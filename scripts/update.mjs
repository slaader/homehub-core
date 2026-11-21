#!/usr/bin/env node
// Update this Home Hub to a release tag, with a way back. Run it on the server, as the person (or the agent)
// who may restart the service; the hub itself never runs it, and nothing in the hub can (docs/updating.md).
//
//   node scripts/update.mjs status                          what is installed and running, the newest tag, the last update
//   node scripts/update.mjs preflight [v1.3.0]              everything that can be checked without touching the instance
//   node scripts/update.mjs apply     [v1.3.0]              preflight, stop, archive, switch, start, health check; back on any failure
//   node scripts/update.mjs rollback  [--yes]               undo the last update (or finish putting back one that was cut short)
//   node scripts/update.mjs backup                          only the archive (stop, archive, start)
//
// Without a tag: the newest release tag after a fetch. --to <tag> is the same as the bare tag.
// --plugins [<source>=]<tag>   also (or only) switch a plugin source, a git checkout of its own, to its tag
// --site-config FILE          stage this target configuration; replace the live site only inside apply's transaction
// --add-plugin-source NAME    append an inactive <home>/NAME source at the switch; also needs --plugins NAME=<tag>
//
// Which installation: this checkout, or --root DIR (a release that has no update command yet is updated by running
// this file from a newer checkout with --root). Where its data is: the same variables the server reads
// (HOME_HUB_HOME, DATA_DIR, STATE_DIR, HOME_HUB_PRIVATE_DIR), or --home, --data, --state, --private.
// How it is stopped, started and checked: <HOME_HUB_HOME>/instance.json → service, health, backups; or
//   --service launchd:system/<label> | launchd:gui/<uid>/<label> | systemd:<unit> | systemd-user:<unit> | 'command:{"stop":[…],"start":[…]}'
//   --health http://127.0.0.1:<port>/healthz   [--health-seconds 60]
//   --backups DIR  [--keep 5]                  where archives go (default <home>/backups, else <checkout>/backups)
// Other: --no-fetch (use the tags that are here), --skip-tests, --allow-unsigned, --force (a release that was rolled
// back here before), --staging DIR (where the scratch worktree is made), --reason TEXT (rollback), --json (status).
//
// Exit: 0 done; 1 refused, or failed and put back (the previous version runs); 2 usage; 3 the previous version could
// not be brought back and the service is stopped.
import path from 'node:path';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {scanBackup,backupRootSummary} from '../server/update-backup.mjs';
import {acquireLock} from '../server/update-lock.mjs';
import {verifyPackage} from '../server/release-package.mjs';
import {downloadPackage,discoverReleases} from '../server/release-catalog.mjs';
import {loadTrust,selectTrustFile,rememberTrustSelection,forbiddenTrustRoots,importTrustKey} from '../server/release-trust.mjs';
import {updateSettings,UPDATE_INTEGRATION} from '../server/update-check.mjs';
import {loadGithubToken,createFetchJson} from '../server/systems-upstream.mjs';
import {fileURLToPath} from 'node:url';
import {resolveInstance,preflight,apply,rollback,backup,status,formatStatus,realContext,readJournal,UpdateError,RollbackFailed} from '../server/update-apply.mjs';

const VALUE=['--to','--plugins','--site-config','--add-plugin-source','--root','--home','--data','--state','--private','--service','--health','--health-seconds','--backups','--keep','--staging','--reason','--trust','--package','--manifest-sha256','--output','--backup-root','--public-key','--fingerprint','--repository','--role','--backup-policy','--search-root','--search-max-entries','--examples'];
const FLAG=['--no-fetch','--skip-tests','--allow-unsigned','--force','--yes','--json','--help','--latest-published','--migrate-from-git','--candidate-cover-files','--read-only'];
const COMMANDS=['status','preflight','apply','rollback','backup','backup-diagnose','verify-package','download','install','trust-import'];
const USAGE=`Usage: node scripts/update.mjs status | preflight [<tag>] | apply [<tag>] | rollback [--yes] | backup | backup-diagnose | verify-package --package FILE | download <tag> | install --package FILE | trust-import
  [--plugins [<source>=]<tag>]… [--add-plugin-source NAME]… [--site-config FILE]
  [--root DIR] [--home DIR] [--data DIR] [--state DIR] [--private DIR]
  [--service SPEC] [--health URL] [--health-seconds N] [--backups DIR] [--keep N] [--staging DIR]
  [--trust FILE] [--package FILE] [--manifest-sha256 HASH] [--latest-published] [--migrate-from-git]
  [--backup-root PATH] [--backup-policy FILE] [--no-fetch] [--skip-tests] [--allow-unsigned] [--force] [--reason TEXT] [--json]
  backup-diagnose [--search-root DIR]… [--search-max-entries N] [--examples N] [--candidate-cover-files]
  preflight --read-only   Check backup coverage and recovery state with no writes or network
docs/updating.md has the whole of it.`;

