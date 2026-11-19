import {createHash,randomBytes} from 'node:crypto';
import {exactKeys,extractLinks,normalizeDoc,PAGE_ID,WIKI_LIMITS,wikiTitle,wikiAssetIds,wikiAttachment} from '../public/wiki-doc.js';
import {PROJECT_ID,TICKET_ID} from './tickets-store.mjs';

export const WIKI_SCHEMA=2;
const ALPHABET='abcdefghijklmnopqrstuvwxyz234567';
const fail=code=>{throw new Error(code);};
const pageId=()=> 'w'+Array.from(randomBytes(11),byte=>ALPHABET[byte&31]).join('');
export const wikiKey=(project,id)=>project+'/'+id;
const pageRow=page=>wikiKey(page.project,page.id);
const rows=(items,key)=>items.map(item=>[key(item),item]);
const docs=items=>(items??[]).map(([,value])=>value);
const projection=({id,project,parentId,title,rev,updatedAt,updatedBy,links})=>({id,project,parentId,title,rev,updatedAt,updatedBy,links});
const plainText=text=>[{t:'text',text:text.toWellFormed().replaceAll('\0','�')}];
const emptyDoc=()=>({v:1,blocks:[]});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
export const wikiPageUrl=(project,id)=>`#wiki/${project}${id?'/'+id:''}`;
export const wikiAssetView=({id,project,name,type,size,digest,source})=>({id,project,name,type,size,digest,
 ...(source?{source}:{}),url:`/api/wiki/${project}/assets/${id}`});

export function wikiCollection(db){
 const keys={wikis:w=>w.project,pages:pageRow,summaries:pageRow,assets:pageRow,uploads:u=>u.id,blobs:b=>b.digest,receipts:r=>r.key,grants:g=>g.key};
 const names=Object.keys(keys);
 function checkMeta(meta){if(meta.schema!==WIKI_SCHEMA)throw new Error('Unsupported wiki schema');}
 return db.collection('wiki',{
  checkMeta,empty:()=>({schema:WIKI_SCHEMA,revision:0,updatedAt:null}),
  split:data=>{
   const meta={...data},colls={};
   for(const name of names){colls[name]=rows(data[name]??[],keys[name]);delete meta[name];}
   return {meta,colls};
  },
  join:(meta,colls)=>{
   checkMeta(meta);
   return {...meta,...Object.fromEntries(names.map(name=>[name,docs(colls[name])]))};
  },
 });
}

function checkRevision(page,rev){
 if(!page)fail('not-found');
 if(page.rev!==rev){
  const {rev,updatedAt,updatedBy}=page;
  throw Object.assign(new Error('conflict'),{current:{rev,updatedAt,updatedBy}});
 }
}

function checkedIdentity(input){
 if(typeof input.id!=='string'||!PAGE_ID.test(input.id)||!Number.isSafeInteger(input.rev)||input.rev<1)fail('invalid');
}

function retryKey(project,operation,id,actor,required=false){
 if(id===undefined&&!required)return null;
 if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)||!actor)fail('invalid');
 return wikiKey(project,hash([actor,operation,id]));
}

function replay({receipts},fingerprint){
 const receipt=receipts[0];
 if(!receipt)return null;
 if(receipt.fingerprint!==fingerprint)fail('request-conflict');
 return {...receipt.result,replayed:true};
}

function remember(data,key,fingerprint,page){
 if(key)data.receipts.push({key,fingerprint,result:projection(page)});
}

function record(data,page){
 const index=data.summaries.findIndex(other=>other.id===page.id);
 if(index===-1)data.summaries.push(projection(page));
 else data.summaries[index]=projection(page);
 data.revision++;
 data.updatedAt=page.updatedAt;
}

function changePage(data,page,by,fields){
 if(fields.length){
  const at=now(),rev=++page.rev;
  page.updatedAt=at;
  page.updatedBy=by;
  page.history.push(...fields.map(field=>({at,by,rev,field})));
  page.history=page.history.slice(-50);
  record(data,page);
 }
 return page;
}

function makePage(project,id,parentId,title,doc,by,at){
 return {id,project,parentId,title,doc,links:extractLinks(doc),rev:1,createdAt:at,createdBy:by,updatedAt:at,updatedBy:by,
  history:[{at,by,rev:1,field:'created'}]};
}

function updateAssets(data,doc,previous,actor){
 const before=new Set(previous?wikiAssetIds(previous):[]),after=new Set(wikiAssetIds(doc));
 const assets=new Map(data.assets.map(asset=>[asset.id,asset]));
 const at=Date.now();
 for(const id of after){
  const asset=assets.get(id);
  if(!asset||!asset.published&&asset.owner!==actor)fail('invalid-asset');
  if(before.has(id))continue;
  asset.references++;
  asset.published=true;
  asset.orphanedAt=null;
 }
 for(const id of before){
  if(after.has(id))continue;
  const asset=assets.get(id);
  if(asset&&--asset.references===0)asset.orphanedAt=at;
 }
}

