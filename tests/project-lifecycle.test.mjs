import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {openDb} from '../server/db.mjs';

const base='/api/tickets/projects';

async function fixture(t){
 const h=await hub(t);
 const writer=(await h.account('project-writer',['tickets:write'])).headers;
 async function read(response,status=200){
  const res=await response,body=await res.json();
  assert.equal(res.status,status,JSON.stringify(body));
  return body;
 }
 const get=(path,status=200,headers=h.admin)=>read(fetch(h.origin+path,{headers}),status);
 const post=(path,body,status=200,headers=h.admin)=>read(h.post(path,body,headers),status);
 return {dir:h.dir,writer,get,post};
}

test('project creation and rename keep the linked Wiki and project in sync',async t=>{
 const {post,get}=await fixture(t),id='example-app';
 await post(base,{id,key:'EX',name:'Example',createWiki:true,settings:{wiki:false}},400);
 const made=await post(base,{id,key:'EX',name:'Example',type:'web',labels:['demo'],createWiki:true},201);
 assert.equal(made.projectVersion,2);
 assert.equal(made.settings.wiki,true);
 const wiki=await get('/api/wiki/'+id),page='/api/wiki/'+id+'/pages/'+wiki.home;
 assert.equal((await get(page)).title,'Example Home');
 const renamed=await post(base,{id,rev:made.rev,name:'Example Two'});
 assert.equal((await get(page)).title,'Example Two Home');
 await post('/api/wiki/pages/update',{project:id,id:wiki.home,rev:(await get(page)).rev,title:'Maintainer guide'});
 await post(base,{id,rev:renamed.rev,name:'Example Three'});
 assert.equal((await get(page)).title,'Maintainer guide');
 const index=await get('/api/wiki');
 assert.equal(index.spaces.find(space=>space.id===id).name,'Example Three');
});

test('project deletion checks scopes and stale dependencies before cascading and detaching',async t=>{
 const {post,get,writer}=await fixture(t),id='example-app';
 const p=await post(base,{id,key:'EX',name:'Example',createWiki:true},201);
 const reference=await post('/api/references/local/save',{project:id,kind:'custom',label:'Tróoper'});
 await post('/api/references/global/save',{kind:'custom',label:'Trooper'});
 const ticket=await post('/api/tickets',{project:id,title:'Example marker'},201);
 const preview=()=>get(base+'/'+id+'/delete-preview');
 const before=await preview();
 assert.deepEqual(before.counts,{epics:0,tickets:1,releases:0,wikiPages:1,reviewSets:0,localReferences:1});
 assert.deepEqual(before.collisions,[{id:reference.id,label:'Tróoper',newLabel:'Tróoper (EX)'}]);
 const deletion={id,rev:p.rev,confirmation:'EX',snapshot:before.snapshot,promoteReferences:true};
 await post(base+'/delete',deletion,403,writer);
 await post(base+'/delete',{...deletion,deleteReviews:true,promoteReferences:false},403,writer);
 await post(base+'/delete',{...deletion,confirmation:'WRONG'},400);
 assert.equal((await preview()).snapshot,before.snapshot);
 const updated=await post('/api/tickets/comment',{id:ticket.id,text:'A new comment'});
 assert.equal(updated.rev,ticket.rev);
 await post(base+'/delete',deletion,409);
 await post('/api/tickets',{project:id,title:'New dependency'},201);
 assert.equal((await get('/api/tickets/'+ticket.id)).id,ticket.id);
 await post(base+'/delete',{...deletion,snapshot:(await preview()).snapshot});
 await get('/api/tickets/'+ticket.id,404);
 const spaces=(await get('/api/wiki')).spaces;
 assert.equal(spaces.find(space=>space.id===id).projectId,null);
 assert.equal((await get('/api/wiki/'+id)).enabled,true);
 const resolved=await post('/api/references/resolve',{refs:[{id:reference.id,kind:'custom'}]});
 assert.equal(resolved.items[0].label,'Tróoper (EX)');
 assert.equal(resolved.items[0].scope,'global');
 const search=await get('/api/search?q=Example%20marker&kind=ticket');
 assert.deepEqual(search.results,[]);
});

