import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {hub} from './hub-helper.mjs';
import {wikiCollection,wikiKey} from '../server/wiki-store.mjs';
import {sanitizeWikiFilename} from '../server/wiki-assets.mjs';
import {grantMatches,isConnectionId} from '../server/wiki-sources.mjs';

const project='sample-game',otherProject='home-hub';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const docs=(...blocks)=>({v:1,blocks});
const file=(name,bytes)=>({name,size:bytes.length,digest:sha(bytes)});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN/cAAAAASUVORK5CYII=','base64');
const mp4=Buffer.concat([Buffer.from('\0\0\0\x14ftypisom\0\0\x02\0isom','latin1'),Buffer.alloc(98*1024)]);
function wave(){
 const header=Buffer.from('RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x40\x1f\0\0\x01\0\x08\0data\0\0\0\0','latin1');
 const audio=Buffer.alloc(384*1024,128);
 header.writeUInt32LE(header.length+audio.length-8,4);
 header.writeUInt32LE(audio.length,40);
 return Buffer.concat([header,audio]);
}
function glb(){
 const bytes=Buffer.alloc(512*1024);
 const source=JSON.stringify({asset:{version:'2.0'},buffers:[{byteLength:bytes.length}]});
 const json=Buffer.from(source.padEnd(Math.ceil(source.length/4)*4,' '));
 const header=Buffer.alloc(20),chunk=Buffer.alloc(8);
 header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(header.length+json.length+chunk.length+bytes.length,8);
 header.writeUInt32LE(json.length,12);header.write('JSON',16);
 chunk.writeUInt32LE(bytes.length);chunk.write('BIN',4);
 return Buffer.concat([header,json,chunk,bytes]);
}

async function rpc(h,actor,name,args,reason){
 const response=await h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',
  params:{name:'wiki_'+name,arguments:args}},actor.headers);
 const payload=await response.json();
 assert.equal(response.status,200);
 assert.equal(payload.result?.isError,Boolean(reason),JSON.stringify(payload));
 if(reason)assert.equal(payload.result.structuredContent.error.reason,reason);
 return payload.result;
}
const data=async (...args)=>(await rpc(...args)).structuredContent;

async function raw(h,actor,uploadId,offset,body){
 const response=await fetch(h.origin+`/api/wiki/uploads/${uploadId}?offset=${offset}`,{
  method:'PUT',headers:{...actor.headers,'Content-Type':'application/octet-stream'},body});
 assert.equal(response.status,200);
 return response.json();
}

