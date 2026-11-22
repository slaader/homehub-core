// Projects v2, Tracker side (docs/projects-v2.md): the schema-7 migration, project labels and the web type, epics
// with their ticket links, search and files, bulk assignment, and the project deletion and upgrade transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {openDb,DB_SCHEMA} from '../server/db.mjs';
import {createTicketStore,projectSelection,EPIC_SPEC_LIMIT} from '../server/tickets-store.mjs';
import {createTicketFiles} from '../server/ticket-files.mjs';
import {WIKI_SCHEMA} from '../server/wiki-store.mjs';

const SEED=[{id:'home-hub',key:'HH',name:'Home Hub',type:'app'},{id:'sample-game',key:'GAME',name:'Sample Game',type:'game'}];
async function scratch(t,prefix){const dir=await mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function stores(t){
 const dir=await scratch(t,'pv2-'),db=openDb(path.join(dir,'hub.db'));t.after(()=>db.close());
 const files=createTicketFiles(dir);
 const tickets=createTicketStore(dir,{db,seedProjects:SEED,files,mentionGuard:async()=>()=>{}});
 return {dir,db,files,tickets};
}
const ftsIds=(db,kind)=>db.db.prepare('SELECT id FROM search WHERE kind=? ORDER BY id').all(kind).map(r=>r.id);

test('migration: a literal schema-6 hub.db with wiki schema 4 moves to schema 7 and keeps revs, counters, settings and wiki keys',async t=>{
 const dir=await scratch(t,'pv2-migrate-'),file=path.join(dir,'hub.db'),{DatabaseSync}=process.getBuiltinModule('node:sqlite');
 const old=new DatabaseSync(file);
 old.exec(`CREATE TABLE meta(kind TEXT PRIMARY KEY, doc TEXT NOT NULL);
  CREATE TABLE docs(kind TEXT NOT NULL, coll TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(kind,coll,id));
  CREATE TABLE sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, password_at TEXT, until INTEGER NOT NULL);
  CREATE INDEX sessions_until ON sessions(until);
  CREATE TABLE search_version(kind TEXT PRIMARY KEY, version INTEGER NOT NULL);
  CREATE VIRTUAL TABLE search USING fts5(kind UNINDEXED, id UNINDEXED, project UNINDEXED, updated UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
  INSERT INTO search_version VALUES ('ticket',1),('review',1);
  PRAGMA user_version=6;`);
 const settings={color:'teal',view:'table',releases:false,reviews:true,wiki:true,globalReferences:true};
 const project={id:'example-app',key:'APP',name:'Example App',description:'Kept',type:'app',settings,createdAt:'2026-11-01T10:00:00.000Z',createdBy:'alice',updatedAt:'2026-11-02T10:00:00.000Z',rev:3,next:5};
 const ticket={id:'APP-4',project:'example-app',title:'Old ticket',description:'',type:'task',status:'open',priority:'normal',release:null,assignee:null,labels:[],refs:[],reporter:'alice',
  createdAt:'2026-11-02T10:00:00.000Z',updatedAt:'2026-11-02T10:00:00.000Z',closedAt:null,rev:2,comments:[],attachments:[],history:[{at:'2026-11-02T10:00:00.000Z',by:'alice',field:'created',from:null,to:'open'}]};
 const wiki={project:'example-app',home:'wtiplrec5uiw',count:1,createdAt:'2026-11-02T10:00:00.000Z',createdBy:'alice'};
 const page={project:'example-app',id:'wtiplrec5uiw',parentId:null,title:'Home'};
 const put=old.prepare('INSERT INTO docs VALUES (?,?,?,?)');
 old.prepare('INSERT INTO meta VALUES (?,?)').run('tickets',JSON.stringify({schema:1,revision:6,updatedAt:'2026-11-02T10:00:00.000Z'}));
 old.prepare('INSERT INTO meta VALUES (?,?)').run('wiki',JSON.stringify({schema:4,revision:2,updatedAt:'2026-11-02T10:00:00.000Z'}));
 put.run('tickets','projects','example-app',JSON.stringify(project));
 put.run('tickets','tickets','APP-4',JSON.stringify(ticket));
 put.run('wiki','wikis','example-app',JSON.stringify(wiki));
 put.run('wiki','pages','example-app/wtiplrec5uiw',JSON.stringify(page));
 old.prepare('INSERT INTO search(kind,id,project,updated,title,body) VALUES (?,?,?,?,?,?)').run('ticket','APP-4','example-app',ticket.updatedAt,'APP-4 Old ticket','');
 old.close();

 const db=openDb(file);
 try{
  assert.equal(DB_SCHEMA,7);assert.equal(WIKI_SCHEMA,5);
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,7);
  const row=(kind,coll,id)=>JSON.parse(db.db.prepare('SELECT doc FROM docs WHERE kind=? AND coll=? AND id=?').get(kind,coll,id).doc);
  assert.deepEqual(row('tickets','projects','example-app'),{...project,labels:[],nextEpic:1,projectVersion:1},'rev, next and settings stay; only the v2 fields are added');
  assert.deepEqual(row('tickets','tickets','APP-4'),ticket,'tickets are not rewritten');
  const {project:legacyWikiProject,...wikiFields}=wiki;
  assert.equal(legacyWikiProject,'example-app');
  assert.deepEqual(row('wiki','wikis','example-app'),{...wikiFields,id:'example-app',projectId:'example-app',name:project.name});
  assert.deepEqual(row('wiki','pages','example-app/wtiplrec5uiw'),page,'page keys and rows stay');
  assert.equal(JSON.parse(db.db.prepare("SELECT doc FROM meta WHERE kind='wiki'").get().doc).schema,5);
  const tickets=createTicketStore(dir,{db,mentionGuard:async()=>()=>{}});
  const [p]=await tickets.projects();
  assert.deepEqual([p.rev,p.projectVersion,p.labels,p.settings,p.next,p.nextEpic],[3,1,[],settings,undefined,undefined],'counters stay internal');
  // The search index is rebuilt for the new kind on first use; the ticket is still found.
  assert.deepEqual((await tickets.list()).tickets.map(t=>[t.id,t.epic]),[['APP-4',null]]);
  assert.equal(db.search({q:'old'}).results[0].id,'APP-4');
  assert.equal(db.db.prepare("SELECT version FROM search_version WHERE kind='epic'").get().version,2);
  // An old client keeps writing with the revs it read before the upgrade.
  assert.equal((await tickets.saveProject({id:'example-app',rev:3,name:'Example'},'a')).rev,4);
  assert.equal((await tickets.update({id:'APP-4',rev:2,status:'done'},'a')).rev,3);
  assert.equal((await tickets.create({project:'example-app',title:'Numbering continues'},'a')).id,'APP-5');
  assert.equal((await tickets.createEpic({project:'example-app',title:'First epic'},'a')).id,'APP-E1');
 }finally{db.close();}
 // Opening again changes nothing.
 const again=openDb(file);try{assert.equal(again.db.prepare('PRAGMA user_version').get().user_version,7);}finally{again.close();}
});

