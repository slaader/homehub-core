// The push agent's report: the frozen schema (parts, the field table, caps, interval ranges), validateReport and
// validateSpecs. Shared by the hub (POST /api/agent/report, server/core/agent.mjs), the agent before it sends
// (scripts/agent/) and the tests. docs/agent.md §3 is the contract; docs/API.md → Push agents is its public copy.
// A change here is a change to that note first.
//
// A leaf module: it imports only node: modules and other leaves (secret-patterns, ssh-lines, agent-privileged,
// watch-rules, semver), so the agent never drags the hub onto a device.
import {createHash} from 'node:crypto';
import {secretIn,namedSecretIn} from './secret-patterns.mjs';
import {splitAuthorizedLine,splitOutside,fingerprintOf} from './ssh-lines.mjs';
import {privilegedIds} from './agent-privileged.mjs';
import {CMD_ARGS} from './watch-rules.mjs';
import {parse as parseSemver} from './semver.mjs';

export const REPORT_VERSION=1;
export const AGENT_PLATFORMS=Object.freeze(['macos','linux','windows']);
// HOST field 2 of a probe, per envelope platform.
export const HOST_PLATFORM=Object.freeze({macos:'Darwin',linux:'Linux',windows:'Windows'});
export const REPORT_LIMITS=Object.freeze({body:524288,lineBytes:4096,lines:8000,withheld:50,parts:16,floorSeconds:20,skewSeconds:300,staleFactor:3,
 runtimeBytes:65536,runtimes:20,models:30,stats:12});
// The parts: which schemas the hub knows, the interval range in seconds, what the payload is and its cap.
// os, updates and packages come from one run of the systems probe (group "systems").
const SIX_HOURS={default:21600,min:900,max:86400};
export const PARTS=Object.freeze({
 heartbeat:Object.freeze({schemas:[1],interval:Object.freeze({default:60,min:30,max:900}),payload:null}),
 os:Object.freeze({schemas:[1],interval:SIX_HOURS,payload:'records',cap:400,group:'systems'}),
 updates:Object.freeze({schemas:[1],interval:SIX_HOURS,payload:'records',cap:1000,group:'systems'}),
 packages:Object.freeze({schemas:[1],interval:SIX_HOURS,payload:'records',cap:2000,group:'systems'}),
 sshkeys:Object.freeze({schemas:[1],interval:SIX_HOURS,payload:'records',cap:4000}),
 runtimes:Object.freeze({schemas:[1],interval:Object.freeze({default:120,min:30,max:3600}),payload:'data',cap:65536}),
});
export const SYSTEMS_PARTS=Object.freeze(['os','updates','packages']);
// What a part may be refused with, inside a 200 answer.
export const PART_CODES=Object.freeze(['invalid','secret','too-large','unknown-part','unknown-schema','too-soon','platform-mismatch']);

