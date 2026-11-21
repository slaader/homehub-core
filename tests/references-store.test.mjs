import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {openDb} from '../server/db.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createWikiStore} from '../server/wiki-store.mjs';
import {createReferences} from '../server/references.mjs';
import {referenceToken} from '../public/reference-format.js';

const project='home-hub',other='sample-game';
const custom={kind:'custom',id:'r'+'a'.repeat(32),label:'Unit [A] \\ guide'};
const doc=c=>({v:1,blocks:[{t:'inventory',id:'units',columns:[{id:'name',label:'Name'}],
 rows:[{id:'first',cells:{name:{c}}}]}]});
const run=({kind,id,label})=>({t:'ref',kind,id,label});

test('standalone ticket and wiki stores enforce mention visibility including same-project, shared and unshared wiki targets',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ref-standalone-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=openDb(path.join(dir,'hub.db'));
 t.after(()=>db.close());
 const seed=[{id:project,key:'HH',name:'Home Hub'},{id:other,key:'SG',name:'Sample Game'}];
 const tickets=createTicketStore(path.join(dir,'tickets'),{db,seedProjects:seed});
 const wiki=createWikiStore(db,tickets);
 const stubHub={db,site:{devices:[],lanCidrs:[]},state:id=>id==='tracker'?{tickets}:id==='wiki'?{wiki}:id==='home'?{homeDevices:{list:async()=>[],siteOverrides:async()=>({})}}:null};
 const refs=createReferences(stubHub);
 const t1=await tickets.create({project,title:'Primary ticket'},'alice');
 const t2=await tickets.create({project:other,title:'Other ticket'},'alice');
 const {home}=await wiki.setup({project},'alice');
 const {home:otherHome}=await wiki.setup({project:other},'alice');
 const t1Token=referenceToken({kind:'ticket',id:t1.id,label:t1.title});
 const t2Token=referenceToken({kind:'ticket',id:t2.id,label:t2.title});
 const projToken=referenceToken({kind:'project',id:other,label:'Sample Game'});
 const missingToken=referenceToken(custom);
 const pageRef={kind:'wiki',id:project+'/'+home,label:'Home'};
 const otherPageRef={kind:'wiki',id:other+'/'+otherHome,label:'Other home'};
 const wikiMention=referenceToken(pageRef),otherWikiMention=referenceToken(otherPageRef);

 // Original standalone tickets instance allows same-project tickets/wiki and existing projects, rejects unshared cross-project or missing refs.
 const linked=await tickets.create({project,title:'Linked',description:`See ${t1Token}, ${wikiMention} and ${projToken}`},'alice');
 assert.equal(linked.project,project);
 await assert.rejects(()=>tickets.create({project,title:'Cross ticket',description:t2Token},'alice'),/unavailable-reference/);
 await assert.rejects(()=>tickets.comment({id:t1.id,text:t2Token},'alice'),/unavailable-reference/);
 await assert.rejects(()=>tickets.create({project,title:'Unshared cross wiki',description:otherWikiMention},'alice'),/unavailable-reference/);
 await assert.rejects(()=>tickets.create({project,title:'Missing',description:missingToken},'alice'),/unavailable-reference/);

 // Sharing the cross-project wiki page makes it mentionable by the original standalone tickets instance.
 await refs.annotate({kind:'wiki',id:otherPageRef.id,rev:0},'alice',true);
 const sharedLinked=await tickets.create({project,title:'Shared cross wiki',description:otherWikiMention},'alice');
 assert.equal(sharedLinked.project,project);

 // Standalone wiki store allows same-project wiki/tickets, shared cross-project wiki, and projects; rejects unshared cross-project or missing targets.
 const createdPage=await wiki.create({project,title:'Notes',doc:doc([run(pageRef),run(otherPageRef),{t:'ticket',id:t1.id},run({kind:'project',id:other,label:'Sample Game'})])},'alice');
 assert.equal(createdPage.project,project);
 const unsharedOther=await wiki.create({project:other,title:'Private page'},'alice');
 await assert.rejects(()=>wiki.create({project,title:'Bad wiki',doc:doc([run({kind:'wiki',id:other+'/'+unsharedOther.id,label:'Private page'})])},'alice'),/unavailable-reference/);
 await assert.rejects(()=>wiki.create({project,title:'Bad ticket',doc:doc([{t:'ticket',id:t2.id}])},'alice'),/unavailable-reference/);
 await assert.rejects(()=>wiki.create({project,title:'Bad custom',doc:doc([run(custom)])},'alice'),/unavailable-reference/);
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
 const stubHub={db,site:{devices:[],lanCidrs:[]},state:id=>id==='tracker'?{tickets}:id==='wiki'?{wiki}:id==='home'?{homeDevices:{list:async()=>[],siteOverrides:async()=>({})}}:null};
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
});
