// The push agent's process (scripts/agent/; docs/agent.md §5, §6): agent.json and specs.txt are checked at every start
// and a hostile watch list stops the agent before anything runs; the probes run as files with a fixed environment
// (stub commands on a temp PATH, never real sudo); every line is checked before it is sent; the send loop batches,
// backs off and honours 429/Retry-After and 401; and nothing in the hub's answer beyond its status, Retry-After and
// acknowledgement changes what the agent does. The loop runs against a real HTTPS server on 127.0.0.1 and once
// against a real hub over http://127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgent,runAgent,parseArgs,prepare,renderStatus,nextBackoff,jittered,launchdDomainOf,EXIT_CONFIG,AGENT_TIMING} from '../scripts/agent/agent.mjs';
import {parseConfig,specsPathErrors} from '../scripts/agent/config.mjs';
import {runCommand,cleanPart,collectSystems,collectSshKeys,probeEnv,specsDigest,PROBE_PATH} from '../scripts/agent/probes.mjs';
import {readRuntimes} from '../scripts/agent/runtimes.mjs';
import {PRIVILEGED} from '../server/agent-privileged.mjs';
import {validateReport} from '../server/agent-report.mjs';
import {RUNTIME_KINDS} from '../server/runtime-kinds.mjs';
import {RUNTIME_KINDS as SITE_RUNTIME_KINDS} from '../server/site-config.mjs';
import {hub} from './hub-helper.mjs';
import {issueAgent} from './support/agent.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fx=n=>readFileSync(path.join(root,'tests','fixtures',n),'utf8');
const [cert,key]=['tls-test.crt','tls-test.key'].map(fx);
const pin=createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
const temp=t=>{const d=realpathSync(mkdtempSync(path.join(os.tmpdir(),'hub-agent-proc-')));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
const put=(file,body,mode=0o644)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,body);chmodSync(file,mode);};
const T='\t',rec=(...f)=>f.join(T);
const TOKEN='hha_'+'d'.repeat(64);
// What mac-probe.sh prints in narrow-sudo mode without any sudo rule (a placeholder device), plus one secret-looking line.
const MAC_PROBE=[rec('HOST','studio','Darwin','alice','0','2026-11-13T10:00:00Z'),rec('OS','macOS','26.1','25B78','25.1.0','arm64'),rec('HW','Mac16,9','Apple M4 Max','68719476736','16'),
 rec('UPTIME','1793800000'),rec('SWU_NONE'),rec('AUTO','AutomaticCheckEnabled','1'),rec('FW','global','1'),rec('PRIV','pf-info','denied'),rec('PRIV','pf-rules','denied'),rec('PF','unknown'),
 rec('FV','FileVault is On.'),rec('SSHD','remotelogin','off'),rec('PRIV','sshd','denied'),rec('SSHD','effective','unknown'),rec('PRIV','listen','denied'),rec('LISTEN','?','?','*.22'),
 rec('SW','node','cmd','v22.13.0','/opt/homebrew/bin/node'),rec('SW','leaky','cmd',`token ${'hha_'+'e'.repeat(64)}`,'/opt/x'),rec('BREWOUT','jq','1.7','1.7.1'),
 rec('DOCKER','web','nginx:1.27','Up 2 hours','2026-11-01T00:00:00Z'),rec('END','ok')].join('\n')+'\n';
const CONFIG=(extra={})=>JSON.stringify({schema:1,hub:'https://localhost:1',trust:{pins:[pin]},...extra});
// A fake exec: the systems probe answers MAC_PROBE, anything else nothing; every call is recorded.
function fakeExec(stdout=MAC_PROBE){const calls=[];const exec=async(cmd,args,opts)=>{calls.push({cmd,args,env:opts?.env});return {code:0,stdout,stderr:'',timedOut:false};};exec.calls=calls;return exec;}

test('agent.json: closed, checked at start; keys per platform; runtimes on loopback only',()=>{
 const ok=(v,platform='macos')=>parseConfig(JSON.stringify(v),{platform});
 const base={schema:1,hub:'https://hub.example.lan'};
 const mac=ok(base).config,linux=ok(base,'linux').config;
 assert.equal(mac.keys,'own');assert.equal(linux.keys,'off');assert.equal(mac.intervals.heartbeat,60);assert.equal(mac.intervals.os,21600);assert.equal(mac.intervals.packages,21600);
 assert.equal(ok({...base,keys:'own'},'linux').ok,false,'own means nothing for a system account');
 assert.equal(ok({...base,device:'mini'}).ok,false,'no device: the key says it');
 assert.equal(ok({...base,schema:2}).ok,false);assert.equal(ok({...base,intervals:{heartbeat:10}}).ok,false);assert.equal(ok({...base,intervals:{os:900,updates:1000}}).ok,false);
 assert.equal(ok({...base,intervals:{os:900}}).config.intervals.updates,900);
 assert.deepEqual(ok({...base,runtimes:[{id:'ollama',kind:'ollama',url:'http://127.0.0.1:11434/'}]}).config.runtimes,[{id:'ollama',kind:'ollama',url:'http://127.0.0.1:11434'}]);
 for(const url of ['http://10.0.0.5:11434','http://localhost:11434','http://127.0.0.1:11434/v1'])assert.equal(ok({...base,runtimes:[{id:'x',kind:'auto',url}]}).ok,false,url);
 assert.equal(parseConfig('{',{platform:'macos'}).ok,false);assert.equal(parseConfig(JSON.stringify(base),{platform:'windows'}).ok,false);
 assert.deepEqual(RUNTIME_KINDS,SITE_RUNTIME_KINDS,'the leaf copy of the runtime kinds is the site\'s');
 assert.deepEqual(parseArgs(['--config','/c','--once','--send']),{config:'/c',state:null,key:null,once:true,send:true,help:false});
 for(const bad of [['--config','rel'],['--send','--config','/c'],['--config','/c','--token','x'],[]])assert.ok(parseArgs(bad).error,bad.join(' '));
});

