// Authentication precedes payload processing and every target-code execution.
// Also implements the Release Source adapter interface for signed release packages.
// Static imports only: the updater may run from the checkout it switches.
import {existsSync,readFileSync,lstatSync,statSync,mkdirSync,mkdtempSync,rmSync,readdirSync,chmodSync,cpSync,renameSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {loadTrust,verifyManifestSignature,forbiddenTrustRoots} from './release-trust.mjs';
import {strictJson,fields,sha256,fileHash,boundedRegularFile,durableWrite,withinPath,syncDirectory} from './safe-fs.mjs';
import {archivePath,extractArchive,ARCHIVE_LIMITS} from './release-archive.mjs';
import {parse,validRange,satisfies,compare} from './semver.mjs';
import {packageReceipt} from './build-info.mjs';
import {refuseSocketReplacement} from './update-backup.mjs';
import {UpdateError} from './update-errors.mjs';
import {writeUpdateJournal} from './update-journal.mjs';

export const PACKAGE_SCHEMA=1,RECEIPT_SCHEMA=1;
export const UPDATER_VERSION='1.0.0';

export function packageSidecars(file){if(!file.endsWith('-node-source.tar.gz'))throw new Error('package name must end in -node-source.tar.gz');const base=file.slice(0,-19);return {manifest:base+'.manifest.json',signature:base+'.manifest.sig.json'};}
export function validateManifest(m,{repository,tag=null,manifestDigest=null,bytes=null,compatibility=true}={}){
 fields(m,['schemaVersion','product','repository','version','tag','fullCommit','dataEpoch','nodeRange','minimumUpdaterVersion','platforms','architectures','readinessProtocol','artifact','files'],'manifest');
 if(m.schemaVersion!==PACKAGE_SCHEMA||m.product!=='home-hub'||m.repository!==repository||!parse(m.version)||m.tag!=='v'+m.version||!/^[0-9a-f]{40}$/.test(m.fullCommit)||!Number.isSafeInteger(m.dataEpoch)||m.dataEpoch<1||m.readinessProtocol!==1)throw new Error('invalid signed release identity');
 if(tag&&m.tag!==tag)throw new Error('requested tag differs from signed package');if(manifestDigest&&(!/^[0-9a-f]{64}$/.test(manifestDigest)||!bytes||sha256(bytes)!==manifestDigest))throw new Error('pinned manifest digest mismatch');
 if(!validRange(m.nodeRange)||!parse(m.minimumUpdaterVersion)||compare(m.minimumUpdaterVersion,UPDATER_VERSION)>0)throw new Error('unsupported Node/updater requirement');
 if(!Array.isArray(m.platforms)||!m.platforms.length||m.platforms.some(p=>!['darwin','linux'].includes(p))||!Array.isArray(m.architectures)||!m.architectures.length||m.architectures.some(p=>!['arm64','x64'].includes(p)))throw new Error('invalid platform support');
 if(compatibility&&(!satisfies(process.versions.node,m.nodeRange)||!m.platforms.includes(process.platform)||!m.architectures.includes(process.arch)))throw new Error('package is incompatible with this Node/platform/architecture');
 fields(m.artifact,['name','bytes','sha256','uncompressedBytes'],'artifact');const a=m.artifact;if(a.name!==`home-hub-${m.tag}-node-source.tar.gz`||!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>ARCHIVE_LIMITS.compressed||!Number.isSafeInteger(a.uncompressedBytes)||a.uncompressedBytes<1024||a.uncompressedBytes>ARCHIVE_LIMITS.expanded||!/^[0-9a-f]{64}$/.test(a.sha256))throw new Error('invalid artifact limits or identity');
 if(!Array.isArray(m.files)||!m.files.length||m.files.length>ARCHIVE_LIMITS.entries)throw new Error('invalid manifest file count');const names=new Set(),folds=new Map(),directories=new Set();let expanded=1024;
 for(const f of m.files){fields(f,['path','bytes','sha256','mode'],'manifest file');archivePath(f.path);if(/^(?:local|data|state|private|node_modules)(?:\/|$)/i.test(f.path))throw new Error('mutable/household payload in core package');if(names.has(f.path))throw new Error('duplicate manifest path');if(directories.has(f.path))throw new Error('manifest prefix collision');const parts=f.path.split('/');for(let i=1;i<=parts.length;i++){const prefix=parts.slice(0,i).join('/'),fold=prefix.normalize('NFC').toLowerCase();if(folds.has(fold)&&folds.get(fold)!==prefix)throw new Error('case-fold manifest path collision');folds.set(fold,prefix);if(i<parts.length){if(names.has(prefix))throw new Error('manifest prefix collision');directories.add(prefix);}}names.add(f.path);if(!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>ARCHIVE_LIMITS.file||!/^[0-9a-f]{64}$/.test(f.sha256)||![0o644,0o755].includes(f.mode))throw new Error('invalid manifest file metadata');expanded+=512+Math.ceil(f.bytes/512)*512;}
 if(expanded!==a.uncompressedBytes)throw new Error('expanded payload size differs from file inventory');return m;
}
export function authenticatePackageMetadata(file,{trust,trustFile,repository,tag,manifestDigest,forbidden=[],compatibility=true}={}){
 const sidecars=packageSidecars(file),bytes=boundedRegularFile(sidecars.manifest,8*1024*1024,'metadata'),side=strictJson(boundedRegularFile(sidecars.signature,16384,'metadata')),manifest=strictJson(bytes);
 const policy=trust??(trustFile?loadTrust(trustFile,{forbidden}):null);if(!policy)throw new Error('Package operations require --trust FILE or <home>/update/trust.json; signatures cannot be bypassed');
 const keyId=verifyManifestSignature(bytes,side,policy,repository,manifest.version);
 validateManifest(manifest,{repository,tag,manifestDigest,bytes,compatibility});if(path.basename(file)!==manifest.artifact.name)throw new Error('package filename differs from authenticated artifact');
 return {manifest,manifestSha256:sha256(bytes),keyId,verification:'verified',verifiedAt:new Date().toISOString(),sidecars};
}
function fixDirectories(root){for(const e of readdirSync(root,{withFileTypes:true}))if(e.isDirectory())fixDirectories(path.join(root,e.name));chmodSync(root,0o755);}
export async function verifyPackage(file,options={}){
 file=path.resolve(file);const verified=authenticatePackageMetadata(file,options),m=verified.manifest,st=lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.size!==m.artifact.bytes||fileHash(file)!==m.artifact.sha256)throw new Error('package payload size/hash mismatch');
 let success=false;const parent=options.stagingParent??os.tmpdir();mkdirSync(parent,{recursive:true,mode:0o700});const stage=mkdtempSync(path.join(parent,'.hub-package-'));
 try{await extractArchive(file,stage,{expectedExpanded:m.artifact.uncompressedBytes,expected:new Map(m.files.map(f=>[f.path,{...f,type:'file'}]))});const pkg=strictJson(readFileSync(path.join(stage,'package.json')));
  if(pkg.name!=='home-hub'||pkg.version!==m.version||pkg.homeHub?.dataEpoch!==m.dataEpoch||pkg.homeHub?.updates?.repo!==m.repository||pkg.engines?.node!==m.nodeRange)throw new Error('package.json differs from signed manifest');
  fixDirectories(stage);if(options.keepStage){success=true;return {...verified,stage};}return verified;
 }finally{if(!success)rmSync(stage,{recursive:true,force:true});}
}
export function writePackageReceipt(root,verified){durableWrite(path.join(root,'.home-hub-package.json'),JSON.stringify({schemaVersion:RECEIPT_SCHEMA,manifestSha256:verified.manifestSha256,fullCommit:verified.manifest.fullCommit,version:verified.manifest.version,keyId:verified.keyId,verifiedAt:verified.verifiedAt})+'\n');}
export function verifyStagedTree(root,manifest,{receipt=false}={}){
 const want=new Map(manifest.files.map(f=>[f.path,f])),found=[];
 const walk=(dir,relative='')=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(receipt&&name==='.home-hub-package.json')continue;const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file,name);else{if(!entry.isFile())throw new Error('unexpected staged special entry');const spec=want.get(name),st=lstatSync(file);if(!spec||st.size!==spec.bytes||(st.mode&0o777)!==spec.mode||fileHash(file)!==spec.sha256)throw new Error(`staged package changed: ${name}`);found.push(name);}}};walk(root);if(found.length!==want.size)throw new Error('staged package file coverage changed');return true;
}

