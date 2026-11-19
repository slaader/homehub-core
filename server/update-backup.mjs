// Multi-root replacement is journalled. The backup and stage data are streamed with bounded memory.
import {constants,lstatSync,realpathSync,readFileSync,readlinkSync,readdirSync,mkdirSync,mkdtempSync,rmSync,cpSync,renameSync,openSync,readSync,closeSync,fchmodSync,fsyncSync,linkSync,symlinkSync,lchmodSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {extractArchive,ARCHIVE_LIMITS} from './release-archive.mjs';
import {sha256,strictJson,durableWrite,syncDirectory} from './release-trust.mjs';
import {writeUpdateJournal} from './update-journal.mjs';
import {UpdateError} from './update-errors.mjs';
import {BACKUP_SCHEMA,writeBackupArchive,walkBackup,writeAll,validateIntegrity} from './backup-archive.mjs';
import {cleanAbsolute,withinPath as within} from './backup-policy.mjs';
import {canonical,exists,stat,inode,exactIdentity,scanBackup,protectedPaths,protectedDirectories,filesystem,checkSpace,verifyBackupRoots,verifyCurrentCoverage} from './backup-scan.mjs';
import {activeRestoreUnits,checkSocketEntry,entryPath,hasPayload,planSocketRestore,prepareSocketAsides,refuseSocketReplacement,
 removeRestoreStage,resolveRestorePath,scanRestoreSockets,socketConflict,validateSocketRestore} from './restore-sockets.mjs';
export {BACKUP_SCHEMA,canonical,scanBackup};

export function fileHash(file,expectedBytes=null){
 const h=createHash('sha256'),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65536);
 try{
  let n,total=0;
  while((n=readSync(fd,buffer,0,buffer.length,null))){
   total+=n;
   if(expectedBytes!==null&&total>expectedBytes)throw new Error('hash input exceeds its expected size');
   h.update(buffer.subarray(0,n));
  }
  if(expectedBytes!==null&&total!==expectedBytes)throw new Error('hash input does not match its expected size');
 }
 finally{closeSync(fd);}
 return h.digest('hex');
}
export function backupRootSummary(roots){
 const names=roots.filter(r=>r.role!=='exact-file'&&!r.runtimeSocket).map(r=>r.name);
 const aliases=roots.filter(r=>r.role==='exact-file').length;
 return [...names,...(aliases?[`${aliases} exact alias paths`]:[])].join(', ');
}
export function backupPlan(inst,options){
 const plan=scanBackup(inst,options);
 if(plan.blockers.length)throw new UpdateError(plan.blockers.map(b=>b.code+': '+b.message).join('\n'));
 return plan;
}
export async function createBackup(inst,ctx,name,{plan=backupPlan(inst)}={}){
 if(!/^[A-Za-z0-9.-]+$/.test(name)||name==='.'||name==='..')throw new Error('invalid backup name');
 if(plan.runtimeSockets.count)ctx.log(`  preserving ${plan.runtimeSockets.count} filesystem UNIX socket(s) in place, outside the archive`);
 mkdirSync(inst.backups,{recursive:true,mode:0o700});
 const file=path.join(inst.backups,name+'.tgz'),manifest=file+'.manifest.jsonl',integrity=file+'.integrity.json';
 if([file,manifest,integrity].some(exists))throw new Error(`archive already exists: ${file}`);
 const temp=file+'.'+randomUUID()+'.tmp',tempManifest=temp+'.jsonl';
 try{
  verifyBackupRoots(inst,plan);
  const data=await writeBackupArchive(temp,tempManifest,plan);
  await walkBackup(temp,tempManifest,data);
  const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  const description=JSON.stringify(data)+'\n';
  verifyBackupRoots(inst,plan);
  renameSync(tempManifest,manifest);durableWrite(integrity,description);renameSync(temp,file);syncDirectory(inst.backups);
  return {schemaVersion:BACKUP_SCHEMA,file,manifest,integrity,integritySha256:sha256(description),entries:plan.roots,
   bytes:data.archiveBytes,files:plan.totals.entries,verified:true};
 }finally{rmSync(temp,{force:true});rmSync(tempManifest,{force:true});}
}
function validateRoots(inst,roots,progress=[],policyFile=null){
 const protectedRoots=protectedPaths(inst,policyFile),protectedDirs=protectedDirectories(inst);
 // Look up each component in its recorded location, with relative links interpreted at their live names.
 const moved=new Map();
 for(const row of progress)if(['moving-old','old-moved','installing'].includes(row.status)&&!exists(row.live)){
  if(exists(row.aside))moved.set(row.live,row.aside);
  else if(exists(row.staged))moved.set(row.live,row.staged);
 }
 const locate=logical=>{
  if(!moved.size)return logical;
  for(let parent=logical;;parent=path.dirname(parent)){
   if(moved.has(parent))return path.join(moved.get(parent),path.relative(parent,logical));
   if(parent===path.dirname(parent))return logical;
  }
 };
 const resolveFollowed=logical=>{
  try{return realpathSync.native(logical);}
  catch(e){
   // A covered target may have been removed since the backup and is about to be restored.
   if(e.code==='ENOENT')return resolveRestorePath(logical)?.file;
   if(!['ENOTDIR','ELOOP'].includes(e.code))throw e;
   return null;
  }
 };
 const linkMatches=(logical,link,target)=>{
  if(!moved.size)return stat(logical)?.isSymbolicLink()&&readlinkSync(logical)===link&&resolveFollowed(logical)===target;
  const parent=resolveRestorePath(path.dirname(logical),locate);
  if(!parent?.st?.isDirectory())return false;
  const file=locate(path.join(parent.file,path.basename(logical)));
  return stat(file)?.isSymbolicLink()&&readlinkSync(file)===link&&resolveRestorePath(logical,locate)?.file===target;
 };
 for(const e of roots){if(!e||!/^root-\d{4}$/.test(e.id)||!path.isAbsolute(e.canonical)||e.canonical===path.parse(e.canonical).root||!path.isAbsolute(e.logical))throw new Error('invalid backup root roles');
  if(canonical(path.dirname(e.canonical))!==path.dirname(e.canonical)||(exists(e.canonical)&&lstatSync(e.canonical).isSymbolicLink()))throw new Error('restore destination topology changed');
  for(const alias of e.aliases??[])if(alias.link!==null&&!linkMatches(alias.logical,alias.link,alias.canonical??e.canonical))throw new Error('restore alias topology changed');
  for(const protectedPath of protectedRoots)if(within(protectedPath,e.canonical))throw new Error('restore would replace recovery metadata or trust');
  if(e.role&&protectedDirs.some(p=>within(e.canonical,p)))throw new Error('restore would replace recovery metadata or trust');
  if(e.role&&e.link===null&&(moved.size?resolveRestorePath(e.logical,locate)?.file:canonical(e.logical))!==e.canonical)throw new Error('restore logical root topology changed');
  if(stat(e.canonical)&&stat(e.canonical).dev!==stat(path.dirname(e.canonical)).dev)throw new Error('restore root is a mountpoint');
  if(e.link!==null&&e.link!==undefined&&!linkMatches(e.logical,e.link,e.canonical))throw new Error('top-level symlink topology changed; manual recovery required');
 }
 for(let i=0;i<roots.length;i++)for(let j=0;j<i;j++)if(within(roots[i].canonical,roots[j].canonical)||within(roots[j].canonical,roots[i].canonical))throw new Error('overlapping restore roots');
}

