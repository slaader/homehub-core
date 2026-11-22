import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {hub} from './hub-helper.mjs';
import {openDb} from '../server/db.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createWikiStore,WIKI_SCHEMA,wikiCollection,wikiKey} from '../server/wiki-store.mjs';
import {createWikiAssets} from '../server/wiki-assets.mjs';
import {createReviewStore} from '../server/review-store.mjs';
import {createReferences,planReferencePromotion} from '../server/references.mjs';
import {referenceHref,referenceKinds,referenceToken,validReference} from '../public/reference-format.js';
import {markdownReferences} from '../public/tracker-markdown-format.js';
import {extractLinks,normalizeDoc} from '../public/wiki-doc.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN/cAAAAASUVORK5CYII=','base64');
const HTML='<!doctype html><html><head><title>A</title></head><body><button data-mock-id="cta">Go</button></body></html>';
const htmlItem=(id='login',label='Go')=>({id,title:'Login',kind:'html',variants:[{id:'a',title:'Var a',media:[{type:'text/html',html:HTML.replace('Go',label)}]}]});
const doc=(...blocks)=>({v:1,blocks});
const para=(...c)=>({t:'p',c});

async function json(res,status){
 res=await res;
 const body=await res.json();
 assert.equal(res.status,status,JSON.stringify(body));
 return body;
}

async function rpc(h,headers,name,args){
 const res=await h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},headers);
 assert.equal(res.status,200);
 return (await res.json()).result;
}

// Simulates Lane A's db.changeCollections([{store,selection},...], fn, {durable:true}) over hub.db
// to verify our .lifecycle adapters execute and roll back atomically inside one SQLite transaction.
async function runMultiCollectionTx(db,entries,fn,{durable=true}={}){
 for(const {store} of entries)await store.version();
 const exec=()=>{
  db.db.exec('BEGIN IMMEDIATE');
  try{
   const states=entries.map(({store,selection})=>{
    const kind=store.kind;
    const metaRow=db.db.prepare('SELECT doc FROM meta WHERE kind=?').get(kind);
    const meta=JSON.parse(metaRow.doc);
    const colls={},previous=new Map();
    for(const [coll,ids] of Object.entries(selection)){
     const rows=ids===null
      ?db.db.prepare('SELECT id,doc FROM docs WHERE kind=? AND coll=? ORDER BY rowid').all(kind,coll)
      :typeof ids==='string'
       ?db.db.prepare('SELECT id,doc FROM docs WHERE kind=? AND coll=? AND id>=? AND id<? ORDER BY id').all(kind,coll,ids,ids+'\uffff')
       :[...new Set(ids)].flatMap(id=>{
        const r=db.db.prepare('SELECT doc FROM docs WHERE kind=? AND coll=? AND id=?').get(kind,coll,id);
        return r?[{id,doc:r.doc}]:[];
       });
     colls[coll]=rows.map(r=>{previous.set(coll+'\u0000'+r.id,r.doc);return [r.id,JSON.parse(r.doc)];});
    }
    const data=store.join(meta,colls);
    return {store,selection,previous,data};
   });
   const result=fn(states.map(s=>s.data));
   const putMeta=db.db.prepare('INSERT INTO meta(kind,doc) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET doc=excluded.doc');
   const putDoc=db.db.prepare('INSERT INTO docs(kind,coll,id,doc) VALUES(?,?,?,?) ON CONFLICT(kind,coll,id) DO UPDATE SET doc=excluded.doc');
   const delDoc=db.db.prepare('DELETE FROM docs WHERE kind=? AND coll=? AND id=?');
   const unindex=db.db.prepare('DELETE FROM search WHERE kind=? AND id=?');
   const index=db.db.prepare('INSERT INTO search(kind,id,project,updated,title,body) VALUES(?,?,?,?,?,?)');
   for(const {store,selection,previous,data} of states){
    const {meta,colls}=store.split(data),next=new Map();
    for(const [coll,rows] of Object.entries(colls))if(Object.hasOwn(selection,coll))for(const [id,d] of rows)next.set(coll+'\u0000'+id,{coll,id,doc:d,json:JSON.stringify(d)});
    putMeta.run(store.kind,JSON.stringify(meta));
    for(const [key,r] of next)if(previous.get(key)!==r.json){
     putDoc.run(store.kind,r.coll,r.id,r.json);
     const e=store.search?.(r.coll,r.doc);
     if(e){unindex.run(e.kind,e.id);index.run(e.kind,e.id,e.project??null,e.updated??null,e.title??'',e.body??'');}
    }
    for(const key of previous.keys())if(!next.has(key)){
     const [coll,id]=key.split('\u0000');
     delDoc.run(store.kind,coll,id);
    }
   }
   db.db.exec('COMMIT');
   return result;
  }catch(e){
   try{db.db.exec('ROLLBACK');}catch{}
   throw e;
  }
 };
 if(!durable)return exec();
 db.db.exec('PRAGMA synchronous=FULL');
 try{return exec();}finally{db.db.exec('PRAGMA synchronous=NORMAL');}
}

