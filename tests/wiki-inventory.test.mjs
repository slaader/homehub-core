import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {gitHost,pointer,workTree} from './support/git-host.mjs';
import {openDb} from '../server/db.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createWikiStore} from '../server/wiki-store.mjs';
import {ASSET_GRACE,createWikiAssets,MCP_CHUNK,UPLOAD_TTL} from '../server/wiki-assets.mjs';
import {createBackup,restoreBackup} from '../server/update-backup.mjs';

const project='sample-game';
const siteWiki='/api/wiki';
const assetUrl=(id,ownerProject=project)=>`${siteWiki}/${ownerProject}/assets/${id}`;
const get=(h,url,headers=h.admin)=>fetch(h.origin+url,{headers});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const doc=(...blocks)=>({v:1,blocks});
const text=text=>({t:'text',text});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN/cAAAAASUVORK5CYII=','base64');
const wave=Buffer.from('RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x40\x1f\0\0\x01\0\x08\0data\0\0\0\0','latin1');
const glb=(extra={})=>{
 const json=JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[0]}],nodes:[{name:'Scout'}],
  animations:[{name:'Idle',channels:[],samplers:[]}],...extra});
 const chunk=Buffer.from(json.padEnd(Math.ceil(json.length/4)*4,' ')),header=Buffer.alloc(20);
 header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(header.length+chunk.length,8);
 header.writeUInt32LE(chunk.length,12);header.write('JSON',16);
 return Buffer.concat([header,chunk]);
};
const mp4=Buffer.from('\0\0\0\x14ftypisom\0\0\x02\0isom','latin1');

async function rpc(h,actor,name,args,reason){
 const response=await fetch(h.origin+'/mcp',{method:'POST',headers:{...actor.headers,'Content-Type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wiki_'+name,arguments:args}})});
 assert.equal(response.status,200);
 const result=(await response.json()).result;
 assert.equal(result?.isError,Boolean(reason),JSON.stringify(result));
 if(reason&&reason!==true)assert.equal(result.structuredContent?.error.reason,reason,JSON.stringify(result));
 return result.structuredContent;
}

async function body(response,status){
 const result=await response;
 const data=await result.json();
 assert.equal(result.status,status,JSON.stringify(data));
 return data;
}

function raw(h,actor,uploadId,offset,bytes){
 return fetch(h.origin+`/api/wiki/uploads/${uploadId}?offset=${offset}`,{method:'PUT',
  headers:{...actor.headers,'Content-Type':'application/octet-stream'},body:bytes});
}

function inventory(ticket){
 return {t:'inventory',id:'scouts',columns:[
  {id:'unit',label:'Unit'},{id:'description',label:'Description'},{id:'stats',label:'Stats'},
  {id:'voices',label:'Voices'},{id:'model',label:'3D preview'},{id:'gameplay',label:'Gameplay'},
 ],rows:[{id:'scout',cells:{unit:{c:[text('Scout')]},description:{c:[{t:'ticket',id:ticket}]},
  stats:{stats:[{name:'Health',value:80},{name:'Speed',value:7,unit:'m/s'}]}}}]};
}

async function upload(h,writer,name,bytes,{type,purpose}={}){
 const session=await rpc(h,writer,'upload_begin',{project,name,size:bytes.length,digest:sha(bytes),type,purpose});
 for(let offset=0;offset<bytes.length;offset+=session.chunkSize){
  const chunk=bytes.subarray(offset,offset+session.chunkSize);
  await rpc(h,writer,'upload_chunk',{uploadId:session.uploadId,offset,data:chunk.toString('base64')});
 }
 return rpc(h,writer,'upload_finish',{uploadId:session.uploadId});
}

