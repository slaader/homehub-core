// Security section: SSH key inventory. The collector (scripts/collect-security.mjs) runs
// scripts/security/ssh-probe.sh on every machine, then buildSecurity() joins the records:
// each private key (by SHA256 fingerprint) → where its copies live, who owns them, and what
// it opens (authorized_keys entries, Forgejo account and deploy keys, ssh config routes).
// No private key material ever reaches this module: the probe sends fingerprints, paths and
// public authorized_keys lines only.
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {site as loadedSite} from './site-config.mjs';
import {tx,sentences,textOf} from './text.mjs';
import {collectorState,staleAfter,COLLECTORS} from './collector-state.mjs';
import {freshUntil} from './agent-report.mjs';
import {pickSource,collectorTime} from './systems-data.mjs';
import {loadMachineDescriptors} from './home-data.mjs';
import {machineIds} from './site-config.mjs';
import {fingerprintOf,parseAuthorizedLine,parseKeygenLine} from './ssh-lines.mjs';
// The line parsers live in server/ssh-lines.mjs (a leaf module the push agent shares); re-exported here.
export {fingerprintOf,parseAuthorizedLine,parseKeygenLine};

export const SECURITY_SCHEMA=1;
// probes.json beside ssh-keys.json (scripts/collect-security.mjs): the collector's raw probe output per machine, so the
// hub can rebuild the inventory with the push agents' sshkeys parts (docs/agent.md §3 → Who wins over the collectors).
//   {schemaVersion: 1, collectedAt, collectedFrom, probes: {id: {text, probedAt} | {error}}, forgejo, extraMachines}
export const SECURITY_PROBES_SCHEMA=1;
const clean=(v,n=400)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';

// sudo -l rule lines → one verdict. "(ALL) ALL, NOPASSWD: ALL" means password-less root.
export function sudoVerdict(account,now=Date.now()){
 if(account.user==='root'||account.uid===0)return {level:'root',commands:[],expired:[]};
 if(account.sudoState==='none')return {level:'none',commands:[],expired:[]};
 if(account.sudoState==='unknown')return {level:'unknown',commands:[],expired:[],detail:account.sudoDetail||''};
 let nopassAll=false,passAll=false;const commands=[],expired=[];
 for(const raw of account.sudoRules||[]){
  let rule=raw.replace(/^\([^)]*\)\s*/,'');
  const until=/NOTAFTER=(\d{14})Z\s*/.exec(rule);
  if(until){const t=Date.parse(until[1].replace(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/,'$1-$2-$3T$4:$5:$6Z'));if(Number.isFinite(t)&&t<now){expired.push(raw);continue;}rule=rule.replace(until[0],'');}
  rule=rule.replace(/\b(NOTBEFORE|TIMEOUT)=\S+\s*/g,'');
  let nopass=false;
  for(let part of rule.split(',').map(s=>s.trim()).filter(Boolean)){
   for(;;){const tag=/^(NOPASSWD|PASSWD|SETENV|NOSETENV|NOEXEC|EXEC|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW|INTERCEPT|NOINTERCEPT):\s*/.exec(part);if(!tag)break;
    if(tag[1]==='NOPASSWD')nopass=true;else if(tag[1]==='PASSWD')nopass=false;part=part.slice(tag[0].length);}
   if(part==='ALL'){if(nopass)nopassAll=true;else passAll=true;}
   else if(nopass)commands.push(part);
  }
 }
 const level=nopassAll?'nopasswd':passAll?'password':commands.length?'limited':'none';
 return {level,commands:[...new Set(commands)].slice(0,12),expired};
}

