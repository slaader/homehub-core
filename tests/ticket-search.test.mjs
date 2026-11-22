import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DB_SCHEMA,openDb} from '../server/db.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createTicketFiles} from '../server/ticket-files.mjs';
import {createTicketSearch,textChunks,ticketSearchSettings} from '../server/ticket-search.mjs';
import {hub} from './hub-helper.mjs';

async function fixture(t,options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-'));
 const db=openDb(path.join(dir,'hub.db'));
 const tickets=createTicketStore(dir,{db,seedProjects:[{id:'sample',key:'SM',name:'Sample',type:'app'},{id:'other',key:'OT',name:'Other',type:'app'}]});
 const files=createTicketFiles(dir);
 const search=createTicketSearch(dir,{db,tickets,ticketFiles:files,env:{},...options});
 t.after(async()=>{await search.close();db.close();await rm(dir,{recursive:true,force:true});});
 return {dir,db,tickets,files,search};
}

function assertStatusShape(st){
 for(const key of ['state','semanticState','readiness','enabled','configured','provider','defaultMode','chunks','embedded','pending','failed','model','revision','lexicalReady','extracting','extraction','coverage','error','errors']){
  assert.ok(Object.hasOwn(st,key),`status missing ${key}`);
 }
 assert.equal(typeof st.provider.configured,'boolean');
 assert.ok(st.provider.model===null||typeof st.provider.model==='string');
 assert.ok(!Object.hasOwn(st.provider,'url')&&!Object.hasOwn(st.provider,'token'),'provider summary leaks no endpoint or secret');
 assert.equal(typeof st.coverage.chunks,'number');
 assert.equal(typeof st.coverage.embedded,'number');
 assert.equal(typeof st.coverage.pending,'number');
 assert.equal(typeof st.coverage.failed,'number');
 assert.equal(typeof st.coverage.ratio,'number');
 assert.equal(typeof st.extraction.attachments,'number');
 assert.equal(typeof st.extraction.indexed,'number');
}

function assertSearchShape(res){
 for(const key of ['query','requestedMode','mode','state','semanticState','coverage','extraction','results']){
  assert.ok(Object.hasOwn(res,key),`search result missing ${key}`);
 }
 assert.equal(typeof res.coverage.chunks,'number');
 assert.equal(typeof res.extraction.attachments,'number');
 assert.ok(Array.isArray(res.results));
}

test('textChunks preserves Unicode code points and ticketSearchSettings validates env',()=>{
 const chunks=textChunks('🦊'.repeat(1800));
 assert.equal(chunks.length,3);
 assert.equal(Array.from(chunks[0]).length,800);
 assert.ok(chunks.every(c=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(c)));
 assert.equal(ticketSearchSettings({}).url,undefined);
 assert.throws(()=>ticketSearchSettings({HOME_HUB_TICKET_EMBEDDING_URL:'https://example.com'}),/configuration/);
 assert.throws(()=>ticketSearchSettings({HOME_HUB_TICKET_SEARCH_MIN_SCORE:'bad'}),/minimum/);
 assert.throws(()=>textChunks('abc',0,0),/bounds/);
});

test('extraction covers complete Unicode attachments, coverage counts, metadata search, deduplication and removal',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-unicode-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'tickets.json'),JSON.stringify({schema:1,revision:0,updatedAt:null,projects:[{id:'sample',key:'HH',name:'Sample',type:'app',rev:1,next:1}],releases:[],tickets:[]}));
 const db=openDb(path.join(dir,'hub.db')),tickets=createTicketStore(dir,{db}),ticketFiles=createTicketFiles(dir);
 const search=createTicketSearch(dir,{db,tickets,ticketFiles,env:{}});
 t.after(async()=>{await search.close();db.close();});

 const ticket=await tickets.create({project:'sample',title:'Start evaluation',description:'A generated fixture for testing and evaluation.'},'alice');
 const unicodeText='🦊'.repeat(1601)+' finalneedle '+'🦊'.repeat(800)+' finalneedle';
 const file=await ticketFiles.put([Buffer.from(unicodeText)],{name:'unicode.txt'});
 let attached=await tickets.attach(ticket.id,file,'alice');
 const unicodeAtt=attached.attachments[0];
 for(const [name,bytes,type] of [['broken.txt',Buffer.from([0xff]),'text/plain'],['big.txt',Buffer.alloc(256*1024+1,65),'text/plain'],['binary.bin',Buffer.from('binary'),'application/octet-stream']]){
  const f=await ticketFiles.put([bytes],{name});
  attached=await tickets.attach(ticket.id,{...f,type},'alice');
 }
 attached=await tickets.attach(ticket.id,{name:'missing.txt',type:'text/plain',size:5,sha256:'a'.repeat(64)},'alice');
 assert.equal(search.status().revision,null,'canonical writes never run indexing before start');
 assertStatusShape(search.status());

 await search.start();
 await search.whenIdle();
 assert.deepEqual(search.status().extraction,{attachments:5,indexed:1,unsupported:1,oversize:1,invalid:1,missing:1,capacity:0,metadataCapacity:0,ticketCapacity:0});

 const unicodeHit=await search.search({query:'finalneedle',mode:'text'});
 assertSearchShape(unicodeHit);
 assert.equal(unicodeHit.state,'ready');
 assert.equal(unicodeHit.results.length,1,'multi-chunk attachment deduplicates per source group');
 assert.equal(unicodeHit.results[0].attachment,unicodeAtt.id);
 assert.equal(unicodeHit.results[0].source,'attachment');
 assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(unicodeHit.results[0].snippet));

 // Searchable attachment metadata: filename, id, timestamp, size, sha256.
 assert.equal((await search.search({query:'missing.txt',mode:'text'})).results[0]?.name,'missing.txt');
 for(const q of [unicodeAtt.id,unicodeAtt.at,String(unicodeAtt.size),unicodeAtt.sha256]){
  assert.equal((await search.search({query:q,mode:'text'})).results[0]?.attachment,unicodeAtt.id,q);
 }

 // Unrelated natural-language queries do not match a stopword alone; prefixes still work.
 assert.equal((await search.search({query:'swimming technique for butterfly stroke',mode:'text'})).results.length,0);
 assert.equal((await search.search({query:'evalu',mode:'text'})).results.length,1);

 // Incremental comment update reports indexing until idle, then becomes searchable.
 await tickets.comment({id:ticket.id,text:'new comment evidence'},'alice');
 const whileDirty=await search.search({query:'new',mode:'text'});
 assertSearchShape(whileDirty);
 assert.equal(whileDirty.state,'indexing');
 assert.deepEqual(whileDirty.results,[]);
 await search.whenIdle();
 assert.equal((await search.search({query:'new comment evidence',mode:'text'})).results[0]?.ticket,ticket.id);

 // Detaching an attachment removes its content and metadata from search.
 await tickets.detach({id:ticket.id,attachment:unicodeAtt.id},'alice');
 await search.whenIdle();
 assert.equal((await search.search({query:'finalneedle',mode:'text'})).results.length,0);

 // Single-pass validation rejects malformed inputs.
 for(const args of [
  null,
  [],
  {query:''},
  {query:'!!!'},
  {query:'x'.repeat(201)},
  {query:'x',status:'invalid'},
  {query:'x',limit:0},
  {query:'x',limit:101},
  {query:'x',limit:1.5},
  {query:'x',arbitrary:'path'},
  {query:'x',mode:'unknown'},
  {query:'x',minScore:NaN},
  {query:'x',minScore:1.5},
 ])await assert.rejects(search.search(args),/invalid/,JSON.stringify(args));

 await search.close();
 await tickets.comment({id:ticket.id,text:'after close'},'alice');
 assert.equal(search.status().state,'closed');
 assert.equal(search.status().extracting,false);
 assertStatusShape(search.status());
});

