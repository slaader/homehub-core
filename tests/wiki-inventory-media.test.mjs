import test from 'node:test';
import assert from 'node:assert/strict';
import {Element,fire,installDom} from './fixtures/mini-dom.mjs';
import {wikiMedia} from '../public/wiki-media.js';
import {wikiInventory} from '../public/wiki-inventory.js';
import {el} from '../public/views.js';

const entries=[
 ['one','Portrait','image/png'],['two','Artwork','image/png'],['three','Concept','image/png'],
 ['left','Ambience','audio/wav'],['right','Footsteps','audio/wav'],
 ['preview','Trailer','video/mp4'],['demo','Demo','video/mp4'],
];
const assets=new Map(entries.map(([id,name,type])=>[id,{id,name,type,url:'/api/wiki/example-app/assets/'+id}]));
const ref=(assetId,caption)=>({assetId,caption});
const withTag=(node,tag)=>[...node.children.flatMap(child=>withTag(child,tag)),...(node.tagName===tag?[node]:[])];
const url=id=>assets.get(id).url;

function harness(){
 const {document}=installDom();
 Element.prototype.getBoundingClientRect=()=>({left:0,right:10});
 Element.prototype.pause=function(){this.paused=true;};
 Element.prototype.play=function(){this.paused=false;return Promise.resolve();};
 Element.prototype.load=function(){this.src=this.getAttribute('src')??'';};
 const open=[];
 const media=wikiMedia({dialog(title,children,options){
  const dialog=el('dialog',{},el('h2',{},title),children);
  const query=dialog.querySelector.bind(dialog);
  dialog.querySelector=selector=>selector==='h2'?withTag(dialog,'h2')[0]:query(selector);
  dialog.close=()=>{
   fire(dialog,'close');
   dialog.remove();
  };
  document.body.append(dialog);
  open.push({dialog,options});
  return dialog;
 }});
 return {document,media,open};
}

test('inventory images use one opener and keyboard selection in the shared filmstrip',()=>{
 const {document,media,open}=harness();
 const portrait=media.inventory([ref('one')],assets),folder=media.inventory([ref('two'),ref('three','Last image')],assets);
 document.body.append(portrait,folder);
 assert.ok(portrait.querySelector('.wiki-portrait'));
 assert.equal(withTag(portrait,'button').length,1);
 assert.equal(withTag(folder,'button').length,1);
 const opener=folder.querySelector('.wiki-image-folder');
 assert.match(opener.textContent,/2 images/);
 assert.deepEqual(withTag(opener,'img').map(img=>[img.getAttribute('src'),img.getAttribute('loading')]),
  [[url('two')+'?thumbnail=1','lazy'],[url('three')+'?thumbnail=1','lazy']]);
 fire(opener,'click');
 const [{dialog,options}]=open;
 assert.equal(options.opener,opener);
 const picture=()=>withTag(dialog.querySelector('.wiki-gallery-image'),'img')[0];
 const frames=dialog.querySelectorAll('.wiki-film-frame');
 assert.equal(picture().src,url('two'));
 assert.equal(frames[0].getAttribute('aria-current'),'true');
 fire(dialog,'keydown',{key:'End'});
 assert.equal(picture().src,url('three'));
 assert.match(dialog.textContent,/Last image/);
 assert.equal(frames[1].getAttribute('aria-current'),'true');
 fire(dialog,'keydown',{key:'Home'});
 assert.equal(picture().src,url('two'));
 fire(dialog,'keydown',{key:'ArrowRight'});
 assert.equal(picture().src,url('three'));
 fire(frames[0],'click');
 assert.equal(picture().src,url('two'));
 dialog.close();
 assert.equal(picture(),undefined);
});

