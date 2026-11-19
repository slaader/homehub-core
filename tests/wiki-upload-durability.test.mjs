import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync,fsyncSync,openSync} from 'node:fs';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openDb} from '../server/db.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createWikiStore,wikiCollection} from '../server/wiki-store.mjs';
import {ASSET_GRACE,createWikiAssets} from '../server/wiki-assets.mjs';

const project='sample-game',owner='alice';
const validDoc=Buffer.from(JSON.stringify({v:1,blocks:[]}));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t,options={}){
 const state=await mkdtemp(path.join(os.tmpdir(),'wiki-asset-test-'));
 const root=path.join(state,'wiki'),dbFile=path.join(state,'hub.db'),db=openDb(dbFile);
 const tickets=createTicketStore(path.join(state,'tickets'),{db,seedProjects:[{id:project,key:'GAME',name:'Sample Game',type:'game'}]});
 const wiki=createWikiStore(db,tickets);
 const {home}=await wiki.setup({project},owner);
 t.after(async()=>{db.close();await rm(state,{recursive:true,force:true});});
 const assets=createWikiAssets(db,root,wiki,options);
 const begin=(bytes,{actor=owner,purpose='asset'}={})=>assets.begin({project,name:'test.bin',size:bytes.length,digest:digest(bytes),purpose},actor);
 async function stage(bytes,options){
  const {uploadId}=await begin(bytes,options);
  if(bytes.length)await assets.chunk(uploadId,0,bytes,options?.actor??owner);
  return uploadId;
 }
 return {db,wiki,home,state,root,assets,begin,stage};
}

test('wiki syncs staging and blob directory entries on publication and retries',async t=>{
 let failAt;
 const paths=[];
 const syncDirectory=dir=>{
  paths.push(dir);
  if(dir===failAt)throw new Error('directory sync failed');
  const fd=openSync(dir,'r');
  try{fsyncSync(fd);}finally{closeSync(fd);}
 };
 const {state,root,assets,stage,begin}=await fixture(t,{syncDirectory});
 const uploads=path.join(root,'uploads'),blobs=path.join(root,'blobs');
 const bytes=Buffer.from('a wiki file'),{uploadId}=await begin(bytes);
 failAt=root;
 await assert.rejects(assets.chunk(uploadId,0,bytes,owner),/directory sync failed/);
 assert.deepEqual(paths.splice(0),[uploads,root]);
 await assert.rejects(assets.status(uploadId,owner),/directory sync failed/);
 paths.length=0;
 failAt=undefined;
 assert.equal((await assets.chunk(uploadId,0,bytes,owner)).nextOffset,bytes.length);
 assert.deepEqual(paths.splice(0),[uploads,root,state]);
 failAt=state;
 await assert.rejects(assets.finish(uploadId,owner),/directory sync failed/);
 assert.deepEqual(paths.splice(0),[blobs,root,state]);
 assert.deepEqual(await assets.list(project,owner),[]);
 assert.deepEqual(await readFile(path.join(blobs,digest(bytes))),bytes);
 failAt=undefined;
 const {assetId}=await assets.finish(uploadId,owner);
 assert.deepEqual(paths.splice(0),[blobs,root,state]);
 assert.deepEqual(await readFile((await assets.media(project,assetId,owner)).file),bytes);
 await assert.rejects(stat(path.join(uploads,uploadId)),{code:'ENOENT'});
 const partial=(await begin(bytes)).uploadId;
 failAt=root;
 await assert.rejects(assets.chunk(partial,0,bytes.subarray(0,3),owner),/directory sync failed/);
 await assert.rejects(assets.finish(partial,owner),/directory sync failed/);
 await assert.rejects(assets.chunk(partial,4,bytes.subarray(4),owner),/directory sync failed/);
 failAt=undefined;
 await assert.rejects(assets.finish(partial,owner),{message:'upload-offset',nextOffset:3});
 const empty=await stage(Buffer.alloc(0));
 const finished=await assets.finish(empty,owner);
 assert.equal((await stat((await assets.media(project,finished.assetId,owner)).file)).size,0);
});