async function backupFixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'hub-wiki-backup-'));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:10}));
 const data=path.join(root,'data'),state=path.join(data,'state'),config=path.join(root,'config');
 const privateDir=path.join(root,'private'),authFile=path.join(privateDir,'auth.json');
 await Promise.all([state,config,privateDir].map(dir=>mkdir(dir,{recursive:true})));
 await writeFile(authFile,'{}');
 const paths={data,state,config,private:privateDir,authFile,siteConfig:path.join(config,'site.json'),softwareWatch:path.join(config,'watch.json')};
 const inst={root:path.join(root,'core'),home:root,paths,env:{},backups:path.join(root,'backups'),staging:path.join(root,'staging'),
  files:{journal:path.join(root,'update-journal.json'),lock:path.join(root,'update.lock')}};
 const ctx={now:()=>0,log:()=>{},checkpoint:()=>{}},file=path.join(state,'hub.db');
 const journal=backup=>{
  const version={label:'1.2.0',core:{version:'1.2.0'},expect:{version:'1.2.0'}};
  return {schemaVersion:3,id:'wiki-fixture',startedAt:new Date(0).toISOString(),step:'rolling-back',
   from:version,to:version,changes:[],epochRose:true,backup,
   settings:{root:inst.root,state,service:{stop:['true'],start:['true']},health:{url:'http://127.0.0.1:1/healthz',seconds:2}}};
 };
 return {inst,ctx,file,state,journal};
}

test('wiki epoch 8 upgrades real 1.2.0 flat records and an updater backup restores the original schema and documents',async t=>{
 const {inst,ctx,file,state,journal}=await backupFixture(t);
 const fixture=JSON.parse(await readFile(new URL('./fixtures/wiki-flat-1.2.0.json',import.meta.url),'utf8'));
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite');
 const old=new DatabaseSync(file);
 old.exec(fixture.ddl.join(';')+'; PRAGMA user_version='+fixture.schema);
 for(const [kind,value] of fixture.meta)old.prepare('INSERT INTO meta VALUES (?,?)').run(kind,JSON.stringify(value));
 for(const [kind,coll,id,value] of fixture.docs)old.prepare('INSERT INTO docs VALUES (?,?,?,?)').run(kind,coll,id,JSON.stringify(value));
 old.close();
 const before=await readFile(file),backup=await createBackup(inst,ctx,'before-wiki-tree');
 const db=openDb(file);
 try{
  const tickets=createTicketStore(path.join(state,'tickets'),{db}),wiki=createWikiStore(db,tickets);
  const saved=await wiki.get('example-app',fixture.units);
  assert.equal(saved.parentId,fixture.home);
  const original=fixture.docs.find(row=>row[1]==='pages'&&row[3].id===fixture.units)[3];
  assert.deepEqual(saved,{...original,parentId:fixture.home});
  const list=await wiki.list('example-app');
  assert.deepEqual(list.pages.map(({id,parentId})=>[id,parentId]),
   [[fixture.home,null],[fixture.inventory,fixture.home],[fixture.units,fixture.home]]);
  assert.equal((await wiki.backlinks(fixture.ticket))[0].id,fixture.units);
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,3);
  await wiki.move({project:'example-app',id:fixture.units,rev:saved.rev,parentId:fixture.inventory},'alice');
 }finally{db.close();}
 await restoreBackup(inst,ctx,backup,journal(backup));
 assert.deepEqual(await readFile(file),before);
 const restored=new DatabaseSync(file,{readOnly:true});
 try{assert.equal(restored.prepare('PRAGMA user_version').get().user_version,2);}
 finally{restored.close();}
});

