import {randomBytes} from 'node:crypto';
import {exactKeys} from '../public/wiki-doc.js';
import {referenceKey,validLabel,validReference} from '../public/reference-format.js';

const fail=message=>{throw new Error(message);};
const collNames=['global','local','notes'];
const rowKey=(coll,r)=>coll==='local'?r.project+'/'+r.id:coll==='notes'?referenceKey(r):r.id;
export const REFERENCE_SCHEMA=1;
export const fold=text=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const owned=kind=>kind==='model'||kind==='custom';
const requireRev=(given,want)=>{if(!Number.isSafeInteger(given)||given<0)fail('invalid');if(given!==want)fail('conflict');};
const description=value=>{
 if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||value.length>8000)fail('invalid');
 return value.trim();
};

// Called inside the source write transaction. Local/Settings moves and visibility checks see a single SQLite snapshot.
export async function referenceGuard(db,machines,refs){
 if(!refs.length)return ()=>{};
 const devices=refs.some(r=>r.kind==='machine')?new Set((await machines()).map(d=>d.id)):null;
 const read=db.db.prepare('SELECT doc FROM docs WHERE kind=? AND coll=? AND id=?');
 const get=(kind,coll,id)=>{const row=read.get(kind,coll,id);return row&&JSON.parse(row.doc);};
 return (project,previous=[])=>{
  const saved=new Set(previous.map(referenceKey));
  for(const ref of refs){
   const {kind,id}=ref;
   if(saved.has(referenceKey(ref)))continue; // A previously valid mention may retain its fallback after deletion.
   let ok;
   if(owned(kind))ok=(get('references','global',id)??get('references','local',project+'/'+id))?.kind===kind;
   else if(kind==='machine')ok=devices.has(id);
   else if(kind==='project')ok=get('tickets','projects',id);
   else{
    const native=kind==='wiki'?get('wiki','summaries',id):get('tickets','tickets',id);
    ok=native&&(native.project===project||get('references','notes',referenceKey(ref))?.shared);
   }
   if(!ok)fail('unavailable-reference');
  }
 };
}

export function createReferenceRecords(db){
 const store=db.collection('references',{
  empty:()=>({schema:REFERENCE_SCHEMA}),
  checkMeta:meta=>{if(meta.schema!==REFERENCE_SCHEMA)throw new Error('Unsupported reference schema');},
  join:(meta,colls)=>({...meta,...Object.fromEntries(collNames.map(k=>[k,(colls[k]??[]).map(([,r])=>r)]))}),
  split:data=>({meta:{schema:data.schema},colls:Object.fromEntries(collNames.map(k=>[k,(data[k]??[]).map(r=>[rowKey(k,r),r])]))}),
 });
 function capacity(records,item,except){
  if(records.length>=2000&&!except)fail('limit');
  if(records.some(r=>r!==except&&r.kind===item.kind&&fold(r.label)===fold(item.label)))fail('conflict');
 }
 function save(input,by,local){
  if(!exactKeys(input,['kind','id','rev','label','description',...(local?['project']:[])])||!owned(input.kind)||
    (local&&(input.kind!=='custom'||!validReference('project',input.project)))||!validLabel(input.label))fail('invalid');
  const scope=local?'local':'global',project=local?input.project:null;
  const label=input.label.trim(),note=description(input.description??'');
  const updating=input.id!==undefined;
  if(updating?!validReference(input.kind,input.id):input.rev!==undefined)fail('invalid');
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
 function annotate(input,by,share=false){
  if(!exactKeys(input,['kind','id','rev',...(share?[]:['description'])])||owned(input.kind)||!validReference(input.kind,input.id)||
    share&&!['ticket','wiki'].includes(input.kind))fail('invalid');
  const note=share?undefined:description(input.description);
  return store.change({notes:[referenceKey(input)]},(data,count)=>{
   const record=data.notes[0]??{kind:input.kind,id:input.id,description:'',rev:0};
   requireRev(input.rev,record.rev);
   if(!data.notes.length&&count('notes')>=5000)fail('limit');
   if(share)record.shared=true;else record.description=note;
   Object.assign(record,{rev:record.rev+1,updatedAt:new Date().toISOString(),updatedBy:by});
   data.notes=[record];return record;
  });
 }
 const brief=db.db.prepare(`SELECT json_extract(doc,'$.kind') AS kind,json_extract(doc,'$.id') AS id,
  json_extract(doc,'$.project') AS project,json_extract(doc,'$.label') AS label,coll AS scope
  FROM docs WHERE kind='references' AND coll IN ('local','global')`);
 const shared=db.db.prepare("SELECT id FROM docs WHERE kind='references' AND coll='notes' AND json_extract(doc,'$.shared')=1");
 return {save,promote,remove,annotate,version:store.version,brief:()=>brief.all(),shared:()=>new Set(shared.all().map(r=>r.id)),
  note:ref=>store.get('notes',referenceKey(ref)),async get(r){
   const record=await store.get(r.scope,rowKey(r.scope,r));
   // Promotion may commit between reading the source catalog and fetching its description.
   return record??(r.scope==='local'?await store.get('global',r.id):null);
  }};

}