test('wiki mixed-media manifest benchmark and lost-response recovery',async t=>{
 const h=await hub(t),legacy=await h.account('legacy-author',['tickets:write']),writer=await h.account('batch-author',['tickets:write']);
 const reader=await h.account('batch-reader',[]),foreign=await h.account('other-author',['tickets:write']);
 const reuser=await h.account('asset-reuser',['tickets:write']);
 const {pageId,rev}=await data(h,writer,'setup',{project});
 await data(h,writer,'setup',{project:otherProject});
 const fixtures=[['portrait.png',png],['brief.wav',wave()],['scout.glb',glb()],['clip.mp4',mp4]];
 const manifest={project,files:fixtures.map(([name,bytes])=>file(name,bytes))};
 const baseline=performance.now();
 let legacyCalls=0;
 for(const [name,bytes] of fixtures){
  const {uploadId,chunkSize}=await data(h,legacy,'upload_begin',{project,...file(name,bytes)});
  legacyCalls++;
  for(let offset=0;offset<bytes.length;offset+=chunkSize){
   const piece=bytes.subarray(offset,offset+chunkSize);
   await data(h,legacy,'upload_chunk',{uploadId,offset,data:piece.toString('base64')});
   legacyCalls++;
  }
  await data(h,legacy,'upload_finish',{uploadId});
  legacyCalls++;
 }
 const legacyMs=performance.now()-baseline;
 const fast=performance.now();
 const [plan,retry]=await Promise.all([data(h,writer,'upload_manifest',manifest),data(h,writer,'upload_manifest',manifest)]);
 assert.equal(plan.transport.http.maxBytes,8*1024*1024);
 assert.equal(plan.transport.mcp.maxBytes,32*1024);
 assert.deepEqual(new Set([...plan.files,...retry.files].map(part=>part.uploadId)).size,fixtures.length);
 assert.deepEqual(new Set([plan.files[0].state,retry.files[0].state]),new Set(['new','resumable']));
 const interrupted=plan.files[1];
 await raw(h,writer,interrupted.uploadId,0,fixtures[1][1].subarray(0,15000));
 const recovered=await data(h,writer,'upload_manifest',manifest);
 assert.equal(recovered.files[1].uploadId,interrupted.uploadId);
 assert.equal(recovered.files[1].nextOffset,15000);
 const finished=[];
 for(const [index,part] of recovered.files.entries()){
  const bytes=fixtures[index][1];
  await raw(h,writer,part.uploadId,part.nextOffset,bytes.subarray(part.nextOffset));
  const result=await data(h,writer,'upload_finish',{uploadId:part.uploadId});
  assert.equal(result.asset.digest,part.digest);
  finished.push(result.asset);
 }
 const fastMs=performance.now()-fast;
 const fastCalls=2+1+1+fixtures.length*2;
 assert.ok(fastCalls<legacyCalls);
 t.diagnostic(`Mixed media (${manifest.files.reduce((total,entry)=>total+entry.size,0)} bytes): legacy ${legacyCalls} calls / ${legacyMs.toFixed(1)} ms, manifest and raw HTTP ${fastCalls} calls including interrupted transfer and replays / ${fastMs.toFixed(1)} ms.`);
 const foreignPlan=await data(h,foreign,'upload_manifest',manifest);
 assert.equal(foreignPlan.files[1].state,'new');
 await raw(h,foreign,foreignPlan.files[0].uploadId,0,png.subarray(0,12));
 assert.equal((await data(h,writer,'upload_manifest',{...manifest,project:otherProject})).files[1].state,'new');
 await data(h,reader,'upload_manifest',manifest,'denied');
 assert.ok((await data(h,writer,'upload_manifest',manifest)).files.every(part=>part.state==='uploaded'));
 assert.deepEqual((await data(h,reader,'assets_list',{project})).assets,[]);
 await data(h,writer,'page_save',{project,pageId,rev,doc:docs({t:'attachments',id:'gallery',attachments:[{assetId:finished[0].id}]})});
 const reuseInput={project,files:[{...manifest.files[0],name:'renamed.png'}]};
 const rival=await data(h,foreign,'upload_manifest',reuseInput);
 assert.equal(rival.files[0].state,'resumable');
 assert.equal(rival.files[0].uploadId,foreignPlan.files[0].uploadId);
 assert.equal(rival.files[0].nextOffset,12);
 await raw(h,foreign,rival.files[0].uploadId,12,png.subarray(12));
 const foreignAsset=await data(h,foreign,'upload_finish',{uploadId:rival.files[0].uploadId});
 assert.equal((await data(h,foreign,'upload_manifest',reuseInput)).files[0].assetId,foreignAsset.assetId);
 const reused=await data(h,reuser,'upload_manifest',reuseInput);
 assert.deepEqual(reused.files[0],{name:'renamed.png',digest:finished[0].digest,state:'uploaded',assetId:finished[0].id});
 assert.deepEqual((await data(h,reader,'assets_list',{project,digest:finished[0].digest,type:'image/png',limit:1})).assets,[finished[0]]);
 assert.equal((await data(h,reader,'assets_list',{project:otherProject,digest:finished[0].digest})).total,0);

 const archiveMember={connection:'c1234567890',repo:'alice/media',commit:'b'.repeat(40),archivePath:'sets/units.zip',
  archiveOid:'c'.repeat(64),memberPath:'units/scout.glb',originalDigest:'d'.repeat(64)};
 const archivePlan=await data(h,writer,'upload_manifest',{project,files:[{...manifest.files[2],archiveMember}]});
 const [part]=archivePlan.files;
 assert.equal(part.state,'new');
 await raw(h,writer,part.uploadId,0,fixtures[2][1]);
 const archived=await data(h,writer,'upload_finish',{uploadId:part.uploadId});
 assert.deepEqual(archived.asset.source,{kind:'lfs-member',verification:'author-reported',...archiveMember});
 assert.equal((await data(h,writer,'assets_list',{project,sourceKind:'lfs-member',query:'units/scout'})).assets[0].id,archived.assetId);

 const capacity=await data(h,legacy,'upload_manifest',{project,files:Array.from({length:20},(_,index)=>file(`item-${index}.txt`,Buffer.from(String(index))))});
 assert.equal(capacity.files.filter(part=>part.state==='new').length,16);
 assert.equal(capacity.files.filter(part=>part.state==='deferred'&&part.reason==='upload-limit').length,4);
});