test('a hostile specs.txt stops the agent before anything runs (status lastError specs-invalid)',async t=>{
 const dir=temp(t);
 for(const bad of ['x|cmd|/bin/sh|-c id|\n','x|cmd|/usr/bin/$(id)|--version|\n','x|cmd|/usr/bin/`id`|--version|\n','x|json|/etc/a;id||\n','x|cmd|/usr/bin/node|--version|lab;el\n','x|brew|node||\nno newline',
  'x|cmd|/nonexist xprobe*|--version|\n','x|cmd|/tmp/*|--version|\n']){
  put(path.join(dir,'config','agent.json'),CONFIG());put(path.join(dir,'config','specs.txt'),bad);put(path.join(dir,'key'),TOKEN);
  const exec=fakeExec(),statuses=[],errs=[];
  const code=await runAgent(['--config',path.join(dir,'config'),'--state',path.join(dir,'state'),'--key',path.join(dir,'key')],{root,platform:'macos',env:{},
   writeStatusTo:()=>text=>statuses.push(JSON.parse(text)),err:m=>errs.push(m),out:()=>{},world:{exec,request:async()=>{throw new Error('no request may be made');}},loop:async()=>{throw new Error('the loop must not start');}});
  assert.equal(code,EXIT_CONFIG,JSON.stringify(bad));
  assert.equal(exec.calls.length,0,'no probe ran');
  assert.equal(statuses.at(-1).lastError,'specs-invalid');assert.match(errs[0],/^specs-invalid: line [01]: /);
 }
 // A good list passes; a missing file or a bad agent.json stops it too.
 put(path.join(dir,'config','specs.txt'),'node|cmd|/opt/homebrew/bin/node|--version|\n');
 assert.equal(prepare({args:{config:path.join(dir,'config'),key:path.join(dir,'key'),once:false},platform:'macos',env:{},root}).ok,true);
 assert.equal(prepare({args:{config:path.join(dir,'nothing'),once:true},platform:'macos',env:{},root}).error,'config-invalid');
 put(path.join(dir,'config','agent.json'),CONFIG({trust:{insecure:true}}));
 assert.equal(prepare({args:{config:path.join(dir,'config'),once:true},platform:'macos',env:{},root}).error,'config-invalid');
 // The key: --key when given; else, on Linux only, systemd's credential; never required for a dry --once.
 put(path.join(dir,'config','agent.json'),CONFIG());put(path.join(dir,'creds','agent-key'),TOKEN+'\n');
 const viaCredential=prepare({args:{config:path.join(dir,'config'),key:null,once:false},platform:'linux',env:{CREDENTIALS_DIRECTORY:path.join(dir,'creds')},root});
 assert.equal(viaCredential.setup.token,TOKEN);
 const other='hha_'+'7'.repeat(64);put(path.join(dir,'other-key'),other+'\n');
 assert.equal(prepare({args:{config:path.join(dir,'config'),key:path.join(dir,'other-key'),once:false},platform:'linux',env:{CREDENTIALS_DIRECTORY:path.join(dir,'creds')},root}).setup.token,other,'--key wins over a credential');
 assert.equal(prepare({args:{config:path.join(dir,'config'),key:path.join(dir,'other-key'),once:true,send:true},platform:'macos',env:{CREDENTIALS_DIRECTORY:path.join(dir,'creds')},root}).setup.token,other,'a stray CREDENTIALS_DIRECTORY never swaps the key');
 assert.equal(prepare({args:{config:path.join(dir,'config'),key:null,once:false},platform:'macos',env:{CREDENTIALS_DIRECTORY:path.join(dir,'creds')},root}).error,'key-missing','no credential directory on macOS');
 assert.equal(prepare({args:{config:path.join(dir,'config'),key:null,once:true,send:false},platform:'macos',env:{},root}).setup.token,null);
 put(path.join(dir,'bad-key'),'hhk_'+'d'.repeat(64));
 assert.equal(prepare({args:{config:path.join(dir,'config'),key:path.join(dir,'bad-key'),once:false},platform:'macos',env:{},root}).error,'key-invalid');
});

