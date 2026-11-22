// Wiki chips as the page, the editor and a folded inventory cell draw them: one construction for Mentions and
// tickets, attributes set once and never edited afterwards, text-only labels, and editor round trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Element,Text,installDom} from './fixtures/mini-dom.mjs';

const {document}=installDom();
// Browser behaviour the editor's serializer reads: upper-case tag names, node types, data-* as dataset and inline
// style (empty, as the wiki never writes one). innerHTML and a style attribute fail the test where they happen.
document.createElement=tag=>new Element(tag.toUpperCase());
const camel=name=>name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
Object.defineProperties(Element.prototype,{
 nodeType:{get:()=>1},
 dataset:{get(){return Object.fromEntries([...this.attrs].filter(([k])=>k.startsWith('data-')).map(([k,v])=>[camel(k),v]));}},
 style:{get:()=>({textDecorationLine:'',fontWeight:'',fontStyle:'',fontFamily:''})},
 innerHTML:{get(){throw new Error('innerHTML read');},set(){throw new Error('innerHTML written');}},
});
Object.defineProperty(Text.prototype,'nodeType',{get:()=>3});
const setAttribute=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
 if(name==='style')throw new Error('inline style');
 return setAttribute.call(this,name,value);
};

// Answers /api/references/resolve with `records` (kind/id → label); an absent key is a missing Reference.
let records=new Map(),resolved=[];
globalThis.fetch=async(url,options)=>{
 assert.equal(url,'/api/references/resolve');
 const {refs}=JSON.parse(options.body);
 resolved.push(...refs.map(r=>r.kind+'/'+r.id));
 return Response.json({items:refs.filter(r=>records.has(r.kind+'/'+r.id)).map(r=>({...r,label:records.get(r.kind+'/'+r.id)}))});
};

// The inventory module first: it and wiki-content.js import each other, and either may be loaded first.
const {wikiInventory}=await import('../public/wiki-inventory.js');
const {inlineNodes,inlineTeaserChip,ticketChip,wikiBlocks}=await import('../public/wiki-content.js');
const {serializeWiki}=await import('../public/wiki-editor.js');
const {normalizeDoc}=await import('../public/wiki-doc.js');
const {t}=await import('../public/i18n.js');

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const all=node=>[node,...node.children.flatMap(all)];
const attrs=node=>Object.fromEntries(node.attrs);
const known={id:'APP-1',title:'Known ticket',status:'open'},knownText='APP-1 Known ticket '+t('Otevřený');
const tickets=new Map([[known.id,known]]);
const host={t:'ref',kind:'machine',id:'example-host',label:'Example host'};
const text=(value,m)=>({t:'text',text:value,...(m?{m}:{})});
const ticket=id=>({t:'ticket',id});
// Records every removeAttribute a chip receives while it is built (not when a lookup paints it later).
function withoutRemoval(build){
 const calls=[],remove=Element.prototype.removeAttribute;
 Element.prototype.removeAttribute=function(name){calls.push(name);return remove.call(this,name);};
 try{return [build(),calls];}finally{Element.prototype.removeAttribute=remove;}
}

test.beforeEach(()=>{records=new Map();resolved=[];});

test('a listed ticket is a ticket chip: data-ticket when editing, a tracker link when reading, never a Reference',async()=>{
 const [editing,removed]=withoutRemoval(()=>ticketChip(known.id,known,true));
 assert.deepEqual(removed,[]);
 assert.equal(editing.tagName,'SPAN');
 assert.deepEqual(attrs(editing),{class:'wiki-ticket ref-chip',contenteditable:'false','data-ticket':'APP-1'});
 assert.equal(editing.textContent,knownText);
 assert.equal(editing.querySelector('.tk-mono').textContent,'APP-1');
 assert.equal(editing.querySelector('.sec-pill').getAttribute('class'),'sec-pill warn');
 const reading=ticketChip(known.id,known);
 assert.equal(reading.tagName,'A');
 assert.deepEqual(attrs(reading),{class:'wiki-ticket ref-chip',href:'#items/APP-1'});
 await settle();
 assert.deepEqual(resolved,[],'a listed ticket needs no lookup');
});