function inventory(roots){const files=[];let bytes=0;const walk=(source,name)=>{
 const st=lstatSync(source),mode=st.mode&0o777;if(st.mode&0o7000)throw new Error(`unsupported backup special mode: ${source}`);
 const type=st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':st.isFile()?'file':null;if(!type)throw new Error(`unsupported backup type: ${source}`);
 if(files.length>=ARCHIVE_LIMITS.entries||(type==='file'&&(st.size>ARCHIVE_LIMITS.file||(bytes+=st.size)>ARCHIVE_LIMITS.expanded)))throw new Error('backup exceeds local archive limits; relocate or use an independently verified backup procedure');
 const entry={path:name,type,mode,bytes:type==='file'?st.size:0,sha256:type==='file'?fileHash(source):null,...(type==='symlink'?{link:readlinkSync(source)}:{})};files.push({...entry,source});
 if(type==='directory')for(const child of readdirSync(source).sort())walk(path.join(source,child),name+'/'+child);
 };for(const e of roots)if(e.existed)walk(e.canonical,e.id);return files;
}

async function restoreLegacy(inst,ctx,backup,journal,{manifest,legacy}){
 const scratch=mkdtempSync(path.join(inst.backups,'.restore-'));const save=()=>{if(journal)writeUpdateJournal(inst.files.journal,journal);};
 try{
  const entries=await extractArchive(backup.file,scratch,{release:false,legacy,expected:manifest.files?new Map(manifest.files.map(f=>[f.path,f])):null});
  if(legacy){const names=new Set(manifest.roots.map(r=>r.legacyName));if(entries.some(e=>!names.has(e.path.split('/')[0])))throw new Error('legacy archive has unplanned roots');}
  // Inspect link destinations as archive data, never by traversing a staged link into the live filesystem.
  for(const e of entries.filter(e=>e.type==='symlink')){const r=manifest.roots.find(r=>e.path===(r.legacyName??r.id)||e.path.startsWith((r.legacyName??r.id)+'/'));if(!r)throw new Error('unmapped backup symlink');const relative=path.relative(r.legacyName??r.id,e.path),target=path.resolve(path.dirname(path.join(r.canonical,relative)),e.link);if(!manifest.roots.some(o=>o.existed&&within(target,o.canonical)))throw new Error('uncovered restore link target');}
  const aside=journal?.failedState??path.join(inst.backups,`failed-${new Date(ctx.now()).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)}`);
  if(journal){journal.failedState=aside;journal.restoreRoots??=[];save();}
  const progress=journal?.restoreRoots??[];
  // Prepare every root on its destination filesystem before the first live rename.
  for(const r of manifest.roots){if(progress.some(p=>p.id===r.id))continue;const parent=path.dirname(r.canonical);mkdirSync(parent,{recursive:true,mode:0o700});const stageDir=mkdtempSync(path.join(parent,'.hub-restore-')),staged=path.join(stageDir,'root');
   if(r.existed){const from=path.join(scratch,r.legacyName??r.id);if(!exists(from))throw new Error(`missing archive root: ${r.id}`);cpSync(from,staged,{recursive:true,dereference:false,preserveTimestamps:true,verbatimSymlinks:true});}
   progress.push({id:r.id,live:r.canonical,staged,stageDir,aside:r.canonical+'.failed-'+randomUUID(),existed:r.existed,status:'prepared'});save();
  }
  if(manifest.files){for(const p of progress.filter(p=>p.status==='prepared'&&p.existed)){const staged=inventory([{id:p.id,existed:true,canonical:p.staged}]).map(({source,...e})=>e),expected=manifest.files.filter(f=>f.path===p.id||f.path.startsWith(p.id+'/'));if(JSON.stringify(staged)!==JSON.stringify(expected))throw new Error('destination staging validation failed');}}
  validateRoots(inst,manifest.roots,progress);
  verifyOldGraph(manifest.roots,progress);
  return installRoots(inst,ctx,manifest.roots,progress,aside,save);
 }finally{rmSync(scratch,{recursive:true,force:true});}
}

