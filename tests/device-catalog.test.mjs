import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,serviceRegistration} from '../server/device-catalog.mjs';
import {check,serviceProblems} from '../public/inventory-rules.js';
import {hub} from './hub-helper.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EMPTY_SITE} from '../server/site-config.mjs';
import {entryHash} from '../scripts/knowledge-edit.mjs';

const service={kind:'omlx',binary:'/opt/bin/omlx',platform:'macos',mode:'server',port:8000,endpointId:'server-omlx',watchId:'omlx'};
const inventory={schema:2,updated_at:'2026-11-14',entries:[
 {id:'server',name:'Server',kind:'device',verified_at:'2026-11-14'},
 {id:'laptop',name:'Laptop',kind:'device',verified_at:'2026-11-14'},
 {id:'server-llm',name:'Language service',kind:'runtime',device:'server',service,address:'http://10.0.0.2:8000',verified_at:'2026-11-14',notes:'Keep these notes',secrets:[{what:'Access',store:'remembered'}]},
 {id:'laptop-editor',name:'Editor',kind:'tool',device:'laptop',depends_on:[{id:'server-llm',kind:'call'}],verified_at:'2026-11-14'}]};
const endpoints=[{id:'server-omlx',device:'server',kind:'omlx',url:'http://10.0.0.2:8000',runtimeId:'omlx',status:'ok'}];
const watch={items:[{id:'omlx',name:'oMLX',detect:{server:{kind:'cmd',path:'/opt/bin/omlx',args:'--version'}}},{id:'editor',name:'Editor',detect:{laptop:{kind:'app',path:'/Applications/Editor.app',inventory:['laptop-editor']}}}]};
const models={devices:[{device:'server',runtimes:[{id:'omlx',kind:'omlx',name:'oMLX',status:'running',version:'1'}]}],
 models:[{name:'sample-model',kind:'llm',placements:[{device:'server',runtime:'omlx',id:'sample-model',state:'loaded'}]}],
 clients:[{client:'Editor',clientDevice:'laptop',targets:[{device:'server',runtime:'omlx',requests:7}]}]};

test('catalog joins explicit endpoint/watch references and observed model/client relationships without duplicating the service',()=>{
 const data=catalog({inventory,endpoints,watch,models});
 assert.equal(data.services.length,1);assert.equal(data.services[0].id,'inventory:server-llm');assert.equal(data.services[0].status,'running');
 assert.equal(data.services[0].software,'watch:server:omlx');assert.equal(data.software.length,2);
 assert.equal(data.models[0].service,'inventory:server-llm');assert.equal(data.models[0].device,'server');assert.equal(data.models[0].kind,'llm');
 assert.equal(data.clients[0].device,'laptop');assert.equal(data.uses.length,2);
 assert(data.uses.every(u=>u.service==='inventory:server-llm'));assert.deepEqual(data.warnings,[]);
 const reordered=catalog({inventory:{...inventory,entries:[...inventory.entries].reverse()},endpoints:[...endpoints].reverse(),watch:{items:[...watch.items].reverse()},models});
 assert.deepEqual(data.models,reordered.models);assert.equal(reordered.services[0].id,data.services[0].id);
});

test('missing references and unknown clients stay explicit, watch rules are not observations of installed software',()=>{
 const data=catalog({inventory,watch,models:{clients:[{client:'Unattributed',clientDevice:null,targets:[{device:'server',runtime:'missing',requests:1}]}]}});
 assert.equal(data.clients[0].device,null);assert.equal(data.uses[0].service,null);
 assert.equal(data.software.find(x=>x.watchId==='omlx').status,'configured');assert.match(data.warnings[0],/missing endpoint/);
 assert.equal(data.models.length,0);
});