test('the probe runner: a file under /bin/sh with a fixed environment; stub commands on a temp PATH; no shell text is built',async t=>{
 const dir=temp(t),bin=path.join(dir,'bin');
 put(path.join(bin,'hello'),'#!/bin/sh\nprintf "PATH=%s SPECS=%s NARROW=%s AGENT=%s\\n" "$PATH" "$SPECS" "$HOME_HUB_NARROW_SUDO" "${HOME_HUB_AGENT_SECRET:-}"\n',0o755);
 const env={...probeEnv({platform:'macos',home:'/Users/alice',specs:'a|cmd|/x|--version|\n',probePath:bin})};
 assert.deepEqual(Object.keys(env).sort(),['HOME','HOME_HUB_NARROW_SUDO','LC_ALL','PATH','SPECS']);
 assert.equal(probeEnv({platform:'linux',home:'',specs:''}).PATH,PROBE_PATH.linux);
 const r=await runCommand('/bin/sh',['-c','hello'],{env});
 assert.equal(r.stdout,`PATH=${bin} SPECS=a|cmd|/x|--version|\n NARROW=1 AGENT=\n`,'only the fixed environment: nothing of the agent\'s own');
 const slow=await runCommand('/bin/sh',['-c','/bin/sleep 5'],{env,timeoutMs:100});assert.equal(slow.timedOut,true);
 const big=await runCommand('/bin/sh',['-c','/usr/bin/yes x'],{env,maxBytes:1000,timeoutMs:5000});assert.ok(big.stdout.length<=1000);
 // collectSystems runs the platform's probe file and nothing else.
 const exec=fakeExec();
 const sys=await collectSystems({root:'/agent',platform:'macos',home:'/Users/alice',specsText:'',interval:21600,exec,now:()=>new Date('2026-11-13T10:00:05Z')});
 assert.equal(sys.ok,true);
 assert.deepEqual(exec.calls.map(c=>[c.cmd,c.args]),[['/bin/sh',['/agent/scripts/systems/mac-probe.sh']]]);
 assert.equal(exec.calls[0].env.HOME_HUB_NARROW_SUDO,'1');
 assert.deepEqual([sys.parts.os.collectedAt,sys.parts.updates.collectedAt,sys.parts.packages.interval],['2026-11-13T10:00:05.000Z','2026-11-13T10:00:05.000Z',21600]);
 assert.equal(sys.parts.packages.records.at(-1),`SPECS${T}${specsDigest('')}`);
 assert.deepEqual(sys.parts.packages.withheld,[{tag:'SW',field:3,reason:'secret',count:1}],'the line goes, the part stays');
 assert.ok(!JSON.stringify(sys.parts).includes('hha_'));
 assert.deepEqual(sys.parts.updates.records,[rec('SWU_NONE'),rec('BREWOUT','jq','1.7','1.7.1')]);
 const v=validateReport({v:1,agentVersion:'1.4.0',platform:'macos',sentAt:'2026-11-13T10:00:06Z',parts:sys.parts});
 assert.deepEqual([v.ok,Object.keys(v.parts),v.refused],[true,['os','updates','packages'],[]]);
 // A probe that does not finish (no END ok, or a HOST of another platform) gives no systems parts at all.
 assert.equal((await collectSystems({root:'/agent',platform:'macos',home:'/h',specsText:'',interval:900,exec:fakeExec(MAC_PROBE.replace('END\tok\n',''))})).error,'probe-incomplete');
 assert.equal((await collectSystems({root:'/agent',platform:'linux',home:'/h',specsText:'',interval:900,exec:fakeExec()})).error,'probe-incomplete');
 // The SSH key probe: own runs the copy beside the agent; all-accounts its root-owned copy through the one sudo rule.
 const keys=fakeExec([rec('HOST','studio','Darwin','alice','0','2026-11-13T10:00:00Z'),rec('LISTEN','on'),rec('END','ok')].join('\n'));
 assert.equal((await collectSshKeys({root:'/agent',platform:'macos',home:'/h',keys:'own',interval:21600,exec:keys})).ok,true);
 await collectSshKeys({root:'/agent',platform:'macos',home:'/h',keys:'all-accounts',interval:21600,exec:keys});
 assert.deepEqual(keys.calls.map(c=>[c.cmd,...c.args]),[['/bin/sh','/agent/scripts/security/ssh-probe.sh'],['/usr/bin/sudo','-n',...PRIVILEGED.macos.find(e=>e.id==='ssh-probe').argv]]);
 assert.equal((await collectSshKeys({root:'/agent',platform:'linux',home:'/h',keys:'off',interval:21600,exec:keys})).error,'off');
});

test('cleanPart: a secret, a long line, a wrong field count or an unknown tag is withheld and counted, never sent',()=>{
 const {records,withheld}=cleanPart('packages',[rec('SW','a','cmd','1.0','/x'),rec('SW','b','cmd','x'.repeat(5000),'/y'),rec('RUN','a','loaded'),rec('NOPE','x'),rec('SW','c','cmd',`k ${'hha_'+'0'.repeat(64)}`,'/z'),rec('SW','d','cmd',`k ${'hha_'+'1'.repeat(64)}`,'/z')],'macos');
 assert.deepEqual(records,[rec('SW','a','cmd','1.0','/x')]);
 assert.deepEqual(withheld,[{tag:'SW',field:0,reason:'long',count:1},{tag:'RUN',field:0,reason:'invalid',count:1},{tag:'NOPE',field:0,reason:'invalid',count:1},{tag:'SW',field:3,reason:'secret',count:2}]);
});

// Wrappers of the plain text tools in a stub directory: a probe run with only this directory on PATH reaches no other
// tool of the host (no sudo, service manager, package manager or docker).
const TEXT_TOOLS=['tr','sed','awk','grep','head','tail','sort','cut','date','id','cat','printf','env','uname','hostname','wc','ls','stat','basename','dirname','test','find','xargs'];
function stubTools(bin){
 for(const tool of TEXT_TOOLS)
  for(const where of ['/usr/bin','/bin'])if(existsSync(path.join(where,tool))){put(path.join(bin,tool),`#!/bin/sh\nexec ${path.join(where,tool)} "$@"\n`,0o755);break;}
}
// A copy of mac-probe.sh that reaches nothing of the host by an absolute path either: its PATH, BREW_PATH, the
// firewall tool and the Homebrew prefix point into the temp directory (where they do not exist, unless a test puts a stub).
function stubbedMacProbe(dir,bin){
 const probe=readFileSync(path.join(root,'scripts','systems','mac-probe.sh'),'utf8').replace(/^PATH=.*$/m,`PATH=${bin}`).replace(/^BREW_PATH=.*$/m,`BREW_PATH=${bin}`)
  .replace(/^FWB=.*$/m,`FWB=${bin}/socketfilterfw`).replaceAll('/opt/homebrew',path.join(dir,'homebrew'));
 assert.ok(!/\nPATH=\/usr/.test(probe)&&!probe.includes('/opt/homebrew')&&!probe.includes('/usr/libexec/'));
 const file=path.join(dir,'agent','scripts','systems','mac-probe.sh');put(file,probe);stubTools(bin);
 return file;
}