function boundedMetadata(file,max){
 const st=stat(file);
 if(!st?.isFile()||st.size>BigInt(max))throw new Error(`backup metadata missing, too large or not a regular file: ${file}`);
 return readFileSync(file);
}

function restoreDescription(inst,backup){
 if(!backup||!cleanAbsolute(backup.file)||!stat(backup.file)?.isFile())throw new Error(`the archive ${backup?.file??'(none)'} is gone or is not a regular file`);
 const modern=backup.schemaVersion===BACKUP_SCHEMA||backup.manifest?.endsWith('.jsonl');
 if(modern){
  if(backup.manifest!==backup.file+'.manifest.jsonl'||backup.integrity!==backup.file+'.integrity.json'||
   path.dirname(canonical(backup.file))!==canonical(inst.backups))throw new Error('invalid backup sidecar paths');
  const bytes=boundedMetadata(backup.integrity,16384);
  if(sha256(bytes)!==backup.integritySha256)throw new Error('backup integrity sidecar mismatch');
  const integrity=validateIntegrity(strictJson(bytes,{limit:16384}));
  return {integrity};
 }
 if(backup.manifest||backup.integrity){
  if(!backup.manifest||!backup.integrity)throw new Error('backup integrity sidecar missing');
  const bytes=boundedMetadata(backup.manifest,8*1024**2),integrity=strictJson(boundedMetadata(backup.integrity,16384));
  if(integrity.schemaVersion!==1||sha256(bytes)!==integrity.manifestSha256||lstatSync(backup.file).size!==integrity.archiveBytes||
   fileHash(backup.file,integrity.archiveBytes)!==integrity.archiveSha256)throw new Error('backup integrity mismatch');
  const manifest=strictJson(bytes);
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!Array.isArray(manifest.roots))throw new Error('unsupported backup manifest');
  return {manifest,legacy:false};
 }
 const roots=backup.entries.map((e,i)=>({id:`root-${String(i+1).padStart(4,'0')}`,logical:path.join(e.parent,e.name),
  canonical:canonical(path.join(e.parent,e.name)),link:null,existed:true,legacyName:e.name}));
 return {manifest:{roots,files:null},legacy:true};
}

