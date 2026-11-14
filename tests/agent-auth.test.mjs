// The push agent's credential in the request pipeline (docs/agent.md §1, §2, §6 → A stolen agent key): an agent key
// reaches the agent report and nothing else, nothing else reaches the agent report, the machine is the key's, and a
// key dies with its machine or its revocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {hub} from './hub-helper.mjs';
import {scopeIds,CORE_SCOPES,BUILTIN_ROLES,legacyScopes,resolveScopes} from '../server/scopes.mjs';

import {envelope,systemsParts,reportTo,issueAgent as issue,errorCode as code,quiet} from './support/agent.mjs';

// A path that a pattern route matches, built from its RegExp: each capture group a sample, the escapes undone.
const SAMPLES=[['([a-z][a-z0-9_-]{1,31})','mini'],['([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5})','HH-1'],['([0-9a-f-]{36})','01234567-89ab-cdef-0123-456789abcdef'],['(.*)','x'],['(.+)','x']];
function samplePath(route){
 if(route.path)return route.path;
 let s=route.match.source.replace(/^\^/,'').replace(/\$$/,'');
 for(const [group,value] of SAMPLES)s=s.split(group).join(value);
 s=s.replace(/\\(.)/g,'$1');
 assert.ok(route.match.test(s),`no sample path for ${route.method} ${route.match}: add one to SAMPLES`);
 return s;
}

test('an agent key is refused on every route but its own, every method, /mcp, pages, assets and paths nothing matches',async t=>{
 const h=await hub(t,{thermoPoller:quiet});
 const {token}=await issue(h,'studio');
 const auth={Authorization:'Bearer '+token};
 const registry=h.handler.registry,paths=new Set(registry.routes.map(samplePath));
 for(const extra of ['/','/index.html','/mcp','/api','/api/','/api/nothing-here','/nothing-here','/api/agent','/api/agent/','/api/agent/report/','/api/agent/x','/api/admin/agents','/api/me'])paths.add(extra);
 for(const url of registry.assets.keys())paths.add(url);
 let checked=0;
 for(const p of paths)for(const method of ['GET','HEAD','POST','PUT','DELETE','PATCH','OPTIONS']){
  const own=p==='/api/agent/report'&&method==='POST';
  const r=await fetch(h.origin+p,{method,headers:{...auth,...(['GET','HEAD'].includes(method)?{}:{'Content-Type':'application/json'})},...(['GET','HEAD'].includes(method)?{}:{body:'{}'})});
  if(own){assert.equal(r.status,400,'its own route answers (the body {} is not a report)');assert.equal(await code(r),'AGENT_REPORT_INVALID');continue;}
  assert.equal(r.status,403,`${method} ${p}`);
  if(method!=='HEAD')assert.equal(await code(r),'AGENT_ONLY',`${method} ${p}`);else await r.arrayBuffer();
  checked++;
 }
 assert.ok(checked>800,`every route, every method (${checked})`);
 // /healthz answers before any credential is read: {ok:true}, nothing more, as before.
 assert.deepEqual(await (await fetch(h.origin+'/healthz',{headers:auth})).json(),{ok:true});
 // The only routes the key reaches belong to the core module "agent".
 assert.deepEqual(registry.routes.filter(r=>r.module==='agent').map(r=>`${r.method} ${r.path}`),['POST /api/agent/report']);
 assert.equal(registry.module('agent').core,true);
});

