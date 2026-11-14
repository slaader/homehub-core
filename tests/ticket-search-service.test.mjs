import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createTicketFiles} from '../server/ticket-files.mjs';
import {createTicketSearchService,textChunks,ticketSearchSettings} from '../server/ticket-search-service.mjs';
import {hub} from './hub-helper.mjs';
import {openDb} from '../server/db.mjs';
import {createHash} from 'node:crypto';
import {createTicketSearchIndex} from '../server/ticket-search-index.mjs';

async function fixture(t,options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-regression-')),db=openDb(path.join(dir,'hub.db'));
 const tickets=createTicketStore(dir,{db,seedProjects:[{id:'sample',key:'SM',name:'Sample',type:'app'}]}),files=createTicketFiles(dir);
 const service=createTicketSearchService(dir,{tickets,ticketFiles:files,env:{},...options});
 t.after(async()=>{await service.close();db.close();await rm(dir,{recursive:true,force:true});});return {dir,db,tickets,files,service};
}

test('search extraction: older canonical state, complete Unicode text, coverage and incremental removal',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'tickets.json'),JSON.stringify({schema:1,revision:0,updatedAt:null,projects:[{id:'sample',key:'HH',name:'Sample',type:'app',rev:1,next:1}],releases:[],tickets:[]}));
 const tickets=createTicketStore(dir),ticketFiles=createTicketFiles(dir);let docs=[],syncs=0;
 const service=createTicketSearchService(dir,{tickets,ticketFiles,env:{},indexFactory:()=>({status:()=>({state:'disabled'}),sync:d=>{docs=d;syncs++;},search:async()=>({results:docs}),close:async()=>{}})});
 t.after(()=>service.close());
 const ticket=await tickets.create({project:'sample',title:'Start',description:'Initial'},'alice');
 const text='🦊'.repeat(1601)+' finalneedle';
 const file=await ticketFiles.put([Buffer.from(text)],{name:'unicode.txt'});
 let attached=await tickets.attach(ticket.id,file,'alice');
 for(const [name,bytes,type] of [['broken.txt',Buffer.from([0xff]),'text/plain'],['big.txt',Buffer.alloc(256*1024+1,65),'text/plain'],['binary.bin',Buffer.from('binary'),'application/octet-stream']]){
  const f=await ticketFiles.put([bytes],{name});attached=await tickets.attach(ticket.id,{...f,type},'alice');
 }
 attached=await tickets.attach(ticket.id,{name:'missing.txt',type:'text/plain',size:5,sha256:'a'.repeat(64)},'alice');
 assert.equal(syncs,0,'writes never call the index');service.start();await service.whenIdle();
 assert.deepEqual(service.status().extraction,{attachments:5,indexed:1,unsupported:1,oversize:1,invalid:1,missing:1,capacity:0,metadataCapacity:0,ticketCapacity:0});
 assert.ok(docs.some(d=>d.text.includes('finalneedle')&&d.attachment===attached.attachments[0].id));
 assert.ok(docs.some(d=>d.text.includes('missing.txt')));
 assert.ok(docs.every(d=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(d.text)));
 await tickets.comment({id:ticket.id,text:'new comment evidence'},'alice');
 assert.equal((await service.search({query:'new'})).state,'indexing');await service.whenIdle();assert.ok(docs.some(d=>d.text.includes('new comment evidence')));
 await tickets.detach({id:ticket.id,attachment:attached.attachments[0].id},'alice');await service.whenIdle();
 assert.ok(!docs.some(d=>d.attachment===attached.attachments[0].id));
 for(const args of [{query:'x',status:'invalid'},{query:'x',limit:0},{query:'x',arbitrary:'path'},{query:'x',mode:'unknown'},{query:'x',minScore:NaN}])await assert.rejects(service.search(args),/invalid/);
 await service.close();await tickets.comment({id:ticket.id,text:'after close'},'alice');assert.equal(service.status().extracting,false);
});