test('projects: web type, labels and a read-only projectVersion; legacy rows read as version 1',async t=>{
 const dir=await scratch(t,'pv2-proj-');
 const {writeFile}=await import('node:fs/promises');
 await writeFile(path.join(dir,'tickets.json'),JSON.stringify({schema:1,revision:1,updatedAt:null,releases:[],tickets:[],projects:[{id:'legacy',key:'LEG',name:'Legacy',description:'',createdAt:null,rev:2,next:3}]}));
 const s=createTicketStore(dir,{mentionGuard:async()=>()=>{}});
 const [legacy]=await s.projects();
 assert.deepEqual([legacy.projectVersion,legacy.labels],[1,[]]);
 const made=await s.saveProject({id:'site',key:'WEB',name:'Site',type:'web',labels:['Front-End','front-end','ui']},'a');
 assert.deepEqual([made.type,made.labels,made.projectVersion],['web',['front-end','ui'],2]);
 await assert.rejects(s.saveProject({id:'site',rev:1,projectVersion:1},'a'),/invalid/,'projectVersion only moves through the wizard');
 assert.equal((await s.saveProject({id:'site',rev:1,projectVersion:2,labels:[]},'a')).labels.length,0,'repeating the current version is harmless');
 await assert.rejects(s.saveProject({id:'other',key:'OTH',name:'O',projectVersion:1},'a'),/invalid/);
 await assert.rejects(s.saveProject({id:'other',key:'OTH',name:'O',labels:['Bad Tag']},'a'),/invalid/);
 await assert.rejects(s.saveProject({id:'other',key:'OTH',name:'O',labels:Array.from({length:11},(_,i)=>'l'+i)},'a'),/invalid/);
 await assert.rejects(s.saveProject({id:'other',key:'OTH',name:'O',createWiki:true},'a'),/invalid/,'the store alone cannot make a wiki');
 assert.equal((await s.saveProject({id:'legacy',rev:2,name:'Legacy 2'},'a')).projectVersion,1,'saving a version-1 project keeps it at 1');
});

