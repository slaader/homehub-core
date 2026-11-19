import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openDb} from '../server/db.mjs';
import {BUILTIN_PROVIDERS,contextFor,resolveImportPointer} from '../server/git-lfs-providers.mjs';
import {createWikiSources} from '../server/wiki-sources.mjs';
import {gitHost,oid,pointer,workTree} from './support/git-host.mjs';

for(const kind of ['github','gitea','forgejo']){
 test(`wiki LFS resolves an exact path from immutable Git objects on ${kind}`,async t=>{
  const host=await gitHost(t,{kind:kind==='github'?'github':'gitea',maxPage:1}),name='alice/media';
  host.addRepo(name);
  const work=workTree(host,name),file='scenes/scout model.glb';
  const first=work.commit({'a.txt':'irrelevant','scenes/a.txt':'irrelevant',[file]:pointer(oid('a'),12)});
  work.git('tag','-a','release','-m','Release',first);
  work.git('branch','release',first);
  work.push('--all');
  work.push('--tags');
  const second=work.commit({[file]:pointer(oid('b'),34),'scenes/ordinary.bin':Buffer.alloc(1024)});
  const provider=BUILTIN_PROVIDERS.find(provider=>provider.id===kind);
  const ctx=contextFor(provider,{baseUrl:host.origin,token:host.token,login:host.login});
  const repo=await provider.getRepo(ctx,name),options={github:kind==='github'};
  let advanced=false;
  ctx.fetch=async(url,request)=>{
   const res=await fetch(url,request);
   if(!advanced&&url.endsWith('/heads/main')){
    advanced=true;
    work.push('main');
   }
   return res;
  };
  const resolve=(ref,selected=file)=>resolveImportPointer(ctx,repo,ref,selected,options);
  assert.deepEqual(await resolve('main'),{commit:first,oid:oid('a'),size:12,ref:'refs/heads/main'});
  assert.deepEqual(await resolve('HEAD'),{commit:second,oid:oid('b'),size:34});
  assert.deepEqual(await resolve(first),{commit:first,oid:oid('a'),size:12});
  assert.deepEqual(await resolve('refs/tags/release'),{commit:first,oid:oid('a'),size:12,ref:'refs/tags/release'});
  await assert.rejects(resolve('release'),{code:'invalid-ref'});
  await assert.rejects(resolve('HEAD','scenes/missing.glb'),{code:'not-found'});
  const before=host.log.length;
  await assert.rejects(resolve('HEAD','scenes/ordinary.bin'),{code:'too-large'});
  assert.ok(!host.log.slice(before).some(r=>r.path.includes('/git/blobs/')));
  assert.ok(!host.log.some(r=>r.path.endsWith('/info/refs')||r.path.endsWith('/git-upload-pack')));

  let signal,cancelled=false;
  ctx.fetch=(url,request)=>{
   if(!url.includes('/git/blobs/'))return fetch(url,request);
   signal=request.signal;
   return new Response(new ReadableStream({
    start(stream){stream.enqueue(new Uint8Array(8193));},
    cancel(){cancelled=true;},
   }));
  };
  await assert.rejects(resolve('HEAD'),{code:'too-large'});
  assert.equal(signal.aborted,true);
  assert.equal(cancelled,true);
 });
}

test('wiki holds the Git LFS concurrency slot through ingestion and releases it after settling',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wiki-lfs-limit-')),db=openDb(path.join(root,'hub.db'));
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 const project='sample-game',connection='c1234567890',repo='alice/media';
 const wiki={projectOf:async id=>({id})};
 let lookups=0,ingests=0;
 const atCap=Promise.withResolvers(),release=Promise.withResolvers();
 const git={importIdentity:()=> 'fixture-identity',async importPointer(){lookups++;return {body:()=>null};}};
 const assets={async ingest(){
  ingests++;
  if(ingests===4)atCap.resolve();
  await release.promise;
  return {assetId:'fixture'};
 }};
 const sources=createWikiSources(db,wiki,assets,{lfs:()=>git});
 await sources.setGrant({project,kind:'lfs',connection,repo,enabled:true});
 const input={project,source:{kind:'lfs',connection,repo,ref:'main',path:'asset.bin'}};
 const run=()=>sources.importAsset(input,'alice',{scopes:['read']});
 const imports=Array.from({length:4},run);
 await atCap.promise;
 await assert.rejects(run(),{message:'source-busy'});
 assert.equal(lookups,4);
 release.resolve();
 await Promise.all(imports);
 assert.deepEqual(await run(),{assetId:'fixture'});
 assert.equal(lookups,5);
});
