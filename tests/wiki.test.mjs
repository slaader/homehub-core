import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hub} from './hub-helper.mjs';
import {openDb} from '../server/db.mjs';
import {createWikiStore} from '../server/wiki-store.mjs';
import {createTicketStore} from '../server/tickets-store.mjs';
import {createWikiPreviews,staticWikiHtml,WIKI_FRAME_CSP} from '../server/wiki-frame.mjs';
import {extractLinks,normalizeDoc,PAGE_ID,WIKI_LIMITS} from '../public/wiki-doc.js';
import {canWriteWiki} from '../public/wiki-content.js';
import {serializeWiki} from '../public/wiki-editor.js';

const project='home-hub',wiki='/api/wiki',list=wiki+'/'+project;
const pageUrl=id=>list+'/pages/'+id;
const doc=(...blocks)=>({v:1,blocks});
const text=(text,m)=>({t:'text',text,...(m?{m}:{})});
const p=(...c)=>({t:'p',c});
const ticket=id=>({t:'ticket',id});
const html=source=>({t:'html',id:'habcdefgh',label:'Status card',height:140,source});
const get=(h,url,headers=h.admin)=>fetch(h.origin+url,{headers});
async function response(result,status){
 const reply=await result;
 const data=await reply.json();
 assert.equal(reply.status,status,JSON.stringify(data));
 return data;
}

test('wiki document: canonical runs, ticket links in tables and strict validation',()=>{
 const normalized=normalizeDoc(doc(
  p(text('Heading',['i','b','b']),{t:'link',href:'HTTPS://EXAMPLE.COM/guide',c:[text('Guide')]}),
  {t:'ol',items:[[ticket('APP-1')]]},
  {t:'table',header:true,rows:[[[ticket('APP-2')],[ticket('APP-1')]]]},
  html('<b>Source stays verbatim</b>'),
 ));
 assert.deepEqual(normalized.blocks[0],p(text('Heading',['b','i']),{t:'link',href:'https://example.com/guide',c:[text('Guide')]}));
 assert.deepEqual(normalizeDoc(normalized),normalized);
 assert.throws(()=>normalizeDoc(doc(p({t:'link',href:'https://example.com/'+'é'.repeat(400),c:[text('Long')]}))),/invalid/);
 assert.deepEqual(extractLinks(normalized),{tickets:['APP-1','APP-2']});
 assert.equal(normalized.blocks[3].source,'<b>Source stays verbatim</b>');
 for(const input of [
  {...doc(),links:{tickets:[]}},doc({t:'h',level:4,c:[]}),doc(p({t:'page',id:'wabcdefghijk'})),
  doc(p({t:'link',href:'javascript:0',c:[text('bad')]})),doc(p({t:'link',href:'https://example.com',c:[ticket('APP-1')]})),
  doc(p({t:'ticket',id:'app-1'})),doc(p(text('bad',['u']))),doc({t:'table',header:true,rows:[[[]],[[],[]]]}),
  doc(html('a'),html('b')),doc(html('a\0b')),doc(html('\ud800')),
 ])assert.throws(()=>normalizeDoc(input),/^Error: invalid$/);
 assert.throws(()=>normalizeDoc(doc(html('é'.repeat(WIKI_LIMITS.htmlBytes/2+1)))),/^Error: limit$/);
 assert.throws(()=>normalizeDoc(doc({t:'table',header:false,rows:[[[text('x'.repeat(WIKI_LIMITS.cell+1))]]]})),/^Error: limit$/);
 assert.throws(()=>normalizeDoc(doc(p(text('x'.repeat(WIKI_LIMITS.docBytes))))),/^Error: limit$/);
});

