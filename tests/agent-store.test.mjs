// The push agent's credential store (server/agent-store.mjs, docs/agent.md §2): a key kind of its own that older
// parsers never match, stored as a hash in its own file, never touching access.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAgentStore,createReportStore,agentBearerOf,findMachine,machineRefusal,boundTo,AGENTS_SCHEMA,AGENT_REPORTS_SCHEMA,AGENT_LIMITS} from '../server/agent-store.mjs';
import {apiBearerOf,createAccessStore} from '../server/access-store.mjs';
import {bearerOf} from '../server/device-tokens.mjs';
import {secretIn,namedSecretIn} from '../server/secret-patterns.mjs';
import {secretIn as reexported} from '../server/home-devices.mjs';
import {credentials,SITE} from './hub-helper.mjs';

const tmp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'hub-agent-store-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25}));return dir;};
const machine=(id,createdAt=null)=>({id,createdAt,site:createdAt===null,role:'computer',platform:null,probe:null});

test('older parsers reject hha_, and only the agent parser takes it',()=>{
 const token='hha_'+'a'.repeat(64),header='Bearer '+token;
 assert.equal(apiBearerOf(header),null,'apiBearerOf (hhk_) never matches an agent key');
 assert.equal(bearerOf(header),null,'bearerOf (hh_) never matches an agent key');
 assert.equal(agentBearerOf(header),token);
 for(const other of ['Bearer hhk_'+'a'.repeat(64),'Bearer hh_'+'a'.repeat(64),'Bearer hha_'+'A'.repeat(64),'Bearer hha_'+'a'.repeat(63),'bearer '+token,header+' ',undefined,null])
  assert.equal(agentBearerOf(other),null,String(other));
 assert.ok(secretIn(`token is ${token} here`),'secretIn knows hha_');assert.ok(namedSecretIn(token),'and so does the named check');
 assert.equal(reexported,secretIn,'home-devices re-exports the one secretIn');
});