function validateProgress(roots,progress,modern){
 const ids=new Set(),staging=new Set(),asides=new Set();
 for(const p of progress){
  const r=roots.find(r=>r.id===p.id);
  if(!r||ids.has(p.id)||p.live!==r.canonical||path.dirname(p.aside)!==path.dirname(p.live)||!p.aside.startsWith(p.live+'.failed-')||
   path.dirname(p.stageDir)!==path.dirname(p.live)||!path.basename(p.stageDir).startsWith('.hub-restore-')||
   p.staged!==path.join(p.stageDir,'root')||p.existed!==hasPayload(r)||staging.has(p.stageDir)||asides.has(p.aside))throw new Error('restore progress does not match authenticated backup root roles');
  ids.add(p.id);staging.add(p.stageDir);asides.add(p.aside);
  if(modern){
   if(!/^\.hub-restore-[a-f0-9-]{36}$/.test(path.basename(p.stageDir))||
    !/^[a-f0-9-]{36}$/.test(p.aside.slice(p.live.length+8)))throw new Error('invalid streaming restore recovery paths');
   const stage=stat(p.stageDir);
   if(stage&&(!stage.isDirectory()||stage.uid!==BigInt(process.getuid())||(stage.mode&0o777n)!==0o700n))throw new Error('unsafe restore stage directory');
   if(roots.some(r=>within(p.stageDir,r.canonical)||within(p.aside,r.canonical)))throw new Error('restore recovery paths overlap a live root');
  }
 }
 if(modern&&progress.length&&(progress.length!==roots.length||
  (progress.some(p=>p.status==='preparing')&&!progress.every(p=>p.status==='preparing'))))throw new Error('incomplete restore transaction');
}

