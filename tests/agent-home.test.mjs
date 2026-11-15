// Push agent, step 4 (docs/agent.md §7): the overview shows the agent of each device that holds a key.
// devices[].agent on GET /api/home, GET /api/home/devices and the MCP tool device_list; the integration "agent.reports"
// and what turning it off means; and that a hub without agent keys answers exactly as before (fixture site).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentFor,buildHome,deviceList} from '../server/home-data.mjs';
import {homeHub,homeAnswers,DEVICE} from './support/home-answers.mjs';
import {envelope,systemsParts,reportTo,issueAgent,errorCode,rec,quiet} from './support/agent.mjs';
import {SITE} from './hub-helper.mjs';

const GOLDEN=JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/home/no-agents.json',import.meta.url)),'utf8'));
const sha=s=>createHash('sha256').update(s).digest('hex');
const without=(list,key)=>list.map(({[key]:_,...rest})=>rest);

test('agentFor: never, fresh and no news by the hub\'s clock; behind ignores build metadata; specsDiffer only with a digest',()=>{
 assert.equal(agentFor(null),null,'no key: null');assert.equal(agentFor(undefined),null);
 assert.deepEqual(agentFor({lastReportAt:null,parts:{}}),{lastReportAt:null,freshness:'never',agentVersion:null,behind:null,specsDiffer:null});
 const at='2026-11-13T10:00:00.000Z',t0=Date.parse(at);
 const entry={lastReportAt:at,agentVersion:'1.6.0+dev',parts:{heartbeat:{receivedAt:at,interval:60},os:{receivedAt:at,interval:21600}},specs:null,hubSpecs:null};
 assert.deepEqual(agentFor(entry,{now:t0+1000,hubVersion:'1.6.0'}),{lastReportAt:at,freshness:'fresh',agentVersion:'1.6.0+dev',behind:false,specsDiffer:null});
 // Fresh while any part is: the 60 s heartbeat goes quiet after three minutes, the os part after 18 hours.
 assert.equal(agentFor(entry,{now:t0+181_000}).freshness,'fresh');
 // The boundary: fresh until receivedAt + 3 × interval, no news from that very instant.
 const beat={...entry,parts:{heartbeat:entry.parts.heartbeat}};
 assert.equal(agentFor(beat,{now:t0+180_000-1}).freshness,'fresh','1 ms before 3 × interval');
 assert.equal(agentFor(beat,{now:t0+180_000}).freshness,'no-news','exactly 3 × interval');
 assert.equal(agentFor({...entry,parts:{heartbeat:entry.parts.heartbeat}},{now:t0+181_000}).freshness,'no-news','3 × 60 s: no news, never off');
 assert.equal(agentFor(entry,{now:t0+3*21600_000+1}).freshness,'no-news');
 assert.equal(agentFor({...entry,parts:{}},{now:t0}).freshness,'no-news','reported, but nothing it sent is read');
 assert.equal(agentFor({...entry,agentVersion:'1.5.9'},{hubVersion:'1.6.0'}).behind,true);
 assert.equal(agentFor({...entry,agentVersion:'1.6.0-rc.1'},{hubVersion:'1.6.0'}).behind,true,'a pre-release is behind its release');
 assert.equal(agentFor({...entry,agentVersion:'1.7.0'},{hubVersion:'1.6.0'}).behind,false);
 assert.equal(agentFor(entry,{hubVersion:null}).behind,null);assert.equal(agentFor({...entry,agentVersion:'junk'},{hubVersion:'1.6.0'}).behind,null);
 assert.equal(agentFor({...entry,specs:sha(''),hubSpecs:sha('')}).specsDiffer,false);
 assert.equal(agentFor({...entry,specs:sha('a'),hubSpecs:sha('')}).specsDiffer,true);
 assert.equal(agentFor({...entry,specs:sha('a'),hubSpecs:null}).specsDiffer,null);
});

