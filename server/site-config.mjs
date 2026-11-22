// Site configuration: everything that describes one particular household (its name, LAN, devices,
// inventory vocabulary, seed projects). Core code never hardcodes any of it; it reads this module.
//   local/site.json            the real file (private overlay, not part of the public export)
//   <config>/site.json         the same in an instance directory (HOME_HUB_HOME or HOME_HUB_CONFIG_DIR; server/paths.mjs)
//   config/site.example.json   a generic example to copy
//   HOME_HUB_SITE_CONFIG       another path (tests, a second instance); "none" = no file
// A missing file is fine: the hub runs empty and generic. A file that is present but wrong is a loud
// start-up error, never a silent fallback. Plugins keep their own settings under "plugins".<id>.
import {readFileSync} from 'node:fs';
import os from 'node:os';
// Legacy field names; keep configuration validation independent of state storage.
const V1={device:'machine',devices:'machines'};
import {repoRoot} from './edition.mjs';
import {resolvePaths} from './paths.mjs';

// The id of a device, a site's or an added one (server/home-devices.mjs), and the roles one may have: defined here only.
export const DEVICE_ID=/^[a-z][a-z0-9_-]{1,31}$/;
export const DEVICE_ROLES=Object.freeze(['computer','nas','router','other']);
export const SSH_PROBES=Object.freeze(['mac','nas']);
// The operating system of a device, apart from its role (the same list as server/home-devices.mjs → PLATFORMS).
// Optional: a device without it is "not said", as before platforms existed.
export const SITE_PLATFORMS=Object.freeze(['macos','windows','linux','other']);
export const LANGUAGES=Object.freeze(['en','cs']);
const fail=message=>{throw new Error(`site config: ${message}`);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed,where)=>{if(!plain(v))fail(`${where} must be an object`);const extra=Object.keys(v).filter(k=>!allowed.includes(k));if(extra.length)fail(`${where} has unknown field(s): ${extra.join(', ')}`);return v;};
const str=(v,max,where,{empty=true}={})=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v)||(!empty&&!v.trim()))fail(`${where} must be a string of at most ${max} characters`);return v;};
const list=(v,max,where)=>{if(!Array.isArray(v)||v.length>max)fail(`${where} must be a list of at most ${max} items`);return v;};

// --- IPv4 and CIDR ---------------------------------------------------------------------------
export function ipv4(text){
 const m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(typeof text==='string'?text:'');if(!m)return null;
 const parts=m.slice(1).map(Number);if(parts.some((p,i)=>p>255||String(p)!==m[i+1]))return null;
 return ((parts[0]<<24)|(parts[1]<<16)|(parts[2]<<8)|parts[3])>>>0;
}
export function parseCidr(text){
 const m=/^([0-9.]+)\/(\d{1,2})$/.exec(typeof text==='string'?text:'');if(!m)return null;
 const base=ipv4(m[1]),bits=Number(m[2]);if(base===null||bits>32)return null;
 const mask=bits===0?0:(0xffffffff<<(32-bits))>>>0;
 if(((base&mask)>>>0)!==base)return null; // must be the network address, e.g. 10.0.0.0/24
 return {base,bits,mask,text:`${m[1]}/${bits}`};
}
// True when ip is a usable host address inside one of the networks (the network and broadcast
// addresses are excluded). With no networks configured every well-formed IPv4 address passes.
export function inCidrs(ip,cidrs){
 const n=ipv4(ip);if(n===null)return false;if(!cidrs?.length)return true;
 return cidrs.some(c=>{const net=typeof c==='string'?parseCidr(c):c;if(!net||((n&net.mask)>>>0)!==net.base)return false;
  if(net.bits>=31)return true;const host=(n&~net.mask)>>>0,last=(~net.mask)>>>0;return host!==0&&host!==last;});
}