function installRoots(inst,ctx,roots,progress,aside,save){
 const exact=new Map(roots.filter(r=>r.role==='exact-file').map(r=>[r.id,r]));
 for(const p of progress){
  if(p.status==='installed')continue;
  if(p.status==='installing'&&p.existed&&!exists(p.staged)&&exists(p.live)){
   syncDirectory(path.dirname(p.live));p.status='installed';save();continue;
  }
  if(p.status==='prepared'||p.status==='moving-old'){
   p.status='moving-old';save();
   if(exists(p.live)){
    if(exists(p.aside))throw new Error('ambiguous partial restore: both live and failed root exist');
    const r=exact.get(p.id),live=stat(p.live);
    if(r&&!exactIdentity(r,live))throw new Error(`exact alias identity changed: ${p.live}`);
    refuseSocketReplacement(p.live);
    renameSync(p.live,p.aside);ctx.checkpoint?.('restore-old-renamed');
   }
   syncDirectory(path.dirname(p.live));
   if(path.dirname(p.aside)!==path.dirname(p.live))syncDirectory(path.dirname(p.aside));
   p.status='old-moved';save();
  }
  if(p.status==='old-moved'||p.status==='installing'){
   if(exists(p.live))throw new Error('unexpected live root during restore');
   p.status='installing';save();
   if(exists(p.live))throw new Error('live root appeared while recording the restore intent');
   if(p.existed){refuseSocketReplacement(p.staged,{aliases:false});renameSync(p.staged,p.live);ctx.checkpoint?.('restore-new-renamed');}
   syncDirectory(path.dirname(p.live));syncDirectory(p.stageDir);p.status='installed';save();
  }
  if(!exact.has(p.id))ctx.log(`  restored ${p.live}; failed state preserved at ${p.aside}`);
 }
 if(exact.size)ctx.log(`  restored ${exact.size} exact alias paths; failed-state index at ${aside}`);
 mkdirSync(aside,{recursive:true,mode:0o700});
 durableWrite(path.join(aside,'roots.json'),JSON.stringify(progress.map(({live,aside})=>({live,aside})),null,1)+'\n');
 return aside;
}

function validateLink(entry,root,roots){
 const target=path.resolve(path.dirname(entryPath(entry,root,root.canonical)),entry.link);
 if(!roots.some(r=>r.existed&&[r.canonical,r.logical,...r.aliases.map(a=>a.logical)].some(p=>within(target,p))))
  throw new Error(`uncovered restore link target: ${entry.path}`);
}
const ensureSpace=fs=>checkSpace(fs,(_,message)=>{throw new Error(message);});
const needsStages=progress=>!progress.length||progress[0].status==='preparing';

