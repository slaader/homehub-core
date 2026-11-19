import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {DB_SCHEMA,openDb} from '../server/db.mjs';
import {WIKI_SCHEMA,createWikiStore} from '../server/wiki-store.mjs';
import {createWikiVideos,WIKI_VIDEO_BUSY} from '../server/wiki-video.mjs';

const project='sample-game',wiki='/api/wiki';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const group=(...attachments)=>({v:1,blocks:[{t:'attachments',id:'media',attachments}]});
const mp4=Buffer.from('\0\0\0\x14ftypisom\0\0\x02\0isom','latin1');
const webm=Buffer.concat([Buffer.from('1a45dfa3','hex'),Buffer.from('webm'),Buffer.alloc(40,123)]);
const fakeBinary='/example/ffmpeg';
const nativeBinary=process.env.HOME_HUB_WIKI_FFMPEG;

function model(name){
 const json=JSON.stringify({asset:{version:'2.0'},nodes:[{name}]});
 const chunk=Buffer.from(json.padEnd(Math.ceil(json.length/4)*4,' ')),header=Buffer.alloc(20);
 header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(header.length+chunk.length,8);
 header.writeUInt32LE(chunk.length,12);header.write('JSON',16);
 return Buffer.concat([header,chunk]);
}

async function json(response,status){
 const result=await response,data=await result.json();
 assert.equal(result.status,status,JSON.stringify(data));
 return data;
}

async function upload(h,actor,name,bytes,destination=project){
 const {uploadId}=await json(h.post(wiki+'/uploads',{project:destination,name,size:bytes.length,digest:digest(bytes)},actor.headers),201);
 await json(fetch(h.origin+wiki+'/uploads/'+uploadId+'?offset=0',{method:'PUT',body:bytes,
  headers:{...actor.headers,'Content-Type':'application/octet-stream'}}),200);
 return (await json(h.post(wiki+'/uploads/finish',{uploadId},actor.headers),200)).asset;
}

test('paired assets authorize and publish together, preserve the original and unpublish on removal',async t=>{
 const h=await hub(t),writer=await h.account('first-author',['tickets:write']);
 const other=await h.account('second-author',['tickets:write']),reader=await h.account('reader',[]);
 const {home}=await json(h.post(wiki+'/setup',{project},writer.headers),201);
 await json(h.post(wiki+'/setup',{project:'home-hub'},writer.headers),201);
 const {rev}=await json(h.post(wiki+'/pages/update',{project,id:home,rev:1,doc:group()},writer.headers),200);
 const original=await upload(h,writer,'original.glb',model('Original'));
 const preview=await upload(h,writer,'preview.glb',model('Preview'));
 const privateCopy=await upload(h,other,'private.glb',model('Private'));
 const wrongProject=await upload(h,writer,'other-project.glb',model('Wrong project'),'home-hub');
 const otherType=await upload(h,writer,'motion.webm',webm);
 const add={project,id:home,rev,groupId:'media',assetId:original.id,requestId:'preview-pair',initialClip:' Walk '};
 for(const display of [privateCopy,wrongProject,otherType]){
  const error=await json(h.post(wiki+'/attachments/add',{...add,displayAssetId:display.id},writer.headers),400);
  assert.equal(error.error.reason,'invalid-asset');
 }
 const badClip=await json(h.post(wiki+'/pages/update',{project,id:home,rev,doc:group({assetId:otherType.id,initialClip:'Walk'})},writer.headers),400);
 assert.equal(badClip.error.reason,'invalid-asset');
 assert.equal((await fetch(h.origin+preview.url,{headers:reader.headers})).status,404);
 const {id:pageId,...args}=add;
 const attach=arguments_=>h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',
  params:{name:'wiki_attachment_add',arguments:arguments_}},writer.headers);
 const captured={...args,pageId,displayAssetId:preview.id};
 const result=(await json(attach(captured),200)).result;
 assert.equal(result.isError,false,JSON.stringify(result));
 const retried=(await json(attach(captured),200)).result;
 assert.equal(retried.structuredContent.replayed,true);
 const saved=await json(fetch(h.origin+wiki+'/'+project+'/pages/'+home,{headers:reader.headers}),200);
 assert.deepEqual(saved.doc.blocks[0].attachments,[{assetId:original.id,label:'',caption:'',displayAssetId:preview.id,initialClip:' Walk '}]);
 assert.deepEqual(saved.assets.map(asset=>asset.id),[original.id,preview.id]);
 const download=await fetch(h.origin+original.url+'?download=1',{headers:reader.headers});
 assert.match(download.headers.get('content-disposition'),/^attachment;/);
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),model('Original'));
 const display=await fetch(h.origin+preview.url,{headers:reader.headers});
 const tag=display.headers.get('etag');
 assert.deepEqual(Buffer.from(await display.arrayBuffer()),model('Preview'));
 await json(h.post(wiki+'/pages/update',{project,id:home,rev:saved.rev,doc:group({assetId:original.id})},writer.headers),200);
 const revoked=await fetch(h.origin+preview.url,{headers:{...reader.headers,'If-None-Match':tag}});
 assert.equal(revoked.status,404);
 assert.equal(revoked.headers.get('etag'),null);
 assert.match(revoked.headers.get('cache-control'),/no-store/);
});

