// Reachability (server/reachability.mjs): a TCP connect from the hub to each machine's ports, a signal of its own
// beside "online". Every connect is injected here, so no test touches a network; the waits are a few milliseconds.
import test from 'node:test';
import net from 'node:net';
import assert from 'node:assert/strict';
import {checkHost,reachabilityOf,reachTargets,createReachabilityPoller,REACH_STALE_MS} from '../server/reachability.mjs';
import {validateSite} from '../server/site-config.mjs';
import {hub,SITE} from './hub-helper.mjs';

const NEVER=()=>new Promise(()=>{});
const machine=(extra={})=>({id:'alpha',name:'Alpha',hostname:'alpha.example.lan',ip:'10.0.0.5',role:'computer',...extra});

test('an open port answers, and the check says it was open',async()=>{
 assert.deepEqual(await checkHost({host:'10.0.0.5',ports:[22],timeoutMs:20,connect:async()=>'open'}),{state:'answering',port:22,open:true});
});

test('a refused port answers too: the host reset the connect, so it is there',async()=>{
 assert.deepEqual(await checkHost({host:'10.0.0.5',ports:[22],connect:async()=>'refused'}),{state:'answering',port:22,open:false});
});

test('a timeout on every port is not-answering, even when the connect never settles',async()=>{
 assert.deepEqual(await checkHost({host:'10.0.0.5',ports:[22,2222],timeoutMs:5,connect:NEVER}),{state:'not-answering',port:null,open:null});
});

test('an unreachable network (a rejected connect) is not-answering; so is a connect that says nothing usable',async()=>{
 const noRoute=async()=>{throw Object.assign(new Error('no route'),{code:'EHOSTUNREACH'});};
 assert.equal((await checkHost({host:'10.0.0.5',ports:[22],connect:noRoute})).state,'not-answering');
 assert.equal((await checkHost({host:'10.0.0.5',ports:[22],connect:async()=>'maybe'})).state,'not-answering');
});

test('ports are tried in order, the first answer decides, and later ports are not tried',async()=>{
 const seen=[];
 const connect=async({port})=>{seen.push(port);if(port===22)throw new Error('timeout');return port===2222?'refused':'open';};
 assert.deepEqual(await checkHost({host:'10.0.0.5',ports:[22,2222,80],connect}),{state:'answering',port:2222,open:false});
 assert.deepEqual(seen,[22,2222]);
});

test('no host or no port is unknown, and nothing is connected',async()=>{
 let calls=0;const connect=async()=>{calls++;return 'open';};
 assert.deepEqual(await checkHost({host:'',ports:[22],connect}),{state:'unknown',port:null,open:null});
 assert.deepEqual(await checkHost({host:'10.0.0.5',ports:[],connect}),{state:'unknown',port:null,open:null});
 assert.equal(calls,0);
});

test('a reading older than three minutes is unknown, and its time is kept',()=>{
 const now=Date.parse('2026-11-13T10:00:00.000Z');
 const fresh={state:'answering',port:22,open:true,at:now-(REACH_STALE_MS-1000)};
 assert.deepEqual(reachabilityOf(fresh,now),{state:'answering',checkedAt:'2026-11-13T09:57:01.000Z',port:22});
 const old=now-REACH_STALE_MS-1;
 assert.deepEqual(reachabilityOf({...fresh,at:old},now),{state:'unknown',checkedAt:new Date(old).toISOString(),port:null});
 assert.deepEqual(reachabilityOf(undefined,now),{state:'unknown',checkedAt:null,port:null});
});

test('reach:false machines are never checked; absent reach means port 22; a machine with no address is left out',()=>{
 const site=validateSite({machines:[machine({id:'alpha'}),machine({id:'beta',ip:'10.0.0.6',reach:false}),machine({id:'gamma',ip:'10.0.0.7',reach:{ports:[2222,22]}}),machine({id:'delta',ip:'',hostname:''})]});
 assert.deepEqual(reachTargets(site),[{id:'alpha',host:'10.0.0.5',ports:[22]},{id:'gamma',host:'10.0.0.7',ports:[2222,22]}]);
 assert.deepEqual(reachTargets(validateSite({})),[]);
});

test('the poller runs one pass at a time, at most four machines at once, and keeps one result per machine',async()=>{
 const targets=Array.from({length:6},(_,i)=>({id:`m${i}`,host:`10.0.0.${i+1}`,ports:[22]}));
 let inFlight=0,peak=0,calls=0;
 const connect=async()=>{calls++;inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,2));inFlight--;return 'open';};
 const p=createReachabilityPoller({targets:()=>targets,connect,now:()=>1000});
 const first=p.poll();
 assert.equal(p.poll(),first,'a call while a pass is running shares it');
 await first;
 assert.equal(calls,6);
 assert.ok(peak>=2&&peak<=4,`at most four at once, saw ${peak}`);
 assert.deepEqual(p.status().m0,{state:'answering',port:22,open:true,at:1000});
 assert.equal(Object.keys(p.status()).length,6);
});

test('paused: no check runs and nothing is kept, so every machine reads unknown; resumed, it checks again',async()=>{
 let calls=0;
 const p=createReachabilityPoller({targets:()=>[{id:'m0',host:'10.0.0.1',ports:[22]}],connect:async()=>{calls++;return 'open';}});
 await p.poll();assert.equal(calls,1);
 await p.pause();
 assert.equal(p.paused(),true);
 assert.deepEqual(p.status(),{});
 await p.poll();assert.equal(calls,1,'no check while paused');
 assert.deepEqual(reachabilityOf(p.status().m0,Date.now()),{state:'unknown',checkedAt:null,port:null});
 await p.resume();await p.poll();assert.equal(calls,2);
});