test('wiki manifests reserve the final project asset slot across writers',async t=>{
 const h=await hub(t),writer=await h.account('slot-author',['tickets:write']),other=await h.account('slot-guest',['tickets:write']);
 await data(h,writer,'setup',{project});
 const assets=Array.from({length:4999},(_,i)=>({id:'a'+i.toString(16).padStart(32,'0'),project,name:`file-${i}.bin`,
  digest:'a'.repeat(64),type:'application/octet-stream',size:1,references:1}));
 const store=wikiCollection(h.handler.hub.db);
 await store.change({assets:assets.map(asset=>wikiKey(project,asset.id))},data=>{data.assets=assets;});
 const input={project,files:[file('first.bin',Buffer.from('a')),file('second.bin',Buffer.from('b'))]};
 const initial=await data(h,writer,'upload_manifest',input);
 assert.deepEqual(initial.files.map(part=>[part.state,part.reason]),[['new',undefined],['deferred','asset-limit']]);
 const retry=await data(h,writer,'upload_manifest',input);
 assert.equal(retry.files[0].uploadId,initial.files[0].uploadId);
 assert.equal(retry.files[0].state,'resumable');
 const denied=await data(h,other,'upload_manifest',input);
 assert.ok(denied.files.every(part=>part.state==='deferred'&&part.reason==='asset-limit'));
});

test('wiki selective reads and concurrent cell patches on a 355-asset catalog',async t=>{
 const h=await hub(t),writer=await h.account('catalog-author',['tickets:write']);
 const other=await h.account('catalog-editor',['tickets:write']),reader=await h.account('catalog-reader',[]);
 const {pageId,rev}=await data(h,writer,'setup',{project});
 const assets=Array.from({length:355},(_,i)=>({id:'a'+i.toString(16).padStart(32,'0'),project,name:`scout-${i}.png`,
  digest:sha(String(i)),type:'image/png',size:512,owner:'api-key:'+writer.account.id,references:0,orphanedAt:Date.now()}));
 const store=wikiCollection(h.handler.hub.db);
 await store.change({assets:assets.map(asset=>wikiKey(project,asset.id))},data=>{data.assets=assets;});
 const rows=Array.from({length:10},(_,i)=>({id:`unit-${i}`,cells:{
  gallery:{attachments:assets.slice(i*35,i===9?355:(i+1)*35).map(asset=>({assetId:asset.id,caption:'Pinned inventory preview. '.repeat(10)}))},
  stats:{stats:[{name:'Health',value:10+i}]},
 }}));
 const doc=docs({t:'inventory',id:'units',columns:[{id:'stats',label:'Stats'},{id:'gallery',label:'Gallery'}],rows});
 const saved=await h.post('/api/wiki/pages/update',{project,id:pageId,rev,doc},writer.headers);
 assert.equal(saved.status,200);
 const full=await rpc(h,reader,'get',{project,pageId});
 assert.equal(full.structuredContent.assets.length,355);
 assert.ok(Buffer.byteLength(JSON.stringify(full))>350000);
 const summary=await rpc(h,reader,'get',{project,pageId,mode:'summary'});
 assert.equal(summary.structuredContent.assetCount,355);
 assert.deepEqual(summary.structuredContent.inventories,[{id:'units',rows:10,columns:2}]);
 assert.ok(Buffer.byteLength(JSON.stringify(summary))<1000);
 const selection={project,pageId,mode:'inventory',tableId:'units',rowIds:['unit-4','unit-5'],columnIds:['stats'],limit:1};
 const catalog=(await (await h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},reader.headers)).json()).result.tools;
 const schema=catalog.find(tool=>tool.name==='wiki_get').inputSchema;
 assert.equal(schema.if.properties.mode.const,'inventory');
 assert.equal(schema.then.properties.limit.maximum,20);
 await data(h,reader,'get',{...selection,limit:21},'invalid');
 const first=await rpc(h,reader,'get',selection);
 assert.deepEqual(first.structuredContent.rows,[{id:'unit-4',cells:{stats:{stats:[{name:'Health',value:14}]}}}]);
 assert.equal(first.structuredContent.nextOffset,1);
 assert.deepEqual(JSON.parse(first.content[0].text),first.structuredContent);
 assert.ok(Buffer.byteLength(JSON.stringify(first))<1200);
 assert.deepEqual((await data(h,reader,'get',{...selection,offset:1})).rows.map(row=>row.id),['unit-5']);
 const assetArgs={project,pageId,mode:'assets',offset:350,limit:4};
 const page=await data(h,reader,'get',assetArgs);
 assert.equal(page.total,355);
 assert.equal(page.rev,first.structuredContent.rev);
 assert.deepEqual(page.assets.map(asset=>asset.id),assets.slice(350,354).map(asset=>asset.id));
 assert.equal((await data(h,reader,'get',{...assetArgs,offset:354})).nextOffset,null);
 const cell={stats:[{name:'Health',value:700}]},patch={tableId:'units',rowId:'unit-4',cells:{stats:cell}};
 const args={project,pageId,rev:page.rev,patch};
 await data(h,reader,'page_save',args,'denied');
 const simultaneous=await Promise.all([writer,other].map((actor,i)=>h.post('/mcp',{jsonrpc:'2.0',id:i,
  method:'tools/call',params:{name:'wiki_page_save',arguments:{...args,patch:{...patch,rowId:`unit-${4+i}`}}}},actor.headers)
  .then(res=>res.json()).then(body=>body.result)));
 const winner=simultaneous.find(value=>!value.isError),loser=simultaneous.find(value=>value.isError);
 assert.equal(loser.structuredContent.error.reason,'conflict');
 assert.equal(loser.structuredContent.current.rev,winner.structuredContent.rev);
 assert.deepEqual(winner.structuredContent.patch.cells,{stats:cell});
 assert.equal(winner.structuredContent.doc,undefined);
 const after=await data(h,reader,'get',{...selection,limit:2});
 assert.equal(after.rows.filter(row=>row.cells.stats.stats[0].value===700).length,1);
 assert.equal((await data(h,reader,'get',{project,pageId,mode:'summary'})).assetCount,355);
 const removed=await data(h,writer,'page_save',{...args,rev:after.rev,patch:{...patch,cells:{stats:null}}});
 assert.deepEqual(removed.patch.cells,{stats:null});
});

