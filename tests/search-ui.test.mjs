// The search page and the platform search settings, drawn in the mini DOM against the canonical status shapes of
// GET /api/search, GET/POST /api/admin/platform/search: every readiness state says what it means (ready, indexing,
// degraded, semantic off, hybrid fallen back to text), attachment hits cite their file as text, a redraw keeps the
// keyboard focus where it was, and both pages use the shared components and the design tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installDom,fire,Element} from './fixtures/mini-dom.mjs';

const {document}=installDom();
Element.prototype.focus=function(){document.activeElement=this;};
const {searchView,searchNotice,citationOf}=await import('../public/search-view.js');
const {platformSettingsPage,searchStatusView}=await import('../public/platform-settings-view.js');
const {setPrincipal}=await import('../public/session-cache.js');
const {setLang}=await import('../public/i18n.js');
const nodes=n=>[n,...n.children.flatMap(nodes)];
const find=(root,pred)=>nodes(root).find(pred);
const byClass=(root,c)=>nodes(root).filter(n=>n.classList?.contains(c));
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
const admin={id:'owner',username:'alice',name:'Alice',role:'admin',roleId:'owner',roleName:'Owner',authKind:'session',canAdmin:true};
const reply=(body,status=200)=>({ok:status<300,status,json:async()=>body});
const modeOf=url=>new URL(String(url),'http://example.test').searchParams.get('mode');
setLang('en');setPrincipal(admin);

test('search notice: one line per readiness state, nothing when the results are complete',()=>{
 const ready={semanticAvailable:true,mode:'text',attachmentSearch:{state:'ready'}};
 assert.equal(searchNotice(ready,'text'),null);
 assert.equal(searchNotice({...ready,semanticAvailable:false},'text'),null,'semantic off does not concern a full-text search');
 assert.equal(searchNotice({results:[]},'text'),null,'a response without attachmentSearch (a review-only search) is complete');
 assert.equal(searchNotice({...ready,attachmentSearch:{state:'indexing'}}).tone,'info');
 assert.equal(searchNotice({...ready,attachmentSearch:{state:'closed'}}).tone,'info');
 const degraded=searchNotice({...ready,attachmentSearch:{state:'degraded',extraction:{capacity:1}}});
 assert.equal(degraded.tone,'warn');assert.match(degraded.body,/may be incomplete/);
 const off=searchNotice({...ready,semanticAvailable:false,attachmentSearch:{state:'disabled'}},'semantic');
 assert.equal(off.tone,'warn');assert.equal(off.fallback,true);assert.match(off.body,/turned off/);
 assert.equal(searchNotice({...ready,semanticAvailable:false},'hybrid').fallback,true);
 assert.match(searchNotice({...ready,mode:'text'},'hybrid').body,/full-text search only/,'hybrid that fell back to text says so');
 assert.equal(searchNotice({...ready,mode:'hybrid'},'hybrid'),null);
});

test('search: an attachment-content hit cites its file by name, as text only',async()=>{
 assert.equal(citationOf({source:'attachment',name:'notes.txt'}),'notes.txt');
 assert.equal(citationOf({source:'ticket',name:'x'}),null);assert.equal(citationOf({source:'attachment'}),null);assert.equal(citationOf(null),null);
 const evil='<img src=x onerror=alert(1)>.txt';
 globalThis.fetch=async()=>reply({semanticAvailable:false,mode:'text',indexed:{ticket:2,review:0},attachmentSearch:{state:'ready'},results:[
  {kind:'ticket',id:'APP-1',title:'APP-1 Login',snippet:'the \u0001token\u0002 expired',source:'attachment',attachment:'f1',name:evil,meta:{status:'open'}},
  {kind:'ticket',id:'APP-2',title:'APP-2 Other',snippet:'plain'}]});
 document.body.replaceChildren(searchView(admin,'token'));await tick();
 const [first,second]=byClass(document.body,'sr-hit');
 const source=byClass(first,'sr-source')[0];assert.ok(source,'the citation is drawn');
 assert.equal(source.textContent,`📎 Attachment: ${evil}`);assert.equal(source.getAttribute('title'),'Found in the attachment contents');
 assert.ok(!nodes(document.body).some(n=>n.tagName==='img'),'a file name never becomes markup');
 assert.equal(byClass(second,'sr-source').length,0,'a ticket hit has no citation');
 assert.equal(find(first,n=>n.tagName==='mark').textContent,'token');
 assert.equal(byClass(document.body,'ui-banner').length,0,'ready: no notice');
 assert.equal(find(document.body,n=>n.tagName==='select'),undefined,'semantic off: no mode picker, full-text only');
});

