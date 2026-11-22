// db.changeCollections: one SQLite transaction over selected rows of several collections (server/db.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {openDb} from '../server/db.mjs';

const rows=list=>(list||[]).map(x=>[x.id,x]),docs=list=>(list||[]).map(([,d])=>d);
function store(db,kind,{failOn=null}={}){
 return db.collection(kind,{empty:()=>({schema:1,items:[],others:[]}),searchKinds:[kind==='alpha'?'ticket':'review'],
  search:(coll,d)=>{if(failOn&&d.id===failOn)throw new Error('injected');return coll==='items'?{kind:kind==='alpha'?'ticket':'review',id:d.id,project:'p',updated:null,title:d.title,body:''}:null;},
  split:({items,others,...meta})=>({meta,colls:{items:rows(items),others:rows(others)}}),
  join:(meta,c)=>({...meta,items:docs(c.items),others:docs(c.others)})});
}
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hh-dbc-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=openDb(path.join(dir,'hub.db'));t.after(()=>db.close());
 return db;
}

test('changeCollections commits selected rows of several collections together, with counts and search',async t=>{
 const db=await setup(t),a=store(db,'alpha'),b=store(db,'beta');
 await a.change({items:[]},d=>{d.items.push({id:'A-1',title:'apple'},{id:'A-2',title:'apricot'});});
 await b.change({items:[]},d=>{d.items.push({id:'B-1',title:'banana'});});
 const result=await db.changeCollections([{store:a,selection:{items:['A-1']}},{store:b,selection:{items:null}}],([da,dbb],[ca,cb])=>{
  assert.deepEqual(da.items.map(x=>x.id),['A-1'],'only the selected row is loaded');
  assert.equal(ca('items'),2);assert.equal(cb('items'),1);
  da.items=[];dbb.items[0].title='blueberry';dbb.items.push({id:'B-2',title:'cherry'});
  return 'done';
 });
 assert.equal(result,'done');
 assert.deepEqual((await a.list('items')).map(x=>x.id),['A-2'],'the deselected row stays, the selected one is deleted');
 assert.deepEqual((await b.list('items')).map(x=>x.title),['blueberry','cherry']);
 assert.equal(db.search({q:'apple'}).total,0,'a deleted row leaves the search index');
 assert.equal(db.search({q:'apricot'}).total,1);
 assert.equal(db.search({q:'blueberry'}).total,1);
});

test('changeCollections rolls every collection back on a throw, and caches move only after a commit',async t=>{
 const db=await setup(t),a=store(db,'alpha'),b=store(db,'beta',{failOn:'B-bad'});
 await a.change({items:[]},d=>{d.items.push({id:'A-1',title:'apple'});});
 const before=[await a.version(),await b.version()];
 await assert.rejects(db.changeCollections([{store:a,selection:{items:null}},{store:b,selection:{items:null}}],([da])=>{da.items=[];throw new Error('stop');}),/stop/);
 // The second collection fails while it saves, after the first one has written its rows.
 await assert.rejects(db.changeCollections([{store:a,selection:{items:null}},{store:b,selection:{items:null}}],([da,dbb])=>{da.items=[];dbb.items.push({id:'B-bad',title:'x'});}),/injected/);
 assert.deepEqual((await a.list('items')).map(x=>x.id),['A-1']);
 assert.deepEqual(await b.list('items'),[]);
 assert.equal(db.search({q:'apple'}).total,1,'the search entry of a rolled-back delete stays');
 assert.deepEqual([await a.version(),await b.version()],before,'nothing that a cache keys on moved');
});

test('changeCollections refuses an async function, an unknown store and a repeated store; readOnly writes nothing',async t=>{
 const db=await setup(t),a=store(db,'alpha'),b=store(db,'beta');
 await a.change({items:[]},d=>{d.items.push({id:'A-1',title:'apple'});});
 await assert.rejects(db.changeCollections([{store:a,selection:{items:null}}],async([d])=>{d.items=[];}),TypeError);
 assert.equal((await a.list('items')).length,1);
 await assert.rejects(db.changeCollections([{store:{},selection:{}}],()=>{}),TypeError);
 await assert.rejects(db.changeCollections([{store:a,selection:{}},{store:a,selection:{}}],()=>{}),TypeError);
 await assert.rejects(db.changeCollections([{store:a,selection:null}],()=>{}),TypeError);
 const version=await a.version();
 const seen=await db.changeCollections([{store:a,selection:{items:null}},{store:b,selection:{items:null}}],([da,dbb],[ca])=>{const n=da.items.length+dbb.items.length+ca('items');da.items=[];return n;},{readOnly:true});
 assert.equal(seen,2);
 assert.equal((await a.list('items')).length,1,'a read-only transaction never saves');
 assert.equal(await a.version(),version);
 // durable commits like any other.
 await db.changeCollections([{store:a,selection:{items:['A-1']}}],([da])=>{da.items[0].title='avocado';},{durable:true});
 assert.equal((await a.get('items','A-1')).title,'avocado');
});

test('changeCollections makes a collection ready before it begins',async t=>{
 const db=await setup(t),fresh=store(db,'alpha');
 const n=await db.changeCollections([{store:fresh,selection:{items:null}}],([d],[count])=>{d.items.push({id:'A-9',title:'new'});return count('items');});
 assert.equal(n,0);
 assert.equal((await fresh.get('items','A-9')).title,'new');
});