test('buildHome and deviceList: agent only where the agent module names the device; online does not follow it',()=>{
 const at='2026-11-13T10:00:00.000Z',now=Date.parse(at)+1000;
 const plain=buildHome({site:SITE,thermo:quiet,now});
 const home=buildHome({site:SITE,thermo:quiet,now,agentNow:now,hubVersion:'1.6.0',agents:{mini:{lastReportAt:at,agentVersion:'1.6.0',parts:{heartbeat:{receivedAt:at,interval:60}}}}});
 assert.deepEqual(home.devices.map(m=>[m.id,m.agent?.freshness??null]),[['mini','fresh'],['studio',null],['mini_server',null],['nas',null],['router',null]]);
 assert.deepEqual(home.devices.map(m=>m.online),plain.devices.map(m=>m.online),'a fresh heartbeat is not online (the owner\'s decision for legacy)');
 assert.deepEqual(without(home.devices,'agent'),without(plain.devices,'agent'));
 const list=deviceList({site:SITE,home});
 assert.deepEqual(list.devices.map(m=>m.agent?.freshness??null),['fresh',null,null,null,null]);
 assert.deepEqual(list.devices[0].agent,home.devices[0].agent,'both lists say the same');
 // The agent's clock stands apart from the telemetry's: the tests move it alone.
 assert.equal(buildHome({site:SITE,thermo:quiet,now,agentNow:now+3600_000,agents:{mini:{lastReportAt:at,parts:{heartbeat:{receivedAt:at,interval:60}}}}}).devices[0].agent.freshness,'no-news');
});

test('a hub without agent keys answers exactly as before step 4, apart from agent: null and the new integration (fixture site)',async t=>{
 const h=await homeHub(t);
 const now=await homeAnswers(h);
 // devices[].agent is null on every device of both lists, and of device_list.
 for(const name of ['home','devices','deviceList']){
  const devices=now[name].body.devices;
  assert.ok(devices.length>=6,`${name}: the site and the added device`);
  assert.deepEqual(devices.map(m=>m.agent),devices.map(()=>null),`${name}: agent null`);
  assert.deepEqual(Object.keys(devices[0]).filter(k=>k==='agent'),['agent'],`${name}: the field is there`);
 }
 const strip=a=>({...a,body:{...a.body,devices:without(a.body.devices,'agent')}});
 for(const name of ['home','devices','deviceList'])assert.equal(JSON.stringify(strip(now[name])),JSON.stringify(GOLDEN[name]),name);
 // The integrations page gains the kind "agent" and the card agent.reports (not configured: no key); nothing else moves.
 const ig=now.integrations.body,card=ig.integrations.find(i=>i.id==='agent.reports');
 assert.deepEqual([card.kind,card.module,card.toggle,card.enabled,card.status.state,card.test],['agent','agent',true,true,'not-configured',false]);
 assert.deepEqual(ig.kinds.filter(k=>!GOLDEN.integrations.body.kinds.includes(k)),['agent']);
 const before={...now.integrations,body:{...ig,kinds:ig.kinds.filter(k=>k!=='agent'),integrations:ig.integrations.filter(i=>i.id!=='agent.reports'),
  plugins:ig.plugins.map(p=>({...p,integrations:p.integrations.filter(i=>i!=='agent.reports')}))}};
 assert.equal(JSON.stringify(before),JSON.stringify(GOLDEN.integrations),'integrations');
 // Integrations → Devices lists the integration's facet among the facets, and no device carries it without a key.
 const am=now.adminDevices.body;
 assert.deepEqual(am.facets.filter(f=>f.id==='int-agent-reports').map(f=>[f.title,f.page]),[['Push agenti','integrations']]);
 assert.equal(am.devices.some(m=>m.facets.some(f=>f.id==='int-agent-reports')),false);
 assert.equal(JSON.stringify({...now.adminDevices,body:{...am,facets:am.facets.filter(f=>f.id!=='int-agent-reports')}}),JSON.stringify(GOLDEN.adminDevices),'Integrations → Devices');
});

// A hub on the fixture site with an injected agent clock, one added device and the agent tooling.
async function agentHub(t,clock,extra={}){
 const h=await homeHub(t,{agentClock:()=>clock.now,...extra});
 const get=async(url,headers=h.admin)=>{const r=await fetch(h.origin+url,{headers});return {status:r.status,body:await r.json()};};
 const home=async id=>(await get('/api/home')).body.devices.find(m=>m.id===id);
 const rpc=async(name,args={})=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...h.writer.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result.structuredContent;
 return {...h,get,home,rpc,report:reportTo(h)};
}