class UsageError extends Error{}
export function parseArgs(argv){
 const out={command:null,tag:null,plugins:{},addPluginSources:[],backupRoots:[],searchRoots:[],flags:new Set(),values:{}};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(VALUE.includes(a)){
   const v=argv[++i];if(!v||v.startsWith('--'))throw new UsageError(`${a} needs a value`);
   if(a==='--plugins'){const at=v.indexOf('=');const [source,tag]=at<0?['*',v]:[v.slice(0,at),v.slice(at+1)];if(!source||!tag||out.plugins[source])throw new UsageError('--plugins takes <tag>, or <source>=<tag> once per source');out.plugins[source]=tag;}
   else if(a==='--backup-root')out.backupRoots.push(path.resolve(v));
   else if(a==='--search-root')out.searchRoots.push(path.resolve(v));
   else if(a==='--add-plugin-source'){if(out.addPluginSources.includes(v))throw new UsageError('--add-plugin-source names each source once');out.addPluginSources.push(v);}
   else if(a==='--to'){if(out.tag)throw new UsageError('the target tag is given twice');out.tag=v;}
   else out.values[a.slice(2)]=v;
  }else if(FLAG.includes(a))out.flags.add(a.slice(2));
  else if(a.startsWith('--'))throw new UsageError(`unknown option ${a}`);
  else if(!out.command)out.command=a;
  else if(!out.tag)out.tag=a;
  else throw new UsageError(`unexpected argument ${a}`);
 }
 if(out.flags.has('help'))return out;
 if(!COMMANDS.includes(out.command))throw new UsageError(out.command?`unknown command ${out.command}`:'which command?');
 if((out.tag||Object.keys(out.plugins).length)&&!['preflight','apply','download'].includes(out.command))throw new UsageError(`${out.command} takes no tag`);
 if(out.values['site-config']&&!['preflight','apply'].includes(out.command))throw new UsageError('--site-config is only for preflight or apply');
 if(out.addPluginSources.length&&!['preflight','apply'].includes(out.command))throw new UsageError('--add-plugin-source is only for preflight or apply');
 if(out.values.package&&(out.tag||Object.keys(out.plugins).length||out.flags.has('latest-published')))throw new UsageError('Conflicting Git/package targets');
 if(['verify-package','install'].includes(out.command)&&!out.values.package)throw new UsageError(`${out.command} requires --package FILE`);
 if(out.command==='download'&&!out.tag)throw new UsageError('download requires a published tag');
 if(out.values['manifest-sha256']&&!/^[0-9a-f]{64}$/.test(out.values['manifest-sha256']))throw new UsageError('--manifest-sha256 requires 64 lowercase hex digits');
 const diagnostic=out.command==='backup-diagnose',readOnly=out.flags.has('read-only');
 if(readOnly&&out.command!=='preflight')throw new UsageError('--read-only is only for preflight');
 if(!diagnostic&&(out.searchRoots.length||out.flags.has('candidate-cover-files')||out.values.examples||out.values['search-max-entries']))throw new UsageError('alias discovery flags are only for backup-diagnose');
 if((diagnostic||readOnly)&&(out.tag||Object.keys(out.plugins).length||out.addPluginSources.length||out.values.package||
   out.values['site-config']||out.flags.has('latest-published')||out.flags.has('migrate-from-git')))throw new UsageError('read-only backup checks take no release or plugin target');
 const scanLimit=(name,fallback,max)=>{
  const raw=out.values[name];
  if(raw===undefined)return fallback;
  if(!/^\d{1,7}$/.test(raw)||Number(raw)<1||Number(raw)>max)throw new UsageError(`--${name} takes a whole number from 1 to ${max}`);
  return Number(raw);
 };
 out.scan={searchRoots:out.searchRoots,searchMaxEntries:scanLimit('search-max-entries',2000000,2000000),
  examples:scanLimit('examples',0,100),candidates:out.flags.has('candidate-cover-files')};
 const whole=(name,min)=>{const v=out.values[name];if(v===undefined)return undefined;if(!/^\d{1,4}$/.test(v)||Number(v)<min)throw new UsageError(`--${name} takes a whole number`);return Number(v);};
 out.options={root:out.values.root,service:out.values.service,health:out.values.health,healthSeconds:whole('health-seconds',2),backups:out.values.backups,keep:whole('keep',1),recovery:['rollback','apply','status','install'].includes(out.command),staging:out.values.staging,trust:out.values.trust,backupRoots:out.backupRoots,backupPolicy:out.values['backup-policy']};
 return out;
}
/** The instance the flags and the environment name. A rollback without --service uses what the update it undoes was run with. */
export function instanceFor(args,env=process.env){
 const e={...env};
 for(const [flag,name] of [['home','HOME_HUB_HOME'],['data','DATA_DIR'],['state','STATE_DIR'],['private','HOME_HUB_PRIVATE_DIR']])if(args.values[flag])e[name]=path.resolve(args.values[flag]);
 let inst=resolveInstance({env:e,options:args.options});

 return inst;
}

