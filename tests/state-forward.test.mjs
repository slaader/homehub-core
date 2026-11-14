// State written by Home Hub 1.0.0 loads in 2.0 (AGENTS.md → Versioning: migrations are forward-only).
// Every test starts from a literal of what 1.0.0 wrote (its own key for a device, its schema numbers), checks what
// the store makes of it, and then starts a second time: the file is the same bytes in the same inode, so nothing
// was written again. tests/fixtures/v1/ holds the two collector files as they were in the 1.0.0 tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,utimes,chmod} from 'node:fs/promises';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgentStore,createReportStore,AGENTS_SCHEMA,AGENT_REPORTS_SCHEMA} from '../server/agent-store.mjs';
import {readAccessAudit} from '../server/access-store.mjs';
import {createEndpointStore,RUNTIMES_CONFIG_SCHEMA} from '../server/runtimes-data.mjs';
import {createRequestHistory,fromImportLine} from '../server/runtime-history.mjs';
import {readSnapshot,SYSTEMS_SCHEMA} from '../server/systems-data.mjs';
import {loadSecurity,forwardSecurity,SECURITY_SCHEMA,SECURITY_PROBES_SCHEMA} from '../server/security-data.mjs';
import {devicesDirectory,forwardJsonl,forwardTrendLine} from '../server/state-forward.mjs';
import {readRouter,forwardObservation,ROUTER_FILE} from '../server/router-data.mjs';
import {collectSystems} from '../scripts/collect-systems.mjs';
import {createKnowledgeEditor,entryHash} from '../scripts/knowledge-edit.mjs';
import {load as loadInventory,validate} from '../scripts/check-knowledge.mjs';
import {forwardInventory,INVENTORY_SCHEMA} from '../public/inventory-rules.js';
import {readKeyFile} from '../scripts/host-agent/core.mjs';
import {hub,SITE} from './hub-helper.mjs';
import {quiet,envelope,reportTo} from './support/agent.mjs';
import {steady,READERS_DIR} from './support/readers.mjs';

const V1_DIR=fileURLToPath(new URL('./fixtures/v1/',import.meta.url));
const temp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'hub-forward-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25}));return dir;};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const jsonl=async file=>(await readFile(file,'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof value==='string'?value:JSON.stringify(value));};
const lines=list=>list.map(l=>JSON.stringify(l)).join('\n')+'\n';
// What a file is now: its bytes and its inode. A file written again (a temporary name, then a rename) has another inode.
const mark=async file=>{const s=await stat(file);return `${s.ino}:${createHash('sha256').update(await readFile(file)).digest('hex')}`;};
const noOldWord=value=>assert.doesNotMatch(JSON.stringify(value),/machine/i,'nothing of the 1.0.0 name is left');

// ---- what 1.0.0 wrote ---------------------------------------------------------------------------------------------
const TOKEN='hha_'+'7'.repeat(64),HASH=createHash('sha256').update(TOKEN).digest('hex');
const AGENTS_V1={schemaVersion:1,agents:[
 {id:'00112233aabbccdd',machine:'studio',machineCreatedAt:null,name:'studio · 2026-10-01',prefix:TOKEN.slice(0,12),hash:HASH,createdAt:'2026-10-01T08:00:00.000Z',createdBy:'admin',revokedAt:null,revokedBy:null},
 {id:'8899aabbccddeeff',machine:'pi-hole',machineCreatedAt:'2026-09-01T00:00:00.000Z',name:'pi-hole',prefix:'hha_00000000',hash:'0'.repeat(64),createdAt:'2026-09-02T08:00:00.000Z',createdBy:'admin',revokedAt:'2026-09-20T08:00:00.000Z',revokedBy:'machine-removed'},
 {id:'1122334455667788',machine:'mini',machineCreatedAt:null,name:'mini',prefix:'hha_11111111',hash:'1'.repeat(64),createdAt:'2026-09-03T08:00:00.000Z',createdBy:'admin',revokedAt:'2026-09-21T08:00:00.000Z',revokedBy:'machine-changed'},
 {id:'99aabbccddeeff00',machine:'mini',machineCreatedAt:null,name:'mini 2',prefix:'hha_22222222',hash:'2'.repeat(64),createdAt:'2026-09-04T08:00:00.000Z',createdBy:'admin',revokedAt:'2026-09-22T08:00:00.000Z',revokedBy:'alice'}]};
const REPORT_V1={schemaVersion:1,machine:'studio',agentId:'00112233aabbccdd',agentVersion:'1.0.0',platform:'macos',lastSeenAt:'2026-11-01T10:00:00.000Z',lastSentAt:'2026-11-01T10:00:00Z',
 parts:{heartbeat:{schema:1,collectedAt:null,receivedAt:'2026-11-01T10:00:00.000Z',interval:60,digest:'a'.repeat(64),withheld:[]}}};
