import test from 'node:test';
import assert from 'node:assert/strict';
import {fire,installDom} from './fixtures/mini-dom.mjs';

const {document,window,localStorage}=installDom();
const {wikiPage}=await import('../public/wiki-view.js');
const {leaveView}=await import('../public/views.js');

const project='example-app',id='wabcdefghijk',user={id:'editor',username:'alice',authKind:'session',canWrite:true,scopes:['read','tickets:write']};
const href=`#wiki/${project}/${id}`;
const api=`/api/wiki/${project}`;
const at='2026-11-01T10:00:00.000Z';
const pageDoc=text=>({v:1,blocks:[{t:'p',c:[{t:'text',text}]}]});
const page=(title,rev,text)=>({project,id,title,rev,doc:pageDoc(text),links:{tickets:[]},updatedAt:at,updatedBy:'alice'});
const nodes=node=>[node,...node.children.flatMap(nodes)];
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));

function editorDom(){
 // Extend the shared DOM fixture with the selection and editable element interfaces the wiki uses.
 const create=document.createElement.bind(document),createText=document.createTextNode.bind(document);
 document.createElement=tag=>{
  const element=create(tag),set=element.setAttribute.bind(element);
  element.tagName=tag.toUpperCase();
  element.nodeType=1;
  element.dataset={};
  element.style={textDecorationLine:''};
  element.setAttribute=(name,value)=>{set(name,value);if(name==='value')element.value=String(value);};
  Object.defineProperty(element,'lastElementChild',{get:()=>element.children.at(-1)??null});
  element.contains=node=>{for(let n=node;n;n=n.parentNode)if(n===element)return true;return false;};
  return element;
 };
 document.createTextNode=value=>Object.assign(createText(value),{nodeType:3});
 document.queryCommandState=()=>false;
 document.queryCommandValue=()=>'';
 let range=null;
 document.createRange=()=>({
  selectNodeContents(node){this.startContainer=this.endContainer=node;},
  collapse(){},
  cloneRange(){return this;},
 });
 globalThis.getSelection=()=>({
  get rangeCount(){return Number(Boolean(range));},
  addRange(next){range=next;},removeAllRanges(){range=null;},getRangeAt:()=>range,
 });
 globalThis.addEventListener=window.addEventListener.bind(window);
 globalThis.removeEventListener=window.removeEventListener.bind(window);
 globalThis.sessionStorage=localStorage;
 globalThis.history={replaceState(_state,_title,hash){location.hash=hash;}};
 globalThis.location={hash:href+'?edit'};
}

test('wiki editor opens directly, retains title and rich text after a stale save and restores the draft',async t=>{
 editorDom();
 t.after(leaveView);
 let saved=page('Home',1,'Original text'),posted=null;
 globalThis.fetch=async(url,options={})=>{
  if(options.method==='POST'){
   assert.equal(url,'/api/wiki/pages/update');
   posted=JSON.parse(options.body);
   assert.equal(posted.rev,1);
   return Response.json({error:{message:'Stránka se mezitím změnila.'},
    current:{rev:saved.rev,updatedAt:saved.updatedAt,updatedBy:saved.updatedBy}},{status:409});
  }
  if(url===api)return Response.json({enabled:true,home:id,pages:[{id,title:saved.title}]});
  if(url===api+'/pages/'+id)return Response.json(saved);
  if(url==='/api/tickets?project='+project)return Response.json({projects:[{id:project,name:'Example app'}],tickets:[]});
  throw new Error('Unexpected request '+url);
 };

 const render=async me=>{
  const root=wikiPage({me,sub:project});
  document.body.replaceChildren(root);
  await nextTurn();
  return root;
 };
 const title=root=>nodes(root).find(node=>node.tagName==='INPUT');
 const edit=root=>root.querySelector('.wiki-editor');
 const form=root=>nodes(root).find(node=>node.tagName==='FORM');

 const initial=await render(user);
 assert.equal(title(initial).value,'Home');
 assert.match(edit(initial).textContent,/Original text/);

 title(initial).value='Local title';
 fire(title(initial),'input');
 const paragraph=document.createElement('p'),strong=document.createElement('strong');
 strong.append(document.createTextNode('Local content'));
 paragraph.append(strong);
 edit(initial).replaceChildren(paragraph);
 fire(edit(initial),'input');

 saved={...page('Saved by another editor',2,'Remote text'),updatedBy:'bob'};
 fire(form(initial),'submit');
 await nextTurn();
 assert.deepEqual(posted.doc,{v:1,blocks:[{t:'p',c:[{t:'text',text:'Local content',m:['b']}]}]});
 assert.equal(title(initial).value,'Local title');
 assert.match(initial.textContent,/Your draft is still here/);

 leaveView();
 location.hash=href;
 const reopened=await render(user);
 assert.equal(title(reopened).value,'Local title');
 assert.equal(edit(reopened).textContent,'Local content');
 assert.match(reopened.textContent,/Last edited by bob/);
 assert.equal(nodes(reopened).find(node=>node.tagName==='BUTTON'&&node.textContent==='Save').disabled,true);

 leaveView();
 const reader=await render({...user,id:'viewer',canWrite:false,scopes:['read']});
 assert.equal(edit(reader),null);
 assert.match(reader.textContent,/Remote text/);
 assert.doesNotMatch(reader.textContent,/Local content/);
});
