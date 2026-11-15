import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {strictJson,validateTrust,publicKey,verifyManifestSignature,MANIFEST_DOMAIN} from '../server/release-trust.mjs';
const pair=generateKeyPairSync('ed25519'),pem=pair.publicKey.export({type:'spki',format:'pem'}),id=publicKey(pem).id;
const record={id,publicKey:pem,fingerprint:id,role:'package',status:'active'};
const doc=()=>({schemaVersion:1,publishers:{'example/core':{gitSigners:[],packageKeys:[{...record}]}}});
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
test('trust: a removed selected policy never silently reverts to legacy discovery',async t=>{
 const {mkdtempSync,rmSync,mkdirSync,writeFileSync,realpathSync}=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const {selectTrustFile,rememberTrustSelection}=await import('../server/release-trust.mjs');const home=realpathSync(mkdtempSync(path.join(os.tmpdir(),'hub-trust-marker-')));t.after(()=>rmSync(home,{recursive:true,force:true}));assert.equal(selectTrustFile({home}),null);const file=path.join(home,'publisher.json');writeFileSync(file,JSON.stringify(doc()),{mode:0o600});rememberTrustSelection(home,file);rmSync(file);assert.equal(selectTrustFile({home}),file);assert.throws(()=>selectTrustFile({home,explicit:''}),/empty/);writeFileSync(path.join(home,'update','trust-required.json'),'{');assert.throws(()=>selectTrustFile({home}));
});
