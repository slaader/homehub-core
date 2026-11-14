// Typed views of existing stores. Nothing is copied into another registry: inventory owns services,
// the software watch owns detection rules, and runtime providers own observations and model placements.
import {entryInput,entryHash} from '../scripts/knowledge-edit.mjs';
import {SERVICE_KINDS,SERVICE_PLATFORMS,serviceProblems,ENTRY_ID} from '../public/inventory-rules.js';
export {SERVICE_KINDS,SERVICE_PLATFORMS};
const arr=v=>Array.isArray(v)?v:[];
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const key=(...parts)=>parts.map(x=>encodeURIComponent(x??'')).join(':');
const fail=detail=>{throw Object.assign(new Error('invalid'),{detail});};

export function catalog({devices=[],inventory={entries:[]},endpoints=[],watch={items:[]},models={}}={}) {
 const entries=arr(inventory?.entries),warnings=[],deviceMap=new Map(devices.map(d=>[d.id,{id:d.id,name:d.name||d.id,source:'overview'}]));
 for(const d of entries.filter(e=>e.kind==='device'))if(!deviceMap.has(d.id))deviceMap.set(d.id,{id:d.id,name:d.name,source:'inventory'});
 const services=[],software=[],byEndpoint=new Map(),byRuntime=new Map(),byEntry=new Map(),byWatch=new Map();
 const runtimeKey=(device,runtime)=>key(device,runtime);
 for(const e of entries.filter(e=>e.kind==='runtime')){
  const s={id:`inventory:${e.id}`,inventoryId:e.id,name:e.name,device:e.device,kind:e.service?.kind||null,binary:e.service?.binary||null,
   platform:e.service?.platform||null,mode:e.service?.mode||null,port:e.service?.port??null,address:e.address||null,status:'unknown',version:e.version||null,
   source:'inventory',endpointId:e.service?.endpointId||null,software:null,hash:entryHash(e)};
  services.push(s);byEntry.set(e.id,s.id);
  if(s.endpointId){if(byEndpoint.has(s.endpointId))warnings.push(`Multiple services reference endpoint ${s.endpointId}`);else byEndpoint.set(s.endpointId,s);}
 }
 for(const e of endpoints){
  let s=byEndpoint.get(e.id);
  if(s&&s.device!==e.device){warnings.push(`Service ${s.inventoryId} and endpoint ${e.id} name different devices`);s=null;}
  if(!s){s={id:`endpoint:${e.id}`,name:e.name||e.kind,device:e.device,kind:e.kind,binary:null,platform:null,mode:'server',port:portOf(e.url),address:e.url,status:'unknown',version:null,source:'runtime-endpoint',endpointId:e.id,software:null};services.push(s);}
  s.status=e.status||'unknown';s.address=e.url;s.endpointId=e.id;
  if(e.runtimeId)byRuntime.set(runtimeKey(e.device,e.runtimeId),s);
 }
 for(const d of arr(models.devices))for(const r of arr(d.runtimes)){
  const k=runtimeKey(d.device,r.id);let s=byRuntime.get(k);
  if(!s){s={id:`runtime:${k}`,name:r.name||r.id,device:d.device,kind:r.kind||null,binary:null,platform:null,mode:r.mode||'server',port:portOf(r.url),address:r.url||null,status:r.status||'unknown',version:r.version||null,source:'runtime-observation',endpointId:null,software:null};services.push(s);byRuntime.set(k,s);}
  else {s.status=r.status||s.status;s.version=r.version||s.version;}
 }
 for(const s of services)if(s.endpointId&&!endpoints.some(e=>e.id===s.endpointId))warnings.push(`Service ${s.inventoryId} references missing endpoint ${s.endpointId}`);
 for(const item of arr(watch.items))for(const [device,rule] of Object.entries(item.detect||{})){
  const sw={id:`watch:${key(device,item.id)}`,watchId:item.id,name:item.name,device,version:null,status:'configured',source:'software-watch',inventoryIds:arr(rule.inventory)};
  software.push(sw);byWatch.set(key(device,item.id),sw);
  for(const id of sw.inventoryIds)if(!byEntry.has(id))byEntry.set(id,sw.id);
 }
 for(const e of entries.filter(e=>e.kind==='tool')){
  const existing=software.find(s=>s.device===e.device&&s.inventoryIds.includes(e.id));
  if(existing){existing.version=e.version||null;existing.status='recorded';continue;}
  const sw={id:`inventory:${e.id}`,inventoryIds:[e.id],watchId:null,name:e.name,device:e.device,version:e.version||null,status:'recorded',source:'inventory'};
  software.push(sw);byEntry.set(e.id,sw.id);
 }
 for(const e of entries.filter(e=>e.service?.watchId)){
  const sw=byWatch.get(key(e.device,e.service.watchId)),s=services.find(s=>s.inventoryId===e.id);
  if(sw&&s)s.software=sw.id;else warnings.push(`Service ${e.id} references an absent software rule on its device: ${e.service.watchId}`);
 }
 const deployments=[];
 for(const model of arr(models.models))for(const p of arr(model.placements)){
  const s=byRuntime.get(runtimeKey(p.device,p.runtime));
  deployments.push({id:`model:${key(p.device,p.runtime,p.id||model.name)}`,name:model.name,kind:model.kind,device:p.device,service:s?.id||null,runtime:p.runtime,status:p.state||'unknown',source:'runtime-observation'});
 }
 const clients=[],uses=[];
 for(const c of arr(models.clients)){
  const client={id:`client:${key(c.clientDevice,c.client)}`,name:c.client,device:c.clientDevice||null,source:'request-history'};clients.push(client);
  for(const t of arr(c.targets)){const s=byRuntime.get(runtimeKey(t.device,t.runtime));uses.push({id:`uses:${key(client.id,t.device,t.runtime)}`,client:client.id,service:s?.id||null,targetDevice:t.device,targetRuntime:t.runtime,requests:t.requests,source:'request-history'});}
 }
 for(const e of entries)for(const d of arr(e.depends_on).filter(d=>d.kind==='call')){
  const s=services.find(s=>s.inventoryId===d.id);if(!s)continue;
  let id=byEntry.get(e.id);
  if(!id){id=`inventory:${e.id}`;if(!clients.some(c=>c.id===id))clients.push({id,name:e.name,device:e.device||null,source:'inventory'});}
  uses.push({id:`uses:${key(id,s.id)}`,client:id,service:s.id,targetDevice:s.device,requests:null,source:'inventory'});
 }
 return {schemaVersion:1,devices:[...deviceMap.values()],services,software,models:deployments,clients,uses,warnings};
}
function portOf(url){try{const u=new URL(url);return Number(u.port)||(u.protocol==='https:'?443:u.protocol==='http:'?80:null);}catch{return null;}}