test('reference-format and wiki-doc support kind epic alongside backwards-compatible ticket mentions',()=>{
 assert.ok(referenceKinds.includes('epic'));
 assert.equal(validReference('epic','APP-E1'),true);
 assert.equal(validReference('epic','GAME2-E42'),true);
 assert.equal(validReference('epic','APP-1'),false);
 assert.equal(validReference('epic','APP-E0'),false);
 assert.equal(validReference('ticket','APP-E1'),false);
 assert.equal(referenceHref('epic','APP-E1'),'#epics/APP-E1');
 const token=referenceToken({kind:'epic',id:'APP-E1',label:'Combat [v2]'});
 assert.equal(token,'@[Combat \\[v2\\]](ref:epic/APP-E1)');
 const parsed=markdownReferences(`See ${token} and APP-12`,{keys:['APP']});
 assert.deepEqual(parsed.map(r=>[r.kind,r.id,r.label]),[['epic','APP-E1','Combat [v2]'],['ticket','APP-12','APP-12']]);
 const normalized=normalizeDoc(doc(para(
  {t:'ref',kind:'epic',id:'APP-E1',label:'Combat v2'},
  {t:'text',text:' and '},
  {t:'ticket',id:'APP-12'},
 )));
 assert.deepEqual(extractLinks(normalized),{tickets:['APP-12'],refs:[{kind:'epic',id:'APP-E1'}]});
 assert.throws(()=>normalizeDoc(doc(para({t:'ref',kind:'epic',id:'APP-1',label:'Not an epic'}))),/invalid/);
});

