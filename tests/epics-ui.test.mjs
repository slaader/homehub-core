// Epics UI, Epic filter (none = unassigned), Epic detail (#epics/<ID>), bulk assign, non-blocking done
// warning, epic references/chips, markdown bare/mention epic links, and search hits for epics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Element,fire,installDom} from './fixtures/mini-dom.mjs';

const {document,window}=installDom();
Element.prototype.focus=function(){document.activeElement=this;};
Element.prototype.contains=function(node){for(let n=node;n;n=n.parentNode)if(n===this)return true;return false;};
Element.prototype.showModal=function(){this.open=true;this.setAttribute('open','');};
Element.prototype.close=function(){if(!this.open)return;this.open=false;this.removeAttribute('open');fire(this,'close');};
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
globalThis.location={hash:'#projects/portal'};
globalThis.confirm=()=>true;

const {trackerView,ticketOrigin,backPath}=await import('../public/tracker-view.js');
const {referenceChip}=await import('../public/reference-chip.js');
const {kindName}=await import('../public/reference-picker.js');
const {markdown}=await import('../public/tracker-md.js');
const {editableMarkdownRange}=await import('../public/tracker-markdown-format.js');
const {searchView,resultHref,groupResults}=await import('../public/search-view.js');
const {setPrincipal}=await import('../public/session-cache.js');
const {setLang}=await import('../public/i18n.js');
const {leaveView}=await import('../public/views.js');

setLang('en');

const all=(root,pred=()=>true)=>{const out=[];const walk=n=>{if(pred(n))out.push(n);for(const c of n.children||[])walk(c);};walk(root);return out;};
const byName=(root,name)=>all(root,n=>n.getAttribute?.('name')===name)[0];
const button=(root,text)=>all(root,n=>n.tagName==='button'&&n.textContent.trim()===text)[0];
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};

const writer={username:'alice',canWrite:true,scopes:['read','tickets:write','references:write']};
const project={id:'portal',key:'WEB',name:'Web Portal',type:'web',labels:['frontend'],projectVersion:2,rev:1,
 settings:{color:'blue',view:'table',releases:true,reviews:true,wiki:true,globalReferences:true}};
const makeEpic=()=>({
 id:'WEB-E1',project:'portal',title:'Authentication Overhaul',description:'Unify login flows',
 spec:'## Scope\nSee @[Web Portal](ref:project/portal) and WEB-1.',
 status:'in-progress',priority:'high',release:'v2.0',assignee:'alice',labels:['auth'],
 refs:['WEB-1','WEB-E2'],attachments:[],comments:[],
 history:[{at:'2026-11-20T10:00:00Z',by:'alice',field:'created',from:null,to:'open'}],
 reporter:'alice',createdAt:'2026-11-20T10:00:00Z',updatedAt:'2026-11-21T10:00:00Z',closedAt:null,rev:2,
});
const makeTickets=()=>[
 {id:'WEB-1',project:'portal',epic:'WEB-E1',title:'Session cookies',status:'done',type:'feature',priority:'high',labels:[],release:'v2.0',assignee:'alice',comments:0,updatedAt:'2026-11-21T10:00:00Z',rev:3},
 {id:'WEB-2',project:'portal',epic:'WEB-E1',title:'Password reset',status:'open',type:'feature',priority:'normal',labels:[],release:'v2.0',assignee:null,comments:0,updatedAt:'2026-11-21T10:00:00Z',rev:1},
 {id:'WEB-3',project:'portal',epic:null,title:'Footer typo',status:'open',type:'bug',priority:'low',labels:[],release:null,assignee:null,comments:0,updatedAt:'2026-11-21T10:00:00Z',rev:4},
 {id:'WEB-4',project:'portal',epic:'WEB-E2',title:'Cache tuning',status:'open',type:'task',priority:'normal',labels:[],release:null,assignee:null,comments:0,updatedAt:'2026-11-21T10:00:00Z',rev:5},
];

