// Projects v2 UI: #projects overview filters & header, New Project opt-in defaults, Project Settings
// read-only projectVersion & labels, Danger Zone deletion dialog (counts, conditional options, scopes,
// collisions, 409 reload), and 4-step v1 -> v2 Upgrade Wizard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Element,fire,installDom} from './fixtures/mini-dom.mjs';

const {document,window}=installDom();
Element.prototype.focus=function(){document.activeElement=this;};
Element.prototype.contains=function(node){for(let n=node;n;n=n.parentNode)if(n===this)return true;return false;};
Element.prototype.showModal=function(){this.open=true;this.setAttribute('open','');};
Element.prototype.close=function(){if(!this.open)return;this.open=false;this.removeAttribute('open');fire(this,'close');};
Object.defineProperty(Element.prototype,'elements',{get(){
 const list=all(this,n=>['input','select','textarea','button'].includes(n.tagName));
 const map=Object.create(null);
 for(const n of list){const name=n.getAttribute('name');if(name&&!(name in map))map[name]=n;}
 map.namedItem=name=>map[name]??null;
 return map;
}});
const origCreate=document.createElement.bind(document);
document.createElement=tag=>{
 const el=origCreate(tag),origSet=el.setAttribute.bind(el);
 el.style={setProperty(){}};
 el.disabled=false;
 el.setAttribute=(k,v)=>{
  origSet(k,v);
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
 const origQS=el.querySelector.bind(el);
 el.querySelector=sel=>{
  if(sel==='button[type=submit]')return all(el,n=>n.tagName==='button'&&n.getAttribute('type')==='submit')[0]||null;
  return origQS(sel);
 };
 if(tag==='form'){
  return new Proxy(el,{get(target,prop,recv){
   if(prop in target)return Reflect.get(target,prop,recv);
   if(typeof prop==='string')return all(target,n=>n.getAttribute?.('name')===prop)[0];
   return undefined;
  }});
 }
 if(['input','textarea','select'].includes(tag)&&el.value===undefined)el.value='';
 if(tag==='input')el.checked=false;
 return el;
};
globalThis.addEventListener=window.addEventListener.bind(window);
globalThis.removeEventListener=window.removeEventListener.bind(window);
globalThis.dispatchEvent=e=>fire(window,e.type,e);
globalThis.location={hash:'#projects'};
globalThis.confirm=()=>true;

const {trackerView}=await import('../public/tracker-view.js');
const {setPrincipal}=await import('../public/session-cache.js');
const {setLang}=await import('../public/i18n.js');
const {leaveView}=await import('../public/views.js');

setLang('en');

const all=(root,pred=()=>true)=>{const out=[];const walk=n=>{if(pred(n))out.push(n);for(const c of n.children||[])walk(c);};walk(root);return out;};
const byName=(root,name)=>all(root,n=>n.getAttribute?.('name')===name)[0];
const button=(root,text)=>all(root,n=>n.tagName==='button'&&n.textContent.trim()===text)[0];
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};

const admin={username:'alice',canWrite:true,scopes:['read','tickets:write','review:write','references:write']};
const ticketWriterOnly={username:'bob',canWrite:true,scopes:['read','tickets:write']};
const reader={username:'carol',canWrite:false,scopes:['read']};

const makeProjects=()=>[
 {id:'portal',key:'WEB',name:'Web Portal',description:'Public site',type:'web',labels:['frontend','public'],projectVersion:2,rev:2,
  settings:{color:'blue',view:'board',releases:true,reviews:true,wiki:true,globalReferences:true}},
 {id:'legacy-app',key:'LEG',name:'Legacy App',description:'Old v1 app',type:'app',labels:['backend'],projectVersion:1,rev:4,
  settings:{color:null,view:'board',releases:true,reviews:true,wiki:true,globalReferences:true}},
];