test('over HTTP: a key that never reported, a fresh report, then no news by the injected clock; online, the device lists and MCP agree',async t=>{
 const clock={now:Date.parse('2026-11-13T10:00:00Z')};
 const h=await agentHub(t,clock);
 const onlineBefore=(await h.get('/api/home')).body.devices.map(m=>[m.id,m.online]);
 const key=await issueAgent(h,'mini');
 assert.deepEqual((await h.home('mini')).agent,{lastReportAt:null,freshness:'never',agentVersion:null,behind:null,specsDiffer:null});
 assert.equal((await h.home('studio')).agent,null,'a device without a key');
 const r=await h.report(key.token,envelope({heartbeat:{schema:1,interval:60},...systemsParts({name:'mini'})},{agentVersion:'0.9.0'}));
 assert.equal(r.status,200);const {receivedAt}=await r.json();
 const fresh=(await h.home('mini')).agent;
 assert.deepEqual(fresh,{lastReportAt:receivedAt,freshness:'fresh',agentVersion:'0.9.0',behind:true,specsDiffer:null});
 assert.deepEqual((await h.get('/api/home')).body.devices.map(m=>[m.id,m.online]),onlineBefore,'online does not follow the agent');
 const listed=(await h.get('/api/home/devices')).body.devices.find(m=>m.id==='mini');assert.deepEqual(listed.agent,fresh);
 assert.deepEqual((await h.rpc('device_list')).devices.find(m=>m.id==='mini').agent,fresh,'device_list carries it, as it carries reachability');
 // The heartbeat goes quiet first; the os part still holds the device fresh. Past every part: no news.
 clock.now+=181_000;assert.equal((await h.home('mini')).agent.freshness,'fresh');
 clock.now+=3*21600_000;
 const quietNow=(await h.home('mini')).agent;
 assert.deepEqual([quietNow.freshness,quietNow.lastReportAt],['no-news',receivedAt],'no news, with when it was last heard');
 // Integrations → Devices: the agent's facet on the devices with a key, each in its own state.
 await issueAgent(h,'mini_server');
 const facets=(await h.get('/api/admin/devices')).body.devices,facet=id=>facets.find(m=>m.id===id).facets.filter(f=>f.id==='int-agent-reports').map(f=>f.state);
 assert.deepEqual([facet('mini'),facet('mini_server'),facet('studio')],[['stale'],['not-configured'],[]]);
 // The integration says the same per device.
 const card=(await h.get('/api/admin/integrations')).body.integrations.find(i=>i.id==='agent.reports');
 assert.deepEqual([card.status.state,card.status.items.map(i=>[i.id,i.state])],['stale',[['mini','stale'],['mini_server','not-configured']]]);
 // Revoked: the device holds no key, and the field is null again.
 assert.equal((await h.post('/api/admin/agents/revoke',{id:key.agent.id},h.admin)).status,200);
 assert.equal((await h.home('mini')).agent,null);
});

test('specsDiffer: the agent\'s SPECS digest against the hub\'s current watch list for that device',async t=>{
 const clock={now:Date.parse('2026-11-13T10:00:00Z')};
 const h=await agentHub(t,clock);
 const key=await issueAgent(h,'mini');
 // The fixture hub has no watch list: the device's specs.txt is empty, and so is the hash of it.
 const send=async digest=>{clock.now+=21600_000;return h.report(key.token,envelope(systemsParts({name:'mini',packages:[rec('SW','node','cmd','v22.13.0','/opt/homebrew/bin/node'),rec('SPECS',digest)]})));};
 assert.equal((await send(sha(''))).status,200);assert.equal((await h.home('mini')).agent.specsDiffer,false);
 // The digest is found once per stored part: polling the overview copies no records.
 const store=h.handler.state('agent').reports,slice=store.slice;let copies=0;
 store.slice=(device,names)=>{if(names.includes('packages'))copies++;return slice(device,names);};
 try{for(let i=0;i<3;i++)assert.equal((await h.home('mini')).agent.specsDiffer,false);}finally{store.slice=slice;}
 assert.equal(copies,0,'GET /api/home copies no packages part it has looked at before');
 assert.equal((await send(sha('node|cmd|/opt/homebrew/bin/node|--version|\n'))).status,200);assert.equal((await h.home('mini')).agent.specsDiffer,true);
 // Two SPECS lines: the last one is the agent's (docs/agent.md), whichever order they come in.
 const two=async(...digests)=>{clock.now+=21600_000;return h.report(key.token,envelope(systemsParts({name:'mini',packages:digests.map(d=>rec('SPECS',d))})));};
 assert.equal((await two(sha('x'),sha(''))).status,200);assert.equal((await h.home('mini')).agent.specsDiffer,false,'the last line matches');
 assert.equal((await two(sha(''),sha('x'))).status,200);assert.equal((await h.home('mini')).agent.specsDiffer,true,'the first line matching does not count');
});

