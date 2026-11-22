import {createReadStream} from 'node:fs';
import {exactKeys,WIKI_LIMITS} from '../public/wiki-doc.js';
import {validFullName} from './git-lfs-providers.mjs';
import {validImportPath,validImportRef} from './git-lfs-git.mjs';
import {REVIEW_ID} from './review-store.mjs';
import {collectionPage,pagination,wikiCollection,wikiKey} from './wiki-store.mjs';
import {sanitizeWikiFilename} from './wiki-assets.mjs';

export const CONNECTION_ID=/^c[a-f0-9]{10}$/;
export function isConnectionId(id){return typeof id==='string'&&CONNECTION_ID.test(id);}
export function grantMatches(stored,expected){
 if(!stored||!expected||stored.key!==expected.key||stored.project!==expected.project||stored.kind!==expected.kind)return false;
 if(expected.kind==='lfs'){
  return stored.connection===expected.connection&&stored.repo===expected.repo&&
   stored.identity===expected.identity&&(stored.downloadOrigin??undefined)===(expected.downloadOrigin??undefined);
 }
 if(expected.kind==='review')return stored.set===expected.set;
 return false;
}

const fail=code=>{throw new Error(code);};
const lfsKey=(project,connection,repo)=>wikiKey(project,'lfs/'+connection+'/'+repo);
const reviewKey=(project,set)=>wikiKey(project,'review/'+set);
const isReview=set=>typeof set==='string'&&REVIEW_ID.test(set);
const canRead=principal=>principal?.scopes?.includes('read')===true;
const audience='project-readers';
const MAX_LFS_OPERATIONS=4;
const discoveryKeys=['project','kind','connection','repo','set','round','item','variant','query','offset','limit'];

function queried(items,fields,query,window){
 const needle=query?.trim().toLowerCase();
 return collectionPage(needle?items.filter(item=>fields(item).some(value=>value?.toLowerCase().includes(needle))):items,window);
}

const roundInfo=round=>({number:round.n,title:`Round ${round.n}`,notes:round.notes,publishedAt:round.publishedAt});

function reviewVariantStatus(item,variant,decision){
 if(variant.reference)return 'reference';
 if(decision.status==='reject')return 'rejected';
 if(item.mode==='approve'){
  const approval=decision.approvals?.[variant.id];
  return approval==='approved'?'approved':approval==='changes'?'changes-requested':'pending';
 }
 if(decision.status==='pending')return 'pending';
 if(decision.variant!==variant.id)return 'not-selected';
 return decision.status==='accept'?'accepted':'revision-requested';
}

function reviewChoice(set,round,item,variant,index){
 const {status='pending',variant:chosen=null,note='',approvals,rev=0}=Object.hasOwn(round.feedback,item.id)?round.feedback[item.id]:{};
 const media=variant.media[index],mode=item.mode??'choose';
 const scope=!rev?'unset':status==='reject'?'item':chosen?'variant':mode==='approve'&&Object.keys(approvals??{}).length?'variants':'item';
 const meaning=reviewVariantStatus(item,variant,{status,variant:chosen,approvals});
 const source={kind:'review',set:set.id,round:round.n,item:item.id,variant:variant.id,media:index};
 const review={
  set:{id:set.id,project:set.project,title:set.title},round:roundInfo(round),item:{id:item.id,title:item.title,mode},
  variant:{id:variant.id,title:variant.title,label:variant.label,role:variant.reference?'reference':'candidate',status:meaning},
  decision:{rev,status,scope,variant:chosen,note,variantApproval:approvals?.[variant.id]??null},
 };
 const context=variant.reference?'comparison reference':meaning.replaceAll('-',' ');
 const captionSuggestion=[
  `${set.title} · Round ${round.n} · ${item.title} · ${variant.title||variant.label} (${context}).`,
  note&&`${scope==='item'?'Item decision':'Review note'} (${status}): ${note}`,media.caption,
 ].filter(Boolean).join(' ').replaceAll('\0','�').slice(0,WIKI_LIMITS.caption).toWellFormed();
 return {source,review,captionSuggestion,name:media.name,type:media.type,size:media.size,digest:media.sha256};
}

function externalOrigin(value){
 if(value===undefined||value==='')return undefined;
 let url;
 try{url=new URL(value);}catch{fail('invalid');}
 if(typeof value!=='string'||url.protocol!=='https:'||url.username||url.password||url.href!==url.origin+'/')fail('invalid');
 return url.origin;
}

