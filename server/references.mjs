import {randomBytes} from 'node:crypto';
import {deviceList} from './home-data.mjs';
import {exactKeys,wikiInlineGroups} from '../public/wiki-doc.js';
import {referenceHref,referenceKey,referenceKinds,validLabel,validReference} from '../public/reference-format.js';

export const REFERENCE_SCHEMA=1;
export const fold=text=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();

const fail=code=>{throw new Error(code);};
const collNames=['global','local','notes'];
const rowKey=(coll,r)=>coll==='local'?r.project+'/'+r.id:coll==='notes'?referenceKey(r):r.id;
const owned=kind=>kind==='model'||kind==='custom';
const referenceScope=(project,shared=false)=>!project||shared?'global':'local';
const requireRev=(given,want)=>{if(!Number.isSafeInteger(given)||given<0)fail('invalid');if(given!==want)fail('conflict');};
const description=value=>{
 if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||value.length>8000)fail('invalid');
 return value.trim();
};

// Shared visibility policy for both discovery (references_suggest) and write-time Mention validation.
function referenceVisible(item,project,{isolated=false}={}){
 if(!item)return false;
 if(item.scope!=='global'&&(!project||item.project!==project))return false;
 if(isolated&&item.project!==project&&item.kind!=='machine'&&item.kind!=='project')return false;
 return true;
}

function number(value,fallback,min,max){
 if(value===undefined)return fallback;
 if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))fail('invalid');
 const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)fail('invalid');return n;
}

function entry(kind,id,title,project=null){
 const label=title.toWellFormed().replace(/[\x00-\x1f\x7f]/g,' ').trim()||id;
 return {kind,id,label,project,scope:referenceScope(project),href:referenceHref(kind,id)};
}

function wikiExcerpt(doc,kind,id){
 for(const runs of wikiInlineGroups(doc)){
  const index=runs.findIndex(r=>r.t==='ticket'?kind==='ticket'&&r.id===id:r.t==='ref'&&r.kind===kind&&r.id===id);
  if(index<0)continue;
  const text=r=>r.text??r.label??r.id??r.c.map(t=>t.text).join('');
  return (runs.slice(0,index).map(text).join('').slice(-60)+runs.slice(index).map(text).join('')).slice(0,150);
 }
 return '';
}

function createReferenceLookup(db){
 const read=db.db.prepare("SELECT doc FROM docs WHERE kind='references' AND coll=? AND id=?");
 const get=(coll,id)=>{const row=read.get(coll,id);return row&&JSON.parse(row.doc);};
 return {
  owned(kind,id,project){
   const record=get('global',id)??(project?get('local',project+'/'+id):null);
   return record?.kind===kind?{kind:record.kind,scope:record.scope,project:record.project}:null;
  },
  isShared(ref){
   return Boolean(get('notes',referenceKey(ref))?.shared);
  },
 };
}

// Two-phase Mention guard: phase 1 (async) snapshots device IDs before a write transaction; phase 2 (sync) runs
// inside SQLite BEGIN IMMEDIATE so concurrent promotions, deletions and shares observe one atomic snapshot.
export function createMentionGuard({db,tickets=null,wiki=null,machines=async()=>[],lookup=null}={}){
 const refsLookup=lookup??createReferenceLookup(db);
 function describeSync(ref,project,devices){
  const {kind,id}=ref;
  if(owned(kind))return refsLookup.owned(kind,id,project);
  if(kind==='machine')return devices?.has(id)?{kind,scope:'global',project:null}:null;
  if(kind==='project')return tickets?.hasProjectSync?.(id)?{kind,scope:'global',project:null}:null;
  if(kind==='ticket'){
   const owner=tickets?.ticketProjectSync?.(id);
   return owner?{kind,scope:referenceScope(owner,refsLookup.isShared(ref)),project:owner}:null;
  }
  if(kind==='wiki'){
   const owner=wiki?.wikiProjectSync?.(id);
   return owner?{kind,scope:referenceScope(owner,refsLookup.isShared(ref)),project:owner}:null;
  }
  return null;
 }
 return async function prepareMentionGuard(refs){
  if(!refs.length)return ()=>{};
  const devices=refs.some(r=>r.kind==='machine')?new Set((await machines()).map(d=>d.id)):null;
  return (project,previous=[])=>{
   const saved=new Set(previous.map(referenceKey));
   for(const ref of refs){
    if(saved.has(referenceKey(ref)))continue; // A previously valid mention may retain its fallback after deletion.
    if(!referenceVisible(describeSync(ref,project,devices),project))fail('unavailable-reference');
   }
  };
 };
}

