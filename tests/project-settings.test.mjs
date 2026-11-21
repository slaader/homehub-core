// Project settings (docs/project-settings.md): additive, revisioned settings on the project row, the schema-6
// migration that gives every existing project its defaults, and the one server behavior a setting has:
// globalReferences narrows reference suggestions, nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {openDb,DB_SCHEMA,PROJECT_SETTINGS_V6} from '../server/db.mjs';
import {createTicketStore,PROJECT_SETTINGS} from '../server/tickets-store.mjs';

const DEFAULTS={color:null,view:'board',releases:true,reviews:true,wiki:true,globalReferences:true};
const SEED=[{id:'home-hub',key:'HH',name:'Home Hub',type:'app'},{id:'sample-game',key:'GAME',name:'Sample Game',type:'game'}];
async function scratch(t,prefix){const dir=await mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('project settings: the agreed defaults, the same in the store and the schema-6 migration',()=>{
 assert.deepEqual(PROJECT_SETTINGS,DEFAULTS);
 assert.deepEqual(JSON.parse(PROJECT_SETTINGS_V6),DEFAULTS);
 assert.equal(DB_SCHEMA,6);
});

test('project settings: seeded, created and legacy projects read the defaults; partial changes merge under rev',async t=>{
 const dir=await scratch(t,'project-settings-');
 // A tickets.json from before hub.db (imported once) has projects without settings.
 await writeFile(path.join(dir,'tickets.json'),JSON.stringify({schema:1,revision:3,updatedAt:null,releases:[],tickets:[],
  projects:[{id:'legacy-app',key:'LEG',name:'Legacy',description:'',createdAt:null,rev:4,next:7}]}));
 const s=createTicketStore(dir);
 assert.deepEqual((await s.projects()).map(p=>[p.id,p.settings]),[['legacy-app',DEFAULTS]]);
 const fresh=createTicketStore(await scratch(t,'project-seed-'),{seedProjects:SEED});
 assert.deepEqual((await fresh.list()).projects.map(p=>p.settings),[DEFAULTS,DEFAULTS]);

 const made=await s.saveProject({id:'ob1',key:'OB',name:'OB1',settings:{color:'violet',wiki:false}},'a');
 assert.deepEqual(made.settings,{...DEFAULTS,color:'violet',wiki:false});
 assert.deepEqual((await s.saveProject({id:'plain',key:'PL',name:'Plain'},'a')).settings,DEFAULTS);

 let p=await s.saveProject({id:'legacy-app',rev:4,settings:{color:'teal',releases:false}},'a');
 assert.deepEqual([p.rev,p.settings],[5,{...DEFAULTS,color:'teal',releases:false}]);
 p=await s.saveProject({id:'legacy-app',rev:5,settings:{view:'table'}},'a');
 assert.deepEqual(p.settings,{...DEFAULTS,color:'teal',releases:false,view:'table'},'omitted siblings and an explicit false stay');
 p=await s.saveProject({id:'legacy-app',rev:6,name:'Legacy App'},'a');
 assert.deepEqual([p.name,p.settings.releases,p.settings.view],['Legacy App',false,'table'],'an old client that sends only name keeps the settings');
 p=await s.saveProject({id:'legacy-app',rev:7,settings:{color:null,releases:true}},'a');
 assert.deepEqual(p.settings,{...DEFAULTS,view:'table'});
 assert.deepEqual((await s.saveProject({id:'legacy-app',rev:8,settings:{}},'a')).settings,{...DEFAULTS,view:'table'});
 await assert.rejects(s.saveProject({id:'legacy-app',rev:8,settings:{wiki:false}},'a'),/conflict/);
 assert.equal((await s.create({project:'legacy-app',title:'Numbering continues'},'a')).id,'LEG-7');

 const bad=[null,[],'board',{color:'pink'},{color:''},{view:'list'},{view:null},{wiki:'false'},{reviews:0},{globalReferences:null},{extra:true},{__proto__:null,constructor:true}];
 for(const settings of bad)await assert.rejects(s.saveProject({id:'legacy-app',rev:9,settings},'a'),/invalid/,JSON.stringify(settings));
 await assert.rejects(s.saveProject({id:'bad-new',key:'BAD',name:'Bad',settings:{view:'grid'}},'a'),/invalid/);
 const after=(await s.projects()).find(p=>p.id==='legacy-app');
 assert.deepEqual([after.rev,after.settings],[9,{...DEFAULTS,view:'table'}],'a refused change writes nothing');
 assert.ok(!(await s.projects()).some(p=>p.id==='bad-new'));
 assert.equal(after.next,undefined,'the ticket counter stays internal');
});

test('project settings: a literal v1.5.0 hub.db (schema 5) moves to schema 6 with defaults and keeps rev and numbering',async t=>{
 const dir=await scratch(t,'project-migrate-'),file=path.join(dir,'hub.db'),{DatabaseSync}=process.getBuiltinModule('node:sqlite');
 const {ddl}=JSON.parse(await readFile(new URL('./fixtures/wiki-flat-1.2.0.json',import.meta.url),'utf8'));
 const old=new DatabaseSync(file);
 old.exec(ddl.join(';')+'; PRAGMA user_version=5');
 old.prepare("INSERT INTO meta VALUES ('tickets',?)").run('{"schema":1,"revision":6,"updatedAt":"2026-11-20T10:00:00.000Z"}');
 const project='{"id":"example-app","key":"APP","name":"Example App","description":"Kept","type":"app","createdAt":"2026-11-01T10:00:00.000Z","createdBy":"alice","updatedAt":"2026-11-02T10:00:00.000Z","rev":3,"next":5}';
 const seeded='{"id":"seeded-game","key":"SG","name":"Seeded","description":"","type":"game","createdAt":null,"rev":1,"next":1}';
 old.prepare("INSERT INTO docs VALUES ('tickets','projects','example-app',?)").run(project);
 old.prepare("INSERT INTO docs VALUES ('tickets','projects','seeded-game',?)").run(seeded);
 old.close();
 const db=openDb(file);
 try{
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,6);
  const row=JSON.parse(db.db.prepare("SELECT doc FROM docs WHERE kind='tickets' AND coll='projects' AND id='example-app'").get().doc);
  assert.deepEqual(row,{...JSON.parse(project),settings:DEFAULTS},'only settings is added; rev, next and every other field stay');
  const s=createTicketStore(dir,{db});
  assert.deepEqual((await s.projects()).map(p=>[p.id,p.rev,p.settings]),[['example-app',3,DEFAULTS],['seeded-game',1,DEFAULTS]]);
  assert.equal((await s.saveProject({id:'example-app',rev:3,settings:{view:'table'}},'a')).rev,4,'a rev read before the upgrade still saves');
  assert.equal((await s.create({project:'example-app',title:'After upgrade'},'a')).id,'APP-5');
 }finally{db.close();}
});

