// Operator-owned trust. Nothing downloaded or restored is allowed to supply these roots.
import {constants,readFileSync,lstatSync,fstatSync,realpathSync,openSync,closeSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createPublicKey,createHash,verify} from 'node:crypto';
import {validRepo} from './version.mjs';
import {compare,parse} from './semver.mjs';
import {sha256,withinPath,canonicalPath,boundedRegularFile,durableWrite,strictJson,fields} from './safe-fs.mjs';
import {acquireLock} from './update-lock.mjs';
import {UpdateError} from './update-errors.mjs';

export const TRUST_SCHEMA=1;
export const TRUST_REQUIREMENT_SCHEMA=1;
export const TRUST_MAX_BYTES=1024*1024;
export const MANIFEST_DOMAIN=Buffer.from('home-hub-release-manifest-v1\n');

export function forbiddenTrustRoots(inst){
 if(!inst)return [];
 return [inst.root,inst.paths?.config,inst.paths?.data,inst.paths?.state,inst.paths?.private,...(inst.backupRoots??[])].filter(Boolean);
}

export function publicKey(pem){
 if(typeof pem!=='string'||!/-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem)||pem.includes('PRIVATE KEY'))throw new Error('package trust requires a public SPKI key');
 const key=createPublicKey(pem);
 if(key.asymmetricKeyType!=='ed25519')throw new Error('only Ed25519 package keys are supported');
 const der=key.export({type:'spki',format:'der'});
 return {key,id:sha256(der)};
}