test('search chunks cover complete content and configuration is optional and validated',()=>{
 const chunks=textChunks('🦊'.repeat(1800));assert.equal(chunks.length,3);assert.equal(Array.from(chunks[0]).length,800);
 assert.equal(ticketSearchSettings({}).url,undefined);
 assert.throws(()=>ticketSearchSettings({HOME_HUB_TICKET_EMBEDDING_URL:'https://example.com'}),/configuration/);
 assert.throws(()=>ticketSearchSettings({HOME_HUB_TICKET_SEARCH_MIN_SCORE:'bad'}),/minimum/);
});

test('hybrid HTTP routes and MCP tools enforce normal read auth and strict input',async t=>{
 const h=await hub(t,{ticketSearch:{env:{}}}),reader=await h.account('search-reader',[]);
 const state=h.handler.state('tracker');t.after(()=>state.ticketSearch.close());
 await state.tickets.saveProject({id:'smoke',key:'SM',name:'Smoke',type:'app'},'alice');
 const smoke=await state.tickets.create({project:'smoke',title:'Smoke example'},'alice');
 const attachment=await state.ticketFiles.put([Buffer.from('smokeneedle')],{name:'smoke.txt'});await state.tickets.attach(smoke.id,attachment,'alice');
 state.ticketSearch.start();await state.ticketSearch.whenIdle();
 const hit=await (await fetch(h.origin+'/api/tickets/search/hybrid?query=smokeneedle&mode=text',{headers:reader.headers})).json();assert.equal(hit.results[0].ticket,smoke.id);assert.equal(hit.results[0].name,'smoke.txt');
 for(const suffix of ['status','hybrid?query=example'])assert.equal((await fetch(h.origin+'/api/tickets/search/'+suffix)).status,401);
 assert.equal((await fetch(h.origin+'/api/tickets/search/status',{headers:reader.headers})).status,200);
 for(const suffix of ['hybrid?query=example&status=unknown','hybrid?query=example&limit=0','status?unexpected=1'])assert.equal((await fetch(h.origin+'/api/tickets/search/'+suffix,{headers:reader.headers})).status,400);
 const rpc=async(name,args)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...reader.headers,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 assert.equal((await rpc('ticket_search_status',{})).isError,false);
 assert.equal((await rpc('ticket_hybrid_search',{query:'example',mode:'text'})).isError,false);
 assert.equal((await rpc('ticket_hybrid_search',{query:'example',limit:1.5})).isError,true);
});

test('real service searches complete attachment contents and metadata with text provider disabled',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-real-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tickets=createTicketStore(dir,{seedProjects:[{id:'sample',key:'HH',name:'Sample',type:'app'}]}),ticketFiles=createTicketFiles(dir);
 const ticket=await tickets.create({project:'sample',title:'Network plan'},'alice');
 const file=await ticketFiles.put([Buffer.from('prefix '.repeat(300)+' rarecontentneedle')],{name:'distinctmetadata.txt'});
 const attached=await tickets.attach(ticket.id,file,'alice');
 const service=createTicketSearchService(dir,{tickets,ticketFiles,env:{}});t.after(()=>service.close());service.start();await service.whenIdle();
 for(const query of ['rarecontentneedle','distinctmetadata']){
  const result=await service.search({query,mode:'text'});assert.equal(result.results.length,1);assert.equal(result.results[0].attachment,attached.attachments[0].id);assert.equal(result.results[0].source,'attachment');
 }
 assert.equal((await service.search({query:'rarecontentneedle',type:'bug',mode:'text'})).results.length,0);
 await tickets.detach({id:ticket.id,attachment:attached.attachments[0].id},'alice');await service.whenIdle();assert.equal((await service.search({query:'rarecontentneedle',mode:'text'})).results.length,0);
});

