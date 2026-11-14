// The push agent's local configuration (docs/agent.md §4 and §5): <config>/agent.json, written by the installer on
// this machine and never by the hub. Read and checked at every start; a file that does not pass stops the agent.
//
//   {"schema": 1, "hub": "https://hub.example.lan", "trust": {"pins": [a, b]} | {"ca": "/abs/hub-ca.pem"} | absent,
//    "intervals": {<part>: seconds}, "keys": "own|all-accounts|off", "runtimes": [{"id", "kind", "url"}]}
//
// Transport trust fails closed: no "trust" is Node's store with hostname verification; "ca" a PEM file that replaces
// it; "pins" one or two SHA-256 fingerprints of the hub's leaf certificate. http:// only to the literal 127.0.0.1.
// No machine: the hub takes it from the key.
import path from 'node:path';
import {PARTS,AGENT_PLATFORMS,loopbackOrigin} from '../../server/agent-report.mjs';
import {validEndpointHost,CERT_PIN} from '../../server/endpoint-http.mjs';
import {RUNTIME_KINDS} from '../../server/runtime-kinds.mjs';

export const CONFIG_SCHEMA=1;
export const KEY_MODES=Object.freeze(['own','all-accounts','off']);
// What each platform does without a "keys" setting (docs/agent.md, open question 2).
export const DEFAULT_KEYS=Object.freeze({macos:'own',linux:'off'});
const RUNTIME_ID=/^[a-z][a-z0-9-]{0,39}$/;
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);

