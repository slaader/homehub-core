// The update command (scripts/update.mjs, server/update-apply.mjs) on throw-away git repositories: a small "core"
// with release tags, a clone that is the installation, and a service that is a stand-in (`svc stop` / `svc start`
// change a flag and write run.json the way a real hub does). git, tar, the staged test run and the staged
// `--check` are real. Nothing here touches a network, a real service or this checkout.
import {sourceLockPath} from '../server/update-lock.mjs';
import {gitPublicKey} from '../server/release-trust.mjs';
import {selectTrustFile} from '../server/release-trust.mjs';
import {contentFingerprint} from '../server/runtime-identity.mjs';
import {packageFixture} from './package-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {existsSync,readFileSync,readdirSync,writeFileSync,statSync,lstatSync,realpathSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createConnection,createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';

// No global git configuration reaches these repositories (a signing key, a hooks path, an identity).
Object.assign(process.env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'Alice',GIT_AUTHOR_EMAIL:'alice@example.com',GIT_COMMITTER_NAME:'Alice',GIT_COMMITTER_EMAIL:'alice@example.com'});
const {resolveInstance,preflight,apply,rollback,recover,backup,status,formatStatus,readJournal,setQuarantine,readQuarantine,coreFacts,pluginFacts,realExec,UpdateError,RollbackFailed}=await import('../server/update-apply.mjs');
const {backupPlan}=await import('../server/update-backup.mjs');
const {parseService,parseHealth,parseBackups,UpdateConfigError}=await import('../server/update-config.mjs');
const {readInstance}=await import('../server/plugins.mjs');
const {satisfies}=await import('../server/semver.mjs');
const {readUpdateState,updateView}=await import('../server/update-check.mjs');
const {parseArgs,main}=await import('../scripts/update.mjs');

