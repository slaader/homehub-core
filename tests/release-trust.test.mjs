import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,chmodSync,symlinkSync,realpathSync,lstatSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {strictJson} from '../server/safe-fs.mjs';
import {validateTrust,publicKey,verifyManifestSignature,MANIFEST_DOMAIN,TRUST_MAX_BYTES,forbiddenTrustRoots,loadTrust,importTrustKey,selectTrustFile,rememberTrustSelection} from '../server/release-trust.mjs';
const pair=generateKeyPairSync('ed25519'),pem=pair.publicKey.export({type:'spki',format:'pem'}),id=publicKey(pem).id;
const record={id,publicKey:pem,fingerprint:id,role:'package',status:'active'};
const doc=()=>({schemaVersion:1,publishers:{'example/core':{gitSigners:[],packageKeys:[{...record}]}}});
function safeTempDir(t,prefix='hub-trust-'){
 let base=os.tmpdir();
 for(const candidate of [os.tmpdir(),os.homedir(),process.cwd()]){
  if(!candidate)continue;
  try{
   const real=realpathSync.native(candidate);
   let ok=true;
   for(let dir=real;dir!==path.dirname(dir);dir=path.dirname(dir)){
    const st=lstatSync(dir);
    if((st.mode&0o022)||![0,process.getuid?.()??st.uid].includes(st.uid)){ok=false;break;}
   }
   if(ok){base=real;break;}
  }catch{}
 }
 const dir=realpathSync.native(mkdtempSync(path.join(base,prefix)));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return dir;
}
test('trust: duplicate JSON keys, invalid encodings, algorithms and conflicting authorizations are refused',()=>{
 for(const input of ['{"a":1,"a":2}','{"a":{"b":1,"b":2}}','[1]garbage'])assert.throws(()=>strictJson(Buffer.from(input)));
 assert.throws(()=>strictJson(Buffer.from([0xff])));assert.deepEqual(strictJson(Buffer.from('{"a":[true,null,3]}')),{a:[true,null,3]});
 assert.deepEqual(validateTrust(doc()),doc());const bad=doc();bad.publishers['example/core'].packageKeys.push({...record,status:'revoked'});assert.throws(()=>validateTrust(bad),/conflicting/);
});
test('trust: exact bytes, authorized key and version constraints required, including after revocation',()=>{
 const bytes=Buffer.from('{"version":"1.0.0"}'),signature=sign(null,Buffer.concat([MANIFEST_DOMAIN,bytes]),pair.privateKey).toString('base64');
 const side={schemaVersion:1,algorithm:'ed25519',keyId:id,signature};const trust=validateTrust(doc());
 assert.equal(verifyManifestSignature(bytes,side,trust,'example/core','1.0.0'),id);
 assert.throws(()=>verifyManifestSignature(Buffer.concat([bytes,Buffer.from('\n')]),side,trust,'example/core','1.0.0'),/invalid package/);
 trust.publishers['example/core'].packageKeys[0].status='revoked';assert.throws(()=>verifyManifestSignature(bytes,side,trust,'example/core','1.0.0'),/unauthorized/);
 assert.throws(()=>verifyManifestSignature(bytes,{...side,algorithm:'rsa'},trust,'example/core','1.0.0'),/invalid signature/);
});
test('trust: a removed selected policy never silently reverts to legacy discovery',t=>{
 const home=safeTempDir(t,'.hub-trust-marker-');assert.equal(selectTrustFile({home}),null);const file=path.join(home,'publisher.json');writeFileSync(file,JSON.stringify(doc()),{mode:0o600});rememberTrustSelection(home,file);rmSync(file);assert.equal(selectTrustFile({home}),file);assert.throws(()=>selectTrustFile({home,explicit:''}),/empty/);writeFileSync(path.join(home,'update','trust-required.json'),'{');assert.throws(()=>selectTrustFile({home}));
});
test('trust: forbiddenTrustRoots includes backupRoots and loadTrust enforces symlink, permission and root checks',t=>{
 const dir=safeTempDir(t,'.hub-trust-sec-');
 const inst={root:path.join(dir,'core'),paths:{config:path.join(dir,'config'),data:path.join(dir,'data'),state:path.join(dir,'state'),private:path.join(dir,'private')},backupRoots:[path.join(dir,'extra-backup')]};
 const forbidden=forbiddenTrustRoots(inst);
 assert.deepEqual(forbidden,[inst.root,inst.paths.config,inst.paths.data,inst.paths.state,inst.paths.private,inst.backupRoots[0]]);
 const safeDir=path.join(dir,'safe'),badParent=path.join(dir,'writable'),linkParent=path.join(dir,'link-parent');
 mkdirSync(safeDir,{mode:0o700});mkdirSync(badParent,{mode:0o700});chmodSync(badParent,0o777);symlinkSync(badParent,linkParent);
 const goodFile=path.join(safeDir,'trust.json'),symFile=path.join(safeDir,'trust.link'),inBadParent=path.join(linkParent,'trust.json');
 writeFileSync(goodFile,JSON.stringify(doc()),{mode:0o600});
 writeFileSync(path.join(badParent,'trust.json'),JSON.stringify(doc()),{mode:0o600});
 symlinkSync(goodFile,symFile);
 assert.deepEqual(loadTrust(goodFile,{forbidden}),doc());
 assert.throws(()=>loadTrust(symFile,{forbidden}),/owner-controlled regular file/);
 assert.throws(()=>loadTrust(inBadParent,{forbidden}),/unsafe trust parent/);
 chmodSync(goodFile,0o644);
 assert.deepEqual(loadTrust(goodFile,{forbidden}),doc());
 chmodSync(goodFile,0o660);
 assert.throws(()=>loadTrust(goodFile,{forbidden}),/owner-controlled regular file/);
 chmodSync(goodFile,0o600);
 const backupDir=inst.backupRoots[0];mkdirSync(backupDir,{mode:0o700});
 const inBackup=path.join(backupDir,'trust.json'),keyFile=path.join(dir,'pub.pem');
 writeFileSync(keyFile,pem,{mode:0o600});
 assert.throws(()=>importTrustKey({inst,trustFile:inBackup,repository:'example/core',role:'package',publicKeyFile:keyFile,expectedFingerprint:id}),/outside replaced\/restored root/);
 writeFileSync(inBackup,JSON.stringify(doc()),{mode:0o600});
 assert.throws(()=>importTrustKey({inst,trustFile:inBackup,repository:'example/core',role:'package',publicKeyFile:keyFile,expectedFingerprint:id}),/outside replaced\/restored root/);
 // An individual file configured as a backup root is refused before writing (when absent) and when existing, including alternate casing on case-insensitive filesystems.
 const fileRoot=path.join(safeDir,'backed-up-trust.json');
 const altCase=path.join(safeDir,'BACKED-UP-TRUST.JSON');
 const instFileRoot={...inst,backupRoots:[...inst.backupRoots,fileRoot]};
 const fileForbidden=forbiddenTrustRoots(instFileRoot);
 let caseInsensitive=false;
 try{const st=lstatSync(path.join(dir,'SAFE')),orig=lstatSync(safeDir);caseInsensitive=st.dev===orig.dev&&st.ino===orig.ino;}catch{}
 assert.throws(()=>importTrustKey({inst:instFileRoot,trustFile:fileRoot,repository:'example/core',role:'package',publicKeyFile:keyFile,expectedFingerprint:id}),/outside replaced\/restored root/);
 assert.throws(()=>lstatSync(fileRoot),{code:'ENOENT'});
 if(caseInsensitive){
  assert.throws(()=>importTrustKey({inst:instFileRoot,trustFile:altCase,repository:'example/core',role:'package',publicKeyFile:keyFile,expectedFingerprint:id}),/outside replaced\/restored root/);
  assert.throws(()=>lstatSync(fileRoot),{code:'ENOENT'});
  assert.throws(()=>lstatSync(altCase),{code:'ENOENT'});
 }
 writeFileSync(fileRoot,JSON.stringify(doc()),{mode:0o600});
 assert.throws(()=>loadTrust(fileRoot,{forbidden:fileForbidden}),/outside replaced\/restored root/);
 assert.throws(()=>importTrustKey({inst:instFileRoot,trustFile:fileRoot,repository:'example/core',role:'package',publicKeyFile:keyFile,expectedFingerprint:id}),/outside replaced\/restored root/);
 if(caseInsensitive){
  assert.throws(()=>loadTrust(altCase,{forbidden:fileForbidden}),/outside replaced\/restored root/);
  assert.throws(()=>importTrustKey({inst:instFileRoot,trustFile:altCase,repository:'example/core',role:'package',publicKeyFile:keyFile,expectedFingerprint:id}),/outside replaced\/restored root/);
 }
});
test('trust: importTrustKey refuses writes exceeding the 1 MiB trust policy limit without modifying the existing policy',t=>{
 const dir=safeTempDir(t,'.hub-trust-limit-');
 const trustFile=path.join(dir,'trust.json'),keyFile=path.join(dir,'extra.pem');
 const existing=doc();
 // Fill provenance to sit just below TRUST_MAX_BYTES so one added key pushes the serialized policy over the limit.
 existing.publishers['example/core'].packageKeys[0].provenance='p'.repeat(TRUST_MAX_BYTES-600);
 const originalBytes=Buffer.from(JSON.stringify(existing,null,1)+'\n','utf8');
 assert.ok(originalBytes.length<=TRUST_MAX_BYTES);
 writeFileSync(trustFile,originalBytes,{mode:0o600});
 const extraPair=generateKeyPairSync('ed25519'),extraPem=extraPair.publicKey.export({type:'spki',format:'pem'}),extraId=publicKey(extraPem).id;
 writeFileSync(keyFile,extraPem,{mode:0o600});
 assert.throws(()=>importTrustKey({inst:null,trustFile,repository:'example/core',role:'package',publicKeyFile:keyFile,expectedFingerprint:extraId}),/1 MiB byte limit/);
 assert.deepEqual(readFileSync(trustFile),originalBytes);
});