// Read-only validation precedes service stop, code checkout and live state renames.
export async function assessRestore(inst,backup,journal=null){
 inst={...inst,driver:journal?.driver??inst.driver,trustFile:journal?.trustFile??inst.trustFile};
 const description=restoreDescription(inst,backup),progress=journal?.restoreRoots??[];
 if(!description.integrity){
  validateProgress(description.manifest.roots,progress,false);
  validateRoots(inst,description.manifest.roots,progress);
  for(const r of description.manifest.roots)refuseSocketReplacement(r.canonical);
  verifyOldGraph(description.manifest.roots,progress);
  return description;
 }
 const {integrity}=description,devices=new Map(),filesystems=new Map(),policyFile=journal?.backupPolicy?.file??inst.backupPolicyFile;
 let roots,liveSockets,pendingAliases;
 const socketRestore=journal?.socketRestore;
 const units=activeRestoreUnits(socketRestore,progress);
 const checkEntry=(e,r)=>{
  if(liveSockets&&(liveSockets.sockets.size||liveSockets.aliases.size))checkSocketEntry(liveSockets,e,r,pendingAliases);
 };
 const restorableSettings=new Set();
 const settings=['site','instance'].map(k=>journal?.[k]).filter(Boolean);
 const checkSetting=(e,r,record=e)=>{
  const file=entryPath(e,r,r.canonical);
  if(settings.some(s=>s.file===file&&s.baseHash===record.sha256&&s.mode===record.mode))restorableSettings.add(file);
 };
 const cost=(root,bytes)=>{devices.get(root.id).restoreBytes+=Math.ceil(bytes/4096)*4096+4096;};
 const metadata=await walkBackup(null,backup.manifest,integrity,{
  header(m){
   roots=m.roots;
   if(JSON.stringify(roots)!==JSON.stringify(backup.entries))throw new Error('backup manifest differs from journal root roles');
   validateProgress(roots,progress,true);
   validateSocketRestore(socketRestore,roots,progress);
   validateRoots(inst,roots,units,policyFile);
   liveSockets=scanRestoreSockets(roots,m.budget.maxEntries);
   if(socketRestore){
    // A previously installed link can now resolve to a preserved socket. Only pending moves can disrupt it.
    const pendingUnits=new Set(units.filter(p=>p.status==='prepared'||p.status==='moving-old').map(p=>p.live));
    const willMove=live=>{
     for(let dir=live;dir!==path.dirname(dir);dir=path.dirname(dir))if(pendingUnits.has(dir))return true;
     return false;
    };
    for(const live of [...liveSockets.sockets.keys(),...liveSockets.aliases.keys()])if(willMove(live))throw socketConflict(live);
    liveSockets.aliases=new Map((socketRestore.aliases??[]).map(a=>[a.live,a]));
   }else if((liveSockets.sockets.size||liveSockets.aliases.size)&&progress.some(p=>!['preparing','prepared'].includes(p.status)))
    throw new Error('A UNIX socket or alias appeared during whole-root restore; preserve the endpoint and reconcile the journal before retrying');
   pendingAliases=new Set(liveSockets.aliases.keys());
   for(const root of roots)devices.set(root.id,filesystem(filesystems,path.dirname(root.canonical)));
  },
  directory(e,r){checkEntry(e,r);cost(r,0);},
  openFile(e,r){checkEntry(e,r);cost(r,e.bytes);checkSetting(e,r);},
  symlink(e,r){checkEntry(e,r);validateLink(e,r,roots);cost(r,0);},
  hardlink(e,r,leader,source){
   checkEntry(e,r);
   checkSetting(e,r,leader);
   if(devices.get(r.id).dev!==devices.get(source.id).dev)throw new Error('restore destinations for a hard-link group are on different filesystems');
   cost(r,0);
  }
 });
 if(pendingAliases.size)throw socketConflict(pendingAliases.values().next().value);
 if(!stat(backup.file)?.isFile()||stat(backup.file).size!==BigInt(integrity.archiveBytes)||
  fileHash(backup.file,integrity.archiveBytes)!==integrity.archiveSha256)throw new Error('backup archive integrity mismatch');
 if(needsStages(progress)){
  verifyOldGraph(roots,units,socketRestore);
  // An interrupted preparation reclaims its staging allocation before the final check.
  if(!progress.length)ensureSpace(filesystems.values());
 }else{
  verifyOldGraph(roots,units,socketRestore);
  await verifyStages(backup,integrity,progress,socketRestore);
 }
 return {integrity,metadata,filesystems,policyFile,restorableSettings};
}

function stageVisitor(ctx,progress){
 const stages=new Map(progress.map(p=>[p.id,p.staged]));
 const at=(e,r)=>entryPath(e,r,stages.get(r.id));
 let fd;
 return {
  directory(e,r){mkdirSync(at(e,r),{mode:0o700});},
  leaveDirectory(e,r){
   const dir=openSync(at(e,r),'r');
   try{fchmodSync(dir,e.mode);fsyncSync(dir);}finally{closeSync(dir);}
  },
  symlink(e,r){const dest=at(e,r);symlinkSync(e.link,dest);if(Number(stat(dest).mode&0o777n)!==e.mode)lchmodSync(dest,e.mode);},
  hardlink(e,r,leader,source){linkSync(at(leader,source),at(e,r));},
  openFile(e,r){fd=openSync(at(e,r),'wx',0o600);},
  chunk(bytes){writeAll(fd,bytes);},
  closeFile(e){
   fchmodSync(fd,e.mode);fsyncSync(fd);closeSync(fd);fd=undefined;
   ctx.checkpoint?.('restore-prepare-mid');
  },
  cleanup(){if(fd!==undefined)closeSync(fd);}
 };
}

// Resolve each root through journaled renames. Cross-root links span these locations on resume.
function restoreLocation(p){
 const live=exists(p.live),staged=exists(p.staged);
 if(p.status==='installed'||(p.status==='installing'&&p.existed&&!staged&&live)){
  if(live!==p.existed||staged)throw new Error('installed restore root changed');
  return p.live;
 }
 if(staged!==p.existed||(['old-moved','installing'].includes(p.status)&&live)||
  (p.status==='moving-old'&&live&&exists(p.aside)))throw new Error('ambiguous restore root state');
 return p.staged;
}