export function parseProbe(text){
 // sshd is keyed by the record's own text, so it is filled without a prototype: `SSHD constructor …` is an entry,
 // never a lookup into Object.prototype.
 const host={name:'',os:'',user:'',root:false,at:null,ips:[],listening:null,accessGroup:null,sshd:Object.create(null),accounts:[],auth:[],routes:[],keys:[],complete:false};
 const accounts=new Map();
 const account=u=>{if(!accounts.has(u))accounts.set(u,{user:u,uid:null,home:'',shell:'',hasSsh:false,sudoState:'rules',sudoRules:[],sudoDetail:''});return accounts.get(u);};
 for(const line of String(text).split('\n')){
  const f=line.split('\t');const tag=f[0];
  if(tag==='HOST'){host.name=clean(f[1],80);host.os=clean(f[2],20);host.user=clean(f[3],64);host.root=f[4]==='1';host.at=clean(f[5],40)||null;}
  else if(tag==='NET')host.ips=f.slice(1).map(s=>clean(s,40)).filter(s=>/^\d+\.\d+\.\d+\.\d+$/.test(s));
  else if(tag==='LISTEN')host.listening=f[1]==='on';
  else if(tag==='ACCESSGROUP')host.accessGroup=f.slice(1).map(s=>clean(s,64)).filter(Boolean);
  else if(tag==='SSHD'){const k=clean(f[1],40).toLowerCase(),v=clean(f[2],400);(host.sshd[k]??=[]).push(v);}
  else if(tag==='USER'){const a=account(clean(f[1],64));a.uid=Number(f[2]);a.home=clean(f[3],300);a.shell=clean(f[4],120);a.hasSsh=f[5]==='1';}
  else if(tag==='SUDO'){const a=account(clean(f[1],64));if(f[2]==='rule')a.sudoRules.push(clean(f[3],600));else{a.sudoState=f[2]==='none'?'none':'unknown';a.sudoDetail=clean(f[3],200);}}
  else if(tag==='AUTH'){const parsed=parseAuthorizedLine(f.slice(3).join('\t'));if(parsed)host.auth.push({user:clean(f[1],64),file:clean(f[2],300),...parsed});}
  else if(tag==='CFG')host.routes.push({user:clean(f[1],64),alias:clean(f[2],120),hostname:clean(f[3],200),port:Number(f[4])||22,remoteUser:clean(f[5],64),
   identityFiles:clean(f[6],2000).split('|').filter(Boolean),proxyJump:clean(f[7],200)||null,identitiesOnly:f[8]==='yes'});
  else if(tag==='KEY'){const kg=parseKeygenLine(f[7]||'');
   host.keys.push({path:clean(f[1],400),mode:clean(f[2],6),owner:clean(f[3],64),mtime:Number(f[4])?new Date(Number(f[4])*1000).toISOString():null,
    format:clean(f[5],40)||'PKCS8',encrypted:f[6]==='yes'?true:f[6]==='no'?false:null,...(kg||{fingerprint:null,bits:null,comment:'',type:null})});}
  else if(tag==='END')host.complete=true;
 }
 host.accounts=[...accounts.values()];
 host.sshd=Object.fromEntries(Object.entries(host.sshd));// an ordinary object, the inherited names its own keys
 return host;
}