function backupDiagnostics(inst,args,out){
 let trustFile;
 try{trustFile=selectTrustFile({home:inst.home,explicit:args.values.trust});}
 catch(e){throw new UpdateError(`Trust selection refused: ${e.message}`);}
 const scanned=scanBackup({...inst,trustFile:trustFile??inst.trustFile},args.scan);
 const report=Object.fromEntries(['rootStats','totals','links','filesystems','blockers','warnings','counts','runtimeSockets','candidatePolicy'].map(k=>[k,scanned[k]]));
 if(scanned.policy)report.policy={file:scanned.policy.file,budget:scanned.policy.budget,exactFiles:scanned.policy.coverFiles.length};
 if(args.flags.has('read-only')){
  let journal;
  try{journal=readJournal(inst);}
  catch(error){
   report.blockers.push({code:'JOURNAL_UNREADABLE',message:error.message});
   report.counts.JOURNAL_UNREADABLE=1;
  }
  report.journal=journal?.step??null;
  if(journal&&!['done','rolled-back','aborted'].includes(journal.step)){
   report.blockers.push({code:'UNFINISHED_UPDATE',message:`Recover transaction ${journal.id} before applying another update`});
   report.counts.UNFINISHED_UPDATE=1;
  }
 }
 // Keep the machine-readable report available by default so suggested coverage can be reviewed and copied.
 out(JSON.stringify(report,null,1));
 return report.blockers.length?1:0;
}