test('a plugin route whose RegExp covers /api/agent/… answers 403 AGENT_ONLY to an agent key',async t=>{
 const hits=[];
 const probe={id:'agent-probe',routes:[
  {method:'GET',match:/^\/api\/agent\/(.+)$/,scope:'read',handler:c=>{hits.push(c.pathname);return c.json(200,{ok:true});}},
  {method:'POST',match:/^\/api\/agent\/(.+)$/,scope:'read',write:false,handler:c=>{hits.push(c.pathname);return c.json(200,{ok:true});}}]};
 const h=await hub(t,{thermoPoller:quiet,plugins:[probe]});
 const {token}=await issue(h,'studio');
 for(const [method,p] of [['GET','/api/agent/x'],['POST','/api/agent/x'],['GET','/api/agent/report'],['POST','/api/agent/report/extra']]){
  const r=await fetch(h.origin+p,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
  assert.equal(r.status,403,`${method} ${p}`);assert.equal(await code(r),'AGENT_ONLY');
 }
 assert.deepEqual(hits,[],'the plugin never ran for the agent key');
 // Core's exact path still wins over the plugin's pattern, for the agent key.
 assert.equal((await reportTo(h)(token,envelope())).status,200);
 // The plugin's route is a plugin route like any other for people.
 assert.equal((await fetch(h.origin+'/api/agent/x',{headers:h.admin})).status,200);
});

test('no other credential reaches the agent route: sessions, every API key, device tokens; none at all is 401',async t=>{
 const h=await hub(t,{thermoPoller:quiet});
 const report=reportTo(h);
 const full=await h.account('agent-full',['*']),reader=await h.account('agent-reader',['read']);
 const legacy={Authorization:'Bearer '+(await (await h.post('/api/admin/keys',{name:'Old writer',permission:'write'},h.admin)).json()).token};
 await h.post('/api/admin/users',{username:'eddie',role:'editor',password:'editor-test-password'},h.admin);
 const editorLogin=await h.post('/api/session',{username:'eddie',password:'editor-test-password'});
 const editor={Cookie:editorLogin.headers.get('set-cookie').split(';')[0]};
 const device={Authorization:'Bearer '+(await (await h.post('/api/devices/tokens',{name:'Phone'},h.admin)).json()).token};
 for(const [who,headers] of [['admin session',{...h.admin,Origin:h.origin}],['editor session',{...editor,Origin:h.origin}],['full-access key (*)',full.headers],['read key',reader.headers],['legacy write key',legacy],['device token',device]]){
  const r=await report(null,envelope(),headers);
  assert.equal(r.status,403,who);assert.equal(await code(r),'AGENT_CREDENTIAL_REQUIRED',who);
 }
 const anonymous=await report(null,envelope());assert.equal(anonymous.status,401);assert.equal(await code(anonymous),'AUTH_REQUIRED');
 const unknown=await report('hha_'+'0'.repeat(64),envelope());assert.equal(unknown.status,401,'an unknown agent key');
 assert.equal((await readdir(h.dir)).includes('agent'),false,'nothing was stored');
 // The refused writes of API keys are in the API write log like refused writes on any other route; nothing else is.
 // Each line is appended on its own after its response went out (server/index.mjs, on 'finish', nothing awaits it):
 // the three are on disk at no promised time and in no promised order, and until the first one is, the file is not
 // there at all. Wait for all three, complete lines only; the deadline is not a pause, it only bounds how long a line
 // that never comes takes to fail. Then exactly what was asserted before.
 const refusedWrites=async()=>{const raw=await readFile(path.join(h.dir,'api-audit.jsonl'),'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e));
  return raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(e=>e.route==='/api/agent/report');};
 let logged;const deadline=Date.now()+10000;
 do{logged=await refusedWrites();if(['Old writer','agent-full','agent-reader'].every(name=>logged.some(e=>e.name===name)))break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<deadline);
 assert.deepEqual(logged.map(e=>[e.event,e.name,e.status]).sort(),[['api-write','Old writer',403],['api-write','agent-full',403],['api-write','agent-reader',403]].sort());
});

test('an agent report is not in the API write log',async t=>{
 const h=await hub(t,{thermoPoller:quiet});
 const {token}=await issue(h,'studio');
 assert.equal((await reportTo(h)(token,envelope())).status,200);
 const raw=await readFile(path.join(h.dir,'api-audit.jsonl'),'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e));
 assert.equal(raw.includes('/api/agent/report'),false);
});

test('no scope is added: the wildcard, the editor, legacy keys and device tokens gain nothing',async t=>{
 const before=scopeIds();
 const h=await hub(t,{thermoPoller:quiet});
 assert.deepEqual(scopeIds(),before,'scopeIds() unchanged by the agent module');
 assert.deepEqual(h.handler.registry.module('agent').scopes,{},'the agent module defines no scope');
 assert.ok(scopeIds().every(s=>!/agent/.test(s)));
 assert.deepEqual(Object.keys(CORE_SCOPES).filter(s=>/agent/.test(s)),[]);
 for(const holder of [resolveScopes(['*']),legacyScopes('write'),BUILTIN_ROLES.find(r=>r.id==='editor').grants(),BUILTIN_ROLES.find(r=>r.id==='owner').grants()])
  assert.ok(holder.every(s=>scopeIds().includes(s))&&!holder.some(s=>/agent/.test(s)));
 // The route needs no scope, and the gate is by principal kind (see the test above for the requests).
 assert.equal(h.handler.registry.match('POST','/api/agent/report').route.scope,null);
 assert.equal(h.handler.registry.match('POST','/api/agent/report').route.write,false);
});

test('the machine comes from the key: a body naming another machine is 400; records land only in agent/<A>.json',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await hub(t,{thermoPoller:quiet,agentClock:()=>clock});
 const report=reportTo(h);
 const a=await issue(h,'studio');
 for(const extra of [{machine:'mini'},{machineId:'mini'}]){
  const r=await report(a.token,envelope(undefined,extra));assert.equal(r.status,400);
  const body=await r.json();assert.equal(body.error.code,'AGENT_REPORT_INVALID');assert.equal(body.error.field,Object.keys(extra)[0]);
 }
 // The HOST name of the records says "mini": stored for studio, as studio's.
 const ok=await report(a.token,envelope({heartbeat:{schema:1,interval:60},...systemsParts({name:'mini'})}));
 assert.equal(ok.status,200);assert.deepEqual((await ok.json()).accepted,['heartbeat','os','updates','packages']);
 // Beside it, the trend's history.jsonl (one line per machine at most every six hours; docs/agent.md §3).
 assert.deepEqual((await readdir(path.join(h.dir,'agent'))).sort(),['history.jsonl','studio.json']);
 assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(h.dir,'agent','history.jsonl'),'utf8')).machines),['studio']);
 const stored=JSON.parse(await readFile(path.join(h.dir,'agent','studio.json'),'utf8'));
 assert.equal(stored.machine,'studio');assert.equal(stored.agentId,a.agent.id);
 // A Content-Type that is not exactly application/json is refused, as for every POST.
 clock+=60_000;
 const charset=await report(a.token,envelope(),{'Content-Type':'application/json; charset=utf-8'});
 assert.equal(charset.status,403);assert.equal(await code(charset),'ORIGIN_REJECTED');
 // An agent key needs no Origin, and a browser Origin changes nothing.
 assert.equal((await report(a.token,envelope(),{Origin:'https://evil.example.com'})).status,200);
});

