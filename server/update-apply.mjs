import {V1} from './state-forward.mjs';
// Applying an update: the steps behind scripts/update.mjs (docs/updating.md). The hub never runs this: it is a
// command a person or an agent starts on the server, outside the hub's process, and it works on a checkout and
// an instance that are named to it. Everything that touches the world comes in through `ctx` (exec, probe,
// pidAlive, sleep, now, log, checkpoint), so tests/update-apply.test.mjs drives it with real git repositories
// and a service that is a stand-in.
//
//   resolveInstance()  which checkout, which plugin sources, where data, state and secrets are, how the service is
//                      stopped, started and checked: HOME_HUB_HOME/instance.json, else flags
//   preflight()        everything that can be checked without touching the instance: fetch the tags, resolve the
//                      target, stage it in a scratch worktree, compatibility and the data epoch, the target's tests,
//                      `node server/index.mjs --check` with this instance's site and plugins
//   apply()            preflight, journal, stop, archive, switch (detached at the tag), start, health check; any
//                      failure after the stop puts the previous version back
//   rollback()         the last update, undone by hand
//   recover()          an update that was cut short (a crash, a lost session) is put back on the next run
//   backup()           only the archive
//
// The journal <home>/update-journal.json (without an instance directory: <checkout>/backups/update-journal.json)
// says how far the last update got: stopping → backup → switching → switched → starting → done, or
// rolling-back → rolled-back | aborted | rollback-failed. It is written before each step, so whatever interrupts
// the command, the next run knows what to put back.
//
// Data: state migrates forward only, and older code refuses newer state (server/db.mjs). When the target's data
// epoch is higher (package.json → homeHub.dataEpoch, or a plugin's plugin.json → dataEpoch), going back is the old
// code AND the archive made here with the hub stopped; the directories it replaces are moved aside, never deleted.
//
// Only static imports: the command may be running from the very checkout it switches, so nothing is loaded later.
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,readdirSync,statSync,appendFileSync,cpSync,symlinkSync,mkdtempSync,chmodSync,realpathSync,lstatSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {convertSite} from '../scripts/convert-site.mjs';
import {repoRoot} from './edition.mjs';
import {resolvePaths} from './paths.mjs';
import {readInstance} from './plugins.mjs';
import {parse,compare,satisfies,validRange} from './semver.mjs';
import {parseService,parseHealth,parseBackups,UpdateConfigError,DEFAULT_HEALTH_SECONDS} from './update-config.mjs';
import {loadTrust,authorizedKeys,sha256,durableWrite,selectTrustFile,rememberTrustSelection} from './release-trust.mjs';
import {UPDATES_SCHEMA} from './update-check.mjs';

import {verifyPackage,writePackageReceipt,authenticatePackageMetadata,verifyStagedTree} from './release-package.mjs';
import {packageReceipt} from './build-info.mjs';
import {within,syncDirectory} from './release-trust.mjs';
import {identityMismatch,observeReadiness,healthSample} from './update-readiness.mjs';
import {contentFingerprint,pluginSourceFingerprint} from './runtime-identity.mjs';
import {backupPlan,createBackup,restoreBackup} from './update-backup.mjs';
import {UpdateError,RollbackFailed} from './update-errors.mjs';
import {acquireLock,acquireSourceLocks} from './update-lock.mjs';
import {JOURNAL_SCHEMA,TERMINAL_STEPS,readUpdateJournal,writeUpdateJournal,unfinished,recordMutation} from './update-journal.mjs';
export {UpdateError,RollbackFailed,JOURNAL_SCHEMA,TERMINAL_STEPS,unfinished};

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const inside=(child,parent)=>{const rel=path.relative(parent,child);return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));};
const stampOf=ms=>new Date(ms).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
const iso=ms=>new Date(ms).toISOString();
const short=commit=>commit?commit.slice(0,7):'?';
const oneLine=(text,max=300)=>String(text??'').replace(/\s+/g,' ').trim().slice(0,max);
const lastLines=(text,n)=>String(text??'').trimEnd().split('\n').slice(-n).join('\n');
const writeAtomic=(file,text)=>durableWrite(file,text);
const digest=text=>createHash('sha256').update(text).digest('hex');
const siteBytes=file=>{try{return readFileSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const hashOf=bytes=>bytes===null?null:digest(bytes);
// Configuration is part of the update transaction. The staged check reads a copy, never a conversion of the live
// file. The plan keeps the replacement in memory; the journal holds paths and hashes only, never site contents.
function stageSite(inst,request,installed,target,staging){
 const automatic=parse(installed.version).major===1&&parse(target.version).major===2;
 if(!request.siteConfig&&!automatic)return null;
 if(!inst.paths.siteConfig){if(request.siteConfig)throw new UpdateError('--site-config needs a live site path (HOME_HUB_SITE_CONFIG must not be "none").');return null;}
 const given=path.resolve(inst.paths.siteConfig),file=existsSync(given)?realpathSync(given):given,original=siteBytes(file);
 let text;
 try{
  if(automatic&&original!==null){
   const raw=JSON.parse(original.toString('utf8'));
   if(plain(raw)&&(Object.hasOwn(raw,'devices')||(Array.isArray(raw.runtimes)&&raw.runtimes.some(r=>plain(r)&&Object.hasOwn(r,'device')))))
    throw new Error('the live legacy site already has current keys; restore its working legacy configuration before updating');
  }
  if(request.siteConfig)text=readFileSync(path.resolve(request.siteConfig),'utf8');
  else{
   if(original===null)return null;
   const raw=JSON.parse(original.toString('utf8'));
   // No renamed key means this configuration needs no conversion. --check still validates it with the target.
   if(!plain(raw))throw new Error('the site file must be a JSON object');
   if(!Object.hasOwn(raw,V1.devices)&&!(Array.isArray(raw.runtimes)&&raw.runtimes.some(r=>plain(r)&&Object.hasOwn(r,V1.device))))return null;
   text=JSON.stringify(convertSite(raw).site,null,2)+'\n';
  }
  JSON.parse(text);
 }catch(e){throw new UpdateError(`Cannot stage the site configuration: ${e.message}. The live file was not changed.`);}
 if(original!==null&&original.equals(Buffer.from(text)))return null;
 const staged=path.join(staging,'site-config.json');writeAtomic(staged,text);
 return {file,baseHash:hashOf(original),mode:original===null?0o600:statSync(file).mode&0o777,text,staged};
}
function checkSiteUnchanged(site){
 const bytes=siteBytes(site.file);
 if(hashOf(bytes)!==site.baseHash)throw new UpdateError(`The ${site.label??'site'} configuration changed since preflight. Run the update again; no configuration was replaced.`);
 return bytes;
}
const replaceSite=(file,bytes,mode)=>durableWrite(file,bytes,mode);
function restoreSite(inst,journal,key='site'){
 const site=journal[key];
 if(!site||!['applying','applied'].includes(site.status))return;
 if(site.baseHash===null)rmSync(site.file,{force:true});
 else{
  const bytes=siteBytes(site.backup);
  if(bytes===null||hashOf(bytes)!==site.baseHash)throw new Error(`the original ${key} configuration is missing or changed: ${site.backup}`);
  replaceSite(site.file,bytes,site.mode);
 }
 site.status='restored';writeJournal(inst,journal);
}
// An inactive checkout can be prepared ahead of time, but must not enter the live manifest until its matching
// core/plugins are installed. This option only appends plugin sources: service, health and core paths stay fixed.
function addedPluginSources(inst,request){
 const names=request.addPluginSources??[];
 if(!names.length)return {sources:[],change:null};
 if(!inst.home)throw new UpdateError('--add-plugin-source needs HOME_HUB_HOME and its instance.json.');
 if(inst.env.HOME_HUB_PLUGINS_DIR)throw new UpdateError('--add-plugin-source cannot be used while HOME_HUB_PLUGINS_DIR overrides instance.json.');
 if(!Array.isArray(names)||names.some(n=>typeof n!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)))throw new UpdateError('--add-plugin-source takes a directory name inside the instance.');
 const named=path.join(inst.home,'instance.json');
 if(!existsSync(named))throw new UpdateError('--add-plugin-source needs an existing instance.json.');
 const file=realpathSync(named),original=readFileSync(file),raw=JSON.parse(original.toString('utf8'));
 const existing=readInstance(inst.home)?.sources.plugins;
 if(!Array.isArray(existing))throw new UpdateError('--add-plugin-source needs an explicit sources.plugins list in instance.json (an empty list is allowed).');
 const combined=[...existing,...names];
 if(combined.length>16||new Set(combined).size!==combined.length)throw new UpdateError('--add-plugin-source would repeat a source or exceed the limit of 16.');
 const sources=names.map(name=>{
  if(['core','node_modules'].includes(name)||name===raw.sources.core||inst.sources.some(s=>s.id===name))throw new UpdateError(`--add-plugin-source ${name}: the source name is already in use or reserved.`);
  if(typeof request.plugins?.[name]!=='string')throw new UpdateError(`--add-plugin-source ${name} also needs --plugins ${name}=<tag>, so its target is explicit.`);
  const dir=path.join(inst.home,name);
  if(!existsSync(path.join(dir,'plugins'))||!existsSync(path.join(dir,'package.json')))throw new UpdateError(`--add-plugin-source ${name}: prepare its checkout at ${dir} first; the inactive checkout must have package.json and plugins/.`);
  return {id:name,kind:'plugins',dir,plugins:['plugins'],added:true};
 });
 return {sources,change:{file,baseHash:hashOf(original),mode:statSync(file).mode&0o777,label:'instance',text:JSON.stringify({...raw,sources:{...raw.sources,plugins:combined}},null,2)+'\n'}};
}
const TAG=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/;

// --- the world, as the real command sees it ----------------------------------------------------------
/** exec(command, args, {cwd, env, timeoutMs}) → {status, stdout, stderr}; never throws. 127: not found, 124: timed out. */
export function realExec(command,args,{cwd,env,timeoutMs=120000}={}){
 const r=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:timeoutMs,maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
 if(r.error)return {status:r.error.code==='ETIMEDOUT'?124:127,stdout:r.stdout||'',stderr:`${r.stderr||''}${r.error.message}`};
 return {status:r.status??124,stdout:r.stdout||'',stderr:r.stderr||''};
}
export const realProbe=healthSample;
const probeOk=async(ctx,url)=>{const sample=await ctx.probe(url);return typeof sample==='object'?sample.ok:sample;};
export function realPidAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=1)return false;
 try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}
}
export const realContext=(extra={})=>({exec:realExec,probe:realProbe,pidAlive:realPidAlive,sleep:ms=>new Promise(r=>setTimeout(r,ms)),now:Date.now,monotonic:()=>performance.now(),log:line=>console.log(line),
 checkpoint:()=>{},node:process.execPath,user:(()=>{try{return os.userInfo().username;}catch{return null;}})(),stopSeconds:45,...extra});

