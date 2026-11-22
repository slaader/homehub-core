import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,readlinkSync,lstatSync,existsSync,readdirSync,realpathSync,linkSync,renameSync} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createConnection,createServer} from 'node:net';
import {once} from 'node:events';
import {writeUpdateJournal} from '../server/update-journal.mjs';
import {backupPlan,createBackup,restoreBackup,assessRestore} from '../server/update-backup.mjs';
import {readUpdateJournal} from '../server/update-journal.mjs';
function fixture(t,temp=os.tmpdir()){const dir=realpathSync(mkdtempSync(path.join(temp,'hub-backup-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));const paths={data:path.join(dir,'data'),state:path.join(dir,'data','state'),private:path.join(dir,'private'),config:path.join(dir,'config'),authFile:path.join(dir,'external','auth.json'),siteConfig:path.join(dir,'config','site.json'),softwareWatch:path.join(dir,'config','software-watch.json')};for(const p of [paths.state,paths.private,paths.config,path.dirname(paths.authFile),path.join(dir,'backups'),path.join(dir,'staging')])mkdirSync(p,{recursive:true});writeFileSync(paths.authFile,'auth',{mode:0o600});writeFileSync(path.join(path.dirname(paths.authFile),'secret.key'),'key',{mode:0o600});writeFileSync(path.join(paths.data,'legitimate.tgz'),'archive bytes');writeFileSync(paths.siteConfig,'{}');const inst={home:dir,root:path.join(dir,'core'),paths,env:{},backups:path.join(dir,'backups'),staging:path.join(dir,'staging'),files:{journal:path.join(dir,'journal.json'),lock:path.join(dir,'update.lock')}};writeFileSync(path.join(dir,'instance.json'),'{}');return {dir,inst,ctx:{now:()=>0,log:()=>{},checkpoint:()=>{}}};}
function journal(inst,backup){const side={label:'1.0.0',core:{version:'1.0.0'},expect:{version:'1.0.0'}};return {schemaVersion:3,id:'restore-test',startedAt:new Date(0).toISOString(),step:'rolling-back',from:side,to:side,changes:[],epochRose:true,backup,settings:{root:inst.root,state:inst.paths.state,service:{stop:['true'],start:['true']},health:{url:'http://127.0.0.1:1/healthz',seconds:2}}};}
test('backup: canonical coverage includes external auth/key, duplicate basenames, links and legitimate archives',async t=>{
 const {dir,inst,ctx}=fixture(t),external=path.join(dir,'physical-data');rmSync(inst.paths.data,{recursive:true});mkdirSync(external);writeFileSync(path.join(external,'legitimate.tgz'),'kept');symlinkSync(external,inst.paths.data);inst.paths.state=path.join(inst.paths.data,'state');mkdirSync(inst.paths.state);const other=path.join(dir,'other','private');mkdirSync(other,{recursive:true});writeFileSync(path.join(other,'one'),'one');inst.backupRoots=[other];symlinkSync('../external/auth.json',path.join(inst.paths.private,'auth-link'));
 const plan=backupPlan(inst);assert.equal(new Set(plan.roots.map(r=>r.id)).size,plan.roots.length);assert.ok(plan.roots.some(r=>r.canonical===inst.paths.authFile));assert.ok(plan.roots.some(r=>r.canonical.endsWith('secret.key')));
 const backup=await createBackup(inst,ctx,'test');writeFileSync(path.join(external,'legitimate.tgz'),'changed');writeFileSync(inst.paths.authFile,'changed');const j=journal(inst,backup);await restoreBackup(inst,ctx,backup,j);
 assert.equal(readFileSync(path.join(external,'legitimate.tgz'),'utf8'),'kept');assert.equal(readFileSync(inst.paths.authFile,'utf8'),'auth');assert.equal(lstatSync(inst.paths.authFile).mode&0o777,0o600);assert.equal(readlinkSync(inst.paths.data),external);assert.equal(readlinkSync(path.join(inst.paths.private,'auth-link')),'../external/auth.json');
});
test('backup: corrupt or incomplete archives move no live roots',async t=>{
 const {inst,ctx}=fixture(t),backup=await createBackup(inst,ctx,'test'),before=readFileSync(inst.paths.authFile),payload=readFileSync(backup.file);writeFileSync(backup.file,payload.subarray(0,payload.length-1));await assert.rejects(restoreBackup(inst,ctx,backup,journal(inst,backup)),/integrity/);assert.ok(readFileSync(inst.paths.authFile).equals(before));assert.ok(!readdirSync(path.dirname(inst.paths.data)).some(n=>n.includes('.failed-')));
});
test('backup: interrupted root renames reconcile in a fresh journal read without losing failed state',async t=>{
 for(const boundary of ['restore-old-renamed','restore-new-renamed']){const {inst,ctx}=fixture(t),backup=await createBackup(inst,ctx,'test'),j=journal(inst,backup);writeFileSync(inst.paths.authFile,'failed data');writeUpdateJournal(inst.files.journal,j);
 const script=`import {readUpdateJournal} from ${JSON.stringify(new URL('../server/update-journal.mjs',import.meta.url).href)};import {restoreBackup} from ${JSON.stringify(new URL('../server/update-backup.mjs',import.meta.url).href)};const inst=${JSON.stringify(inst)};const j=readUpdateJournal(inst.files.journal);await restoreBackup(inst,{now:()=>0,log:()=>{},checkpoint:p=>{if(p===${JSON.stringify(boundary)})process.exit(99);}},j.backup,j);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,99,child.stderr);const persisted=readUpdateJournal(inst.files.journal);await restoreBackup(inst,ctx,backup,persisted);assert.equal(readFileSync(inst.paths.authFile,'utf8'),'auth');assert.ok(persisted.restoreRoots.every(r=>r.status==='installed'));const failed=persisted.restoreRoots.find(r=>r.live===inst.paths.authFile).aside;assert.equal(readFileSync(failed,'utf8'),'failed data');}
});
test('backup: uncovered escaping and dangling links and self-including destinations refuse',t=>{
 const {dir,inst}=fixture(t);linkSync(inst.paths.authFile,path.join(dir,'hard-link'));assert.throws(()=>backupPlan(inst),/hard-linked/);rmSync(path.join(dir,'hard-link'));writeFileSync(path.join(dir,'uncovered'),'x');symlinkSync('../uncovered',path.join(inst.paths.private,'link'));assert.throws(()=>backupPlan(inst),/uncovered escaping/);rmSync(path.join(inst.paths.private,'link'));symlinkSync('missing',path.join(inst.paths.private,'link'));assert.throws(()=>backupPlan(inst),/dangling/);rmSync(path.join(inst.paths.private,'link'));inst.backups=path.join(inst.paths.data,'backups');assert.throws(()=>backupPlan(inst),/inside/);
});
test('backup: interrupted rename of a symlinked root can be resumed',async t=>{
 const {dir,inst,ctx}=fixture(t),physical=path.join(dir,'physical');rmSync(inst.paths.data,{recursive:true});mkdirSync(physical);mkdirSync(path.join(physical,'state'));writeFileSync(path.join(physical,'value'),'before');symlinkSync(physical,inst.paths.data);const backup=await createBackup(inst,ctx,'symlink-crash'),j=journal(inst,backup);writeUpdateJournal(inst.files.journal,j);
 const root=backup.entries.find(e=>e.canonical===physical);let crashed=false;
 await assert.rejects(restoreBackup(inst,{...ctx,checkpoint:p=>{if(p==='restore-old-renamed'&&!crashed){crashed=true;throw new Error('crash');}}},backup,j),/crash/);
 assert.equal(j.restoreRoots.find(p=>p.id===root.id).status,'moving-old');
 await restoreBackup(inst,ctx,backup,readUpdateJournal(inst.files.journal));
 assert.equal(readFileSync(path.join(inst.paths.data,'value'),'utf8'),'before');
});

test('hard links across roots and exact paths recover together after interruption',async t=>{
 for(const boundary of ['restore-prepare-mid','restore-all-prepared','restore-new-renamed'])await t.test(boundary,async t=>{
  const {dir,inst,ctx}=fixture(t);
  const file=path.join(inst.paths.data,'payload'),local=path.join(inst.paths.data,'local'),other=path.join(inst.paths.private,'cross-root');
  const legacy=path.join(dir,'legacy'),alias=path.join(legacy,'covered'),unrelated=path.join(legacy,'unrelated');
  mkdirSync(legacy);writeFileSync(file,'archived bytes',{mode:0o640});writeFileSync(unrelated,'unrelated');
  for(const name of [local,other,alias])linkSync(file,name);
  const policyDir=mkdtempSync(path.join(os.homedir(),'.home-hub-backup-test-'));t.after(()=>rmSync(policyDir,{recursive:true,force:true}));
  inst.backupPolicyFile=path.join(policyDir,'policy.json');
  writeFileSync(inst.backupPolicyFile,JSON.stringify({schemaVersion:1,coverFiles:[alias]}),{mode:0o600});
  const backup=await createBackup(inst,ctx,'links'),j=journal(inst,backup);
  assert.equal(backup.entries.filter(r=>r.role==='exact-file').length,1);
  writeFileSync(file,'failed data');
  const before=lstatSync(unrelated,{bigint:true});
  writeUpdateJournal(inst.files.journal,j);
  const script=`import {readUpdateJournal} from ${JSON.stringify(new URL('../server/update-journal.mjs',import.meta.url).href)};
   import {restoreBackup} from ${JSON.stringify(new URL('../server/update-backup.mjs',import.meta.url).href)};
   const inst=${JSON.stringify(inst)};const j=readUpdateJournal(inst.files.journal);
   await restoreBackup(inst,{now:()=>0,log:()=>{},checkpoint:p=>{if(p===${JSON.stringify(boundary)})process.exit(99);}},j.backup,j);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(child.status,99,child.stderr);
  const persisted=readUpdateJournal(inst.files.journal);
  const stages=persisted.restoreRoots.map(r=>r.stageDir);
  await restoreBackup(inst,ctx,backup,persisted);
  const names=[file,local,other,alias],stats=names.map(n=>lstatSync(n,{bigint:true}));
  assert.ok(stats.every(s=>s.ino===stats[0].ino&&s.dev===stats[0].dev&&s.nlink===4n&&(s.mode&0o777n)===0o640n));
  assert.equal(readFileSync(file,'utf8'),'archived bytes');
  assert.ok(stages.every(p=>!existsSync(p)));
  const after=lstatSync(unrelated,{bigint:true});
  assert.deepEqual([after.ino,after.nlink,after.size,after.mtimeNs,after.ctimeNs],[before.ino,before.nlink,before.size,before.mtimeNs,before.ctimeNs]);
  assert.equal(readFileSync(unrelated,'utf8'),'unrelated');
 });
});

test('rollback refuses unknown live aliases and replacements of an enrolled exact file before moving roots',async t=>{
 const {dir,inst,ctx}=fixture(t),file=path.join(inst.paths.data,'payload'),exact=path.join(dir,'exact'),outside=path.join(dir,'outside');
 const policyDir=mkdtempSync(path.join(os.homedir(),'.home-hub-backup-test-'));t.after(()=>rmSync(policyDir,{recursive:true,force:true}));
 inst.backupPolicyFile=path.join(policyDir,'policy.json');
 writeFileSync(inst.backupPolicyFile,JSON.stringify({schemaVersion:1,coverFiles:[exact]}),{mode:0o600});
 writeFileSync(file,'old');linkSync(file,exact);
 const backup=await createBackup(inst,ctx,'exact'),j=journal(inst,backup);
 linkSync(file,outside);
 await assert.rejects(restoreBackup(inst,ctx,backup,j),/HARDLINK_UNACCOUNTED/);
 rmSync(outside);rmSync(exact);writeFileSync(exact,'unrelated replacement');
 await assert.rejects(restoreBackup(inst,ctx,backup,j),/exact alias identity changed/);
 assert.equal(readFileSync(exact,'utf8'),'unrelated replacement');
 assert.equal(j.restoreRoots,undefined);
});

test('tagged v1.0.0 tar and sidecars remain readable and retain schema-2 journal recovery',async t=>{
 const {dir,inst,ctx}=fixture(t);
 const old=JSON.parse(readFileSync(new URL('./fixtures/update/backup-v1.json',import.meta.url),'utf8'));
 const file=path.join(inst.backups,'old.tgz'),manifest=file+'.manifest.json',integrity=file+'.integrity.json';
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 assert.equal(digest(JSON.stringify(old.manifest,null,1)+'\n'),old.integrity.manifestSha256);
 // Only the host's root paths are relocated; the old tar stream is unchanged.
 Object.assign(old.manifest.roots[0],{canonical:inst.paths.data,logical:inst.paths.data,parent:dir});
 const relocated=JSON.stringify(old.manifest,null,1)+'\n';
 writeFileSync(file,Buffer.from(old.archiveBase64,'base64'));
 writeFileSync(manifest,relocated);
 writeFileSync(integrity,JSON.stringify({...old.integrity,manifestSha256:digest(relocated)}));
 const backup={file,manifest,integrity,entries:old.manifest.roots};
 const j={...journal(inst,backup),schemaVersion:2};
 writeUpdateJournal(inst.files.journal,j);
 const loaded=readUpdateJournal(inst.files.journal);
 const outside=path.join(dir,'outside-legacy');
 linkSync(path.join(inst.paths.data,'legitimate.tgz'),outside);
 await assert.rejects(assessRestore(inst,loaded.backup,loaded),/HARDLINK_UNACCOUNTED/);
 rmSync(outside);
 await restoreBackup(inst,ctx,loaded.backup,loaded);
 assert.equal(readUpdateJournal(inst.files.journal).schemaVersion,2);
 const restored=path.join(inst.paths.data,'payload');
 assert.equal(readFileSync(restored,'utf8'),'archived by v1.0.0\n');
 assert.equal(lstatSync(restored).mode&0o777,0o640);

 // A legacy archive has no sidecars and uses the name in the journal as its tar prefix.
 const legacy={file,entries:[{parent:dir,name:'root-0001'}]};
 await restoreBackup(inst,ctx,legacy);
 assert.equal(readFileSync(path.join(dir,'root-0001','payload'),'utf8'),'archived by v1.0.0\n');
});

async function listen(t,file){
 const server=createServer(connection=>connection.end('endpoint\n'));
 server.listen(file);
 await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return lstatSync(file,{bigint:true}).ino;
}

async function reachable(file,expectedInode){
 assert.equal(lstatSync(file,{bigint:true}).ino,expectedInode);
 const connection=createConnection(file);
 connection.setTimeout(3000,()=>connection.destroy(new Error('socket connection timed out')));
 let reply='';
 for await(const chunk of connection)reply+=chunk;
 assert.equal(reply,'endpoint\n');
}

test('backup and rollback keep live UNIX sockets and journal durable children independently',async t=>{
 for(const boundary of ['restore-old-renamed','restore-new-renamed','restore-cleaned'])await t.test(boundary,async t=>{
  const {dir,inst,ctx}=fixture(t,'/tmp');
  const socket=path.join(inst.paths.state,'service.sock'),endpoint=await listen(t,socket);
  const standalone=path.join(dir,'standalone.sock'),standaloneInode=await listen(t,standalone);
  inst.backupRoots=[standalone];
  const value=path.join(inst.paths.state,'value'),cross=path.join(inst.paths.config,'linked-value');
  writeFileSync(value,'before');linkSync(value,cross);
  symlinkSync('service.sock',path.join(inst.paths.state,'socket-link'));
  const addresses=path.join(inst.paths.private,'addresses'),front=path.join(addresses,'front');
  const middle=path.join(inst.paths.state,'middle'),byDir=path.join(addresses,'by-dir');
  const jump=path.join(addresses,'jump'),detour=path.join(inst.paths.state,'detour');
  const forward=path.join(inst.paths.config,'forward');
  mkdirSync(addresses);mkdirSync(detour);
  symlinkSync('service.sock',middle);
  symlinkSync('../../data/state/detour',jump);
  symlinkSync('jump/../middle',front);
  symlinkSync('../../data/state',byDir);
  symlinkSync('../private/addresses',forward);
  const aliasPaths=[front,middle,byDir,jump,forward],aliasInodes=aliasPaths.map(file=>lstatSync(file,{bigint:true}).ino);
  const checkAliases=async()=>{
   await reachable(front,aliasInodes[0]);
   await reachable(middle,aliasInodes[1]);
   await reachable(path.join(byDir,'service.sock'),endpoint);
   await reachable(path.join(forward,'front'),aliasInodes[0]);
   assert.deepEqual(aliasPaths.map(file=>lstatSync(file,{bigint:true}).ino),aliasInodes);
  };
  const ancestors=[inst.paths.data,inst.paths.state,inst.paths.private,addresses,detour];
  const ancestorInodes=ancestors.map(file=>lstatSync(file,{bigint:true}).ino);
  const plan=backupPlan(inst);
  assert.equal(plan.runtimeSockets.count,2);
  const backup=await createBackup(inst,ctx,'sockets',{plan});
  const archived=readFileSync(backup.manifest,'utf8').trim().split('\n').slice(1).map(line=>JSON.parse(line));
  assert.ok(archived.some(e=>e.path.endsWith('/state/value')));
  assert.ok(!archived.some(e=>e.path.endsWith('.sock')));
  await reachable(socket,endpoint);
  await reachable(standalone,standaloneInode);

  writeFileSync(value,'after');rmSync(path.join(inst.paths.state,'socket-link'));
  const newDir=path.join(inst.paths.private,'new'),newSocket=path.join(newDir,'new.sock');
  mkdirSync(newDir);
  const newEndpoint=await listen(t,newSocket),newDirInode=lstatSync(newDir,{bigint:true}).ino;
  const newValue=path.join(newDir,'added');
  writeFileSync(newValue,'created after backup');
  const otherNew=path.join(inst.paths.state,'also-added');
  mkdirSync(otherNew);writeFileSync(path.join(otherNew,'child'),'another addition');

  const j=journal(inst,backup);writeUpdateJournal(inst.files.journal,j);
  const script=`import {readUpdateJournal} from ${JSON.stringify(new URL('../server/update-journal.mjs',import.meta.url).href)};
   import {restoreBackup} from ${JSON.stringify(new URL('../server/update-backup.mjs',import.meta.url).href)};
   import {existsSync,readFileSync} from 'node:fs';
   const inst=${JSON.stringify(inst)}, value=${JSON.stringify(value)}, j=readUpdateJournal(inst.files.journal);
   await restoreBackup(inst,{now:()=>0,log:()=>{},checkpoint:p=>{
    if(p===${JSON.stringify(boundary)}&&(${boundary==='restore-old-renamed'?"!existsSync(value)":"existsSync(value)&&readFileSync(value,'utf8')==='before'"}))process.exit(99);
   }},j.backup,j);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(child.status,99,child.stderr);
  await reachable(socket,endpoint);
  await reachable(newSocket,newEndpoint);
  await reachable(standalone,standaloneInode);
  await checkAliases();
  const persisted=readUpdateJournal(inst.files.journal);
  assert.ok(persisted.socketRestore.units.some(u=>u.live===value));
  const index=await restoreBackup(inst,ctx,backup,persisted);
  await reachable(socket,endpoint);
  await reachable(newSocket,newEndpoint);
  await reachable(standalone,standaloneInode);
  await checkAliases();
  assert.deepEqual(ancestors.map(file=>lstatSync(file,{bigint:true}).ino),ancestorInodes);
  assert.equal(lstatSync(newDir,{bigint:true}).ino,newDirInode);
  assert.equal(readFileSync(value,'utf8'),'before');
  assert.equal(lstatSync(cross,{bigint:true}).ino,lstatSync(value,{bigint:true}).ino);
  assert.equal(readlinkSync(path.join(inst.paths.state,'socket-link')),'service.sock');
  const moved=new Map(JSON.parse(readFileSync(path.join(index,'roots.json'))).map(p=>[p.live,p.aside]));
  assert.equal(readFileSync(moved.get(value),'utf8'),'after');
  assert.equal(readFileSync(moved.get(newValue),'utf8'),'created after backup');
  assert.equal(readFileSync(path.join(moved.get(otherNew),'child'),'utf8'),'another addition');
  assert.ok(!existsSync(newValue)&&!existsSync(otherNew));
  assert.equal(backupPlan(inst).runtimeSockets.count,3);
 });
});

test('rollback refuses a socket at an archived durable pathname before changing live state',async t=>{
 const {inst,ctx}=fixture(t,'/tmp');
 const file=path.join(inst.paths.state,'conflict');
 writeFileSync(file,'archived regular file');
 const backup=await createBackup(inst,ctx,'conflict');
 rmSync(file);const socket=await listen(t,file),j=journal(inst,backup);
 await assert.rejects(restoreBackup(inst,ctx,backup,j),/would replace a UNIX socket/);
 assert.equal(j.restoreRoots,undefined);
 await reachable(file,socket);
});

test('backup refuses an absent root that appeared after planning',async t=>{
 const {inst,ctx,dir}=fixture(t),extra=path.join(dir,'extra');
 inst.backupRoots=[extra];
 const plan=backupPlan(inst);
 writeFileSync(extra,'appeared');
 await assert.rejects(createBackup(inst,ctx,'raced',{plan}),/root topology changed/);
 assert.deepEqual(readdirSync(inst.backups),[]);
});

test('resume resolves each component of aliases through moved roots and children',async t=>{
 for(const split of [false,true])await t.test(split?'journalled child':'whole root',async t=>{
  const {dir,inst,ctx}=fixture(t,'/tmp');
  const links=path.join(inst.paths.data,'chain'),hop=path.join(links,'hop');
  mkdirSync(links);
  mkdirSync(path.join(inst.paths.data,'landing','sub'),{recursive:true});
  writeFileSync(path.join(inst.paths.data,'landing','legitimate.tgz'),'via hop');
  symlinkSync('hop/../legitimate.tgz',path.join(links,'entry'));
  symlinkSync('../landing/sub',hop);
  inst.paths.authFile=path.join(dir,'external','auth-link');
  symlinkSync('../data/chain/entry',inst.paths.authFile);
  const socket=path.join(inst.paths.state,'service.sock'),endpoint=split?await listen(t,socket):null;
  const backup=await createBackup(inst,ctx,'embedded'),j=journal(inst,backup);
  await assert.rejects(restoreBackup(inst,{...ctx,checkpoint:name=>{
   if(name==='restore-old-renamed'&&!existsSync(links))throw new Error('interruption');
  }},backup,j),/interruption/);
  const persisted=readUpdateJournal(inst.files.journal);
  const moved=(split?persisted.socketRestore.units:persisted.restoreRoots).find(p=>p.status==='moving-old');
  const oldHop=split?path.join(moved.aside,'hop'):path.join(moved.aside,'chain','hop');
  rmSync(oldHop);symlinkSync('hop',oldHop);
  await assert.rejects(assessRestore(inst,backup,persisted),/alias topology changed/);
  rmSync(oldHop);symlinkSync('../landing/sub',oldHop);
  await restoreBackup(inst,ctx,backup,persisted);
  assert.equal(readFileSync(inst.paths.authFile,'utf8'),'via hop');
  if(split)await reachable(socket,endpoint);
 });
});

test('rollback restores a missing covered target through an unchanged external alias',async t=>{
 const {dir,inst,ctx}=fixture(t),target=path.join(inst.paths.data,'legitimate.tgz');
 inst.paths.authFile=path.join(dir,'external','auth-link');
 symlinkSync('../data/legitimate.tgz',inst.paths.authFile);
 const backup=await createBackup(inst,ctx,'removed-target');
 rmSync(target);
 await restoreBackup(inst,ctx,backup,journal(inst,backup));
 assert.equal(readFileSync(inst.paths.authFile,'utf8'),'archive bytes');
});

test('rollback refuses unaligned and replaced live socket aliases',async t=>{
 const {inst,ctx}=fixture(t,'/tmp');
 const socket=path.join(inst.paths.state,'service.sock');
 const endpoint=await listen(t,socket);
 const alias=path.join(inst.paths.config,'address'),alternate=path.join(inst.paths.state,'alternate');
 symlinkSync('service.sock',alternate);
 symlinkSync('../data/state/service.sock',alias);
 const backup=await createBackup(inst,ctx,'socket-alias'),j=journal(inst,backup);
 const link='../data/state/service.sock';
 rmSync(alias);symlinkSync('../data/state/alternate',alias);
 await assert.rejects(restoreBackup(inst,ctx,backup,j),/would replace a UNIX socket.*address/);
 assert.equal(j.restoreRoots,undefined);
 await reachable(alias,lstatSync(alias,{bigint:true}).ino);
 rmSync(alias);symlinkSync(link,alias);
 const added=path.join(inst.paths.config,'added');
 symlinkSync('address',added);
 await assert.rejects(restoreBackup(inst,ctx,backup,j),/would replace a UNIX socket.*added/);
 await reachable(added,lstatSync(added,{bigint:true}).ino);
 rmSync(added);

 await assert.rejects(restoreBackup(inst,{...ctx,checkpoint:name=>{
  if(name==='restore-all-prepared')throw new Error('interruption');
 }},backup,j),/interruption/);
 const replaced=path.join(inst.paths.config,'replaced');
 symlinkSync(link,replaced);renameSync(replaced,alias);
 await assert.rejects(restoreBackup(inst,ctx,backup,readUpdateJournal(inst.files.journal)),/Preserved UNIX socket alias changed/);
 await reachable(alias,lstatSync(alias,{bigint:true}).ino);
 await reachable(socket,endpoint);
});

test('resume rejects a shutdown write to an already installed root',async t=>{
 const {inst,ctx}=fixture(t),backup=await createBackup(inst,ctx,'shutdown-write'),j=journal(inst,backup);
 await assert.rejects(restoreBackup(inst,{...ctx,checkpoint:name=>{
  if(name==='restore-new-renamed')throw new Error('interruption');
 }},backup,j),/interruption/);
 const persisted=readUpdateJournal(inst.files.journal);
 const assessed=await assessRestore(inst,backup,persisted);
 writeFileSync(path.join(inst.paths.data,'legitimate.tgz'),'shutdown write');
 await assert.rejects(restoreBackup(inst,ctx,backup,persisted,assessed),/staging content/);
 assert.equal(readFileSync(path.join(inst.paths.data,'legitimate.tgz'),'utf8'),'shutdown write');
});

test('assessRestore().coversFile works identically across v2 (including exact-file alias roots), v1 and legacy archives',async t=>{
 const {dir,inst,ctx}=fixture(t,'/tmp');
 const payload=path.join(inst.paths.data,'payload'),aliasDir=path.join(dir,'legacy'),alias=path.join(aliasDir,'alias.bin');
 const link=path.join(inst.paths.private,'payload-link'),outside=path.join(dir,'outside.txt');
 const sock=path.join(inst.paths.state,'live.sock');
 mkdirSync(aliasDir);
 writeFileSync(payload,'exact payload',{mode:0o640});
 linkSync(payload,alias);
 symlinkSync('../data/payload',link);
 writeFileSync(outside,'outside');
 await listen(t,sock);
 const policyDir=mkdtempSync(path.join(os.homedir(),'.home-hub-backup-test-'));
 t.after(()=>rmSync(policyDir,{recursive:true,force:true}));
 inst.backupPolicyFile=path.join(policyDir,'policy.json');
 writeFileSync(inst.backupPolicyFile,JSON.stringify({schemaVersion:1,coverFiles:[alias]}),{mode:0o600});
 const backup=await createBackup(inst,ctx,'covers-v2');
 const assessed=await assessRestore(inst,backup);
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 const payloadHash=digest('exact payload'),instanceHash=digest('{}');
 const instanceFile=path.join(dir,'instance.json');
 assert.equal(assessed.coversFile(payload),true);
 assert.equal(assessed.coversFile(payload,{sha256:payloadHash,mode:0o640}),true);
 assert.equal(assessed.coversFile(payload,{sha256:payloadHash,mode:0o600}),false);
 assert.equal(assessed.coversFile(payload,{sha256:digest('other'),mode:0o640}),false);
 assert.equal(assessed.coversFile(alias),true);
 assert.equal(assessed.coversFile(alias,{sha256:payloadHash,mode:0o640}),true);
 assert.equal(assessed.coversFile(alias,{sha256:payloadHash,mode:0o600}),false);
 assert.equal(assessed.coversFile(instanceFile),true);
 assert.equal(assessed.coversFile(instanceFile,{sha256:instanceHash}),true);
 assert.equal(assessed.coversFile(inst.paths.data),false,'directories are not covered regular files');
 assert.equal(assessed.coversFile(link),false,'symlinks are not covered regular files');
 assert.equal(assessed.coversFile(sock),false,'runtime sockets are not covered regular files');
 assert.equal(assessed.coversFile(outside),false,'uncovered paths return false');
 assert.equal(assessed.coversFile(path.join(inst.paths.data,'nonexistent')),false);

 // Moving an archived directory (or subdirectory) and leaving a symlink at its old path — EVEN when combined with
 // an outer path alias (symlinked parent) and pointing the inner symlink into ANOTHER archived root — must match
 // the original archived root's entry, never the target root's file.
 const movedConfig=path.join(dir,'config-moved');
 const subDir=path.join(inst.paths.config,'sub'),otherSub=path.join(inst.paths.data,'sub');
 mkdirSync(subDir);mkdirSync(otherSub);
 const subFile=path.join(subDir,'nested.json'),otherFile=path.join(otherSub,'nested.json');
 writeFileSync(subFile,'{"from":"config"}\n',{mode:0o640});
 writeFileSync(otherFile,'{"from":"data"}\n',{mode:0o640});
 const movedBackup=await createBackup(inst,ctx,'covers-moved');
 const movedAssessed=await assessRestore(inst,movedBackup);
 const subHash=digest('{"from":"config"}\n'),otherHash=digest('{"from":"data"}\n');
 const outerAlias=path.join(os.tmpdir(),'hub-outer-alias-'+process.pid+'-'+Date.now());
 symlinkSync(dir,outerAlias);
 t.after(()=>rmSync(outerAlias,{force:true}));
 const aliasedSubFile=path.join(outerAlias,'config','sub','nested.json');
 rmSync(subDir,{recursive:true});
 symlinkSync(otherSub,subDir);
 assert.equal(movedAssessed.coversFile(subFile,{sha256:subHash,mode:0o640}),true,'canonical path matches archived config root');
 assert.equal(movedAssessed.coversFile(aliasedSubFile,{sha256:subHash,mode:0o640}),true,'outer alias + inner symlink into another archived root still matches config root');
 assert.equal(movedAssessed.coversFile(aliasedSubFile,{sha256:otherHash,mode:0o640}),false,'must not match the other archived root file via inner symlink');
 rmSync(subDir);mkdirSync(subDir);writeFileSync(subFile,'{"from":"config"}\n',{mode:0o640});
 renameSync(inst.paths.config,movedConfig);
 symlinkSync(movedConfig,inst.paths.config);
 assert.equal(movedAssessed.coversFile(subFile,{sha256:subHash,mode:0o640}),true,'coversFile matches archived root even when live root dir was replaced by a symlink');
 rmSync(inst.paths.config);renameSync(movedConfig,inst.paths.config);

 // v1 sidecar archive and legacy sidecar-less archive (separate fixture without live sockets)
 const v1=fixture(t);
 const old=JSON.parse(readFileSync(new URL('./fixtures/update/backup-v1.json',import.meta.url),'utf8'));
 const v1File=path.join(v1.inst.backups,'v1-covers.tgz'),v1Manifest=v1File+'.manifest.json',v1Integrity=v1File+'.integrity.json';
 Object.assign(old.manifest.roots[0],{canonical:v1.inst.paths.data,logical:v1.inst.paths.data,parent:v1.dir});
 const relocated=JSON.stringify(old.manifest,null,1)+'\n';
 writeFileSync(v1File,Buffer.from(old.archiveBase64,'base64'));
 writeFileSync(v1Manifest,relocated);
 writeFileSync(v1Integrity,JSON.stringify({...old.integrity,manifestSha256:digest(relocated)}));
 const v1Assessed=await assessRestore(v1.inst,{file:v1File,manifest:v1Manifest,integrity:v1Integrity,entries:old.manifest.roots});
 const v1Payload=path.join(v1.inst.paths.data,'payload');
 assert.equal(v1Assessed.coversFile(v1Payload),true);
 assert.equal(v1Assessed.coversFile(v1Payload,{sha256:old.manifest.files[1].sha256,mode:0o640}),true);
 assert.equal(v1Assessed.coversFile(v1Payload,{sha256:old.manifest.files[1].sha256,mode:0o600}),false);
 assert.equal(v1Assessed.coversFile(v1Payload,{sha256:digest('wrong'),mode:0o640}),false);
 assert.equal(v1Assessed.coversFile(v1.inst.paths.data),false);
 assert.equal(v1Assessed.coversFile(path.join(v1.dir,'outside.txt')),false);

 // Genuine sidecar-less legacy archive created with the historical `tar -czf` writer (including macOS PAX/AppleDouble headers)
 // assesses and restores cleanly, and read-only assessment rejects missing roots and collisions.
 const legacyRoot=path.join(v1.dir,'legacy-root');mkdirSync(legacyRoot);
 const legacySrc=path.join(legacyRoot,'site.json');
 writeFileSync(legacySrc,'{"legacy":1}\n',{mode:0o640});
 const legacyArchive=path.join(v1.inst.backups,'legacy-only.tgz');
 const tarRes=spawnSync('tar',['-czf',legacyArchive,'-C',v1.dir,'legacy-root'],{encoding:'utf8'});
 assert.equal(tarRes.status,0,tarRes.stderr);
 const legacyBackup={file:legacyArchive,entries:[{parent:v1.dir,name:'legacy-root'}]};
 const legacyAssessed=await assessRestore(v1.inst,legacyBackup);
 const legacyHash=digest('{"legacy":1}\n');
 assert.equal(legacyAssessed.coversFile(legacySrc),true);
 assert.equal(legacyAssessed.coversFile(legacySrc,{sha256:legacyHash,mode:0o640}),true);
 assert.equal(legacyAssessed.coversFile(legacySrc,{sha256:legacyHash,mode:0o600}),false);
 assert.equal(legacyAssessed.coversFile(legacySrc,{sha256:digest('wrong'),mode:0o640}),false);
 assert.equal(legacyAssessed.coversFile(legacyRoot),false);
 assert.equal(legacyAssessed.coversFile(path.join(v1.dir,'outside.txt')),false);

 // Missing declared root in a legacy archive is rejected during read-only assessRestore() before service stop.
 const extraMissing=path.join(v1.dir,'legacy-missing');mkdirSync(extraMissing);
 await assert.rejects(assessRestore(v1.inst,{file:legacyArchive,entries:[{parent:v1.dir,name:'legacy-root'},{parent:v1.dir,name:'legacy-missing'}]}),/missing archive root: root-0002/);

 // Explicit GNU-format tar fixture ('ustar  \0' header) including an ordinary '._notes' regular file assesses and restores cleanly on macOS and Linux.
 const {gzipSync}=await import('node:zlib');
 const gnuHeader=(name,type,mode,bytes)=>{
  const b=Buffer.alloc(512);
  const put=(s,off,len)=>Buffer.from(s).copy(b,off,0,len);
  put(name,0,100);put(mode.toString(8).padStart(7,'0')+'\0',100,8);put('0000000\0',108,8);put('0000000\0',116,8);
  put(bytes.toString(8).padStart(11,'0')+'\0',124,12);put('00000000000\0',136,12);b.fill(32,148,156);
  put(type,156,1);put('ustar  \0',257,8);
  const sum=b.reduce((a,v)=>a+v,0);put(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
  return b;
 };
 const gnuRoot=path.join(v1.dir,'gnu-root');mkdirSync(gnuRoot);
 const gnuFile=path.join(gnuRoot,'cfg.json'),gnuBytes=Buffer.from('{"gnu":true}\n');
 const gnuNotes=path.join(gnuRoot,'._notes'),gnuNotesBytes=Buffer.from('ordinary notes\n');
 writeFileSync(gnuFile,'{"mutated":true}\n',{mode:0o640});
 const padFor=len=>Buffer.alloc((512-len%512)%512);
 const gnuTar=Buffer.concat([
  gnuHeader('gnu-root/','5',0o700,0),
  gnuHeader('gnu-root/cfg.json','0',0o640,gnuBytes.length),gnuBytes,padFor(gnuBytes.length),
  gnuHeader('gnu-root/._notes','0',0o640,gnuNotesBytes.length),gnuNotesBytes,padFor(gnuNotesBytes.length),
  Buffer.alloc(1024),
 ]);
 const gnuArchive=path.join(v1.inst.backups,'gnu-legacy.tgz');
 writeFileSync(gnuArchive,gzipSync(gnuTar));
 const gnuBackup={file:gnuArchive,entries:[{parent:v1.dir,name:'gnu-root'}]};
 const gnuAssessed=await assessRestore(v1.inst,gnuBackup);
 assert.equal(gnuAssessed.coversFile(gnuFile,{sha256:digest(gnuBytes),mode:0o640}),true,'GNU-format legacy archive passes coversFile');
 assert.equal(gnuAssessed.coversFile(gnuNotes,{sha256:digest(gnuNotesBytes),mode:0o640}),true,'ordinary ._ file without AppleDouble magic passes coversFile');
 await restoreBackup(v1.inst,v1.ctx,gnuBackup,null,gnuAssessed);
 assert.equal(readFileSync(gnuFile,'utf8'),'{"gnu":true}\n','GNU-format legacy archive restores cleanly');
 assert.equal(readFileSync(gnuNotes,'utf8'),'ordinary notes\n','ordinary ._ file restores with intact text');

 // Case-fold collision inside a legacy archive is rejected during read-only assessRestore() before restore/stop.
 const {writeArchive}=await import('../server/release-archive.mjs');
 const collidingArchive=path.join(v1.inst.backups,'legacy-collide.tgz');
 await writeArchive(collidingArchive,[
  {path:'legacy-root',type:'directory',mode:0o700,bytes:0},
  {path:'legacy-root/File.txt',type:'file',mode:0o640,bytes:Buffer.byteLength('{"legacy":1}\n'),source:legacySrc},
  {path:'legacy-root/file.txt',type:'file',mode:0o640,bytes:Buffer.byteLength('{"legacy":1}\n'),source:legacySrc},
 ],{release:false});
 await assert.rejects(assessRestore(v1.inst,{file:collidingArchive,entries:[{parent:v1.dir,name:'legacy-root'}]}),/case-fold archive path collision/);

 // Resumed legacy restore uses empty-directory removal on stageDir and preserves unexpected files inside it.
 const stageDir=path.join(v1.dir,'.hub-restore-legacy-extra');
 const stagedRoot=path.join(stageDir,'root');
 mkdirSync(stagedRoot,{recursive:true,mode:0o700});
 writeFileSync(path.join(stagedRoot,'site.json'),'{"legacy":1}\n',{mode:0o640});
 const unrelated=path.join(stageDir,'keep-me.txt');
 writeFileSync(unrelated,'do not delete');
 writeFileSync(legacySrc,'{"mutated":2}\n',{mode:0o640});
 const legacyJournal={
  schemaVersion:2,id:'legacy-resume',startedAt:new Date(v1.ctx.now()).toISOString(),step:'rolling-back',epochRose:true,
  from:{label:'v1.0.0',core:{version:'1.0.0'},expect:{version:'1.0.0'}},
  to:{label:'v1.1.0',core:{version:'1.1.0'},expect:{version:'1.1.0'}},
  changes:[],settings:{root:v1.inst.root,state:v1.inst.paths.state,service:{stop:['true'],start:['true']},health:{url:'http://127.0.0.1:1/healthz',seconds:2}},
  restoreRoots:[{id:'root-0001',live:legacyRoot,stageDir,staged:stagedRoot,aside:legacyRoot+'.failed-legacy',existed:true,status:'prepared'}],
 };
 await restoreBackup(v1.inst,v1.ctx,legacyBackup,legacyJournal);
 assert.equal(readFileSync(legacySrc,'utf8'),'{"legacy":1}\n');
 assert.equal(readFileSync(unrelated,'utf8'),'do not delete','legacy stageDir cleanup preserves unexpected files');
});

test('updater closure rooted at scripts/update.mjs is 100% static, acyclic, and update-backup exports stay narrow',async()=>{
 const repoRoot=path.resolve(import.meta.dirname,'..');
 const entry=path.join(repoRoot,'scripts','update.mjs');
 const visited=new Set(),stack=[],cycles=[],dynamics=[];
 const deleted=['backup-scan.mjs','backup-archive.mjs','backup-policy.mjs','restore-sockets.mjs'];
 function walk(file){
  if(stack.includes(file)){cycles.push([...stack.slice(stack.indexOf(file)),file].map(f=>path.relative(repoRoot,f)));return;}
  if(visited.has(file))return;
  visited.add(file);
  const src=readFileSync(file,'utf8');
  const stripped=src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  if(/\bimport\s*\(/.test(stripped))dynamics.push(path.relative(repoRoot,file));
  stack.push(file);
  for(const m of stripped.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)){
   const target=path.resolve(path.dirname(file),m[1]);
   assert.ok(!deleted.includes(path.basename(target)),`unexpected import of removed module: ${target}`);
   walk(target);
  }
  stack.pop();
 }
 walk(entry);
 assert.deepEqual(cycles,[],'updater import graph must be acyclic');
 assert.deepEqual(dynamics,[],'updater import closure must have zero dynamic import() calls');
 for(const name of deleted)assert.equal(existsSync(path.join(repoRoot,'server',name)),false,`${name} must remain deleted`);
 const mod=await import('../server/update-backup.mjs');
 assert.deepEqual(Object.keys(mod).sort(),[
  'BACKUP_SCHEMA','DRIVER_CAPABILITIES','POLICY_SCHEMA',
  'assessRestore','backupPlan','backupRootSummary','createBackup','refuseSocketReplacement','restoreBackup','scanBackup'
 ]);
 assert.equal(mod.BACKUP_SCHEMA,2);
 assert.equal(mod.POLICY_SCHEMA,1);
 assert.deepEqual(mod.DRIVER_CAPABILITIES,['backup-v1','backup-v2','hardlinks','budget','journal-3','staged-fsync','socket-aware']);
});
