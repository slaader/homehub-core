import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {hub} from './hub-helper.mjs';
import {siteOverrideHash} from '../server/home-devices.mjs';
import {openDb,DB_SCHEMA} from '../server/db.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createWikiStore} from '../server/wiki-store.mjs';
import {createMentionGuard,createReferences} from '../server/references.mjs';
import {referenceToken} from '../public/reference-format.js';
import {markdownReferences} from '../public/tracker-markdown-format.js';
import {extractLinks,normalizeDoc} from '../public/wiki-doc.js';

const project='home-hub',other='sample-game',base='/api/references';
const custom={kind:'custom',id:'r'+'a'.repeat(32),label:'Unit [A] \\ guide'};
const doc=c=>({v:1,blocks:[{t:'inventory',id:'units',columns:[{id:'name',label:'Name'}],
 rows:[{id:'first',cells:{name:{c}}}]}]});
const run=({kind,id,label})=>({t:'ref',kind,id,label});
test('reference syntax round-trips in prose and inventory cells without interpreting literal examples',()=>{
 const token=referenceToken(custom);
 const styled={...custom,label:'Build **debug** and *test*'};
 assert.deepEqual(markdownReferences('**'+referenceToken(styled)+'**').map(r=>r.label),[styled.label]);
 assert.deepEqual(markdownReferences('*'+referenceToken(styled)+'*').map(r=>r.label),[styled.label]);
 const md=['**'+token+'**'];
 md.push('\\'+token,'`'+token+'`','```',token,'```','![HH-2]','HH-1','3. '+token);
 const links=markdownReferences(md.join('\n'),{keys:['HH'],attachmentNames:['HH-2']});
 assert.deepEqual(links.map(r=>[r.kind,r.id,r.label]),[[custom.kind,custom.id,custom.label],['ticket','HH-1','HH-1'],[custom.kind,custom.id,custom.label]]);
 assert.deepEqual(extractLinks(normalizeDoc(doc([run(custom),run(custom)]))),{tickets:[],refs:[{kind:'custom',id:custom.id}]});
 assert.throws(()=>normalizeDoc(doc([run({...custom,id:'../escape'})])),/invalid/);
 assert.throws(()=>normalizeDoc(doc([{...run(custom),href:'https://example.org'}])),/invalid/);
});