// --- the field table ------------------------------------------------------------------------------------------
// A type: text N (at most N characters, with a secret check: "all" = every pattern of secretIn, "named" = all but
// the two shape patterns, null = none), or a typed value that needs no secret check.
const text=(n,check='all')=>({t:'text',n,check}),named=n=>text(n,'named'),oneOf=(...v)=>({t:'enum',v});
const num={t:'num'},iso={t:'iso'},ipv4={t:'ipv4'},octal={t:'octal'},sha256={t:'sha256'},keygen={t:'keygen'},authline={t:'authline'},priv={t:'priv'},kb={t:'kb'},runState={t:'run'};
const state=oneOf('on','off','unknown');
// A row: fields = the types of the fields after the tag; min (default: all of them) = how many must be there.
// rest = {type, min, max}: every field is of that type (NET, ACCESSGROUP). restAs = the remaining fields joined
// back with tabs are one value of that type (AUTH).
const row=(fields,extra={})=>Object.freeze({fields,min:fields.length,max:fields.length,...extra});
const HOST=row([text(64),oneOf('Darwin','Linux','Windows'),text(64),oneOf('0','1'),iso]);
const END=row([oneOf('ok')]);
export const FIELDS=Object.freeze({
 os:Object.freeze({HOST,
  OS:row([text(40),text(20),text(80),text(60),text(20)]),
  HW:row([text(60),text(80),num,num]),
  UPTIME:row([num]),
  AUTO:row([text(60),text(20)]),
  FW:row([oneOf('global','stealth','blockall','allowsigned'),text(10)]),
  PF:row([text(20),num],{min:1}),
  FV:row([text(120)]),SIP:row([text(120)]),GK:row([text(120)]),
  SSHD:row([text(40),text(120)]),
  SHARE:row([text(60),oneOf('loaded','off')]),
  LISTEN:row([text(60),text(64),text(64)]),
  NFT:row([text(80),num,text(400)],{min:1}),
  PRIV:row([priv,oneOf('ok','denied')]),
  DEFENDER:row([state,num]),
  BITLOCKER:row([text(8),state]),
  WINFW:row([oneOf('domain','private','public'),state]),
  RDP:row([state]),
  ERROR:row([text(200)]),
  END}),
 updates:Object.freeze({
  SWU:row([text(400)]),
  SWU_NONE:row([]),WINUP_NONE:row([]),
  SWU_ERR:row([text(200)]),WINUP_ERR:row([text(200)]),
  BREWOUT:row([text(80),named(80),named(80)]),
  PKGUP:row([oneOf('apt','dnf'),text(120),named(80),named(80),oneOf('0','1')]),
  PKGUP_NONE:row([oneOf('apt','dnf'),num]),
  PKGUP_ERR:row([oneOf('apt','dnf'),text(200)]),
  WINUP:row([kb,text(200),oneOf('Critical','Important','Moderate','Low','Unspecified'),oneOf('0','1')])}),
 packages:Object.freeze({
  SW:row([text(60),oneOf('brew','cask','app','cmd','pydist','json','missing','unsupported'),named(300),text(300),text(120)],{min:4}),
  RUN:row([text(60),runState,text(120)]),
  DOCKER:row([text(80),named(160),text(80),text(40)]),
  SPECS:row([sha256])}),
 sshkeys:Object.freeze({HOST,
  NET:Object.freeze({fields:[],rest:{type:ipv4,min:0,max:32}}),
  LISTEN:row([oneOf('on','off')]),
  ACCESSGROUP:Object.freeze({fields:[],rest:{type:text(64),min:1,max:64}}),
  SSHD:row([text(40),text(400)]),
  USER:row([text(64),num,text(300),text(120),oneOf('0','1')]),
  SUDO:row([named(64),oneOf('rule','none','unknown'),named(600)]),
  AUTH:Object.freeze({fields:[text(64),text(300)],restAs:authline}),
  CFG:row([text(64),text(120),text(200),num,text(64),text(2000),text(200),oneOf('yes','no','')]),
  KEY:row([text(400),octal,text(64),num,text(40),oneOf('yes','no','unknown'),keygen]),
  END}),
});
// Which part of the systems probe a tag belongs to: updates and packages by their own tags, everything else os.
export const systemsPartOf=tag=>Object.hasOwn(FIELDS.updates,tag)?'updates':Object.hasOwn(FIELDS.packages,tag)?'packages':'os';
// One run of the systems probe (its lines) → {os, updates, packages}, each in the order printed.
export function splitSystemsRecords(lines){
 const out={os:[],updates:[],packages:[]};
 for(const line of lines)if(line!=='')out[systemsPartOf(line.split('\t')[0])].push(line);
 return out;
}

