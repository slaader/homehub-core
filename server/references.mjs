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

function truncateCodePoints(str,maxLen){
 if(str.length<=maxLen)return str;
 let end=maxLen;
 if(end>0&&str.charCodeAt(end-1)>=0xd800&&str.charCodeAt(end-1)<=0xdbff)end--;
 return str.slice(0,end).trimEnd();
}

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

function createDbWikiTargetLookup(db){
 const query=db.db.prepare(`SELECT json_extract(p.doc,'$.project') AS spaceId,
  COALESCE(json_extract(w.doc,'$.projectId'),CASE WHEN json_type(w.doc,'$.projectId')='null' THEN NULL ELSE json_extract(w.doc,'$.project') END) AS projectId
  FROM docs p
  JOIN docs w ON w.kind='wiki' AND w.coll='wikis' AND w.id=json_extract(p.doc,'$.project')
  WHERE p.kind='wiki' AND p.coll='summaries' AND p.id=?`);
 return id=>{
  const row=query.get(id);
  return row?{spaceId:row.spaceId,projectId:row.projectId??null}:null;
 };
}

function createDbEpicProjectLookup(db){
 const query=db.db.prepare("SELECT json_extract(doc,'$.project') AS project FROM docs WHERE kind='tickets' AND coll='epics' AND id=?");
 return id=>query.get(id)?.project??null;
}

export function planReferencePromotion(data,project){
 const projectId=typeof project==='string'?project:project?.id;
 if(!validReference('project',projectId))fail('invalid');
 const key=(typeof project==='object'&&typeof project?.key==='string'&&project.key.trim())?project.key.trim():projectId.toUpperCase();
 const globalCustom=(data.global??[]).filter(r=>r.kind==='custom');
 const byFold=new Map(globalCustom.map(r=>[fold(r.label),r]));
 const used=new Set(byFold.keys());
 const locals=(data.local??[]).filter(r=>r.project===projectId&&r.kind==='custom').sort((a,b)=>a.id.localeCompare(b.id));
 const collisions=[],plan=[];
 for(const r of locals){
  const base=r.label.trim(),baseFold=fold(base);
  if(!used.has(baseFold)){
   used.add(baseFold);
   plan.push({id:r.id,kind:r.kind,from:r.label,label:base,renamed:false});
   continue;
  }
  const existing=byFold.get(baseFold)??null;
  for(let n=1;;n++){
   const suffix=n===1?` (${key})`:` (${key} ${n})`;
   const maxHead=200-suffix.length;
   const head=truncateCodePoints(base,maxHead);
   const candidate=(head||truncateCodePoints(key,maxHead))+suffix;
   const cf=fold(candidate);
   if(validLabel(candidate)&&!used.has(cf)){
    used.add(cf);
    collisions.push({id:r.id,kind:r.kind,from:r.label,to:candidate,existingId:existing?.id??null,existingLabel:existing?.label??null});
    plan.push({id:r.id,kind:r.kind,from:r.label,label:candidate,renamed:true});
    break;
   }
  }
 }
 return {localCount:locals.length,locals:locals.map(r=>({id:r.id,kind:r.kind,label:r.label,rev:r.rev})),collisions,plan};
}