test('mac-probe.sh in narrow-sudo mode: one sudo -n per line of the privileged list, PRIV denied without rules, root 0, never sudo -n true',async t=>{
 const dir=temp(t),bin=path.join(dir,'bin'),log=path.join(dir,'sudo.log');
 // The probe sets its own PATH; this copy of it gets the stub directory instead, so no real sudo is ever reached.
 stubbedMacProbe(dir,bin);
 const stubSudo=body=>put(path.join(bin,'sudo'),`#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n${body}\n`,0o755);
 stubSudo('exit 1');
 const run=async()=>{rmSync(log,{force:true});const r=await collectSystems({root:path.join(dir,'agent'),platform:'macos',home:dir,specsText:'',interval:21600,probePath:bin});
  return {r,sudo:existsSync(log)?readFileSync(log,'utf8').trim().split('\n'):[]};};
 const denied=await run();
 assert.equal(denied.r.ok,true,denied.r.error);
 const os_=denied.r.parts.os.records;
 assert.deepEqual(os_.filter(l=>l.startsWith('PRIV')),['pf-info','pf-rules','sshd','listen'].map(id=>rec('PRIV',id,'denied')));
 assert.equal(os_[0].split(T)[4],'0','HOST root stays 0');
 assert.ok(os_.includes(rec('SSHD','effective','unknown'))&&os_.includes(rec('PF','unknown')));
 const lines=e=>`-n ${e.argv.join(' ')}`;
 assert.deepEqual(denied.sudo,[lines(PRIVILEGED.macos[0]),lines(PRIVILEGED.macos[3]),lines(PRIVILEGED.macos[2])],'pf-info, sshd, listen; pf-rules only after pf-info');
 assert.ok(!denied.sudo.includes('-n true'));
 // With every rule in place (the stub answers as the tool would), each read is ok.
 stubSudo(`case "$2" in /sbin/pfctl) [ "$4" = info ] && echo "Status: Enabled" || printf 'pass all\\nblock in\\n';; /usr/sbin/sshd) echo "passwordauthentication no";; /usr/sbin/lsof) printf 'COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\\nsshd 1 root 3u IPv4 0 0t0 TCP *:22 (LISTEN)\\n';; *) exit 1;; esac`);
 const granted=await run();
 assert.deepEqual(granted.r.parts.os.records.filter(l=>l.startsWith('PRIV')),['pf-info','pf-rules','sshd','listen'].map(id=>rec('PRIV',id,'ok')));
 assert.ok(granted.r.parts.os.records.includes(rec('PF','Enabled','2')));assert.ok(granted.r.parts.os.records.includes(rec('SSHD','passwordauthentication','no')));
 assert.equal(granted.sudo.length,4);
});

test('linux-probe.sh through the agent: its privileged reads go through sudo -n with the listed full paths only',async t=>{
 const dir=temp(t),bin=path.join(dir,'bin'),log=path.join(dir,'sudo.log');
 // Only stubs on PATH: the host's systemctl, apt, dnf, docker, ss or nft are never reached, so the result is the same
 // on every device (linux-probe.sh calls its other tools by name; its privileged ones only through the sudo stub).
 stubTools(bin);
 put(path.join(bin,'timeout'),'#!/bin/sh\nshift\nexec "$@"\n',0o755);
 put(path.join(bin,'sudo'),`#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexit 1\n`,0o755);
 const exec=async(cmd,args,o)=>{assert.equal(o.env.PATH,bin);return runCommand(cmd,args,o);};
 const r=await collectSystems({root,platform:'linux',home:dir,specsText:'',interval:21600,probePath:bin,exec});
 const sudo=existsSync(log)?readFileSync(log,'utf8').trim().split('\n'):[];
 const listed=new Set(PRIVILEGED.linux.filter(e=>e.only!=='all-accounts').map(e=>`-n ${e.argv.join(' ')}`));
 assert.ok(sudo.length>=3&&sudo.every(l=>listed.has(l)),sudo.join('\n'));
 assert.equal(r.ok,true,r.error);
 assert.deepEqual(r.parts.os.records.filter(l=>l.startsWith('PRIV')).sort(),['listen','nft','sshd'].map(id=>rec('PRIV',id,'denied')).sort());
});

test('mac-probe.sh watch-list globs: a space never splits a pattern into a relative one; a path with a space is one candidate',async t=>{
 const dir=temp(t),bin=path.join(dir,'bin'),cwd=path.join(dir,'cwd');
 const file=stubbedMacProbe(dir,bin);
 put(path.join(dir,'sp ace','xprobe-1'),'#!/bin/sh\necho v1\n',0o755);put(path.join(dir,'sp ace','python3.12','site-packages','foo-2.0.dist-info','METADATA'),'');
 // What a pattern split at its space would find: a file in the probe's working directory.
 put(path.join(cwd,'xprobe-evil'),'#!/bin/sh\necho evil\n',0o755);
 put(path.join(bin,'sudo'),'#!/bin/sh\nexit 1\n',0o755);
 const specs=[`x|cmd|${dir}/sp ace/xprobe*|--version|`,`y|cmd|/nonexist xprobe*|--version|`,`p|pydist|${dir}/sp ace/python3.*/site-packages|foo|`,`q|pydist|${dir}/sp ace|foo|`].join('\n')+'\n';
 const r=await runCommand('/bin/sh',[file],{env:probeEnv({platform:'macos',home:dir,specs,probePath:bin}),cwd});
 const sw=r.stdout.split('\n').filter(l=>l.startsWith('SW\t'));
 assert.ok(!r.stdout.includes('xprobe-evil'),sw.join('\n'));
 // (The version field is whatever the stub PATH gives: perl, which runs the binary, is not on it.)
 assert.ok(sw.some(l=>{const f=l.split(T);return f[1]==='x'&&f[2]==='cmd'&&f[4]===`${dir}/sp ace/xprobe-1`;}),sw.join('\n'));
 assert.equal(sw.filter(l=>l.split(T)[1]==='x').length,1,'one candidate');
 assert.ok(sw.includes(rec('SW','y','missing','','/nonexist xprobe*')));
 assert.ok(sw.includes(rec('SW','p','pydist','2.0',`${dir}/sp ace/python3.12/site-packages`)),sw.join('\n'));
 assert.ok(sw.includes(rec('SW','q','missing','',`${dir}/sp ace`)),'a path with a space and no glob is one path');
 // And the agent refuses such lines before any probe runs: a space in a glob, a binary any account can write.
 assert.deepEqual(specsPathErrors(specs).map(e=>e.line),[1,2,3]);
 assert.deepEqual(specsPathErrors('a|cmd|/tmp/*|--version|\nb|cmd|/Users/Shared/x|--version|\nc|cmd|/opt/x|--version|\nd|json|/tmp/x.json||\ne|cmd|/TMP/./x|--version|\n').map(e=>e.line),[1,2,5]);
});