test('wiki spaces: standalone create/rename/attach/delete, immutable space id, settings.wiki visibility and orphan cleanup',async t=>{
 const h=await hub(t);
 const writer=await h.account('space-writer',['tickets:write']);
 const reader=await h.account('space-reader',['read']);
 const reviewWriter=await h.account('rev-writer',['review:write']);

 // Rejects read-only, reserved IDs, and colliding with existing tracker project ID.
 await json(h.post('/api/wiki/spaces',{id:'handbook',name:'Handbook'},reader.headers),403);
 await json(h.post('/api/wiki/spaces',{id:'spaces',name:'Reserved'},writer.headers),400);
 await json(h.post('/api/wiki/spaces',{id:'uploads',name:'Reserved'},writer.headers),400);
 await json(h.post('/api/wiki/spaces',{id:'home-hub',name:'Shadow'},writer.headers),409);

 // Create standalone space via HTTP POST /api/wiki/spaces.
 const created=await json(h.post('/api/wiki/spaces',{id:'handbook',name:'Team Handbook',create:true},writer.headers),201);
 assert.equal(created.id,'handbook');
 assert.equal(created.name,'Team Handbook');
 assert.equal(created.projectId,null);
 assert.equal(created.count,1);
 assert.equal(created.created,true);

 // Duplicate create intent conflicts.
 await json(h.post('/api/wiki/spaces',{id:'handbook',name:'Other',create:true},writer.headers),409);

 // Root page is titled "<Name> Home".
 const homePage=await json(fetch(h.origin+`/api/wiki/handbook/pages/${created.home}`,{headers:reader.headers}),200);
 assert.equal(homePage.title,'Team Handbook Home');
 assert.equal(homePage.project,'handbook');

 // Rename standalone space updates space name AND unchanged default root title.
 const renamed=await json(h.post('/api/wiki/spaces',{id:'handbook',name:'Ops Handbook'},writer.headers),200);
 assert.equal(renamed.name,'Ops Handbook');
 const homeAfterRename=await json(fetch(h.origin+`/api/wiki/handbook/pages/${created.home}`,{headers:reader.headers}),200);
 assert.equal(homeAfterRename.title,'Ops Handbook Home');
 assert.equal(homeAfterRename.rev,2);

 // Manually renamed root page stays untouched on subsequent space rename.
 await json(h.post('/api/wiki/pages/update',{project:'handbook',id:created.home,rev:2,title:'Custom Landing'},writer.headers),200);
 await json(h.post('/api/wiki/spaces',{id:'handbook',name:'Final Handbook'},writer.headers),200);
 assert.equal((await json(fetch(h.origin+`/api/wiki/handbook/pages/${created.home}`,{headers:reader.headers}),200)).title,'Custom Landing');

 // Standalone mention visibility: allows own/global/project refs, blocks unshared project tickets.
 const localTicket=await json(h.post('/api/tickets',{project:'home-hub',title:'Private ticket'},writer.headers),201);
 await json(h.post('/api/wiki/pages',{project:'handbook',title:'Bad mention',doc:doc(para({t:'ticket',id:localTicket.id}))},writer.headers),400);
 const child=await json(h.post('/api/wiki/pages',{project:'handbook',title:'Subpage',doc:doc(para(
  {t:'ref',kind:'wiki',id:'handbook/'+created.home,label:'Landing'},
  {t:'ref',kind:'project',id:'home-hub',label:'Home Hub'},
 ))},writer.headers),201);
 assert.equal(child.project,'handbook');

 // Standalone import eligibility: no implicit review sets; explicit grant required.
 const revSet=await json(h.post('/api/review/publish',{project:'home-hub',title:'Mockup',items:[htmlItem()]},reviewWriter.headers),201);
 const sourcesBefore=await json(fetch(h.origin+'/api/wiki/handbook/sources',{headers:writer.headers}),200);
 assert.deepEqual(sourcesBefore.reviewSets,[]);
 await json(h.post('/api/wiki/assets/import',{project:'handbook',source:{kind:'review',set:revSet.id,round:1,item:'login',variant:'a',media:0}},writer.headers),403);
 await json(h.post('/api/admin/wiki/sources',{project:'handbook',kind:'review',set:revSet.id,enabled:true},h.admin),200);
 const imported=await json(h.post('/api/wiki/assets/import',{project:'handbook',source:{kind:'review',set:revSet.id,round:1,item:'login',variant:'a',media:0}},writer.headers),201);
 assert.equal(imported.asset.project,'handbook');

 // Attach standalone space to 'home-hub': space ID stays immutable ('handbook'), projectId becomes 'home-hub'.
 const attached=await json(h.post('/api/wiki/spaces',{id:'handbook',projectId:'home-hub'},writer.headers),200);
 assert.equal(attached.id,'handbook');
 assert.equal(attached.projectId,'home-hub');
 assert.equal(attached.name,'Home Hub');

 // Attaching another space to a project that already has a wiki conflicts.
 const extra=await json(h.post('/api/wiki/spaces',{id:'extra-notes',name:'Extra Notes',create:true},writer.headers),201);
 await json(h.post('/api/wiki/spaces',{id:'extra-notes',projectId:'home-hub'},writer.headers),409);

 // Direct rename or standalone delete of a project-linked space is refused.
 await json(h.post('/api/wiki/spaces',{id:'handbook',name:'Illegal rename'},writer.headers),400);
 await json(h.post('/api/wiki/spaces/delete',{id:'handbook'},writer.headers),409);

 // projectId lookup finds attached space; page reads require immutable space id ('handbook'), not 'home-hub'.
 const byProject=await json(fetch(h.origin+'/api/wiki/home-hub',{headers:reader.headers}),200);
 assert.equal(byProject.enabled,true);
 assert.equal(byProject.id,'handbook');
 assert.equal(byProject.projectId,'home-hub');
 assert.equal(byProject.home,created.home);
 await json(fetch(h.origin+`/api/wiki/home-hub/pages/${created.home}`,{headers:reader.headers}),404);
 await json(fetch(h.origin+`/api/wiki/handbook/pages/${created.home}`,{headers:reader.headers}),200);

 // Now that 'handbook' is linked to 'home-hub', mentioning 'home-hub' ticket succeeds!
 const linkedMention=await json(h.post('/api/wiki/pages',{project:'handbook',title:'Linked',doc:doc(para({t:'ticket',id:localTicket.id}))},writer.headers),201);
 assert.deepEqual(linkedMention.links.tickets,[localTicket.id]);

 // GET /api/wiki returns legacy projects + spaces, and respects settings.wiki = false while keeping direct reads working.
 const indexBefore=await json(fetch(h.origin+'/api/wiki',{headers:reader.headers}),200);
 assert.deepEqual(indexBefore.projects,[{id:'home-hub',name:'Home Hub',home:created.home}]);
 assert.deepEqual(indexBefore.spaces.map(s=>s.id).sort(),['extra-notes','handbook']);

 const projList=(await json(fetch(h.origin+'/api/tickets',{headers:reader.headers}),200)).projects;
 const hh=projList.find(p=>p.id==='home-hub');
 await json(h.post('/api/tickets/projects',{id:'home-hub',rev:hh.rev,settings:{wiki:false}},writer.headers),200);

 const indexHidden=await json(fetch(h.origin+'/api/wiki',{headers:reader.headers}),200);
 assert.deepEqual(indexHidden.projects,indexBefore.projects,'legacy project index stays readable');
 assert.deepEqual(indexHidden.spaces.map(s=>s.id),['extra-notes']);
 const indexAll=await json(fetch(h.origin+'/api/wiki?includeHidden=1',{headers:reader.headers}),200);
 assert.equal(indexAll.spaces.find(s=>s.id==='handbook').visible,false);
 assert.equal(indexAll.spaces.find(s=>s.id==='extra-notes').visible,true);
 // Direct reads still work when settings.wiki === false!
 assert.equal((await json(fetch(h.origin+'/api/wiki/handbook',{headers:reader.headers}),200)).enabled,true);
 assert.equal((await json(fetch(h.origin+`/api/wiki/handbook/pages/${created.home}`,{headers:reader.headers}),200)).id,created.home);

 // Upload shared blob in both 'handbook' and 'extra-notes', plus unique blob in 'extra-notes'.
 const sharedBytes=PNG,uniqueBytes=Buffer.concat([PNG,Buffer.from('unique')]);
 async function uploadAsset(spaceId,name,bytes){
  const u=await json(h.post('/api/wiki/uploads',{project:spaceId,name,size:bytes.length,digest:sha(bytes)},writer.headers),201);
  await json(fetch(h.origin+`/api/wiki/uploads/${u.uploadId}?offset=0`,{method:'PUT',headers:{...writer.headers,'Content-Type':'application/octet-stream'},body:bytes}),200);
  return (await json(h.post('/api/wiki/uploads/finish',{uploadId:u.uploadId},writer.headers),200)).asset;
 }
 const sharedInHandbook=await uploadAsset('handbook','shared.png',sharedBytes);
 const sharedInExtra=await uploadAsset('extra-notes','shared.png',sharedBytes);
 const uniqueInExtra=await uploadAsset('extra-notes','unique.png',uniqueBytes);
 // Also start an unfinished upload in 'extra-notes' to ensure staging file cleanup.
 const pending=await json(h.post('/api/wiki/uploads',{project:'extra-notes',name:'pending.bin',size:10,digest:sha(Buffer.alloc(10))},writer.headers),201);
 await json(fetch(h.origin+`/api/wiki/uploads/${pending.uploadId}?offset=0`,{method:'PUT',headers:{...writer.headers,'Content-Type':'application/octet-stream'},body:Buffer.alloc(4)}),200);

 const wikiRoot=path.join(h.handler.hub.stateDirectory,'wiki');
 assert.equal(existsSync(path.join(wikiRoot,'blobs',sha(sharedBytes))),true);
 assert.equal(existsSync(path.join(wikiRoot,'blobs',sha(uniqueBytes))),true);
 assert.equal(existsSync(path.join(wikiRoot,'uploads',pending.uploadId)),true);

 // Delete standalone space 'extra-notes' via MCP wiki_space_delete.
 const delMcp=await rpc(h,writer.headers,'wiki_space_delete',{id:'extra-notes'});
 assert.equal(delMcp.isError,false);
 assert.equal(delMcp.structuredContent.deleted,true);
 assert.equal(delMcp.structuredContent.removedPages,1);
 assert.equal(delMcp.structuredContent.removedAssets,2);

 // Unique blob and staged upload are removed from disk; shared blob stays intact for 'handbook'!
 assert.equal(existsSync(path.join(wikiRoot,'blobs',sha(uniqueBytes))),false);
 assert.equal(existsSync(path.join(wikiRoot,'uploads',pending.uploadId)),false);
 assert.equal(existsSync(path.join(wikiRoot,'blobs',sha(sharedBytes))),true);
 assert.equal((await fetch(h.origin+sharedInHandbook.url,{headers:writer.headers})).status,200);
 assert.equal((await fetch(h.origin+sharedInExtra.url,{headers:writer.headers})).status,404);
 assert.equal((await fetch(h.origin+uniqueInExtra.url,{headers:writer.headers})).status,404);

 // MCP wiki_spaces_list, wiki_space_create, wiki_space_update work end-to-end.
 const mcpList=await rpc(h,reader.headers,'wiki_spaces_list',{});
 assert.equal(mcpList.isError,false);
 assert.equal(mcpList.structuredContent.spaces.length,1);
 assert.equal(mcpList.structuredContent.spaces[0].visible,false);
 const mcpCreate=await rpc(h,writer.headers,'wiki_space_create',{id:'mcp-space',name:'MCP Space'});
 assert.equal(mcpCreate.isError,false);
 assert.equal(mcpCreate.structuredContent.id,'mcp-space');
 const mcpUpdate=await rpc(h,writer.headers,'wiki_space_update',{id:'mcp-space',name:'MCP Renamed'});
 assert.equal(mcpUpdate.isError,false);
 assert.equal(mcpUpdate.structuredContent.name,'MCP Renamed');
});

