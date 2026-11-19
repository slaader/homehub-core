import {createReadStream} from 'node:fs';
import {exactKeys} from '../public/wiki-doc.js';
import {validFullName} from './git-lfs-providers.mjs';
import {validImportPath,validImportRef} from './git-lfs-git.mjs';
import {REVIEW_ID} from './review-store.mjs';
import {wikiCollection,wikiKey} from './wiki-store.mjs';

const fail=code=>{throw new Error(code);};
const lfsKey=(project,connection,repo)=>wikiKey(project,'lfs/'+connection+'/'+repo);
const reviewKey=(project,set)=>wikiKey(project,'review/'+set);
const isConnection=id=>typeof id==='string'&&/^c[a-f0-9]{10}$/.test(id);
const isReview=set=>typeof set==='string'&&REVIEW_ID.test(set);
const canRead=principal=>principal?.scopes?.includes('read')===true;
const audience='project-readers';
const MAX_LFS_IMPORTS=4;

function externalOrigin(value){
 if(value===undefined||value==='')return undefined;
 let url;
 try{url=new URL(value);}catch{fail('invalid');}
 if(typeof value!=='string'||url.protocol!=='https:'||url.username||url.password||url.href!==url.origin+'/')fail('invalid');
 return url.origin;
}

export function createWikiSources(db,wiki,assets,{lfs,review}){
 const store=wikiCollection(db);
 let activeLfsImports=0;

 async function setGrant(input){
  if(!exactKeys(input,['project','kind','connection','repo','set','downloadOrigin','enabled'])||typeof input.enabled!=='boolean')fail('invalid');
  const {id:project}=await wiki.projectOf(input.project);
  const {kind,connection,repo,set}=input;
  let grant;
  if(kind==='lfs'){
   if(set!==undefined||!isConnection(connection)||!validFullName(repo))fail('invalid');
   const key=lfsKey(project,connection,repo),identity=lfs()?.importIdentity(connection);
   if(input.enabled&&!identity)fail('not-found');
   const downloadOrigin=externalOrigin(input.downloadOrigin);
   grant={key,project,kind,connection,repo,identity,...(downloadOrigin?{downloadOrigin}:{})};
  }else if(kind==='review'){
   if(connection!==undefined||repo!==undefined||input.downloadOrigin!==undefined||!isReview(set))fail('invalid');
   if(input.enabled&&!await review()?.get(set))fail('not-found');
   grant={key:reviewKey(project,set),project,kind,set};
  }else fail('invalid');
  return store.change({grants:[grant.key]},data=>{
   data.grants=input.enabled?[grant]:[];
   return {project,kind,enabled:input.enabled,audience};
  });
 }

 async function list(project,principal,{admin=false}={}){
  await wiki.projectOf(project);
  if(!canRead(principal))fail('denied');
  const grants=await store.list('grants',project+'/');
  const repositories=grants.filter(grant=>grant.kind==='lfs').flatMap(grant=>{
   const current=lfs()?.importIdentity(grant.connection)===grant.identity;
   if(!admin&&!current)return [];
   const {connection,repo,downloadOrigin}=grant;
   return [{connection,repo,...(admin?{current,downloadOrigin}:{} )}];
  });
  const otherSets=grants.filter(grant=>grant.kind==='review').map(grant=>grant.set);
  const same=await review()?.list({project,status:'all'});
  const others=await Promise.all(otherSets.map(set=>review()?.get(set).catch(error=>{if(error.message!=='not-found')throw error;})));
  const sets=new Map([...(same?.sets??[]),...others.filter(Boolean)].map(({id,project,title})=>[id,{id,project,title}]));
  return {audience,repositories,reviewSets:[...sets.values()],...(admin?{reviewGrants:otherSets}:{})};
 }

 async function importAsset(input,actor,principal){
  if(!exactKeys(input,['project','source']))fail('invalid');
  if(!canRead(principal))fail('denied');
  const {id:project}=await wiki.projectOf(input.project);
  const source=input.source;
  if(source?.kind==='lfs'){
   if(!exactKeys(source,['kind','connection','repo','ref','path'])||!isConnection(source.connection)||!validFullName(source.repo)||
    !validImportRef(source.ref)||!validImportPath(source.path))fail('invalid-target');
   const grant=await store.get('grants',lfsKey(project,source.connection,source.repo));
   const git=lfs();
   if(!grant||!git||git.importIdentity(source.connection)!==grant.identity)fail('denied');
   if(activeLfsImports>=MAX_LFS_IMPORTS)fail('source-busy');
   activeLfsImports++;
   try{
    let pinned;
    try{pinned=await git.importPointer(source,grant);}
    catch(error){throw sourceError(error);}
    const download=pinned.body;
    pinned.body=async()=>{try{return await download();}catch(error){throw sourceError(error);}};
    return await assets.ingest(project,pinned,actor,grant);
   }finally{activeLfsImports--;}
  }
  if(source?.kind!=='review'||!exactKeys(source,['kind','set','round','item','variant','media'])||
   !isReview(source.set)||!Number.isSafeInteger(source.round)||source.round<1||
   typeof source.item!=='string'||typeof source.variant!=='string')fail('invalid-target');
  const reviews=review();
  if(!reviews)fail('source-unavailable');
  const set=await reviews.get(source.set);
  const grant=set.project===project?null:await store.get('grants',reviewKey(project,set.id));
  if(set.project!==project&&!grant)fail('denied');
  const round=set.rounds.find(round=>round.n===source.round);
  const item=round?.items.find(item=>item.id===source.item);
  const variant=item?.variants.find(variant=>variant.id===source.variant);
  const index=source.media??0;
  if(!Number.isSafeInteger(index)||index<0||index>= (variant?.media.length??0))fail('invalid-target');
  const {sha256:digest,type,name}=variant.media[index];
  const match=await reviews.media(digest);
  const fallback={'text/html':'html','model/gltf-binary':'glb','image/jpeg':'jpg','audio/mp4':'m4a','audio/mpeg':'mp3'};
  const suffix=fallback[type]??type.split('/')[1];
  const fileName=name?.toWellFormed().replace(/[\x00-\x1f\x7f/\\]/g,'_').trim();
  return assets.ingest(project,{name:fileName&&fileName!=='.'&&fileName!=='..'?fileName:`${item.id}-${variant.id}-${index+1}.${suffix}`,
   size:match.size,digest,type,body:()=>createReadStream(match.file),
   source:{kind:'review',project:set.project,set:set.id,round:round.n,item:item.id,variant:variant.id,media:index,digest}},actor,grant);
 }

 return {setGrant,list,importAsset};
}

function sourceError(error){
 const code=error.code??error.message;
 const message={denied:'denied',disabled:'source-unavailable',auth:'denied',forbidden:'denied','not-found':'source-missing',
  'invalid-ref':'invalid-target','invalid-pointer':'invalid-target','invalid-url':'unsafe-source','too-large':'too-large',
  'bad-response':'source-invalid'}[code]??'source-unavailable';
 return new Error(message);
}