test('an unlisted ticket is a ticket Reference built in one step, which looks its label up or marks it missing',async()=>{
 records.set('ticket/LIB-7','LIB-7 Shared library ticket');
 const [[editing,reading,gone],removed]=withoutRemoval(()=>[ticketChip('LIB-7',undefined,true),ticketChip('LIB-7'),ticketChip('OLD-9',undefined,true)]);
 assert.deepEqual(removed,[],'no attribute is taken off a chip after it is made');
 assert.deepEqual(attrs(editing),{class:'wiki-ticket ref-chip',contenteditable:'false',
  'data-ref-kind':'ticket','data-ref-id':'LIB-7','data-ref-label':'LIB-7'});
 assert.equal(editing.tagName,'SPAN');
 assert.deepEqual(attrs(reading),{class:'wiki-ticket ref-chip',href:'#items/LIB-7',
  'data-ref-kind':'ticket','data-ref-id':'LIB-7','data-ref-label':'LIB-7'});
 assert.equal(editing.textContent,'LIB-7','the id until the lookup answers');
 await settle();
 assert.deepEqual(resolved.sort(),['ticket/LIB-7','ticket/OLD-9']);
 assert.equal(editing.textContent,'LIB-7 Shared library ticket');
 assert.equal(reading.textContent,'LIB-7 Shared library ticket');
 assert.equal(gone.textContent,'OLD-9');
 assert.equal(gone.classList.contains('wiki-ticket-missing'),true);
 assert.equal(gone.title,t('Reference nebyla nalezena.'));
});

test('a Mention chip carries its kind, id and label; a hostile label stays text',async()=>{
 const label='<img src=x onerror=alert(1)> & "quoted"';
 const [chip]=inlineNodes([{...host,label}],{tickets,editing:true});
 assert.deepEqual(attrs(chip),{class:'wiki-ticket ref-chip',contenteditable:'false',
  'data-ref-kind':'machine','data-ref-id':'example-host','data-ref-label':label});
 assert.deepEqual(chip.childNodes.map(n=>n.constructor),[Text]);
 assert.equal(chip.textContent,label);
 const [link]=inlineNodes([host],{tickets,editing:false});
 assert.equal(link.tagName,'A');assert.equal(link.getAttribute('href'),'#host-example-host');
 await settle();
});

test('the editor reads back every chip as the run it was drawn from, before and after lookups repaint them',async()=>{
 records.set('machine/example-host','Example host');
 records.set('ticket/LIB-7','LIB-7 Renamed elsewhere');
 const doc=normalizeDoc({v:1,blocks:[
  {t:'h',level:2,c:[text('Status '),ticket('APP-1')]},
  {t:'p',c:[text('See ',['b']),host,text(' and '),ticket('LIB-7'),text(', '),ticket('OLD-9'),
   {t:'link',href:'https://example.com/',c:[text('the guide')]}]},
  {t:'quote',c:[ticket('LIB-7'),text(' quoted')]},
  {t:'ul',items:[[ticket('APP-1')],[host,text(' listed')]]},
 ]});
 const root=document.createElement('div');
 root.append(...wikiBlocks(doc,{tickets,editing:true}));
 assert.equal(all(root).filter(n=>n.dataset.ticket).length,2,'listed tickets');
 assert.equal(all(root).filter(n=>n.dataset.refKind==='ticket').length,3,'unlisted tickets');
 assert.deepEqual(normalizeDoc(serializeWiki(root,new WeakMap())),doc);
 await settle();
 assert.equal(all(root).filter(n=>n.classList.contains('wiki-ticket-missing')).length,1,'OLD-9 is gone');
 assert.deepEqual(normalizeDoc(serializeWiki(root,new WeakMap())),doc,'labels repaint, the runs stay the same');
});

test('the shared teaser chip is a non-interactive copy of a Mention or ticket chip, and nothing for other runs',async()=>{
 const mention=inlineTeaserChip(host,'Example host');
 assert.equal(mention.tagName,'SPAN');assert.equal(mention.hasAttribute('href'),false);
 assert.equal(mention.getAttribute('data-ref-id'),'example-host');
 const chip=inlineTeaserChip(ticket('APP-1'),knownText);
 assert.deepEqual(attrs(chip),{class:'wiki-ticket ref-chip'});
 assert.equal(chip.textContent,knownText);
 assert.equal(inlineTeaserChip(text('plain'),'plain'),null);
 assert.equal(inlineTeaserChip({t:'link',href:'https://example.com/',c:[text('x')]},'x'),null);
 await settle();
});

function foldedCell(c,options={}){
 const region=wikiInventory({columns:[{id:'notes',label:'Notes'}],rows:[{cells:{notes:{c}}}]},
  {group:()=>null,inline:runs=>inlineNodes(runs,{tickets,editing:false}),...options});
 const details=region.querySelector('.wiki-cell-text');
 return {region,details,teaser:details?.querySelector('.wiki-cell-teaser'),body:details?.children.at(-1)};
}