export function gitPublicKey(text){
 if(typeof text!=='string')throw new Error('Git signer must be an SSH Ed25519 public key');
 const m=/^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(text.trim());
 if(!m)throw new Error('only SSH Ed25519 Git signer keys are supported');
 const blob=Buffer.from(m[1],'base64');
 if(blob.toString('base64')!==m[1]||blob.length!==51||blob.readUInt32BE(0)!==11||blob.subarray(4,15).toString()!=='ssh-ed25519'||blob.readUInt32BE(15)!==32)throw new Error('invalid SSH public key encoding');
 return {line:'ssh-ed25519 '+m[1],id:sha256(blob),fingerprint:'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,'')};
}

function present(file){try{lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

export function selectTrustFile({home,explicit=null}={}){
 if(explicit!==null&&explicit!==undefined){if(typeof explicit!=='string'||!explicit)throw new Error('explicit trust path is empty');return path.resolve(explicit);}
 if(!home)return null;
 const marker=path.join(home,'update','trust-required.json');
 if(present(marker)){
  const doc=strictJson(boundedRegularFile(marker,16384,'trust requirement'),{limit:16384});
  fields(doc,['schemaVersion','file'],'trust requirement');
  if(doc.schemaVersion!==TRUST_REQUIREMENT_SCHEMA||typeof doc.file!=='string'||!path.isAbsolute(doc.file))throw new Error('invalid trust requirement; refusing legacy fallback');
  return doc.file;
 }
 const candidate=path.join(home,'update','trust.json');
 return present(candidate)?candidate:null;
}

export function rememberTrustSelection(home,file){
 if(!home)return;
 const marker=path.join(home,'update','trust-required.json');
 trustDestination(marker);
 durableWrite(marker,JSON.stringify({schemaVersion:TRUST_REQUIREMENT_SCHEMA,file:canonicalPath(file)})+'\n');
}

function devIno(st){return `${st.dev}:${st.ino}`;}

function deepestExisting(p){
 let cur=path.resolve(p);
 const suffix=[];
 while(true){
  try{return {existing:cur,stat:lstatSync(cur),suffix};}
  catch(e){
   if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;
   const parent=path.dirname(cur);
   if(parent===cur)throw e;
   suffix.unshift(path.basename(cur));
   cur=parent;
  }
 }
}

function resolveTrustTarget(file,{forbidden=[]}={}){
 const named=path.resolve(file);
 const {existing:parent,suffix}=deepestExisting(path.dirname(named));
 const realParent=realpathSync.native(parent);
 const targetSuffix=[...suffix,path.basename(named)];
 let resolved=path.join(realParent,...targetSuffix);
 let leafStat=null;
 if(!suffix.length){
  try{
   leafStat=lstatSync(resolved);
   if(!leafStat.isSymbolicLink())resolved=realpathSync.native(resolved);
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }
 // Collect (dev, ino) of the existing non-symlink leaf and every existing ancestor directory up to '/'.
 // Comparing inodes catches directory and file aliases even when realpath preserves caller spelling (e.g. casefolded ext4).
 const ancestorIds=new Set();
 if(leafStat&&!leafStat.isSymbolicLink())ancestorIds.add(devIno(leafStat));
 const parentStat=lstatSync(realParent),ancestors=[];
 for(let dir=realParent;;dir=path.dirname(dir)){
  const st=dir===realParent?parentStat:lstatSync(dir);
  ancestorIds.add(devIno(st));
  const up=path.dirname(dir);
  if(dir===up)break;
  ancestors.push([dir,st]);
 }
 for(const root of forbidden){
  if(!root)continue;
  const cRoot=canonicalPath(root);
  if(withinPath(resolved,cRoot))throw new Error(`trust must be outside replaced/restored root: ${root}`);
  try{
   const rStat=lstatSync(cRoot);
   if(ancestorIds.has(devIno(rStat)))throw new Error(`trust must be outside replaced/restored root: ${root}`);
  }catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}
 }
 // Parent directories must not permit another account to substitute the file.
 for(const [dir,st] of ancestors){
  if((st.mode&0o022)||![0,process.getuid?.()??st.uid].includes(st.uid))throw new Error(`unsafe trust parent permissions/ownership: ${dir}`);
 }
 return {resolved,realParent,parentStat,leafStat,targetSuffix};
}

export function trustDestination(file,{forbidden=[]}={}){
 return resolveTrustTarget(file,{forbidden}).resolved;
}

// For an absent trust destination, test whether any absent forbidden root under the same existing parent directory
// resolves to the same directory entry using a private mkdtemp sandbox inside that parent (inheriting its exact
// filesystem lookup rules: APFS Unicode folding, ext4 per-directory casefold, etc.) without ever touching `target`.
function probeAbsentTrustDestination(info,forbidden){
 if(!forbidden.length||info.leafStat)return;
 const parentId=devIno(info.parentStat);
 const candidates=[];
 for(const root of forbidden){
  if(!root)continue;
  const {stat:rExistStat,suffix:rootSuffix}=deepestExisting(canonicalPath(root));
  if(!rootSuffix.length||rootSuffix.length>info.targetSuffix.length)continue;
  if(devIno(rExistStat)===parentId)candidates.push({root,rootSuffix});
 }
 if(!candidates.length)return;
 const probeDir=mkdtempSync(path.join(info.realParent,'.hub-trust-probe-'));
 try{
  for(const {root,rootSuffix} of candidates){
   const caseDir=mkdtempSync(path.join(probeDir,'c-'));
   let cur=caseDir,matched=true;
   for(let i=0;i<rootSuffix.length;i++){
    const targetEntry=path.join(cur,info.targetSuffix[i]);
    const rootEntry=path.join(cur,rootSuffix[i]);
    let stA;
    if(i===rootSuffix.length-1){
     const fd=openSync(targetEntry,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
     try{stA=fstatSync(fd);}finally{closeSync(fd);}
    }else{
     mkdirSync(targetEntry,{mode:0o700});
     stA=lstatSync(targetEntry);
    }
    try{
     const stB=lstatSync(rootEntry);
     if(devIno(stA)!==devIno(stB)){matched=false;break;}
    }catch(e){
     if(e.code==='ENOENT'||e.code==='ENOTDIR'){matched=false;break;}
     throw e;
    }
    cur=targetEntry;
   }
   if(matched)throw new Error(`trust must be outside replaced/restored root: ${root}`);
  }
 }finally{
  rmSync(probeDir,{recursive:true,force:true});
 }
}

export function validateTrust(doc){
 fields(doc,['schemaVersion','publishers'],'trust');
 if(doc.schemaVersion!==TRUST_SCHEMA)throw new Error('unsupported trust schema');
 fields(doc.publishers,Object.keys(doc.publishers??{}),'publishers');
 const seen=new Map();
 for(const [repo,pub] of Object.entries(doc.publishers)){
  if(!validRepo(repo))throw new Error('invalid publisher repository');
  fields(pub,['gitSigners','packageKeys'],'publisher');
  for(const role of ['gitSigners','packageKeys']){
   if(!Array.isArray(pub[role]))throw new Error(`missing ${role}`);
   for(const record of pub[role]){
    fields(record,['id','publicKey','fingerprint','role','status','minimumVersion','maximumVersion','provenance'],'key');
    if(record.role!==(role==='packageKeys'?'package':'git')||!['active','revoked','retired'].includes(record.status))throw new Error('invalid key authorization');
    for(const bound of ['minimumVersion','maximumVersion'])if(record[bound]!==undefined&&!parse(record[bound]))throw new Error('invalid version bound');
    if(typeof record.publicKey!=='string'||record.publicKey.length>16384||typeof record.fingerprint!=='string')throw new Error('invalid public key');
    const parsed=role==='packageKeys'?{...publicKey(record.publicKey),fingerprint:publicKey(record.publicKey).id}:gitPublicKey(record.publicKey),id=parsed.id;
    if(record.id!==id||record.fingerprint!==parsed.fingerprint)throw new Error('key fingerprint mismatch');
    if(seen.has(id)&&seen.get(id)!==JSON.stringify(record))throw new Error('conflicting key ID');
    seen.set(id,JSON.stringify(record));
   }
  }
 }
 return doc;
}

export function loadTrust(file,{forbidden=[]}={}){
 const resolved=trustDestination(file,{forbidden});
 const ownerError=()=>{throw new Error('trust must be an owner-controlled regular file, not writable by other users');};
 const bytes=boundedRegularFile(resolved,TRUST_MAX_BYTES,'trust',{
  onSymlink:ownerError,
  checkStat:fst=>{
   if(!fst.isFile()||(fst.mode&0o022)||fst.uid!==(process.getuid?.()??fst.uid))ownerError();
  },
 });
 return validateTrust(strictJson(bytes,{limit:TRUST_MAX_BYTES}));
}

export function authorizedKeys(trust,repository,role,version){
 const records=trust.publishers[repository]?.[role==='package'?'packageKeys':'gitSigners']??[];
 return records.filter(k=>k.status==='active'&&(!k.minimumVersion||compare(version,k.minimumVersion)>=0)&&(!k.maximumVersion||compare(version,k.maximumVersion)<=0));
}

export function verifyManifestSignature(bytes,sidecar,trust,repository,version){
 fields(sidecar,['schemaVersion','algorithm','keyId','signature'],'signature');
 if(sidecar.schemaVersion!==1||sidecar.algorithm!=='ed25519'||!/^[0-9a-f]{64}$/.test(sidecar.keyId)||typeof sidecar.signature!=='string')throw new Error('invalid signature metadata');
 const sig=Buffer.from(sidecar.signature,'base64');
 if(sig.length!==64||sig.toString('base64')!==sidecar.signature)throw new Error('invalid canonical signature');
 const key=authorizedKeys(trust,repository,'package',version).find(k=>k.id===sidecar.keyId);
 if(!key)throw new Error('unknown or unauthorized package signing key');
 if(!verify(null,Buffer.concat([MANIFEST_DOMAIN,bytes]),publicKey(key.publicKey).key,sig))throw new Error('invalid package signature');
 return sidecar.keyId;
}

export function importTrustKey({inst,trustFile,repository,role='package',publicKeyFile,expectedFingerprint,lock=acquireLock,out=null}={}){
 if(!['package','git'].includes(role))throw new UpdateError('trust-import role must be package or git');
 const forbidden=forbiddenTrustRoots(inst);
 const info=resolveTrustTarget(trustFile,{forbidden});
 probeAbsentTrustDestination(info,forbidden);
 const target=info.resolved;
 const release=lock(target+'.lock');
 try{
  const pem=readFileSync(publicKeyFile,'utf8').trim()+'\n';
  const parsed=role==='package'?publicKey(pem):gitPublicKey(pem);
  const id=parsed.id,fingerprint=parsed.fingerprint??id;
  if(fingerprint!==expectedFingerprint)throw new UpdateError('Expected public-key fingerprint does not match');
  const doc=present(target)?loadTrust(target,{forbidden}):{schemaVersion:TRUST_SCHEMA,publishers:{}};
  doc.publishers[repository]??={gitSigners:[],packageKeys:[]};
  const records=doc.publishers[repository][role==='package'?'packageKeys':'gitSigners'];
  if(records.some(k=>k.id===id))throw new UpdateError('Key already exists; import never reactivates retired or revoked keys. Review the local trust policy explicitly.');
  records.push({id,publicKey:pem,fingerprint,role,status:'active',provenance:'Local import with independently supplied expected fingerprint'});
  validateTrust(doc);
  const serialized=Buffer.from(JSON.stringify(doc,null,1)+'\n','utf8');
  if(serialized.length>TRUST_MAX_BYTES)throw new UpdateError('Trust policy exceeds its 1 MiB byte limit');
  probeAbsentTrustDestination(resolveTrustTarget(target,{forbidden}),forbidden);
  out?.(`Authorizing repository ${repository}, role ${role}, fingerprint ${id}`);
  durableWrite(target,serialized);
  const trust=loadTrust(target,{forbidden});
  rememberTrustSelection(inst?.home,target);
  return {repository,role,id,fingerprint,trustFile:target,trust};
 }finally{release();}
}
