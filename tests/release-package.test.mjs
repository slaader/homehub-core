import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {verifyPackage,validateManifest} from '../server/release-package.mjs';
import {packageFixture} from './package-fixture.mjs';
const temporary=t=>{const dir=mkdtempSync(path.join(os.tmpdir(),'hub-package-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
test('package: exact signed metadata, complete payload verification, pinning and revocation',async t=>{
 const f=await packageFixture(temporary(t),{files:{'server/index.mjs':'throw new Error("must not execute");'}}),opts={trust:f.trust,repository:'example/core',manifestDigest:f.manifestSha256};const verified=await verifyPackage(f.file,opts);assert.equal(verified.verification,'verified');assert.equal(verified.manifestSha256,f.manifestSha256);
 await assert.rejects(verifyPackage(f.file,{repository:'example/core'}),/require --trust/);
 await assert.rejects(verifyPackage(f.file,{...opts,manifestDigest:'0'.repeat(64)}),/pinned/);
 const bytes=readFileSync(f.base+'.manifest.json');writeFileSync(f.base+'.manifest.json',Buffer.concat([bytes,Buffer.from(' ')]));await assert.rejects(verifyPackage(f.file,opts),/invalid package signature/);f.save();
 f.trust.publishers['example/core'].packageKeys[0].status='revoked';await assert.rejects(verifyPackage(f.file,opts),/unauthorized/);f.trust.publishers['example/core'].packageKeys[0].status='active';
 const payload=readFileSync(f.file);writeFileSync(f.file,payload.subarray(0,payload.length-1));await assert.rejects(verifyPackage(f.file,opts),/size\/hash/);
});
test('package: signed declarations cannot raise limits or introduce mutable/unsafe payloads',async t=>{
 const f=await packageFixture(temporary(t));for(const field of ['bytes','uncompressedBytes']){const old=f.manifest.artifact[field];f.manifest.artifact[field]=Number.MAX_SAFE_INTEGER;assert.throws(()=>validateManifest(f.manifest,{repository:'example/core'}),/limits/);f.manifest.artifact[field]=old;}
 for(const name of ['../bad','/bad','C:/bad','a\\b','.git/config','private/auth.json','.home-hub-package.json']){const original=f.manifest.files[0].path;f.manifest.files[0].path=name;assert.throws(()=>validateManifest(f.manifest,{repository:'example/core'}));f.manifest.files[0].path=original;}
 f.manifest.files.push({...f.manifest.files[0]});assert.throws(()=>validateManifest(f.manifest,{repository:'example/core'}),/duplicate/);
});