test('canonical filter parity across tickets.search, ticketSearch.search and searchAll',async t=>{
 const {tickets,search}=await fixture(t);
 await tickets.create({project:'sample',title:'needle alpha',status:'open',type:'bug',priority:'high',labels:['evidence']},'alice');
 await tickets.create({project:'sample',title:'needle beta',status:'in-progress',type:'task',priority:'normal',labels:['evidence']},'alice');
 await tickets.create({project:'other',title:'needle gamma',status:'done',type:'task',priority:'low',labels:['other']},'alice');
 await search.start();
 await search.whenIdle();

 for(const [filter,count] of [
  [{status:'active'},2],
  [{status:'open,in-progress'},2],
  [{status:''},3],
  [{release:'none'},3],
  [{assignee:'none'},3],
  [{project:'other'},1],
  [{type:'bug',priority:'high'},1],
  [{label:'evidence'},2],
 ]){
  assert.equal((await tickets.search({q:'needle',...filter})).tickets.length,count,`tickets.search ${JSON.stringify(filter)}`);
  assert.equal((await search.search({query:'needle',mode:'text',...filter})).results.length,count,`ticketSearch.search ${JSON.stringify(filter)}`);
 }
 assert.equal((await search.searchAll({q:'needle',project:'other'})).results.length,1);
});

test('persistent vector cache reuse across restart, threshold, model invalidation and backwards clock',async t=>{
 let calls=0;
 const embed=async texts=>{calls++;return texts.map(s=>s.includes('unrelated')?[0,1]:[1,0]);};
 const {dir,db,tickets,files,search}=await fixture(t,{embed,modelFingerprint:'fixture-v1',semanticEnabled:true});
 await tickets.create({project:'sample',title:'needle one'},'alice');
 await tickets.create({project:'other',title:'needle two'},'alice');
 await search.start();
 await search.whenIdle();
 assert.ok(calls>=1);
 assert.equal(search.status().semanticState,'ready');
 assert.equal(search.status().embedded,search.status().chunks);
 assert.equal((await stat(path.join(dir,'search','ticket-search.db'))).mode&0o777,0o600);

 // Threshold filters orthogonal vectors.
 assert.equal((await search.search({query:'unrelated',mode:'semantic'})).results.length,0);
 assert.equal((await search.search({query:'needle',project:'other',mode:'semantic'})).results[0]?.ticket,'OT-1');

 // Reopen with the same modelFingerprint: zero re-embedding calls.
 const callsBeforeRestart=calls;
 await search.close();
 const warm=createTicketSearch(dir,{db,tickets,ticketFiles:files,env:{},embed,modelFingerprint:'fixture-v1',semanticEnabled:true});
 t.after(()=>warm.close());
 await warm.start();
 await warm.whenIdle();
 assert.equal(calls,callsBeforeRestart,'warm vector cache reused across restart');
 assert.equal(warm.status().embedded,warm.status().chunks);

 // Reopen with a changed modelFingerprint and future timestamps (backwards wall clock):
 // new active vectors survive eviction without re-embedding loops.
 await warm.close();
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite');
 const raw=new DatabaseSync(path.join(dir,'search','ticket-search.db'));
 raw.prepare('UPDATE vectors SET used=?').run(Date.now()+1_000_000);
 raw.close();

 let newModelCalls=0;
 const next=createTicketSearch(dir,{
  db,tickets,ticketFiles:files,env:{},modelFingerprint:'fixture-v2',semanticEnabled:true,maxVectors:1,maxRetries:0,
  embed:async texts=>{newModelCalls++;return texts.map(()=>[0,1]);},
 });
 t.after(()=>next.close());
 await next.start();
 await next.whenIdle();
 assert.equal(newModelCalls,1,'new active vector survives eviction even when old vectors have future timestamps');
 assert.equal(next.status().embedded,1);
 assert.ok(next.status().failed>=1,'chunks beyond maxVectors are reported as failed');
});

