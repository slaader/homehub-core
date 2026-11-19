// Disposable signed-driver rehearsal against the real stock v1.0.0 hub and an independent UNIX listener.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {closeSync,copyFileSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {createConnection,createServer} from 'node:net';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {hashPassword} from '../../server/auth.mjs';
import {sourceLockPath} from '../../server/update-lock.mjs';
import {invokeWithCheckpoint} from './backup-rehearsal-crash.mjs';

const self=import.meta.filename,node=process.execPath;
const [mode,settingsFile]=process.argv.slice(2);
if(mode==='start'||mode==='stop'){
 const {root,pidFile,log}=JSON.parse(readFileSync(settingsFile,'utf8'));
 if(mode==='start'){
  const fd=openSync(log,'a',0o600);
  try{
   const child=spawn(node,[path.join(root,'server','index.mjs')],{cwd:root,detached:true,stdio:['ignore',fd,fd]});
   writeFileSync(pidFile,String(child.pid),{mode:0o600});
   child.unref();
  }
  finally{closeSync(fd);}
 }else if(existsSync(pidFile)){
  const pid=Number(readFileSync(pidFile,'utf8'));
  try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
 }
}else{
 const {values}=parseArgs({options:{aliases:{type:'boolean'},'unsigned-pin':{type:'string'},tag:{type:'string'},
  'tag-object':{type:'string'},'public-key':{type:'string'},fingerprint:{type:'string'}}});
 const supplied=[values.tag,values['tag-object'],values['public-key'],values.fingerprint].filter(Boolean).length;
 if(values['unsigned-pin'])assert.ok(supplied===2&&values.tag&&values['tag-object']&&/^[0-9a-f]{40}$/.test(values['unsigned-pin']),'unsigned rehearsal requires tag, tag object and full commit');
 else assert.ok(supplied===0||supplied===4,'--tag requires --tag-object, --public-key and --fingerprint');
 await rehearsal(values);
}