function parentOf(input){
 if(typeof input!=='string'||!PAGE_ID.test(input))fail('invalid-parent');
 return input;
}

function orderedTree(pages){
 const children=new Map();
 for(const page of pages){
  if(!children.has(page.parentId))children.set(page.parentId,[]);
  children.get(page.parentId).push(page);
 }
 const ordered=[];
 function walk(parent){
  const siblings=children.get(parent)??[];
  siblings.sort((a,b)=>a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
  for(const page of siblings){ordered.push(page);walk(page.id);}
 }
 walk(null);
 return ordered;
}

export function createWikiStore(db,tickets){
 const store=wikiCollection(db);
 let cached=null;

 async function projectOf(id){
  if(typeof id!=='string'||!PROJECT_ID.test(id))fail('invalid');
  return (await tickets.projects()).find(project=>project.id===id)??fail('not-found');
 }

 async function list(project){
  await projectOf(project);
  const wiki=await store.get('wikis',project);
  if(!wiki)return {enabled:false};
  return {enabled:true,home:wiki.home,pages:orderedTree(await store.list('summaries',project+'/'))};
 }

 async function summaries(){
  const version=await store.version();
  if(cached?.version===version)return cached.pages;
  const pages=await store.list('summaries');
  cached=Buffer.byteLength(JSON.stringify(pages))<=16*1024*1024?{version,pages}:null;
  return pages;
 }

 async function get(project,id){
  if(typeof id!=='string'||!PAGE_ID.test(id))fail('invalid');
  return await store.get('pages',wikiKey(project,id))??fail('not-found');
 }

 async function withAssets(page){
  if(!page.doc)return page;
  const assets=await Promise.all(wikiAssetIds(page.doc).map(id=>store.get('assets',wikiKey(page.project,id))));
  return {...page,assets:assets.filter(Boolean).map(wikiAssetView)};
 }

 async function setup(input,by){
  if(!exactKeys(input,['project']))fail('invalid');
  const project=await projectOf(input.project),id=pageId(),key=wikiKey(project.id,id);
  return store.change({wikis:[project.id],pages:[key],summaries:[key]},data=>{
   const wiki=data.wikis[0];
   if(wiki)return {created:false,home:wiki.home};
   if(data.pages.length)fail('conflict');
   const at=now(),blocks=[{t:'h',level:1,c:plainText(project.name)}];
   if(project.description)blocks.push({t:'p',c:plainText(project.description)});
   data.wikis.push({project:project.id,home:id,count:1,createdAt:at,createdBy:by});
   const page=makePage(project.id,id,null,'Home',normalizeDoc({v:1,blocks}),by,at);
   data.pages.push(page);
   record(data,page);
   return {created:true,home:id};
  });
 }

 async function checkedDoc(input,project){
  const doc=normalizeDoc(input);
  await Promise.all(extractLinks(doc).tickets.map(async id=>{
   if(!id.startsWith(project.key+'-'))fail('invalid');
   let ticket;
   try{ticket=await tickets.get(id);}catch(error){if(error.message==='not-found')fail('invalid');throw error;}
   if(ticket.project!==project.id)fail('invalid');
  }));
  return doc;
 }

 async function create(input,by,actor=by,{requireRequestId=false}={}){
  if(!exactKeys(input,['project','parentId','title','doc','requestId']))fail('invalid');
  const title=wikiTitle(input.title),project=await projectOf(input.project),id=pageId(),key=wikiKey(project.id,id);
  const parent=input.parentId===undefined?undefined:parentOf(input.parentId);
  const doc=input.doc===undefined?emptyDoc():await checkedDoc(input.doc,project);
  const receipt=retryKey(project.id,'create',input.requestId,actor,requireRequestId),fingerprint=hash([parent,title,doc]);
  const selection={wikis:[project.id],pages:[key],summaries:project.id+'/',assets:wikiAssetIds(doc).map(id=>wikiKey(project.id,id)),
   receipts:receipt?[receipt]:[]};
  return store.change(selection,data=>{
   const prior=replay(data,fingerprint);
   if(prior)return prior;
   const wiki=data.wikis[0];
   if(!wiki)fail('not-found');
   if(wiki.count>=WIKI_LIMITS.pages)fail('page-limit');
   const parentId=parent??wiki.home;
   if(!data.summaries.some(page=>page.id===parentId))fail('invalid-parent');
   if(data.pages.length)fail('conflict');
   updateAssets(data,doc,null,actor);
   const page=makePage(project.id,id,parentId,title,doc,by,now());
   wiki.count++;
   data.pages.push(page);
   record(data,page);
   remember(data,receipt,fingerprint,page);
   return page;
  });
 }

 async function update(input,by,actor=by){
  if(!exactKeys(input,['project','id','rev','title','doc'])||(input.title===undefined&&input.doc===undefined))fail('invalid');
  checkedIdentity(input);
  const title=input.title===undefined?undefined:wikiTitle(input.title),project=await projectOf(input.project);
  const key=wikiKey(project.id,input.id);
  // Read only the previous asset IDs here. The revision is checked again inside the write transaction.
  const doc=input.doc===undefined?undefined:await checkedDoc(input.doc,project);
  const old=doc===undefined?null:await get(project.id,input.id);
  if(old)checkRevision(old,input.rev);
  const assets=old?[...new Set([...wikiAssetIds(old.doc),...wikiAssetIds(doc)])].map(id=>wikiKey(project.id,id)):[];
  return store.change({pages:[key],summaries:[key],assets},data=>{
   const page=data.pages[0];
   checkRevision(page,input.rev);
   const fields=[];
   if(title!==undefined&&title!==page.title){page.title=title;fields.push('title');}
   if(doc!==undefined&&JSON.stringify(doc)!==JSON.stringify(page.doc)){
    updateAssets(data,doc,page.doc,actor);
    page.doc=doc;
    page.links=extractLinks(doc);
    fields.push('content');
   }
   return changePage(data,page,by,fields);
  });
 }

 async function move(input,by){
  if(!exactKeys(input,['project','id','rev','parentId']))fail('invalid');
  checkedIdentity(input);
  const parentId=parentOf(input.parentId),project=await projectOf(input.project),key=wikiKey(project.id,input.id);
  return store.change({pages:[key],summaries:project.id+'/'},data=>{
   const page=data.pages[0],tree=new Map(data.summaries.map(entry=>[entry.id,entry]));
   checkRevision(page,input.rev);
   if(page.parentId===null)fail('invalid-parent');
   for(let id=parentId;id!==null;){
    const parent=tree.get(id);
    if(!parent||id===page.id)fail('invalid-parent');
    id=parent.parentId;
   }
   if(page.parentId===parentId)return page;
   page.parentId=parentId;
   return changePage(data,page,by,['parentId']);
  });
 }

 async function attach(input,by,actor=by){
  if(!exactKeys(input,['project','id','rev','requestId','assetId','label','caption','position','groupId','tableId','rowId','columnId']))fail('invalid');
  checkedIdentity(input);
  const {groupId,tableId,rowId,columnId,position}=input;
  if(groupId===undefined?[tableId,rowId,columnId].some(id=>typeof id!=='string'):[tableId,rowId,columnId].some(id=>id!==undefined))fail('invalid-target');
  const ref=wikiAttachment({assetId:input.assetId,label:input.label,caption:input.caption});
  const project=await projectOf(input.project),key=wikiKey(project.id,input.id);
  const receipt=retryKey(project.id,'attach',input.requestId,actor,true),fingerprint=hash([input.id,input.rev,groupId,tableId,rowId,columnId,position,ref]);
  return store.change({pages:[key],summaries:[key],assets:[wikiKey(project.id,ref.assetId)],receipts:[receipt]},data=>{
   const prior=replay(data,fingerprint);
   if(prior)return prior;
   const page=data.pages[0];
   checkRevision(page,input.rev);
   const asset=data.assets[0];
   if(!asset||!asset.published&&asset.owner!==actor)fail('invalid-asset');
   const previous=wikiAssetIds(page.doc).includes(ref.assetId);
   let target;
   if(groupId!==undefined)target=page.doc.blocks.find(block=>block.t==='attachments'&&block.id===groupId);
   else{
    const table=page.doc.blocks.find(block=>block.t==='inventory'&&block.id===tableId);
    const row=table?.rows.find(row=>row.id===rowId);
    if(row&&table.columns.some(column=>column.id===columnId)){
     if(!Object.hasOwn(row.cells,columnId))row.cells[columnId]={};
     target=row.cells[columnId];
    }
   }
   if(!target)fail('invalid-target');
   const group=target.attachments??=[],index=position===undefined?group.length:position;
   if(!Number.isSafeInteger(index)||index<0||index>group.length)fail('invalid-target');
   group.splice(index,0,ref);
   page.doc=normalizeDoc(page.doc);
   if(!previous){asset.references++;asset.published=true;asset.orphanedAt=null;}
   changePage(data,page,by,['content']);
   remember(data,receipt,fingerprint,page);
   return page;
  });
 }

 async function backlinks(id){
  if(typeof id!=='string'||!TICKET_ID.test(id))fail('invalid');
  let ticket;
  try{ticket=await tickets.get(id);}catch(error){if(error.message==='not-found')return [];throw error;}
  return (await summaries()).filter(page=>page.project===ticket.project&&page.links.tickets.includes(id))
   .map(({project,id,title,updatedAt})=>({project,id,title,updatedAt}))
   .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
 }

 return {projectOf,list,get,withAssets,setup,create,update,move,attach,backlinks};
}