// --- one value ---------------------------------------------------------------------------------------------------
const TAG=/^[A-Z][A-Z0-9_]{0,19}$/;
// A control character: C0, DEL and C1. A record line may hold the tab and nothing else of these; a runtimes string none.
const CONTROL=/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/,CONTROL_ALL=/[\u0000-\u001f\u007f-\u009f]/;
// A name taken from the body is echoed (in an answer or the agent audit) only when it looks like a name and not a secret.
const echoable=(name,re)=>typeof name==='string'&&re.test(name)&&!secretIn(name);
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,ISO_MS=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const isoTime=(v,re=ISO)=>typeof v==='string'&&re.test(v)&&Number.isFinite(Date.parse(v));
const ipv4Ok=v=>{const m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);return Boolean(m)&&m.slice(1).every(p=>Number(p)<=255&&String(Number(p))===p);};
const KEYGEN=/^(\d{1,5}) SHA256:([A-Za-z0-9+/]{43}) (.*) \(([A-Z0-9-]{1,20})\)$/;
const BASE64=/^[A-Za-z0-9+/]{16,16384}={0,3}$/;
const OPTION=/^[A-Za-z0-9-]{1,40}(="(?:[^"\\]|\\.)*")?$/;
// → null when the value fits, else 'invalid' or 'secret'. platform: the envelope's (for PRIV).
function checkValue(type,v,platform){
 const secret=(check,s)=>check==='all'?secretIn(s):check==='named'?namedSecretIn(s):null;
 switch(type.t){
  case 'text':return v.length>type.n?'invalid':secret(type.check,v)?'secret':null;
  case 'enum':return type.v.includes(v)?null:'invalid';
  case 'num':return /^\d{0,20}$/.test(v)?null:'invalid';
  case 'iso':return isoTime(v)?null:'invalid';
  case 'ipv4':return ipv4Ok(v)?null:'invalid';
  case 'octal':return /^([0-7]{3,4})?$/.test(v)?null:'invalid';
  case 'sha256':return /^[a-f0-9]{64}$/.test(v)?null:'invalid';
  case 'kb':return /^KB\d{1,10}$/.test(v)?null:'invalid';
  case 'run':return /^(absent|loaded|\d{0,10})$/.test(v)?null:'invalid';
  case 'priv':return privilegedIds(platform).includes(v)?null:'invalid';
  case 'keygen':{if(v==='')return null;const m=KEYGEN.exec(v);if(!m||m[3].length>400)return 'invalid';return namedSecretIn(m[3])?'secret':null;}
  case 'authline':{
   const parts=splitAuthorizedLine(v);
   if(!parts||parts.options.length>1||!BASE64.test(parts.blob)||!fingerprintOf(parts.blob))return 'invalid';
   const options=parts.options.flatMap(t=>splitOutside(t,','));
   if(options.some(o=>!OPTION.test(o)))return 'invalid';
   return namedSecretIn(parts.options.join(' '))||namedSecretIn(parts.comment)?'secret':null;
  }
  default:return 'invalid';
 }
}

/**
 * One record line of a part → null when it fits the field table, else {code: 'invalid'|'secret', tag?, field?}.
 * field counts from 1 after the tag; a tag that is not one of the part's is named only when it looks like a tag.
 * Never the value.
 */
export function checkLine(part,line,platform){
 if(typeof line!=='string')return {code:'invalid'};
 const [tag,...fields]=line.split('\t'),named=echoable(tag,TAG)?{tag}:{};
 if(Buffer.byteLength(line)>REPORT_LIMITS.lineBytes||CONTROL.test(line))return {code:'invalid',...named};
 // Only the part's own tags: never a name the object inherits (constructor, __proto__, toString, …).
 const table=Object.hasOwn(FIELDS,part)?FIELDS[part]:null,spec=TAG.test(tag)&&table&&Object.hasOwn(table,tag)?table[tag]:null;
 if(!spec)return {code:'invalid',...named};
 const fail=(code,field)=>({code,tag,...(field?{field}:{})});
 if(spec.rest){
  if(fields.length<spec.rest.min||fields.length>spec.rest.max)return fail('invalid');
  for(let i=0;i<fields.length;i++){const why=checkValue(spec.rest.type,fields[i],platform);if(why)return fail(why,i+1);}
  return null;
 }
 if(spec.restAs){
  const n=spec.fields.length;if(fields.length<=n)return fail('invalid');
  for(let i=0;i<n;i++){const why=checkValue(spec.fields[i],fields[i],platform);if(why)return fail(why,i+1);}
  const why=checkValue(spec.restAs,fields.slice(n).join('\t'),platform);return why?fail(why,n+1):null;
 }
 if(fields.length<spec.min||fields.length>spec.max)return fail('invalid');
 for(let i=0;i<fields.length;i++){const why=checkValue(spec.fields[i],fields[i],platform);if(why)return fail(why,i+1);}
 return null;
}