const TREND_V1=[{at:'2026-10-30T06:00:00.000Z',machines:{studio:{os:false,software:1,apps:0,warn:1,crit:0,stale:false}}},{at:'2026-10-30T12:00:00.000Z',machines:{mini:{os:true,software:0,apps:2,warn:0,crit:0,stale:false}}}];
const AGENT_AUDIT_V1=[{at:'2026-10-01T08:05:00.000Z',event:'agent-first-report',agent:'00112233aabbccdd',machine:'studio'},{at:'2026-10-02T08:05:00.000Z',event:'agent-refused',agent:'00112233aabbccdd',machine:'studio',code:'too-soon'}];
const ACCESS_AUDIT_V1=[{at:'2026-10-01T08:00:00.000Z',event:'agent-key-created',id:'00112233aabbccdd',name:'studio · 2026-10-01',by:'admin',detail:'machine studio'},
 {at:'2026-09-20T08:00:00.000Z',event:'agent-key-revoked',id:'8899aabbccddeeff',name:'pi-hole',by:'machine-removed',detail:'machine pi-hole'},
 {at:'2026-09-19T08:00:00.000Z',event:'user-created',id:'u1',name:'machine operator',by:'admin',detail:'machine room'}];
const ENDPOINTS_V1={schema:1,endpoints:[{id:'studio-ollama',machine:'studio',kind:'ollama',url:'http://10.0.0.26:11434',name:'Ollama',addedAt:'2026-10-05T08:00:00.000Z',addedBy:'admin',updatedAt:'2026-10-05T08:00:00.000Z',updatedBy:'admin',source:'ui'}]};
const requestV1=(at,metricId,more={})=>({machine:'studio',runtime:'llama-swap',model:'qwen',at,metricId,path:'/v1/chat/completions',status:200,inputTokens:10,outputTokens:20,cacheTokens:0,promptTps:100,generationTps:50,durationMs:900,client:'codex',...more});
const INVENTORY_V1={schema:1,updated_at:'2026-10-20',about:'written by hand',entries:[
 {id:'studio',kind:'machine',name:'Mac Studio',verified_at:'2026-10-20'},
 {id:'studio-gateway',kind:'runtime',machine:'studio',name:'Gateway',address:':8790',verified_at:'2026-10-20',secrets:[{what:'Token',store:'keychain:studio',ref:'gateway.token'}],depends_on:[{id:'studio-sync',kind:'cert'}]},
 {id:'studio-sync',kind:'tool',machine:'studio',name:'Cert sync',notes:'runs on the machine itself',verified_at:'2026-10-20',verified_by:'user edit in Home Hub'},
 {id:'dns',kind:'external',name:'DNS provider',address:'https://dns.example.com',verified_at:'2026-10-20'}]};
const PROBES_V1=at=>({schemaVersion:1,collectedAt:at,collectedFrom:'studio',probes:{studio:{error:'timeout'}},forgejo:null,extraMachines:[{id:'router',sshOpen:false,note:'SSH je na routeru vypnuté (port 22 zavřený).'}]});
const DESCRIPTOR={schemaVersion:1,id:'studio',name:'Studio from its descriptor',hostname:'studio.example.lan',collectedAt:'2026-11-07T21:00:00Z',addresses:[{ip:'10.0.0.26'}],hardware:{cpu:'Apple M2 Max',ramGb:64}};

// ---- the agent stores ---------------------------------------------------------------------------------------------
test('agents.json of 1.0.0: schema 2 with the same ids, hashes and stamps; the key still verifies; a second start writes nothing',async t=>{
 const dir=await temp(t),file=path.join(dir,'agents.json');await put(file,AGENTS_V1);
 const store=createAgentStore(dir),doc=await json(file);
 assert.equal(AGENTS_SCHEMA,2);assert.equal(doc.schemaVersion,2);noOldWord(doc);
 assert.deepEqual(Object.keys(doc.agents[0]),['id','device','deviceCreatedAt','name','prefix','hash','createdAt','createdBy','revokedAt','revokedBy'],'the keys keep their places');
 assert.deepEqual(doc.agents.map(a=>[a.id,a.device,a.deviceCreatedAt,a.hash,a.createdAt,a.revokedAt,a.revokedBy]),
  AGENTS_V1.agents.map(a=>[a.id,a.machine,a.machineCreatedAt,a.hash,a.createdAt,a.revokedAt,{'machine-removed':'device-removed','machine-changed':'device-changed'}[a.revokedBy]??a.revokedBy]));
 assert.equal((await stat(file)).mode&0o777,0o600);
 assert.deepEqual((await readdir(dir)).sort(),['agents.json'],'no temporary file is left');
 const who=store.verify(TOKEN);assert.equal(who?.device,'studio');assert.equal(who.deviceCreatedAt,null);
 assert.deepEqual(store.active().map(a=>[a.id,a.device,a.deviceCreatedAt]),[['00112233aabbccdd','studio',null]]);
 const before=await mark(file);
 assert.equal(createAgentStore(dir).verify(TOKEN)?.device,'studio');
 assert.equal(await mark(file),before,'the second start read schema 2 and wrote nothing');
});

