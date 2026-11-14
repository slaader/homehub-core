// Systémy section: OS versions, watched software with update candidates, and host protection
// (firewall, FileVault, SIP, Gatekeeper, update policy, SSH password login, exposed ports).
// scripts/collect-systems.mjs runs scripts/systems/{mac,nas}-probe.sh on every device and saves
// data/systems/snapshot.json; scripts/check-upstream.mjs saves the newest upstream versions to
// data/systems/upstream.json. buildSystems() joins both with the site's software watch list
// (server/software-watch.mjs: local/software-watch.json, empty without one).
// SSH keys and sudo stay in the security section (security-data.mjs); this module links to it.
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {upstreamKey} from './systems-upstream.mjs';
import {parseVersion,compareVersions,extractVersion} from './versions.mjs';
import {site as loadedSite} from './site-config.mjs';
import {readWatch,watchPath,CMD_ARGS} from './software-watch.mjs';
import {collectorState,staleAfter,COLLECTORS} from './collector-state.mjs';
import {freshUntil,SYSTEMS_PARTS} from './agent-report.mjs';
import {privilegedIds} from './agent-privileged.mjs';
import {tx,sentences,textOf,field} from './text.mjs';
import {provenance,collectorSource} from './provenance.mjs';
import {readRun} from './collector-run.mjs';
export {parseVersion,compareVersions,extractVersion};

export const SYSTEMS_SCHEMA=1;
// The devices the collector probes: every site device with ssh.probe (mac or nas), in site order.
export const systemDevices=s=>s.devices.filter(m=>m.ssh?.probe).map(m=>({id:m.id,name:m.name,kind:m.ssh.probe}));
const clean=(v,n=300)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const onOff=v=>v==='on'||v==='off'?v:'unknown';
// A key taken from a record (a privileged id, a volume) never names what every object inherits.
const ownKey=k=>Boolean(k)&&k!=='__proto__'&&k!=='constructor'&&k!=='prototype';
// The maps a record keys by its own text (SW, RUN, SHARE, AUTO, FW, SSHD) are filled without a prototype, so a name
// every object inherits (constructor, toString, __proto__) is an entry like any other, never a lookup into
// Object.prototype; plain() hands them back as ordinary objects holding those names as their own keys.
const dict=(init={})=>Object.assign(Object.create(null),init);
const plain=o=>Object.fromEntries(Object.entries(o));
const MAPS=['autoUpdate','firewall','sshd','sharing','software','running'];
// A value a map holds itself (a snapshot read back from JSON has ordinary objects), never an inherited one.
const own=(o,k)=>o!=null&&typeof o==='object'&&Object.hasOwn(o,k)?o[k]:undefined;