test('project page Items & Epics tabs: epic=none filters unassigned tickets, Epics tab creates new epics',async t=>{
 t.after(leaveView);
 setPrincipal(writer);
 const epic=makeEpic(),tickets=makeTickets(),queries=[],created=[];
 globalThis.fetch=async(url,opts={})=>{
  if(opts.method==='POST'&&url==='/api/tickets/epics/create'){
   const body=JSON.parse(opts.body);created.push(body);
   return Response.json({...epic,id:'WEB-E2',title:body.title,spec:body.spec,rev:1},{status:201});
  }
  if(url.startsWith('/api/tickets/epics'))return Response.json({epics:[epic]});
  if(url.startsWith('/api/wiki/'))return Response.json({enabled:false});
  if(url==='/api/tickets/people')return Response.json({people:[{name:'alice'}]});
  if(url.startsWith('/api/tickets')){
   queries.push(url);
   const params=new URL(url,'http://hub.test').searchParams;
   const epicFilter=params.get('epic');
   const filtered=epicFilter==='none'?tickets.filter(x=>!x.epic):epicFilter?tickets.filter(x=>x.epic===epicFilter):tickets;
   return Response.json({projects:[project],releases:[{project:'portal',version:'v2.0',status:'planned',counts:{open:1,'in-progress':0,done:1,cancelled:0},total:2}],tickets:filtered,total:filtered.length});
  }
  throw new Error('Unexpected '+url);
 };

 // 1. Items tab with Epic filter (none = unassigned)
 location.hash='#projects/portal';
 const itemsRoot=trackerView(writer,'projects','portal');
 document.body.replaceChildren(itemsRoot);
 await flush();
 assert.ok(all(itemsRoot,n=>n.tagName==='a'&&n.getAttribute('href')==='#projects/portal/epics').length,'Epics tab link shown');
 const epicFilter=all(itemsRoot,n=>n.tagName==='select'&&n.getAttribute('aria-label')==='All epics')[0];
 assert.ok(epicFilter,'Epic filter dropdown present');
 assert.ok(all(epicFilter,n=>n.tagName==='option'&&n.getAttribute('value')==='none').length,'No epic (none) option present');
 epicFilter.value='none';
 fire(epicFilter,'change');
 await flush();
 assert.ok(queries.some(u=>u.includes('epic=none')),'sends epic=none for unassigned filter');
 assert.match(itemsRoot.textContent,/Footer typo/);
 assert.doesNotMatch(itemsRoot.textContent,/Password reset/);

 // 2. Epics tab & creating a new epic
 location.hash='#projects/portal/epics';
 const epicsRoot=trackerView(writer,'projects','portal');
 document.body.replaceChildren(epicsRoot);
 await flush();
 assert.match(epicsRoot.textContent,/Authentication Overhaul/);
 assert.match(epicsRoot.textContent,/50 %/,'progress bar shows 1/2 done = 50%');

 fire(button(epicsRoot,'+ New epic'),'click');
 await flush();
 const dlg=all(document.body,n=>n.tagName==='dialog')[0];
 assert.ok(dlg);
 const form=all(dlg,n=>n.tagName==='form')[0];
 const titleIn=byName(dlg,'title'),specIn=byName(dlg,'spec'),descIn=byName(dlg,'description');
 const statusIn=byName(dlg,'status'),prioIn=byName(dlg,'priority'),relIn=byName(dlg,'release'),assIn=byName(dlg,'assignee'),labIn=byName(dlg,'labels');
 titleIn.value='Performance Pass';
 descIn.value='Speed up SSR';
 specIn.value='x'.repeat(20000); // > 16 KiB, <= 64 KiB allowed for epic spec
 fire(form,'submit',{currentTarget:{title:titleIn,description:descIn,spec:specIn,status:statusIn,priority:prioIn,release:relIn,assignee:assIn,labels:labIn,querySelector:()=>all(form,n=>n.getAttribute('type')==='submit')[0]}});
 await flush();
 assert.equal(created.length,1);
 assert.equal(created[0].title,'Performance Pass');
 assert.equal(created[0].spec.length,20000);
});

