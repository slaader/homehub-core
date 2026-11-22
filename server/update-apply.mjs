import {V1} from './state-forward.mjs';
// Applying an update: the steps behind scripts/update.mjs (docs/updating.md). The hub never runs this: it is a
// command a person or an agent starts on the server, outside the hub's process, and it works on a checkout and
// an instance that are named to it. Everything that touches the world comes in through `ctx` (exec, probe,
// pidAlive, sleep, now, log, checkpoint), so tests/update-apply.test.mjs drives it with real git repositories,
// signed packages, and a service that is a stand-in.
//
//   resolveInstance()  which checkout, which plugin sources, where data, state and secrets are, how the service is
//                      stopped, started and checked: HOME_HUB_HOME/instance.json, else flags
//   preflight()        unified 7-step check over either Release Source adapter (Git Tag or Signed Package)
//   apply()            preflight, journal, stop, archive, switch, start, health check; any failure after stop rolls back
//   rollback()         the last update, undone by hand
//   recover()          an update that was cut short (a crash, a lost session) is put back on the next run
//   backup()           only the archive
//
// Only static imports: the command may be running from the very checkout it switches, so nothing is loaded later.
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,unlinkSync,readdirSync,statSync,appendFileSync,symlinkSync,mkdtempSync,realpathSync,lstatSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {convertSite} from '../scripts/convert-site.mjs';
import {repoRoot} from './edition.mjs';
import {resolvePaths} from './paths.mjs';
import {parseService,parseHealth,parseBackups,UpdateConfigError,DEFAULT_HEALTH_SECONDS,readInstance} from './update-config.mjs';
import {loadTrust,selectTrustFile,rememberTrustSelection,forbiddenTrustRoots} from './release-trust.mjs';
import {UPDATES_SCHEMA,updateSettings,UPDATE_INTEGRATION} from './update-check.mjs';
import {parse,compare,satisfies,validRange} from './semver.mjs';
import {gitReleaseSource,inspectSource,newestTag} from './release-git.mjs';
import {packageReleaseSource,verifyPackage} from './release-package.mjs';
import {downloadPackage,discoverReleases} from './release-catalog.mjs';
import {loadGithubToken,createFetchJson} from './systems-upstream.mjs';
import {packageReceipt} from './build-info.mjs';
import {sha256,withinPath,durableWrite} from './safe-fs.mjs';
import {identityMismatch,observeReadiness,healthSample} from './update-readiness.mjs';
import {contentFingerprint,pluginSourceFingerprint} from './runtime-identity.mjs';
import {backupPlan,createBackup,restoreBackup,assessRestore,backupRootSummary,refuseSocketReplacement,scanBackup} from './update-backup.mjs';
import {UpdateError,RollbackFailed} from './update-errors.mjs';
import {retainDriver,checkRetainedDriver} from './update-driver.mjs';
import {acquireLock,acquireSourceLocks} from './update-lock.mjs';
import {JOURNAL_SCHEMA,readUpdateJournal,writeUpdateJournal,unfinished} from './update-journal.mjs';