// --- LLM runtime endpoints ------------------------------------------------------------------
// Where the hub reads a local LLM runtime directly (server/core/runtimes.mjs, server/runtime-adapters.mjs):
// {id?, device, kind, url, name?}. url is an origin only (scheme, address, port): no path, so no endpoint
// can point the read-only adapters at a route of its choosing, and no user:password, because credentials
// never go in this file (a bearer token is stored server-side, write-only). The host is an address, never a
// name: loopback, or inside lanCidrs when the site lists its networks (else a private IPv4 range).
export const RUNTIME_KINDS=Object.freeze(['auto','llama-swap','ollama','lmstudio','llama-cpp','vllm','sglang','omlx','mlx-serve','openai']);
export const RUNTIME_ENDPOINT_ID=/^[a-z][a-z0-9-]{1,47}$/;
export const RUNTIME_ENDPOINT_LIMIT=40;
export const RUNTIME_CLIENT_FAMILY=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
export const RUNTIME_CLIENT_LIMIT=60;
const PRIVATE_NETS=['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'].map(parseCidr);
const loopback=host=>host==='localhost'||host==='[::1]'||(ipv4(host)!==null&&host.startsWith('127.'));
// → {id, device, kind, url, name} or throws Error(message) naming the field. where: the field's path.
export function runtimeEndpoint(raw,{lanCidrs=[],where='runtime'}={}){
 const no=message=>{throw Object.assign(new Error(`${where}${message}`),{code:'invalid'});};
 if(!plain(raw))no(' must be an object');
 if(Object.hasOwn(raw,V1.device))no(' has unsupported runtime field; use device');
 const extra=Object.keys(raw).filter(k=>!['id','device','kind','url','name'].includes(k));if(extra.length)no(` has unknown field(s): ${extra.join(', ')}`);
 if(typeof raw.device!=='string'||!DEVICE_ID.test(raw.device))no(`.device must be a device id`);
 const kind=raw.kind??'auto';if(!RUNTIME_KINDS.includes(kind))no(`.kind must be one of ${RUNTIME_KINDS.join(', ')}`);
 let url;try{url=new URL(raw.url);}catch{no('.url must be an http(s) address such as http://127.0.0.1:11434');}
 if(!['http:','https:'].includes(url.protocol))no('.url must use http or https');
 if(url.username||url.password)no('.url must not carry a user or password: credentials never go in the configuration');
 if(url.pathname!=='/'||url.search||url.hash||/[?#]/.test(raw.url))no('.url must be an origin only (scheme, address and port), with no path or query');
 const host=url.hostname;
 if(!loopback(host)){
  if(ipv4(host)===null)no('.url must name an IP address (or localhost), not a host name');
  if(lanCidrs.length?!inCidrs(host,lanCidrs):!PRIVATE_NETS.some(n=>inCidrs(host,[n])))no(lanCidrs.length?'.url must be a loopback address or inside the site networks (lanCidrs)':'.url must be a loopback or private network address');
 }
 const port=url.port||(url.protocol==='https:'?'443':'80');
 const id=raw.id??`${raw.device}-${port}`.slice(0,48);
 if(typeof id!=='string'||!RUNTIME_ENDPOINT_ID.test(id))no(`.id must match ${RUNTIME_ENDPOINT_ID}`);
 const name=raw.name??'';if(typeof name!=='string'||name.length>60||/[\u0000-\u001f\u007f]/.test(name))no('.name must be a string of at most 60 characters');
 return {id,device:raw.device,kind,url:url.origin,name:name.trim()};
}

// --- validation ------------------------------------------------------------------------------
export const UPDATE_CHANNELS=Object.freeze(['stable','prerelease']);
export const UPDATE_INTERVAL_HOURS=Object.freeze({min:6,max:168,default:12});
const UPDATE_REPO=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
// Whether the hub checks this device's address with a TCP connect (server/reachability.mjs): false = never; else
// {ports} with 1 to 4 port numbers, tried in order. Absent (or null) = port 22.
export const REACH_PORT_LIMIT=4;
function reachOf(raw,where){
 if(raw===undefined||raw===null)return {ports:[22]};
 if(raw===false)return false;
 if(!plain(raw))fail(`${where} must be false, or {"ports": [...]}`);
 keys(raw,['ports'],where);
 if(!Array.isArray(raw.ports)||raw.ports.length<1||raw.ports.length>REACH_PORT_LIMIT)fail(`${where}.ports must be a list of 1 to ${REACH_PORT_LIMIT} port numbers`);
 raw.ports.forEach((p,j)=>{if(!Number.isSafeInteger(p)||p<1||p>65535)fail(`${where}.ports[${j}] must be a port number from 1 to 65535`);});
 if(new Set(raw.ports).size!==raw.ports.length)fail(`${where}.ports lists a port twice`);
 return {ports:[...raw.ports]};
}
function device(raw,i){
 const where=`devices[${i}]`;keys(raw,['id','name','hostname','ip','role','picture','thermoId','hardware','ssh','stack','platform','reach'],where);
 if(typeof raw.id!=='string'||!DEVICE_ID.test(raw.id))fail(`${where}.id must match ${DEVICE_ID}`);
 const role=raw.role??'computer';if(!DEVICE_ROLES.includes(role))fail(`${where}.role must be one of ${DEVICE_ROLES.join(', ')}`);
 const ip=raw.ip??'';if(ip!==''&&ipv4(ip)===null)fail(`${where}.ip must be an IPv4 address`);
 const picture=raw.picture??null;if(picture!==null&&!/^\/(images|plugins)\/[A-Za-z0-9._/-]{1,120}$/.test(picture))fail(`${where}.picture must be a path under /images/ or /plugins/`);
 const thermoId=raw.thermoId??null;if(thermoId!==null&&(typeof thermoId!=='string'||!DEVICE_ID.test(thermoId)))fail(`${where}.thermoId must be a device-style id`);
 const platform=raw.platform??null;if(platform!==null&&!SITE_PLATFORMS.includes(platform))fail(`${where}.platform must be one of ${SITE_PLATFORMS.join(', ')}, or null`);
 let hardware={};if(raw.hardware!==undefined){keys(raw.hardware,['cpu','gpu','ramGb','diskTotalBytes','pools','wifi'],`${where}.hardware`);
  for(const [k,v] of Object.entries(raw.hardware)){if(['cpu','gpu','wifi'].includes(k))str(v,80,`${where}.hardware.${k}`);else if(v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0))fail(`${where}.hardware.${k} must be a number or null`);}
  hardware={...raw.hardware};}
 let ssh=null;if(raw.ssh!==undefined&&raw.ssh!==null){keys(raw.ssh,['alias','probe','keys'],`${where}.ssh`);
  if(typeof raw.ssh.alias!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(raw.ssh.alias))fail(`${where}.ssh.alias must be an ssh host alias, or "local"`);
  const probe=raw.ssh.probe??null;if(probe!==null&&!SSH_PROBES.includes(probe))fail(`${where}.ssh.probe must be one of ${SSH_PROBES.join(', ')}`);
  if(raw.ssh.keys!==undefined&&typeof raw.ssh.keys!=='boolean')fail(`${where}.ssh.keys must be true or false`);
  ssh={alias:raw.ssh.alias,probe,keys:raw.ssh.keys!==false};}
 let stack=null;if(raw.stack!==undefined&&raw.stack!==null){if(!plain(raw.stack)||!Array.isArray(raw.stack.layers)||!Array.isArray(raw.stack.cols)||!Array.isArray(raw.stack.blocks))fail(`${where}.stack needs layers, cols and blocks`);stack=raw.stack;}
 return {id:raw.id,name:str(raw.name??raw.id,60,`${where}.name`,{empty:false}),hostname:str(raw.hostname??'',253,`${where}.hostname`),ip,role,picture,thermoId,platform,hardware,ssh,stack,reach:reachOf(raw.reach,`${where}.reach`)};
}
// Reject legacy field names in configuration.
export function validateSite(raw={}){
 if(plain(raw)&&Object.hasOwn(raw,V1.devices))fail('unsupported device list field; use devices and runtimes[].device');
 keys(raw,['$comment','siteName','lanCidrs','timeZone','defaultLanguage','publicOrigin','devices','inventory','tracker','security','router','runtimes','runtimeClients','updates','strings','plugins'],'the file');
 const lanCidrs=list(raw.lanCidrs??[],16,'lanCidrs').map((c,i)=>parseCidr(c)?.text??fail(`lanCidrs[${i}] must be an IPv4 network such as 10.0.0.0/24`));
 const timeZone=raw.timeZone??null;
 if(timeZone!==null){try{new Intl.DateTimeFormat('en',{timeZone});}catch{fail('timeZone must be an IANA zone such as Europe/Berlin, or null');}}
 const defaultLanguage=raw.defaultLanguage??'en';if(!LANGUAGES.includes(defaultLanguage))fail(`defaultLanguage must be one of ${LANGUAGES.join(', ')}`);
 let publicOrigin=raw.publicOrigin??null;
 if(publicOrigin!==null){let url;try{url=new URL(publicOrigin);}catch{fail('publicOrigin must be an http(s) origin');}if(!['http:','https:'].includes(url.protocol)||url.origin!==publicOrigin)fail('publicOrigin must be a bare origin such as https://hub.example.lan');}
 const devices=list(raw.devices??[],50,'devices').map(device);
 const ids=devices.map(m=>m.id);if(new Set(ids).size!==ids.length)fail('devices have duplicate ids');
 const inv=keys(raw.inventory??{},['places','secretStores'],'inventory');
 // A place is where inventory entries live (a device id, or something like a work laptop). On the map:
 // column = it gets a column of its own with this heading; lane = it shares the Network or Outside column;
 // short = the tag shown on its cards when the map is grouped by category. Order = column and sort order.
 const places=list(inv.places??[],100,'inventory.places').map((p,i)=>{const where=`inventory.places[${i}]`;keys(p,['id','label','short','column','lane'],where);
  if(p.lane!==undefined&&!['net','outside'].includes(p.lane))fail(`${where}.lane must be "net" or "outside"`);
  return {id:str(p.id,64,`${where}.id`,{empty:false}),label:str(p.label,80,`${where}.label`,{empty:false}),...(p.short?{short:str(p.short,30,`${where}.short`)}:{}),...(p.column?{column:str(p.column,60,`${where}.column`)}:{}),...(p.lane?{lane:p.lane}:{})};});
 const secretStores=list(inv.secretStores??[],40,'inventory.secretStores').map((s,i)=>{if(typeof s!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(s))fail(`inventory.secretStores[${i}] must be a lowercase name`);return s;});
 const tracker=keys(raw.tracker??{},['projects'],'tracker');
 const projects=list(tracker.projects??[],50,'tracker.projects').map((p,i)=>{keys(p,['id','key','name','type'],`tracker.projects[${i}]`);
  if(typeof p.id!=='string'||!/^[a-z][a-z0-9-]{1,39}$/.test(p.id)||typeof p.key!=='string'||!/^[A-Z][A-Z0-9]{1,9}$/.test(p.key))fail(`tracker.projects[${i}] needs an id (a-z, 0-9, -) and a KEY`);
  if(p.type!==undefined&&p.type!==null&&!['web','app','game','other'].includes(p.type))fail(`tracker.projects[${i}].type must be web, app, game or other`);
  return {id:p.id,key:p.key,name:str(p.name??p.id,80,`tracker.projects[${i}].name`,{empty:false}),...(p.type?{type:p.type}:{})};});
 const security=keys(raw.security??{},['gitHost','gitUrl','certificates','order'],'security');
 const certificates=list(security.certificates??[],20,'security.certificates').map((c,i)=>{keys(c,['match','label'],`security.certificates[${i}]`);try{new RegExp(c.match);}catch{fail(`security.certificates[${i}].match must be a regular expression`);}return {match:str(c.match,200,`security.certificates[${i}].match`,{empty:false}),label:str(c.label,120,`security.certificates[${i}].label`,{empty:false})};});
 const order=list(security.order??[],50,'security.order').map((id,i)=>ids.includes(id)?id:fail(`security.order[${i}] is not a device id`));
 // The router feed (server/router-data.mjs): adapter = "unifi" (included) or the id of an adapter a plugin provides;
 // host = the gateway the included collector reads (default: the device with role "router"); site = its UniFi site name.
 let router=null;if(raw.router!==undefined&&raw.router!==null){keys(raw.router,['adapter','host','site'],'router');
  if(typeof raw.router.adapter!=='string'||!/^[a-z][a-z0-9-]{1,31}$/.test(raw.router.adapter))fail('router.adapter must be an adapter id such as "unifi"');
  const host=raw.router.host??null;if(host!==null&&(typeof host!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)))fail('router.host must be an IPv4 address or a host name');
  const name=raw.router.site??null;if(name!==null&&(typeof name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(name)))fail('router.site must be a UniFi site name such as "default"');
  router={adapter:raw.router.adapter,host,site:name};}
 // Local LLM runtimes the hub reads directly: each on a device of this file, each URL once.
 const runtimes=list(raw.runtimes??[],RUNTIME_ENDPOINT_LIMIT,'runtimes').map((r,i)=>{let e;try{e=runtimeEndpoint(r,{lanCidrs,where:`runtimes[${i}]`});}catch(err){fail(err.message);}
  if(!ids.includes(e.device))fail(`runtimes[${i}].device is not a device id of this file`);return e;});
 if(new Set(runtimes.map(r=>r.id)).size!==runtimes.length)fail('runtimes have duplicate ids');
 if(new Set(runtimes.map(r=>r.url)).size!==runtimes.length)fail('runtimes list one URL twice');
 // Who a User-Agent family is in this household, for the runtimes' request history: {"<family>": "<client>"},
 // the family being the first word of the User-Agent ("claude-cli", "deno"). Wins over the generic names
 // in server/runtime-history.mjs; matched without regard to case.
 const runtimeClients={};
 if(raw.runtimeClients!==undefined){if(!plain(raw.runtimeClients))fail('runtimeClients must be an object: {"<User-Agent family>": "<client name>"}');
  const entries=Object.entries(raw.runtimeClients);if(entries.length>RUNTIME_CLIENT_LIMIT)fail(`runtimeClients may name at most ${RUNTIME_CLIENT_LIMIT} families`);
  for(const [family,name] of entries){
   if(!RUNTIME_CLIENT_FAMILY.test(family))fail(`runtimeClients key "${family.slice(0,40)}" must be a User-Agent family: letters, digits, . _ + -, at most 40`);
   if(Object.keys(runtimeClients).some(k=>k.toLowerCase()===family.toLowerCase()))fail(`runtimeClients names the family "${family}" twice`);
   runtimeClients[family]=str(name,60,`runtimeClients.${family}`,{empty:false}).trim();}}
 // The update check (server/update-check.mjs): repo = another "owner/name" on GitHub whose releases to follow (a
 // fork; default: the one in package.json), channel = stable or prerelease, intervalHours = how often (6 to 168).
 const up=keys(raw.updates??{},['repo','channel','intervalHours'],'updates');
 const updateRepo=up.repo??null;if(updateRepo!==null&&(typeof updateRepo!=='string'||!UPDATE_REPO.test(updateRepo)||updateRepo.endsWith('.git')))fail('updates.repo must be a GitHub repository as "owner/name", or null for the default');
 const updateChannel=up.channel??'stable';if(!UPDATE_CHANNELS.includes(updateChannel))fail(`updates.channel must be one of ${UPDATE_CHANNELS.join(', ')}`);
 const updateHours=up.intervalHours??UPDATE_INTERVAL_HOURS.default;
 if(typeof updateHours!=='number'||!Number.isFinite(updateHours)||updateHours<UPDATE_INTERVAL_HOURS.min||updateHours>UPDATE_INTERVAL_HOURS.max)fail(`updates.intervalHours must be a number from ${UPDATE_INTERVAL_HOURS.min} to ${UPDATE_INTERVAL_HOURS.max}`);
 if(raw.plugins!==undefined&&!plain(raw.plugins))fail('plugins must be an object keyed by plugin id');
 // Translations of the site's own labels (the UI's source language is Czech): {"en": {"source text": "translation"}}.
 const strings={};
 for(const [lang,dict] of Object.entries(raw.strings??{})){if(!LANGUAGES.includes(lang)||!plain(dict)||Object.values(dict).some(v=>typeof v!=='string'))fail(`strings.${lang} must map source text to a translation`);strings[lang]={...dict};}
 return deepFreeze({siteName:str(raw.siteName??'',60,'siteName'),lanCidrs,timeZone,defaultLanguage,publicOrigin,devices,
  inventory:{places,secretStores},tracker:{projects},
  security:{gitHost:security.gitHost?str(security.gitHost,253,'security.gitHost'):null,gitUrl:security.gitUrl?str(security.gitUrl,300,'security.gitUrl'):null,certificates,order},
  router,runtimes,runtimeClients,updates:{repo:updateRepo,channel:updateChannel,intervalHours:updateHours},strings,plugins:raw.plugins??{}});
}
function deepFreeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);for(const x of Object.values(v))deepFreeze(x);}return v;}
export const EMPTY_SITE=validateSite({});