// --- runtimes ----------------------------------------------------------------------------------------------------
// One device's entry of the home.runtimes extension point (docs/plugins.md), closed: only the documented fields.
const str=n=>({s:n}),number={n:true},list=(of,max)=>({list:of,max}),obj=keys=>({keys});
const RUNTIME=obj({id:str(60),name:str(60),kind:str(40),status:{enum:['running','stopped','unknown']},url:{url:true},version:str(40),source:str(40),
 mode:{enum:['cli']},activity:obj({active:number,queued:number}),pids:list(number,16),role:{enum:['gateway','engine']},
 memory:obj({usedGb:number,capacityGb:number,basis:{enum:['resident','budget']}}),
 models:list(obj({id:str(120),name:str(120),state:str(16),kind:str(20),sizeGb:number,contextTokens:number,ttlRemainingSeconds:number,active:number,queued:number,since:str(40),
  capabilities:list(str(20),12),engine:str(40),via:str(60),target:str(120),lastRequestAt:str(40),ttlSeconds:number,pids:list(number,16)}),REPORT_LIMITS.models),
 stats:list(obj({label:str(40),value:{sOrN:40}}),REPORT_LIMITS.stats)});
// → null, 'invalid', 'secret' or 'too-large'. runtimeUrl(url) says whether an endpoint address is allowed.
function checkRuntimeValue(schema,v,runtimeUrl){
 if(v===null)return null;
 if(typeof v==='string'&&CONTROL_ALL.test(v))return 'invalid';
 if(schema.s)return typeof v!=='string'?'invalid':v.length>schema.s?'invalid':secretIn(v)?'secret':null;
 if(schema.sOrN)return typeof v==='number'?(Number.isFinite(v)?null:'invalid'):checkRuntimeValue({s:schema.sOrN},v,runtimeUrl);
 if(schema.n)return typeof v==='number'&&Number.isFinite(v)?null:'invalid';
 if(schema.enum)return schema.enum.includes(v)?null:'invalid';
 if(schema.url)return typeof v!=='string'?'invalid':secretIn(v)?'secret':runtimeUrl(v)?null:'invalid';
 if(schema.list){
  if(!Array.isArray(v))return 'invalid';if(v.length>schema.max)return 'too-large';
  for(const item of v){const why=checkRuntimeValue(schema.list,item,runtimeUrl);if(why)return why;}return null;
 }
 if(schema.keys){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!Object.hasOwn(schema.keys,k)))return 'invalid';
  for(const [k,item] of Object.entries(v)){const why=checkRuntimeValue(schema.keys[k],item,runtimeUrl);if(why)return why;}return null;
 }
 return 'invalid';
}
// The agent's own default: an origin on loopback only (docs/agent.md §5 → runtimes.mjs). The hub passes its own
// check (server/site-config.mjs → runtimeEndpoint for the bound device: loopback or inside lanCidrs).
export function loopbackOrigin(url){
 let u;try{u=new URL(url);}catch{return false;}
 return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash&&!/[?#]/.test(url)&&ipv4Ok(u.hostname)&&u.hostname.startsWith('127.')&&`${u.origin}`===url.replace(/\/$/,'');
}
// What is stored for an accepted url: its origin, as runtimeEndpoint returns it (http://0x0a000005/ → http://10.0.0.5).
const originOf=url=>new URL(url).origin;
function checkRuntimes(data,runtimeUrl){
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||!Array.isArray(data.runtimes))return 'invalid';
 if(Buffer.byteLength(JSON.stringify(data))>REPORT_LIMITS.runtimeBytes||data.runtimes.length>REPORT_LIMITS.runtimes)return 'too-large';
 // Every runtime needs an id and a status, as the readers expect.
 for(const r of data.runtimes){const why=checkRuntimeValue(RUNTIME,r,runtimeUrl);if(why)return why;if(typeof r.id!=='string'||!r.id||!r.status)return 'invalid';}
 return null;
}

// --- withheld ------------------------------------------------------------------------------------------------------
const validWithheld=w=>Array.isArray(w)&&w.length<=REPORT_LIMITS.withheld&&w.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===4
 &&typeof x.tag==='string'&&TAG.test(x.tag)&&Number.isSafeInteger(x.field)&&x.field>=0&&x.field<=64&&['secret','long','invalid'].includes(x.reason)&&Number.isSafeInteger(x.count)&&x.count>=1&&x.count<=REPORT_LIMITS.lines);