test('project settings: a hub.db newer than this code is refused, never opened',async t=>{
 const dir=await scratch(t,'project-newer-'),file=path.join(dir,'hub.db'),{DatabaseSync}=process.getBuiltinModule('node:sqlite');
 const newer=new DatabaseSync(file);newer.exec(`CREATE TABLE meta(kind TEXT PRIMARY KEY, doc TEXT NOT NULL); PRAGMA user_version=${DB_SCHEMA+1}`);newer.close();
 assert.throws(()=>openDb(file),new RegExp(`schema ${DB_SCHEMA+1} is newer than this code \\(${DB_SCHEMA}\\)`));
 // v1.5.0 runs this same check with schema 5, so it refuses a database this release has moved to 6.
 const check=new DatabaseSync(file);try{assert.equal(check.prepare('PRAGMA user_version').get().user_version,DB_SCHEMA+1);}finally{check.close();}
});

test('project settings HTTP and MCP: tickets:write saves partial settings, readers see them and cannot change them',async t=>{
 const h=await hub(t),writer=(await h.account('settings-writer',['tickets:write'])).headers,reader=(await h.account('settings-reader',['read'])).headers;
 const json=async(res,status)=>{res=await res;const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;};
 const projectsOf=async()=>(await json(fetch(h.origin+'/api/tickets',{headers:reader}),200)).projects;
 assert.deepEqual((await projectsOf()).map(p=>[p.id,p.settings]),[['home-hub',DEFAULTS],['sample-game',DEFAULTS]]);
 await json(h.post('/api/tickets/projects',{id:'home-hub',rev:1,settings:{wiki:false}},reader),403);
 await json(h.post('/api/tickets/projects',{id:'home-hub',rev:1,settings:{color:'pink'}},writer),400);
 const saved=await json(h.post('/api/tickets/projects',{id:'home-hub',rev:1,settings:{color:'amber',reviews:false}},writer),200);
 assert.deepEqual([saved.rev,saved.settings],[2,{...DEFAULTS,color:'amber',reviews:false}]);
 await json(h.post('/api/tickets/projects',{id:'home-hub',rev:1,settings:{view:'table'}},writer),409);
 const created=await json(h.post('/api/tickets/projects',{id:'new-app',key:'NEW',name:'New',settings:{view:'table'}},writer),201);
 assert.deepEqual(created.settings,{...DEFAULTS,view:'table'});

 let n=0;const call=async(headers,name,args)=>(await json(h.post('/mcp',{jsonrpc:'2.0',id:++n,method:'tools/call',params:{name,arguments:args}},headers),200)).result;
 const listed=await call(reader,'projects_list',{});
 assert.deepEqual(listed.structuredContent.projects.find(p=>p.id==='home-hub').settings,{...DEFAULTS,color:'amber',reviews:false});
 assert.equal((await call(reader,'project_save',{id:'home-hub',rev:2,settings:{view:'table'}})).isError,true);
 assert.equal((await call(writer,'project_save',{id:'home-hub',rev:2,settings:{view:'grid'}})).isError,true);
 assert.equal((await call(writer,'project_save',{id:'home-hub',rev:2,settings:{view:'table',theme:'dark'}})).isError,true);
 const mcp=await call(writer,'project_save',{id:'home-hub',rev:2,settings:{view:'table',globalReferences:false}});
 assert.equal(mcp.isError,false);
 assert.deepEqual([mcp.structuredContent.rev,mcp.structuredContent.settings],[3,{...DEFAULTS,color:'amber',reviews:false,view:'table',globalReferences:false}]);
 const tools=(await json(h.post('/mcp',{jsonrpc:'2.0',id:++n,method:'tools/list'},writer),200)).result.tools;
 const schema=tools.find(x=>x.name==='project_save').inputSchema.properties.settings;
 assert.deepEqual(Object.keys(schema.properties),Object.keys(DEFAULTS));assert.equal(schema.additionalProperties,false);
 const ticketsList=await call(reader,'tickets_list',{project:'home-hub'});
 assert.equal(ticketsList.structuredContent.projects.find(p=>p.id==='home-hub').settings.globalReferences,false);
 // Presentation settings have no side effects: the parts they hide stay reachable.
 await json(h.post('/api/tickets/projects',{id:'sample-game',rev:1,settings:{releases:false,reviews:false,wiki:false}},writer),200);
 await json(h.post('/api/tickets/releases',{project:'sample-game',version:'1.0'},writer),200);
 const {home}=await json(h.post('/api/wiki/setup',{project:'sample-game'},writer),201);
 assert.equal((await json(fetch(h.origin+'/api/wiki/sample-game',{headers:reader}),200)).home,home);
});