test('epics: CRUD with rev, history without bodies, a 64 KiB UTF-8 spec, ticket links within the project, filters and search',async t=>{
 const {db,tickets:s}=await stores(t);
 await s.saveRelease({project:'home-hub',version:'1.0'},'a');
 const e=await s.createEpic({project:'home-hub',title:'Login',description:'Sign-in work',spec:'# Plan\n\nPasskeys',release:'1.0',labels:['auth']},'alice');
 assert.deepEqual([e.id,e.status,e.priority,e.rev,e.release,e.total],['HH-E1','open','normal',1,'1.0',0]);
 assert.equal((await s.createEpic({project:'home-hub',title:'Second'},'a')).id,'HH-E2');
 assert.equal((await s.createEpic({project:'sample-game',title:'Game epic'},'a')).id,'GAME-E1');
 await assert.rejects(s.createEpic({project:'home-hub',title:'x',release:'9.9'},'a'),/invalid/);
 await assert.rejects(s.createEpic({project:'nope',title:'x'},'a'),/invalid/);
 // The spec limit counts UTF-8 bytes: 32768 two-byte characters fit, one more does not.
 const big=await s.updateEpic({id:'HH-E1',rev:1,spec:'é'.repeat(EPIC_SPEC_LIMIT/2)},'a');
 assert.equal(Buffer.byteLength(big.spec),EPIC_SPEC_LIMIT);
 await assert.rejects(s.updateEpic({id:'HH-E1',rev:2,spec:'é'.repeat(EPIC_SPEC_LIMIT/2+1)},'a'),/invalid/);
 await assert.rejects(s.updateEpic({id:'HH-E1',rev:2,spec:' '.repeat(EPIC_SPEC_LIMIT+1)},'a'),/invalid/);
 await assert.rejects(s.updateEpic({id:'HH-E1',rev:1,title:'Stale'},'a'),/conflict/);
 const done=await s.updateEpic({id:'HH-E1',rev:2,status:'done',title:'Login v2'},'a');
 assert.ok(done.closedAt);assert.equal(done.rev,3);
 assert.deepEqual(done.history.filter(h=>h.field!=='created').map(h=>[h.field,h.from,h.to]),[['spec',null,null],['title',null,null],['status','open','done']]);
 const c=await s.commentEpic({id:'HH-E1',text:'Ship it'},'bob');assert.equal(c.comments.length,1);assert.equal(c.rev,3,'a comment needs no rev');

 // Tickets link to an epic of their own project only.
 const t1=await s.create({project:'home-hub',title:'Passkey prompt',epic:'HH-E1'},'a');
 assert.equal(t1.epic,'HH-E1');
 await assert.rejects(s.create({project:'home-hub',title:'x',epic:'GAME-E1'},'a'),/invalid/);
 await assert.rejects(s.create({project:'home-hub',title:'x',epic:'HH-E99'},'a'),/invalid/);
 const t2=await s.create({project:'home-hub',title:'Unrelated'},'a');
 assert.equal(t2.epic,null);
 await assert.rejects(s.update({id:t2.id,rev:1,epic:'GAME-E1'},'a'),/invalid/);
 const moved=await s.update({id:t2.id,rev:1,epic:'HH-E2'},'a');
 assert.deepEqual(moved.history.at(-1),{...moved.history.at(-1),field:'epic',from:null,to:'HH-E2'});
 assert.equal((await s.update({id:t2.id,rev:2,epic:'HH-E2'},'a')).rev,2,'the same epic again changes nothing');
 assert.equal((await s.update({id:t2.id,rev:2,epic:null},'a')).epic,null);
 assert.deepEqual((await s.list({epic:'HH-E1'})).tickets.map(t=>t.id),[t1.id]);
 assert.deepEqual((await s.list({project:'home-hub',epic:'none'})).tickets.map(t=>t.id),[t2.id],'none means no epic');
 await assert.rejects(s.list({epic:'bad'}),/invalid/);
 assert.deepEqual((await s.list({project:'home-hub'})).epics.map(e=>e.id).sort(),['HH-E1','HH-E2']);

 const listed=await s.listEpics({project:'home-hub'});
 assert.deepEqual(listed.epics.map(e=>[e.id,e.total,e.counts.open]),[['HH-E2',0,0],['HH-E1',1,1]],'open epics first');
 assert.equal(listed.epics[0].spec,undefined,'lists carry no spec');
 assert.deepEqual((await s.listEpics({status:'done'})).epics.map(e=>e.id),['HH-E1']);
 await assert.rejects(s.listEpics({status:'nope'}),/invalid/);
 assert.equal((await s.getEpic('HH-E1')).counts.open,1);
 await assert.rejects(s.getEpic('HH-1'),/not-found/);

 // Epics have their own search kind, independent of ticket search.
 assert.deepEqual(db.search({q:'sign work'}).results.map(r=>[r.kind,r.id]),[['epic','HH-E1']]);
 assert.deepEqual(db.search({q:'login',kind:'epic'}).results.map(r=>r.id),['HH-E1']);
 assert.equal((await s.search({q:'sign work'})).total,0,'ticket search stays tickets only');
 assert.equal(db.searchStats().epic,3);
});