// Two-phase Mention guard: phase 1 (async) snapshots device IDs before a write transaction; phase 2 (sync) runs
// inside SQLite BEGIN IMMEDIATE so concurrent promotions, deletions and shares observe one atomic snapshot.
export function createMentionGuard({db,tickets=null,wiki=null,machines=async()=>[],lookup=null}={}){
 const refsLookup=lookup??createReferenceLookup(db);
 const wikiTargetSync=wiki?.wikiTargetSync??(db?createDbWikiTargetLookup(db):null);
 const epicProjectFallback=db?createDbEpicProjectLookup(db):null;
 function describeSync(ref,project,devices){
  const {kind,id}=ref;
  if(owned(kind))return refsLookup.owned(kind,id,project);
  if(kind==='machine')return devices?.has(id)?{kind,scope:'global',project:null}:null;
  if(kind==='project')return tickets?.hasProjectSync?.(id)?{kind,scope:'global',project:null}:null;
  if(kind==='ticket'){
   const owner=tickets?.ticketProjectSync?.(id);
   return owner?{kind,scope:referenceScope(owner,refsLookup.isShared(ref)),project:owner}:null;
  }
  if(kind==='epic'){
   const owner=typeof tickets?.epicProjectSync==='function'?tickets.epicProjectSync(id):epicProjectFallback?.(id);
   return owner?{kind,scope:referenceScope(owner,refsLookup.isShared(ref)),project:owner}:null;
  }
  if(kind==='wiki'){
   if(wikiTargetSync){
    const target=wikiTargetSync(id);
    return target?{kind,scope:referenceScope(target.projectId,refsLookup.isShared(ref)),project:target.projectId}:null;
   }
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
 const nativeTarget=hub.db.db.prepare('SELECT 1 FROM docs WHERE kind=? AND coll=? AND id=?');
 const targetRows={project:['tickets','projects'],ticket:['tickets','tickets'],epic:['tickets','epics'],wiki:['wiki','summaries']};
 const stillExists=(kind,id)=>!Object.hasOwn(targetRows,kind)||Boolean(nativeTarget.get(...targetRows[kind],id));


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
   const [projects,refRows,epicRows,pages,spaceRows]=await Promise.all([
    tickets.projects(),
    tickets.referenceSummaries(),
    typeof tickets.epicSummaries==='function'?tickets.epicSummaries():[],
    wiki.summaries(),
    typeof wiki.spaces==='function'?wiki.spaces({includeHidden:true}):null,
   ]);
   const shared=new Set(sharedQuery.all().map(r=>r.id));
   const spaceMap=spaceRows?new Map(spaceRows.map(s=>[s.id,s.projectId??null])):null;
   const trackerEntries=[],seenEpics=new Set();
   for(const r of refRows){
    const kind=r.kind==='epic'?'epic':'ticket';
    if(kind==='epic')seenEpics.add(r.id);
    trackerEntries.push(entry(kind,r.id,r.title,r.project));
   }
   for(const e of epicRows){
    if(seenEpics.has(e.id))continue;
    seenEpics.add(e.id);
    trackerEntries.push(entry('epic',e.id,e.title,e.project));
   }
   const wikiEntries=pages.filter(p=>!spaceMap||spaceMap.has(p.project))
    .map(p=>entry('wiki',p.project+'/'+p.id,p.title,spaceMap?spaceMap.get(p.project):p.project));
   const entries=[...projects.map(p=>entry('project',p.id,p.name)),...trackerEntries,...wikiEntries,...briefQuery.all()];
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
  const [pages,spaceRows,ticketHits,epicHits]=await Promise.all([
   wiki.summaries(),
   typeof wiki.spaces==='function'?wiki.spaces({includeHidden:true}):null,
   tickets.findMentionUsages(kind,id),
   typeof tickets.findEpicMentionUsages==='function'?tickets.findEpicMentionUsages(kind,id):[],
  ]);
  const spaceMap=spaceRows?new Map(spaceRows.map(s=>[s.id,s.projectId??null])):null;
  const hits=[...ticketHits,...epicHits];
  for(const page of pages){
   if(spaceMap&&!spaceMap.has(page.project))continue;
   const found=kind==='ticket'?page.links.tickets.includes(id):page.links.refs?.some(r=>r.id===id&&r.kind===kind);
   if(found)hits.push({source:{kind:'wiki',id:page.project+'/'+page.id,label:page.title,project:spaceMap?spaceMap.get(page.project):page.project,href:referenceHref('wiki',page.project+'/'+page.id)},updatedAt:page.updatedAt});
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
   if(local&&!stillExists('project',project))fail('invalid');
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
  await target(input?.kind,input?.id);
  if(!exactKeys(input,['kind','id','rev',...(share?[]:['description'])])||owned(input.kind)||
    share&&!['ticket','epic','wiki'].includes(input.kind))fail('invalid');
  const note=share?undefined:description(input.description);
  return store.change({notes:[referenceKey(input)]},(data,count)=>{
   if(!stillExists(input.kind,input.id))fail('not-found');
   const record=data.notes[0]??{kind:input.kind,id:input.id,description:'',rev:0};
   requireRev(input.rev,record.rev);
   if(!data.notes.length&&count('notes')>=5000)fail('limit');
   if(share)record.shared=true;else record.description=note;
   Object.assign(record,{rev:record.rev+1,updatedAt:new Date().toISOString(),updatedBy:by});
   data.notes=[record];return record;
  });
 }

 async function previewPromotion(project){
  const projectId=typeof project==='string'?project:project?.id;
  if(!validReference('project',projectId))fail('invalid');
  const [local,global]=await Promise.all([store.list('local',projectId+'/'),store.list('global')]);
  return planReferencePromotion({local,global},project);
 }

 const lifecycle={
  store,
  select(projectId){
   if(!validReference('project',projectId))fail('invalid');
   return {local:projectId+'/',global:null,notes:null};
  },
  planPromotion(data,project){
   return planReferencePromotion(data,project);
  },
  removeProject(data,project,{promote:shouldPromote=false,collisions: _collisions=null,ticketIds=[],epicIds=[],wikiPageKeys=[],wikiSpaceId=null,by='system',at=new Date().toISOString()}={}){
   const projectId=typeof project==='string'?project:project?.id;
   if(!validReference('project',projectId))fail('invalid');
   const locals=(data.local??[]).filter(r=>r.project===projectId);
   const promoted=[],renamed=[],deletedLocal=[];
   if(shouldPromote){
    const planned=planReferencePromotion(data,project);
    if((data.global?.length??0)+locals.length>2000)fail('limit');
    if(locals.some(r=>data.global.some(g=>g.id===r.id)))fail('conflict');
    const byId=new Map(planned.plan.map(item=>[item.id,item]));
    data.local=data.local.filter(r=>r.project!==projectId);
    for(const r of locals){
     const plan=byId.get(r.id);
     const from=r.label,label=plan?plan.label:r.label,wasRenamed=Boolean(plan?.renamed);
     Object.assign(r,{project:null,scope:'global',label,rev:r.rev+1,updatedAt:at,updatedBy:by});
     data.global.push(r);
     promoted.push({id:r.id,kind:r.kind,from,label,renamed:wasRenamed});
     if(wasRenamed)renamed.push({id:r.id,from,to:label});
    }
   }else{
    data.local=data.local.filter(r=>r.project!==projectId);
    for(const r of locals)deletedLocal.push(r.id);
   }
   const dropKeys=new Set([
    referenceKey({kind:'project',id:projectId}),
    ...(ticketIds??[]).map(id=>referenceKey({kind:'ticket',id})),
    ...(epicIds??[]).map(id=>referenceKey({kind:'epic',id})),
    ...(wikiPageKeys??[]).map(id=>referenceKey({kind:'wiki',id})),
   ]);
   const removedNotes=[];
   data.notes=(data.notes??[]).filter(n=>{
    const key=referenceKey(n);
    const drop=dropKeys.has(key)||(Boolean(wikiSpaceId)&&n.kind==='wiki'&&n.id.startsWith(wikiSpaceId+'/'));
    if(drop)removedNotes.push(key);
    return !drop;
   });
   return {promoted,renamed,deletedLocal,removedNotes};
  },
  notify(){cached=null;},
 };

 return {machines,search,resolve,get,save,remove,promote,annotate,previewPromotion,prepareMentionGuard,lifecycle};
}