test('inventory audio and video lists mount a single selected player and stop it on switching or closing',()=>{
 const {document,media,open}=harness();
 const cell=media.inventory([ref('left'),ref('right'),ref('preview'),ref('demo')],assets);
 document.body.append(cell);
 assert.equal(withTag(cell,'audio').length,0);
 assert.equal(withTag(cell,'video').length,0);
 const [tracks,videos]=cell.querySelectorAll('.wiki-media-tile');
 assert.equal(tracks.textContent,'Audio tracks (2)');
 assert.equal(videos.textContent,'Videos (2)');
 for(const [kind,opener,firstId,secondId] of [['audio',tracks,'left','right'],['video',videos,'preview','demo']]){
  fire(opener,'click');
  const {dialog,options}=open.at(-1);
  assert.equal(options.opener,opener);
  assert.equal(withTag(dialog,kind).length,0);
  const [first,second]=dialog.querySelectorAll('.wiki-playlist-choice');
  fire(first,'click');
  const firstPlayer=withTag(dialog,kind)[0];
  assert.equal(firstPlayer.src,url(firstId));
  fire(second,'click');
  assert.equal(firstPlayer.paused,true);
  assert.equal(firstPlayer.src,'');
  assert.equal(withTag(dialog,kind).length,1);
  const secondPlayer=withTag(dialog,kind)[0];
  assert.equal(secondPlayer.src,url(secondId));
  assert.equal(first.getAttribute('aria-pressed'),'false');
  assert.equal(second.getAttribute('aria-pressed'),'true');
  media.stop();
  assert.equal(secondPlayer.paused,true);
  assert.equal(secondPlayer.src,'');
  assert.equal(dialog.isConnected,false);
 }
});

test('read-only inventory keeps dense rows compact and preserves authored details',()=>{
 installDom();
 const long='A character description with background, voice notes and usage guidance. '.repeat(4);
 const names=['Strength','Agility','Magic resistance','Awareness','Voice pitch','Speed'];
 const stats=names.map(name=>({name,value:'10',unit:'pts'}));
 const table={columns:[{id:'attributes',label:'Attributes'}],rows:[{cells:{attributes:{
  c:[{t:'text',text:long},{t:'link',href:'https://example.com',c:[{t:'text',text:'Guide'}]}],stats,
 }}}]};
 const options={group:()=>null,inline:runs=>runs.map(run=>run.t==='text'?run.text:el('a',{href:run.href},run.c[0].text))};
 const region=wikiInventory(table,options);
 assert.equal(region.getAttribute('tabindex'),'0');
 const [first,second]=region.querySelectorAll('.wiki-stats');
 assert.deepEqual(withTag(first,'dt').map(dt=>dt.textContent),names.slice(0,4));
 const details=region.querySelector('.wiki-stat-disclosure');
 assert.equal(details.hasAttribute('open'),false);
 assert.match(withTag(details,'summary')[0].textContent,/All stats \(6\)/);
 assert.deepEqual(withTag(second,'dt').map(dt=>dt.textContent),names.slice(4));
 assert.equal(withTag(region.querySelector('.wiki-cell-text'),'a')[0].getAttribute('href'),'https://example.com');
 const editor=wikiInventory(table,{...options,editCell:()=>null});
 assert.equal(editor.querySelector('.wiki-stat-disclosure'),null);
 assert.equal(editor.querySelector('.wiki-cell-text'),null);
});

test('a folded cell keeps its early mention noninteractive and its full reference link in the body',async t=>{
 installDom();
 const {inlineNodes}=await import('../public/wiki-content.js');
 const ref={t:'ref',kind:'machine',id:'example-host',label:'Example host'};
 const savedFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=savedFetch;});
 globalThis.fetch=async()=>Response.json({items:[{...ref,label:'Current host'}]});
 const c=[{t:'text',text:'See '},ref,{t:'text',text:' for details. '.repeat(30)},ref];
 const region=wikiInventory({columns:[{id:'notes',label:'Notes'}],rows:[{cells:{notes:{c}}}]},
  {group:()=>null,inline:runs=>inlineNodes(runs,{tickets:new Map()})});
 await new Promise(resolve=>setImmediate(resolve));
 const [summary]=withTag(region,'summary'),preview=summary.querySelector('.ref-chip');
 assert.equal(preview.tagName,'span');assert.equal(preview.hasAttribute('href'),false);
 assert.equal(summary.querySelectorAll('.ref-chip').length,1);
 assert.equal(withTag(summary,'a').length,0);
 assert.equal(preview.textContent,'Current host');
 assert.deepEqual(withTag(region,'a').map(a=>a.getAttribute('href')),['#host-example-host','#host-example-host']);
});