test('review detached sets: explicit detached=true filter preserves project=none, blocks writes, supports delete and reassign',async t=>{
 const h=await hub(t);
 const writer=await h.account('rev-writer',['review:write']);
 const reader=await h.account('rev-reader',['read']);
 const tkWriter=await h.account('tk-writer',['tickets:write']);

 // Create a real project with slug 'none' to verify project=none is NEVER conflated with detached!
 await json(h.post('/api/tickets/projects',{id:'none',key:'NONE',name:'Project Named None',type:'app'},tkWriter.headers),201);
 const tkOld=await json(h.post('/api/tickets',{project:'home-hub',title:'Old ticket'},tkWriter.headers),201);
 const tkTarget=await json(h.post('/api/tickets',{project:'sample-game',title:'Target ticket'},tkWriter.headers),201);

 // Upload a shared image blob and a unique image blob.
 const sharedImg=PNG,uniqueImg=Buffer.concat([PNG,Buffer.from('unique-rev')]);
 for(const buf of [sharedImg,uniqueImg]){
  const res=await fetch(`${h.origin}/api/review/blobs/${sha(buf)}?offset=0&size=${buf.length}`,{
   method:'PUT',headers:{...writer.headers,'Content-Type':'application/octet-stream'},body:buf,
  });
  assert.equal(res.status,201);
 }

 const setNone=await json(h.post('/api/review/publish',{project:'none',title:'None project set',items:[{id:'img',title:'Img',kind:'image',variants:[{id:'a',media:[{sha256:sha(sharedImg),type:'image/png'}]}]}]},writer.headers),201);
 const setDetached1=await json(h.post('/api/review/publish',{project:'home-hub',title:'Will detach 1',tickets:[tkOld.id],items:[
  {id:'img',title:'Img',kind:'image',variants:[{id:'a',media:[{sha256:sha(sharedImg),type:'image/png'},{sha256:sha(uniqueImg),type:'image/png'}]}]},
  htmlItem('login','A'),
 ]},writer.headers),201);
 const setDetached2=await json(h.post('/api/review/publish',{project:'home-hub',title:'Will detach 2',tickets:[tkOld.id],items:[htmlItem('login','B')]},writer.headers),201);

 // Project deletion detaches the Review sets and keeps their historical ticket IDs.
 const preview=await json(fetch(h.origin+'/api/tickets/projects/home-hub/delete-preview',{headers:tkWriter.headers}),200);
 assert.equal(preview.counts.reviewSets,2);
 await json(h.post('/api/tickets/projects/delete',{
  id:'home-hub',rev:preview.rev,confirmation:'HH',snapshot:preview.snapshot,
 },tkWriter.headers),200);

 // Filter checks: project=none returns ONLY project 'none'; detached=true returns ONLY detached sets; both together -> 400.
 const onlyNone=await json(fetch(h.origin+'/api/review?project=none',{headers:reader.headers}),200);
 assert.deepEqual(onlyNone.sets.map(s=>s.id),[setNone.id]);
 assert.equal(onlyNone.detachedCount,2);

 const onlyDetached=await json(fetch(h.origin+'/api/review?detached=true',{headers:reader.headers}),200);
 assert.deepEqual(onlyDetached.sets.map(s=>s.id).sort(),[setDetached1.id,setDetached2.id]);
 assert.equal(onlyDetached.sets[0].detached,true);
 assert.equal(onlyDetached.sets[0].detachedProjectName,'Home Hub');
 assert.equal(onlyDetached.sets[0].project,null);

 const excludeDetached=await json(fetch(h.origin+'/api/review?detached=false',{headers:reader.headers}),200);
 assert.deepEqual(excludeDetached.sets.map(s=>s.id),[setNone.id]);

 await json(fetch(h.origin+'/api/review?project=none&detached=true',{headers:reader.headers}),400);

 // MCP review_list detached filter parity + review_get preserves historical tickets and detached metadata.
 const mcpDetached=await rpc(h,reader.headers,'review_list',{detached:true});
 assert.equal(mcpDetached.isError,false);
 assert.deepEqual(mcpDetached.structuredContent.sets.map(s=>s.id).sort(),[setDetached1.id,setDetached2.id]);
 const mcpGot=await rpc(h,reader.headers,'review_get',{id:setDetached1.id});
 assert.equal(mcpGot.isError,false);
 assert.equal(mcpGot.structuredContent.detached,true);
 assert.equal(mcpGot.structuredContent.detachedProjectName,'Home Hub');
 assert.deepEqual(mcpGot.structuredContent.tickets,[tkOld.id]);

 // Block publish, feedback, and saveSet on detached sets (HTTP 409 & MCP error).
 await json(h.post('/api/review/publish',{set:setDetached1.id,items:[htmlItem()]},writer.headers),409);
 await json(h.post('/api/review/feedback',{set:setDetached1.id,round:1,item:'login',rev:0,variant:'a',status:'accept'},writer.headers),409);
 await json(h.post('/api/review/sets',{id:setDetached1.id,rev:2,title:'Blocked'},writer.headers),409);
 assert.equal((await rpc(h,writer.headers,'review_set_save',{id:setDetached1.id,rev:2,title:'Blocked'})).isError,true);

 // Cannot delete or reassign an attached set (409) or with stale rev (409) or without review:write (403).
 await json(h.post('/api/review/sets/delete',{id:setNone.id,rev:1},writer.headers),409);
 await json(h.post('/api/review/sets/reassign',{id:setNone.id,rev:1,project:'sample-game'},writer.headers),409);
 await json(h.post('/api/review/sets/delete',{id:setDetached1.id,rev:1},writer.headers),409);
 await json(h.post('/api/review/sets/delete',{id:setDetached1.id,rev:2},reader.headers),403);
 await json(h.post('/api/review/sets/reassign',{id:setDetached2.id,rev:2,project:'missing-proj'},writer.headers),400);

 // Delete setDetached1: unindexes from FTS5, deletes unique blob file from disk, preserves shared blob for setNone!
 const blobDir=path.join(h.handler.hub.stateDirectory,'review','blobs');
 assert.equal(existsSync(path.join(blobDir,sha(uniqueImg))),true);
 assert.equal(existsSync(path.join(blobDir,sha(sharedImg))),true);
 const deleted=await json(h.post('/api/review/sets/delete',{id:setDetached1.id,rev:2},writer.headers),200);
 assert.deepEqual(deleted,{id:setDetached1.id,deleted:true});
 assert.equal(existsSync(path.join(blobDir,sha(uniqueImg))),false);
 assert.equal(existsSync(path.join(blobDir,sha(sharedImg))),true);
 await json(fetch(h.origin+`/api/review/sets/${setDetached1.id}`,{headers:reader.headers}),404);
 const searchAfterDelete=h.handler.hub.db.search({q:'detach',kind:'review'});
 assert.ok(!searchAfterDelete.results.some(r=>r.id===setDetached1.id));

 // Reassign setDetached2 via MCP to 'sample-game': strips invalid/cross-project ticket tkOld, re-enables writes & FTS project!
 const reassigned=await rpc(h,writer.headers,'review_set_reassign',{id:setDetached2.id,rev:2,project:'sample-game'});
 assert.equal(reassigned.isError,false);
 assert.equal(reassigned.structuredContent.project,'sample-game');
 assert.equal(reassigned.structuredContent.detached,false);
 assert.equal(reassigned.structuredContent.detachedProjectName,undefined);
 assert.deepEqual(reassigned.structuredContent.tickets,[]);
 assert.deepEqual(reassigned.structuredContent.removedTickets,[tkOld.id]);

 // Reassigned set accepts edits and feedback again and links target project's tickets.
 const saved=await json(h.post('/api/review/sets',{id:setDetached2.id,rev:reassigned.structuredContent.rev,tickets:[tkTarget.id]},writer.headers),200);
 assert.deepEqual(saved.tickets,[tkTarget.id]);
 const fb=await json(h.post('/api/review/feedback',{set:setDetached2.id,round:1,item:'login',rev:0,variant:'a',status:'accept'},writer.headers),200);
 assert.equal(fb.status,'accept');
 const searchReassigned=h.handler.hub.db.search({q:'detach',kind:'review',project:'sample-game'});
 assert.ok(searchReassigned.results.some(r=>r.id===setDetached2.id));
});