function verifyOldGraph(roots,units,socketRestore){
 const active=new Map(units.map(p=>[p.live,p]));
 const split=new Set(socketRestore?.anchors.map(a=>a.id)??[]),sockets=new Set(socketRestore?.sockets??[]);
 const originals=roots.flatMap(r=>sockets.has(r.id)?[]:split.has(r.id)?
  units.filter(u=>u.id===r.id).map(u=>({...r,canonical:u.live})):[r]);
 const old=[];
 for(const r of originals){
  const p=active.get(r.canonical);
  if(p&&exists(p.aside))old.push({...r,canonical:p.aside});
  else if(!p||['preparing','prepared','moving-old'].includes(p.status))old.push(r);
 }
 verifyCurrentCoverage(old);
}

async function verifyStages(backup,integrity,progress,socketRestore){
 const stageBases=new Map(progress.map(p=>[p.id,p.staged]));
 const units=activeRestoreUnits(socketRestore,progress);
 const locations=new Map(units.map(p=>[p.live,restoreLocation(p)]));
 const awaitingPayload=new Set(units.filter(p=>p.existed).map(p=>p.live));
 const anchorPaths=new Set(socketRestore?.anchors.map(a=>a.live));
 const aliasPaths=new Set(socketRestore?.aliases?.map(a=>a.live));
 const dirs=[],leaders=new Map(),payloadRoots=new Set();
 const finished=units.every(p=>p.status==='installed');
 const retained=finished?anchorPaths:new Set();
 const locate=(e,r)=>{
  const live=entryPath(e,r,r.canonical);
  if(anchorPaths.has(live)||aliasPaths.has(live))return finished?live:entryPath(e,r,stageBases.get(r.id));
  awaitingPayload.delete(live);
  for(let p=live;within(p,r.canonical);p=path.dirname(p)){
   if(locations.has(p))return path.join(locations.get(p),path.relative(p,live));
   if(anchorPaths.has(p))break;
  }
  throw new Error(`Archive entry has no journalled restore unit: ${live}`);
 };
 const verify=(e,r,type)=>{
  const file=locate(e,r);
  if(dirs.length&&dirs.at(-1).root===r&&path.dirname(file)===dirs.at(-1).file)dirs.at(-1).count++;
  if(e.path===r.id)payloadRoots.add(r.id);
  const s=stat(file);
  if(!s||!s[type]()||(!retained.has(file)&&e.mode!==undefined&&Number(s.mode&0o7777n)!==e.mode))throw new Error(`destination staging type or mode mismatch: ${file}`);
  return {s,file};
 };
 await walkBackup(null,backup.manifest,integrity,{
  directory(e,r){const {file}=verify(e,r,'isDirectory');dirs.push({file,root:r,count:0});},
  leaveDirectory(){const {file,count}=dirs.pop();if(!retained.has(file)&&readdirSync(file).length!==count)throw new Error(`unexpected staged entries: ${file}`);},
  symlink(e,r){const {file}=verify(e,r,'isSymbolicLink');if(readlinkSync(file)!==e.link)throw new Error(`destination staging link mismatch: ${file}`);},
  openFile(e,r){
   const {s,file}=verify(e,r,'isFile');
   if(s.nlink!==BigInt(e.names??1)||s.size!==BigInt(e.bytes)||fileHash(file,e.bytes)!==e.sha256)throw new Error(`destination staging content or hard-link mismatch: ${file}`);
   if(e.names)leaders.set(e.path,inode(s));
  },
  hardlink(e,r){
   const {s,file}=verify(e,r,'isFile');
   if(inode(s)!==leaders.get(e.target))throw new Error(`destination staging hard-link target mismatch: ${file}`);
  }
 });
 if(awaitingPayload.size)throw new Error('restore unit has no matching archive entry');
 // An anchored, live-only directory has no payload or staging tree.
 for(const p of progress)if(!payloadRoots.has(p.id)&&exists(p.staged))throw new Error('unexpected staged root');
}