test('search: indexing and degraded show a banner above the results; the empty query shows the tips',async()=>{
 for(const [state,tone] of [['indexing','info'],['degraded','warn']]){
  globalThis.fetch=async()=>reply({semanticAvailable:false,mode:'text',indexed:{ticket:1,review:0},attachmentSearch:{state},results:[]});
  document.body.replaceChildren(searchView(admin,'anything'));await tick();
  const banners=byClass(document.body,'ui-banner');assert.equal(banners.length,1,state);
  assert.ok(banners[0].classList.contains(tone),state);assert.equal(banners[0].getAttribute('role'),'status');
  assert.match(document.body.textContent,/Nothing found/,'the empty result is still said, with the notice above it');
 }
 globalThis.fetch=async()=>reply({semanticAvailable:false,indexed:{ticket:3,review:1},results:[]});
 document.body.replaceChildren(searchView(admin,''));await tick();
 assert.match(document.body.textContent,/How to search/);assert.match(document.body.textContent,/In the index: 3 items and 1 review set/);
 assert.equal(byClass(document.body,'ui-banner').length,0);
});

test('search: semantic switched off while asked for offers full-text, and the admin a way to the setting',async()=>{
 const requests=[];let available=true;
 globalThis.fetch=async url=>{requests.push(modeOf(url));return reply({semanticAvailable:available,mode:modeOf(url),indexed:{ticket:1,review:0},
  attachmentSearch:{state:available||modeOf(url)==='text'?'ready':'disabled'},results:[]});};
 for(const me of [admin,{...admin,canAdmin:false,role:'viewer'}]){
  requests.length=0;available=true;
  document.body.replaceChildren(searchView(me,'login'));await tick();
  const select=find(document.body,n=>n.tagName==='select');select.value='semantic';available=false;fire(select,'change');await tick();
  assert.deepEqual(requests,['text','semantic']);
  const notice=byClass(document.body,'ui-banner')[0];assert.ok(notice?.classList.contains('warn'));assert.match(notice.textContent,/Meaning-based search is turned off/);
  assert.equal(nodes(notice).some(n=>n.getAttribute?.('href')==='#platform-settings'),me.canAdmin,'only an admin gets the settings link');
  const back=find(notice,n=>n.tagName==='button'&&n.textContent==='Search full-text');fire(back,'click');await tick();
  assert.deepEqual(requests,['text','semantic','text']);
  assert.equal(byClass(document.body,'ui-banner').length,0,'full-text again: the notice goes');
  assert.equal(find(document.body,n=>n.tagName==='select'),undefined,'and so does the picker, semantic being off');
 }
});

test('search: a kind chip keeps the keyboard focus after the results are redrawn; a failure clears aria-busy',async()=>{
 globalThis.fetch=async()=>reply({semanticAvailable:false,mode:'text',indexed:{ticket:1,review:1},attachmentSearch:{state:'ready'},
  results:[{kind:'ticket',id:'APP-1',title:'APP-1 a'},{kind:'review',id:'R-1',title:'R-1 b'}]});
 document.body.replaceChildren(searchView(admin,'a'));await tick();
 const chip=byClass(document.body,'sys-chip').find(n=>n.getAttribute('data-kind')==='review');fire(chip,'click');
 const now=document.activeElement;assert.notEqual(now,chip,'the chips are drawn again');
 assert.ok(now.isConnected);assert.equal(now.getAttribute('data-kind'),'review');assert.equal(now.getAttribute('aria-pressed'),'true');
 assert.deepEqual(byClass(document.body,'sr-hit').map(n=>n.getAttribute('href')),['#review/R-1']);
 globalThis.fetch=async()=>reply({error:{code:'unavailable'}},503);
 document.body.replaceChildren(searchView(admin,'a'));await tick();
 const body=byClass(document.body,'sr-body')[0];assert.equal(body.hasAttribute('aria-busy'),false);
 assert.match(document.body.textContent,/Search is unavailable right now/);
});

test('platform settings: the status is read once from the canonical top-level fields',()=>{
 const status={state:'ready',semanticState:'indexing',coverage:{chunks:4,embedded:1,pending:3,failed:0,ratio:.25},
  extraction:{attachments:5,indexed:2,unsupported:1,oversize:1,invalid:0,missing:0,capacity:1,metadataCapacity:0,ticketCapacity:0}};
 const v=searchStatusView({configured:true,enabled:true,status});
 assert.deepEqual(v.fullText,{label:'Ready',tone:'good'});assert.deepEqual(v.semantic,{label:'Indexing',tone:'info'});
 assert.deepEqual(v.vectors,{done:1,total:4,failed:0});
 assert.deepEqual(v.attachments,{total:5,indexed:2,omitted:[{key:'unsupported',label:'unsupported type',n:1},{key:'oversize',label:'too large',n:1},{key:'capacity',label:'over the index limit',n:1}]});
 assert.deepEqual(searchStatusView({configured:true,enabled:false,status}).semantic,{label:'Off',tone:''});
 assert.deepEqual(searchStatusView({configured:false,enabled:false,status}).semantic,{label:'Not configured',tone:''});
 assert.deepEqual(searchStatusView({configured:true,enabled:true,status:{...status,semanticState:'degraded'}}).semantic.tone,'bad');
 assert.deepEqual(searchStatusView({configured:true,enabled:true,status:{...status,state:'degraded'}}).fullText,{label:'Incomplete',tone:'warn'});
 const empty=searchStatusView({configured:true,enabled:true});
 assert.deepEqual(empty.vectors,{done:0,total:0,failed:0},'a missing field counts as zero');assert.equal(empty.fullText.label,'—');
 assert.equal(searchStatusView({status:{state:'warming'}}).fullText.label,'warming','an unknown state is shown as it is');
});