// --- a core that is four files ---------------------------------------------------------------------------
const RUNNER=`import {existsSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.env.HOME_HUB_HOME||process.env.STATE_DIR){console.log('the instance leaked into the tests');process.exit(1);}
if(process.argv.filter(a=>a==='--plugins').length>1){console.error('each plugin source requires its own fixture; unrelated sources cannot share it');process.exit(1);}
if(existsSync(path.join(root,'FAIL_TESTS'))){console.log('not ok 1 - a test of this release');console.log('core     tests 1  pass 0  fail 1');process.exit(1);}
console.log(process.argv.includes('--plugins')?'household tests 2  pass 2  fail 0':'core     tests 3  pass 3  fail 0');
`;
const INDEX=`// stands in for the server: only '--check'
import {existsSync,readFileSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(existsSync(path.join(root,'FAIL_CHECK'))){console.error('plugin "p-one" needs site.json → plugins.p-one.socket');process.exit(1);}
const sitePath=process.env.HOME_HUB_SITE_CONFIG;
let siteTag='';
if(sitePath&&sitePath!=='none'&&existsSync(sitePath)){const site=JSON.parse(readFileSync(sitePath,'utf8'));if(existsSync(path.join(root,'STRICT_SITE'))&&(!Array.isArray(site.devices)||'machines' in site)){console.error('target needs devices, refuses machines');process.exit(1);}if(site.siteName)siteTag=' siteName='+site.siteName;}
else if(existsSync(path.join(root,'STRICT_SITE'))){console.error('missing site config');process.exit(1);}
console.info('check ok: Home Hub '+JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version+'; site '+sitePath+siteTag);
`;
const pkg=(version,epoch=1)=>JSON.stringify({name:'home-hub',version,type:'module',engines:{node:'>=22'},homeHub:{dataEpoch:epoch,updates:{repo:'example/core'}}})+'\n';
const tree=(version,epoch=1,extra={})=>({'package.json':pkg(version,epoch),'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX,'.gitignore':'data/\nstate/\nprivate/\nbackups/\n',...extra});
const manifest=(id,version,more={})=>JSON.stringify({id,version,core:'>=1.0.0 <2.0.0',...more})+'\n';

function repository(root){
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const commit=async(message,files,{tag=null,remove=[]}={})=>{
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
  for(const file of remove)await rm(path.join(root,file),{force:true});
  git('add','-A');git('commit','-q','-m',message);if(tag)git('tag','-a','-m',tag,tag);return git('rev-parse','HEAD');
 };
 return {root,git,commit};
}
async function init(root){await mkdir(root,{recursive:true});const r=repository(root);r.git('init','-q','-b','main');return r;}
function clone(from,to){execFileSync('git',['clone','-q',from,to],{stdio:'ignore'});return repository(to);}

/**
 * An installation and its world. layout 'checkout': a clone with data/, state/ and private/ in it (state beside data,
 * as STATE_DIR puts it). layout 'home': <home>/core, <home>/household (a plugin source of its own), config/, data/,
 * private/ and instance.json. upstream has v1.0.0; the test adds what it needs.
 */
function safeTempParent(){
 for(const candidate of [os.tmpdir(),os.homedir(),process.cwd()]){
  if(!candidate)continue;
  try{
   const real=realpathSync.native(candidate);
   let ok=true;
   for(let dir=real;dir!==path.dirname(dir);dir=path.dirname(dir)){
    const st=lstatSync(dir);
    if((st.mode&0o022)||![0,process.getuid?.()??st.uid].includes(st.uid)){ok=false;break;}
   }
   if(ok)return real;
  }catch{}
 }
 return os.tmpdir();
}

async function world(t,{layout='checkout',instance={},temp=safeTempParent()}={}){
 const dir=await realpath(await mkdtemp(path.join(temp,'hub-update-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const upstream=await init(path.join(dir,'upstream'));
 const v100=await upstream.commit('1.0.0',tree('1.0.0'),{tag:'v1.0.0'});
 const home=layout==='home'?path.join(dir,'home'):null,root=home?path.join(home,'core'):path.join(dir,'hub');
 if(home)await mkdir(home,{recursive:true});
 const hub=clone(upstream.root,root);
 let plugins=null,pluginsUpstream=null;
 const env={};
 if(home){
  pluginsUpstream=await init(path.join(dir,'household-upstream'));
  await pluginsUpstream.commit('1.0.0',{'package.json':JSON.stringify({name:'household',version:'1.0.0',homeHub:{core:'>=1.0.0 <2.0.0'}})+'\n','plugins/p-one/index.mjs':'export default {id:"p-one"};\n','plugins/p-one/plugin.json':manifest('p-one','1.0.0'),
   'plugins/p-one/tests/one.test.mjs':'// a test\n'},{tag:'v1.0.0'});
  plugins=clone(pluginsUpstream.root,path.join(home,'household'));
  for(const d of ['config','data/state','private'])await mkdir(path.join(home,d),{recursive:true});
  await writeFile(path.join(home,'config','site.json'),'{"siteName":"Example"}\n');
  await writeFile(path.join(home,'instance.json'),JSON.stringify({schemaVersion:1,sources:{core:'core',plugins:['household']},service:{stop:['svc','stop'],start:['svc','start']},health:{url:'http://127.0.0.1:9/healthz',seconds:2},...instance}));
  env.HOME_HUB_HOME=home;
 }else{
  for(const d of ['data','state','private'])await mkdir(path.join(root,d),{recursive:true});
  env.STATE_DIR=path.join(root,'state');
 }
 const base=home??root,state=home?path.join(home,'data','state'):path.join(root,'state');
 await writeFile(path.join(base,'data','knowledge.json'),'{"entries":[]}\n');
 await writeFile(path.join(base,'private','auth.json'),'{"secret":"kept"}\n',{mode:0o600});
 await writeFile(path.join(state,'hub.db'),'written by 1.0.0\n');
 // The stand-in service. A start "runs" whatever the checkout holds: it writes run.json unless the tree says it crashes.
 let clock=Date.parse('2026-11-12T10:00:00.000Z');
 const svc={running:false,pid:1000,calls:[],refuseStop:false,onStart:null,execs:[]};
 const start=()=>{
  const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;svc.calls.push(`start ${version}`);
  if(svc.siteFile){const site=JSON.parse(readFileSync(svc.siteFile,'utf8')),old=version.startsWith('1.');
   if(old?('devices' in site||!Array.isArray(site.machines)):('machines' in site||!Array.isArray(site.devices))){svc.running=false;return {status:0,stdout:'',stderr:'site schema refused'};}}
  if(existsSync(path.join(root,'CRASH_AT_START'))){svc.running=false;return {status:0,stdout:'',stderr:''};}
  svc.pid++;svc.running=true;
  const configured=home&&env.HOME_HUB_PLUGINS_DIR!=='none'?(readInstance(home).sources.plugins??[]).flatMap(name=>pluginFacts(path.join(home,name,'plugins'))):[];
  if(configured.some(p=>p.core&&!satisfies(version,p.core))){svc.running=false;return {status:0,stdout:'',stderr:'plugin core range refused'};}
  const receipt=existsSync(path.join(root,'.home-hub-package.json'))?JSON.parse(readFileSync(path.join(root,'.home-hub-package.json'),'utf8')):null;
  const loaded=configured.map(p=>({id:p.id,version:p.version}));
  writeFileSync(path.join(state,'run.json'),JSON.stringify({version,commit:(receipt?.fullCommit??hub.git('rev-parse','HEAD')).slice(0,7),...(receipt?{fullCommit:receipt.fullCommit,packageDigest:receipt.manifestSha256,readinessProtocol:1,bootId:'boot-'+svc.pid}:{}),exact:true,dataEpoch:JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).homeHub.dataEpoch,pid:svc.pid,startedAt:new Date(clock).toISOString(),plugins:receipt?loaded.map(p=>({...p,fingerprint:contentFingerprint(path.join(home,'household','plugins',p.id)),sourceFingerprint:contentFingerprint(path.join(home,'household'))})):loaded}));
  svc.onStart?.(version);
  return {status:0,stdout:'',stderr:''};
 };
 const stop=()=>{svc.calls.push('stop');if(svc.ignoreStop)return {status:0,stdout:'',stderr:''};if(svc.refuseStop)return {status:1,stdout:'',stderr:'sudo: a password is required'};svc.running=false;return {status:0,stdout:'',stderr:''};};
 const lines=[];
 const ctx={exec:(command,args,options={})=>{svc.execs.push({command,args,env:options.env});return command==='svc'?(args[0]==='start'?start():stop()):realExec(command,args,options);},
  probe:async()=>{const run=JSON.parse(readFileSync(path.join(state,'run.json'),'utf8'));return run.readinessProtocol===1?{ok:svc.running,bootId:run.bootId}:svc.running;},pidAlive:pid=>svc.running&&pid===svc.pid,sleep:async ms=>{clock+=ms;},now:()=>clock,log:line=>lines.push(line),checkpoint:()=>{},node:process.execPath,user:'alice',stopSeconds:2};
 start();svc.calls.length=0;
 const options=home?{}:{service:'command:{"stop":["svc","stop"],"start":["svc","start"]}',health:'http://127.0.0.1:9/healthz',healthSeconds:2};
 const inst=(more={})=>resolveInstance({env,root,options:{...options,...more}});
 const tick=ms=>{clock+=ms;};
 return {dir,upstream,hub,root,home,plugins,pluginsUpstream,env,state,base,svc,ctx,lines,inst,v100,tick};
}
const refused=(promise,pattern)=>assert.rejects(promise,e=>e instanceof UpdateError&&pattern.test(e.message)||assert.fail(`${e.constructor.name}: ${e.message}`));
const tarList=file=>execFileSync('tar',['-tzf',file],{encoding:'utf8'}).split('\n').filter(Boolean);

test('configuration: a service is a launchd label, a systemd unit or two commands; health is an address; instance.json holds them',async t=>{
 assert.deepEqual({...parseService('launchd:system/com.example.home-hub',{uid:501})},{kind:'launchd',spec:'launchd:system/com.example.home-hub',
  stop:['sudo','-n','/bin/launchctl','bootout','system/com.example.home-hub'],start:['sudo','-n','/bin/launchctl','bootstrap','system','/Library/LaunchDaemons/com.example.home-hub.plist'],startTries:4});
 assert.deepEqual(parseService('launchd:system/com.example.home-hub',{uid:0}).stop,['/bin/launchctl','bootout','system/com.example.home-hub'],'root needs no sudo');
 assert.deepEqual(parseService('launchd:gui/501/com.example.hub',{uid:501,home:'/Users/alice'}).start,['/bin/launchctl','bootstrap','gui/501','/Users/alice/Library/LaunchAgents/com.example.hub.plist']);
 assert.deepEqual(parseService('systemd:home-hub.service',{uid:1000}).stop,['sudo','-n','systemctl','stop','home-hub.service']);
 assert.deepEqual(parseService('systemd-user:home-hub.service').start,['systemctl','--user','start','home-hub.service']);
 assert.deepEqual(parseService('command:{"stop":["a","b"],"start":["c"]}').start,['c']);
 assert.equal(parseService({stop:['a'],start:['b']}).kind,'command');
 for(const [bad,why] of [['launchd:com.example.x',/launchd:system\/<label>/],['launchd:system/../x',/launchd:system/],['docker:hub',/not a kind/],[{stop:['a']},/service\.start/],[{stop:['a'],start:['b'],restart:['c']},/unknown field/],
  ['command:{',/followed by JSON/],['systemd:a b',/systemd:<unit>/],[{stop:'a b',start:['b']},/service\.stop/]])assert.throws(()=>parseService(bad),e=>e instanceof UpdateConfigError&&why.test(e.message),String(why));
 assert.deepEqual({...parseHealth({url:'http://127.0.0.1:8781/healthz'})},{url:'http://127.0.0.1:8781/healthz',seconds:60});
 for(const bad of [{url:'file:///etc/passwd'},{url:'http://alice:pw@127.0.0.1/'},{url:'http://127.0.0.1/',seconds:1},{url:'http://127.0.0.1/',retries:3},{}])assert.throws(()=>parseHealth(bad),UpdateConfigError);
 assert.equal(parseBackups().keep,5);assert.throws(()=>parseBackups({keep:0}),UpdateConfigError);
 // instance.json: the server checks these fields too, and refuses what is malformed
 const home=await mkdtemp(path.join(os.tmpdir(),'hub-instance-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const put=doc=>writeFile(path.join(home,'instance.json'),JSON.stringify(doc));
 await put({sources:{core:'core',plugins:['household']},service:'launchd:system/com.example.home-hub',health:{url:'http://127.0.0.1:8781/healthz'},backups:{keep:3}});
 const read=readInstance(home);
 assert.deepEqual({core:read.sources.core,plugins:[...read.sources.plugins],service:read.service,health:{...read.health},backups:{...read.backups}},
  {core:'core',plugins:['household'],service:'launchd:system/com.example.home-hub',health:{url:'http://127.0.0.1:8781/healthz',seconds:60},backups:{keep:3}});
 for(const [bad,why] of [[{service:'docker:x'},/instance: .*not a kind/],[{health:{url:'nope'}},/health\.url/],[{backups:{keep:'all'}},/backups\.keep/],[{sources:{core:'../x'}},/sources\.core/],[{sources:{core:'a',plugins:['a']}},/also named/]]){
  await put(bad);assert.throws(()=>readInstance(home),why);}
});

test('the instance: a checkout with its data inside, or an instance directory; flags win over instance.json',async t=>{
 const w=await world(t),inst=w.inst();
 assert.deepEqual({root:inst.root,home:inst.home,data:inst.paths.data,state:inst.paths.state,private:inst.paths.private,backups:inst.backups,journal:inst.files.journal,sources:inst.sources.map(s=>s.id)},
  {root:w.root,home:null,data:path.join(w.root,'data'),state:path.join(w.root,'state'),private:path.join(w.root,'private'),backups:path.join(w.root,'backups'),journal:path.join(w.root,'backups','update-journal.json'),sources:['core']});
 assert.deepEqual(backupPlan(inst).roots.filter(e=>e.existed).map(e=>e.name),['data','state','private'],'state beside data is archived on its own');
 assert.deepEqual(backupPlan(resolveInstance({env:{},root:w.root})).roots.filter(e=>e.existed).map(e=>e.name),['data','private'],'state inside data comes with it');
 assert.throws(()=>backupPlan(w.inst({backups:path.join(w.root,'private','backups')})),/inside .*private, which is archived/);
 assert.throws(()=>resolveInstance({env:{},root:path.join(w.dir,'nowhere')}),/not a Home Hub checkout/);
 const h=await world(t,{layout:'home'}),hi=h.inst();
 assert.deepEqual({root:hi.root,home:hi.home,state:hi.paths.state,backups:hi.backups,journal:hi.files.journal,staging:hi.staging,sources:hi.sources.map(s=>[s.id,s.kind,s.plugins]),service:hi.service.stop,health:hi.health.seconds},
  {root:path.join(h.home,'core'),home:h.home,state:path.join(h.home,'data','state'),backups:path.join(h.home,'backups'),journal:path.join(h.home,'update-journal.json'),staging:path.join(h.home,'staging'),
   sources:[['core','core',[]],['household','plugins',['plugins']]],service:['svc','stop'],health:2});
 assert.deepEqual(backupPlan(hi).roots.filter(e=>e.existed).map(e=>e.name),['data','private','config','instance.json']);
 const flagged=h.inst({service:'systemd:hub.service',health:'http://127.0.0.1:1/x',healthSeconds:9,keep:2,backups:path.join(h.dir,'elsewhere')});
 assert.deepEqual({kind:flagged.service.kind,health:{...flagged.health},keep:flagged.keep,backups:flagged.backups},{kind:'systemd',health:{url:'http://127.0.0.1:1/x',seconds:9},keep:2,backups:path.join(h.dir,'elsewhere')});
 assert.equal(resolveInstance({env:{...h.env,HOME_HUB_PLUGINS_DIR:'none'},root:h.root}).sources.length,1);
});

test('apply, the whole way: a checkout on a branch ends detached at the tag, with an archive and a journal',async t=>{
 const w=await world(t),inst=w.inst();
 const v110=await w.upstream.commit('1.1.0',tree('1.1.0',1,{'NEW':'new in 1.1.0\n'}),{tag:'v1.1.0'});
 setQuarantine(inst.files.updates,'1.1.0',{at:'2026-11-11T08:00:00.000Z',reason:'health check'});
 await refused(apply(inst,{core:null},w.ctx),/1\.1\.0 was tried here on 2026-11-11 and rolled back \(health check\)\. --force/);
 assert.deepEqual(w.svc.calls,[],'a refusal stops nothing');
 assert.ok(!existsSync(inst.files.lock),'and leaves no lock');
 const {journal,plan}=await apply(inst,{core:null,force:true},w.ctx);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0'],'one stop, one start');
 assert.equal(w.hub.git('rev-parse','HEAD'),v110);
 assert.throws(()=>w.hub.git('symbolic-ref','-q','HEAD'),'detached at the tag');
 assert.deepEqual({from:plan.from.label,to:plan.to.label,epochRose:plan.epochRose,changes:plan.changes.map(c=>[c.id,c.tag,c.branch])},
  {from:`1.0.0 @ ${w.v100.slice(0,7)}`,to:`1.1.0 @ ${v110.slice(0,7)}`,epochRose:false,changes:[['core','v1.1.0','main']]});
 assert.ok(plan.lines.some(l=>/tests \(core\): core tests 3 pass 3 fail 0/.test(l)),plan.lines.join('\n'));
 assert.ok(plan.lines.some(l=>/^check ok: Home Hub 1\.1\.0/.test(l)));
 assert.ok(plan.lines.some(l=>/data epoch unchanged \(1\)/.test(l)));
 // the staged check ran from the scratch worktree with this instance's own state, and the stage is gone
 const check=w.svc.execs.find(e=>e.args.includes('--check'));
 assert.ok(check.args[0].includes('home-hub-update-')&&!check.args[0].startsWith(w.root),'the check runs from the stage, never from the live checkout');
 assert.deepEqual({plugins:check.env.HOME_HUB_PLUGINS_DIR,state:check.env.STATE_DIR,auth:check.env.AUTH_FILE,site:check.env.HOME_HUB_SITE_CONFIG},
  {plugins:'none',state:path.join(w.root,'state'),auth:path.join(w.root,'private','auth.json'),site:path.join(w.root,'local','site.json')});
 assert.ok(!existsSync(path.dirname(path.dirname(path.dirname(check.args[0])))),'the stage is removed');
 assert.equal(w.hub.git('worktree','list').split('\n').length,1,'no worktree is left behind');
 // the archive: made with the hub stopped, 0600, holding all three directories
 assert.equal(path.dirname(journal.backup.file),path.join(w.root,'backups'));assert.match(path.basename(journal.backup.file),/^pre-1\.0\.0-to-1\.1\.0-20261112-\d{6}\.tgz$/);
 assert.equal(statSync(journal.backup.file).mode&0o777,0o600);
 const names=tarList(journal.backup.file);
 for(const [label,file] of [['data','knowledge.json'],['state','hub.db'],['state','run.json'],['private','auth.json']]){const root=journal.backup.entries.find(e=>e.name===label);assert.ok(names.includes(root.id+'/'+file),file);}
 // the journal, the history and the note
 const saved=readJournal(inst);
 assert.deepEqual({step:saved.step,started:saved.started,by:saved.by,service:saved.settings.service,state:saved.settings.state},{step:'done',started:true,by:'alice',service:{stop:['svc','stop'],start:['svc','start']},state:path.join(w.root,'state')});
 const past=readFileSync(inst.files.history,'utf8').trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual(past.map(h=>[h.from,h.to,h.result,h.by]),[[plan.from.label,plan.to.label,'done','alice']]);
 assert.deepEqual(readQuarantine(inst.files.updates),{},'a release that now runs is no longer noted as rolled back');
 assert.ok(!existsSync(inst.files.lock));
 assert.equal(JSON.parse(readFileSync(inst.files.run,'utf8')).version,'1.1.0');
 // status says all of it
 const s=status(inst,w.ctx),text=formatStatus(s).join('\n');
 assert.deepEqual({version:s.installed.version,tag:s.installed.tag,exact:s.installed.exact,running:s.running.version,alive:s.running.alive,step:s.journal.step,newer:s.newerTag},{version:'1.1.0',tag:'v1.1.0',exact:true,running:'1.1.0',alive:true,step:'done',newer:null});
 assert.match(text,/Home Hub 1\.1\.0 @ \w{7} \(v1\.1\.0, detached\), data epoch 1/);assert.match(text,/Last update: 1\.0\.0 @ \w{7} → 1\.1\.0 @ \w{7}, begun .*: done/);
 // going back by hand: the code switches back onto the branch it was on, the state stays, the release is noted
 w.svc.calls.length=0;await writeFile(path.join(w.state,'hub.db'),'written by 1.1.0\n');
 const back=await rollback(inst,w.ctx,{reason:'the map page is broken'});
 assert.deepEqual({step:back.journal.step,calls:w.svc.calls,head:w.hub.git('rev-parse','HEAD'),branch:w.hub.git('symbolic-ref','--short','HEAD')},{step:'rolled-back',calls:['stop','start 1.0.0'],head:w.v100,branch:'main'});
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'written by 1.1.0\n','same data epoch: nothing written since is lost');
 assert.deepEqual(Object.entries(readQuarantine(inst.files.updates)).map(([v,q])=>[v,q.reason]),[['git-'+v110,'the map page is broken'],['1.1.0','the map page is broken']]);
 await refused(rollback(inst,w.ctx),/already ended as "rolled-back"/);
 // what the hub then tells: the update card reads the same file
 const view=updateView({record:{repo:'alice/home-hub',channel:'stable',checkedAt:'2026-11-12T09:00:00.000Z',version:'1.1.0',tag:'v1.1.0',url:null,publishedAt:null,notes:''},quarantined:readUpdateState(inst.files.updates).state.quarantined,
  version:{version:'1.0.0',label:'1.0.0',exact:true,commit:'abc',dataEpoch:1},settings:{repo:'alice/home-hub',channel:'stable',intervalHours:12,envOff:false},now:Date.parse('2026-11-12T10:00:00.000Z')});
 assert.deepEqual({available:view.updateAvailable,version:view.quarantined?.version,reason:view.quarantined?.reason},{available:true,version:'1.1.0',reason:'the map page is broken'});
});

test('preflight refuses before anything is touched, and says why',async t=>{
 const w=await world(t),inst=w.inst();
 await refused(preflight(inst,{core:null},w.ctx),/Nothing to do: 1\.0\.0 \(v1\.0\.0\) is the newest release tag/);
 await refused(preflight(inst,{core:'v9.9.9'},w.ctx),/There is no tag v9\.9\.9/);
 await refused(preflight(inst,{core:'main'},w.ctx),/"main" is not a release tag/);
 await refused(preflight(inst,{core:'v1.0.0'},w.ctx),/already on v1\.0\.0/);
 await refused(preflight(inst,{core:null,plugins:{'*':'v1.0.0'}},w.ctx),/no plugin source outside the core checkout/);
 await w.upstream.commit('mislabeled',tree('1.0.5'),{tag:'v1.0.6'});
 await w.upstream.commit('tests fail',tree('1.1.0',1,{FAIL_TESTS:''}),{tag:'v1.1.0'});
 await w.upstream.commit('check fails',tree('1.2.0',1,{FAIL_CHECK:''}),{remove:['FAIL_TESTS'],tag:'v1.2.0'});
 await w.upstream.commit('older epoch',tree('1.3.0',1,{'data-note':'x'}),{remove:['FAIL_CHECK'],tag:'v1.3.0'});
 await w.upstream.commit('needs a newer node',{'package.json':JSON.stringify({name:'home-hub',version:'1.4.0',type:'module',engines:{node:'>=99'},homeHub:{dataEpoch:1}})},{tag:'v1.4.0'});
 await refused(preflight(inst,{core:'v1.0.6'},w.ctx),/v1\.0\.6 is not what it says: its package\.json reads 1\.0\.5/);
 await refused(preflight(inst,{core:'v1.1.0'},w.ctx),/npm test of the target failed \(exit 1\)\. The instance was not touched\.[\s\S]*not ok 1 - a test of this release/);
 await refused(preflight(inst,{core:'v1.2.0'},w.ctx),/start-up check \(node server\/index\.mjs --check\) failed[\s\S]*plugins\.p-one\.socket/);
 await refused(preflight(inst,{core:'v1.4.0'},w.ctx),/Home Hub 1\.4\.0 needs Node >=99/);
 assert.equal(w.hub.git('worktree','list').split('\n').length,1,'a failed preflight removes its worktree');
 const skipped=await preflight(inst,{core:'v1.1.0',skipTests:true},w.ctx);
 assert.ok(skipped.lines.includes('tests: SKIPPED (--skip-tests)'));
 // offline: the fetch is the failure, and --no-fetch uses what is here
 w.hub.git('remote','set-url','origin',path.join(w.dir,'gone'));
 await refused(preflight(inst,{core:'v1.3.0'},w.ctx),/git fetch --tags origin failed[\s\S]*--no-fetch/);
 assert.equal((await preflight(inst,{core:'v1.3.0',fetch:false},w.ctx)).to.core.version,'1.3.0');
 // a changed tracked file, and an untracked file the target would overwrite
 await writeFile(path.join(w.root,'data-note'),'mine\n');
 await refused(preflight(inst,{core:'v1.3.0',fetch:false},w.ctx),/untracked file\(s\) that v1\.3\.0 also contains[\s\S]*data-note/);
 await rm(path.join(w.root,'data-note'));await writeFile(path.join(w.root,'server','index.mjs'),INDEX+'// edited\n');
 await refused(preflight(inst,{core:'v1.3.0',fetch:false},w.ctx),/uncommitted changes to tracked files[\s\S]*server\/index\.mjs/);
 w.hub.git('checkout','-q','--','server/index.mjs');
 // going down is not an update
 w.hub.git('checkout','-q','--detach','v1.3.0');
 await refused(preflight(inst,{core:'v1.0.0',fetch:false},w.ctx),/1\.0\.0 is lower than what is installed \(1\.3\.0\)\. Going back is "rollback"/);
 w.hub.git('checkout','-q','main');
 // an apply also needs a hub that runs now, where it is said to be
 await refused(apply(w.inst({service:undefined}),{core:'v1.3.0',fetch:false},w.ctx),/How to stop and start the hub is not known[\s\S]*--service/);
 await refused(apply(resolveInstance({env:{},root:w.root,options:{service:{stop:['svc','stop'],start:['svc','start']},health:'http://127.0.0.1:9/healthz'}}),{core:'v1.3.0',fetch:false},w.ctx),/run\.json is missing[\s\S]*pass --state/);
 w.svc.running=false;
 await refused(apply(inst,{core:'v1.3.0',fetch:false},w.ctx),/not running what this checkout holds: the process in run\.json \(pid 1001\) is not running/);
 assert.deepEqual(w.svc.calls,[],'none of this stopped or started anything');
 assert.ok(!existsSync(inst.files.journal));
});

test('a release that does not come up is rolled back: the old code, the old branch, a quarantine note; state stays when the epoch did not move',async t=>{
 const w=await world(t),inst=w.inst();
 await w.upstream.commit('1.1.0',tree('1.1.0',1,{CRASH_AT_START:''}),{tag:'v1.1.0'});
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/failed at "starting": health check failed: no answer from http:\/\/127\.0\.0\.1:9\/healthz \(waited 2 s\)\nIt was rolled back; 1\.0\.0 @ \w{7} is running again\. 1\.1\.0 is noted as tried and rolled back[\s\S]*journal  .*update-journal\.json\n  archive  .*pre-1\.0\.0-to-1\.1\.0/);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0','stop','start 1.0.0']);
 assert.deepEqual({head:w.hub.git('rev-parse','HEAD'),branch:w.hub.git('symbolic-ref','--short','HEAD'),running:w.svc.running},{head:w.v100,branch:'main',running:true});
 const j=readJournal(inst);
 assert.deepEqual({step:j.step,failed:j.failure.step,restored:j.restored??false},{step:'rolled-back',failed:'starting',restored:false});
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'written by 1.0.0\n');
 const q=readQuarantine(inst.files.updates)['1.1.0'];
 assert.match(q.reason,/^health check failed: no answer/);assert.ok(q.reason.length<=120);
 assert.deepEqual(readFileSync(inst.files.history,'utf8').trim().split('\n').map(l=>JSON.parse(l).result),['rolled-back']);
 assert.ok(!existsSync(inst.files.lock));
 // the same hub, again: refused without --force; nothing to roll back by hand
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/tried here on 2026-11-12 and rolled back/);
 await refused(rollback(inst,w.ctx),/already ended as "rolled-back"/);
 // a hub that answers but is the wrong one (run.json still the old process) does not pass either
 await w.upstream.commit('1.2.0',tree('1.2.0'),{remove:['CRASH_AT_START'],tag:'v1.2.0'});
 w.svc.onStart=version=>{if(version==='1.2.0')writeFileSync(path.join(w.state,'run.json'),JSON.stringify({version:'1.0.0',pid:w.svc.pid,startedAt:new Date(w.ctx.now()).toISOString(),plugins:[]}));};
 await refused(apply(inst,{core:'v1.2.0'},w.ctx),/health check failed: the hub that wrote run\.json is 1\.0\.0, not 1\.2\.0/);
 assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
});

function socketFixture(t,file){
 const server=createServer(connection=>connection.end('listening'));
 const close=()=>new Promise(resolve=>server.close(resolve));
 t.after(close);
 return {bind:()=>server.listen(file),close,async verify(address=file){
  const connection=createConnection(address);
  connection.setTimeout(3000,()=>connection.destroy(new Error('socket connection timed out')));
  let body='';
  for await(const chunk of connection)body+=chunk;
  assert.equal(body,'listening');
 }};
}

test('rollback rechecks configuration socket conflicts before stop, after stop, and before writing',async t=>{
 for(const epoch of [1,2])for(const hadSite of [false,true])await t.test(`epoch ${epoch}, ${hadSite?'replace':'unlink'} configuration`,async t=>{
  const w=await world(t,{temp:'/tmp'}),site=path.join(w.state,'site.json');
  w.env.HOME_HUB_SITE_CONFIG=site;
  const original='{"siteName":"Original"}';
  if(hadSite)writeFileSync(site,original);
  const inst=w.inst(),candidate=path.join(w.dir,'site-candidate.json');
  writeFileSync(candidate,'{"siteName":"Example"}');
  const v110=await w.upstream.commit('1.1.0',tree('1.1.0',epoch),{tag:'v1.1.0'});
  await apply(inst,{core:'v1.1.0',siteConfig:candidate},w.ctx);
  assert.equal(readJournal(inst).site.baseHash===null,!hadSite);
  rmSync(site);
  const before=socketFixture(t,site);
  before.bind();
  w.svc.calls.length=0;
  await refused(rollback(inst,w.ctx,{yes:true}),/Rollback assessment refused before stopping.*UNIX socket/);
  await before.verify();
  assert.deepEqual(w.svc.calls,[]);
  assert.equal(w.svc.running,true);
  assert.equal(w.hub.git('rev-parse','HEAD'),v110);
  await before.close();

  const after=socketFixture(t,path.join(w.dir,'endpoint'));
  const exec=w.ctx.exec;
  w.ctx.exec=(cmd,args,options)=>{
   const result=exec(cmd,args,options);
   if(cmd==='svc'&&args[0]==='stop'){
    after.bind();symlinkSync(path.join(w.dir,'endpoint'),site);
   }
   return result;
  };
  await assert.rejects(rollback(inst,w.ctx,{yes:true}),e=>e instanceof RollbackFailed&&/UNIX socket/.test(e.message));
  assert.deepEqual(w.svc.calls,['stop']);
  assert.equal(w.hub.git('rev-parse','HEAD'),v110);
  assert.ok(!readJournal(inst).operations.some(o=>o.kind==='source-restore'));
  await after.verify(site);
  rmSync(site);await after.close();

  const late=socketFixture(t,site);
  const bindLate=()=>{rmSync(site,{force:true});late.bind();};
  w.ctx.exec=(cmd,args,options)=>{
   const result=exec(cmd,args,options);
   if(epoch===1&&cmd==='git'&&args.includes('checkout'))bindLate();
   return result;
  };
  if(epoch===2)w.ctx.checkpoint=name=>{if(name==='restore-cleaned')bindLate();};
  await assert.rejects(rollback(inst,w.ctx,{yes:true}),e=>e instanceof RollbackFailed&&/UNIX socket/.test(e.message));
  await late.verify();
  assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
  assert.equal(w.svc.running,false);
  await late.close();
  w.ctx.exec=exec;w.ctx.checkpoint=()=>{};
  await rollback(inst,w.ctx,{yes:true});
  assert.equal(w.svc.calls.at(-1),'start 1.0.0');
  assert.equal(w.svc.running,true);
  if(hadSite)assert.equal(readFileSync(site,'utf8'),original);
  else assert.ok(!existsSync(site));
 });
});

test('rollback refuses to replace an archived file when the stop command binds a socket there',async t=>{
 const w=await world(t,{temp:'/tmp'}),inst=w.inst();
 const file=path.join(w.state,'hub.db'),socket=socketFixture(t,file);
 const v110=await w.upstream.commit('1.1.0',tree('1.1.0',2),{tag:'v1.1.0'});
 w.svc.onStart=version=>{if(version==='1.1.0')writeFileSync(file,'migrated');};
 await apply(inst,{core:'v1.1.0'},w.ctx);
 const exec=w.ctx.exec;
 w.ctx.exec=(cmd,args,options)=>{
  const result=exec(cmd,args,options);
  if(cmd==='svc'&&args[0]==='stop'){
   rmSync(file);socket.bind();
  }
  return result;
 };
 w.svc.calls.length=0;
 await assert.rejects(rollback(inst,w.ctx,{yes:true}),e=>e instanceof RollbackFailed&&/UNIX socket.*hub\.db/.test(e.message));
 await socket.verify();
 assert.deepEqual(w.svc.calls,['stop']);
 assert.equal(w.hub.git('rev-parse','HEAD'),v110);
 assert.ok(!readJournal(inst).operations.some(o=>o.kind==='source-restore'));
 await socket.close();w.ctx.exec=exec;
 await rollback(inst,w.ctx,{yes:true});
 assert.equal(readFileSync(file,'utf8'),'written by 1.0.0\n');
 assert.equal(w.svc.calls.at(-1),'start 1.0.0');
 assert.equal(w.svc.running,true);
});

test('the data epoch: when it rises, going back restores the archive, and what was there is moved aside',async t=>{
 const w=await world(t),inst=w.inst();
 const v110=await w.upstream.commit('1.1.0',tree('1.1.0',2),{tag:'v1.1.0'});
 await w.upstream.commit('1.2.0',tree('1.2.0',3,{CRASH_AT_START:''}),{tag:'v1.2.0'});
 // the new code migrates the state the moment it starts
 w.svc.onStart=version=>{if(version!=='1.0.0')writeFileSync(path.join(w.state,'hub.db'),`migrated by ${version}\n`);};
 const {plan,journal}=await apply(inst,{core:'v1.1.0'},w.ctx);
 assert.equal(plan.epochRose,true);assert.ok(plan.lines.some(l=>/^DATA EPOCH RISES \(core 1 → 2\)/.test(l)));
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'migrated by 1.1.0\n');
 await writeFile(path.join(w.root,'data','knowledge.json'),'{"entries":["added after the update"]}\n');
 await refused(rollback(inst,w.ctx),/The data epoch rose[\s\S]*everything written since then is lost[\s\S]*--yes/);
 const integrity=readFileSync(journal.backup.integrity),beforeCalls=[...w.svc.calls];
 writeFileSync(journal.backup.integrity,Buffer.concat([integrity,Buffer.from(' ')]));
 await refused(rollback(inst,w.ctx,{yes:true}),/Rollback assessment refused before stopping the service: backup integrity sidecar mismatch/);
 assert.deepEqual(w.svc.calls,beforeCalls);
 assert.equal(readJournal(inst).step,'done');
 assert.equal(w.hub.git('rev-parse','HEAD'),v110);
 writeFileSync(journal.backup.integrity,integrity);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0'],'asking is not doing');
 const back=await rollback(inst,w.ctx,{yes:true});
 assert.equal(back.journal.restored,true);
 assert.deepEqual({db:readFileSync(path.join(w.state,'hub.db'),'utf8'),knowledge:readFileSync(path.join(w.root,'data','knowledge.json'),'utf8'),auth:readFileSync(path.join(w.root,'private','auth.json'),'utf8'),mode:statSync(path.join(w.root,'private','auth.json')).mode&0o777},
  {db:'written by 1.0.0\n',knowledge:'{"entries":[]}\n',auth:'{"secret":"kept"}\n',mode:0o600});
 const aside=back.journal.failedState;
 assert.match(path.basename(aside),/^failed-20261112-\d{6}$/);
 assert.equal(readFileSync(path.join(JSON.parse(readFileSync(path.join(aside,'roots.json'),'utf8')).find(r=>r.live===w.state).aside,'hub.db'),'utf8'),'migrated by 1.1.0\n','the newer state is kept, not deleted');
 assert.equal(readFileSync(path.join(JSON.parse(readFileSync(path.join(aside,'roots.json'),'utf8')).find(r=>r.live===path.join(w.root,'data')).aside,'knowledge.json'),'utf8'),'{"entries":["added after the update"]}\n');
 assert.equal(JSON.parse(readFileSync(inst.files.run,'utf8')).version,'1.0.0');
 assert.ok(readFileSync(inst.files.history,'utf8').includes('"result":"rolled-back"'),'the history says so, in the restored state');
 assert.ok(existsSync(journal.backup.file),'the archive is still there');
 // an automatic rollback restores too, without asking: the new version ran for seconds
 w.tick(60000);
 await refused(apply(inst,{core:'v1.2.0',force:true},w.ctx),/failed at "starting"/);
 assert.equal(readJournal(inst).restored,true);
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'written by 1.0.0\n');
 assert.equal(readdirSync(inst.backups).filter(n=>n.startsWith('failed-')).length,2);
 // a lower epoch is never a target
 w.hub.git('checkout','-q','--detach','v1.1.0');
 assert.equal(coreFacts(w.root).dataEpoch,2);
});