async function rehearsal(options){
 const source=path.resolve(path.dirname(self),'../..'),scratch=realpathSync(mkdtempSync(path.join(os.homedir(),'.hhu-')));
 const root=path.join(scratch,'install'),driver=path.join(scratch,'driver'),publisher=path.join(scratch,'publisher');
 const settings=path.join(scratch,'service.json'),log=path.join(scratch,'service.log'),trust=path.join(scratch,'trust.json');
 const allowed=path.join(scratch,'allowed-signers'),key=path.join(scratch,'publisher-key'),pidFile=path.join(scratch,'service.pid');
 const state=path.join(root,'data','state'),runFile=path.join(state,'run.json'),journalFile=path.join(root,'backups','update-journal.json');
 const readJson=file=>JSON.parse(readFileSync(file,'utf8'));
 const endpoint=path.join(root,'private','bridge.sock'),durable=path.join(root,'private','durable');
 const password='test-only-administrator',aliases=options.aliases;
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>['PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT'].includes(name)));
 Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',
  GIT_TERMINAL_PROMPT:'0',LOCAL_PREVIEW:'1',INVENTORY_LOCAL:'1',HOME_HUB_UPDATE_CHECK:'off',HOME_HUB_PLUGINS_DIR:'none'});
 const execute=(cmd,args)=>spawnSync(cmd,args,{cwd:scratch,env,encoding:'utf8',maxBuffer:8*1024**2});
 const run=(cmd,args,expected=0)=>{
  const result=execute(cmd,args);
  if(result.error)throw result.error;
  assert.equal(result.status,expected,`${cmd} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
 };
 const git=(dir,...args)=>run('git',['-C',dir,...args]);
 const service=JSON.stringify({start:[node,self,'start',settings],stop:[node,self,'stop',settings]});
 const cli=path.join(driver,'scripts','update.mjs'),stock=path.join(root,'scripts','update.mjs');
 const echo=result=>{if(result)console.log(result);};
 const bridge=createServer(connection=>connection.end('bridge alive\n'));
 let bridgeOpen=false;
 try{
  const oldTag='v1.0.0',target=options.tag??'v1.99.0-rehearsal';
  const stockTag=git(source,'rev-parse','refs/tags/'+oldTag);
  run('git',['clone','--quiet','--no-hardlinks',source,publisher]);
  let publicKey=options['public-key']&&path.resolve(options['public-key']);
  if(!options.tag){
   git(publisher,'fetch','--quiet',source,'HEAD');
   git(publisher,'checkout','--quiet','--detach','FETCH_HEAD');
   // Only this throwaway publisher checkout gets a synthetic version and signed tag.
   const pkg=path.join(publisher,'package.json'),release=readJson(pkg);
   release.version=target.slice(1);writeFileSync(pkg,JSON.stringify(release,null,2)+'\n');
   git(publisher,'-c','user.name=Home Hub','-c','user.email=dev@home-hub.invalid','-c','commit.gpgsign=false',
    'commit','--quiet','-am','Set version for disposable updater rehearsal');
   run('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);
   git(publisher,'-c','user.name=Home Hub','-c','user.email=dev@home-hub.invalid','-c','gpg.format=ssh',
    '-c',`user.signingkey=${key}`,'tag','-s','-m','Disposable release',target);
   publicKey=key+'.pub';
  }
  const tagObject=git(publisher,'rev-parse','refs/tags/'+target),commit=git(publisher,'rev-parse',tagObject+'^{commit}');
  if(options.tag)assert.equal(tagObject,options['tag-object']);

  run('git',['clone','--quiet','--no-hardlinks',publisher,root]);
  assert.equal(git(root,'rev-parse','refs/tags/'+oldTag),stockTag);
  git(root,'checkout','--quiet','--detach',oldTag);
  for(const dir of ['local','private','data/state'])mkdirSync(path.join(root,dir),{recursive:true,mode:0o700});
  copyFileSync(path.join(source,'tests','fixtures','site.json'),path.join(root,'local','site.json'));
  writeFileSync(path.join(root,'private','auth.json'),JSON.stringify({username:'admin',...hashPassword(password)}),{mode:0o600});
  writeFileSync(durable,'pre-update data',{mode:0o600});
  const repo=readJson(path.join(root,'package.json')).homeHub.updates.repo;
  const pinned=options['unsigned-pin'];
  if(pinned){
   assert.equal(commit,pinned);
   assert.equal(git(root,'rev-parse','refs/tags/'+target),tagObject);
  }else{
   const fingerprint=options.fingerprint??run('/usr/bin/ssh-keygen',['-lf',publicKey]).split(/\s+/)[1];
   run(node,[stock,'trust-import','--root',root,'--trust',trust,'--repository',repo,'--role','git',
    '--public-key',publicKey,'--fingerprint',fingerprint]);

   // Provision the driver with the same exact tag-object pin and SSH verification as the operator guide.
   writeFileSync(allowed,`release namespaces="git" ${readFileSync(publicKey,'utf8').trim()}\n`,{mode:0o600});
  }
  mkdirSync(driver,{mode:0o700});
  git(driver,'init','--quiet');
  git(driver,'fetch','--quiet','--no-tags',publisher,`refs/tags/${target}:refs/tags/${target}`);
  assert.equal(git(driver,'rev-parse','refs/tags/'+target),tagObject);
  if(!pinned)git(driver,'-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen',
   '-c',`gpg.ssh.allowedSignersFile=${allowed}`,'verify-tag',tagObject);
  git(driver,'-c','core.hooksPath=/dev/null','checkout','--quiet','--detach',tagObject+'^{commit}');

  const portPicker=createServer().listen(0,'127.0.0.1');
  await once(portPicker,'listening');
  const origin=`http://127.0.0.1:${portPicker.address().port}`,health=origin+'/healthz';
  env.PORT=String(portPicker.address().port);
  await new Promise(resolve=>portPicker.close(resolve));
  writeFileSync(settings,JSON.stringify({root,pidFile,log}));
  const flags=['--root',root,...(pinned?[]:['--trust',trust]),'--health',health,'--service','command:'+service];
  bridge.listen(endpoint);await once(bridge,'listening');bridgeOpen=true;
  const inode=lstatSync(endpoint,{bigint:true}).ino,folder=lstatSync(path.dirname(endpoint),{bigint:true}).ino;
  const verifyBridge=async()=>{
   assert.equal(lstatSync(endpoint,{bigint:true}).ino,inode);
   assert.equal(lstatSync(path.dirname(endpoint),{bigint:true}).ino,folder);
   const connection=createConnection(endpoint);let message='';
   connection.setTimeout(3000,()=>connection.destroy(new Error('socket connection timed out')));
   for await(const chunk of connection)message+=chunk;
   assert.equal(message,'bridge alive\n');
  };

  const alias=path.join(scratch,'legacy-alias'),coverage=[];
  if(aliases){
   linkSync(durable,alias);
   const report=JSON.parse(run(node,[cli,'backup-diagnose','--root',root,'--search-root',scratch,'--candidate-cover-files'],1));
   assert.deepEqual(report.candidatePolicy.coverFiles,[alias]);
   const policy=path.join(scratch,'backup-policy.json');
   writeFileSync(policy,JSON.stringify(report.candidatePolicy),{mode:0o600});
   coverage.push('--backup-policy',policy);
  }
  const ready=JSON.parse(run(node,[cli,'preflight','--read-only',...flags,...coverage]));
  assert.equal(ready.runtimeSockets.count,1);
  run(node,[self,'start',settings]);
  for(let i=0;i<60&&!existsSync(runFile);i++)await delay(100);
  assert.equal(readJson(runFile).version,'1.0.0');
  assert.equal((await fetch(health)).status,200);
  await verifyBridge();
  const post=(route,document,cookie)=>fetch(origin+route,{method:'POST',headers:{Origin:origin,
   'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(document)});
  const login=async()=>{
   const response=await post('/api/session',{username:'admin',password});
   assert.equal(response.status,200);
   return response.headers.get('set-cookie').split(';')[0];
  };
  await login();
  console.log(`Stock ${oldTag} @ ${git(root,'rev-parse','HEAD')} → ${pinned?'pinned':'signed'} ${target} @ ${commit}, tag object ${tagObject}`);
  echo(run(node,[cli,'apply',target,...flags,...coverage,'--no-fetch','--skip-tests']));
  await verifyBridge();
  assert.equal(git(root,'rev-parse','HEAD'),commit);
  assert.equal(readJson(runFile).fullCommit,commit);
  const cookie=await login();
  const wiki=await post('/api/wiki/setup',{project:'home-hub'},cookie);
  assert.equal(wiki.status,201);
  const {home}=await wiki.json();
  assert.equal((await (await fetch(origin+'/api/wiki/home-hub/pages/'+home,{headers:{Cookie:cookie}})).json()).title,'Home');
  writeFileSync(durable,'target data');
  const j=readJson(journalFile),retained=path.join(j.driver,'scripts','update.mjs');
  const rollback=['rollback','--yes',...flags];
  const crash=invokeWithCheckpoint(execute,node,retained,rollback,'restore-all-prepared');
  assert.equal(crash.signal,'SIGKILL',crash.stdout+crash.stderr);
  for(const lock of [path.join(root,'backups','update.lock'),sourceLockPath(root),sourceLockPath(path.join(root,'.git'))]){
   const {pid}=readJson(path.join(lock,'owner.json'));
   assert.equal(pid,crash.pid);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
   renameSync(lock,path.join(scratch,'stale-'+randomUUID()));
  }
  await verifyBridge();
  echo(run(node,[retained,...rollback]));
  await verifyBridge();
  assert.equal(git(root,'rev-parse','refs/tags/'+oldTag),stockTag);
  assert.equal(git(root,'rev-parse','HEAD'),git(root,'rev-parse',oldTag+'^{commit}'));
  assert.equal(readJson(runFile).version,'1.0.0');
  assert.equal((await fetch(health)).status,200);
  await login();
  assert.equal(readFileSync(durable,'utf8'),'pre-update data');
  if(aliases){
   assert.equal(lstatSync(durable,{bigint:true}).ino,lstatSync(alias,{bigint:true}).ino);
   assert.equal(readFileSync(alias,'utf8'),'pre-update data');
  }
  console.log('Verified wiki setup on the upgraded hub, stock startup after recovery, and UNIX socket identity and reachability throughout');
 }catch(error){
  if(existsSync(log))console.error(readFileSync(log,'utf8'));
  throw error;
 }finally{
  if(existsSync(pidFile)){
   execute(node,[self,'stop',settings]);
   const pid=Number(readFileSync(pidFile,'utf8'));
   for(let i=0;i<30;i++){
    try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')break;throw e;}
    await delay(100);
   }
  }
  if(bridgeOpen)await new Promise(resolve=>bridge.close(resolve));
  rmSync(scratch,{recursive:true,force:true});
 }
}