test('source and storage permissions, atomic promotion, incoming uses and live resolution',async t=>{
 const h=await hub(t),writer=(await h.account('project-author',['tickets:write'])).headers,
  global=(await h.account('reference-author',['references:write'])).headers,reader=(await h.account('reference-reader',['read'])).headers;
 async function body(res,status=200){res=await res;const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;}
 const post=(path,data,headers=writer,status=200)=>body(h.post(path,data,headers),status);
 const get=(path,headers=reader)=>body(fetch(h.origin+path,{headers}));
 const item=(kind,id)=>get(base+'/item?'+new URLSearchParams({kind,id}));
 const rpc=async(name,args,headers)=>{const {result}=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},headers);return result;};
 const create={kind:'custom',project,label:'Tróoper',description:'A unit.'};
 const first=await post(base+'/local/save',create);
 await post(base+'/local/save',create,reader,403);
 await post(base+'/global/save',{kind:'model',label:'Example model'},writer,403);
 await post(base+'/local/save',{...create,project:'missing'},writer,400);
 const token=referenceToken(first);
 const {id:ticket}=await post('/api/tickets',{project,title:'Unit guide',description:'Description '+token},writer,201);
 await post('/api/tickets/comment',{id:ticket,text:'Comment '+token});
 const otherTicket=await post('/api/tickets',{project:other,title:'Other item'},writer,201);
 const invalidComment=await post('/api/tickets/comment',{id:otherTicket.id,text:token},writer,400);
 assert.match(invalidComment.error.message,/reference is missing or unavailable/i);
 await post('/api/tickets',{project:other,title:'Unavailable reference',description:token},writer,400);
 // A backtick in an attachment name cannot hide a reference in validation and expose it in rendering.
 const name='a`b.txt',paired='!['+name+'] '+token+' `';
 assert.deepEqual(markdownReferences(paired),markdownReferences(paired,{attachmentNames:[name]}));
 await post('/api/tickets/comment',{id:otherTicket.id,text:paired},writer,400);
 const attached=await body(fetch(h.origin+'/api/tickets/'+otherTicket.id+'/attachments?'+new URLSearchParams({name}),{
  method:'PUT',headers:{...writer,'Content-Type':'application/octet-stream'},body:'Fixture attachment.',
 }),201);
 assert.equal(attached.attachments[0].name,name);
 await post('/api/tickets/comment',{id:otherTicket.id,text:paired},writer,400);
 await post('/api/tickets/attachments/delete',{id:otherTicket.id,attachment:attached.attachments[0].id});
 await post('/api/tickets/comment',{id:otherTicket.id,text:paired},writer,400);
 await post('/api/tickets/update',{id:otherTicket.id,rev:1,description:token},writer,400);
 const {home}=await post('/api/wiki/setup',{project},writer,201);
 const saved=await post('/api/wiki/pages/update',{project,id:home,rev:1,doc:doc([{t:'text',text:'Inventory '},run(first)])});
 const otherHome=(await post('/api/wiki/setup',{project:other},writer,201)).home;
 assert.equal((await rpc('wiki_page_save',{project:other,pageId:otherHome,rev:1,doc:doc([run(first)])},writer)).isError,true);
 assert.deepEqual((await get(base+'/suggest?project='+project+'&q=tRO')).items.map(r=>r.id),[first.id]);
 assert.deepEqual((await get(base+'/suggest?project='+other+'&q=tro')).items,[]);
 const listed=await rpc('references_search',{project,kind:'custom',limit:50},reader);
 assert.deepEqual(listed.structuredContent.items.map(r=>r.id),[first.id]);
 const suggested=await rpc('references_suggest',{project:other,q:'tro'},reader);
 assert.deepEqual(suggested.structuredContent.items,[]);
 const used=await item('custom',first.id);
 assert.equal(used.usageTotal,3);assert.deepEqual(new Set(used.usages.map(u=>u.excerpt)),new Set(['Inventory Tróoper','Description Tróoper','Comment Tróoper']));
 const promote={kind:'custom',id:first.id,project,rev:first.rev};
 await post('/api/admin/users',{username:'editor',role:'editor',password:'editor-test-password'},h.admin,201);
 const login=await h.post('/api/session',{username:'editor',password:'editor-test-password'});
 const editor={Cookie:login.headers.get('set-cookie').split(';')[0]};
 await post(base+'/promote',promote,editor,403);
 await post(base+'/global/save',{kind:'model',label:'Example model'},editor,403);
 await post(base+'/promote',promote,writer,403);await post(base+'/promote',promote,global,403);
 const clash=await post(base+'/global/save',{kind:'custom',label:'Trooper'},global);
 await post(base+'/promote',promote,h.admin,409);assert.equal((await item('custom',first.id)).record.scope,'local');
 await post(base+'/global/delete',{kind:'custom',id:clash.id,rev:1},global);
 const attempts=await Promise.all([h.post(base+'/promote',promote,h.admin),h.post(base+'/promote',promote,h.admin)]);
 assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
 const after=(await item('custom',first.id)).record;
 assert.deepEqual([after.rev,after.scope,after.project],[2,'global',null]);
 await post(base+'/global/save',{kind:'custom',id:first.id,label:'Scout',rev:1},global,409);
 await post(base+'/global/save',{kind:'custom',id:first.id,label:'Scout',rev:2},global);
 const resolved=await post(base+'/resolve',{refs:[{kind:'custom',id:first.id}]},reader);assert.equal(resolved.items[0].label,'Scout');
 await post('/api/tickets/comment',{id:otherTicket.id,text:token});
 const pageRef={kind:'wiki',id:project+'/'+home,label:'Guide'};
 const notShared=await post('/api/wiki/pages/update',{project:other,id:otherHome,rev:1,doc:doc([run(pageRef)])},writer,400);
 assert.equal(notShared.error.reason,'unavailable-reference');
 await post(base+'/share',{kind:'wiki',id:pageRef.id,rev:0},h.admin);
 await post('/api/wiki/pages/update',{project:other,id:otherHome,rev:1,doc:doc([run(pageRef)])});
 assert.equal((await item('wiki',pageRef.id)).usages[0].source.href,'#wiki/'+other+'/'+otherHome);
 await post('/api/wiki/pages/update',{project,id:home,rev:saved.rev,doc:doc([])});
 assert.equal((await item('custom',first.id)).usageTotal,3);
 const model=await rpc('reference_save',{kind:'model',label:'Example model',description:'Offline documentation'},global);
 assert.equal(model.structuredContent.kind,'model');
 assert.equal((await rpc('reference_get',{kind:'model',id:model.structuredContent.id},reader)).structuredContent.record.description,'Offline documentation');
 await post('/api/home/devices/site',{id:'mini',base:siteOverrideHash(null),device:{name:'Renamed workstation'}},h.admin);
 const machine=(await item('machine','mini')).record;
 assert.equal(machine.label,'Renamed workstation');
 assert.equal(machine.href,'#host-mini');
 assert.deepEqual(Object.keys(machine).sort(),['kind','id','label','project','scope','href','role','ip'].sort());
 await post(base+'/global/delete',{kind:'custom',id:first.id,rev:3},global);
 assert.deepEqual((await post(base+'/resolve',{refs:[{kind:'custom',id:first.id}]},reader)).items,[]);
});