test('wiki Review discovery and receipts preserve candidate decisions without promoting references',async t=>{
 const h=await hub(t),writer=await h.account('review-catalog-author',['tickets:write']),reader=await h.account('review-catalog-reader',[]);
 await data(h,writer,'setup',{project});
 const reviews=h.handler.hub.state('review').review;
 const variant=(id,title,reference=false)=>({id,title,reference,media:[{type:'text/html',html:`<p>${title}</p>`,caption:'Study render'}]});
 const item=(id,title,variants,mode)=>({id,title,variants,kind:'html',...(mode?{mode}:{})});
 const {id:set}=await reviews.publish({project:otherProject,title:'Game comparison',notes:'Round notes',items:[
  item('accept','Accepted design',[variant('a','Picked'),variant('b','Alternative')]),
  item('reject','Needs a redesign',[variant('a','Production baseline',true),variant('b','Candidate')]),
  item('pending','Awaiting feedback',[variant('a','Undecided')]),
  item('approvals','Independent approvals',[variant('a','Approved render'),variant('b','Pending render')],'approve'),
 ]},'alice');
 await reviews.feedback({set,round:1,item:'accept',rev:0,status:'accept',variant:'a',note:'Use as shown'},'alice');
 await reviews.feedback({set,round:1,item:'reject',rev:0,status:'reject',note:'Redesign requested'},'alice');
 await reviews.feedback({set,round:1,item:'approvals',rev:0,status:'pending',approvals:{a:'approved'},note:'One render is still pending'},'alice');
 assert.equal((await data(h,writer,'sources_list',{project})).total,0);
 await data(h,writer,'sources_list',{project,set,round:1},'source-not-granted');
 await data(h,reader,'sources_list',{project},'denied');
 await h.handler.hub.state('wiki').sources.setGrant({project,kind:'review',set,enabled:true});
 const rounds=await data(h,writer,'sources_list',{project,set});
 assert.deepEqual(rounds.items.map(({number,title,notes})=>({number,title,notes})),[{number:1,title:'Round 1',notes:'Round notes'}]);
 const args={project,set,round:1,limit:2};
 const accepted=await data(h,writer,'sources_list',args);
 assert.equal(accepted.audience,'project-readers');
 assert.deepEqual(accepted.items.map(item=>item.review.variant.status),['accepted','not-selected']);
 assert.equal(accepted.items[0].review.decision.note,'Use as shown');
 const rejected=await data(h,writer,'sources_list',{...args,offset:accepted.nextOffset});
 assert.deepEqual(rejected.items.map(item=>item.review.variant.status),['reference','rejected']);
 assert.ok(rejected.items.every(item=>item.review.decision.scope==='item'&&item.review.decision.variant===null));
 const pending=await data(h,writer,'sources_list',{...args,item:'pending'});
 assert.equal(pending.items[0].review.decision.scope,'unset');
 assert.equal(pending.items[0].review.variant.status,'pending');
 const approval=await data(h,writer,'sources_list',{...args,item:'approvals',variant:'b'});
 assert.equal(approval.items[0].review.variant.status,'pending');
 assert.equal(approval.items[0].review.decision.scope,'variants');
 assert.equal(approval.items[0].review.decision.variantApproval,null);
 for(const choice of rejected.items){
  const receipt=await data(h,writer,'asset_import',{project,source:choice.source});
  assert.deepEqual(receipt.review,choice.review);
  assert.equal(receipt.asset.digest,choice.digest);
  assert.match(receipt.captionSuggestion,/Redesign requested/);
  assert.equal(receipt.asset.review,undefined);
 }
});