export function createReferences(hub){
 const tickets=hub.state('tracker').tickets,wiki=hub.state('wiki').wiki;
 const store=hub.db.collection('references',{
  empty:()=>({schema:REFERENCE_SCHEMA}),
  checkMeta:meta=>{if(meta.schema!==REFERENCE_SCHEMA)throw new Error('Unsupported reference schema');},
  join:(meta,colls)=>({...meta,...Object.fromEntries(collNames.map(k=>[k,(colls[k]??[]).map(([,r])=>r)]))}),
  split:data=>({meta:{schema:data.schema},colls:Object.fromEntries(collNames.map(k=>[k,(data[k]??[]).map(r=>[rowKey(k,r),r])]))}),
 });
 const briefQuery=hub.db.db.prepare(`SELECT json_extract(doc,'$.kind') AS kind,json_extract(doc,'$.id') AS id,
  json_extract(doc,'$.project') AS project,json_extract(doc,'$.label') AS label,coll AS scope
  FROM docs WHERE kind='references' AND coll IN ('local','global')`);
 const sharedQuery=hub.db.db.prepare("SELECT id FROM docs WHERE kind='references' AND coll='notes' AND json_extract(doc,'$.shared')=1");
 const lookup=createReferenceLookup(hub.db);

 function capacity(records,item,except){
  if(records.length>=2000&&!except)fail('limit');
  if(records.some(r=>r!==except&&r.kind===item.kind&&fold(r.label)===fold(item.label)))fail('conflict');
 }
 async function readRecord(r){
  const record=await store.get(r.scope,rowKey(r.scope,r));
  // Promotion may commit between reading the source catalog and fetching its description.
  return record??(r.scope==='local'?await store.get('global',r.id):null);
 }

 async function machines(){
  const home=hub.state('home').homeDevices;
  const [added,siteOverrides]=await Promise.all([home.list(),home.siteOverrides()]);
  const {devices}=deviceList({site:hub.site,added,siteOverrides});
  return devices.map(d=>({...entry('machine',d.id,d.name),role:d.role,ip:d.ip??null}));
 }
 const prepareMentionGuard=createMentionGuard({db:hub.db,tickets,wiki,machines,lookup});

 // Only lightweight fields enter the catalog. Wiki bodies and ticket comments are read on demand.
 let cached;
 async function catalog(){
  const stamp=JSON.stringify(await Promise.all([store.version(),tickets.version(),wiki.version()]));
  if(cached?.stamp!==stamp){
   const [projects,ticketRows,pages]=await Promise.all([tickets.projects(),tickets.referenceSummaries(),wiki.summaries()]);
   const shared=new Set(sharedQuery.all().map(r=>r.id));
   const entries=[...projects.map(p=>entry('project',p.id,p.name)),...ticketRows.map(r=>entry('ticket',r.id,r.title,r.project)),
    ...pages.map(p=>entry('wiki',p.project+'/'+p.id,p.title,p.project)),...briefQuery.all()];
   cached={stamp,entries:entries.map(r=>({...r,href:referenceHref(r.kind,r.id),scope:referenceScope(r.project,shared.has(referenceKey(r)))})),
    isolated:new Set(projects.filter(p=>!p.settings.globalReferences).map(p=>p.id))};
  }
  return {entries:[...cached.entries,...await machines()],isolated:cached.isolated};
 }
 async function search(input={},suggest=false){
  if(!exactKeys(input,['kind','project','scope','q','limit','offset'])||input.kind!==undefined&&!referenceKinds.includes(input.kind)||
    input.scope!==undefined&&!['local','global'].includes(input.scope)||input.project!==undefined&&!validReference('project',input.project)||
    input.q!==undefined&&(typeof input.q!=='string'||input.q.length>200))fail('invalid');
  const limit=number(input.limit,suggest?8:50,1,suggest?20:100),offset=number(input.offset,0,0,1000000),q=fold(input.q??'').trim();
  const {entries,isolated}=await catalog(),matches=[];
  // A project whose settings turn globalReferences off is offered its own sources, machines and projects only.
  // Discovery alone: saving, resolving and listing references are unchanged.
  const own=suggest&&isolated.has(input.project);
  for(const r of entries){
   if(input.kind&&input.kind!==r.kind||input.scope&&input.scope!==r.scope)continue;
   if(suggest?!referenceVisible(r,input.project,{isolated:own}):input.project&&input.project!==r.project)continue;
   const label=fold(r.label),prefix=label.startsWith(q);
   if(!prefix&&!fold(r.id).startsWith(q)&&!label.split(/[^\p{L}\p{N}]+/u).some(word=>word.startsWith(q)))continue;
   matches.push({r,rank:(prefix?0:2)+(r.project===input.project?0:1)});
  }
  matches.sort((a,b)=>a.rank-b.rank||a.r.label.localeCompare(b.r.label)||referenceKey(a.r).localeCompare(referenceKey(b.r)));
  return {total:matches.length,items:matches.slice(offset,offset+limit).map(({r})=>projection(r))};
 }
 function projection({kind,id,label,scope,project,href}){return {kind,id,label,scope,project,href};}
 async function resolve(input){
  if(!exactKeys(input,['refs'])||!Array.isArray(input.refs)||input.refs.length>100||
    !input.refs.every(r=>exactKeys(r,['id','kind'])&&validReference(r.kind,r.id)))fail('invalid');
  const wanted=new Set(input.refs.map(referenceKey));
  return {items:(await catalog()).entries.filter(r=>wanted.has(referenceKey(r))).map(projection)};
 }
 async function usages(kind,id,offset,limit){
  const [pages,ticketHits]=await Promise.all([wiki.summaries(),tickets.findMentionUsages(kind,id)]);
  const hits=[...ticketHits];
  for(const page of pages){
   const found=kind==='ticket'?page.links.tickets.includes(id):page.links.refs?.some(r=>r.id===id&&r.kind===kind);
   if(found)hits.push({source:{kind:'wiki',id:page.project+'/'+page.id,label:page.title,project:page.project,href:referenceHref('wiki',page.project+'/'+page.id)},updatedAt:page.updatedAt});
  }
  hits.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.source.id.localeCompare(b.source.id));
  const window=hits.slice(offset,offset+limit);
  await Promise.all(window.filter(h=>h.source.kind==='wiki').map(async hit=>{
   const [project,page]=hit.source.id.split('/');hit.excerpt=wikiExcerpt((await wiki.get(project,page)).doc,kind,id);
  }));
  return {usages:window,usageTotal:hits.length};
 }
 async function target(kind,id){
  if(!validReference(kind,id))fail('invalid');
  const {entries}=await catalog(),source=entries.find(r=>r.kind===kind&&r.id===id);
  if(!source)fail('not-found');
  if(owned(kind)){
   const record=await readRecord(source);if(!record)fail('not-found');
   return {record:{...record,href:source.href},note:null};
  }
  return {record:source,note:await store.get('notes',referenceKey(source))};
 }
 async function get(input){
  if(!exactKeys(input,['kind','id','offset','limit']))fail('invalid');
  const offset=number(input.offset,0,0,1000000),limit=number(input.limit,50,1,100);
  const {kind,id}=input,{record,note}=await target(kind,id);
  return {record,note,...await usages(kind,id,offset,limit)};
 }
 async function save(input,by,local){
  if(!exactKeys(input,['kind','id','rev','label','description',...(local?['project']:[])])||!owned(input.kind)||
    (local&&(input.kind!=='custom'||!validReference('project',input.project)))||!validLabel(input.label))fail('invalid');
  const scope=local?'local':'global',project=local?input.project:null;
  const label=input.label.trim(),note=description(input.description??'');
  const updating=input.id!==undefined;
  if(updating?!validReference(input.kind,input.id):input.rev!==undefined)fail('invalid');
  if(local&&!(await tickets.projects()).some(p=>p.id===project))fail('invalid');
  const id=updating?input.id:(input.kind==='model'?'m':'r')+randomBytes(16).toString('hex');
  return store.change({[scope]:local?project+'/':null},data=>{
   const records=data[scope],old=records.find(r=>r.id===id);
   if(updating){if(!old)fail('not-found');requireRev(input.rev,old.rev);}
   else if(old)fail('conflict');
   capacity(records,{kind:input.kind,label},old);
   const at=new Date().toISOString(),record=old??{kind:input.kind,id,project,scope,rev:0,createdAt:at,createdBy:by};
   Object.assign(record,{label,description:note,rev:record.rev+1,updatedAt:at,updatedBy:by});
   if(!old)records.push(record);
   return record;
  });
 }
 function promote(input,by){
  if(!exactKeys(input,['kind','id','project','rev'])||!validReference('project',input.project)||input.kind!=='custom'||!validReference(input.kind,input.id))fail('invalid');
  return store.change({local:[input.project+'/'+input.id],global:null},data=>{
   const record=data.local[0];if(!record)fail(data.global.some(r=>r.id===input.id)?'conflict':'not-found');
   requireRev(input.rev,record.rev);
   capacity(data.global,record);
   data.local=[];Object.assign(record,{project:null,scope:'global',rev:record.rev+1,updatedAt:new Date().toISOString(),updatedBy:by});
   data.global.push(record);return record;
  });
 }
 function remove(input,local){
  if(!exactKeys(input,['id','kind','rev',...(local?['project']:[])])||!owned(input.kind)||!validReference(input.kind,input.id)||local&&!validReference('project',input.project))fail('invalid');
  const coll=local?'local':'global';
  return store.change({[coll]:[local?input.project+'/'+input.id:input.id]},data=>{
   const r=data[coll][0];if(!r)fail('not-found');requireRev(input.rev,r.rev);data[coll]=[];return {kind:r.kind,id:r.id};
  });
 }
 async function annotate(input,by,share=false){
  if(!exactKeys(input,['kind','id','rev',...(share?[]:['description'])])||owned(input.kind)||!validReference(input.kind,input.id)||
    share&&!['ticket','wiki'].includes(input.kind))fail('invalid');
  const note=share?undefined:description(input.description);
  await target(input.kind,input.id);
  return store.change({notes:[referenceKey(input)]},(data,count)=>{
   const record=data.notes[0]??{kind:input.kind,id:input.id,description:'',rev:0};
   requireRev(input.rev,record.rev);
   if(!data.notes.length&&count('notes')>=5000)fail('limit');
   if(share)record.shared=true;else record.description=note;
   Object.assign(record,{rev:record.rev+1,updatedAt:new Date().toISOString(),updatedBy:by});
   data.notes=[record];return record;
  });
 }
 return {machines,search,resolve,get,save,remove,promote,annotate,prepareMentionGuard};
}