test('startup reconciles stale cached sources before sending them to a changed provider',async t=>{
 const {dir,db,tickets,files,search}=await fixture(t,{embed:async xs=>xs.map(()=>[1,0]),modelFingerprint:'old-model',semanticEnabled:true});
 await tickets.create({project:'sample',title:'Stale source'},'alice');
 await search.start();
 await search.whenIdle();
 assert.ok(search.status().chunks>0);
 await search.close();

 // Fresh store with zero tickets on the same cache directory: canonical reconciliation must run first.
 let entered,release,embedCalls=0;
 const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 const emptyTickets={
  searchSnapshot:async()=>{entered();await gate;return {revision:0,tickets:[]};},
  searchRevision:()=>0,
  onSearchChange:()=>()=>{},
 };
 const reopened=createTicketSearch(dir,{
  db,tickets:emptyTickets,ticketFiles:files,env:{},modelFingerprint:'new-model',semanticEnabled:true,
  embed:async xs=>{embedCalls++;return xs.map(()=>[1,0]);},
 });
 t.after(()=>reopened.close());
 reopened.start();
 const idle=reopened.whenIdle();
 await started;
 assert.equal(embedCalls,0,'stale persisted docs are never embedded before reconciliation');
 release();
 await idle;
 assert.equal(embedCalls,0);
 assert.equal(reopened.status().chunks,0);
});

test('live opt-in and opt-out toggle works in place without re-extracting or losing lexical search',async t=>{
 let fileReads=0,embedCalls=0,inFlightAborted=false,batchEntered,releaseBatch;
 const batchStarted=new Promise(r=>{batchEntered=r;});
 let blockNextBatch=false;
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-toggle-'));
 const db=openDb(path.join(dir,'hub.db'));
 const tickets=createTicketStore(dir,{db,seedProjects:[{id:'sample',key:'SM',name:'Sample',type:'app'}]});
 const rawFiles=createTicketFiles(dir);
 const ticketFiles={
  ...rawFiles,
  async readText(sha){fileReads++;return rawFiles.readText(sha);},
 };
 const embed=async(texts,{signal}={})=>{
  embedCalls++;
  if(blockNextBatch){
   blockNextBatch=false;
   batchEntered();
   await new Promise(resolve=>{
    signal?.addEventListener('abort',()=>{inFlightAborted=true;resolve();},{once:true});
    releaseBatch=resolve;
   });
   if(signal?.aborted)throw new Error('aborted');
  }
  return texts.map(()=>[1,0]);
 };
 const search=createTicketSearch(dir,{db,tickets,ticketFiles,env:{},embed,modelFingerprint:'live-toggle',batchSize:1});
 t.after(async()=>{releaseBatch?.();await search.close();db.close();await rm(dir,{recursive:true,force:true});});

 const tk=await tickets.create({project:'sample',title:'Live toggle ticket'},'alice');
 await tickets.attach(tk.id,await rawFiles.put([Buffer.from('attachment toggle needle')],{name:'note.txt'}),'alice');
 await search.start();
 await search.whenIdle();
 assert.equal(fileReads,1);
 assert.equal(embedCalls,0,'zero provider calls while disabled');
 assert.equal(search.status().semanticState,'disabled');
 assert.equal(search.status().state,'ready');
 assert.equal((await search.search({query:'attachment toggle needle',mode:'text'})).results[0]?.ticket,tk.id);

 // Enable while blocking the first batch, then immediately disable to verify clean abort and instant lexical availability.
 blockNextBatch=true;
 const enableSettings=await search.setEnabled({enabled:true});
 assert.equal(enableSettings.enabled,true);
 await batchStarted;
 const disableSettings=await search.setEnabled({enabled:false});
 assert.equal(disableSettings.enabled,false);
 assert.equal(inFlightAborted,true,'disabling aborts in-flight embedding batch');
 assert.equal(search.status().semanticState,'disabled');
 assert.equal(search.status().state,'ready','lexical/attachment search remains ready immediately');
 assert.equal((await search.search({query:'attachment toggle needle',mode:'text'})).results[0]?.ticket,tk.id);
 assert.equal((await search.search({query:'meaning',mode:'semantic'})).state,'disabled');
 const callsAfterDisable=embedCalls;
 await search.whenIdle();
 assert.equal(embedCalls,callsAfterDisable,'no further provider calls while disabled');

 // Re-enable: backfills vectors on existing extracted chunks WITHOUT re-reading attachments.
 await search.setEnabled({enabled:true});
 await search.whenIdle();
 assert.equal(fileReads,1,'live toggle never re-extracts attachments');
 assert.equal(search.status().semanticState,'ready');
 assert.equal(search.status().embedded,search.status().chunks);
 const callsAfterBackfill=embedCalls;

 // Toggle off and back on: already-persisted vectors stay warm with zero new provider calls.
 await search.setEnabled({enabled:false});
 await search.setEnabled({enabled:true});
 await search.whenIdle();
 assert.equal(embedCalls,callsAfterBackfill,'warm vectors survive live disable/enable round-trip');
 assert.equal(fileReads,1);
});

test('concurrent identical semantic queries coalesce, invalid dimensions retry, and query cache reuses vectors',async t=>{
 let failOnce=true,queryCalls=0,entered,release;
 const queryGate=new Promise(r=>{entered=r;});
 const {tickets,search}=await fixture(t,{
  semanticEnabled:true,retryMs:1,
  embed:async(texts,{query}={})=>{
   if(query){
    queryCalls++;
    if(queryCalls===1){entered();await new Promise(r=>{release=r;});}
    return texts.map(()=>[1,0]);
   }
   if(failOnce){failOnce=false;return texts.map(()=>[NaN,0]);}
   return texts.map(()=>[1,0]);
  },
 });
 await tickets.create({project:'sample',title:'Evidence item'},'alice');
 await search.start();
 await search.whenIdle();
 assert.equal(search.status().embedded,search.status().chunks);

 const burst=Array.from({length:8},()=>search.search({query:'paraphrase',mode:'semantic'}));
 await queryGate;
 release();
 const results=await Promise.all(burst);
 assert.equal(queryCalls,1,'concurrent identical semantic queries share one provider request');
 assert.ok(results.every(r=>r.state==='ready'&&r.results[0]?.ticket==='SM-1'));

 // Repeated query hits queryCache without calling provider again.
 await search.search({query:'paraphrase',mode:'hybrid'});
 assert.equal(queryCalls,1);
});