test('authorized wiki video representations revalidate and serve ranges without changing the original',async t=>{
 const renders=[];
 const h=await hub(t,{wikiVideos:{binary:fakeBinary,render:(_binary,file)=>{renders.push(file.digest);return webm;}}});
 const writer=await h.account('wiki-author',['tickets:write']),reader=await h.account('wiki-reader',[]);
 const {home}=await json(h.post(wiki+'/setup',{project},writer.headers),201);
 const original=await upload(h,writer,'clip.mp4',mp4);
 const get=(url,actor=reader,headers={},method='GET')=>fetch(h.origin+url,{method,headers:{...actor?.headers,...headers}});
 const preview=original.url+'?preview=webm';
 assert.equal((await get(preview,null,{'If-None-Match':'*'})).status,401);
 assert.equal((await get(preview,reader,{'If-None-Match':'*'},'HEAD')).status,404);
 assert.deepEqual(renders,[]);
 for(const url of [original.url,preview]){
  const draft=await get(url,writer,{'If-None-Match':'*'},'HEAD');
  assert.equal(draft.status,200);
  assert.equal(draft.headers.get('cache-control'),'private, no-store');
  assert.equal(draft.headers.get('etag'),null);
 }
 await json(h.post(wiki+'/pages/update',{project,id:home,rev:1,doc:group({assetId:original.id})},writer.headers),200);
 const mp4Head=await get(original.url,reader,{},'HEAD');
 const webmHead=await get(preview,reader,{},'HEAD');
 const tag=webmHead.headers.get('etag');
 assert.equal(webmHead.headers.get('content-type'),'video/webm');
 assert.equal(webmHead.headers.get('content-length'),String(webm.length));
 assert.equal(await webmHead.text(),'');
 assert.notEqual(tag,mp4Head.headers.get('etag'));
 assert.equal(webmHead.headers.get('cache-control'),'private, no-cache');
 for(const validator of [`"some,tag", W/${tag}`,'*']){
  const cached=await get(preview,reader,{'If-None-Match':validator,Range:'bytes=0-4'});
  assert.equal(cached.status,304);
  assert.equal(await cached.text(),'');
 }
 const range=await get(preview,reader,{Range:'bytes=1-4','If-Range':tag});
 assert.equal(range.status,206);
 assert.equal(range.headers.get('content-range'),`bytes 1-4/${webm.length}`);
 assert.deepEqual(Buffer.from(await range.arrayBuffer()),webm.subarray(1,5));
 for(const stale of [mp4Head.headers.get('etag'),`W/${tag}`]){
  const full=await get(preview,reader,{Range:'bytes=1-4','If-Range':stale});
  assert.equal(full.status,200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),webm);
 }
 const invalid=await get(preview,reader,{Range:'bytes=999-'});
 assert.equal(invalid.status,416);
 assert.equal(invalid.headers.get('content-range'),`bytes */${webm.length}`);
 assert.match(invalid.headers.get('cache-control'),/no-store/);
 assert.equal(invalid.headers.get('etag'),null);
 assert.deepEqual(Buffer.from(await (await get(original.url)).arrayBuffer()),mp4);
 assert.deepEqual(renders,[original.digest]);
});