test('wiki editor serialization preserves marked text, ticket chips, table rows and HTML blocks',()=>{
 const txt=data=>({nodeType:3,data});
 const element=(tagName,childNodes=[],attrs={})=>{
  const classList={contains:name=>attrs.className===name};
  return {nodeType:1,tagName,childNodes,children:childNodes.filter(child=>child.nodeType===1),dataset:attrs.dataset??{},classList,
   style:{textDecorationLine:''},getAttribute:name=>attrs[name]??null,querySelector:()=>attrs.table};
 };
 for(const tag of ['OL','UL']){
  const list=element(tag,[element('LI',[txt('List item')])]);
  const wrapped=element('DIV',[element('P',[list])]);
  assert.deepEqual(serializeWiki(wrapped,new WeakMap()),doc({t:tag.toLowerCase(),items:[[text('List item')]]}));
 }
 const chip=element('SPAN',[txt('Display text')],{dataset:{ticket:'APP-1'}});
 const heading=element('H2',[element('B',[txt('Title')])]);
 const url=element('A',[txt('Guide')],{href:'https://example.com/'});
 const td=(...nodes)=>element('TD',nodes);
 const table={rows:[{cells:[element('TH',[txt('Ticket')]),element('TH',[txt('Notes')])]},
  {cells:[td(chip),td(txt('Line 1'),element('BR'),txt('Line 2'))]}]};
 const tableBlock=element('DIV',[],{className:'wiki-table',table});
 const card=element('DIV',[txt('HTML editor chrome')]),saved=html('<em>Source</em>');
 const root=element('DIV',[heading,element('P',[url]),tableBlock,card,element('P',[element('BR')])]);
 const actual=normalizeDoc(serializeWiki(root,new WeakMap([[card,saved]])));
 assert.deepEqual(actual,doc({t:'h',level:2,c:[text('Title',['b'])]},
  p({t:'link',href:'https://example.com/',c:[text('Guide')]}),
  {t:'table',header:true,rows:[[[text('Ticket')],[text('Notes')]],[[ticket('APP-1')],[text('Line 1'),text('\n'),text('Line 2')]]]},
  saved));
});

test('wiki HTTP setup is atomic and idempotent, and writes require the tracker scope',async t=>{
 const h=await hub(t);
 const reader=await h.account('wiki-reader',['read']),otherWriter=await h.account('review-editor',['review:write']);
 const writer=await h.account('wiki-editor',['tickets:write']);
 assert.equal(canWriteWiki({canWrite:true,scopes:['read','tickets:write']}),true);
 assert.equal(canWriteWiki({canWrite:true,scopes:['read','review:write']}),false);
 assert.equal(canWriteWiki({canWrite:false,scopes:['read']}),false);
 assert.deepEqual(await response(get(h,list,reader.headers),200),{enabled:false});
 await response(get(h,list,{}),401);
 await response(get(h,wiki+'/unknown-project'),404);
 await response(h.post(wiki+'/pages',{project,title:'Too soon'},h.admin),404);
 for(const credential of [reader,otherWriter])await response(h.post(wiki+'/setup',{project},credential.headers),403);
 const requests=await Promise.all(Array.from({length:8},()=>h.post(wiki+'/setup',{project},writer.headers)));
 assert.deepEqual(requests.map(reply=>reply.status).sort(),[200,200,200,200,200,200,200,201]);
 const results=await Promise.all(requests.map(reply=>reply.json())),homes=new Set(results.map(reply=>reply.home));
 assert.equal(homes.size,1);
 const [home]=homes;
 assert.match(home,PAGE_ID);
 assert.equal(results.filter(reply=>reply.created).length,1);
 const meta=await response(get(h,list,reader.headers),200);
 assert.equal(meta.home,home);
 assert.equal(meta.pages.length,1);
 assert.equal(meta.pages[0].doc,undefined);
 const saved=await response(get(h,pageUrl(home),reader.headers),200);
 assert.equal(saved.title,'Home');
 assert.equal(saved.rev,1);
 assert.equal(saved.provenance.kind,'agent');
 assert.deepEqual(saved.doc,doc({t:'h',level:1,c:[text('Home Hub')]}));
 const page=await response(h.post(wiki+'/pages/update',{project,id:home,rev:1,doc:doc(p(text('Edited Home')))},h.admin),200);
 assert.equal(page.rev,2);
 assert.deepEqual(await response(h.post(wiki+'/setup',{project},writer.headers),200),{created:false,home});
 assert.deepEqual((await response(get(h,pageUrl(home)),200)).doc,page.doc);
 const manifest=await response(get(h,'/api/ui/manifest'),200);
 assert.deepEqual(manifest.pages.find(page=>page.hash==='wiki')?.view,{url:'/wiki-view.js',export:'wikiPage'});
 assert.ok(manifest.nav.every(group=>group.items.every(item=>item.hash!=='wiki')));
 assert.equal((await get(h,'/wiki-view.js',{})).status,200);
});

