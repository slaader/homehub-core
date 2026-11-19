import {randomBytes} from 'node:crypto';
import {exactKeys,extractLinks,normalizeDoc,PAGE_ID,WIKI_LIMITS,wikiTitle} from '../public/wiki-doc.js';
import {PROJECT_ID,TICKET_ID} from './tickets-store.mjs';

export const WIKI_SCHEMA=1;
const ALPHABET='abcdefghijklmnopqrstuvwxyz234567';
const fail=code=>{throw new Error(code);};
const pageId=()=> 'w'+Array.from(randomBytes(11),byte=>ALPHABET[byte&31]).join('');
const pageKey=(project,id)=>project+'/'+id;
const pageRow=page=>pageKey(page.project,page.id);
const rows=(items,key)=>items.map(item=>[key(item),item]);
const docs=items=>(items??[]).map(([,value])=>value);
const projection=({id,project,title,rev,updatedAt,updatedBy,links})=>({id,project,title,rev,updatedAt,updatedBy,links});
const plainText=text=>[{t:'text',text}];
const emptyDoc=()=>({v:1,blocks:[]});

export function createWikiStore(db,tickets){
 const store=db.collection('wiki',{
  empty:()=>({schema:WIKI_SCHEMA,revision:0,updatedAt:null,wikis:[],pages:[],summaries:[]}),
  valid:data=>data?.schema===WIKI_SCHEMA&&Array.isArray(data.wikis)&&Array.isArray(data.pages)&&Array.isArray(data.summaries),
  split:({wikis,pages,summaries,...meta})=>({meta,colls:{
   wikis:rows(wikis,w=>w.project),pages:rows(pages,pageRow),summaries:rows(summaries,pageRow),
  }}),
  join:(meta,colls)=>({...meta,wikis:docs(colls.wikis),pages:docs(colls.pages),summaries:docs(colls.summaries)}),
 });
 let queue=Promise.resolve(),cached=null;
 function write(run){
  const result=queue.then(run);
  queue=result.catch(()=>{});
  return result;
 }

 async function projectOf(id){
  if(typeof id!=='string'||!PROJECT_ID.test(id))fail('invalid');
  return (await tickets.projects()).find(project=>project.id===id)??fail('not-found');
 }

 async function list(project){
  await projectOf(project);
  const wiki=await store.get('wikis',project);
  if(!wiki)return {enabled:false};
  const pages=(await summaries()).filter(page=>page.project===project);
  pages.sort((a,b)=>Number(b.id===wiki.home)-Number(a.id===wiki.home)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
  return {enabled:true,home:wiki.home,pages:structuredClone(pages)};
 }

 async function summaries(){
  const version=await store.version();
  if(cached?.version===version)return cached.pages;
  // The projection is written in the same transaction as the page. Lists never load article bodies.
  const pages=await store.list('summaries');
  cached=Buffer.byteLength(JSON.stringify(pages))<=16*1024*1024?{version,pages}:null;
  return pages;
 }

 async function get(project,id){
  if(typeof id!=='string'||!PAGE_ID.test(id))fail('invalid');
  return await store.get('pages',pageKey(project,id))??fail('not-found');
 }

 function makePage(project,id,title,doc,by,at){
  return {id,project,title,doc,links:extractLinks(doc),rev:1,createdAt:at,createdBy:by,updatedAt:at,updatedBy:by,
   history:[{at,by,rev:1,field:'created'}]};
 }

 function record(data,page){
  data.summaries[0]=projection(page);
  data.revision++;
  data.updatedAt=page.updatedAt;
 }

 async function availableId(project){
  let id;
  do{id=pageId();}while(await store.get('pages',pageKey(project,id)));
  return id;
 }

 function setup(input,by){
  if(!exactKeys(input,['project']))fail('invalid');
  return write(async()=>{
   const project=await projectOf(input.project),id=await availableId(project.id);
   const key=pageKey(project.id,id);
   return store.change({wikis:[project.id],pages:[key],summaries:[key]},data=>{
    const wiki=data.wikis[0];
    if(wiki)return {created:false,home:wiki.home};
    if(data.pages.length)fail('conflict');
    const at=new Date().toISOString();
    const blocks=[{t:'h',level:1,c:plainText(project.name)}];
    if(project.description)blocks.push({t:'p',c:plainText(project.description)});
    data.wikis.push({project:project.id,home:id,count:1,createdAt:at,createdBy:by});
    const page=makePage(project.id,id,'Home',normalizeDoc({v:1,blocks}),by,at);
    data.pages.push(page);
    record(data,page);
    return {created:true,home:id};
   });
  });
 }

 async function checkedDoc(input,project){
  const doc=normalizeDoc(input);
  const {tickets:links}=extractLinks(doc);
  await Promise.all(links.map(async id=>{
   if(!id.startsWith(project.key+'-'))fail('invalid');
   let ticket;
   try{ticket=await tickets.get(id);}catch(error){if(error.message==='not-found')fail('invalid');throw error;}
   if(ticket.project!==project.id)fail('invalid');
  }));
  return doc;
 }

 function create(input,by){
  if(!exactKeys(input,['project','title','doc']))fail('invalid');
  const title=wikiTitle(input.title);
  return write(async()=>{
   const project=await projectOf(input.project);
   if(!await store.get('wikis',project.id))fail('not-found');
   const doc=input.doc===undefined?emptyDoc():await checkedDoc(input.doc,project);
   const id=await availableId(project.id);
   const key=pageKey(project.id,id);
   return store.change({wikis:[project.id],pages:[key],summaries:[key]},data=>{
    const wiki=data.wikis[0];
    if(wiki.count>=WIKI_LIMITS.pages)fail('limit');
    if(data.pages.length)fail('conflict');
    const at=new Date().toISOString(),page=makePage(project.id,id,title,doc,by,at);
    wiki.count++;
    data.pages.push(page);
    record(data,page);
    return page;
   });
  });
 }

 function update(input,by){
  if(!exactKeys(input,['project','id','rev','title','doc'])||typeof input.id!=='string'||!PAGE_ID.test(input.id)||
    !Number.isSafeInteger(input.rev)||input.rev<1||(input.title===undefined&&input.doc===undefined))fail('invalid');
  const title=input.title===undefined?undefined:wikiTitle(input.title);
  return write(async()=>{
   const project=await projectOf(input.project);
   const doc=input.doc===undefined?undefined:await checkedDoc(input.doc,project);
   const key=pageKey(project.id,input.id);
   return store.change({pages:[key],summaries:[key]},data=>{
    const page=data.pages[0];
    if(!page)fail('not-found');
    if(page.rev!==input.rev){
     const {rev,updatedAt,updatedBy}=page;
     throw Object.assign(new Error('conflict'),{current:{rev,updatedAt,updatedBy}});
    }
    const fields=[];
    if(title!==undefined&&title!==page.title){page.title=title;fields.push('title');}
    if(doc!==undefined&&JSON.stringify(doc)!==JSON.stringify(page.doc)){
     page.doc=doc;
     page.links=extractLinks(doc);
     fields.push('content');
    }
    if(fields.length){
     const at=new Date().toISOString(),rev=++page.rev;
     page.updatedAt=at;
     page.updatedBy=by;
     page.history.push(...fields.map(field=>({at,by,rev,field})));
     page.history=page.history.slice(-50);
     record(data,page);
    }
    return page;
   });
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

 return {list,get,setup,create,update,backlinks};
}
