// The push agent's credential and what agents report (docs/agent.md §1–§3).
//
// <state>/agents.json, 0600, its own file (access.json is never touched), schemaVersion 1:
//   {schemaVersion: 1, agents: [{id, machine, machineCreatedAt, name, prefix, hash, createdAt, createdBy, revokedAt, revokedBy}]}
//   hash = SHA-256 of the token (hha_ + 64 lowercase hex), prefix = its first 12 characters. A key is bound to one
//   machine of the overview's namespace and to that machine's createdAt (an added device's; null for a machine of
//   the site configuration), and works only while that machine exists with that stamp. Last seen is never written
//   here: a report never rewrites the credential file.
// <state>/agent/<machine>.json, 0600 in a 0700 directory, schemaVersion 1 (AGENT_REPORTS_SCHEMA): the latest copy of
//   each part one machine's agent reported: {schemaVersion, machine, agentId, agentVersion, platform, lastSeenAt,
//   lastSentAt, parts: {<part>: {schema, collectedAt, receivedAt, interval, digest, withheld, records | data}}}.
//   lastSentAt is the machine's clock (the envelope's sentAt), kept to show clock skew; every other time is the hub's.
// <state>/agent-audit.jsonl: a line only on a change (a refusal, at most one per key and code per ten minutes; a
//   key's first report; a report after no news; a changed agentVersion or platform, each of these three at most
//   once per key and event per ten minutes). Never a body or a token.
// Issuing and revoking a key go to access-audit.jsonl, beside the other credentials.
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {mkdir,writeFile,rename,appendFile} from 'node:fs/promises';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {digestOf,freshUntil} from './agent-report.mjs';

export const AGENTS_SCHEMA=1;
export const AGENT_REPORTS_SCHEMA=1;
export const AGENT_LIMITS=Object.freeze({active:100,perMachine:2});
export const AGENT_TOKEN=/^hha_[a-f0-9]{64}$/;
// The agent key from an Authorization header, or null. Neither bearerOf (hh_) nor apiBearerOf (hhk_) matches it.
export const agentBearerOf=header=>typeof header==='string'&&/^Bearer hha_[a-f0-9]{64}$/.test(header)?header.slice(7):null;
const MACHINE_ID=/^[a-z][a-z0-9_-]{1,31}$/,AGENT_ID=/^[a-f0-9]{16}$/;
const sha=s=>createHash('sha256').update(s).digest('hex');
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const fail=code=>{throw new Error(code);};
const nameOk=s=>typeof s==='string'&&s.trim().length>0&&s.length<=80&&!/[\u0000-\u001f\u007f]/.test(s);

// --- the machine a key is for ---------------------------------------------------------------------------------------
// One id of the overview's machine namespace, as a key sees it: {id, createdAt, site, role, platform, probe}.
// siteMachines = site.json → machines; devices = the added devices (server/home-devices.mjs → list()).
export function findMachine(id,{siteMachines=[],devices=[]}={}){
 if(typeof id!=='string'||!MACHINE_ID.test(id))return null;
 const s=siteMachines.find(m=>m?.id===id);
 if(s)return {id,createdAt:null,site:true,role:s.role??null,platform:s.platform??null,probe:s.ssh?.probe??null};
 const d=devices.find(x=>x?.id===id);
 if(d)return {id,createdAt:typeof d.createdAt==='string'?d.createdAt:null,site:false,role:d.role??null,platform:d.platform??null,probe:null};
 return null;
}
// Why no key may be issued for this machine, or null: it names nothing, it is the router, the NAS (agent-less,
// so a machine never has two reader kinds), or its platform is "other" (no report platform could ever match it).
// A key whose machine comes to one of these later is revoked by the hub (server/core/agent.mjs).
export const machineRefusal=m=>!m?'unknown':m.role==='router'?'router':m.probe==='nas'?'nas':m.platform==='other'?'other':null;
// Does the machine still exist with the stamp the key was bound to?
export const boundTo=(key,m)=>Boolean(m)&&m.id===key.machine&&(m.createdAt??null)===(key.machineCreatedAt??null);