const safeGitEnv=()=>({...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_COUNT:'0'});
const safeGitArgs=dir=>['-C',dir,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','submodule.recurse=false'];
const git=(ctx,dir,...args)=>{const r=ctx.exec('git',[...safeGitArgs(dir),...args],{env:safeGitEnv()});return r.status===0?r.stdout.trim():null;};
function gitDo(ctx,dir,...args){
 const r=ctx.exec('git',[...safeGitArgs(dir),...args],{env:safeGitEnv()});
 if(r.status!==0)throw new Error(`git ${args.join(' ')} failed in ${dir}: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}`);
 return r.stdout.trim();
}

// --- the instance --------------------------------------------------------------------------------------
/**
 * env: the environment with the instance variables (HOME_HUB_HOME, DATA_DIR, STATE_DIR, …; the command's --home,
 * --data, --state and --private flags are written into it first). root: the core checkout this code runs from.
 * options: {root, service, health, healthSeconds, backups, keep, staging} from the flags; each wins over instance.json.
 */
export function resolveInstance({env=process.env,root=repoRoot,options={}}={}){
 const home=env.HOME_HUB_HOME?path.resolve(env.HOME_HUB_HOME):null;
 const instanceFile=home?path.join(home,'instance.json'):null,instanceBytes=instanceFile?siteBytes(instanceFile):null;
 let instance=null;
 try{instance=home?readInstance(home):null;}catch(e){throw new UpdateError(e.message);}
 if(instanceFile&&hashOf(siteBytes(instanceFile))!==hashOf(instanceBytes))throw new UpdateError('Instance configuration changed while resolving; retry.');
 const core=path.resolve(options.root??(home&&instance?.sources.core?path.join(home,instance.sources.core):root));
 if(!options.recovery&&!existsSync(path.join(core,'package.json')))throw new UpdateError(`${core} is not a Home Hub checkout (it has no package.json)`);
 const p=resolvePaths(env,core);
 const paths=Object.freeze({config:p.config,siteConfig:p.siteConfig,data:path.resolve(p.data),state:path.resolve(p.state),private:p.private,authFile:path.resolve(p.authFile),softwareWatch:p.softwareWatch});
 let service=null,health=null,backups;
 try{
  const spec=options.service??instance?.service??null;service=spec?parseService(spec):null;
  const url=options.health??instance?.health?.url??null;
  health=url?parseHealth({url,seconds:options.healthSeconds??instance?.health?.seconds??DEFAULT_HEALTH_SECONDS}):null;
  backups=parseBackups(options.keep!==undefined&&options.keep!==null?{keep:options.keep}:instance?.backups??{});
 }catch(e){if(e instanceof UpdateConfigError)throw new UpdateError(e.message);throw e;}
 // Where the plugins are: the same order of choice as the server (server/plugins.mjs → pluginsDirectories).
 const chosen=env.HOME_HUB_PLUGINS_DIR;
 const pluginDirs=chosen==='none'?[]:chosen?[...new Set(chosen.split(path.delimiter).filter(Boolean).map(d=>path.resolve(d)))]
  :home&&instance?.sources.plugins?instance.sources.plugins.map(name=>path.join(home,name,'plugins')):[path.join(core,'local','plugins')];
 const sources=[{id:'core',kind:'core',dir:core,plugins:[]}];
 for(const dir of pluginDirs){
  if(!existsSync(dir))continue;
  if(inside(dir,core)){sources[0].plugins.push(path.relative(core,dir));continue;}
  const base=path.dirname(dir);let id=path.basename(base)||'plugins';
  const known=sources.find(s=>s.dir===base);
  if(known){known.plugins.push(path.basename(dir));continue;}
  for(let n=2;id==='core'||id==='node_modules'||sources.some(s=>s.id===id);n++)id=`${path.basename(base)}-${n}`;
  sources.push({id,kind:'plugins',dir:base,plugins:[path.basename(dir)]});
 }
 const work=home??path.join(core,'backups');
 return Object.freeze({home,root:core,env,instanceHash:hashOf(instanceBytes),paths,service,health,keep:backups.keep,sources:Object.freeze(sources),
  backupRoots:options.backupRoots??[],trustFile:options.trust??(home?path.join(home,'update','trust.json'):null),
  backups:path.resolve(options.backups??(home?path.join(home,'backups'):path.join(core,'backups'))),
  staging:path.resolve(options.staging??(home?path.join(home,'staging'):os.tmpdir())),
  files:Object.freeze({journal:path.join(work,'update-journal.json'),lock:path.join(work,'update.lock'),history:path.join(paths.state,'update-history.jsonl'),run:path.join(paths.state,'run.json'),updates:path.join(paths.state,'updates.json')})});
}

// --- facts read from files -----------------------------------------------------------------------------
// Read leniently on purpose: the target may be newer than this code and know fields this code does not. What is
// strict is the target's own `--check`.
/** package.json of a core tree → {version, dataEpoch, node} or null. */
export function coreFacts(input){
 const p=typeof input==='string'?readJson(path.join(input,'package.json')):input;
 if(!plain(p)||!parse(p.version))return null;
 const epoch=p.homeHub?.dataEpoch;
 return {version:parse(p.version).text,dataEpoch:Number.isSafeInteger(epoch)&&epoch>=1?epoch:1,node:typeof p.engines?.node==='string'?p.engines.node:null};
}
/** Every plugin of a plugins directory → [{id, version, core, requires, dataEpoch}] (version and core null without plugin.json). */
export function pluginFacts(directory){
 if(!existsSync(directory))return [];
 const pkg=readJson(path.join(path.dirname(directory),'package.json')),own=plain(pkg)&&pkg.name!=='home-hub'?pkg:null;
 return readdirSync(directory,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&!d.name.startsWith('_')&&existsSync(path.join(directory,d.name,'index.mjs'))).map(d=>d.name).sort().map(id=>{
  const m=readJson(path.join(directory,id,'plugin.json'));
  if(!plain(m))return {id,version:null,core:null,requires:{},dataEpoch:null};
  const version=parse(m.version??own?.version)?.text??null,core=m.core??own?.homeHub?.core??null;
  return {id,version,core:typeof core==='string'?core:null,requires:plain(m.requires)?m.requires:{},dataEpoch:Number.isSafeInteger(m.dataEpoch)?m.dataEpoch:null};
 });
}
const pluginsOf=(inst,place=s=>s.dir)=>inst.sources.flatMap(s=>s.plugins.flatMap(rel=>pluginFacts(path.join(place(s),rel))));
/** <state>/run.json → what the running hub wrote when it began to listen, or null. */
export const readRun=inst=>{const r=readJson(inst.files.run);return plain(r)&&typeof r.version==='string'?r:null;};

/** Why run.json is not the hub that was expected ('' when it is). expect: {version, plugins:[{id, version}]}. */
export const runMismatch=identityMismatch;

// --- sources as git sees them --------------------------------------------------------------------------
function inspectSource(ctx,source){
 const top=git(ctx,source.dir,'rev-parse','--show-toplevel');
 let isGit=false;try{isGit=Boolean(top)&&statSync(top).ino===statSync(source.dir).ino;}catch{}
 if(!isGit)return {...source,git:false,commit:null,branch:null,dirty:[],tag:null};
 const commit=git(ctx,source.dir,'rev-parse','HEAD'),branch=git(ctx,source.dir,'symbolic-ref','--short','-q','HEAD')||null;
 const dirty=(git(ctx,source.dir,'status','--porcelain','--untracked-files=no')||'').split('\n').filter(Boolean);
 const tag=(git(ctx,source.dir,'tag','--points-at','HEAD')||'').split('\n').filter(Boolean)[0]||null;
 return {...source,git:true,commit,branch,dirty,tag};
}
const tagCommit=(ctx,dir,tag)=>git(ctx,dir,'rev-parse','-q','--verify',`refs/tags/${tag}^{commit}`);
function newestTag(ctx,dir){
 const tags=(git(ctx,dir,'tag','--list','v*')||'').split('\n').map(t=>t.trim()).filter(t=>{const v=parse(t.slice(1));return t.startsWith('v')&&v&&!v.prerelease.length;});
 return tags.sort((a,b)=>compare(a.slice(1),b.slice(1))).at(-1)||null;
}
// Files that are not tracked here but are tracked in the target: git would refuse the checkout over them.
function collisions(ctx,dir,commit){
 const untracked=(git(ctx,dir,'ls-files','--others','--exclude-standard')||'').split('\n').filter(Boolean);if(!untracked.length)return [];
 const there=new Set((git(ctx,dir,'ls-tree','-r','--name-only',commit)||'').split('\n'));
 return untracked.filter(f=>there.has(f));
}

// --- updates.json: the note the update card reads ---------------------------------------------------------
/** quarantined[version] = entry ({at, reason}), or removed with entry null. → false when the file belongs to newer code. */
export function setQuarantine(file,version,entry){
 const raw=existsSync(file)?readJson(file):null;
 if(Number.isInteger(raw?.schemaVersion)&&raw.schemaVersion>UPDATES_SCHEMA)return false;
 const doc=plain(raw)&&[1,UPDATES_SCHEMA].includes(raw.schemaVersion)?{...raw,schemaVersion:UPDATES_SCHEMA}:{schemaVersion:UPDATES_SCHEMA,sources:{},quarantined:{},dismissed:null};
 const {[version]:had,...rest}=plain(doc.quarantined)?doc.quarantined:{};
 if(!entry&&had===undefined)return true;
 doc.quarantined=Object.fromEntries([...(entry?[[version,{at:entry.at,reason:oneLine(entry.reason,120)||null}]]:[]),...Object.entries(rest)].slice(0,50));
 writeAtomic(file,JSON.stringify(doc,null,1)+'\n');
 return true;
}
export const readQuarantine=file=>{const raw=readJson(file);return plain(raw?.quarantined)?raw.quarantined:{};};

// --- journal, lock, history ----------------------------------------------------------------------------
export const readJournal=inst=>{const journal=readUpdateJournal(inst.files.journal);if(journal&&path.resolve(journal.settings.root)!==path.resolve(inst.root))throw new UpdateError('Journal belongs to another core path; use its original --root/instance settings.');return journal;};
const writeJournal=(inst,journal)=>writeUpdateJournal(inst.files.journal,journal);
const takeLock=(inst,ctx)=>{const release=acquireLock(inst.files.lock,{now:ctx.now});if(inst.home&&hashOf(siteBytes(path.join(inst.home,'instance.json')))!==inst.instanceHash){release();throw new UpdateError('Instance configuration changed before lock acquisition; resolve it again.');}return release;};
function history(inst,ctx,journal,result){
 try{
  mkdirSync(path.dirname(inst.files.history),{recursive:true});
  appendFileSync(inst.files.history,JSON.stringify({at:iso(ctx.now()),id:journal.id,from:journal.from.label,to:journal.to.label,by:journal.by,seconds:Math.round((ctx.now()-Date.parse(journal.startedAt))/1000),result,
   ...(journal.failure?{reason:journal.failure.message}:{})})+'\n',{mode:0o600});
 }catch(e){ctx.log(`  (could not write ${inst.files.history}: ${e.message})`);}
}

// --- the service ---------------------------------------------------------------------------------------
const needService=inst=>{
 if(!inst.service)throw new UpdateError(`How to stop and start the hub is not known. Say it with --service (launchd:system/<label>, systemd:<unit>, or command:{"stop":[…],"start":[…]})${inst.home?', or as "service" in '+path.join(inst.home,'instance.json'):''}.`);
 if(!inst.health)throw new UpdateError(`Where the hub answers is not known. Say it with --health http://127.0.0.1:<port>/healthz${inst.home?', or as "health" in '+path.join(inst.home,'instance.json'):''}.`);
};
const isDown=async(inst,ctx,pid)=>!(pid&&ctx.pidAlive(pid))&&!(await probeOk(ctx,inst.health.url));
/** Stops the service and waits until its process is gone and nothing answers. A stop command that fails is fine when the hub is down anyway. */
async function stopService(inst,ctx,pid){
 ctx.log(`  $ ${inst.service.stop.join(' ')}`);
 const r=ctx.exec(inst.service.stop[0],inst.service.stop.slice(1),{timeoutMs:60000});
 const deadline=ctx.now()+ctx.stopSeconds*1000;
 for(;;){
  if(await isDown(inst,ctx,pid)){if(r.status!==0)ctx.log(`  (the stop command said: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}; the hub is down)`);return;}
  // Refused (no permission, no such service) with the hub still up: nothing happened, and undo() leaves it alone.
  if(r.status!==0)throw Object.assign(new Error(`the service did not stop: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}`),{stopRefused:true});
  if(ctx.now()>=deadline)throw new Error(`the service was told to stop, but ${pid&&ctx.pidAlive(pid)?`pid ${pid} is still running`:`${inst.health.url} still answers`} after ${ctx.stopSeconds} s`);
  await ctx.sleep(300);
 }
}
async function startService(inst,ctx){
 ctx.log(`  $ ${inst.service.start.join(' ')}`);
 let r;
 for(let attempt=1;;attempt++){
  r=ctx.exec(inst.service.start[0],inst.service.start.slice(1),{timeoutMs:60000});
  if(r.status===0)return;
  if(attempt>=inst.service.startTries)break;
  await ctx.sleep(2000);
 }
 throw new Error(`the service did not start: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}`);
}
/** Waits until the health address answers 200 and run.json shows the expected hub, started after `since`. */
async function waitHealthy(inst,ctx,expect,since,{interruptible=true}={}){
 return observeReadiness({inst,ctx,expect,since,readRun,previousBootId:expect.previousBootId,interruptible});
}

// --- the archive ---------------------------------------------------------------------------------------
export const archiveEntries=inst=>backupPlan(inst).roots;
export const makeArchive=(inst,ctx,name)=>createBackup(inst,ctx,name);
export const restoreArchive=(inst,ctx,backup,journal)=>restoreBackup(inst,ctx,backup,journal);
function pruneArchives(inst,ctx,keepFile){
 try{
  const old=readdirSync(inst.backups).filter(n=>/^pre-.*\.tgz$/.test(n)).map(n=>({file:path.join(inst.backups,n),at:statSync(path.join(inst.backups,n)).mtimeMs})).sort((a,b)=>b.at-a.at).slice(inst.keep).filter(a=>a.file!==keepFile);
  const active=readJournal(inst);
  for(const a of old){if(active?.backup?.file===a.file)continue;for(const suffix of ['.manifest.json','.integrity.json'])rmSync(a.file+suffix,{force:true});rmSync(a.file,{force:true});for(const key of ['site','instance'])rmSync(a.file+`.${key}.json`,{force:true});ctx.log(`  removed the old archive ${a.file}`);}
 }catch{}
}

// --- preflight -----------------------------------------------------------------------------------------
// Fixture tests need the operating system and toolchain, never the live service's sockets, credentials or Node
// injection settings. An allowlist also covers plugin variables core cannot know. Preserve the spelling of Windows
// environment keys (Path/SystemRoot, for example). The final --check still gets the full instance environment.
const TEST_ENV=new Set(['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','TZ','LANG','LANGUAGE',
 'LC_ALL','LC_CTYPE','LC_COLLATE','LC_MESSAGES','LC_MONETARY','LC_NUMERIC','LC_TIME','LC_PAPER','LC_NAME','LC_ADDRESS','LC_TELEPHONE','LC_MEASUREMENT','LC_IDENTIFICATION',
 'SYSTEMROOT','SYSTEMDRIVE','WINDIR','COMSPEC','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA']);
const testEnv=env=>Object.fromEntries(Object.entries(env).filter(([k])=>TEST_ENV.has(k.toUpperCase())));
function hasTests(source,staged){
 const has=dir=>existsSync(dir)&&readdirSync(dir).some(f=>/\.test\.mjs$/.test(f));
 const plugins=path.join(staged,'plugins');
 return has(path.join(staged,'tests'))||(existsSync(plugins)&&readdirSync(plugins,{withFileTypes:true}).some(d=>d.isDirectory()&&has(path.join(plugins,d.name,'tests'))));
}
function runStep(ctx,title,command,args,options){
 ctx.log(`  $ ${[path.basename(command),...args].join(' ')}   (in ${options.cwd})`);
 const r=ctx.exec(command,args,{timeoutMs:1800000,...options});
 if(r.status!==0)throw new UpdateError(`${title} failed (exit ${r.status}). The instance was not touched.\n${lastLines(`${r.stdout}\n${r.stderr}`,40)}`);
 return r;
}
/**
 * request: {core: 'v1.3.0' | null (the newest tag here, unless only plugins were asked for), plugins: {'<source>'|'*': '<tag>'},
 *  fetch (default true), skipTests, allowUnsigned, force}.
 * → the plan: {from, to, changes: [{id, dir, from, to, tag, branch}], epochRose, expect, lines: […]}. Throws UpdateError.
 * forApply also requires what only an apply needs: the service, the health address, and a hub that is running now.
 */
export async function preflight(inst,request,ctx,{forApply=false,sourceLocksHeld=false}={}){
 if(!sourceLocksHeld){const release=acquireSourceLocks([...inst.sources,...addedPluginSources(inst,request).sources],{now:ctx.now});try{return await preflight(inst,request,ctx,{forApply,sourceLocksHeld:true});}finally{release();}}

 if(request.trust)inst={...inst,trustFile:path.resolve(request.trust)};
 if(request.package)return preflightPackage(inst,request,ctx,{forApply});
 let trustFile;try{trustFile=selectTrustFile({home:inst.home,explicit:request.trust});}catch(e){throw new UpdateError(`Trust selection refused: ${e.message}`);}
 let trust=null;if(trustFile){try{trust=loadTrust(trustFile,{forbidden:[inst.root,inst.paths.config,inst.paths.data,inst.paths.state,inst.paths.private,...inst.backupRoots]});rememberTrustSelection(inst.home,trustFile);}catch(e){throw new UpdateError(`Trust policy refused: ${e.message}`);}}
 const initialSnapshot=sourceSnapshot(inst,ctx);
 const say=line=>ctx.log(line);
 const addedSources=addedPluginSources(inst,request);
 const live=[...inst.sources,...addedSources.sources].map(s=>inspectSource(ctx,s)),core=live[0];
 if(!core.git)throw new UpdateError(`${core.dir} is not a git checkout: there is nothing to switch. (A container image is rebuilt instead: docs/docker.md.)`);
 const installed=coreFacts(core.dir);
 if(!installed)throw new UpdateError(`${core.dir}/package.json has no version.`);
 const run=readRun(inst);
 if(forApply){
  needService(inst);
  if(!run)throw new UpdateError(`${inst.files.run} is missing. A running hub writes it, so either the hub is not running or its state directory is somewhere else: pass --state (or STATE_DIR), as the service has it.`);
  const why=runMismatch(run,{version:installed.version},{pidAlive:ctx.pidAlive});
  if(why)throw new UpdateError(`The hub is not running what this checkout holds: ${why}. Start (or restart) it first; an update begins from a hub that works.`);
  if(typeof run.commit==='string'&&run.commit&&!core.commit.startsWith(run.commit))throw new UpdateError(`The hub was started from commit ${run.commit}, and the checkout is now on ${short(core.commit)}: restart it first, so that "the previous version" is one that has run.`);
  if(!(await probeOk(ctx,inst.health.url)))throw new UpdateError(`${inst.health.url} does not answer now, before anything was changed. Check the address: a health check that cannot pass would roll every update back.`);
 }
 // 1. what is asked for
 const wanted=new Map();
 for(const [name,tag] of Object.entries(request.plugins||{})){
  const targets=name==='*'?live.filter(s=>s.kind==='plugins'):live.filter(s=>s.kind==='plugins'&&s.id===name);
  if(name==='*'&&targets.length!==1)throw new UpdateError(targets.length?`There are ${targets.length} plugin sources (${targets.map(s=>s.id).join(', ')}): say which, as --plugins <source>=<tag>.`:'--plugins: this instance has no plugin source outside the core checkout.');
  if(!targets.length)throw new UpdateError(`--plugins ${name}=…: there is no plugin source "${name}" (there ${live.length>1?'is '+live.slice(1).map(s=>s.id).join(', '):'are none'}).`);
  if(!TAG.test(tag))throw new UpdateError(`"${tag}" is not a tag name.`);
  wanted.set(targets[0].id,tag);
 }
 const coreAsked=request.core??null;
 if(coreAsked!==null&&!(coreAsked.startsWith('v')&&parse(coreAsked.slice(1))))throw new UpdateError(`"${coreAsked}" is not a release tag. Releases are tagged v<version>, such as v${installed.version}.`);
 for(const s of live)if((s.id==='core'||wanted.has(s.id))&&s.git&&s.dirty.length)throw new UpdateError(`${s.dir} has uncommitted changes to tracked files; an update would have to discard them:\n${s.dirty.slice(0,10).join('\n')}`);
 // 2. the tags
 for(const s of live){
  if(!s.git||!(s.id==='core'?coreAsked!==null||!wanted.size:wanted.has(s.id)))continue;
  if(request.fetch===false){say(`  ${s.id}: not fetching (--no-fetch); using the tags that are here`);continue;}
  const remotes=(git(ctx,s.dir,'remote')||'').split('\n').filter(Boolean),remote=remotes.includes('origin')?'origin':remotes[0];
  if(!remote){say(`  ${s.id}: no remote; using the tags that are here`);continue;}
  const r=ctx.exec('git',[...safeGitArgs(s.dir),'fetch','--tags','--quiet',remote],{env:safeGitEnv(),timeoutMs:120000});
  if(r.status!==0)throw new UpdateError(`git fetch --tags ${remote} failed in ${s.dir}: ${oneLine(r.stderr)||`exit ${r.status}`}\nWith --no-fetch the tags already here are used.`);
  say(`  ${s.id}: fetched tags from ${remote}`);
 }
 // 3. the targets
 const changes=[],lines=[];
 const coreTag=coreAsked??(wanted.size?null:newestTag(ctx,core.dir));
 let target=installed,targetCommit=core.commit;
 if(coreTag){
  const commit=tagCommit(ctx,core.dir,coreTag);
  if(!commit)throw new UpdateError(`There is no tag ${coreTag} in ${core.dir}${request.fetch===false?' (nothing was fetched)':''}.`);
  const there=coreFacts(readJsonText(git(ctx,core.dir,'show',`${commit}:package.json`)));
  if(!there)throw new UpdateError(`${coreTag} has no package.json with a version.`);
  if(there.version!==parse(coreTag.slice(1)).text)throw new UpdateError(`${coreTag} is not what it says: its package.json reads ${there.version}.`);
  const order=compare(there.version,installed.version);
  if(order<0)throw new UpdateError(`${there.version} is lower than what is installed (${installed.version}). Going back is "rollback", and only to the version the last update came from.`);
  if(commit!==core.commit){target=there;targetCommit=commit;changes.push({id:'core',dir:core.dir,from:core.commit,to:commit,tag:coreTag,branch:core.branch});}
  else if(coreAsked===null&&!wanted.size)throw new UpdateError(`Nothing to do: ${installed.version} (${coreTag}) is the newest release tag in ${core.dir}.`);
  else if(!wanted.size)throw new UpdateError(`Nothing to do: ${core.dir} is already on ${coreTag}.`);
 }else if(!wanted.size)throw new UpdateError(`Nothing to do: ${core.dir} has no release tag. Name one: apply v<version>.`);
 if(target.dataEpoch<installed.dataEpoch)throw new UpdateError(`${coreTag} has data epoch ${target.dataEpoch}, lower than the installed ${installed.dataEpoch}: it could not read this instance's state.`);
 const quarantines=readQuarantine(inst.files.updates),quarantined=quarantines[target.version]??quarantines['git-'+targetCommit];
 if(changes.length&&quarantined&&!request.force)throw new UpdateError(`${target.version} was tried here on ${String(quarantined.at).slice(0,10)} and rolled back${quarantined.reason?` (${quarantined.reason})`:''}. --force tries it again.`);
 for(const [id,tag] of wanted){
  const s=live.find(x=>x.id===id);
  if(!s.git)throw new UpdateError(`The plugin source ${s.dir} is not a git checkout; it cannot be switched to ${tag}.`);
  const commit=tagCommit(ctx,s.dir,tag);
  if(!commit)throw new UpdateError(`There is no tag ${tag} in ${s.dir}.`);
  const now=parse(readJson(path.join(s.dir,'package.json'))?.version),then=parse(readJsonText(git(ctx,s.dir,'show',`${commit}:package.json`))?.version);
  if(now&&then&&compare(then,now)<0)throw new UpdateError(`${s.id} ${tag} is ${then.text}, lower than what is installed (${now.text}).`);
  if(commit!==s.commit||s.added)changes.push({id,dir:s.dir,from:s.commit,to:commit,tag,branch:s.branch,...(s.added?{added:true}:{})});
 }
 if(!changes.length)throw new UpdateError('Nothing to do: every source is already on what was asked for.');
 for(const c of changes){
  const hit=collisions(ctx,c.dir,c.to);
  if(hit.length)throw new UpdateError(`${c.dir} has untracked file(s) that ${c.tag} also contains; git would refuse the switch:\n${hit.slice(0,10).join('\n')}`);
  c.tagObject=git(ctx,c.dir,'rev-parse',`refs/tags/${c.tag}`);
  if(trust){
   const raw=readJson(path.join(c.dir,'package.json')),repository=c.id==='core'?updateRepository(inst):raw?.homeHub?.publisher;
   if(!repository)throw new UpdateError(`${c.id}: no publisher repository identity configured`);
   if(git(ctx,c.dir,'config','--get-regexp','^filter\\.')||git(ctx,c.dir,'config','--get','core.attributesFile'))throw new UpdateError('Hardened Git refuses configured checkout filters and external attributes');
   const info=git(ctx,c.dir,'rev-parse','--git-path','info/attributes'),grafts=git(ctx,c.dir,'rev-parse','--git-path','info/grafts');for(const file of [info,grafts].filter(Boolean)){const resolved=path.resolve(c.dir,file);if(existsSync(resolved)&&readFileSync(resolved,'utf8').trim())throw new UpdateError('Hardened Git refuses local attributes and grafts');}
   if(git(ctx,c.dir,'cat-file','-t',c.tagObject)!=='tag')throw new UpdateError('Hardened Git updates require an annotated signed tag');
   const keys=authorizedKeys(trust,repository,'git',c.tag.slice(1));if(!keys.length)throw new UpdateError(`${c.id}: no authorized Git signers for ${repository}`);
   const signerDir=mkdtempSync(path.join(os.tmpdir(),'hub-signers-')),signerFile=path.join(signerDir,'allowed');
   try{
    writeFileSync(signerFile,keys.map(k=>`release namespaces="git" ${k.publicKey.trim()}`).join('\n')+'\n',{mode:0o600});
    const r=ctx.exec('git',[...safeGitArgs(c.dir),'-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen','-c',`gpg.ssh.allowedSignersFile=${signerFile}`,'verify-tag',c.tagObject],{env:safeGitEnv()});
    if(r.status!==0)throw new UpdateError(`${c.id}: configured trust verification FAILED: ${oneLine(r.stderr)}. Legacy fallback is forbidden.`);
   }finally{rmSync(signerDir,{recursive:true,force:true});}
   const tree=gitDo(ctx,c.dir,'ls-tree','-r',c.to).split('\n');
   if(tree.some(l=>!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(l)))throw new UpdateError('Hardened Git refuses symlinks, submodules and special tree entries');
   const attrs=tree.filter(l=>l.endsWith('.gitattributes')).map(l=>l.split('\t')[1]);
   if(attrs.some(f=>/filter\s*=/.test(gitDo(ctx,c.dir,'show',`${c.to}:${f}`))))throw new UpdateError('Hardened Git refuses filter/LFS-dependent payloads');
   lines.push(`${c.id}: verified exact tag ${c.tagObject} → ${c.to} with operator trust`);c.verification='verified';continue;
  }
  lines.push(`${c.id}: LEGACY Git verification policy (deprecated); use --trust for independently configured trust`);
  // Retained legacy policy; never reached after a configured trust failure.
  const signers=path.join(c.dir,'config','release-signers');
  if(existsSync(signers)&&readFileSync(signers,'utf8').trim()){
   const r=ctx.exec('git',['-C',c.dir,'-c','gpg.format=ssh','-c',`gpg.ssh.allowedSignersFile=${signers}`,'verify-tag',c.tag]);
   if(r.status===0)lines.push(`${c.id}: the signature of ${c.tag} is good (config/release-signers)`);
   else if(request.allowUnsigned)lines.push(`${c.id}: WARNING: ${c.tag} has no good signature; accepted because of --allow-unsigned`);
   else throw new UpdateError(`${c.id}: ${c.tag} has no good signature by a key in ${signers}: ${oneLine(r.stderr)||'verify-tag failed'}\n--allow-unsigned accepts it anyway.`);
  }else lines.push(`${c.id}: ${c.tag} is legacy-unverified: not checked for a signature (no config/release-signers in the installed checkout)`);
 }
 // 4. the target, staged next to nothing live
 mkdirSync(inst.staging,{recursive:true});
 // The real path: the server compares its own file with argv[1], and a temp directory is often behind a link.
 const staging=realpathSync(mkdtempSync(path.join(inst.staging,'home-hub-update-'))),place=s=>path.join(staging,s.id),added=[];
 try{
  for(const s of live){
   const to=changes.find(c=>c.id===s.id)?.to??s.commit;
   if(s.git){gitDo(ctx,s.dir,'worktree','add','--detach','--quiet',place(s),to);added.push(s);}
   else cpSync(s.dir,place(s),{recursive:true,filter:from=>!['.git','node_modules'].includes(path.basename(from))});
  }
  const stagedCore=place(core);
  // Paths inside the checkout follow it into the stage when the target tracks them (an overlay kept in git), and
  // stay the instance's own otherwise (data, state, secrets, a site file that is not in git).
  const at=dir=>{if(!inside(dir,core.dir))return dir;const there=path.join(stagedCore,path.relative(core.dir,dir));return existsSync(there)?there:dir;};
  const siteChange=stageSite(inst,request,installed,target,staging);
  if(addedSources.change){const checked=mkdtempSync(path.join(staging,'.instance-'));writeAtomic(path.join(checked,'instance.json'),addedSources.change.text);readInstance(checked);}
  const siteFile=siteChange?.staged??(inst.paths.siteConfig?at(inst.paths.siteConfig):null);
  const checkEnv={...inst.env,HOME_HUB_CONFIG_DIR:at(inst.paths.config),HOME_HUB_SITE_CONFIG:siteFile??'none',DATA_DIR:at(inst.paths.data),STATE_DIR:at(inst.paths.state),HOME_HUB_PRIVATE_DIR:at(inst.paths.private),AUTH_FILE:at(inst.paths.authFile)};
  // A temporary site path must not move the implicit software watch list away from the live configuration.
  if(siteChange)checkEnv.SOFTWARE_WATCH_FILE=resolvePaths(inst.env,inst.root).softwareWatch;
  // Plugins that live in the checkout without being tracked there (a site's own local/plugins) are copied in.
  let copied=false;
  for(const rel of core.plugins)if(!existsSync(path.join(stagedCore,rel))){cpSync(path.join(core.dir,rel),path.join(stagedCore,rel),{recursive:true,filter:from=>path.basename(from)!=='node_modules'});copied=true;}
  if(live.length>1){mkdirSync(path.join(staging,'node_modules'));symlinkSync(stagedCore,path.join(staging,'node_modules','home-hub'),'dir');}
  const stagedDirs=live.flatMap(s=>s.plugins.map(rel=>path.join(place(s),rel)));
  checkEnv.HOME_HUB_PLUGINS_DIR=stagedDirs.length?stagedDirs.join(path.delimiter):'none';
  // 5. compatibility and the data epoch, from files
  const before=pluginsOf(inst),after=stagedDirs.flatMap(pluginFacts),staged=coreFacts(stagedCore);
  if(!staged||staged.version!==target.version)throw new UpdateError(`The staged core reads ${staged?.version??'no version'}, not ${target.version}.`);
  if(target.node&&validRange(target.node)&&!satisfies(process.versions.node,target.node))throw new UpdateError(`Home Hub ${target.version} needs Node ${target.node}; this is ${process.versions.node}.`);
  for(const p of after){
   if(!p.core){lines.push(`plugin ${p.id}: no plugin.json, so no core range to check`);continue;}
   if(!validRange(p.core)||!satisfies(target.version,p.core))throw new UpdateError(`Plugin ${p.id}${p.version?' '+p.version:''} supports Home Hub ${p.core}; the target is ${target.version}. Update the plugins too (--plugins <tag>), or stay.`);
   for(const [id,range] of Object.entries(p.requires)){
    const other=after.find(o=>o.id===id);
    if(!other)throw new UpdateError(`Plugin ${p.id} needs plugin ${id} (${range}), which would not be installed.`);
    if(!other.version||!validRange(range)||!satisfies(other.version,range))throw new UpdateError(`Plugin ${p.id} needs plugin ${id} ${range}; ${other.version??'an unversioned one'} would be installed.`);
   }
  }
  if(after.length)lines.push(`plugins: ${after.map(p=>`${p.id}${p.version?' '+p.version:''}`).join(', ')}: every core range includes ${target.version}`);
  const epochs=[...(target.dataEpoch>installed.dataEpoch?[`core ${installed.dataEpoch} → ${target.dataEpoch}`]:[]),
   ...after.flatMap(p=>{const was=before.find(b=>b.id===p.id);return was&&p.dataEpoch!==null&&p.dataEpoch>(was.dataEpoch??1)?[`plugin ${p.id} ${was.dataEpoch??1} → ${p.dataEpoch}`]:[];})];
  const lower=after.find(p=>{const was=before.find(b=>b.id===p.id);return was&&was.dataEpoch!==null&&(p.dataEpoch??1)<was.dataEpoch;});
  if(lower)throw new UpdateError(`Plugin ${lower.id} would go to a lower data epoch; it could not read its own state.`);
  const epochRose=epochs.length>0;
  if(siteChange)lines.push(`site configuration: staged for the target; the original will be saved before replacement and restored on rollback`);
  if(addedSources.change)lines.push(`instance configuration: add plugin source(s) ${addedSources.sources.map(s=>s.id).join(', ')} only after stopping; rollback restores the original manifest`);
  lines.push(epochRose?`DATA EPOCH RISES (${epochs.join('; ')}): after this update the old code cannot read the state. Going back means restoring the archive made before the switch; whatever is written after the update is then lost.`
   :`data epoch unchanged (${installed.dataEpoch}): going back keeps application data${siteChange?'; the original site configuration is restored':', and nothing written since is lost'}`);
  // 6. the target's own tests
  if(request.skipTests)lines.push('tests: SKIPPED (--skip-tests)');
  else{
   const env=testEnv(inst.env),runner=path.join(stagedCore,'scripts','run-tests.mjs');
   say(`Testing ${target.version} in ${staging}:`);
   const summary=r=>lastLines(r.stdout,8).split('\n').filter(l=>/^\S+\s+tests \d+/.test(l)).map(l=>l.replace(/\s+/g,' ')).join('; ');
   lines.push(`tests (core): ${summary(runStep(ctx,'npm test of the target',ctx.node,[runner,...(copied&&inst.paths.siteConfig&&existsSync(inst.paths.siteConfig)?['--site',inst.paths.siteConfig]:[])],{cwd:stagedCore,env}))||'passed'}`);
   const tested=live.filter(s=>s.kind==='plugins'&&s.plugins.includes('plugins')&&hasTests(s,place(s)));
   // Each source owns its fixture site. Passing multiple sources makes the runner load unrelated plugins with
   // each source's fixture, which can neither configure them nor authorize use of the live site's settings.
   // Keep these test runs separate; the --check below still validates every target source together on the real site.
   if(tested.length)for(const source of tested)lines.push(`tests (plugins): ${summary(runStep(ctx,`the ${source.id} plugin tests against the target core`,ctx.node,[runner,'--plugins',place(source)],{cwd:stagedCore,env}))||'passed'}`);
   else if(live.length>1)lines.push('tests (plugins): the plugin sources have no tests');
  }
  // 7. would it start, with this instance's site and these plugins
  if(/'--check'/.test(readFileSync(path.join(stagedCore,'server','index.mjs'),'utf8'))){
   say('Start-up check with this instance\'s configuration:');
   const r=runStep(ctx,'The start-up check (node server/index.mjs --check)',ctx.node,[path.join(stagedCore,'server','index.mjs'),'--check'],{cwd:stagedCore,env:checkEnv,timeoutMs:120000});
   const said=r.stdout.split('\n').find(l=>l.startsWith('check ok'));
   // Exit 0 without that line means the check did not run at all (the file was loaded, not executed as the server).
   if(!said)throw new UpdateError(`The start-up check of ${target.version} ended without saying "check ok". The instance was not touched.\n${lastLines(`${r.stdout}\n${r.stderr}`,20)}`);
   lines.push(oneLine(said).replaceAll(staging,'<stage>'));
  }else lines.push(`start-up check: ${target.version} has no --check; skipped`);
  const modern=existsSync(path.join(stagedCore,'server','runtime-identity.mjs'));if(modern)for(const source of live.filter(s=>s.kind==='plugins'&&changes.some(c=>c.id===s.id))){const extra=(git(ctx,source.dir,'ls-files','--others')??'').split('\n').filter(p=>p&&!p.startsWith('node_modules/'));if(extra.length)throw new UpdateError(`Modern plugin-source identity requires a reproducible tracked tree: ${source.dir} has untracked/ignored content. Move external resources outside the source before updating it.`);}if(!modern)lines.push('readiness: reduced assurance for legacy target; sustained version/process/plugin checks for 10 seconds');
  const label=(facts,commit,plugins)=>`${facts.version}${plugins.some(p=>p.version)?` (${plugins.filter(p=>p.version).map(p=>`${p.id} ${p.version}`).join(', ')})`:''} @ ${short(commit)}`;
  return {
   from:{label:label(installed,core.commit,before),core:{...installed,commit:core.commit,tag:core.tag},plugins:before.map(({id,version,dataEpoch})=>({id,version,dataEpoch})),
    expect:{version:installed.version,previousPid:run?.pid??null,...(run?.readinessProtocol===1?{readinessProtocol:1,dataEpoch:run.dataEpoch,fullCommit:run.fullCommit,packageDigest:run.packageDigest,previousBootId:run.bootId}:{}),plugins:run?(Array.isArray(run.plugins)?run.plugins:[]).map(p=>({id:p.id,version:p.version??null,...(p.fingerprint?{fingerprint:p.fingerprint}:{}),...(p.sourceFingerprint?{sourceFingerprint:p.sourceFingerprint}:{})})):null}},
   to:{label:label(target,targetCommit,after),core:{...target,commit:targetCommit,tag:coreTag??core.tag},plugins:after.map(({id,version,dataEpoch})=>({id,version,dataEpoch})),
    expect:{version:target.version,previousPid:run?.pid??null,...(modern?{readinessProtocol:1,dataEpoch:target.dataEpoch,fullCommit:targetCommit,packageDigest:null,previousBootId:run?.bootId??null}:{}),plugins:stagedDirs.flatMap(dir=>pluginFacts(dir).map(p=>({id:p.id,version:p.version,...(modern?{fingerprint:contentFingerprint(path.join(dir,p.id)),sourceFingerprint:pluginSourceFingerprint((()=>{const source=live.find(s=>s.plugins.some(rel=>path.join(place(s),rel)===dir));const rel=source?.plugins.find(rel=>path.join(place(source),rel)===dir);return source&&!changes.some(c=>c.id===source.id)?path.join(source.dir,rel):dir;})())}:{})})))}},
   changes,epochRose,lines,trustFile,sourceSnapshot:initialSnapshot,trustDigest:trustFile?sha256(readFileSync(trustFile)):null,siteChange:siteChange?Object.fromEntries(Object.entries(siteChange).filter(([k])=>k!=='staged')):null,instanceChange:addedSources.change};
 }finally{
  for(const s of added)ctx.exec('git',['-C',s.dir,'worktree','remove','--force',place(s)]);
  rmSync(staging,{recursive:true,force:true});
  for(const s of added)ctx.exec('git',['-C',s.dir,'worktree','prune']);
 }
}
function updateRepository(inst){return (inst.paths.siteConfig?readJson(inst.paths.siteConfig)?.updates?.repo:null)??readJson(path.join(inst.root,'package.json'))?.homeHub?.updates?.repo;}
function packageLayout(inst,request){
 if(!inst.home)throw new UpdateError('Managed package updates require HOME_HUB_HOME with configuration, state, private files and plugins outside core. Relocate the instance first (docs/updating.md).');
 const st=lstatSync(inst.root),parent=statSync(path.dirname(inst.root));if(!st.isDirectory()||st.isSymbolicLink()||st.dev!==parent.dev)throw new UpdateError('Package core must be a regular replaceable directory on its parent filesystem; symlinks and mount-point swaps are unsupported.');
 if(existsSync(path.join(inst.root,'.git'))){if(!lstatSync(path.join(inst.root,'.git')).isDirectory())throw new UpdateError('Linked Git worktrees cannot migrate. Use an independent checkout.');if(!request.migrateFromGit)throw new UpdateError('Git migration requires explicit --migrate-from-git; the complete old checkout is retained.');}
 for(const file of [...Object.values(inst.paths).filter(v=>typeof v==='string'),...inst.sources.slice(1).map(s=>s.dir),path.join(inst.home,'instance.json')])if(within(path.resolve(file),inst.root))throw new UpdateError(`Mutable instance path is inside replaceable core: ${file}. Relocate it before using packages.`);
 if(inst.sources[0].plugins.length)throw new UpdateError('Move in-tree household plugins to an external plugin source before package migration.');
 if(Object.keys(request.plugins??{}).length||(request.addPluginSources??[]).length)throw new UpdateError('Package activation keeps external plugin sources fixed. Update them in a separate Git transaction.');
}
async function preflightPackage(inst,request,ctx,{forApply}){
 if(request.core)throw new UpdateError('Conflicting Git and package targets');packageLayout(inst,request);const initialSnapshot=sourceSnapshot(inst,ctx),installed=coreFacts(inst.root),run=readRun(inst),source=inspectSource(ctx,inst.sources[0]);
 if(source.dirty.length)throw new UpdateError('Git checkout has tracked edits; migration refuses to replace them.');
 const trustFile=selectTrustFile({home:inst.home,explicit:request.trust}),repository=updateRepository(inst);
 let verified;try{verified=await verifyPackage(request.package,{trustFile,repository,manifestDigest:request.manifestDigest,stagingParent:path.dirname(inst.root),keepStage:true,forbidden:[inst.root,inst.paths.config,inst.paths.data,inst.paths.state,inst.paths.private,...inst.backupRoots]});}catch(e){throw new UpdateError(`Package verification refused: ${e.message}`);}
 rememberTrustSelection(inst.home,trustFile);const stage=verified.stage,target=coreFacts(stage),m=verified.manifest,siteStaging=mkdtempSync(path.join(path.dirname(inst.root),'.hub-check-'));
 try{
  if(compare(target.version,installed.version)<0||target.dataEpoch<installed.dataEpoch)throw new UpdateError('Package downgrade refused; use the recorded rollback transaction.');
  const quarantine=readQuarantine(inst.files.updates);if(!request.force&&(quarantine[target.version]||quarantine[verified.manifestSha256]))throw new UpdateError('This exact package or version was rolled back; --force permits a verified retry.');
  if(forApply){needService(inst);const why=runMismatch(run,{version:installed.version},{pidAlive:ctx.pidAlive});if(why||!await probeOk(ctx,inst.health.url))throw new UpdateError(`The installed hub must be running before apply: ${why||'health endpoint does not answer'}`);
   // A process from another commit of the same version is not a viable rollback target.
   if(source.git&&typeof run.commit==='string'&&run.commit&&!source.commit.startsWith(run.commit))throw new UpdateError('The running hub commit differs from the installed checkout; restart it before applying a package.');
   const receipt=packageReceipt(inst.root);if(receipt&&(run.readinessProtocol!==1||run.fullCommit!==receipt.fullCommit||run.packageDigest!==receipt.manifestSha256))throw new UpdateError('The running hub identity differs from the installed package; restart it before applying a package.');
  }
  const before=pluginsOf(inst),plugins=inst.sources.flatMap(s=>s.plugins.flatMap(rel=>pluginFacts(path.join(s.dir,rel)).map(p=>({...p,fingerprint:contentFingerprint(path.join(s.dir,rel,p.id)),sourceFingerprint:pluginSourceFingerprint(path.join(s.dir,rel))}))));
  for(const p of plugins){if(!p.version||!p.core||!validRange(p.core)||!satisfies(target.version,p.core))throw new UpdateError(`Package target is incompatible with plugin ${p.id}; a version and valid core range are required.`);for(const [id,range] of Object.entries(p.requires)){const other=plugins.find(p=>p.id===id);if(!other?.version||!validRange(range)||!satisfies(other.version,range))throw new UpdateError(`Plugin ${p.id} dependency ${id} is incompatible`);}}
  const siteChange=stageSite(inst,request,installed,target,siteStaging),env=testEnv(inst.env),runner=path.join(stage,'scripts','run-tests.mjs');
  // Package startup checks are mandatory. --skip-tests keeps its documented meaning, never bypassing trust/check.
  if(!request.skipTests)runStep(ctx,'package target tests',ctx.node,[runner],{cwd:stage,env});
  const index=path.join(stage,'server','index.mjs');if(!existsSync(index)||!/'--check'/.test(readFileSync(index,'utf8')))throw new UpdateError('New packages require a startup --check capability');
  mkdirSync(path.join(siteStaging,'node_modules'));symlinkSync(stage,path.join(siteStaging,'node_modules','home-hub'),'dir');
  const pluginDirs=[];for(const source of inst.sources.slice(1)){const dir=path.join(siteStaging,source.id);cpSync(source.dir,dir,{recursive:true,filter:f=>!['.git','node_modules'].includes(path.basename(f))});for(const rel of source.plugins)pluginDirs.push(path.join(dir,rel));}
  const checkEnv={...inst.env,HOME_HUB_SITE_CONFIG:siteChange?.staged??inst.paths.siteConfig??'none',HOME_HUB_CONFIG_DIR:inst.paths.config,DATA_DIR:inst.paths.data,STATE_DIR:inst.paths.state,HOME_HUB_PRIVATE_DIR:inst.paths.private,AUTH_FILE:inst.paths.authFile,HOME_HUB_PLUGINS_DIR:pluginDirs.join(path.delimiter)||'none'};
  if(siteChange)checkEnv.SOFTWARE_WATCH_FILE=inst.paths.softwareWatch;
  const check=runStep(ctx,'package startup check',ctx.node,[index,'--check'],{cwd:stage,env:checkEnv,timeoutMs:120000});if(!check.stdout.split('\n').some(l=>l.startsWith('check ok')))throw new UpdateError('Package startup check did not publish check ok');
  verifyStagedTree(stage,m);writePackageReceipt(stage,verified);const expectedPlugins=plugins.map(({id,version,fingerprint,sourceFingerprint})=>({id,version,fingerprint,sourceFingerprint}));
  return {from:{label:installed.version,core:{...installed,commit:source.commit},plugins:before,expect:{version:installed.version,previousPid:run?.pid??null,...(run?.readinessProtocol===1?{readinessProtocol:1,fullCommit:run.fullCommit,packageDigest:run.packageDigest,dataEpoch:run.dataEpoch,previousBootId:run.bootId}:{}),plugins:run?.plugins??null}},
   to:{label:target.version,core:{...target,commit:m.fullCommit,tag:m.tag},plugins:before,expect:{version:m.version,previousPid:run?.pid??null,dataEpoch:m.dataEpoch,fullCommit:m.fullCommit,packageDigest:verified.manifestSha256,readinessProtocol:1,previousBootId:run?.bootId??null,plugins:expectedPlugins}},
   changes:[],sourceSnapshot:initialSnapshot,epochRose:target.dataEpoch>installed.dataEpoch,package:{live:inst.root,old:inst.root+'.previous-'+path.basename(stage),staged:stage,status:'prepared',manifestSha256:verified.manifestSha256,artifact:verified.manifest.artifact,files:m.files,trustFile,packageFile:path.resolve(request.package)},siteChange:siteChange?Object.fromEntries(Object.entries(siteChange).filter(([k])=>k!=='staged')):null,instanceChange:null,lines:[`package signature: verified (${verified.keyId}); manifest ${verified.manifestSha256}`,`exact release: ${m.tag} @ ${m.fullCommit}`,`readiness: exact boot/process/plugin identity for 10 consecutive seconds after startup`,...(target.dataEpoch>installed.dataEpoch?['DATA EPOCH RISES: rollback restores the pre-update backup']:[])]};
 }catch(e){rmSync(stage,{recursive:true,force:true});throw e;}finally{rmSync(siteStaging,{recursive:true,force:true});}
}
function sourceSnapshot(inst,ctx){
 const files=[inst.paths.config,inst.paths.siteConfig,inst.paths.softwareWatch,inst.paths.authFile,inst.env.HOME_HUB_SECRET_KEY_FILE,inst.env.INTEGRATION_SECRETS_FILE,inst.env.GITHUB_TOKEN_FILE,inst.env.TLS_KEY,inst.env.TLS_CERT,...(inst.home?[path.join(inst.home,'instance.json')]:[])].filter(Boolean);
 return {sources:inst.sources.map(s=>{const git=inspectSource(ctx,s);return {dir:s.dir,canonical:realpathSync(s.dir),device:statSync(s.dir).dev,inode:statSync(s.dir).ino,commit:git.commit,dirty:git.dirty,plugins:s.plugins.map(p=>contentFingerprint(path.join(s.dir,p))),...(s.kind==='plugins'?{sourceFingerprints:s.plugins.map(rel=>pluginSourceFingerprint(path.join(s.dir,rel)))}:{}),...(!git.git?{content:contentFingerprint(s.dir)}:{})};}),configuration:files.map(file=>[file,existsSync(file)?realpathSync(file):null,existsSync(file)?contentFingerprint(realpathSync(file)):null])};
}
function retainDriver(inst,journal){
 const driver=path.join(inst.home,'update','drivers',journal.id);mkdirSync(driver,{recursive:true,mode:0o700});for(const name of ['server','scripts','public','package.json'])cpSync(path.join(repoRoot,name),path.join(driver,name),{recursive:true,dereference:false});journal.driver=driver;writeJournal(inst,journal);
}
function activatePackage(inst,journal,ctx){const p=journal.package;
 p.status='moving-old';writeJournal(inst,journal);renameSync(p.live,p.old);ctx.checkpoint('package-old-renamed');syncDirectory(path.dirname(p.live));p.status='old-moved';writeJournal(inst,journal);
 p.status='installing';writeJournal(inst,journal);renameSync(p.staged,p.live);ctx.checkpoint('package-new-renamed');syncDirectory(path.dirname(p.live));p.status='installed';writeJournal(inst,journal);
}
function restorePackage(inst,journal,ctx){const p=journal.package;
 // Reconcile intent even when a process died between rename and its completion record.
 if(p.status==='prepared'&&existsSync(p.live)&&!existsSync(p.old))return;
 if(p.status==='moving-old'&&existsSync(p.live)&&!existsSync(p.old))return;
 if(p.status==='restored')return;
 if(!existsSync(p.old)){if(p.status==='restoring'&&existsSync(p.live)){p.status='restored';writeJournal(inst,journal);return;}throw new Error('Retained previous core is missing; manual recovery required');}
 if(existsSync(p.live)){
  verifyStagedTree(p.live,{files:p.files},{receipt:true});const receipt=packageReceipt(p.live);if(receipt?.manifestSha256!==p.manifestSha256)throw new Error('Core no longer matches the installed package; refusing to overwrite unrelated code');
  p.failed??=p.live+'.failed-'+path.basename(p.staged);p.status='moving-failed';writeJournal(inst,journal);renameSync(p.live,p.failed);syncDirectory(path.dirname(p.live));
 }
 p.status='restoring';writeJournal(inst,journal);renameSync(p.old,p.live);syncDirectory(path.dirname(p.live));p.status='restored';writeJournal(inst,journal);
}
function readJsonText(text){try{return JSON.parse(text);}catch{return null;}}

// --- apply ---------------------------------------------------------------------------------------------
const switchTo=(ctx,change,commit,{force=false,branch=null}={})=>{
 // Back onto the branch it was on when that branch still names the same commit; otherwise detached at the commit.
 if(branch&&git(ctx,change.dir,'rev-parse','-q','--verify',`refs/heads/${branch}^{commit}`)===commit)return gitDo(ctx,change.dir,'checkout','--quiet',...(force?['--force']:[]),branch);
 return gitDo(ctx,change.dir,'checkout','--quiet','--detach',...(force?['--force']:[]),commit);
};
const pathsLine=(inst,journal)=>`  journal  ${inst.files.journal}\n  archive  ${journal.backup?.file??'(none was made)'}\n  history  ${inst.files.history}\n  driver   ${journal.driver??'retain this trusted driver checkout'}\n  failed   ${journal.package?.failed??journal.failedState??'(none)'}${(journal.restoreRoots??[]).map(r=>'\n  root     '+r.live+'; retained failed root '+r.aside).join('')}`;

/**
 * Puts the `from` side of a journal back: stop, switch the code back, restore the archive when the data epoch rose
 * and the new version ran, note the quarantine, start, health check. Ends as rolled-back (or aborted, when nothing had
 * been switched yet). When that fails the service is left stopped and RollbackFailed names the files that matter.
 */
async function undo(inst,ctx,journal){
 const switched=!['stopping','backup','backup-verified'].includes(journal.undoFrom??journal.step);
 if(journal.step!=='rolling-back'&&journal.step!=='rollback-failed')journal.undoFrom=journal.step;
 journal.step='rolling-back';writeJournal(inst,journal);
 try{
  const head=change=>git(ctx,change.dir,'rev-parse','HEAD');
  const moved=journal.changes.some(c=>head(c)!==c.from)||Boolean(journal.package&&existsSync(journal.package.old));
  // Nothing was switched and the old hub still answers as before (a stop that was refused, or one that said yes
  // and stopped nothing): there is nothing to put back, and stopping it again would only fail the same way.
  const untouched=!switched&&!moved&&(await probeOk(ctx,inst.health.url))&&!runMismatch(readRun(inst),journal.from.expect,{pidAlive:ctx.pidAlive});
  if(untouched)ctx.log('  the hub still runs as it did; nothing was changed. Check the service\'s stop command before trying again.');
  if(!untouched){
   await stopService(inst,ctx,readRun(inst)?.pid??null);
   if(journal.package)restorePackage(inst,journal,ctx);
   for(const c of journal.changes)if(head(c)!==c.from||c.branch){ctx.log(`  ${c.id}: back to ${short(c.from)}${c.branch?` (${c.branch})`:''}`);if(inspectSource(ctx,c).dirty.length)throw new Error(`Unrelated tracked edits in ${c.dir}; refusing forced rollback`);const current=head(c);if(current!==c.from&&current!==c.to)throw new Error(`Unexpected source identity in ${c.dir}; manual recovery required`);recordMutation(inst,journal,'source-restore',{source:c.id,from:current,to:c.from},()=>switchTo(ctx,c,c.from,{branch:c.branch}));}
   if(journal.epochRose&&journal.started&&!journal.restored){
    if(!journal.backup)throw new Error('the data epoch rose and the new version was started, but the journal names no archive');
    ctx.log(`  restoring ${journal.backup.file} (the data epoch rose, and the new version has written its state)`);
    journal.failedState=await restoreArchive(inst,ctx,journal.backup,journal);journal.restored=true;writeJournal(inst,journal);
   }
   // The site may have changed before the new code ever started; restore it independently of the data epoch.
   for(const key of ['site','instance'])restoreSite(inst,journal,key);
   if(journal.quarantine&&journal.to.core.version!==journal.from.core.version){
    if(!setQuarantine(inst.files.updates,journal.to.core.version,{at:iso(ctx.now()),reason:journal.quarantine.reason}))ctx.log(`  (${inst.files.updates} belongs to newer code; the quarantine note was not written)`);
   }
   if(!journal.package&&journal.quarantine&&journal.changes.some(c=>c.id==='core'))setQuarantine(inst.files.updates,'git-'+journal.to.core.commit,{at:iso(ctx.now()),reason:journal.quarantine.reason});
   if(journal.package&&journal.quarantine)setQuarantine(inst.files.updates,journal.package.manifestSha256,{at:iso(ctx.now()),reason:journal.quarantine.reason});
   const since=ctx.now();
   await startService(inst,ctx);
   await waitHealthy(inst,ctx,journal.from.expect,since,{interruptible:false});
  }
  journal.step=switched||moved?'rolled-back':'aborted';journal.finishedAt=iso(ctx.now());writeJournal(inst,journal);
  history(inst,ctx,journal,journal.step);
  return journal;
 }catch(e){
  journal.step='rollback-failed';journal.rollbackError=oneLine(e.message);writeJournal(inst,journal);
  history(inst,ctx,journal,'rollback-failed');
  try{ctx.exec(inst.service.stop[0],inst.service.stop.slice(1),{timeoutMs:60000});}catch{}
  throw new RollbackFailed(`The previous version could not be brought back: ${e.message}\nThe service was told to stop and is left stopped. Look at these, fix the cause, then run "rollback" again:\n${pathsLine(inst,journal)}`);
 }
}

async function reconcileJournal(inst,ctx,journal){const done=await undo(inst,ctx,journal);if(journal.kind==='backup'&&journal.previous)writeJournal(inst,journal.previous);return done;}

/** An update that did not finish (a crash, a lost session) is put back. → the journal, or null when there was nothing to do. */
export async function recover(inst,ctx){
 const release=takeLock(inst,ctx);let sourceRelease=()=>{};
 try{
 const journal=readJournal(inst);if(!unfinished(journal))return null;needService(inst);sourceRelease=acquireSourceLocks([...inst.sources,...journal.changes],{now:ctx.now});
  ctx.log(`An update begun ${journal.startedAt} (${journal.from.label} → ${journal.to.label}) stopped at "${journal.step}". Putting ${journal.from.label} back:`);
  journal.failure??={step:journal.step,message:'the update was interrupted'};
  return await reconcileJournal(inst,ctx,journal);
 }finally{sourceRelease();release();}
}

/** preflight, then the update itself. → {journal, plan}. Throws UpdateError (nothing changed, or everything was put back) or RollbackFailed. */
export async function apply(inst,request,ctx){
 needService(inst);
 if(request.trust)inst={...inst,trustFile:path.resolve(request.trust)};
 const release=takeLock(inst,ctx);let sourceRelease=()=>{};
 try{
  if(unfinished(readJournal(inst))){const old=readJournal(inst);sourceRelease=acquireSourceLocks([...inst.sources,...old.changes],{now:ctx.now});await reconcileJournal(inst,ctx,old);throw new UpdateError('The unfinished transaction was recovered. Run apply again for a new update.');}
  sourceRelease=acquireSourceLocks([...inst.sources,...addedPluginSources(inst,request).sources],{now:ctx.now});
  ctx.log('Preflight:');
  const plan=await preflight(inst,request,ctx,{forApply:true,sourceLocksHeld:true});
  for(const line of plan.lines)ctx.log(`  ${line}`);
  backupPlan(inst);
  for(const change of [plan.siteChange,plan.instanceChange])if(change)checkSiteUnchanged(change);
  if(JSON.stringify(sourceSnapshot(inst,ctx))!==JSON.stringify(plan.sourceSnapshot))throw new UpdateError('Installed source/plugin/configuration fingerprint changed since preflight; refusing before stop');
  for(const c of plan.changes){if(git(ctx,c.dir,'rev-parse','HEAD')!==c.from||tagCommit(ctx,c.dir,c.tag)!==c.to||git(ctx,c.dir,'rev-parse',`refs/tags/${c.tag}`)!==c.tagObject||inspectSource(ctx,c).dirty.length)throw new UpdateError('Source or target changed since preflight; refusing before stop');}
  if(plan.trustFile){loadTrust(plan.trustFile,{forbidden:[inst.root,inst.paths.config,inst.paths.data,inst.paths.state,inst.paths.private,...inst.backupRoots]});if(sha256(readFileSync(plan.trustFile))!==plan.trustDigest)throw new UpdateError('Trust policy changed since preflight; refusing before stop');}
  if(plan.package){verifyStagedTree(plan.package.staged,{files:plan.package.files},{receipt:true});const meta=authenticatePackageMetadata(plan.package.packageFile,{trustFile:plan.package.trustFile,repository:updateRepository(inst),manifestDigest:plan.package.manifestSha256,forbidden:[inst.root,inst.paths.config,inst.paths.data,inst.paths.state,inst.paths.private,...inst.backupRoots]});if(meta.manifestSha256!==plan.package.manifestSha256)throw new UpdateError('Package target changed since preflight');}
  for(const change of [plan.siteChange,plan.instanceChange])if(change)checkSiteUnchanged(change);
  ctx.checkpoint();
  const started=ctx.now(),run=readRun(inst);
  const journal={schemaVersion:JOURNAL_SCHEMA,id:`${stampOf(started)}-${process.pid}`,startedAt:iso(started),by:ctx.user??null,from:plan.from,to:plan.to,changes:plan.changes,epochRose:plan.epochRose,
   ...(plan.package?{package:plan.package}:{}),settings:{service:inst.service.spec,health:inst.health,root:inst.root,home:inst.home,state:inst.paths.state},step:'stopping',started:false,backup:null};
  writeJournal(inst,journal);
  if(plan.package)retainDriver(inst,journal);
  const fail=async(e,quarantine)=>{
   journal.failure={step:journal.step,message:oneLine(e.message)};
   if(e.stopRefused)journal.stopRefused=true;
   // A lost session or Ctrl-C says nothing about the release: it is put back, and not noted as a release that failed.
   if(quarantine&&!e.interrupted)journal.quarantine={reason:oneLine(e.message,120)};
   ctx.log(`\nFAILED at "${journal.step}": ${e.message}\nPutting ${plan.from.label} back:`);
   await undo(inst,ctx,journal);
   throw new UpdateError(`The update to ${plan.to.label} failed at "${journal.failure.step}": ${e.message}\n${journal.step==='aborted'?'Nothing had been switched':'It was rolled back'}; ${plan.from.label} is running again.${journal.quarantine&&plan.to.core.version!==plan.from.core.version?` ${plan.to.core.version} is noted as tried and rolled back (the update card says so; --force tries it again).`:''}\n${pathsLine(inst,journal)}`);
  };
  try{
   ctx.log(`\nStopping the hub (${plan.from.label}):`);
   await stopService(inst,ctx,run?.pid??null);
   ctx.checkpoint();
   journal.step='backup';writeJournal(inst,journal);
   ctx.log('Archiving, with the hub stopped:');
   journal.backup=await makeArchive(inst,ctx,`pre-${plan.from.core.version}-to-${plan.to.core.version}-${stampOf(started)}`);
   for(const key of ['site','instance'])if(plan[`${key}Change`]){
    const site=plan[`${key}Change`],original=checkSiteUnchanged(site),backup=journal.backup.file+`.${key}.json`;
    if(original!==null)writeAtomic(backup,original);
    journal[key]={file:site.file,backup:original===null?null:backup,baseHash:site.baseHash,mode:site.mode,status:'prepared'};
    writeJournal(inst,journal);
   }
   journal.step='backup-verified';writeJournal(inst,journal);
   ctx.log(`  ${journal.backup.file} (${journal.backup.entries.map(e=>e.name).join(', ')}; ${journal.backup.files} entries, ${Math.ceil(journal.backup.bytes/1024)} KiB)`);
   ctx.checkpoint();
  }catch(e){await fail(e,false);}
  try{
   if(JSON.stringify(sourceSnapshot(inst,ctx))!==JSON.stringify(plan.sourceSnapshot))throw new Error('Source/configuration topology changed after backup; refusing switch');
   journal.step='switching';writeJournal(inst,journal);
   ctx.log('Switching:');
   if(journal.package)activatePackage(inst,journal,ctx);
   for(const c of plan.changes){ctx.log(`  ${c.id}: ${short(c.from)} → ${c.tag} (${short(c.to)}), detached`);recordMutation(inst,journal,'source-switch',{source:c.id,from:c.from,to:c.to},()=>switchTo(ctx,c,c.to));}
   for(const key of ['site','instance'])if(plan[`${key}Change`]){
    checkSiteUnchanged(plan[`${key}Change`]);
    journal[key].status='applying';writeJournal(inst,journal);
    replaceSite(journal[key].file,plan[`${key}Change`].text,journal[key].mode);
    journal[key].status='applied';writeJournal(inst,journal);
   }
   journal.step='switched';writeJournal(inst,journal);
   setQuarantine(inst.files.updates,plan.to.core.version,null);setQuarantine(inst.files.updates,journal.package?.manifestSha256??'git-'+plan.to.core.commit,null);
   ctx.checkpoint();
   journal.step='starting';journal.targetMayHaveWritten=true;journal.started=true;writeJournal(inst,journal);ctx.checkpoint('target-start-intent');
   ctx.log(`Starting ${plan.to.label}:`);
   const since=ctx.now();
   await startService(inst,ctx);
   await waitHealthy(inst,ctx,plan.to.expect,since);
  }catch(e){await fail(e,true);}
  journal.step='done';journal.finishedAt=iso(ctx.now());writeJournal(inst,journal);
  history(inst,ctx,journal,'done');
  pruneArchives(inst,ctx,journal.backup.file);
  return {journal,plan};
 }finally{sourceRelease();release();}
}

/** The last update, undone by hand. yes: required when the data epoch rose (the archive is restored and later writes are lost). */
export async function rollback(inst,ctx,{yes=false,reason=null}={}){
 const release=takeLock(inst,ctx);let sourceRelease=()=>{};
 try{
 const journal=readJournal(inst);
 if(journal&&(!inst.service||!inst.health))inst={...inst,service:inst.service??parseService(journal.settings.service),health:inst.health??parseHealth(journal.settings.health)};
 needService(inst);
 if(!journal)throw new UpdateError(`There is no update to go back from (${inst.files.journal} does not exist).`);
 if(unfinished(journal)){sourceRelease=acquireSourceLocks([...inst.sources,...journal.changes],{now:ctx.now});return {journal:await reconcileJournal(inst,ctx,journal),recovered:true};}
 if(journal.step!=='done')throw new UpdateError(`The last update (${journal.from.label} → ${journal.to.label}) already ended as "${journal.step}"; there is nothing to go back from.`);
 sourceRelease=acquireSourceLocks([...inst.sources,...journal.changes],{now:ctx.now});
  if(journal.package&&packageReceipt(inst.root)?.manifestSha256!==journal.package.manifestSha256)throw new UpdateError('Installed core differs from the last package; rollback refuses unrelated edits.');
  const moved=journal.changes.filter(c=>git(ctx,c.dir,'rev-parse','HEAD')!==c.to);
  if(moved.length)throw new UpdateError(`${moved.map(c=>c.dir).join(', ')} is no longer on what the last update installed (${journal.to.label}); "rollback" only undoes that update.`);
  if(journal.epochRose){
   if(!journal.backup||!existsSync(journal.backup.file))throw new UpdateError(`The data epoch rose in that update, so going back needs its archive, and ${journal.backup?.file??'it'} is gone. The old code cannot read the current state.`);
   if(!yes)throw new UpdateError(`The data epoch rose in the update of ${journal.finishedAt}. Going back restores ${journal.backup.file}: everything written since then is lost (tickets, feedback, inventory edits, history). The current state is moved to ${path.join(inst.backups,'failed-<time>')}, not deleted. Say --yes to do it.`);
  }
  ctx.log(`Going back from ${journal.to.label} to ${journal.from.label}:`);
  journal.started=true;journal.failure={step:'done',message:oneLine(reason)||'rolled back by hand'};journal.quarantine={reason:oneLine(reason,120)||'rolled back by hand'};
  return {journal:await undo(inst,ctx,journal),recovered:false};
 }finally{sourceRelease();release();}
}

/** Only the archive: stop, archive, start, health check. */
export async function backup(inst,ctx){
 needService(inst);
 const release=takeLock(inst,ctx);let sourceRelease=()=>{};
 try{
  sourceRelease=acquireSourceLocks(inst.sources,{now:ctx.now});
  if(unfinished(readJournal(inst)))throw new UpdateError(`An earlier update did not finish (${inst.files.journal}). Run "rollback" first.`);
  const run=readRun(inst),version=coreFacts(inst.root)?.version??'unknown';
  if(!(await probeOk(ctx,inst.health.url)))throw new UpdateError(`${inst.health.url} does not answer; this command stops and starts a hub that is running.`);
  const recorded=readJournal(inst),previous=recorded?.kind==='backup'?recorded.previous??null:recorded,facts=coreFacts(inst.root),side={label:version,core:facts,expect:{version:run?.version??version,previousPid:run?.pid??null,...(run?.readinessProtocol===1?{readinessProtocol:1,fullCommit:run.fullCommit,packageDigest:run.packageDigest,dataEpoch:run.dataEpoch,previousBootId:run.bootId}:{}),plugins:run?.plugins??null}};
  const journal={schemaVersion:JOURNAL_SCHEMA,id:`backup-${stampOf(ctx.now())}-${process.pid}`,kind:'backup',previous,startedAt:iso(ctx.now()),from:side,to:side,changes:[],epochRose:false,started:false,backup:null,settings:{service:inst.service.spec,health:inst.health,root:inst.root,home:inst.home,state:inst.paths.state},step:'stopping'};
  backupPlan(inst);writeJournal(inst,journal);
  ctx.log('Stopping the hub:');
  await stopService(inst,ctx,run?.pid??null);ctx.checkpoint('manual-backup-stopped');
  journal.step='backup';writeJournal(inst,journal);
  let made=null,error=null;
  try{made=await makeArchive(inst,ctx,`manual-${version}-${stampOf(ctx.now())}`);}catch(e){error=e;}
  journal.backup=made;journal.step='starting';writeJournal(inst,journal);
  ctx.log('Starting it again:');
  const since=ctx.now();
  try{await startService(inst,ctx);await waitHealthy(inst,ctx,journal.from.expect,run?since:0);}catch(e){journal.step='rollback-failed';journal.rollbackError=oneLine(e.message);writeJournal(inst,journal);ctx.exec(inst.service.stop[0],inst.service.stop.slice(1));throw new RollbackFailed(`Manual backup could not restart the previous service: ${e.message}\n${pathsLine(inst,journal)}`);}
  journal.step='done';journal.finishedAt=iso(ctx.now());writeJournal(inst,journal);
  if(previous)writeJournal(inst,previous);
  if(error)throw new UpdateError(`The archive failed: ${error.message}. The hub is running again.`);
  return made;
 }finally{sourceRelease();release();}
}

// --- status --------------------------------------------------------------------------------------------
export function status(inst,ctx){
 const sources=inst.sources.map(s=>{const g=inspectSource(ctx,s);return {id:s.id,kind:s.kind,dir:s.dir,git:g.git,commit:g.commit,branch:g.branch,tag:g.tag,dirty:g.dirty.length,version:parse(readJson(path.join(s.dir,'package.json'))?.version)?.text??null};});
 const installed=coreFacts(inst.root),run=readRun(inst),known=readJson(inst.files.updates),journal=readJournal(inst),core=sources[0];
 const newest=core.git?newestTag(ctx,inst.root):null;
 return {root:inst.root,home:inst.home,paths:inst.paths,backups:inst.backups,journalFile:inst.files.journal,installed:{...installed,commit:core.commit,branch:core.branch,tag:core.tag,exact:core.tag===`v${installed?.version}`},
  sources,plugins:pluginsOf(inst).map(({id,version,core:range,dataEpoch})=>({id,version,core:range,dataEpoch})),
  running:run?{version:run.version,pid:run.pid,alive:ctx.pidAlive(run.pid),startedAt:run.startedAt,plugins:run.plugins}:null,
  newestTag:newest,newerTag:newest&&installed&&compare(newest.slice(1),installed.version)>0?newest:null,
  known:plain(known?.sources?.core)?{version:known.sources.core.version??null,checkedAt:known.sources.core.checkedAt??null,failedAt:known.sources.core.failedAt??null}:null,
  quarantined:plain(known?.quarantined)?known.quarantined:{},
  service:inst.service?{kind:inst.service.kind,stop:inst.service.stop,start:inst.service.start}:null,health:inst.health,
  journal:journal?{id:journal.id,step:journal.step,unfinished:unfinished(journal),startedAt:journal.startedAt,finishedAt:journal.finishedAt??null,from:journal.from.label,to:journal.to.label,epochRose:journal.epochRose,
   archive:journal.backup?.file??null,failure:journal.failure??null}:null};
}
export function formatStatus(s){
 const out=[`Home Hub ${s.installed.version??'?'}${s.installed.exact?'':'+dev'} @ ${short(s.installed.commit)}${s.installed.branch?` (branch ${s.installed.branch})`:s.installed.tag?` (${s.installed.tag}, detached)`:' (detached)'}, data epoch ${s.installed.dataEpoch??'?'}`,
  `  checkout  ${s.root}${s.sources[0].dirty?`  (${s.sources[0].dirty} tracked file(s) changed)`:''}`,
  ...(s.home?[`  instance  ${s.home}`]:[]),`  data      ${s.paths.data}`,`  state     ${s.paths.state}`,`  private   ${s.paths.private}`,`  backups   ${s.backups}`];
 for(const src of s.sources.slice(1))out.push(`  plugins   ${src.dir}${src.version?`  ${src.id} ${src.version}`:''} @ ${src.git?short(src.commit)+(src.tag?` (${src.tag})`:''):'not a git checkout'}`);
 if(s.plugins.length)out.push(`  plugins   ${s.plugins.map(p=>`${p.id}${p.version?' '+p.version:''}`).join(', ')}`);
 out.push(s.running?`Running:  ${s.running.version}, pid ${s.running.pid} ${s.running.alive?'(alive)':'(NOT running)'}, since ${s.running.startedAt}`:`Running:  unknown (no run.json in ${s.paths.state}; is this the service's state directory?)`);
 out.push(`Service:  ${s.service?`${s.service.stop.join(' ')}  |  ${s.service.start.join(' ')}`:'not configured (--service, or instance.json → service)'}`);
 out.push(`Health:   ${s.health?`${s.health.url} (${s.health.seconds} s)`:'not configured (--health, or instance.json → health)'}`);
 out.push(`Newest tag here: ${s.newestTag??'none'}${s.newerTag?`  → newer than what is installed: apply ${s.newerTag}`:''} (tags as last fetched; preflight fetches)`);
 if(s.known)out.push(`Update check: newest known release ${s.known.version??'none'}${s.known.checkedAt?`, checked ${s.known.checkedAt}`:''}${s.known.failedAt?`, last failure ${s.known.failedAt}`:''}`);
 for(const [version,q] of Object.entries(s.quarantined))out.push(`Quarantined: ${version}, tried and rolled back ${q.at}${q.reason?` (${q.reason})`:''}`);
 if(s.journal){
  const j=s.journal;
  out.push(`Last update: ${j.from} → ${j.to}, begun ${j.startedAt}: ${j.step}${j.finishedAt?` at ${j.finishedAt}`:''}${j.failure?` (${j.failure.message})`:''}`);
  if(j.archive)out.push(`  archive   ${j.archive}${j.epochRose?'  (the data epoch rose: going back needs it)':''}`);
  if(j.unfinished)out.push('  UNFINISHED: run "rollback" to put the previous version back before anything else.');
 }else out.push('Last update: none recorded');
 return out;
}