test('agents.json: hashes only, 0600, its own file; access.json round-trips unchanged',async t=>{
 const dir=await tmp(t),now=()=>Date.parse('2026-11-13T10:00:00Z');
 // An access.json as an older release wrote it: byte for byte the same after agent keys come and go.
 const access=JSON.stringify({schemaVersion:1,users:[],keys:[],accounts:[],prefs:{},roles:[]});
 await writeFile(path.join(dir,'access.json'),access);
 const accessStore=createAccessStore(dir,credentials);
 const store=createAgentStore(dir,{now});
 assert.deepEqual(store.list(),[],'no agents.json: no keys, and the store loads');
 const {token,agent}=await store.issue(machine('studio'),{name:'Studio agent',by:'admin'});
 assert.match(token,/^hha_[a-f0-9]{64}$/);
 assert.deepEqual(agent,{id:agent.id,machine:'studio',name:'Studio agent',prefix:token.slice(0,12),createdAt:'2026-11-13T10:00:00.000Z',createdBy:'admin',revokedAt:null,revokedBy:null});
 const file=path.join(dir,'agents.json'),raw=await readFile(file,'utf8'),doc=JSON.parse(raw);
 assert.equal((await stat(file)).mode&0o777,0o600);
 assert.equal(doc.schemaVersion,AGENTS_SCHEMA);
 assert.ok(!raw.includes(token),'the token is never stored');
 assert.equal(doc.agents[0].hash,createHash('sha256').update(token).digest('hex'));
 assert.deepEqual(Object.keys(doc.agents[0]).sort(),['createdAt','createdBy','hash','id','machine','machineCreatedAt','name','prefix','revokedAt','revokedBy']);
 assert.equal(store.verify(token).authKind,'agent');assert.deepEqual(store.verify(token).scopes,[],'an agent key holds no scope');
 assert.equal(accessStore.verifyKey(token),null,'the access store does not know it');
 await store.revoke(agent.id,{by:'admin'});
 assert.equal(store.verify(token),null,'a revoked key verifies to nothing');
 assert.equal(await readFile(path.join(dir,'access.json'),'utf8'),access,'access.json is not touched');
 const audit=(await readFile(path.join(dir,'access-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual(audit.map(e=>e.event),['agent-key-created','agent-key-revoked']);
 assert.ok(!JSON.stringify(audit).includes(token)&&!JSON.stringify(audit).includes(doc.agents[0].hash),'the audit holds neither the token nor its hash');
 // A second store over the same directory reads the same file.
 assert.equal(createAgentStore(dir).list()[0].revokedBy,'admin');
});

test('limits: two keys per machine, 100 that are not revoked; a newer agents.json is refused',async t=>{
 const dir=await tmp(t),store=createAgentStore(dir);
 await store.issue(machine('mini'));const second=await store.issue(machine('mini'));
 await assert.rejects(store.issue(machine('mini')),/limit/,'a third key for one machine');
 await store.revoke(second.agent.id);await store.issue(machine('mini'));
 for(let i=0;i<AGENT_LIMITS.active-2;i++)await store.issue(machine(`m${String(i).padStart(3,'0')}`));
 await assert.rejects(store.issue(machine('another')),/limit/,'the 101st active key');
 await assert.rejects(store.issue(machine('x1'),{name:'bad\nname'}),/invalid/);
 await writeFile(path.join(dir,'agents.json'),JSON.stringify({schemaVersion:2,agents:[]}));
 assert.throws(()=>createAgentStore(dir),/Invalid agent key store/,'older code refuses newer state');
});

test('the machine a key binds: site machines without a stamp, devices with their createdAt; router and NAS refused',()=>{
 const devices=[{id:'pi-hole',role:'other',createdAt:'2026-11-01T00:00:00.000Z'},{id:'gw',role:'router',createdAt:'2026-11-01T00:00:00.000Z'}];
 const at=id=>findMachine(id,{siteMachines:SITE.machines,devices});
 assert.deepEqual(at('studio'),{id:'studio',createdAt:null,site:true,role:'computer',platform:null,probe:'mac'});
 assert.equal(at('pi-hole').createdAt,'2026-11-01T00:00:00.000Z');
 assert.deepEqual(['studio','pi-hole','nas','router','gw','ghost','../x'].map(id=>machineRefusal(at(id))),[null,null,'nas','router','router','unknown','unknown']);
 assert.equal(boundTo({machine:'pi-hole',machineCreatedAt:'2026-11-01T00:00:00.000Z'},at('pi-hole')),true);
 assert.equal(boundTo({machine:'pi-hole',machineCreatedAt:'2026-10-01T00:00:00.000Z'},at('pi-hole')),false,'re-created: another stamp');
 assert.equal(boundTo({machine:'studio',machineCreatedAt:null},null),false,'gone');
});

test('report store: an older-format state directory loads unchanged; a newer file is left alone',async t=>{
 const dir=await tmp(t);
 assert.deepEqual(createReportStore(dir).machines(),[],'no agent/ directory: nothing, and nothing is written');
 assert.deepEqual((await readdir(dir)),[]);
 await writeFile(path.join(dir,'access.json'),'{}');
 const {mkdir}=await import('node:fs/promises');await mkdir(path.join(dir,'agent'));
 await writeFile(path.join(dir,'agent','mini.json'),JSON.stringify({schemaVersion:AGENT_REPORTS_SCHEMA+1,machine:'mini',parts:{}}));
 const warned=[],store=createReportStore(dir,{log:{warn:m=>warned.push(m)}});
 assert.equal(store.locked('mini'),true);assert.equal(warned.length,1);
 await assert.rejects(store.accept('mini',{agentId:'a'.repeat(16),report:{agentVersion:'1.0.0',platform:'macos',sentAt:'2026-11-13T10:00:00Z'},parts:{},receivedAt:'2026-11-13T10:00:00.000Z'}),/newer-state/);
 assert.equal(JSON.parse(await readFile(path.join(dir,'agent','mini.json'),'utf8')).schemaVersion,AGENT_REPORTS_SCHEMA+1,'never overwritten');
});
