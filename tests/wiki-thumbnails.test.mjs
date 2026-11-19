import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {hub} from './hub-helper.mjs';
import {gitHost,pointer,workTree} from './support/git-host.mjs';
import {createWikiThumbnails} from '../server/wiki-thumbnails.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const project='sample-game';
const thumbnail=url=>url+'?thumbnail=1';
const fakeBinary='/example/ffmpeg';
const nativeBinary=process.env.HOME_HUB_WIKI_FFMPEG;
const dimensions=bytes=>[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
const empty={v:1,blocks:[]};

function png(width,height,red=120){
 function chunk(type,data=Buffer.alloc(0)){
  const part=Buffer.alloc(12+data.length);
  part.writeUInt32BE(data.length,0);
  part.write(type,4);
  data.copy(part,8);
  part.writeUInt32BE(crc32(part.subarray(4,-4)),part.length-4);
  return part;
 }
 const header=Buffer.alloc(13);
 header.writeUInt32BE(width,0);
 header.writeUInt32BE(height,4);
 header[8]=8;
 header[9]=2;
 const row=Buffer.alloc(1+width*3);
 for(let x=1;x<row.length;x+=3)row[x]=red;
 const pixels=Buffer.concat(Array(height).fill(row));
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
  chunk('IDAT',deflateSync(pixels)),chunk('IEND')]);
}

async function body(response,status){
 const result=await response;
 const data=await result.json();
 assert.equal(result.status,status,JSON.stringify(data));
 return data;
}

async function rpc(h,actor,name,args){
 const data=await body(h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',
  params:{name:'wiki_'+name,arguments:args}},actor.headers),200);
 assert.equal(data.result?.isError,false,JSON.stringify(data));
 return data.result.structuredContent;
}

