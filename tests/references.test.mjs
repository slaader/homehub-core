import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {hub} from './hub-helper.mjs';
import {openDb,DB_SCHEMA} from '../server/db.mjs';
import {createWikiStore} from '../server/wiki-store.mjs';
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
 await post('/api/tickets/comment',{id:otherTicket.id,text:token},writer,400);
 await post('/api/tickets/update',{id:otherTicket.id,rev:1,description:token},writer,400);
 const {home}=await post('/api/wiki/setup',{project},writer,201);
 const saved=await post('/api/wiki/pages/update',{project,id:home,rev:1,doc:doc([{t:'text',text:'Inventory '},run(first)])});
 const otherHome=(await post('/api/wiki/setup',{project:other},writer,201)).home;
 assert.equal((await rpc('wiki_page_save',{project:other,pageId:otherHome,rev:1,doc:doc([run(first)])},writer)).isError,true);
 assert.deepEqual((await get(base+'/suggest?project='+project+'&q=tRO')).items.map(r=>r.id),[first.id]);
 assert.deepEqual((await get(base+'/suggest?project='+other+'&q=tro')).items,[]);
 const used=await item('custom',first.id);
 assert.equal(used.usageTotal,3);assert.deepEqual(new Set(used.usages.map(u=>u.excerpt)),new Set(['Inventory Tróoper','Description Tróoper','Comment Tróoper']));
 const promote={kind:'custom',id:first.id,project,rev:first.rev};
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
 assert.equal(notShared.error.code,'WIKI_FAILED');
 await post(base+'/share',{kind:'wiki',id:pageRef.id,rev:0},h.admin);
 await post('/api/wiki/pages/update',{project:other,id:otherHome,rev:1,doc:doc([run(pageRef)])});
 assert.equal((await item('wiki',pageRef.id)).usages[0].source.href,'#wiki/'+other+'/'+otherHome);
 await post('/api/wiki/pages/update',{project,id:home,rev:saved.rev,doc:doc([])});
 assert.equal((await item('custom',first.id)).usageTotal,3);
 const model=await rpc('reference_save',{kind:'model',label:'Example model',description:'Offline documentation'},global);
 assert.equal(model.structuredContent.kind,'model');
 assert.equal((await rpc('reference_get',{kind:'model',id:model.structuredContent.id},reader)).structuredContent.record.description,'Offline documentation');
 const machine=(await item('machine','mini')).record;
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