test('agent/<id>.json of 1.0.0: schema 2 under the device key; a second start writes nothing; a file that names another id is not taken',async t=>{
 const dir=await temp(t),file=path.join(dir,'agent','studio.json');await put(file,REPORT_V1);
 await put(path.join(dir,'agent','mini.json'),{...REPORT_V1,machine:'studio'});
 const store=createReportStore(dir,{log:{}}),doc=await json(file);
 assert.equal(AGENT_REPORTS_SCHEMA,2);
 assert.deepEqual(doc,{schemaVersion:2,device:'studio',agentId:REPORT_V1.agentId,agentVersion:'1.0.0',platform:'macos',lastSeenAt:REPORT_V1.lastSeenAt,lastSentAt:REPORT_V1.lastSentAt,parts:REPORT_V1.parts});
 assert.deepEqual(Object.keys(doc),['schemaVersion','device','agentId','agentVersion','platform','lastSeenAt','lastSentAt','parts']);
 assert.deepEqual(store.get('studio'),doc);assert.equal(store.locked('studio'),false,'reports for it are taken again');
 assert.equal(store.get('mini'),null,'the file name is the device: a record of another one is not this device\'s');
 assert.equal((await stat(file)).mode&0o777,0o600);
 const before=await mark(file);
 assert.deepEqual(createReportStore(dir,{log:{}}).get('studio'),doc);
 assert.equal(await mark(file),before);
});

test('the trend files of 1.0.0 (agent/history.jsonl, systems/history.jsonl): each line under devices, rewritten once',async t=>{
 const dir=await temp(t),file=path.join(dir,'history.jsonl');await put(file,lines(TREND_V1)+'not json\n');
 assert.equal(await forwardJsonl(file,forwardTrendLine),2);
 const text=await readFile(file,'utf8');
 assert.deepEqual(text.split('\n').slice(0,2).map(l=>JSON.parse(l)),TREND_V1.map(l=>({at:l.at,devices:l.machines})));
 assert.equal(text.split('\n')[2],'not json','a line that cannot be read is kept as it is');assert.ok(text.endsWith('\n'));
 const before=await mark(file);
 assert.equal(await forwardJsonl(file,forwardTrendLine),0);assert.equal(await mark(file),before,'nothing left to forward: the file is not written');
 assert.equal(await forwardJsonl(path.join(dir,'none.jsonl'),forwardTrendLine),0,'no file, nothing to do');
 assert.deepEqual((await readdir(dir)).sort(),['history.jsonl']);
});

test('the audit files of 1.0.0 are not rewritten and read in today\'s words',async t=>{
 const dir=await temp(t);
 await put(path.join(dir,'agent-audit.jsonl'),lines(AGENT_AUDIT_V1));await put(path.join(dir,'access-audit.jsonl'),lines(ACCESS_AUDIT_V1));
 const before=[await mark(path.join(dir,'agent-audit.jsonl')),await mark(path.join(dir,'access-audit.jsonl'))];
 const events=await readAccessAudit(dir,{});
 assert.deepEqual(events.filter(e=>e.kind==='agent').map(e=>[e.event,e.id,e.subject,e.detail]),[['agent-refused','00112233aabbccdd','studio','too-soon'],['agent-first-report','00112233aabbccdd','studio','']]);
 const access=Object.fromEntries(events.filter(e=>e.kind==='access').map(e=>[e.event,e]));
 assert.deepEqual([access['agent-key-created'].detail,access['agent-key-created'].by],['device studio','admin']);
 assert.deepEqual([access['agent-key-revoked'].detail,access['agent-key-revoked'].by],['device pi-hole','device-removed']);
 assert.deepEqual([access['user-created'].detail,access['user-created'].subject],['machine room','machine operator'],'only what the hub wrote about an agent key is reworded, never a name a person chose');
 assert.deepEqual([await mark(path.join(dir,'agent-audit.jsonl')),await mark(path.join(dir,'access-audit.jsonl'))],before,'an audit file is append-only');
});

// ---- runtimes -----------------------------------------------------------------------------------------------------
test('runtimes-config.json of 1.0.0: schema 2, each endpoint with its device; a second start writes nothing; a newer file is refused',async t=>{
 const dir=await temp(t),file=path.join(dir,'runtimes-config.json');await put(file,ENDPOINTS_V1);
 const store=createEndpointStore(file),list=await store.list(),old=ENDPOINTS_V1.endpoints[0];
 const {machine,...rest}=old;
 assert.equal(RUNTIMES_CONFIG_SCHEMA,2);
 assert.deepEqual(list,[{id:old.id,device:machine,kind:rest.kind,url:rest.url,name:rest.name,addedAt:rest.addedAt,addedBy:rest.addedBy,updatedAt:rest.updatedAt,updatedBy:rest.updatedBy,source:'ui'}]);
 assert.deepEqual(Object.keys(list[0]),['id','device','kind','url','name','addedAt','addedBy','updatedAt','updatedBy','source']);
 assert.deepEqual(await json(file),{schema:2,endpoints:list});assert.equal((await stat(file)).mode&0o777,0o600);
 assert.deepEqual((await readdir(dir)).sort(),['runtimes-config.json']);
 const before=await mark(file);
 assert.deepEqual(await createEndpointStore(file).list(),list);assert.deepEqual(await store.list(),list);
 assert.equal(await mark(file),before);
 // A change made before anything listed the file starts from the forwarded list too.
 const other=path.join(dir,'other','runtimes-config.json');await put(other,ENDPOINTS_V1);
 await createEndpointStore(other).upsert({id:'mini-ollama',device:'mini',kind:'ollama',url:'http://10.0.0.25:11434',name:'',by:'admin',source:'ui'});
 assert.deepEqual((await json(other)).endpoints.map(e=>[e.id,e.device]),[['studio-ollama','studio'],['mini-ollama','mini']]);noOldWord(await json(other));
 // Older code refuses newer state.
 const newer=JSON.stringify({schema:3,endpoints:[{id:'x',thing:'studio'}]});await writeFile(file,newer);
 assert.deepEqual(await store.list(),[]);
 await assert.rejects(store.upsert({id:'y',device:'studio',kind:'ollama',url:'http://10.0.0.26:1',name:'',by:'admin',source:'ui'}),/newer-state/);
 await assert.rejects(store.remove('x'),/newer-state/);
 assert.equal(await readFile(file,'utf8'),newer,'never written over');
});