test('video conversion bounds and deduplicates a queue and remembers failures by digest',async ()=>{
 const deferred=Promise.withResolvers(),rendered=[];
 const service=createWikiVideos({binary:fakeBinary,render:(_binary,{digest})=>{
  rendered.push(digest);
  return digest==='a'?deferred.promise:Buffer.alloc(32);
 }});
 const source=(digest,overrides)=>({digest,type:'video/mp4',size:123,file:'/fixture',...overrides});
 assert.equal(service.get(source('a',{type:'video/webm'})),null);
 assert.equal(service.get(source('a',{size:65*1024**2})),null);
 const first=service.get(source('a'));
 assert.equal(service.get(source('a')),first);
 const second=service.get(source('b')),third=service.get(source('c'));
 assert.equal(service.get(source('b')),second);
 assert.equal(service.get(source('d')),WIKI_VIDEO_BUSY);
 assert.deepEqual(rendered,['a']);
 deferred.resolve(webm);
 assert.deepEqual((await first).bytes,webm);
 assert.equal(await second,null);
 assert.equal(await third,null);
 assert.equal(service.get(source('b')),null);
 assert.deepEqual(rendered,['a','b','c']);
});

test('literal Home Hub 1.3.0 attachment records migrate without rewriting their references',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'wiki-media-db-')),file=path.join(temp,'hub.db');
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite'),old=new DatabaseSync(file);
 const legacyMeta='{"schema":2,"revision":1,"updatedAt":"2026-01-01T00:00:00.000Z"}';
 const legacyPage='{"id":"wabcdefghijk","project":"sample-game","parentId":null,"title":"Media","doc":{"v":1,"blocks":[{"t":"attachments","id":"pictures","attachments":[{"assetId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","label":"Existing asset","caption":""}]}]},"links":{"tickets":[]},"rev":1,"createdAt":"2026-01-01T00:00:00.000Z","createdBy":"alice","updatedAt":"2026-01-01T00:00:00.000Z","updatedBy":"alice","history":[]}';
 const legacyAsset='{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","project":"sample-game","name":"preview.png","type":"image/png","size":123,"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","owner":"alice","references":1,"published":true,"orphanedAt":null}';
 const {ddl}=JSON.parse(await readFile(new URL('./fixtures/wiki-flat-1.2.0.json',import.meta.url),'utf8'));
 old.exec(ddl.join(';')+'; PRAGMA user_version=3');
 old.prepare("INSERT INTO meta VALUES ('wiki',?)").run(legacyMeta);
 old.prepare("INSERT INTO docs VALUES ('wiki','pages','sample-game/wabcdefghijk',?)").run(legacyPage);
 old.prepare("INSERT INTO docs VALUES ('wiki','assets','sample-game/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?)").run(legacyAsset);
 old.close();
 const db=openDb(file);
 try{
  const store=createWikiStore(db,{});
  const loaded=await store.get('sample-game','wabcdefghijk');
  assert.deepEqual(loaded,JSON.parse(legacyPage));
  assert.equal((await store.withAssets(loaded)).assets[0].name,'preview.png');
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,DB_SCHEMA);
  assert.equal(JSON.parse(db.db.prepare("SELECT doc FROM meta WHERE kind='wiki'").get().doc).schema,WIKI_SCHEMA);
  assert.deepEqual(db.db.prepare("SELECT doc FROM docs WHERE kind='wiki' ORDER BY coll").all().map(({doc})=>doc),[legacyAsset,legacyPage]);
 }finally{db.close();}
});

if(nativeBinary)test('FFmpeg converts H.264 High with audio to a complete playable WebM',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'wiki-native-video-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const original=path.join(temp,'clip'),preview=path.join(temp,'preview.webm');
 execFileSync(nativeBinary,['-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=30',
  '-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libx264','-profile:v','high','-c:a','aac','-f','mp4',original]);
 const input=await readFile(original);
 const media=await createWikiVideos({binary:nativeBinary}).get({file:original,size:input.length,digest:digest(input),type:'video/mp4'});
 assert.ok(media);
 await writeFile(preview,media.bytes);
 const decoded=execFileSync(nativeBinary,['-v','error','-i',preview,'-map','0:v','-vf','scale=1:1',
  '-pix_fmt','gray','-f','rawvideo','pipe:1','-map','0:a','-f','null','-']);
 assert.equal(decoded.length,30);
});