test('provider failures report degraded, recover via retryFailed and cooldown, and hybrid falls back to text',async t=>{
 let failing=true,calls=0;
 const {tickets,search}=await fixture(t,{
  semanticEnabled:true,maxRetries:1,retryMs:1,recoveryMs:25,
  embed:async texts=>{calls++;if(failing)throw new Error('sensitive provider secret');return texts.map(()=>[1,0]);},
 });
 await tickets.create({project:'sample',title:'Recoverable needle'},'alice');
 await search.start();
 await search.whenIdle();
 assert.equal(search.status().state,'degraded');
 assert.equal(search.status().semanticState,'degraded');
 assert.ok(search.status().failed>0);
 assert.ok(!JSON.stringify(search.status()).includes('sensitive'));
 // Hybrid falls back to text while vectors are not ready.
 const fallback=await search.search({query:'Recoverable',mode:'hybrid'});
 assert.equal(fallback.requestedMode,'hybrid');
 assert.equal(fallback.mode,'text');
 assert.equal(fallback.results[0]?.ticket,'SM-1');

 // Automatic recovery after cooldown.
 failing=false;
 const deadline=Date.now()+1500;
 while(search.status().state!=='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
 assert.equal(search.status().state,'ready');
 assert.ok(calls>=3);

 // Manual retryFailed recovery after a second failure.
 failing=true;
 await tickets.create({project:'sample',title:'Second failure'},'alice');
 await search.whenIdle();
 assert.equal(search.status().state,'degraded');
 failing=false;
 search.retryFailed();
 await search.whenIdle();
 assert.equal(search.status().state,'ready');

 // Query-time failure in hybrid mode degrades cleanly to text.
 failing=true;
 const degradedHybrid=await search.search({query:'Recoverable',mode:'hybrid'});
 assert.equal(degradedHybrid.mode,'text');
 assert.equal(degradedHybrid.state,'degraded');
 assert.equal(degradedHybrid.semanticState,'degraded');
 assert.equal(degradedHybrid.results[0]?.ticket,'SM-1');
});

test('canonical writes invalidate in-flight semantic queries, and metadata edits reuse embeddings and attachment reads',async t=>{
 let entered,release,embedCalls=0,fileReads=0;
 const queryGate=new Promise(r=>{entered=r;});
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-edit-'));
 const db=openDb(path.join(dir,'hub.db'));
 const tickets=createTicketStore(dir,{db,seedProjects:[{id:'sample',key:'SM',name:'Sample',type:'app'}]});
 const rawFiles=createTicketFiles(dir);
 const ticketFiles={...rawFiles,async readText(sha){fileReads++;return rawFiles.readText(sha);}};
 const search=createTicketSearch(dir,{
  db,tickets,ticketFiles,env:{},semanticEnabled:true,
  embed:async(texts,{query}={})=>{
   embedCalls++;
   if(query){entered();await new Promise(r=>{release=r;});}
   return texts.map(()=>[1,0]);
  },
 });
 t.after(async()=>{release?.();await search.close();db.close();await rm(dir,{recursive:true,force:true});});

 const a=await tickets.create({project:'sample',title:'First item'},'alice');
 const b=await tickets.create({project:'sample',title:'Second item'},'alice');
 await tickets.attach(a.id,await rawFiles.put([Buffer.from('firstfileneedle')],{name:'a.txt'}),'alice');
 await tickets.attach(b.id,await rawFiles.put([Buffer.from('secondfileneedle')],{name:'b.txt'}),'alice');
 await search.start();
 await search.whenIdle();
 assert.equal(fileReads,2);

 // In-flight semantic query is invalidated if canonical state changes before it finishes.
 const pending=search.search({query:'meaning',mode:'semantic'});
 await queryGate;
 await tickets.update({id:a.id,rev:a.rev,status:'done'},'alice');
 release();
 const stale=await pending;
 assertSearchShape(stale);
 assert.equal(stale.state,'indexing');
 assert.deepEqual(stale.results,[]);
 await search.whenIdle();

 // Metadata-only edit did not re-read attachment files and preserved unchanged text embeddings.
 assert.equal(fileReads,2,'ordinary edit does not re-read cached attachments');
 assert.equal((await search.search({query:'firstfileneedle',status:'done',mode:'text'})).results[0]?.ticket,a.id);
 assert.equal((await search.search({query:'secondfileneedle',mode:'text'})).results[0]?.ticket,b.id);
});

test('document capacity keeps metadata searchable while reporting degraded coverage',async t=>{
 const {tickets,files,search}=await fixture(t,{maxDocuments:5});
 const ticket=await tickets.create({project:'sample',title:'ticketneedle'},'alice');
 await tickets.attach(ticket.id,await files.put([Buffer.from('a'.repeat(5000)+' tailneedle')],{name:'largefilemetadata.txt'}),'alice');
 await search.start();
 await search.whenIdle();
 assert.equal(search.status().state,'degraded');
 assert.equal(search.status().extraction.capacity,1);
 assert.equal((await search.search({query:'ticketneedle',mode:'text'})).results[0]?.ticket,ticket.id);
 assert.equal((await search.search({query:'largefilemetadata',mode:'text'})).results[0]?.source,'attachment');
 assert.equal((await search.search({query:'tailneedle',mode:'text'})).results.length,0,'omitted content is never presented as indexed');
});

test('stale snapshot during async extraction is discarded, transient errors recover, and close releases waiters',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-race-'));
 const db=openDb(path.join(dir,'hub.db'));
 const tickets=createTicketStore(dir,{db,seedProjects:[{id:'sample',key:'SM',name:'Sample',type:'app'}]});
 const ticket=await tickets.create({project:'sample',title:'Original'},'alice');
 const attached=await tickets.attach(ticket.id,{name:'race.txt',type:'text/plain',size:5,sha256:'b'.repeat(64)},'alice');
 let entered,release;
 const gate=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});
 const search=createTicketSearch(dir,{
  db,tickets,env:{},buildRetryMs:1,maxBuildRetries:1,
  ticketFiles:{readText:async()=>{entered();await wait;return {state:'indexed',text:'removed evidence'};}},
 });
 t.after(async()=>{release?.();await search.close();db.close();await rm(dir,{recursive:true,force:true});});

 search.start();
 const idle=search.whenIdle();
 await gate;
 await tickets.detach({id:ticket.id,attachment:attached.attachments[0].id},'alice');
 release();
 await idle;
 assert.equal((await search.search({query:'removed evidence',mode:'text'})).results.length,0,'detached attachment is never published');

 // Shutdown during blocked extraction releases idle waiters and prevents late publication.
 await tickets.attach(ticket.id,{name:'late.txt',type:'text/plain',size:5,sha256:'c'.repeat(64)},'alice');
 let entered2,release2;
 const gate2=new Promise(r=>{entered2=r;}),wait2=new Promise(r=>{release2=r;});
 const closing=createTicketSearch(dir,{
  db,tickets,env:{},
  ticketFiles:{readText:async()=>{entered2();await wait2;return {state:'indexed',text:'latefile'};}},
 });
 t.after(async()=>{release2?.();await closing.close();});
 closing.start();
 const closingIdle=closing.whenIdle();
 const rejected=assert.rejects(closingIdle,/closed/);
 await gate2;
 await closing.close();
 await rejected;
 release2();
 await new Promise(r=>setImmediate(r));
 assert.equal(closing.status().state,'closed');

 // Close prevents late provider writes even if an embedding provider ignores AbortSignal.
 let finishLate,lateEntered;
 const lateGate=new Promise(r=>{lateEntered=r;});
 const lateSearch=createTicketSearch(dir,{
  db,tickets,ticketFiles:createTicketFiles(dir),env:{},semanticEnabled:true,modelFingerprint:'late-close',
  embed:()=>new Promise(resolve=>{lateEntered();finishLate=resolve;}),
 });
 t.after(()=>lateSearch.close());
 await lateSearch.start();
 await lateGate;
 await lateSearch.close();
 finishLate([[1,0],[1,0]]);
 await new Promise(r=>setTimeout(r,10));
 assert.equal(lateSearch.status().state,'closed');
});