test('projects overview: header has only + New project, supports type/label filters and shows v1 badge',async t=>{
 t.after(leaveView);
 setPrincipal(admin);
 location.hash='#projects';
 const projects=makeProjects();
 globalThis.fetch=async url=>{
  if(url==='/api/tickets')return Response.json({projects,releases:[],tickets:[],total:0});
  throw new Error('Unexpected '+url);
 };
 const root=trackerView(admin,'projects');
 document.body.replaceChildren(root);
 await flush();

 assert.ok(button(root,'+ New project'),'header has + New project');
 assert.equal(button(root,'+ New item'),undefined,'+ New item removed from #projects header');
 assert.match(root.textContent,/Web Portal/);
 assert.match(root.textContent,/frontend/);
 assert.match(root.textContent,/v1 · Upgrade/);

 // Filter by type=web
 const typeSelect=all(root,n=>n.tagName==='select'&&n.getAttribute('aria-label')==='All types')[0];
 typeSelect.value='web';
 fire(typeSelect,'change');
 await flush();
 assert.match(root.textContent,/Web Portal/);
 assert.doesNotMatch(root.textContent,/Legacy App/);

 // Filter by label=backend (combined with type=web -> empty filter state)
 const labelSelect=all(root,n=>n.tagName==='select'&&n.getAttribute('aria-label')==='All labels')[0];
 labelSelect.value='backend';
 fire(labelSelect,'change');
 await flush();
 assert.match(root.textContent,/Nothing matches the filters/);

 // Clear filters restores both projects
 fire(button(root,'Clear filters'),'click');
 await flush();
 assert.match(root.textContent,/Web Portal/);
 assert.match(root.textContent,/Legacy App/);

 // Reader sees static v1 pill without Upgrade button
 setPrincipal(reader);
 const readerRoot=trackerView(reader,'projects');
 document.body.replaceChildren(readerRoot);
 await flush();
 assert.equal(button(readerRoot,'+ New project'),undefined);
 assert.equal(all(readerRoot,n=>n.tagName==='button'&&n.textContent.includes('Upgrade')).length,0);
});

test('new project dialog: zero opt-in checkboxes checked by default, supports web type, labels and createWiki',async t=>{
 t.after(leaveView);
 setPrincipal(admin);
 location.hash='#projects';
 const posts=[];
 let wikiNavEvents=0;
 const onNav=()=>{wikiNavEvents++;};
 window.addEventListener('wikinavchange',onNav);
 t.after(()=>window.removeEventListener('wikinavchange',onNav));
 globalThis.fetch=async(url,opts={})=>{
  if(opts.method==='POST'&&url==='/api/tickets/projects'){
   const body=JSON.parse(opts.body);
   posts.push(body);
   return Response.json({...body,projectVersion:2,rev:1},{status:201});
  }
  return Response.json({projects:makeProjects(),releases:[],tickets:[],total:0});
 };
 const root=trackerView(admin,'projects');
 document.body.replaceChildren(root);
 await flush();

 fire(button(root,'+ New project'),'click');
 const dialog=all(document.body,n=>n.tagName==='dialog')[0];
 assert.ok(dialog);
 const wikiBox=byName(dialog,'wiki'),reviewBox=byName(dialog,'reviews'),typeSel=byName(dialog,'type');
 assert.equal(wikiBox.checked,false,'Wiki checkbox unchecked by default');
 assert.equal(reviewBox.checked,false,'Review checkbox unchecked by default');
 assert.ok(all(typeSel,n=>n.tagName==='option'&&n.getAttribute('value')==='web').length,'web type option available');

 const nameIn=byName(dialog,'name'),idIn=byName(dialog,'id'),keyIn=byName(dialog,'key'),descIn=byName(dialog,'description'),labelsIn=byName(dialog,'labels');
 nameIn.value='Site Redesign';
 fire(nameIn,'input');
 assert.equal(idIn.value,'site-redesign');
 assert.equal(keyIn.value,'SR');
 typeSel.value='web';
 descIn.value='New landing page';
 labelsIn.value='Web, Launch-2026';
 wikiBox.checked=true;
 reviewBox.checked=true;

 const form=all(dialog,n=>n.tagName==='form')[0];
 fire(form,'submit',{currentTarget:{id:idIn,key:keyIn,name:nameIn,description:descIn,type:typeSel,labels:labelsIn,wiki:wikiBox,reviews:reviewBox,querySelector:()=>all(form,n=>n.getAttribute('type')==='submit')[0]}});
 await flush();

 assert.equal(posts.length,1);
 assert.deepEqual(posts[0],{
  id:'site-redesign',key:'SR',name:'Site Redesign',description:'New landing page',
  type:'web',labels:['web','launch-2026'],settings:{wiki:true,reviews:true},createWiki:true,
 });
 assert.equal('projectVersion' in posts[0],false,'projectVersion is never submitted');
 assert.equal(wikiNavEvents,1,'wiki sidebar notified when createWiki is enabled');
});

