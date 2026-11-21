import test from 'node:test';
import assert from 'node:assert/strict';
import {fire,installDom} from './fixtures/mini-dom.mjs';
import {editableMarkdownRange} from '../public/tracker-markdown-format.js';
import {referenceToken} from '../public/reference-format.js';

test('picker ignores literals and replaces a project selection or @ prefix using keyboard and popup',async()=>{
 const {document}=installDom();
 const {referencePicker}=await import('../public/reference-picker.js');
 let selection={selected:'',before:'(@Tro',position:5},inserted,requested;
 const record={kind:'machine',id:'build-host',label:'Trooper'};
 const node=document.createElement('textarea'),panel=referencePicker(node,{project:()=>'sample-game',canGlobal:true,context:()=>{
  const ctx={...selection,replace(r){inserted={r,trim:ctx.trim};}};return ctx;
 }});
 document.body.append(node,panel);
 const next=()=>new Promise(r=>setImmediate(r));
 globalThis.fetch=async(url,opts)=>{
  if(!opts.method){assert.equal(url,'/api/references/suggest?project=sample-game&q=Tro');return Response.json({items:[record]});}
  requested={url,body:JSON.parse(opts.body)};return Response.json({...record,...requested.body});
 };
 fire(node,'input');await next();
 assert.equal(node.getAttribute('aria-expanded'),'true');
 assert.ok(node.getAttribute('aria-activedescendant'));
 fire(node,'keyup',{key:'o'});fire(node,'keydown',{key:'Enter'});
 assert.deepEqual(inserted,{r:record,trim:4});
 selection={selected:'Trooper',before:'',position:0};
 fire(node,'pointerup');fire(panel.children[0],'click');
 const [label,note]=panel.children;
 // This fixture stores the input's value in attributes until a user edits it.
 label.value=label.getAttribute('value');note.value='Unit documentation';
 const buttons=panel.children.at(-1);fire(buttons.children[0],'click');await next();
 assert.deepEqual(requested,{url:'/api/references/local/save',body:{kind:'custom',label:'Trooper',description:'Unit documentation',project:'sample-game'}});
 assert.equal(inserted.r.kind,'custom');assert.equal(panel.hidden,true);
 const token=referenceToken(record),files=name=>name==='shot.png',keys=['HH'];
 for(const [text,segment,want] of [
  ['plain @Tro','@Tro',true],['**Trooper**','Trooper',true],['- Selected text','Selected text',true],
  ['`@Tro`','@Tro',false],['```\n@Tro\n```','@Tro',false],['![shot.png]','shot.png',false],
  [token,'Trooper',false],['HH-12','HH-12',false],['https://example.org/test','example',false],
 ]){
  const start=text.indexOf(segment);assert.equal(editableMarkdownRange(text,start,start+segment.length,{keys,files}),want,text);
 }
});