test('transient extraction errors retry and recover; exhausted errors settle degraded without leaking details',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-err-'));
 const db=openDb(path.join(dir,'hub.db'));
 const realTickets=createTicketStore(dir,{db,seedProjects:[{id:'sample',key:'SM',name:'Sample',type:'app'}]});
 await realTickets.create({project:'sample',title:'recoveredneedle'},'alice');
 let mode='failOnce',calls=0;
 const tickets={
  ...realTickets,
  async searchSnapshot(){
   calls++;
   if(mode==='failOnce'&&calls===1)throw new Error('temporary');
   if(mode==='alwaysFail')throw new Error('sensitive internal detail');
   return realTickets.searchSnapshot();
  },
 };
 const search=createTicketSearch(dir,{db,tickets,ticketFiles:createTicketFiles(dir),env:{},buildRetryMs:1,maxBuildRetries:1});
 t.after(async()=>{await search.close();db.close();await rm(dir,{recursive:true,force:true});});

 await search.start();
 await search.whenIdle();
 assert.equal(calls,2);
 assert.equal((await search.search({query:'recoveredneedle',mode:'text'})).results.length,1);

 mode='alwaysFail';
 await realTickets.comment({id:'SM-1',text:'change'},'alice');
 await search.whenIdle();
 assert.equal(search.status().state,'degraded');
 assert.equal(search.status().extracting,false);
 assert.ok(!JSON.stringify(search.status()).includes('sensitive'));
});