test('epoch 9 wiki pages retain their literal v1.4.0 document and links after migration',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ref-migrate-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'hub.db'),{DatabaseSync}=process.getBuiltinModule('node:sqlite'),old=new DatabaseSync(file);
 const {ddl}=JSON.parse(await readFile(new URL('./fixtures/wiki-flat-1.2.0.json',import.meta.url),'utf8'));
 old.exec(ddl.join(';')+'; PRAGMA user_version=4');
 old.prepare("INSERT INTO meta VALUES ('wiki',?)").run('{"schema":3,"revision":2}');
 const page='{"id":"wabcdefghijk","project":"sample-game","parentId":null,"title":"Earlier guide","doc":{"v":1,"blocks":[{"t":"p","c":[{"t":"ticket","id":"GAME-1"}]}]},"links":{"tickets":["GAME-1"]},"rev":2}';
 old.prepare("INSERT INTO docs VALUES ('wiki','pages','sample-game/wabcdefghijk',?)").run(page);
 old.close();
 const db=openDb(file);
 try{
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,DB_SCHEMA);
  const migrated=await createWikiStore(db,{}).get('sample-game','wabcdefghijk');
  assert.deepEqual(migrated,JSON.parse(page));
  assert.deepEqual(extractLinks(migrated.doc),migrated.links);
 }finally{db.close();}
});

test('standalone ticket and wiki stores enforce mention visibility without a full hub',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ref-standalone-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=openDb(path.join(dir,'hub.db'));
 t.after(()=>db.close());
 const seed=[{id:project,key:'HH',name:'Home Hub'},{id:other,key:'SG',name:'Sample Game'}];
 const tickets=createTicketStore(path.join(dir,'tickets'),{db,seedProjects:seed});
 const wiki=createWikiStore(db,tickets);
 const t1=await tickets.create({project,title:'Primary ticket'},'alice');
 const t2=await tickets.create({project:other,title:'Other ticket'},'alice');
 const {home}=await wiki.setup({project},'alice');
 const {home:otherHome}=await wiki.setup({project:other},'alice');
 const t1Token=referenceToken({kind:'ticket',id:t1.id,label:t1.title});
 const t2Token=referenceToken({kind:'ticket',id:t2.id,label:t2.title});
 const projToken=referenceToken({kind:'project',id:other,label:'Sample Game'});
 const missingToken=referenceToken(custom);

 // Standalone tickets store allows same-project tickets and any existing project, rejects cross-project or missing refs.
 const linked=await tickets.create({project,title:'Linked',description:`See ${t1Token} and ${projToken}`},'alice');
 assert.equal(linked.project,project);
 await assert.rejects(()=>tickets.create({project,title:'Cross',description:t2Token},'alice'),/unavailable-reference/);
 await assert.rejects(()=>tickets.comment({id:t1.id,text:t2Token},'alice'),/unavailable-reference/);
 await assert.rejects(()=>tickets.create({project,title:'Missing',description:missingToken},'alice'),/unavailable-reference/);

 // Standalone wiki store allows same-project wiki/tickets and projects, rejects cross-project unshared targets.
 const pageRef={kind:'wiki',id:project+'/'+home,label:'Home'};
 const otherPageRef={kind:'wiki',id:other+'/'+otherHome,label:'Other home'};
 const createdPage=await wiki.create({project,title:'Notes',doc:doc([run(pageRef),{t:'ticket',id:t1.id},run({kind:'project',id:other,label:'Sample Game'})])},'alice');
 assert.equal(createdPage.project,project);
 await assert.rejects(()=>wiki.create({project,title:'Bad wiki',doc:doc([run(otherPageRef)])},'alice'),/unavailable-reference/);
 await assert.rejects(()=>wiki.create({project,title:'Bad ticket',doc:doc([{t:'ticket',id:t2.id}])},'alice'),/unavailable-reference/);
 await assert.rejects(()=>wiki.create({project,title:'Bad custom',doc:doc([run(custom)])},'alice'),/unavailable-reference/);

 // Explicit createMentionGuard wires wiki visibility into standalone ticket writes as well.
 const wiredTickets=createTicketStore(path.join(dir,'tickets'),{db,mentionGuard:createMentionGuard({db,tickets,wiki})});
 const wikiMention=referenceToken(pageRef),otherWikiMention=referenceToken(otherPageRef);
 await wiredTickets.create({project,title:'Same wiki',description:wikiMention},'alice');
 await assert.rejects(()=>wiredTickets.create({project,title:'Other wiki',description:otherWikiMention},'alice'),/unavailable-reference/);
});

