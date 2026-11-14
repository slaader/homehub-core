// The push agent's keys from the command line (scripts/manage-access.mjs create-agent-key, revoke-agent-key, list;
// docs/agent.md §2 → CLI), against a scratch state directory and the fixture site, with no hub running.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {credentials} from './hub-helper.mjs';
import {createAgentStore} from '../server/agent-store.mjs';

const script=fileURLToPath(new URL('../scripts/manage-access.mjs',import.meta.url));
const run=promisify(execFile);

async function scratch(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-agent-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state=path.join(dir,'state'),authFile=path.join(dir,'auth.json');
 await mkdir(state,{recursive:true});await writeFile(authFile,JSON.stringify(credentials),{mode:0o600});
 const env={...process.env,STATE_DIR:state,AUTH_FILE:authFile,HOME_HUB_LAUNCHD_LABEL:''};
 // → {code, out, err}: the command's exit and what it printed.
 const cli=async(...args)=>{try{const r=await run(process.execPath,[script,...args],{env});return {code:0,out:r.stdout,err:r.stderr};}catch(e){return {code:e.code,out:e.stdout,err:e.stderr};}};
 return {dir,state,cli};
}

test('create-agent-key: a 0600 file with the token, never printed; list shows the key without a secret; revoke-agent-key',async t=>{
 const {dir,state,cli}=await scratch(t);
 const output=path.join(dir,'keys','studio.json');
 const made=await cli('create-agent-key','--device','studio','--name','Studio agent','--output',output);
 assert.equal(made.code,0,made.err);
 const file=JSON.parse(await readFile(output,'utf8'));
 assert.equal((await stat(output)).mode&0o777,0o600);
 assert.deepEqual(Object.keys(file).sort(),['agent','schema','token']);assert.equal(file.schema,1);
 assert.deepEqual(Object.keys(file.agent).sort(),['createdAt','device','id','name','prefix']);
 assert.equal(file.agent.device,'studio');assert.equal(file.agent.name,'Studio agent');
 assert.match(file.token,/^hha_[a-f0-9]{64}$/);assert.equal(file.agent.prefix,file.token.slice(0,12));
 assert.ok(!made.out.includes(file.token)&&!made.err.includes(file.token),'the token goes only into the file');
 assert.deepEqual(JSON.parse(made.out),{ok:true,id:file.agent.id});
 assert.equal(createAgentStore(state).verify(file.token).device,'studio','the hub would take it');
 // An existing --output is never overwritten; a relative one is refused.
 assert.notEqual((await cli('create-agent-key','--device','studio','--output',output)).code,0);
 assert.notEqual((await cli('create-agent-key','--device','studio','--output','relative.json')).code,0);
 // list: the agent keys, without a token or its hash.
 const listed=await cli('list');assert.equal(listed.code,0,listed.err);
 const keys=JSON.parse(listed.out).agentKeys;
 assert.deepEqual(keys.map(k=>[k.id,k.device,k.name,k.prefix,k.revokedAt]),[[file.agent.id,'studio','Studio agent',file.agent.prefix,null]]);
 assert.ok(!listed.out.includes(file.token)&&!/"hash"/.test(listed.out));
 // Revoke: audited as local administration, and the key verifies to nothing.
 const revoked=await cli('revoke-agent-key','--id',file.agent.id);assert.equal(revoked.code,0,revoked.err);
 assert.equal(createAgentStore(state).verify(file.token),null);
 assert.equal(JSON.parse((await cli('list')).out).agentKeys[0].revokedBy,'local administration');
 const audit=(await readFile(path.join(state,'access-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual(audit.map(e=>[e.event,e.by]),[['agent-key-created','local administration'],['agent-key-revoked','local administration']]);
 assert.notEqual((await cli('revoke-agent-key','--id','0'.repeat(16))).code,0,'an unknown id');
});

test('create-agent-key refuses what the admin API refuses: unknown, the router, the NAS, platform "other"; an invalid devices.json stops it',async t=>{
 const {dir,state,cli}=await scratch(t);
 await mkdir(path.join(state,'home'),{recursive:true});
 const devices=path.join(state,'home','devices.json');
 await writeFile(devices,JSON.stringify({schema:1,devices:[{id:'odd',name:'Odd',platform:'other',role:'computer',createdAt:'2026-11-01T00:00:00.000Z'},{id:'pi-hole',name:'Pi-hole',role:'other',createdAt:'2026-11-01T00:00:00.000Z'}]}));
 for(const [device,message] of [['ghost',/No device/],['router',/router adapter/],['nas',/agent-less/],['odd',/platform/],['../x',/No device/]]){
  const output=path.join(dir,`${device.replace(/\W/g,'_')}.json`);
  const r=await cli('create-agent-key','--device',device,'--output',output);
  assert.notEqual(r.code,0,device);assert.match(r.err,message,device);
  await assert.rejects(stat(output),{code:'ENOENT'},`${device}: no file written`);
 }
 // The 1.x flag is refused by name, with no stack trace and no file; so is it by the other commands that took it.
 for(const args of [['--machine','pi-hole'],['--machine=pi-hole']]){
  const r=await cli('create-agent-key',...args,'--output',path.join(dir,'old.json'));
  assert.equal(r.code,2);assert.equal(r.err.trim(),'manage-access: --machine was renamed to --device in 2.0');
  await assert.rejects(stat(path.join(dir,'old.json')),{code:'ENOENT'});
 }
 const installer=await run(process.execPath,[fileURLToPath(new URL('../scripts/install-host-agent.mjs',import.meta.url)),'--plugin','x','--machine','pi-hole','--dry-run']).catch(e=>e);
 assert.equal(installer.code,2);assert.equal(installer.stderr.trim(),'install-host-agent: --machine was renamed to --device in 2.0');
 // An added device takes a key, bound to its createdAt.
 const ok=await cli('create-agent-key','--device','pi-hole','--output',path.join(dir,'pi.json'));assert.equal(ok.code,0,ok.err);
 assert.equal(JSON.parse(await readFile(path.join(state,'agents.json'),'utf8')).agents[0].deviceCreatedAt,'2026-11-01T00:00:00.000Z');
 // devices.json of another schema: refused as the server refuses it, nothing issued.
 await writeFile(devices,JSON.stringify({schema:2,devices:[{id:'pi-hole',role:'other',createdAt:'2026-11-01T00:00:00.000Z'}]}));
 const newer=await cli('create-agent-key','--device','pi-hole','--output',path.join(dir,'pi2.json'));
 assert.notEqual(newer.code,0);assert.match(newer.err,/Invalid devices file/);
 assert.equal(JSON.parse(await readFile(path.join(state,'agents.json'),'utf8')).agents.length,1);
});