test('epic assignment is atomic: a stale rev, a missing ticket or one of another project changes nothing',async t=>{
 const {tickets:s}=await stores(t);
 const e1=await s.createEpic({project:'home-hub',title:'One'},'a'),e2=await s.createEpic({project:'home-hub',title:'Two'},'a');
 const a=await s.create({project:'home-hub',title:'A'},'a'),b=await s.create({project:'home-hub',title:'B',epic:e2.id},'a'),g=await s.create({project:'sample-game',title:'G'},'a');
 const snapshot=async()=>(await s.list()).tickets.map(t=>[t.id,t.epic,t.rev]).sort();
 const before=await snapshot();
 await assert.rejects(s.assignEpic(e1.id,{tickets:[{id:a.id,rev:1},{id:g.id,rev:1}]},'x'),/invalid/);
 await assert.rejects(s.assignEpic(e1.id,{tickets:[{id:a.id,rev:1},{id:b.id,rev:9}]},'x'),/conflict/);
 await assert.rejects(s.assignEpic(e1.id,{tickets:[{id:a.id,rev:1},{id:'HH-99',rev:1}]},'x'),/not-found/);
 await assert.rejects(s.assignEpic(e1.id,{tickets:[{id:a.id,rev:1},{id:a.id,rev:1}]},'x'),/invalid/);
 await assert.rejects(s.assignEpic(e1.id,{tickets:[]},'x'),/invalid/);
 await assert.rejects(s.assignEpic('HH-E9',{tickets:[{id:a.id,rev:1}]},'x'),/not-found/);
 assert.deepEqual(await snapshot(),before,'a refused batch writes nothing');
 // A ticket of another epic moves; one already in this epic is left alone.
 const out=await s.assignEpic(e1.id,{tickets:[{id:a.id,rev:1},{id:b.id,rev:1}]},'x');
 assert.deepEqual(out.tickets.map(t=>[t.id,t.epic,t.rev]),[[a.id,e1.id,2],[b.id,e1.id,2]]);
 assert.equal((await s.get(b.id)).history.at(-1).from,e2.id);
 assert.deepEqual((await s.assignEpic(e1.id,{tickets:[{id:a.id,rev:2}]},'x')).tickets,[]);
});