test('platform settings: unconfigured provider is a warning tied to the disabled toggle',async()=>{
 globalThis.fetch=async()=>reply({defaultMode:'text',configured:false,enabled:false,model:null,status:{state:'ready',semanticState:'disabled',coverage:{chunks:0,embedded:0}}});
 document.body.replaceChildren(platformSettingsPage({me:admin}));await tick();
 const toggle=find(document.body,n=>n.getAttribute?.('id')==='semantic-enabled');
 assert.ok(toggle.hasAttribute('disabled'));assert.equal(toggle.getAttribute('aria-describedby'),'semantic-provider-missing');
 const missing=find(document.body,n=>n.getAttribute?.('id')==='semantic-provider-missing');
 assert.ok(missing.classList.contains('ui-banner')&&missing.classList.contains('warn'));assert.match(missing.textContent,/Configure a provider/);
 assert.match(document.body.textContent,/Not configured/);assert.doesNotMatch(document.body.textContent,/Vectors/,'no vector count without a provider');
});

test('platform settings: saving keeps the focus on the toggle and says it saved; refresh and errors keep it too',async()=>{
 const calls=[];let enabled=false;
 globalThis.fetch=async(url,options={})=>{calls.push(options.method||'GET');if(options.body)enabled=JSON.parse(options.body).enabled;
  return reply({defaultMode:'text',configured:true,enabled,model:'example-model',status:{state:'ready',semanticState:enabled?'indexing':'disabled',
   coverage:{chunks:4,embedded:enabled?1:0,failed:enabled?2:0},extraction:{attachments:2,indexed:2}}});};
 document.body.replaceChildren(platformSettingsPage({me:admin}));await tick();
 assert.match(document.body.textContent,/Provider configured\. Model: example-model/);assert.match(document.body.textContent,/2 of 2 indexed/);
 let toggle=find(document.body,n=>n.getAttribute?.('id')==='semantic-enabled');toggle.checked=true;fire(toggle,'change');await tick();
 assert.deepEqual(calls,['GET','POST']);
 toggle=document.activeElement;assert.equal(toggle.getAttribute('id'),'semantic-enabled');assert.ok(toggle.isConnected);assert.equal(toggle.getAttribute('checked'),'');
 assert.match(document.body.textContent,/Saved\./);assert.match(document.body.textContent,/Indexing/);assert.match(document.body.textContent,/1\/4/);
 assert.ok(byClass(document.body,'ui-pill').some(p=>p.classList.contains('bad')&&p.textContent==='2 failed'),'failed vectors are counted');
 const refresh=find(document.body,n=>n.tagName==='button'&&n.textContent==='Refresh status');fire(refresh,'click');await tick();
 assert.equal(document.activeElement.textContent,'Refresh status');assert.ok(document.activeElement.isConnected);
 globalThis.fetch=async()=>({ok:false,status:502,json:async()=>{throw new SyntaxError('Unexpected token <');}});
 fire(document.activeElement,'click');await tick();
 assert.match(document.body.textContent,/Request failed\./,'an HTML error page is not shown as a parser error');
 assert.equal(document.activeElement.textContent,'Try again');assert.ok(document.activeElement.isConnected);
});

test('both pages: text-safe DOM, shared components, design tokens',()=>{
 const pub=new URL('../public/',import.meta.url),src=f=>readFileSync(new URL(f,pub),'utf8');
 for(const file of ['search-view.js','platform-settings-view.js']){
  const code=src(file);
  assert.doesNotMatch(code,/innerHTML|outerHTML|insertAdjacentHTML|document\.write/,`${file}: no markup from strings`);
  assert.match(code,/from '\.\/ui\.js'/);assert.match(code,/banner\(/,`${file}: states use the shared banner`);
  assert.doesNotMatch(code,/coverage\?\.extraction|\.coverage\.extraction/,`${file}: extraction is read from its canonical top-level field`);
 }
 const rules=css=>css.split('}').filter(r=>/\.(sr-mode|sr-notice|sr-source)|\.set-card \.(ui-banner|set-dl)/.test(r));
 const added=[...rules(src('tickets.css')),...rules(src('settings.css'))];
 assert.ok(added.length>=4);
 for(const r of added)assert.doesNotMatch(r,/#[0-9a-f]{3,8}\b|rgb\(/i,`colours come from the tokens: ${r}`);
 assert.match(src('tickets.css'),/\.sr-source\{[^}]*overflow-wrap:anywhere/,'a long file name wraps at 320px');
 assert.match(src('settings.css'),/@media\(max-width:480px\)\{\.set-card \.set-dl\{grid-template-columns:1fr/,'the status list stacks on a phone');
});