test('wiki HTTP ticket backlinks follow the saved revision and changes to title and content',async t=>{
 const h=await hub(t);
 const foreign=await response(h.post('/api/tickets',{project:'sample-game',title:'Foreign ticket'},h.admin),201);
 const local=await response(h.post('/api/tickets',{project,title:'Existing ticket'},h.admin),201);
 await response(h.post(wiki+'/setup',{project},h.admin),201);
 for(const id of [foreign.id,'HH-999999']){
  await response(h.post(wiki+'/pages',{project,title:'Invalid link',doc:doc(p(ticket(id)))},h.admin),400);
 }
 const start=doc(p(ticket(local.id)),{t:'table',header:false,rows:[[[ticket(local.id)]]]});
 const page=await response(h.post(wiki+'/pages',{project,title:'  Before  ',doc:start},h.admin),201);
 assert.equal(page.title,'Before');
 assert.deepEqual(page.links,{tickets:[local.id]});
 const backlinks=wiki+'/tickets/'+local.id+'/backlinks';
 assert.deepEqual(await response(get(h,backlinks),200),{pages:[{project,id:page.id,title:'Before',updatedAt:page.updatedAt}]});
 const one=await response(h.post(wiki+'/pages/update',{project,id:page.id,rev:1,title:'After'},h.admin),200);
 assert.equal(one.id,page.id);
 assert.equal(one.rev,2);
 assert.equal((await response(get(h,backlinks),200)).pages[0].title,'After');
 const stale=await response(h.post(wiki+'/pages/update',{project,id:page.id,rev:1,doc:doc(p(text('Local draft')))},h.admin),409);
 assert.deepEqual(stale.current,{rev:2,updatedAt:one.updatedAt,updatedBy:one.updatedBy});
 assert.deepEqual((await response(get(h,pageUrl(page.id)),200)).doc,start);
 const removed=await response(h.post(wiki+'/pages/update',{project,id:page.id,rev:2,doc:doc()},h.admin),200);
 assert.deepEqual(removed.links,{tickets:[]});
 assert.deepEqual(await response(get(h,backlinks),200),{pages:[]});
 assert.deepEqual(removed.history.map(change=>change.field),['created','title','content']);
 await response(h.post(wiki+'/pages/update',{project,id:page.id,rev:3,parent:null},h.admin),400);
 await response(get(h,wiki+'/sample-game/pages/'+page.id),404);
});