test('atomic wiki_page_save patch enforces mentions, asset ref-counts and conflict inside one transaction',async t=>{
 const h=await hub(t),writer=await h.account('patch-author',['tickets:write']);
 const other=await h.account('patch-rival',['tickets:write']),reader=await h.account('patch-reader',[]);
 const localTicket=await (await h.post('/api/tickets',{project,title:'Local ticket'},h.admin)).json();
 const foreignTicket=await (await h.post('/api/tickets',{project:otherProject,title:'Foreign ticket'},h.admin)).json();
 const {pageId,rev:homeRev}=await data(h,writer,'setup',{project});
 async function stageAsset(actor,name,bytes){
  const {uploadId}=await data(h,actor,'upload_begin',{project,...file(name,bytes)});
  await raw(h,actor,uploadId,0,bytes);
  return (await data(h,actor,'upload_finish',{uploadId})).asset;
 }
 const assetA=await stageAsset(writer,'a.png',png);
 const assetB=await stageAsset(writer,'b.png',Buffer.concat([png,Buffer.from('b')]));
 const assetC=await stageAsset(writer,'c.png',Buffer.concat([png,Buffer.from('c')]));
 const assetD=await stageAsset(other,'d.png',Buffer.concat([png,Buffer.from('d')]));
 const foreignDraft=await stageAsset(other,'private.png',Buffer.concat([png,Buffer.from('p')]));
 const table={t:'inventory',id:'items',columns:[{id:'notes',label:'Notes'},{id:'gallery',label:'Gallery'}],
  rows:[{id:'row-1',cells:{gallery:{attachments:[{assetId:assetA.id}]}}}]};
 const init=await data(h,writer,'page_save',{project,pageId,rev:homeRev,doc:docs(table)});
 const store=wikiCollection(h.handler.hub.db);
 assert.equal((await store.get('assets',wikiKey(project,assetA.id))).references,1);

 // Mention guard rejects unshared foreign ticket in cell patch and leaves page unchanged.
 await data(h,writer,'page_save',{project,pageId,rev:init.rev,
  patch:{tableId:'items',rowId:'row-1',cells:{notes:{c:[{t:'ticket',id:foreignTicket.id}]}}}},'unavailable-reference');
 assert.equal((await h.handler.hub.state('wiki').wiki.get(project,pageId)).rev,init.rev);

 // Mention guard allows local ticket and updates backlinks atomically in one store.change without pre-reading pages or loading assets.
 const origGet=store.get,origChange=store.change;
 let pageGets=0,changes=0,selectionAssets=null;
 store.get=(coll,id)=>{if(coll==='pages')pageGets++;return origGet(coll,id);};
 store.change=(selection,fn,opts)=>{changes++;selectionAssets=selection.assets;return origChange(selection,fn,opts);};
 let patched;
 try{
  patched=await h.handler.hub.state('wiki').wiki.patch({project,id:pageId,rev:init.rev,
   patch:{tableId:'items',rowId:'row-1',cells:{notes:{c:[{t:'ticket',id:localTicket.id}]}}}},
   writer.account.username,'api-key:'+writer.account.id);
 }finally{store.get=origGet;store.change=origChange;}
 assert.equal(pageGets,0);
 assert.equal(changes,1);
 assert.equal(selectionAssets,undefined,'text-only patch does not select the assets collection');
 assert.deepEqual(patched.page.links,{tickets:[localTicket.id]});
 assert.equal((await (await fetch(h.origin+`/api/wiki/tickets/${localTicket.id}/backlinks`,{headers:reader.headers})).json()).pages[0].id,pageId);

 // Validation order matches prior behavior: conflict, not-found and invalid-target precede title validation,
 // and staged save checks upload expiry before rejecting extra fields.
 const staleWithBadTitle=await data(h,writer,'page_save',{project,pageId,rev:init.rev,title:'   ',
  patch:{tableId:'items',rowId:'row-1',cells:{notes:{c:[{t:'text',text:'stale'}]}}}},'conflict');
 assert.equal(staleWithBadTitle.current.rev,patched.page.rev);
 await data(h,writer,'page_save',{project,pageId:'wmissingpag2',rev:1,title:'   ',
  patch:{tableId:'items',rowId:'row-1',cells:{notes:{c:[{t:'text',text:'missing'}]}}}},'not-found');
 await data(h,writer,'page_save',{project,pageId,rev:patched.page.rev,title:'   ',
  patch:{tableId:'items',rowId:'no-such-row',cells:{notes:{c:[{t:'text',text:'bad row'}]}}}},'invalid-target');
 await assert.rejects(
  h.handler.hub.state('wiki').wiki.save({project,id:pageId,rev:patched.page.rev,
   documentUploadId:'u'+'0'.repeat(32),extraField:true},writer.account.username,'api-key:'+writer.account.id),
  {message:'upload-expired'},
 );
 // Column validation follows table column order (notes before gallery) regardless of request key order.
 await data(h,writer,'page_save',{project,pageId,rev:patched.page.rev,
  patch:{tableId:'items',rowId:'row-1',cells:{
   gallery:{c:[{t:'text',text:'x'.repeat(2001)}]},
   notes:{c:[{t:'bogus'}]},
  }}},'invalid');
 // Repeated mentions of a new ticket are deduplicated before reaching the mention guard.
 const localTicket2=await h.handler.hub.state('tracker').tickets.create({project,title:'Second local ticket',type:'task'},'alice');
 const repeated=Array.from({length:20},()=>({t:'ticket',id:localTicket2.id}));
 const refsState=h.handler.hub.state('references'),origGuard=refsState.prepareMentionGuard;
 let passedRefs=null;
 refsState.prepareMentionGuard=refs=>{passedRefs=refs;return origGuard(refs);};
 try{
  patched=await h.handler.hub.state('wiki').wiki.patch({project,id:pageId,rev:patched.page.rev,
   patch:{tableId:'items',rowId:'row-1',cells:{notes:{c:repeated}}}},
   writer.account.username,'api-key:'+writer.account.id);
 }finally{refsState.prepareMentionGuard=origGuard;}
 assert.deepEqual(passedRefs,[{kind:'ticket',id:localTicket2.id}],'repeated ticket mentions deduplicate before mentionGuard');

 // Asset visibility rejects another writer's private draft without mutating existing ref-counts.
 await data(h,writer,'page_save',{project,pageId,rev:patched.page.rev,
  patch:{tableId:'items',rowId:'row-1',cells:{gallery:{attachments:[{assetId:foreignDraft.id}]}}}},'invalid-asset');
 assert.equal((await store.get('assets',wikiKey(project,assetA.id))).references,1);
 assert.equal((await store.get('assets',wikiKey(project,foreignDraft.id))).references,0);

 // Swapping attachment in a patch publishes the new asset and orphans the removed one.
 const swapped=await data(h,writer,'page_save',{project,pageId,rev:patched.page.rev,
  patch:{tableId:'items',rowId:'row-1',cells:{gallery:{attachments:[{assetId:assetB.id}]}}}});
 assert.equal((await store.get('assets',wikiKey(project,assetB.id))).references,1);
 assert.equal((await store.get('assets',wikiKey(project,assetA.id))).references,0);
 assert.ok((await store.get('assets',wikiKey(project,assetA.id))).orphanedAt);
 assert.equal((await fetch(h.origin+assetB.url,{headers:reader.headers})).status,200);
 assert.equal((await fetch(h.origin+assetA.url,{headers:reader.headers})).status,404);

 // Concurrent cell patch vs HTTP page update: one succeeds, one fails with conflict (409 / WIKI_CONFLICT), zero dropped ref-counts.
 const rivalDoc=docs({t:'inventory',id:'items',columns:table.columns,
  rows:[{id:'row-1',cells:{gallery:{attachments:[{assetId:assetD.id}]}}}]});
 const [mcpRes,httpRes]=await Promise.all([
  h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wiki_page_save',arguments:{
   project,pageId,rev:swapped.rev,patch:{tableId:'items',rowId:'row-1',cells:{gallery:{attachments:[{assetId:assetC.id}]}}},
  }}},writer.headers).then(r=>r.json()).then(body=>body.result),
  h.post('/api/wiki/pages/update',{project,id:pageId,rev:swapped.rev,doc:rivalDoc},other.headers)
   .then(async r=>({status:r.status,body:await r.json()})),
 ]);
 const mcpWon=!mcpRes.isError,httpWon=httpRes.status===200;
 assert.notEqual(mcpWon,httpWon);
 if(mcpWon){
  assert.equal(httpRes.status,409);
  assert.equal(httpRes.body.error.reason,'conflict');
  assert.equal(httpRes.body.current.rev,mcpRes.structuredContent.rev);
 }else{
  assert.equal(mcpRes.structuredContent.error.code,'WIKI_CONFLICT');
  assert.equal(mcpRes.structuredContent.error.reason,'conflict');
  assert.equal(mcpRes.structuredContent.current.rev,httpRes.body.rev);
 }
 const winnerAsset=mcpWon?assetC:assetD,loserAsset=mcpWon?assetD:assetC;
 assert.equal((await store.get('assets',wikiKey(project,winnerAsset.id))).references,1);
 assert.equal((await store.get('assets',wikiKey(project,loserAsset.id))).references,0);
 assert.equal((await store.get('assets',wikiKey(project,assetB.id))).references,0);
 assert.equal((await fetch(h.origin+winnerAsset.url,{headers:reader.headers})).status,200);
 assert.equal((await fetch(h.origin+loserAsset.url,{headers:reader.headers})).status,404);
});