test('the launchd daemon: HOME_HUB_LAUNCHD_DOMAIN reaches the probe only as this account\'s own gui/<uid>, on macOS; unset, the environment is as before',async t=>{
 assert.equal(launchdDomainOf({env:{HOME_HUB_LAUNCHD_DOMAIN:'gui/501'},platform:'macos',uid:501}),'gui/501');
 for(const [env,platform,uid] of [[{HOME_HUB_LAUNCHD_DOMAIN:'gui/502'},'macos',501],[{HOME_HUB_LAUNCHD_DOMAIN:'system'},'macos',501],[{HOME_HUB_LAUNCHD_DOMAIN:'gui/501'},'linux',501],
  [{HOME_HUB_LAUNCHD_DOMAIN:'gui/501/x'},'macos',501],[{},'macos',501],[{HOME_HUB_LAUNCHD_DOMAIN:'gui/null'},'macos',null]])
  assert.equal(launchdDomainOf({env,platform,uid}),null,JSON.stringify([env,platform,uid]));
 assert.deepEqual(Object.keys(probeEnv({platform:'macos',home:'/Users/alice',specs:'',launchdDomain:'gui/501'})).sort(),['HOME','HOME_HUB_LAUNCHD_DOMAIN','HOME_HUB_NARROW_SUDO','LC_ALL','PATH','SPECS']);
 // Through the agent: the plist's variable is passed to the systems probe (and only there), never to ssh-probe.sh.
 const dir=temp(t);
 put(path.join(dir,'config','agent.json'),CONFIG({keys:'own'}));put(path.join(dir,'config','specs.txt'),'');
 for(const [env,expected] of [[{HOME:'/Users/alice',HOME_HUB_LAUNCHD_DOMAIN:'gui/501'},'gui/501'],[{HOME:'/Users/alice'},undefined],[{HOME:'/Users/alice',HOME_HUB_LAUNCHD_DOMAIN:'gui/0'},undefined]]){
  const exec=fakeExec();
  await runAgent(['--config',path.join(dir,'config'),'--once'],{root,platform:'macos',env,uid:501,out:()=>{},err:()=>{},world:{exec}});
  const systems=exec.calls.find(c=>c.args[0].endsWith('mac-probe.sh')),keys=exec.calls.find(c=>c.args[0].endsWith('ssh-probe.sh'));
  assert.equal(systems.env.HOME_HUB_LAUNCHD_DOMAIN,expected,JSON.stringify(env));
  assert.ok(keys&&!('HOME_HUB_LAUNCHD_DOMAIN' in keys.env));
 }
});

test('mac-probe.sh RUN as the launchd daemon: the owner\'s agents read in gui/<uid> while that domain exists; without a login session no RUN record, never a wrong absent',async t=>{
 const dir=temp(t),bin=path.join(dir,'bin'),log=path.join(dir,'launchctl.log'),up=path.join(dir,'gui-up');
 const file=stubbedMacProbe(dir,bin);
 put(path.join(bin,'sudo'),'#!/bin/sh\nexit 1\n',0o755);
 const uid=process.getuid();
 // A launchctl that knows the owner's GUI domain only while the file gui-up exists (a login session), one running
 // agent, one loaded and idle, one it refuses to print (exit 1), and one system daemon; anything else is not found
 // (113), as launchctl answers.
 put(path.join(bin,'launchctl'),`#!/bin/sh
printf '%s\\n' "$*" >> ${log}
case "$1 $2" in
 "print gui/${uid}") [ -e ${up} ] && { echo "gui/${uid} = {"; exit 0; }; echo "Could not find domain"; exit 113;;
 "print gui/${uid}/com.example.up") [ -e ${up} ] && { printf '\\tstate = running\\n\\tpid = 4242\\n'; exit 0; }; exit 113;;
 "print gui/${uid}/com.example.idle") [ -e ${up} ] && { printf '\\tstate = not running\\n'; exit 0; }; exit 113;;
 "print gui/${uid}/com.example.denied") echo "Operation not permitted"; exit 1;;
 "print system/com.example.daemon") printf '\\tpid = 77\\n'; exit 0;;
 "list com.example.up") printf '{\\n\\t"PID" = 4242;\\n};\\n'; exit 0;;
esac
exit 113
`,0o755);
 const specs=['up|cmd|/nonexist/up|--version|com.example.up','idle|cmd|/nonexist/idle|--version|com.example.idle','gone|cmd|/nonexist/gone|--version|com.example.gone',
  'daemon|cmd|/nonexist/d|--version|system/com.example.daemon'].join('\n')+'\n';
 const run=async(launchdDomain,list=specs)=>{rmSync(log,{force:true});const r=await runCommand('/bin/sh',[file],{env:probeEnv({platform:'macos',home:dir,specs:list,probePath:bin,launchdDomain})});
  return {run:r.stdout.split('\n').filter(l=>l.startsWith('RUN\t')),calls:existsSync(log)?readFileSync(log,'utf8').trim().split('\n'):[]};};
 put(up,'');
 const session=await run(`gui/${uid}`);
 assert.deepEqual(session.run,[rec('RUN','up','4242','com.example.up'),rec('RUN','idle','loaded','com.example.idle'),rec('RUN','gone','absent','com.example.gone'),rec('RUN','daemon','77','system/com.example.daemon')]);
 assert.ok(!session.calls.some(c=>c.startsWith('list')),'never launchctl list as the daemon');
 assert.equal(session.calls.filter(c=>c===`print gui/${uid}`).length,1,'the domain is looked up once');
 // Only 113 (not found) is absent: a print that fails otherwise (refused) says nothing of the agent, so no RUN record.
 const refused=await run(`gui/${uid}`,'denied|cmd|/nonexist/x|--version|com.example.denied\ngone|cmd|/nonexist/gone|--version|com.example.gone\n');
 assert.ok(refused.calls.includes(`print gui/${uid}/com.example.denied`));
 assert.deepEqual(refused.run,[rec('RUN','gone','absent','com.example.gone')],'refused: unknown, never a wrong absent');
 rmSync(up);
 const boot=await run(`gui/${uid}`);
 assert.deepEqual(boot.run,[rec('RUN','daemon','77','system/com.example.daemon')],'no login session: the owner\'s agents are unknown, the system daemon is read');
 assert.ok(!boot.calls.some(c=>c.startsWith(`print gui/${uid}/`)));
 // Unset (the launchd agent, the collector over SSH) or another account's domain: launchctl list, as before.
 for(const domain of [null,`gui/${uid+1}`,'gui/x1']){
  const before=await run(domain);
  assert.deepEqual(before.run,[rec('RUN','up','4242','com.example.up'),rec('RUN','idle','absent','com.example.idle'),rec('RUN','gone','absent','com.example.gone'),rec('RUN','daemon','77','system/com.example.daemon')],String(domain));
  assert.ok(before.calls.includes('list com.example.up')&&!before.calls.some(c=>c.startsWith('print gui/')),String(domain));
 }
});