function packageLayout(inst,request){
 if(request.core)throw new UpdateError('Conflicting Git and package targets');
 if(!inst.home)throw new UpdateError('Managed package updates require HOME_HUB_HOME with configuration, state, private files and plugins outside core. Relocate the instance first (docs/updating.md).');
 const st=lstatSync(inst.root),parent=statSync(path.dirname(inst.root));
 if(!st.isDirectory()||st.isSymbolicLink()||st.dev!==parent.dev)throw new UpdateError('Package core must be a regular replaceable directory on its parent filesystem; symlinks and mount-point swaps are unsupported.');
 if(existsSync(path.join(inst.root,'.git'))){
  if(!lstatSync(path.join(inst.root,'.git')).isDirectory())throw new UpdateError('Linked Git worktrees cannot migrate. Use an independent checkout.');
  if(!request.migrateFromGit)throw new UpdateError('Git migration requires explicit --migrate-from-git; the complete old checkout is retained.');
 }
 for(const file of [...Object.values(inst.paths).filter(v=>typeof v==='string'),...inst.sources.slice(1).map(s=>s.dir),path.join(inst.home,'instance.json')])
  if(withinPath(path.resolve(file),inst.root))throw new UpdateError(`Mutable instance path is inside replaceable core: ${file}. Relocate it before using packages.`);
 try{refuseSocketReplacement(inst.root);}catch(e){throw new UpdateError(`Package core cannot be replaced: ${e.message}`);}
 if(inst.sources[0].plugins.length)throw new UpdateError('Move in-tree household plugins to an external plugin source before package migration.');
 if(Object.keys(request.plugins??{}).length||(request.addPluginSources??[]).length)throw new UpdateError('Package activation keeps external plugin sources fixed. Update them in a separate Git transaction.');
}

