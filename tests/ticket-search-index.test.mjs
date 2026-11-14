import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTicketSearchIndex} from '../server/ticket-search-index.mjs';
const doc=(id,text,project='p')=>({id,ticket:id,project,source:'ticket',text,fields:{status:'open'}});
async function setup(t,options={}){const dir=await mkdtemp(path.join(tmpdir(),'ticket-index-'));const index=createTicketSearchIndex(dir,options);t.after(async()=>{await index.close();await rm(dir,{recursive:true,force:true});});return {dir,index};}
test('persistent shared content cache, filtering, threshold and restart',async t=>{
 let calls=0;const embed=async texts=>{calls++;return texts.map(s=>s==='unrelated'?[0,1]:[1,0]);};
 const {dir,index}=await setup(t,{embed,modelFingerprint:'fixture'});
 index.sync([doc('a','needle'),doc('b','needle','other')]);await index.whenIdle();assert.equal(calls,1);
 assert.equal((await index.search({query:'needle',project:'other'})).results[0].ticket,'b');
 assert.deepEqual((await index.search({query:'unrelated',mode:'semantic'})).results,[]);
 await index.close();const warm=createTicketSearchIndex(dir,{embed,modelFingerprint:'fixture'});t.after(()=>warm.close());assert.equal(warm.status().embedded,2);
 const before=calls;await warm.whenIdle();assert.equal(calls,before);assert.equal((await stat(path.join(dir,'ticket-search.db'))).mode&0o777,0o600);
});
test('removal cancels stale generation and source groups deduplicate',async t=>{
 let finish;const {index}=await setup(t,{embed:()=>new Promise(r=>{finish=r;})});
 index.sync([doc('a','old')]);await new Promise(r=>setTimeout(r,10));index.sync([]);finish([[1,0]]);await index.whenIdle();assert.equal(index.status().chunks,0);
 const d=doc('a','needle');index.sync([{...d,source:'attachment',attachment:'file'},{...d,id:'b',source:'attachment',attachment:'file'}]);
 assert.equal((await index.search({query:'needle',mode:'text'})).results.length,1);
});
test('bounded retries report failure; disabled semantic is explicit',async t=>{
 let calls=0;const {index}=await setup(t,{embed:async()=>{calls++;throw new Error('sensitive');},retryMs:1,maxRetries:1});index.sync([doc('a','text')]);await index.whenIdle();assert.equal(calls,2);assert.equal(index.status().failed,1);assert.equal(index.status().state,'degraded');
 const {index:off}=await setup(t);off.sync([doc('a','needle')]);const result=await off.search({query:'needle',mode:'semantic'});assert.equal(result.state,'disabled');assert.deepEqual(result.results,[]);
});
test('model invalidation and bounded vector capacity settle',async t=>{
 const {dir,index}=await setup(t,{embed:async x=>x.map(()=>[1,0]),maxVectors:1});index.sync([doc('a','one'),doc('b','two')]);await index.whenIdle();assert.equal(index.status().embedded,1);assert.equal(index.status().failed,1);await index.close();const next=createTicketSearchIndex(dir,{embed:async x=>x.map(()=>[0,1]),modelFingerprint:'changed'});t.after(()=>next.close());assert.equal(next.status().embedded,0);await next.whenIdle();assert.equal(next.status().embedded,2);
});
test('invalid dimensions retry without caching, later success and query reuse',async t=>{
 let fail=true,queries=0;const {index}=await setup(t,{retryMs:1,embed:async(texts,{query}={})=>{if(query)queries++;if(fail){fail=false;return [[NaN,0]];}return texts.map(()=>[1,0]);}});
 index.sync([doc('a','needle')]);await index.whenIdle();assert.equal(index.status().embedded,1);
 await index.search({query:'needle'});await index.search({query:'needle'});assert.equal(queries,1);
 index.sync([doc('a','replacement')]);assert.equal((await index.search({query:'needle',mode:'text'})).results.length,0);await index.whenIdle();
});
test('close prevents late provider writes even if provider ignores cancellation',async t=>{
 let finish;const {index}=await setup(t,{embed:()=>new Promise(r=>{finish=r;})});index.sync([doc('a','old')]);await new Promise(r=>setTimeout(r,10));await index.close();finish([[1,0]]);await new Promise(r=>setTimeout(r,10));assert.throws(()=>index.status(),/closed/);
});

test('canonical filter aliases and searchable attachment metadata agree with the tracker',async t=>{
 const {index}=await setup(t);const fields={status:'open',release:null,assignee:null,labels:['evidence']};
 index.sync(['open','in-progress','done'].map((status,i)=>({...doc('APP-'+(i+1),'needle','example-app'),fields:{...fields,status}})));
 for(const[filter,count]of [[{status:'active'},2],[{status:'open,in-progress'},2],[{status:''},3],[{release:'none'},3],[{assignee:'none'},3]])assert.equal((await index.search({query:'needle',mode:'text',...filter})).results.length,count);
 index.sync([{...doc('file','body','example-app'),ticket:'APP-1',source:'attachment',attachment:'att-unique42',at:'2026-11-14T12:34:56Z',name:'file.txt',size:12345,sha256:'a'.repeat(64),fields}]);
 for(const query of ['att-unique42','2026-11-14T12:34:56Z','12345','a'.repeat(64)])assert.equal((await index.search({query,mode:'text'})).results[0]?.attachment,'att-unique42',query);
});

test('unrelated natural-language queries do not match a stopword alone; prefixes still work',async t=>{
 const {index}=await setup(t);index.sync([doc('APP-1','A generated fixture for testing and evaluation.','example-app')]);
 assert.equal((await index.search({query:'swimming technique for butterfly stroke',mode:'text'})).results.length,0);
 assert.equal((await index.search({query:'evalu',mode:'text'})).results.length,1);
});