test('wiki MCP authors a 100-row inventory with streamed media, atomic moves and retry-safe attachments',async t=>{
 const h=await hub(t),writer=await h.account('wiki-author',['tickets:write']),reader=await h.account('wiki-reader',[]);
 const another=await h.account('other-author',['tickets:write']);
 const ticket=await body(h.post('/api/tickets',{project,title:'Implement scout'},h.admin),201);
 const home=await rpc(h,writer,'setup',{project});
 assert.equal(home.home,home.pageId);
 const create={project,parentId:home.home,title:'Game inventory',requestId:'inventory-1'};
 const catalog=await rpc(h,writer,'page_create',create);
 assert.equal((await rpc(h,writer,'page_create',create)).pageId,catalog.pageId);
 await rpc(h,writer,'page_create',{...create,title:'A different request'},'request-conflict');
 await rpc(h,writer,'page_create',{project,title:'Missing retry key'},'invalid');
 const units=await rpc(h,writer,'page_create',{project,parentId:catalog.pageId,title:'Units',requestId:'units-1'});
 const buildings=await rpc(h,writer,'page_create',{project,parentId:catalog.pageId,title:'Buildings',requestId:'buildings-1'});
 await rpc(h,writer,'page_create',{project,parentId:catalog.pageId,title:'Neutral enemies',requestId:'neutral-1'});
 await rpc(h,reader,'page_create',{project,title:'No'},true);
 const tree=await rpc(h,reader,'list',{project});
 assert.deepEqual(tree.pages.map(page=>page.title),['Home','Game inventory','Buildings','Neutral enemies','Units']);
 const moves=await Promise.all([
  h.post('/api/wiki/pages/move',{project,id:units.pageId,rev:1,parentId:buildings.pageId},writer.headers),
  h.post('/api/wiki/pages/move',{project,id:buildings.pageId,rev:1,parentId:units.pageId},another.headers),
 ]);
 assert.deepEqual(moves.map(res=>res.status).sort(),[200,400]);
 await rpc(h,writer,'page_move',{project,pageId:home.home,rev:1,parentId:units.pageId},'invalid-parent');

 const latest=await rpc(h,writer,'get',{project,pageId:units.pageId});
 const rowGroup={t:'attachments',id:'downloads',attachments:[]};
 const table=inventory(ticket.id);
 const description='Documented in the source collection. '.repeat(25);
 for(let index=1;index<100;index++)table.rows.push({id:'unit-'+index,cells:{unit:{c:[text(description)]}}});
 const document=doc(table,rowGroup);
 const serialized=Buffer.from(JSON.stringify(document));
 assert.ok(serialized.length>65536&&serialized.length<256*1024);
 const staged=await upload(h,writer,'inventory.json',serialized,{purpose:'document'});
 assert.ok(staged.documentUploadId&&!staged.assetId);
 await rpc(h,another,'page_save',{project,pageId:units.pageId,rev:latest.rev,documentUploadId:staged.documentUploadId},'denied');
 const saved=await rpc(h,writer,'page_save',{project,pageId:units.pageId,rev:latest.rev,title:'Playable units',documentUploadId:staged.documentUploadId});
 assert.equal(saved.pageId,units.pageId);
 assert.equal(saved.url,units.url);
 const stale=await rpc(h,writer,'page_save',{project,pageId:units.pageId,rev:latest.rev,title:'Stale'},'conflict');
 assert.equal(stale.current.rev,saved.rev);
 assert.equal((await body(get(h,`${siteWiki}/tickets/${ticket.id}/backlinks`),200)).pages[0].id,units.pageId);

 const files=[
  ['scout-front.png',png,'unit'],['scout-back.png',Buffer.concat([png,Buffer.from('back')]),'unit'],
  ['selected.wav',wave,'voices'],['move.wav',wave,'voices'],
  ['scout.glb',glb(),'model'],['attack.mp4',mp4,'gameplay'],
  ['download.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),null],
 ];
 let rev=saved.rev;
 for(const [index,[name,bytes,columnId]] of files.entries()){
  const {assetId,asset}=await upload(h,writer,name,bytes);
  assert.equal(asset.digest,sha(bytes));
  assert.equal((await get(h,assetUrl(assetId),reader.headers)).status,404);
  assert.equal((await get(h,assetUrl(assetId),another.headers)).status,404);
  assert.equal((await get(h,assetUrl(assetId),writer.headers)).status,200);
  const attach={project,pageId:units.pageId,rev,assetId,requestId:'asset-'+index,label:name,caption:'Pinned '+name,position:0,
   ...(columnId?{tableId:'scouts',rowId:'scout',columnId}:{groupId:'downloads'})};
  if(index===0)await rpc(h,another,'attachment_add',attach,'invalid-asset');
  const result=await rpc(h,writer,'attachment_add',attach);
  assert.equal(result.rev,++rev);
  assert.equal((await rpc(h,writer,'attachment_add',attach)).rev,rev);
  const published=await get(h,assetUrl(assetId),reader.headers);
  assert.equal(published.status,200);
  assert.deepEqual(Buffer.from(await published.arrayBuffer()),bytes);
  if(columnId===null){
   assert.equal(published.headers.get('content-type'),'application/octet-stream');
   assert.match(published.headers.get('content-disposition'),/^attachment;/);
  }
  assert.equal((await get(h,assetUrl(assetId,'home-hub'),writer.headers)).status,404);
 }
 const read=await rpc(h,reader,'get',{project,pageId:units.pageId});
 assert.equal(read.rev,rev);
 assert.equal(read.doc.blocks[0].rows.length,100);
 assert.deepEqual(read.doc.blocks[0].rows[0].cells.voices.attachments.map(ref=>ref.label),['move.wav','selected.wav']);
 assert.equal(read.assets.length,7);
 const pngAsset=read.assets.find(asset=>asset.name==='scout-front.png');
 const ranged=await get(h,pngAsset.url,{...reader.headers,Range:'bytes=2-7'});
 assert.equal(ranged.status,206);
 assert.equal(ranged.headers.get('content-range'),`bytes 2-7/${png.length}`);
 assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),png.subarray(2,8));
 assert.equal((await get(h,pngAsset.url,{...reader.headers,Range:'bytes=9999-'})).status,416);
 const duplicate=await rpc(h,writer,'page_create',{project,title:'Other page',requestId:'other-page',
  doc:doc({...rowGroup,attachments:[{assetId:pngAsset.id}]})});
 await rpc(h,writer,'setup',{project:'home-hub'});
 await rpc(h,writer,'page_create',{project:'home-hub',title:'Foreign reference',requestId:'foreign-asset',
  doc:doc({...rowGroup,attachments:[{assetId:pngAsset.id}]})},'invalid-asset');
 const results=await Promise.all(['First edit','Second edit'].map(title=>h.post('/api/wiki/pages/update',{project,id:units.pageId,rev,title,doc:doc(rowGroup)},writer.headers)));
 assert.deepEqual(results.map(res=>res.status).sort(),[200,409]);
 assert.equal((await get(h,pngAsset.url,reader.headers)).status,200);
 const emptied=await rpc(h,writer,'page_save',{project,pageId:duplicate.pageId,rev:duplicate.rev,doc:doc(rowGroup)});
 const target={project,pageId:duplicate.pageId,rev:emptied.rev};
 await rpc(h,another,'attachment_add',{...target,groupId:'downloads',assetId:pngAsset.id,requestId:'reattach'},'invalid-asset');
 await rpc(h,another,'page_save',{...target,doc:doc({...rowGroup,attachments:[{assetId:pngAsset.id}]})},'invalid-asset');
 assert.equal((await get(h,pngAsset.url,reader.headers)).status,404);
});