test('project settings: projectVersion is read-only, Danger Zone delete-preview enforces scopes, collisions, confirmation and 409 reload',async t=>{
 t.after(leaveView);
 const projects=makeProjects();
 let previewVersion=1;
 const deletePosts=[];
 const previewData=()=>({
  id:'portal',rev:2+previewVersion,
  counts:{epics:2,tickets:5,releases:1,wikiPages:3,reviewSets:2,localReferences:2},
  collisions:[{id:'r'+'1'.repeat(32),label:'Hero',newLabel:'Hero (WEB)'}],
  snapshot:`snap-${previewVersion}`,
 });

 globalThis.fetch=async(url,opts={})=>{
  if(url==='/api/tickets?project=portal&limit=1')return Response.json({projects,releases:[],tickets:[],total:0});
  if(url==='/api/tickets/projects/portal/delete-preview')return Response.json(previewData());
  if(opts.method==='POST'&&url==='/api/tickets/projects/delete'){
   const body=JSON.parse(opts.body);
   deletePosts.push(body);
   if(body.snapshot==='snap-1'){
    previewVersion=2;
    return Response.json({error:{message:'Snapshot changed'}},{status:409});
   }
   return Response.json({deleted:true,renamedReferences:[{id:'r'+'1'.repeat(32),label:'Hero',newLabel:'Hero (WEB)'}]});
  }
  throw new Error('Unexpected '+url);
 };

 // 1. Ticket-only writer: review:write & references:write options disabled with explanations
 setPrincipal(ticketWriterOnly);
 location.hash='#projects/portal/settings';
 const limitedRoot=trackerView(ticketWriterOnly,'projects','portal');
 document.body.replaceChildren(limitedRoot);
 await flush();
 assert.ok(all(limitedRoot,n=>n.tagName==='input'&&n.getAttribute('readonly')===''&&n.value==='v2').length,'projectVersion shown read-only');
 fire(button(limitedRoot,'Delete project'),'click');
 await flush();
 let dlg=all(document.body,n=>n.tagName==='dialog')[0];
 assert.ok(dlg);
 assert.equal(byName(dlg,'deleteWiki').checked,false);
 assert.equal(byName(dlg,'deleteWiki').disabled,false);
 assert.equal(byName(dlg,'deleteReviews').disabled,true,'deleteReviews disabled without review:write');
 assert.equal(byName(dlg,'deleteReviews').checked,false);
 assert.equal(byName(dlg,'promoteReferences').disabled,true,'promoteReferences disabled without references:write');
 assert.equal(byName(dlg,'promoteReferences').checked,false,'promoteReferences unchecked when disabled');
 assert.match(dlg.textContent,/review:write/);
 assert.match(dlg.textContent,/references:write/);
 dlg.close();

 // 2. Full-scope admin: promoteReferences checked by default, collision warning visible, 409 reload & delete succeeds
 setPrincipal(admin);
 location.hash='#projects/portal/settings';
 const root=trackerView(admin,'projects','portal');
 document.body.replaceChildren(root);
 await flush();
 fire(button(root,'Delete project'),'click');
 await flush();
 dlg=all(document.body,n=>n.tagName==='dialog')[0];
 assert.equal(byName(dlg,'deleteWiki').checked,false);
 assert.equal(byName(dlg,'deleteReviews').checked,false);
 assert.equal(byName(dlg,'promoteReferences').checked,true);
 assert.match(dlg.textContent,/Hero → Hero \(WEB\)/,'collision warning shown when promoteReferences is checked');

 // Unchecking promoteReferences hides collision warning; re-checking restores it
 byName(dlg,'promoteReferences').checked=false;
 fire(byName(dlg,'promoteReferences'),'change');
 assert.doesNotMatch(dlg.textContent,/Hero → Hero \(WEB\)/);
 byName(dlg,'promoteReferences').checked=true;
 fire(byName(dlg,'promoteReferences'),'change');
 assert.match(dlg.textContent,/Hero → Hero \(WEB\)/);

 // Submit disabled until key or name entered
 const submitBtn=button(dlg,'Permanently delete project');
 assert.equal(submitBtn.disabled,true);
 const confirmIn=byName(dlg,'confirmation');
 confirmIn.value='WRONG';
 fire(confirmIn,'input');
 assert.equal(submitBtn.disabled,true);
 confirmIn.value='WEB';
 fire(confirmIn,'input');
 assert.equal(submitBtn.disabled,false);

 // First submit gets 409, shows Reload preview
 fire(all(dlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.equal(deletePosts.length,1);
 assert.deepEqual(deletePosts[0],{
  id:'portal',rev:3,confirmation:'WEB',snapshot:'snap-1',
  deleteWiki:false,deleteReviews:false,promoteReferences:true,
 });
 const reloadBtn=button(dlg,'Reload preview');
 assert.ok(reloadBtn,'409 offers Reload preview');
 fire(reloadBtn,'click');
 await flush();

 // After reload, snapshot is snap-2 and rev is 4; confirm and delete
 const confirmIn2=byName(dlg,'confirmation');
 confirmIn2.value='Web Portal';
 fire(confirmIn2,'input');
 byName(dlg,'deleteWiki').checked=true;
 fire(all(dlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.equal(deletePosts.length,2);
 assert.deepEqual(deletePosts[1],{
  id:'portal',rev:4,confirmation:'Web Portal',snapshot:'snap-2',
  deleteWiki:true,deleteReviews:false,promoteReferences:true,
 });
 assert.equal(location.hash,'#projects');
});

test('v1 -> v2 Upgrade Wizard: walks 4 steps with local refs, renameWikiHome, initial epics and ticket assignment',async t=>{
 t.after(leaveView);
 setPrincipal(admin);
 location.hash='#projects/legacy-app';
 const projects=makeProjects();
 const tickets=[
  {id:'LEG-1',project:'legacy-app',title:'Migrate auth',status:'open',type:'task',priority:'high',labels:[],release:null,assignee:null,comments:0,updatedAt:'2026-11-20T10:00:00Z',rev:1},
  {id:'LEG-2',project:'legacy-app',title:'Update CSS',status:'open',type:'task',priority:'normal',labels:[],release:null,assignee:null,comments:0,updatedAt:'2026-11-20T10:00:00Z',rev:2},
 ];
 const upgradePosts=[];
 globalThis.fetch=async(url,opts={})=>{
  if(url.startsWith('/api/tickets?project=legacy-app'))return Response.json({projects,releases:[],tickets,total:2});
  if(url.startsWith('/api/tickets/epics?project=legacy-app'))return Response.json({epics:[]});
  if(url==='/api/wiki/legacy-app?project=1')return Response.json({enabled:true,home:'whomepage1234',pages:[{id:'whomepage1234',title:'Home',parentId:null},{id:'wpage22222222',title:'Notes',parentId:'whomepage1234'}]});
  if(url==='/api/review?project=legacy-app&status=all')return Response.json({sets:[{id:'R-1',title:'Old layout'}]});
  if(url.startsWith('/api/references?'))return Response.json({items:[{kind:'custom',id:'r'+'2'.repeat(32),label:'Legacy Term'}],total:1});
  if(opts.method==='POST'&&url==='/api/tickets/projects/upgrade'){
   const body=JSON.parse(opts.body);
   upgradePosts.push(body);
   projects[1]={...projects[1],projectVersion:2,type:body.type,labels:body.labels,settings:body.settings,rev:5};
   return Response.json({project:projects[1]});
  }
  throw new Error('Unexpected '+url);
 };

 const root=trackerView(admin,'projects','legacy-app');
 document.body.replaceChildren(root);
 await flush();

 // Non-blocking v1 banner shown alongside normal project content
 assert.match(root.textContent,/This project is on v1/);
 assert.match(root.textContent,/Migrate auth/,'v1 project remains usable without upgrading');

 fire(button(root,'Start upgrade wizard'),'click');
 await flush();
 const dlg=all(document.body,n=>n.tagName==='dialog')[0];
 assert.ok(dlg);

 // Step 1 of 4: Profile
 assert.match(dlg.textContent,/Step 1 of 4/);
 const typeSel=byName(dlg,'type');typeSel.value='web';fire(typeSel,'change');
 const labelsIn=byName(dlg,'labels');labelsIn.value='v2, web';fire(labelsIn,'input');
 fire(button(dlg,'Next →'),'click');

 // Step 2 of 4: Linked Wiki & Review
 assert.match(dlg.textContent,/Step 2 of 4/);
 assert.match(dlg.textContent,/Detected Wiki: 2 pages/);
 assert.match(dlg.textContent,/R-1/);
 assert.equal(byName(dlg,'renameWikiHome').checked,true,'offers rename Home -> Legacy App Home');
 fire(button(dlg,'Next →'),'click');

 // Step 3 of 4: Local References
 assert.match(dlg.textContent,/Step 3 of 4/);
 assert.match(dlg.textContent,/Legacy Term/);
 fire(button(dlg,'Next →'),'click');

 // Step 4 of 4: Epics & existing tickets
 assert.match(dlg.textContent,/Step 4 of 4/);
 const createRadio=all(dlg,n=>n.tagName==='input'&&n.getAttribute('value')==='create')[0];
 createRadio.checked=true;fire(createRadio,'change');
 const title0=byName(dlg,'epic-title-0');title0.value='Core Modernization';fire(title0,'input');
 const desc0=byName(dlg,'epic-desc-0');desc0.value='First wave';fire(desc0,'input');
 const firstTicketCheck=all(dlg,n=>n.tagName==='input'&&n.getAttribute('type')==='checkbox')[0];
 firstTicketCheck.checked=true;fire(firstTicketCheck,'change');

 fire(button(dlg,'Complete upgrade to v2'),'click');
 await flush();

 assert.equal(upgradePosts.length,1);
 assert.deepEqual(upgradePosts[0],{
  id:'legacy-app',rev:4,type:'web',labels:['v2','web'],
  settings:{color:null,view:'board',releases:true,reviews:true,wiki:true,globalReferences:true},
  renameWikiHome:true,
  epics:[{title:'Core Modernization',description:'First wave',tickets:[{id:'LEG-1',rev:1}]}],
 });
 assert.doesNotMatch(root.textContent,/This project is on v1/,'v1 banner removed after upgrade');
});