test('thumbnail requests use the original access check for uploaded and imported images',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'wiki-thumbnail-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const seen=[];
 const wikiThumbnails=nativeBinary?{binary:nativeBinary}:{binary:fakeBinary,render:(_binary,file)=>{
  seen.push(file.digest);
  return png(384,240);
 }};
 const h=await hub(t,{wikiThumbnails,gitLfsTokenFile:path.join(temp,'tokens.json')});
 const writer=await h.account('wiki-author',['tickets:write']);
 const reader=await h.account('wiki-reader',[]);
 const other=await h.account('other-author',['tickets:write']);
 const get=(url,actor,options)=>fetch(h.origin+url,{...options,headers:{...actor?.headers,...options?.headers}});
 const {home}=await body(h.post('/api/wiki/setup',{project},writer.headers),201);

 const browserBytes=png(640,400,50),mcpBytes=png(640,400,83),reviewBytes=png(640,400,115),lfsBytes=png(640,400,144);
 const browserUpload=await body(h.post('/api/wiki/uploads',
  {project,name:'front.png',size:browserBytes.length,digest:sha(browserBytes)},writer.headers),201);
 const raw=await fetch(h.origin+'/api/wiki/uploads/'+browserUpload.uploadId+'?offset=0',{method:'PUT',body:browserBytes,
  headers:{...writer.headers,'Content-Type':'application/octet-stream'}});
 assert.equal(raw.status,200);
 await raw.json();
 const browser=(await body(h.post('/api/wiki/uploads/finish',{uploadId:browserUpload.uploadId},writer.headers),200)).asset;
 const upload=await rpc(h,writer,'upload_begin',{project,name:'scout.png',size:mcpBytes.length,digest:sha(mcpBytes)});
 await rpc(h,writer,'upload_chunk',{uploadId:upload.uploadId,offset:0,data:mcpBytes.toString('base64')});
 const mcp=(await rpc(h,writer,'upload_finish',{uploadId:upload.uploadId})).asset;

 const digest=sha(reviewBytes);
 const staged=await fetch(h.origin+'/api/review/blobs/'+digest+'?offset=0&size='+reviewBytes.length,
  {method:'PUT',headers:{...h.admin,Origin:h.origin,'Content-Type':'application/octet-stream'},body:reviewBytes});
 assert.equal(staged.status,201);
 await staged.json();
 const review=await body(h.post('/api/review/publish',{project,title:'Scout screenshot',items:[
  {id:'scout',kind:'image',title:'Scout',variants:[{id:'a',media:[{sha256:digest,type:'image/png',name:'review.png'}]}]},
 ]},h.admin),201);
 const reviewAsset=(await body(h.post('/api/wiki/assets/import',{project,
  source:{kind:'review',set:review.id,round:1,item:'scout',variant:'a'}},writer.headers),201)).asset;
 await rm((await h.handler.hub.state('review').review.media(digest)).file);

 const host=await gitHost(t),repo='alice/media',file='screens/scout.png',oid=sha(lfsBytes);
 host.addRepo(repo);
 const work=workTree(host,repo);
 work.commit({[file]:pointer(oid,lfsBytes.length)});
 host.storeObject(repo,oid,lfsBytes);
 work.push();
 const git=h.handler.hub.state('git-lfs').store;
 const connection=(await git.save({provider:'gitea',name:'Fixture Git',baseUrl:host.origin,token:host.token,repoMode:'all'},'alice')).id;
 const grant={project,kind:'lfs',connection,repo};
 await body(h.post('/api/admin/wiki/sources',{...grant,enabled:true},h.admin),200);
 const lfs=(await rpc(h,writer,'asset_import',{project,source:{kind:'lfs',connection,repo,ref:'main',path:file}})).asset;
 await body(h.post('/api/admin/wiki/sources',{...grant,enabled:false},h.admin),200);
 host.fail['/']=503;
 assert.equal(reviewAsset.source.kind,'review');
 assert.equal(lfs.source.kind,'lfs');

 const url=thumbnail(mcp.url);
 assert.equal((await get(url)).status,401);
 for(const actor of [reader,other]){
  assert.equal((await get(mcp.url,actor)).status,404);
  assert.equal((await get(url,actor,{method:'HEAD'})).status,404);
 }
 assert.equal(seen.length,0);
 assert.equal((await get(url,writer)).status,200);
 assert.equal((await get(url,reader)).status,404);
 assert.equal((await get(url.replace(project,'home-hub'),writer)).status,404);
 assert.equal((await get(url.replace(mcp.id,mcp.digest),writer)).status,404);

 const assets=[[browser,browserBytes],[mcp,mcpBytes],[reviewAsset,reviewBytes],[lfs,lfsBytes]];
 const saved=await body(h.post('/api/wiki/pages/update',{project,id:home,rev:1,doc:{v:1,blocks:[
  {t:'attachments',id:'pictures',attachments:assets.map(([asset])=>({assetId:asset.id}))},
 ]}},writer.headers),200);
 for(const [asset,original] of assets){
  const thumb=await get(thumbnail(asset.url),reader,{headers:{Range:'bytes=0-7'}});
  assert.equal(thumb.status,200);
  assert.equal(thumb.headers.get('content-type'),'image/png');
  assert.equal(thumb.headers.get('cache-control'),'private, no-store');
  assert.equal(thumb.headers.get('x-content-type-options'),'nosniff');
  assert.equal(thumb.headers.get('content-range'),null);
  const bytes=Buffer.from(await thumb.arrayBuffer());
  assert.deepEqual(dimensions(bytes),[384,240]);
  assert.notDeepEqual(bytes,original);
  const head=await get(thumbnail(asset.url),reader,{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(Number(head.headers.get('content-length')),bytes.length);
  assert.equal((await head.arrayBuffer()).byteLength,0);
  const range=await get(asset.url,reader,{headers:{Range:'bytes=16-23'}});
  assert.equal(range.status,206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()),original.subarray(16,24));
 }
 await body(h.post('/api/wiki/pages/update',{project,id:home,rev:saved.rev,doc:empty},writer.headers),200);
 for(const [asset] of assets)assert.equal((await get(thumbnail(asset.url),reader)).status,404);
 if(!nativeBinary)assert.deepEqual(seen.sort(),assets.map(([asset])=>asset.digest).sort());
});