test('wiki page and projection survive reopening the existing tracker database',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'wiki-test-')),file=path.join(dir,'hub.db');
 let db=openDb(file);
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 let tickets=createTicketStore(dir,{db,seedProjects:[{id:'example-app',key:'APP',name:'Example app',description:'Imported\0notes'}]});
 const old=await tickets.create({project:'example-app',title:'Before the wiki'},'alice');
 db.db.exec('PRAGMA user_version=1');
 db.close();
 db=openDb(file);
 assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,2);
 tickets=createTicketStore(dir,{db});
 let store=createWikiStore(db,tickets);
 assert.deepEqual(await store.list('example-app'),{enabled:false});
 const {home}=await store.setup({project:'example-app'},'alice');
 const edits=await Promise.allSettled(['First','Second'].map(title=>store.update({
  project:'example-app',id:home,rev:1,title,doc:doc(p(ticket(old.id))),
 },'alice')));
 assert.deepEqual(edits.map(edit=>edit.status),['fulfilled','rejected']);
 assert.equal(edits[1].reason.message,'conflict');
 db.close();
 db=openDb(file);
 tickets=createTicketStore(dir,{db});
 store=createWikiStore(db,tickets);
 assert.equal((await tickets.get(old.id)).title,'Before the wiki');
 const saved=await store.get('example-app',home),meta=await store.list('example-app');
 assert.equal(saved.rev,2);
 assert.equal(saved.title,'First');
 assert.deepEqual(meta.pages[0].links,{tickets:[old.id]});
 assert.equal(meta.pages[0].title,saved.title);
 assert.equal(meta.pages[0].doc,undefined);
 assert.equal((await store.backlinks(old.id))[0].id,home);
 db.db.exec("UPDATE meta SET doc=json_set(doc,'$.schema',2) WHERE kind='wiki'");
 await assert.rejects(store.list('example-app'),/Unsupported wiki schema/);
 await assert.rejects(store.update({project:'example-app',id:home,rev:2,title:'Unsupported'},'alice'),/Unsupported wiki schema/);
});

test('wiki frames: safe static HTML, restrictive headers and preview ownership',async t=>{
 const h=await hub(t),other=await h.account('other-writer',['tickets:write']);
 const {home}=await response(h.post(wiki+'/setup',{project},h.admin),201);
 const source='<style>.card { color: blue }</style><div class="card" onclick="alert(1)">Useful text</div>'+
  '<img src="https://example.com/pixel" alt="Remote"><img src="data:image/png;base64,YQ==" alt="Local">'+
  '<script>bad()</script><meta http-equiv="refresh" content="0;url=https://example.com">'+
  '<a href="https://example.com" ping="https://example.com">Link text</a><iframe src="https://example.com"></iframe>';
 await response(h.post(wiki+'/pages/update',{project,id:home,rev:1,doc:doc(html(source))},h.admin),200);
 const stored=wiki+'/frame/'+project+'/'+home+'/'+html(source).id;
 await response(get(h,stored,{}),401);
 const preview=await response(h.post(wiki+'/preview',{source},other.headers),200);
 const draft=wiki+'/frame/preview/'+preview.token;
 await response(get(h,draft),404);
 for(const reply of [await get(h,stored),await get(h,draft,other.headers)]){
  assert.equal(reply.status,200);
  assert.equal(reply.headers.get('content-type'),'text/html; charset=utf-8');
  assert.equal(reply.headers.get('content-security-policy'),WIKI_FRAME_CSP);
  assert.equal(reply.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.equal(reply.headers.get('x-content-type-options'),'nosniff');
  assert.equal(reply.headers.get('referrer-policy'),'no-referrer');
  assert.equal(reply.headers.get('cache-control'),'no-store');
  const body=await reply.text();
  assert.match(body,/<style>\.card \{ color: blue \}<\/style><div class="card">Useful text<\/div>/);
  assert.match(body,/<img alt="Remote"><img src="data:image\/png;base64,YQ==" alt="Local">/);
  assert.match(body,/<a>Link text<\/a>/);
  assert.doesNotMatch(body,/iframe|script|onclick|https:|refresh|bad\(\)/i);
 }
 assert.doesNotMatch(staticWikiHtml('<svg><use href="https://example.com/x"/></svg><img srcset="https://example.com/p 1x">'),/https:|href|srcset/);
});

test('wiki HTML preview storage prunes expired entries and bounds active drafts',()=>{
 let now=0;
 const previews=createWikiPreviews(()=>now),owner='author';
 const first=previews.put(owner,'<p>Private draft</p>');
 assert.equal(previews.get(owner,first),'<p>Private draft</p>');
 assert.throws(()=>previews.get('another',first),/^Error: not-found$/);
 for(let i=1;i<20;i++)previews.put(owner,'');
 assert.throws(()=>previews.put(owner,''),/^Error: limit$/);
 now=10*60*1000;
 assert.throws(()=>previews.get(owner,first),/^Error: not-found$/);
 assert.ok(previews.put(owner,''));
});