// --- one part ------------------------------------------------------------------------------------------------------
const PART_NAME=/^[a-z][a-z0-9-]{0,31}$/;
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
// → {part} (normalized: {schema, interval, collectedAt, records|data, withheld}) or {refused: {code, tag?, field?}}.
function checkPart(name,raw,{platform,runtimeUrl}){
 const spec=PARTS[name],no=(code,extra={})=>({refused:{code,...extra}});
 if(!plain(raw))return no('invalid');
 if(!Number.isSafeInteger(raw.schema))return no('invalid');
 if(!spec.schemas.includes(raw.schema))return no('unknown-schema');
 const allowed=['schema','interval','withheld',...(spec.payload?['collectedAt',spec.payload]:[])];
 if(Object.keys(raw).some(k=>!allowed.includes(k))||(spec.payload&&(!(spec.payload in raw)||!('collectedAt' in raw))))return no('invalid');
 if(!Number.isSafeInteger(raw.interval)||raw.interval<spec.interval.min||raw.interval>spec.interval.max)return no('invalid');
 if(spec.payload&&!isoTime(raw.collectedAt,ISO_MS))return no('invalid');
 if(raw.withheld!==undefined&&!validWithheld(raw.withheld))return no('invalid');
 const part={schema:raw.schema,interval:raw.interval,collectedAt:spec.payload?raw.collectedAt:null,withheld:raw.withheld?raw.withheld.map(w=>({...w})):[]};
 if(spec.payload==='data'){
  const why=checkRuntimes(raw.data,runtimeUrl);if(why)return no(why);
  const data=structuredClone(raw.data);for(const r of data.runtimes)if(typeof r.url==='string')r.url=originOf(r.url);
  return {part:{...part,data}};
 }
 if(spec.payload!=='records')return {part};
 const records=raw.records;
 if(!Array.isArray(records))return no('invalid');
 if(records.length>spec.cap)return no('too-large');
 for(const line of records){const bad=checkLine(name,line,platform);if(bad)return no(bad.code,{...(bad.tag?{tag:bad.tag}:{}),...(bad.field?{field:bad.field}:{})});}
 if(name==='os'||name==='sshkeys'){
  const hosts=records.filter(l=>l.startsWith('HOST\t')),ends=records.filter(l=>l.split('\t')[0]==='END');
  if(hosts.length!==1||ends.length!==1||records.at(-1)!=='END\tok')return no('invalid');
  if(hosts[0].split('\t')[2]!==HOST_PLATFORM[platform])return no('platform-mismatch',{tag:'HOST',field:2});
 }
 return {part:{...part,records:[...records]}};
}

/**
 * A report as sent → {ok:false, field} when the envelope is wrong (400 AGENT_REPORT_INVALID, naming the field), else
 * {ok:true, report:{v, agentVersion, platform, sentAt}, parts:{<part>: normalized}, refused:[{part, code, tag?, field?}]}.
 * Never throws. A part that is refused is not in parts. runtimeUrl(url) → whether a runtime's url is allowed
 * (default: loopback only, the agent's own rule).
 */
export function validateReport(input,{runtimeUrl=loopbackOrigin}={}){
 const bad=field=>({ok:false,field});
 try{
  if(!plain(input))return bad('body');
  const keys=['v','agentVersion','platform','sentAt','parts'];
  const extra=Object.keys(input).find(k=>!keys.includes(k));if(extra!==undefined)return bad(echoable(extra,/^[A-Za-z][A-Za-z0-9_-]{0,39}$/)?extra:'body');
  const missing=keys.find(k=>!(k in input));if(missing)return bad(missing);
  if(input.v!==REPORT_VERSION)return bad('v');
  if(typeof input.agentVersion!=='string'||input.agentVersion.length>64||!parseSemver(input.agentVersion)||input.agentVersion.trim()!==input.agentVersion)return bad('agentVersion');
  if(!AGENT_PLATFORMS.includes(input.platform))return bad('platform');
  if(!isoTime(input.sentAt,ISO_MS))return bad('sentAt');
  const names=plain(input.parts)?Object.keys(input.parts):[];
  // A part name is echoed back and audited (unknown-part), so one that looks like a secret refuses the report instead.
  if(!names.length||names.length>REPORT_LIMITS.parts||names.some(n=>!echoable(n,PART_NAME)))return bad('parts');
  const lines=names.reduce((sum,n)=>sum+(Array.isArray(input.parts[n]?.records)?input.parts[n].records.length:0),0);
  if(lines>REPORT_LIMITS.lines)return bad('parts');
  const platform=input.platform,parts={},refused=[];
  for(const name of names){
   if(!Object.hasOwn(PARTS,name)){refused.push({part:name,code:'unknown-part'});continue;}
   const r=checkPart(name,input.parts[name],{platform,runtimeUrl});
   if(r.part)parts[name]=r.part;else refused.push({part:name,...r.refused});
  }
  // One run of the systems probe: sent together, same collectedAt and interval, or none of them is taken.
  const sent=SYSTEMS_PARTS.filter(n=>names.includes(n));
  if(sent.length){
   const taken=sent.filter(n=>parts[n]);
   const together=sent.length===SYSTEMS_PARTS.length&&taken.length===sent.length&&taken.every(n=>parts[n].collectedAt===parts.os.collectedAt&&parts[n].interval===parts.os.interval);
   if(!together)for(const n of taken){delete parts[n];refused.push({part:n,code:'invalid'});}
  }
  return {ok:true,report:{v:input.v,agentVersion:input.agentVersion,platform,sentAt:input.sentAt},parts,refused};
 }catch{return bad('body');}
}