test('specsDiffer is null while the hub\'s watch list cannot be read, and follows the file when it changes',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'hh-watch-')),file=path.join(dir,'software-watch.json');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(file,'{ not json');
 const clock={now:Date.parse('2026-11-13T10:00:00Z')};
 const h=await agentHub(t,clock,{softwareWatchFile:file});
 const key=await issueAgent(h,'mini');
 assert.equal((await h.report(key.token,envelope(systemsParts({name:'mini',packages:[rec('SPECS',sha(''))]})))).status,200);
 assert.equal((await h.home('mini')).agent.specsDiffer,null,'an unreadable list says nothing (agent-specs.mjs refuses too), never "differs"');
 await writeFile(file,JSON.stringify({schemaVersion:1,categories:{},items:[]}));
 assert.equal((await h.home('mini')).agent.specsDiffer,false,'read again once the file changed');
 await rm(file);
 assert.equal((await h.home('mini')).agent.specsDiffer,false,'a missing list is the empty list, as agent-specs.mjs prints it');
});

test('a re-issued key starts at never: what an earlier key of the device sent is not this key\'s report',async t=>{
 const clock={now:Date.parse('2026-11-13T10:00:00Z')};
 const h=await agentHub(t,clock);
 const old=await issueAgent(h,'mini');
 assert.equal((await h.report(old.token,envelope({heartbeat:{schema:1,interval:60},...systemsParts({name:'mini'})},{agentVersion:'1.6.0'}))).status,200);
 assert.equal((await h.home('mini')).agent.freshness,'fresh');
 // A second key while the first still works (a rotation): the device is still reporting.
 clock.now+=1000;const next=await issueAgent(h,'mini');
 assert.equal((await h.home('mini')).agent.freshness,'fresh','the earliest key that is not revoked counts');
 // The first key revoked (a leaked one): the one left has sent nothing.
 assert.equal((await h.post('/api/admin/agents/revoke',{id:old.agent.id},h.admin)).status,200);
 assert.deepEqual((await h.home('mini')).agent,{lastReportAt:null,freshness:'never',agentVersion:null,behind:null,specsDiffer:null});
 const item=async()=>(await h.get('/api/admin/integrations')).body.integrations.find(i=>i.id==='agent.reports').status.items.find(i=>i.id==='mini');
 assert.equal((await item()).state,'not-configured','the integration says it has not been heard from either');
 // Revoked again and issued anew: the same.
 assert.equal((await h.post('/api/admin/agents/revoke',{id:next.agent.id},h.admin)).status,200);
 clock.now+=1000;const third=await issueAgent(h,'mini');
 assert.equal((await h.home('mini')).agent.freshness,'never');
 assert.equal((await h.rpc('device_list')).devices.find(m=>m.id==='mini').agent.freshness,'never','device_list says the same');
 // Its first report: fresh, and only what it sent counts (the os part of the earlier key does not).
 clock.now+=60_000;
 const r=await h.report(third.token,envelope({heartbeat:{schema:1,interval:60}},{agentVersion:'1.7.0'}));assert.equal(r.status,200);
 const now=(await h.home('mini')).agent;
 assert.deepEqual([now.freshness,now.agentVersion],['fresh','1.7.0']);assert.equal((await item()).state,'ok');
 clock.now+=180_000;
 assert.equal((await h.home('mini')).agent.freshness,'no-news','the heartbeat went quiet; the earlier key\'s os part is not this key\'s');
});