test('a reused id: remove a device, add one that gets the same id, the old key gets 409 then 401, audited machine-removed',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await hub(t,{thermoPoller:quiet,agentClock:()=>clock});
 const report=reportTo(h),writer=await h.account('agent-home',['home:write']);
 const pi={id:'pi-hole',name:'Pi-hole',hostname:'pi.example.lan',ip:'10.0.0.53',role:'other',platform:'linux'};
 const made=await (await h.post('/api/home/machines',{machine:pi},writer.headers)).json();
 const key=await issue(h,'pi-hole');
 const linux=envelope(undefined,{platform:'linux'});
 assert.equal((await report(key.token,linux)).status,200);
 // The device goes and an agent adds one with the same id: a new createdAt.
 assert.equal((await h.post('/api/home/machines/remove',{id:'pi-hole',base:made.hash},writer.headers)).status,200);
 await new Promise(r=>setTimeout(r,3));
 assert.equal((await h.post('/api/home/machines',{machine:pi},writer.headers)).status,201);
 clock+=60_000;
 const gone=await report(key.token,linux);assert.equal(gone.status,409);assert.equal(await code(gone),'AGENT_MACHINE_GONE');
 const after=await report(key.token,linux);assert.equal(after.status,401);assert.equal(await code(after),'AUTH_REQUIRED');
 const audit=(await readFile(path.join(h.dir,'access-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.event.startsWith('agent-key-'));
 assert.deepEqual(audit.map(e=>[e.event,e.by??null]),[['agent-key-created','admin'],['agent-key-revoked','machine-removed']]);
 const listed=(await (await fetch(h.origin+'/api/admin/agents',{headers:h.admin})).json()).agents;
 assert.equal(listed[0].revokedBy,'machine-removed');
 const events=(await (await fetch(h.origin+'/api/admin/audit?kind=agent',{headers:h.admin})).json()).events;
 assert.ok(events.some(e=>e.event==='agent-refused'&&e.detail.includes('AGENT_MACHINE_GONE')&&e.subject==='pi-hole'));
 // A new key for the new device works; without a report, the hub revokes on its own sweep.
 const fresh=await issue(h,'pi-hole');
 assert.equal((await report(fresh.token,linux)).status,200);
 const now=await (await fetch(h.origin+'/api/home/machines',{headers:h.admin})).json();
 const again=now.machines.find(m=>m.id==='pi-hole');
 assert.equal((await h.post('/api/home/machines/remove',{id:'pi-hole',base:again.hash},writer.headers)).status,200);
 assert.equal(await h.handler.state('agent').sweep(),1,'the sweep (start, devices.json changed) revokes it');
 clock+=60_000;
 assert.equal((await report(fresh.token,linux)).status,401,'no report needed for the revocation');
});

test('revoked through the admin API: the next report is 401; the admin API is for administrators with a password',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await hub(t,{thermoPoller:quiet,agentClock:()=>clock});
 const report=reportTo(h);
 const key=await issue(h,'studio','Studio agent');
 assert.deepEqual(Object.keys(key).sort(),['agent','token']);
 assert.deepEqual(Object.keys(key.agent).sort(),['agentVersion','createdAt','createdBy','id','lastReportAt','machine','name','platform','prefix','revokedAt','revokedBy']);
 assert.equal((await report(key.token,envelope())).status,200);
 const list=await (await fetch(h.origin+'/api/admin/agents',{headers:h.admin})).json();
 assert.equal(list.agents.length,1);
 assert.deepEqual([list.agents[0].lastReportAt,list.agents[0].agentVersion,list.agents[0].platform],['2026-11-13T10:00:00.000Z','1.6.0','macos']);
 assert.ok(!JSON.stringify(list).includes(key.token)&&!('hash' in list.agents[0]),'never the token or its hash');
 // Refusals: unknown machine, the router, the NAS, a malformed body; a third key; an unknown id.
 for(const body of [{machine:'ghost'},{machine:'router'},{machine:'nas'},{machine:'studio',extra:1},{},{machine:'studio',name:'x'.repeat(81)}]){
  const r=await h.post('/api/admin/agents',body,h.admin);assert.equal(r.status,400,JSON.stringify(body));assert.equal(await code(r),'AGENT_INVALID');}
 await issue(h,'studio');
 const third=await h.post('/api/admin/agents',{machine:'studio'},h.admin);assert.equal(third.status,409);assert.equal(await code(third),'AGENT_LIMIT');
 const missing=await h.post('/api/admin/agents/revoke',{id:'0'.repeat(16)},h.admin);assert.equal(missing.status,404);assert.equal(await code(missing),'NOT_FOUND');
 // Only an administrator signed in with a password.
 const full=await h.account('agent-full',['*']);
 const device={Authorization:'Bearer '+(await (await h.post('/api/devices/tokens',{name:'Phone'},h.admin)).json()).token};
 await h.post('/api/admin/users',{username:'eddie',role:'editor',password:'editor-test-password'},h.admin);
 const editor={Cookie:(await h.post('/api/session',{username:'eddie',password:'editor-test-password'})).headers.get('set-cookie').split(';')[0]};
 for(const [who,headers,expected] of [['full key',full.headers,'ADMIN_REQUIRED'],['device token',device,'ADMIN_REQUIRED'],['editor',editor,'ADMIN_REQUIRED']]){
  for(const [url,body] of [['/api/admin/agents',{machine:'mini'}],['/api/admin/agents/revoke',{id:key.agent.id}]]){
   const r=await h.post(url,body,headers);assert.equal(r.status,403,`${who} ${url}`);assert.equal(await code(r),expected,`${who} ${url}`);}
  assert.equal((await fetch(h.origin+'/api/admin/agents',{headers})).status,403,who);
 }
 // Revoke: 200 with the key, then the key is dead.
 const revoked=await h.post('/api/admin/agents/revoke',{id:key.agent.id},h.admin);assert.equal(revoked.status,200);
 const body=await revoked.json();assert.equal(body.agent.revokedBy,'admin');assert.ok(body.agent.revokedAt);
 clock+=60_000;
 const r=await report(key.token,envelope());assert.equal(r.status,401);assert.equal(await code(r),'AUTH_REQUIRED');
 // On /mcp and on a page the dead key is no one: 401 and anonymous, as an older core would treat it.
 assert.equal((await fetch(h.origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json'},body:'{}'})).status,401);
 const page=await fetch(h.origin+'/',{headers:{Authorization:'Bearer '+key.token}});assert.notEqual(page.status,403);await page.arrayBuffer();
 // The admin audit names both events, kind access.
 const events=(await (await fetch(h.origin+'/api/admin/audit?kind=access',{headers:h.admin})).json()).events.map(e=>e.event);
 assert.ok(events.includes('agent-key-created')&&events.includes('agent-key-revoked'));
});

test('a machine whose platform is said must report that one, else every part is platform-mismatch',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await hub(t,{thermoPoller:quiet,agentClock:()=>clock});
 const report=reportTo(h),writer=await h.account('agent-home',['home:write']);
 await h.post('/api/home/machines',{machine:{id:'box',name:'Box',hostname:'box.example.lan',ip:'10.0.0.60',role:'computer',platform:'linux'}},writer.headers);
 const key=await issue(h,'box');
 const r=await report(key.token,envelope({heartbeat:{schema:1,interval:60},...systemsParts({name:'box'})}));
 assert.equal(r.status,200);const body=await r.json();
 assert.deepEqual(body.accepted,[]);assert.deepEqual(body.refused.map(x=>[x.part,x.code]),[['heartbeat','platform-mismatch'],['os','platform-mismatch'],['updates','platform-mismatch'],['packages','platform-mismatch']]);
 // A HOST line that says another system than the envelope: that part is refused, and with it the systems run.
 const key2=await issue(h,'studio');
 const mixed=await (await report(key2.token,envelope({...systemsParts({host:'Linux'})}))).json();
 assert.deepEqual(mixed.refused,[{part:'os',code:'platform-mismatch',tag:'HOST',field:2},{part:'updates',code:'invalid'},{part:'packages',code:'invalid'}]);
});

test('a key revoked while its report is still on the way stores nothing: 401',async t=>{
 const h=await hub(t,{thermoPoller:quiet});
 const key=await issue(h,'studio');
 const body=JSON.stringify(envelope({heartbeat:{schema:1,interval:60},...systemsParts()}));
 const url=new URL(h.origin+'/api/agent/report');
 const answer=new Promise((resolve,reject)=>{
  const req=http.request({host:url.hostname,port:url.port,path:url.pathname,method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',d=>{text+=d;});res.on('end',()=>resolve({status:res.statusCode,text}));});
  req.on('error',reject);
  // The headers and the first bytes go now; the key is revoked; then the rest.
  req.write(body.slice(0,10));
  setTimeout(async()=>{try{const r=await h.post('/api/admin/agents/revoke',{id:key.agent.id},h.admin);assert.equal(r.status,200);req.end(body.slice(10));}catch(e){reject(e);}},50);
 });
 const r=await answer;
 assert.equal(r.status,401,r.text);assert.equal(JSON.parse(r.text).error.code,'AUTH_REQUIRED');
 assert.equal((await readdir(h.dir)).includes('agent'),false,'nothing was stored');
 const listed=(await (await fetch(h.origin+'/api/admin/agents',{headers:h.admin})).json()).agents;
 assert.equal(listed[0].lastReportAt,null,'no last report either');
});

test('a key whose machine would now be refused at issue is revoked: platform "other", the router; "other" is refused at issue',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await hub(t,{thermoPoller:quiet,agentClock:()=>clock});
 const report=reportTo(h),writer=await h.account('agent-home',['home:write']);
 const box={id:'box',name:'Box',hostname:'box.example.lan',ip:'10.0.0.60',role:'computer',platform:'linux'};
 const made=await (await h.post('/api/home/machines',{machine:box},writer.headers)).json();
 await h.post('/api/home/machines',{machine:{id:'odd',name:'Odd',hostname:'odd.example.lan',ip:'10.0.0.61',role:'computer',platform:'other'}},writer.headers);
 const odd=await h.post('/api/admin/agents',{machine:'odd'},h.admin);assert.equal(odd.status,400);
 const oddBody=await odd.json();assert.equal(oddBody.error.code,'AGENT_INVALID');assert.match(oddBody.error.message,/platform/);
 const key=await issue(h,'box'),linux=envelope(undefined,{platform:'linux'});
 assert.equal((await report(key.token,linux)).status,200);
 // The device becomes the router: the next report is 409 and the key is dead, revoked as machine-changed.
 const changed=await h.post('/api/home/machines',{machine:{...box,role:'router'},base:made.hash},writer.headers);assert.equal(changed.status,200,await changed.clone().text());
 clock+=60_000;
 const r=await report(key.token,linux);assert.equal(r.status,409);assert.equal(await code(r),'AGENT_MACHINE_GONE');
 assert.equal((await report(key.token,linux)).status,401);
 const listed=(await (await fetch(h.origin+'/api/admin/agents',{headers:h.admin})).json()).agents;
 assert.equal(listed.find(a=>a.id===key.agent.id).revokedBy,'machine-changed');
 // Without a report: the sweep revokes a key whose machine got platform "other".
 const now=(await (await fetch(h.origin+'/api/home/machines',{headers:h.admin})).json()).machines.find(m=>m.id==='box');
 assert.equal((await h.post('/api/home/machines',{machine:{...box,role:'computer'},base:now.hash},writer.headers)).status,200);
 const second=await issue(h,'box');
 const again=(await (await fetch(h.origin+'/api/home/machines',{headers:h.admin})).json()).machines.find(m=>m.id==='box');
 assert.equal((await h.post('/api/home/machines',{machine:{...box,platform:'other'},base:again.hash},writer.headers)).status,200);
 assert.equal(await h.handler.state('agent').sweep(),1);
 clock+=60_000;
 assert.equal((await report(second.token,linux)).status,401);
});

test('revoke-agent-key from the command line takes effect in a running hub, and the hub\'s next write keeps it',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await hub(t,{thermoPoller:quiet,agentClock:()=>clock});
 const report=reportTo(h);
 const key=await issue(h,'studio');
 assert.equal((await report(key.token,envelope())).status,200);
 const authFile=path.join(h.dir,'cli-auth.json');
 await writeFile(path.join(h.dir,'cli-auth.json'),JSON.stringify({username:'admin',salt:'00',hash:'00'}),{mode:0o600});
 const script=fileURLToPath(new URL('../scripts/manage-access.mjs',import.meta.url));
 const env={...process.env,STATE_DIR:h.dir,AUTH_FILE:authFile,HOME_HUB_LAUNCHD_LABEL:''};
 await promisify(execFile)(process.execPath,[script,'revoke-agent-key','--id',key.agent.id],{env});
 clock+=60_000;
 const r=await report(key.token,envelope());assert.equal(r.status,401,'the hub read agents.json again');
 // The hub writes the file next (a new key): the CLI's revocation is still there.
 await issue(h,'studio');
 const doc=JSON.parse(await readFile(path.join(h.dir,'agents.json'),'utf8'));
 assert.equal(doc.agents.find(a=>a.id===key.agent.id).revokedBy,'local administration');
});

test('a machine record written by a newer hub: 500 UNAVAILABLE, never overwritten',async t=>{
 // The second server (below) closes before the hub's teardown, which removes the directory both serve: hooks run in
 // the order they were registered and one that fails skips the rest, so registered after the hub's, a removal that
 // failed would leave this server listening and the run would never end.
 let server=null;t.after(()=>{if(!server)return;server.closeAllConnections();return new Promise(r=>server.close(r));});
 const h=await hub(t,{thermoPoller:quiet});
 const {mkdir}=await import('node:fs/promises');
 await mkdir(path.join(h.dir,'agent'),{recursive:true});
 const newer=JSON.stringify({schemaVersion:2,machine:'studio',parts:{}});
 await writeFile(path.join(h.dir,'agent','studio.json'),newer);
 // A second handler over the same state loads the store as a restarted hub would.
 const {createHandler}=await import('../server/index.mjs');
 const {credentials}=await import('./hub-helper.mjs');
 server=http.createServer(createHandler({directory:h.dir,stateDirectory:h.dir,credentials,origin:'http://127.0.0.1',secure:false,thermoPoller:quiet,thermoHostsFile:path.join(h.dir,'private','thermo-hosts.json')}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const key=await issue(h,'studio');
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api/agent/report`,{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json'},body:JSON.stringify(envelope())});
 assert.equal(r.status,500);assert.equal(await code(r),'UNAVAILABLE');
 assert.equal(await readFile(path.join(h.dir,'agent','studio.json'),'utf8'),newer);
});
