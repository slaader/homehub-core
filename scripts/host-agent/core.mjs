// The core entry of the host-agent installer: core's own push agent (docs/agent.md §5), which needs no plugin and no
// site.json on the device. scripts/install-host-agent.mjs --core parses the flags and calls this.
//
// Split as server/update-apply.mjs is: planCoreInstall and the render functions are pure (the inputs are read by the
// caller and passed in), and applyCorePlan does every side effect through the world it is given (exec, fs, clock,
// confirm). No test drives a real service manager, sudo, visudo or useradd, or writes outside a temp directory.
//
// Where things are (docs/agent.md → Where things are):
//   macOS  ~/Library/Application Support/Home Hub Agent/ (the copy, config/agent.json, config/specs.txt,
//          private/agent.key 0600, state/status.json), ~/Library/Logs/Home Hub Agent/agent.log, a launchd agent
//          (~/Library/LaunchAgents, kind launchd-agent) of the owner's login account; or, with --service
//          launchd-daemon, a launchd daemon (/Library/LaunchDaemons, root:wheel 0644) that runs the same copy as that
//          account (UserName) from boot. One of the two at a time: installing one boots out and removes the other.
//   Linux  /opt/home-hub-agent/ (root), /etc/home-hub-agent/agent.json and specs.txt (root 0644), the key
//          /etc/home-hub-agent/agent.key (root 0600, handed over with LoadCredential=; systemd older than 247: owned by
//          home-hub-agent, 0400), /var/lib/home-hub-agent/status.json, a systemd system unit (kind systemd-system) with
//          User=home-hub-agent
//   both   /etc/sudoers.d/home-hub-agent (0440, rendered from PRIVILEGED), and with --keys all-accounts a root-owned
//          copy of ssh-probe.sh in /usr/local/libexec/home-hub-agent/
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coreAgentClosure,CORE_AGENT_ENTRY} from '../../server/agent-closure.mjs';
import {AGENT_MANIFEST} from '../../server/host-agent.mjs';
import {PRIVILEGED} from '../../server/agent-privileged.mjs';
import {validateSpecs} from '../../server/agent-report.mjs';
import {normalizePin} from '../../server/endpoint-http.mjs';
import {parseConfig,parseHub,parseToken,specsPathErrors,DEFAULT_KEYS,KEY_MODES} from '../agent/config.mjs';
import {RUNTIME_KINDS} from '../../server/runtime-kinds.mjs';

export const coreRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const TEMPLATES=path.join(coreRoot,'scripts','host-agent');
export const CORE_LABEL='home-hub-agent';
export const LINUX_ACCOUNT='home-hub-agent';
export const SUDOERS_FILE='/etc/sudoers.d/home-hub-agent';
export const LAUNCH_DAEMONS='/Library/LaunchDaemons';
// The service kinds of the core agent: macOS a launchd agent (the default) or daemon, Linux a systemd system unit.
export const CORE_SERVICES=Object.freeze({macos:Object.freeze(['launchd-agent','launchd-daemon']),linux:Object.freeze(['systemd-system'])});
// Groups whose members may become root anyway (wheel, admin): a directory they may write is no way into another account.
const ADMIN_GROUPS=Object.freeze([0,80]);
// systemd learned LoadCredential= in 247.
export const LOAD_CREDENTIAL_SINCE=247;
const ACCOUNT=/^[a-z_][a-z0-9_.-]{0,31}$/;
const sha256=b=>createHash('sha256').update(b).digest('hex');
export class CoreInstallError extends Error{}
const refuse=m=>{throw new CoreInstallError(m);};

/**
 * Where everything goes on this platform. home: the owner's home on macOS. service (macOS): launchd-agent (default)
 * or launchd-daemon, which only moves the service file; launchAgent and launchDaemon name both, so either kind can
 * find and remove the other.
 */
export function corePaths(platform,{home,service='launchd-agent'}={}){
 if(platform==='macos'){
  const base=path.join(home,'Library','Application Support','Home Hub Agent');
  const launchAgent=path.join(home,'Library','LaunchAgents',`${CORE_LABEL}.plist`),launchDaemon=path.join(LAUNCH_DAEMONS,`${CORE_LABEL}.plist`);
  return {target:base,config:path.join(base,'config'),key:path.join(base,'private','agent.key'),state:path.join(base,'state'),
   log:path.join(home,'Library','Logs','Home Hub Agent','agent.log'),service:service==='launchd-daemon'?launchDaemon:launchAgent,
   backups:path.join(home,'Library','Application Support','Home Hub Agent Backups'),sudoers:SUDOERS_FILE,probeCopy:sshProbeCopy('macos'),launchAgent,launchDaemon};
 }
 if(platform==='linux')return {target:'/opt/home-hub-agent',config:'/etc/home-hub-agent',key:'/etc/home-hub-agent/agent.key',state:'/var/lib/home-hub-agent',log:null,
  service:`/etc/systemd/system/${CORE_LABEL}.service`,backups:'/var/backups/home-hub-agent',sudoers:SUDOERS_FILE,probeCopy:sshProbeCopy('linux')};
 return refuse(`The Node agent runs on macOS and Linux, not ${platform}`);
}
const sshProbeCopy=platform=>PRIVILEGED[platform].find(e=>e.id==='ssh-probe').argv[0];

// --- sudoers ---------------------------------------------------------------------------------------------------------
// One argument of a sudoers command line: ":", ",", "=" and "\" are escaped (docs/agent.md → The privileged list).
export const sudoersEscape=arg=>String(arg).replace(/[\\:,=]/g,c=>`\\${c}`);
/**
 * The rules for one account, rendered from PRIVILEGED: one exact command line each, no wildcard. A command listed
 * without arguments (ssh-probe) is rendered with "" after it, which in sudoers allows no arguments at all (a bare
 * command would allow any). listen alternatives
 * (Linux) only for the ss paths that exist, are root-owned and not writable by others (ssOk(path) → bool); the
 * ssh-probe rule only with keys all-accounts. → {text, rules: [[argv]]}.
 */
export function renderSudoers({platform,account,keys,ssOk=()=>true}){
 if(!ACCOUNT.test(account||''))refuse('The account name is not one sudoers can take');
 const rules=PRIVILEGED[platform].filter(e=>(e.only!=='all-accounts'||keys==='all-accounts')&&(!e.alternative||ssOk(e.argv[0]))).map(e=>[...e.argv]);
 const lines=['# The Home Hub push agent\'s privileged reads (docs/agent.md section 5), rendered from server/agent-privileged.mjs.',
  '# Written by scripts/install-host-agent.mjs --core: one exact command line each, no wildcard. Do not edit: install again.'];
 if(platform==='linux')lines.push(`Defaults:${account} !requiretty`);
 for(const argv of rules)lines.push(`${account} ALL=(root) NOPASSWD: ${argv.map(sudoersEscape).join(' ')}${argv.length===1?' ""':''}`);
 return {text:lines.join('\n')+'\n',rules};
}

// --- the service -------------------------------------------------------------------------------------------------------
const xml=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fill=(template,values)=>template.replace(/\{\{(\w+)\}\}/g,(_,k)=>values[k]??'');
const systemdQuote=v=>`"${String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%')}"`;
/**
 * The service file: macOS a launchd agent of the owner (launchd-agent) or, with service launchd-daemon, a launchd
 * daemon in the system domain that runs as the owner (UserName: the account passed in, never root, never taken from
 * os.userInfo()); Linux a systemd system unit (systemd-system) running as the agent's account. keyMode (Linux):
 * "credential" (LoadCredential=) or "file". → {kind, label, file, text, domain?, gui? (the daemon: the owner's GUI domain)}
 */