test('a folded inventory cell previews Mentions and tickets with the shared chip, as text that cannot be followed',async()=>{
 records.set('machine/example-host','Current host');
 const long=' word'.repeat(40);
 const {details,teaser,body}=foldedCell([text('Start '),host,text(' then '),ticket('APP-1'),text(' and '),ticket('LIB-7'),text(long)]);
 assert.equal(details.tagName,'DETAILS');
 assert.equal(teaser.getAttribute('aria-hidden'),'true');
 const chips=teaser.querySelectorAll('.ref-chip');
 assert.equal(chips.length,3);
 assert.deepEqual(all(teaser).filter(n=>n.tagName==='A'||n.hasAttribute('href')||n.hasAttribute('tabindex')),[],'nothing in the teaser takes focus');
 assert.equal(chips[1].textContent,knownText,'a ticket reads as the chip in the cell');
 assert.deepEqual(attrs(chips[1]),{class:'wiki-ticket ref-chip'});
 assert.equal(chips[2].textContent,'LIB-7','an unlisted ticket falls back to its id');
 // The body keeps the interactive chips, and the summary is the cell's one keyboard stop.
 assert.deepEqual(all(body).filter(n=>n.tagName==='A').map(a=>a.getAttribute('href')),['#host-example-host','#items/APP-1','#items/LIB-7']);
 assert.equal(details.children[0].tagName,'SUMMARY');
 assert.equal(details.children[0].childNodes[0].textContent,t('Text buňky'));
 await settle();
 assert.equal(chips[0].textContent,'Current host','the teaser Mention follows the lookup, like the body');
 assert.equal(body.querySelector('.ref-chip').textContent,'Current host');
});

test('the teaser stops at 160 characters with an ellipsis, collapses whitespace and never cuts a chip',async()=>{
 const words='alpha  beta\tgamma\n'.repeat(12);
 const cut=foldedCell([text(words)]).teaser;
 assert.equal(cut.textContent.endsWith('…'),true);
 assert.equal(cut.textContent.length<=161,true);
 assert.doesNotMatch(cut.textContent,/\s{2}|[\t\n]| …$/);
 // A chip that starts just before the limit is kept whole; the rest of the cell is behind the ellipsis.
 const label='A label much longer than what is left';
 const kept=foldedCell([text('x'.repeat(150)),{...host,label},text(' more text after')]).teaser;
 assert.equal(kept.querySelector('.ref-chip').textContent,label);
 assert.equal(kept.childNodes.at(-1).textContent,'…');
 // Exactly at the limit with more to come, and exactly at the end with nothing more.
 const boundary=foldedCell([text('y'.repeat(160)),ticket('APP-1')]).teaser;
 assert.equal(boundary.querySelectorAll('.ref-chip').length,0);assert.equal(boundary.textContent,'y'.repeat(160)+'…');
 // Trailing whitespace right at the 160-char cutoff between formatted runs trims identically to one plain run.
 const plainCut=foldedCell([text('x'.repeat(159)+' more')]).teaser;
 const styledCut=foldedCell([text('x'.repeat(159)+' '),text('more',['b'])]).teaser;
 const splitSpaceCut=foldedCell([text('x'.repeat(159)),text(' ',['b']),text('more',['b'])]).teaser;
 assert.equal(plainCut.textContent,'x'.repeat(159)+'…');
 assert.equal(styledCut.textContent,'x'.repeat(159)+'…');
 assert.equal(splitSpaceCut.textContent,'x'.repeat(159)+'…');
 const lines=foldedCell([text('one\ntwo\nthree\nfour\nfive')]).teaser;
 assert.equal(lines.textContent,'one two three four five','short but on many lines: folded, nothing cut');
 await settle();
});

test('a short cell is not folded, and an editable cell never is',async()=>{
 const short=foldedCell([text('Short '),ticket('APP-1')]);
 assert.equal(short.details,null);
 assert.equal(short.region.querySelector('.ref-chip').textContent,knownText);
 const editable=foldedCell([text('z'.repeat(400))],{editCell:()=>null});
 assert.equal(editable.details,null);
 await settle();
});

test('a teaser Mention keeps its saved label when the lookup fails',async()=>{
 const saved=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('offline');};
 try{
  const {teaser,body}=foldedCell([host,text(' w'.repeat(100))]);
  await settle();
  assert.equal(teaser.querySelector('.ref-chip').textContent,'Example host');
  assert.equal(teaser.querySelector('.ref-chip').classList.contains('wiki-ticket-missing'),false);
  assert.equal(body.querySelector('.ref-chip').getAttribute('href'),'#host-example-host');
 }finally{globalThis.fetch=saved;}
});

test('an inventory block on a page draws its folded teasers through the same path',async()=>{
 const block={t:'inventory',id:'iabcdefghijk',columns:[{id:'notes',label:'Notes'}],
  rows:[{id:'rabcdefghijk',cells:{notes:{c:[ticket('APP-1'),text(' '+'q'.repeat(200))]}}}]};
 const [region]=wikiBlocks({v:1,blocks:[block]},{tickets,editing:false,media:()=>null});
 const teaser=region.querySelector('.wiki-cell-teaser');
 assert.equal(teaser.querySelector('.ref-chip').textContent,knownText);
 assert.equal(teaser.textContent.endsWith('…'),true);
 await settle();
});