test('requests-YYYY-MM.jsonl of 1.0.0: read and rewritten under device and clientDevice; the same request is not taken twice',async t=>{
 const dir=await temp(t),now=Date.parse('2026-11-10T12:00:00Z'),file=path.join(dir,'runtimes','studio','requests-2026-11.jsonl');
 const old=[requestV1('2026-11-10T10:00:00.000Z',1,{clientMachine:'mini',clientAddress:'10.0.0.25'}),requestV1('2026-11-10T11:00:00.000Z',2)];
 await put(file,lines(old));
 const store=createRequestHistory(dir),got=await store.readDevice('studio',now-86400000,now);
 assert.deepEqual(got.map(r=>[r.device,r.metricId,r.clientDevice??null,r.client]),[['studio',1,'mini','codex'],['studio',2,null,'codex']]);
 const stored=await jsonl(file);
 assert.deepEqual(Object.keys(stored[0]),['device','runtime','model','at','metricId','path','status','inputTokens','outputTokens','cacheTokens','promptTps','generationTps','durationMs','client','clientDevice','clientAddress']);
 assert.deepEqual(stored,old.map(({machine,clientMachine,...r})=>({device:machine,...r,...(clientMachine?{clientDevice:clientMachine}:{})})).map((r,i)=>Object.fromEntries(Object.keys(stored[i]).map(k=>[k,r[k]]))));
 noOldWord(stored);assert.equal((await stat(file)).mode&0o777,0o600);
 assert.deepEqual(await readdir(path.dirname(file)),['requests-2026-11.jsonl']);
 // The runtime hands the same two records again (its ring buffer) and one new one: only the new one is added.
 const again=await store.ingest('studio',[...got,{...got[1],metricId:3,at:'2026-11-10T11:30:00.000Z'}],{now});
 assert.deepEqual(again,{added:1,known:2,skipped:0},'the de-duplication key is built from the forwarded device');
 const before=await mark(file);
 const second=createRequestHistory(dir);
 assert.equal((await second.readDevice('studio',now-86400000,now)).length,3);
 assert.equal(await mark(file),before,'a second start finds nothing to forward');
 // The importer takes a file from a 1.0.0 store as it is, and leaves another device's lines out.
 assert.deepEqual(fromImportLine(old[0],{device:'studio'}),got[0]);
 assert.equal(fromImportLine(old[0],{device:'mini'}),null);
 noOldWord(fromImportLine(old[0],{device:'studio'}));
});

// ---- the collectors' files ----------------------------------------------------------------------------------------
test('systems/snapshot.json of 1.0.0: schema 2 with its devices, the file\'s time kept; a second read writes nothing; a newer one is refused',async t=>{
 const dir=await temp(t),file=path.join(dir,'snapshot.json'),old=await json(path.join(V1_DIR,'snapshot.json'));
 assert.equal(old.schemaVersion,1);assert.ok(old.machines.studio&&!old.devices,'the fixture is what 1.0.0 wrote');
 await put(file,JSON.stringify(old,null,1)+'\n');const then=new Date('2026-11-08T12:00:05Z');await utimes(file,then,then);
 const doc=await readSnapshot(file);
 assert.equal(SYSTEMS_SCHEMA,2);
 assert.deepEqual(doc,await json(path.join(READERS_DIR,'snapshot.json')),'exactly the snapshot a 2.0 collector writes');
 assert.deepEqual(Object.keys(doc),Object.keys(old).map(k=>k==='machines'?'devices':k));
 assert.deepEqual(await json(file),doc);assert.equal((await stat(file)).mtimeMs,then.getTime(),'the snapshot is as old as it was');
 assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(await readdir(dir),['snapshot.json']);
 const before=await mark(file);
 assert.deepEqual(await readSnapshot(file),doc);assert.equal(await mark(file),before);
 await writeFile(file,JSON.stringify({schemaVersion:3,things:{}}));
 await assert.rejects(readSnapshot(file),e=>e.code==='NEWER');
});

test('a directory the hub may not write: the 1.0.0 snapshot and key inventory are still read forward',{skip:process.getuid?.()===0&&'root writes anywhere'},async t=>{
 const dir=await temp(t),snapshot=path.join(dir,'systems','snapshot.json'),keys=path.join(dir,'security','ssh-keys.json');
 await put(snapshot,readFileSync(path.join(V1_DIR,'snapshot.json'),'utf8'));await put(keys,readFileSync(path.join(V1_DIR,'ssh-keys.json'),'utf8'));
 for(const d of ['systems','security'])await chmod(path.join(dir,d),0o500);
 try{
  assert.deepEqual(await readSnapshot(snapshot),await json(path.join(READERS_DIR,'snapshot.json')));
  assert.deepEqual(await loadSecurity(dir,keys,{site:SITE}),await json(path.join(READERS_DIR,'ssh-keys.json')));
  assert.equal((await json(snapshot)).schemaVersion,1,'and left for the collector\'s next run');assert.equal((await json(keys)).schemaVersion,1);
  assert.deepEqual([await readdir(path.join(dir,'systems')),await readdir(path.join(dir,'security'))],[['snapshot.json'],['ssh-keys.json']]);
 }finally{for(const d of ['systems','security'])await chmod(path.join(dir,d),0o700);}
});