export function createWikiSources(db,wiki,assets,{lfs,review}){
 const store=wikiCollection(db);
 let activeLfsOperations=0;
 async function withLfsSlot(run){
  if(activeLfsOperations>=MAX_LFS_OPERATIONS)fail('source-busy');
  activeLfsOperations++;
  try{return await run();}
  finally{activeLfsOperations--;}
 }

 async function setGrant(input){
  if(!exactKeys(input,['project','kind','connection','repo','set','downloadOrigin','enabled'])||typeof input.enabled!=='boolean')fail('invalid');
  const {id:project}=await wiki.projectOf(input.project);
  const {kind,connection,repo,set}=input;
  let grant;
  if(kind==='lfs'){
   if(set!==undefined||!isConnectionId(connection)||!validFullName(repo))fail('invalid');
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

 async function reviewTarget(project,setId){
  const reviews=review();
  if(!reviews)fail('source-unavailable');
  const set=await reviews.get(setId).catch(error=>{if(error.message!=='not-found')throw error;return null;});
  const grant=await store.get('grants',reviewKey(project,setId));
  if(!set)fail(grant?'source-unavailable':'source-not-granted');
  if(set.project!==project&&!grant)fail('source-not-granted');
  return set;
 }

 async function discover(input,principal){
  if(!exactKeys(input,discoveryKeys))fail('invalid');
  const {kind,connection,repo,set:setId,round:roundNumber,item:itemId,variant:variantId,query}=input;
  if(kind!==undefined&&!['lfs','review'].includes(kind)||query!==undefined&&(typeof query!=='string'||query.length>200))fail('invalid');
  if(!canRead(principal))fail('denied');
  const {id:project}=await wiki.projectOf(input.project);
  const window=pagination(input,{max:20,defaultLimit:10});
  const base={project,audience};
  if(connection!==undefined||repo!==undefined){
   if(kind==='review'||[setId,roundNumber,itemId,variantId].some(value=>value!==undefined)||
    !isConnectionId(connection)||!validFullName(repo))fail('invalid-target');
   const key=lfsKey(project,connection,repo),grant=await store.get('grants',key);
   if(!grant)fail('source-not-granted');
   const git=lfs();
   if(!git?.importRepo(grant))fail('source-unavailable');
   const found=await withLfsSlot(()=>git.browseImport(grant,{...window,query}).catch(()=>fail('source-unavailable')));
   const current=await store.get('grants',key);
   if(!current)fail('source-not-granted');
   if(current.identity!==grant.identity||!git.importRepo(current))fail('source-unavailable');
   return {...base,kind:'lfs',connection,repo,...found};
  }
  if(setId!==undefined){
   if(kind==='lfs'||!isReview(setId)||itemId!==undefined&&(typeof itemId!=='string'||!/^[a-z0-9][a-z0-9-]{0,39}$/.test(itemId))||
    variantId!==undefined&&(typeof variantId!=='string'||!/^[a-f]$/.test(variantId)||!itemId))fail('invalid-target');
   const set=await reviewTarget(project,setId),context={...base,kind:'review',set:{id:set.id,project:set.project,title:set.title}};
   if(roundNumber===undefined){
    if(itemId!==undefined)fail('invalid-target');
    return {...context,...queried(set.rounds.map(roundInfo),round=>[round.title,round.notes],query,window)};
   }
   const round=Number.isSafeInteger(roundNumber)&&roundNumber>0&&set.rounds.find(r=>r.n===roundNumber);
   if(!round)fail('invalid-target');
   const items=itemId?round.items.filter(item=>item.id===itemId):round.items;
   if(!items.length||variantId&&!items[0].variants.some(variant=>variant.id===variantId))fail('invalid-target');
   const files=items.flatMap(item=>item.variants.filter(variant=>!variantId||variant.id===variantId).flatMap(variant=>
    variant.media.map((media,index)=>({item,variant,media,index}))));
   const page=queried(files,({item,variant,media})=>[media.name,media.sha256,item.title,variant.title,variant.label],query,window);
   return {...context,round:roundInfo(round),...page,items:page.items.map(({item,variant,index})=>reviewChoice(set,round,item,variant,index))};
  }
  if([roundNumber,itemId,variantId].some(value=>value!==undefined))fail('invalid-target');
  const grants=await store.list('grants',project+'/');
  const git=lfs();
  const repositories=kind==='review'?[]:grants.filter(grant=>grant.kind==='lfs').map(grant=>{
   const {kind,connection,repo}=grant,info=git?.importRepo(grant);
   return {kind,connection,repo,status:info?'configured':'unavailable'};
  });
  const sets=kind==='lfs'?[]:(await list(project,principal)).reviewSets.map(({id:set,project,title})=>({kind:'review',set,project,title}));
  return {...base,...queried([...repositories,...sets],item=>[item.repo,item.set,item.title],query,window)};
 }

 async function importAsset(input,actor,principal){
  if(!exactKeys(input,['project','source']))fail('invalid');
  if(!canRead(principal))fail('denied');
  const {id:project}=await wiki.projectOf(input.project);
  const source=input.source;
  if(source?.kind==='lfs'){
   if(!exactKeys(source,['kind','connection','repo','ref','path'])||!isConnectionId(source.connection)||!validFullName(source.repo)||
    !validImportRef(source.ref)||!validImportPath(source.path))fail('invalid-target');
   const grant=await store.get('grants',lfsKey(project,source.connection,source.repo));
   const git=lfs();
   if(!grant)fail('denied');
   if(!git||git.importIdentity(source.connection)!==grant.identity)fail('source-unavailable');
   return withLfsSlot(async ()=>{
    let pinned;
    try{pinned=await git.importPointer(source,grant);}
    catch(error){throw sourceError(error);}
    const download=pinned.body;
    pinned.body=async()=>{try{return await download();}catch(error){throw sourceError(error);}};
    return await assets.ingest(project,pinned,actor,grant);
   });
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
  const choice=reviewChoice(set,round,item,variant,index);
  const result=await assets.ingest(project,{name:sanitizeWikiFilename(name,`${item.id}-${variant.id}-${index+1}.${suffix}`),
   size:match.size,digest,type,body:()=>createReadStream(match.file),
   source:{...choice.source,project:set.project,digest}},actor,grant);
  return {...result,review:choice.review,captionSuggestion:choice.captionSuggestion};
 }

 return {setGrant,list,discover,importAsset};
}

function sourceError(error){
 const code=error.code??error.message;
 const message={denied:'denied',disabled:'source-unavailable',auth:'denied',forbidden:'denied','not-found':'source-missing',
  'invalid-ref':'invalid-target','invalid-pointer':'invalid-target','invalid-url':'unsafe-source','too-large':'too-large',
  'bad-response':'source-invalid'}[code]??'source-unavailable';
 return new Error(message);
}