test('wiki_get mode=assets returns paged metadata without mutating or fabricating docs and respects asset visibility',async t=>{
 const h=await hub(t),writer=await h.account('assets-author',['tickets:write']),reader=await h.account('assets-reader',[]);
 const {pageId,rev}=await data(h,writer,'setup',{project});
 async function stageAsset(name,bytes){
  const {uploadId}=await data(h,writer,'upload_begin',{project,...file(name,bytes)});
  await raw(h,writer,uploadId,0,bytes);
  return (await data(h,writer,'upload_finish',{uploadId})).asset;
 }
 const attached=[];
 for(let i=0;i<5;i++)attached.push(await stageAsset(`frame-${i}.png`,Buffer.concat([png,Buffer.from([i])])));
 const privateDraft=await stageAsset('unattached-draft.png',Buffer.concat([png,Buffer.from('draft')]));
 const pageDoc=docs(
  {t:'attachments',id:'lead',attachments:attached.slice(0,2).map(a=>({assetId:a.id}))},
  {t:'inventory',id:'units',columns:[{id:'art',label:'Art'}],
   rows:[{id:'r1',cells:{art:{attachments:attached.slice(2).map(a=>({assetId:a.id}))}}}]},
 );
 await data(h,writer,'page_save',{project,pageId,rev,doc:pageDoc});

 // Pagination cursor/offset walk and visibility rules.
 const seen=[];
 for(let offset=0;offset!==null;){
  const slice=await data(h,reader,'get',{project,pageId,mode:'assets',offset,limit:2});
  assert.equal(slice.mode,'assets');
  assert.equal(slice.doc,undefined);
  assert.equal(slice.total,5);
  assert.equal(slice.offset,offset);
  assert.equal(slice.limit,2);
  seen.push(...slice.assets);
  offset=slice.nextOffset;
 }
 assert.deepEqual(seen,attached);
 assert.ok(!seen.some(asset=>asset.id===privateDraft.id));
 assert.equal((await fetch(h.origin+privateDraft.url,{headers:reader.headers})).status,404);
 assert.equal((await fetch(h.origin+attached[0].url,{headers:reader.headers})).status,200);
 const pastEnd=await data(h,reader,'get',{project,pageId,mode:'assets',offset:10,limit:2});
 assert.deepEqual(pastEnd.assets,[]);
 assert.equal(pastEnd.nextOffset,null);
 await data(h,reader,'get',{project,pageId,mode:'assets',tableId:'units'},'invalid');

 // Direct store.read(page, {mode:'assets'}) never mutates page or fabricates a fake doc.
 const wiki=h.handler.hub.state('wiki').wiki;
 const stored=await wiki.get(project,pageId);
 const beforeJson=JSON.stringify(stored);
 Object.freeze(stored);
 Object.freeze(stored.doc);
 Object.freeze(stored.doc.blocks);
 const direct=await wiki.read(stored,{mode:'assets',offset:1,limit:2});
 assert.equal(JSON.stringify(stored),beforeJson);
 assert.deepEqual(direct,{total:5,offset:1,limit:2,nextOffset:3,assets:attached.slice(1,3)});
});

