// Disposable production-mode Git rehearsal. Requires the real v1.0.0 and v1.1.0 tags locally.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,closeSync,copyFileSync,existsSync,ftruncateSync,linkSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync,writeSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {fileHash} from '../../server/update-backup.mjs';
import {powerLossPoints,invokeWithCheckpoint} from './backup-rehearsal-crash.mjs';
import {sourceLockPath} from '../../server/update-lock.mjs';

const argv=process.argv.slice(2);
const small=argv.includes('--small'),dense=argv.includes('--dense');
const interruption=argv.find(a=>a.startsWith('--interrupt='))?.slice('--interrupt='.length);
if(argv.some(a=>!['--small','--dense',`--interrupt=${interruption}`].includes(a))||
  (interruption&&!powerLossPoints.includes(interruption))||(small&&dense))throw new Error(
  `usage: node tests/large/backup-large.mjs [--small | --dense] [--interrupt=${powerLossPoints.join('|')}]`);
const driver=fileURLToPath(new URL('../../scripts/update.mjs',import.meta.url));
const source=path.resolve(path.dirname(driver),'..');
const node=process.execPath,MiB=1024**2;
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT'].includes(key)));
Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
const scratch=realpathSync(mkdtempSync(path.join(os.homedir(),'.home-hub-rehearsal-')));
const home=path.join(scratch,'instance'),root=path.join(home,'core'),state=path.join(home,'data','state');
const legacy=path.join(scratch,'legacy'),fixture=path.join(scratch,'fixture.json'),service=path.join(scratch,'service.mjs');
const calls=path.join(scratch,'service.log'),runFile=path.join(state,'run.json'),portFile=path.join(scratch,'port');
const journalFile=path.join(home,'update-journal.json'),policyFile=path.join(home,'update','backup-policy.json');
const version=()=>JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
const journal=()=>JSON.parse(readFileSync(journalFile,'utf8'));
const execute=(cmd,args,options={})=>{
 const r=spawnSync(cmd,args,{env,cwd:scratch,encoding:'utf8',maxBuffer:16*MiB,...options});
 if(r.error)throw r.error;
 return r;
};
const run=(cmd,args,expected=0)=>{
 const r=execute(cmd,args);
 assert.equal(r.status,expected,`${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
 return r;
};
const git=(dir,...args)=>run('git',['-C',dir,...args]).stdout.trim();
const flags=['--home',home,'--root',root];
const update=(script,command,expected=0)=>run(node,[script,...command,...flags],expected);
const print=result=>{for(const line of result.stdout.trim().split('\n'))if(line)console.log(line);};
const audit=file=>{const s=lstatSync(file,{bigint:true});return [String(s.ino),String(s.nlink),String(s.size),String(s.mtimeNs),String(s.ctimeNs),fileHash(file)];};
const stamp=file=>{const s=lstatSync(file,{bigint:true});return [String(s.ino),String(s.mtimeNs),String(s.ctimeNs)];};

function randomFile(file,bytes){
 const fd=openSync(file,'wx',0o640);
 try{for(let offset=0;offset<bytes;offset+=MiB){
  const buffer=randomBytes(Math.min(MiB,bytes-offset));let position=0;
  while(position<buffer.length)position+=writeSync(fd,buffer,position,buffer.length-position);
 }}finally{closeSync(fd);}
}
function clearFixtureCrashLocks(pid){
 const locks=[path.join(home,'update.lock'),sourceLockPath(root),sourceLockPath(path.join(root,'.git'))];
 for(const lock of locks){
  const owner=JSON.parse(readFileSync(path.join(lock,'owner.json'),'utf8'));
  assert.equal(owner.pid,pid);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  renameSync(lock,path.join(scratch,`stale-${randomUUID()}`));
 }
}
function crash(script,command,point){
 const r=invokeWithCheckpoint(execute,node,script,[...command,...flags],point);
 assert.equal(r.signal,'SIGKILL',`${point}: ${r.stdout}\n${r.stderr}`);
 clearFixtureCrashLocks(r.pid);
 console.log(`Interrupted at ${point}, preserved the disposable locks, resuming from the persisted journal`);
}

try{
 const v100=git(source,'rev-parse','refs/tags/v1.0.0^{commit}'),v110=git(source,'rev-parse','refs/tags/v1.1.0^{commit}');
 for(const d of ['data/state','private','config','update'])mkdirSync(path.join(home,d),{recursive:true,mode:0o700});
 for(const d of ['one','two'])mkdirSync(path.join(legacy,d),{recursive:true,mode:0o700});
 run('git',['clone','--quiet','--no-hardlinks',source,root]);
 git(root,'checkout','--quiet','--detach','v1.0.0');
 const local=[path.join(home,'data','media-a'),path.join(home,'data','media-a-local'),path.join(home,'private','media-a-cross'),path.join(home,'data','media-b')];
 const large=path.join(home,'data','large');
 if(dense)randomFile(large,2304*MiB);
 else{const fd=openSync(large,'wx',0o640);try{ftruncateSync(fd,(small?2:2304)*MiB);}finally{closeSync(fd);}}
 randomFile(local[0],(small?1:72)*MiB);linkSync(local[0],local[1]);linkSync(local[0],local[2]);
 writeFileSync(local[3],'second inode\n',{mode:0o640});
 const aliases=[[],[]];
 for(const [group,total] of [214,54].entries())for(let i=0;i<total;i++){
  const destination=path.join(legacy,group?'two':'one',`alias-${i}.bin`);
  linkSync(local[group?3:0],destination);aliases[group].push(destination);
 }
 const external=aliases.flat(),unrelated=path.join(legacy,'two','untouched.txt');
 writeFileSync(unrelated,'this file must never be enrolled\n');
 const unrelatedBefore=audit(unrelated),preimage=[fileHash(local[0]),fileHash(local[3]),fileHash(large)];
 copyFileSync(new URL('./backup-rehearsal-service.mjs',import.meta.url),service);
 writeFileSync(fixture,JSON.stringify({root,runFile,calls,portFile}));
 run(node,[service,'start',fixture]);
 for(let i=0;!existsSync(portFile)&&i<50;i++)await delay(100);
 const url=`http://127.0.0.1:${readFileSync(portFile,'utf8')}/healthz`;
 assert.ok((await fetch(url)).ok);
 writeFileSync(path.join(home,'instance.json'),JSON.stringify({schemaVersion:1,sources:{core:'core',plugins:[]},
  service:{start:[node,service,'start',fixture],stop:[node,service,'stop',fixture]},health:{url,seconds:8},backups:{keep:2}}));
 const treeBefore=[home,legacy,...external,unrelated].map(stamp);
 const discovery=JSON.parse(update(driver,['backup-diagnose','--search-root',legacy,'--candidate-cover-files'],1).stdout);
 assert.equal(discovery.links.missingNames,268);assert.equal(discovery.links.foundNames,268);assert.equal(discovery.links.unfoundNames,0);
 assert.deepEqual(discovery.links.candidateCoverFiles,[...external].sort());
 assert.deepEqual([home,legacy,...external,unrelated].map(stamp),treeBefore);
 assert.equal(existsSync(path.join(home,'backups')),false);
 writeFileSync(policyFile,JSON.stringify({schemaVersion:1,budget:{maxBytes:4*1024**3,maxFileBytes:3*1024**3,maxRoots:300},
  coverFiles:discovery.links.candidateCoverFiles}),{mode:0o600});
 chmodSync(policyFile,0o600);
 const preflight=JSON.parse(update(driver,['preflight','--read-only']).stdout);
 assert.equal(preflight.links.missingNames,0);assert.equal(preflight.links.crossRoot,2);
 if(!small)assert.ok(preflight.totals.bytes>2.07*1024**3);
 assert.equal(existsSync(journalFile),false);
 console.log(`Git rehearsal v1.0.0 (${v100}) → v1.1.0 (${v110}), ${preflight.totals.bytes} unique bytes, 268 enrolled exact paths`);
 const apply=['apply','v1.1.0','--no-fetch','--skip-tests','--allow-unsigned'];
 print(update(driver,['preflight',...apply.slice(1)]));
 if(interruption&&!interruption.startsWith('restore-')){
  crash(driver,apply,interruption);
  print(update(path.join(journal().driver,'scripts','update.mjs'),['rollback','--yes']));
  assert.equal(version(),'1.0.0');
  // Archive names contain seconds. Use a later transaction time after the fixture has recovered.
  await delay(1100);
 }
 print(update(driver,apply));
 assert.equal(version(),'1.1.0');assert.equal(git(root,'rev-parse','HEAD'),v110);
 const applied=journal();
 assert.equal(applied.schemaVersion,3);assert.equal(applied.backup.schemaVersion,2);
 if(dense)assert.ok(applied.backup.bytes>2**31);
 const oldDriver=path.join(root,'scripts','update.mjs'),retained=path.join(applied.driver,'scripts','update.mjs');
 const recordBefore=fileHash(journalFile),callsBefore=fileHash(calls);
 for(const command of [['status'],['rollback','--yes'],apply]){
  const refused=update(oldDriver,command,1);
  assert.match(refused.stderr,/corrupt or newer.*mutation refused/);
  assert.equal(fileHash(journalFile),recordBefore);assert.equal(fileHash(calls),callsBefore);
  assert.equal(git(root,'rev-parse','HEAD'),v110);
 }
 assert.ok((await fetch(url)).ok);
 console.log('Tagged updater refused status, apply and rollback before changing the service, journal or checkout');
 writeFileSync(local[0],'written by target');writeFileSync(local[3],'changed second inode');
 writeFileSync(large,'changed large file');
 if(interruption?.startsWith('restore-'))crash(retained,['rollback','--yes'],interruption);
 print(update(retained,['rollback','--yes']));
 assert.equal(version(),'1.0.0');assert.equal(git(root,'rev-parse','HEAD'),v100);assert.ok((await fetch(url)).ok);
 assert.equal(journal().step,'rolled-back');
 for(const [i,files] of [[...local.slice(0,3),...aliases[0]],[local[3],...aliases[1]]].entries()){
  const stats=files.map(file=>lstatSync(file,{bigint:true}));
  assert.ok(stats.every(s=>s.ino===stats[0].ino&&s.dev===stats[0].dev&&s.nlink===BigInt(files.length)));
  assert.equal(fileHash(files[0]),preimage[i]);assert.equal(stats[0].mode&0o777n,0o640n);
 }
 assert.equal(fileHash(large),preimage[2]);assert.deepEqual(audit(unrelated),unrelatedBefore);
 assert.equal(readdirSync(path.dirname(unrelated)).filter(f=>f.startsWith('untouched.txt')).length,1);
 console.log('Verified archive payloads, modes, both inode groups, and the unrelated legacy file after retained-driver rollback');
}finally{
 if(existsSync(fixture))execute(node,[service,'stop',fixture]);
 rmSync(scratch,{recursive:true,force:true});
}