test('epic deletion detaches its tickets, leaves search, and frees only files no other record names',async t=>{
 const {db,files,tickets:s}=await stores(t);
 const e=await s.createEpic({project:'home-hub',title:'Doomed epic'},'a');
 const tk=await s.create({project:'home-hub',title:'Survivor',epic:e.id},'a');
 const shared=await files.put([Buffer.from('shared bytes')],{name:'shared.txt'}),own=await files.put([Buffer.from('own bytes')],{name:'own.txt'});
 await s.attachEpic(e.id,shared,'a');await s.attachEpic(e.id,own,'a');await s.attach(tk.id,shared,'a');
 const withFiles=await s.getEpic(e.id);
 assert.equal(withFiles.attachments.length,2);
 assert.equal((await s.epicAttachment(e.id,withFiles.attachments[0].id)).name,'shared.txt');
 // Removing the shared file from the epic keeps the blob: the ticket still names it.
 const detached=await s.detachEpic({id:e.id,attachment:withFiles.attachments[0].id},'a');
 assert.equal(detached.used,true);
 await s.attachEpic(e.id,shared,'a');
 await assert.rejects(s.deleteEpic({id:e.id,rev:2},'a'),/conflict/);
 const out=await s.deleteEpic({id:e.id,rev:1},'a');
 assert.deepEqual(out.detached,[tk.id]);
 assert.deepEqual(out.unused,[own.sha256],'the ticket still uses the shared file');
 const after=await s.get(tk.id);
 assert.deepEqual([after.epic,after.rev,after.history.at(-1).field],[null,2,'epic']);
 await assert.rejects(s.getEpic(e.id),/not-found/);
 assert.deepEqual(ftsIds(db,'epic'),[]);
 assert.equal(await s.fileInUse(shared.sha256),true);assert.equal(await s.fileInUse(own.sha256),false);
});