export const packageReleaseSource=Object.freeze({
 kind:'package',

 async stageTarget(inst,request,ctx,trust,{live,trustFile,repository,checkBackup}={}){
  packageLayout(inst,request);
  const core=live[0];
  if(core.dirty.length)throw new UpdateError('Git checkout has tracked edits; migration refuses to replace them.');
  const options={trust,trustFile,repository,manifestDigest:request.manifestDigest,stagingParent:path.dirname(inst.root),keepStage:true,forbidden:forbiddenTrustRoots(inst)};
  let verified,coverage;
  try{
   const {manifest}=authenticatePackageMetadata(request.package,options);
   const packageBytes=manifest.artifact.uncompressedBytes+8192*manifest.files.length;
   coverage=checkBackup?.({packageBytes})??null;
   verified=await verifyPackage(request.package,options);
  }catch(e){
   if(e instanceof UpdateError)throw e;
   throw new UpdateError(`Package verification refused: ${e.message}`);
  }
  const stage=verified.stage,m=verified.manifest;
  const siteStaging=realpathSync(mkdtempSync(path.join(path.dirname(inst.root),'.hub-check-')));
  const cleanupWorkspace=()=>rmSync(siteStaging,{recursive:true,force:true});
  const cleanup=()=>{cleanupWorkspace();rmSync(stage,{recursive:true,force:true});};
  try{
   const place=s=>s.id==='core'?stage:path.join(siteStaging,s.id);
   for(const source of live.slice(1))cpSync(source.dir,place(source),{recursive:true,filter:f=>!['.git','node_modules'].includes(path.basename(f))});
   const target={version:m.version,dataEpoch:m.dataEpoch,node:m.nodeRange};
   const pkgRecord={
    live:inst.root,
    old:inst.root+'.previous-'+path.basename(stage),
    staged:stage,
    status:'prepared',
    manifestSha256:verified.manifestSha256,
    artifact:m.artifact,
    files:m.files,
    trustFile,
    packageFile:path.resolve(request.package),
   };
   const lines=[
    `package signature: verified (${verified.keyId}); manifest ${verified.manifestSha256}`,
    `exact release: ${m.tag} @ ${m.fullCommit}`,
    'readiness: exact boot/process/plugin identity for 10 consecutive seconds after startup',
   ];
   return {
    kind:'package',
    target,
    targetCommit:m.fullCommit,
    targetTag:m.tag,
    stagedDir:stage,
    stagingRoot:siteStaging,
    place,
    stagedPluginDirs:live.flatMap(s=>s.plugins.map(rel=>({source:s,rel,dir:path.join(place(s),rel)}))),
    copiedLocalPlugins:false,
    changes:[],
    hasChange:true,
    coverage,
    quarantineKeys:[verified.manifestSha256],
    strictPlugins:true,
    requireCheck:true,
    modern:true,
    packageDigest:verified.manifestSha256,
    lines,
    journalFields:{package:pkgRecord},
    keepStageOnSuccess:true,
    describe:()=>`${m.version} @ ${m.fullCommit.slice(0,7)}`,
    finalizeStage:()=>{
     verifyStagedTree(stage,m);
     writePackageReceipt(stage,verified);
     return [];
    },
    cleanupWorkspace,
    cleanup,
   };
  }catch(e){
   cleanup();
   throw e;
  }
 },

 verifyPreSwitch(inst,plan){
  const p=plan.package;
  verifyStagedTree(p.staged,{files:p.files},{receipt:true});
  const meta=authenticatePackageMetadata(p.packageFile,{trustFile:p.trustFile,repository:plan.repository,manifestDigest:p.manifestSha256,forbidden:forbiddenTrustRoots(inst)});
  if(meta.manifestSha256!==p.manifestSha256)throw new UpdateError('Package target changed since preflight');
 },

 applySwitch(inst,journal,plan,ctx){
  const p=journal.package;
  p.status='moving-old';writeUpdateJournal(inst.files.journal,journal);refuseSocketReplacement(p.live);renameSync(p.live,p.old);ctx.checkpoint('package-old-renamed');syncDirectory(path.dirname(p.live));p.status='old-moved';writeUpdateJournal(inst.files.journal,journal);
  p.status='installing';writeUpdateJournal(inst.files.journal,journal);renameSync(p.staged,p.live);ctx.checkpoint('package-new-renamed');syncDirectory(path.dirname(p.live));p.status='installed';writeUpdateJournal(inst.files.journal,journal);
 },

 verifyRollbackPreStop(inst,journal){
  if(journal.package.status!=='restored'&&existsSync(journal.package.old))refuseSocketReplacement(journal.package.live);
 },

 hasMoved(inst,journal){
  return existsSync(journal.package.old);
 },

 verifyRollbackTarget(inst,journal){
  if(packageReceipt(inst.root)?.manifestSha256!==journal.package.manifestSha256)throw new UpdateError('Installed core differs from the last package; rollback refuses unrelated edits.');
 },

 rollbackSwitch(inst,journal){
  const p=journal.package;
  // Reconcile intent even when a process died between rename and its completion record.
  if(p.status==='prepared'&&existsSync(p.live)&&!existsSync(p.old))return;
  if(p.status==='moving-old'&&existsSync(p.live)&&!existsSync(p.old))return;
  if(p.status==='restored')return;
  if(!existsSync(p.old)){
   if(p.status==='restoring'&&existsSync(p.live)){p.status='restored';writeUpdateJournal(inst.files.journal,journal);return;}
   throw new Error('Retained previous core is missing; manual recovery required');
  }
  if(existsSync(p.live)){
   verifyStagedTree(p.live,{files:p.files},{receipt:true});
   const receipt=packageReceipt(p.live);
   if(receipt?.manifestSha256!==p.manifestSha256)throw new Error('Core no longer matches the installed package; refusing to overwrite unrelated code');
   p.failed??=p.live+'.failed-'+path.basename(p.staged);
   p.status='moving-failed';writeUpdateJournal(inst.files.journal,journal);
   refuseSocketReplacement(p.live);renameSync(p.live,p.failed);syncDirectory(path.dirname(p.live));
  }
  p.status='restoring';writeUpdateJournal(inst.files.journal,journal);
  renameSync(p.old,p.live);syncDirectory(path.dirname(p.live));
  p.status='restored';writeUpdateJournal(inst.files.journal,journal);
 },

 quarantineKeys(journal){
  return [journal.package.manifestSha256];
 },

 failedPath(journal){
  return journal.package?.failed??null;
 },
});