/** The hub's origin → {host, port, secure, origin}, or null when it is not one the agent may talk to. */
export function parseHub(value){
 if(typeof value!=='string'||value.length>300)return null;
 let u;try{u=new URL(value);}catch{return null;}
 if(u.username||u.password||u.search||u.hash||/[?#@]/.test(value)||(u.pathname!=='/'&&u.pathname!==''))return null;
 if(value.replace(/\/$/,'')!==u.origin)return null;
 const secure=u.protocol==='https:';
 if(!secure&&u.protocol!=='http:')return null;
 // validEndpointHost takes no IPv6 literal, so [::1] fails here too.
 if(!validEndpointHost(u.hostname))return null;
 // Plain HTTP only to the hub's own machine, by the literal address: never a name (localhost), never ::1.
 if(!secure&&u.hostname!=='127.0.0.1')return null;
 return {host:u.hostname,port:Number(u.port||(secure?443:80)),secure,origin:u.origin};
}

/**
 * The text of agent.json → {ok:true, config} or {ok:false, error}. platform: "macos" or "linux". The CA file is
 * named here and read by the caller (readCa), so this stays a pure function.
 */
export function parseConfig(text,{platform}){
 const no=error=>({ok:false,error});
 if(!AGENT_PLATFORMS.includes(platform)||platform==='windows')return no(`no Node agent on ${platform}`);
 let raw;try{raw=JSON.parse(text);}catch{return no('agent.json is not JSON');}
 if(!plain(raw))return no('agent.json must be an object');
 const extra=Object.keys(raw).filter(k=>!['schema','hub','trust','intervals','keys','runtimes','$comment'].includes(k));
 if(extra.length)return no(`agent.json has unknown field(s): ${extra.join(', ')}`);
 if(raw.schema!==CONFIG_SCHEMA)return no(`agent.json → schema must be ${CONFIG_SCHEMA}`);
 const hub=parseHub(raw.hub);
 if(!hub)return no('agent.json → hub must be an origin: https://<name or IPv4>[:port], or http://127.0.0.1[:port] on the hub\'s own machine');
 let trust={mode:'system'};
 if(raw.trust!==undefined){
  if(!plain(raw.trust)||Object.keys(raw.trust).length!==1)return no('agent.json → trust is {"pins": [...]} or {"ca": "/abs/file.pem"}');
  if('pins' in raw.trust){
   const pins=raw.trust.pins;
   if(!Array.isArray(pins)||pins.length<1||pins.length>2||!pins.every(p=>typeof p==='string'&&CERT_PIN.test(p))||new Set(pins).size!==pins.length)
    return no('agent.json → trust.pins is one or two SHA-256 fingerprints (64 lowercase hex)');
   trust={mode:'pin',pins:[...pins]};
  }else if('ca' in raw.trust){
   const ca=raw.trust.ca;
   if(typeof ca!=='string'||!ca.startsWith('/')||ca.length>300||/[\u0000-\u001f]/.test(ca))return no('agent.json → trust.ca must be an absolute path');
   trust={mode:'ca',caFile:ca};
  }else return no('agent.json → trust is {"pins": [...]} or {"ca": "/abs/file.pem"}');
  if(!hub.secure)return no('agent.json → trust is for https:// only');
 }
 const intervals={};
 for(const [name,spec] of Object.entries(PARTS))intervals[name]=spec.interval.default;
 if(raw.intervals!==undefined){
  if(!plain(raw.intervals))return no('agent.json → intervals must be an object of seconds');
  for(const [name,v] of Object.entries(raw.intervals)){
   if(!Object.hasOwn(PARTS,name))return no(`agent.json → intervals names an unknown part (${String(name).slice(0,32)})`);
   const r=PARTS[name].interval;
   if(!Number.isSafeInteger(v)||v<r.min||v>r.max)return no(`agent.json → intervals.${name} must be ${r.min}–${r.max} seconds`);
   intervals[name]=v;
  }
  // os, updates and packages are one run of the systems probe: one interval.
  if(raw.intervals.updates!==undefined&&raw.intervals.updates!==intervals.os||raw.intervals.packages!==undefined&&raw.intervals.packages!==intervals.os)
   return no('agent.json → intervals: os, updates and packages are one run of the probe; give os only');
  intervals.updates=intervals.packages=intervals.os;
 }
 const keys=raw.keys??DEFAULT_KEYS[platform];
 if(!KEY_MODES.includes(keys))return no('agent.json → keys is own, all-accounts or off');
 // On Linux the agent's own account is a system account without keys of its own.
 if(platform==='linux'&&keys==='own')return no('agent.json → keys "own" means nothing for the Linux agent\'s system account: use off or all-accounts');
 const runtimes=[];
 if(raw.runtimes!==undefined){
  if(!Array.isArray(raw.runtimes)||raw.runtimes.length>20)return no('agent.json → runtimes is a list of at most 20');
  for(const r of raw.runtimes){
   if(!plain(r)||Object.keys(r).some(k=>!['id','kind','url'].includes(k)))return no('agent.json → a runtime is {"id", "kind", "url"}');
   if(typeof r.id!=='string'||!RUNTIME_ID.test(r.id))return no('agent.json → a runtime id is lowercase letters, digits and dashes');
   if(!RUNTIME_KINDS.includes(r.kind??'auto'))return no(`agent.json → runtime ${r.id}: kind must be one of ${RUNTIME_KINDS.join(', ')}`);
   if(typeof r.url!=='string'||!loopbackOrigin(r.url))return no(`agent.json → runtime ${r.id}: url must be an origin on loopback (http://127.0.0.1:<port>)`);
   if(runtimes.some(x=>x.id===r.id))return no(`agent.json → runtime ${r.id} is listed twice`);
   runtimes.push({id:r.id,kind:r.kind??'auto',url:new URL(r.url).origin});
  }
 }
 return {ok:true,config:{schema:CONFIG_SCHEMA,hub,trust,intervals,keys,runtimes}};
}

/** The trust endpoint-http takes, from a parsed config and the CA file's text (when trust is a CA). */
export function transportTrust(config,caText=null){
 if(!config.hub.secure)return null;
 if(config.trust.mode==='pin')return {mode:'pin',pins:config.trust.pins};
 if(config.trust.mode==='ca'){
  if(typeof caText!=='string'||!/-----BEGIN CERTIFICATE-----/.test(caText))throw new Error('ca-invalid');
  return {mode:'ca',ca:caText};
 }
 return {mode:'system'};
}

/** A token as the installer writes it to the key file: the token alone, a newline allowed. → the token or null. */
export const parseToken=text=>{const t=typeof text==='string'?text.trim():'';return /^hha_[0-9a-f]{64}$/.test(t)?t:null;};

// Directories any local account can write into: a watched binary there would be whatever someone dropped in.
export const SHARED_WRITABLE=Object.freeze(['/tmp','/private/tmp','/var/tmp','/private/var/tmp','/dev/shm','/Users/Shared']);
/**
 * What the agent asks of a watch list beyond validateSpecs (server/agent-report.mjs, frozen), run after it at every
 * start, by the installer and by scripts/agent-specs.mjs. → [{line, reason}], empty when the list passes.
 *   - a cmd or pydist path with a glob (*) holds no space: the probes expand a glob into candidates, and a space must
 *     never split a pattern into a second, relative one;
 *   - a cmd path is not in a directory every account can write (/tmp, /var/tmp, /Users/Shared …): the agent would run
 *     whatever another account put there;
 *   - a cmd glob cannot reach one either: the directory before its first star must not hold a shared-writable
 *     directory (a star right under /, /Users or /private/var could expand into one). A star below every such
 *     directory (under /opt/homebrew/Cellar, or a home-relative path) passes.
 * validateSpecs allows * as the only glob character and no .. segment, so the text is the path the probes expand.
 */
export function specsPathErrors(text){
 const errors=[];
 if(typeof text!=='string'||text==='')return errors;
 const shared=SHARED_WRITABLE.map(d=>d.toLowerCase());
 const within=(p,d)=>p===d||p.startsWith(d==='/'?'/':`${d}/`);
 text.replace(/\n$/,'').split('\n').forEach((line,i)=>{
  const [,kind,a]=line.split('|');
  if(kind!=='cmd'&&kind!=='pydist'||typeof a!=='string')return;
  if(a.includes('*')&&a.includes(' '))return void errors.push({line:i+1,reason:'a glob path may not hold a space'});
  // Lower case: macOS file systems usually ignore case, so /TMP is /tmp there.
  const abs=a.startsWith('/')?path.posix.normalize(a).toLowerCase():null;
  if(kind!=='cmd'||!abs)return;
  if(shared.some(d=>within(abs,d)))return void errors.push({line:i+1,reason:'a cmd path in a directory every account can write'});
  const star=abs.indexOf('*');
  if(star<0)return;
  const fixed=abs.slice(0,abs.lastIndexOf('/',star))||'/';
  if(shared.some(d=>within(d,fixed)))errors.push({line:i+1,reason:'a cmd glob that can expand into a directory every account can write'});
 });
 return errors;
}