export function renderCoreService({platform,paths,node,uid=null,home=null,account=LINUX_ACCOUNT,keyMode='credential',service=null,read=f=>fs.readFileSync(f,'utf8')}){
 const entry=path.join(paths.target,CORE_AGENT_ENTRY);
 if(platform==='macos'){
  const values={label:xml(CORE_LABEL),node:xml(node),entry:xml(entry),config:xml(paths.config),key:xml(paths.key),state:xml(paths.state),
   log:xml(paths.log),target:xml(paths.target),home:xml(home)};
  if(service==='launchd-daemon'){
   if(!ACCOUNT.test(account||'')||account==='root')refuse('The launchd daemon runs as the owner\'s account, named explicitly and never root');
   if(!Number.isSafeInteger(uid)||uid<=0)refuse('The launchd daemon needs the owner\'s uid (not root\'s)');
   const gui=`gui/${uid}`;
   const text=fill(read(path.join(TEMPLATES,'agent-launchd-daemon.plist')),{...values,gui:xml(gui),account:xml(account)});
   return {kind:'launchd-daemon',label:CORE_LABEL,file:paths.service,text,domain:'system',gui};
  }
  const text=fill(read(path.join(TEMPLATES,'agent-launchd.plist')),values);
  return {kind:'launchd-agent',label:CORE_LABEL,file:paths.service,text,domain:`gui/${uid}`};
 }
 const exec=[node,entry,'--config',paths.config,'--state',paths.state,...(keyMode==='file'?['--key',paths.key]:[])].map(systemdQuote).join(' ');
 const text=fill(read(path.join(TEMPLATES,'agent-systemd.service')),{label:CORE_LABEL,account,exec,target:paths.target,state:paths.state,stateName:path.basename(paths.state),
  credential:keyMode==='credential'?`LoadCredential=agent-key:${paths.key}\n`:''});
 return {kind:'systemd-system',label:CORE_LABEL,file:paths.service,text};
}

/** agent.json as the installer writes it; checked with the agent's own parser. */
export function renderAgentConfig({platform,hub,pins=[],caPath=null,keys,runtimes=[]}){
 const doc={$comment:'Written by scripts/install-host-agent.mjs --core. Do not edit: install again.',schema:1,hub:hub.replace(/\/$/,''),
  ...(pins.length?{trust:{pins}}:caPath?{trust:{ca:caPath}}:{}),keys,...(runtimes.length?{runtimes}:{})};
 const text=JSON.stringify(doc,null,1)+'\n';
 const c=parseConfig(text,{platform});if(!c.ok)refuse(c.error);
 return text;
}

// --- flags -------------------------------------------------------------------------------------------------------------
const VALUE=['--hub','--pin','--ca','--key-file','--specs','--runtime','--keys','--account','--wait','--service'],SWITCH=['--core','--dry-run','--once','--yes','--allow-dirty','--help'];
/** argv of `install-host-agent.mjs --core …` → options, or {error}. */
export function parseCoreArgs(argv){
 const o={hub:null,pins:[],ca:null,keyFile:null,specs:null,runtimes:[],keys:null,account:null,service:null,wait:90,dryRun:false,once:false,yes:false,allowDirty:false,help:false};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(SWITCH.includes(a)){if(a!=='--core')o[{'--dry-run':'dryRun','--allow-dirty':'allowDirty'}[a]||a.slice(2)]=true;continue;}
  if(!VALUE.includes(a))return {error:`Unknown: ${String(a).slice(0,60)}`};
  const v=argv[++i];if(v===undefined||v.startsWith('--'))return {error:`${a} needs a value`};
  if(a==='--pin')o.pins.push(v);else if(a==='--runtime')o.runtimes.push(v);
  else if(a==='--wait'){const n=Number(v);if(!Number.isSafeInteger(n)||n<5||n>3600)return {error:'--wait is 5–3600 seconds'};o.wait=n;}
  else o[{'--key-file':'keyFile'}[a]||a.slice(2)]=v;
 }
 return o;
}

// --- the plan ----------------------------------------------------------------------------------------------------------
const KEY_FILE_V1='machine';
/**
 * A key file as create-agent-key --output writes it → {token, agent: {id, device, prefix}}. A file a 1.x hub wrote
 * names the device under 1.x's key (KEY_FILE_V1): the key in it still works, so the file is read as it is.
 */
export function readKeyFile(text){
 let raw;try{raw=JSON.parse(text);}catch{refuse('--key-file is not the JSON file create-agent-key --output wrote');}
 if(raw?.agent&&typeof raw.agent==='object'&&raw.agent.device===undefined&&typeof raw.agent[KEY_FILE_V1]==='string')raw={...raw,agent:{...raw.agent,device:raw.agent[KEY_FILE_V1]}};
 const token=parseToken(raw?.token);
 if(raw?.schema!==1||!token||!raw.agent||typeof raw.agent.device!=='string')refuse('--key-file is not an agent key file (schema 1, an hha_ token)');
 const id=typeof raw.agent.id==='string'?raw.agent.id.slice(0,64):null;
 return {token,agent:{id,device:raw.agent.device.slice(0,64),prefix:token.slice(0,12)}};
}
/** "--runtime ollama=http://127.0.0.1:11434" → {id, kind, url}: the id is the kind when it names one, else auto. */
export function parseRuntimeFlag(v){
 const m=/^([a-z][a-z0-9-]{0,39})=(.+)$/.exec(v||'');if(!m)refuse(`--runtime ${String(v).slice(0,60)}: id=http://127.0.0.1:<port>`);
 return {id:m[1],kind:RUNTIME_KINDS.includes(m[1])?m[1]:'auto',url:m[2]};
}

/**
 * Everything the install would do, worked out without changing anything. options: the parsed flags. inputs: what the
 * caller read (keyText, specsText or null, caText or null), platform, root (the core checkout), home, uid, user (the
 * name of the account running the installer), node, systemd (Linux: its version, or null when unknown), loadCredential
 * (Linux: whether a test unit was handed a LoadCredential=, null when not tried; loadCredentialWhy: what the test said
 * when it was not), ssOk(path), paths (tests), git (a checkout's state), installed (the current install's
 * .agent-install.json, parsed, or null: on macOS without --service its kind is kept, so an update of a launchd daemon
 * does not quietly turn it into an agent).
 */
