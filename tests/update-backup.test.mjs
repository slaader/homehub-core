import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,readlinkSync,lstatSync,existsSync,readdirSync,realpathSync,linkSync} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeUpdateJournal} from '../server/update-journal.mjs';
import {backupPlan,createBackup,restoreBackup,assessRestore} from '../server/update-backup.mjs';
import {readUpdateJournal} from '../server/update-journal.mjs';
function fixture(t){const dir=realpathSync(mkdtempSync(path.join(os.tmpdir(),'hub-backup-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));const paths={data:path.join(dir,'data'),state:path.join(dir,'data','state'),private:path.join(dir,'private'),config:path.join(dir,'config'),authFile:path.join(dir,'external','auth.json'),siteConfig:path.join(dir,'config','site.json'),softwareWatch:path.join(dir,'config','software-watch.json')};for(const p of [paths.state,paths.private,paths.config,path.dirname(paths.authFile),path.join(dir,'backups'),path.join(dir,'staging')])mkdirSync(p,{recursive:true});writeFileSync(paths.authFile,'auth',{mode:0o600});writeFileSync(path.join(path.dirname(paths.authFile),'secret.key'),'key',{mode:0o600});writeFileSync(path.join(paths.data,'legitimate.tgz'),'archive bytes');writeFileSync(paths.siteConfig,'{}');const inst={home:dir,root:path.join(dir,'core'),paths,env:{},backups:path.join(dir,'backups'),staging:path.join(dir,'staging'),files:{journal:path.join(dir,'journal.json'),lock:path.join(dir,'update.lock')}};writeFileSync(path.join(dir,'instance.json'),'{}');return {dir,inst,ctx:{now:()=>0,log:()=>{},checkpoint:()=>{}}};}
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

test('backup refuses an absent root that appeared after planning',async t=>{
 const {inst,ctx,dir}=fixture(t),extra=path.join(dir,'extra');
 inst.backupRoots=[extra];
 const plan=backupPlan(inst);
 writeFileSync(extra,'appeared');
 await assert.rejects(createBackup(inst,ctx,'raced',{plan}),/root topology changed/);
 assert.deepEqual(readdirSync(inst.backups),[]);
});

test('resume validates embedded aliases while their owning root is moved aside',async t=>{
 const {inst,ctx}=fixture(t);
 inst.paths.authFile=path.join(inst.paths.data,'auth-link');
 symlinkSync('legitimate.tgz',inst.paths.authFile);
 const backup=await createBackup(inst,ctx,'embedded'),j=journal(inst,backup);
 await assert.rejects(restoreBackup(inst,{...ctx,checkpoint:name=>{
  if(name==='restore-old-renamed')throw new Error('interruption');
 }},backup,j),/interruption/);
 await restoreBackup(inst,ctx,backup,readUpdateJournal(inst.files.journal));
 assert.equal(readlinkSync(inst.paths.authFile),'legitimate.tgz');
 assert.equal(readFileSync(inst.paths.authFile,'utf8'),'archive bytes');
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