test('collect-systems after 1.0.0: carries the old snapshot\'s records over, writes schema 2 and forwards its trend file',async t=>{
 const dir=await temp(t),old=await json(path.join(V1_DIR,'snapshot.json'));
 await put(path.join(dir,'snapshot.json'),old);await put(path.join(dir,'history.jsonl'),lines(TREND_V1));
 const site={...SITE,devices:SITE.devices.filter(m=>m.id==='studio')};
 const exec=async cmd=>cmd==='hostname'?{code:0,stdout:'collector\n',stderr:''}:{code:255,stdout:'',stderr:'ssh: connect to host studio port 22: Operation timed out'};
 const {snapshot}=await collectSystems({site,hosts:new Map([['studio','studio']]),registry:{categories:{},items:[]},outDir:dir,exec,now:()=>'2026-11-14T06:00:00.000Z'});
 const written=await json(path.join(dir,'snapshot.json'));
 assert.equal(written.schemaVersion,2);assert.deepEqual(written,snapshot);assert.equal(written.machines,undefined);
 assert.deepEqual(Object.keys(written.devices).sort(),Object.keys(old.machines).sort(),'every record of the 1.0.0 snapshot is still there');
 assert.equal(written.devices.studio.stale,true,'the device that did not answer keeps its last record, marked stale');
 assert.deepEqual(written.devices.studio.os,old.machines.studio.os);
 const trend=await jsonl(path.join(dir,'history.jsonl'));
 assert.deepEqual(trend.slice(0,2),TREND_V1.map(l=>({at:l.at,devices:l.machines})));assert.equal(trend.length,3);assert.deepEqual(Object.keys(trend[2]),['at','devices']);
 // A snapshot of a newer collector is not written over.
 const newer=JSON.stringify({schemaVersion:3,things:{}});await writeFile(path.join(dir,'snapshot.json'),newer);
 await assert.rejects(collectSystems({site,hosts:new Map([['studio','studio']]),registry:{categories:{},items:[]},outDir:dir,exec}),/schema 3/);
 assert.equal(await readFile(path.join(dir,'snapshot.json'),'utf8'),newer);
});

test('security/ssh-keys.json and probes.json of 1.0.0: schema 2, every key and stored template forwarded; a second load writes nothing',async t=>{
 const dir=await temp(t),file=path.join(dir,'security','ssh-keys.json'),probes=path.join(dir,'security','probes.json');
 const old=await json(path.join(V1_DIR,'ssh-keys.json')),now=await json(path.join(READERS_DIR,'ssh-keys.json'));
 assert.equal(old.schemaVersion,1);assert.ok(Array.isArray(old.machines)&&!old.devices,'the fixture is what 1.0.0 wrote');
 await put(file,JSON.stringify(old,null,1)+'\n');const then=new Date('2026-11-08T12:00:05Z');await utimes(file,then,then);
 const doc=await loadSecurity(dir,file,{site:SITE});
 assert.equal(SECURITY_SCHEMA,2);
 assert.deepEqual(doc,now,'exactly the document a 2.0 collector writes');
 assert.equal(JSON.stringify(doc),JSON.stringify(now),'with every key in its place');noOldWord(doc);
 assert.ok(doc.findings.some(f=>f.titleT?.some(p=>p.key.includes('{device}')&&typeof p.params.device==='string')),'a finding\'s template is the one today\'s dictionary has');
 assert.deepEqual(await json(file),now);assert.equal((await stat(file)).mtimeMs,then.getTime());assert.equal((await stat(file)).mode&0o777,0o600);
 const before=await mark(file);
 assert.deepEqual(await loadSecurity(dir,file,{site:SITE}),now);assert.equal(await mark(file),before);
 assert.equal(forwardSecurity(now),now,'a schema 2 document is left as it is');
 // probes.json is read when an agent reports SSH keys: here the join finds it forwarded, and it stays that.
 await put(probes,JSON.stringify(PROBES_V1(now.collectedAt),null,1)+'\n');await utimes(probes,then,then);
 const record={schemaVersion:2,device:'studio',agentId:'0123456789abcdef',agentVersion:'2.0.0',platform:'macos',lastSeenAt:'2026-11-08T12:10:00.000Z',lastSentAt:'2026-11-08T12:10:00Z',
  parts:{sshkeys:{schema:1,collectedAt:'2026-11-08T12:10:00Z',receivedAt:'2026-11-08T12:10:00.000Z',interval:21600,digest:'0'.repeat(64),withheld:[],records:['HOST\tstudio\tDarwin\talice\t0\t2026-11-08T12:10:00Z','END\tok']}}};
 const joined=await loadSecurity(dir,file,{site:SITE,agents:[{id:'studio',name:'Mac Studio',record}],now:Date.parse('2026-11-08T12:20:00Z'),devicesDir:path.join(dir,'devices')});
 assert.equal(joined.agents.joined,true,'the forwarded probes.json is the run the inventory names');
 assert.equal(SECURITY_PROBES_SCHEMA,2);
 const stored=await json(probes),v1=PROBES_V1(now.collectedAt);
 assert.deepEqual(stored,{schemaVersion:2,collectedAt:v1.collectedAt,collectedFrom:'studio',probes:v1.probes,forgejo:null,extraDevices:v1.extraMachines});
 assert.deepEqual(Object.keys(stored),['schemaVersion','collectedAt','collectedFrom','probes','forgejo','extraDevices']);
 assert.ok(joined.devices.some(m=>m.id==='router'&&m.sshOpen===false),'the router entry the collector noted is still there');
 assert.equal((await stat(probes)).mtimeMs,then.getTime());
 const mark2=await mark(probes);
 await loadSecurity(dir,file,{site:SITE,agents:[{id:'studio',name:'Mac Studio',record}],now:Date.parse('2026-11-08T12:20:00Z'),devicesDir:path.join(dir,'devices')});
 assert.equal(await mark(probes),mark2);assert.equal(await mark(file),before);
});