test('populated 2.0.1 SQLite ticket state is read without rewriting canonical rows',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-v201-')),file=path.join(dir,'hub.db');
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite'),raw=new DatabaseSync(file);
 raw.exec(`CREATE TABLE meta(kind TEXT PRIMARY KEY,doc TEXT NOT NULL);
  CREATE TABLE docs(kind TEXT NOT NULL,coll TEXT NOT NULL,id TEXT NOT NULL,doc TEXT NOT NULL,PRIMARY KEY(kind,coll,id));
  CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,password_at TEXT,until INTEGER NOT NULL);
  CREATE INDEX sessions_until ON sessions(until);
  CREATE TABLE search_version(kind TEXT PRIMARY KEY,version INTEGER NOT NULL);
  CREATE VIRTUAL TABLE search USING fts5(kind UNINDEXED,id UNINDEXED,project UNINDEXED,updated UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2',prefix='2 3');PRAGMA user_version=1;`);
 const at='2026-11-01T10:00:00.000Z',bytes=Buffer.from('legacycontentneedle'),sha=createHash('sha256').update(bytes).digest('hex');
 const old={id:'APP-1',project:'legacy-app',title:'Existing ticket',description:'Existing description',type:'task',status:'open',priority:'normal',release:null,assignee:null,labels:[],refs:[],reporter:'alice',createdAt:at,updatedAt:at,closedAt:null,rev:3,comments:[{id:'c1',at,by:'bob',text:'Existing comment'}],history:[],attachments:[{id:'11111111-1111-4111-8111-111111111111',name:'legacy.txt',type:'text/plain',size:bytes.length,sha256:sha,by:'alice',at}]};
 raw.prepare('INSERT INTO meta VALUES(?,?)').run('tickets',JSON.stringify({schema:1,revision:7,updatedAt:at}));
 const put=raw.prepare('INSERT INTO docs VALUES(?,?,?,?)');
 put.run('tickets','projects','legacy-app',JSON.stringify({id:'legacy-app',key:'APP',name:'Legacy app',description:'',type:'app',rev:1,next:2}));
 put.run('tickets','tickets',old.id,JSON.stringify(old));
 raw.close();
 await mkdir(path.join(dir,'attachments'));
 await writeFile(path.join(dir,'attachments',sha),bytes);

 const db=openDb(file),tickets=createTicketStore(dir,{db}),search=createTicketSearch(dir,{db,tickets,ticketFiles:createTicketFiles(dir),env:{}});
 t.after(async()=>{await search.close();db.close();await rm(dir,{recursive:true,force:true});});
 await search.start();
 await search.whenIdle();
 assert.equal((await search.search({query:'legacycontentneedle',mode:'text'})).results[0]?.attachment,old.attachments[0].id);
 assert.equal(db.db.prepare("SELECT doc FROM docs WHERE kind='tickets' AND coll='tickets' AND id=?").get(old.id).doc,JSON.stringify(old));
 assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,DB_SCHEMA);
});

test('HTTP routes and MCP tools enforce read auth, strict input, and avoid double Ticket hydration',async t=>{
 const h=await hub(t,{ticketSearch:{env:{}}}),reader=await h.account('search-reader',[]);
 const state=h.handler.state('tracker');
 t.after(()=>state.ticketSearch.close());
 await state.tickets.saveProject({id:'smoke',key:'SM',name:'Smoke',type:'app'},'alice');
 const smoke=await state.tickets.create({project:'smoke',title:'Smoke example'},'alice');
 const attachment=await state.ticketFiles.put([Buffer.from('smokeneedle')],{name:'smoke.txt'});
 await state.tickets.attach(smoke.id,attachment,'alice');
 await state.ticketSearch.start();
 await state.ticketSearch.whenIdle();

 const hit=await (await fetch(h.origin+'/api/tickets/search/hybrid?query=smokeneedle&mode=text',{headers:reader.headers})).json();
 assertSearchShape(hit);
 assert.equal(hit.results[0].ticket,smoke.id);
 assert.equal(hit.results[0].name,'smoke.txt');

 for(const suffix of ['status','hybrid?query=example'])assert.equal((await fetch(h.origin+'/api/tickets/search/'+suffix)).status,401);
 const stRes=await fetch(h.origin+'/api/tickets/search/status',{headers:reader.headers});
 assert.equal(stRes.status,200);
 assertStatusShape(await stRes.json());
 for(const suffix of ['hybrid?query=example&status=unknown','hybrid?query=example&limit=0','status?unexpected=1']){
  assert.equal((await fetch(h.origin+'/api/tickets/search/'+suffix,{headers:reader.headers})).status,400);
 }

 // Mixed global HTTP search (one title hit + one attachment-only hit) hydrates each ticket at most once.
 const titleOnly=await state.tickets.create({project:'smoke',title:'Mixed sharedneedle title'},'alice');
 const attachOnly=await state.tickets.create({project:'smoke',title:'Mixed plain ticket'},'alice');
 const mixAtt=await state.ticketFiles.put([Buffer.from('sharedneedle inside attachment')],{name:'mix.txt'});
 await state.tickets.attach(attachOnly.id,mixAtt,'alice');
 await state.ticketSearch.whenIdle();

 let listCalls=0;
 const getCounts=new Map();
 const origList=state.tickets.list,origGet=state.tickets.get;
 state.tickets.list=async(...args)=>{listCalls++;return origList(...args);};
 state.tickets.get=async(id,...rest)=>{getCounts.set(id,(getCounts.get(id)??0)+1);return origGet(id,...rest);};
 const globalRes=await (await fetch(h.origin+'/api/search?q=sharedneedle',{headers:reader.headers})).json();
 state.tickets.list=origList;state.tickets.get=origGet;
 assert.deepEqual(new Set(globalRes.results.map(r=>r.id)),new Set([titleOnly.id,attachOnly.id]));
 assert.ok(globalRes.results.every(r=>r.meta?.status==='open'));
 assert.equal(globalRes.attachmentSearch.state,'ready');
 assert.equal(typeof globalRes.attachmentSearch.extraction.attachments,'number');
 assert.equal(listCalls,0,'describeHits never calls tickets.list() on mixed search hits');
 assert.equal(getCounts.get(titleOnly.id),1,'title hit hydrated once');
 assert.equal(getCounts.get(attachOnly.id),1,'attachment-only hit hydrated once');

 // HTTP filter parity: include tickets that violate each individual filter so ignored filters fail the test.
 await state.tickets.saveProject({id:'other',key:'OT',name:'Other',type:'app'},'alice');
 await state.tickets.saveRelease({project:'smoke',version:'1.0.0',status:'planned'},'alice');
 const parityMatch=await state.tickets.create({project:'smoke',title:'parityneedle match',status:'open'},'alice');
 const parityClosed=await state.tickets.create({project:'smoke',title:'parityneedle closed',status:'done'},'alice');
 const parityReleased=await state.tickets.create({project:'smoke',title:'parityneedle released',status:'open',release:'1.0.0'},'alice');
 const parityAssigned=await state.tickets.create({project:'smoke',title:'parityneedle assigned',status:'open',assignee:'bob'},'alice');
 const parityOther=await state.tickets.create({project:'other',title:'parityneedle other',status:'open'},'alice');
 assert.ok(parityClosed.id&&parityReleased.id&&parityAssigned.id);
 await state.ticketSearch.whenIdle();

 const activeHttp=await (await fetch(h.origin+'/api/tickets/search?q=parityneedle&project=smoke&status=active&release=none&assignee=none',{headers:reader.headers})).json();
 const activeHybrid=await (await fetch(h.origin+'/api/tickets/search/hybrid?query=parityneedle&mode=text&project=smoke&status=active&release=none&assignee=none',{headers:reader.headers})).json();
 assert.deepEqual(activeHttp.tickets.map(t=>t.id),[parityMatch.id]);
 assert.deepEqual(activeHybrid.results.map(r=>r.ticket),[parityMatch.id]);
 const globalOther=await (await fetch(h.origin+'/api/search?q=parityneedle&project=other',{headers:reader.headers})).json();
 assert.deepEqual(globalOther.results.map(r=>r.id),[parityOther.id]);
 const globalSmoke=await (await fetch(h.origin+'/api/search?q=parityneedle&project=smoke',{headers:reader.headers})).json();
 assert.deepEqual(new Set(globalSmoke.results.map(r=>r.id)),new Set([parityMatch.id,parityClosed.id,parityReleased.id,parityAssigned.id]));
 assert.equal((await fetch(h.origin+'/api/search?q=parityneedle&status=active',{headers:reader.headers})).status,400);

 // Global hybrid search while semantic is disabled preserves ticket+attachment hits and excludes reviews.
 const reviewHtml='<p>hybriddisabledneedle</p>';
 const revRes=await h.post('/api/review/publish',{project:'smoke',title:'hybriddisabledneedle review',items:[{id:'hyb',title:'hybriddisabledneedle',kind:'html',variants:[{id:'a',media:[{type:'text/html',html:reviewHtml}]},{id:'b',media:[{type:'text/html',html:reviewHtml+' '}]}]}]},h.admin);
 assert.equal(revRes.status,201);
 const hybridAttachTicket=await state.tickets.create({project:'smoke',title:'Hybrid plain'},'alice');
 const hybridAtt=await state.ticketFiles.put([Buffer.from('hybriddisabledneedle attachment content')],{name:'hyb.txt'});
 await state.tickets.attach(hybridAttachTicket.id,hybridAtt,'alice');
 await state.ticketSearch.whenIdle();
 const hybridDisabled=await (await fetch(h.origin+'/api/search?q=hybriddisabledneedle&mode=hybrid',{headers:reader.headers})).json();
 assert.equal(hybridDisabled.mode,'text');
 assert.equal(hybridDisabled.semanticAvailable,false);
 assert.equal(hybridDisabled.attachmentSearch.state,'ready');
 assert.deepEqual(hybridDisabled.results.map(r=>[r.kind,r.id]),[['ticket',hybridAttachTicket.id]]);

 const rpc=async(name,args)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...reader.headers,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 assert.equal((await rpc('ticket_search_status',{})).isError,false);
 assert.equal((await rpc('ticket_hybrid_search',{query:'example',mode:'text'})).isError,false);
 assert.equal((await rpc('ticket_hybrid_search',{query:'example',limit:1.5})).isError,true);
});