test('a rotation: the old key reports after the new one is issued and is then revoked; what it sent is not the new key\'s',async t=>{
 const clock={now:Date.parse('2026-11-13T10:00:00Z')};
 const h=await agentHub(t,clock);
 const hb={heartbeat:{schema:1,interval:60}};
 const item=async()=>(await h.get('/api/admin/integrations')).body.integrations.find(i=>i.id==='agent.reports').status.items.find(i=>i.id==='mini');
 const agents=async()=>(await h.get('/api/admin/agents')).body.agents;
 const a=await issueAgent(h,'mini');
 assert.equal((await h.report(a.token,envelope({...hb,...systemsParts({name:'mini'})},{agentVersion:'1.6.0'}))).status,200);
 clock.now+=1000;const b=await issueAgent(h,'mini');
 // The rotation window: both keys are live, and a report of either counts.
 clock.now+=30_000;
 const late=await h.report(a.token,envelope(hb,{agentVersion:'1.6.1'}));assert.equal(late.status,200);
 const {receivedAt:lateAt}=await late.json();
 assert.deepEqual([(await h.home('mini')).agent.freshness,(await h.home('mini')).agent.lastReportAt],['fresh',lateAt]);
 assert.equal((await h.handler.state('agent').readers()).some(e=>e.id==='mini'),true,'the readers read it too');
 // The old key revoked: the one left has sent nothing, on every page that says so.
 assert.equal((await h.post('/api/admin/agents/revoke',{id:a.agent.id},h.admin)).status,200);
 assert.deepEqual((await h.home('mini')).agent,{lastReportAt:null,freshness:'never',agentVersion:null,behind:null,specsDiffer:null});
 assert.equal((await item()).state,'not-configured');
 assert.equal((await agents()).find(x=>x.id===b.agent.id).lastReportAt,null);
 assert.deepEqual((await h.handler.state('agent').readers()).filter(e=>e.id==='mini'),[],'nor do the readers read the revoked key\'s record');
 clock.now+=6*3600_000;
 assert.equal((await h.home('mini')).agent.freshness,'never','still never, not no news');
 // The new key's first report.
 const r=await h.report(b.token,envelope(hb,{agentVersion:'1.7.0'}));assert.equal(r.status,200);
 const body=await r.json();assert.deepEqual([body.accepted,body.refused],[['heartbeat'],[]]);
 const now=(await h.home('mini')).agent;
 assert.deepEqual([now.freshness,now.agentVersion,now.lastReportAt],['fresh','1.7.0',body.receivedAt]);
 assert.equal((await item()).state,'ok');
 // Only what it sent counts: the old key's os part is not read for it, by the overview or by the readers.
 assert.deepEqual(Object.keys((await h.handler.state('agent').readers()).find(e=>e.id==='mini').record.parts),['heartbeat']);
});

test('the too-soon check compares a part only with what the same key stored',async t=>{
 const clock={now:Date.parse('2026-11-13T10:00:00Z')};
 const h=await agentHub(t,clock);
 const hb={heartbeat:{schema:1,interval:60}};
 const a=await issueAgent(h,'mini'),b=await issueAgent(h,'mini');
 assert.equal((await h.report(a.token,envelope(hb))).status,200);
 clock.now+=5000;
 const first=await (await h.report(b.token,envelope(hb))).json();
 assert.deepEqual([first.accepted,first.refused],[['heartbeat'],[]],'another key\'s heartbeat 5 s ago does not make this one too soon');
 clock.now+=20_000;
 const again=await (await h.report(b.token,envelope(hb))).json();
 assert.deepEqual([again.accepted,again.refused.map(x=>[x.part,x.code])],[[],[['heartbeat','too-soon']]],'its own does');
 clock.now+=1000;
 assert.equal((await h.report(b.token,envelope(hb))).status,429,'and the 20 s floor stays per key');
});

test('a record of another platform than the device now says is no news, as for the readers',async t=>{
 const clock={now:Date.now()};
 const h=await agentHub(t,clock);
 clock.now=Date.now();
 const key=await issueAgent(h,DEVICE.id);
 assert.equal((await h.report(key.token,envelope({heartbeat:{schema:1,interval:60}},{platform:'linux'}))).status,200);
 assert.equal((await h.home(DEVICE.id)).agent.freshness,'fresh');
 const listed=(await h.get('/api/home/devices')).body.devices.find(m=>m.id===DEVICE.id);
 assert.equal((await h.post('/api/home/devices',{device:{...DEVICE,platform:'macos'},base:listed.hash},h.writer.headers)).status,200);
 await h.handler.state('agent').sweep();
 const a=(await h.home(DEVICE.id)).agent;
 assert.ok(a,'the key stays: macos may run an agent');
 assert.equal(a.freshness,'no-news','what a linux agent sent is not read for a macos device');assert.notEqual(a.lastReportAt,null);
});