test('ssh-probe.sh: with HOME_HUB_NARROW_SUDO=1 nothing runs through sudo even where sudo -n works; as root its PATH holds system directories only',async t=>{
 const dir=temp(t),bin=path.join(dir,'bin'),log=path.join(dir,'sudo.log');
 const source=readFileSync(path.join(root,'scripts','security','ssh-probe.sh'),'utf8');
 // Root never gets a directory an account may own (/usr/local/bin, /opt/homebrew/bin on macOS) on its PATH.
 assert.match(source,/^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
 assert.match(source,/^if \[ "\$\(\/usr\/bin\/id -u\)" != 0 \]; then PATH=\$PATH:\/usr\/local\/bin:\/opt\/homebrew\/bin; fi$/m);
 assert.ok(source.split('\n').filter(l=>/^\s*PATH=/.test(l)).every(l=>!/\/usr\/local|\/opt\/homebrew/.test(l)),'no other PATH line adds them');
 const probe=source.replace(/^PATH=.*$/m,`PATH=${bin}`).replace(/^if \[ "\$\(\/usr\/bin\/id -u\)" != 0 \].*$/m,'');
 put(path.join(dir,'ssh-probe.sh'),probe);stubTools(bin);
 // A sudo that would let everything through (passwordless or cached): the narrow switch must not use it.
 put(path.join(bin,'sudo'),`#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexit 0\n`,0o755);
 const run=narrow=>runCommand('/bin/sh',[path.join(dir,'ssh-probe.sh')],{env:{PATH:bin,HOME:dir,LC_ALL:'C',...(narrow?{HOME_HUB_NARROW_SUDO:'1'}:{})},timeoutMs:60000});
 const r=await run(true);
 const sudo=existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean):[];
 assert.ok(sudo.every(l=>/^-n -l$/.test(l)),sudo.join('\n'));
 assert.equal(r.stdout.split('\n')[0].split(T)[4],'0','HOST root 0');
 // Without the switch (the collector over SSH) the probe decides from sudo -n true, as before.
 rmSync(log,{force:true});await run(false);
 assert.ok(readFileSync(log,'utf8').split('\n').includes('-n true'));
});

const until=async(check,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,5));}return false;};
test('runCommand: the timeout kills the probe\'s whole process group and settles even when a child holds the output',async()=>{
 const env={PATH:'/usr/bin:/bin'};
 let t0=Date.now();
 const hung=await runCommand('/bin/sh',['-c','(/bin/sleep 6; echo late) & echo early; /bin/sleep 6'],{env,timeoutMs:500});
 assert.ok(Date.now()-t0<3000,`settled after ${Date.now()-t0} ms`);
 assert.deepEqual([hung.timedOut,hung.stdout],[true,'early\n']);
 // The command exits but leaves a child holding stdout: settled graceMs later, the child killed with its group.
 t0=Date.now();
 const left=await runCommand('/bin/sh',['-c','(/bin/sleep 6; echo late) & echo early'],{env,timeoutMs:10000,graceMs:200});
 assert.ok(Date.now()-t0<3000,`settled after ${Date.now()-t0} ms`);
 assert.deepEqual([left.code,left.timedOut,left.stdout],[0,false,'early\n']);
 // The kill is a signal to another process, and runCommand settles when it has sent it: the child's pid is gone only
 // once the child has died of it and its new parent (init or launchd, as sh has exited) has reaped it; until then it
 // is a zombie and kill(pid,0) still finds it. Neither comes at a promised time, so the check waits for the pid to go
 // (bounded) instead of for 100 ms. The child would sleep for a minute, far beyond that deadline: gone can only mean
 // killed, never slept out.
 const pid=Number((await runCommand('/bin/sh',['-c','/bin/sleep 60 & echo $!'],{env,timeoutMs:10000,graceMs:100})).stdout.trim());
 assert.ok(Number.isInteger(pid)&&pid>1,'the shell printed its child\'s pid');
 const there=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
 await until(()=>!there());
 assert.throws(()=>process.kill(pid,0),/ESRCH/,'the left-behind child is gone');
});

test('runtimes: read through the adapters on loopback only; one that does not answer is stopped, never left out',async()=>{
 const fetcher=async url=>{if(String(url).startsWith('http://127.0.0.1:11434/api/'))return new Response(JSON.stringify(String(url).endsWith('/api/version')?{version:'0.9.0'}:{models:[]}),{status:200});
  throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}});};
 const out=await readRuntimes([{id:'ollama',kind:'ollama',url:'http://127.0.0.1:11434'},{id:'other',kind:'vllm',url:'http://127.0.0.1:8000'},{id:'lan',kind:'auto',url:'http://10.0.0.5:1'}],{fetcher});
 assert.deepEqual(out.runtimes.map(r=>[r.id,r.status]),[['ollama','running'],['other','stopped']]);
 assert.equal(validateReport({v:1,agentVersion:'1.4.0',platform:'macos',sentAt:'2026-11-13T10:00:00Z',parts:{runtimes:{schema:1,collectedAt:'2026-11-13T10:00:00Z',interval:120,data:out}}}).refused.length,0);
});

