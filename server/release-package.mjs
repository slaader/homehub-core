// Authentication precedes payload processing and every target-code execution.
import {readFileSync,lstatSync,mkdirSync,mkdtempSync,rmSync,readdirSync,chmodSync} from 'node:fs';
import path from 'node:path';import os from 'node:os';
import {strictJson,fields,sha256,loadTrust,verifyManifestSignature,durableWrite} from './release-trust.mjs';
import {archivePath,extractArchive,ARCHIVE_LIMITS} from './release-archive.mjs';
import {fileHash} from './update-backup.mjs';
import {parse,validRange,satisfies,compare} from './semver.mjs';
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
const bounded=(file,max)=>{const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw new Error('metadata must be a bounded regular file');return readFileSync(file);};
export function authenticatePackageMetadata(file,{trust,trustFile,repository,tag,manifestDigest,forbidden=[],compatibility=true}={}){
 const sidecars=packageSidecars(file),bytes=bounded(sidecars.manifest,8*1024*1024),side=strictJson(bounded(sidecars.signature,16384)),manifest=strictJson(bytes);
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