test('project lifecycle steps: footprint, removal in one transaction that rolls back whole, and the upgrade',async t=>{
 const {db,files,tickets:s}=await stores(t);const L=s.lifecycle;
 await s.saveRelease({project:'home-hub',version:'1.0'},'a');
 const e=await s.createEpic({project:'home-hub',title:'Epic in HH'},'a');
 const t1=await s.create({project:'home-hub',title:'Ticket in HH',epic:e.id},'a');
 const keep=await s.create({project:'sample-game',title:'Ticket in GAME'},'a');
 const blob=await files.put([Buffer.from('hh only')],{name:'a.txt'});await s.attach(t1.id,blob,'a');
 const p=await db.changeCollections([{store:L.store,selection:{projects:['home-hub']}}],([d])=>d.projects[0],{readOnly:true});
 assert.deepEqual(projectSelection(p),{projects:['home-hub'],releases:'home-hub/',tickets:'HH-',epics:'HH-'});
 const fp=await db.changeCollections([{store:L.store,selection:L.selection(p)}],([d])=>L.footprint(d,'home-hub'),{readOnly:true});
 assert.deepEqual(fp.counts,{epics:1,tickets:1,releases:1});
 // An injected failure after the tracker rows were removed rolls everything back, search entries included.
 await assert.rejects(db.changeCollections([{store:L.store,selection:L.selection(p)}],([d])=>{L.remove(d,p,'a',new Date().toISOString());throw new Error('injected');},{durable:true}),/injected/);
 assert.equal((await s.get(t1.id)).id,t1.id);assert.deepEqual(ftsIds(db,'epic'),[e.id]);assert.ok(ftsIds(db,'ticket').includes(t1.id));
 const fp2=await db.changeCollections([{store:L.store,selection:L.selection(p)}],([d])=>L.footprint(d,'home-hub'),{readOnly:true});
 assert.equal(fp2.digest,fp.digest);
 const out=await db.changeCollections([{store:L.store,selection:L.selection(p)}],([d])=>L.remove(d,p,'a',new Date().toISOString()),{durable:true});
 L.notify();
 assert.deepEqual([out.counts,out.ticketIds,out.epicIds],[{epics:1,tickets:1,releases:1},[t1.id],[e.id]]);
 assert.deepEqual(await out.cleanup(),[blob.sha256]);
 assert.deepEqual((await s.projects()).map(x=>x.id),['sample-game']);
 assert.deepEqual((await s.list()).tickets.map(x=>x.id),[keep.id]);
 assert.deepEqual(ftsIds(db,'ticket'),[keep.id]);assert.deepEqual(ftsIds(db,'epic'),[]);
 await assert.rejects(s.get(t1.id),/not-found/);
 // The key can be used again; numbering starts over.
 assert.equal((await s.saveProject({id:'home-hub',key:'HH',name:'Again'},'a')).rev,1);
 assert.equal((await s.create({project:'home-hub',title:'Fresh'},'a')).id,'HH-1');
 assert.equal((await s.createEpic({project:'home-hub',title:'Fresh epic'},'a')).id,'HH-E1');
});

test('upgrade: a version-1 project moves to 2 once, with its profile, epics and ticket assignments, or not at all',async t=>{
 const {db,tickets:s}=await stores(t);
 const a=await s.create({project:'home-hub',title:'A'},'a'),b=await s.create({project:'home-hub',title:'B'},'a'),g=await s.create({project:'sample-game',title:'G'},'a');
 // Make home-hub a project from before Projects v2.
 db.db.prepare("UPDATE docs SET doc=json_set(doc,'$.projectVersion',1) WHERE kind='tickets' AND coll='projects' AND id='home-hub'").run();
 db.db.prepare("UPDATE meta SET doc=json_set(doc,'$.revision',json_extract(doc,'$.revision')+1) WHERE kind='tickets'").run();
 const before=async()=>[(await s.projects()).find(p=>p.id==='home-hub'),(await s.list()).tickets.map(t=>[t.id,t.epic,t.rev]).sort()];
 const start=await before();
 assert.equal(start[0].projectVersion,1);
 const input={id:'home-hub',rev:1,type:'web',labels:['core'],settings:{reviews:false},renameWikiHome:true,epics:[{title:'Auth',spec:'# Auth',ticketIds:[a.id]},{title:'Ops',ticketIds:[b.id,g.id]}]};
 await assert.rejects(s.upgradeProject(input,'a'),/invalid/,'a ticket of another project refuses the whole upgrade');
 await assert.rejects(s.upgradeProject({...input,epics:[{title:'Auth',ticketIds:[a.id]},{title:'Dup',ticketIds:[a.id]}]},'a'),/invalid/);
 await assert.rejects(s.upgradeProject({...input,rev:5,epics:[]},'a'),/conflict/);
 await assert.rejects(s.upgradeProject({...input,epics:[{title:'Big',spec:'x'.repeat(EPIC_SPEC_LIMIT+1)}]},'a'),/invalid/);
 assert.deepEqual(await before(),start,'nothing was written');
 assert.deepEqual(await s.listEpics({project:'home-hub'}),{total:0,epics:[]});
 const out=await s.upgradeProject({...input,epics:[{title:'Auth',spec:'# Auth',ticketIds:[a.id]},{title:'Ops',ticketIds:[b.id]}]},'a');
 assert.deepEqual([out.project.projectVersion,out.project.rev,out.project.type,out.project.labels,out.project.settings.reviews],[2,2,'web',['core'],false]);
 assert.deepEqual(out.epics.map(e=>e.id),['HH-E1','HH-E2']);
 assert.deepEqual(out.tickets,[a.id,b.id]);
 assert.deepEqual([(await s.get(a.id)).epic,(await s.get(b.id)).epic],['HH-E1','HH-E2']);
 await assert.rejects(s.upgradeProject({id:'home-hub',rev:2,epics:[]},'a'),/conflict/,'only once');
 // No epics at all is a valid choice.
 db.db.prepare("UPDATE docs SET doc=json_set(doc,'$.projectVersion',1) WHERE kind='tickets' AND coll='projects' AND id='sample-game'").run();
 db.db.prepare("UPDATE meta SET doc=json_set(doc,'$.revision',json_extract(doc,'$.revision')+1) WHERE kind='tickets'").run();
 assert.equal((await s.upgradeProject({id:'sample-game',rev:1,epics:[]},'a')).project.projectVersion,2);
});