// Registration patches only the typed fields of an existing inventory runtime, preserving notes,
// dependencies and secret pointers. Optimistic concurrency is still enforced by the single inventory writer.
export function serviceRegistration(input,{inventory,endpoints=[],watch={items:[]}}) {
 const allowed=['id','name','device','kind','binary','port','platform','mode','address','endpointId','watchId','base'];
 if(!plain(input)||Object.keys(input).some(k=>!allowed.includes(k)))fail(`Expected only ${allowed.join(', ')}`);
 if(typeof input.id!=='string'||!ENTRY_ID.test(input.id))fail('id must be an inventory entry id');
 if(typeof input.name!=='string'||!input.name.trim()||input.name.length>120)fail('name must have 1..120 characters');
 const entries=arr(inventory?.entries),existing=entries.find(e=>e.id===input.id);
 if(existing&&existing.kind!=='runtime')fail('That id belongs to an inventory entry of another kind');
 if(!entries.some(e=>e.id===input.device&&e.kind==='device'))fail('device must name an inventory device entry; add the device first');
 const service={kind:input.kind,binary:input.binary,platform:input.platform,mode:input.mode||'server',port:input.port,
  ...(input.endpointId?{endpointId:input.endpointId}:{}),...(input.watchId?{watchId:input.watchId}:{})};
 const problems=serviceProblems(service);if(problems.length)fail(problems.join('; '));
 if(service.endpointId){
  const endpoint=endpoints.find(e=>e.id===service.endpointId);if(!endpoint||endpoint.device!==input.device)fail('endpointId must name an existing endpoint on this device');
  if(entries.some(e=>e.id!==input.id&&e.service?.endpointId===service.endpointId))fail('Another service already references this endpoint');
 }
 if(service.watchId&&!arr(watch.items).some(i=>i.id===service.watchId&&Object.hasOwn(i.detect||{},input.device)))fail('watchId must name a software rule for this device');
 if(input.address!==undefined&&(typeof input.address!=='string'||input.address.length>2000))fail('address must be text of at most 2000 characters');
 const entry={...existing,id:input.id,kind:'runtime',name:input.name.trim(),device:input.device,service,
  ...(input.address!==undefined?{address:input.address}:{}),confidence:existing?.confidence||'inferred'};
 return entryInput({entry,...(input.base!==undefined?{base:input.base}:{})});
}
