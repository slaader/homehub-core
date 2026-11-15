import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync,renameSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {acquireLock,sourceLockPath} from '../server/update-lock.mjs';
import {readUpdateJournal} from '../server/update-journal.mjs';
const moduleUrl=new URL('../server/update-lock.mjs',import.meta.url).href;
test('lock: exclusive processes, crash evidence, legacy locks and ownership-safe release',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'hub-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'update.lock');
 const release=acquireLock(file);assert.throws(()=>acquireLock(file),/already exists/);
 const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireLock,sourceLockPath} from ${JSON.stringify(moduleUrl)};try{acquireLock(${JSON.stringify(file)});process.exit(8);}catch{process.exit(0);}`]);assert.equal(await new Promise(r=>child.on('exit',r)),0);
 renameSync(file,file+'.old');mkdirSync(file);writeFileSync(path.join(file,'owner.json'),'{}');release();assert.ok(readFileSync(path.join(file,'owner.json'),'utf8')==='{}','replaced lock is never deleted');rmSync(file,{recursive:true});rmSync(file+'.old',{recursive:true});
 const crash=spawn(process.execPath,['--input-type=module','-e',`import {acquireLock,sourceLockPath} from ${JSON.stringify(moduleUrl)};acquireLock(${JSON.stringify(file)});process.exit(0);`]);assert.equal(await new Promise(r=>crash.on('exit',r)),0);assert.throws(()=>acquireLock(file),/No automatic stale-lock/);rmSync(file,{recursive:true});
 writeFileSync(file,'{"pid":999999}');assert.throws(()=>acquireLock(file),/legacy file locks/);
});
test('journal: missing is distinct from corrupt, unknown and malformed schema-1 journals',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'hub-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'journal');assert.equal(readUpdateJournal(file),null);
 for(const text of ['{','{"schemaVersion":999}',JSON.stringify({schemaVersion:1,step:'switching'})]){writeFileSync(file,text);assert.throws(()=>readUpdateJournal(file),/corrupt or newer/);assert.equal(readFileSync(file,'utf8'),text);}
});
test('journal: literal schema-1 recovery record is preserved and migrates explicitly on write',async t=>{
 const {writeUpdateJournal}=await import('../server/update-journal.mjs');const dir=mkdtempSync(path.join(os.tmpdir(),'hub-journal-v1-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'journal');writeFileSync(file,readFileSync(new URL('./fixtures/update/journal-v1.json',import.meta.url)));const j=readUpdateJournal(file);assert.equal(j.schemaVersion,1);assert.equal(j.step,'starting');writeUpdateJournal(file,j);assert.equal(readUpdateJournal(file).schemaVersion,2);assert.equal(j.backup.entries[0].name,'data');
});

test('source locks: local registry identity is independent of TMPDIR and path aliases',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'hub-lock-alias-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const before=sourceLockPath(dir),original=process.env.TMPDIR;try{process.env.TMPDIR=dir;assert.equal(sourceLockPath(path.join(dir,'.')),before);}finally{if(original===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=original;}
});