test('references: epic lookup, summaries, mention guard, sharing, usages and folded promotion collisions',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'lane-b-refs-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=openDb(path.join(dir,'hub.db'));
 t.after(()=>db.close());
 const seed=[{id:'alpha',key:'APP',name:'Alpha App'},{id:'beta',key:'BETA',name:'Beta App'}];
 const tickets=createTicketStore(path.join(dir,'tickets'),{db,seedProjects:seed});
 let refs;
 const wiki=createWikiStore(db,tickets,{mentionGuard:list=>refs.prepareMentionGuard(list)});
 const stubHub={db,site:{devices:[],lanCidrs:[]},state:id=>id==='tracker'?{tickets}:id==='wiki'?{wiki}:id==='home'?{homeDevices:{list:async()=>[],siteOverrides:async()=>({})}}:null};
 refs=createReferences(stubHub);

 const epic=await tickets.createEpic({project:'alpha',title:'Combat Overhaul'},'alice');
 await tickets.createEpic({project:'beta',title:'Audio Engine'},'alice');
 await tickets.updateEpic({id:epic.id,rev:epic.rev,spec:'@[Combat Overhaul](ref:epic/APP-E1)'},'alice');

 // Epics appear in references_search, references_suggest, resolve, and reference_get.
 const found=await refs.search({kind:'epic',project:'alpha'});
 assert.deepEqual(found.items.map(i=>[i.id,i.href,i.scope]),[['APP-E1','#epics/APP-E1','local']]);
 const suggestedAlpha=await refs.search({project:'alpha',q:'combat'},true);
 assert.deepEqual(suggestedAlpha.items.map(i=>i.id),['APP-E1']);
 const suggestedBeta=await refs.search({project:'beta',q:'combat'},true);
 assert.deepEqual(suggestedBeta.items,[]);

 // Wiki mentions of epics: same-project allowed, cross-project blocked until shared via reference_share.
 const {home:alphaHome}=await wiki.setup({project:'alpha'},'alice');
 const {home:betaHome}=await wiki.setup({project:'beta'},'alice');
 const epicRun={t:'ref',kind:'epic',id:'APP-E1',label:'Combat Overhaul'};
 await wiki.update({project:'alpha',id:alphaHome,rev:1,doc:doc(para(epicRun))},'alice');
 await assert.rejects(wiki.update({project:'beta',id:betaHome,rev:1,doc:doc(para(epicRun))},'alice'),/unavailable-reference/);
 await refs.annotate({kind:'epic',id:'APP-E1',rev:0},'alice',true);
 await wiki.update({project:'beta',id:betaHome,rev:1,doc:doc(para(epicRun))},'alice');
 const detail=await refs.get({kind:'epic',id:'APP-E1'});
 assert.equal(detail.record.scope,'global');
 assert.equal(detail.usageTotal,3);
 assert.ok(detail.usages.some(u=>u.source.kind==='wiki'&&u.source.id==='alpha/'+alphaHome));
 assert.ok(detail.usages.some(u=>u.source.kind==='wiki'&&u.source.id==='beta/'+betaHome));

 // Folded collision planning with diacritics, numeric suffixes, and 200-char surrogate-safe truncation.
 const longBase='A'.repeat(193)+'😀'+'Z'.repeat(5); // length = 193 + 2 + 5 = 200
 const globalData=[
  {kind:'custom',id:'r'+'0'.repeat(32),label:'Héro',project:null,scope:'global',rev:1},
  {kind:'custom',id:'r'+'1'.repeat(32),label:'Hero (APP)',project:null,scope:'global',rev:1},
  {kind:'custom',id:'r'+'2'.repeat(32),label:longBase,project:null,scope:'global',rev:1},
 ];
 const localData=[
  {kind:'custom',id:'r'+'a'.repeat(32),label:'Hero',project:'alpha',scope:'local',rev:1},
  {kind:'custom',id:'r'+'b'.repeat(32),label:'Unique Term',project:'alpha',scope:'local',rev:1},
  {kind:'custom',id:'r'+'c'.repeat(32),label:longBase,project:'alpha',scope:'local',rev:1},
 ];
 const planned=planReferencePromotion({global:globalData,local:localData},{id:'alpha',key:'APP'});
 assert.equal(planned.localCount,3);
 assert.equal(planned.collisions.length,2);
 const heroPlan=planned.plan.find(p=>p.id==='r'+'a'.repeat(32));
 assert.deepEqual({label:heroPlan.label,renamed:heroPlan.renamed},{label:'Hero (APP 2)',renamed:true});
 const uniquePlan=planned.plan.find(p=>p.id==='r'+'b'.repeat(32));
 assert.deepEqual({label:uniquePlan.label,renamed:uniquePlan.renamed},{label:'Unique Term',renamed:false});
 const longPlan=planned.plan.find(p=>p.id==='r'+'c'.repeat(32));
 assert.equal(longPlan.renamed,true);
 assert.ok(longPlan.label.length<=200);
 assert.equal(longPlan.label.isWellFormed(),true);
 assert.ok(longPlan.label.endsWith(' (APP)'));
 assert.ok(!longPlan.label.includes('\ud83d'));
});