// --- the credential store ---------------------------------------------------------------------------------------------
function loadAgents(file){
 let doc;try{doc=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {schemaVersion:AGENTS_SCHEMA,agents:[]};throw e;}
 // Older code refuses newer state; it never "tries anyway".
 if(!plain(doc)||doc.schemaVersion!==AGENTS_SCHEMA||!Array.isArray(doc.agents))throw new Error('Invalid agent key store (agents.json)');
 return doc;
}
const view=a=>({id:a.id,machine:a.machine,name:a.name,prefix:a.prefix,createdAt:a.createdAt,createdBy:a.createdBy??null,revokedAt:a.revokedAt??null,revokedBy:a.revokedBy??null});
const usable=a=>plain(a)&&AGENT_ID.test(a.id)&&/^[a-f0-9]{64}$/.test(a.hash)&&MACHINE_ID.test(a.machine)&&!a.revokedAt;

export function createAgentStore(directory,{now=Date.now}={}){
 const file=path.join(directory,'agents.json'),auditFile=path.join(directory,'access-audit.jsonl');
 // The file is read again whenever it changed on disk (another inode, size or mtime): a revoke by the CLI takes
 // effect in a running hub at once, and the hub's next write starts from it instead of undoing it.
 const stampOf=()=>{try{const s=statSync(file);return `${s.ino}:${s.size}:${s.mtimeMs}`;}catch(e){if(e.code==='ENOENT')return 'none';throw e;}};
 let state=loadAgents(file),loadedStamp=stampOf(),queue=Promise.resolve();
 const current=()=>{const s=stampOf();if(s!==loadedStamp){state=loadAgents(file);loadedStamp=s;}return state;};
 const stamp=()=>new Date(now()).toISOString();
 // One line in the access audit, as the access store writes them: ids and names, never a token or its hash.
 const audit=(event,a,{by,detail}={})=>appendFile(auditFile,JSON.stringify({at:stamp(),event,id:a.id,name:String(a.name).slice(0,80),...(by?{by:String(by).slice(0,80)}:{}),...(detail?{detail:String(detail).slice(0,120)}:{})})+'\n',{mode:0o600});
 // One change at a time: copy, change, write to a temp file, rename.
 const transact=change=>{const op=queue.then(async()=>{const draft=structuredClone(current()),result=change(draft);
   await mkdir(directory,{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify(draft),{mode:0o600});await rename(file+'.tmp',file);state=draft;loadedStamp=stampOf();return result;});
  queue=op.catch(()=>{});return op;};
 const api={
  list:()=>current().agents.filter(a=>plain(a)).map(view),
  get:id=>{const a=current().agents.find(x=>x?.id===id);return a?view(a):null;},
  // Keys that are not revoked, with what they are bound to.
  active:()=>current().agents.filter(usable).map(a=>({...view(a),machineCreatedAt:a.machineCreatedAt??null})),
  // The principal behind a token, or null (unknown, malformed or revoked). It holds no scope at all. A file that
  // cannot be read any more (a newer schema) verifies nothing: it fails closed.
  verify(token){
   if(typeof token!=='string'||!AGENT_TOKEN.test(token))return null;const digest=Buffer.from(sha(token),'hex');
   let agents;try{agents=current().agents;}catch{return null;}
   const a=agents.find(x=>usable(x)&&timingSafeEqual(Buffer.from(x.hash,'hex'),digest));if(!a)return null;
   return {id:a.id,username:a.name,keyName:a.name,role:'agent',permission:'none',authKind:'agent',scopes:[],machine:a.machine,machineCreatedAt:a.machineCreatedAt??null};
  },
  // machine: what findMachine returned (the caller has checked machineRefusal). → {token, agent}; the token only here.
  async issue(machine,{name,by}={}){
   if(!plain(machine)||!MACHINE_ID.test(machine.id)||name!==undefined&&!nameOk(name))fail('invalid');
   return transact(d=>{const live=d.agents.filter(usable);
    if(live.length>=AGENT_LIMITS.active||live.filter(a=>a.machine===machine.id).length>=AGENT_LIMITS.perMachine)fail('limit');
    const token='hha_'+randomBytes(32).toString('hex'),created=stamp();
    const a={id:randomBytes(8).toString('hex'),machine:machine.id,machineCreatedAt:machine.createdAt??null,name:(name||`${machine.id} · ${created.slice(0,10)}`).trim(),
     prefix:token.slice(0,12),hash:sha(token),createdAt:created,createdBy:by?String(by).slice(0,80):null,revokedAt:null,revokedBy:null};
    d.agents.push(a);return {token,agent:view(a),stored:a};})
    .then(async r=>{await audit('agent-key-created',r.stored,{by,detail:`machine ${machine.id}`});return {token:r.token,agent:r.agent};});
  },
  // by: who (an administrator's name, "local administration", or "machine-removed" when the hub revokes it itself).
  async revoke(id,{by}={}){
   if(typeof id!=='string')fail('invalid');
   return transact(d=>{const a=d.agents.find(x=>x?.id===id);if(!a)fail('not-found');const fresh=!a.revokedAt;
    if(fresh){a.revokedAt=stamp();a.revokedBy=by?String(by).slice(0,80):null;}return {agent:view(a),stored:a,fresh};})
    .then(async r=>{if(r.fresh)await audit('agent-key-revoked',r.stored,{by,detail:`machine ${r.stored.machine}`});return {agent:r.agent};});
  },
 };
 return api;
}

// --- what agents report ------------------------------------------------------------------------------------------------
const FLUSH_MS=60_000;
const emptyRecord=machine=>({schemaVersion:AGENT_REPORTS_SCHEMA,machine,agentId:null,agentVersion:null,platform:null,lastSeenAt:null,lastSentAt:null,parts:{}});
// Fresh while any stored part is fresh; "no news" once every one is past receivedAt + 3 × interval.
export const machineFresh=(record,at)=>Boolean(record)&&Object.values(record.parts||{}).some(p=>freshUntil(p)>at);

export function createReportStore(directory,{now=Date.now,log=console}={}){
 const dir=path.join(directory,'agent');
 const records=new Map(),flushedAt=new Map(),dirty=new Set(),newer=new Set();
 // What is on disk is loaded once. A file written by a newer hub is left as it is and never overwritten here.
 let names=[];try{names=readdirSync(dir).filter(f=>f.endsWith('.json')&&MACHINE_ID.test(f.slice(0,-5)));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const f of names){const machine=f.slice(0,-5);
  try{const doc=JSON.parse(readFileSync(path.join(dir,f),'utf8'));
   if(!plain(doc)||doc.schemaVersion!==AGENT_REPORTS_SCHEMA){newer.add(machine);log.warn?.(`agent: ${f} has another schema; reports for ${machine} are refused until it is moved`);continue;}
   if(doc.machine===machine&&plain(doc.parts))records.set(machine,doc);}catch{log.warn?.(`agent: ${f} cannot be read; it is replaced by the next report`);}}
 let queue=Promise.resolve();
 const write=machine=>{const op=queue.then(async()=>{const doc=records.get(machine);if(!doc)return;dirty.delete(machine);flushedAt.set(machine,now());
   await mkdir(dir,{recursive:true,mode:0o700});const file=path.join(dir,`${machine}.json`);
   await writeFile(file+'.tmp',JSON.stringify(doc),{mode:0o600});await rename(file+'.tmp',file);});
  queue=op.catch(e=>{log.error?.(`agent: cannot write the report of ${machine}: ${e.message}`);});return op;};
 return {
  get:machine=>records.has(machine)?structuredClone(records.get(machine)):null,
  machines:()=>[...records.keys()],
  // One machine's record with only the named parts, each a copy: what a reader needs, without copying the rest.
  slice:(machine,names)=>{const r=records.get(machine);if(!r)return null;const {parts,...rest}=r;
   return {...structuredClone(rest),parts:Object.fromEntries(names.filter(n=>Object.hasOwn(parts,n)).map(n=>[n,structuredClone(parts[n])]))};},
  // One machine's record without its payloads: the envelope fields and, per part, only its times and digest (what the
  // overview needs to say how fresh an agent is, on every GET /api/home, without copying the records).
  heads:machine=>{const r=records.get(machine);if(!r)return null;const {parts,...rest}=r;
   return {...structuredClone(rest),parts:Object.fromEntries(Object.entries(parts||{}).map(([n,p])=>[n,{receivedAt:p.receivedAt,interval:p.interval,digest:p.digest??null}]))};},
  // A machine whose file a newer hub wrote: its reports are refused rather than overwrite it.
  locked:machine=>newer.has(machine),
  // The parts of a report that were taken, at the hub's receive time. A changed digest (or a new part, agent, version
  // or platform) is written at once; a report that changes only times is written at most once a minute.
  // → {before, after} records (before null for a machine that never reported).
  async accept(machine,{agentId,report,parts,receivedAt}){
   if(newer.has(machine))fail('newer-state');
   const before=records.has(machine)?structuredClone(records.get(machine)):null,doc=before?structuredClone(before):emptyRecord(machine);
   let changed=!before||doc.agentId!==agentId||doc.agentVersion!==report.agentVersion||doc.platform!==report.platform;
   for(const [name,part] of Object.entries(parts)){
    const prev=doc.parts[name],digest=digestOf(part),withheld=part.withheld||[];
    if(!prev||prev.digest!==digest||prev.schema!==part.schema||prev.interval!==part.interval||JSON.stringify(prev.withheld)!==JSON.stringify(withheld))changed=true;
    doc.parts[name]={schema:part.schema,collectedAt:part.collectedAt??null,receivedAt,interval:part.interval,digest,withheld,
     ...(part.records?{records:part.records}:{}),...(part.data?{data:part.data}:{})};
   }
   Object.assign(doc,{agentId,agentVersion:report.agentVersion,platform:report.platform,lastSeenAt:receivedAt,lastSentAt:report.sentAt});
   records.set(machine,doc);
   if(changed||now()-(flushedAt.get(machine)??0)>=FLUSH_MS)await write(machine);else dirty.add(machine);
   return {before,after:structuredClone(doc)};
  },
  // Everything not written yet (at stop).
  flush:()=>Promise.all([...dirty].map(write)),
 };
}

// --- the agent audit -----------------------------------------------------------------------------------------------------
const REFUSAL_EVERY_MS=10*60_000;
export function createAgentAudit(directory,{now=Date.now}={}){
 const file=path.join(directory,'agent-audit.jsonl'),last=new Map();
 const line=entry=>mkdir(directory,{recursive:true,mode:0o700}).then(()=>appendFile(file,JSON.stringify({at:new Date(now()).toISOString(),...entry})+'\n',{mode:0o600}));
 // At most one line per key and k per ten minutes: a key alone can never write more than a few lines an hour.
 const due=k=>{const t=now();if(last.has(k)&&t-last.get(k)<REFUSAL_EVERY_MS)return false;last.set(k,t);return true;};
 return {
  // event: agent-first-report (once per key, by the caller) | agent-report-after-no-news | agent-version-changed |
  // agent-platform-changed (each at most once per key and event per ten minutes).
  record(event,{agent,machine,detail}){
   if(event!=='agent-first-report'&&!due(`${agent}|event|${event}`))return Promise.resolve(false);
   return line({event,agent,machine,...(detail?{detail:String(detail).slice(0,120)}:{})}).then(()=>true);
  },
  // A refusal: at most one line per key and code per ten minutes. detail names fields and tags, never values.
  refused(code,{agent,machine,detail}){
   if(!due(`${agent}|${code}`))return Promise.resolve(false);
   return line({event:'agent-refused',agent,machine,code,...(detail?{detail:String(detail).slice(0,120)}:{})}).then(()=>true);
  },
 };
}