// --- the send loop against an HTTPS hub stand-in ----------------------------------------------------------------------
async function standIn(t){
 const seen=[];let reply=(q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({receivedAt:new Date().toISOString(),accepted:Object.keys(JSON.parse(q.body).parts),refused:[]}));};
 const s=https.createServer({cert,key},(q,r)=>{const c=[];q.on('data',d=>c.push(d));q.on('end',()=>{q.body=Buffer.concat(c).toString('utf8');seen.push(JSON.parse(q.body));reply(q,r);});});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections?.();s.close(r);}));
 return {port:s.address().port,seen,set:f=>{reply=f;}};
}
function loopAgent(port,{pins=[pin],keys='off',exec=fakeExec()}={}){
 let clock=Date.parse('2026-11-13T10:00:00Z');const statuses=[];
 const config=parseConfig(JSON.stringify({schema:1,hub:`https://127.0.0.1:${port}`,trust:{pins},keys}),{platform:'macos'}).config;
 const frozen=JSON.stringify(config);
 const agent=createAgent({config,trust:{mode:'pin',pins:config.trust.pins},token:TOKEN,specsText:'',platform:'macos',root:'/agent',home:'/h',version:'1.4.0',
  world:{exec,now:()=>clock,random:()=>0.5,writeStatus:text=>statuses.push(JSON.parse(text))}});
 return {agent,exec,statuses,config,frozen,tick:ms=>{clock+=ms;},now:()=>clock};
}

test('the loop: heartbeat first, the systems run when it is collected, one report per batch, status.json as documented',async t=>{
 const hubS=await standIn(t),a=loopAgent(hubS.port);
 await a.agent.step();
 assert.deepEqual(Object.keys(hubS.seen[0].parts),['heartbeat'],'the heartbeat does not wait for the probe');
 await a.agent.settled();
 assert.ok(await a.agent.step()>=250);assert.equal(hubS.seen.length,1,'the 20 s floor');
 a.tick(AGENT_TIMING.floorMs);await a.agent.step();
 assert.deepEqual(Object.keys(hubS.seen[1].parts),['os','updates','packages']);
 assert.equal(validateReport(hubS.seen[1]).refused.length,0);
 const st=a.statuses.at(-1);
 assert.deepEqual(Object.keys(st),['lastAttemptAt','lastAcceptedAt','lastError','parts']);
 assert.equal(st.lastError,null);assert.ok(st.lastAcceptedAt);
 assert.deepEqual(Object.keys(st.parts),['heartbeat','os','packages','updates']);
 assert.deepEqual(Object.keys(st.parts.os),['lastSentAt','lastAcceptedAt','lastRefused']);
 // The next heartbeat comes after its interval (with jitter: 60 s ± 10 %; random 0.5 = exactly 60 s), alone.
 a.tick(30000);await a.agent.step();assert.equal(hubS.seen.length,2);
 a.tick(30000);await a.agent.step();assert.deepEqual(Object.keys(hubS.seen[2].parts),['heartbeat']);
 assert.equal(a.exec.calls.length,1,'the probe ran once');
 assert.equal(renderStatus({parts:{}}),'{\n "lastAttemptAt": null,\n "lastAcceptedAt": null,\n "lastError": null,\n "parts": {}\n}\n');
 assert.deepEqual([nextBackoff(0),nextBackoff(30),nextBackoff(600)],[30,60,900]);
 assert.equal(jittered('heartbeat',30,()=>0),30000,'never below the part\'s minimum');
});

test('the loop: 429 waits Retry-After and resends the batch; 5xx doubles; 401 waits an hour; 400 waits for the interval',async t=>{
 const hubS=await standIn(t),a=loopAgent(hubS.port);
 const status=(code,headers={})=>hubS.set((q,r)=>{r.writeHead(code,{'Content-Type':'application/json',...headers});r.end('{}');});
 status(429,{'Retry-After':'45'});
 await a.agent.step();await a.agent.settled();
 assert.equal(a.statuses.at(-1).lastError,'too-soon');
 a.tick(30000);await a.agent.step();assert.equal(hubS.seen.length,1,'not before Retry-After');
 status(200);hubS.set((q,r)=>{r.writeHead(200);r.end(JSON.stringify({accepted:Object.keys(JSON.parse(q.body).parts)}));});
 a.tick(16000);await a.agent.step();
 assert.deepEqual(Object.keys(hubS.seen[1].parts),['heartbeat','os','updates','packages'],'the batch kept for the retry, sent together');
 // 5xx: 30 s, then 60 s.
 status(503);a.tick(60000);await a.agent.step();assert.equal(a.statuses.at(-1).lastError,'http-503');
 const n=hubS.seen.length;a.tick(29000);await a.agent.step();assert.equal(hubS.seen.length,n);
 a.tick(1000);await a.agent.step();assert.equal(hubS.seen.length,n+1);
 a.tick(59000);await a.agent.step();assert.equal(hubS.seen.length,n+1,'doubled to 60 s');
 // 401: nothing for an hour.
 status(401);a.tick(1000);await a.agent.step();assert.equal(a.statuses.at(-1).lastError,'unauthorized');
 const m=hubS.seen.length;a.tick(3599000);await a.agent.step();assert.equal(hubS.seen.length,m);
 a.tick(1000);await a.agent.step();assert.equal(hubS.seen.length,m+1);
 // 400: the parts wait for their next interval.
 status(400);a.tick(3600000);await a.agent.step();assert.equal(a.statuses.at(-1).lastError,'http-400');
 const k=hubS.seen.length;a.tick(30000);await a.agent.step();assert.equal(hubS.seen.length,k);
});