test('cut short: the next run puts the previous version back from the journal',async t=>{
 const w=await world(t),inst=w.inst();
 const v110=await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});
 const {journal}=await apply(inst,{core:'v1.1.0'},w.ctx);
 // as if the command died right after it started the new version
 const cut=step=>writeFileSync(inst.files.journal,JSON.stringify({...journal,step,finishedAt:undefined}));
 cut('starting');w.svc.calls.length=0;
 assert.match(formatStatus(status(inst,w.ctx)).join('\n'),/UNFINISHED: run "rollback"/);
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/unfinished transaction was recovered/);cut('switched');w.svc.calls.length=0;
 const done=await recover(inst,w.ctx);
 assert.deepEqual({step:done.step,calls:w.svc.calls,head:w.hub.git('rev-parse','HEAD'),why:done.failure.message},{step:'rolled-back',calls:['stop','start 1.0.0'],head:w.v100,why:'the update was interrupted'});
 assert.deepEqual(readQuarantine(inst.files.updates),{},'an interrupted update says nothing about the release');
 assert.equal(await recover(inst,w.ctx),null,'nothing left to recover');
 // died while archiving: nothing was switched, the hub is simply started again
 cut('backup');w.svc.running=false;w.svc.calls.length=0;
 const early=await recover(inst,w.ctx);
 assert.deepEqual({step:early.step,calls:w.svc.calls,running:w.svc.running},{step:'aborted',calls:['stop','start 1.0.0'],running:true});
 // the command line does the same before it applies anything, and says so
 cut('switched');w.hub.git('checkout','-q','--detach','v1.1.0');
 const out=[];
 const code=await main(['apply','v1.1.0','--root',w.root,'--state',w.state,'--service','command:{"stop":["svc","stop"],"start":["svc","start"]}','--health','http://127.0.0.1:9/healthz','--health-seconds','2'],{env:{},ctx:w.ctx,out:l=>out.push(l)});
 assert.equal(code,1);assert.equal(readJournal(inst).step,'rolled-back');
 assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
 // Ctrl-C between the switch and the start: back, and no quarantine
 let armed=false;const interrupted={...w.ctx,log:line=>{w.ctx.log(line);if(/^Starting /.test(line))armed=true;},checkpoint:()=>{if(armed)throw Object.assign(new Error('interrupted (SIGINT)'),{interrupted:true});}};
 await refused(apply(inst,{core:'v1.1.0'},interrupted),/failed at "starting": interrupted \(SIGINT\)\nIt was rolled back/);
 assert.deepEqual({head:w.hub.git('rev-parse','HEAD'),running:w.svc.running,q:readQuarantine(inst.files.updates)},{head:w.v100,running:true,q:{}});
 assert.notEqual(v110,w.v100);
});

