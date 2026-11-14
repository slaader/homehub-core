// Reachability: does a machine's address answer on the network? The hub makes a TCP connect to each port a
// machine lists in site.json (machines[].reach, default port 22) and records the answer. It is a signal of its
// own, apart from "online" (server/home-data.mjs), which it never changes. A host that does not answer is not
// proof of the machine's state (AGENTS.md: a failed probe is not proof of a device's state).
//   checkHost({host, ports, timeoutMs, connect})  → {state: answering|not-answering|unknown, port, open}
//   reachabilityOf(entry, nowMs)                  → {state, checkedAt, port} as the API shows it (older than 3 min = unknown)
//   reachTargets(site)                            → [{id, host, ports}] of the site machines that are checked
//   createReachabilityPoller({targets, connect, now, …}) → {start, stop, poll, pause, resume, paused, status}
// A port answers when the connect completes (open) or the host refuses it (refused: something answered with a
// reset). A timeout or an unreachable network on every port is not-answering. connect and the clock are injected
// so tests never touch the network. The connect pattern is the one of scripts/collect-security.mjs (tcpOpen).
import net from 'node:net';

export const REACH_INTERVAL_MS=60000;
export const REACH_TIMEOUT_MS=2000;
export const REACH_CONCURRENCY=4;
export const REACH_STALE_MS=180000;
export const REACH_DEFAULT_PORTS=Object.freeze([22]);

// One TCP connect. Resolves 'open' (the handshake completed) or 'refused' (ECONNREFUSED); rejects for anything else.
export function tcpConnect({host,port,timeoutMs=REACH_TIMEOUT_MS}){
 return new Promise((resolve,reject)=>{
  const s=net.connect({host,port});
  const done=(fn,v)=>{s.destroy();fn(v);};
  s.setTimeout(timeoutMs,()=>done(reject,new Error('timeout')));
  s.once('connect',()=>done(resolve,'open'));
  s.once('error',e=>e?.code==='ECONNREFUSED'?done(resolve,'refused'):done(reject,e));
 });
}

// One port, bounded by timeoutMs whatever the connect does. → 'open' | 'refused' | 'unreachable' (never throws).
async function probePort({host,port,timeoutMs,connect}){
 let timer=null;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),timeoutMs);timer.unref?.();});
 try{
  const r=await Promise.race([Promise.resolve().then(()=>connect({host,port,timeoutMs})),deadline]);
  return r==='open'||r==='refused'?r:'unreachable';
 }catch{return 'unreachable';}
 finally{clearTimeout(timer);}
}

// The ports are tried in order; the first that answers decides. No host, or no port: unknown.
export async function checkHost({host,ports=REACH_DEFAULT_PORTS,timeoutMs=REACH_TIMEOUT_MS,connect=tcpConnect}={}){
 if(typeof host!=='string'||!host||!Array.isArray(ports)||!ports.length)return {state:'unknown',port:null,open:null};
 for(const port of ports){
  const r=await probePort({host,port,timeoutMs,connect});
  if(r==='open'||r==='refused')return {state:'answering',port,open:r==='open'};
 }
 return {state:'not-answering',port:null,open:null};
}

// The API's view of one machine's last check (entry = {state, port, at} with at in ms, or nothing).
// A result older than REACH_STALE_MS, or none, is unknown; its checkedAt stays so the age can be read.
export function reachabilityOf(entry,nowMs){
 const at=Number.isFinite(entry?.at)?entry.at:null;
 if(at===null)return {state:'unknown',checkedAt:null,port:null};
 const checkedAt=new Date(at).toISOString();
 if(nowMs-at>REACH_STALE_MS)return {state:'unknown',checkedAt,port:null};
 return {state:entry.state,checkedAt,port:entry.port};
}

// The machines of the site configuration that are checked: not reach:false, and with an address (ip, else hostname).
export function reachTargets(site){
 return (site?.machines||[]).filter(m=>m.reach!==false&&(m.ip||m.hostname)).map(m=>({id:m.id,host:m.ip||m.hostname,ports:[...(m.reach?.ports??REACH_DEFAULT_PORTS)]}));
}

// The poller: one run at a time, at most `concurrency` machines at once, the ports of a machine in order.
// targets() → [{id, host, ports}] (see reachTargets). Results are kept per machine: {state, port, open, at}.
export function createReachabilityPoller({targets=()=>[],connect=tcpConnect,now=Date.now,intervalMs=REACH_INTERVAL_MS,timeoutMs=REACH_TIMEOUT_MS,concurrency=REACH_CONCURRENCY,log=()=>{}}={}){
 const results=new Map();
 let timer=null,polling=null,paused=false,started=false,stopped=false;
 async function run(){
  const list=await Promise.resolve().then(()=>targets()).catch(()=>[]);
  const ids=new Set(list.map(t=>t.id));
  for(const id of [...results.keys()])if(!ids.has(id))results.delete(id);
  for(let i=0;i<list.length;i+=concurrency){
   // Paused or stopped mid-pass: no further batch opens a socket (the batch in flight finishes; its results are dropped).
   if(paused||stopped)break;
   await Promise.all(list.slice(i,i+concurrency).map(async t=>{
    const r=await checkHost({host:t.host,ports:t.ports,timeoutMs,connect}).catch(()=>({state:'unknown',port:null,open:null}));
    if(paused||stopped||!ids.has(t.id))return;
    results.set(t.id,{...r,at:now()});
   }));
  }
 }
 function poll(){
  if(paused)return Promise.resolve();
  if(polling)return polling;
  polling=(async()=>{try{await run();}catch(e){log('reachability',e?.message||'failed');}finally{polling=null;}})();
  return polling;
 }
 const schedule=()=>{clearInterval(timer);timer=setInterval(()=>void poll(),intervalMs);timer.unref?.();};
 return {
  // Starts without waiting for the first run: a check of many machines must not hold up the hub's start.
  start(){started=true;stopped=false;if(!paused){void poll();schedule();}return Promise.resolve();},
  stop(){started=false;stopped=true;clearInterval(timer);timer=null;},
  poll,
  // Paused (the integration is disabled): no checks, and nothing kept, so every machine reads unknown.
  pause(){paused=true;clearInterval(timer);timer=null;results.clear();return Promise.resolve();},
  resume(){if(!paused)return Promise.resolve();paused=false;if(started){void poll();schedule();}return Promise.resolve();},
  paused:()=>paused,
  status:()=>Object.fromEntries(results),
 };
}