test('thumbnail generator bounds and deduplicates work and rejects oversized output',async ()=>{
 const bytes=png(2,1);
 const called=[],jobs=[];
 const render=(_binary,file)=>{
  called.push(file.digest);
  return new Promise(resolve=>jobs.push(resolve));
 };
 const generator=createWikiThumbnails({binary:fakeBinary,render});
 const entry=(index,extra={})=>({digest:String(index),type:'image/png',size:12,file:'/fixture',...extra});
 assert.equal(generator.get(entry(0,{size:32*1024**2+1})),null);
 assert.equal(generator.get(entry(0,{type:'image/svg+xml'})),null);
 const first=generator.get(entry(0));
 assert.equal(generator.get(entry(0)),first);
 const rest=Array.from({length:13},(_,index)=>generator.get(entry(index+1)));
 assert.deepEqual(called,['0','1']);
 assert.ok(rest.every(value=>value instanceof Promise));
 assert.equal(generator.get(entry(99)),null);
 for(let index=0;index<14;index++){
  const result=index===0?first:rest[index-1];
  jobs.shift()(index===0?png(385,1):bytes);
  assert.deepEqual(await result,index===0?null:bytes);
 }
 assert.equal(generator.get(entry(1)),bytes);
 assert.equal(called.length,14);
 assert.equal(createWikiThumbnails({binary:'ffmpeg',render}).get(entry(0)),null);

 let attempts=0;
 const retry=createWikiThumbnails({binary:fakeBinary,render:()=>{
  if(++attempts===1)throw new Error('helper failed');
  if(attempts===2)return Buffer.concat([bytes,Buffer.alloc(640*1024)]);
  return bytes;
 }});
 assert.equal(await retry.get(entry(1)),null);
 assert.equal(await retry.get(entry(1)),null);
 assert.equal(await retry.get(entry(1)),bytes);
});

test('thumbnail cache evicts old entries and leaves downloads usable when the helper is unavailable',async t=>{
 const bytes=png(1,1);
 let renders=0;
 const generator=createWikiThumbnails({binary:fakeBinary,render:()=>{renders++;return bytes;}});
 const entry=digest=>({digest,type:'image/png',size:bytes.length,file:'/fixture'});
 for(let index=0;index<128;index++)await generator.get(entry(index));
 assert.equal(generator.get(entry(0)),bytes);
 await generator.get(entry(128));
 assert.equal(generator.get(entry(0)),bytes);
 await generator.get(entry(1));
 assert.equal(renders,130);

 const h=await hub(t,{wikiThumbnails:{binary:''}});
 const writer=await h.account('wiki-author',['tickets:write']);
 await body(h.post('/api/wiki/setup',{project},writer.headers),201);
 const source=await rpc(h,writer,'upload_begin',{project,name:'still.png',size:bytes.length,digest:sha(bytes)});
 await rpc(h,writer,'upload_chunk',{uploadId:source.uploadId,offset:0,data:bytes.toString('base64')});
 const {asset}=await rpc(h,writer,'upload_finish',{uploadId:source.uploadId});
 const preview=await fetch(h.origin+thumbnail(asset.url),{headers:writer.headers});
 assert.equal(preview.status,404);
 assert.equal(preview.headers.get('cache-control'),'private, no-store');
 const original=await fetch(h.origin+asset.url,{headers:writer.headers});
 assert.equal(original.status,200);
 assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
});

if(nativeBinary)test('installed FFmpeg renders the supported raster formats and safely rejects invalid input',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'wiki-native-thumbnail-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const service=createWikiThumbnails({binary:nativeBinary});
 const input=png(800,450);
 const encode=(codec,muxer)=>execFileSync(nativeBinary,['-v','error','-nostdin','-f','png_pipe','-i','pipe:0',
  '-frames:v','1','-c:v',codec,'-f',muxer,'pipe:1'],{input});
 // A 16×10 red WebP. The server only needs a WebP decoder, so the fixture does not need a WebP encoder.
 const webp=Buffer.from('UklGRkYAAABXRUJQVlA4IDkAAADwAgCdASoQAAoAAEcIhYWIhYSIAgICdaoD+AP6Ag1NGAD+/W7z/+OZNzDE/45t//FhPA4oyP/xUQAA','base64');
 for(const [type,bytes,expected] of [
  ['image/png',input,[384,216]],['image/jpeg',encode('mjpeg','image2pipe'),[384,216]],
  ['image/gif',encode('gif','gif'),[384,216]],['image/webp',webp,[16,10]],
 ]){
  const file=path.join(dir,'fixture');
  await writeFile(file,bytes);
  const preview=await service.get({file,digest:sha(bytes),size:bytes.length,type});
  assert.ok(preview,type);
  assert.deepEqual(dimensions(preview),expected);
 }
 const invalid=input.subarray(0,33),file=path.join(dir,'invalid.png');
 await writeFile(file,invalid);
 const entry={file,digest:sha(invalid),size:invalid.length,type:'image/png'};
 assert.equal(await service.get(entry),null);
});