test('wiki uploads resume across raw and MCP retries, expire, reject bad bytes and survive an updater backup',async t=>{
 const now={value:Date.now()};
 const h=await hub(t,{wikiAssets:{now:()=>now.value,maxBytes:5*MCP_CHUNK}});
 const writer=await h.account('wiki-author',['tickets:write']),other=await h.account('other-author',['tickets:write']);
 await rpc(h,writer,'setup',{project});
 const bytes=Buffer.from('fixture contents for a retry'),name='record.txt';
 const start=await rpc(h,writer,'upload_begin',{project,name,size:bytes.length,digest:sha(bytes)});
 const partial=bytes.subarray(0,10);
 const rawResult=await body(raw(h,writer,start.uploadId,0,partial),200);
 assert.equal(rawResult.nextOffset,10);
 const input={uploadId:start.uploadId,offset:0,data:partial.toString('base64')};
 await rpc(h,other,'upload_status',{uploadId:start.uploadId},'denied');
 await rpc(h,writer,'upload_chunk',{...input,data:Buffer.alloc(10).toString('base64')},'upload-offset');
 assert.equal((await rpc(h,writer,'upload_chunk',input)).nextOffset,10);
 const premature=await rpc(h,writer,'upload_finish',{uploadId:start.uploadId},'upload-offset');
 assert.equal(premature.nextOffset,10);
 await rpc(h,writer,'upload_chunk',{...input,offset:10,data:bytes.subarray(10).toString('base64')});
 const [finished,retried]=await Promise.all([1,2].map(()=>rpc(h,writer,'upload_finish',{uploadId:start.uploadId})));
 assert.equal(finished.assetId,retried.assetId);
 assert.equal((await rpc(h,writer,'upload_chunk',input)).nextOffset,bytes.length);
 await rpc(h,writer,'upload_begin',{project,name,size:6*MCP_CHUNK,digest:sha(bytes)},'disk-limit');
 const valid=(await rpc(h,writer,'upload_begin',{project,name:'invalid.png',size:bytes.length,digest:sha(bytes)})).uploadId;
 await body(raw(h,writer,valid,0,bytes),200);
 await rpc(h,writer,'upload_finish',{uploadId:valid},'invalid-media');
 const wrong=(await rpc(h,writer,'upload_begin',{project,name,size:bytes.length,digest:'a'.repeat(64)})).uploadId;
 await body(raw(h,writer,wrong,0,bytes),200);
 await rpc(h,writer,'upload_finish',{uploadId:wrong},'digest-mismatch');
 const external=glb({images:[{uri:'/api/private'}]});
 const unsafe=(await rpc(h,writer,'upload_begin',{project,name:'external.glb',size:external.length,digest:sha(external)})).uploadId;
 await body(raw(h,writer,unsafe,0,external),200);
 await rpc(h,writer,'upload_finish',{uploadId:unsafe},'invalid-media');
 const pending=await rpc(h,writer,'upload_begin',{project,name,size:bytes.length,digest:sha(bytes)});
 await body(raw(h,writer,pending.uploadId,0,partial),200);
 now.value+=UPLOAD_TTL+1;
 await h.handler.hub.state('wiki').assets.sweep();
 await rpc(h,writer,'upload_status',{uploadId:pending.uploadId},'upload-expired');
 now.value+=ASSET_GRACE;
 await h.handler.hub.state('wiki').assets.sweep();
 assert.equal((await get(h,finished.asset.url,writer.headers)).status,404);

 const {state,file,inst,ctx,journal}=await backupFixture(t);
 const root=path.join(state,'wiki'),db=openDb(file);
 const tickets=createTicketStore(path.join(state,'tickets'),{db,seedProjects:[{id:project,key:'GAME',name:'Sample Game',type:'game'}]});
 const wiki=createWikiStore(db,tickets),assets=createWikiAssets(db,root,wiki);
 const {home}=await wiki.setup({project},'alice');
 const session=await assets.begin({project,name,size:bytes.length,digest:sha(bytes)},'alice');
 await assets.chunk(session.uploadId,0,partial,'alice');
 db.close();
 const nextDb=openDb(file),nextWiki=createWikiStore(nextDb,createTicketStore(path.join(state,'tickets'),{db:nextDb}));
 const nextAssets=createWikiAssets(nextDb,root,nextWiki);
 assert.equal((await nextAssets.status(session.uploadId,'alice')).nextOffset,10);
 await nextAssets.chunk(session.uploadId,10,bytes.subarray(10),'alice');
 const {assetId}=await nextAssets.finish(session.uploadId,'alice');
 await nextWiki.update({project,id:home,rev:1,doc:doc({t:'attachments',id:'files',attachments:[{assetId}]})},'alice');
 nextDb.close();
 const backup=await createBackup(inst,ctx,'wiki-with-assets');
 await rm(root,{recursive:true,force:true});
 await restoreBackup(inst,ctx,backup,journal(backup));
 const restored=openDb(file);
 try{
  const restoredWiki=createWikiStore(restored,createTicketStore(path.join(state,'tickets'),{db:restored}));
  const restoredAssets=createWikiAssets(restored,root,restoredWiki);
  assert.equal((await restoredWiki.withAssets(await restoredWiki.get(project,home))).assets[0].id,assetId);
  const media=await restoredAssets.media(project,assetId,null);
  assert.deepEqual(await readFile(media.file),bytes);
 }finally{restored.close();}
});