test('data/machines of 1.0.0 becomes data/devices once; DEVICES_DIR is left alone; an existing data/devices is never replaced',async t=>{
 const dir=await temp(t);await put(path.join(dir,'machines','studio.json'),DESCRIPTOR);
 assert.equal(devicesDirectory(dir,{DEVICES_DIR:'/elsewhere'}),'/elsewhere');assert.ok(existsSync(path.join(dir,'machines')),'a directory named by DEVICES_DIR moves nothing');
 assert.equal(devicesDirectory(dir,{}),path.join(dir,'devices'));
 assert.deepEqual((await readdir(dir)).sort(),['devices']);assert.deepEqual(await json(path.join(dir,'devices','studio.json')),DESCRIPTOR);
 const before=await mark(path.join(dir,'devices','studio.json'));
 assert.equal(devicesDirectory(dir,{}),path.join(dir,'devices'));assert.equal(await mark(path.join(dir,'devices','studio.json')),before);
 await put(path.join(dir,'machines','mini.json'),{id:'mini'});
 assert.equal(devicesDirectory(dir,{}),path.join(dir,'devices'));
 assert.deepEqual((await readdir(dir)).sort(),['devices','machines'],'both there: the new one is read and the old one is left for a person to look at');
 assert.equal(devicesDirectory(await temp(t),{}).endsWith(path.sep+'devices'),true,'neither there: the new name');
});

// ---- the inventory ------------------------------------------------------------------------------------------------
test('knowledge.json of 1.0.0: schema 2, kind and field device, every other field as it was; hashes change only where the field did',async t=>{
 const next=forwardInventory(INVENTORY_V1);
 assert.equal(INVENTORY_SCHEMA,2);assert.equal(next.schema,2);assert.equal(next.about,'written by hand');assert.equal(next.updated_at,'2026-10-20');
 assert.deepEqual(next.entries.map(e=>[e.id,e.kind,e.device??null]),[['studio','device',null],['studio-gateway','runtime','studio'],['studio-sync','tool','studio'],['dns','external',null]]);
 assert.deepEqual(next.entries.map(e=>Object.keys(e)),INVENTORY_V1.entries.map(e=>Object.keys(e).map(k=>k==='machine'?'device':k)),'the keys keep their places');
 assert.equal(next.entries[2].notes,'runs on the machine itself','a person\'s own words are not touched');
 assert.equal(next.entries[1].secrets[0].store,'keychain:studio');assert.equal(next.entries[2].verified_by,'user edit in Home Hub');
 assert.deepEqual(validate(next,{secretStores:[]}).errors,[]);
 assert.ok(validate(INVENTORY_V1,{secretStores:[]}).errors.includes('schema must be 2'),'the 1.0.0 document itself is not a 2.0 document');
 assert.equal(entryHash(next.entries[3]),entryHash(INVENTORY_V1.entries[3]),'an entry without the field keeps its hash');
 assert.notEqual(entryHash(next.entries[1]),entryHash(INVENTORY_V1.entries[1]));
 assert.equal(forwardInventory(next),next,'a schema 2 document is left as it is');
 assert.deepEqual(forwardInventory([{kind:'machine'}]),[{kind:'machine'}],'a bare list has no schema: it is not forwarded');
 // The editor: reads forward, and forward() writes once.
 const dir=await temp(t),file=path.join(dir,'knowledge.json');await put(file,JSON.stringify(INVENTORY_V1,null,2)+'\n');
 assert.deepEqual(await loadInventory(file),next,'the checker reads forward');assert.equal((await json(file)).schema,1,'and writes nothing');
 const editor=createKnowledgeEditor({file,secretStores:[],publish:async()=>{}});
 assert.equal(await editor.forward(),true);
 assert.deepEqual(await json(file),next);assert.deepEqual(await readdir(dir),['knowledge.json']);
 const before=await mark(file);
 assert.equal(await editor.forward(),false);assert.equal(await mark(file),before);
 // An edit of a 1.0.0 file that was never forwarded is checked against the hash of the forwarded entry and saves schema 2.
 await writeFile(file,JSON.stringify(INVENTORY_V1));
 const r=await editor({id:'studio-sync',base:entryHash(next.entries[2]),fields:{notes:'moved'}});
 assert.equal(r.ok,true);const saved=await json(file);assert.equal(saved.schema,2);assert.equal(saved.entries[2].device,'studio');noOldWord(saved);
});