// --- probe records -------------------------------------------------------------------------------
const decode=s=>s.replace(/\\x([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
export function listenEntry(proc,user,addr){
 const m=/^(.*):(\d+|\*)$/.exec(addr||'');if(!m)return null;
 const host=m[1].replace(/^\[|\]$/g,''),port=num(m[2]);if(port==null)return null;
 const scope=['*','0.0.0.0','::',''].includes(host)?'all':/^(127\.|::1$|localhost$)/.test(host)?'loopback':'address';
 return {proc:clean(decode(proc||'?'),40)||'?',user:clean(user,32),host,port,scope};
}
// One device's probe output → a plain record (no versions resolved yet).
export function parseSystemsProbe(text){
 const h={host:null,platform:null,user:null,root:false,collectedAt:null,os:{},hw:{},uptimeSeconds:null,
  osUpdates:{checked:false,items:[],error:null},autoUpdate:dict(),firewall:dict(),pf:null,fileVault:null,sip:null,gatekeeper:null,
  sshd:dict({allowUsers:[]}),sharing:dict(),listening:[],software:dict(),running:dict(),brewOutdated:[],docker:[],
  truenasUpdate:null,apps:[],services:[],ftp:null,nft:null,errors:[],complete:false};
 let pendingLabel=null;const seen=new Set();
 for(const line of String(text||'').split('\n')){
  const f=line.split('\t'),t=f[0];
  if(t==='HOST')Object.assign(h,{host:clean(f[1],64),platform:f[2]==='Darwin'?'mac':f[2]==='Linux'?'linux':f[2]==='Windows'?'windows':clean(f[2],20),user:clean(f[3],32),root:f[4]==='1',collectedAt:clean(f[5],30)||null});
  else if(t==='OS')h.os=h.platform==='mac'?{name:clean(f[1],40),version:clean(f[2],20),build:clean(f[3],20),kernel:clean(f[4],40),arch:clean(f[5],20)}
   :h.platform==='windows'?{name:clean(f[1],40),version:clean(f[2],20),build:clean(f[3],80),kernel:clean(f[4],60),arch:clean(f[5],20)}
   :{name:clean(f[1],40),version:clean(f[2],20),base:clean(f[3],80),kernel:clean(f[4],60),arch:clean(f[5],20)};
  else if(t==='HW')h.hw={model:clean(f[1],60),cpu:clean(f[2],80),memBytes:num(f[3]),cpus:num(f[4])};
  // macOS reports the boot time (epoch seconds), Linux the uptime. An empty field is "not known", not zero.
  else if(t==='UPTIME'){const v=f[1]?num(f[1]):null;if(v!=null)h.uptimeSeconds=h.platform==='mac'?(h.collectedAt&&v>0?Math.max(0,Math.round(Date.parse(h.collectedAt)/1000-v)):null):Math.round(v);}
  else if(t==='SWU_NONE')h.osUpdates={checked:true,items:[],error:null};
  else if(t==='SWU_ERR')h.osUpdates={checked:false,items:[],error:clean(f[1],200)};
  else if(t==='SWU'){h.osUpdates.checked=true;const s=clean(f[1],400);
   const label=/^\* Label:\s*(.*)$/.exec(s);if(label){pendingLabel=label[1];continue;}
   const kv=Object.fromEntries(s.split(/,\s*/).map(p=>p.split(/:\s*/)).filter(p=>p.length>=2).map(([k,...v])=>[k.toLowerCase(),v.join(':')]));
   if(kv.title)h.osUpdates.items.push({label:pendingLabel||kv.title,title:kv.title,version:kv.version||'',recommended:/yes/i.test(kv.recommended||''),restart:/restart/i.test(kv.action||'')});
   pendingLabel=null;}
  else if(t==='AUTO')h.autoUpdate[f[1]]=f[2]==='unset'?null:f[2];
  else if(t==='FW')h.firewall[f[1]]=f[2];
  else if(t==='PF')h.pf={status:clean(f[1],20).toLowerCase()||'unknown',rules:num(f[2])};
  else if(t==='FV')h.fileVault=/is on/i.test(f[1])?'on':/is off/i.test(f[1])?'off':'unknown';
  else if(t==='SIP')h.sip=/enabled/i.test(f[1])?'on':/disabled/i.test(f[1])?'off':'unknown';
  else if(t==='GK')h.gatekeeper=/enabled/i.test(f[1])?'on':/disabled/i.test(f[1])?'off':'unknown';
  else if(t==='SSHD'){const k=String(f[1]).toLowerCase(),v=clean(f[2],120);if(k==='allowusers')h.sshd.allowUsers.push(...v.split(/\s+/).filter(Boolean));else h.sshd[k]=v;}
  else if(t==='SHARE')h.sharing[clean(f[1],60)]=f[2]==='loaded';
  else if(t==='LISTEN'){const e=listenEntry(f[1],f[2],f[3]);if(e){const k=`${e.proc}|${e.host}|${e.port}`;if(!seen.has(k)){seen.add(k);h.listening.push(e);}}}
  else if(t==='SW'){const id=clean(f[1],60);(h.software[id]??=[]).push({kind:clean(f[2],20),value:clean(f[3],300),detail:clean(f[4],300),extra:clean(f[5],120)});}
  else if(t==='RUN')h.running[clean(f[1],60)]={state:f[2]==='absent'?'absent':f[2]==='loaded'?'loaded':'running',pid:num(f[2]),label:clean(f[3],120)};
  else if(t==='BREWOUT')h.brewOutdated.push({name:clean(f[1],80),installed:clean(f[2],80),latest:clean(f[3],80)});
  else if(t==='DOCKER')h.docker.push({name:clean(f[1],80),image:clean(f[2],160),status:clean(f[3],80),created:clean(f[4],40)||null});
  else if(t==='TNUPDATE')h.truenasUpdate={code:clean(f[1],30),train:clean(f[2],60),profile:clean(f[3],40),version:clean(f[4],30)||null,date:clean(f[5],20)||null,notes:clean(f[6],400)};
  else if(t==='APP')h.apps.push({name:clean(f[1],60),state:clean(f[2],20),version:clean(f[3],40),human:clean(f[4],60),upgrade:f[5]==='true',image:f[6]==='true',custom:f[7]==='true',train:clean(f[8],30),catalogApp:clean(f[9],60),latest:null,latestHuman:null});
  else if(t==='APPUP'){const a=h.apps.find(x=>x.name===f[1]);if(a){a.latest=clean(f[2],40)||null;a.latestHuman=clean(f[3],60)||null;}}
  else if(t==='SERVICE')h.services.push({name:clean(f[1],40),state:clean(f[2],20),enabled:f[3]==='true'});
  else if(t==='FTP')h.ftp={port:num(f[1]),tls:f[2]==='true',onlyAnonymous:f[3]==='true',onlyLocal:f[4]==='true'};
  // `NFT none <rules> <tables>`: the ruleset has no chain on the input hook at all. That is
  // "nothing filters ingress", represented explicitly (inputHooks:0), never as a policy named none.
  else if(t==='NFT'){if(f[1]==='unknown')h.nft={unknown:true};else{
   const inputPolicies=clean(f[1],80).split(/\s+/).filter(p=>p&&p!=='none').map(p=>{const [policy,count]=p.split(':');return {policy,chains:num(count)};}).filter(p=>/^[a-z]+$/.test(p.policy));
   h.nft={inputPolicies,inputHooks:inputPolicies.reduce((s,p)=>s+(p.chains??1),0),rules:num(f[2]),tables:clean(f[3],400).split(',').filter(Boolean)};}}
  // The push agent's records (docs/agent.md §3 → Lines); a record without them has none of these fields.
  // Linux package updates from the package manager's cached index (PKGUP*), Windows Update (WINUP*), which
  // privileged reads ran (PRIV) and the Windows protection records.
  else if(t==='PKGUP'||t==='PKGUP_NONE'||t==='PKGUP_ERR'){const p=h.packageUpdates??={manager:null,checked:false,cacheAgeSeconds:null,items:[],error:null};p.manager=clean(f[1],10)||null;
   if(t==='PKGUP'){p.checked=true;p.items.push({name:clean(f[2],120),installed:clean(f[3],80)||null,candidate:clean(f[4],80)||null,security:f[5]==='1'});}
   else if(t==='PKGUP_NONE'){p.checked=true;p.cacheAgeSeconds=f[2]?num(f[2]):null;}
   else{p.checked=false;p.error=clean(f[2],200)||'?';}}
  else if(t==='WINUP'||t==='WINUP_NONE'||t==='WINUP_ERR'){const w=h.windowsUpdates??={checked:false,items:[],error:null};
   if(t==='WINUP'){w.checked=true;w.items.push({kb:clean(f[1],20),title:clean(f[2],200),severity:clean(f[3],20)||'Unspecified',restart:f[4]==='1'});}
   else if(t==='WINUP_NONE')w.checked=true;
   else{w.checked=false;w.error=clean(f[1],200)||'?';}}
  else if(t==='PRIV'){const id=clean(f[1],20);if(/^[a-z][a-z-]*$/.test(id)&&ownKey(id))(h.privileged??={})[id]=f[2]==='ok';}
  else if(t==='DEFENDER'||t==='BITLOCKER'||t==='WINFW'||t==='RDP'){const w=h.windows??={defender:null,signatureAgeDays:null,bitlocker:{},firewall:{},rdp:null};
   if(t==='DEFENDER'){w.defender=onOff(f[1]);w.signatureAgeDays=f[2]?num(f[2]):null;}
   else if(t==='BITLOCKER'){const v=clean(f[1],8);if(ownKey(v))w.bitlocker[v]=onOff(f[2]);}
   else if(t==='WINFW'){if(['domain','private','public'].includes(f[1]))w.firewall[f[1]]=onOff(f[2]);}
   else w.rdp=onOff(f[1]);}
  else if(t==='ERROR')h.errors.push(clean(f[1],200));
  else if(t==='END'&&f[1]==='ok')h.complete=true;
 }
 for(const k of MAPS)h[k]=plain(h[k]);
 return h;
}

// SPECS lines the macOS probe reads for one device: "id|kind|arg1|arg2|launchd" (split on |). The Linux probe and the
// Windows agent read the same lines; launchd names a systemd unit there and a Windows service here (winreg: displayName|'').
// A rule is data: every field is stripped of the characters that separate or quote a line, and a cmd
// rule may pass only one of the fixed version flags (CMD_ARGS). Any other argument would let the list
// run a program for something else than printing its version, so such a rule reaches the probe as an
// unsupported kind and its row reads "not found".
const specField=v=>String(v??'').replace(/[|\r\n']/g,' ').trim();
export function systemsSpecs(registry,device){
 const lines=[];
 for(const item of registry?.items||[]){const d=item.detect?.[device];if(!d)continue;
  const kind=d.kind==='cmd'&&!CMD_ARGS.includes(d.args)?'unsupported-args':d.kind;
  const [a,b]=kind==='brew'?[d.formula,'']:kind==='cask'?[d.cask,'']:kind==='app'?[d.path,'']:kind==='cmd'?[d.path,d.args]:kind==='pydist'?[d.glob,d.package]:kind==='json'?[d.path,d.key]:kind==='winreg'?[d.displayName,'']:['',''];
  lines.push([item.id,kind,a,b,d.launchd].map(specField).join('|'));}
 return lines.join('\n');
}
// The push agent's specs.txt for a device (docs/agent.md → The watch list): systemsSpecs's lines, each followed by
// "\n", an empty list an empty file. The agent hashes these bytes for its `SPECS <sha256>` record, so the hub must hash
// exactly these bytes too: this is the one place they are made (scripts/agent-specs.mjs prints them).
export function specsFileText(registry,device){
 const text=systemsSpecs(registry,device);
 return text===''?'':text+'\n';
}

// --- watched software rows ---------------------------------------------------------------------
const BREW='https://formulae.brew.sh';
function sourceOf(det,rec){
 if(det.source)return {label:clean(det.source.label,120),url:det.source.url||null};
 if(det.kind==='brew'){const f=rec?.detail||String(det.formula||'').split(',')[0],tap=rec?.extra||'';
  if(tap&&tap!=='homebrew/core'){const [user,repo]=tap.split('/');return {label:`Homebrew tap ${tap}`,url:`https://github.com/${user}/homebrew-${repo}`};}
  return {label:'Homebrew',url:`${BREW}/formula/${f}`};}
 if(det.kind==='cask')return {label:'Homebrew cask',url:`${BREW}/cask/${det.cask}`};
 return {label:det.kind,url:null};
}
// Installed version from the probe records of one item on one device.
function installedOf(item,det,recs){
 const ok=(recs||[]).filter(r=>r.kind!=='missing'&&r.kind!=='unsupported');
 if(!ok.length)return {version:null,raw:null,path:(recs||[])[0]?.detail||null};
 // pydist, and winreg (the Windows agent: one SW line per matching uninstall entry): the highest version, the others listed.
 if(det.kind==='pydist'||det.kind==='winreg'){const best=ok.reduce((a,b)=>compareVersions(b.value,a.value)>0?b:a);return {version:best.value,raw:best.value,path:best.detail,others:ok.filter(r=>r!==best).map(r=>`${r.value} (${r.detail})`)};}
 if(det.kind==='cmd'){
  const parsed=ok.map(r=>({...r,version:extractVersion(r.value,det.match||item.match)}));
  const best=parsed.find(r=>r.extra==='running')||parsed.reduce((a,b)=>compareVersions(b.version,a.version)>0?b:a);
  return {version:best.version,raw:best.value,path:best.detail,others:parsed.filter(r=>r!==best).map(r=>`${r.version||'?'} (${r.detail})`)};
 }
 const r=ok[0];
 if(det.kind==='app')return {version:r.value,raw:r.value,build:r.extra||null,path:r.detail};
 return {version:r.value,raw:r.value,path:r.detail};
}
const LEGACY_BUILD=/^b?\d{4,}$/;
// installed vs upstream → status + human detail. scheme: llamacpp (bare build numbers predate
// semver releases) or node (odd major lines are short-lived, even lines compare within the line).
// A stale upstream (the last check failed, the value is from an earlier success) can still prove an
// update exists, but it cannot prove "current"/"ahead": those become 'unknown' (neověřeno).
// note is the Czech sentence; noteT (when present) its translatable parts (server/text.mjs).
export function versionStatus(args){
 const {note,...st}=staleAware(args);
 return note?{...st,...field('note',note)}:st;
}
function staleAware(args){
 const st=freshStatus(args),up=args.upstream;
 if(!up?.ok||!up.stale)return st;
 const since=up.checkedAt?tx('Poslední úspěšná kontrola {when} UTC.',{when:String(up.checkedAt).slice(0,16).replace('T',' ')}):null;
 const why=sentences(tx('Kontrola nejnovější verze selhala ({error}).',{error:up.error||'chyba'}),since);
 if(['current','ahead'].includes(st.status))return {...st,status:'unknown',note:sentences(why,st.status==='current'?'Naposledy aktuální.':'Naposledy novější než vydání.')};
 return {...st,note:sentences(st.note,why)};
}
function freshStatus({installed,build,scheme,upstream,up}){
 if(!installed)return {status:'missing',latest:null};
 if(!up||up.type==='none')return {status:'n/a',latest:null,note:up?.note||null};
 if(!upstream?.ok)return {status:'unknown',latest:upstream?.version||null,note:upstream?.error||'Nejnovější verzi se nepodařilo zjistit.'};
 let latest=upstream.version;
 if(scheme==='llamacpp'&&LEGACY_BUILD.test(installed)&&/\./.test(latest))return {status:'update',latest,note:tx('Nainstalovaný build {build} je starší než první semver vydání.',{build:installed.replace(/^b/,'')})};
 if(scheme==='node'&&upstream.latestByMajor){
  const major=parseVersion(installed)?.nums[0],lineLatest=upstream.latestByMajor[major],isLts=(upstream.ltsMajors||[]).includes(major);
  if(major%2===1||!isLts||!lineLatest){const c=compareVersions(installed,upstream.version);return {status:c<0?'update':c>0?'ahead':'current',latest:upstream.version,note:tx('Řada Node {major} není LTS; aktuální LTS je {lts}.',{major,lts:upstream.version})};}
  latest=lineLatest;const c=compareVersions(installed,latest);
  return {status:c<0?'update':c>0?'ahead':'current',latest,note:major===upstream.ltsMajor?'Aktivní LTS řada.':tx('LTS řada {major}; nejnovější LTS je {lts}.',{major,lts:upstream.version})};
 }
 let c=compareVersions(installed,latest);
 if(c===0&&build!=null&&upstream.build!=null)c=Math.sign(Number(build)-Number(upstream.build))||0;
 if(c==null)return {status:'unknown',latest,note:tx('Verze {installed} a {latest} nejdou porovnat.',{installed,latest})};
 return {status:c<0?'update':c>0?'ahead':'current',latest};
}

function softwareRows(registry,devices,upstream){
 const rows=[];
 for(const item of registry.items||[])for(const [device,det] of Object.entries(item.detect||{})){
  const host=devices[device];if(!host)continue;
  const recs=own(host.software,item.id),inst=installedOf(item,det,recs),up=det.upstream||item.upstream;
  const res=upstream?.results?.[upstreamKey(up)]||null;
  // A rule the probe refused (unknown kind, or a cmd rule with arguments beyond a version flag).
  const refused=(recs||[]).find(r=>r.kind==='unsupported');
  const st=refused?{status:'unknown',latest:null,note:refused.detail==='unsupported-args'?'Pravidlo cmd smí programu předat jen přepínač verze (--version, -version, -v, -V, version).':'Tenhle druh pravidla sonda nezná.'}
   :host.complete||recs?versionStatus({installed:inst.version,build:inst.build,scheme:item.scheme,upstream:res,up}):{status:'unknown',latest:null,note:'Stroj nebyl prozkoumán.'};
  const run=own(host.running,item.id);
  rows.push({id:item.id,name:item.name,category:item.category,device,installed:inst.version,raw:inst.raw,build:inst.build||null,path:inst.path,others:inst.others||[],
   source:sourceOf(det,(recs||[]).find(r=>r.kind===det.kind)),latest:st.latest,latestUrl:res?.url||null,publishedAt:res?.publishedAt||null,upstreamType:up?.type||null,
   status:st.status,note:st.note||null,...(st.noteT?{noteT:st.noteT}:{}),running:run?run.state:null,runLabel:run?.label||det.launchd||null,stale:Boolean(host.stale),
   // Inventory entries (data/knowledge.json ids) this row describes, when the id/name heuristic would miss them.
   inventory:Array.isArray(det.inventory)?det.inventory.filter(x=>typeof x==='string').map(x=>clean(x,80)).filter(Boolean).slice(0,10):[],
   // Upstream freshness, separate from the device snapshot's `stale`.
   upstreamStale:Boolean(res?.stale||res&&!res.ok),upstreamError:res?.stale||res&&!res.ok?res.error||null:null,upstreamCheckedAt:res?.ok?res.checkedAt||null:null,upstreamFailedAt:res?.failedAt||null});
 }
 for(const [device,host] of Object.entries(devices)){
  for(const a of host.apps||[])rows.push({id:`app:${a.name}`,name:a.name,category:'nas-apps',device,installed:a.human||a.version,raw:a.version,path:null,others:[],
   source:a.custom?{label:'Vlastní aplikace (custom app)',url:null}:{...field('label',tx('TrueNAS katalog · {train}',{train:a.train||'?'})),url:`https://apps.truenas.com/catalog/${a.catalogApp||a.name}/`},
   latest:a.upgrade?(a.latestHuman||a.latest):a.human,latestUrl:null,publishedAt:null,upstreamType:'truenas-app',
   status:a.upgrade?'update':'current',note:a.upgrade&&a.latestHuman===a.human?'Stejná verze aplikace, nový obraz kontejneru.':a.custom?'Vlastní aplikace: aktualizace = nový obraz.':null,
   running:a.state==='RUNNING'?'running':a.state==='STOPPED'?'absent':String(a.state||'').toLowerCase(),runLabel:a.state,stale:Boolean(host.stale)});
  for(const d of host.docker||[]){const [image,tag='latest']=d.image.split(/:(?=[^/]+$)/);
   rows.push({id:`docker:${d.name}`,name:d.name,category:'containers',device,installed:tag,raw:d.image,path:null,others:[],
    source:{...field('label',tx('Docker obraz {image}',{image})),url:image.includes('/')?`https://hub.docker.com/r/${image}`:`https://hub.docker.com/_/${image}`},
    latest:null,latestUrl:null,publishedAt:d.created,upstreamType:'docker',status:tag==='latest'?'floating':'n/a',
    ...(tag==='latest'?field('note',tx('Plovoucí tag :latest, obraz z {date}; novější verze se pozná až podle digestu.',{date:String(d.created||'?').slice(0,10)})):{note:null}),running:/^Up/.test(d.status)?'running':'absent',runLabel:d.status,stale:Boolean(host.stale)});}
 }
 return rows;
}

// --- operating system --------------------------------------------------------------------------
// The reader kind of a device decides how its record is read: mac or nas from site.json → ssh.probe, mac, linux or
// windows from the platform an agent reports. Never the HOST platform (Linux for the NAS and a Linux agent alike).
// A caller that passes no kind gets what the HOST platform said before kinds existed.
const kindOf=(host,kind)=>kind||(host.platform==='linux'?'nas':'mac');
function osSummary(host,kind){
 if(kind==='linux')return linuxSummary(host);
 if(kind==='windows')return windowsSummary(host);
 if(kind==='nas'){const u=host.truenasUpdate;
  return {name:host.os.name||'TrueNAS',version:host.os.version||null,build:null,base:host.os.base||null,kernel:host.os.kernel||null,
   updates:u?.version?[{title:`TrueNAS ${u.version}`,version:u.version,date:u.date,notes:u.notes,kind:'minor',restart:true}]:[],
   status:u?u.version?'update':'current':'unknown',channel:u?.train||null};}
 const major=parseVersion(host.os.version||'')?.nums[0];
 // macOS in the same major line = minor (the one to install); another major = upgrade offer; Safari,
 // Command Line Tools and similar = app (listed, but they do not make the OS outdated).
 const updates=(host.osUpdates.items||[]).map(u=>{const v=parseVersion(u.version||'');const isOs=/^macos/i.test(u.title);
  return {title:u.title,version:u.version,recommended:u.recommended,restart:u.restart,kind:isOs?(v&&v.nums[0]!==major?'major':'minor'):'app'};});
 const status=!host.osUpdates.checked?'unknown':updates.some(u=>u.kind==='minor')?'update':updates.some(u=>u.kind==='major')?'major':'current';
 return {name:host.os.name||'macOS',version:host.os.version||null,build:host.os.build||null,kernel:host.os.kernel?`Darwin ${host.os.kernel}`:null,updates,status,error:host.osUpdates.error||null};
}

// --- host protection checks ---------------------------------------------------------------------
// value and detail are Czech text, or tx()/sentences() objects: then the check also carries valueT / detailT.
const check=(id,label,state,value,detail='')=>({id,label,state,value:textOf(value),detail:textOf(detail),
 ...(typeof value==='object'&&value?{valueT:value.parts}:{}),...(typeof detail==='object'&&detail?{detailT:detail.parts}:{})});
function macChecks(host,os){
 const out=[],fw=num(host.firewall.global),a=host.autoUpdate,s=host.sshd;
 out.push(fw==null?check('firewall','Firewall (aplikační)','unknown','neověřeno'):fw===0?check('firewall','Firewall (aplikační)','warn','vypnutý','Příchozí spojení k aplikacím nic nefiltruje; spoléhá se na router.'):check('firewall','Firewall (aplikační)','ok',fw===2?'blokuje vše':'zapnutý',host.firewall.stealth==='on'?'Stealth mode zapnutý.':''));
 out.push(check('stealth','Stealth mode','info',host.firewall.stealth==='on'?'zapnutý':'vypnutý','Neodpovídá na ping a sondy zavřených portů.'));
 out.push(host.pf?.status==='unknown'||!host.pf?check('pf','Packet filter (pf)','unknown','neověřeno','pfctl potřebuje sudo.'):check('pf','Packet filter (pf)','info',host.pf.status==='enabled'?tx('zapnutý · {rules} pravidel',{rules:host.pf.rules??'?'}):'vypnutý','Výchozí kotvy Apple; vlastní pravidla žádná.'));
 out.push(check('filevault','FileVault (šifrování disku)',host.fileVault==='on'?'ok':host.fileVault==='off'?'crit':'unknown',host.fileVault==='on'?'zapnutý':host.fileVault==='off'?'vypnutý':'neověřeno'));
 out.push(check('sip','System Integrity Protection',host.sip==='on'?'ok':host.sip==='off'?'crit':'unknown',host.sip==='on'?'zapnutá':host.sip==='off'?'vypnutá':'neověřeno'));
 out.push(check('gatekeeper','Gatekeeper',host.gatekeeper==='on'?'ok':host.gatekeeper==='off'?'warn':'unknown',host.gatekeeper==='on'?'zapnutý':host.gatekeeper==='off'?'vypnutý':'neověřeno'));
 const sec=[a.CriticalUpdateInstall,a.ConfigDataInstall];
 out.push(check('security-responses','Automatické bezpečnostní opravy',sec.some(v=>v==='0')?'warn':'ok',sec.some(v=>v==='0')?'vypnuté':sec.every(v=>v==null)?'výchozí (zapnuté)':'zapnuté','Rapid Security Responses a systémové datové soubory.'));
 out.push(check('auto-macos','Automatická instalace macOS',a.AutomaticallyInstallMacOSUpdates==='1'?'ok':'info',a.AutomaticallyInstallMacOSUpdates==='1'?'zapnutá':'ručně',a.AutomaticDownload==='1'?'Stahování zapnuté.':''));
 const others=os.updates.filter(u=>u.kind!=='minor').map(u=>u.kind==='major'?`nabídka ${u.title}`:(u.title.includes(u.version)?u.title:`${u.title} ${u.version}`).trim());
 const more=list=>list.length?tx('Další: {others}.',{others:list.map(o=>o.replace(/^nabídka /,'')).join(', ')},`Další: ${list.join(', ')}.`):null;
 out.push(os.status==='update'?check('os-update','Aktualizace systému','warn',os.updates.filter(u=>u.kind==='minor').map(u=>u.title).join(', '),sentences('Čeká instalace ve stejné hlavní verzi.',more(others)))
  :os.status==='major'?check('os-update','Aktualizace systému','info',tx('nabídka {titles}',{titles:os.updates.filter(u=>u.kind==='major').map(u=>u.title).join(', ')}),sentences('Stejná řada je aktuální.',more(others.slice(1))))
  :os.status==='current'?check('os-update','Aktualizace systému','ok','aktuální'):check('os-update','Aktualizace systému','unknown','neověřeno',os.error||''));
 const pw=[s.passwordauthentication,s.kbdinteractiveauthentication];
 out.push(s.remotelogin==='off'?check('ssh-password','SSH přihlášení heslem','ok','SSH vypnuté')
  :pw.every(v=>v==null)?check('ssh-password','SSH přihlášení heslem','unknown','neověřeno','sshd -T potřebuje sudo.')
  :pw.some(v=>v==='yes')?check('ssh-password','SSH přihlášení heslem','warn','povolené',s.allowUsers.length?tx('Jen z adres v AllowUsers: {from}.',{from:[...new Set(s.allowUsers.map(x=>x.split('@')[1]||x))].join(', ')}):'Bez omezení AllowUsers.')
  :check('ssh-password','SSH přihlášení heslem','ok','jen klíče'));
 const shares=[['com.apple.screensharing','Sdílení obrazovky'],['com.apple.smbd','Sdílení souborů (SMB)'],['com.apple.RemoteDesktop.agent','Vzdálená správa (ARD)']].filter(([k])=>host.sharing[k]).map(([,l])=>l);
 out.push(check('sharing','Sdílení zapnuté',shares.length?'info':'ok',shares.length?tx('{items}',{items:shares}):'nic'));
 return out;
}
// Linux, from an agent: the distribution, and pending updates from the package manager's cached index (PKGUP). The
// status says "update" while anything is pending; securityUpdates counts the ones the index marks as security fixes.
function linuxSummary(host){
 const p=host.packageUpdates||null,items=p?.items||[];
 const updates=items.map(u=>({title:u.name,version:u.candidate,installed:u.installed,security:u.security,kind:'package'}));
 return {name:host.os.name||'Linux',version:host.os.version||null,build:null,base:host.os.base||null,kernel:host.os.kernel||null,updates,
  status:!p?.checked?'unknown':updates.length?'update':'current',securityUpdates:updates.filter(u=>u.security).length,
  channel:p?.manager||null,cacheAgeSeconds:p?.cacheAgeSeconds??null,error:p?.error||null};
}
// Windows, from an agent: the edition and build, and what Windows Update offers (WINUP).
function windowsSummary(host){
 const w=host.windowsUpdates||null;
 const updates=(w?.items||[]).map(u=>({title:u.title,version:u.kb,kb:u.kb,severity:u.severity,restart:u.restart,kind:'update'}));
 return {name:host.os.name||'Windows',version:host.os.version||null,build:host.os.build||null,kernel:host.os.kernel||null,updates,
  status:!w?.checked?'unknown':updates.length?'update':'current',error:w?.error||null};
}
// The nftables verdict for a Linux device: an input chain that drops or rejects is a firewall; accept-only or no
// input hook at all is unfiltered ingress. unknown says why it was not read.
function nftCheck(host,{unknown,acceptOnly}){
 const pol=(host.nft?.inputPolicies||[]).filter(p=>p.policy!=='none');
 if(host.nft?.unknown||!host.nft)return check('firewall','Firewall (nftables)','unknown','neověřeno',unknown);
 if(!pol.length)return check('firewall','Firewall (nftables)','warn','vstup nefiltrován',host.nft.tables?.length?tx('Žádný řetězec na vstupním hooku (tabulky {tables}); příchozí provoz nic nefiltruje, spoléhá se na router.',{tables:host.nft.tables.join(', ')})
  :'Žádný řetězec na vstupním hooku, ruleset je prázdný; příchozí provoz nic nefiltruje, spoléhá se na router.');
 if(pol.some(p=>['drop','reject'].includes(p.policy)))return check('firewall','Firewall (nftables)','ok',pol.map(p=>p.policy).join(', '));
 return check('firewall','Firewall (nftables)','warn','vstup povolen (accept)',acceptOnly);
}
// What a denied privileged read leaves unknown (PRIV <id> denied).
const denied=(host,id,why)=>host.privileged?.[id]===false?why:'';
function linuxChecks(host,os){
 const out=[],s=host.sshd,a=host.autoUpdate;
 out.push(nftCheck(host,{unknown:denied(host,'nft','nft list ruleset potřebuje sudo.'),acceptOnly:'Vstupní řetězce jen přijímají; příchozí provoz nic nefiltruje.'}));
 const pw=[s.passwordauthentication,s.kbdinteractiveauthentication];
 out.push(pw.every(v=>v==null)||s.effective==='unknown'?check('ssh-password','SSH přihlášení heslem','unknown','neověřeno',denied(host,'sshd','sshd -T potřebuje sudo.'))
  :pw.includes('yes')?check('ssh-password','SSH přihlášení heslem','warn','povolené',s.allowUsers.length?tx('Jen pro AllowUsers: {users}.',{users:s.allowUsers.join(', ')}):'Bez omezení AllowUsers.')
  :check('ssh-password','SSH přihlášení heslem','ok','jen klíče'));
 if(s.permitrootlogin)out.push(check('ssh-root','SSH jako root',s.permitrootlogin==='yes'?'warn':'info',s.permitrootlogin==='no'?'zakázáno':s.permitrootlogin==='without-password'||s.permitrootlogin==='prohibit-password'?'jen klíčem':s.permitrootlogin));
 const n=os.securityUpdates;
 out.push(os.error?check('security-updates','Bezpečnostní aktualizace','unknown','neověřeno',os.error)
  :os.status==='unknown'?check('security-updates','Bezpečnostní aktualizace','unknown','neověřeno','Správce balíčků nemá záznam, který by sonda četla.')
  :n?check('security-updates','Bezpečnostní aktualizace','warn',tx('čeká {n}',{n}),os.updates.filter(u=>u.security).slice(0,20).map(u=>u.title).join(', '))
  :check('security-updates','Bezpečnostní aktualizace','ok','žádné čekající'));
 out.push(os.status==='update'?check('os-update','Aktualizace balíčků','info',tx('balíčků: {n}',{n:os.updates.length}),os.cacheAgeSeconds!=null?tx('Index balíčků je {hours} h starý.',{hours:Math.round(os.cacheAgeSeconds/3600)}):'')
  :os.status==='current'?check('os-update','Aktualizace balíčků','ok','aktuální',os.cacheAgeSeconds!=null?tx('Index balíčků je {hours} h starý.',{hours:Math.round(os.cacheAgeSeconds/3600)}):'')
  :check('os-update','Aktualizace balíčků','unknown','neověřeno',os.error||''));
 const auto=a['unattended-upgrade']!==undefined?a['unattended-upgrade']:a['dnf-automatic-apply'];
 out.push(auto===undefined?check('auto-updates','Automatické aktualizace','unknown','neověřeno')
  :auto==='1'||auto==='yes'||auto==='true'?check('auto-updates','Automatické aktualizace','ok','zapnuté')
  :auto==null?check('auto-updates','Automatické aktualizace','info','nenastaveno')
  :check('auto-updates','Automatické aktualizace','warn','vypnuté'));
 return out;
}
function windowsChecks(host,os){
 const out=[],w=host.windows||{defender:null,signatureAgeDays:null,bitlocker:{},firewall:{},rdp:null};
 const age=w.signatureAgeDays;
 out.push(w.defender==='on'?check('defender','Microsoft Defender',age!=null&&age>7?'warn':'ok','zapnutý',age!=null?tx('Signatury jsou {days} d staré.',{days:age}):'')
  :w.defender==='off'?check('defender','Microsoft Defender','crit','vypnutý','Ochrana v reálném čase je vypnutá.'):check('defender','Microsoft Defender','unknown','neověřeno'));
 const vols=Object.entries(w.bitlocker),offVols=vols.filter(([,v])=>v==='off').map(([k])=>k);
 out.push(!vols.length||vols.every(([,v])=>v==='unknown')?check('bitlocker','BitLocker (šifrování disku)','unknown','neověřeno')
  :offVols.length?check('bitlocker','BitLocker (šifrování disku)','crit','vypnutý',tx('Nešifrované svazky: {volumes}.',{volumes:offVols.join(', ')}))
  :vols.every(([,v])=>v==='on')?check('bitlocker','BitLocker (šifrování disku)','ok','zapnutý',vols.map(([k])=>k).join(', '))
  :check('bitlocker','BitLocker (šifrování disku)','unknown','neověřeno'));
 const profiles=['domain','private','public'].filter(p=>w.firewall[p]),offProfiles=profiles.filter(p=>w.firewall[p]==='off');
 out.push(!profiles.length?check('firewall','Windows Firewall','unknown','neověřeno')
  :offProfiles.length?check('firewall','Windows Firewall','warn','vypnutý',tx('Vypnuté profily: {profiles}.',{profiles:offProfiles.join(', ')}))
  :profiles.every(p=>w.firewall[p]==='on')?check('firewall','Windows Firewall','ok','zapnutý',profiles.join(', '))
  :check('firewall','Windows Firewall','unknown','neověřeno'));
 out.push(w.rdp==='on'?check('rdp','Vzdálená plocha (RDP)','info','zapnutá'):w.rdp==='off'?check('rdp','Vzdálená plocha (RDP)','ok','vypnutá'):check('rdp','Vzdálená plocha (RDP)','unknown','neověřeno'));
 const restart=os.updates.some(u=>u.restart);
 out.push(os.status==='update'?check('os-update','Aktualizace systému',os.updates.some(u=>['Critical','Important'].includes(u.severity))?'warn':'info',tx('čeká {n}',{n:os.updates.length}),
   sentences(tx('{updates}',{updates:os.updates.slice(0,10).map(u=>u.kb).join(', ')}),restart?'Některá vyžaduje restart.':null))
  :os.status==='current'?check('os-update','Aktualizace systému','ok','aktuální'):check('os-update','Aktualizace systému','unknown','neověřeno',os.error||''));
 return out;
}
function nasChecks(host,os){
 // Snapshots written before inputHooks existed stored the probe's "none" as a policy; drop it.
 const out=[],pol=(host.nft?.inputPolicies||[]).filter(p=>p.policy!=='none'),s=host.sshd,ftp=host.services.find(x=>x.name==='ftp');
 out.push(host.nft?.unknown||!host.nft?check('firewall','Firewall (nftables)','unknown','neověřeno')
  :!pol.length?check('firewall','Firewall (nftables)','warn','vstup nefiltrován',host.nft.tables?.length?tx('Žádný řetězec na vstupním hooku (tabulky {tables}); příchozí provoz nic nefiltruje, spoléhá se na router.',{tables:host.nft.tables.join(', ')})
   :'Žádný řetězec na vstupním hooku, ruleset je prázdný; příchozí provoz nic nefiltruje, spoléhá se na router.')
  :pol.some(p=>['drop','reject'].includes(p.policy))?check('firewall','Firewall (nftables)','ok',pol.map(p=>p.policy).join(', '))
  :check('firewall','Firewall (nftables)','warn','vstup povolen (accept)',tx('Jen pravidla Dockeru a tabulky {tables}; TrueNAS vlastní firewall nemá.',{tables:host.nft.tables.filter(t=>!/^ip6? (nat|filter|raw)$/.test(t)).join(', ')||'—'})));
 out.push(ftp?.state==='RUNNING'?check('ftp','FTP',host.ftp?.tls?'info':'warn',host.ftp?.tls?'zapnuté (TLS)':'zapnuté bez šifrování',tx(host.ftp?.onlyAnonymous?'Port {port} na všech rozhraních, jen anonymně.':host.ftp?.onlyLocal?'Port {port} na všech rozhraních, jen místní účty.':'Port {port} na všech rozhraních, místní účty s heslem.',{port:host.ftp?.port??21}))
  :check('ftp','FTP','ok','vypnuté'));
 out.push(!s.passwordauthentication?check('ssh-password','SSH přihlášení heslem','unknown','neověřeno'):[s.passwordauthentication,s.kbdinteractiveauthentication].includes('yes')?check('ssh-password','SSH přihlášení heslem','warn','povolené'):check('ssh-password','SSH přihlášení heslem','ok','jen klíče'));
 out.push(check('ssh-root','SSH jako root','info',s.permitrootlogin==='no'?'zakázáno':s.permitrootlogin==='without-password'||s.permitrootlogin==='prohibit-password'?'jen klíčem':s.permitrootlogin||'?'));
 out.push(check('ssh-forwarding','SSH přesměrování portů',s.allowtcpforwarding==='no'?'ok':'info',s.allowtcpforwarding==='no'?'zakázáno':s.allowtcpforwarding||'?'));
 out.push(os.status==='update'?check('os-update','Aktualizace TrueNAS','warn',os.updates[0]?.version||'?',/CVE|security/i.test(os.updates[0]?.notes||'')?tx('Bezpečnostní vydání: {notes}',{notes:(os.updates[0]?.notes||'').slice(0,240)}):(os.updates[0]?.notes||'').slice(0,240))
  :os.status==='current'?check('os-update','Aktualizace TrueNAS','ok','aktuální'):check('os-update','Aktualizace TrueNAS','unknown','neověřeno'));
 const shares=host.services.filter(x=>x.state==='RUNNING'&&['cifs','nfs','iscsitarget','webdav','rsync','snmp'].includes(x.name)).map(x=>({cifs:'SMB',nfs:'NFS',iscsitarget:'iSCSI'})[x.name]||x.name.toUpperCase());
 out.push(check('sharing','Sdílení zapnuté',shares.length?'info':'ok',shares.join(', ')||'nic'));
 return out;
}

// --- push agents ---------------------------------------------------------------------------------
// docs/agent.md §3 → Who wins over the collectors. Per device, between the collector's record C and the agent's A:
// 1. current: C when complete, not stale and younger than the collector's stale-after (7.5 h); A while it is fresh
//    (receivedAt + 3 × interval). If only one is current, it wins; if neither, the newer, shown stale.
// 2. coverage: when both are current, A wins only if it covers at least what C covers (systems: C with HOST root 1
//    covers every privileged read of its kind, with 0 none; A the ids its PRIV lines report ok and whose records it
//    carries; SSH keys: HOST root).
// 3. time: otherwise the newer wins, a tie to the agent. A's time is receivedAt (the hub's clock); C's the earlier of
//    its probedAt and its file's modification time (the hub's clock), so a collector clock ahead cannot win. A
//    collector record that never carried a probe (the placeholder of a device never reached) has no time: it loses.
// c and a: {current, time (ms)} or null; a.covers as in 2.
export function pickSource(c,a){
 if(!a)return c?'collector':null;
 if(!c)return 'agent';
 if(c.current!==a.current)return c.current?'collector':'agent';
 if(c.current&&!a.covers)return 'collector';
 const ct=Number.isFinite(c.time)?c.time:-Infinity,at=Number.isFinite(a.time)?a.time:-Infinity;
 return at>=ct?'agent':'collector';
}
// A collector record's time in ms: the earlier of its probedAt (the collecting host's clock when the probe came
// back) and the file's modification time. A record written before probedAt existed has the earlier of the file's
// collectedAt and its own HOST time (a record kept from an earlier run is no newer than that run). A record with
// neither never carried a probe (collect-systems' placeholder for a device it could not reach): NaN, no time at all.
export function collectorTime(record,{collectedAt=null,fileTime=null}={}){
 const probed=Date.parse(record?.probedAt),host=Date.parse(record?.collectedAt);
 const own=Number.isFinite(probed)?[probed]:Number.isFinite(host)?[host,Date.parse(collectedAt)]:[];
 if(!own.length)return NaN;
 return Math.min(...[...own,fileTime==null?NaN:Number(fileTime)].filter(Number.isFinite));
}
const newestOf=list=>list.filter(v=>Number.isFinite(Date.parse(v))).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null;
export const READER_KINDS=Object.freeze({macos:'mac',linux:'linux',windows:'windows'});
const PLATFORM_OF={mac:'macos',linux:'linux',windows:'windows'};
// The privileged reads of the systems probe of a reader kind (ssh-probe is the SSH key probe's).
const systemsPrivileged=kind=>privilegedIds(PLATFORM_OF[kind]).filter(id=>id!=='ssh-probe');
// What a privileged read leaves in the record when it ran: `PRIV <id> ok` counts towards coverage only with it, so a
// report cannot look more complete than the records it carries.
const READ_RECORDS={
 sshd:h=>Object.keys(h.sshd||{}).some(k=>!['remotelogin','effective','allowUsers'].includes(k))||Boolean(h.sshd?.allowUsers?.length),
 listen:h=>h.listening.length>0,
 'pf-info':h=>Boolean(h.pf)&&h.pf.status!=='unknown',
 'pf-rules':h=>h.pf?.rules!=null,
 nft:h=>Boolean(h.nft)&&!h.nft.unknown};
export const covered=(h,id)=>h.privileged?.[id]===true&&(READ_RECORDS[id]?.(h)??true);
/**
 * One agent's systems record: parseSystemsProbe(os + updates + packages) with the hub's receive time in place of the
 * HOST time (the device's own value kept as deviceCollectedAt; the macOS uptime is worked out first, from two values
 * of the device's own clock), stale while it is no news. → the record, or null without an os part.
 */
export function agentSystemsHost(record,{now=Date.now()}={}){
 const parts=record?.parts||{},os=parts.os;
 if(!os||!Array.isArray(os.records)||!READER_KINDS[record.platform])return null;
 const h=parseSystemsProbe(SYSTEMS_PARTS.flatMap(n=>Array.isArray(parts[n]?.records)?parts[n].records:[]).join('\n'));
 const fresh=freshUntil(os)>now;
 const withheld=SYSTEMS_PARTS.flatMap(n=>(Array.isArray(parts[n]?.withheld)?parts[n].withheld:[]).map(w=>({part:n,tag:w.tag,field:w.field,reason:w.reason,count:w.count})));
 return {...h,deviceCollectedAt:h.collectedAt,collectedAt:os.receivedAt,source:'agent',stale:!fresh,lastError:null,kind:READER_KINDS[record.platform],fresh,withheld};
}
// One device's agent record that cannot be read is left out (its collector record stands), never the whole answer.
const readable=(record,now)=>{try{return agentSystemsHost(record,{now});}catch{return null;}};
function joinAgents({snapshot,probed,agents,now,snapshotTime}){
 const usable=(Array.isArray(agents)?agents:[]).map(e=>({id:e?.id,name:e?.name,host:readable(e?.record,now)})).filter(x=>typeof x.id==='string'&&x.host);
 if(!usable.length)return null;
 const hosts={...(snapshot?.devices||{})},sources={},list=probed.map(m=>({...m})),limit=staleAfter(COLLECTORS.systems)*1000;
 for(const {id,name,host:a} of usable){
  let m=list.find(x=>x.id===id);
  if(m?.kind==='nas')continue;// the NAS stays agent-less: it never has two reader kinds
  const C=m?snapshot?.devices?.[id]:null,cTime=C?collectorTime(C,{collectedAt:snapshot?.collectedAt,fileTime:snapshotTime}):NaN;
  const c=C?{current:Boolean(C.complete)&&!C.stale&&Number.isFinite(cTime)&&now-cTime<=limit,time:cTime}:null;
  const need=C?.root?systemsPrivileged(m.kind||'mac'):[];
  const winner=pickSource(c,{current:a.fresh,time:Date.parse(a.collectedAt),covers:need.every(p=>covered(a,p))});
  if(!m){m={id,name:name||id,kind:a.kind};list.push(m);}
  const {fresh,kind,withheld,source,...record}=a;
  if(winner==='agent'){hosts[id]=record;m.kind=kind;sources[id]={source:'agent',sourceAt:a.collectedAt,deviceCollectedAt:a.deviceCollectedAt,withheld};}
  else{if(!c.current)hosts[id]={...C,stale:true};sources[id]={source:'collector',sourceAt:Number.isFinite(cTime)?new Date(cTime).toISOString():null};}
 }
 const fresh=usable.filter(x=>x.host.fresh).length;
 return {hosts,list,sources,agentTimes:usable.map(x=>x.host.collectedAt),agents:{devices:usable.length,fresh,noNews:usable.length-fresh}};
}

// One device's line of the trend (history.jsonl of the collector, <state>/agent/history.jsonl of the agents).
export const historyEntry=m=>({os:m.summary.osUpdate,software:m.summary.softwareUpdates,apps:m.summary.appUpdates,warn:m.summary.checks.warn,crit:m.summary.checks.crit,stale:m.stale});

// --- payload ------------------------------------------------------------------------------------
// Snapshots collected before the macOS probe read kern.boottime correctly hold an uptime of decades
// (the boot time's microseconds were taken for its seconds). Such a value is not shown.
const plausibleUptime=s=>Number.isFinite(s)&&s>=0&&s<20*365*86400?s:null;
// collector (additive): where the two snapshots stand (collector-state.mjs) and where the watch list comes from.
// provenance (additive): the same as sources (server/provenance.mjs): the device snapshot (id systems), the
// release check (id upstream) and the watch list file (id watch), so a page can show the part it draws.
//
// agents (docs/agent.md §3 → Who wins over the collectors): [{id, name, record}], the push agents' stored reports
// (server/agent-store.mjs) of devices that exist now. Without any, the answer is what the collector alone gives,
// byte for byte. snapshotTime: the snapshot file's modification time (ms, the hub's clock).
export function buildSystems({snapshot,upstream,registry,devices:probed=systemDevices(loadedSite()),now=Date.now(),watchSource=null,watchFile=null,agents=[],snapshotTime=null}){
 const joined=joinAgents({snapshot,probed,agents,now,snapshotTime});
 const devices=joined?joined.hosts:snapshot?.devices||{},list=joined?joined.list:probed;
 const software=softwareRows(registry||{items:[]},devices,upstream);
 const out=list.map(m=>{
  const host=devices[m.id],from=joined?.sources[m.id]||null;
  if(!host)return {...m,reachable:false,stale:false,error:'Zatím neprozkoumáno.',os:null,checks:[],listening:[],brewOutdated:[],summary:null};
  const kind=kindOf(host,m.kind),os=osSummary(host,kind),checks=kind==='nas'?nasChecks(host,os):kind==='linux'?linuxChecks(host,os):kind==='windows'?windowsChecks(host,os):macChecks(host,os);
  const exposed=host.listening.filter(l=>l.scope!=='loopback');
  const ports=new Set(exposed.map(l=>l.port)).size;
  checks.push(check('exposed','Porty otevřené do sítě',exposed.length?'info':'ok',tx('Portů: {n}',{n:ports},`${ports} portů`),[...new Set(exposed.map(l=>`${l.port} ${l.proc}`))].sort((x,y)=>parseInt(x)-parseInt(y)).slice(0,40).join(' · ')));
  const rows=software.filter(r=>r.device===m.id);
  const count=(list,st)=>list.filter(x=>x.state===st).length;
  return {...m,reachable:Boolean(host.complete),stale:Boolean(host.stale),error:host.lastError||(host.errors||[])[0]||null,collectedAt:host.collectedAt,
   hw:{model:host.hw.model||null,cpu:host.hw.cpu||null,ramGb:host.hw.memBytes?Math.round(host.hw.memBytes/1e9):null,cpus:host.hw.cpus},uptimeSeconds:plausibleUptime(host.uptimeSeconds),
   os,checks,listening:host.listening,brewOutdated:host.brewOutdated||[],
   summary:{osUpdate:os.status==='update'?1:0,softwareUpdates:rows.filter(r=>r.status==='update'&&!['nas-apps','containers'].includes(r.category)).length,
    appUpdates:rows.filter(r=>r.status==='update'&&r.category==='nas-apps').length,unknown:rows.filter(r=>['unknown'].includes(r.status)).length,
    checks:{ok:count(checks,'ok'),warn:count(checks,'warn'),crit:count(checks,'crit'),info:count(checks,'info'),unknown:count(checks,'unknown')}},
   // Only for a device an agent reports on: which record won and its time (docs/agent.md §3).
   ...(from||{})};
 });
 const times=out.map(m=>m.collectedAt).filter(Boolean).sort();
 // The collector's own time: without agents, as it always was; with them, from the devices the collector's records won.
 const collectorTimes=joined?out.filter(m=>joined.sources[m.id]?.source!=='agent').map(m=>m.collectedAt).filter(Boolean).sort():times;
 const collectorAt=snapshot?.collectedAt||collectorTimes.at(-1)||null;
 const collectedAt=joined?newestOf([collectorAt,...joined.agentTimes]):collectorAt;
 const items=(registry?.items||[]).length;
 const collector={...collectorState('systems',{configured:probed.length>0,collectedAt:collectorAt,now}),
   upstream:collectorState('upstream',{configured:items>0,collectedAt:upstream?.checkedAt||null,now}),
   watch:{source:watchSource,items},...(joined?{agents:joined.agents}:{})};
 const collected=joined?out.filter(m=>m.reachable&&joined.sources[m.id]?.source!=='agent').length:out.filter(m=>m.reachable).length;
 return {schemaVersion:SYSTEMS_SCHEMA,generatedAt:new Date(now).toISOString(),collectedAt,oldestCollectedAt:times[0]||null,
  collectedFrom:snapshot?.collectedFrom||null,upstreamCheckedAt:upstream?.checkedAt||null,
  upstreamFailed:Object.values(upstream?.results||{}).filter(r=>r&&(r.stale||!r.ok)).length,categories:{...(registry?.categories||{}),'nas-apps':'Aplikace na NAS','containers':'Kontejnery (Docker)'},
  devices:out,software,
  collector,
  provenance:provenance([
   collectorSource(collector,{id:'systems',run:readRun(snapshot?.run),host:snapshot?.collectedFrom||'',count:collected,unit:'devices'}),
   joined?{kind:'telemetry',id:'agents',source:'push agent',count:joined.agents.devices,unit:'devices',lastAt:newestOf(joined.agentTimes)}:null,
   items||upstream?collectorSource(collector.upstream,{id:'upstream',run:readRun(upstream?.run),count:Object.keys(upstream?.results||{}).length,unit:'sources'}):null,
   watchSource==='local'?{kind:'config',id:'watch',source:watchFile||'software-watch.json',count:items,unit:'items'}:null])};
}
// What the versions and protection pages need before there is a snapshot: is anything configured, and what.
export function systemsSetup(site,{now=Date.now()}={}){
 const probed=systemDevices(site);
 return {...collectorState('systems',{configured:probed.length>0,now}),devices:probed,siteDevices:site.devices.length};
}

// upstream:false leaves upstream.json unread (the release check is turned off: server/core/security.mjs).
export const systemsDirectory=directory=>process.env.SYSTEMS_DIR||path.join(directory,'systems');
// agents: as for buildSystems. null only when there is neither a snapshot nor an agent's os part.
export async function loadSystems(directory,{registryFile=watchPath(),site=loadedSite(),now=Date.now(),upstream:withUpstream=true,agents=[]}={}){
 const dir=systemsDirectory(directory),file=path.join(dir,'snapshot.json');
 const reporting=(Array.isArray(agents)?agents:[]).filter(e=>e?.record?.parts?.os);
 // Only a snapshot that is not there yet leaves the agents' devices alone; one that cannot be read is null, as before.
 let snapshot=null;try{snapshot=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT'||!reporting.length)return null;}
 const snapshotTime=reporting.length&&snapshot?(await stat(file).catch(()=>null))?.mtimeMs??null:null;
 const upstream=withUpstream?await readFile(path.join(dir,'upstream.json'),'utf8').then(JSON.parse).catch(()=>null):null;
 const watch=await readWatch({file:registryFile});
 // The watch list by the name people know it under: its path inside the checkout, else just the file name.
 const rel=registryFile?path.relative(path.resolve(import.meta.dirname,'..'),registryFile):'',watchFile=!registryFile?null:rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel:path.basename(registryFile);
 return buildSystems({snapshot,upstream,registry:watch.registry,devices:systemDevices(site),now,watchSource:watch.source,watchFile,agents:reporting,snapshotTime});
}