test('lexical edits stay searchable while an embedding batch is pending, and early-exit keeps coverage.extraction',async t=>{
 let releaseBatch,batchStarted;
 const startedPromise=new Promise(r=>{batchStarted=r;});
 const pendingBatch=new Promise(r=>{releaseBatch=r;});
 let calls=0;
 const embed=async texts=>{
  calls++;
  if(calls===1){batchStarted();await pendingBatch;}
  return texts.map(()=>[1,0]);
 };
 const {tickets,search}=await fixture(t,{embed,semanticEnabled:true});
 const t1=await tickets.create({project:'sample',title:'initial alpha'},'alice');
 // Before first build finishes, early-exit response carries both top-level extraction and legacy coverage.extraction.
 const early=await search.search({query:'alpha',mode:'text'});
 assert.equal(early.state,'indexing');
 assert.equal(typeof early.extraction.attachments,'number');
 assert.equal(typeof early.coverage.extraction.attachments,'number');

 await startedPromise;
 // While the first embedding batch is blocked in flight, edit the ticket and verify lexical search updates immediately.
 await tickets.update({id:t1.id,rev:t1.rev,title:'updated concurrentlexicalword'},'alice');
 for(let i=0;i<40;i++){
  const res=await search.search({query:'concurrentlexicalword',mode:'text'});
  if(res.state==='ready'&&res.results.length===1){
   assert.equal(res.results[0].ticket,t1.id);
   break;
  }
  if(i===39)assert.fail('lexical edit did not become searchable while embedding batch was pending');
  await new Promise(r=>setTimeout(r,20));
 }
 releaseBatch();
 await search.whenIdle();
 assertStatusShape(search.status());
 assert.equal(search.status().state,'ready');
});