test('transactional .lifecycle adapters commit atomically, roll back cleanly on injected failure, and allow project ID reuse',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'lane-b-tx-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=openDb(path.join(dir,'hub.db'));
 t.after(()=>db.close());
 const seed=[{id:'alpha',key:'APP',name:'Alpha App',description:'Alpha desc'},{id:'beta',key:'BETA',name:'Beta App'}];
 const tickets=createTicketStore(path.join(dir,'tickets'),{db,seedProjects:seed});
 let assets,refs;
 const wiki=createWikiStore(db,tickets,{
  mentionGuard:list=>refs.prepareMentionGuard(list),
  cleanupFiles:info=>assets.cleanupOrphans(info),
 });
 assets=createWikiAssets(db,path.join(dir,'wiki'),wiki);
 const review=createReviewStore(path.join(dir,'review'),{tickets,db});
 const stubHub={db,site:{devices:[],lanCidrs:[]},state:id=>id==='tracker'?{tickets}:id==='wiki'?{wiki}:id==='home'?{homeDevices:{list:async()=>[],siteOverrides:async()=>({})}}:null};
 refs=createReferences(stubHub);

 // Attach raw codec helpers onto store objects for our test multi-collection harness.
 const wrapCodec=(store,kind,codec)=>Object.assign(store,{kind,...codec});
 const wikiCodec={
  split:data=>{
   const keys={wikis:w=>w.id??w.project,pages:p=>p.project+'/'+p.id,summaries:p=>p.project+'/'+p.id,assets:a=>a.project+'/'+a.id,uploads:u=>u.id,blobs:b=>b.digest,receipts:r=>r.key,grants:g=>g.key};
   const meta={...data},colls={};
   for(const [name,key] of Object.entries(keys)){colls[name]=(data[name]??[]).map(item=>[key(item),item]);delete meta[name];}
   return {meta,colls};
  },
  join:(meta,colls)=>({...meta,...Object.fromEntries(['wikis','pages','summaries','assets','uploads','blobs','receipts','grants'].map(n=>[n,(colls[n]??[]).map(([,v])=>v)]))}),
 };
 const reviewCodec={
  split:({sets,blobs,...meta})=>({meta,colls:{sets:sets.map(x=>[x.id,x]),blobs:Object.entries(blobs)}}),
  join:(meta,c)=>({...meta,sets:(c.sets||[]).map(([,x])=>x),blobs:Object.fromEntries(c.blobs||[])}),
  search:(coll,s)=>coll!=='sets'?null:{kind:'review',id:s.id,project:s.project,updated:s.updatedAt,title:`${s.id} ${s.title}`,body:s.description||''},
 };
 const refsCodec={
  split:data=>({meta:{schema:data.schema},colls:{global:(data.global??[]).map(r=>[r.id,r]),local:(data.local??[]).map(r=>[r.project+'/'+r.id,r]),notes:(data.notes??[]).map(r=>[r.kind+'/'+r.id,r])}}),
  join:(meta,c)=>({...meta,global:(c.global??[]).map(([,r])=>r),local:(c.local??[]).map(([,r])=>r),notes:(c.notes??[]).map(([,r])=>r)}),
 };
 wrapCodec(wiki.lifecycle.store,'wiki',wikiCodec);
 wrapCodec(review.lifecycle.store,'review',reviewCodec);
 wrapCodec(refs.lifecycle.store,'references',refsCodec);

 // 1. Create wiki for 'alpha' via wiki.lifecycle.create and rename via wiki.lifecycle.rename.
 const createdWiki=await wiki.lifecycle.store.change(wiki.lifecycle.select('alpha','create'),data=>
  wiki.lifecycle.create(data,{id:'alpha',name:'Alpha App',description:'Alpha desc'},'alice','2026-11-22T10:00:00.000Z'));
 assert.equal((await wiki.get('alpha',createdWiki.home)).title,'Alpha App Home');

 const renameRes=await wiki.lifecycle.store.change(wiki.lifecycle.select('alpha','rename'),data=>{
  const sp=wiki.lifecycle.space(data,'alpha');
  return wiki.lifecycle.rename(data,sp,'Alpha App','Alpha Two','alice','2026-11-22T10:01:00.000Z');
 });
 assert.equal(renameRes.homeRenamed,true);
 assert.equal((await wiki.get('alpha',createdWiki.home)).title,'Alpha Two Home');

 // Create a ticket, a review set with blob, a local colliding custom ref, and reference notes.
 const tk=await tickets.create({project:'alpha',title:'Ticket 1'},'alice');
 const reviewBlob=Buffer.concat([PNG,Buffer.from('tx-review')]);
 await review.putChunk(sha(reviewBlob),{offset:0,size:reviewBlob.length},Readable.from([reviewBlob]));
 const rev=await review.publish({project:'alpha',title:'Alpha Review',tickets:[tk.id],items:[{id:'shot',title:'Shot',kind:'image',variants:[{id:'a',media:[{sha256:sha(reviewBlob),type:'image/png'}]}]}]},'alice');
 const wikiBlob=Buffer.concat([PNG,Buffer.from('tx-wiki')]);
 const up=await assets.begin({project:'alpha',name:'pic.png',size:wikiBlob.length,digest:sha(wikiBlob)},'alice');
 await assets.chunk(up.uploadId,0,wikiBlob,'alice');
 await assets.finish(up.uploadId,'alice');
 await refs.save({kind:'custom',label:'Hero'},'alice',false);
 const localRef=await refs.save({kind:'custom',project:'alpha',label:'Hero'},'alice',true);
 await refs.annotate({kind:'ticket',id:tk.id,rev:0,description:'Note on ticket'},'alice',false);
 await refs.annotate({kind:'wiki',id:'alpha/'+createdWiki.home,rev:0,description:'Note on wiki'},'alice',false);

 // 2. Injected failure mid-transaction rolls back ALL three stores and leaves disk blobs intact!
 await assert.rejects(runMultiCollectionTx(db,[
  {store:wiki.lifecycle.store,selection:wiki.lifecycle.select('alpha','delete')},
  {store:review.lifecycle.store,selection:review.lifecycle.select('alpha','delete')},
  {store:refs.lifecycle.store,selection:refs.lifecycle.select('alpha')},
 ],([wikiData,reviewData,refsData])=>{
  const sp=wiki.lifecycle.space(wikiData,'alpha');
  const wRes=wiki.lifecycle.remove(wikiData,sp,'2026-11-22T10:05:00.000Z');
  review.lifecycle.removeProject(reviewData,{id:'alpha',name:'Alpha Two'},true,'alice','2026-11-22T10:05:00.000Z');
  refs.lifecycle.removeProject(refsData,{id:'alpha',key:'APP'},{promote:true,ticketIds:[tk.id],wikiPageKeys:wRes.pageKeys,by:'alice',at:'2026-11-22T10:05:00.000Z'});
  throw new Error('injected-failure');
 }),/injected-failure/);

 // Everything is still intact after rollback!
 assert.equal((await wiki.get('alpha',createdWiki.home)).title,'Alpha Two Home');
 assert.equal((await review.get(rev.id)).project,'alpha');
 assert.equal((await refs.get({kind:'custom',id:localRef.id})).record.scope,'local');
 assert.equal((await refs.get({kind:'ticket',id:tk.id})).note.description,'Note on ticket');
 assert.equal(existsSync(path.join(dir,'wiki','blobs',sha(wikiBlob))),true);
 assert.equal(existsSync(path.join(dir,'review','blobs',sha(reviewBlob))),true);

 // 3. Successful multi-collection commit (deleteWiki:true, deleteReviews:true, promoteReferences:true).
 const committed=await runMultiCollectionTx(db,[
  {store:wiki.lifecycle.store,selection:wiki.lifecycle.select('alpha','delete')},
  {store:review.lifecycle.store,selection:review.lifecycle.select('alpha','delete')},
  {store:refs.lifecycle.store,selection:refs.lifecycle.select('alpha')},
 ],([wikiData,reviewData,refsData])=>{
  const sp=wiki.lifecycle.space(wikiData,'alpha');
  const wRes=wiki.lifecycle.remove(wikiData,sp,'2026-11-22T10:06:00.000Z');
  const rRes=review.lifecycle.removeProject(reviewData,{id:'alpha',name:'Alpha Two'},true,'alice','2026-11-22T10:06:00.000Z');
  const refRes=refs.lifecycle.removeProject(refsData,{id:'alpha',key:'APP'},{promote:true,ticketIds:[tk.id],wikiPageKeys:wRes.pageKeys,wikiSpaceId:wRes.spaceId,by:'alice',at:'2026-11-22T10:06:00.000Z'});
  return {wRes,rRes,refRes};
 });
 await wiki.lifecycle.cleanup(committed.wRes);
 await review.lifecycle.notify(committed.rRes);
 refs.lifecycle.notify(committed.refRes);

 assert.equal(committed.wRes.removed,true);
 assert.equal(committed.rRes.deleted,true);
 assert.deepEqual(committed.refRes.renamed,[{id:localRef.id,from:'Hero',to:'Hero (APP)'}]);
 assert.ok(committed.refRes.removedNotes.includes('ticket/'+tk.id));
 assert.ok(committed.refRes.removedNotes.includes('wiki/alpha/'+createdWiki.home));
 assert.equal(existsSync(path.join(dir,'wiki','blobs',sha(wikiBlob))),false);
 assert.equal(existsSync(path.join(dir,'review','blobs',sha(reviewBlob))),false);
 const promoted=(await refs.get({kind:'custom',id:localRef.id})).record;
 assert.deepEqual([promoted.scope,promoted.project,promoted.label],['global',null,'Hero (APP)']);
 await assert.rejects(review.get(rev.id),/not-found/);

 // 4. Project ID reuse after deletion succeeds cleanly!
 const recreated=await wiki.lifecycle.store.change(wiki.lifecycle.select('alpha','create'),data=>
  wiki.lifecycle.create(data,{id:'alpha',name:'Alpha Reborn'},'alice','2026-11-22T10:07:00.000Z'));
 assert.equal(recreated.space.id,'alpha');
 assert.equal((await wiki.get('alpha',recreated.home)).title,'Alpha Reborn Home');

 // 5. Detach wiki via lifecycle.detach leaves space id 'alpha' occupied, so reusing 'alpha' with createWiki conflicts!
 const detached=await wiki.lifecycle.store.change(wiki.lifecycle.select('alpha','detach'),data=>{
  const sp=wiki.lifecycle.space(data,'alpha');
  return wiki.lifecycle.detach(data,sp,'Alpha Reborn','2026-11-22T10:08:00.000Z');
 });
 assert.equal(detached.detached,true);
 assert.equal(detached.space.projectId,null);
 assert.equal(detached.space.name,'Alpha Reborn');
 await assert.rejects(wiki.lifecycle.store.change(wiki.lifecycle.select('alpha','create'),data=>
  wiki.lifecycle.create(data,{id:'alpha',name:'Alpha Third'},'alice','2026-11-22T10:09:00.000Z')),/conflict/);
});