test('wiki authoring module is folded, HTTP-to-MCP inversion is removed, and shared seams validate cleanly',()=>{
 assert.equal(existsSync(new URL('../server/wiki-authoring.mjs',import.meta.url)),false);
 const coreWiki=readFileSync(new URL('../server/core/wiki.mjs',import.meta.url),'utf8');
 const mcpImports=[...coreWiki.matchAll(/import\s+([^;]+?)\s+from\s+['"]\.\.\/wiki-mcp\.mjs['"]/g)];
 assert.equal(mcpImports.length,1);
 assert.equal(mcpImports[0][1].replace(/\s+/g,''),'{wikiTools}');

 assert.equal(isConnectionId('c0123456789'),true);
 assert.equal(isConnectionId('c012345678'),false);
 assert.equal(sanitizeWikiFilename('dir/bad\x00name.png','fallback.png'),'dir_bad_name.png');
 assert.equal(sanitizeWikiFilename('..','fallback.png'),'fallback.png');
 const lfsGrant={key:'sample-game/lfs/c0123456789/alice/media',project:'sample-game',kind:'lfs',
  connection:'c0123456789',repo:'alice/media',identity:'id-1',downloadOrigin:'https://cdn.example.com'};
 const reordered={downloadOrigin:'https://cdn.example.com',identity:'id-1',repo:'alice/media',
  connection:'c0123456789',kind:'lfs',project:'sample-game',key:lfsGrant.key};
 assert.equal(grantMatches(reordered,lfsGrant),true);
 assert.equal(grantMatches({...lfsGrant,identity:'id-2'},lfsGrant),false);
 assert.equal(grantMatches({...lfsGrant,extra:true},lfsGrant),false);
 assert.equal(grantMatches({...lfsGrant,downloadOrigin:undefined},lfsGrant),false);
 const noOrigin={key:lfsGrant.key,project:'sample-game',kind:'lfs',connection:'c0123456789',repo:'alice/media',identity:'id-1'};
 assert.equal(grantMatches({...noOrigin,downloadOrigin:null},noOrigin),false);
 assert.equal(grantMatches({...noOrigin,downloadOrigin:undefined},noOrigin),false);
 assert.equal(grantMatches(undefined,lfsGrant),false);
 const reviewGrant={key:'sample-game/review/R-1',project:'sample-game',kind:'review',set:'R-1'};
 assert.equal(grantMatches({...reviewGrant},reviewGrant),true);
 assert.equal(grantMatches({...reviewGrant,set:'R-2'},reviewGrant),false);
 assert.equal(grantMatches({...reviewGrant,extra:'x'},reviewGrant),false);

 // Wiki modules form a clean acyclic graph: store <- assets <- sources (no mutual imports).
 const storeSrc=readFileSync(new URL('../server/wiki-store.mjs',import.meta.url),'utf8');
 const assetsSrc=readFileSync(new URL('../server/wiki-assets.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(storeSrc,/from\s+['"]\.\/wiki-(assets|sources)\.mjs['"]/);
 assert.doesNotMatch(assetsSrc,/from\s+['"]\.\/wiki-sources\.mjs['"]/);
});