test('in-transaction mention validation sees one atomic SQLite snapshot across concurrent promote and delete',async t=>{
 // Deterministic two-phase check: mutations committed after prepareMentionGuard (phase 1) are seen by sync verify (phase 2).
 const dir=await mkdtemp(path.join(os.tmpdir(),'ref-snapshot-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=openDb(path.join(dir,'hub.db'));
 t.after(()=>db.close());
 let gate=null;
 const pause=()=>{let release;const ready=new Promise(r=>{gate={wait:new Promise(done=>{release=done;}),hit:r};});return {ready,release};};
 let refs;
 const gatedGuard=async list=>{
  const verify=await refs.prepareMentionGuard(list);
  if(gate&&list.length){const current=gate;gate=null;current.hit();await current.wait;}
  return verify;
 };
 const seed=[{id:project,key:'HH',name:'Home Hub'},{id:other,key:'SG',name:'Sample Game'}];
 const tickets=createTicketStore(path.join(dir,'tickets'),{db,seedProjects:seed,mentionGuard:gatedGuard});
 const wiki=createWikiStore(db,tickets,{mentionGuard:gatedGuard});
 const stubHub={db,site:{devices:[]},state:id=>id==='tracker'?{tickets}:id==='wiki'?{wiki}:id==='home'?{homeDevices:{list:async()=>[],siteOverrides:async()=>({})}}:null};
 refs=createReferences(stubHub);
 await wiki.setup({project},'alice');
 await wiki.setup({project:other},'alice');

 // Delete commits between phase 1 and phase 2 -> ticket and wiki writes must observe deletion and fail.
 const ephemeral=await refs.save({kind:'custom',project,label:'Ephemeral'},'alice',true);
 const p1=pause();
 const ticketAfterDelete=tickets.create({project,title:'Race delete ticket',description:referenceToken(ephemeral)},'alice');
 await p1.ready;
 await refs.remove({kind:'custom',id:ephemeral.id,project,rev:ephemeral.rev},true);
 p1.release();
 await assert.rejects(ticketAfterDelete,/unavailable-reference/);

 const ephemeralWiki=await refs.save({kind:'custom',project,label:'Ephemeral wiki'},'alice',true);
 const p2=pause();
 const wikiAfterDelete=wiki.create({project,title:'Race delete page',doc:doc([run(ephemeralWiki)])},'alice');
 await p2.ready;
 await refs.remove({kind:'custom',id:ephemeralWiki.id,project,rev:ephemeralWiki.rev},true);
 p2.release();
 await assert.rejects(wikiAfterDelete,/unavailable-reference/);

 // Promote commits between phase 1 and phase 2 -> cross-project ticket and wiki writes observe global visibility and succeed.
 const promotable=await refs.save({kind:'custom',project,label:'Promotable'},'alice',true);
 const p3=pause();
 const crossTicket=tickets.create({project:other,title:'Race promote ticket',description:referenceToken(promotable)},'alice');
 await p3.ready;
 await refs.promote({kind:'custom',id:promotable.id,project,rev:promotable.rev},'alice');
 p3.release();
 assert.equal((await crossTicket).project,other);

 const promotableWiki=await refs.save({kind:'custom',project,label:'Promotable wiki'},'alice',true);
 const p4=pause();
 const crossWiki=wiki.create({project:other,title:'Race promote page',doc:doc([run(promotableWiki)])},'alice');
 await p4.ready;
 await refs.promote({kind:'custom',id:promotableWiki.id,project,rev:promotableWiki.rev},'alice');
 p4.release();
 assert.equal((await crossWiki).project,other);

 // Live HTTP concurrency: promoting a local reference never opens a gap where same-project writes fail.
 const h=await hub(t),writer=(await h.account('race-writer',['tickets:write'])).headers;
 const saved=await (await h.post(base+'/local/save',{kind:'custom',project,label:'Atomic unit'},writer)).json();
 const token=referenceToken(saved);
 const [promoted,...writes]=await Promise.all([
  h.post(base+'/promote',{kind:'custom',id:saved.id,project,rev:saved.rev},h.admin),
  ...Array.from({length:6},(_,i)=>h.post('/api/tickets',{project,title:`Concurrent ${i}`,description:`Uses ${token}`},writer)),
 ]);
 assert.equal(promoted.status,200);
 for(const res of writes)assert.equal(res.status,201);
});
