import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {hashPassword} from '../server/auth.mjs';import {createAccessStore} from '../server/access-store.mjs';
import {createHandler} from '../server/index.mjs';import {createKnowledgeEditor,entryHash} from '../scripts/knowledge-edit.mjs';
const credentials={username:'admin',...hashPassword('administrator-test-password')};
const until=async(check,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,5));}return false;};
test('new users are view-only unless given a role, hash-only keys persist and revoke immediately, the owner is out of reach',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-access-'));t.after(()=>rm(dir,{recursive:true,force:true}));const s=createAccessStore(dir,credentials);
 const created=await s.createUser({username:'guest',name:'Guest'});assert.equal(created.user.role,'viewer');assert(created.initialPassword);
 assert.equal((await s.authenticate('guest',created.initialPassword)).role,'viewer');
 assert.throws(()=>s.createUser({username:'root',admin:true}),/invalid/);await assert.rejects(s.createUser({username:'root',role:'owner'}),/invalid/,'nobody is made an owner');
 await assert.rejects(s.createUser({username:'root',role:'no-such-role'}),/invalid/);
 for(const change of [{disabled:true},{role:'viewer'},{remove:true},{name:'x'}])assert.throws(()=>s.updateUser({id:'owner',...change}),/invalid/);
 const issued=await s.issueKey({name:'Reader',permission:'read'});assert.equal(s.verifyKey(issued.token).permission,'read');
 // A key's first use stamps lastUsedAt behind the answer (verifyKey awaits no write), through access.json.tmp. The
 // "restarted" stores below are further stores on the same directory and write through that same temp file, which a
 // real restart never does while the old process still writes: with the stamp still on its way, its rename took the
 // revocation's temp file away (ENOENT) or put the key back after it. So the restart comes once the stamp is on the
 // disk, however long that was.
 const stamped=async()=>JSON.parse(await readFile(path.join(dir,'access.json'),'utf8')).keys.some(k=>k.id===issued.key.id&&k.lastUsedAt);
 assert.ok(await until(()=>stamped().catch(()=>false)),'the key\'s first use reaches the disk');
 const disk=await readFile(path.join(dir,'access.json'),'utf8');assert(!disk.includes(issued.token));assert(!disk.includes(created.initialPassword));assert(!JSON.stringify(s.keys()).includes('hash'));
 const restarted=createAccessStore(dir,credentials);assert(restarted.verifyKey(issued.token));await restarted.revokeKey({id:issued.key.id});assert.equal(restarted.verifyKey(issued.token),null);assert.equal(createAccessStore(dir,credentials).verifyKey(issued.token),null);
 await s.updateUser({id:created.user.id,disabled:true});assert.equal(await s.authenticate('guest',created.initialPassword),null);
});
test('all write families reject viewer sessions and read keys; only admin sessions manage credentials',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-roles-'));let server=null;
 // One teardown, server first (as tests/hub-helper.mjs): hooks run in the order they were registered and one that
 // fails skips the rest. dir is the hub's state directory, and the hub appends its API write log once a response is
 // out (server/index.mjs, on 'finish', not awaited), one line per key write below: with such a line still on its way,
 // an rm registered before the close failed (ENOTEMPTY), the close never ran and the listening server kept the run
 // alive. Hence also the retries.
 t.after(async()=>{try{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25});}});
 await writeFile(path.join(dir,'knowledge.json'),JSON.stringify({schema:1,updated_at:'2026-11-05',entries:[]}));
 server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;let calls=0;
 server.on('request',createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,bridgeRequest:async()=>{calls++;return {};}}));
 const post=(url,body,headers={})=>fetch(origin+url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const login=async(username,password)=>(await post('/api/session',{username,password})).headers.get('set-cookie').split(';')[0];
 const admin={Cookie:await login('admin','administrator-test-password')};
 const created=await (await post('/api/admin/users',{username:'guest'},admin)).json();const viewer={Cookie:await login('guest',created.initialPassword)};
 const read=await (await post('/api/admin/keys',{name:'Reader',permission:'read'},admin)).json();const readHeaders={Authorization:'Bearer '+read.token};
 const write=await (await post('/api/admin/keys',{name:'Writer',permission:'write'},admin)).json();const writeHeaders={Authorization:'Bearer '+write.token};
 for(const headers of [viewer,readHeaders]){
  for(const route of ['/api/tickets','/api/tickets/update','/api/review/publish','/api/review/sets','/api/home/settings','/api/home/devices','/api/home/devices/add','/api/home/devices/remove','/api/inventory/entry','/api/inventory/entries','/api/services','/api/app-tokens','/api/app-tokens/revoke','/api/admin/users','/api/admin/keys'])assert.equal((await post(route,{},headers)).status,403,route);
  assert.equal((await fetch(origin+'/api/inventory',{headers})).status,200);assert.equal((await fetch(origin+'/api/services',{headers})).status,200);assert.equal((await fetch(origin+'/api/me',{headers})).status,200);
  assert.equal((await fetch(origin+'/api/admin/keys',{headers})).status,403);
 }
 assert.equal(calls,0);
 assert.equal((await post('/api/admin/keys',{name:'Escalation',permission:'write'},writeHeaders)).status,403);
 assert.equal((await post('/api/admin/users',{username:'evil'},writeHeaders)).status,403);
 assert.equal((await post('/api/admin/keys',{name:'CSRF',permission:'read'},{...admin,Origin:'https://evil.example'})).status,403);
 await post('/api/admin/users/action',{id:created.user.id,disabled:true},admin);assert.equal((await fetch(origin+'/api/me',{headers:viewer})).status,401);
 await post('/api/admin/keys/revoke',{id:read.key.id},admin);assert.equal((await fetch(origin+'/api/inventory',{headers:readHeaders})).status,401);
 const rows=await(await fetch(origin+'/api/admin/keys',{headers:admin})).text();assert(!rows.includes(read.token));assert(!rows.includes(write.token));assert(!rows.includes('"hash"'));
});
test('inventory creation and complete updates are checked and require an exact current base hash',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-create-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'knowledge.json');let published=0;
 await writeFile(file,JSON.stringify({schema:1,updated_at:'2026-11-05',entries:[{id:'mini',kind:'machine',name:'mini',verified_at:'2026-11-05'}]}));
 const editor=createKnowledgeEditor({file,publish:async()=>{published++;}});const entry={id:'new-service',kind:'runtime',machine:'mini',name:'New service',address:'127.0.0.1:12345'};
 const created=await editor.put({entry});assert(created.ok);assert(created.published);assert.equal(published,1);
 await assert.rejects(editor.put({entry}),/conflict/);
 const changed=await editor.put({entry:{...created.entry,depends_on:[{id:'mini',kind:'call'}],version:'1.0'},base:created.hash});assert(changed.ok);assert.equal(published,2);
 await assert.rejects(editor.put({entry,base:created.hash}),/conflict/);
 const before=await readFile(file,'utf8'),bad=await editor.put({entry:{...changed.entry,notes:'password=secretsecret'},base:changed.hash});assert.equal(bad.ok,false);assert.equal(await readFile(file,'utf8'),before);
 const rawKey=await editor.put({entry:{...changed.entry,notes:'hhk_'+'a'.repeat(64)},base:changed.hash});assert.equal(rawKey.ok,false);assert.equal(await readFile(file,'utf8'),before);
});
