import test from 'node:test';import assert from 'node:assert/strict';
import {identityMismatch,observeReadiness} from '../server/update-readiness.mjs';
const expected={version:'2.1.0',dataEpoch:4,fullCommit:'a'.repeat(40),packageDigest:null,readinessProtocol:1,plugins:[{id:'test',version:'1.0.0',fingerprint:'hash',sourceFingerprint:'sourcehash'}]};
const identity=()=>({...expected,bootId:'new-boot',pid:100,startedAt:'2026-01-01T00:00:00Z'});
test('readiness refuses wrong/missing identity and unversioned expected plugins',()=>{
 for(const field of ['fullCommit','packageDigest','dataEpoch','readinessProtocol','bootId']){const run=identity();delete run[field];assert.ok(identityMismatch(run,expected,{pidAlive:()=>true}),field);}
 const run=identity();run.plugins=[{id:'test'}];assert.match(identityMismatch(run,expected,{pidAlive:()=>true}),/unversioned/);const source=identity();source.plugins=[{...expected.plugins[0],sourceFingerprint:'wrong'}];assert.match(identityMismatch(source,expected,{pidAlive:()=>true}),/source fingerprint/);
});
test('readiness requires full stable interval and resets on flaps, restarts and proxy mismatches',async()=>{
 for(const scenario of ['stable','flap','restart','proxy','missing']){let clock=0,samples=0;const run=identity();const ctx={now:()=>clock,sleep:async n=>{clock+=n;},checkpoint:()=>{},pidAlive:()=>true,probe:async()=>{samples++;if(scenario==='restart'&&clock>=4000)run.bootId='different';return {ok:scenario!=='flap'||clock!==4000,bootId:scenario==='proxy'?'proxy':scenario==='missing'?null:run.bootId};}};
 const promise=observeReadiness({inst:{health:{url:'http://127.0.0.1:1/healthz',seconds:15}},ctx,expect:expected,since:0,readRun:()=>run,previousBootId:'old'});
 if(['proxy','missing'].includes(scenario))await assert.rejects(promise,/HTTP boot ID/);else {await promise;assert.ok(clock>=(scenario==='stable'?10000:15000));assert.ok(samples>=11);}
 }
});