// The first real Linux device: `systemctl restart` 45 s after a report, and the hub refused os, updates and packages as
// too-soon (it holds this key's copy from less than 15 min ago). They must come again once that minimum has passed, not
// six hours later (a watch list changed by an install would reach the hub only then).
test('the loop: systems parts refused as too-soon are collected again after their minimum, not a whole interval later',async t=>{
 const hubS=await standIn(t),a=loopAgent(hubS.port);
 hubS.set((q,r)=>{const parts=Object.keys(JSON.parse(q.body).parts);r.writeHead(200,{'Content-Type':'application/json'});
  r.end(JSON.stringify({receivedAt:new Date().toISOString(),accepted:parts.filter(p=>p==='heartbeat'),refused:parts.filter(p=>p!=='heartbeat').map(part=>({part,code:'too-soon'}))}));});
 await a.agent.step();await a.agent.settled();
 a.tick(AGENT_TIMING.floorMs);await a.agent.step();
 assert.deepEqual(Object.keys(hubS.seen[1].parts),['os','updates','packages']);
 assert.equal(a.statuses.at(-1).parts.os.lastRefused.code,'too-soon');
 hubS.set((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({receivedAt:new Date().toISOString(),accepted:Object.keys(JSON.parse(q.body).parts),refused:[]}));});
 // Heartbeats only until the minimum (900 s) has passed since the refusal; then one probe run and the parts again.
 for(let s=0;s<900;s+=60){a.tick(60000);await a.agent.step();await a.agent.settled();}
 a.tick(60000);await a.agent.step();await a.agent.settled();a.tick(AGENT_TIMING.floorMs);await a.agent.step();
 const systems=hubS.seen.filter(e=>'os' in e.parts);
 assert.equal(systems.length,2,'sent again within about 16 min, not after 6 h');
 assert.equal(a.exec.calls.length,2,'collected again for it');
 assert.equal(a.statuses.at(-1).parts.os.lastRefused,null);
});

// Early only once in a row: a hub that keeps refusing as too-soon (another install with the same key, a stale copy)
// must not make the agent run its probe, and its sudo reads, every 15 min for good.
test('the loop: a second too-soon refusal in a row sends the systems parts back to their interval',async t=>{
 const hubS=await standIn(t),a=loopAgent(hubS.port);
 hubS.set((q,r)=>{const parts=Object.keys(JSON.parse(q.body).parts);r.writeHead(200,{'Content-Type':'application/json'});
  r.end(JSON.stringify({receivedAt:new Date().toISOString(),accepted:parts.filter(p=>p==='heartbeat'),refused:parts.filter(p=>p!=='heartbeat').map(part=>({part,code:'too-soon'}))}));});
 await a.agent.step();await a.agent.settled();
 a.tick(AGENT_TIMING.floorMs);await a.agent.step();
 const systems=()=>hubS.seen.filter(e=>'os' in e.parts).length;
 assert.equal(systems(),1);
 // The early try (about 16 min later), refused again.
 for(let s=0;s<=900;s+=60){a.tick(60000);await a.agent.step();await a.agent.settled();}
 a.tick(AGENT_TIMING.floorMs);await a.agent.step();await a.agent.settled();
 assert.equal(systems(),2,'one early try');
 assert.equal(a.exec.calls.length,2);
 // Then two hours of heartbeats: no third probe run (the interval is 6 h).
 for(let s=0;s<7200;s+=60){a.tick(60000);await a.agent.step();await a.agent.settled();}
 assert.equal(systems(),2,'not every 15 min');
 assert.equal(a.exec.calls.length,2,'the probe is not run again before the interval');
});

test('the loop: a wrong pin sends nothing; a hostile answer changes nothing the agent runs or reads',async t=>{
 const hubS=await standIn(t);
 const wrong=loopAgent(hubS.port,{pins:['0'.repeat(64)]});
 await wrong.agent.step();assert.equal(hubS.seen.length,0);assert.equal(wrong.statuses.at(-1).lastError,'tls-pin');
 const a=loopAgent(hubS.port);
 hubS.set((q,r)=>{r.writeHead(200,{'Content-Type':'application/json',Location:'https://evil.example.lan/'});
  r.end(JSON.stringify({receivedAt:'2026-11-13T10:00:00Z',accepted:['heartbeat'],refused:[],command:'reboot',exec:['/bin/sh','-c','id'],run:'x|cmd|/bin/sh|-c id|',
   config:{hub:'https://evil.example.lan',trust:null},specs:'evil|cmd|/bin/sh|-c id|',intervals:{heartbeat:1},probe:'#!/bin/sh\nrm -rf /'}));});
 for(let i=0;i<6;i++){await a.agent.step();await a.agent.settled();a.tick(20000);}
 assert.equal(JSON.stringify(a.config),a.frozen,'configuration untouched');
 assert.deepEqual(a.exec.calls.map(c=>[c.cmd,...c.args]),[['/bin/sh','/agent/scripts/systems/mac-probe.sh']],'exec ran only the probe, once');
 assert.ok(a.exec.calls.every(c=>c.env.SPECS===''),'the watch list is still the local one');
 assert.ok(hubS.seen.length>=2&&hubS.seen.every(e=>Object.keys(e.parts).every(p=>['heartbeat','os','updates','packages'].includes(p))));
});

test('end to end in-process: --once --send to a real hub over http://127.0.0.1; the parts are accepted',async t=>{
 const h=await hub(t),{token}=await issueAgent(h,'studio');
 const dir=temp(t),config=path.join(dir,'config');
 put(path.join(config,'agent.json'),JSON.stringify({schema:1,hub:h.origin,keys:'off'}));put(path.join(config,'specs.txt'),'');put(path.join(dir,'key'),token+'\n',0o600);
 const outs=[],statuses=[];
 const code=await runAgent(['--config',config,'--state',path.join(dir,'state'),'--key',path.join(dir,'key'),'--once','--send'],{root,platform:'macos',env:{HOME:dir},
  out:m=>outs.push(m),err:()=>{},writeStatusTo:()=>text=>statuses.push(JSON.parse(text)),world:{exec:fakeExec(),log:()=>{}}});
 const answer=JSON.parse(outs.at(-1));
 assert.equal(code,0,outs.join('\n'));assert.equal(answer.status,200);
 assert.deepEqual(answer.accepted.sort(),['heartbeat','os','packages','updates']);assert.deepEqual(answer.refused,[]);
 assert.ok(statuses.at(-1).lastAcceptedAt);assert.ok(!outs.join('').includes(token),'the key is never printed');
 // A dry --once reads no key and sends nothing: it prints the envelope.
 const dry=[];
 assert.equal(await runAgent(['--config',config,'--once'],{root,platform:'macos',env:{HOME:dir},out:m=>dry.push(m),err:()=>{},world:{exec:fakeExec(),request:async()=>{throw new Error('sent');}}}),0);
 assert.deepEqual(Object.keys(JSON.parse(dry[0]).parts),['heartbeat','os','updates','packages']);
});