// SHA-256 of a part's payload (its records, or its data), as the report store keeps it.
export const digestOf=part=>part.records?createHash('sha256').update(part.records.join('\n')).digest('hex'):part.data?createHash('sha256').update(JSON.stringify(part.data)).digest('hex'):null;
// When a part stored with receivedAt stops being fresh: receivedAt + 3 × interval (then it is "no news", never off).
export const freshUntil=part=>Date.parse(part.receivedAt)+REPORT_LIMITS.staleFactor*part.interval*1000;

// --- the watch list on the device -----------------------------------------------------------------------------------
// specs.txt (docs/agent.md → The watch list): the bytes of systemsSpecs(registry, device), "id|kind|a|b|label" per
// line, "\n" after each, an empty list an empty file. The installer and the agent at every start run this; a file that
// fails stops the agent before anything runs. platform: "macos" or "linux". → {ok, lines, errors:[{line, reason}]}.
const SPEC_ID=/^[A-Za-z0-9._-]{1,60}$/,FORMULAS=/^[a-z0-9@._+-]+(,[a-z0-9@._+-]+)*$/,PACKAGE=/^[A-Za-z0-9._-]{1,100}$/,LABEL=/^[A-Za-z0-9._@-]{1,120}$/;
const specPath=(p,glob)=>typeof p==='string'&&p.length<=300&&(p.startsWith('/')||p.startsWith('~/'))&&!p.split('/').includes('..')&&(glob?/^[A-Za-z0-9 ._/~@+*-]+$/:/^[A-Za-z0-9 ._/~@+-]+$/).test(p);
export const SPEC_KINDS=Object.freeze({macos:Object.freeze(['brew','cask','app','cmd','pydist','json','unsupported-args']),linux:Object.freeze(['cmd','json','pydist'])});
export function validateSpecs(text,{platform='macos'}={}){
 const errors=[],lines=[];
 if(typeof text!=='string')return {ok:false,lines,errors:[{line:0,reason:'not text'}]};
 if(text==='')return {ok:true,lines,errors};
 if(!text.endsWith('\n'))return {ok:false,lines,errors:[{line:0,reason:'the file must end with a newline'}]};
 const kinds=SPEC_KINDS[platform];if(!kinds)return {ok:false,lines,errors:[{line:0,reason:`no watch list on ${platform}`}]};
 text.slice(0,-1).split('\n').forEach((line,i)=>{
  const n=i+1,no=reason=>errors.push({line:n,reason});
  const f=line.split('|');if(f.length!==5)return no('a line is id|kind|a|b|label');
  const [id,kind,a,b,label]=f;
  if(!SPEC_ID.test(id))return no('id');
  if(!kinds.includes(kind))return no('kind');
  if(label!==''&&!(LABEL.test(label)||(platform==='macos'&&label.startsWith('system/')&&LABEL.test(label.slice(7)))))return no('label');
  const ok=kind==='brew'||kind==='cask'?FORMULAS.test(a)&&b===''
   :kind==='app'?specPath(a,false)&&b===''
   :kind==='cmd'?specPath(a,true)&&CMD_ARGS.includes(b)
   :kind==='pydist'?specPath(a,true)&&PACKAGE.test(b)
   :kind==='json'?specPath(a,false)&&(b===''||PACKAGE.test(b))
   :a===''&&b==='';
  if(!ok)return no('arguments');
  lines.push(line);
 });
 return {ok:errors.length===0,lines:errors.length?[]:lines,errors};
}
