// Wiki spaces & sidebar filtering + Review project chips, top-right project badges & detached read-only flows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Element,fire,installDom} from './fixtures/mini-dom.mjs';

const {document,window}=installDom();
Element.prototype.focus=function(){document.activeElement=this;};
Element.prototype.showModal=function(){this.open=true;this.setAttribute('open','');};
Element.prototype.close=function(){if(!this.open)return;this.open=false;this.removeAttribute('open');fire(this,'close');};
Element.prototype.getBoundingClientRect=()=>({top:0,bottom:20,left:0,width:400,height:20});
const origCreate=document.createElement.bind(document);
document.createElement=tag=>{
 const el=origCreate(tag),origSet=el.setAttribute.bind(el);
 el.style={setProperty(){}};
 el.dataset=el.dataset||{};
 el.disabled=false;
 el.setAttribute=(k,v)=>{
  origSet(k,v);
  if(k.startsWith('data-'))el.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v);
  if(k==='value')el.value=String(v);
  if(k==='checked')el.checked=true;
  if(k==='disabled')el.disabled=true;
 };
 const origRemove=el.removeAttribute.bind(el);
 el.removeAttribute=k=>{
  origRemove(k);
  if(k==='checked')el.checked=false;
  if(k==='disabled')el.disabled=false;
 };
 if(['input','textarea','select'].includes(tag)&&el.value===undefined)el.value='';
 if(tag==='input')el.checked=false;
 return el;
};
globalThis.addEventListener=window.addEventListener.bind(window);
globalThis.removeEventListener=window.removeEventListener.bind(window);
globalThis.dispatchEvent=e=>fire(window,e.type,e);
globalThis.location={hash:'#wiki'};
globalThis.history={replaceState(_s,_t,hash){location.hash=hash;}};
globalThis.requestAnimationFrame=fn=>setImmediate(fn);
globalThis.cancelAnimationFrame=id=>clearImmediate(id);
globalThis.confirm=()=>true;

const {createWikiNavigation}=await import('../public/wiki-navigation.js');
const {wikiPage}=await import('../public/wiki-view.js');
const {reviewView}=await import('../public/review-view.js');
const {referencePicker}=await import('../public/reference-picker.js');
const {setPrincipal}=await import('../public/session-cache.js');
const {setLang}=await import('../public/i18n.js');
const {leaveView}=await import('../public/views.js');

setLang('en');

const all=(root,pred=()=>true)=>{const out=[];const walk=n=>{if(pred(n))out.push(n);for(const c of n.children||[])walk(c);};walk(root);return out;};
const byName=(root,name)=>all(root,n=>n.getAttribute?.('name')===name)[0];
const button=(root,text)=>all(root,n=>n.tagName==='button'&&n.textContent.trim()===text)[0];
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};

const writer={id:'u1',username:'alice',authKind:'session',canWrite:true,scopes:['read','tickets:write','review:write','references:write']};
const reader={id:'u2',username:'carol',authKind:'session',canWrite:false,scopes:['read']};

test('wiki sidebar: reads spaces, filters disabled linked wikis, preserves direct links and shows + New wiki for writers',async()=>{
 const nav=createWikiNavigation({
  readIndex:async()=>({
   projects:[{id:'portal',name:'Web Portal',home:'whome1111111'}],
   spaces:[
    {id:'portal',name:'Web Portal',home:'whome1111111',projectId:'portal'},
    {id:'hidden-proj',name:'Hidden Project',home:'whome2222222',projectId:'hidden-proj',settings:{wiki:false}},
    {id:'notes',name:'Team Notes',home:'whome3333333',projectId:null},
   ],
  }),
  readTree:async id=>({enabled:true,home:'whome1111111',pages:[{id:'whome1111111',title:'Home',parentId:null}]}),
  canWrite:()=>true,
 });
 const slot=nav.mount('#projects');
 document.body.append(slot);
 await flush();
 assert.equal(slot.hidden,false);
 const trigger=all(slot,n=>n.getAttribute('data-wiki-focus')==='wiki')[0];
 fire(trigger,'click');
 assert.match(slot.textContent,/Web Portal/);
 assert.match(slot.textContent,/Team Notes/);
 assert.doesNotMatch(slot.textContent,/Hidden Project/,'linked disabled wiki filtered out of sidebar');
 assert.ok(all(slot,n=>n.tagName==='a'&&n.getAttribute('href')==='#wiki?new').length,'+ New wiki link present for writers');

 // Direct visit observe with sidebarHidden:true keeps disabled project out of sidebar
 nav.observe('hidden-proj',{enabled:true,home:'whome2222222',pages:[{id:'whome2222222',title:'Home',parentId:null}]},'Hidden Project',{sidebarHidden:true});
 assert.doesNotMatch(slot.textContent,/Hidden Project/);
});