test('paused or stopped in the middle of a pass: no later batch opens a socket',async()=>{
 const targets=Array.from({length:6},(_,i)=>({id:`m${i}`,host:`10.0.0.${i+1}`,ports:[22]}));
 for(const how of ['pause','stop']){
  let calls=0,p=null;
  // The first connect of the first batch switches the poller off; the other connect of that batch is already in flight.
  const connect=async()=>{calls++;if(calls===1){if(how==='pause')p.pause();else p.stop();}return 'open';};
  p=createReachabilityPoller({targets:()=>targets,connect,concurrency:2,now:()=>1000});
  await p.poll();
  assert.equal(calls,2,`${how}: only the batch in flight is connected, no later batch`);
  assert.deepEqual(p.status(),{},`${how}: the results of that pass are dropped`);
 }
});

test('a hub built by the test helper never calls the real connect from the reachability poller',async t=>{
 // Counts every connect made by server/reachability.mjs (the real tcpConnect calls net.connect from there).
 const real=net.connect;let fromPoller=0;
 t.mock.method(net,'connect',function(...args){if(new Error().stack.includes('reachability.mjs'))fromPoller++;return real.apply(this,args);});
 const h=await hub(t);
 await h.handler.start();
 // The inert poller does run: its pass gives every checked machine a time, even though its connects fail.
 let checked=false;
 for(let i=0;i<200&&!checked;i++){
  const doc=await (await fetch(h.origin+'/api/home',{headers:h.admin})).json();
  checked=doc.machines.some(m=>m.reachability?.checkedAt);
  if(!checked)await new Promise(r=>setTimeout(r,10));
 }
 await h.handler.stop();
 assert.equal(checked,true,'the default poller ran its pass');
 assert.equal(fromPoller,0,'no connect from server/reachability.mjs');
});

test('site.json reach: absent or null is port 22, false is never checked, {ports} takes 1 to 4 ports; anything else is named',()=>{
 const one=reach=>validateSite({machines:[machine({reach})]}).machines[0].reach;
 assert.deepEqual(one(undefined),{ports:[22]});
 assert.deepEqual(one(null),{ports:[22]});
 assert.equal(one(false),false);
 assert.deepEqual(one({ports:[22,2222,80,443]}),{ports:[22,2222,80,443]});
 const refuses=(reach,pattern)=>assert.throws(()=>validateSite({machines:[machine({reach})]}),pattern);
 refuses(true,/machines\[0\]\.reach must be false, or/);
 refuses('22',/machines\[0\]\.reach must be false, or/);
 refuses({},/reach\.ports must be a list of 1 to 4/);
 refuses({ports:[]},/reach\.ports must be a list of 1 to 4/);
 refuses({ports:[22,2222,80,443,8080]},/reach\.ports must be a list of 1 to 4/);
 refuses({ports:[0]},/reach\.ports\[0\] must be a port number from 1 to 65535/);
 refuses({ports:[65536]},/reach\.ports\[0\] must be a port number from 1 to 65535/);
 refuses({ports:[22.5]},/reach\.ports\[0\]/);
 refuses({ports:['22']},/reach\.ports\[0\]/);
 refuses({ports:[22,22]},/reach\.ports lists a port twice/);
 refuses({ports:[22],timeout:5},/reach has unknown field\(s\): timeout/);
});

test('GET /api/home and /api/home/devices carry reachability; online does not change; disabling the integration reads unknown',async t=>{
 // The fixture's studio answers with a refusal (it is there), every other machine times out.
 const reach=createReachabilityPoller({targets:()=>reachTargets(SITE),connect:async({host})=>{if(host===SITE.machines.find(m=>m.id==='studio').ip)return 'refused';throw new Error('timeout');}});
 const h=await hub(t,{reachability:reach});
 const get=async path=>(await fetch(h.origin+path,{headers:h.admin})).json();
 const byId=doc=>Object.fromEntries(doc.machines.map(m=>[m.id,m]));
 const before=byId(await get('/api/home'));
 for(const m of SITE.machines)assert.deepEqual(before[m.id].reachability,{state:'unknown',checkedAt:null,port:null},`${m.id} before the first pass`);
 await reach.poll();
 const after=byId(await get('/api/home'));
 for(const m of SITE.machines){
  assert.equal(after[m.id].online,before[m.id].online,`${m.id}: online is unchanged by the check`);
  assert.deepEqual(Object.keys(after[m.id].reachability).sort(),['checkedAt','port','state']);
 }
 assert.equal(after.studio.reachability.state,'answering');
 assert.equal(after.studio.reachability.port,22);
 assert.equal(after.mini.reachability.state,'not-answering');
 assert.equal(after.mini.reachability.port,null);
 assert.match(after.mini.reachability.checkedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
 const list=await get('/api/home/devices');
 for(const m of list.machines.filter(x=>x.source==='site'))assert.deepEqual(m.reachability,after[m.id].reachability,`${m.id} on the machine list`);
 // The integration on the integrations page: disabled, the poller stops and every machine reads unknown.
 const off=await h.post('/api/admin/integrations/toggle',{id:'home.reachability',enabled:false},h.admin);
 assert.equal(off.status,200);
 assert.equal(reach.paused(),true);
 const item=(await get('/api/admin/integrations')).integrations.find(i=>i.id==='home.reachability');
 assert.equal(item?.enabled,false);
 for(const m of Object.values(byId(await get('/api/home'))))assert.equal(m.reachability.state,'unknown');
 const on=await h.post('/api/admin/integrations/toggle',{id:'home.reachability',enabled:true},h.admin);
 assert.equal(on.status,200);
 assert.equal(reach.paused(),false);
 await reach.poll();
 assert.equal(byId(await get('/api/home')).studio.reachability.state,'answering');
});