test('service discards a snapshot changed during asynchronous extraction',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tickets=createTicketStore(dir,{seedProjects:[{id:'sample',key:'HH',name:'Sample',type:'app'}]});
 const ticket=await tickets.create({project:'sample',title:'Original'},'alice');
 const attached=await tickets.attach(ticket.id,{name:'race.txt',type:'text/plain',size:5,sha256:'b'.repeat(64)},'alice');
 let entered,release;const gate=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});const published=[];
 const service=createTicketSearchService(dir,{tickets,env:{},ticketFiles:{readText:async()=>{entered();await wait;return {state:'indexed',text:'removed evidence'};}},indexFactory:()=>({status:()=>({state:'disabled'}),sync:docs=>published.push(docs),search:async()=>({results:[]}),close:async()=>{}})});
 t.after(()=>service.close());service.start();const idle=service.whenIdle();await gate;
 await tickets.detach({id:ticket.id,attachment:attached.attachments[0].id},'alice');release();await idle;
 assert.equal(published.length,1);assert.ok(published[0].every(d=>d.source==='ticket'));
});

test('canonical filter aliases work through the complete service and empty filters are ignored',async t=>{
 const {tickets,service}=await fixture(t);await tickets.create({project:'sample',title:'needle'},'alice');service.start();await service.whenIdle();
 for(const filter of [{status:'active'},{status:'open,in-progress'},{status:''},{release:'none'},{assignee:'none'}])assert.equal((await service.search({query:'needle',mode:'text',...filter})).results.length,1);
});

test('editing one ticket reuses file extraction and preserves unrelated indexed sources',async t=>{
 const {tickets,files,service}=await fixture(t);let reads=0;const read=files.readText;files.readText=async(...args)=>{reads++;return read(...args);};
 const a=await tickets.create({project:'sample',title:'First'},'alice'),b=await tickets.create({project:'sample',title:'Second'},'alice');
 for(const [ticket,text]of [[a,'firstfileneedle'],[b,'secondfileneedle']])await tickets.attach(ticket.id,await files.put([Buffer.from(text)],{name:ticket.id+'.txt'}),'alice');
 service.start();await service.whenIdle();assert.equal(reads,2);
 await tickets.comment({id:a.id,text:'freshcommentneedle'},'alice');await service.whenIdle();assert.equal(reads,2,'an ordinary edit does not reread attachments');
 assert.equal((await service.search({query:'freshcommentneedle',mode:'text'})).results[0].ticket,a.id);
 assert.equal((await service.search({query:'secondfileneedle',mode:'text'})).results[0].ticket,b.id);
});

test('document capacity reports skipped complete contents while keeping ticket and file metadata searchable',async t=>{
 const {tickets,files,service}=await fixture(t,{maxDocuments:5});const ticket=await tickets.create({project:'sample',title:'ticketneedle'},'alice');
 await tickets.attach(ticket.id,await files.put([Buffer.from('a'.repeat(5000)+' tailneedle')],{name:'largefilemetadata.txt'}),'alice');
 service.start();await service.whenIdle();assert.equal(service.status().state,'degraded');assert.equal(service.status().extraction.capacity,1);
 assert.equal((await service.search({query:'ticketneedle',mode:'text'})).results[0].ticket,ticket.id);
 assert.equal((await service.search({query:'largefilemetadata',mode:'text'})).results[0].source,'attachment');
 assert.equal((await service.search({query:'tailneedle',mode:'text'})).results.length,0,'omitted content is never presented as fully indexed');
});

test('transient extraction failures recover; exhausted failures settle as degraded instead of indexing forever',async t=>{
 const {tickets,service}=await fixture(t,{buildRetryMs:1,maxBuildRetries:1});await tickets.create({project:'sample',title:'recoveredneedle'},'alice');
 const read=tickets.searchSnapshot;let calls=0;tickets.searchSnapshot=async()=>{if(++calls===1)throw new Error('temporary');return read();};
 service.start();await service.whenIdle();assert.equal(calls,2);assert.equal((await service.search({query:'recoveredneedle',mode:'text'})).results.length,1);
 tickets.searchSnapshot=async()=>{throw new Error('sensitive internal error');};await tickets.comment({id:'SM-1',text:'change'},'alice');await service.whenIdle();
 assert.equal(service.status().state,'degraded');assert.equal(service.status().extracting,false);assert.ok(!JSON.stringify(service.status()).includes('sensitive'));
});