export {UpdateError,RollbackFailed};

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const stampOf=ms=>new Date(ms).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
const iso=ms=>new Date(ms).toISOString();
const short=commit=>commit?commit.slice(0,7):'?';
const oneLine=(text,max=300)=>String(text??'').replace(/\s+/g,' ').trim().slice(0,max);
const lastLines=(text,n)=>String(text??'').trimEnd().split('\n').slice(-n).join('\n');
const siteBytes=file=>{try{return readFileSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const hashOf=bytes=>bytes===null?null:sha256(bytes);

const releaseSourceForRequest=request=>request.package?packageReleaseSource:gitReleaseSource;
const releaseSourceForJournal=journal=>journal.package?packageReleaseSource:gitReleaseSource;

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
 const staged=path.join(staging,'site-config.json');durableWrite(staged,text);
 return {file,baseHash:hashOf(original),mode:original===null?0o600:statSync(file).mode&0o777,text,staged};
}
function checkSiteUnchanged(site){
 const bytes=siteBytes(site.file);
 if(bytes!==null&&statSync(site.file).nlink>1)throw new UpdateError(`Cannot replace hard-linked ${site.label??'site'} configuration.`);
 if(hashOf(bytes)!==site.baseHash)throw new UpdateError(`The ${site.label??'site'} configuration changed since preflight. Run the update again; no configuration was replaced.`);
 return bytes;
}
function verifyConfigurationPath(file){
 refuseSocketReplacement(file);
 try{
  if(!lstatSync(file).isFile())throw new Error(`Configuration path is no longer a regular file: ${file}`);
 }catch(e){if(e.code!=='ENOENT')throw e;}
}
const replaceSite=(file,bytes,mode)=>durableWrite(file,bytes,mode,()=>verifyConfigurationPath(file));
const currentSiteMatches=site=>hashOf(siteBytes(site.file))===site.baseHash&&(statSync(site.file).mode&0o777)===site.mode;
function verifyConfigurationRecovery(journal,assessed){
 for(const key of ['site','instance']){
  const site=journal[key];
  if(!site||!['applying','applied'].includes(site.status))continue;
  verifyConfigurationPath(site.file);
  if(site.baseHash===null)continue;
  if(assessed?.coversFile(site.file,{sha256:site.baseHash,mode:site.mode}))continue;
  if(!assessed&&currentSiteMatches(site))continue;
  if(hashOf(siteBytes(site.backup))!==site.baseHash)throw new Error(`the original ${key} configuration is missing or changed: ${site.backup}`);
 }
}
function restoreSite(inst,journal,key='site'){
 const site=journal[key];
 if(!site||!['applying','applied'].includes(site.status))return;
 verifyConfigurationPath(site.file);
 if(site.baseHash===null){
  try{unlinkSync(site.file);}catch(e){if(e.code!=='ENOENT')throw e;}
 }else if(!currentSiteMatches(site)){
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

// --- the world, as the real command sees it ----------------------------------------------------------
/** exec(command, args, {cwd, env, timeoutMs}) → {status, stdout, stderr}; never throws. 127: not found, 124: timed out. */
export function realExec(command,args,{cwd,env,timeoutMs=120000}={}){
 const r=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:timeoutMs,maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
 if(r.error)return {status:r.error.code==='ETIMEDOUT'?124:127,stdout:r.stdout||'',stderr:`${r.stderr||''}${r.error.message}`};
 return {status:r.status??124,stdout:r.stdout||'',stderr:r.stderr||''};
}
const probeOk=async(ctx,url)=>{const sample=await ctx.probe(url);return typeof sample==='object'?sample.ok:sample;};
function realPidAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=1)return false;
 try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}
}
export const realContext=(extra={})=>({exec:realExec,probe:healthSample,pidAlive:realPidAlive,sleep:ms=>new Promise(r=>setTimeout(r,ms)),now:Date.now,monotonic:()=>performance.now(),log:line=>console.log(line),
 checkpoint:()=>{},node:process.execPath,user:(()=>{try{return os.userInfo().username;}catch{return null;}})(),stopSeconds:45,...extra});

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
  if(withinPath(dir,core)){sources[0].plugins.push(path.relative(core,dir));continue;}
  const base=path.dirname(dir);let id=path.basename(base)||'plugins';
  const known=sources.find(s=>s.dir===base);
  if(known){known.plugins.push(path.basename(dir));continue;}
  for(let n=2;id==='core'||id==='node_modules'||sources.some(s=>s.id===id);n++)id=`${path.basename(base)}-${n}`;
  sources.push({id,kind:'plugins',dir:base,plugins:[path.basename(dir)]});
 }
 const work=home??path.join(core,'backups');
 const pkgPath=path.join(core,'package.json');
 let repository=null;
 if(existsSync(pkgPath)){
  if(options.diagnostic)repository=readJson(pkgPath)?.homeHub?.updates?.repo??null;
  else{
   let pkg;
   try{pkg=JSON.parse(readFileSync(pkgPath,'utf8'));}
   catch(e){throw new UpdateError(`${pkgPath} is not valid JSON: ${e.message}`);}
   repository=pkg?.homeHub?.updates?.repo??null;
  }
 }
 return Object.freeze({home,root:core,env,repository,instanceHash:hashOf(instanceBytes),paths,service,health,keep:backups.keep,sources:Object.freeze(sources),
  backupRoots:options.backupRoots??[],backupPolicyFile:options.backupPolicy?path.resolve(options.backupPolicy):null,
  driverSource:path.resolve(core)===path.resolve(repoRoot)?null:repoRoot,trustFile:options.trust??(home?path.join(home,'update','trust.json'):null),
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
const readRun=inst=>{const r=readJson(inst.files.run);return plain(r)&&typeof r.version==='string'?r:null;};
const updateRepository=inst=>(inst.paths.siteConfig?readJson(inst.paths.siteConfig)?.updates?.repo:null)??readJson(path.join(inst.root,'package.json'))?.homeHub?.updates?.repo??null;

// Shared readiness expectation builders used by preflight and backup.
function fromExpectation(version,run){
 const plugins=run?(Array.isArray(run.plugins)?run.plugins:[]).map(p=>({id:p.id,version:p.version??null,...(p.fingerprint?{fingerprint:p.fingerprint}:{}),...(p.sourceFingerprint?{sourceFingerprint:p.sourceFingerprint}:{})})):null;
 return {
  version,
  previousPid:run?.pid??null,
  ...(run?.readinessProtocol===1?{readinessProtocol:1,dataEpoch:run.dataEpoch,fullCommit:run.fullCommit,packageDigest:run.packageDigest,previousBootId:run.bootId}:{}),
  plugins,
 };
}
function toExpectation({target,commit,packageDigest=null,modern,run,plugins}){
 return {
  version:target.version,
  previousPid:run?.pid??null,
  ...(modern?{readinessProtocol:1,dataEpoch:target.dataEpoch,fullCommit:commit,packageDigest,previousBootId:run?.bootId??null}:{}),
  plugins:plugins.map(p=>({id:p.id,version:p.version,...(modern?{fingerprint:p.fingerprint,sourceFingerprint:p.sourceFingerprint}:{})})),
 };
}
const releaseLabel=(facts,commit,plugins)=>`${facts.version}${plugins.some(p=>p.version)?` (${plugins.filter(p=>p.version).map(p=>`${p.id} ${p.version}`).join(', ')})`:''}${commit?` @ ${short(commit)}`:''}`;

// --- updates.json: the note the update card reads ---------------------------------------------------------
/** quarantined[version] = entry ({at, reason}), or removed with entry null. → false when the file belongs to newer code. */
export function setQuarantine(file,version,entry){
 const raw=existsSync(file)?readJson(file):null;
 if(Number.isInteger(raw?.schemaVersion)&&raw.schemaVersion>UPDATES_SCHEMA)return false;
 const doc=plain(raw)&&[1,UPDATES_SCHEMA].includes(raw.schemaVersion)?{...raw,schemaVersion:UPDATES_SCHEMA}:{schemaVersion:UPDATES_SCHEMA,sources:{},quarantined:{},dismissed:null};
 const {[version]:had,...rest}=plain(doc.quarantined)?doc.quarantined:{};
 if(!entry&&had===undefined)return true;
 doc.quarantined=Object.fromEntries([...(entry?[[version,{at:entry.at,reason:oneLine(entry.reason,120)||null}]]:[]),...Object.entries(rest)].slice(0,50));
 durableWrite(file,JSON.stringify(doc,null,1)+'\n');
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
function pruneArchives(inst,ctx,keepFile){
 try{
  const regular=file=>{
   try{const st=lstatSync(file);return st.isFile()?st:null;}catch(e){if(e.code==='ENOENT')return null;throw e;}
  };
  const old=readdirSync(inst.backups).filter(n=>/^pre-.*\.tgz$/.test(n)).flatMap(n=>{
   const file=path.join(inst.backups,n),st=regular(file);
   return st?[{file,at:st.mtimeMs}]:[];
  }).sort((a,b)=>b.at-a.at).slice(inst.keep).filter(a=>a.file!==keepFile);
  const active=readJournal(inst);
  for(const a of old){
   if(active?.backup?.file===a.file||!regular(a.file))continue;
   for(const suffix of ['.manifest.json','.manifest.jsonl','.integrity.json','.site.json','.instance.json'])
    if(regular(a.file+suffix))unlinkSync(a.file+suffix);
   unlinkSync(a.file);
   ctx.log(`  removed the old archive ${a.file}`);
  }
 }catch{}
}

// --- unified 7-step preflight --------------------------------------------------------------------------
// Fixture tests need the operating system and toolchain, never the live service's sockets, credentials or Node
// injection settings. An allowlist also covers plugin variables core cannot know. Preserve the spelling of Windows
// environment keys (Path/SystemRoot, for example). The final --check still gets the full instance environment.
const TEST_ENV=new Set(['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','TZ','LANG','LANGUAGE',
 'LC_ALL','LC_CTYPE','LC_COLLATE','LC_MESSAGES','LC_MONETARY','LC_NUMERIC','LC_TIME','LC_PAPER','LC_NAME','LC_ADDRESS','LC_TELEPHONE','LC_MEASUREMENT','LC_IDENTIFICATION',
 'SYSTEMROOT','SYSTEMDRIVE','WINDIR','COMSPEC','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA']);
const testEnv=env=>Object.fromEntries(Object.entries(env).filter(([k])=>TEST_ENV.has(k.toUpperCase())));
function hasTests(staged){
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
 * Unified 7-step preflight over the chosen Release Source adapter (Git Tag or Signed Package):
 *  1. Trust selection & policy loading
 *  2. Running hub identity verification (when forApply)
 *  3. Adapter target authentication, layout/dirty checks, backup coverage & staging
 *  4. Downgrade & quarantine refusal
 *  5. Plugin compatibility / requires, Node version, data epoch & site/instance staging
 *  6. Target tests (core + external plugin sources)
 *  7. Target start-up check (`node server/index.mjs --check`) + staged integrity finalization
 */
export async function preflight(inst,request,ctx,{forApply=false,sourceLocksHeld=false}={}){
 if(request.package&&request.core)throw new UpdateError('Conflicting Git and package targets');
 if(request.package&&(Object.keys(request.plugins??{}).length||(request.addPluginSources??[]).length))
  throw new UpdateError('Package activation keeps external plugin sources fixed. Update them in a separate Git transaction.');
 if(!sourceLocksHeld){
  const release=acquireSourceLocks([...inst.sources,...addedPluginSources(inst,request).sources],{now:ctx.now});
  try{return await preflight(inst,request,ctx,{forApply,sourceLocksHeld:true});}finally{release();}
 }
 if(request.trust)inst={...inst,trustFile:path.resolve(request.trust)};
 const adapter=releaseSourceForRequest(request);
 const say=line=>ctx.log(line);

 // 1. Trust selection & policy loading
 let trustFile;
 try{trustFile=selectTrustFile({home:inst.home,explicit:request.trust});}
 catch(e){throw new UpdateError(`Trust selection refused: ${e.message}`);}
 let trust=null;
 if(trustFile){
  try{trust=loadTrust(trustFile,{forbidden:forbiddenTrustRoots(inst)});}
  catch(e){throw new UpdateError(`Trust policy refused: ${e.message}`);}
 }
 const instWithTrust={...inst,trustFile:trustFile??inst.trustFile};
 const initialSnapshot=sourceSnapshot(inst,ctx);
 const addedSources=addedPluginSources(inst,request);
 const live=[...inst.sources,...addedSources.sources].map(s=>inspectSource(ctx,s)),core=live[0];
 const installed=coreFacts(core.dir);
 if(!installed)throw new UpdateError(`${core.dir}/package.json has no version.`);
 const run=readRun(inst);
 const repository=updateRepository(inst);

 // 2. Running hub identity check (forApply)
 if(forApply){
  needService(inst);
  if(!run)throw new UpdateError(`${inst.files.run} is missing. A running hub writes it, so either the hub is not running or its state directory is somewhere else: pass --state (or STATE_DIR), as the service has it.`);
  const why=identityMismatch(run,{version:installed.version},{pidAlive:ctx.pidAlive});
  if(why)throw new UpdateError(`The hub is not running what this checkout holds: ${why}. Start (or restart) it first; an update begins from a hub that works.`);
  if(core.git&&typeof run.commit==='string'&&run.commit&&!core.commit.startsWith(run.commit))
   throw new UpdateError(`The running hub commit differs from the installed checkout: started from ${run.commit}, checkout is now on ${short(core.commit)}; restart it first, so that "the previous version" is one that has run.`);
  const receipt=packageReceipt(inst.root);
  if(receipt&&(run.readinessProtocol!==1||run.fullCommit!==receipt.fullCommit||run.packageDigest!==receipt.manifestSha256))
   throw new UpdateError('The running hub identity differs from the installed package; restart it before applying an update.');
  if(!(await probeOk(ctx,inst.health.url)))throw new UpdateError(`${inst.health.url} does not answer now, before anything was changed. Check the address: a health check that cannot pass would roll every update back.`);
 }

 // 3. Adapter target authentication, backup coverage & staging
 const staged=await adapter.stageTarget(instWithTrust,request,ctx,trust,{
  installed,
  live,
  trustFile,
  repository,
  checkBackup:extra=>backupPlan(instWithTrust,extra),
 });
 const lines=[...staged.lines];
 let keepStage=false;
 try{
  if(trustFile)rememberTrustSelection(inst.home,trustFile);
  const coverage=staged.coverage??backupPlan(instWithTrust);
  const {target,targetCommit,targetTag,stagedDir,stagingRoot,place,stagedPluginDirs,changes,modern}=staged;

  // 4. Downgrade & quarantine refusal
  if(compare(target.version,installed.version)<0)
   throw new UpdateError(`${target.version} is lower than what is installed (${installed.version}). Going back is "rollback", and only to the version the last update came from.`);
  if(target.dataEpoch<installed.dataEpoch)
   throw new UpdateError(`${targetTag??target.version} has data epoch ${target.dataEpoch}, lower than the installed ${installed.dataEpoch}: it could not read this instance's state.`);
  const coreChanges=Boolean(request.package)||changes.some(c=>c.id==='core');
  const quarantines=readQuarantine(inst.files.updates);
  const quarantined=[...(coreChanges?[target.version]:[]),...staged.quarantineKeys].map(k=>quarantines[k]).find(Boolean);
  if(coreChanges&&quarantined&&!request.force)
   throw new UpdateError(`${target.version} was tried here on ${String(quarantined.at).slice(0,10)} and rolled back${quarantined.reason?` (${quarantined.reason})`:''}. --force tries it again.`);

  // 5. Compatibility, data epoch, and site/instance staging
  const stagedCoreFacts=coreFacts(stagedDir);
  if(!stagedCoreFacts||stagedCoreFacts.version!==target.version)
   throw new UpdateError(`The staged core reads ${stagedCoreFacts?.version??'no version'}, not ${target.version}.`);
  if(target.node&&validRange(target.node)&&!satisfies(process.versions.node,target.node))
   throw new UpdateError(`Home Hub ${target.version} needs Node ${target.node}; this is ${process.versions.node}.`);

  const before=pluginsOf(inst);
  const after=stagedPluginDirs.flatMap(({dir})=>pluginFacts(dir));
  for(const p of after){
   if(!p.core||(staged.strictPlugins&&!p.version)){
    if(staged.strictPlugins)throw new UpdateError(`Plugin ${p.id} is incompatible with ${target.version}; a version and valid core range in plugin.json are required.`);
    lines.push(`plugin ${p.id}: no plugin.json, so no core range to check`);
    continue;
   }
   if(!validRange(p.core)||!satisfies(target.version,p.core))
    throw new UpdateError(`Plugin ${p.id}${p.version?' '+p.version:''} supports Home Hub ${p.core}; the target is ${target.version}. Update the plugins too (--plugins <tag>), or stay.`);
   for(const [id,range] of Object.entries(p.requires)){
    const other=after.find(o=>o.id===id);
    if(!other)throw new UpdateError(`Plugin ${p.id} needs plugin ${id} (${range}), which would not be installed.`);
    if(!other.version||!validRange(range)||!satisfies(other.version,range))
     throw new UpdateError(`Plugin ${p.id} needs plugin ${id} ${range}; ${other.version??'an unversioned one'} would be installed.`);
   }
  }
  if(after.length)lines.push(`plugins: ${after.map(p=>`${p.id}${p.version?' '+p.version:''}`).join(', ')}: every core range includes ${target.version}`);

  const epochs=[...(target.dataEpoch>installed.dataEpoch?[`core ${installed.dataEpoch} → ${target.dataEpoch}`]:[]),
   ...after.flatMap(p=>{const was=before.find(b=>b.id===p.id);return was&&p.dataEpoch!==null&&p.dataEpoch>(was.dataEpoch??1)?[`plugin ${p.id} ${was.dataEpoch??1} → ${p.dataEpoch}`]:[];})];
  const lower=after.find(p=>{const was=before.find(b=>b.id===p.id);return was&&was.dataEpoch!==null&&(p.dataEpoch??1)<was.dataEpoch;});
  if(lower)throw new UpdateError(`Plugin ${lower.id} would go to a lower data epoch; it could not read its own state.`);
  const epochRose=epochs.length>0;

  // Paths inside the checkout follow it into the stage when the target tracks them (an overlay kept in git), and
  // stay the instance's own otherwise (data, state, secrets, a site file that is not in git).
  const at=dir=>{if(!withinPath(dir,core.dir))return dir;const there=path.join(stagedDir,path.relative(core.dir,dir));return existsSync(there)?there:dir;};
  const siteChange=stageSite(inst,request,installed,target,stagingRoot);
  if(addedSources.change){const checked=mkdtempSync(path.join(stagingRoot,'.instance-'));durableWrite(path.join(checked,'instance.json'),addedSources.change.text);readInstance(checked);}
  const siteFile=siteChange?.staged??(inst.paths.siteConfig?at(inst.paths.siteConfig):null);
  const checkEnv={...inst.env,HOME_HUB_CONFIG_DIR:at(inst.paths.config),HOME_HUB_SITE_CONFIG:siteFile??'none',DATA_DIR:at(inst.paths.data),STATE_DIR:at(inst.paths.state),HOME_HUB_PRIVATE_DIR:at(inst.paths.private),AUTH_FILE:at(inst.paths.authFile)};
  // A temporary site path must not move the implicit software watch list away from the live configuration.
  if(siteChange)checkEnv.SOFTWARE_WATCH_FILE=inst.paths.softwareWatch;
  if(live.length>1){mkdirSync(path.join(stagingRoot,'node_modules'),{recursive:true});symlinkSync(stagedDir,path.join(stagingRoot,'node_modules','home-hub'),'dir');}
  checkEnv.HOME_HUB_PLUGINS_DIR=stagedPluginDirs.length?stagedPluginDirs.map(d=>d.dir).join(path.delimiter):'none';

  if(siteChange)lines.push('site configuration: staged for the target; the original will be saved before replacement and restored on rollback');
  if(addedSources.change)lines.push(`instance configuration: add plugin source(s) ${addedSources.sources.map(s=>s.id).join(', ')} only after stopping; rollback restores the original manifest`);
  lines.push(epochRose?`DATA EPOCH RISES (${epochs.join('; ')}): after this update the old code cannot read the state. Going back means restoring the archive made before the switch; whatever is written after the update is then lost.`
   :`data epoch unchanged (${installed.dataEpoch}): going back keeps application data${siteChange?'; the original site configuration is restored':', and nothing written since is lost'}`);

  // 6. The target's own tests
  if(request.skipTests)lines.push('tests: SKIPPED (--skip-tests)');
  else{
   const env=testEnv(inst.env),runner=path.join(stagedDir,'scripts','run-tests.mjs');
   say(`Testing ${target.version} in ${stagingRoot}:`);
   const summary=r=>lastLines(r.stdout,8).split('\n').filter(l=>/^\S+\s+tests \d+/.test(l)).map(l=>l.replace(/\s+/g,' ')).join('; ');
   lines.push(`tests (core): ${summary(runStep(ctx,'npm test of the target',ctx.node,[runner,...(staged.copiedLocalPlugins&&inst.paths.siteConfig&&existsSync(inst.paths.siteConfig)?['--site',inst.paths.siteConfig]:[])],{cwd:stagedDir,env}))||'passed'}`);
   const tested=live.filter(s=>s.kind==='plugins'&&s.plugins.includes('plugins')&&hasTests(place(s)));
   // Each source owns its fixture site. Passing multiple sources makes the runner load unrelated plugins with
   // each source's fixture, which can neither configure them nor authorize use of the live site's settings.
   // Keep these test runs separate; the --check below still validates every target source together on the real site.
   if(tested.length)for(const source of tested)lines.push(`tests (plugins): ${summary(runStep(ctx,`the ${source.id} plugin tests against the target core`,ctx.node,[runner,'--plugins',place(source)],{cwd:stagedDir,env}))||'passed'}`);
   else if(live.length>1)lines.push('tests (plugins): the plugin sources have no tests');
  }

  // 7. Would it start, with this instance's site and these plugins
  const index=path.join(stagedDir,'server','index.mjs');
  if(!existsSync(index))throw new UpdateError(`${target.version} has no server/index.mjs; refusing.`);
  const hasCheck=/'--check'/.test(readFileSync(index,'utf8'));
  if(staged.requireCheck&&!hasCheck)throw new UpdateError('New packages require a startup --check capability');
  if(hasCheck){
   say('Start-up check with this instance\'s configuration:');
   const r=runStep(ctx,'The start-up check (node server/index.mjs --check)',ctx.node,[index,'--check'],{cwd:stagedDir,env:checkEnv,timeoutMs:120000});
   const said=r.stdout.split('\n').find(l=>l.startsWith('check ok'));
   // Exit 0 without that line means the check did not run at all (the file was loaded, not executed as the server).
   if(!said)throw new UpdateError(`The start-up check of ${target.version} ended without saying "check ok". The instance was not touched.\n${lastLines(`${r.stdout}\n${r.stderr}`,20)}`);
   lines.push(oneLine(said).replaceAll(stagingRoot,'<stage>'));
  }else lines.push(`start-up check: ${target.version} has no --check; skipped`);

  const extraLines=staged.finalizeStage()??[];
  lines.push(...extraLines);

  const isChanged=source=>source.id==='core'?Boolean(request.package)||changes.some(c=>c.id==='core'):changes.some(c=>c.id===source.id);
  const expectedPlugins=stagedPluginDirs.flatMap(({source,rel,dir})=>pluginFacts(dir).map(p=>{
   const fpDir=isChanged(source)?dir:path.join(source.dir,rel);
   return {id:p.id,version:p.version,...(modern?{fingerprint:contentFingerprint(path.join(fpDir,p.id)),sourceFingerprint:pluginSourceFingerprint(fpDir)}:{})};
  }));
  const fromCommit=core.commit??packageReceipt(inst.root)?.fullCommit??null;
  const plan={
   from:{
    label:releaseLabel(installed,fromCommit,before),
    core:{...installed,commit:fromCommit,tag:core.tag},
    plugins:before.map(({id,version,dataEpoch})=>({id,version,dataEpoch})),
    expect:fromExpectation(installed.version,run),
   },
   to:{
    label:releaseLabel(target,targetCommit,after),
    core:{...target,commit:targetCommit,tag:targetTag},
    plugins:after.map(({id,version,dataEpoch})=>({id,version,dataEpoch})),
    expect:toExpectation({target,commit:targetCommit,packageDigest:staged.packageDigest,modern,run,plugins:expectedPlugins}),
   },
   changes,
   epochRose,
   lines,
   trustFile,
   coverage,
   sourceSnapshot:initialSnapshot,
   trustDigest:trustFile?sha256(readFileSync(trustFile)):null,
   repository,
   journalFields:staged.journalFields,
   ...staged.journalFields,
   siteChange:siteChange?Object.fromEntries(Object.entries(siteChange).filter(([k])=>k!=='staged')):null,
   instanceChange:addedSources.change,
   ...(forApply&&staged.keepStageOnSuccess?{cleanupStage:()=>staged.cleanup()}:{}),
  };
  keepStage=forApply&&staged.keepStageOnSuccess;
  return plan;
 }finally{
  if(keepStage)staged.cleanupWorkspace();
  else staged.cleanup();
 }
}

function sourceSnapshot(inst,ctx){
 const files=[inst.paths.config,inst.paths.siteConfig,inst.paths.softwareWatch,inst.paths.authFile,inst.env.HOME_HUB_SECRET_KEY_FILE,inst.env.INTEGRATION_SECRETS_FILE,inst.env.GITHUB_TOKEN_FILE,inst.env.TLS_KEY,inst.env.TLS_CERT,...(inst.home?[path.join(inst.home,'instance.json')]:[])].filter(Boolean);
 return {sources:inst.sources.map(s=>{const g=inspectSource(ctx,s);return {dir:s.dir,canonical:realpathSync(s.dir),device:statSync(s.dir).dev,inode:statSync(s.dir).ino,commit:g.commit,dirty:g.dirty,plugins:s.plugins.map(p=>contentFingerprint(path.join(s.dir,p))),...(s.kind==='plugins'?{sourceFingerprints:s.plugins.map(rel=>pluginSourceFingerprint(path.join(s.dir,rel)))}:{}),...(!g.git?{content:contentFingerprint(s.dir)}:{})};}),configuration:files.map(file=>[file,existsSync(file)?realpathSync(file):null,existsSync(file)?contentFingerprint(realpathSync(file)):null])};
}
function recordDriver(inst,journal,ctx){
 const facts=coreFacts(repoRoot);
 const tree=inspectSource(ctx,{dir:repoRoot});
 retainDriver(inst,journal,repoRoot,{version:facts.version,commit:tree.git&&!tree.dirty.length?tree.commit:null});
}
function sameCoverage(before,after){
 if(before.policy.file!==after.policy.file||before.policy.digest!==after.policy.digest||
  JSON.stringify(before.roots)!==JSON.stringify(after.roots))throw new UpdateError('Backup policy or root topology changed since preflight; retry from a new plan.');
 return after;
}
function backupPolicyRecord(coverage){
 const {file,digest}=coverage.policy;
 return file?{backupPolicy:{file,digest}}:{};
}

// --- apply / undo / recover / rollback -----------------------------------------------------------------
const pathsLine=(inst,journal,adapter)=>`  journal  ${inst.files.journal}\n  archive  ${journal.backup?.file??'(none was made)'}\n  history  ${inst.files.history}\n  driver   ${journal.driver??'retain this trusted driver checkout'}\n  failed   ${adapter.failedPath(journal)??journal.failedState??'(none)'}${[...(journal.restoreRoots??[]),...(journal.socketRestore?.units??[])].map(r=>'\n  root     '+r.live+'; retained failed root '+r.aside).join('')}`;

/**
 * Puts the `from` side of a journal back: stop, switch the code back, restore the archive when the data epoch rose
 * and the new version ran, note the quarantine, start, health check. Ends as rolled-back (or aborted, when nothing had
 * been switched yet). When that fails the service is left stopped and RollbackFailed names the files that matter.
 */
async function undo(inst,ctx,journal){
 const adapter=releaseSourceForJournal(journal);
 let assessed=null;
 try{
  checkRetainedDriver(journal);
  adapter.verifyRollbackPreStop(inst,journal,ctx);
  if(journal.epochRose&&journal.started&&!journal.restored){
   if(!journal.backup)throw new Error('the data epoch rose and the new version was started, but the journal names no archive');
   assessed=await assessRestore(inst,journal.backup,journal);
  }
  verifyConfigurationRecovery(journal,assessed);
 }catch(e){throw new UpdateError(`Rollback assessment refused before stopping the service: ${e.message}\n${pathsLine(inst,journal,adapter)}`);}
 const switched=!['stopping','backup','backup-verified'].includes(journal.undoFrom??journal.step);
 if(journal.step!=='rolling-back'&&journal.step!=='rollback-failed')journal.undoFrom=journal.step;
 journal.step='rolling-back';writeJournal(inst,journal);
 let stopped=false;
 try{
  const moved=adapter.hasMoved(inst,journal,ctx);
  // Nothing was switched and the old hub still answers as before (a stop that was refused, or one that said yes
  // and stopped nothing): there is nothing to put back, and stopping it again would only fail the same way.
  const untouched=!switched&&!moved&&(await probeOk(ctx,inst.health.url))&&!identityMismatch(readRun(inst),journal.from.expect,{pidAlive:ctx.pidAlive});
  if(untouched)ctx.log('  the hub still runs as it did; nothing was changed. Check the service\'s stop command before trying again.');
  if(!untouched){
   await stopService(inst,ctx,readRun(inst)?.pid??null);
   stopped=true;
   // The stop command can change the state layout. Reassess against the archive before switching code.
   if(assessed)assessed=await assessRestore(inst,journal.backup,journal);
   verifyConfigurationRecovery(journal,assessed);
   adapter.rollbackSwitch(inst,journal,ctx);
   if(assessed){
    ctx.log(`  restoring ${journal.backup.file} (the data epoch rose, and the new version has written its state)`);
    journal.failedState=await restoreBackup(inst,ctx,journal.backup,journal,assessed);journal.restored=true;writeJournal(inst,journal);
   }
   // The site may have changed before the new code ever started; restore it independently of the data epoch.
   for(const key of ['site','instance'])restoreSite(inst,journal,key);
   if(journal.quarantine&&journal.to.core.version!==journal.from.core.version){
    if(!setQuarantine(inst.files.updates,journal.to.core.version,{at:iso(ctx.now()),reason:journal.quarantine.reason}))ctx.log(`  (${inst.files.updates} belongs to newer code; the quarantine note was not written)`);
   }
   if(journal.quarantine){
    for(const key of adapter.quarantineKeys(journal))setQuarantine(inst.files.updates,key,{at:iso(ctx.now()),reason:journal.quarantine.reason});
   }
   const since=ctx.now();
   stopped=false;
   await startService(inst,ctx);
   await waitHealthy(inst,ctx,journal.from.expect,since,{interruptible:false});
  }
  journal.step=switched||moved?'rolled-back':'aborted';journal.finishedAt=iso(ctx.now());writeJournal(inst,journal);
  history(inst,ctx,journal,journal.step);
  return journal;
 }catch(e){
  journal.step='rollback-failed';journal.rollbackError=oneLine(e.message);writeJournal(inst,journal);
  history(inst,ctx,journal,'rollback-failed');
  if(!stopped)try{ctx.exec(inst.service.stop[0],inst.service.stop.slice(1),{timeoutMs:60000});}catch{}
  throw new RollbackFailed(`The previous version could not be brought back: ${e.message}\nThe service was told to stop and is left stopped. Look at these, fix the cause, then run "rollback" again:\n${pathsLine(inst,journal,adapter)}`);
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
 const adapter=releaseSourceForRequest(request);
 const release=takeLock(inst,ctx);let sourceRelease=()=>{},cleanupStage=null;
 try{
  if(unfinished(readJournal(inst))){const old=readJournal(inst);sourceRelease=acquireSourceLocks([...inst.sources,...old.changes],{now:ctx.now});await reconcileJournal(inst,ctx,old);throw new UpdateError('The unfinished transaction was recovered. Run apply again for a new update.');}
  sourceRelease=acquireSourceLocks([...inst.sources,...addedPluginSources(inst,request).sources],{now:ctx.now});
  ctx.log('Preflight:');
  const plan=await preflight(inst,request,ctx,{forApply:true,sourceLocksHeld:true});
  cleanupStage=plan.cleanupStage??null;
  for(const line of plan.lines)ctx.log(`  ${line}`);
  inst={...inst,trustFile:plan.trustFile??inst.trustFile};
  const coverage=sameCoverage(plan.coverage,backupPlan(inst));
  for(const change of [plan.siteChange,plan.instanceChange])if(change)checkSiteUnchanged(change);
  if(JSON.stringify(sourceSnapshot(inst,ctx))!==JSON.stringify(plan.sourceSnapshot))throw new UpdateError('Installed source/plugin/configuration fingerprint changed since preflight; refusing before stop');
  adapter.verifyPreSwitch(inst,plan,ctx);
  if(plan.trustFile){loadTrust(plan.trustFile,{forbidden:forbiddenTrustRoots(inst)});if(sha256(readFileSync(plan.trustFile))!==plan.trustDigest)throw new UpdateError('Trust policy changed since preflight; refusing before stop');}
  for(const change of [plan.siteChange,plan.instanceChange])if(change)checkSiteUnchanged(change);
  ctx.checkpoint();
  const started=ctx.now(),run=readRun(inst);
  const journal={schemaVersion:JOURNAL_SCHEMA,id:`${stampOf(started)}-${process.pid}`,startedAt:iso(started),by:ctx.user??null,from:plan.from,to:plan.to,changes:plan.changes,epochRose:plan.epochRose,
   ...plan.journalFields,...(plan.trustFile?{trustFile:plan.trustFile}:{}),...backupPolicyRecord(coverage),settings:{service:inst.service.spec,health:inst.health,root:inst.root,home:inst.home,state:inst.paths.state},step:'stopping',started:false,backup:null};
  recordDriver(inst,journal,ctx);
  writeJournal(inst,journal);cleanupStage=null;
  const fail=async(e,quarantine)=>{
   journal.failure={step:journal.step,message:oneLine(e.message)};
   if(e.stopRefused)journal.stopRefused=true;
   // A lost session or Ctrl-C says nothing about the release: it is put back, and not noted as a release that failed.
   if(quarantine&&!e.interrupted)journal.quarantine={reason:oneLine(e.message,120)};
   ctx.log(`\nFAILED at "${journal.step}": ${e.message}\nPutting ${plan.from.label} back:`);
   await undo(inst,ctx,journal);
   throw new UpdateError(`The update to ${plan.to.label} failed at "${journal.failure.step}": ${e.message}\n${journal.step==='aborted'?'Nothing had been switched':'It was rolled back'}; ${plan.from.label} is running again.${journal.quarantine&&plan.to.core.version!==plan.from.core.version?` ${plan.to.core.version} is noted as tried and rolled back (the update card says so; --force tries it again).`:''}\n${pathsLine(inst,journal,adapter)}`);
  };
  try{
   ctx.log(`\nStopping the hub (${plan.from.label}):`);
   await stopService(inst,ctx,run?.pid??null);
   ctx.checkpoint();
   journal.step='backup';writeJournal(inst,journal);
   ctx.log('Archiving, with the hub stopped:');
   journal.backup=await createBackup(inst,ctx,`pre-${plan.from.core.version}-to-${plan.to.core.version}-${stampOf(started)}`,{plan:sameCoverage(coverage,backupPlan(inst))});
   for(const key of ['site','instance'])if(plan[`${key}Change`]){
    const site=plan[`${key}Change`],original=checkSiteUnchanged(site),backupFile=journal.backup.file+`.${key}.json`;
    if(original!==null)durableWrite(backupFile,original);
    journal[key]={file:site.file,backup:original===null?null:backupFile,baseHash:site.baseHash,mode:site.mode,status:'prepared'};
    writeJournal(inst,journal);
   }
   journal.step='backup-verified';writeJournal(inst,journal);
   ctx.log(`  ${journal.backup.file} (${backupRootSummary(journal.backup.entries)}; ${journal.backup.files} entries, ${Math.ceil(journal.backup.bytes/1024)} KiB)`);
   ctx.checkpoint('backup-verified');
  }catch(e){await fail(e,false);}
  try{
   if(JSON.stringify(sourceSnapshot(inst,ctx))!==JSON.stringify(plan.sourceSnapshot))throw new Error('Source/configuration topology changed after backup; refusing switch');
   adapter.verifyPreSwitch(inst,plan,ctx);
   journal.step='switching';writeJournal(inst,journal);
   ctx.log('Switching:');
   adapter.applySwitch(inst,journal,plan,ctx);
   for(const key of ['site','instance'])if(plan[`${key}Change`]){
    checkSiteUnchanged(plan[`${key}Change`]);
    journal[key].status='applying';writeJournal(inst,journal);
    replaceSite(journal[key].file,plan[`${key}Change`].text,journal[key].mode);
    journal[key].status='applied';writeJournal(inst,journal);
   }
   journal.step='switched';writeJournal(inst,journal);
   if(Boolean(plan.package)||plan.changes.some(c=>c.id==='core'))setQuarantine(inst.files.updates,plan.to.core.version,null);
   for(const key of adapter.quarantineKeys(journal))setQuarantine(inst.files.updates,key,null);
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
 }finally{
  try{cleanupStage?.();}
  finally{sourceRelease();release();}
 }
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
  const adapter=releaseSourceForJournal(journal);
  adapter.verifyRollbackTarget(inst,journal,ctx);
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
  const recorded=readJournal(inst),previous=recorded?.kind==='backup'?recorded.previous??null:recorded,facts=coreFacts(inst.root);
  const side={label:version,core:facts,expect:fromExpectation(run?.version??version,run)};
  const journal={schemaVersion:JOURNAL_SCHEMA,id:`backup-${stampOf(ctx.now())}-${process.pid}`,kind:'backup',previous,startedAt:iso(ctx.now()),from:side,to:side,changes:[],epochRose:false,started:false,backup:null,settings:{service:inst.service.spec,health:inst.health,root:inst.root,home:inst.home,state:inst.paths.state},step:'stopping'};
  const coverage=backupPlan(inst);Object.assign(journal,backupPolicyRecord(coverage));
  recordDriver(inst,journal,ctx);writeJournal(inst,journal);
  ctx.log('Stopping the hub:');
  await stopService(inst,ctx,run?.pid??null);ctx.checkpoint('manual-backup-stopped');
  journal.step='backup';writeJournal(inst,journal);
  let made=null,error=null;
  try{made=await createBackup(inst,ctx,`manual-${version}-${stampOf(ctx.now())}`,{plan:sameCoverage(coverage,backupPlan(inst))});}catch(e){error=e;}
  journal.backup=made;journal.step='starting';writeJournal(inst,journal);
  ctx.log('Starting it again:');
  const since=ctx.now();
  try{await startService(inst,ctx);await waitHealthy(inst,ctx,journal.from.expect,run?since:0);}catch(e){journal.step='rollback-failed';journal.rollbackError=oneLine(e.message);writeJournal(inst,journal);ctx.exec(inst.service.stop[0],inst.service.stop.slice(1));throw new RollbackFailed(`Manual backup could not restart the previous service: ${e.message}\n${pathsLine(inst,journal,gitReleaseSource)}`);}
  journal.step='done';journal.finishedAt=iso(ctx.now());writeJournal(inst,journal);
  if(previous)writeJournal(inst,previous);
  if(error)throw new UpdateError(`The archive failed: ${error.message}. The hub is running again.`);
  return {...made,summary:backupRootSummary(made.entries)};
 }finally{sourceRelease();release();}
}

// --- CLI workflows (diagnostics, package verification & published discovery) ---------------------------
function instanceUpdateSettings(inst,{env=inst.env}={}){
 const site=inst.paths.siteConfig&&existsSync(inst.paths.siteConfig)?JSON.parse(readFileSync(inst.paths.siteConfig,'utf8')):null;
 const repo=existsSync(path.join(inst.root,'package.json'))?JSON.parse(readFileSync(path.join(inst.root,'package.json'),'utf8')).homeHub?.updates?.repo:null;
 return updateSettings({site,version:{updates:{repo}},env});
}
function assertDiscoveryEnabled(inst,{env=inst.env}={}){
 const integrationsFile=path.join(inst.paths.state,'integrations.json');
 const integrations=existsSync(integrationsFile)?JSON.parse(readFileSync(integrationsFile,'utf8')):{};
 const disabled=updateSettings({env}).envOff||Object.hasOwn(integrations?.disabled??{},UPDATE_INTEGRATION);
 if(disabled)throw new UpdateError('Update discovery is disabled; no update network requests were made.');
}

export function diagnoseBackup(inst,{trust=null,scan={},readOnly=false}={}){
 let trustFile;
 try{trustFile=selectTrustFile({home:inst.home,explicit:trust});}
 catch(e){throw new UpdateError(`Trust selection refused: ${e.message}`);}
 const scanned=scanBackup({...inst,trustFile:trustFile??inst.trustFile},scan);
 const report=Object.fromEntries(['rootStats','totals','links','filesystems','blockers','warnings','counts','runtimeSockets','candidatePolicy'].map(k=>[k,scanned[k]]));
 if(scanned.policy)report.policy={file:scanned.policy.file,budget:scanned.policy.budget,exactFiles:scanned.policy.coverFiles.length};
 if(readOnly){
  let journal;
  try{journal=readJournal(inst);}
  catch(error){
   report.blockers.push({code:'JOURNAL_UNREADABLE',message:error.message});
   report.counts.JOURNAL_UNREADABLE=1;
  }
  report.journal=journal?.step??null;
  if(unfinished(journal)){
   report.blockers.push({code:'UNFINISHED_UPDATE',message:`Recover transaction ${journal.id} before applying another update`});
   report.counts.UNFINISHED_UPDATE=1;
  }
 }
 return report;
}

export async function verifyPackageTarget(inst,{packageFile,trust=null,manifestDigest=null,env=inst.env}={}){
 const trustFile=selectTrustFile({home:inst.home,explicit:trust});
 const settings=instanceUpdateSettings(inst,{env});
 const result=await verifyPackage(packageFile,{trustFile,repository:settings.repo,manifestDigest,compatibility:false,forbidden:forbiddenTrustRoots(inst)});
 rememberTrustSelection(inst.home,trustFile);
 return result;
}

export async function downloadRelease(inst,{tag,trust=null,manifestDigest=null,output=process.cwd(),env=inst.env}={}){
 assertDiscoveryEnabled(inst,{env});
 const settings=instanceUpdateSettings(inst,{env});
 const trustFile=selectTrustFile({home:inst.home,explicit:trust});
 const token=(await loadGithubToken({env})).token,fetchJson=createFetchJson({token});
 if(trustFile)loadTrust(trustFile,{forbidden:forbiddenTrustRoots(inst)});
 const result=await downloadPackage({tag,repository:settings.repo,trustFile,manifestDigest,output:path.resolve(output),fetchJson});
 rememberTrustSelection(inst.home,trustFile);
 return result;
}

export async function resolvePublishedUpdate(inst,{env=inst.env}={}){
 assertDiscoveryEnabled(inst,{env});
 const settings=instanceUpdateSettings(inst,{env});
 const token=(await loadGithubToken({env})).token,fetchJson=createFetchJson({token});
 const found=await discoverReleases({repository:settings.repo,channel:settings.channel,fetchJson});
 const tag=found.found.tag;
 if(!tag)throw new UpdateError('No published release selected');
 return {tag,found:found.found,releases:found.releases};
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
   archive:journal.backup?.file??null,driver:journal.driver??null,failure:journal.failure??null}:null};
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
  if(j.driver)out.push(`  driver    ${j.driver}/scripts/update.mjs`);
  if(j.unfinished)out.push('  UNFINISHED: run "rollback" to put the previous version back before anything else.');
 }else out.push('Last update: none recorded');
 return out;
}