test('the integration agent.reports turned off: a report is refused with 409 INTEGRATION_DISABLED and nothing is stored; the readers join no agent record',async t=>{
 const clock={now:Date.parse('2026-11-13T10:00:00Z')};
 const h=await agentHub(t,clock);
 const key=await issueAgent(h,'mini');
 const runtimes={schema:1,collectedAt:'2026-11-13T10:00:00Z',interval:120,data:{runtimes:[{id:'ollama',name:'Ollama',kind:'ollama',status:'running',url:'http://127.0.0.1:11434',models:[],stats:[]}]}};
 assert.equal((await h.report(key.token,envelope({heartbeat:{schema:1,interval:60},runtimes}))).status,200);
 const record=async()=>JSON.parse(await readFile(path.join(h.dir,'agent','mini.json'),'utf8'));
 const stored=await record();
 assert.equal((await h.home('mini')).runtimes?.source,'agent');
 const off=await h.post('/api/admin/integrations/toggle',{id:'agent.reports',enabled:false},h.admin);assert.equal(off.status,200);
 clock.now+=60_000;
 const refused=await h.report(key.token,envelope({heartbeat:{schema:1,interval:60}}));
 assert.equal(refused.status,409);assert.equal(await errorCode(refused),'INTEGRATION_DISABLED');
 assert.deepEqual(await record(),stored,'nothing stored');
 // Off as for every other integration: the overview lists it, the readers answer as without agents, the card says so.
 const home=(await h.get('/api/home')).body;
 assert.ok(home.integrations.disabled.some(i=>i.id==='agent.reports'&&i.kind==='agent'));
 assert.equal(home.devices.find(m=>m.id==='mini').runtimes,null,'home.runtimes answers nothing while it is off');
 assert.equal(home.devices.find(m=>m.id==='mini').agent.lastReportAt,stored.lastSeenAt,'the key is still there: the field says when it was last heard');
 assert.deepEqual(await h.handler.state('agent').readers(),[]);
 const card=(await h.get('/api/admin/integrations')).body.integrations.find(i=>i.id==='agent.reports');
 assert.deepEqual([card.enabled,card.status.state],[false,'disabled']);
 // An unknown key is still 401 first, and every other credential still 403: the gate is unchanged.
 assert.equal((await h.report('hha_'+'0'.repeat(64),envelope())).status,401);
 // On again: taken as before.
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'agent.reports',enabled:true},h.admin)).status,200);
 clock.now+=60_000;
 assert.equal((await h.report(key.token,envelope({heartbeat:{schema:1,interval:60}}))).status,200);
 assert.equal((await h.home('mini')).runtimes?.source,'agent');
});

test('turned off, a key whose device is gone is still revoked on its report (409 AGENT_DEVICE_GONE, not INTEGRATION_DISABLED)',async t=>{
 const clock={now:Date.now()};
 const h=await agentHub(t,clock);
 clock.now=Date.now();
 const key=await issueAgent(h,DEVICE.id);
 assert.equal((await h.post('/api/admin/integrations/toggle',{id:'agent.reports',enabled:false},h.admin)).status,200);
 const listed=(await h.get('/api/home/devices')).body.devices.find(m=>m.id===DEVICE.id);
 assert.equal((await h.post('/api/home/devices/remove',{id:DEVICE.id,base:listed.hash},h.writer.headers)).status,200);
 const r=await h.report(key.token,envelope({heartbeat:{schema:1,interval:60}},{platform:'linux'}));
 assert.equal(r.status,409);assert.equal(await errorCode(r),'AGENT_DEVICE_GONE');
 assert.equal(h.handler.state('agent').record(DEVICE.id),null,'nothing stored');
 const stored=(await h.get('/api/admin/agents')).body.agents.find(a=>a.id===key.agent.id);
 assert.equal(stored.revokedBy,'device-removed','revoked in the same step');
 assert.equal((await h.report(key.token,envelope({heartbeat:{schema:1,interval:60}},{platform:'linux'}))).status,401);
});

test('a device added after its id was used: an old record is no report (never), and agent keys of a device show on its tile',async t=>{
 // A device's createdAt is the real clock's, so the agent clock starts there too.
 const clock={now:Date.now()};
 const h=await agentHub(t,clock);
 clock.now=Date.now();
 const key=await issueAgent(h,DEVICE.id);
 assert.equal((await h.report(key.token,envelope({heartbeat:{schema:1,interval:60}},{platform:'linux'}))).status,200);
 assert.equal((await h.home(DEVICE.id)).agent.freshness,'fresh');
 // Removed and added again under the same id: the key is revoked by the hub, and a new key starts at never.
 const listed=(await h.get('/api/home/devices')).body.devices.find(m=>m.id===DEVICE.id);
 assert.equal((await h.post('/api/home/devices/remove',{id:DEVICE.id,base:listed.hash},h.writer.headers)).status,200);
 await new Promise(r=>setTimeout(r,20));
 assert.equal((await h.post('/api/home/devices',{device:DEVICE},h.writer.headers)).status,201);
 await h.handler.state('agent').sweep();
 assert.equal((await h.home(DEVICE.id)).agent,null,'the old key is revoked');
 await issueAgent(h,DEVICE.id);
 assert.equal((await h.home(DEVICE.id)).agent.freshness,'never','what the earlier device of that id sent is not this one\'s');
});