test('a stop that is refused changes nothing; a rollback that fails leaves the service stopped and says where to look',async t=>{
 const w=await world(t),inst=w.inst();
 await w.upstream.commit('1.1.0',tree('1.1.0',1,{CRASH_AT_START:''}),{tag:'v1.1.0'});
 w.svc.refuseStop=true;const pid=w.svc.pid;
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/failed at "stopping": the service did not stop: sudo: a password is required\nNothing had been switched; 1\.0\.0 @ \w{7} is running again\.\n/);
 assert.deepEqual({calls:w.svc.calls,pid:w.svc.pid,running:w.svc.running,step:readJournal(inst).step,q:readQuarantine(inst.files.updates)},{calls:['stop'],pid,running:true,step:'aborted',q:{}},'the same process still runs');
 // a stop command that says yes and stops nothing (a wrong label, a wrong pid file): the same answer
 w.svc.refuseStop=false;w.svc.ignoreStop=true;w.svc.calls.length=0;
 await refused(apply(inst,{core:'v1.1.0'},w.ctx),/failed at "stopping": the service was told to stop, but pid \d+ is still running after 2 s\nNothing had been switched/);
 assert.deepEqual({calls:w.svc.calls,pid:w.svc.pid,running:w.svc.running,step:readJournal(inst).step},{calls:['stop'],pid,running:true,step:'aborted'});
 assert.ok(w.lines.some(l=>/the hub still runs as it did; nothing was changed/.test(l)));
 w.svc.ignoreStop=false;w.svc.calls.length=0;
 // the new version crashes, and then the old one does not come up either
 const start=w.ctx.exec;let broken=true;
 const ctx={...w.ctx,exec:(command,args,options)=>{if(command==='svc'&&args[0]==='start'&&broken){w.svc.calls.push('start (fails)');return {status:1,stdout:'',stderr:'Bootstrap failed: 5: Input/output error'};}return start(command,args,options);}};
 await assert.rejects(apply(inst,{core:'v1.1.0'},ctx),e=>e instanceof RollbackFailed&&/could not be brought back: the service did not start: Bootstrap failed: 5[\s\S]*left stopped[\s\S]*journal  [\s\S]*archive  .*\.tgz[\s\S]*history  /.test(e.message)||assert.fail(e.message));
 assert.deepEqual({step:readJournal(inst).step,running:w.svc.running,last:w.svc.calls.at(-1),head:w.hub.git('rev-parse','HEAD')},{step:'rollback-failed',running:false,last:'stop',head:w.v100},'the code is back; the service is stopped, not looping');
 assert.match(formatStatus(status(inst,ctx)).join('\n'),/rollback-failed[\s\S]*UNFINISHED/);
 // fixed: "rollback" finishes the job
 broken=false;
 const done=await rollback(inst,ctx);
 assert.deepEqual({recovered:done.recovered,step:done.journal.step,running:w.svc.running},{recovered:true,step:'rolled-back',running:true});
 assert.ok(readQuarantine(inst.files.updates)['1.1.0'],'the release that crashed stays noted');assert.ok(Object.keys(readQuarantine(inst.files.updates)).some(k=>k.startsWith('git-')),'the exact failed target stays noted');
});

test('an instance directory: core and a plugin source update in one transaction, and a plugin can hold core back',async t=>{
 const w=await world(t,{layout:'home'}),inst=w.inst();
 const core110=await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});
 await w.upstream.commit('2.0.0',tree('2.0.0'),{tag:'v2.0.0'});
 const p110=await w.pluginsUpstream.commit('1.1.0',{'package.json':JSON.stringify({name:'household',version:'1.1.0',homeHub:{core:'>=1.1.0 <2.0.0'}})+'\n','plugins/p-one/plugin.json':manifest('p-one','1.1.0',{core:'>=1.1.0 <2.0.0'}),
  'plugins/p-two/index.mjs':'export default {id:"p-two"};\n','plugins/p-two/plugin.json':manifest('p-two','0.3.0',{requires:{'p-one':'^1.1.0'}})},{tag:'v1.1.0'});
 // the plugins alone would need a newer core than the one installed; core alone to the current format.0 is blocked by the plugin
 await refused(preflight(inst,{core:null,plugins:{'*':'v1.1.0'}},w.ctx),/Plugin p-one 1\.1\.0 supports Home Hub >=1\.1\.0 <2\.0\.0; the target is 1\.0\.0/);
 await refused(preflight(inst,{core:'v2.0.0'},w.ctx),/Plugin p-one 1\.0\.0 supports Home Hub >=1\.0\.0 <2\.0\.0; the target is 2\.0\.0\. Update the plugins too/);
 await refused(preflight(inst,{core:'v1.1.0',plugins:{nope:'v1.1.0'}},w.ctx),/no plugin source "nope" \(there is household\)/);
 await refused(preflight(inst,{core:'v1.1.0',plugins:{household:'v7'}},w.ctx),/There is no tag v7 in .*household/);
 const {plan,journal}=await apply(inst,{core:'v1.1.0',plugins:{'*':'v1.1.0'}},w.ctx);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0'],'one stop and one start for both');
 assert.deepEqual({core:w.hub.git('rev-parse','HEAD'),plugins:w.plugins.git('rev-parse','HEAD'),changes:plan.changes.map(c=>c.id),to:plan.to.label,expect:plan.to.expect.plugins},
  {core:core110,plugins:p110,changes:['core','household'],to:`1.1.0 (p-one 1.1.0, p-two 0.3.0) @ ${core110.slice(0,7)}`,expect:[{id:'p-one',version:'1.1.0'},{id:'p-two',version:'0.3.0'}]});
 assert.ok(plan.lines.some(l=>/tests \(plugins\): household tests 2 pass 2 fail 0/.test(l)),plan.lines.join('\n'));
 assert.ok(plan.lines.some(l=>/plugins: p-one 1\.1\.0, p-two 0\.3\.0: every core range includes 1\.1\.0/.test(l)));
 // staged like the instance: the plugins beside the target core, linked to it, with the real site file
 const check=w.svc.execs.find(e=>e.args.includes('--check')),stage=path.dirname(path.dirname(path.dirname(check.args[0])));
 assert.equal(path.dirname(stage),path.join(w.home,'staging'));
 assert.deepEqual({plugins:check.env.HOME_HUB_PLUGINS_DIR,home:check.env.HOME_HUB_HOME,site:check.env.HOME_HUB_SITE_CONFIG},{plugins:path.join(stage,'household','plugins'),home:w.home,site:path.join(w.home,'config','site.json')});
 const tests=w.svc.execs.filter(e=>e.args.some(a=>a.endsWith('run-tests.mjs')));
 assert.deepEqual(tests.at(-1).args.slice(1),['--plugins',path.join(stage,'household')]);assert.ok(!('HOME_HUB_HOME' in tests[0].env),'tests never see the instance');
 assert.ok(!existsSync(stage));
 assert.deepEqual([...new Set(tarList(journal.backup.file).map(n=>n.split('/')[0]))].sort(),journal.backup.entries.filter(e=>e.existed).map(e=>e.id).sort());
 assert.equal(path.dirname(journal.backup.file),path.join(w.home,'backups'));
 // only the plugins, later: the core range check still holds, and a failure names the plugin that did not load
 await w.pluginsUpstream.commit('1.2.0',{'package.json':JSON.stringify({name:'household',version:'1.2.0',homeHub:{core:'>=1.1.0 <2.0.0'}})+'\n','plugins/p-one/plugin.json':manifest('p-one','1.2.0')},{tag:'v1.2.0'});
 w.svc.calls.length=0;w.svc.onStart=()=>{const run=JSON.parse(readFileSync(inst.files.run,'utf8'));if(run.plugins.some(p=>p.version==='1.2.0'))writeFileSync(inst.files.run,JSON.stringify({...run,plugins:run.plugins.filter(p=>p.id!=='p-two')}));};
 await refused(apply(inst,{core:null,plugins:{household:'v1.2.0'}},w.ctx),/health check failed: plugin\(s\) not loaded: p-two[\s\S]*It was rolled back/);
 assert.deepEqual({core:w.hub.git('rev-parse','HEAD'),plugins:w.plugins.git('rev-parse','HEAD'),calls:w.svc.calls,q:readQuarantine(inst.files.updates)},{core:core110,plugins:p110,calls:['stop','start 1.1.0','stop','start 1.1.0'],q:{}},'core did not change, so no core release is quarantined');
 w.svc.onStart=null;
 const again=await apply(inst,{core:null,plugins:{household:'v1.2.0'}},w.ctx);
 assert.deepEqual(again.plan.changes.map(c=>[c.id,c.tag]),[['household','v1.2.0']]);
 assert.match(path.basename(again.journal.backup.file),/^pre-1\.1\.0-to-1\.1\.0-/);
 // only the archive
 w.svc.calls.length=0;
 const made=await backup(inst,w.ctx);
 assert.deepEqual({calls:w.svc.calls,name:/^manual-1\.1\.0-\d{8}-\d{6}\.tgz$/.test(path.basename(made.file)),entries:made.entries.map(e=>e.name)},{calls:['stop','start 1.1.0'],name:true,entries:['data','private','config','instance.json']});
});