test('project upgrade commits initial epics, ticket links and legacy Wiki changes together',async t=>{
 const {dir,post,get}=await fixture(t),id='legacy-app';
 const project=await post(base,{id,key:'LEG',name:'Legacy'},201);
 const db=openDb(path.join(dir,'hub.db'));
 db.db.prepare("UPDATE docs SET doc=json_set(doc,'$.projectVersion',1) WHERE kind='tickets' AND coll='projects' AND id=?").run(id);
 const {home}=await post('/api/wiki/setup',{project:id},201);
 const page='/api/wiki/'+id+'/pages/'+home;
 assert.equal((await get(page)).title,'Home');
 const item=await post('/api/tickets',{project:id,title:'Existing task'},201);
 const input={id,rev:project.rev,type:'web',labels:['legacy'],settings:{wiki:true,reviews:false},renameWikiHome:true};
 const epic={title:'First epic',ticketIds:[item.id]};
 await post(base+'/upgrade',{...input,epics:[epic,{title:'Unavailable ticket',ticketIds:['OTH-1']}]},400);
 assert.equal((await get(page)).title,'Home');
 assert.equal((await get('/api/tickets/'+item.id)).epic,null);
 assert.equal((await get('/api/tickets')).projects.find(p=>p.id===id).projectVersion,1);
 await post(base+'/upgrade',{...input,epics:[epic]});
 const upgraded=(await get('/api/tickets')).projects.find(p=>p.id===id);
 assert.deepEqual([upgraded.projectVersion,upgraded.type,upgraded.labels,upgraded.settings.reviews],[2,'web',['legacy'],false]);
 assert.equal((await get(page)).title,'Legacy Home');
 assert.equal((await get('/api/tickets/'+item.id)).epic,'LEG-E1');
 await post(base+'/upgrade',{...input,epics:[]},409);
});

test('Epic MCP writes accept a full 64 KiB spec after JSON escaping',async t=>{
 const {post,writer}=await fixture(t);
 const project=await post(base,{id:'example-app',key:'EX',name:'Example'},201);
 const call=async(name,arguments_)=>{
  const response=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}},200,writer);
  return response.result;
 };
 const spec='"x'.repeat(32768);
 assert.equal(Buffer.byteLength(spec),65536);
 const created=await call('epic_create',{project:project.id,title:'Long spec',spec});
 assert.equal(created.isError,false,JSON.stringify(created.content));
 assert.equal(created.structuredContent.spec,spec);
 const oversized=await call('epic_create',{project:project.id,title:'Oversized spec',spec:spec+'x'});
 assert.equal(oversized.isError,true);
});

test('project deletion rolls back Tracker and search if a later Wiki write fails',async t=>{
 const {dir,post,get}=await fixture(t),id='example-app';
 const project=await post(base,{id,key:'EX',name:'Example',createWiki:true},201);
 const ticket=await post('/api/tickets',{project:id,title:'Rollback marker'},201);
 const {snapshot}=await get(base+'/'+id+'/delete-preview');
 const input={id,rev:project.rev,confirmation:'EX',snapshot,deleteWiki:true};
 const db=openDb(path.join(dir,'hub.db'));
 db.db.exec(`CREATE TRIGGER test_project_delete_failure BEFORE DELETE ON docs
  WHEN OLD.kind='wiki' AND OLD.coll='wikis'
  BEGIN SELECT RAISE(ABORT,'Injected Wiki deletion failure'); END`);
 try{
  await post(base+'/delete',input,503);
 }finally{
  db.db.exec('DROP TRIGGER test_project_delete_failure');
 }
 assert.equal((await get('/api/tickets/'+ticket.id)).id,ticket.id);
 assert.equal((await get('/api/search?q=Rollback%20marker&kind=ticket')).results[0].id,ticket.id);
 assert.equal((await get('/api/wiki/'+id)).enabled,true);
 assert.equal((await get(base+'/'+id+'/delete-preview')).snapshot,snapshot);
 await post(base+'/delete',input);
 await get('/api/tickets/'+ticket.id,404);
});

test('reusing a project key keeps deleted ticket and epic IDs unavailable',async t=>{
 const {post,get}=await fixture(t),id='example-app';
 const project=await post(base,{id,key:'EX',name:'Example'},201);
 const ticket=await post('/api/tickets',{project:id,title:'First item'},201);
 const epic=await post('/api/tickets/epics/create',{project:id,title:'First epic'},201);
 const {snapshot}=await get(base+'/'+id+'/delete-preview');
 await post(base+'/delete',{id,rev:project.rev,confirmation:'EX',snapshot});
 const replacement='replacement-app';
 await post(base,{id:replacement,key:'EX',name:'Replacement'},201);
 assert.equal((await post('/api/tickets',{project:replacement,title:'New item'},201)).id,'EX-2');
 assert.equal((await post('/api/tickets/epics/create',{project:replacement,title:'New epic'},201)).id,'EX-E2');
 await get('/api/tickets/'+ticket.id,404);
 await get('/api/tickets/epics/'+epic.id,404);
});