async function verifyAssessedRestore(plan,backup,journal){
 const progress=journal?.restoreRoots??[];
 const roots=plan.integrity?plan.metadata.roots:plan.manifest.roots;
 const sockets=journal?.socketRestore;
 verifyOldGraph(roots,activeRestoreUnits(sockets,progress),sockets);
 if(plan.integrity&&!needsStages(progress))await verifyStages(backup,plan.integrity,progress,sockets);
}

export async function restoreBackup(inst,ctx,backup,journal=null,assessed=null){
 const plan=assessed??await assessRestore(inst,backup,journal);
 if(assessed)await verifyAssessedRestore(plan,backup,journal);
 if(journal?.driver)inst={...inst,driver:journal.driver};
 if(!plan.integrity){
  if(plan.legacy)ctx.log('  LEGACY archive: no integrity provenance; strict staged inspection required');
  return restoreLegacy(inst,ctx,backup,journal,plan);
 }
 const {metadata:{roots,budget},integrity,policyFile}=plan;
 let socketRestore=journal?.socketRestore;
 const progress=journal?.restoreRoots??[];
 const namedAside=path.join(inst.backups,`failed-${new Date(ctx.now()).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)}`);
 const aside=journal?.failedState??(exists(namedAside)?namedAside+'-'+randomUUID():namedAside);
 if(path.dirname(aside)!==path.resolve(inst.backups)||!path.basename(aside).startsWith('failed-')||
   (stat(aside)&&!stat(aside).isDirectory()))throw new Error('invalid failed-state index path');
 const save=()=>{if(journal){
  journal.failedState=aside;journal.restoreRoots=progress;
  if(socketRestore)journal.socketRestore=socketRestore;
  writeUpdateJournal(inst.files.journal,journal);
 }};
 validateProgress(roots,progress,true);
 validateSocketRestore(socketRestore,roots,progress);
 validateRoots(inst,roots,activeRestoreUnits(socketRestore,progress),policyFile);
 try{
  if(needsStages(progress)){
   verifyOldGraph(roots,progress,socketRestore);
   if(!progress.length){
    for(const r of roots){
     const stageDir=path.join(path.dirname(r.canonical),'.hub-restore-'+randomUUID());
     progress.push({id:r.id,live:r.canonical,stageDir,staged:path.join(stageDir,'root'),aside:r.canonical+'.failed-'+randomUUID(),existed:hasPayload(r),status:'preparing'});
    }
    save();
   }else for(const p of progress)removeRestoreStage(p.stageDir);
   ensureSpace(plan.filesystems.values());
   for(const p of progress){
    mkdirSync(path.dirname(p.live),{recursive:true,mode:0o700});
    mkdirSync(p.stageDir,{mode:0o700});syncDirectory(path.dirname(p.live));
   }
   await walkBackup(backup.file,backup.manifest,integrity,stageVisitor(ctx,progress));
   for(const p of progress)syncDirectory(p.stageDir);
   await verifyStages(backup,integrity,progress);
   for(const p of progress)p.status='prepared';
   socketRestore=planSocketRestore(roots,progress,scanRestoreSockets(roots,budget.maxEntries));
   save();ctx.checkpoint?.('restore-all-prepared');
  }else if(!socketRestore&&progress.every(p=>p.status==='prepared')){
   socketRestore=planSocketRestore(roots,progress,scanRestoreSockets(roots,budget.maxEntries));
   if(socketRestore)save();
  }
  validateSocketRestore(socketRestore,roots,progress);
  if(socketRestore?.anchors.length)ctx.log(`  preserving ${socketRestore.anchors.length} socket-containing directories during restore`);
  const units=activeRestoreUnits(socketRestore,progress);
  verifyOldGraph(roots,units,socketRestore);
  prepareSocketAsides(socketRestore);
  const result=installRoots(inst,ctx,roots,units,aside,save);
  for(const p of progress)removeRestoreStage(p.stageDir);
  ctx.checkpoint?.('restore-cleaned');
  return result;
 }finally{
  if(!journal&&activeRestoreUnits(socketRestore,progress).every(p=>['preparing','prepared'].includes(p.status)))
   for(const p of progress)removeRestoreStage(p.stageDir);
 }
}