// ---- a key file on another host -----------------------------------------------------------------------------------
test('router-observations.json of a 1.0.0 collector: read forward as clients and hardware on every read, never rewritten',async t=>{
 const dir=await temp(t),file=path.join(dir,ROUTER_FILE);
 // What scripts/collect-router-unifi.py of 1.0.0 wrote (the collector may run on another host and be copied here).
 const v1={schemaVersion:1,attemptedAt:'2026-11-08T11:59:30+00:00',source:'UniFi Network API',status:'ok',observedAt:'2026-11-08T11:59:30+00:00',error:null,
  devices:[{mac:'aa:bb:cc:dd:ee:01',ip:'10.0.0.151',name:'Desktop',connection:'Ethernet',presence:'reachable',connected:true,type:'WIRED',connectedAt:'',lastSeen:'2026-11-08T11:59:30+00:00',uplink:'Gateway'}],
  clientCounts:{wired:1,wireless:0,other:0},model:'UniFi Dream Router 7 (UDR7)',firmware:'4.3.6',routerMac:'a8:9c:6c:0e:8d:15',routerIp:'10.0.0.1',
  unifiDevices:[{name:'Gateway',model:'UDR7',mac:'a8:9c:6c:0e:8d:15',ip:'10.0.0.1',state:'ONLINE',firmware:'4.3.6'}],knownClients:{'aa:bb:cc:dd:ee:01':{ip:'10.0.0.151',name:'Desktop',type:'WIRED',lastSeen:'2026-11-08T11:59:30+00:00'}},
  site:'Default',applicationVersion:'9.4.19',backend:'integration-api',routerBaseMac:'a8:9c:6c:0e:8d:15'};
 const forward=forwardObservation(v1);
 assert.deepEqual([forward.clients,forward.hardware],[v1.devices,v1.unifiDevices]);assert.ok(!('devices' in forward)&&!('unifiDevices' in forward));
 assert.equal(forwardObservation(forward),forward,'a 2.0 observation is returned as it is');
 await put(file,v1);const before=await mark(file);
 const router=await readRouter(dir,{lanCidrs:['10.0.0.0/24'],now:Date.parse('2026-11-08T12:00:00Z')});
 assert.equal(router.state,'ok');assert.deepEqual(router.clients.map(c=>c.name),['Desktop']);assert.equal(router.health.hardware[0].name,'Gateway');
 assert.deepEqual(router.health.clientCounts,{connected:1,wired:1,wireless:0,other:0,known:1});
 assert.equal(await mark(file),before,'the collector\'s file is not rewritten');
});

test('an agent key file downloaded from 1.0.0 is still an agent key file',()=>{
 const old=JSON.stringify({schema:1,agent:{id:'00112233aabbccdd',machine:'studio',name:'studio · 2026-10-01',prefix:TOKEN.slice(0,12),createdAt:'2026-10-01T08:00:00.000Z'},token:TOKEN});
 assert.deepEqual(readKeyFile(old),{token:TOKEN,agent:{id:'00112233aabbccdd',device:'studio',prefix:TOKEN.slice(0,12)}});
 assert.deepEqual(readKeyFile(old.replace('"machine"','"device"')),readKeyFile(old),'and reads as the one 2.0 writes');
 assert.throws(()=>readKeyFile(JSON.stringify({schema:1,agent:{id:'x'},token:TOKEN})),/not an agent key file/);
});

