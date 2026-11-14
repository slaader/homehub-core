// scripts/systems/linux-probe.sh (step 3a of docs/agent.md): the Linux probe's output against the field table of
// docs/agent.md section 3, its shell and its privileged reads against section 5, and its records on a stubbed host.
// The stubs stand in for every command the probe can reach: the test's PATH holds nothing else, so no real sudo,
// package manager, ss, nft or systemd runs, and the same test passes on macOS and Linux.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,chmod} from 'node:fs/promises';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSystemsProbe} from '../server/systems-data.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SCRIPT=path.join(root,'scripts','systems','linux-probe.sh');
const NOTE=path.join(root,'docs','agent.md');
const FIXTURES=path.join(root,'tests','fixtures','probes');
const SHELLS=['/bin/sh','/bin/dash','/bin/bash'].filter(p=>existsSync(p));

// --- the field table (docs/agent.md section 3) for the tags a Linux agent emits -----------------------
const KINDS=['brew','cask','app','cmd','pydist','json','missing','unsupported'];
const PKG_MANAGERS=['apt','dnf'];
const PRIV_IDS=['nft','listen','sshd'];
const text=n=>({text:n}), num={num:true}, one=(...v)=>({enum:v});
const TABLE={
  HOST:{fields:[text(64),one('Linux'),text(64),one('0','1'),{iso:true}]},
  OS:{fields:[text(40),text(20),text(80),text(60),text(20)]},
  HW:{fields:[text(60),text(80),num,num]},
  UPTIME:{fields:[num]},
  AUTO:{fields:[text(60),text(20)]},
  SSHD:{fields:[text(40),text(120)]},
  LISTEN:{fields:[text(60),text(64),text(64)]},
  NFT:{min:1,max:3,fields:[text(80),num,text(400)]},
  PRIV:{fields:[one(...PRIV_IDS),one('ok','denied')]},
  PKGUP:{fields:[one(...PKG_MANAGERS),text(120),text(80),text(80),one('0','1')]},
  PKGUP_NONE:{fields:[one(...PKG_MANAGERS),num]},
  PKGUP_ERR:{fields:[one(...PKG_MANAGERS),text(200)]},
  SW:{min:4,max:5,fields:[text(60),one(...KINDS),text(300),text(300),text(120)]},
  RUN:{fields:[text(60),{runState:true},text(120)]},
  DOCKER:{fields:[text(80),text(160),text(80),text(40)]},
  ERROR:{fields:[text(200)]},
  END:{fields:[one('ok')]},
};
function fieldProblem(spec,v){
  if(spec.text!==undefined)return v.length<=spec.text?null:`longer than ${spec.text} characters`;
  if(spec.num)return /^[0-9]*$/.test(v)?null:'not empty or digits';
  if(spec.enum)return spec.enum.includes(v)?null:`${JSON.stringify(v)} is not ${spec.enum.join(' or ')}`;
  if(spec.iso)return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)?null:'not an ISO time';
  if(spec.runState)return /^(absent|loaded|[0-9]+)$/.test(v)?null:'not absent, loaded or a pid';
  return 'no rule';
}
// Problems of one record line (empty array when it fits the table).
export function lineProblems(line){
  const problems=[];
  if(Buffer.byteLength(line)>4096)problems.push('longer than 4096 bytes');
  if(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line))problems.push('control character');
  const f=line.split('\t'),tag=f[0],spec=TABLE[tag];
  if(!spec)return [...problems,`unknown tag ${JSON.stringify(tag)}`];
  const fields=f.slice(1),min=spec.min??spec.fields.length,max=spec.max??spec.fields.length;
  if(fields.length<min||fields.length>max)return [...problems,`${tag} has ${fields.length} fields, want ${min === max ? min : `${min} to ${max}`}`];
  if(tag==='NFT'&&fields[0]==='unknown'){if(fields.length!==1)problems.push('NFT unknown stands alone');return problems;}
  fields.forEach((v,i)=>{const p=fieldProblem(spec.fields[i],v);if(p)problems.push(`${tag} field ${i+1}: ${p}`);});
  return problems;
}
// Problems of a whole report: every line fits, HOST first and END ok last.
export function reportProblems(report){
  const lines=report.replace(/\n$/,'').split('\n'),problems=[];
  lines.forEach((l,i)=>{for(const p of lineProblems(l))problems.push(`record ${i+1}: ${p}`);});
  if(lines[0].split('\t')[0]!=='HOST')problems.push('the first record is not HOST');
  if(lines.at(-1)!=='END\tok')problems.push('the last record is not END ok');
  return problems;
}