// --- loading ---------------------------------------------------------------------------------
// The site file: HOME_HUB_SITE_CONFIG, else site.json in the configuration directory (server/paths.mjs).
export const siteConfigPath=(env=process.env,root=repoRoot)=>resolvePaths(env,root).siteConfig;
export function loadSite({file=siteConfigPath()}={}){
 if(!file)return EMPTY_SITE;
 let text;try{text=readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return EMPTY_SITE;throw new Error(`site config: cannot read ${file}: ${e.message}`);}
 let raw;try{raw=JSON.parse(text);}catch(e){throw new Error(`site config: ${file} is not valid JSON: ${e.message}`);}
 return validateSite(raw);
}
let cached=null;
// The process-wide site (read once). Code that can take a site as an argument should; tests pass their own.
export const site=()=>cached??(cached=loadSite());

// --- derived views ---------------------------------------------------------------------------
// The ids of the site's own devices (the added ones are the home store's: server/home-devices.mjs).
export const siteDeviceIds=s=>s.devices.map(m=>m.id);
// What the overview tile and the collectors call this device: thermo = live Thermo telemetry.
export const deviceKind=m=>m.thermoId?'thermo':m.role==='nas'?'nas':m.role==='router'?'router':'other';
export const thermoDeviceIds=s=>s.devices.filter(m=>m.thermoId).map(m=>m.id);
export const inLan=(s,ip)=>inCidrs(ip,s.lanCidrs);
// id → ssh alias for the collectors ("local" runs the probe on this computer).
export const sshHosts=(s,pick=()=>true)=>new Map(s.devices.filter(m=>m.ssh&&pick(m)).map(m=>[m.id,m.ssh.alias]));
// What the browser may know before and after sign-in (GET /api/ui/manifest).
export const publicSite=s=>({name:s.siteName,timeZone:s.timeZone,defaultLanguage:s.defaultLanguage,lanCidrs:[...s.lanCidrs]});
// The software watch list (versions to follow per device): SOFTWARE_WATCH_FILE, else software-watch.json beside
// the site file, else none (server/paths.mjs). The same answer as server/software-watch.mjs → watchPath; kept
// here for older callers. config/software-watch.json is an example to copy, never the active list.
export const softwareWatchPath=(env=process.env,root=repoRoot)=>resolvePaths(env,root).softwareWatch;

// The hub's own IPv4 address inside the site's networks (lanCidrs), or null when it has none there: what another
// device sees the hub connect from (backups' from="…", the telemetry guides' firewall rules).
export function hubAddress(lanCidrs=[],interfaces=os.networkInterfaces()){
 for(const list of Object.values(interfaces||{}))for(const a of list||[])if(a&&!a.internal&&(a.family==='IPv4'||a.family===4)&&lanCidrs.length&&inCidrs(a.address,lanCidrs))return a.address;
 return null;
}