test('preflight fixture tests inherit only OS settings; startup checks retain the live plugin environment',async t=>{
 const w=await world(t,{layout:'home'});
 const kept={PATH:process.env.PATH,HOME:w.dir,TMPDIR:w.dir,LANG:'C',LC_ALL:'C',TZ:'UTC',SystemRoot:w.dir,ComSpec:path.join(w.dir,'cmd.exe'),PATHEXT:'.EXE;.CMD'};
 const live={EXAMPLE_PLUGIN_SOCKET:path.join(w.home,'private','plugin.sock'),EXAMPLE_PLUGIN_KEY:'fixture-credential',
  NODE_OPTIONS:'--no-warnings',NODE_PATH:path.join(w.home,'modules'),HTTPS_PROXY:'http://127.0.0.1:9',SSH_AUTH_SOCK:path.join(w.dir,'ssh.sock')};
 Object.assign(w.env,kept,live);
 const checkKept=`for(const [key,value] of Object.entries(${JSON.stringify(kept)}))assert.equal(process.env[key],value,key);\n`;
 const fixture=`import assert from 'node:assert/strict';\n${checkKept}for(const key of ${JSON.stringify(Object.keys(live))})assert.equal(process.env[key],undefined,key+' leaked into fixture tests');\n${RUNNER}`;
 const startup=`import assert from 'node:assert/strict';\n${checkKept}for(const [key,value] of Object.entries(${JSON.stringify(live)}))assert.equal(process.env[key],value,key+' missing from startup check');\n${INDEX}`;
 await w.upstream.commit('1.1.0',tree('1.1.0',1,{'scripts/run-tests.mjs':fixture,'server/index.mjs':startup}),{tag:'v1.1.0'});
 await preflight(w.inst(),{core:'v1.1.0'},w.ctx);
 const tests=w.svc.execs.filter(e=>e.args.some(a=>a.endsWith('run-tests.mjs')));
 assert.equal(tests.length,2,'core and plugin fixture subprocesses both ran');
 for(const call of tests)assert.deepEqual(call.env,kept);
 const check=w.svc.execs.find(e=>e.args.includes('--check'));
 assert.equal(check.env.HOME_HUB_HOME,w.home);assert.equal(check.env.HOME_HUB_SITE_CONFIG,path.join(w.home,'config','site.json'));
 for(const [key,value] of Object.entries(live))assert.equal(check.env[key],value);
 assert.deepEqual(w.svc.calls,[],'preflight never stops or starts the service');
});

test('the command line: arguments, status, and a rollback that remembers how the update was run',async t=>{
 assert.deepEqual((({command,tag,plugins,options})=>({command,tag,plugins,keep:options.keep}))(parseArgs(['apply','v1.2.0','--plugins','household=v1.1.0','--keep','3'])),{command:'apply',tag:'v1.2.0',plugins:{household:'v1.1.0'},keep:3});
 assert.deepEqual(parseArgs(['preflight','--to','v1.2.0','--plugins','v2']).plugins,{'*':'v2'});
 for(const [bad,why] of [[[],/which command/],[['upgrade'],/unknown command/],[['apply','--colour','red'],/unknown option/],[['apply','--to'],/needs a value/],[['status','v1.0.0'],/takes no tag/],[['apply','v1','v2'],/unexpected argument/],[['apply','--keep','many'],/whole number/]])
  assert.throws(()=>parseArgs(bad),why);
 const w=await world(t);await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});
 const flags=['--root',w.root,'--state',w.state,'--service','command:{"stop":["svc","stop"],"start":["svc","start"]}','--health','http://127.0.0.1:9/healthz','--health-seconds','2'];
 const run=async(...argv)=>{const out=[];const code=await main(argv,{env:{},ctx:w.ctx,out:l=>out.push(l)});return {code,text:out.join('\n')};};
 const first=await run('status','--root',w.root,'--state',w.state);
 assert.equal(first.code,0);assert.match(first.text,/Home Hub 1\.0\.0 @ \w{7} \(branch main\)[\s\S]*Running:  1\.0\.0, pid 1001 \(alive\)[\s\S]*Service:  not configured[\s\S]*Last update: none recorded/);
 const pre=await run('preflight',...flags);
 assert.equal(pre.code,0);assert.match(pre.text,/Preflight passed: 1\.0\.0 @ \w{7} → 1\.1\.0 @ \w{7}\. The live installation was not switched; staging and trust selection may update local updater metadata\./);assert.deepEqual(w.svc.calls,[]);
 const done=await run('apply',...flags);
 assert.equal(done.code,0);assert.match(done.text,/Updated: 1\.0\.0 @ \w{7} → 1\.1\.0 @ \w{7} in \d+ s[\s\S]*To go back: the same command with "rollback"/);
 assert.match((await run('status','--root',w.root,'--state',w.state,'--json')).text,/"step": "done"/);
 // the service and the health address come from the journal of the update being undone
 const back=await run('rollback','--root',w.root,'--state',w.state);
 assert.equal(back.code,0);assert.match(back.text,/Rolled back: 1\.0\.0 @ \w{7} is running \(rolled-back\)\./);
 assert.deepEqual(w.svc.calls,['stop','start 1.1.0','stop','start 1.0.0']);
});

// The updater being tested lives outside these tiny legacy installations. No old checkout needs to load new
// modules: the supported driver is the new update.mjs with --root pointing at the deployment checkout.
async function siteWorld(t,{home=false}={}){
 const w=await world(t,{layout:home?'home':'checkout'});
 if(home){w.env.HOME_HUB_PLUGINS_DIR='none';const file=path.join(w.state,'run.json');writeFileSync(file,JSON.stringify({...JSON.parse(readFileSync(file,'utf8')),plugins:[]}));}
 const file=home?path.join(w.home,'config','site.json'):path.join(w.dir,'external-config','site.json');
 await mkdir(path.dirname(file),{recursive:true});
 const original='{ "siteName": "Example", "machines": [{"id":"alpha"}], "runtimes": [] }\n';
 await writeFile(file,original);chmodSync(file,0o640);
 w.env.HOME_HUB_SITE_CONFIG=file;w.svc.siteFile=file;
 const target=await w.upstream.commit('2.0.0',tree('2.0.0',2,{STRICT_SITE:''}),{tag:'v2.0.0'});
 return {...w,file,original,target};
}

test('legacy to the current format preflight checks a converted copy and never changes the live site, including on refusal',async t=>{
 const w=await siteWorld(t),inst=w.inst();
 const before=statSync(w.file).ino;
 const plan=await preflight(inst,{core:'v2.0.0'},w.ctx);
 assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(statSync(w.file).ino,before);
 assert.deepEqual(w.svc.calls,[]);
 assert.deepEqual(JSON.parse(plan.siteChange.text).devices,[{id:'alpha'}]);
 const check=w.svc.execs.find(e=>e.args.includes('--check'));
 assert.notEqual(check.env.HOME_HUB_SITE_CONFIG,w.file);
 assert.equal(check.env.SOFTWARE_WATCH_FILE,path.join(path.dirname(w.file),'software-watch.json'));
 assert.equal(existsSync(check.env.HOME_HUB_SITE_CONFIG),false,'the staging copy is removed');
 await w.upstream.commit('bad target',tree('2.0.1',2,{FAIL_CHECK:''}),{tag:'v2.0.1'});
 await refused(apply(inst,{core:'v2.0.1'},w.ctx),/start-up check.*failed/s);
 assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(statSync(w.file).ino,before);
 assert.deepEqual(w.svc.calls,[]);assert.equal(readJournal(inst),null);
 writeFileSync(w.file,plan.siteChange.text);
 await refused(preflight(inst,{core:'v2.0.0'},w.ctx),/live legacy site already has current keys/);
 assert.deepEqual(w.svc.calls,[],'a configuration pre-converted outside the transaction is not accepted as a safe rollback baseline');
});

test('legacy to the current format saves original site bytes and restores them on later rollback, with and without an instance',async t=>{
 for(const home of [false,true])await t.test(home?'instance configuration':'external site, no instance',async t=>{
  const w=await siteWorld(t,{home}),inst=w.inst();
  const {journal}=await apply(inst,{core:'v2.0.0'},w.ctx);
  assert.equal(journal.site.status,'applied');assert.equal(readFileSync(journal.site.backup,'utf8'),w.original);
  assert.equal(statSync(journal.site.backup).mode&0o777,0o600);
  assert.equal(statSync(w.file).mode&0o777,0o640);
  assert.deepEqual(JSON.parse(readFileSync(w.file,'utf8')).devices,[{id:'alpha'}]);
  assert.deepEqual(w.svc.calls,['stop','start 2.0.0']);
  if(home){const saved=execFileSync('tar',['-xOf',journal.backup.file,journal.backup.entries.find(e=>e.name==='config').id+'/site.json'],{encoding:'utf8'});assert.equal(saved,w.original,'the archive predates conversion');await rm(journal.site.backup);}
  else assert.ok(!tarList(journal.backup.file).some(n=>n.endsWith('/site.json')),'the site sidecar covers paths outside the ordinary archive');
  const {journal:back}=await rollback(inst,w.ctx,{yes:true});
  assert.equal(back.site.status,'restored');assert.equal(w.svc.running,true);
  assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(statSync(w.file).mode&0o777,0o640);
  assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
 });
});

test('a failed current start automatically restores the original site before restarting legacy',async t=>{
 const w=await siteWorld(t),inst=w.inst();
 await w.upstream.commit('2.0.1 crashes',tree('2.0.1',2,{STRICT_SITE:'',CRASH_AT_START:''}),{tag:'v2.0.1'});
 await refused(apply(inst,{core:'v2.0.1'},w.ctx),/health check failed[\s\S]*It was rolled back/);
 assert.deepEqual(w.svc.calls,['stop','start 2.0.1','stop','start 1.0.0']);
 assert.equal(w.svc.running,true);assert.equal(readFileSync(w.file,'utf8'),w.original);
 assert.equal(readJournal(inst).site.status,'restored');
});

test('interruption after the site replacement, before the target starts, restores configuration without restoring data',async t=>{
 const w=await siteWorld(t),inst=w.inst();
 const ctx={...w.ctx,checkpoint:()=>{if(readJournal(inst)?.step==='switched')throw Object.assign(new Error('interrupted (SIGINT)'),{interrupted:true});}};
 await refused(apply(inst,{core:'v2.0.0'},ctx),/failed at "switched": interrupted[\s\S]*It was rolled back/);
 const journal=readJournal(inst);
 assert.equal(journal.started,false);assert.equal(journal.restored,undefined);assert.equal(journal.site.status,'restored');
 assert.deepEqual(w.svc.calls,['stop','stop','start 1.0.0']);assert.equal(w.svc.running,true);
 assert.equal(readFileSync(w.file,'utf8'),w.original);
 // Also model an abrupt process death after rename but before 'applied' was journalled. Recovery must treat
 // 'applying' as potentially changed, even though no new service has run.
 writeFileSync(w.file,JSON.stringify({devices:[{id:'alpha'}]}));
 w.hub.git('checkout','--quiet','--detach','v2.0.0');w.svc.running=false;
 writeFileSync(inst.files.journal,JSON.stringify({...journal,step:'switching',undoFrom:undefined,finishedAt:undefined,site:{...journal.site,status:'applying'}}));
 const recovered=await recover(inst,w.ctx);
 assert.equal(recovered.site.status,'restored');assert.equal(w.svc.running,true);
 assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
});