// ---- the whole hub ------------------------------------------------------------------------------------------------
// A data and state directory as 1.0.0 left it, served by this hub: every page's answer comes out in today's names,
// the agent's key still reports, and a restart finds nothing left to do.
test('a hub started on the state of 1.0.0 serves it, forwards it once, and a restart changes nothing',async t=>{
 const dir=await temp(t),at=new Date(Date.now()-3600e3).toISOString(),month=at.slice(0,7);
 const golden=await json(path.join(READERS_DIR,'golden.json'));
 const requests=path.join(dir,'runtimes','studio',`requests-${month}.jsonl`);
 await put(path.join(dir,'agents.json'),AGENTS_V1);await put(path.join(dir,'agent','studio.json'),REPORT_V1);await put(path.join(dir,'agent','history.jsonl'),lines(TREND_V1));
 await put(path.join(dir,'agent-audit.jsonl'),lines(AGENT_AUDIT_V1));await put(path.join(dir,'access-audit.jsonl'),lines(ACCESS_AUDIT_V1));
 await put(path.join(dir,'runtimes-config.json'),ENDPOINTS_V1);await put(requests,lines([requestV1(at,7,{clientMachine:'mini'})]));
 await put(path.join(dir,'systems','snapshot.json'),readFileSync(path.join(V1_DIR,'snapshot.json'),'utf8'));
 await put(path.join(dir,'systems','upstream.json'),readFileSync(path.join(READERS_DIR,'upstream.json'),'utf8'));
 await put(path.join(dir,'security','ssh-keys.json'),readFileSync(path.join(V1_DIR,'ssh-keys.json'),'utf8'));
 await put(path.join(dir,'machines','studio.json'),DESCRIPTOR);
 const offline=async()=>{throw new Error('test: no network');};
 const start=async()=>{const h=await hub(t,{directory:dir,stateDirectory:dir,thermoPoller:quiet,softwareWatchFile:path.join(READERS_DIR,'watch.json'),runtimeFetch:offline,thermoHostsFile:path.join(dir,'private','thermo-hosts.json')});
  // hub() writes its own schema 2 inventory into its own directory; this one keeps the 1.0.0 file.
  return {...h,dir};};
 await put(path.join(dir,'knowledge.json'),JSON.stringify(INVENTORY_V1,null,2)+'\n');
 const answers=async h=>{
  const get=async url=>{const r=await fetch(h.origin+url,{headers:h.admin});assert.equal(r.status,200,url);return r.json();};
  const out={};
  out.systems=steady(await get('/api/systems'));out.security=steady(await get('/api/security'));
  out.agents=(await get('/api/admin/agents')).agents.map(a=>[a.id,a.device,a.revokedBy]);
  out.audit=(await get('/api/admin/audit?limit=1000')).events.filter(e=>e.at<'2026-11-01').map(e=>[e.kind,e.event,e.subject,e.detail??null,e.by??null]);
  out.endpoints=(await get('/api/runtimes/endpoints')).endpoints.map(e=>[e.id,e.device,e.source]);
  const inventory=await get('/api/inventory');out.inventory=inventory.doc;out.hashes=inventory.hashes;
  out.home=(await get('/api/home')).devices.find(m=>m.id==='studio').name;
  const models=await get('/api/models?range=24h');out.clients=models.clients.map(c=>[c.client,c.clientDevice,c.targets.map(x=>x.device)]);
  return out;
 };
 const check=out=>{
  assert.equal(JSON.stringify(out.systems),JSON.stringify(golden.systems.body),'/api/systems, byte for byte what a 2.0 snapshot answers');
  assert.equal(JSON.stringify(out.security),JSON.stringify(golden.security.body),'/api/security, byte for byte what a 2.0 inventory answers');
  assert.deepEqual(out.agents.sort(),[['00112233aabbccdd','studio',null],['1122334455667788','mini','device-changed'],['8899aabbccddeeff','pi-hole','device-removed'],['99aabbccddeeff00','mini','alice']]);
  assert.deepEqual(out.audit.filter(e=>e[0]==='agent'),[['agent','agent-refused','studio','too-soon',null],['agent','agent-first-report','studio','',null]]);
  assert.ok(out.audit.some(e=>e[1]==='agent-key-revoked'&&e[3]==='device pi-hole'&&e[4]==='device-removed'));
  assert.deepEqual(out.endpoints,[['studio-ollama','studio','ui']]);
  assert.deepEqual(out.inventory,forwardInventory(INVENTORY_V1));assert.equal(out.hashes['studio-gateway'],entryHash(forwardInventory(INVENTORY_V1).entries[1]));
  assert.equal(out.home,'Studio from its descriptor','the descriptor directory was found under its new name');
  assert.deepEqual(out.clients,[['codex','mini',['studio']]],'the request 1.0.0 logged is on the LLM page, with its client\'s device');
 };
 const first=await start();
 check(await answers(first));
 // The key 1.0.0 issued still reports, and the device's record takes it.
 const report=await reportTo(first)(TOKEN,envelope());
 assert.equal(report.status,200,JSON.stringify(await report.clone().json()));
 // On disk: today's forms only, nothing temporary, the old directory gone. (The trend file is forwarded at start, beside the requests.)
 for(let i=0;i<200&&/machine/.test(await readFile(path.join(dir,'agent','history.jsonl'),'utf8'));i++)await new Promise(r=>setTimeout(r,10));
 const files=['agents.json','agent/studio.json','agent/history.jsonl','runtimes-config.json',`runtimes/studio/requests-${month}.jsonl`,'systems/snapshot.json','security/ssh-keys.json','knowledge.json'];
 for(const f of files)assert.doesNotMatch((await readFile(path.join(dir,f),'utf8')).replace('runs on the machine itself',''),/machine/i,f);
 assert.equal(existsSync(path.join(dir,'machines')),false);assert.deepEqual(await readdir(path.join(dir,'devices')),['studio.json']);
 assert.deepEqual([(await json(path.join(dir,'agents.json'))).schemaVersion,(await json(path.join(dir,'agent','studio.json'))).schemaVersion,(await json(path.join(dir,'runtimes-config.json'))).schema,
  (await json(path.join(dir,'systems','snapshot.json'))).schemaVersion,(await json(path.join(dir,'security','ssh-keys.json'))).schemaVersion,(await json(path.join(dir,'knowledge.json'))).schema],[2,2,2,2,2,2]);
 const all=async(d=dir)=>(await Promise.all((await readdir(d,{withFileTypes:true})).map(e=>e.isDirectory()?all(path.join(d,e.name)):[path.join(d,e.name)]))).flat();
 assert.deepEqual((await all()).filter(f=>/\.tmp$|\.edit-/.test(f)),[],'no temporary file is left');
 // A restart: the same answers, and none of the forwarded files is written again.
 const stable=files.filter(f=>f!=='agent/studio.json'&&f!=='agent/history.jsonl');// the report above belongs in these two
 const before=await Promise.all(stable.map(f=>mark(path.join(dir,f))));
 const second=await start();
 check(await answers(second));
 assert.deepEqual(await Promise.all(stable.map(f=>mark(path.join(dir,f)))),before);
 assert.equal((await json(path.join(dir,'agent','studio.json'))).device,'studio');
});