test('concurrent identical semantic queries share one provider request',async t=>{
 let calls=0,release,entered;const started=new Promise(r=>{entered=r;});
 const {index}=await setup(t,{embed:async(texts,{query}={})=>{calls++;if(query){entered();await new Promise(r=>{release=r;});}return texts.map(()=>[1,0]);}});
 index.sync([doc('APP-1','evidence','example-app')]);await index.whenIdle();
 const queries=Array.from({length:8},()=>index.search({query:'paraphrase',mode:'semantic'}));await started;release();const results=await Promise.all(queries);
 assert.equal(calls,2);assert.ok(results.every(r=>r.state==='ready'&&r.results[0]?.ticket==='APP-1'));
});

test('metadata edits preserve in-flight content work, and partial sync preserves other sources',async t=>{
 let release,entered,calls=0;const started=new Promise(r=>{entered=r;});
 const {index}=await setup(t,{embed:async texts=>{calls++;entered();await new Promise(r=>{release=r;});return texts.map(()=>[1,0]);}});
 const a=doc('APP-1','same evidence','example-app'),b=doc('APP-2','other evidence','example-app');index.sync([a,b]);await started;
 index.sync([{...a,fields:{status:'done'}}],{revision:2,replaceTickets:['APP-1']});release();await index.whenIdle();
 assert.equal(calls,1);assert.equal(index.status().embedded,2);assert.equal((await index.search({query:'other',mode:'text'})).results[0].ticket,'APP-2');
 assert.equal((await index.search({query:'same',status:'done',mode:'text'})).results[0].ticket,'APP-1');
});

test('failed backfills can recover without reopening, and stale queries cannot cite removed sources',async t=>{
 let failing=true,queryStarted,release;const queryGate=new Promise(r=>{queryStarted=r;});
 const {index}=await setup(t,{maxRetries:0,recoveryMs:60000,embed:async(texts,{query}={})=>{if(failing)throw new Error('offline');if(query){queryStarted();await new Promise(r=>{release=r;});}return texts.map(()=>[1,0]);}});
 index.sync([doc('APP-1','evidence','example-app')]);await index.whenIdle();assert.equal(index.status().state,'degraded');
 failing=false;index.retryFailed();await index.whenIdle();assert.equal(index.status().state,'ready');
 const pending=index.search({query:'question',mode:'semantic'});await queryGate;index.sync([]);release();const result=await pending;assert.equal(result.state,'indexing');assert.deepEqual(result.results,[]);
});

test('vector eviction survives a backwards wall clock and a model change without re-embedding loops',async t=>{
 const {dir,index}=await setup(t,{maxVectors:1,embed:async texts=>texts.map(()=>[1,0])});index.sync([doc('APP-1','evidence','example-app')]);await index.whenIdle();await index.close();
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite'),db=new DatabaseSync(path.join(dir,'ticket-search.db'));db.prepare('UPDATE vectors SET used=?').run(Date.now()+1000000);db.close();
 let calls=0;const next=createTicketSearchIndex(dir,{maxVectors:1,maxRetries:0,modelFingerprint:'new-model',embed:async texts=>{assert.ok(++calls<=1,'a successful active vector must survive eviction');return texts.map(()=>[0,1]);}});t.after(()=>next.close());await next.whenIdle();assert.equal(calls,1);assert.equal(next.status().embedded,1);
});

test('a rolled-back vector batch cannot appear successfully cached in memory',async t=>{
 const {dir,index}=await setup(t,{maxRetries:0,embed:async texts=>texts.map(()=>[1,0])});
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite'),db=new DatabaseSync(path.join(dir,'ticket-search.db'));
 const hash=(await import('node:crypto')).createHash('sha256').update('second evidence').digest('hex');
 db.exec(`CREATE TRIGGER fail_batch BEFORE INSERT ON vectors WHEN NEW.hash='${hash}' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;`);
 index.sync([doc('APP-1','first evidence','example-app'),doc('APP-2','second evidence','example-app')]);await index.whenIdle();
 assert.equal(index.status().embedded,0);assert.equal(db.prepare('SELECT count(*) n FROM vectors').get().n,0);assert.equal(index.status().failed,2);
 db.exec('DROP TRIGGER fail_batch');db.close();index.retryFailed();await index.whenIdle();assert.equal(index.status().embedded,2);
});

test('a deferred cache does not send persisted text before canonical reconciliation',async t=>{
 const {dir,index}=await setup(t,{embed:async texts=>texts.map(()=>[1,0]),modelFingerprint:'old'});index.sync([doc('APP-1','previously cached text','example-app')]);await index.whenIdle();await index.close();
 let calls=0;const deferred=createTicketSearchIndex(dir,{autoStart:false,modelFingerprint:'new',embed:async texts=>{calls++;return texts.map(()=>[1,0]);}});t.after(()=>deferred.close());
 await deferred.whenIdle();assert.equal(calls,0);deferred.sync([]);await deferred.whenIdle();assert.equal(calls,0);assert.equal(deferred.status().chunks,0);
});

test('an exhausted provider failure recovers automatically after its cooldown',async t=>{
 let failing=true,calls=0;const {index}=await setup(t,{maxRetries:0,recoveryMs:15,embed:async texts=>{calls++;if(failing)throw new Error('offline');return texts.map(()=>[1,0]);}});
 index.sync([doc('APP-1','evidence','example-app')]);await index.whenIdle();assert.equal(index.status().state,'degraded');failing=false;
 const deadline=Date.now()+1000;while(index.status().state!=='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
 assert.equal(index.status().state,'ready');assert.equal(calls,2);
});