test('the separate driver CLI accepts a staged household site and rolls it back without needing the candidate file',async t=>{
 const w=await siteWorld(t),candidate=path.join(w.dir,'candidate.json');
 const replacement=JSON.stringify({siteName:'New site',devices:[{id:'alpha'}],plugins:{'device-table':{enabled:true}}})+'\n';
 await writeFile(candidate,replacement);
 const flags=['--root',w.root,'--state',w.state,'--service','command:{"stop":["svc","stop"],"start":["svc","start"]}','--health','http://127.0.0.1:9/healthz','--health-seconds','2'];
 const out=[];
 const done=await main(['apply','v2.0.0','--site-config',candidate,...flags],{env:w.env,ctx:w.ctx,out:l=>out.push(l)});
 assert.equal(done,0);assert.equal(readFileSync(w.file,'utf8'),replacement);
 await rm(candidate);
 const back=await main(['rollback','--yes','--root',w.root,'--state',w.state],{env:w.env,ctx:w.ctx,out:l=>out.push(l)});
 assert.equal(back,0);assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(w.svc.running,true);
 assert.throws(()=>parseArgs(['rollback','--site-config','x']),/only for preflight or apply/);
});

test('a site edited during preflight is refused before stopping the service',async t=>{
 const w=await siteWorld(t),inst=w.inst();let changed=false;
 const latest=w.original.replace('Example','Edited while checking');
 const ctx={...w.ctx,exec:(command,args,options)=>{const r=w.ctx.exec(command,args,options);if(args.includes('--check')&&!changed){changed=true;writeFileSync(w.file,latest);}return r;}};
 await refused(apply(inst,{core:'v2.0.0'},ctx),/site configuration changed since preflight/);
 assert.equal(readFileSync(w.file,'utf8'),latest);assert.deepEqual(w.svc.calls,[]);assert.equal(readJournal(inst),null);
});

test('an explicit site replacement rolls back without a data-epoch rise, keeping later application data',async t=>{
 const w=await world(t),file=path.join(w.dir,'site.json'),candidate=path.join(w.dir,'next-site.json');
 await writeFile(file,'{"siteName":"Before"}\n');await writeFile(candidate,'{"siteName":"After"}\n');
 w.env.HOME_HUB_SITE_CONFIG=file;
 await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});
 const inst=w.inst(),{journal}=await apply(inst,{core:'v1.1.0',siteConfig:candidate},w.ctx);
 assert.equal(journal.epochRose,false);assert.equal(readFileSync(file,'utf8'),'{"siteName":"After"}\n');
 await writeFile(path.join(w.state,'hub.db'),'later data\n');
 await rollback(inst,w.ctx);
 assert.equal(readFileSync(file,'utf8'),'{"siteName":"Before"}\n');
 assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'later data\n');assert.equal(w.svc.running,true);
});

async function sourceWorld(t){
 const w=await world(t,{layout:'home'}),file=path.join(w.home,'instance.json'),original=readFileSync(file,'utf8');
 await writeFile(path.join(w.home,'config','site.json'),'{"machines":[{"id":"alpha"}]}\n');
 w.svc.siteFile=path.join(w.home,'config','site.json');
 await w.upstream.commit('2.0.0',tree('2.0.0',2,{STRICT_SITE:''}),{tag:'v2.0.0'});
 await w.pluginsUpstream.commit('2.0.0',{'package.json':JSON.stringify({name:'household',version:'2.0.0'})+'\n','plugins/p-one/plugin.json':manifest('p-one','2.0.0',{core:'>=2.0.0 <3.0.0'})},{tag:'v2.0.0'});
 const publicUpstream=await init(path.join(w.dir,'public-upstream'));
 await publicUpstream.commit('1.0.0',{'package.json':JSON.stringify({name:'public-plugins',version:'1.0.0'})+'\n',
  'plugins/p-public/index.mjs':'export default {id:"p-public"};\n','plugins/p-public/plugin.json':manifest('p-public','1.0.0',{core:'>=2.0.0 <3.0.0'}),'plugins/p-public/tests/public.test.mjs':'// fixture\n'},{tag:'v1.0.0'});
 const added=clone(publicUpstream.root,path.join(w.home,'public-plugins'));
 return {...w,file,original,added,request:{core:'v2.0.0',plugins:{household:'v2.0.0','public-plugins':'v1.0.0'},addPluginSources:['public-plugins']}};
}

test('an inactive plugin source joins only at the update switch; preflight and rollback preserve the original manifest',async t=>{
 const w=await sourceWorld(t),inst=w.inst();
 const plan=await preflight(inst,w.request,w.ctx);
 assert.equal(readFileSync(w.file,'utf8'),w.original);assert.deepEqual(w.svc.calls,[]);
 assert.deepEqual(plan.to.expect.plugins.map(p=>p.id),['p-one','p-public']);
 const tested=w.svc.execs.filter(e=>e.args.includes('--plugins'));
 assert.equal(tested.length,2,'each source gets a test run using its own fixture');
 assert.deepEqual(tested.map(e=>path.basename(e.args[e.args.indexOf('--plugins')+1])),['household','public-plugins']);
 for(const call of tested){assert.equal(call.args.filter(a=>a==='--plugins').length,1);assert.equal(call.args.includes('--site'),false,'the real site is never supplied to plugin tests');}
 const check=w.svc.execs.find(e=>e.args.includes('--check'));
 assert.deepEqual(check.env.HOME_HUB_PLUGINS_DIR.split(path.delimiter).map(p=>path.basename(path.dirname(p))),['household','public-plugins'],'startup still checks all target sources together');
 const {journal}=await apply(inst,w.request,w.ctx);
 assert.equal(journal.instance.status,'applied');assert.equal(readFileSync(journal.instance.backup,'utf8'),w.original);
 assert.equal(statSync(journal.instance.backup).mode&0o777,0o600);
 assert.deepEqual(readInstance(w.home).sources.plugins,['household','public-plugins']);
 assert.deepEqual(JSON.parse(readFileSync(inst.files.run,'utf8')).plugins.map(p=>p.id),['p-one','p-public']);
 // Resolve anew as a separate CLI invocation does: it sees the new manifest, but recovery uses the old manifest
 // held by the journal. The new source remains cloned on disk, inactive after rollback.
 const {journal:back}=await rollback(w.inst(),w.ctx,{yes:true});
 assert.equal(back.instance.status,'restored');assert.equal(readFileSync(w.file,'utf8'),w.original);
 assert.deepEqual(readInstance(w.home).sources.plugins,['household']);assert.equal(w.svc.running,true);
 assert.deepEqual(w.svc.calls,['stop','start 2.0.0','stop','start 1.0.0']);assert.ok(existsSync(w.added.root));
});

test('a failed start and an interrupted manifest replacement both recover without loading the new plugin on legacy',async t=>{
 const w=await sourceWorld(t),inst=w.inst();
 await w.upstream.commit('2.0.1 crash',tree('2.0.1',2,{STRICT_SITE:'',CRASH_AT_START:''}),{tag:'v2.0.1'});
 await refused(apply(inst,{...w.request,core:'v2.0.1'},w.ctx),/It was rolled back/);
 assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(w.svc.running,true);
 assert.equal(readJournal(inst).instance.status,'restored');
 // A fresh update interrupted before start recovers without an archive restoration, so this proves manifest
 // restoration is independent of data restore (instance.json is not in the ordinary archive).
 const ctx={...w.ctx,checkpoint:()=>{if(readJournal(inst)?.step==='switched')throw Object.assign(new Error('interrupted'),{interrupted:true});}};
 await refused(apply(inst,w.request,ctx),/failed at "switched": interrupted/);
 const journal=readJournal(inst);
 assert.equal(journal.started,false);assert.equal(journal.restored,undefined);assert.equal(journal.instance.status,'restored');
 assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(w.svc.running,true);
 // A hard crash after rename but before marking applied: the durable 'applying' state is sufficient.
 writeFileSync(w.file,JSON.stringify({...JSON.parse(w.original),sources:{core:'core',plugins:['household','public-plugins']}}));
 w.svc.running=false;
 writeFileSync(inst.files.journal,JSON.stringify({...journal,step:'switching',undoFrom:undefined,finishedAt:undefined,instance:{...journal.instance,status:'applying'}}));
 await recover(w.inst(),w.ctx);
 assert.equal(readFileSync(w.file,'utf8'),w.original);assert.equal(w.svc.running,true);
});

test('adding plugin sources refuses ambiguous targets, overrides, and concurrent manifest edits before stopping',async t=>{
 const w=await sourceWorld(t),inst=w.inst();
 await refused(preflight(inst,{...w.request,plugins:{household:'v2.0.0'}},w.ctx),/also needs --plugins public-plugins=<tag>/);
 await refused(preflight(inst,{...w.request,addPluginSources:['household']},w.ctx),/repeat a source/);
 const override=resolveInstance({env:{...w.env,HOME_HUB_PLUGINS_DIR:'none'},root:w.root});
 await refused(preflight(override,w.request,w.ctx),/HOME_HUB_PLUGINS_DIR overrides/);
 let edited=false;
 const changed=JSON.stringify({...JSON.parse(w.original),$comment:'changed by another writer'})+'\n';
 const ctx={...w.ctx,exec:(command,args,options)=>{const result=w.ctx.exec(command,args,options);if(args.includes('--check')&&!edited){edited=true;writeFileSync(w.file,changed);}return result;}};
 await refused(apply(inst,w.request,ctx),/instance configuration changed since preflight/);
 assert.equal(readFileSync(w.file,'utf8'),changed);assert.deepEqual(w.svc.calls,[]);
 assert.deepEqual(parseArgs(['apply','v2.0.0','--add-plugin-source','public-plugins','--plugins','public-plugins=v1.0.0']).addPluginSources,['public-plugins']);
 assert.throws(()=>parseArgs(['rollback','--add-plugin-source','public-plugins']),/only for preflight or apply/);
});


test('signed package migration uses the common transaction and retains the complete Git checkout for rollback',async t=>{
 const w=await world(t,{layout:'home'}),inst=w.inst(),f=await packageFixture(path.join(w.dir,'packages'),{files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX}});
 await refused(apply(inst,{package:f.file,trust:f.trustFile},w.ctx),/migrate-from-git/);assert.deepEqual(w.svc.calls,[]);
 const {journal,plan}=await apply(inst,{package:f.file,trust:f.trustFile,migrateFromGit:true},w.ctx);
 assert.equal(journal.step,'done');assert.equal(plan.package.manifestSha256,f.manifestSha256);assert.ok(existsSync(path.join(journal.package.old,'.git')));assert.ok(!existsSync(path.join(w.root,'.git')));assert.ok(existsSync(path.join(journal.driver,'scripts','update.mjs')));
 assert.equal(JSON.parse(readFileSync(inst.files.run,'utf8')).packageDigest,f.manifestSha256);
 const back=await rollback(w.inst(),w.ctx);assert.equal(back.journal.step,'rolled-back');assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);assert.ok(existsSync(back.journal.package.failed));
});

test('package migration refuses a running process from another commit of the same version',async t=>{
 const w=await world(t,{layout:'home'}),f=await packageFixture(path.join(w.dir,'packages'),{files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX}}),file=path.join(w.state,'run.json'),run=JSON.parse(readFileSync(file,'utf8'));
 run.commit='0000000';writeFileSync(file,JSON.stringify(run));
 await refused(apply(w.inst(),{package:f.file,trust:f.trustFile,migrateFromGit:true},w.ctx),/running hub commit differs/);
 assert.deepEqual(w.svc.calls,[]);assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
});

test('invalid package trust executes no target code, calls no service and never accepts unsigned/force bypasses',async t=>{
 const w=await world(t,{layout:'home'}),f=await packageFixture(path.join(w.dir,'packages'),{files:{'scripts/run-tests.mjs':`throw Error('MUST NOT EXECUTE')`,'server/index.mjs':INDEX}});
 const trust=JSON.parse(readFileSync(f.trustFile,'utf8'));trust.publishers['example/core'].packageKeys[0].status='revoked';writeFileSync(f.trustFile,JSON.stringify(trust));
 await refused(apply(w.inst(),{package:f.file,trust:f.trustFile,migrateFromGit:true,allowUnsigned:true,force:true,skipTests:true},w.ctx),/unauthorized/);assert.deepEqual(w.svc.calls,[]);assert.ok(!w.svc.execs.some(e=>e.args.some(a=>a.includes('.hub-package-')&&a.endsWith('run-tests.mjs'))));assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
});