test('project settings: globalReferences:false narrows suggestions only; listing, resolving and saving stay as they were',async t=>{
 const h=await hub(t),writer=(await h.account('refs-writer',['tickets:write'])).headers,globalWriter=(await h.account('refs-global',['references:write'])).headers,
  reader=(await h.account('refs-reader',['read'])).headers,base='/api/references';
 const json=async(res,status=200)=>{res=await res;const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;};
 const get=(url)=>json(fetch(h.origin+url,{headers:reader}));
 const suggest=query=>get(base+'/suggest?'+new URLSearchParams(query)).then(r=>r.items.map(i=>i.kind+':'+i.label).sort());
 const own=await json(h.post(base+'/local/save',{kind:'custom',project:'home-hub',label:'Alpha own'},writer));
 await json(h.post(base+'/local/save',{kind:'custom',project:'sample-game',label:'Alpha other local'},writer));
 const globalCustom=await json(h.post(base+'/global/save',{kind:'custom',label:'Alpha global'},globalWriter));
 await json(h.post(base+'/global/save',{kind:'model',label:'Alpha model'},globalWriter));
 const ownTicket=await json(h.post('/api/tickets',{project:'home-hub',title:'Alpha own ticket'},writer),201);
 const otherTicket=await json(h.post('/api/tickets',{project:'sample-game',title:'Alpha other ticket'},writer),201);
 for(const id of [ownTicket.id,otherTicket.id])await json(h.post(base+'/share',{kind:'ticket',id,rev:0},h.admin));
 const everything=['custom:Alpha global','custom:Alpha own','model:Alpha model','ticket:Alpha other ticket','ticket:Alpha own ticket'];
 assert.deepEqual(await suggest({project:'home-hub',q:'alpha'}),everything);
 const listedBefore=await get(base+'?q=alpha&limit=100');
 const machinesBefore=await suggest({project:'home-hub',kind:'machine'}),projectsBefore=await suggest({project:'home-hub',kind:'project'});
 assert.ok(machinesBefore.length>0&&projectsBefore.length===2);

 await json(h.post('/api/tickets/projects',{id:'home-hub',rev:1,settings:{globalReferences:false}},writer));
 assert.deepEqual(await suggest({project:'home-hub',q:'alpha'}),['custom:Alpha own','ticket:Alpha own ticket'],'own sources stay, including a shared ticket the project owns');
 assert.deepEqual(await suggest({project:'home-hub',kind:'machine'}),machinesBefore);
 assert.deepEqual(await suggest({project:'home-hub',kind:'project'}),projectsBefore);
 const mcp=await json(h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'references_suggest',arguments:{project:'home-hub',q:'alpha'}}},reader));
 assert.deepEqual(mcp.result.structuredContent.items.map(i=>i.label).sort(),['Alpha own','Alpha own ticket']);
 assert.deepEqual(await suggest({project:'sample-game',q:'alpha'}),['custom:Alpha global','custom:Alpha other local','model:Alpha model','ticket:Alpha other ticket','ticket:Alpha own ticket'],'other projects are unaffected');
 assert.deepEqual(await get(base+'?q=alpha&limit=100'),listedBefore,'the catalog listing does not change');
 assert.equal((await json(h.post(base+'/resolve',{refs:[{kind:'custom',id:globalCustom.id}]},reader))).items[0].label,'Alpha global');
 // A global mention is still valid in a project that does not suggest it.
 const mention=`@[Alpha global](ref:custom/${globalCustom.id})`;
 await json(h.post('/api/tickets/comment',{id:ownTicket.id,text:mention},writer));

 // The project's References list is the existing catalog read: scope=local&project=<id>, paged by offset.
 for(let i=0;i<4;i++)await json(h.post(base+'/local/save',{kind:'custom',project:'home-hub',label:'Beta '+i},writer));
 const all=(await get(base+'?scope=local&project=home-hub&limit=100')).items.map(r=>r.kind+'/'+r.id);
 const paged=[];for(let offset=0;offset<all.length;offset+=2)paged.push(...(await get(base+`?scope=local&project=home-hub&limit=2&offset=${offset}`)).items.map(r=>r.kind+'/'+r.id));
 assert.deepEqual(paged,all,'pages are disjoint, in order and complete');
 assert.ok(all.includes('custom/'+own.id)&&all.includes('ticket/'+ownTicket.id)===false,'a shared ticket is global, not in the local list');
 assert.deepEqual((await get(base+'?scope=local&project=home-hub&kind=custom&q=beta')).items.map(r=>r.label),['Beta 0','Beta 1','Beta 2','Beta 3']);
});
