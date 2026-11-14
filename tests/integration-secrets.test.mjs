import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSecretStore} from '../server/integrations.mjs';
import {createSecretBox} from '../server/secret-box.mjs';

async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-integration-secrets-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'integrations.json');
 const box=createSecretBox({env:{HOME_HUB_SECRET_KEY:'a'.repeat(64)},platform:'linux',keyFile:path.join(dir,'unused.key')});
 return {dir,file,box};
}
test('legacy integration secrets are sealed before use and reopen without exposing values',async t=>{
 const {file,box}=await fixture(t);
 await writeFile(file,JSON.stringify({schemaVersion:1,values:{'demo.feed':{apiKey:'legacy-test-key'}}}));
 const store=createSecretStore(file,{box});await store.ready();
 assert.equal(store.get('demo.feed','apiKey'),'legacy-test-key');
 const disk=await readFile(file,'utf8');assert.equal(JSON.parse(disk).sealed,1);assert(!disk.includes('legacy-test-key'));
 assert.equal((await stat(file)).mode&0o777,0o600);
 const reopened=createSecretStore(file,{box});await reopened.ready();assert.equal(reopened.get('demo.feed','apiKey'),'legacy-test-key');
 await reopened.clear('demo.feed','apiKey');assert.equal(reopened.get('demo.feed','apiKey'),null);
 const cleared=createSecretStore(file,{box});await cleared.ready();assert.equal(cleared.has('demo.feed','apiKey'),false);
});
test('parallel secret updates do not discard other integrations or fields',async t=>{
 const {file,box}=await fixture(t),store=createSecretStore(file,{box});
 await Promise.all([store.set('demo.feed','a','one'),store.set('demo.feed','b','two'),store.set('demo.other','a','three')]);
 const reopened=createSecretStore(file,{box});await reopened.ready();
 assert.equal(reopened.get('demo.feed','a'),'one');assert.equal(reopened.get('demo.feed','b'),'two');assert.equal(reopened.get('demo.other','a'),'three');
});
test('locked, corrupt and newer secret stores cannot be silently replaced',async t=>{
 const {file,dir,box}=await fixture(t),store=createSecretStore(file,{box});await store.set('demo.feed','apiKey','test-value');
 const original=await readFile(file,'utf8');
 const wrong=createSecretBox({env:{HOME_HUB_SECRET_KEY:'b'.repeat(64)},platform:'linux',keyFile:path.join(dir,'absent.key')});
 const locked=createSecretStore(file,{box:wrong});await assert.rejects(locked.ready(),/secrets-locked/);
 await assert.rejects(locked.set('demo.feed','apiKey','replacement'));assert.equal(await readFile(file,'utf8'),original);
 for(const raw of ['{broken',JSON.stringify({schemaVersion:99,values:{}})]){
  await writeFile(file,raw);const bad=createSecretStore(file,{box});await assert.rejects(bad.ready());
  await assert.rejects(bad.set('demo.feed','apiKey','replacement'));assert.equal(await readFile(file,'utf8'),raw);
 }
});