test('package startup failure restores Git, original instance and data after an epoch rise',async t=>{
 const w=await world(t,{layout:'home'}),f=await packageFixture(path.join(w.dir,'packages'),{epoch:2,files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX,'CRASH_AT_START':''}}),original=readFileSync(path.join(w.home,'instance.json'));
 await refused(apply(w.inst(),{package:f.file,trust:f.trustFile,migrateFromGit:true},w.ctx),/failed at "starting"/);
 assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);assert.ok(readFileSync(path.join(w.home,'instance.json')).equals(original));assert.equal(readFileSync(path.join(w.state,'hub.db'),'utf8'),'written by 1.0.0\n');assert.equal(readJournal(w.inst()).restored,true);
});


test('hardened Git verifies exact signed objects and never falls back after revocation, including with unsigned/force',async t=>{
 const w=await world(t),ssh=path.join(w.dir,'ephemeral-git-key');execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',ssh],{stdio:'pipe'});w.upstream.git('config','gpg.format','ssh');w.upstream.git('config','user.signingkey',ssh);
 const commit=await w.upstream.commit('signed target',tree('1.1.0'));w.upstream.git('tag','-s','-m','fixture release','v1.1.0');const text=readFileSync(ssh+'.pub','utf8').trim(),key=gitPublicKey(text),trustFile=path.join(w.dir,'trust.json'),trust={schemaVersion:1,publishers:{'example/core':{gitSigners:[{id:key.id,fingerprint:key.fingerprint,publicKey:text,role:'git',status:'active'}],packageKeys:[]}}};writeFileSync(trustFile,JSON.stringify(trust),{mode:0o600});
 const plan=await preflight(w.inst(),{core:'v1.1.0',trust:trustFile},w.ctx);assert.equal(plan.changes[0].to,commit);assert.equal(plan.changes[0].verification,'verified');assert.match(plan.changes[0].tagObject,/^[0-9a-f]{40}$/);assert.deepEqual(w.svc.calls,[]);
 trust.publishers['example/core'].gitSigners[0].status='revoked';writeFileSync(trustFile,JSON.stringify(trust));await refused(apply(w.inst(),{core:'v1.1.0',trust:trustFile,allowUnsigned:true,force:true},w.ctx),/no authorized Git signers/);assert.deepEqual(w.svc.calls,[]);
});

test('fresh process recovers package migration after each core rename and durable target-start intent',async t=>{
 for(const boundary of ['package-old-renamed','package-new-renamed','target-start-intent']){const w=await world(t,{layout:'home'}),inst=w.inst(),f=await packageFixture(path.join(w.dir,'packages'),{files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX}});
 const locks=inst.sources.flatMap(s=>[sourceLockPath(s.dir),sourceLockPath(path.join(s.dir,'.git'))]);
 const script=`import {apply,resolveInstance,realContext,realExec} from ${JSON.stringify(new URL('../server/update-apply.mjs',import.meta.url).href)};let running=true;const ctx=realContext({exec:(cmd,args,options)=>{if(cmd==='svc'){running=args[0]==='start';return {status:0,stdout:'',stderr:''};}return realExec(cmd,args,options);},probe:async()=>running,pidAlive:()=>running,log:()=>{},checkpoint:p=>{if(p===${JSON.stringify(boundary)})process.exit(99);}});await apply(resolveInstance({env:${JSON.stringify(w.env)},root:${JSON.stringify(w.root)}}),{package:${JSON.stringify(f.file)},trust:${JSON.stringify(f.trustFile)},migrateFromGit:true},ctx);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});assert.equal(child.status,99,child.stderr);
 // Explicit maintenance only after this known child has exited; production locks are never inspected or touched.
 for(const lock of [inst.files.lock,...locks])await rm(lock,{recursive:true,force:true});w.svc.running=false;
 const restored=await recover(w.inst({recovery:true}),w.ctx);assert.equal(restored.step,'rolled-back');assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);assert.equal(restored.package.status,'restored');assert.ok(w.svc.running);
 }
});


test('manual backup interruption restarts the old process and preserves the preceding rollback transaction',async t=>{
 const w=await world(t),inst=w.inst();await w.upstream.commit('1.1.0',tree('1.1.0'),{tag:'v1.1.0'});const applied=await apply(inst,{core:'v1.1.0'},w.ctx);const ctx={...w.ctx,checkpoint:point=>{if(point==='manual-backup-stopped')throw new Error('simulated backup interruption');}};
 await assert.rejects(backup(inst,ctx),/backup interruption/);assert.equal(w.svc.running,false);assert.equal(readJournal(inst).kind,'backup');await recover(inst,w.ctx);assert.equal(w.svc.running,true);assert.equal(readJournal(inst).id,applied.journal.id);assert.equal(readJournal(inst).step,'done');await rollback(inst,w.ctx);assert.equal(w.hub.git('rev-parse','HEAD'),w.v100);
});

test('package CLI verification and download honor the site publisher and retain required trust',async t=>{
 for(const command of ['verify-package','download']){
  const w=await world(t,{layout:'home'}),f=await packageFixture(path.join(w.dir,'packages'),{repository:'example/fork'});
  await writeFile(path.join(w.home,'config','site.json'),JSON.stringify({updates:{repo:'example/fork'}}));
  const names=[path.basename(f.file),path.basename(f.base)+'.manifest.json',path.basename(f.base)+'.manifest.sig.json'];
  const published={tag_name:'v1.1.0',draft:false,prerelease:false,assets:names.map(name=>({name,browser_download_url:`https://github.com/example/fork/releases/download/v1.1.0/${name}`}))};
  const originalFetch=globalThis.fetch;let requests=0;
  globalThis.fetch=async raw=>{requests++;const url=new URL(raw);assert.equal(url.protocol,'https:');
   if(url.hostname==='api.github.com'){assert.ok(url.pathname.startsWith('/repos/example/fork/'));return Response.json(url.pathname.endsWith('/latest')?published:[published]);}
   assert.equal(url.hostname,'github.com');const name=decodeURIComponent(url.pathname.split('/').at(-1));assert.ok(names.includes(name));return new Response(readFileSync(path.join(path.dirname(f.file),name)));
  };
  try{
   const args=command==='download'?['download','v1.1.0','--output',path.join(w.dir,'downloaded')]:['verify-package','--package',f.file];
   assert.equal(await main([...args,'--trust',f.trustFile],{env:w.env,ctx:w.ctx,out:()=>{}}),0);
   assert.equal(requests,command==='download'?5:0,'offline verification never contacts a forge');
   assert.equal(selectTrustFile({home:w.home}),f.trustFile);
   await rm(f.trustFile);
   await refused(preflight(w.inst(),{core:'v1.1.0',allowUnsigned:true},w.ctx),/Trust policy refused/);
   assert.deepEqual(w.svc.calls,[]);
  }finally{globalThis.fetch=originalFetch;}
 }
});

test('CLI discovery honors normalized environment and stored integration disablement without network requests',async t=>{
 const w=await world(t,{layout:'home'}),originalFetch=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw new Error('unexpected update network request');};
 try{
  for(const command of [['download','v1.1.0'],['preflight','--latest-published']]){
   for(const value of ['off',' OFF ','\toff\n'])assert.equal(await main(command,{env:{...w.env,HOME_HUB_UPDATE_CHECK:value},ctx:w.ctx,out:()=>{}}),1);
   await writeFile(path.join(w.state,'integrations.json'),JSON.stringify({schemaVersion:1,disabled:{'updates.check':null}}));
   assert.equal(await main(command,{env:w.env,ctx:w.ctx,out:()=>{}}),1);
   await rm(path.join(w.state,'integrations.json'));
  }
  assert.equal(requests,0);assert.deepEqual(w.svc.calls,[]);
 }finally{globalThis.fetch=originalFetch;}
});

test('trust-import refuses new and existing trust files inside --backup-root and accepts isolated trust paths',async t=>{
 const w=await world(t,{layout:'home'});
 const {generateKeyPairSync}=await import('node:crypto');
 const {publicKey}=await import('../server/release-trust.mjs');
 const pair=generateKeyPairSync('ed25519'),pem=pair.publicKey.export({type:'spki',format:'pem'}),fp=publicKey(pem).id;
 const keyFile=path.join(w.dir,'publisher.pub.pem');
 await writeFile(keyFile,pem,{mode:0o600});
 const extraBackup=path.join(w.dir,'extra-backup');
 await mkdir(extraBackup,{recursive:true,mode:0o700});
 const insideBackup=path.join(extraBackup,'trust.json');
 const baseArgs=['trust-import','--public-key',keyFile,'--fingerprint',fp,'--backup-root',extraBackup,'--trust',insideBackup];
 await assert.rejects(main(baseArgs,{env:w.env,ctx:w.ctx,out:()=>{}}),/outside replaced\/restored root/);
 assert.equal(existsSync(insideBackup),false);
 // Even when an existing valid trust file already sits inside --backup-root, trust-import must refuse it.
 const otherPair=generateKeyPairSync('ed25519'),otherPem=otherPair.publicKey.export({type:'spki',format:'pem'}),otherFp=publicKey(otherPem).id;
 const existingDoc={schemaVersion:1,publishers:{'example/core':{gitSigners:[],packageKeys:[{id:otherFp,publicKey:otherPem,fingerprint:otherFp,role:'package',status:'active'}]}}};
 await writeFile(insideBackup,JSON.stringify(existingDoc),{mode:0o600});
 await assert.rejects(main(baseArgs,{env:w.env,ctx:w.ctx,out:()=>{}}),/outside replaced\/restored root/);
 assert.deepEqual(JSON.parse(readFileSync(insideBackup,'utf8')),existingDoc);
 // Importing into an isolated trust path outside all forbidden roots succeeds and remembers selection.
 const safeTrust=path.join(w.dir,'operator-trust','trust.json');
 const output=[];
 assert.equal(await main(['trust-import','--public-key',keyFile,'--fingerprint',fp,'--backup-root',extraBackup,'--trust',safeTrust],{env:w.env,ctx:w.ctx,out:l=>output.push(l)}),0);
 assert.ok(output.some(l=>l.includes(fp)));
 assert.equal(selectTrustFile({home:w.home}),safeTrust);
 // Re-importing the same key is refused without modifying the trust policy.
 assert.equal(await main(['trust-import','--public-key',keyFile,'--fingerprint',fp,'--backup-root',extraBackup,'--trust',safeTrust],{env:w.env,ctx:w.ctx,out:()=>{}}),1);
});

test('update journal accepts legacy schema-3 journals with unnormalized absolute paths',async t=>{
 const {validateJournal,readUpdateJournal}=await import('../server/update-journal.mjs');
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'hub-journal-compat-')));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'update-journal.json');
 const legacy={
  schemaVersion:3,id:'op-legacy-1',startedAt:'2026-01-01T00:00:00.000Z',step:'done',epochRose:false,
  from:{label:'v1.0.0',core:{version:'1.0.0'},expect:{version:'1.0.0'}},
  to:{label:'v1.1.0',core:{version:'1.1.0'},expect:{version:'1.1.0'}},
  changes:[{id:'core',dir:'/srv/home-hub/./core',from:'a'.repeat(40),to:'b'.repeat(40)}],
  settings:{root:'/srv/home-hub/./core',state:'/srv/home-hub/data/./state',service:{stop:['svc','stop'],start:['svc','start']},health:{url:'http://127.0.0.1:9/healthz',seconds:2}},
  trustFile:'/srv/policy/./trust.json',
 };
 assert.deepEqual(validateJournal(legacy),legacy);
 await writeFile(file,JSON.stringify(legacy)+'\n',{mode:0o600});
 assert.deepEqual(readUpdateJournal(file),legacy);
});