test('shutdown during blocked extraction prevents late publication and releases idle waiters',async t=>{
 let entered,release;const gate=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});
 const {tickets,files,service}=await fixture(t);const ticket=await tickets.create({project:'sample',title:'Closing'},'alice');
 await tickets.attach(ticket.id,await files.put([Buffer.from('latefile')],{name:'late.txt'}),'alice');files.readText=async()=>{entered();await wait;return {state:'indexed',text:'latefile'};};
 service.start();const idle=service.whenIdle();const rejected=assert.rejects(idle,/closed/);await gate;await service.close();await rejected;release();await new Promise(r=>setImmediate(r));assert.equal(service.status().state,'closed');
});

test('a canonical write during a semantic query invalidates its citations',async t=>{
 let entered,release;const gate=new Promise(r=>{entered=r;});
 const {tickets,service}=await fixture(t,{embed:async(texts,{query}={})=>{if(query){entered();await new Promise(r=>{release=r;});}return texts.map(()=>[1,0]);}});
 const ticket=await tickets.create({project:'sample',title:'Before'},'alice');service.start();await service.whenIdle();const pending=service.search({query:'meaning',mode:'semantic'});await gate;
 await tickets.update({id:ticket.id,rev:ticket.rev,title:'After'},'alice');release();assert.deepEqual((await pending).results,[]);await service.whenIdle();
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
 raw.prepare('INSERT INTO meta VALUES(?,?)').run('tickets',JSON.stringify({schema:1,revision:7,updatedAt:at}));const put=raw.prepare('INSERT INTO docs VALUES(?,?,?,?)');put.run('tickets','projects','legacy-app',JSON.stringify({id:'legacy-app',key:'APP',name:'Legacy app',description:'',type:'app',rev:1,next:2}));put.run('tickets','tickets',old.id,JSON.stringify(old));raw.close();
 await mkdir(path.join(dir,'attachments'));await writeFile(path.join(dir,'attachments',sha),bytes);
 const db=openDb(file),tickets=createTicketStore(dir,{db}),service=createTicketSearchService(dir,{tickets,ticketFiles:createTicketFiles(dir),env:{}});
 t.after(async()=>{await service.close();db.close();await rm(dir,{recursive:true,force:true});});service.start();await service.whenIdle();
 assert.equal((await service.search({query:'legacycontentneedle',mode:'text'})).results[0].attachment,old.attachments[0].id);
 assert.equal(db.db.prepare("SELECT doc FROM docs WHERE kind='tickets' AND coll='tickets' AND id=?").get(old.id).doc,JSON.stringify(old));assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,1);
});

test('startup reconciles stale cached sources before sending them to a changed provider',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ticket-search-startup-')),index=createTicketSearchIndex(path.join(dir,'search'),{modelFingerprint:'old',embed:async texts=>texts.map(()=>[1,0])});
 index.sync([{id:'APP-1',ticket:'APP-1',project:'sample',source:'ticket',text:'removed cached source',fields:{status:'open'}}]);await index.whenIdle();await index.close();
 let entered,release,calls=0;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 const tickets={searchSnapshot:async()=>{entered();await gate;return {revision:0,tickets:[]};},searchRevision:()=>0,onSearchChange:()=>()=>{}};
 const service=createTicketSearchService(dir,{tickets,ticketFiles:{},env:{},modelFingerprint:'new',embed:async texts=>{calls++;return texts.map(()=>[1,0]);}});t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 service.start();const idle=service.whenIdle();await started;assert.equal(calls,0);release();await idle;assert.equal(calls,0);assert.equal(service.status().chunks,0);
});