test('wiki pins authorized LFS and Review bytes, with explicit destination audience and no provider secrets',async t=>{
 const h=await hub(t,{gitLfsTokenFile:path.join(await mkdtemp(path.join(os.tmpdir(),'wiki-lfs-token-')),'tokens.json')});
 t.after(()=>rm(path.dirname(h.handler.hub.state('git-lfs').store.files.tokenFile),{recursive:true,force:true}));
 const host=await gitHost(t),writer=await h.account('wiki-author',['tickets:write']),reader=await h.account('wiki-reader',[]);
 const repository='alice/media',file='screens/scout.png';
 host.addRepo(repository);
 const work=workTree(host,repository),first=work.commit({[file]:pointer(sha(png),png.length)});
 host.storeObject(repository,sha(png),png);
 work.push();
 const git=h.handler.hub.state('git-lfs').store;
 const connection=await git.save({provider:'gitea',name:'Fixture Git',baseUrl:host.origin,token:host.token,repoMode:'all'},'alice');
 const {pageId,rev}=await rpc(h,writer,'setup',{project});
 const source={kind:'lfs',connection:connection.id,repo:repository,ref:'main',path:file};
 await rpc(h,writer,'asset_import',{project,source},'denied');
 const grant={project,kind:'lfs',connection:connection.id,repo:repository,enabled:true};
 await body(h.post('/api/admin/wiki/sources',grant,writer.headers),403);
 assert.equal((await body(h.post('/api/admin/wiki/sources',grant,h.admin),200)).audience,'project-readers');
 const lfs=await rpc(h,writer,'asset_import',{project,source});
 assert.deepEqual(lfs.source,{kind:'lfs',connection:connection.id,repo:repository,commit:first,path:file,oid:sha(png)});
 assert.doesNotMatch(JSON.stringify(lfs),new RegExp(host.token));
 await rpc(h,writer,'asset_import',{project,source:{...source,path:'../../outside.png'}},'invalid-target');

 const changed=Buffer.concat([png,Buffer.from('new revision')]);
 work.commit({[file]:pointer(sha(changed),changed.length)});
 work.push();
 host.storeObject(repository,sha(changed),Buffer.from(changed).fill(0,changed.length-1));
 await rpc(h,writer,'asset_import',{project,source},'digest-mismatch');
 host.store.get(repository).get(sha(changed)).href='http://127.0.0.1:1/not-approved';
 await rpc(h,writer,'asset_import',{project,source},'unsafe-source');
 host.fail['/']=503;

 const reviewBytes=Buffer.from('RIFF\x24\0\0\0WAVEfmt ','latin1'),digest=sha(reviewBytes);
 const reviewHeaders={...h.admin,Origin:h.origin,'Content-Type':'application/octet-stream'};
 const stage=await fetch(`${h.origin}/api/review/blobs/${digest}?offset=0&size=${reviewBytes.length}`,{method:'PUT',headers:reviewHeaders,body:reviewBytes});
 assert.equal(stage.status,201);
 const review=await body(h.post('/api/review/publish',{project:'home-hub',title:'Scout recording',items:[
  {id:'voices',kind:'audio',title:'Voices',variants:[{id:'a',media:[{sha256:digest,type:'audio/wav',name:'scout.wav'}]}]},
 ]},h.admin),201);
 const reviewSource={kind:'review',set:review.id,round:1,item:'voices',variant:'a',media:0};
 await rpc(h,writer,'asset_import',{project,source:reviewSource},'denied');
 await body(h.post('/api/admin/wiki/sources',{project,kind:'review',set:review.id,enabled:true},h.admin),200);
 const copied=await rpc(h,writer,'asset_import',{project,source:reviewSource});
 assert.deepEqual(copied.source,{...reviewSource,project:'home-hub',digest});
 await rpc(h,writer,'page_save',{project,pageId,rev,doc:doc({t:'attachments',id:'pins',attachments:[
  {assetId:lfs.assetId},{assetId:copied.assetId},
 ]})});
 const original=await h.handler.hub.state('review').review.media(digest);
 await rm(original.file);
 for(const [asset,expected] of [[lfs,png],[copied,reviewBytes]]){
  const download=await get(h,asset.url,reader.headers);
  assert.equal(download.status,200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),expected);
 }
 await body(h.post('/api/admin/wiki/sources',{...grant,enabled:false},h.admin),200);
 await rpc(h,writer,'asset_import',{project,source},'denied');
});