test('wiki verifies staged documents and counts finished documents against both session limits',async t=>{
 let now=Date.now();
 const {assets,begin,stage}=await fixture(t,{now:()=>now});
 for(const bytes of [Buffer.from('{"other":1}'),Buffer.from('{"v":1,"blocks":[{"t":"unknown"}]}')]){
  const id=await stage(bytes,{purpose:'document'});
  await assert.rejects(assets.finish(id,owner),{message:'invalid'});
  await assert.rejects(assets.status(id,owner),{message:'upload-expired'});
 }
 for(let i=0;i<16;i++){
  const id=await stage(validDoc,{purpose:'document'});
  assert.equal((await assets.finish(id,owner)).documentUploadId,id);
  assert.deepEqual(await assets.document(id,project,owner),{v:1,blocks:[]});
 }
 await assert.rejects(begin(validDoc),{message:'upload-limit'});
 for(let i=0;i<7;i++){
  for(let j=0;j<16;j++)await begin(validDoc,{actor:'writer-'+i});
 }
 await assert.rejects(begin(validDoc,{actor:'writer-extra'}),{message:'upload-limit'});
 now+=ASSET_GRACE;
 assert.ok((await begin(validDoc)).uploadId);
});

test('wiki cleanup retains aged files until the WAL is flushed and retries committed cleanup',async t=>{
 let now=Date.now();
 const {db,wiki,home,root,assets,stage}=await fixture(t,{now:()=>now});
 const orphans=Buffer.from('unreferenced file'),live=Buffer.from('referenced file');
 const old=await stage(orphans);
 await assets.finish(old,owner);
 const kept=await assets.finish(await stage(live),owner);
 const doc={v:1,blocks:[{t:'attachments',id:'files',attachments:[{assetId:kept.assetId}]}]};
 await wiki.update({project,id:home,rev:1,doc},owner);
 const pending=await stage(Buffer.from('pending'));
 const publishedDoc=await stage(validDoc,{purpose:'document'});
 await assets.finish(publishedDoc,owner);
 const files=[path.join(root,'blobs',digest(orphans)),path.join(root,'uploads',pending),path.join(root,'uploads',publishedDoc)];
 const flushWal=db.flushWal;
 const store=wikiCollection(db),change=store.change,seen=[];
 t.mock.method(store,'change',(selection,fn,options)=>change(selection,(data,count)=>{
  const mode=db.db.prepare('PRAGMA synchronous').get().synchronous;
  seen.push(mode);
  return fn(data,count);
 },options));
 db.flushWal=()=>{throw new Error('checkpoint did not complete');};
 now+=ASSET_GRACE;
 await assert.rejects(assets.sweep(),/checkpoint did not complete/);
 assert.deepEqual(seen,[2]);
 assert.equal(db.db.prepare('PRAGMA synchronous').get().synchronous,1);
 await assert.rejects(assets.status(pending,owner),{message:'upload-expired'});
 await Promise.all(files.map(file=>stat(file)));
 db.flushWal=flushWal;
 let republished;
 // Restore the same content after sweep has selected disk files and before it takes the writer lock.
 t.mock.method(store,'change',async(selection,fn,options)=>{
  if(!options?.durable&&Object.hasOwn(selection,'blobs')&&!republished){
   republished=await assets.finish(await stage(orphans),owner);
  }
  return change(selection,fn,options);
 });
 await assets.sweep();
 for(const file of files.slice(1))await assert.rejects(stat(file),{code:'ENOENT'});
 assert.deepEqual(await readFile((await assets.media(project,republished.assetId,owner)).file),orphans);
 assert.deepEqual(await readFile((await assets.media(project,kept.assetId,owner)).file),live);
});