test('typed service descriptors are validated by the same inventory checker used by every writer',()=>{
 assert.deepEqual(check(inventory).errors,[]);
 for(const bad of [{port:0},{port:65536},{platform:'bsd'},{binary:'relative/path'},{binary:'/opt/../secret'},{kind:'made-up'},{extra:true},{mode:'on-demand',port:8000}]){
  const doc=structuredClone(inventory);Object.assign(doc.entries[2].service,bad);assert(check(doc).errors.length,JSON.stringify(bad));
 }
 assert.deepEqual(serviceProblems({kind:'mflux',platform:'linux',mode:'on-demand',port:null,binary:'/opt/bin/mflux'}),[]);
 assert.deepEqual(serviceProblems({kind:'generic',platform:'windows',mode:'server',port:8000,binary:'C:\\Program Files\\Example\\service.exe'}),[]);
 const wrongKind=structuredClone(inventory);wrongKind.entries[2].kind='tool';assert.match(check(wrongKind).errors.join(' '),/only allowed on runtime/);
});

test('registration preserves unrelated inventory fields and validates device, endpoint and software references',()=>{
 const current=inventory.entries[2],input={id:current.id,name:'Updated service',device:'server',...service,base:entryHash(current)};
 const change=serviceRegistration(input,{inventory,endpoints,watch});
 assert.equal(change.base,entryHash(current));assert.equal(change.entry.notes,current.notes);assert.deepEqual(change.entry.secrets,current.secrets);
 assert.throws(()=>serviceRegistration({...input,device:'missing'},{inventory,endpoints,watch}),/invalid/);
 assert.throws(()=>serviceRegistration({...input,endpointId:'missing'},{inventory,endpoints,watch}),/invalid/);
 assert.throws(()=>serviceRegistration({...input,watchId:'missing'},{inventory,endpoints,watch}),/invalid/);
 assert.throws(()=>serviceRegistration({...input,id:'laptop-editor'},{inventory,endpoints,watch}),/invalid/);
});

test('HTTP registration uses inventory authorization and optimistic hashes; joined software data keeps security:read',async t=>{
 const h=await hub(t);
 for(const [file,type] of [['device-record.js','javascript'],['device-record.css','text/css']]){
  const response=await fetch(h.origin+'/'+file);
  assert.equal(response.status,200,file);
  assert.match(response.headers.get('content-type'),new RegExp(type));
 }
 const reader=await h.account('catalog-reader',['read']),writer=await h.account('catalog-writer',['read','inventory:write']),security=await h.account('catalog-security',['security:read']);
 const body={id:'studio-new-service',device:'studio',name:'Registered example',kind:'generic',binary:'/opt/bin/example',platform:'macos',mode:'server',port:9000};
 assert.equal((await h.post('/api/service-registrations',body,reader.headers)).status,403);
 const created=await h.post('/api/service-registrations',body,writer.headers);assert.equal(created.status,200);const result=await created.json();
 assert.equal(result.entry.service.port,9000);assert.equal(result.entry.confidence,'inferred');
 assert.equal((await h.post('/api/service-registrations',{...body,name:'Replacement'},writer.headers)).status,409);
 assert.equal((await h.post('/api/service-registrations',{...body,name:'Replacement',base:result.hash},writer.headers)).status,200);
 assert.equal((await fetch(h.origin+'/api/device-catalog',{headers:reader.headers})).status,403);
 const response=await fetch(h.origin+'/api/device-catalog',{headers:security.headers});assert.equal(response.status,200);
 const data=await response.json();assert(data.services.some(s=>s.inventoryId===body.id));
 const bad=await h.post('/api/service-registrations',{...body,id:'bad',port:0},writer.headers);assert.equal(bad.status,422);
});


test('a fresh hub without inventory, watch file or runtime configuration returns an empty usable catalog',async t=>{
 const scratch=await mkdtemp(path.join(os.tmpdir(),'catalog-empty-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const h=await hub(t,{site:EMPTY_SITE,softwareWatchFile:path.join(scratch,'missing-watch.json')});
 await rm(path.join(h.dir,'knowledge.json'));
 const response=await fetch(h.origin+'/api/device-catalog',{headers:h.admin});assert.equal(response.status,200);
 const data=await response.json();for(const field of ['devices','services','software','models','clients','uses','warnings'])assert.deepEqual(data[field],[],field);
 const attempt=await h.post('/api/service-registrations',{id:'service',device:'missing',name:'Example',kind:'generic',platform:'linux',binary:'/opt/bin/example',port:80},h.admin);
 assert.equal(attempt.status,422);
});