export function planCoreInstall(options,{platform,root=coreRoot,home,uid,user=null,node,systemd=null,loadCredential=null,loadCredentialWhy=null,keyText,specsText=null,caText=null,ssOk=()=>true,paths=null,installed=null,
 git=dir=>gitState(dir),readText=f=>fs.readFileSync(f,'utf8'),readBytes=f=>fs.readFileSync(f)}){
 if(platform!=='macos'&&platform!=='linux')refuse(`The Node agent runs on macOS and Linux, not ${platform}`);
 if(!options.hub)refuse('Say where the hub is: --hub https://hub.example.lan');
 const hub=parseHub(options.hub);
 if(!hub)refuse('--hub must be an origin: https://<name or IPv4>[:port], or http://127.0.0.1[:port] on the hub\'s own host');
 if(options.pins.length&&options.ca)refuse('--pin and --ca exclude each other');
 if(options.pins.length>2)refuse('At most two --pin (the certificate now and the next one)');
 const pins=options.pins.map(p=>normalizePin(p)||refuse(`--pin ${String(p).slice(0,80)} is not a SHA-256 fingerprint`));
 if((pins.length||options.ca)&&!hub.secure)refuse('--pin and --ca are for an https:// hub');
 if(options.ca&&!path.isAbsolute(options.ca))refuse('--ca must be an absolute path');
 if(options.ca&&(typeof caText!=='string'||!/-----BEGIN CERTIFICATE-----/.test(caText)))refuse(`--ca ${options.ca} is not a PEM certificate`);
 if(!options.keyFile)refuse('Say which key: --key-file /abs/agent-key.json (create-agent-key --output wrote it)');
 const key=readKeyFile(keyText);
 const keys=options.keys??DEFAULT_KEYS[platform];
 if(!KEY_MODES.includes(keys))refuse('--keys is own, all-accounts or off');
 // The account is passed in, never taken from os.userInfo() (root under sudo).
 let account;
 if(platform==='macos'){
  account=options.account;
  if(!account||!ACCOUNT.test(account))refuse('--account must be the owner\'s login account (default: the invoking user)');
  if(account==='root'||uid===0)refuse('On macOS the agent runs as the owner\'s login account: run the installer as that account, not as root or with sudo');
 }else{
  if(options.account&&options.account!==LINUX_ACCOUNT)refuse(`On Linux the agent runs as the system account ${LINUX_ACCOUNT}; --account cannot change it`);
  account=LINUX_ACCOUNT;
 }
 // Without --service: the kind the current core install runs (macOS), else the default. A fresh install is the default.
 const recorded=platform==='macos'&&options.service==null&&installed?.kind==='core'&&CORE_SERVICES.macos.includes(installed?.service)?installed.service:null;
 const kind=options.service??recorded??CORE_SERVICES[platform][0];
 const serviceFrom=options.service!=null?'flag':recorded?'install':'default';
 if(!CORE_SERVICES[platform].includes(kind))refuse(platform==='macos'?'--service is launchd-agent (the default: a launchd agent of the owner\'s login session) or launchd-daemon (from boot, as the owner)'
  :`On Linux the agent is a systemd system unit (systemd-system); --service cannot change it`);
 // The daemon runs the copy in this account's home as the account it names: that must be the account the install
 // belongs to, the one running the installer, or whoever owns the copy could run code as another account.
 if(kind==='launchd-daemon'&&account!==user)refuse(`--service launchd-daemon runs the agent as the account the install belongs to, the one running the installer (${String(user||'unknown').slice(0,32)}); --account ${account} is another`);
 const base=paths||corePaths(platform,{home});
 const p=kind==='launchd-daemon'?{...base,service:base.launchDaemon}:base;
 const specs=validateSpecs(specsText??'',{platform});
 const specErrors=specs.ok?specsPathErrors(specsText??''):specs.errors;
 if(specErrors.length)refuse(`The watch list does not pass the agent's check, so nothing was installed:\n${specErrors.map(e=>`  line ${e.line}: ${e.reason}`).join('\n')}`);
 const runtimes=options.runtimes.map(parseRuntimeFlag);
 const caPath=options.ca?path.join(p.config,'hub-ca.pem'):null;
 const configText=renderAgentConfig({platform,hub:hub.origin,pins,caPath,keys,runtimes});
 // Linux: the key goes through LoadCredential= when systemd has it and a test unit was handed one, else a file of the
 // agent's account. The version alone is not enough: systemd 257 in a container dropped the setting without a word.
 const keyMode=platform==='macos'?'owner-file':systemd!==null&&systemd>=LOAD_CREDENTIAL_SINCE&&loadCredential!==false?'credential':'file';
 if(platform==='linux'&&/^\/(home|root)\//.test(node))refuse(`node is ${node}, inside a home directory the agent's account cannot read; install Node system-wide (or pass a system node by running the installer with it)`);
 const closure=coreAgentClosure(root);
 // The bytes read here are the bytes hashed and the bytes installed: nothing is copied from the checkout again.
 const files=closure.map(f=>{const body=Buffer.from(readBytes(f.from));return {from:f.from,to:f.to,body,sha256:sha256(body),mode:f.to.endsWith('.sh')?0o755:0o644};});
 const sudoers=renderSudoers({platform,account,keys,ssOk});
 const service=renderCoreService({platform,paths:p,node,uid,home,account,keyMode:keyMode==='file'?'file':'credential',service:kind,read:readText});
 // macOS: the other launchd kind of this label, which the install boots out and removes when it is there.
 const other=platform!=='macos'?null:kind==='launchd-daemon'?{kind:'launchd-agent',label:CORE_LABEL,file:p.launchAgent,domain:`gui/${uid}`}
  :{kind:'launchd-daemon',label:CORE_LABEL,file:p.launchDaemon,domain:'system'};
 const source=git(root),dirty=source.dirty?source.dirty.filter(f=>files.some(x=>x.to===f)):null;
 if(!options.allowDirty&&source.commit===null)refuse('The core checkout must be a git checkout, so the copy is a commit (or --allow-dirty for a test)');
 if(!options.allowDirty&&dirty?.length)refuse(`These agent files have uncommitted changes; commit them first (or --allow-dirty for a test):\n${dirty.join('\n')}`);
 let version;try{version=JSON.parse(readText(path.join(root,'package.json'))).version;}catch{refuse('Cannot read core\'s package.json');}
 const record={schema:1,kind:'core',core:version,platform,account,label:CORE_LABEL,service:service.kind,entry:CORE_AGENT_ENTRY,commits:{core:source.commit},dirty:Boolean(dirty?.length),
  agent:key.agent,files:files.map(f=>({path:f.to,sha256:f.sha256})),config:{path:'agent.json',sha256:sha256(Buffer.from(configText))},specs:{sha256:sha256(Buffer.from(specsText??'')),lines:specs.lines.length},keyMode,
  keys,privileged:{sudoers:sudoers.text,probeCopy:keys==='all-accounts'}};
 return {platform,account,hub,pins,keys,runtimes,uid,home,node,paths:p,files,configText,specsText:specsText??'',specsLines:specs.lines,caText:options.ca?caText:null,caPath,
  token:key.token,agent:key.agent,keyMode,systemd,loadCredential,loadCredentialWhy,service,serviceFrom,other,sudoers,record,wait:options.wait};
}
/** An install's .agent-install.json (bytes or null) → the parsed record, or null when there is none or it does not parse. */
export function readInstallRecord(bytes){
 if(bytes===null||bytes===undefined)return null;
 try{const r=JSON.parse(String(bytes));return r&&typeof r==='object'&&!Array.isArray(r)?r:null;}catch{return null;}
}
function gitState(dir){
 const run=(...a)=>{const r=spawnSync('git',['-C',dir,...a],{encoding:'utf8'});return r.status===0?r.stdout.trim():null;};
 const commit=run('rev-parse','HEAD');if(!commit)return {commit:null,dirty:null};
 const status=run('status','--porcelain','--','scripts','server','package.json');
 return {commit,dirty:status===null?null:status.split('\n').filter(Boolean).map(l=>l.slice(3))};
}

/** What the plan would do, as lines for a person. Never the token. */
export function formatCorePlan(p){
 const l=[];
 l.push(`Push agent (core ${p.record.core}, commit ${(p.record.commits.core||'?').slice(0,10)}${p.record.dirty?', dirty':''}) on ${p.platform} as ${p.account} → ${p.paths.target}`);
 l.push(`  hub ${p.hub.origin}: ${!p.hub.secure?'plain HTTP to the hub on this computer':p.pins.length?`pinned (${p.pins.map(x=>x.slice(0,16)+'…').join(', ')})`:p.caPath?`CA ${p.caPath}`:'the system certificate store'}`);
 l.push(`  key ${p.agent.prefix}… for device ${p.agent.device} → ${p.paths.key}${p.keyMode==='credential'?' (root 0600, LoadCredential=agent-key)':p.keyMode==='file'?` (owned by ${p.account}, 0400: systemd ${p.systemd??'unknown'} ${p.loadCredential===false&&p.systemd>=LOAD_CREDENTIAL_SINCE?'did not hand a test unit its LoadCredential=':'has no LoadCredential='})`:' (0600)'}`);
 if(p.keyMode==='file'&&p.loadCredential===false&&p.loadCredentialWhy)l.push(`    the LoadCredential= test: ${p.loadCredentialWhy}`);
 l.push(`  ${p.files.length} files; agent.json and specs.txt in ${p.paths.config}; state ${p.paths.state}${p.paths.log?`; log ${p.paths.log}`:'; log: the journal'}`);
 l.push(`  SSH keys: ${p.keys}${p.runtimes.length?`; runtimes: ${p.runtimes.map(r=>`${r.id} ${r.url}`).join(', ')}`:''}`);
 l.push(`  watch list (${p.specsLines.length} line${p.specsLines.length===1?'':'s'}): each one is run or read on this computer; confirm every line:`);
 p.specsLines.forEach((line,i)=>l.push(`   ${String(i+1).padStart(3)}  ${line}`));
 if(p.service.kind==='launchd-daemon'){
  l.push(`  launchd-daemon ${p.service.label}: ${p.service.file} (root:wheel 0644, written with sudo), in the system domain from boot, UserName ${p.account} (never root); HOME_HUB_LAUNCHD_DOMAIN ${p.service.gui}`);
  l.push(`  a launchd-agent ${p.service.label} (${p.other.file}) is booted out and removed when there is one: one job afterwards`);
  if(p.serviceFrom==='install')l.push('  (no --service: the kind the current install runs, from .agent-install.json; --service launchd-agent switches to the agent kind)');
 }else l.push(`  ${p.service.kind} ${p.service.label}: ${p.service.file}`);
 l.push(`  sudoers ${p.paths.sudoers} (0440, checked with visudo -cf first):`);
 for(const line of p.sudoers.text.trim().split('\n'))l.push(`     ${line}`);
 if(p.keys==='all-accounts')l.push(`  a root-owned copy of ssh-probe.sh at ${p.paths.probeCopy} (0755)`);
 l.push(`  health: the first accepted report (status.json → lastAcceptedAt after the restart) within ${p.wait} s`);
 return l;
}

// --- carrying it out ---------------------------------------------------------------------------------------------------
/** The real world: commands, files, the clock and a question on the terminal. Tests pass their own. */
export function systemWorld(){
 return {
  // env: the command's whole environment (default: the installer's own). timeoutMs: past it the command is killed and
  // the answer is {code: -1, timedOut: true} (0: no limit).
  exec:(cmd,args,{interactive=false,input=null,env=null,timeoutMs=0}={})=>new Promise(resolve=>{
   const child=spawn(cmd,args,{stdio:interactive?'inherit':[input===null?'ignore':'pipe','pipe','pipe'],...(env?{env}:{})});let stdout='',stderr='',done=false;
   const end=r=>{if(done)return;done=true;clearTimeout(timer);resolve(r);};
   const timer=timeoutMs>0?setTimeout(()=>{end({code:-1,stdout,stderr:'timed out',timedOut:true});child.kill('SIGKILL');},timeoutMs):null;
   child.stdout?.on('data',d=>{stdout+=d;});child.stderr?.on('data',d=>{stderr+=d;});
   if(input!==null)child.stdin.end(input);
   child.on('error',e=>end({code:-1,stdout,stderr:String(e.code||e.message)}));child.on('close',code=>end({code:code??-1,stdout,stderr}));
  }),
  fs:{
   read:f=>{try{return fs.readFileSync(f);}catch{return null;}},
   write:(f,data,mode)=>{fs.writeFileSync(f,data,{mode});fs.chmodSync(f,mode);},
   mkdir:(d,mode)=>{fs.mkdirSync(d,{recursive:true,mode});fs.chmodSync(d,mode);},
   chown:(f,uid,gid)=>fs.chownSync(f,uid,gid),
   remove:f=>{try{if(fs.lstatSync(f).isFile())fs.unlinkSync(f);}catch{}},
   exists:f=>fs.existsSync(f),
   stat:f=>{try{const s=fs.statSync(f);return {uid:s.uid,gid:s.gid,mode:s.mode&0o7777,file:s.isFile(),dir:s.isDirectory()};}catch{return null;}},
   realpath:f=>{try{return fs.realpathSync(f);}catch{return null;}},
   tempDir:()=>fs.mkdtempSync(path.join(os.tmpdir(),'home-hub-agent-')),
   removeTree:d=>fs.rmSync(d,{recursive:true,force:true}),
  },
  now:()=>Date.now(),
  sleep:ms=>new Promise(r=>setTimeout(r,ms)),
  log:console.log,warn:console.error,
  confirm:async question=>{
   if(!process.stdin.isTTY)return false;
   process.stdout.write(question);
   const answer=await new Promise(r=>{process.stdin.setEncoding('utf8');process.stdin.once('data',d=>{process.stdin.pause();r(String(d).trim());});});
   return /^(y|yes)$/i.test(answer);
  },
 };
}

const tools={macos:{launchctl:'/bin/launchctl',sudo:'/usr/bin/sudo',install:'/usr/bin/install',visudo:'/usr/sbin/visudo',rm:'/bin/rm',group:'wheel'},
 linux:{systemctl:'/usr/bin/systemctl',install:'/usr/bin/install',visudo:'/usr/sbin/visudo',useradd:'/usr/sbin/useradd',id:'/usr/bin/id',runuser:'/usr/sbin/runuser',rm:'/bin/rm',group:'root'}};
// The environment of the copy run by --once: nothing of the installer's own (root's HOME, SUDO_*, its PATH).
const SYSTEM_PATH='/usr/bin:/bin:/usr/sbin:/sbin';
// How long a launchd job may take to go after bootout before bootstrap is tried anyway (bootout is asynchronous).
export const BOOTOUT_WAIT={tries:20,ms:500};

// The account the Linux agent runs as: made once, a system account with no home and no shell.
async function ensureAccount(world,account){
 const t=tools.linux;
 let uid=await world.exec(t.id,['-u',account]);
 if(uid.code!==0){
  const r=await world.exec(t.useradd,['--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',account]);
  if(r.code!==0)refuse(`useradd ${account} failed: ${String(r.stderr).trim().slice(0,200)}`);
  world.log(`  made the system account ${account}`);
  uid=await world.exec(t.id,['-u',account]);
 }
 const gid=await world.exec(t.id,['-g',account]);
 if(uid.code!==0||gid.code!==0)refuse(`Cannot read the ids of ${account}`);
 return {uid:Number(uid.stdout.trim()),gid:Number(gid.stdout.trim())};
}
// A command with root: as root on Linux, through sudo on macOS (it asks for the owner's password there, once).
const asRoot=(p,world,cmd,args)=>p.platform==='macos'?world.exec(tools.macos.sudo,[cmd,...args],{interactive:true}):world.exec(cmd,args);

// Only root may write the file and every directory above it. Before anything is installed the directories that
// exist are checked (existingOnly); after the copy, the whole chain. why: what would not be safe, for the refusal.
function safeChain(world,file,{existingOnly=false,why='the all-accounts rule would not be safe; nothing was changed for it'}={}){
 for(let d=file;;d=path.dirname(d)){
  const s=world.fs.stat(d);
  if(!(existingOnly&&!s)&&(!s||s.uid!==0||(s.mode&0o022)))refuse(`${d} is not root-owned or is writable by others: ${why}`);
  if(d===path.dirname(d))break;
 }
}
// The launchd daemon: launchd runs node and the copy as the owner from boot. Whoever can change them, or a directory
// above them, could make it run something else as that account; that may only be root, the account itself (which runs
// it anyway) or an administrator (who can become root): never another account. Missing paths are skipped.
function ownedChain(world,file,{uid,why}){
 for(let d=file;;d=path.dirname(d)){
  const s=world.fs.stat(d);
  if(s&&((s.uid!==0&&s.uid!==uid)||(s.mode&0o002)||((s.mode&0o020)&&!ADMIN_GROUPS.includes(s.gid))))refuse(`${d} can be changed by an account other than root, the owner or an administrator: ${why}`);
  if(d===path.dirname(d))break;
 }
}
const isDaemon=s=>s?.kind==='launchd-daemon';
// Writes bytes and reads them back: what is on disk must hash to what the plan recorded.
function writeChecked(world,file,body,mode,digest){
 world.fs.write(file,body,mode);
 const back=world.fs.read(file);
 if(back===null||sha256(back)!==digest)refuse(`${file} does not hold the bytes the plan hashed; nothing more was installed`);
}

/**
 * The sudoers file and, with all-accounts, the root-owned probe copy. The rules are checked with visudo -cf before
 * anything changes; the probe copy is installed from the bytes the plan hashed, and read back and compared, before
 * the rules are. changed: filled with what was changed (probe, sudoers), so a failure can be undone.
 */
export async function installPrivileged(p,world,changed={}){
 const t=tools[p.platform];
 if(p.keys==='all-accounts')safeChain(world,p.paths.probeCopy,{existingOnly:true});
 const dir=world.fs.tempDir();
 try{
  const draft=path.join(dir,'home-hub-agent');world.fs.write(draft,p.sudoers.text,0o644);
  const check=await world.exec(t.visudo,['-cf',draft]);
  if(check.code!==0)refuse(`visudo -cf refused the rendered rules; nothing was installed:\n${String(check.stdout+check.stderr).trim().slice(0,400)}`);
  if(p.keys==='all-accounts'){
   const copy=p.paths.probeCopy,dirOf=path.dirname(copy),probe=p.files.find(f=>f.to==='scripts/security/ssh-probe.sh');
   const staged=path.join(dir,'ssh-probe.sh');writeChecked(world,staged,probe.body,0o644,probe.sha256);
   if((await asRoot(p,world,t.install,['-d','-m','0755','-o','root','-g',t.group,dirOf])).code!==0)refuse(`Could not make ${dirOf}`);
   changed.probe=true;
   if((await asRoot(p,world,t.install,['-m','0755','-o','root','-g',t.group,staged,copy])).code!==0)refuse(`Could not copy ssh-probe.sh to ${copy}`);
   safeChain(world,copy);
   const back=world.fs.read(copy);
   if(back===null||sha256(back)!==probe.sha256)refuse(`${copy} does not hold the ssh-probe.sh the plan hashed`);
   world.log(`  installed the root-owned ${copy}`);
  }
  changed.sudoers=true;
  const put=await asRoot(p,world,t.install,['-m','0440','-o','root','-g',t.group,draft,p.paths.sudoers]);
  if(put.code!==0)refuse(`Could not install ${p.paths.sudoers}`);
  world.log(`  installed ${p.paths.sudoers}`);
 }finally{world.fs.removeTree(dir);}
}
/**
 * Undoes what installPrivileged changed: the previous sudoers rules (from the previous record) and probe copy (from
 * the backup) are put back; with no previous agent, or no previous copy, they are removed. Never throws; says what it did.
 * → false when a command it ran failed (the backup may then be all that is left of the previous copy).
 */
async function restorePrivileged(p,world,{old,saved,changed}){
 const t=tools[p.platform];
 let clean=true;
 const said=(r,ok,no)=>{if(r.code!==0)clean=false;world.warn(r.code===0?ok:no);};
 if(changed.probe){
  const copy=p.paths.probeCopy,previous=saved?path.join(saved,'privileged','ssh-probe.sh'):null;
  if(previous&&world.fs.read(previous)!==null)said(await asRoot(p,world,t.install,['-m','0755','-o','root','-g',t.group,previous,copy]),`  put the previous ${copy} back`,`  could not put the previous ${copy} back`);
  else said(await asRoot(p,world,t.rm,['-f',copy]),`  removed ${copy}`,`  could not remove ${copy}`);
 }
 if(changed.sudoers){
  const file=p.paths.sudoers,text=old?.privileged?.sudoers;
  if(!old)said(await asRoot(p,world,t.rm,['-f',file]),`  removed ${file} (there was no previous agent)`,`  could not remove ${file}`);
  else if(typeof text!=='string')world.warn(`  left the new ${file} in place: the previous install did not record its rules`);
  else{
   const dir=world.fs.tempDir();
   try{
    const draft=path.join(dir,'home-hub-agent');world.fs.write(draft,text,0o644);
    if((await world.exec(t.visudo,['-cf',draft])).code!==0)world.warn(`  left the new ${file} in place: visudo -cf refused the previous rules`);
    else said(await asRoot(p,world,t.install,['-m','0440','-o','root','-g',t.group,draft,file]),`  put the previous ${file} back`,`  could not put the previous ${file} back`);
   }finally{world.fs.removeTree(dir);}
  }
 }
 return clean;
}

// Lays the copy, configuration and key out. Files of the previous record that the new one does not list are removed.
function layOut(p,world,{owner=null,old=null}){
 const f=world.fs,mac=p.platform==='macos';
 f.mkdir(p.paths.target,0o755);
 const keep=new Set(p.files.map(x=>x.to));
 for(const x of old?.files||[])if(typeof x?.path==='string'&&!keep.has(x.path)&&!x.path.split('/').includes('..'))f.remove(path.join(p.paths.target,x.path));
 for(const x of p.files){const at=path.join(p.paths.target,x.to);f.mkdir(path.dirname(at),0o755);writeChecked(world,at,x.body,x.mode,x.sha256);}
 f.write(path.join(p.paths.target,AGENT_MANIFEST),JSON.stringify({...p.record,installedAt:new Date(world.now()).toISOString()},null,1)+'\n',0o644);
 f.mkdir(p.paths.config,mac?0o700:0o755);
 f.write(path.join(p.paths.config,'agent.json'),p.configText,mac?0o600:0o644);
 f.write(path.join(p.paths.config,'specs.txt'),p.specsText,mac?0o600:0o644);
 if(p.caPath)f.write(p.caPath,p.caText,0o644);
 // The key: the token alone. macOS 0600 of the owner in a 0700 directory; Linux root 0600 (LoadCredential=), or the
 // account's 0400 in a root-owned 0755 directory when systemd is older than 247.
 f.mkdir(path.dirname(p.paths.key),mac?0o700:0o755);
 f.remove(p.paths.key);
 f.write(p.paths.key,p.token+'\n',p.keyMode==='file'?0o400:0o600);
 if(p.keyMode==='file')f.chown(p.paths.key,owner.uid,owner.gid);
 if(mac){f.mkdir(p.paths.state,0o700);f.mkdir(path.dirname(p.paths.log),0o755);}
 // The daemon: launchd opens the log for a job that runs as another account; made here, it is the owner's file.
 if(isDaemon(p.service)&&!f.exists(p.paths.log))f.write(p.paths.log,'',0o644);
}
// The previous copy (its listed files, configuration, service file and the root-owned probe copy) into
// backups/<stamp>/, the key excepted. other: the other launchd kind's plist, when it is there, into service/<kind>/.
function backUp(p,world,old,other=null){
 if(!old&&!other)return null;
 const f=world.fs,stamp=new Date(world.now()).toISOString().replace(/[-:]/g,'').replace(/\..*/,'').replace('T','-'),dir=path.join(p.paths.backups,stamp);
 f.mkdir(dir,0o700);
 const save=(from,rel)=>{const body=f.read(from);if(body===null)return;const to=path.join(dir,rel);f.mkdir(path.dirname(to),0o700);f.write(to,body,0o600);};
 for(const x of old.files||[])if(typeof x?.path==='string'&&!x.path.split('/').includes('..'))save(path.join(p.paths.target,x.path),path.join('code',x.path));
 save(path.join(p.paths.target,AGENT_MANIFEST),path.join('code',AGENT_MANIFEST));
 for(const n of ['agent.json','specs.txt','hub-ca.pem'])save(path.join(p.paths.config,n),path.join('config',n));
 save(p.service.file,path.join('service',path.basename(p.service.file)));
 if(other)save(other.file,serviceBackup(p,other));
 save(p.paths.probeCopy,path.join('privileged','ssh-probe.sh'));
 return dir;
}
// Where a service file is in backups/<stamp>/: this install's kind at service/<name>, the other kind's at service/<kind>/<name>.
const serviceBackup=(p,s)=>s===p.service?path.join('service',path.basename(s.file)):path.join('service',s.kind,path.basename(s.file));

// A launchd daemon's plist is root's (root:wheel 0644 in /Library/LaunchDaemons): written with sudo from a staged copy
// and read back; any other service file is written by the installer itself.
async function putService(p,world,s,body){
 if(!isDaemon(s)){world.fs.mkdir(path.dirname(s.file),0o755);world.fs.write(s.file,body,0o644);return;}
 const dir=world.fs.tempDir();
 try{
  const staged=path.join(dir,path.basename(s.file));world.fs.write(staged,body,0o644);
  if((await asRoot(p,world,tools.macos.install,['-m','0644','-o','root','-g',tools.macos.group,staged,s.file])).code!==0)refuse(`Could not install ${s.file}`);
 }finally{world.fs.removeTree(dir);}
 const back=world.fs.read(s.file),st=world.fs.stat(s.file);
 if(back===null||sha256(back)!==sha256(Buffer.from(body)))refuse(`${s.file} does not hold the plist the plan rendered`);
 if(!st||st.uid!==0||(st.mode&0o022))refuse(`${s.file} is not root's, or is writable by others`);
}
// Removes a service file (a daemon's with sudo rm). → true only when the command worked and the file is gone.
async function removeService(p,world,s){
 if(isDaemon(s)){const r=await asRoot(p,world,tools.macos.rm,['-f',s.file]);return r.code===0&&!world.fs.exists(s.file);}
 world.fs.remove(s.file);
 return !world.fs.exists(s.file);
}
// The same, in the rollback: a file it cannot remove is said, never thrown.
async function removeSaid(p,world,s){if(!await removeService(p,world,s))world.warn(`  could not remove ${s.file}`);}
/**
 * Puts the previous copy back from the backup. → {start, lost}: start, the service to start again (null when there was
 * none); lost, the previous kind that a switch could not put back (its plist missing from the backup, or not
 * written), or null. On macOS, when the install switched kinds, the kind the previous record ran comes back and the
 * other plist is removed, so one job is left; when it cannot come back, the new kind's plist is left in place, so
 * there is still a service file to start by hand rather than none. otherIntact: the other kind was never booted out,
 * so its plist and job are as they were and are left alone.
 */
async function restore(p,world,saved,other=null,{otherIntact=false}={}){
 const f=world.fs;
 for(const x of p.files)f.remove(path.join(p.paths.target,x.to));
 f.remove(path.join(p.paths.target,AGENT_MANIFEST));
 if(!saved){await removeSaid(p,world,p.service);return {start:null,lost:null};}
 const back=(rel,to,mode)=>{const body=f.read(path.join(saved,rel));if(body===null)return false;f.mkdir(path.dirname(to),0o755);f.write(to,body,mode);return true;};
 const old=JSON.parse(String(f.read(path.join(saved,'code',AGENT_MANIFEST))||'{}'));
 for(const x of old.files||[])back(path.join('code',x.path),path.join(p.paths.target,x.path),x.path.endsWith('.sh')?0o755:0o644);
 back(path.join('code',AGENT_MANIFEST),path.join(p.paths.target,AGENT_MANIFEST),0o644);
 for(const n of ['agent.json','specs.txt','hub-ca.pem'])back(path.join('config',n),path.join(p.paths.config,n),p.platform==='macos'?0o600:0o644);
 // The previous kind: the other one when it was there and the previous record does not say this install's kind.
 const previous=other&&old.service!==p.service.kind?other:p.service,switched=previous!==p.service;
 let had=false;
 if(switched&&otherIntact)had=true;
 else{
  const body=f.read(path.join(saved,serviceBackup(p,previous)));
  if(body!==null){try{await putService(p,world,previous,body);had=true;}catch(e){world.warn(`  ${e.message}`);}}
  else if(switched)world.warn(`  the backup holds no plist of the previous ${previous.kind}`);
 }
 // A switch whose previous kind did not come back keeps the new kind's plist: removing it too would leave none.
 // The other kind, when it was never booted out, is left exactly as it was.
 for(const s of [p.service,other])if(s&&(s!==previous||!had)&&!(switched&&!had&&s===p.service)&&!(otherIntact&&s===other))await removeSaid(p,world,s);
 return {start:had?previous:null,lost:switched&&!had?previous:null};
}
// The commands that put a launchd kind's plist back from the backup and start it, for a person to run.
function startByHand(p,saved,s){
 const from=`'${path.join(saved,serviceBackup(p,s))}'`;
 return isDaemon(s)?`sudo install -m 0644 -o root -g wheel ${from} ${s.file} && sudo launchctl bootstrap system ${s.file}`
  :`install -m 0644 ${from} '${s.file}' && launchctl bootstrap ${s.domain} '${s.file}'`;
}
// strict: a job still loaded after the wait is refused (the other kind of a switch: starting beside it would make two jobs).
async function stopService(p,world,s=p.service,{strict=false}={}){
 if(p.platform!=='macos'){await world.exec(tools.linux.systemctl,['stop',s.label]);return;}
 const target=`${s.domain}/${s.label}`;
 // A daemon is the system domain's: bootout with sudo. print reads either domain without it.
 if(isDaemon(s))await asRoot(p,world,tools.macos.launchctl,['bootout',target]);else await world.exec(tools.macos.launchctl,['bootout',target]);
 // bootout tears the job down asynchronously, and a bootstrap while it is still there fails ("5: Input/output error").
 for(let i=0;i<BOOTOUT_WAIT.tries;i++){
  if((await world.exec(tools.macos.launchctl,['print',target])).code!==0)return;
  await world.sleep(BOOTOUT_WAIT.ms);
 }
 if(strict)refuse(`${target} (the ${s.kind}) is still loaded ${BOOTOUT_WAIT.tries*BOOTOUT_WAIT.ms/1000} s after bootout${isDaemon(s)?' (was sudo refused?)':''}; the new kind is not started beside it`);
 world.warn(`  ${target} is still loaded ${BOOTOUT_WAIT.tries*BOOTOUT_WAIT.ms/1000} s after bootout; trying bootstrap anyway`);
}
async function startService(p,world,s=p.service){
 if(p.platform==='macos'){
  const args=['bootstrap',s.domain,s.file];
  const r=isDaemon(s)?await asRoot(p,world,tools.macos.launchctl,args):await world.exec(tools.macos.launchctl,args);
  if(r.code!==0)refuse(`launchctl bootstrap failed: ${String(r.stderr).trim().slice(0,200)}`);
  return;
 }
 const t=tools.linux.systemctl;
 await world.exec(t,['daemon-reload']);
 const e=await world.exec(t,['enable',p.service.label]);if(e.code!==0)refuse(`systemctl enable failed: ${String(e.stderr).trim().slice(0,200)}`);
 const r=await world.exec(t,['restart',p.service.label]);if(r.code!==0)refuse(`systemctl restart failed: ${String(r.stderr).trim().slice(0,200)}`);
}
/** status.json → lastAcceptedAt (ms) and lastError, or null. */
export function readStatus(text){
 try{const s=JSON.parse(String(text));const at=Date.parse(s?.lastAcceptedAt);return {acceptedAt:Number.isFinite(at)?at:null,lastError:typeof s?.lastError==='string'?s.lastError.slice(0,60):null};}catch{return null;}
}
async function waitAccepted(p,world,since){
 const deadline=since+p.wait*1000;let last=null;
 while(world.now()<deadline){
  last=readStatus(world.fs.read(path.join(p.paths.state,'status.json')));
  if(last?.acceptedAt!==null&&last?.acceptedAt>=since)return {ok:true,status:last};
  await world.sleep(1000);
 }
 return {ok:false,status:last};
}

/**
 * --once: the copy and its configuration in a temporary directory (never where an install is, so an agent that runs
 * now and its backups are left exactly as they were; no key, which --once does not read), run once with --once, and
 * removed. On Linux as the agent's account through runuser; with a fixed environment on both.
 */
async function runOnce(p,world){
 const f=world.fs,dir=f.tempDir();
 try{
  // The account must be able to read the copy (Linux): the directory is root's, 0755, and only root writes in it.
  f.mkdir(dir,0o755);
  const target=path.join(dir,'agent'),config=path.join(dir,'config');
  for(const x of p.files){const at=path.join(target,x.to);f.mkdir(path.dirname(at),0o755);writeChecked(world,at,x.body,x.mode,x.sha256);}
  f.mkdir(config,0o755);
  const caPath=p.caPath?path.join(config,'hub-ca.pem'):null;
  f.write(path.join(config,'agent.json'),renderAgentConfig({platform:p.platform,hub:p.hub.origin,pins:p.pins,caPath,keys:p.keys,runtimes:p.runtimes}),0o644);
  f.write(path.join(config,'specs.txt'),p.specsText,0o644);
  if(caPath)f.write(caPath,p.caText,0o644);
  const args=[path.join(target,CORE_AGENT_ENTRY),'--config',config,'--once'];
  // The daemon's run reads the owner's agents where the daemon will (HOME_HUB_LAUNCHD_DOMAIN, as its plist sets it).
  const env={PATH:SYSTEM_PATH,LC_ALL:'C',HOME:p.platform==='linux'?'/nonexistent':p.home,...(isDaemon(p.service)?{HOME_HUB_LAUNCHD_DOMAIN:p.service.gui}:{})};
  return p.platform==='linux'?await world.exec(tools.linux.runuser,['-u',p.account,'--',p.node,...args],{env}):await world.exec(p.node,args,{env});
 }finally{f.removeTree(dir);}
}

/**
 * Carries the plan out. → {status: 'done'|'rolled-back'|'once'|'once-failed'|'declined'}. once: lay the copy out in a
 * temporary directory and run it once with --once (nothing is sent; no installed file, service or sudoers is touched;
 * on Linux the account is made when it is missing). yes: the watch list was confirmed.
 */
export async function applyCorePlan(p,{world=systemWorld(),once=false,yes=false}={}){
 if(p.platform==='macos'&&world.uid===0)refuse('Run the installer as the owner\'s login account, not with sudo: it asks for sudo itself for the sudoers file');
 if(p.platform==='linux'&&world.uid!==0)refuse('On Linux the installer runs as root (sudo): it makes the account, the unit and the sudoers file');
 // Linux: node runs as the agent's account, with its key and its sudo rules; whoever can replace it would be that account.
 if(p.platform==='linux')safeChain(world,p.node,{why:`node there would run as ${p.account}, which holds the key and the sudo rules; use a node only root can change. Nothing was changed`});
 // The launchd daemon: its plist is root's, in a directory only root writes; node and the copy are the owner's.
 if(isDaemon(p.service)){
  safeChain(world,p.service.file,{existingOnly:true,why:'the launchd daemon\'s plist would not be root\'s alone. Nothing was changed'});
  const why=`launchd would run what is there as ${p.account} from boot. Nothing was changed`;
  if(!world.fs.stat(p.node))refuse(`${p.node} is not there: node must exist for launchd to run it. Nothing was changed`);
  for(const f of new Set([p.node,world.fs.realpath?.(p.node)||p.node]))ownedChain(world,f,{uid:p.uid,why});
  ownedChain(world,p.paths.target,{uid:p.uid,why});
 }
 if(p.specsLines.length&&!yes){
  const ok=await world.confirm(`Install with these ${p.specsLines.length} watch-list line(s)? Each one is run or read on this computer. [y/N] `);
  if(!ok){world.warn('Not confirmed (or no terminal: pass --yes after reading the lines); nothing was changed.');return {status:'declined'};}
 }
 const owner=p.platform==='linux'?await ensureAccount(world,p.account):null;
 if(once){
  const r=await runOnce(p,world);
  if(r.stdout)world.log(String(r.stdout).trimEnd());
  if(r.code!==0)world.warn(String(r.stderr).trim().slice(-2000));
  world.log(r.code===0?'--once: the envelope above passed the agent\'s check; nothing was sent, and nothing installed (copy, service, sudoers) was touched.':'--once: the agent did not produce a report it would send.');
  world.log(`Sudoers rules the full install puts in ${p.paths.sudoers}:\n${p.sudoers.text.trimEnd()}`);
  return {status:r.code===0?'once':'once-failed'};
 }
 const oldText=world.fs.read(path.join(p.paths.target,AGENT_MANIFEST));
 let old=null;try{old=oldText?JSON.parse(String(oldText)):null;}catch{}
 if(old&&old.kind!=='core')refuse(`${p.paths.target} holds another host agent (${String(old.plugin||'?').slice(0,40)}); nothing was changed`);
 // macOS: the other launchd kind, when its plist is there or the previous record ran it, is booted out and removed.
 const other=p.other&&(world.fs.exists(p.other.file)||old?.service===p.other.kind)?p.other:null;
 const saved=backUp(p,world,old,other);
 // The privileged part first: when it is refused, it is undone and the agent that runs now is left as it was.
 const changed={};
 // Its backup goes with it, unless putting the previous probe copy back failed and the backup is where that copy is.
 try{await installPrivileged(p,world,changed);}catch(e){
  const clean=await restorePrivileged(p,world,{old,saved,changed});
  if(saved&&clean)world.fs.removeTree(saved);
  else if(saved)world.warn(`  kept the backup of the previous agent in ${saved}`);
  throw e;
 }
 if(saved)world.log(`  saved the previous agent in ${saved}`);
 await stopService(p,world);
 let health={ok:false,status:null},otherDown=false;
 try{
  // The other kind must be gone, job and plist, before this one starts: a failure here goes to the rollback.
  if(other){await stopService(p,world,other,{strict:true});otherDown=true;world.log(`  booted out the ${other.kind} ${other.label} (${other.domain})`);}
  layOut(p,world,{owner,old});
  await putService(p,world,p.service,p.service.text);
  if(other){if(!await removeService(p,world,other))refuse(`Could not remove ${other.file}${isDaemon(other)?' (sudo rm -f failed, or the file is still there)':''}`);world.log(`  removed ${other.file}`);}
  // Health is a report accepted after this restart: an older status.json says nothing about the new agent.
  world.fs.remove(path.join(p.paths.state,'status.json'));
  const since=world.now();
  await startService(p,world);health=await waitAccepted(p,world,since);
 }catch(e){world.warn(e.message);}
 if(health.ok){world.log(`Installed: the hub accepted the first report (${new Date(health.status.acceptedAt).toISOString()}).`);return {status:'done',saved};}
 world.warn(`No accepted report within ${p.wait} s${health.status?.lastError?` (status.json → lastError: ${health.status.lastError})`:''}; putting the previous agent back.`);
 await stopService(p,world);
 const otherIntact=Boolean(other)&&!otherDown;
 const {start,lost}=await restore(p,world,saved,other,{otherIntact});
 await restorePrivileged(p,world,{old,saved,changed});
 // What is left on disk, said by name: the owner must know whether /Library/LaunchDaemons still holds anything.
 const left=[p.service,other].filter(s=>s&&world.fs.exists(s.file));
 const leftText=left.length?left.map(s=>`the ${s.kind} plist ${s.file}`).join(' and '):`no plist of ${other?'either kind':'it'}`;
 if(start&&start===other&&otherIntact)world.warn(`Rolled back: the previous ${other.kind} was never stopped (its bootout did not take) and still runs as it was; left: ${leftText}.`);
 else if(start){try{await startService(p,world,start);world.warn(`Rolled back: the previous agent was started again${start!==p.service?` (${start.kind})`:''}.`);}catch(e){world.warn(`Rolled back the files, but the previous ${start.kind} did not start: ${e.message}. Left: ${leftText}.`);}}
 else if(lost){
  world.warn(`Rolled back the files, but the previous ${lost.kind} could not be restored; nothing runs. Left: ${leftText}.`);
  world.warn(`  To start the previous ${lost.kind} by hand: ${startByHand(p,saved,lost)}${left.includes(p.service)?`; and remove the ${p.service.kind} plist: ${isDaemon(p.service)?`sudo rm -f ${p.service.file}`:`rm -f '${p.service.file}'`}`:''}`);
 }
 else world.warn(`Rolled back: there was no previous agent; ${left.includes(p.service)?`its ${p.service.kind} plist ${p.service.file} could not be removed`:'its service file was removed'}${changed.sudoers||changed.probe?', and its sudoers file and probe copy as said above':''}.`);
 return {status:'rolled-back',saved};
}

/** The systemd version (`systemctl --version`, first line "systemd 252 (…)"), or null. */
export const systemdVersion=text=>{const m=/^systemd (\d+)/.exec(String(text||''));return m?Number(m[1]):null;};

/** How long the LoadCredential= test may take, in ms (the unit itself is stopped by systemd a little earlier). */
export const LOAD_CREDENTIAL_TEST_MS=15000;

/**
 * Whether this service manager hands a unit its LoadCredential=: one transient unit (removed when it ends, --collect)
 * loads a credential from `source` (a file root can read, not the key) and prints $CREDENTIALS_DIRECTORY. A version of
 * 247 or newer is not proof: systemd 257 in a container dropped the setting from the unit without a word, and the agent
 * then had no key. Some versions refuse the property on a transient unit although a unit file would take it; that, a
 * test that does not end within LOAD_CREDENTIAL_TEST_MS, and anything else count as no, and the plan says why. With
 * --wait systemd-run exits with the unit's code: printenv's 1 is "no such variable".
 * → {ok: true} when the directory was set, else {ok: false, why} (the account's 0400 key file is used instead).
 */
export async function loadCredentialWorks(world,source){
 const r=await world.exec('/usr/bin/systemd-run',['--quiet','--wait','--pipe','--collect','-p',`RuntimeMaxSec=${Math.floor(LOAD_CREDENTIAL_TEST_MS/1000)-5}`,'-p',`LoadCredential=home-hub-agent-test:${source}`,'/usr/bin/printenv','CREDENTIALS_DIRECTORY'],{timeoutMs:LOAD_CREDENTIAL_TEST_MS});
 if(r.code===0&&/^\/\S+$/.test(String(r.stdout).trim()))return {ok:true,why:null};
 const said=String(r.stderr||'').split('\n').map(x=>x.replace(/[^\x20-\x7e]/g,'').trim()).find(Boolean)?.slice(0,160);
 return {ok:false,why:r.timedOut?`systemd-run did not finish within ${LOAD_CREDENTIAL_TEST_MS/1000} s`:said?`systemd-run: ${said}`:r.code===0||r.code===1?'the unit had no $CREDENTIALS_DIRECTORY':`systemd-run exited ${r.code}`};
}

/** install-host-agent.mjs --core: flags → plan → print → apply. → exit code. */
export async function runCoreInstall(argv,{world=systemWorld(),platform={darwin:'macos',linux:'linux'}[process.platform],root=coreRoot,uid=process.getuid?.()??null}={}){
 const o=parseCoreArgs(argv);
 if(o.error){world.warn(o.error);return 2;}
 try{
  const read=(f,what)=>{if(!f)return null;if(!path.isAbsolute(f))refuse(`${what} must be an absolute path`);const b=world.fs.read(f);if(b===null)refuse(`Cannot read ${what} ${f}`);return String(b);};
  // macOS: the owner is the invoking user (SUDO_USER is refused below: the installer is not run with sudo there).
  const user=platform==='macos'?os.userInfo().username:null;
  const account=o.account||user;
  const systemd=platform==='linux'?systemdVersion((await world.exec('/usr/bin/systemctl',['--version'])).stdout):null;
  // Asked only as root (the installer refuses otherwise further on) and only where the version says it could work.
  const test=platform==='linux'&&uid===0&&systemd!==null&&systemd>=LOAD_CREDENTIAL_SINCE?await loadCredentialWorks(world,path.join(root,'package.json')):null;
  const loadCredential=test?test.ok:null,loadCredentialWhy=test?.why??null;
  const ssOk=f=>{const s=world.fs.stat(f);return Boolean(s?.file&&s.uid===0&&!(s.mode&0o022));};
  const home=os.homedir();
  // macOS: the kind the current install runs is kept when --service is not given.
  const installed=platform==='macos'?readInstallRecord(world.fs.read(path.join(corePaths(platform,{home}).target,AGENT_MANIFEST))):null;
  const plan=planCoreInstall({...o,account},{platform,root,home,uid,user,node:process.execPath,systemd,loadCredential,loadCredentialWhy,keyText:read(o.keyFile,'--key-file'),specsText:read(o.specs,'--specs'),caText:read(o.ca,'--ca'),ssOk,installed});
  for(const line of formatCorePlan(plan))world.log(line);
  if(o.dryRun){world.log('Dry run: nothing changed.');return 0;}
  const result=await applyCorePlan(plan,{world:{...world,uid},once:o.once,yes:o.yes});
  return ['done','once'].includes(result.status)?0:1;
 }catch(e){world.warn(e instanceof CoreInstallError?e.message:e.stack||e.message);return 1;}
}