export async function main(argv,{env=process.env,ctx=null,out=line=>console.log(line)}={}){
 const args=parseArgs(argv);
 if(args.flags.has('help')){out(USAGE);return 0;}
 // A lost session or Ctrl-C must not leave the hub stopped: the signal is noted and the next step puts things back.
 let signal=null;
 const note=name=>{signal=name;};
 const diagnostic=args.command==='backup-diagnose'||args.flags.has('read-only');
 const signals=diagnostic?[]:['SIGINT','SIGTERM','SIGHUP'];
 if(!ctx)for(const name of signals)process.on(name,note);
 const world=ctx??realContext({log:out,checkpoint:()=>{if(signal)throw Object.assign(new Error(`interrupted (${signal})`),{interrupted:true});}});
 try{
  const inst=instanceFor(args,env);
  if(diagnostic)return backupDiagnostics(inst,args,out);
  const request={core:args.tag,plugins:args.plugins,addPluginSources:args.addPluginSources,siteConfig:args.values['site-config'],fetch:!args.flags.has('no-fetch'),skipTests:args.flags.has('skip-tests'),allowUnsigned:args.flags.has('allow-unsigned'),package:args.values.package,manifestDigest:args.values['manifest-sha256'],migrateFromGit:args.flags.has('migrate-from-git'),trust:args.values.trust,force:args.flags.has('force')};
  const repository=existsSync(path.join(inst.root,'package.json'))?JSON.parse(readFileSync(path.join(inst.root,'package.json'),'utf8')).homeHub?.updates?.repo:null;
  const trustFile=['verify-package','download','trust-import'].includes(args.command)?selectTrustFile({home:inst.home,explicit:args.values.trust})??(args.command==='trust-import'?inst.trustFile:null):args.values.trust??inst.trustFile;
  if(args.command==='trust-import'){
   const repo=args.values.repository??repository,role=args.values.role??'package',file=args.values['public-key'];if(!file||!args.values.fingerprint||!['package','git'].includes(role))throw new UsageError('trust-import needs --public-key FILE --fingerprint HASH [--repository OWNER/REPO] [--role package|git] and --trust FILE without an instance');if(!trustFile)throw new UsageError('trust-import requires --trust FILE or --home DIR');
   importTrustKey({inst,trustFile,repository:repo,role,publicKeyFile:file,expectedFingerprint:args.values.fingerprint,lock:acquireLock,out});return 0;
  }
  if(args.command==='verify-package'){
   const site=inst.paths.siteConfig&&existsSync(inst.paths.siteConfig)?JSON.parse(readFileSync(inst.paths.siteConfig,'utf8')):null;
   const settings=updateSettings({site,version:{updates:{repo:repository}},env});
   const result=await verifyPackage(args.values.package,{trustFile,repository:settings.repo,manifestDigest:request.manifestDigest,compatibility:false,forbidden:forbiddenTrustRoots(inst)});rememberTrustSelection(inst.home,trustFile);out(JSON.stringify(result,null,1));return 0;
  }
  if(args.command==='download'||args.flags.has('latest-published')){
   const disabled=updateSettings({env}).envOff||Object.hasOwn(JSON.parse(existsSync(path.join(inst.paths.state,'integrations.json'))?readFileSync(path.join(inst.paths.state,'integrations.json'),'utf8'):'{}')?.disabled??{},UPDATE_INTEGRATION);if(disabled)throw new UpdateError('Update discovery is disabled; no update network requests were made.');
   const site=inst.paths.siteConfig&&existsSync(inst.paths.siteConfig)?JSON.parse(readFileSync(inst.paths.siteConfig,'utf8')):null,settings=updateSettings({site,version:{updates:{repo:repository}},env});
   const token=(await loadGithubToken({env})).token,fetchJson=createFetchJson({token});
   if(args.command==='download'){if(trustFile)loadTrust(trustFile,{forbidden:forbiddenTrustRoots(inst)});const result=await downloadPackage({tag:args.tag,repository:settings.repo,trustFile,manifestDigest:request.manifestDigest,output:path.resolve(args.values.output??process.cwd()),fetchJson});rememberTrustSelection(inst.home,trustFile);out(`Verified download: ${result.file}\nManifest SHA-256: ${result.manifestSha256}`);return 0;}
   const found=await discoverReleases({repository:settings.repo,channel:settings.channel,fetchJson});request.core=found.found.tag;if(!request.core)throw new UpdateError('No published release selected');
  }
  if(args.command==='status'){
   const s=status(inst,world);
   if(args.flags.has('json'))out(JSON.stringify(s,null,1));else for(const line of formatStatus(s))out(line);
   return s.journal?.unfinished?1:0;
  }
  if(args.command==='preflight'){
   out(`Preflight for ${inst.root}:`);
   const plan=await preflight(inst,request,world);
   for(const line of plan.lines)out(`  ${line}`);
   if(plan.package){rmSync(plan.package.staged,{recursive:true,force:true});}
   out(`\nPreflight passed: ${plan.from.label} → ${plan.to.label}. The live installation was not switched; staging and trust selection may update local updater metadata.`);
   if(!inst.service||!inst.health)out('To apply it, also say how the hub is stopped, started and checked: --service and --health (or instance.json).');
   return 0;
  }
  if(args.command==='apply'||args.command==='install'){
   const {journal,plan}=await apply(inst,request,world);
   out(`\nUpdated: ${plan.from.label} → ${plan.to.label} in ${Math.round((Date.parse(journal.finishedAt)-Date.parse(journal.startedAt))/1000)} s. The hub answers at ${inst.health.url}.`);
   out(`  archive  ${journal.backup.file}\n  driver   ${journal.driver}/scripts/update.mjs`);
   out(plan.epochRose?'  The data epoch rose: "rollback --yes" restores that archive, and what is written from now on would be lost.':`  To go back: the same command with "rollback" (the data epoch did not change; ${plan.siteChange?'application data is kept and the original site is restored':'nothing written since is lost'}).`);
   return 0;
  }
  if(args.command==='rollback'){
   const {journal,recovered}=await rollback(inst,world,{yes:args.flags.has('yes'),reason:args.values.reason??null});
   out(`\n${recovered?'The unfinished update was put back':'Rolled back'}: ${journal.from.label} is running (${journal.step}).${journal.restored?` The state from before the update was restored; what was there is in ${journal.failedState}.`:''}`);
   return 0;
  }
  const made=await backup(inst,world);
  out(`\nArchive: ${made.file} (${backupRootSummary(made.entries)}; ${made.files} entries). The hub is running again.`);
  return 0;
 }catch(e){
  if(e instanceof RollbackFailed){console.error(`\nROLLBACK FAILED. ${e.message}`);return 3;}
  if(e instanceof UpdateError){console.error(`\n${e.message}`);return 1;}
  throw e;
 }finally{if(!ctx)for(const name of signals)process.off(name,note);}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{process.exitCode=await main(process.argv.slice(2));}
 catch(e){if(e instanceof UsageError){console.error(`${e.message}\n${USAGE}`);process.exitCode=2;}else{console.error(e.stack||e.message);process.exitCode=1;}}
}
