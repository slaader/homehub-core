// The push agent's installer (scripts/install-host-agent.mjs --core → scripts/host-agent/core.mjs) and its copy
// (server/agent-closure.mjs, core-only; docs/agent.md §5, §6): the copy holds only leaf modules; the sudoers rules are
// PRIVILEGED, escaped, and the probes call exactly those lines; the rendered plist, unit, sudoers and agent.json; a
// hostile watch list is refused at install; and the install, its health check and its rollback, all through a fake
// world in temp directories: no test runs a service manager, sudo, visudo or useradd. Plugin host agents are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync,rmSync,realpathSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentClosure,coreAgentClosure,importsOf} from '../server/agent-closure.mjs';
import {PRIVILEGED} from '../server/agent-privileged.mjs';
import {parseConfig,specsPathErrors} from '../scripts/agent/config.mjs';
import {planCoreInstall,applyCorePlan,formatCorePlan,renderSudoers,renderCoreService,sudoersEscape,parseCoreArgs,parseRuntimeFlag,systemdVersion,corePaths,readStatus,readInstallRecord,systemWorld,LOAD_CREDENTIAL_SINCE,BOOTOUT_WAIT,loadCredentialWorks,runCoreInstall,LOAD_CREDENTIAL_TEST_MS} from '../scripts/host-agent/core.mjs';
import {planInstall,formatPlan} from '../scripts/install-host-agent.mjs';
import {agentSpecs} from '../scripts/agent-specs.mjs';
import {specsFileText} from '../server/systems-data.mjs';
import {validateSite} from '../server/site-config.mjs';
import {AGENT_MANIFEST} from '../server/host-agent.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=t=>{const d=realpathSync(mkdtempSync(path.join(os.tmpdir(),'hub-agent-inst-')));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
const put=(file,body)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,body);};
const TOKEN='hha_'+'f'.repeat(64);
const KEY_TEXT=JSON.stringify({schema:1,agent:{id:'ag_1',device:'studio',name:'studio',prefix:TOKEN.slice(0,12),createdAt:'2026-11-13T10:00:00Z'},token:TOKEN});
const HOSTILE=['x|cmd|/bin/sh|-c id|\n','x|cmd|/usr/bin/$(id)|--version|\n','x|cmd|/usr/bin/`id`|--version|\n','x|json|/etc/a;id||\n',
 // validateSpecs passes these; the agent's path rules do not (a space in a glob, a binary any account can drop in).
 'x|cmd|/nonexist xprobe*|--version|\n','x|pydist|/opt/a b/*/site-packages|foo|\n','x|cmd|/tmp/*|--version|\n','x|cmd|/private/tmp/x|--version|\n','x|cmd|/Users/Shared/bin/x|--version|\n','x|cmd|/var//tmp/x|--version|\n',
 // A glob whose fixed directory holds a shared-writable one: the probes would expand it into a directory every account can write.
 'x|cmd|/t*/evil|--version|\n','x|cmd|/Users/*/evil|--version|\n','x|cmd|/private/var/t*/evil|--version|\n'];
// systemd's settings that, in a unit with User= (no CAP_SYS_ADMIN), imply NoNewPrivileges=yes in some or all versions,
// which stops the setuid sudo (systemd.exec(5); src/core/exec-invoke.c context_has_no_new_privileges, context_has_seccomp).
const IMPLIES_NO_NEW_PRIVILEGES=['NoNewPrivileges','PrivateDevices','ProtectKernelTunables','ProtectKernelModules','ProtectKernelLogs','ProtectClock','ProtectHostname',
 'LockPersonality','MemoryDenyWriteExecute','RestrictAddressFamilies','RestrictNamespaces','RestrictRealtime','RestrictSUIDSGID','SystemCallFilter','SystemCallArchitectures',
 'SystemCallLog','DynamicUser'];
const clean=()=>({commit:'c'.repeat(40),dirty:[]});

// The closure of scripts/agent/agent.mjs, pinned: a new import is a decision, not an accident.
const CLOSURE=['package.json','scripts/agent/agent.mjs','scripts/agent/config.mjs','scripts/agent/probes.mjs','scripts/agent/runtimes.mjs','scripts/agent/transport.mjs',
 'scripts/security/ssh-probe.sh','scripts/systems/linux-probe.sh','scripts/systems/mac-probe.sh','server/agent-privileged.mjs','server/agent-report.mjs','server/endpoint-http.mjs',
 'server/runtime-adapters.mjs','server/runtime-kinds.mjs','server/secret-patterns.mjs','server/semver.mjs','server/ssh-lines.mjs','server/watch-rules.mjs'];