test('constructor-option provider keeps base cache fingerprint, opt-out during searchAll drops semantic hits, and standalone whenIdle stays alive',async t=>{
 // 1. Constructor options {url, model} share the same fingerprint as base ticketSearchSettings({}) when modelFingerprint is omitted.
 let fetchCalls=0;
 const fetchImpl=async(url,init)=>{
  fetchCalls++;
  const body=JSON.parse(init.body);
  return new Response(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0]}))}),{status:200,headers:{'content-type':'application/json'}});
 };
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-fp-'));
 const db=openDb(path.join(dir,'hub.db'));
 const tickets=createTicketStore(dir,{db,seedProjects:[{id:'sample',key:'SM',name:'Sample',type:'app'}]});
 const files=createTicketFiles(dir);
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 await tickets.create({project:'sample',title:'warm cache check'},'alice');
 const first=createTicketSearch(dir,{db,tickets,ticketFiles:files,env:{},url:'http://127.0.0.1:8081/v1/embeddings',model:'embed-m',fetchImpl,semanticEnabled:true});
 await first.start();await first.whenIdle();
 const baseModel=first.status().model;
 assert.equal(baseModel,ticketSearchSettings({}).modelFingerprint);
 assert.equal(fetchCalls,1);
 await first.close();
 const second=createTicketSearch(dir,{db,tickets,ticketFiles:files,env:{},url:'http://127.0.0.1:8081/v1/embeddings',model:'embed-m',fetchImpl,semanticEnabled:true});
 await second.start();await second.whenIdle();
 assert.equal(fetchCalls,1,'reopening with identical constructor url/model reuses warm vector cache');
 assert.deepEqual(second.status().provider,{configured:true,model:'embed-m'});
 await second.close();

 // 2. Disabling semantic search while searchAll() awaits ticket metadata discards semantic hits and reports semanticAvailable: false.
 const embed=async texts=>texts.map(()=>[1,0]);
 const f=await fixture(t,{embed,semanticEnabled:true});
 const tk=await f.tickets.create({project:'sample',title:'unrelated alpha'},'alice');
 await f.search.start();await f.search.whenIdle();
 let releaseGet,getEntered;
 const entered=new Promise(r=>{getEntered=r;});
 const blocked=new Promise(r=>{releaseGet=r;});
 const origGet=f.tickets.get;
 f.tickets.get=async(...args)=>{getEntered();await blocked;return origGet(...args);};
 const pendingSearch=f.search.searchAll({q:'conceptquery',mode:'semantic'});
 await entered;
 await f.search.setEnabled({enabled:false});
 releaseGet();
 f.tickets.get=origGet;
 const afterOptOut=await pendingSearch;
 assert.equal(afterOptOut.semanticAvailable,false);
 assert.deepEqual(afterOptOut.results,[]);
 assert.equal(afterOptOut.attachmentSearch.state,'disabled');

 // 3. Standalone caller awaiting whenIdle() with pending backfill exits 0 (event loop stays alive).
 const {spawnSync}=await import('node:child_process');
 const script=`
  import {mkdtempSync,rmSync} from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import {openDb} from ${JSON.stringify(new URL('../server/db.mjs',import.meta.url).href)};
  import {createTicketStore} from ${JSON.stringify(new URL('../server/tickets-store.mjs',import.meta.url).href)};
  import {createTicketFiles} from ${JSON.stringify(new URL('../server/ticket-files.mjs',import.meta.url).href)};
  import {createTicketSearch} from ${JSON.stringify(new URL('../server/ticket-search.mjs',import.meta.url).href)};
  const dir=mkdtempSync(path.join(os.tmpdir(),'ts-idle-'));
  const db=openDb(path.join(dir,'hub.db'));
  const tickets=createTicketStore(dir,{db,seedProjects:[{id:'s',key:'SM',name:'S',type:'app'}]});
  const files=createTicketFiles(dir);
  await tickets.create({project:'s',title:'standalone idle test'},'alice');
  const search=createTicketSearch(dir,{db,tickets,ticketFiles:files,env:{},embed:async texts=>texts.map(()=>[1,0]),semanticEnabled:true});
  try{
   const st=await search.whenIdle();
   if(st.state!=='ready'||st.embedded<1)process.exit(2);
  }finally{await search.close();db.close();rmSync(dir,{recursive:true,force:true});}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,`standalone whenIdle exited with ${child.status}: ${child.stderr}`);

 // 4. Hybrid opt-out during searchAll hydration returns ticket-only lexical results with zero semantic hits and zero reviews.
 const fHyb=await fixture(t,{embed,semanticEnabled:true});
 const lexTk=await fHyb.tickets.create({project:'sample',title:'hyboptoutword ticket'},'alice');
 const semOnlyTk=await fHyb.tickets.create({project:'sample',title:'completely unrelated'},'alice');
 assert.ok(semOnlyTk.id);
 await fHyb.search.start();await fHyb.search.whenIdle();
 let relHyb,entHyb;
 const hybEntered=new Promise(r=>{entHyb=r;}),hybBlocked=new Promise(r=>{relHyb=r;});
 const origHybGet=fHyb.tickets.get;
 let pausedOnce=false;
 fHyb.tickets.get=async(...args)=>{
  if(!pausedOnce){pausedOnce=true;entHyb();await hybBlocked;}
  return origHybGet(...args);
 };
 const hybPending=fHyb.search.searchAll({q:'hyboptoutword',mode:'hybrid'});
 await hybEntered;
 await fHyb.search.setEnabled({enabled:false});
 relHyb();
 fHyb.tickets.get=origHybGet;
 const hybAfter=await hybPending;
 assert.equal(hybAfter.mode,'text');
 assert.equal(hybAfter.semanticAvailable,false);
 assert.deepEqual(hybAfter.results.map(r=>r.id),[lexTk.id]);

 // 5. Backward wall-clock adjustment during retry delay never strands embedding or extraction retries.
 const origDateNow=Date.now;
 let offsetMs=0;
 Date.now=()=>origDateNow()+offsetMs;
 t.after(()=>{Date.now=origDateNow;});
 let embedAttempts=0;
 const flakyEmbed=async texts=>{
  embedAttempts++;
  if(embedAttempts===1){offsetMs=-250;throw new Error('transient');}
  return texts.map(()=>[1,0]);
 };
 const fClock=await fixture(t,{embed:flakyEmbed,semanticEnabled:true,retryMs:40,maxRetries:2});
 await fClock.tickets.create({project:'sample',title:'clock jump test'},'alice');
 await fClock.search.start();
 const deadline=origDateNow()+2000;
 while(fClock.search.status().state!=='ready'&&origDateNow()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal(fClock.search.status().state,'ready','embedding retry completes even when wall clock moves backwards');
 assert.ok(embedAttempts>=2);
});