// What a private key file is for, from where it lives. Anything else with a fingerprint is a
// client SSH key. Server host keys and TLS/JWT keys go to the "other keys" list.
// certificates: [{match, label}] from site.json → security.certificates, for TLS keys the site wants named.
export function classifyKey(file,hasFingerprint,certificates=loadedSite().security.certificates){
 const p=file.toLowerCase();
 if(/\/(forgejo|gitea)\/data\/ssh\//.test(p)||/ssh_host_[a-z0-9]+_key$/.test(p))return {kind:'ssh-host',label:/forgejo/.test(p)?'Forgejo SSH server – klíč hostitele':/gitea/.test(p)?'Gitea SSH server (starý) – klíč hostitele':'SSH server – klíč hostitele'};
 if(/\/(jwt|actions_id_token)\//.test(p))return {kind:'signing',label:/forgejo/.test(p)?'Forgejo – podpis tokenů':/gitea/.test(p)?'Gitea (starý) – podpis tokenů':'podpis tokenů'};
 if(/\/\.t3\/userdata\/secrets\//.test(p))return {kind:'app',label:'T3 Code – identita pro cloud link'};
 if(/(\/certs?\/|\/certificates\/|privkey\.pem$|server\.key$|\.key$)/.test(p)&&!/\/\.ssh\//.test(p))return {kind:'tls',label:/truenas/.test(p)?'TrueNAS – HTTPS certifikát':/home-hub/.test(p)?'Home Hub – HTTPS certifikát':certificates.find(c=>new RegExp(c.match).test(p))?.label||'TLS certifikát'};
 if(hasFingerprint)return {kind:'ssh',label:'SSH klíč'};
 return {kind:'other',label:'privátní klíč'};
}
const isBackupPath=p=>/(\/backups?[-_/]|\.bak|retired|\.old$)/i.test(p);
// ssh-keygen prints non-ASCII comment bytes as \ooo escapes; decode them, and drop comments that
// are still mojibake (a hostname typed with a broken encoding) so the UI shows the file name.
export function readableComment(comment){
 const raw=String(comment||'');
 const bytes=[];for(let i=0;i<raw.length;i++){const m=/^\\([0-7]{3})/.exec(raw.slice(i));if(m){bytes.push(parseInt(m[1],8));i+=3;}else bytes.push(...Buffer.from(raw[i]));}
 const text=Buffer.from(bytes).toString('utf8');
 return /�|ï¿½|[\u0080-\u009f]/.test(text)?'':clean(text,200);
}

// How well a key type holds up today, from what ssh-keygen -l prints (type name and bits):
// weak = replace it (DSA, RSA under 2048 bits, ECDSA under 256), legacy = fine for now but not for a new
// key (RSA under 3072 bits), ok = everything else, null = the probe could not read the type.
export function keyStrength(type,bits){
 const t=String(type||'').toUpperCase().replace(/-SK$/,''),n=Number(bits)||0;
 if(!t)return null;
 if(t==='DSA'||t==='DSS')return 'weak';
 if(t==='RSA')return n<2048?'weak':n<3072?'legacy':'ok';
 if(t==='ECDSA')return n&&n<256?'weak':'ok';
 return 'ok';
}
// A finding: level, the key it is about, and a Czech title and detail. A title or detail built with
// tx()/sentences() also leaves its translatable parts in titleT / detailT (server/text.mjs).
const finding=(level,title,detail='',key)=>({level,...(key?{key}:{}),title:textOf(title),detail:textOf(detail),
 ...(title?.parts?{titleT:title.parts}:{}),...(detail?.parts?{detailT:detail.parts}:{})});

const privateIp=ip=>/^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./.test(ip);
// Who is who: names, host names and addresses from the site configuration, refined by the collected
// machine descriptors (data/machines/*.json) and, for a machine neither knows, by what its probe reports.
function machineIndex(descriptors,probes,site){
 const byName=new Map(),machines=new Map();
 for(const m of site?.machines||[])machines.set(m.id,{id:m.id,name:m.name||m.id,hostname:m.hostname||'',ips:m.ip?[m.ip]:[]});
 for(const d of Array.isArray(descriptors)?descriptors:Object.values(descriptors||{})){
  if(!d?.id)continue;
  const ips=(d.addresses||[]).map(a=>a?.ip).filter(ip=>typeof ip==='string'&&/^\d+\.\d+\.\d+\.\d+$/.test(ip));
  const known=machines.get(d.id);
  machines.set(d.id,{id:d.id,name:d.name||known?.name||d.id,hostname:d.hostname||known?.hostname||'',ips:ips.length?ips:known?.ips||[]});
 }
 // A push agent's probe names neither itself nor its addresses here (HOST name, NET): what one machine says about
 // itself never decides which machine another machine's route reaches.
 for(const [id,p] of Object.entries(probes)){
  const m=machines.get(id)||{id,name:id,hostname:'',ips:[]};
  if(!m.ips.length&&p.host&&!p.agent)m.ips=p.host.ips.filter(privateIp);
  machines.set(id,m);
 }
 for(const m of machines.values()){
  for(const n of [m.id,m.hostname,m.hostname.split('.')[0],...m.ips,probes[m.id]?.agent?null:probes[m.id]?.host?.name].filter(Boolean))byName.set(String(n).toLowerCase(),m.id);
 }
 // ssh config often spells an id with a hyphen (mini-server for mini_server).
 for(const id of [...machines.keys()])if(id.includes('_')&&!byName.has(id.replaceAll('_','-')))byName.set(id.replaceAll('_','-'),id);
 return {machines,byName};
}

// Resolve an ssh config route to what it reaches.
// forgejoMachine = the machine whose disk holds the Forgejo SSH host key; git remotes there are
// ssh://git@<it>:2222, so a Host block for that machine also picks the key git uses.
function resolveRoute(route,fromMachine,index,forgejoHost,forgejoMachine){
 const host=route.hostname.toLowerCase(),machine=index.byName.get(host);
 if(host===forgejoHost||machine&&machine===forgejoMachine&&(route.port===2222||route.remoteUser==='git'||machine===fromMachine))
  return {kind:'forgejo',label:'Forgejo (git)'};
 if(host==='github.com'||host==='ssh.github.com')return {kind:'external',label:'GitHub'};
 if(host==='gitlab.com')return {kind:'external',label:'GitLab'};
 if(['127.0.0.1','localhost','::1'].includes(host))return route.port===22?{kind:'host',machine:fromMachine}:{kind:'local',label:`${route.alias} – lokální VM na ${fromMachine} (port ${route.port})`};
 return machine?{kind:'host',machine}:{kind:'external',label:route.hostname};
}

const expandHome=(file,home)=>file.startsWith('~/')?path.posix.join(home,file.slice(2)):file;

/**
 * probes: {machineId: {text}|{error}}; forgejo: {url, host, users:[{login,isAdmin,keys:[{title,key|fingerprint}]}], deployKeys:[{repo,title,key|fingerprint,readOnly}]}|null
 * router: {id, sshOpen:boolean}|null; descriptors: data/machines/*.json
 * A probe joined from a push agent also carries {agent: true, receivedAt}: its HOST time is replaced by receivedAt
 * (the machine's own value kept as machineCollectedAt), and its HOST name and NET decide nothing (machineIndex). What
 * it adds to a key (a copy, an authorized_keys access, a route) carries source: "agent", so a key row can tell what
 * the machine said about itself from what the collector read. A
 * probe with source ("collector" | "agent") and sourceAt says which record won for that machine; without, the
 * machine is as it always was. An agent's that won also says whether it is no news (stale: past receivedAt + 3 ×
 * interval), so the page can say so instead of showing it as current.
 */
export function buildSecurity({probes:rawProbes={},forgejo=null,extraMachines=[],descriptors=[],collectedFrom='',now=Date.now(),site=loadedSite()}){
 const probes={};
 for(const [id,p] of Object.entries(rawProbes)){
  if(p?.text==null){probes[id]={error:clean(p?.error||'nedostupné',300)};continue;}
  const host=parseProbe(p.text);
  if(p.agent){host.machineAt=host.at;host.at=p.receivedAt||null;}
  probes[id]={host,agent:Boolean(p.agent),...(p.source?{from:{source:p.source,sourceAt:p.sourceAt??null,...(p.agent?{machineCollectedAt:host.machineAt,stale:p.stale===true}:{})}}:{})};
 }
 const index=machineIndex(descriptors,probes,site);
 const forgejoHost=(forgejo?.host||site.security.gitHost||'').toLowerCase();
 const machines=[],keys=new Map(),otherKeys=[],unknownAuthorized=[],findings=[];
 // The label comes from the primary copy (not a backup); unreadable comments fall back to the file name.
 const keyFor=(fp,meta,copy)=>{
  if(!keys.has(fp))keys.set(fp,{id:fp,fingerprint:fp,type:meta.type||null,bits:meta.bits||null,name:'',comment:'',copies:[],access:[],routes:[]});
  const k=keys.get(fp),primary=!copy.backup;
  if(!k.name||primary&&k.copies.every(c=>c.backup)){k.name=path.posix.basename(copy.path);const c=readableComment(meta.comment);if(c||primary)k.comment=c;}
  return k;};

 // 1. machines, accounts and the private key files on them
 for(const [id,p] of Object.entries(probes)){
  const m=index.machines.get(id);
  if(p.error){machines.push({id,name:m.name,ips:m.ips,hostname:m.hostname,reachable:false,error:p.error,accounts:[],ssh:null});continue;}
  const h=p.host,sshd=h.sshd,mark=p.agent?{source:'agent'}:{};
  const one=k=>sshd[k]?.[0]??null;
  const accounts=h.accounts.map(a=>({user:a.user,uid:a.uid,home:a.home,shell:a.shell,sudo:sudoVerdict(a,now),authorizedKeys:[]}));
  machines.push({id,name:m.name,ips:m.ips,hostname:m.hostname,reachable:true,os:h.os,probedAs:h.user,complete:h.complete,collectedAt:h.at,
   ssh:{listening:h.listening,passwordAuth:one('passwordauthentication')==null?null:one('passwordauthentication')==='yes',kbdInteractive:one('kbdinteractiveauthentication')==='yes',
    rootLogin:one('permitrootlogin'),allowUsers:[...new Set(sshd.allowusers||[])],accessGroup:h.accessGroup},accounts,...(p.from||{})});
  for(const k of h.keys){
   const cls=classifyKey(k.path,Boolean(k.fingerprint));
   const copy={machine:id,owner:k.owner,path:k.path,mode:k.mode,mtime:k.mtime,encrypted:k.encrypted,backup:isBackupPath(k.path),...mark};
   if(cls.kind==='ssh'){keyFor(k.fingerprint,k,copy).copies.push(copy);}
   else otherKeys.push({...copy,kind:cls.kind,label:cls.label,fingerprint:k.fingerprint,type:k.type,bits:k.bits});
  }
 }
 const machineById=new Map(machines.map(m=>[m.id,m]));
 const forgejoMachine=otherKeys.find(o=>o.kind==='ssh-host'&&/\/forgejo\//.test(o.path))?.machine||null;
 const accountOf=(machine,user)=>machineById.get(machine)?.accounts.find(a=>a.user===user)||null;

 // 2. authorized_keys: what each fingerprint opens
 for(const [id,p] of Object.entries(probes)){
  if(p.error)continue;
  const mark=p.agent?{source:'agent'}:{};
  for(const e of p.host.auth){
   const acct=accountOf(id,e.user);
   // Only a forced command="..." constrains what the key can run. `restrict` disables forwarding,
   // agent/X11 and the PTY but still runs any command (a shell via `ssh host sh`), so it must not
   // silence root/sudo or unrestricted-address warnings; it is reported separately as noForwarding.
   const restricted=Boolean(e.options.command),noForwarding=Boolean(e.options.restrict);
   const entry={fingerprint:e.fingerprint,type:e.type,comment:readableComment(e.comment),from:e.options.from,command:e.options.command,restricted,noForwarding,permitOpen:e.options.permitOpen,flags:e.options.flags,file:e.file,known:keys.has(e.fingerprint)};
   acct?.authorizedKeys.push(entry);
   const target={kind:'host',machine:id,user:e.user,ips:machineById.get(id)?.ips||[]};
   if(keys.has(e.fingerprint))keys.get(e.fingerprint).access.push({target,entryComment:entry.comment,from:e.options.from,command:e.options.command,restricted,noForwarding,permitOpen:e.options.permitOpen,sudo:acct?.sudo?.level||'unknown',via:'authorized_keys',...mark});
   else unknownAuthorized.push({machine:id,user:e.user,...entry});
  }
 }

 // 3. Forgejo: account keys (full account) and deploy keys (one repository)
 const forgejoUnknown=[];
 if(forgejo){
  for(const u of forgejo.users||[])for(const k of u.keys||[]){
   const fp=k.fingerprint||(k.key?parseAuthorizedLine(k.key)?.fingerprint:null);if(!fp)continue;
   const target={kind:'forgejo',account:u.login,admin:Boolean(u.isAdmin),title:clean(k.title,120)};
   if(keys.has(fp))keys.get(fp).access.push({target,from:[],command:null,restricted:false,sudo:u.isAdmin?'forgejo-admin':'forgejo-user',via:'forgejo'});
   else forgejoUnknown.push({...target,fingerprint:fp});
  }
  for(const k of forgejo.deployKeys||[]){
   const fp=k.fingerprint||(k.key?parseAuthorizedLine(k.key)?.fingerprint:null);if(!fp)continue;
   const target={kind:'forgejo-deploy',repo:clean(k.repo,200),readOnly:Boolean(k.readOnly),title:clean(k.title,120)};
   if(keys.has(fp))keys.get(fp).access.push({target,from:[],command:null,restricted:true,sudo:k.readOnly?'repo-read':'repo-write',via:'forgejo'});
   else forgejoUnknown.push({...target,fingerprint:fp});
  }
 }

 // 4. client routes (~/.ssh/config): which key each alias uses, and whether the target accepts it
 for(const [id,p] of Object.entries(probes)){
  if(p.error)continue;
  const homeOf=user=>p.host.accounts.find(a=>a.user===user)?.home||'',mark=p.agent?{source:'agent'}:{};
  for(const r of p.host.routes){
   const files=new Set(r.identityFiles.map(f=>expandHome(f,homeOf(r.user))));
   const target=resolveRoute(r,id,index,forgejoHost,forgejoMachine);
   for(const k of keys.values())for(const c of k.copies){
    if(c.machine!==id||!files.has(c.path))continue;
    let accepted=null;
    const git=k.access.some(a=>a.target.kind==='forgejo'||a.target.kind==='forgejo-deploy');
    if(target.kind==='host')accepted=k.access.some(a=>a.target.kind==='host'&&a.target.machine===target.machine&&a.target.user===r.remoteUser);
    else if(target.kind==='forgejo')accepted=git;
    // A Host block for the Forgejo machine serves both ssh and git; either one counts.
    const alsoGit=target.kind==='host'&&target.machine===forgejoMachine&&git;
    if(alsoGit&&!accepted)accepted=true;
    k.routes.push({machine:id,user:r.user,alias:r.alias,hostname:r.hostname,port:r.port,remoteUser:target.kind==='external'?'':r.remoteUser,proxyJump:r.proxyJump,target,accepted,alsoGit,keyPath:c.path,...mark});
   }
  }
 }
 // External routes (GitHub, VMs) are the only evidence of what those keys open.
 for(const k of keys.values())for(const r of k.routes)if(['external','local'].includes(r.target.kind)&&!k.access.some(a=>a.target.label===r.target.label))
  k.access.push({target:{kind:r.target.kind,label:r.target.label,user:r.remoteUser||null},from:[],command:null,restricted:false,sudo:'unknown',via:'ssh-config',unverified:true});

 // 5. findings
 const mName=id=>machineById.get(id)?.name||id;
 const rootKeys=[];
 const order=site.security.order.length?site.security.order:site.machines.map(m=>m.id),rank=id=>order.indexOf(id)+1||99;
 const home=k=>(k.copies.find(c=>!c.backup)||k.copies[0])?.machine||'';
 const sorted=[...keys.values()].sort((a,b)=>rank(home(a))-rank(home(b))||a.name.localeCompare(b.name));
 for(const k of sorted){
  const label=k.comment&&k.comment!==k.name?`${k.name} (${k.comment})`:k.name||k.fingerprint.slice(0,20);
  const where=[...new Set(k.copies.map(c=>mName(c.machine)))].join(', ');
  const rootOn=[...new Set(k.access.filter(a=>a.target.kind==='host'&&['nopasswd','root'].includes(a.sudo)&&!a.restricted).map(a=>`${mName(a.target.machine)} (${a.target.user})`))];
  if(rootOn.length&&k.copies.some(c=>c.encrypted===false))rootKeys.push(`${label} (${where}) → ${rootOn.join(', ')}`);
  if(!k.access.length)findings.push(finding('info',tx('{key}: nikam nevede',{key:label}),tx('Neplatí v žádném authorized_keys ani ve Forgejo. Leží na {where}. Kandidát na smazání.',{where}),k.id));
  const copies=k.copies.length;
  if(copies>1)findings.push(finding('info',tx('{key}: počet kopií {n}',{key:label,n:copies},`${label}: ${copies} kopie`),k.copies.map(c=>`${mName(c.machine)}:${c.path}`).join(' · '),k.id));
  for(const c of k.copies)if(/^[0-7]{3,4}$/.test(c.mode)&&/[1-7]/.test(c.mode.slice(-2)))
   findings.push(finding('high',tx('{key}: soubor čitelný i pro ostatní ({mode})',{key:label,mode:c.mode}),`${mName(c.machine)}:${c.path}`,k.id));
  for(const r of k.routes)if(r.accepted===false)findings.push(finding('info',tx('{key}: alias „{alias}“ na {machine} míří na {target}, ale cíl klíč nepřijímá',{key:label,alias:r.alias,machine:mName(r.machine),target:r.target.kind==='host'?`${mName(r.target.machine)} (${r.remoteUser})`:r.target.label}),'Zastaralý záznam v ~/.ssh/config nebo chybějící authorized_keys.',k.id));
  const strength=keyStrength(k.type,k.bits),kind=[k.type,k.bits].filter(Boolean).join(' ');
  if(strength==='weak')findings.push(finding('warn',tx('{key}: slabý typ klíče ({type})',{key:label,type:kind}),'DSA a krátké RSA nebo ECDSA klíče už nejsou bezpečné. Vygeneruj nový klíč ed25519 a starý odeber z authorized_keys.',k.id));
  else if(strength==='legacy')findings.push(finding('info',tx('{key}: starší typ klíče ({type})',{key:label,type:kind}),'RSA pod 3072 bitů se pro nové klíče nedoporučuje. Při příští výměně použij ed25519.',k.id));
 }
 if(rootKeys.length)findings.push(finding('warn',tx('Klíče bez passphrase, které otevírají účet se sudo bez hesla, tedy root: {n}',{n:rootKeys.length},`${rootKeys.length} klíčů bez passphrase otevírá účet se sudo bez hesla, tedy root`),
  tx('Kdo získá soubor klíče, je root na cílovém stroji. Jde o záměr pro agenty, ochranu dělají jen from= a AllowUsers. {keys}',{keys:rootKeys.join(' · ')})));
 for(const u of unknownAuthorized)findings.push(finding(['nopasswd','root'].includes(accountOf(u.machine,u.user)?.sudo.level)?'warn':'info',
  tx('Na {machine} ({user}) je povolený cizí klíč „{key}“',{machine:mName(u.machine),user:u.user,key:(u.comment||u.fingerprint).slice(0,48)}),
  sentences('Jeho privátní část není na žádném z prověřených strojů (jiné zařízení nebo zapomenutý klíč).',u.from.length?tx('Jen z {from}.',{from:u.from.join(', ')}):'Bez omezení adresy.',u.restricted?'Omezený příkaz.':null)));
 for(const u of forgejoUnknown)findings.push(finding('warn',tx(u.kind==='forgejo'?'Forgejo: cizí klíč „{title}“ (účet {name})':'Forgejo: cizí klíč „{title}“ (repozitář {name})',{title:u.title,name:u.kind==='forgejo'?u.account:u.repo}),'Privátní část není na žádném z prověřených strojů.'));
 for(const m of machines){
  if(!m.reachable||!m.ssh)continue;
  if(m.ssh.passwordAuth)findings.push(finding('warn',tx('{machine}: SSH přijímá i heslo',{machine:m.name}),m.ssh.allowUsers.length?tx('Omezeno přes AllowUsers na {users}.',{users:m.ssh.allowUsers.join(', ')}):'Bez omezení adres (AllowUsers).'));
  for(const a of m.accounts){
   if(a.sudo.expired?.length)findings.push(finding('info',tx('{machine}: prošlé pravidlo sudo pro {user}',{machine:m.name,user:a.user}),a.sudo.expired.join(' · ')));
   for(const e of a.authorizedKeys)if(!e.from.length&&!e.restricted&&['nopasswd','root'].includes(a.sudo.level)&&!m.ssh.allowUsers.some(x=>x.startsWith(`${a.user}@`)))
    findings.push(finding('warn',tx('{machine} ({user}): klíč „{key}“ bez omezení adresy',{machine:m.name,user:a.user,key:e.comment||e.fingerprint.slice(0,20)}),'Účet má sudo bez hesla a ani from= ani AllowUsers neomezují, odkud se klíč smí použít.'));
  }
  const present=new Set(m.accounts.map(a=>a.user));
  const stale=(m.ssh.accessGroup||[]).filter(u=>!u.startsWith('%')&&u!=='*'&&!present.has(u));
  if(stale.length)findings.push(finding('info',tx('{machine}: Remote Login povoluje neexistující účty',{machine:m.name}),tx('com.apple.access_ssh obsahuje {users}, kteří na stroji nejsou.',{users:stale.join(', ')})));
 }
 for(const o of otherKeys)if(o.backup)findings.push(finding('info',tx('{machine}: záloha klíče {label}',{machine:mName(o.machine),label:[o.label]}),o.path));
 const level={high:0,warn:1,info:2};findings.sort((a,b)=>level[a.level]-level[b.level]);

 for(const x of extraMachines)machines.push({id:x.id,name:index.machines.get(x.id)?.name||x.name||x.id,ips:index.machines.get(x.id)?.ips||x.ips||[],hostname:index.machines.get(x.id)?.hostname||'',reachable:false,sshOpen:x.sshOpen,note:clean(x.note,200),accounts:[],ssh:null});
 machines.sort((a,b)=>rank(a.id)-rank(b.id));
 return {schemaVersion:SECURITY_SCHEMA,collectedAt:new Date(now).toISOString(),collectedFrom,
  machines,keys:sorted,otherKeys,unknownAuthorized,forgejo:forgejo?{url:forgejo.url||`https://${forgejoHost}`,users:(forgejo.users||[]).map(u=>({login:u.login,isAdmin:Boolean(u.isAdmin),keys:(u.keys||[]).length})),deployKeys:(forgejo.deployKeys||[]).length,unknown:forgejoUnknown}:null,
  findings};
}

// The machines the key collector reads: every site machine with an ssh alias unless ssh.keys is false.
export const securityMachines=s=>s.machines.filter(m=>m.ssh&&m.ssh.keys).map(m=>({id:m.id,name:m.name}));
// Where the key inventory stands (collector-state.mjs); with a snapshot, its age decides between ok and stale.
export function securitySetup(site,{collectedAt=null,now=Date.now()}={}){
 const machines=securityMachines(site);
 return {...collectorState('security',{configured:machines.length>0,collectedAt,now}),machines,siteMachines:site.machines.length,gitHost:site.security.gitHost};
}
// One push agent's sshkeys part as a probe for buildSecurity: {text, receivedAt, fresh, root}, or null without one.
// A part whose lines cannot be read is null too: that one machine keeps its collector record, the answer stands.
export function agentKeysProbe(record,{now=Date.now()}={}){
 const part=record?.parts?.sshkeys;
 if(!part||!Array.isArray(part.records)||!Number.isFinite(Date.parse(part.receivedAt)))return null;
 let text,root;
 try{text=part.records.join('\n');parseProbe(text);root=rootIn(part.records);}catch{return null;}
 return {text,receivedAt:part.receivedAt,fresh:freshUntil(part)>now,root};
}
// HOST field 4 of a probe's lines: 1 = it ran as root and saw every account.
const rootIn=lines=>(lines.find(l=>l.startsWith('HOST\t'))?.split('\t')||[])[4]==='1';
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const newest=list=>list.filter(v=>Number.isFinite(Date.parse(v))).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null;
// probes.json lies beside the inventory file (SECURITY_FILE, else data/security/ssh-keys.json).
export const probesFileOf=file=>path.join(path.dirname(file),'probes.json');
async function readProbes(file){
 let doc,time;
 try{[doc,time]=await Promise.all([readFile(file,'utf8').then(JSON.parse),stat(file).then(s=>s.mtimeMs)]);}catch(e){return {doc:null,why:e.code==='ENOENT'?'probes-missing':'probes-unreadable'};}
 if(!plain(doc)||doc.schemaVersion!==SECURITY_PROBES_SCHEMA||!plain(doc.probes))return {doc:null,why:'probes-unreadable'};
 return {doc,time};
}
/**
 * The SSH key inventory: ssh-keys.json as the collector wrote it, or null without one. agents: [{id, name, record}],
 * the push agents' stored reports of machines that exist now. When one of them has an sshkeys part, the inventory is
 * joined across machines, so it is rebuilt: buildSecurity over the collector's probes.json, each machine's record the
 * winner between the collector's and the agent's (docs/agent.md §3); Forgejo and the router entry stay the collector's.
 * collectedAt is then the newest of the collector's and the agents' receive times, collectorCollectedAt the collector's
 * alone, and agents = {joined, machines, fresh, noNews}. A probes.json missing, unreadable or from another run than
 * ssh-keys.json (an older collector wrote only the inventory) leaves ssh-keys.json as it is, with agents.joined false
 * and why. Without an agent's sshkeys part the file is returned exactly as it was.
 */
export async function loadSecurity(directory,file=process.env.SECURITY_FILE||path.join(directory,'security','ssh-keys.json'),{agents=[],site=loadedSite(),now=Date.now(),machinesDir=process.env.MACHINES_DIR||path.join(directory,'machines')}={}){
 let doc=null;
 try{doc=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('invalid');}
 if(doc&&(doc?.schemaVersion!==SECURITY_SCHEMA||!Array.isArray(doc.machines)||!Array.isArray(doc.keys)))throw new Error('invalid');
 if(doc===null&&!(Array.isArray(agents)&&agents.length))return null;
 const reporting=(Array.isArray(agents)?agents:[]).map(e=>({id:e?.id,name:e?.name,probe:agentKeysProbe(e?.record,{now})})).filter(x=>typeof x.id==='string'&&x.probe).sort((a,b)=>a.id.localeCompare(b.id));
 if(!reporting.length)return doc;
 const fresh=reporting.filter(x=>x.probe.fresh).length,count={machines:reporting.length,fresh,noNews:reporting.length-fresh};
 const {doc:collected,time:probesTime,why}=await readProbes(probesFileOf(file));
 if(doc&&(!collected||collected.collectedAt!==doc.collectedAt))return {...doc,agents:{joined:false,reason:collected?'probes-outdated':why,...count}};
 const raw={},limit=staleAfter(COLLECTORS.security)*1000;
 for(const [id,p] of Object.entries(collected?.probes||{}))if(plain(p))raw[id]=typeof p.text==='string'?{text:p.text,probedAt:p.probedAt??null}:{error:typeof p.error==='string'?p.error:'nedostupné'};
 for(const {id,probe:a} of reporting){
  // C is current only when complete (END ok), as on the systems side, not stale by its age, and with a time.
  const C=raw[id],cHost=C?.text!=null?parseProbe(C.text):null;
  const cTime=cHost?collectorTime({probedAt:C.probedAt,collectedAt:cHost.at},{collectedAt:collected?.collectedAt,fileTime:probesTime}):NaN;
  const c=C?{current:Boolean(cHost?.complete)&&Number.isFinite(cTime)&&now-cTime<=limit,time:cTime}:null;
  const cRoot=Boolean(cHost?.root);
  // SSH keys coverage: HOST root (1 = every account). Less access never replaces more while that record is current.
  if(pickSource(c,{current:a.fresh,time:Date.parse(a.receivedAt),covers:a.root||!cRoot})==='agent')raw[id]={text:a.text,agent:true,receivedAt:a.receivedAt,source:'agent',sourceAt:a.receivedAt,stale:!a.fresh};
  else raw[id]={...C,source:'collector',sourceAt:Number.isFinite(cTime)?new Date(cTime).toISOString():null};
 }
 const descriptors=await loadMachineDescriptors(machinesDir,machineIds(site)).catch(()=>({}));
 for(const {id,name} of reporting)if(!descriptors[id]&&!site.machines.some(m=>m.id===id))descriptors[id]={id,name:name||id};
 const built=buildSecurity({probes:raw,forgejo:collected?.forgejo??null,extraMachines:Array.isArray(collected?.extraMachines)?collected.extraMachines:[],descriptors,
  collectedFrom:typeof collected?.collectedFrom==='string'?collected.collectedFrom:'',now,site});
 const collectorAt=collected?.collectedAt??null;
 return {...built,collectedAt:newest([collectorAt,...reporting.map(x=>x.probe.receivedAt)]),collectorCollectedAt:collectorAt,...(doc?.run?{run:doc.run}:{}),agents:{joined:true,...count}};
}