test('the agent\'s copy: a fixed list of files, every server module a leaf, never the hub',()=>{
 const files=coreAgentClosure(root);
 assert.deepEqual(files.map(f=>f.to),CLOSURE);
 assert.ok(files.every(f=>f.part==='core'&&f.from===path.join(root,f.to)));
 for(const hubModule of ['server/site-config.mjs','server/secret-box.mjs','server/thermo-client.mjs','server/index.mjs','server/plugins.mjs','server/paths.mjs','server/edition.mjs'])
  assert.ok(!files.some(f=>f.to===hubModule),`${hubModule} must not reach the agent`);
 // A leaf imports only node: modules and other leaves of this list.
 for(const f of files.filter(x=>x.to.endsWith('.mjs')))
  for(const spec of importsOf(readFileSync(f.from,'utf8'))){
   if(spec.startsWith('node:'))continue;
   assert.ok(CLOSURE.includes(path.relative(root,path.resolve(path.dirname(f.from),spec)).split(path.sep).join('/')),`${f.to} imports ${spec}`);
  }
 // Core-only refuses a by-name import of core: the agent's files keep their paths.
 const dir=mkdtempSync(path.join(os.tmpdir(),'hub-closure-'));
 try{put(path.join(dir,'package.json'),'{"name":"home-hub","exports":{"./plugin-api":"./api.mjs"}}');put(path.join(dir,'api.mjs'),'');put(path.join(dir,'a.mjs'),`import 'home-hub/plugin-api';`);
  assert.throws(()=>agentClosure(path.join(dir,'a.mjs'),{coreRoot:dir,coreOnly:true}),/core's own agent imports core files by relative path/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the privileged list: every R call in the probes is in PRIVILEGED, and every PRIVILEGED line is called',()=>{
 // R /full/path args…  up to the redirection, the closing parenthesis or the end of the command.
 const calls=file=>[...readFileSync(path.join(root,'scripts','systems',file),'utf8').split('\n').filter(l=>!/^\s*#/.test(l)).join('\n')
  .matchAll(/(?:^|[\s($|&;])R (\/[^\s<>)|;&]+(?: [^\s<>)|;&]+)*)/gm)].map(m=>m[1].trim());
 for(const [platform,file] of [['macos','mac-probe.sh'],['linux','linux-probe.sh']]){
  const probe=new Set(calls(file)),listed=new Set(PRIVILEGED[platform].filter(e=>e.only!=='all-accounts').map(e=>e.argv.join(' ')));
  assert.deepEqual([...probe].sort(),[...listed].sort(),file);
 }
 assert.ok(!/\bR (pfctl|sshd|lsof|nft|ss)\b/.test(readFileSync(path.join(root,'scripts','systems','mac-probe.sh'),'utf8')),'never a bare name');
});

test('sudoers: one exact rule per PRIVILEGED line, escaped, no wildcard; listen alternatives that exist; ssh-probe only with all-accounts',()=>{
 const rules=text=>text.split('\n').filter(l=>l.includes('NOPASSWD:'));
 const mac=renderSudoers({platform:'macos',account:'alice',keys:'own'});
 assert.deepEqual(rules(mac.text),PRIVILEGED.macos.filter(e=>!e.only).map(e=>`alice ALL=(root) NOPASSWD: ${e.argv.map(sudoersEscape).join(' ')}`));
 assert.ok(mac.text.includes('NOPASSWD: /usr/sbin/lsof +c 0 -nP -iTCP -sTCP\\:LISTEN'),'":" escaped');
 assert.ok(!/\*/.test(rules(mac.text).join('\n')),'no wildcard');
 assert.equal(sudoersEscape('a,b=c:d\\e'),'a\\,b\\=c\\:d\\\\e');
 const all=renderSudoers({platform:'macos',account:'alice',keys:'all-accounts'});
 // A command without arguments is rendered with "": in sudoers a bare command would allow any arguments.
 assert.equal(rules(all.text).at(-1),'alice ALL=(root) NOPASSWD: /usr/local/libexec/home-hub-agent/ssh-probe.sh ""');
 assert.ok(rules(all.text).concat(rules(mac.text)).every(l=>/NOPASSWD: \S+ \S/.test(l)),'every rule names its arguments, or "" for none');
 const linux=renderSudoers({platform:'linux',account:'home-hub-agent',keys:'off',ssOk:p=>p==='/usr/bin/ss'});
 assert.deepEqual(rules(linux.text),['home-hub-agent ALL=(root) NOPASSWD: /usr/sbin/sshd -T','home-hub-agent ALL=(root) NOPASSWD: /usr/sbin/nft list ruleset','home-hub-agent ALL=(root) NOPASSWD: /usr/bin/ss -Htlnp']);
 assert.match(linux.text,/^Defaults:home-hub-agent !requiretty$/m);
 for(const bad of ['root ALL','al ice','$(id)',''])assert.throws(()=>renderSudoers({platform:'macos',account:bad,keys:'own'}),/account name/);
});

// A plan with everything passed in: no file of this device but the checkout is read.
const planFor=(platform,o={},inputs={})=>planCoreInstall({hub:'https://hub.example.lan',pins:[],ca:null,keyFile:'/k.json',specs:null,runtimes:[],keys:null,account:platform==='macos'?'alice':null,wait:90,allowDirty:false,...o},
 {platform,home:'/Users/alice',uid:501,node:platform==='macos'?'/opt/homebrew/bin/node':'/usr/bin/node',systemd:252,keyText:KEY_TEXT,git:clean,...inputs});

test('the plan: refusals by name; the hostile watch lists the agent refuses are refused at install too',()=>{
 for(const bad of HOSTILE)assert.throws(()=>planFor('macos',{specs:'/s'},{specsText:bad}),/does not pass the agent's check/,bad);
 assert.throws(()=>planFor('linux',{specs:'/s'},{specsText:'x|brew|node||\n'}),/line 1: kind/,'Linux has no brew');
 // A glob below every shared-writable directory still passes: several installs of one tool, a home-relative pattern.
 const globs='llama|cmd|~/x/llama-b*/llama-server|--version|\nnode|cmd|/opt/homebrew/Cellar/node*/bin/node|--version|\nx|cmd|/usr/local/lib/x-*/bin/x|--version|\n';
 assert.deepEqual(specsPathErrors(globs),[]);
 assert.doesNotThrow(()=>planFor('macos',{specs:'/s'},{specsText:globs}));
 assert.deepEqual(specsPathErrors('a|cmd|/t*/evil|--version|\nb|cmd|/Users/*/evil|--version|\nc|cmd|/private/var/t*/evil|--version|\nd|cmd|/*|--version|\ne|cmd|/Var/T*/x|--version|\n').map(e=>e.reason),
  Array(5).fill('a cmd glob that can expand into a directory every account can write'));
 assert.throws(()=>planFor('macos',{hub:'http://10.0.0.5:8781'}),/--hub must be an origin/);
 assert.throws(()=>planFor('macos',{hub:'http://localhost:8781'}),/--hub must be an origin/);
 assert.throws(()=>planFor('macos',{pins:['a'.repeat(64)],ca:'/ca.pem'}),/exclude each other/);
 assert.throws(()=>planFor('macos',{pins:['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]}),/At most two/);
 assert.throws(()=>planFor('macos',{pins:['nope']}),/not a SHA-256/);
 assert.throws(()=>planFor('macos',{ca:'/ca.pem'},{caText:'nope'}),/not a PEM/);
 assert.throws(()=>planFor('macos',{},{keyText:'{"schema":1,"token":"hhk_x"}'}),/not an agent key file/);
 assert.throws(()=>planFor('macos',{account:'root'}),/not as root/);
 assert.throws(()=>planFor('macos',{},{uid:0}),/not as root or with sudo/);
 assert.throws(()=>planFor('linux',{account:'alice'}),/system account home-hub-agent/);
 assert.throws(()=>planFor('linux',{},{node:'/home/alice/.nvm/node'}),/inside a home directory/);
 assert.throws(()=>planFor('linux',{keys:'own'}),/keys "own"/);
 assert.throws(()=>planFor('macos',{},{git:()=>({commit:null,dirty:null})}),/must be a git checkout/);
 assert.throws(()=>planFor('macos',{},{git:()=>({commit:'c',dirty:['scripts/agent/agent.mjs']})}),/uncommitted changes.*scripts\/agent\/agent\.mjs/s);
 assert.throws(()=>planFor('windows'),/macOS and Linux/);
 assert.deepEqual(parseRuntimeFlag('ollama=http://127.0.0.1:11434'),{id:'ollama',kind:'ollama',url:'http://127.0.0.1:11434'});
 assert.equal(parseRuntimeFlag('box=http://127.0.0.1:1').kind,'auto');
 assert.throws(()=>planFor('macos',{runtimes:['x=http://10.0.0.5:1']}),/loopback/);
 assert.deepEqual(parseCoreArgs(['--core','--hub','https://h.example.lan','--pin','a','--pin','b','--runtime','x=y','--yes']).pins,['a','b']);
 for(const bad of [['--token','x'],['--hub'],['--wait','1']])assert.ok(parseCoreArgs(bad).error,bad.join(' '));
 assert.equal(systemdVersion('systemd 252 (252.22-1~deb12u1)\n+PAM'),252);assert.equal(systemdVersion('nope'),null);
});

test('rendered files: agent.json, the launchd agent, the systemd system unit (LoadCredential or the older fallback), the plan text',()=>{
 const mac=planFor('macos',{pins:['AB'.repeat(32)],runtimes:['ollama=http://127.0.0.1:11434']},{specsText:'node|cmd|/opt/homebrew/bin/node|--version|\n'});
 const cfg=parseConfig(mac.configText,{platform:'macos'});
 assert.equal(cfg.ok,true);assert.deepEqual(cfg.config.trust,{mode:'pin',pins:['ab'.repeat(32)]});assert.equal(cfg.config.keys,'own');assert.equal(cfg.config.runtimes[0].id,'ollama');
 assert.ok(!mac.configText.includes('device')&&!mac.configText.includes(TOKEN));
 const base='/Users/alice/Library/Application Support/Home Hub Agent';
 assert.deepEqual([mac.paths.config,mac.paths.key,mac.paths.state,mac.paths.log],[`${base}/config`,`${base}/private/agent.key`,`${base}/state`,'/Users/alice/Library/Logs/Home Hub Agent/agent.log']);
 assert.equal(mac.service.kind,'launchd-agent');assert.equal(mac.service.file,'/Users/alice/Library/LaunchAgents/home-hub-agent.plist');assert.equal(mac.service.domain,'gui/501');
 assert.match(mac.service.text,/<string>\/opt\/homebrew\/bin\/node<\/string>\n\t\t<string>\/Users\/alice\/Library\/Application Support\/Home Hub Agent\/scripts\/agent\/agent\.mjs<\/string>\n\t\t<string>--config<\/string>/);
 assert.doesNotMatch(mac.service.text,/\{\{|UserName|hha_/);
 if(process.platform==='darwin'&&existsSync('/usr/bin/plutil')){const r=spawnSync('/usr/bin/plutil',['-lint','-'],{input:mac.service.text,encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);}
 const text=formatCorePlan(mac).join('\n');
 assert.ok(!text.includes(TOKEN),'never the token');assert.match(text,/key hha_ffffffff… for device studio/);assert.match(text,/  1  node\|cmd\|\/opt\/homebrew\/bin\/node\|--version\|/);
 assert.match(text,/alice ALL=\(root\) NOPASSWD: \/sbin\/pfctl -s info/);
 const unit=planFor('linux',{keys:'all-accounts'},{ssOk:p=>p!=='/bin/ss'});
 assert.equal(unit.account,'home-hub-agent');assert.equal(unit.keyMode,'credential');assert.equal(unit.service.kind,'systemd-system');assert.equal(unit.service.file,'/etc/systemd/system/home-hub-agent.service');
 for(const line of ['User=home-hub-agent','LoadCredential=agent-key:/etc/home-hub-agent/agent.key','StateDirectory=home-hub-agent','ProtectSystem=strict','ReadWritePaths=/var/lib/home-hub-agent',
  'ProtectControlGroups=yes','RestartPreventExitStatus=78',
  'ExecStart="/usr/bin/node" "/opt/home-hub-agent/scripts/agent/agent.mjs" "--config" "/etc/home-hub-agent" "--state" "/var/lib/home-hub-agent"'])
  assert.ok(unit.service.text.split('\n').includes(line),line);
 // The agent's privileged reads go through the setuid sudo: no setting of the unit may turn on no_new_privs.
 const settings=unit.service.text.split('\n').filter(l=>/^[A-Za-z]+=/.test(l)).map(l=>l.split('=')[0]);
 for(const never of IMPLIES_NO_NEW_PRIVILEGES)assert.ok(!settings.includes(never),`${never}= implies NoNewPrivileges=yes for User=`);
 for(const never of ['ProtectHome','ProtectProc','PrivateTmp','PrivateUsers','CapabilityBoundingSet','{{'])assert.ok(!unit.service.text.includes(never),never);
 assert.match(unit.sudoers.text,/NOPASSWD: \/usr\/local\/libexec\/home-hub-agent\/ssh-probe\.sh ""$/m);assert.doesNotMatch(unit.sudoers.text,/NOPASSWD: \/bin\/ss -Htlnp$/m);
 const old=planFor('linux',{},{systemd:LOAD_CREDENTIAL_SINCE-1});
 assert.equal(old.keyMode,'file');assert.doesNotMatch(old.service.text,/LoadCredential/);assert.match(old.service.text,/"--key" "\/etc\/home-hub-agent\/agent\.key"/);
 assert.match(formatCorePlan(old).join('\n'),/owned by home-hub-agent, 0400: systemd 246 has no LoadCredential=/);
 assert.equal(planFor('linux',{},{systemd:null}).keyMode,'file','unknown systemd: the fallback that works everywhere');
});

// The first real Linux device (systemd 257 in a container) took a unit with LoadCredential= and dropped the setting
// without a word: no $CREDENTIALS_DIRECTORY, so the agent stopped with key-missing and the install rolled back.
test('Linux: LoadCredential= is used only when a test unit was handed one; else the account\'s 0400 key file',async t=>{
 const dropped=planFor('linux',{},{systemd:257,loadCredential:false});
 assert.equal(dropped.keyMode,'file');assert.doesNotMatch(dropped.service.text,/LoadCredential/);assert.match(dropped.service.text,/"--key" "\/etc\/home-hub-agent\/agent\.key"/);
 assert.match(formatCorePlan(dropped).join('\n'),/owned by home-hub-agent, 0400: systemd 257 did not hand a test unit its LoadCredential=/);
 assert.equal(planFor('linux',{},{systemd:257,loadCredential:true}).keyMode,'credential');
 // What v1.5.0 did: the version alone (257 ≥ 247) chose LoadCredential=, and the agent had no key.
 assert.equal(planFor('linux',{},{systemd:257}).keyMode,'credential','not tried (not root): the version decides, as before');
 const answer=(code,stdout,stderr='',extra={})=>({calls:[],opts:[],exec(cmd,args,o){this.calls.push([cmd,...args]);this.opts.push(o);return Promise.resolve({code,stdout,stderr,...extra});}});
 const works=answer(0,'/run/credentials/run-u1.service\n');
 assert.deepEqual(await loadCredentialWorks(works,'/opt/core/package.json'),{ok:true,why:null});
 assert.deepEqual(works.calls[0],['/usr/bin/systemd-run','--quiet','--wait','--pipe','--collect','-p','RuntimeMaxSec=10','-p','LoadCredential=home-hub-agent-test:/opt/core/package.json','/usr/bin/printenv','CREDENTIALS_DIRECTORY']);
 assert.equal(works.opts[0].timeoutMs,LOAD_CREDENTIAL_TEST_MS,'the test has a time limit');
 assert.deepEqual(await loadCredentialWorks(answer(1,''),'/x'),{ok:false,why:'the unit had no $CREDENTIALS_DIRECTORY'},'printenv finds no CREDENTIALS_DIRECTORY (exit 1, passed on by --wait)');
 assert.deepEqual(await loadCredentialWorks(answer(217,''),'/x'),{ok:false,why:'systemd-run exited 217'});
 assert.deepEqual(await loadCredentialWorks(answer(0,'\n'),'/x'),{ok:false,why:'the unit had no $CREDENTIALS_DIRECTORY'});
 assert.deepEqual(await loadCredentialWorks(answer(-1,'','ENOENT'),'/x'),{ok:false,why:'systemd-run: ENOENT'},'no systemd-run');
 // A systemd that refuses the property on a transient unit: what it said reaches the plan.
 assert.deepEqual(await loadCredentialWorks(answer(1,'','\nUnknown assignment: LoadCredential=home-hub-agent-test:/x\n'),'/x'),{ok:false,why:'systemd-run: Unknown assignment: LoadCredential=home-hub-agent-test:/x'});
 assert.deepEqual(await loadCredentialWorks(answer(-1,'','timed out',{timedOut:true}),'/x'),{ok:false,why:`systemd-run did not finish within ${LOAD_CREDENTIAL_TEST_MS/1000} s`});
 const said=formatCorePlan(planFor('linux',{},{systemd:249,loadCredential:false,loadCredentialWhy:'systemd-run: Unknown assignment'})).join('\n');
 assert.match(said,/0400: systemd 249 did not hand a test unit its LoadCredential=\)\n {4}the LoadCredential= test: systemd-run: Unknown assignment$/m);
 // runCoreInstall asks the service manager, as root, before it plans: the dry run already shows the key file.
 const dir=temp(t),keyFile=path.join(dir,'key.json');put(keyFile,KEY_TEXT);
 const lines=[],calls=[];
 const fake={...systemWorld(),log:l=>lines.push(l),warn:l=>lines.push(l),exec:async(cmd,args)=>{calls.push(cmd);
  if(cmd==='/usr/bin/systemctl')return {code:0,stdout:'systemd 257 (257.13-1~deb13u1)\n',stderr:''};
  if(cmd==='/usr/bin/systemd-run')return {code:1,stdout:'',stderr:'Job failed. See "journalctl -xe" for details.\n'};
  return {code:0,stdout:'',stderr:''};}};
 const code=await runCoreInstall(['--core','--hub','https://hub.example.lan','--key-file',keyFile,'--dry-run','--allow-dirty'],{world:fake,platform:'linux',uid:0});
 assert.equal(code,0,lines.join('\n'));
 assert.ok(calls.includes('/usr/bin/systemd-run'));
 assert.match(lines.join('\n'),/0400: systemd 257 did not hand a test unit its LoadCredential=/);
 assert.match(lines.join('\n'),/the LoadCredential= test: systemd-run: Job failed\./);
 // Not root: nothing is asked (the installer refuses further on anyway).
 calls.length=0;await runCoreInstall(['--core','--hub','https://hub.example.lan','--key-file',keyFile,'--dry-run','--allow-dirty'],{world:fake,platform:'linux',uid:1000});
 assert.ok(!calls.includes('/usr/bin/systemd-run'));
});

// A transient unit that hangs must not hang the installer (--dry-run included): past its time limit the command is
// killed and the answer counts as no.
test('systemWorld().exec: a command past timeoutMs is killed and answers timedOut',async()=>{
 const w=systemWorld(),began=Date.now();
 const r=await w.exec(process.execPath,['-e','setTimeout(()=>{},60000)'],{timeoutMs:300});
 assert.equal(r.code,-1);assert.equal(r.timedOut,true);assert.ok(Date.now()-began<10000,'did not wait for the command');
 const quick=await w.exec(process.execPath,['-e','process.stdout.write("ok")'],{timeoutMs:10000});
 assert.equal(quick.code,0);assert.equal(quick.stdout,'ok');assert.ok(!quick.timedOut);
});

// --- carrying it out, in a temp directory ---------------------------------------------------------------------------
// A fake world: the files are real (in a temp directory), the commands are not. install and rm act on those files as
// the real ones would (so what the installer reads back is what "root" wrote); launchctl print answers "not loaded"
// unless printBusy says the job is still going away; the service manager's start writes the agent's first status.
function world(t,{uid=501,accept=true,idKnown=true,printBusy=0,corruptInstall=false}={}){
 // corruptInstall: the first install of ssh-probe.sh writes other bytes (a file swapped on its way).
 const calls=[],chowns=[],opts=[];let clock=Date.parse('2026-11-13T10:00:00Z');let state=null;
 const real=systemWorld().fs;
 const w={uid,calls,chowns,opts,
  fs:{...real,chown:(f,u,g)=>chowns.push([f,u,g]),stat:()=>({uid:0,mode:0o755,file:true,dir:true})},
  now:()=>clock,sleep:async ms=>{clock+=ms;},log:()=>{},warns:[],warn(m){w.warns.push(m);},confirm:async()=>true,
  setState:dir=>{state=dir;},
  exec:async(cmd,args,o)=>{
   calls.push([cmd,...args].join(' '));opts.push(o||{});
   const [c,a]=cmd==='/usr/bin/sudo'?[args[0],args.slice(1)]:[cmd,args];
   if(c==='/usr/bin/install'){
    if(a.includes('-d'))mkdirSync(a.at(-1),{recursive:true});
    else{mkdirSync(path.dirname(a.at(-1)),{recursive:true});const swap=corruptInstall&&a.at(-1).endsWith('ssh-probe.sh');if(swap)corruptInstall=false;writeFileSync(a.at(-1),swap?'#!/bin/sh\necho swapped\n':readFileSync(a.at(-2)));}
    return {code:0,stdout:'',stderr:''};
   }
   if(c==='/bin/rm'){rmSync(a.at(-1),{force:true});return {code:0,stdout:'',stderr:''};}
   if(c==='/bin/launchctl'&&a[0]==='print'){if(printBusy>0){printBusy--;return {code:0,stdout:'state = running',stderr:''};}return {code:113,stdout:'',stderr:'Could not find service'};}
   if(cmd==='/usr/bin/id'&&args[0]==='-u'&&!idKnown){idKnown=calls.some(c=>c.startsWith('/usr/sbin/useradd'));return idKnown?{code:0,stdout:'990\n',stderr:''}:{code:1,stdout:'',stderr:'no such user'};}
   if(cmd==='/usr/bin/id')return {code:0,stdout:args[0]==='-u'?'990\n':'985\n',stderr:''};
   // The agent the service manager started writes its first status (accepted, or not).
   if((a[0]==='bootstrap'||a[0]==='restart')&&state){mkdirSync(state,{recursive:true});clock+=3000;writeFileSync(path.join(state,'status.json'),JSON.stringify({lastAttemptAt:new Date(clock).toISOString(),lastAcceptedAt:accept?new Date(clock).toISOString():null,lastError:accept?null:'tls-pin',parts:{}}));}
   return {code:0,stdout:'',stderr:''};
  }};
 return w;
}
const pathsIn=(dir,platform)=>{const p=corePaths(platform,{home:path.join(dir,'home')});const map=x=>x&&(x.startsWith(dir)?x:path.join(dir,'root',x));return Object.fromEntries(Object.entries(p).map(([k,v])=>[k,map(v)]));};
// Every file under a directory → its bytes, to compare a tree before and after.
const snapshot=d=>{const out={};const walk=x=>{for(const e of readdirSync(x,{withFileTypes:true})){const f=path.join(x,e.name);if(e.isDirectory())walk(f);else out[path.relative(d,f)]=readFileSync(f,'utf8');}};if(existsSync(d))walk(d);return out;};

test('install on macOS: the copy, configuration, key and service in place; sudo only for sudoers; health is the first accepted report',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'macos');
 const plan=planFor('macos',{specs:'/s',wait:30},{specsText:'node|cmd|/opt/homebrew/bin/node|--version|\n',paths});
 const w=world(t);w.setState(paths.state);
 const r=await applyCorePlan(plan,{world:w});
 assert.equal(r.status,'done');
 for(const f of plan.files)assert.equal(readFileSync(path.join(paths.target,f.to),'utf8'),f.body.toString('utf8'),f.to);
 assert.equal(statSync(path.join(paths.target,'scripts','systems','mac-probe.sh')).mode&0o777,0o755);
 assert.equal(readFileSync(paths.key,'utf8'),TOKEN+'\n');assert.equal(statSync(paths.key).mode&0o777,0o600);assert.equal(statSync(path.dirname(paths.key)).mode&0o777,0o700);
 assert.equal(statSync(path.join(paths.config,'agent.json')).mode&0o777,0o600);
 assert.equal(readFileSync(path.join(paths.config,'specs.txt'),'utf8'),'node|cmd|/opt/homebrew/bin/node|--version|\n');
 assert.equal(readFileSync(paths.service,'utf8'),plan.service.text);
 assert.equal(readFileSync(paths.sudoers,'utf8'),plan.sudoers.text);
 const record=readFileSync(path.join(paths.target,AGENT_MANIFEST),'utf8');
 assert.ok(!record.includes(TOKEN),'the key never in .agent-install.json');assert.equal(JSON.parse(record).kind,'core');assert.equal(JSON.parse(record).privileged.sudoers,plan.sudoers.text);
 assert.deepEqual(w.calls.map(c=>c.split(' ').slice(0,3).join(' ')),['/usr/sbin/visudo -cf '+w.calls[0].split(' ')[2],'/usr/bin/sudo /usr/bin/install -m',
  '/bin/launchctl bootout gui/501/home-hub-agent','/bin/launchctl print gui/501/home-hub-agent','/bin/launchctl bootstrap gui/501']);
 assert.ok(w.calls[1].endsWith(` ${paths.sudoers}`));
 // The agent's own copy runs from where it was put.
 const once=spawnSync(process.execPath,[path.join(paths.target,'scripts','agent','agent.mjs'),'--config',paths.config,'--help'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
 assert.equal(once.status,0,once.stderr);
 // Installing again with an agent that never reports: the previous copy, service file and sudoers rules come back.
 put(paths.service,'<plist>previous</plist>');
 const failed=await applyCorePlan(planFor('macos',{wait:10},{paths}),{world:Object.assign(world(t,{accept:false}),{setState(){}})});
 assert.equal(failed.status,'rolled-back');assert.ok(failed.saved&&existsSync(failed.saved));
 assert.equal(readFileSync(path.join(paths.config,'specs.txt'),'utf8'),'node|cmd|/opt/homebrew/bin/node|--version|\n','the previous watch list is back');
 assert.equal(readFileSync(paths.service,'utf8'),'<plist>previous</plist>');
 assert.equal(readFileSync(paths.sudoers,'utf8'),plan.sudoers.text,'the previous rules are back');
 // Not as root on macOS; the watch list must be confirmed.
 await assert.rejects(applyCorePlan(plan,{world:world(t,{uid:0})}),/not with sudo/);
 assert.equal((await applyCorePlan(plan,{world:Object.assign(world(t),{confirm:async()=>false})})).status,'declined');
});

test('macOS: bootstrap waits until bootout has taken the job away, for a bounded time',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'macos');
 const plan=planFor('macos',{wait:30},{paths});
 const w=world(t,{printBusy:3});w.setState(paths.state);
 assert.equal((await applyCorePlan(plan,{world:w})).status,'done');
 const launchctl=w.calls.filter(c=>c.startsWith('/bin/launchctl')).map(c=>c.split(' ')[1]);
 assert.deepEqual(launchctl,['bootout','print','print','print','print','bootstrap'],'bootstrap only after print stops answering');
 // A job that never goes: bootstrap is tried after BOOTOUT_WAIT, not never.
 const stuck=world(t,{printBusy:1e9});stuck.setState(paths.state);
 assert.equal((await applyCorePlan(plan,{world:stuck})).status,'done');
 assert.equal(stuck.calls.filter(c=>c.startsWith('/bin/launchctl print')).length,BOOTOUT_WAIT.tries);
 assert.ok(stuck.calls.at(-1).startsWith('/bin/launchctl bootstrap'));assert.match(stuck.warns.join('\n'),/still loaded/);
});

test('install on Linux: the account, root-owned files, the key by LoadCredential or as the account\'s 0400; a node others can change is refused',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'linux');
 const w=world(t,{uid:0,idKnown:false});w.setState(paths.state);
 const plan=planFor('linux',{wait:30},{paths,systemd:252});
 assert.equal((await applyCorePlan(plan,{world:w})).status,'done');
 assert.ok(w.calls.includes('/usr/sbin/useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin home-hub-agent'));
 assert.ok(w.calls.some(c=>c.startsWith('/usr/bin/install -m 0440 -o root -g root ')&&c.endsWith(paths.sudoers)),'root installs the sudoers file itself');
 assert.deepEqual(w.calls.filter(c=>c.startsWith('/usr/bin/systemctl')),['/usr/bin/systemctl stop home-hub-agent','/usr/bin/systemctl daemon-reload','/usr/bin/systemctl enable home-hub-agent','/usr/bin/systemctl restart home-hub-agent']);
 assert.equal(statSync(paths.key).mode&0o777,0o600);assert.deepEqual(w.chowns,[],'LoadCredential: the key stays root\'s');
 assert.equal(statSync(path.join(paths.config,'agent.json')).mode&0o777,0o644);
 assert.ok(!w.calls.some(c=>c.startsWith('/usr/bin/sudo')),'root needs no sudo');
 const older=world(t,{uid:0});older.setState(paths.state);
 await applyCorePlan(planFor('linux',{wait:30},{paths,systemd:245}),{world:older});
 assert.equal(statSync(paths.key).mode&0o777,0o400);assert.deepEqual(older.chowns,[[paths.key,990,985]]);
 await assert.rejects(applyCorePlan(plan,{world:world(t,{uid:1000})}),/runs as root/);
 // node runs as the agent's account: a node (or a directory above it) that another account can change is refused
 // before anything is run or changed.
 for(const [where,stat] of [['/usr/local/bin',{uid:1000,mode:0o755}],['/usr/bin/node',{uid:0,mode:0o775}]]){
  const unsafe=world(t,{uid:0});unsafe.fs={...unsafe.fs,stat:f=>f===where?{...stat,file:true,dir:true}:{uid:0,mode:0o755,file:true,dir:true}};
  const p=planFor('linux',{wait:30},{paths,node:where==='/usr/local/bin'?'/usr/local/bin/node':'/usr/bin/node'});
  await assert.rejects(applyCorePlan(p,{world:unsafe}),new RegExp(`${where.replace(/\//g,'\\/')} is not root-owned or is writable by others: node there would run as home-hub-agent`));
  assert.deepEqual(unsafe.calls,[],'nothing ran');
 }
});

test('--once: the copy runs from a temporary directory, as the account with a fixed environment; an install, its service and sudoers are left exactly as they were',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'linux');
 const v1={specs:'a|cmd|/usr/bin/a|--version|\n'},v2={specs:'b|cmd|/usr/bin/b|--version|\n'};
 const plan=(v,o={})=>planFor('linux',{specs:'/s',wait:30,...o},{paths,specsText:v.specs});
 const w1=world(t,{uid:0});w1.setState(paths.state);
 assert.equal((await applyCorePlan(plan(v1),{world:w1})).status,'done');
 const installed=[paths.target,paths.config,path.dirname(paths.sudoers),path.dirname(paths.service)].map(snapshot);
 const once=world(t,{uid:0});
 assert.equal((await applyCorePlan(plan(v2,{hub:'https://other.example.lan'}),{world:once,once:true})).status,'once');
 const run=once.calls.find(c=>c.startsWith('/usr/sbin/runuser'));
 const m=/^\/usr\/sbin\/runuser -u home-hub-agent -- \/usr\/bin\/node (\S+)\/agent\/scripts\/agent\/agent\.mjs --config (\S+)\/config --once$/.exec(run);
 assert.ok(m&&m[1]===m[2],run);
 assert.ok(!m[1].startsWith(paths.target)&&!m[1].startsWith(dir),'not where the install is');
 assert.ok(!existsSync(m[1]),'the temporary copy is removed');
 assert.deepEqual(once.opts[once.calls.indexOf(run)].env,{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',HOME:'/nonexistent'},'nothing of root\'s environment');
 assert.ok(!once.calls.some(c=>/systemctl|install|visudo|\/bin\/rm/.test(c)));
 assert.deepEqual([paths.target,paths.config,path.dirname(paths.sudoers),path.dirname(paths.service)].map(snapshot),installed,'the installed agent is untouched');
 // A full install of v2 that fails its health check puts v1 back, not anything --once laid out.
 const failed=world(t,{uid:0,accept:false});failed.setState(paths.state);
 assert.equal((await applyCorePlan(plan(v2),{world:failed})).status,'rolled-back');
 assert.equal(readFileSync(path.join(paths.config,'specs.txt'),'utf8'),v1.specs);
 assert.equal(readFileSync(path.join(paths.config,'agent.json'),'utf8'),plan(v1).configText);
 // macOS: the node is run directly, with the owner's HOME.
 const mdir=temp(t),mpaths=pathsIn(mdir,'macos'),mac=world(t);
 assert.equal((await applyCorePlan(planFor('macos',{},{paths:mpaths}),{world:mac,once:true})).status,'once');
 assert.match(mac.calls[0],/^\/opt\/homebrew\/bin\/node \S+\/agent\/scripts\/agent\/agent\.mjs --config \S+\/config --once$/);
 assert.deepEqual(mac.opts[0].env,{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',HOME:'/Users/alice'});
 assert.ok(!existsSync(mpaths.target),'nothing installed');
});

test('all-accounts: the root-owned probe copy from the hashed bytes, refused when a parent is writable by others; a failure undoes the privileged part',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'linux');
 const plan=planFor('linux',{keys:'all-accounts',wait:30},{paths});
 const w=world(t,{uid:0});w.setState(paths.state);
 assert.equal((await applyCorePlan(plan,{world:w})).status,'done');
 const copy=w.calls.find(c=>c.startsWith('/usr/bin/install -m 0755 -o root -g root ')&&c.endsWith(paths.probeCopy));
 assert.ok(copy&&!copy.includes(root),'installed from the staged bytes the plan hashed, not from the checkout');
 assert.equal(readFileSync(paths.probeCopy,'utf8'),plan.files.find(f=>f.to==='scripts/security/ssh-probe.sh').body.toString('utf8'));
 assert.ok(w.calls.indexOf(copy)<w.calls.findIndex(c=>c.endsWith(paths.sudoers)),'the copy before the rule that runs it');
 const unsafe=world(t,{uid:0});unsafe.fs={...unsafe.fs,stat:f=>({uid:f===path.dirname(path.dirname(paths.probeCopy))?501:0,mode:0o755,file:true,dir:true})};
 await assert.rejects(applyCorePlan(plan,{world:unsafe}),/is not root-owned or is writable by others/);
 assert.ok(!unsafe.calls.some(c=>/systemctl|install -m/.test(c)),'refused before anything was installed or stopped');
 // A probe copy that does not hold the hashed bytes: refused before the rules, the copy put back as it was.
 const before=readFileSync(paths.probeCopy,'utf8'),rules=readFileSync(paths.sudoers,'utf8');
 const swapped=world(t,{uid:0,corruptInstall:true});
 await assert.rejects(applyCorePlan(plan,{world:swapped}),/does not hold the ssh-probe\.sh the plan hashed/);
 assert.ok(!swapped.calls.some(c=>c.startsWith('/usr/bin/install -m 0440')),'no new rules');
 assert.ok(!swapped.calls.some(c=>/systemctl/.test(c)),'the running agent was not stopped');
 assert.equal(readFileSync(paths.sudoers,'utf8'),rules);
 assert.equal(swapped.calls.filter(c=>c.endsWith(paths.probeCopy)).length,2,'the copy, then the previous one put back');
 assert.equal(readFileSync(paths.probeCopy,'utf8'),before);
 // The refused install leaves no backup behind: the previous agent was never touched, so there is nothing to keep.
 assert.deepEqual(readdirSync(paths.backups),[],'no backups/<stamp>/ left by a refused privileged step');
 // visudo refuses the rules: the same, on macOS; and when putting the previous probe copy back fails, the backup stays and is named.
 const mac=pathsIn(path.join(dir,'mac'),'macos'),mplan=planFor('macos',{wait:30},{paths:mac});
 const first=world(t);first.setState(mac.state);assert.equal((await applyCorePlan(mplan,{world:first})).status,'done');
 const visudo=world(t);const vexec=visudo.exec;visudo.exec=async(cmd,args,o)=>cmd==='/usr/sbin/visudo'?(visudo.calls.push(cmd),{code:1,stdout:'',stderr:'syntax error'}):vexec(cmd,args,o);
 await assert.rejects(applyCorePlan(mplan,{world:visudo}),/visudo -cf refused/);
 assert.deepEqual(readdirSync(mac.backups),[]);
 const stuck=world(t,{uid:0,corruptInstall:true});const sexec=stuck.exec;let installs=0;
 stuck.exec=async(cmd,args,o)=>cmd==='/usr/bin/install'&&args.at(-1)===paths.probeCopy&&++installs===2?(stuck.calls.push(cmd),{code:1,stdout:'',stderr:''}):sexec(cmd,args,o);
 await assert.rejects(applyCorePlan(plan,{world:stuck}),/does not hold the ssh-probe\.sh the plan hashed/);
 const kept=readdirSync(paths.backups);
 assert.equal(kept.length,1);assert.ok(stuck.warns.includes(`  kept the backup of the previous agent in ${path.join(paths.backups,kept[0])}`),stuck.warns.join('\n'));
});

test('a fresh install that fails its health check removes its sudoers file and probe copy; a copied file that is not the hashed one rolls back',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'linux');
 const failed=world(t,{uid:0,accept:false});failed.setState(paths.state);
 assert.equal((await applyCorePlan(planFor('linux',{keys:'all-accounts',wait:10},{paths}),{world:failed})).status,'rolled-back');
 assert.ok(!existsSync(paths.sudoers)&&!existsSync(paths.probeCopy)&&!existsSync(paths.service),'no rules left for an agent that is not there');
 assert.ok(failed.calls.includes(`/bin/rm -f ${paths.sudoers}`)&&failed.calls.includes(`/bin/rm -f ${paths.probeCopy}`));
 assert.ok(failed.warns.includes(`  removed ${paths.sudoers} (there was no previous agent)`)&&failed.warns.includes(`  removed ${paths.probeCopy}`),failed.warns.join('\n'));
 // The copy is written from the plan's bytes and read back: a file that differs on disk is refused, and rolled back.
 const bad=world(t,{uid:0});bad.setState(paths.state);
 const write=bad.fs.write;bad.fs={...bad.fs,write:(f,data,mode)=>write(f,f.endsWith('agent.mjs')?'// swapped\n':data,mode)};
 assert.equal((await applyCorePlan(planFor('linux',{wait:10},{paths}),{world:bad})).status,'rolled-back');
 assert.match(bad.warns.join('\n'),/does not hold the bytes the plan hashed/);
 assert.ok(!existsSync(paths.sudoers),'fresh: the rules went with it');
});

test('the status the installer waits for, and the watch list the hub hands out',()=>{
 assert.deepEqual(readStatus('{"lastAcceptedAt":"2026-11-13T10:00:00Z","lastError":null}'),{acceptedAt:Date.parse('2026-11-13T10:00:00Z'),lastError:null});
 assert.equal(readStatus('nope'),null);
 const registry={items:[{id:'node',detect:{studio:{kind:'cmd',path:'/opt/homebrew/bin/node',args:'--version'}}},{id:'evil',detect:{studio:{kind:'cmd',path:'/bin/sh',args:'-c id'}}},{id:'none',detect:{}}]};
 assert.equal(specsFileText(registry,'studio'),'node|cmd|/opt/homebrew/bin/node|--version|\nevil|unsupported-args|||\n');
 assert.equal(specsFileText(registry,'other'),'');
 // The agent's path rules too: a space in a glob, a binary in a directory every account can write.
 for(const [kind,p] of [['cmd','/opt/a b/*'],['cmd','/tmp/x'],['pydist','/opt/x y/*']]){
  const r=agentSpecs({registry:{items:[{id:'x',detect:{studio:kind==='cmd'?{kind,path:p,args:'--version'}:{kind,glob:p,package:'foo'}}}]},device:'studio',platform:'macos'});
  assert.equal(r.ok,false,p);assert.equal(r.errors[0].line,1);
 }
 assert.equal(agentSpecs({registry,device:'studio',platform:'macos'}).ok,true,'a cmd rule with other arguments reaches the device as unsupported-args');
 assert.equal(agentSpecs({registry,device:'studio',platform:'linux'}).ok,false);
 const hostile={items:[{id:'x',detect:{studio:{kind:'json',path:'/etc/$(id)',key:'version'}}}]};
 assert.equal(agentSpecs({registry:hostile,device:'studio',platform:'macos'}).ok,false);
});

// --- the launchd daemon (--service launchd-daemon) -------------------------------------------------------------------
// What the 1.5.0 installer planned (tests/fixtures/agent-install/core-plan.json, written by that release's code): the
// plan without --service, and with the default named, must stay exactly that.
// The version is <V>, and the placeholder home <HOME> (the leak scan takes the placeholder home followed by markup for a real one).
const corePlanShape=p=>{
 const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
 const {files,...record}=p.record;
 const shape={lines:formatCorePlan(p),service:{kind:p.service.kind,label:p.service.label,file:p.service.file,domain:p.service.domain??null,text:p.service.text},
  paths:Object.fromEntries(Object.entries(p.paths).filter(([k])=>['target','config','key','state','log','service','backups','sudoers','probeCopy'].includes(k))),
  record,files:files.map(f=>f.path),sudoers:p.sudoers.text,configText:p.configText};
 return JSON.parse(JSON.stringify(shape).split(version).join('<V>').split('/Users/alice').join('<HOME>'));
};
const fixturePlan=(platform,o={},inputs={})=>planFor(platform,{pins:['AB'.repeat(32)],specs:'/s',runtimes:['ollama=http://127.0.0.1:11434'],keys:platform==='macos'?'all-accounts':null,...o},{specsText:'node|cmd|/opt/homebrew/bin/node|--version|\n',...inputs});
const daemonFor=(o={},inputs={})=>planFor('macos',{service:'launchd-daemon',...o},{user:'alice',...inputs});

test('without --service the plan is byte for byte what 1.5.0 planned (macOS launchd agent, Linux system unit)',()=>{
 const expected=JSON.parse(readFileSync(path.join(root,'tests','fixtures','agent-install','core-plan.json'),'utf8'));
 for(const platform of ['macos','linux']){
  assert.deepEqual(corePlanShape(fixturePlan(platform)),expected[platform],platform);
  assert.deepEqual(corePlanShape(fixturePlan(platform,{service:platform==='macos'?'launchd-agent':'systemd-system'})),expected[platform],`${platform}, the default named`);
 }
 // The LoadCredential= test (Linux only, as root) changes nothing on macOS. On Linux the plan stays 1.5.0's when the
 // test was not run (the fixture: not root) or a test unit was handed the credential; only when it was not does the
 // plan differ from 1.5.0, and then in the key mode alone: the 0400 key file, its plan line and the reason.
 assert.deepEqual(corePlanShape(fixturePlan('macos',{},{loadCredential:false,loadCredentialWhy:'x'})),expected.macos,'macos ignores the Linux test');
 assert.deepEqual(corePlanShape(fixturePlan('linux',{},{loadCredential:true})),expected.linux,'linux, the test unit was handed its credential');
 const dropped=corePlanShape(fixturePlan('linux',{},{loadCredential:false,loadCredentialWhy:'the unit had no $CREDENTIALS_DIRECTORY'}));
 assert.equal(dropped.record.keyMode,'file');assert.equal(expected.linux.record.keyMode,'credential');
 assert.deepEqual({...dropped,lines:null,service:{...dropped.service,text:null},record:{...dropped.record,keyMode:null}},{...expected.linux,lines:null,service:{...expected.linux.service,text:null},record:{...expected.linux.record,keyMode:null}},'only the key mode differs');
 assert.deepEqual(dropped.lines.filter(l=>!/^ {2}key |^ {4}the LoadCredential= test: /.test(l)),expected.linux.lines.filter(l=>!/^ {2}key /.test(l)));
 assert.equal(parseCoreArgs(['--core','--hub','h']).service,null);
 assert.equal(parseCoreArgs(['--core','--service','launchd-daemon']).service,'launchd-daemon');
 assert.ok(parseCoreArgs(['--service']).error);
});

test('the launchd daemon\'s plan: root-owned plist in /Library/LaunchDaemons, UserName the owner (never root), the agent\'s environment and timing; refusals',()=>{
 const agent=planFor('macos'),d=daemonFor();
 assert.equal(d.service.kind,'launchd-daemon');assert.equal(d.service.file,'/Library/LaunchDaemons/home-hub-agent.plist');assert.equal(d.service.domain,'system');assert.equal(d.service.gui,'gui/501');
 assert.equal(d.paths.service,'/Library/LaunchDaemons/home-hub-agent.plist');assert.equal(d.record.service,'launchd-daemon');
 assert.deepEqual(d.other,{kind:'launchd-agent',label:'home-hub-agent',file:'/Users/alice/Library/LaunchAgents/home-hub-agent.plist',domain:'gui/501'});
 assert.deepEqual(agent.other,{kind:'launchd-daemon',label:'home-hub-agent',file:'/Library/LaunchDaemons/home-hub-agent.plist',domain:'system'});
 // The same copy, key, configuration, state, log and sudoers rules as the agent kind.
 for(const k of ['target','config','key','state','log','backups','sudoers','probeCopy'])assert.equal(d.paths[k],agent.paths[k],k);
 assert.equal(d.sudoers.text,agent.sudoers.text);assert.equal(d.configText,agent.configText);assert.deepEqual(d.files.map(f=>f.sha256),agent.files.map(f=>f.sha256));
 // The plist is the agent's plus UserName and HOME_HUB_LAUNCHD_DOMAIN: HOME and PATH set, KeepAlive, RunAtLoad,
 // ThrottleInterval 60, ProcessType Background, the same program and log.
 const extra=['\t\t<key>HOME_HUB_LAUNCHD_DOMAIN</key>','\t\t<string>gui/501</string>','\t<key>UserName</key>','\t<string>alice</string>'];
 assert.deepEqual(d.service.text.split('\n').filter(l=>!extra.includes(l)),agent.service.text.split('\n'));
 for(const l of extra)assert.ok(d.service.text.split('\n').includes(l),l);
 assert.doesNotMatch(d.service.text,/\{\{|hha_|<string>root<\/string>|GroupName|SessionCreate|LimitLoadToSessionType/);
 if(process.platform==='darwin'&&existsSync('/usr/bin/plutil')){const r=spawnSync('/usr/bin/plutil',['-lint','-'],{input:d.service.text,encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);}
 const text=formatCorePlan(d).join('\n');
 assert.match(text,/launchd-daemon home-hub-agent: \/Library\/LaunchDaemons\/home-hub-agent\.plist \(root:wheel 0644, written with sudo\), in the system domain from boot, UserName alice \(never root\)/);
 assert.match(text,/a launchd-agent home-hub-agent \(\/Users\/alice\/Library\/LaunchAgents\/home-hub-agent\.plist\) is booted out and removed when there is one/);
 // Refused: the daemon for an account other than the one running the installer, root, Linux, an unknown kind.
 assert.throws(()=>daemonFor({account:'bob'}),/runs the agent as the account the install belongs to, the one running the installer \(alice\); --account bob is another/);
 assert.throws(()=>daemonFor({},{user:null}),/the one running the installer \(unknown\)/);
 assert.throws(()=>daemonFor({account:'root'},{user:'root'}),/not as root/);
 assert.throws(()=>daemonFor({},{uid:0}),/not as root or with sudo/);
 assert.throws(()=>planFor('macos',{service:'systemd-system'}),/--service is launchd-agent .* or launchd-daemon/);
 assert.throws(()=>planFor('linux',{service:'launchd-daemon'}),/On Linux the agent is a systemd system unit/);
 assert.doesNotThrow(()=>planFor('linux',{service:'systemd-system'}));
 // The renderer itself never writes UserName root, nor a domain of uid 0.
 const paths=corePaths('macos',{home:'/Users/alice',service:'launchd-daemon'});
 assert.equal(paths.service,paths.launchDaemon);
 for(const [account,uid] of [['root',501],['alice',0],['',501],['alice',null]])
  assert.throws(()=>renderCoreService({platform:'macos',paths,node:'/opt/homebrew/bin/node',uid,home:'/Users/alice',account,service:'launchd-daemon'}),/named explicitly and never root|not root's/,`${account} ${uid}`);
});

// The calls of a run, with the temp directory and the staged file names taken out.
const callsOf=(w,dir)=>w.calls.map(c=>c.split(dir).join('<T>').replace(/\/\S*home-hub-agent-[A-Za-z0-9]+\//g,'<STAGED>/'));

test('install the launchd daemon: the plist through sudo install (root:wheel 0644) and read back, bootstrap in the system domain; the log is the owner\'s',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'macos');
 const plan=daemonFor({wait:30},{paths});
 const w=world(t);w.setState(paths.state);
 assert.equal((await applyCorePlan(plan,{world:w})).status,'done');
 assert.deepEqual(callsOf(w,dir).slice(2),['/usr/bin/sudo /bin/launchctl bootout system/home-hub-agent','/bin/launchctl print system/home-hub-agent',
  '/usr/bin/sudo /usr/bin/install -m 0644 -o root -g wheel <STAGED>/home-hub-agent.plist <T>/root/Library/LaunchDaemons/home-hub-agent.plist',
  '/usr/bin/sudo /bin/launchctl bootstrap system <T>/root/Library/LaunchDaemons/home-hub-agent.plist']);
 assert.equal(readFileSync(paths.launchDaemon,'utf8'),plan.service.text);
 assert.ok(!existsSync(paths.launchAgent),'no launchd agent beside it');
 assert.ok(existsSync(paths.log),'the log made by the installer, so it is the owner\'s file');
 assert.equal(JSON.parse(readFileSync(path.join(paths.target,AGENT_MANIFEST),'utf8')).service,'launchd-daemon');
 // Installing it again (an update): the same, and no launchd agent is touched.
 const again=world(t);again.setState(paths.state);
 assert.equal((await applyCorePlan(plan,{world:again})).status,'done');
 assert.ok(!again.calls.some(c=>c.includes('gui/')));
 // A plist that does not read back as rendered, or is not root's afterwards: refused and rolled back.
 const swapped=world(t);swapped.setState(paths.state);const sx=swapped.exec;
 swapped.exec=async(cmd,args,o)=>{const r=await sx(cmd,args,o);if(args.at(-1)===paths.launchDaemon&&args.includes('/usr/bin/install'))writeFileSync(paths.launchDaemon,'<plist>other</plist>');return r;};
 assert.equal((await applyCorePlan(plan,{world:swapped})).status,'rolled-back');
 assert.match(swapped.warns.join('\n'),/does not hold the plist the plan rendered/);
 // (Before the install the plist there is root's, so the check before anything changes passes.)
 const notRoot=world(t);notRoot.setState(paths.state);let installed=false;const nx=notRoot.exec;
 notRoot.exec=async(cmd,args,o)=>{if(args.at(-1)===paths.launchDaemon&&args.includes('/usr/bin/install'))installed=true;return nx(cmd,args,o);};
 notRoot.fs={...notRoot.fs,stat:f=>({uid:f===paths.launchDaemon&&installed?501:0,mode:0o644,file:true,dir:true})};
 assert.equal((await applyCorePlan(plan,{world:notRoot})).status,'rolled-back');
 assert.match(notRoot.warns.join('\n'),/is not root's, or is writable by others/);
});

test('switching kinds: agent to daemon and back leaves exactly one job; a switch whose first report is not accepted puts the previous kind back',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'macos');
 const agent=planFor('macos',{wait:30},{paths}),daemon=daemonFor({wait:30},{paths});
 const first=world(t);first.setState(paths.state);
 assert.equal((await applyCorePlan(agent,{world:first})).status,'done');
 assert.ok(existsSync(paths.launchAgent)&&!existsSync(paths.launchDaemon));
 // To the daemon: the launchd agent is booted out of gui/501 and its plist removed (the owner's: no sudo).
 const up=world(t);up.setState(paths.state);
 const r=await applyCorePlan(daemon,{world:up});
 assert.equal(r.status,'done');
 assert.ok(!existsSync(paths.launchAgent)&&readFileSync(paths.launchDaemon,'utf8')===daemon.service.text,'one plist: the daemon\'s');
 const calls=callsOf(up,dir);
 assert.ok(calls.includes('/bin/launchctl bootout gui/501/home-hub-agent')&&calls.includes('/usr/bin/sudo /bin/launchctl bootout system/home-hub-agent'));
 assert.ok(calls.indexOf('/bin/launchctl bootout gui/501/home-hub-agent')<calls.findIndex(c=>c.includes('bootstrap')),'the agent is gone before the daemon starts');
 assert.ok(!calls.some(c=>c.startsWith('/bin/launchctl bootstrap gui/')));
 assert.equal(readFileSync(path.join(r.saved,'service','launchd-agent','home-hub-agent.plist'),'utf8'),agent.service.text,'the agent\'s plist is in the backup');
 // And back to the agent kind (no --service): the daemon is booted out and its plist removed with sudo.
 const back=world(t);back.setState(paths.state);
 assert.equal((await applyCorePlan(agent,{world:back})).status,'done');
 assert.ok(existsSync(paths.launchAgent)&&!existsSync(paths.launchDaemon),'one plist: the agent\'s');
 const bcalls=callsOf(back,dir);
 assert.ok(bcalls.includes('/usr/bin/sudo /bin/launchctl bootout system/home-hub-agent')&&bcalls.includes('/usr/bin/sudo /bin/rm -f <T>/root/Library/LaunchDaemons/home-hub-agent.plist'));
 assert.equal(bcalls.at(-1),'/bin/launchctl bootstrap gui/501 <T>/home/Library/LaunchAgents/home-hub-agent.plist');
 // A switch to the daemon that never reports: the daemon's plist goes (sudo rm), the agent's comes back and starts.
 const failed=world(t,{accept:false});failed.setState(paths.state);
 assert.equal((await applyCorePlan(daemon,{world:failed})).status,'rolled-back');
 assert.ok(existsSync(paths.launchAgent)&&!existsSync(paths.launchDaemon));
 assert.equal(readFileSync(paths.launchAgent,'utf8'),agent.service.text);
 const fcalls=callsOf(failed,dir);
 assert.ok(fcalls.includes('/usr/bin/sudo /bin/rm -f <T>/root/Library/LaunchDaemons/home-hub-agent.plist'));
 assert.equal(fcalls.at(-1),'/bin/launchctl bootstrap gui/501 <T>/home/Library/LaunchAgents/home-hub-agent.plist');
 assert.match(failed.warns.join('\n'),/Rolled back: the previous agent was started again \(launchd-agent\)/);
 assert.equal(JSON.parse(readFileSync(path.join(paths.target,AGENT_MANIFEST),'utf8')).service,'launchd-agent','the previous record is back');
 // Now as the daemon for good, then a switch back to the agent that never reports: the daemon comes back, root's.
 const again=world(t);again.setState(paths.state);assert.equal((await applyCorePlan(daemon,{world:again})).status,'done');
 const failedBack=world(t,{accept:false});failedBack.setState(paths.state);
 assert.equal((await applyCorePlan(agent,{world:failedBack})).status,'rolled-back');
 assert.ok(!existsSync(paths.launchAgent)&&readFileSync(paths.launchDaemon,'utf8')===daemon.service.text);
 const gcalls=callsOf(failedBack,dir);
 assert.ok(gcalls.some(c=>/^\/usr\/bin\/sudo \/usr\/bin\/install -m 0644 -o root -g wheel <STAGED>\/home-hub-agent\.plist <T>\/root\/Library\/LaunchDaemons\/home-hub-agent\.plist$/.test(c)),'put back with sudo, root:wheel 0644');
 assert.equal(gcalls.at(-1),'/usr/bin/sudo /bin/launchctl bootstrap system <T>/root/Library/LaunchDaemons/home-hub-agent.plist');
 // A fresh daemon install that never reports leaves no plist of either kind.
 const fresh=pathsIn(path.join(dir,'fresh'),'macos'),none=world(t,{accept:false});none.setState(fresh.state);
 assert.equal((await applyCorePlan(daemonFor({wait:10},{paths:fresh}),{world:none})).status,'rolled-back');
 assert.ok(!existsSync(fresh.launchDaemon)&&!existsSync(fresh.launchAgent)&&!existsSync(fresh.sudoers));
});

// A fake world whose launchctl remembers what is loaded (print answers 0 for a loaded job), and whose commands can be
// made to fail: fail(callText) → an exit code, or null for the fake's own answer.
function loadedWorld(t,{loaded=[],fail=()=>null,accept=true}={}){
 const w=world(t,{accept}),base=w.exec,jobs=new Set(loaded);
 w.jobs=jobs;
 w.exec=async(cmd,args,o)=>{
  const text=[cmd,...args].join(' '),code=fail(text);
  if(code!==null){w.calls.push(text);w.opts.push(o||{});return {code,stdout:'',stderr:'refused'};}
  const [c,a]=cmd==='/usr/bin/sudo'?[args[0],args.slice(1)]:[cmd,args];
  if(c==='/bin/launchctl'&&a[0]==='print'){w.calls.push(text);w.opts.push(o||{});return jobs.has(a[1])?{code:0,stdout:'state = running',stderr:''}:{code:113,stdout:'',stderr:'Could not find service'};}
  if(c==='/bin/launchctl'&&a[0]==='bootout')jobs.delete(a[1]);
  if(c==='/bin/launchctl'&&a[0]==='bootstrap')jobs.add(`${a[1]}/home-hub-agent`);
  return base(cmd,args,o);
 };
 return w;
}

test('switching kinds when the other kind will not go: a bootout that does not take or a plist that cannot be removed is refused and rolled back, never two jobs',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'macos');
 const agent=planFor('macos',{wait:30},{paths}),daemon=daemonFor({wait:30},{paths});
 const asDaemon=async()=>{const w=world(t);w.setState(paths.state);assert.equal((await applyCorePlan(daemon,{world:w})).status,'done');};
 await asDaemon();
 // Daemon → agent with sudo refused for bootout and rm (a declined password): the daemon still runs, so the agent is
 // never started beside it, and nothing of it is touched.
 const sudoNo=loadedWorld(t,{loaded:['system/home-hub-agent'],fail:c=>/^\/usr\/bin\/sudo \/bin\/(launchctl bootout|rm) /.test(c)?1:null});sudoNo.setState(paths.state);
 assert.equal((await applyCorePlan(agent,{world:sudoNo})).status,'rolled-back');
 assert.ok(!existsSync(paths.launchAgent),'no agent plist');assert.equal(readFileSync(paths.launchDaemon,'utf8'),daemon.service.text,'the daemon\'s plist as it was');
 assert.ok(!sudoNo.calls.some(c=>c.includes(' bootstrap ')),'nothing started: the daemon never stopped');
 assert.ok(sudoNo.jobs.has('system/home-hub-agent')&&sudoNo.jobs.size===1,'one job: the daemon');
 assert.match(sudoNo.warns.join('\n'),/system\/home-hub-agent \(the launchd-daemon\) is still loaded .* after bootout \(was sudo refused\?\); the new kind is not started beside it/);
 assert.match(sudoNo.warns.join('\n'),/Rolled back: the previous launchd-daemon was never stopped .* still runs as it was; left: the launchd-daemon plist /);
 assert.equal(JSON.parse(readFileSync(path.join(paths.target,AGENT_MANIFEST),'utf8')).service,'launchd-daemon');
 // Bootout takes but sudo rm does not: refused before the agent starts; the daemon's plist is put back and started.
 const rmNo=loadedWorld(t,{loaded:['system/home-hub-agent'],fail:c=>/^\/usr\/bin\/sudo \/bin\/rm /.test(c)?1:null});rmNo.setState(paths.state);
 assert.equal((await applyCorePlan(agent,{world:rmNo})).status,'rolled-back');
 assert.match(rmNo.warns.join('\n'),/Could not remove .*LaunchDaemons\/home-hub-agent\.plist \(sudo rm -f failed, or the file is still there\)/);
 assert.ok(!rmNo.calls.some(c=>c.startsWith('/bin/launchctl bootstrap gui/')),'the agent never started');
 assert.ok(!existsSync(paths.launchAgent)&&readFileSync(paths.launchDaemon,'utf8')===daemon.service.text);
 assert.equal(rmNo.calls.at(-1).split(dir).join('<T>'),'/usr/bin/sudo /bin/launchctl bootstrap system <T>/root/Library/LaunchDaemons/home-hub-agent.plist');
 assert.deepEqual([...rmNo.jobs],['system/home-hub-agent']);
 assert.match(rmNo.warns.join('\n'),/Rolled back: the previous agent was started again \(launchd-daemon\)/);
 // An rm that says 0 but leaves the file is a failure too.
 const rmLies=loadedWorld(t,{loaded:['system/home-hub-agent'],fail:c=>/^\/usr\/bin\/sudo \/bin\/rm /.test(c)?0:null});rmLies.setState(paths.state);
 assert.equal((await applyCorePlan(agent,{world:rmLies})).status,'rolled-back');
 assert.ok(!existsSync(paths.launchAgent)&&existsSync(paths.launchDaemon));
 // Agent → daemon when the agent's bootout does not take: refused, the agent left running, the daemon never written.
 const back=world(t);back.setState(paths.state);assert.equal((await applyCorePlan(agent,{world:back})).status,'done');
 const guiNo=loadedWorld(t,{loaded:['gui/501/home-hub-agent'],fail:c=>c==='/bin/launchctl bootout gui/501/home-hub-agent'?5:null});guiNo.setState(paths.state);
 assert.equal((await applyCorePlan(daemon,{world:guiNo})).status,'rolled-back');
 assert.equal(readFileSync(paths.launchAgent,'utf8'),agent.service.text);assert.ok(!existsSync(paths.launchDaemon));
 assert.ok(!guiNo.calls.some(c=>c.includes(' bootstrap ')));assert.deepEqual([...guiNo.jobs],['gui/501/home-hub-agent']);
 assert.match(guiNo.warns.join('\n'),/gui\/501\/home-hub-agent \(the launchd-agent\) is still loaded/);
});

test('a switch whose previous kind cannot be put back says so, names what is left and how to start it, and keeps the new kind\'s plist',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'macos');
 const agent=planFor('macos',{wait:30},{paths}),daemon=daemonFor({wait:30},{paths});
 const first=world(t);first.setState(paths.state);assert.equal((await applyCorePlan(daemon,{world:first})).status,'done');
 // Daemon → agent without a GUI session (bootstrap gui/501 fails), and sudo install of the daemon's plist refused.
 const w=loadedWorld(t,{loaded:['system/home-hub-agent'],fail:c=>c.startsWith('/bin/launchctl bootstrap gui/')?5:/^\/usr\/bin\/sudo \/usr\/bin\/install .*LaunchDaemons\/home-hub-agent\.plist$/.test(c)?1:null});
 w.setState(paths.state);
 const r=await applyCorePlan(agent,{world:w});
 assert.equal(r.status,'rolled-back');
 assert.ok(existsSync(paths.launchAgent)&&!existsSync(paths.launchDaemon),'the agent\'s plist is kept: not zero service files');
 const said=w.warns.join('\n');
 assert.doesNotMatch(said,/there was no previous agent/);
 assert.match(said,new RegExp(`the previous launchd-daemon could not be restored; nothing runs\\. Left: the launchd-agent plist ${paths.launchAgent.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')}\\.`));
 const backup=path.join(r.saved,'service','launchd-daemon','home-hub-agent.plist');
 assert.equal(readFileSync(backup,'utf8'),daemon.service.text);
 assert.ok(said.includes(`To start the previous launchd-daemon by hand: sudo install -m 0644 -o root -g wheel '${backup}' ${paths.launchDaemon} && sudo launchctl bootstrap system ${paths.launchDaemon}; and remove the launchd-agent plist: rm -f '${paths.launchAgent}'`),said);
 assert.equal(w.jobs.size,0);
 // A fresh install that fails names the plist it removed (or could not).
 const fresh=pathsIn(path.join(dir,'fresh'),'macos'),none=loadedWorld(t,{accept:false,fail:c=>/^\/usr\/bin\/sudo \/bin\/rm .*LaunchDaemons/.test(c)?1:null});none.setState(fresh.state);
 assert.equal((await applyCorePlan(daemonFor({wait:10},{paths:fresh}),{world:none})).status,'rolled-back');
 assert.match(none.warns.join('\n'),/there was no previous agent; its launchd-daemon plist .*LaunchDaemons\/home-hub-agent\.plist could not be removed/);
});

test('without --service an update keeps the kind the install runs (.agent-install.json); a fresh install and the agent kind are 1.5.0\'s, calls included',async t=>{
 const installed={kind:'core',service:'launchd-daemon'};
 const kept=planFor('macos',{},{user:'alice',installed});
 assert.equal(kept.service.kind,'launchd-daemon');assert.equal(kept.serviceFrom,'install');assert.equal(kept.record.service,'launchd-daemon');
 assert.ok(formatCorePlan(kept).includes('  (no --service: the kind the current install runs, from .agent-install.json; --service launchd-agent switches to the agent kind)'));
 assert.equal(planFor('macos',{service:'launchd-agent'},{user:'alice',installed}).service.kind,'launchd-agent','the flag switches back');
 assert.throws(()=>planFor('macos',{},{installed}),/the one running the installer \(unknown\)/,'the daemon\'s account rule holds for a kept kind too');
 for(const other of [null,{kind:'core',service:'launchd-agent'},{kind:'plugin',service:'launchd-daemon'},{kind:'core',service:'systemd-system'},{kind:'core'}])
  assert.equal(planFor('macos',{},{installed:other}).service.kind,'launchd-agent',JSON.stringify(other));
 assert.equal(planFor('linux',{},{installed}).service.kind,'systemd-system');
 const expected=JSON.parse(readFileSync(path.join(root,'tests','fixtures','agent-install','core-plan.json'),'utf8'));
 assert.deepEqual(corePlanShape(fixturePlan('macos',{},)),expected.macos);
 assert.deepEqual(corePlanShape(planFor('macos',{pins:['AB'.repeat(32)],specs:'/s',runtimes:['ollama=http://127.0.0.1:11434'],keys:'all-accounts'},{specsText:'node|cmd|/opt/homebrew/bin/node|--version|\n',installed:{kind:'core',service:'launchd-agent'}})),expected.macos,'an agent-kind update: 1.5.0\'s plan');
 assert.equal(readInstallRecord(null),null);assert.equal(readInstallRecord('{'),null);assert.equal(readInstallRecord('[1]'),null);assert.deepEqual(readInstallRecord(Buffer.from('{"kind":"core"}')),{kind:'core'});
 // The agent kind with no daemon plist and no daemon record runs exactly 1.5.0's commands: nothing in the system domain.
 const dir=temp(t),paths=pathsIn(dir,'macos'),w=world(t);w.setState(paths.state);
 assert.equal((await applyCorePlan(planFor('macos',{wait:30},{paths}),{world:w})).status,'done');
 assert.deepEqual(callsOf(w,dir),['/usr/sbin/visudo -cf <STAGED>/home-hub-agent','/usr/bin/sudo /usr/bin/install -m 0440 -o root -g wheel <STAGED>/home-hub-agent <T>/root/etc/sudoers.d/home-hub-agent',
  '/bin/launchctl bootout gui/501/home-hub-agent','/bin/launchctl print gui/501/home-hub-agent','/bin/launchctl bootstrap gui/501 <T>/home/Library/LaunchAgents/home-hub-agent.plist']);
});

test('the launchd daemon refuses a node, copy or plist directory another account could change, before anything runs; --once runs as the daemon would',async t=>{
 const dir=temp(t),paths=pathsIn(dir,'macos'),plan=daemonFor({wait:30},{paths});
 const node=plan.node,nodeDir=path.dirname(node);
 const cases=[[nodeDir,{uid:502,gid:20,mode:0o755},/can be changed by an account other than root, the owner or an administrator/],
  [nodeDir,{uid:501,gid:20,mode:0o775},/can be changed by an account other than root/],
  [path.dirname(paths.target),{uid:0,gid:0,mode:0o777},/can be changed by an account other than root/],
  [path.dirname(paths.launchDaemon),{uid:501,gid:20,mode:0o755},/is not root-owned or is writable by others: the launchd daemon's plist/]];
 for(const [where,stat,why] of cases){
  const w=world(t);w.fs={...w.fs,realpath:f=>f,stat:f=>f===where?{...stat,file:true,dir:true}:{uid:0,gid:0,mode:0o755,file:true,dir:true}};
  await assert.rejects(applyCorePlan(plan,{world:w}),why,where);
  assert.deepEqual(w.calls,[],'nothing ran');
 }
 // Homebrew's own layout passes: the owner's, group admin may write (an administrator can become root anyway).
 const brew=world(t);brew.setState(paths.state);brew.fs={...brew.fs,realpath:f=>f,stat:f=>f===nodeDir?{uid:501,gid:80,mode:0o775,file:false,dir:true}:{uid:0,gid:0,mode:0o755,file:true,dir:true}};
 assert.equal((await applyCorePlan(plan,{world:brew})).status,'done');
 // Where node is a link, its target is checked too.
 const linked=world(t);linked.fs={...linked.fs,realpath:()=>'/opt/x/Cellar/node/1/bin/node',stat:f=>f==='/opt/x/Cellar'?{uid:502,gid:20,mode:0o755,dir:true}:{uid:0,gid:0,mode:0o755,file:true,dir:true}};
 await assert.rejects(applyCorePlan(plan,{world:linked}),/\/opt\/x\/Cellar can be changed/);
 // --once: the copy run once with the daemon's HOME_HUB_LAUNCHD_DOMAIN; nothing installed.
 const fresh=pathsIn(path.join(dir,'once'),'macos'),once=world(t);
 assert.equal((await applyCorePlan(daemonFor({},{paths:fresh}),{world:once,once:true})).status,'once');
 assert.deepEqual(once.opts[0].env,{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',HOME:'/Users/alice',HOME_HUB_LAUNCHD_DOMAIN:'gui/501'});
 assert.ok(!existsSync(fresh.launchDaemon)&&!existsSync(fresh.target),'nothing installed');
});

test('a plugin\'s host agent: the plan is exactly what it was before the core entry existed',async t=>{
 const expected=JSON.parse(readFileSync(path.join(root,'tests','fixtures','agent-install','plugin-plan.json'),'utf8'));
 const dir=temp(t),plugin=path.join(dir,'plugins','relay');
 put(path.join(plugin,'index.mjs'),`export default {id:'relay',title:'Relay'};`);
 put(path.join(plugin,'plugin.json'),JSON.stringify({id:'relay',version:'2.3.0',core:'*',hostAgents:[{id:'agent',title:'Relay agent',entry:'scripts/agent.mjs',service:'systemd-user',health:{socket:'private/a.sock',get:'/status'},config:'server/agent-config.mjs'}]}));
 put(path.join(plugin,'server','agent-config.mjs'),`export default ({site,device})=>({greeting:site.plugins.relay.greeting,device});`);
 put(path.join(plugin,'scripts','agent.mjs'),`import {CORE_VERSION} from 'home-hub/plugin-api';console.log(CORE_VERSION);`);
 const target=path.join(dir,'agent'),home=path.join(dir,'home');
 const site=validateSite({devices:[{id:'box',name:'Box',hostname:'box.example.lan'}],plugins:{relay:{greeting:'hello',agents:{agent:{box:{target,label:'com.example.relay-agent',node:'/opt/node/bin/node',env:{RELAY_MODE:'test'}}}}}}});
 const p=await planInstall({plugin:'relay',agent:'agent',site,directories:[path.join(dir,'plugins')],allowDirty:true,env:{},hostname:'box',stateHome:home,serviceHome:home,backups:path.join(dir,'b'),root});
 const norm=s=>String(s).split(dir).join('<T>').split(root).join('<CORE>');
 assert.deepEqual({lines:formatPlan(p).map(l=>norm(l).replace(/commits core [0-9a-f?]+/,'commits core <C>').replace(/\(core [^;]+;/,'(core <V>;').replace(/, dirty\) for /,') for ')),service:norm(p.service.text),file:norm(p.service.file),files:p.files.map(f=>f.to),config:norm(p.config.text)},expected);
 // Whether the copied files have uncommitted changes depends on the checkout the test runs in (a release run has
 // its version bump in package.json), so the first line is compared without the marker and the flag is checked here.
 assert.equal(typeof p.record.dirty,'boolean');
 assert.ok(!readdirSync(dir).includes('root'));
});
