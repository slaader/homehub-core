import test from 'node:test';
import assert from 'node:assert/strict';
import {fire,installDom} from './fixtures/mini-dom.mjs';
import {editableMarkdownRange} from '../public/tracker-markdown-format.js';
import {referenceToken} from '../public/reference-format.js';

test('picker ignores literals and replaces a project selection or @ prefix using keyboard and popup',async()=>{
 const {document}=installDom();
 const {referencePicker}=await import('../public/reference-picker.js');
 let selection={selected:'',before:'(@Tro',position:5},inserted,requested,allowGlobal=true;
 const record={kind:'machine',id:'build-host',label:'Trooper'};
 const node=document.createElement('textarea'),panel=referencePicker(node,{project:()=>'sample-game',canGlobal:()=>allowGlobal,context:()=>{
  const ctx={...selection,replace(r){inserted={r,trim:ctx.trim};}};return ctx;
 }});
 node.setAttribute('role','textbox');node.setAttribute('aria-multiline','true');node.setAttribute('aria-keyshortcuts','c');
 document.body.append(node,panel);
 const next=()=>new Promise(r=>setImmediate(r));
 globalThis.fetch=async(url,opts)=>{
  if(!opts.method){assert.match(url,/^\/api\/references\/suggest\?project=sample-game&q=(Tro)?$/);return Response.json({items:[record]});}
  requested={url,body:JSON.parse(opts.body)};return Response.json({...record,...requested.body});
 };
 fire(node,'input');await next();
 assert.equal(node.getAttribute('role'),'textbox');
 assert.equal(node.getAttribute('aria-multiline'),'true');
 assert.ok(node.getAttribute('aria-controls'));
 assert.ok(node.getAttribute('aria-activedescendant'));
 fire(node,'keyup',{key:'o'});fire(node,'keydown',{key:'Enter'});
 assert.deepEqual(inserted,{r:record,trim:4});
 assert.equal(node.getAttribute('aria-keyshortcuts'),'c');
 selection={selected:'',before:' @',position:2};inserted=undefined;
 fire(node,'input');await next();
 assert.ok(node.getAttribute('aria-controls'));
 assert.equal(node.getAttribute('aria-activedescendant'),null);
 assert.equal(fire(node,'keydown',{key:'Enter'}).defaultPrevented,false);
 assert.equal(inserted,undefined);
 selection={selected:'Trooper',before:'',position:0};
 document.activeElement=node;fire(document,'selectionchange');fire(panel.children[0],'click');
 const scope=panel.querySelector('.ref-scope-label'),checkbox=scope.children[0];
 assert.equal(scope.getAttribute('for'),checkbox.getAttribute('id'));
 assert.equal(checkbox.getAttribute('aria-describedby'),scope.parentNode.children[1].getAttribute('id'));
 const [label,note]=panel.children;
 // This fixture stores the input's value in attributes until a user edits it.
 label.value=label.getAttribute('value');note.value='Unit documentation';
 const buttons=panel.children.at(-1);fire(buttons.children[0],'click');await next();
 assert.deepEqual(requested,{url:'/api/references/local/save',body:{kind:'custom',label:'Trooper',description:'Unit documentation',project:'sample-game'}});
 assert.equal(inserted.r.kind,'custom');assert.equal(panel.hidden,true);
 allowGlobal=false;
 fire(node,'select');fire(panel.children[0],'click');
 assert.equal(panel.querySelector('.ref-scope-label'),null);
 const token=referenceToken(record),files=name=>name==='shot.png',keys=['HH'];
 for(const [text,segment,want] of [
  ['plain @Tro','@Tro',true],['see @BUILD_HOST','@BUILD_HOST',true],['see @/tmp/example','@/tmp/example',true],['**Trooper**','Trooper',true],['- Selected text','Selected text',true],
  ['`@Tro`','@Tro',false],['```\n@Tro\n```','@Tro',false],['![shot.png]','shot.png',false],
  [token,'Trooper',false],['HH-12','HH-12',false],['https://example.org/test','example',false],
 ]){
  const start=text.indexOf(segment);assert.equal(editableMarkdownRange(text,start,start+segment.length,{keys,files}),want,text);
 }
});

test('project-local catalog pins search, paging and creation to the project',async()=>{
 const {document}=installDom(),{projectReferences}=await import('../public/references-view.js');
 const calls=[],next=()=>new Promise(r=>setImmediate(r)),project='sample-game';
 globalThis.fetch=async(raw,options={})=>{
  const url=new URL(raw,'http://hub.test');
  if(options.method==='POST'){calls.push([url.pathname,JSON.parse(options.body)]);return Response.json({id:'created'});}
  calls.push(Object.fromEntries(url.searchParams));return Response.json({items:[],total:51});
 };
 const root=projectReferences({canWrite:true,scopes:['tickets:write']},project);document.body.append(root);await next();
 const all=n=>[n,...n.children.flatMap(all)],find=(tag,text)=>all(root).find(n=>n.tagName===tag&&n.textContent===text);
 assert.equal(all(root).filter(n=>n.tagName==='select').length,1);
 const search=all(root).find(n=>n.getAttribute('type')==='search');search.value='book';fire(search,'input');await next();
 fire(find('button','Next'),'click');await next();
 assert.deepEqual(calls.slice(0,3),[{offset:'0',scope:'local',project},{offset:'0',scope:'local',project,q:'book'},{offset:'50',scope:'local',project,q:'book'}]);
 fire(find('button','Add custom reference'),'click');
 const form=all(root).find(n=>n.tagName==='form');all(form).find(n=>n.tagName==='input').value='Book';all(form).find(n=>n.tagName==='textarea').value='Guide';
 fire(form,'submit');await next();
 assert.deepEqual(calls[3],['/api/references/local/save',{kind:'custom',project,label:'Book',description:'Guide'}]);
 assert.deepEqual(calls[4],{offset:'0',scope:'local',project});
});
