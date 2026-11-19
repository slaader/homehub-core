import test from 'node:test';
import assert from 'node:assert/strict';
import {Element,fire,installDom} from './fixtures/mini-dom.mjs';
import {createWikiNavigation} from '../public/wiki-navigation.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const descendants=node=>[node,...node.children.flatMap(descendants)];
const focusKey=(slot,key)=>descendants(slot).find(node=>node.getAttribute('data-wiki-focus')===key);
const attr=(slot,key,name)=>focusKey(slot,key)?.getAttribute(name);
const home='wabcdefghijk',parent='wabcdefghijl',child='wabcdefghijm',other='wabcdefghijn';
const app={id:'example-app',name:'Example app',home};
const library={id:'sample-library',name:'Sample library',home:other};
const tree=(branch='Notes',parentId=parent)=>({enabled:true,home,pages:[
 {id:home,title:'Home',parentId:null},{id:parent,title:branch,parentId:home},
 {id:child,title:'Release Notes',parentId},
]});

test('sidebar fetches only expanded Wiki trees, follows deep links, and updates after writes',async()=>{
 const {document}=installDom();
 Element.prototype.focus=function(){globalThis.document.activeElement=this;};
 Element.prototype.getBoundingClientRect=()=>({top:0,bottom:20});
 const calls=[];
 let index=[],meta=tree(),rail=false;
 const nav=createWikiNavigation({
  readIndex:async()=>({projects:index}),
  readTree:async id=>{calls.push(id);return meta;},
  isRail:()=>rail,expandSidebar:()=>{rail=false;},
 });
 let slot=nav.mount('#projects');
 document.body.append(slot);
 await settle();
 assert.equal(slot.hidden,true);
 assert.deepEqual(calls,[]);

 index=[app,library];
 nav.invalidate({project:app.id,index:true});
 await settle();
 assert.equal(slot.hidden,false);
 assert.equal(attr(slot,'wiki','aria-expanded'),'false');
 assert.deepEqual(calls,[]);
 const toggle=key=>{
  const button=focusKey(slot,key);
  button.focus();
  fire(button,'click');
  assert.equal(document.activeElement,focusKey(slot,key));
 };
 toggle('wiki');
 assert.deepEqual(calls,[]);
 toggle('project:'+app.id);
 await settle();
 assert.deepEqual(calls,[app.id]);
 assert.equal(focusKey(slot,'page:'+app.id+':'+home).textContent,'Home');
 assert.equal(focusKey(slot,'page:'+app.id+':'+child),undefined);

 slot=nav.mount('#wiki/'+app.id+'/'+child+'?edit');
 document.body.replaceChildren(slot);
 await settle();
 assert.equal(attr(slot,'branch:'+app.id+':'+home,'aria-expanded'),'true');
 assert.equal(attr(slot,'branch:'+app.id+':'+parent,'aria-expanded'),'true');
 assert.equal(attr(slot,'page:'+app.id+':'+child,'aria-current'),'page');
 assert.equal(attr(slot,'page:'+app.id+':'+child,'href'),'#wiki/'+app.id+'/'+child);
 assert.deepEqual(calls,[app.id]);

 meta=tree('Archived',home);
 nav.invalidate({project:app.id});
 await settle();
 assert.deepEqual(calls,[app.id,app.id]);
 assert.equal(focusKey(slot,'page:'+app.id+':'+parent).textContent,'Archived');
 assert.equal(attr(slot,'page:'+app.id+':'+child,'aria-current'),'page');

 rail=true;
 nav.layout();
 assert.equal(attr(slot,'wiki','aria-expanded'),'false');
 toggle('wiki');
 assert.equal(rail,false);
 assert.equal(attr(slot,'wiki','aria-expanded'),'true');
});

test('sidebar drops an obsolete tree response and allows retry',async()=>{
 installDom();
 let reject,finish,attempt=0;
 const nav=createWikiNavigation({
  readIndex:async()=>({projects:[app]}),
  readTree:()=>{
   if(attempt++===0)return new Promise(resolve=>{finish=resolve;});
   if(attempt===2)return new Promise((_,fail)=>{reject=fail;});
   return Promise.resolve(tree('Current'));
  },
 });
 const slot=nav.mount('#wiki/'+app.id+'/'+child);
 document.body.append(slot);
 await settle();
 nav.invalidate({project:app.id});
 finish(tree('Obsolete'));
 reject(new Error('offline'));
 await settle();
 assert.match(slot.textContent,/could not be loaded/);
 assert.doesNotMatch(slot.textContent,/Obsolete/);
 const retry=focusKey(slot,'retry:'+app.id);
 retry.focus();
 fire(retry,'click');
 assert.equal(document.activeElement,focusKey(slot,'project:'+app.id));
 assert.equal(document.activeElement.isConnected,true);
 await settle();
 assert.match(slot.textContent,/Current/);
 assert.equal(attr(slot,'page:'+app.id+':'+child,'aria-current'),'page');
});

test('an article refresh follows an external move while preserving previously expanded branches',async()=>{
 installDom();
 const elsewhere='wabcdefghijo',leaf='wabcdefghijp';
 const original=tree();
 original.pages.push({id:elsewhere,title:'Elsewhere',parentId:home},{id:leaf,title:'Earlier page',parentId:parent});
 const nav=createWikiNavigation({readIndex:async()=>({projects:[app]}),readTree:async()=>original});
 const slot=nav.mount('#wiki/'+app.id+'/'+child);
 document.body.append(slot);
 await settle();
 const branchKey=id=>'branch:'+app.id+':'+id;
 assert.equal(attr(slot,branchKey(parent),'aria-expanded'),'true');
 assert.equal(attr(slot,branchKey(elsewhere),'aria-expanded'),undefined);
 const refreshed=structuredClone(original);
 const moved=refreshed.pages.find(entry=>entry.id===child);
 moved.parentId=elsewhere;
 moved.title='Moved release notes';
 nav.observe(app.id,refreshed,app.name);
 assert.equal(attr(slot,branchKey(parent),'aria-expanded'),'true');
 assert.equal(attr(slot,branchKey(elsewhere),'aria-expanded'),'true');
 assert.equal(attr(slot,'page:'+app.id+':'+child,'aria-current'),'page');
 assert.equal(focusKey(slot,'page:'+app.id+':'+child).textContent,'Moved release notes');
});

test('the wiki index revalidates after its cooldown and keeps a project just discovered by its article',async()=>{
 installDom();
 let at=0,checks=0,finish;
 const nav=createWikiNavigation({
  now:()=>at,readTree:async()=>tree(),
  readIndex:()=>{
   if(checks++===0)return new Promise(resolve=>{finish=resolve;});
   return Promise.resolve({projects:[app,library]});
  },
 });
 let slot=nav.mount('#wiki/'+app.id);
 document.body.append(slot);
 nav.observe(app.id,tree(),app.name);
 finish({projects:[]});
 await settle();
 assert.equal(slot.hidden,false);
 assert.ok(focusKey(slot,'project:'+app.id));
 at=29_999;
 nav.revalidate();
 slot=nav.mount('#wiki/'+app.id+'/'+child);
 document.body.replaceChildren(slot);
 await settle();
 assert.equal(checks,1);
 at=30_000;
 nav.revalidate();
 nav.revalidate();
 await settle();
 assert.equal(checks,2);
 assert.ok(focusKey(slot,'project:'+library.id));
});