test('HTTP and MCP: epics, assignment, search, deletion preview and delete, upgrade, scopes and body limits',async t=>{
 const h=await hub(t),writer=(await h.account('pv2-writer',['tickets:write'])).headers,reader=(await h.account('pv2-reader',['read'])).headers;
 const all=(await h.account('pv2-all',['tickets:write','review:write','references:write'])).headers;
 const json=async(res,status)=>{res=await res;const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;};
 const get=(url,headers=reader)=>fetch(h.origin+url,{headers});
 const created=await json(h.post('/api/tickets/projects',{id:'site',key:'WEB',name:'Site',type:'web',labels:['frontend']},writer),201);
 assert.deepEqual([created.projectVersion,created.labels,created.next],[2,['frontend'],undefined]);
 await json(h.post('/api/tickets/projects',{id:'site',rev:1,projectVersion:1},writer),400);
 await json(h.post('/api/tickets/epics/create',{project:'site',title:'Nope'},reader),403);
 // A 64 KiB spec of characters JSON escapes is far above the default 16 KiB body, and still accepted.
 const spec='"'.repeat(EPIC_SPEC_LIMIT);
 const epic=await json(h.post('/api/tickets/epics/create',{project:'site',title:'Landing page',spec},writer),201);
 assert.equal(epic.id,'WEB-E1');assert.equal(epic.spec.length,EPIC_SPEC_LIMIT);
 await json(h.post('/api/tickets/epics/update',{id:'WEB-E1',rev:1,spec:spec+'"'},writer),400);
 const fetched=await json(get('/api/tickets/epics/WEB-E1'),200);
 assert.equal(fetched.title,'Landing page');assert.ok(fetched.provenance,'an epic carries provenance like a ticket');
 await json(get('/api/tickets/epics/WEB-E9'),404);
 assert.deepEqual((await json(get('/api/tickets/epics?project=site'),200)).epics.map(e=>e.id),['WEB-E1']);
 const tk=await json(h.post('/api/tickets',{project:'site',title:'Hero section'},writer),201);
 const assigned=await json(h.post('/api/tickets/epics/WEB-E1/assign',{tickets:[{id:tk.id,rev:1}]},writer),200);
 assert.deepEqual(assigned.tickets.map(t=>[t.id,t.epic]),[[tk.id,'WEB-E1']]);
 await json(h.post('/api/tickets/epics/WEB-E1/assign',{tickets:[{id:tk.id,rev:1}]},writer),409);
 assert.deepEqual((await json(get('/api/tickets?epic=WEB-E1'),200)).tickets.map(t=>t.id),[tk.id]);
 assert.equal((await json(get('/api/tickets?project=site&epic=none'),200)).total,0);
 const found=await json(get('/api/search?q=landing'),200);
 assert.deepEqual(found.results.map(r=>[r.kind,r.id,r.meta?.status,r.meta?.total]),[['epic','WEB-E1','open',1]]);
 assert.equal(found.indexed.epic,1);
 assert.equal((await json(get('/api/search?q=landing&kind=ticket'),200)).results.length,0);
 await json(get('/api/search?q=landing&kind=epic&mode=hybrid'),400);
 await json(h.post('/api/tickets/epics/comment',{id:'WEB-E1',text:'Looks good'},writer),200);

 // MCP: the same store behind the epic tools and the deletion preview.
 let id=0;const call=async(headers,name,args)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},
  body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 const viaMcp=JSON.parse((await call(writer,'epic_create',{project:'site',title:'Docs'})).content[0].text);
 assert.equal(viaMcp.id,'WEB-E2');
 assert.equal((await call(reader,'epic_create',{project:'site',title:'x'})).isError,true);
 assert.equal(JSON.parse((await call(reader,'epic_get',{id:'WEB-E2'})).content[0].text).title,'Docs');
 assert.notEqual((await call(writer,'epic_delete',{id:'WEB-E2',rev:1})).isError,true);

 // Deletion: preview, then the same rev and snapshot with a typed confirmation.
 await json(get('/api/tickets/projects/site/delete-preview'),403);
 const preview=await json(get('/api/tickets/projects/site/delete-preview',writer),200);
 assert.deepEqual([preview.id,preview.rev,preview.counts],['site',1,{epics:1,tickets:1,releases:0,wikiPages:0,reviewSets:0,localReferences:0}]);
 const mcpPreview=JSON.parse((await call(writer,'project_delete_preview',{id:'site'})).content[0].text);
 assert.equal(mcpPreview.snapshot,preview.snapshot);
 const del={id:'site',rev:1,confirmation:'WEB',snapshot:preview.snapshot};
 await json(h.post('/api/tickets/projects/delete',{...del,confirmation:'wrong'},writer),400);
 await json(h.post('/api/tickets/projects/delete',{...del,deleteReviews:true},writer),403);
 await json(h.post('/api/tickets/projects/delete',{...del,promoteReferences:true},writer),403);
 await json(h.post('/api/tickets/projects/delete',del,reader),403);
 // A change after the preview makes the snapshot stale.
 await json(h.post('/api/tickets',{project:'site',title:'Late addition'},writer),201);
 await json(h.post('/api/tickets/projects/delete',del,writer),409);
 const fresh=await json(get('/api/tickets/projects/site/delete-preview',writer),200);
 const removed=await json(h.post('/api/tickets/projects/delete',{...del,confirmation:'Site',snapshot:fresh.snapshot,deleteReviews:true,promoteReferences:true},all),200);
 assert.deepEqual([removed.id,removed.deleted],['site',{epics:1,tickets:2,releases:0}]);
 await json(get('/api/tickets/epics/WEB-E1'),404);
 await json(get('/api/tickets/'+tk.id),404);
 assert.equal((await json(get('/api/search?q=landing'),200)).results.length,0);
 await json(get('/api/tickets/projects/site/delete-preview',writer),404);

 // Upgrade: projects created now are version 2, so the wizard refuses them.
 await json(h.post('/api/tickets/projects/upgrade',{id:'home-hub',rev:1,epics:[]},writer),409);
 await json(h.post('/api/tickets/projects/upgrade',{id:'home-hub',rev:1,epics:'none'},writer),400);
 await json(h.post('/api/tickets/projects/upgrade',{id:'home-hub',rev:1,epics:[]},reader),403);
});