test('wiki overview & standalone space management: create, rename, link to project, delete and direct disabled link',async t=>{
 t.after(leaveView);
 setPrincipal(writer);
 const posts=[];
 const home='whomeaaaaaaa';
 const spaces=[
  {id:'portal',name:'Web Portal',projectId:'portal',home:'whomebbbbbbb',count:2},
  {id:'handbook',name:'Handbook',projectId:null,home,count:1},
 ];
 const projects=[
  {id:'portal',key:'WEB',name:'Web Portal',settings:{wiki:true}},
  {id:'alpha',key:'ALP',name:'Alpha Project',settings:{wiki:true}},
  {id:'quiet',key:'QUI',name:'Quiet Project',settings:{wiki:false}},
 ];
 globalThis.fetch=async(url,opts={})=>{
  if(opts.method==='POST'){
   const body=JSON.parse(opts.body);
   if(url==='/api/references/resolve')return Response.json({items:[]});
   posts.push({url,body});
   if(url==='/api/wiki/spaces')return Response.json({id:body.id,name:body.name??'Handbook',projectId:body.projectId??null,home});
   if(url==='/api/wiki/spaces/delete')return Response.json({deleted:true});
  }
  if(url==='/api/wiki')return Response.json({projects:[spaces[0]],spaces});
  if(url.startsWith('/api/tickets?limit=1'))return Response.json({projects,releases:[],tickets:[],total:0});
  if(url.startsWith('/api/tickets?project='))return Response.json({projects,releases:[],tickets:[],total:0});
  if(url==='/api/wiki/handbook')return Response.json({enabled:true,id:'handbook',name:'Handbook',projectId:null,home,pages:[{id:home,title:'Handbook Home',parentId:null}]});
  if(url==='/api/wiki/handbook/pages/'+home)return Response.json({
   project:'handbook',id:home,title:'Handbook Home',rev:1,
   doc:{v:1,blocks:[{t:'p',c:[{t:'text',text:'Detached ticket: '},{t:'ticket',id:'OLD-9'}]}]},
   links:{tickets:['OLD-9']},updatedAt:'2026-11-20T10:00:00Z',updatedBy:'alice',
  });
  if(url==='/api/wiki/quiet')return Response.json({enabled:true,id:'quiet',name:'Quiet Project',projectId:'quiet',home,pages:[{id:home,title:'Quiet Home',parentId:null}]});
  if(url==='/api/wiki/quiet/pages/'+home)return Response.json({
   project:'quiet',id:home,title:'Quiet Home',rev:1,doc:{v:1,blocks:[]},links:{tickets:[]},updatedAt:'2026-11-20T10:00:00Z',updatedBy:'alice',
  });
  throw new Error('Unexpected '+url);
 };

 // 1. #wiki overview & create standalone wiki
 location.hash='#wiki';
 const overview=wikiPage({me:writer,sub:null});
 document.body.replaceChildren(overview);
 await flush();
 assert.match(overview.textContent,/Web Portal/);
 assert.match(overview.textContent,/Handbook/);
 assert.match(overview.textContent,/Standalone wiki/);
 fire(button(overview,'+ New wiki'),'click');
 const createDlg=all(document.body,n=>n.tagName==='dialog')[0];
 const nameIn=byName(createDlg,'name'),idIn=byName(createDlg,'id');
 nameIn.value='Architecture Docs';fire(nameIn,'input');
 assert.equal(idIn.value,'architecture-docs');
 fire(all(createDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[0],{url:'/api/wiki/spaces',body:{id:'architecture-docs',name:'Architecture Docs',create:true}});

 // 2. Standalone space page: breadcrumbs, detached ticket renders safely, rename, link to project, delete
 location.hash='#wiki/handbook';
 const spaceRoot=wikiPage({me:writer,sub:'handbook'});
 document.body.replaceChildren(spaceRoot);
 await flush();
 assert.match(spaceRoot.textContent,/Handbook Home/);
 assert.ok(all(spaceRoot,n=>n.getAttribute('href')==='#wiki').length,'standalone breadcrumb links to #wiki');
 assert.ok(all(spaceRoot,n=>n.classList?.contains('wiki-ticket-missing')).length,'missing ticket rendered safely as unavailable badge');

 // Rename space
 fire(button(spaceRoot,'Rename wiki'),'click');
 const renDlg=all(document.body,n=>n.tagName==='dialog')[0];
 byName(renDlg,'name').value='Engineering Handbook';
 fire(all(renDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[1],{url:'/api/wiki/spaces',body:{id:'handbook',name:'Engineering Handbook',create:false}});

 // Link to project (only projects without a wiki are offered: alpha and quiet, not portal)
 fire(button(spaceRoot,'Link to project'),'click');
 await flush();
 const linkDlg=all(document.body,n=>n.tagName==='dialog')[0];
 const projOpts=all(linkDlg,n=>n.tagName==='option').map(o=>o.getAttribute('value'));
 assert.deepEqual(projOpts,['alpha','quiet']);
 byName(linkDlg,'projectId').value='alpha';
 fire(all(linkDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[2],{url:'/api/wiki/spaces',body:{id:'handbook',projectId:'alpha',create:false}});

 // Delete space with confirmation
 fire(button(spaceRoot,'Delete wiki'),'click');
 const delDlg=all(document.body,n=>n.tagName==='dialog')[0];
 const conf=byName(delDlg,'confirmation');
 conf.value='handbook';fire(conf,'input');
 fire(all(delDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[3],{url:'/api/wiki/spaces/delete',body:{id:'handbook'}});
 assert.equal(location.hash,'#wiki');

 // 3. Direct link to linked project whose settings.wiki === false still works and reports sidebarHidden:true
 location.hash='#wiki/quiet';
 let observedOptions=null;
 const directRoot=wikiPage({me:writer,sub:'quiet',onWikiTree:(_id,_meta,_name,opts)=>{observedOptions=opts;}});
 document.body.replaceChildren(directRoot);
 await flush();
 assert.match(directRoot.textContent,/Quiet Home/,'direct link still renders when settings.wiki is false');
 assert.deepEqual(observedOptions,{sidebarHidden:true});
});

test('standalone referencePicker suggests global references without project param',async()=>{
 const requested=[];
 globalThis.fetch=async url=>{
  requested.push(url);
  return Response.json({items:[{kind:'machine',id:'build-box',label:'Build Box',scope:'global'}]});
 };
 const node=document.createElement('textarea');
 const panel=referencePicker(node,{project:()=>null,canGlobal:true,standalone:true,context:()=>({selected:'',before:'@Bu',position:3,trim:0,replace(){}})});
 document.body.append(node,panel);
 fire(node,'input');
 await flush();
 assert.deepEqual(requested,['/api/references/suggest?q=Bu']);
 assert.match(panel.textContent,/Build Box/);
});

test('review overview & detached sets: project chips, detached=true, top-right badges, read-only detail, reassign and delete',async t=>{
 t.after(leaveView);
 setPrincipal(writer);
 const projects=[
  {id:'portal',key:'WEB',name:'Web Portal',type:'web',settings:{color:'teal',reviews:true}},
  {id:'none',key:'NON',name:'Project None',type:'app',settings:{color:'blue',reviews:true}},
 ];
 const activeSet={
  id:'R-1',project:'portal',title:'Landing Hero',status:'open',done:false,feedbackPending:false,
  tickets:['WEB-1'],round:{n:1,items:1,decided:0,kinds:['html'],publishedAt:'2026-11-20T10:00:00Z'},rev:1,
 };
 const detachedSetSummary={
  id:'R-2',project:null,detachedProjectName:'Old App',title:'Archived Mockups',status:'open',done:false,feedbackPending:false,
  tickets:['OLD-1'],round:{n:1,items:1,decided:0,kinds:['image'],publishedAt:'2026-11-19T10:00:00Z'},rev:3,
 };
 const detachedSetFull={
  id:'R-2',project:null,detachedProjectName:'Old App',title:'Archived Mockups',description:'Saved from old app',status:'open',
  feedbackPending:false,tickets:['OLD-1'],rev:3,
  rounds:[{n:1,publishedAt:'2026-11-19T10:00:00Z',publishedBy:'agent',notes:'Initial',addresses:[],
   items:[{id:'shot',title:'Shot 1',kind:'image',mode:'choose',variants:[{id:'a',label:'A',title:'Option A',media:[{sha256:'a'.repeat(64),type:'image/png'}]}]}],
   feedback:{}}],
 };
 const urls=[],posts=[];
 globalThis.fetch=async(url,opts={})=>{
  if(opts.method==='POST'){
   const body=JSON.parse(opts.body);posts.push({url,body});
   return Response.json({ok:true,id:body.id,rev:(body.rev||1)+1,project:body.project??null});
  }
  urls.push(url);
  if(url.startsWith('/api/tickets?limit=1'))return Response.json({projects,releases:[],tickets:[],total:0});
  if(url==='/api/tickets/OLD-1')return Response.json({error:{message:'Not found'}},{status:404});
  if(url==='/api/review/sets/R-2')return Response.json(detachedSetFull);
  if(url.includes('detached=true'))return Response.json({sets:[detachedSetSummary]});
  if(url.includes('project=none'))return Response.json({sets:[]});
  return Response.json({sets:[activeSet,detachedSetSummary]});
 };

 // 1. Overview with project chips and top-right badges
 location.hash='#review';
 const listRoot=reviewView(writer,null);
 document.body.replaceChildren(listRoot);
 await flush();
 const badges=all(listRoot,n=>n.classList?.contains('rv-card-project'));
 assert.equal(badges.length,2,'every card has a top-right project badge');
 assert.equal(badges[0].getAttribute('data-project-color'),'teal');
 assert.match(badges[0].textContent,/Web Portal/);
 assert.match(badges[1].textContent,/Old App · no project/);
 assert.equal(all(listRoot,n=>n.classList?.contains('rv-card-bin')).length,1,'no archive bin on detached card');

 // Clicking "No project" chip sends detached=true (never project=none!)
 const noProjectChip=button(listRoot,'No project');
 assert.ok(noProjectChip,'No project chip shown when detached sets exist');
 fire(noProjectChip,'click');
 await flush();
 assert.ok(urls.some(u=>u.includes('detached=true')&&!u.includes('project=none')),'uses detached=true');

 // Project with literal id "none" still queries project=none
 fire(button(listRoot,'Project None'),'click');
 await flush();
 assert.ok(urls.some(u=>u.includes('project=none')&&!u.includes('detached=true')),'preserves literal project=none');

 // 2. Detached set detail: read-only, reassign and delete actions for review:write
 location.hash='#review/R-2';
 const detRoot=reviewView(writer,'R-2');
 document.body.replaceChildren(detRoot);
 await flush();
 assert.match(detRoot.textContent,/This review set is detached \(read-only\)/);
 assert.match(detRoot.textContent,/Old App · no project/);
 assert.equal(all(detRoot,n=>n.classList?.contains('rv-pick')).length,0,'variant pick buttons hidden on detached set');
 assert.equal(button(detRoot,'Archive'),undefined,'Archive button hidden on detached set');
 assert.equal(button(detRoot,'Change ticket links'),undefined,'ticket linking hidden on detached set');

 // Reassign action
 fire(button(detRoot,'Reassign to project'),'click');
 const reDlg=all(document.body,n=>n.tagName==='dialog')[0];
 byName(reDlg,'project').value='portal';
 fire(all(reDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[0],{url:'/api/review/sets/reassign',body:{id:'R-2',rev:3,project:'portal'}});

 // Delete action
 fire(button(detRoot,'Delete review set'),'click');
 const delDlg=all(document.body,n=>n.tagName==='dialog')[0];
 fire(all(delDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[1],{url:'/api/review/sets/delete',body:{id:'R-2',rev:3}});
 assert.equal(location.hash,'#review');

 // 3. Reader without review:write cannot see Reassign or Delete buttons on detached set
 setPrincipal(reader);
 location.hash='#review/R-2';
 const readerDet=reviewView(reader,'R-2');
 document.body.replaceChildren(readerDet);
 await flush();
 assert.match(readerDet.textContent,/This review set is detached \(read-only\)/);
 assert.equal(button(readerDet,'Reassign to project'),undefined);
 assert.equal(button(readerDet,'Delete review set'),undefined);
});