test('epic detail (#epics/WEB-E1): non-blocking done notice, bulk assign {tickets:[{id,rev}]}, linked reviews and delete',async t=>{
 t.after(leaveView);
 setPrincipal(writer);
 let epic=makeEpic();
 const tickets=makeTickets(),posts=[];
 globalThis.fetch=async(url,opts={})=>{
  if(opts.method==='POST'){
   const body=JSON.parse(opts.body);
   if(url==='/api/references/resolve')return Response.json({items:[]});
   posts.push({url,body});
   if(url==='/api/tickets/epics/update'){epic={...epic,...body,rev:epic.rev+1};return Response.json(epic);}
   if(url==='/api/tickets/epics/WEB-E1/assign'){
    for(const item of body.tickets){const tk=tickets.find(x=>x.id===item.id);if(tk){tk.epic='WEB-E1';tk.rev++;}}
    return Response.json({assigned:body.tickets.length});
   }
   if(url==='/api/tickets/epics/delete')return Response.json({deleted:true});
  }
  if(url==='/api/tickets/epics/WEB-E1')return Response.json(epic);
  if(url==='/api/tickets/people')return Response.json({people:[{name:'alice'}]});
  if(url.startsWith('/api/tickets?project=portal'))return Response.json({projects:[project],releases:[],tickets,total:tickets.length});
  if(url.startsWith('/api/review?project=portal'))return Response.json({sets:[{id:'R-5',title:'Login screens',tickets:['WEB-2'],feedbackPending:true},{id:'R-6',title:'Unrelated',tickets:['WEB-3']}]});
  throw new Error('Unexpected '+url);
 };

 location.hash='#epics/WEB-E1';
 const root=trackerView(writer,'epics','WEB-E1');
 document.body.replaceChildren(root);
 await flush();

 assert.match(root.textContent,/Authentication Overhaul/);
 assert.match(root.textContent,/Unify login flows/);
 assert.match(root.textContent,/Linked tickets \(2\)/);
 assert.match(root.textContent,/Linked Reviews \(1\)/);
 assert.match(root.textContent,/R-5 · Login screens/);
 assert.doesNotMatch(root.textContent,/R-6 · Unrelated/);

 // Marking epic done while WEB-2 is still open shows non-blocking notice without blocking the write
 fire(button(root,'✓ Done'),'click');
 await flush();
 assert.deepEqual(posts[0],{url:'/api/tickets/epics/update',body:{id:'WEB-E1',rev:2,status:'done'}});
 assert.match(root.textContent,/Epic is marked done, but still has unfinished items/);

 // Bulk assign existing tickets sends {tickets:[{id,rev}]}
 fire(button(root,'+ Assign existing tickets'),'click');
 await flush();
 const assignDlg=all(document.body,n=>n.tagName==='dialog')[0];
 assert.ok(assignDlg);
 assert.match(assignDlg.textContent,/currently in WEB-E2/);
 const checks=all(assignDlg,n=>n.tagName==='input'&&n.getAttribute('type')==='checkbox');
 assert.equal(checks.length,2,'excludes tickets already in WEB-E1');
 checks[0].checked=true;fire(checks[0],'change');
 checks[1].checked=true;fire(checks[1],'change');
 fire(all(assignDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[1],{url:'/api/tickets/epics/WEB-E1/assign',body:{tickets:[{id:'WEB-3',rev:4},{id:'WEB-4',rev:5}]}});
 assert.match(root.textContent,/Linked tickets \(4\)/);

 // Delete epic sends {id, rev} and navigates back to #projects/portal/epics
 fire(button(root,'Delete epic'),'click');
 const delDlg=all(document.body,n=>n.tagName==='dialog')[0];
 fire(all(delDlg,n=>n.tagName==='form')[0],'submit');
 await flush();
 assert.deepEqual(posts[2],{url:'/api/tickets/epics/delete',body:{id:'WEB-E1',rev:3}});
 assert.equal(location.hash,'#projects/portal/epics');
});

test('epic references, markdown rendering, breadcrumbs and search hits work end-to-end',async t=>{
 t.after(leaveView);
 globalThis.fetch=async url=>{
  if(url==='/api/references/resolve')return Response.json({items:[{kind:'epic',id:'WEB-E1',label:'Auth Overhaul'}]});
  if(url.startsWith('/api/search?'))return Response.json({
   semanticAvailable:false,mode:'text',indexed:{ticket:2,epic:1,review:1},attachmentSearch:{state:'ready'},
   results:[
    {kind:'epic',id:'WEB-E1',title:'WEB-E1 Auth \u0001Overhaul\u0002',project:'portal',snippet:'\u0001Overhaul\u0002 login',meta:{status:'in-progress'}},
    {kind:'ticket',id:'WEB-1',title:'WEB-1 Session',project:'portal',meta:{status:'open'}},
   ],
  });
  throw new Error('Unexpected '+url);
 };

 assert.equal(kindName('epic'),'Epic');
 const chip=referenceChip({kind:'epic',id:'WEB-E1',label:'Old label'});
 assert.equal(chip.getAttribute('href'),'#epics/WEB-E1');
 await flush();
 assert.equal(chip.textContent,'Auth Overhaul');

 // Markdown renders both explicit epic mention and bare WEB-E1 link
 const md=markdown('See @[Auth](ref:epic/WEB-E1) and bare WEB-E1',{keys:['WEB'],references:true});
 const links=all(md,n=>n.tagName==='a').map(a=>a.getAttribute('href'));
 assert.deepEqual(links,['#epics/WEB-E1','#epics/WEB-E1']);
 assert.equal(editableMarkdownRange('plain WEB-E1',6,12,{keys:['WEB'],files:()=>null}),false);

 // ticketOrigin & backPath remember #epics/WEB-E1
 assert.equal(ticketOrigin('#epics/WEB-E1','#items/WEB-1',''),'#epics/WEB-E1');
 assert.equal(backPath({id:'WEB-1',project:'portal'},[project],'#epics/WEB-E1').getAttribute('href'),'#epics/WEB-E1');

 // Search view routes epic hits to #epics/<ID> and groups them under Epics
 assert.equal(resultHref({kind:'epic',id:'WEB-E1'}),'#epics/WEB-E1');
 assert.deepEqual(groupResults([{kind:'review',id:'R-1'},{kind:'epic',id:'WEB-E1'},{kind:'ticket',id:'WEB-1'}]).map(g=>g.kind),['ticket','epic','review']);
 setPrincipal(writer);
 const sr=searchView(writer,'overhaul');
 document.body.replaceChildren(sr);
 await flush();
 assert.ok(all(sr,n=>n.tagName==='a'&&n.getAttribute('href')==='#epics/WEB-E1').length);
 assert.match(sr.textContent,/Epics/);
});