test('release source adapter symmetry: Git tag and signed package preflights enforce the exact same 7 checks',async t=>{
 for(const kind of ['git','package'])await t.test(`${kind} adapter`,async t=>{
  const w=await world(t,{layout:'home'});
  let ssh=null,gitKey=null;
  if(kind==='git'){
   ssh=path.join(w.dir,'sym-git-key');
   execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',ssh],{stdio:'pipe'});
   w.upstream.git('config','gpg.format','ssh');
   w.upstream.git('config','user.signingkey',ssh);
   const text=readFileSync(ssh+'.pub','utf8').trim();
   gitKey={text,...gitPublicKey(text)};
  }
  let seq=0;
  async function publish({version='1.1.0',epoch=1,extra={},revoked=false}={}){
   seq++;
   const tag='v'+version;
   if(kind==='git'){
    const trustFile=path.join(w.dir,`trust-${seq}.json`);
    const trust={schemaVersion:1,publishers:{'example/core':{gitSigners:[{id:gitKey.id,fingerprint:gitKey.fingerprint,publicKey:gitKey.text,role:'git',status:revoked?'revoked':'active'}],packageKeys:[]}}};
    writeFileSync(trustFile,JSON.stringify(trust),{mode:0o600});
    const prevTags=w.upstream.git('tag','--list',tag);
    if(prevTags){w.upstream.git('tag','-d',tag);if(w.hub.git('tag','--list',tag))w.hub.git('tag','-d',tag);}
    const commit=await w.upstream.commit(`sym-${seq}-${version}`,tree(version,epoch,extra),{remove:['FAIL_TESTS','FAIL_CHECK','STRICT_SITE'].filter(k=>!(k in extra))});
    w.upstream.git('tag','-s','-m',`release ${tag}`,tag);
    return {request:{core:tag,trust:trustFile},quarantineKey:'git-'+commit};
   }
   const f=await packageFixture(path.join(w.dir,`pkg-${seq}`),{version,epoch,files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX,...extra}});
   if(revoked){
    const doc=JSON.parse(readFileSync(f.trustFile,'utf8'));
    doc.publishers['example/core'].packageKeys[0].status='revoked';
    writeFileSync(f.trustFile,JSON.stringify(doc),{mode:0o600});
   }
   return {request:{package:f.file,trust:f.trustFile,migrateFromGit:true},quarantineKey:f.manifestSha256};
  }

  // 1. Trust: revoked key is refused even with allowUnsigned/force and runs zero target code.
  const badTrust=await publish({version:'1.1.0',extra:{'scripts/run-tests.mjs':'throw new Error("MUST NOT RUN")'},revoked:true});
  await refused(preflight(w.inst(),{...badTrust.request,allowUnsigned:true,force:true},w.ctx),kind==='git'?/no authorized Git signers/:(/unauthorized/));
  assert.equal(w.svc.execs.filter(e=>e.args.some(a=>a.endsWith('run-tests.mjs'))).length,0);

  // 2. Running identity (forApply): mismatched commit refuses before touching the service.
  const valid=await publish({version:'1.1.0'});
  const runFile=path.join(w.state,'run.json'),savedRun=readFileSync(runFile,'utf8');
  writeFileSync(runFile,JSON.stringify({...JSON.parse(savedRun),commit:'0000000'}));
  await refused(preflight(w.inst(),valid.request,w.ctx,{forApply:true}),/running hub commit differs/);
  writeFileSync(runFile,savedRun);

  // 3. Downgrade & quarantine: lower version refused; exact target quarantine refused unless --force.
  const lower=await publish({version:'0.9.0'});
  await refused(preflight(w.inst(),lower.request,w.ctx),/0\.9\.0 is lower than what is installed \(1\.0\.0\)/);
  setQuarantine(w.inst().files.updates,valid.quarantineKey,{at:'2026-11-11T08:00:00.000Z',reason:'prior failure'});
  await refused(preflight(w.inst(),valid.request,w.ctx),/1\.1\.0 was tried here on 2026-11-11 and rolled back \(prior failure\)\. --force/);
  const forced=await preflight(w.inst(),{...valid.request,force:true},w.ctx);
  assert.equal(forced.to.core.version,'1.1.0');
  setQuarantine(w.inst().files.updates,valid.quarantineKey,null);

  // 4. Plugin compatibility & requires: incompatible core range and missing dependency are both refused.
  const incompatibleCore=await publish({version:'2.0.0'});
  await refused(preflight(w.inst(),incompatibleCore.request,w.ctx),/Plugin p-one 1\.0\.0 supports Home Hub >=1\.0\.0 <2\.0\.0; the target is 2\.0\.0/);
  const origPluginHead=w.plugins.git('rev-parse','HEAD');
  await w.plugins.commit('missing dependency',{'plugins/p-one/plugin.json':manifest('p-one','1.0.0',{requires:{'missing-plugin':'^1.0.0'}})});
  await refused(preflight(w.inst(),valid.request,w.ctx),/Plugin p-one needs plugin missing-plugin/);
  w.plugins.git('reset','--hard',origPluginHead);

  // 5. Site staging: explicit --site-config is checked in stage while the live site stays untouched.
  const liveSite=path.join(w.home,'config','site.json'),origSite=readFileSync(liveSite,'utf8');
  const candidateSite=path.join(w.dir,'candidate-site.json');
  writeFileSync(candidateSite,'{"siteName":"Staged"}\n');
  w.svc.execs.length=0;
  const stagedPlan=await preflight(w.inst(),{...valid.request,siteConfig:candidateSite},w.ctx);
  assert.equal(readFileSync(liveSite,'utf8'),origSite,'live site file must not be touched during preflight');
  assert.equal(JSON.parse(stagedPlan.siteChange.text).siteName,'Staged');
  const checkCall=w.svc.execs.find(e=>e.args.includes('--check'));
  assert.notEqual(checkCall.env.HOME_HUB_SITE_CONFIG,liveSite);
  assert.equal(checkCall.env.SOFTWARE_WATCH_FILE,w.inst().paths.softwareWatch);
  assert.ok(stagedPlan.lines.some(l=>/^tests \(core\): /.test(l)));
  assert.ok(stagedPlan.lines.some(l=>/^tests \(plugins\): /.test(l)));
  assert.ok(stagedPlan.lines.some(l=>/^check ok: Home Hub 1\.1\.0.*siteName=Staged$/.test(l)),'start-up --check actually reads the staged candidate site file');
  assert.equal(existsSync(checkCall.env.HOME_HUB_SITE_CONFIG),false,'staging site copy is removed after preflight');
  if(kind==='package')assert.equal(existsSync(stagedPlan.package.staged),false,'read-only preflight cleans up staged package dir');

  // 6. Target tests: FAIL_TESTS refuses unless --skip-tests is passed.
  const badTests=await publish({version:'1.1.1',extra:{FAIL_TESTS:''}});
  await refused(preflight(w.inst(),badTests.request,w.ctx),/npm test of the target failed/);
  const skipped=await preflight(w.inst(),{...badTests.request,skipTests:true},w.ctx);
  assert.ok(skipped.lines.includes('tests: SKIPPED (--skip-tests)'));

  // 7. Start-up --check: FAIL_CHECK refuses even when --skip-tests is passed.
  const badCheck=await publish({version:'1.1.2',extra:{FAIL_CHECK:''}});
  await refused(preflight(w.inst(),{...badCheck.request,skipTests:true},w.ctx),/start-up check.*failed/s);
  assert.deepEqual(w.svc.calls,[],'preflight never stops or starts the service');
 });
});

test('adapter review regressions: post-backup stage recheck, trust reload, symlinked external plugin, missing index, plugin quarantine, trust persistence, malformed package.json',async t=>{
 // 1. Staged package modified after backup (before applySwitch) is refused before any rename.
 {
  const w=await world(t,{layout:'home'});
  const f=await packageFixture(path.join(w.dir,'pkg-tamper'),{version:'1.1.0',files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX}});
  const origCheckpoint=w.ctx.checkpoint;
  let tampered=false;
  w.ctx.checkpoint=name=>{
   origCheckpoint(name);
   if(name==='backup-verified'&&!tampered){
    tampered=true;
    const staged=readdirSync(path.dirname(w.root)).find(d=>d.startsWith('.hub-package-'));
    assert.ok(staged,'staged package exists at backup-verified');
    writeFileSync(path.join(path.dirname(w.root),staged,'server','index.mjs'),INDEX+'// tampered\n');
   }
  };
  await refused(apply(w.inst(),{package:f.file,trust:f.trustFile,migrateFromGit:true},w.ctx),/staged package changed/);
  assert.equal(tampered,true);
  assert.equal(coreFacts(w.root).version,'1.0.0','live core was never switched');
  assert.equal(readJournal(w.inst()).step,'aborted');
 }

 // 2. Package preflight reloads trust policy after backup planning before extracting/running target code.
 {
  const w=await world(t,{layout:'home'});
  const f=await packageFixture(path.join(w.dir,'pkg-revoke'),{version:'1.1.0',files:{'scripts/run-tests.mjs':'throw new Error("MUST NOT RUN")','server/index.mjs':INDEX}});
  const {packageReleaseSource}=await import('../server/release-package.mjs');
  const {loadTrust}=await import('../server/release-trust.mjs');
  const inst=w.inst({trust:f.trustFile});
  const cachedTrust=loadTrust(f.trustFile);
  await refused(packageReleaseSource.stageTarget(inst,{package:f.file,trust:f.trustFile,migrateFromGit:true},w.ctx,cachedTrust,{
   live:inst.sources.map(s=>({...s,git:s.id==='core',dirty:[]})),
   trustFile:f.trustFile,
   repository:'example/core',
   checkBackup:()=>{
    const doc=JSON.parse(readFileSync(f.trustFile,'utf8'));
    doc.publishers['example/core'].packageKeys[0].status='revoked';
    writeFileSync(f.trustFile,JSON.stringify(doc),{mode:0o600});
    return backupPlan(inst);
   },
  }),/unauthorized|revoked/i);
 }

 // 3. Package update with an unchanged external plugin holding a relative symlink succeeds without rolling back.
 {
  const w=await world(t,{layout:'home'});
  writeFileSync(path.join(w.plugins.root,'plugins','p-one','target.txt'),'hello\n');
  symlinkSync('./target.txt',path.join(w.plugins.root,'plugins','p-one','link.txt'));
  w.plugins.git('add','-A');w.plugins.git('commit','-q','-m','add relative symlink');
  // Re-sync running hub's run.json with the updated plugin fingerprint before applying.
  w.ctx.exec('svc',['start']);
  const f=await packageFixture(path.join(w.dir,'pkg-symlink'),{version:'1.1.0',files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX}});
  const {journal}=await apply(w.inst(),{package:f.file,trust:f.trustFile,migrateFromGit:true},w.ctx);
  assert.equal(journal.step,'done');
  assert.equal(coreFacts(w.root).version,'1.1.0');
 }

 // 4. Git preflight refuses a release missing server/index.mjs; core quarantine does not block plugin-only updates.
 {
  const w=await world(t,{layout:'home'});
  await w.upstream.commit('1.1.0-no-index',{'package.json':pkg('1.1.0'),'scripts/run-tests.mjs':RUNNER},{tag:'v1.1.0',remove:['server/index.mjs']});
  await refused(preflight(w.inst(),{core:'v1.1.0',skipTests:true},w.ctx),/has no server\/index\.mjs/);

  await w.pluginsUpstream.commit('1.1.0',{'package.json':JSON.stringify({name:'household',version:'1.1.0',homeHub:{core:'>=1.0.0 <2.0.0'}})+'\n','plugins/p-one/plugin.json':manifest('p-one','1.1.0')},{tag:'v1.1.0'});
  setQuarantine(w.inst().files.updates,'1.0.0',{at:'2026-11-11T08:00:00.000Z',reason:'prior core rollback'});
  const pluginOnly=await preflight(w.inst(),{plugins:{household:'v1.1.0'}},w.ctx);
  assert.deepEqual(pluginOnly.changes.map(c=>c.id),['household']);
 }

 // 5. Rejected package verification does not replace the instance's saved trust selection; malformed package.json exits 1 on status --json.
 {
  const w=await world(t,{layout:'home'});
  const good=await packageFixture(path.join(w.dir,'pkg-good'),{version:'1.1.0',files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX}});
  const other=await packageFixture(path.join(w.dir,'pkg-other'),{version:'1.1.0',files:{'scripts/run-tests.mjs':RUNNER,'server/index.mjs':INDEX}});
  await preflight(w.inst(),{package:good.file,trust:good.trustFile,migrateFromGit:true},w.ctx);
  assert.equal(selectTrustFile({home:w.home}),good.trustFile);
  await refused(preflight(w.inst(),{package:good.file,trust:other.trustFile,migrateFromGit:true},w.ctx),/Package verification refused/);
  assert.equal(selectTrustFile({home:w.home}),good.trustFile,'failed verification must keep previous saved trust selection');

  writeFileSync(path.join(w.root,'package.json'),'{not valid json');
  const lines=[];
  const code=await main(['status','--json','--home',w.home],{ctx:w.ctx,out:l=>lines.push(l)});
  assert.equal(code,1,'status --json exits 1 for malformed installed package.json');
 }
});
