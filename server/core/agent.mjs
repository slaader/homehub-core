// Core module "agent": where the push agent reports (docs/agent.md). One route, POST /api/agent/report, reached
// only with an agent key (hha_…, server/agent-store.mjs); the request pipeline (server/index.mjs) refuses that key
// everywhere else (403 AGENT_ONLY) and every other credential here (403 AGENT_CREDENTIAL_REQUIRED). The device is
// the key's, never the report's. What is accepted is kept per device in <state>/agent/<device>.json.
//
// The readers join it (docs/agent.md §3 → Who wins over the collectors): readers() hands the records of devices that
// exist now and still hold a key that is not revoked, last sent with one of those keys, to GET /api/systems and GET /api/security
// (server/core/security.mjs), this module provides home.runtimes
// from the runtimes parts (source "agent", observedAt = the receive time), and an accepted os part adds the device's
// line to the trend in <state>/agent/history.jsonl, at most every six hours (the collector's history.jsonl is its own).
//
// The keys are managed by administrators (core module "access": GET/POST /api/admin/agents…, which call the
// functions this module's state exposes) and by `node scripts/manage-access.mjs create-agent-key` with the hub
// stopped. A key whose device is gone or was re-created is revoked by the hub itself ("device-removed"), and so is
// one whose device would now be refused at issue: the router, the NAS, platform "other" ("device-changed"). That
// happens on a report, at the start, and when devices.json changes.
//
// The overview shows the agent of each device that holds a key (overview(), read by server/home-data.mjs → agentFor:
// devices[].agent on GET /api/home, GET /api/home/devices and the MCP tool device_list), and the integration
// "agent.reports" puts the agents on Administration → Integrations (docs/agent.md §7, step 4). Turned off there, the hub
// takes no report (409 INTEGRATION_DISABLED, nothing stored) and the readers join no agent record, so /api/systems,
// /api/security and home.runtimes answer as on a hub without agents; the keys and what was stored stay as they are.
//
// hub.options.agentClock (a () => ms function) stands in for the clock in the tests.
import {forwardJsonl,forwardTrendLine} from '../state-forward.mjs';
import {stat,readFile,writeFile,appendFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {validateReport,PARTS,REPORT_LIMITS,freshUntil} from '../agent-report.mjs';
import {createReportStore,createAgentAudit,findDevice,deviceRefusal,boundTo,deviceFresh} from '../agent-store.mjs';
import {runtimeEndpoint} from '../site-config.mjs';
import {buildSystems,historyEntry,systemsDirectory,specsFileText} from '../systems-data.mjs';
import {readWatch,watchPath} from '../software-watch.mjs';
import {agentFor} from '../home-data.mjs';
import {worstState} from '../integration-states.mjs';
import {tx} from '../text.mjs';

export const AGENT_MODULE='agent';
export const AGENT_INTEGRATION='agent.reports';
const SWEEP_EVERY_MS=30_000,HISTORY_EVERY_MS=6*3600_000,HISTORY_LINES=3000;
const MESSAGES={
 unknown:'No device of the overview has this id.',
 router:'The router is reported by the router adapter, not by an agent.',
 nas:'The NAS stays agent-less: it is read over SSH (ssh.probe "nas").',
 other:'A device whose platform is "other" cannot run an agent: set its platform to macos, linux or windows, or leave it unset.'};
// Why the hub revokes a key on its own, or null while the key may stay: its device is gone or re-created
// ("device-removed"), or would now be refused at issue ("device-changed").
const lapsed=(key,m)=>!boundTo(key,m)?'device-removed':deviceRefusal(m)?'device-changed':null;
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
// A runtimes part that is no news says nothing about now: as the direct reads do with a stale read, the status is
// unknown, nothing is busy and nothing is said to be loaded.
// No process ids either, the runtime's or a model's: an old pid may name a live process now (the GPU processes are
// named by them). stats is [] as on a direct read that is stale.
const noNews=r=>{const {activity,pids,...rest}=r;
 return {...rest,status:'unknown',stats:[],models:(Array.isArray(r.models)?r.models:[]).map(m=>{const {active,queued,since,pids:_,...x}=m;return {...x,state:'unknown',ttlRemainingSeconds:null};})};};

function setupAgent(hub){
 const now=hub.options.agentClock||Date.now;
 const keys=hub.agentStore,reports=createReportStore(hub.stateDirectory,{now}),audit=createAgentAudit(hub.stateDirectory,{now});
 const home=hub.state('home');
 const addedDevices=async()=>home?.homeDevices?await home.homeDevices.list():[];
 // The integration "agent.reports" (below): off, no report is taken and no agent record is read.
 const on=()=>typeof hub.integrationEnabled==='function'?hub.integrationEnabled(AGENT_INTEGRATION):true;
 // The hub's software watch list, the one the systems page reads.
 const watchRegistry=()=>readWatch({file:hub.state('security')?.watch?.file??watchPath()}).then(w=>w?.registry||null).catch(()=>null);
 const deviceNow=async id=>findDevice(id,{siteDevices:hub.site.devices,addedDevices:await addedDevices()});
 // When each key's last report was accepted (the 20 s floor) and what it said, for the admin list.
 const lastAccepted=new Map(),lastReport=new Map();
 for(const device of reports.devices()){const r=reports.get(device);if(r?.agentId)lastReport.set(r.agentId,{at:r.lastSeenAt,agentVersion:r.agentVersion,platform:r.platform});}
 const seen=new Set([...lastReport.keys()]);
 // Revoke every key whose device is gone or re-created. One sweep at a time.
 let sweeping=null;
 const sweep=()=>sweeping??=(async()=>{try{
   const list=await addedDevices(),gone=keys.active().map(k=>[k,lapsed(k,findDevice(k.device,{siteDevices:hub.site.devices,addedDevices:list}))]).filter(([,why])=>why);
   for(const [k,why] of gone)await keys.revoke(k.id,{by:why});return gone.length;}finally{sweeping=null;}})();
 const view=a=>{const r=lastReport.get(a.id);return {...a,lastReportAt:r?.at??null,agentVersion:r?.agentVersion??null,platform:r?.platform??null};};
 const admin={
  async list(){await sweep();return keys.list().map(view);},
  async issue(input,{by}){
   if(!plain(input)||Object.keys(input).some(k=>!['device','name'].includes(k))||typeof input.device!=='string'||input.name!==undefined&&typeof input.name!=='string')throw Object.assign(new Error('invalid'),{detail:'Send {device, name?}.'});
   await sweep();
   const m=await deviceNow(input.device),why=deviceRefusal(m);
   if(why)throw Object.assign(new Error('invalid'),{detail:MESSAGES[why]});
   const r=await keys.issue(m,{name:input.name,by});return {token:r.token,agent:view(r.agent)};
  },
  async revoke(input,{by}){
   if(!plain(input)||Object.keys(input).length!==1||typeof input.id!=='string')throw new Error('invalid');
   return {agent:view((await keys.revoke(input.id,{by})).agent)};
  },
 };
 // The audit lines a report may bring: a key's first report, one after no news, a changed version or platform.
 const noteReport=(key,before,report,at,stored)=>{
  const who={agent:key.id,device:key.device},out=[];
  if(!seen.has(key.id)){seen.add(key.id);out.push(audit.record('agent-first-report',who));}
  // Back after no news: something was stored before, all of it had gone stale, and this report stored a part. A
  // device whose reports store nothing (every part refused) never comes back, so it writes no such line.
  else if(stored&&before&&Object.keys(before.parts||{}).length&&!deviceFresh(before,at))out.push(audit.record('agent-report-after-no-news',who));
  if(before?.agentVersion&&before.agentVersion!==report.agentVersion)out.push(audit.record('agent-version-changed',{...who,detail:`${before.agentVersion} → ${report.agentVersion}`}));
  if(before?.platform&&before.platform!==report.platform)out.push(audit.record('agent-platform-changed',{...who,detail:`${before.platform} → ${report.platform}`}));
  return Promise.all(out).catch(()=>{});
 };
 const refused=(key,code,detail)=>audit.refused(code,{agent:key.id,device:key.device,detail}).catch(()=>{});
 // An endpoint of a runtimes part: what runtimeEndpoint accepts for the bound device (loopback, or inside lanCidrs).
 const runtimeUrl=device=>url=>{try{runtimeEndpoint({device,url},{lanCidrs:hub.site.lanCidrs});return true;}catch{return false;}};

 // The key as it stands now. The pipeline verified it when the headers arrived; the body can take up to ten
 // seconds more, and a revocation in between must win (docs/agent.md §6 → Outlive its revocation).
 const stillValid=key=>{const k=keys.get(key.id);return Boolean(k)&&!k.revokedAt;};
 const revokedAnswer=c=>c.error(401,'AUTH_REQUIRED','Use an agent key: Authorization: Bearer hha_…');

 async function receive(c){
  const key=c.principal,at=now(),receivedAt=new Date(at).toISOString();
  if(!stillValid(key))return revokedAnswer(c);
  // A key whose device is gone or changed is revoked first, whether the integration is on or off.
  const m=await deviceNow(key.device),why=lapsed(key,m);
  if(why){
   if(stillValid(key))await keys.revoke(key.id,{by:why});await refused(key,'AGENT_DEVICE_GONE');
   return c.error(409,'AGENT_DEVICE_GONE',why==='device-removed'?'The device this key was issued for is gone or was added again; the key is revoked. Issue a new one.'
    :'The device this key was issued for no longer takes an agent (the router, the NAS, or platform "other"); the key is revoked.');
  }
  // Turned off by an administrator: nothing is taken, as no other integration that is off reads anything. The agent
  // logs a 409 and waits for its next interval (docs/agent.md §5); the key and what was stored before stay.
  if(!on()){await refused(key,'INTEGRATION_DISABLED');
   return c.error(409,'INTEGRATION_DISABLED','Push agents are turned off on this hub (Administration → Integrations); nothing was stored. Try again at the next interval.');}
  // The 20 s floor. The slot is taken here, before anything else is awaited, so reports that arrive together cannot
  // all pass; it is given back when this report does not end in a 200.
  const last=lastAccepted.get(key.id),floor=REPORT_LIMITS.floorSeconds*1000;
  if(last!==undefined&&at-last<floor){
   c.res.setHeader('Retry-After',String(Math.max(1,Math.ceil((floor-(at-last))/1000))));await refused(key,'AGENT_TOO_SOON');
   return c.error(429,'AGENT_TOO_SOON',`One report per ${REPORT_LIMITS.floorSeconds} seconds; send what falls due together.`);
  }
  lastAccepted.set(key.id,at);
  let done=false;
  try{
   const v=validateReport(c.input,{runtimeUrl:runtimeUrl(key.device)});
   if(!v.ok){await refused(key,'AGENT_REPORT_INVALID',`field ${v.field}`);return c.json(400,{error:{code:'AGENT_REPORT_INVALID',message:`The report is malformed: ${v.field}.`,field:v.field}});}
   // Written by a newer hub: refused rather than overwritten (older code refuses newer state).
   if(reports.locked(key.device))return c.error(500,'UNAVAILABLE','The hub cannot store this device\'s reports: its record was written by a newer Home Hub.');
   const parts={...v.parts},refusals=[...v.refused];
   const take=(name,code)=>{delete parts[name];refusals.push({part:name,code});};
   // A device whose platform is said must report that one: the hub never guesses which side is right.
   if(m.platform&&m.platform!==v.report.platform)for(const name of Object.keys(parts))take(name,'platform-mismatch');
   // A part sent again before its range's minimum is not stored; the rest of the report is.
   const stored=reports.get(key.device);
   // Compared only with what this key stored (the record's agentId is the key of its last report): the first report
   // of a key that takes over is not held back by the other key's parts, which the overview and the readers no longer
   // count once that key is revoked. The 20 s floor above is per key either way.
   const own=stored?.agentId===key.id;
   for(const name of Object.keys(parts)){const prev=own?stored.parts?.[name]:null;if(prev&&at-Date.parse(prev.receivedAt)<PARTS[name].interval.min*1000)take(name,'too-soon');}
   // Checked again right before the store, with nothing awaited in between: a key revoked while its report was on
   // the way stores nothing.
   if(!stillValid(key))return revokedAnswer(c);
   const {before}=await reports.accept(key.device,{agentId:key.id,report:v.report,parts,receivedAt});
   done=true;lastReport.set(key.id,{at:receivedAt,agentVersion:v.report.agentVersion,platform:v.report.platform});
   await noteReport(key,before,v.report,at,Object.keys(parts).length>0);
   if(parts.os)await noteHistory(key.device,at).catch(e=>console.error(`agent: history of ${key.device}: ${e.message}`));
   for(const r of refusals)await refused(key,r.code,`${r.part}${r.tag?` ${r.tag}`:''}${r.field?` field ${r.field}`:''}`);
   return c.json(200,{receivedAt,accepted:Object.keys(parts),refused:refusals});
  }finally{if(!done&&lastAccepted.get(key.id)===at)last===undefined?lastAccepted.delete(key.id):lastAccepted.set(key.id,last);}
 }

 // Whether a device's stored record is trusted now, and from when: the device exists, would still be given a key, and
 // holds keys that are not revoked and are bound to it as it is now. → {m, keys, since} or null. since is when the
 // earliest of those keys was issued (never before an added device was created): what arrived before it is another
 // key's (one revoked since) or an earlier device's of that id. A record counts only while the key of its last report
 // (its agentId; the parts carry none of their own) is one of those keys, so a report sent with a key revoked since is
 // no report at all, and a re-issued key starts at never. While two keys are live (a rotation), either one's counts.
 const trust=(id,{list,live})=>{
  const m=findDevice(id,{siteDevices:hub.site.devices,addedDevices:list});if(!m||deviceRefusal(m))return null;
  const bound=live.filter(k=>k.device===id&&boundTo(k,m));if(!bound.length)return null;
  const stamps=bound.map(k=>Date.parse(k.createdAt??'')).filter(Number.isFinite),born=Date.parse(m.createdAt??'');
  return {m,keys:bound,since:Math.max(stamps.length?Math.min(...stamps):-Infinity,Number.isFinite(born)?born:-Infinity)};
 };
 const counts=(t,r)=>Boolean(r)&&t.keys.some(k=>k.id===r.agentId)&&Date.parse(r.lastSeenAt??'')>=t.since;
 const since=(t,p)=>Date.parse(p?.receivedAt??'')>=t.since;
 const nameOf=(id,list)=>hub.site.devices.find(x=>x.id===id)?.name||list.find(d=>d?.id===id)?.name||id;

 // What the readers join: the records trusted now (trust above, [{id, name, record}], by id), with only the parts
 // received since. Revoking a device's last key is how an administrator stops trusting it: from then on its records
 // are not read, and neither is a record whose last report came with a key revoked since. A record of another platform
 // than the device now says is left out (its reports are refused from now on). parts: the part names to copy (all
 // when left out).
 async function readers({parts:names=null}={}){
  if(!on())return [];// the integration is off: no agent record is read
  const list=await addedDevices().catch(()=>[]),out=[];
  let live;try{live=keys.active();}catch{return [];}// a key store this hub cannot read trusts nothing
  for(const id of reports.devices().sort()){
   const t=trust(id,{list,live});if(!t)continue;
   const r=names?reports.slice(id,names):reports.get(id);
   if(!counts(t,r)||t.m.platform&&r.platform&&t.m.platform!==r.platform)continue;
   const parts=Object.fromEntries(Object.entries(r.parts||{}).filter(([,p])=>since(t,p)));
   if(!Object.keys(parts).length)continue;
   out.push({id,name:nameOf(id,list),record:{...r,parts}});
  }
  return out;
 }
 // home.runtimes: {device: {source: "agent", observedAt: receivedAt, runtimes}} for the devices with a runtimes part.
 async function runtimes(){
  const at=now(),out={};
  for(const {id,record} of await readers({parts:['runtimes']})){const p=record.parts.runtimes;if(!Array.isArray(p?.data?.runtimes))continue;
   const fresh=freshUntil(p)>at;
   out[id]={source:'agent',observedAt:p.receivedAt,runtimes:p.data.runtimes.map(r=>fresh?r:noNews(r))};}
  return out;
 }
 // The SPECS digest of a device's stored packages part (its last SPECS line), worked out once per stored part: the
 // cache is keyed by the part's receivedAt and digest, so GET /api/home copies no records to find it.
 const specsCache=new Map();
 const agentSpecs=(device,head)=>{
  const key=`${head.receivedAt}|${head.digest}`,hit=specsCache.get(device);if(hit?.key===key)return hit.specs;
  const records=reports.slice(device,['packages'])?.parts?.packages?.records;
  const line=Array.isArray(records)?records.findLast(l=>typeof l==='string'&&l.startsWith('SPECS\t')):null;
  const specs=line&&/^[a-f0-9]{64}$/.test(line.split('\t')[1]||'')?line.split('\t')[1]:null;
  specsCache.set(device,{key,specs});return specs;
 };
 // The SHA-256 of the hub's specs.txt for a device (what node scripts/agent-specs.mjs prints), or null when the watch
 // list cannot be read or is invalid (the script refuses then too, so the page must not ask for a new specs.txt). The
 // list is read again only when its file changed (inode, size, mtime); a missing file is the empty list.
 let hubWatch={stamp:undefined,registry:null,hashes:new Map()};
 async function hubSpecs(id){
  const file=hub.state('security')?.watch?.file??watchPath();
  let stamp='none';
  if(file){try{const s=await stat(file);stamp=`${s.ino}:${s.size}:${s.mtimeMs}`;}catch(e){if(e.code!=='ENOENT')return null;}}
  if(stamp!==hubWatch.stamp){const registry=await watchRegistry();hubWatch={stamp,registry,hashes:new Map()};}
  if(!hubWatch.registry)return null;
  if(!hubWatch.hashes.has(id))hubWatch.hashes.set(id,createHash('sha256').update(specsFileText(hubWatch.registry,id)).digest('hex'));
  return hubWatch.hashes.get(id);
 }
 // What the overview says of each device that holds a key that is not revoked and is bound to the device as it is now
 // (and that would still be given one): {<id>: {name, lastReportAt, agentVersion, platform, parts: {<part>: {receivedAt,
 // interval}}, specs, hubSpecs}}, read by server/home-data.mjs → agentFor. The record counts as the readers' does
 // (trust above): one whose last report came with a key revoked since, or that arrived before the device's earliest
 // such key was issued, is no report at all (lastReportAt null), and so a re-issued key starts at never. Of a record
 // that counts, the parts are those received since that key (none of another platform than the device now says).
 // specs: the agent's SPECS digest (the last SPECS line of its packages part), hubSpecs: the SHA-256 of the hub's
 // specs.txt for the device, read only when an agent sent one. Shown whether the integration is on or off: the keys
 // are there either way.
 async function overview(){
  const list=await addedDevices().catch(()=>[]),out={};
  let live;try{live=keys.active();}catch{return out;}
  for(const k of live){
   if(Object.hasOwn(out,k.device))continue;
   const t=trust(k.device,{list,live});if(!t)continue;
   const name=nameOf(k.device,list),r=reports.heads(k.device);
   if(!counts(t,r)){out[k.device]={name,lastReportAt:null,agentVersion:null,platform:null,parts:{},specs:null,hubSpecs:null};continue;}
   const kept=t.m.platform&&r.platform&&t.m.platform!==r.platform?[]:Object.entries(r.parts||{}).filter(([,p])=>since(t,p));
   const parts=Object.fromEntries(kept.map(([n,p])=>[n,{receivedAt:p.receivedAt,interval:p.interval}]));
   const specs=parts.packages?agentSpecs(k.device,r.parts.packages):null;
   out[k.device]={name,lastReportAt:r.lastSeenAt,agentVersion:r.agentVersion??null,platform:r.platform??null,parts,specs,hubSpecs:specs?await hubSpecs(k.device):null};
  }
  return out;
 }
 // The trend: one line {at, devices:{<id>: {os, software, apps, warn, crit, stale}}} per device at most every six
 // hours, the shape of the collector's history.jsonl, capped at 3000 lines.
 const historyFile=path.join(hub.stateDirectory,'agent','history.jsonl'),historyAt=new Map();let historyRead=null;
 // A file 1.x wrote is written forward at start, once (server/state-forward.mjs), before anything reads or adds a line.
 const historyForwarded=forwardJsonl(historyFile,forwardTrendLine).catch(()=>0);
 const readHistory=()=>historyRead??=historyForwarded.then(()=>readFile(historyFile,'utf8')).then(text=>{for(const line of text.split('\n'))try{const x=forwardTrendLine(JSON.parse(line)),t=Date.parse(x.at);
  for(const id of Object.keys(x.devices||{}))if(Number.isFinite(t)&&!(historyAt.get(id)>t))historyAt.set(id,t);}catch{}}).catch(()=>{});
 let historyQueue=Promise.resolve();
 function noteHistory(device,at){
  const op=historyQueue.then(async()=>{
   await readHistory();
   if(historyAt.has(device)&&at-historyAt.get(device)<HISTORY_EVERY_MS)return;
   const entry=(await readers({parts:['os','updates','packages']})).find(e=>e.id===device);if(!entry?.record.parts.os)return;
   const security=hub.state('security'),dir=systemsDirectory(hub.directory);
   const [watch,upstream]=await Promise.all([readWatch({file:security?.watch?.file??watchPath()}).catch(()=>null),readFile(path.join(dir,'upstream.json'),'utf8').then(JSON.parse).catch(()=>null)]);
   const m=buildSystems({snapshot:null,upstream,registry:watch?.registry,devices:[],agents:[entry],now:at}).devices.find(x=>x.id===device);
   if(!m?.summary)return;
   const line=JSON.stringify({at:new Date(at).toISOString(),devices:{[device]:historyEntry(m)}})+'\n';
   await mkdir(path.dirname(historyFile),{recursive:true,mode:0o700});
   const lines=(await readFile(historyFile,'utf8').catch(()=>'')).split('\n').filter(Boolean);
   if(lines.length>=HISTORY_LINES){await writeFile(historyFile+'.tmp',lines.slice(-(HISTORY_LINES-1)).join('\n')+'\n'+line,{mode:0o600});await rename(historyFile+'.tmp',historyFile);}
   else await appendFile(historyFile,line,{mode:0o600});
   // Only once the line is written: a failed write is tried again with the next os part, not six hours later.
   historyAt.set(device,at);
  });
  historyQueue=op.catch(()=>{});return op;
 }

 // devices.json is looked at every 30 s; when it changed, the keys are checked against it.
 const devicesFile=path.join(hub.stateDirectory,'home','devices.json');
 let timer=null,seenStamp=null;
 const tick=async()=>{const s=await stat(devicesFile).catch(()=>null),stamp=s?`${s.mtimeMs}:${s.size}`:'none';if(stamp!==seenStamp){seenStamp=stamp;await sweep();}};
 return {reports,admin,sweep,receive,readers,runtimes,overview,clock:now,
  // What one device's agent reported (record), and how it stands at `at` (status): each part fresh until receivedAt
  // + 3 × interval, then "no news" (never off); the device's clock against the hub's, flagged beyond five minutes.
  // For the tests now and the readers to come.
  record:device=>reports.get(device),
  status:(device,at=now())=>{const r=reports.get(device);if(!r)return null;
   const skew=r.lastSentAt&&r.lastSeenAt?Math.round((Date.parse(r.lastSentAt)-Date.parse(r.lastSeenAt))/1000):null;
   return {lastReportAt:r.lastSeenAt,clockSkewSeconds:skew,skewed:skew!==null&&Math.abs(skew)>REPORT_LIMITS.skewSeconds,
    parts:Object.fromEntries(Object.entries(r.parts).map(([n,p])=>[n,freshUntil(p)>at?'fresh':'no-news']))};},
  start:async()=>{await tick().catch(e=>console.error(`agent: key check failed: ${e.message}`));timer=setInterval(()=>{tick().catch(()=>{});},SWEEP_EVERY_MS);timer.unref?.();},
  stop:async()=>{if(timer)clearInterval(timer);timer=null;await reports.flush();}};
}

// --- integration "agent.reports": the push agents, one item per device that holds a key -------------------------------
// A device's item: fresh → ok, no news → stale (never off: a quiet agent says nothing about the device), a key that has
// not reported yet → not-configured. No test: the hub does not reach out to an agent, it only takes what one sends.
const AGENT_ITEM={fresh:'ok','no-news':'stale',never:'not-configured'};
async function agentStatus(state,hub){
 const devices=await state.overview(),ids=Object.keys(devices).sort(),at=state.clock();
 const configuredBy=[{source:'ui',name:'Uživatelé a API → Push agenti'}];
 if(!ids.length)return {state:'not-configured',summary:'Žádné zařízení zatím nemá klíč agenta.',configuredBy,items:[]};
 const items=ids.map(id=>{const a=agentFor(devices[id],{now:at,hubVersion:hub.version?.version??null});
  return {id,label:devices[id].name||id,state:AGENT_ITEM[a.freshness],lastSuccessAt:a.lastReportAt,
   summary:a.freshness==='never'?'Klíč je vydaný, agent se zatím neozval.':a.freshness==='no-news'?tx('Žádné zprávy. Agent {version} se odmlčel.',{version:a.agentVersion||'?'})
    :a.behind?tx('Hlásí se. Agent {version} je starší než hub.',{version:a.agentVersion||'?'}):tx('Hlásí se. Agent {version}.',{version:a.agentVersion||'?'})};});
 const fresh=items.filter(i=>i.state==='ok').length;
 return {state:worstState(items.map(i=>i.state)),summary:tx('Čerstvé zprávy od {fresh} z {total} agentů.',{fresh,total:ids.length}),
  lastSuccessAt:items.map(i=>i.lastSuccessAt).filter(Boolean).sort().at(-1)||null,configuredBy,items};
}
const agentIntegration={id:AGENT_INTEGRATION,title:'Push agenti',kind:'agent',
 description:'Co zařízení sama posílají: systém a aktualizace, sledovaný software, SSH klíče a lokální LLM runtimy, každý svým klíčem agenta. Vypnutá: hub hlášení odmítá (409, nic neuloží) a stránky čtou jen kolektory; klíče a uložená hlášení zůstanou.',
 howTo:'Vydej zařízení klíč v Uživatelé a API → Push agenti a na zařízení spusť instalátor: node scripts/install-host-agent.mjs --core --hub <adresa hubu> --key-file <soubor s klíčem>.',
 page:'access/agents',docs:'docs/agent.md; docs/API.md → Push agent',
 provides:['home.runtimes'],
 devices:async state=>Object.keys(await state.overview()).map(id=>({device:id,item:id})),
 status:(state,hub)=>agentStatus(state,hub)};

export default {
 id:AGENT_MODULE,title:'Push agent',
 setup:setupAgent,
 integrations:[agentIntegration],
 // The only route of this module. scope:null and write:false: the pipeline's gate is the check (docs/agent.md §2).
 routes:[{method:'POST',path:'/api/agent/report',scope:null,write:false,bodyLimit:REPORT_LIMITS.body,handler:c=>c.state.receive(c)}],
 pollers:[{id:'agent-keys',start:state=>state.start(),stop:state=>state.stop()}],
 // Local LLM runtimes as the agents report them (docs/agent.md §3 → Runtimes); home merges them with the other providers.
 provides:{'home.runtimes':state=>state.runtimes()},
};