// --- the privileged list (docs/agent.md section 5) -------------------------------------------------------
// The Linux and "both" rows of the table whose id this probe reads: nft, listen, sshd. Read from the note itself.
function notePrivileged(){
  const md=readFileSync(NOTE,'utf8');
  const start=md.indexOf('**The privileged list**'),end=md.indexOf('The rules go to',start);
  assert.ok(start>0&&end>start,'docs/agent.md section 5 has the privileged list');
  const commands=new Map();
  for(const row of md.slice(start,end).split('\n').filter(l=>/^\|\s*(Linux|both)\s*\|/.test(l))){
    const cells=row.split('|').slice(1,-1).map(c=>c.trim());
    const id=/`([^`]+)`/.exec(cells[1])?.[1];
    if(!PRIV_IDS.includes(id))continue;
    commands.set(id,[...cells[2].matchAll(/`(\/[^`]+)`/g)].map(m=>m[1]));
  }
  return commands;
}
// Every R call of the script (the command text up to a redirection, a pipe or a closing parenthesis).
function rCalls(code){
  return [...code.matchAll(/(?:^|[\s;(&|])R ([^<>;|&()\n]*)/gm)].map(m=>m[1].trim());
}

// --- the script, read and stripped of comments -------------------------------------------------------------
const script=readFileSync(SCRIPT,'utf8');
const code=script.split('\n').map(l=>l.replace(/(^|\s)#.*$/,'$1')).join('\n');

test('the probe parses under every shell that exists here, POSIX mode included', ()=>{
  assert.ok(SHELLS.length>=1);
  for(const shell of SHELLS){
    const r=spawnSync(shell,['-n',SCRIPT],{encoding:'utf8'});
    assert.equal(r.status,0,`${shell} -n: ${r.stderr}`);
  }
  const posix=spawnSync('/bin/bash',['--posix','-n',SCRIPT],{encoding:'utf8'});
  assert.equal(posix.status,0,`bash --posix -n: ${posix.stderr}`);
});

test('the probe is a POSIX sh script: no bash-only syntax', ()=>{
  assert.match(script.split('\n')[0],/^#!\/bin\/sh$/);
  for(const bashism of [/\[\[(?!:)/,/\bfunction\s+\w+/,/\bdeclare\b/,/\blocal\s/,/\$\{\w+\/\//,/<\(/,/\bsource\b/,/\bmapfile\b/,/\bselect\b/,/\bBASH/,/\bUID\b/]){
    assert.doesNotMatch(code,bashism,`bash-only syntax: ${bashism}`);
  }
});

test('the probe never installs, updates, refreshes or restarts anything', ()=>{
  const forbidden=[
    [/\b(apt-get|apt|aptitude)\s+(-\S+\s+)*(update|upgrade|dist-upgrade|full-upgrade|install|reinstall|remove|purge|autoremove|autoclean|clean)\b/,'apt writes'],
    [/\b(dnf|yum)\s+(-\S+\s+)*(makecache|update|upgrade|upgrade-minimal|install|reinstall|remove|erase|clean|autoremove|distro-sync)\b/,'dnf or yum writes'],
    [/\b(pacman|zypper|apk|pip3?|npm|gem|snap|flatpak)\b/,'another package manager'],
    [/\bsystemctl\s+(-\S+\s+)*(start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload|try-restart)\b/,'systemctl changes a unit'],
    [/\bdocker\s+(run|start|stop|rm|rmi|exec|pull|build|compose|kill|restart|create|network|volume|system)\b/,'docker changes a container or image'],
    [/\b(rm|mv|cp|ln|chmod|chown|chgrp|mkdir|touch|tee|dd|install|mktemp|truncate|kill|pkill)\b/,'a file or process change'],
  ];
  for(const [re,what] of forbidden)assert.doesNotMatch(code,re,what);
  for(const line of code.split('\n').filter(l=>/T \d+ .*check-update/.test(l)))
    assert.match(line,/\s-C\s/,`check-update reads the cache only (-C): ${line.trim()}`);
  // Every redirection writes to /dev/null, or duplicates a descriptor. Nothing is written to a file.
  // Single-quoted text (awk programs, format strings) is not a shell redirection and is blanked first.
  for(const m of code.replace(/'[^']*'/g,"''").matchAll(/\d*>>?(&?)([^\s;)|]*)/g)){
    if(m[1]==='&')continue;
    assert.equal(m[2],'/dev/null',`redirection to ${m[2]}`);
  }
});

test('sudo is called in one place only: the R helper, as sudo -n', ()=>{
  const lines=code.split('\n').filter(l=>/\bsudo\b/.test(l));
  assert.deepEqual(lines.map(l=>l.trim()),['R() { T 60 sudo -n "$@"; }']);
});

test('every R call is a privileged read of the note, and every read of the note is called', ()=>{
  const expected=notePrivileged();
  assert.deepEqual([...expected.keys()].sort(),[...PRIV_IDS].sort());
  const allowed=new Set([...expected.values()].flat());
  const calls=rCalls(code);
  assert.ok(calls.length>=5,`R calls found: ${calls.length}`);
  for(const c of calls)assert.ok(allowed.has(c),`R call outside the privileged list: ${c}`);
  for(const c of allowed)assert.ok(calls.includes(c),`privileged read never called: ${c}`);
  for(const id of PRIV_IDS)assert.ok(code.includes(`priv ${id} `),`PRIV record for ${id}`);
});

test('every system command runs under a timeout (T) or as a privileged read (R)', ()=>{
  const names=['apt','apt-cache','dnf','yum','ss','sshd','nft','systemctl','docker','stat','date','uname','sudo'];
  const commandPosition=/(^|[;|(&]|\bthen|\bdo|\belse|\$\(|\|\||&&|!)\s*$/;
  const problems=[];
  for(const raw of code.split('\n')){
    // Message text is not a command: quoted strings without an expansion are blanked out first.
    const line=raw.replace(/"[^"$]*"/g,'""');
    for(const name of names){
      const re=new RegExp(`(?<![\\w./-])${name}(?![\\w.-])(?!\\s*[|)])`,'g');
      for(const m of line.matchAll(re)){
        if(commandPosition.test(line.slice(0,m.index)))problems.push(line.trim());
      }
    }
  }
  assert.deepEqual(problems,[]);
  assert.ok(/T\(\) \{/.test(code)&&/R\(\) \{ T 60 sudo/.test(code));
});

// --- the fixtures ---------------------------------------------------------------------------------------------
// The fixtures are hand-written, not made by the probe, so they only show that the text fits TABLE (above, a copy of
// the field table). Step 1 replaces TABLE with validateReport from server/agent-report.mjs, and these checks use it.
const fixtureNames=readdirSync(FIXTURES).filter(f=>/^linux-.*\.txt$/.test(f)).sort();
test('the fixtures cover apt, dnf, apk without systemd, and a host with nothing privileged', ()=>{
  for(const want of ['linux-debian-apt.txt','linux-fedora-dnf.txt','linux-alpine-apk.txt','linux-minimal.txt'])
    assert.ok(fixtureNames.includes(want),`missing fixture ${want}`);
});
for(const name of fixtureNames){
  test(`fixture ${name}: every record fits the field table and the frame`, ()=>{
    const text=readFileSync(path.join(FIXTURES,name),'utf8');
    assert.deepEqual(reportProblems(text),[]);
    assert.doesNotMatch(text,/\/home\/|\/Users\/|192\.168\./,'placeholders only');
  });
  test(`fixture ${name}: the reader of docs/agent.md parses it`, ()=>{
    const h=parseSystemsProbe(readFileSync(path.join(FIXTURES,name),'utf8'));
    assert.equal(h.complete,true);
    assert.equal(h.platform,'linux');
    assert.ok(h.host&&h.os.name);
  });
}
test('fixture alpine: an apk host with no systemd has no update, auto-update or unit records', ()=>{
  const text=readFileSync(path.join(FIXTURES,'linux-alpine-apk.txt'),'utf8');
  for(const tag of ['PKGUP','PKGUP_NONE','PKGUP_ERR','AUTO','RUN'])
    assert.doesNotMatch(text,new RegExp(`^${tag}\\t`,'m'));
});

// --- the probe on a stubbed host ---------------------------------------------------------------------------
const q=s=>`'${String(s).replace(/'/g,"'\\''")}'`;
const TEXT_TOOLS=['awk','cat','cut','grep','head','sed','sort','tr','uniq'];
function realCommand(name){
  const r=spawnSync('/bin/sh',['-c',`command -v ${name}`],{encoding:'utf8'});
  const p=r.stdout.trim();
  return p&&existsSync(p)?p:null;
}
// Stubs for one scenario: which privileged reads succeed, what the package manager and systemd print, and
// whether timeout(1) exists at all. The text tools are the host's own (they read and write, nothing else).
async function makeHost(dir,s){
  const bin=path.join(dir,'bin');
  await mkdir(bin,{recursive:true});
  const files={};
  const file=async(name,body)=>{const p=path.join(dir,'data',name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,body);return p;};
  const put=async(name,body)=>{const p=path.join(bin,name);await writeFile(p,`#!/bin/sh\n${body}\n`);await chmod(p,0o755);};
  for(const t of TEXT_TOOLS){const real=realCommand(t);if(real)await symlink(real,path.join(bin,t));}
  if(s.timeout)await put('timeout','shift\nexec "$@"');
  const sudoCases=[];
  for(const [cmd,body] of Object.entries(s.sudo??{}))sudoCases.push(`${q(cmd)}) cat ${q(await file(`sudo-${sudoCases.length}.txt`,body))};;`);
  await put('sudo',`[ "$1" = -n ] && shift\ncase "$*" in\n${sudoCases.join('\n')}\n*) echo "sudo: a password is required" >&2; exit 1;;\nesac`);
  if(s.ss)await put('ss',`case "$*" in\n'-Htln') cat ${q(await file('ss-plain.txt',s.ss))};;\n*) exit 1;;\nesac`);
  if(s.apt){
    const list=await file('apt-list.txt',s.apt);
    await put('apt',`case "$1" in\nlist) cat ${q(list)};;\n*) exit 1;;\nesac`);
  }
  // The package manager: dnf, or yum (labelled dnf by the probe). Its cache is the stub's stat, below.
  if(s.dnf||s.yum){
    const d=s.dnf??s.yum;
    const check=await file('dnf-check.txt',d.check??'');
    const sec=await file('dnf-sec.txt',d.security??'');
    const rc=d.rc??100;
    await put(s.yum?'yum':'dnf',`case "$*" in\n'-C check-update') cat ${q(check)}; exit ${rc};;\n'-C check-update --security') cat ${q(sec)}; exit ${d.secRc??100};;\n*) exit 1;;\nesac`);
  }
  if(s.systemd){
    // The probe's call is: systemctl show -p MainPID,ActiveState,LoadState -- UNIT. Any other shape exits 2.
    const units=[];
    for(const [unit,body] of Object.entries(s.systemd))units.push(`${q(unit)}) cat ${q(await file(`unit-${units.length}.txt`,body))};;`);
    units.push(`*) cat ${q(await file('unit-none.txt','MainPID=0\nActiveState=inactive\nLoadState=not-found\n'))};;`);
    await put('systemctl',`[ "$1 $2 $3 $4" = "show -p MainPID,ActiveState,LoadState --" ] || exit 2\ncase "$5" in\n${units.join('\n')}\nesac`);
  }
  if(s.docker){
    const ps=await file('docker-ps.txt',s.docker.ps);
    await put('docker',`case "$1" in\nps) cat ${q(ps)};;\nimage) echo ${q(s.docker.created)};;\n*) exit 1;;\nesac`);
  }
  // The age of every cache is 6800 s before the stub's clock; no index at all when the scenario says so.
  await put('stat',`case "$*" in\n*_Packages*) ${s.aptIndex===false?'exit 1':'echo 1794643200'};;\n*) echo 1794643200;;\nesac`);
  await put('date',`case "$*" in\n'+%s') echo 1794650000;;\n*) echo 2026-11-13T10:00:00Z;;\nesac`);
  await put('uname','echo aarch64');
  return bin;
}
// The watch list: one demo binary, a JSON file, a Python distribution and a missing binary.
async function watchList(dir){
  const tool=path.join(dir,'tools','demo-tool');
  await mkdir(path.dirname(tool),{recursive:true});
  await writeFile(tool,'#!/bin/sh\necho "demo-tool 1.2.3"\n');
  await chmod(tool,0o755);
  const json=path.join(dir,'data','package.json');
  await mkdir(path.dirname(json),{recursive:true});
  await writeFile(json,'{"name": "demo", "version": "1.4.0"}\n');
  const site=path.join(dir,'site-packages');
  await mkdir(path.join(site,'Demo_Lib-2.1.0.dist-info'),{recursive:true});
  const missing=path.join(dir,'absent','demo');
  // A tool under a directory with a space, a tool that prints an argument count, a tool that prints colour codes
  // and a non-ASCII name, and a relative JSON file whose name starts with a dash (it must be read, not taken as an
  // option): each one is a case the probe must handle exactly.
  const spaced=path.join(dir,'my tools','spaced tool');
  await mkdir(path.dirname(spaced),{recursive:true});
  await writeFile(spaced,'#!/bin/sh\necho "spaced 0.9"\n');
  await chmod(spaced,0o755);
  const argc=path.join(dir,'tools','argc');
  await writeFile(argc,'#!/bin/sh\nprintf "argc=%s\\n" "$#"\n');
  await chmod(argc,0o755);
  const colour=path.join(dir,'tools','colour');
  await writeFile(colour,'#!/bin/sh\nprintf "\\033[32mcoloured 2.0\\033[0m\\n"\n');
  await chmod(colour,0o755);
  const utf=path.join(dir,'tools','café');
  await writeFile(utf,'#!/bin/sh\necho "café 1.0"\n');
  await chmod(utf,0o755);
  const dashJson='-version.json';
  await writeFile(path.join(dir,dashJson),'{"name": "dash", "version": "7.0"}\n');
  const specs=[
    `demo-tool|cmd|${tool}|--version|`,
    `demo-json|json|${json}|version|`,
    `demo-py|pydist|${site}|Demo_Lib|`,
    `demo-missing|cmd|${missing}|--version|`,
    `demo-brew|brew|demo-formula||`,
    `demo-svc|cmd|${tool}|--version|demo.service`,
    `demo-old|cmd|${tool}|--version|old.service`,
    `demo-stopped|cmd|${tool}|--version|stopped.service`,
    `demo-space|cmd|${spaced}|--version|`,
    `demo-args|cmd|${argc}|one two|`,
    `demo-colour|cmd|${colour}|--version|`,
    `demo-utf|cmd|${utf}|--version|`,
    `demo-dash|json|${dashJson}|version|`,
    `demo-notfile|json|${path.join(dir,'tools')}|version|`,
    `demo-unit-dash|cmd|${tool}|--version|-Halice@10.0.0.5`,
  ].join('\n');
  return {tool,json,site,missing,spaced,argc,colour,utf,notfile:path.join(dir,'tools'),specs};
}
const NFT_RULESET=`table inet filter {
\tchain input {
\t\ttype filter hook input priority filter; policy drop;
\t\tct state established,related accept
\t\ttcp dport 22 accept
\t}
}
table ip nat {
\tchain prerouting {
\t\ttype nat hook prerouting priority dstnat; policy accept;
\t}
}
`;
const SSHD_T=`passwordauthentication no
kbdinteractiveauthentication no
permitrootlogin no
pubkeyauthentication yes
allowusers alice
allowtcpforwarding no
maxauthtries 6
`;
const SS_PROCESSES=`LISTEN 0      128        0.0.0.0:22       0.0.0.0:*    users:(("sshd",pid=812,fd=3))
LISTEN 0      128           [::]:22          [::]:*    users:(("sshd",pid=812,fd=4))
LISTEN 0      4096   127.0.0.1:8080      0.0.0.0:*    users:(("nginx",pid=901,fd=6),("nginx",pid=902,fd=6))
LISTEN 0      4096     10.0.0.20:53      0.0.0.0:*
`;
const SS_PLAIN=`LISTEN 0      128        0.0.0.0:22       0.0.0.0:*
LISTEN 0      4096   127.0.0.1:53      0.0.0.0:*
`;
const APT_LIST=`Listing...
openssl/jammy-security 3.0.2-0ubuntu1.19 amd64 [upgradable from: 3.0.2-0ubuntu1.18]
curl/jammy-updates 7.81.0-1ubuntu1.20 amd64 [upgradable from: 7.81.0-1ubuntu1.19]
`;
const DNF_CHECK=`
bash.x86_64                       5.2.32-1.fc41                  updates
kernel-core.x86_64                6.11.5-300.fc41                updates
very-long-package-name-for-the-listing.noarch
                                  2.0-4.fc41                     updates
firefox.x86_64                    134.0-1.fc41                   updates
Obsoleting Packages
bash-compat.x86_64                5.2.32-1.fc41                  updates
`;
const DNF_SEC=`
kernel-core.x86_64                6.11.5-300.fc41                updates
`;

const DOCKER_PS='web|nginx:1.27|Up 2 hours\n';
const SCENARIOS={
  full:{
    sudo:{'/usr/sbin/sshd -T':SSHD_T,'/usr/sbin/nft list ruleset':NFT_RULESET,'/usr/bin/ss -Htlnp':SS_PROCESSES},
    ss:SS_PLAIN,apt:APT_LIST,
    docker:{ps:DOCKER_PS,created:'2026-11-01T00:00:00Z'},
    systemd:{'demo.service':'MainPID=4242\nActiveState=active\nLoadState=loaded\n','stopped.service':'MainPID=0\nActiveState=inactive\nLoadState=loaded\n'},
    expect:[
      'PRIV\tsshd\tok','SSHD\tpasswordauthentication\tno','SSHD\tallowusers\talice',
      'PRIV\tlisten\tok','LISTEN\tsshd\t?\t0.0.0.0:22','LISTEN\tnginx\t?\t127.0.0.1:8080','LISTEN\t?\t?\t10.0.0.20:53',
      'PRIV\tnft\tok','NFT\tdrop:1\t2\tinet filter,ip nat',
      'PKGUP\tapt\topenssl\t3.0.2-0ubuntu1.18\t3.0.2-0ubuntu1.19\t1','PKGUP\tapt\tcurl\t7.81.0-1ubuntu1.19\t7.81.0-1ubuntu1.20\t0',
      'SW\tdemo-tool\tcmd\tdemo-tool 1.2.3\t__TOOL__','SW\tdemo-json\tjson\t1.4.0\t__JSON__','SW\tdemo-py\tpydist\t2.1.0\t__SITE__',
      'SW\tdemo-missing\tmissing\t\t__MISSING__','SW\tdemo-brew\tunsupported\t\tbrew',
      'SW\tdemo-space\tcmd\tspaced 0.9\t__SPACED__',
      'SW\tdemo-args\tcmd\targc=1\t__ARGC__',
      'SW\tdemo-colour\tcmd\t [32mcoloured 2.0 [0m\t__COLOUR__',
      'SW\tdemo-utf\tcmd\tcaf?? 1.0\t__UTF__',
      'SW\tdemo-dash\tjson\t7.0\t-version.json',
      'SW\tdemo-notfile\tmissing\t\t__NOTFILE__',
      'RUN\tdemo-svc\t4242\tdemo.service','RUN\tdemo-old\tabsent\told.service','RUN\tdemo-stopped\tloaded\tstopped.service',
      'RUN\tdemo-unit-dash\tabsent\t-Halice@10.0.0.5',
      'DOCKER\tweb\tnginx:1.27\tUp 2 hours\t2026-11-01T00:00:00Z',
    ],
  },
  minimal:{
    ss:SS_PLAIN,apt:APT_LIST,aptIndex:false,
    expect:[
      'PRIV\tsshd\tdenied','SSHD\teffective\tunknown','PRIV\tlisten\tdenied','LISTEN\t?\t?\t127.0.0.1:53',
      'PRIV\tnft\tdenied','NFT\tunknown','PKGUP_ERR\tapt\tno package index on this host (/var/lib/apt/lists)',
      'SW\tdemo-tool\tcmd\tdemo-tool 1.2.3\t__TOOL__',
    ],
    absent:['RUN\t','PKGUP\t','PKGUP_NONE\t'],
  },
  // The privileged ss read at the other two paths of the list (the first that answers is used).
  ssSbin:{
    sudo:{'/usr/sbin/ss -Htlnp':SS_PROCESSES},ss:SS_PLAIN,
    expect:['PRIV\tlisten\tok','LISTEN\tsshd\t?\t0.0.0.0:22','LISTEN\tnginx\t?\t127.0.0.1:8080'],
  },
  ssBin:{
    sudo:{'/bin/ss -Htlnp':SS_PROCESSES},ss:SS_PLAIN,
    expect:['PRIV\tlisten\tok','LISTEN\tsshd\t?\t0.0.0.0:22','LISTEN\tnginx\t?\t127.0.0.1:8080'],
  },
  // yum is labelled dnf, and reads the same cached check-update pair as dnf.
  yum:{
    yum:{check:DNF_CHECK,security:DNF_SEC,rc:100},
    expect:[
      'PKGUP\tdnf\tbash\t\t5.2.32-1.fc41\t0','PKGUP\tdnf\tkernel-core\t\t6.11.5-300.fc41\t1',
      'PKGUP\tdnf\tvery-long-package-name-for-the-listing\t\t2.0-4.fc41\t0','PKGUP\tdnf\tfirefox\t\t134.0-1.fc41\t0',
    ],
    absent:['PKGUP_ERR\t','PKGUP_NONE\t','PKGUP\tdnf\tbash-compat\t'],
  },
  // A failed security read is an error record, never a silent security flag of 0.
  dnfSecFail:{
    dnf:{check:DNF_CHECK,security:'',rc:100,secRc:1},
    expect:['PKGUP_ERR\tdnf\tdnf -C check-update --security exited 1'],
    absent:['PKGUP\t','PKGUP_NONE\t'],
  },
  aptNone:{
    apt:'Listing...\nDone\n',
    expect:['PKGUP_NONE\tapt\t6800'],
    absent:['PKGUP\t','PKGUP_ERR\t'],
  },
  dnf:{
    dnf:{check:DNF_CHECK,security:DNF_SEC,rc:100},
    expect:[
      'PKGUP\tdnf\tbash\t\t5.2.32-1.fc41\t0','PKGUP\tdnf\tkernel-core\t\t6.11.5-300.fc41\t1',
      'PKGUP\tdnf\tvery-long-package-name-for-the-listing\t\t2.0-4.fc41\t0','PKGUP\tdnf\tfirefox\t\t134.0-1.fc41\t0',
    ],
    absent:['PKGUP_ERR\t','PKGUP_NONE\t','PKGUP\tdnf\tbash-compat\t'],
  },
  dnfNone:{
    dnf:{check:'',security:'',rc:0},
    expect:['PKGUP_NONE\tdnf\t6800'],
    absent:['PKGUP\t','PKGUP_ERR\t'],
  },
  noTimeout:{
    sudo:{'/usr/sbin/sshd -T':SSHD_T},timeout:false,
    // Without timeout(1) date cannot run either, so HOST has no time: the one record the table refuses, and the
    // ERROR record says why. The probe stops there (END ok): no read is reported as denied or as not installed.
    // The agent does not send such a report.
    onlyProblems:['HOST field 5'],
    expect:['ERROR\ttimeout(1) is not installed: no command of this probe ran','END\tok'],
    absent:['SSHD\t','PRIV\t','OS\t','HW\t','SW\t','RUN\t','PKGUP','NFT\t','LISTEN\t','DOCKER\t'],
  },
};

// The watch list reaches the loop through a pipe: a here-document would need a temporary file the probe may not write.
test('the watch list is read through a pipe: no here-document, no unquoted loop over a path', ()=>{
  assert.doesNotMatch(code,/<</,'a here-document needs a temporary file');
  assert.match(code,/printf '%s\\n' "\$SPECS" \| while IFS='\|' read -r w_id/);
  assert.doesNotMatch(code,/for \w+ in \$(w_|\(expand_home)/,'a watch-list path is never word-split');
  // A json path is read only when it is a regular file (a device or a FIFO would never end), and under timeout(1).
  assert.match(code,/if \[ -f "\$w_file" \]; then/);
  assert.match(code,/T 10 grep -o -e .* -- "\$w_file"/);
});
test('timeout(1) missing: the probe emits HOST, ERROR and END ok, and nothing else', ()=>{
  assert.match(script,/if ! command -v timeout[^\n]*\n\s*emit ERROR[^\n]*\n\s*emit END ok\n\s*exit 0\n\s*fi/);
});

for(const shell of SHELLS){
  for(const [label,s] of Object.entries(SCENARIOS)){
    test(`execution, ${label} host under ${shell}: stubbed commands only, the records of the scenario`, async()=>{
      const dir=await mkdtemp(path.join(os.tmpdir(),'hh-linux-probe-'));
      try{
        // TMPDIR is a directory the probe must leave empty: a temporary file, were one made, would show up in it.
        const tmpd=path.join(dir,'tmp');
        await mkdir(tmpd);
        const wl=await watchList(dir);
        const bin=await makeHost(dir,{timeout:true,...s});
        const before=readdirSync(dir).sort().join(',');
        const r=spawnSync(shell,[SCRIPT],{cwd:dir,encoding:'utf8',timeout:30000,
          env:{PATH:bin,LC_ALL:'C',HOME:dir,SPECS:wl.specs,TMPDIR:tmpd}});
        assert.equal(r.status,0,r.stderr);
        assert.equal(r.stderr,'');
        const problems=reportProblems(r.stdout);
        if(s.onlyProblems)for(const p of problems)assert.ok(s.onlyProblems.some(o=>p.includes(o)),p);
        else assert.deepEqual(problems,[]);
        assert.equal(readdirSync(dir).sort().join(','),before,'the probe writes nothing');
        assert.deepEqual(readdirSync(tmpd),[],'the probe writes nothing to TMPDIR');
        const lines=new Set(r.stdout.split('\n'));
        const fill=l=>l.replace('__TOOL__',wl.tool).replace('__JSON__',wl.json).replace('__SITE__',wl.site).replace('__MISSING__',wl.missing)
          .replace('__SPACED__',wl.spaced).replace('__ARGC__',wl.argc).replace('__COLOUR__',wl.colour).replace('__NOTFILE__',wl.notfile)
          .replace('__UTF__',wl.utf.replace(/[^\x00-\x7f]/gu,c=>'?'.repeat(Buffer.byteLength(c))));  // one ? per byte
        for(const want of s.expect??[])assert.ok(lines.has(fill(want)),`missing record: ${fill(want)}\n${r.stdout}`);
        for(const no of s.absent??[])assert.ok(![...lines].some(l=>l.startsWith(no)),`unexpected record ${no}\n${r.stdout}`);
      }finally{
        await rm(dir,{recursive:true,force:true});
      }
    });
  }
}
