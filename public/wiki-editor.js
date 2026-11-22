import {referenceChip} from './reference-chip.js';
import {referencePicker,richSelection} from './reference-picker.js';
import {el} from './views.js';
import {t} from './i18n.js';
import {htmlSource,normalizeDoc,wikiAssetIds,wikiUrl,WIKI_LIMITS} from './wiki-doc.js';
import {htmlFrame,inlineNodes,tableCell,ticketChip,wikiBlocks} from './wiki-content.js';
import {editAttachments,editInventory,newWikiItemId} from './wiki-inventory-editor.js';

const button=(label,onclick,attrs={})=>el('button',{type:'button',class:'acc-btn small',onclick,...attrs},label);
const BLOCKS=new Set(['DIV','P','H1','H2','H3','BLOCKQUOTE','PRE','UL','OL','HR']);
const marksFor={B:'b',STRONG:'b',I:'i',EM:'i',S:'s',STRIKE:'s',DEL:'s',CODE:'code'};
const run=(text,marks)=>({t:'text',text,...(marks.length?{m:[...new Set(marks)]}:{})});

function inline(nodes,marks=[],tail=true){
 return Array.from(nodes).flatMap((node,i,list)=>{
  if(node.nodeType===3)return node.data?run(node.data,marks):[];
  if(node.nodeType!==1)return [];
  const last=tail&&i===list.length-1;
  // A ticket is never a ref run (wiki-doc.js): a ticket Reference chip is the ticket the tracker did not list.
  if(node.dataset.refKind==='ticket')return {t:'ticket',id:node.dataset.refId};
  if(node.dataset.refKind)return {t:'ref',kind:node.dataset.refKind,id:node.dataset.refId,label:node.dataset.refLabel};
  if(node.dataset.ticket)return {t:'ticket',id:node.dataset.ticket};
  if(node.tagName==='BR')return last?[]:run('\n',marks);
  const mark=marksFor[node.tagName],style=node.style;
  const next=[...marks,mark,
   style.fontWeight==='bold'||Number(style.fontWeight)>=600?'b':null,
   style.fontStyle==='italic'?'i':null,
   style.textDecorationLine.includes('line-through')?'s':null].filter(Boolean);
  const font=style.fontFamily||node.getAttribute('face');
  if(font==='monospace')next.push('code');
  const inside=inline(node.childNodes,font==='sans-serif'?next.filter(value=>value!=='code'):next,last);
  if(node.tagName==='A'){
   let href;
   try{href=wikiUrl(node.getAttribute('href'));}catch{return inside;}
   // A ticket chip always remains its own link, even if surrounded by a formatted selection.
   if(inside.every(part=>part.t==='text'))return {t:'link',href,c:inside};
  }
  return inside;
 });
}

function inlineBlocks(container){
 return Array.from(container.childNodes).reduce((runs,node,i,list)=>{
  const separate=node.nodeType===1&&BLOCKS.has(node.tagName);
  if(separate&&runs.length)runs.push(run('\n',[]));
  runs.push(...inline([node],[],i===list.length-1));
  return runs;
 },[]);
}

export function serializeWiki(root,islands){
 const blocks=[];
 function collect(container){
  let pending=[];
  function flush(){
   if(pending.length)blocks.push({t:'p',c:inline(pending)});
   pending=[];
  }
  for(const node of container.childNodes){
   if(node.nodeType!==1){if(node.nodeType===3&&node.data)pending.push(node);continue;}
   const tag=node.tagName,block=islands.get(node);
   if(block){flush();blocks.push(block);continue;}
   if(node.classList.contains('wiki-table')){
    flush();
    const table=node.querySelector('table');
    blocks.push({t:'table',header:table.rows[0]?.cells[0]?.tagName==='TH',
     rows:Array.from(table.rows,row=>Array.from(row.cells,inlineBlocks))});
    continue;
   }
   if(!BLOCKS.has(tag)){pending.push(node);continue;}
   flush();
   if((tag==='DIV'||tag==='P')&&Array.from(node.children).some(child=>BLOCKS.has(child.tagName)||islands.has(child)||child.classList.contains('wiki-table'))){
    collect(node);
   }else if(tag==='P'||tag==='DIV'){
    blocks.push({t:'p',c:inlineBlocks(node)});
   }else if(/^H[1-3]$/.test(tag)){
    blocks.push({t:'h',level:Number(tag[1]),c:inlineBlocks(node)});
   }else if(tag==='BLOCKQUOTE'){
    blocks.push({t:'quote',c:inlineBlocks(node)});
   }else if(tag==='PRE'){
    const c=inlineBlocks(node);
    blocks.push({t:'code',text:c.map(part=>part.text??part.label??part.id??part.c.map(text=>text.text).join('')).join('')});
   }else if(tag==='HR'){
    blocks.push({t:'hr'});
   }else{
    blocks.push({t:tag.toLowerCase(),items:Array.from(node.children).filter(child=>child.tagName==='LI').map(inlineBlocks)});
   }
  }
  flush();
 }
 collect(root);
 // The blank editable paragraph is a caret target, including for an empty saved page.
 while(blocks.at(-1)?.t==='p'&&blocks.at(-1).c.length===0)blocks.pop();
 return {v:1,blocks};
}

const newBlockId=()=> 'h'+Array.from(crypto.getRandomValues(new Uint8Array(8)),byte=>'abcdefghijklmnopqrstuvwxyz234567'[byte&31]).join('');
const paragraph=()=>el('p',{},el('br'));

export function wikiEditor({page,doc,tickets,api,dialog,changed,canGlobal=false,inlineOnly=false,projectId,standalone=false}){
 const root=el('div',{class:'wiki-article wiki-editor',contenteditable:'true',role:'textbox',
  'aria-multiline':'true','aria-label':t(inlineOnly?'Text buňky':'Obsah stránky'),tabindex:'0'});
 if(inlineOnly)root.classList.add('wiki-inline-editor');
 const islands=new WeakMap(),htmlPreviews=new Map(),tableTools=el('div',{class:'wiki-table-tools',hidden:''});
 const error=el('p',{class:'acc-status error',role:'alert'});
 let selection=null,activeCell=null;
 const context={page,tickets,editing:true,htmlCard,inventoryCard};
 const assets=new Map((page.assets??[]).map(asset=>[asset.id,asset]));
 if(!inlineOnly&&wikiAssetIds(doc).some(id=>!assets.has(id)))api('/api/wiki/'+page.project+'/assets')
  .then(data=>{for(const asset of data.assets)assets.set(asset.id,asset);}).catch(()=>{});
 const inventoryContext={project:page.project,dialog,assets,inline:runs=>inlineNodes(runs,{tickets,editing:false}),
  richEditor:runs=>wikiEditor({page,doc:{v:1,blocks:[{t:'p',c:runs}]},tickets,api,dialog,canGlobal,changed:()=>{},inlineOnly:true})};

 function htmlCard(block){
  const saved=page.doc.blocks.find(value=>value.t==='html'&&value.id===block.id&&value.source===block.source);
  const src=htmlPreviews.get(block.id)??(saved?`/api/wiki/frame/${page.project}/${page.id}/${block.id}`:null);
  const card=el('div',{class:'wiki-html',contenteditable:'false'},
   el('div',{class:'wiki-html-head'},el('strong',{},block.label),
    button(t('Upravit HTML'),()=>editHtml(block,card)),
    button(t('Odebrat blok HTML'),()=>{card.remove();htmlPreviews.delete(block.id);ensureCaret();changed();})),
   src?htmlFrame(src,block.label,block.height):null);
  islands.set(card,block);
  return card;
 }

 function inventoryCard(block){
  const group=block.t==='attachments';
  const title=t(group?'Skupina příloh':'Tabulka inventáře');
  const edit=()=>openIsland(block,card);
  const summary=group?t('Přílohy ({count})',{count:block.attachments.length}):block.columns.map(column=>column.label).join(' · ');
  const card=el('div',{class:'wiki-html wiki-island',contenteditable:'false'},
   el('div',{class:'wiki-html-head'},el('strong',{},title),
    el('div',{class:'wiki-actions'},button(t('Upravit'),edit),button(t('Odebrat'),()=>{card.remove();ensureCaret();changed();}))),
   el('div',{class:'sec-dim'},summary));
  islands.set(card,block);
  return card;
 }

 function openIsland(block,card){
  const edit=block.t==='attachments'?editAttachments:editInventory;
  edit(block,inventoryContext,value=>{
   const next=inventoryCard(value);
   if(card){card.replaceWith(next);changed();next.querySelector('button')?.focus();}
   else insertBlock(next);
  });
 }

 function ensureCaret(){
  if(!root.lastElementChild||root.lastElementChild.getAttribute('contenteditable')==='false')root.append(paragraph());
 }
 function place(node,{end=false}={}){
  const cell=node.closest('td,th');
  (cell??root).focus();
  const range=document.createRange();
  range.selectNodeContents(node);
  range.collapse(!end);
  const current=getSelection();
  current.removeAllRanges();
  current.addRange(range);
  selection=range.cloneRange();
  syncTools();
 }
 function restore(){
  if(!selection||!root.contains(selection.startContainer)||!root.contains(selection.endContainer)){
   ensureCaret();
   place(root.lastElementChild,{end:true});
  }else{
   (selectedElement(selection).closest('td,th')??root).focus();
   const current=getSelection();
   current.removeAllRanges();
   current.addRange(selection);
  }
  return getSelection().getRangeAt(0);
 }
 function selectedElement(range){
  return range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
 }

 function command(name,value){
  restore();
  document.execCommand(name,false,value);
  syncTools();
  changed();
 }

 function insertBlock(node){
  const range=restore(),start=selectedElement(range);
  let after=start;
  while(after&&after!==root&&after.parentElement!==root)after=after.parentElement;
  if(after===root&&range.startContainer===root){
   root.insertBefore(node,root.childNodes[range.startOffset]??null);
  }else if(after?.tagName==='P'&&!after.textContent&&!after.querySelector('[data-ticket]')){
   after.replaceWith(node);
  }else if(after&&after!==root){
   after.after(node);
  }else{
   root.append(node);
  }
  ensureCaret();
  if(node.classList.contains('wiki-table'))place(node.querySelector('th,td'));
  else{
   let next=node.nextElementSibling;
   if(!next||next.getAttribute('contenteditable')==='false'){next=paragraph();node.after(next);}
   place(next);
  }
  changed();
 }

 function insertTicket(id){
  const range=restore(),start=selectedElement(range);
  const chip=ticketChip(id,tickets.get(id),true),space=document.createTextNode(' ');
  const anchor=start.closest('a');
  if(anchor){
   anchor.after(chip,space);
  }else{
   range.deleteContents();
   range.insertNode(space);
   range.insertNode(chip);
  }
  range.setStartAfter(space);
  range.collapse(true);
  const current=getSelection();
  current.removeAllRanges();
  current.addRange(range);
  syncTools();
  changed();
 }

 function pickTicket(){
  const list=el('div',{class:'wiki-picker-list'});
  const filter=el('input',{type:'search',placeholder:t('ID nebo název ticketu'),autofocus:''});
  const d=dialog(t('Vložit odkaz na ticket'),[
   el('label',{},t('Hledat v ticketech projektu'),filter),list,
  ]);
  function update(){
   const query=filter.value.trim().toLocaleLowerCase();
   const matches=[...tickets.values()].filter(ticket=>(ticket.id+' '+ticket.title).toLocaleLowerCase().includes(query));
   list.replaceChildren(...matches.slice(0,50).map(ticket=>button(ticket.id+' · '+ticket.title,()=>{d.close();insertTicket(ticket.id);})),
    ...(!matches.length?[el('p',{class:'tk-dim'},t('Žádné odpovídající tickety.'))]:[]));
  }
  filter.addEventListener('input',update);
  update();
  filter.focus();
 }

 function link(){
  const selected=restore(),existing=selectedElement(selected).closest('a');
  const href=el('input',{type:'url',required:'',value:existing?.getAttribute('href')??'',placeholder:'https://',autofocus:''});
  const label=el('input',{value:existing?.textContent??selected.toString(),'aria-label':t('Text odkazu')});
  const message=el('p',{class:'acc-status error',role:'alert'});
  const form=el('form',{class:'wiki-form',onsubmit:event=>{
   event.preventDefault();
   let url;
   try{url=wikiUrl(href.value);}catch{message.textContent=t('Zadej platnou adresu HTTP nebo HTTPS.');return;}
   d.close();
   const range=restore();
   if(existing&&root.contains(existing)){
    existing.setAttribute('href',url);
    if(label.value!==existing.textContent)existing.textContent=label.value||url;
    place(existing,{end:true});
    changed();
   }else if(!range.collapsed&&label.value===range.toString()&&!range.cloneContents().querySelector('[data-ticket],[data-ref-id],.wiki-table,.wiki-html,.wiki-island')){
    command('createLink',url);
   }else{
    if(!range.collapsed&&range.cloneContents().querySelector('[data-ticket],[data-ref-id],.wiki-table,.wiki-html,.wiki-island'))range.collapse(false);
    range.deleteContents();
    const anchor=el('a',{href:url},label.value||url);
    range.insertNode(anchor);
    place(anchor,{end:true});
    changed();
   }
  }},
   el('label',{},t('Adresa odkazu'),href),el('label',{},t('Text odkazu'),label),message,
   el('div',{class:'wiki-actions'},el('button',{class:'acc-btn primary'},t('Použít')),button(t('Zrušit'),()=>d.close())));
  const d=dialog(t('Odkaz'),[form],{closeButton:false});
 }

 function editHtml(previous,card){
  const label=el('input',{required:'',maxlength:WIKI_LIMITS.label,value:previous?.label??t('Blok HTML'),autofocus:''});
  const height=el('input',{type:'number',required:'',min:WIKI_LIMITS.minHeight,max:WIKI_LIMITS.maxHeight,value:previous?.height??240});
  const source=el('textarea',{rows:10},previous?.source??'');
  const message=el('p',{class:'acc-status error',role:'alert'}),preview=el('div',{});
  const previewButton=button(t('Náhled'),async ()=>{
   if(!form.reportValidity())return;
   save.disabled=previewButton.disabled=true;
   message.textContent='';
   try{
    const current=htmlSource(source.value),data=await api('/api/wiki/preview',{source:current});
    if(d.open){
     latest={source:current,url:'/api/wiki/frame/preview/'+data.token};
     preview.replaceChildren(htmlFrame(latest.url,label.value||t('Blok HTML'),height.valueAsNumber));
    }
   }catch(e){message.textContent=wikiValidationMessage(e);}
   finally{save.disabled=previewButton.disabled=false;}
  });
  let latest=null;
  const save=el('button',{class:'acc-btn primary'},t('Použít'));
  const form=el('form',{class:'wiki-form',onsubmit:event=>{
   event.preventDefault();
   const block={t:'html',id:previous?.id??newBlockId(),label:label.value,height:height.valueAsNumber,source:source.value};
   try{
    normalizeDoc({v:1,blocks:[block]});
    if(!previous&&root.querySelectorAll('.wiki-html').length>=WIKI_LIMITS.htmlBlocks)throw new Error('limit');
   }catch(e){message.textContent=wikiValidationMessage(e);return;}
   if(latest?.source===block.source)htmlPreviews.set(block.id,latest.url);
   else if(previous?.source!==block.source)htmlPreviews.delete(block.id);
   d.close();
   if(card){card.replaceWith(htmlCard(block));changed();}
   else insertBlock(htmlCard(block));
  }},
   el('label',{},t('Název bloku'),label),el('label',{},t('Výška (px)'),height),
   el('label',{},t('Zdroj HTML'),source),
   el('small',{class:'tk-dim'},t('Pouze statický obsah. Skripty, formuláře a vzdálené zdroje jsou blokovány.')),
   message,el('div',{class:'wiki-actions'},save,previewButton,button(t('Zrušit'),()=>d.close())),preview);
  const d=dialog(t('Blok HTML'),[form],{closeButton:false});
 }

 const newTable=()=>insertBlock(wikiBlocks({blocks:[{t:'table',header:true,
  rows:Array.from({length:3},()=>Array.from({length:3},()=>[]))}]},context)[0]);

 function headerRow(table,header){
  for(const [i,row] of [...table.rows].entries()){
   const tag=i===0&&header?'th':'td';
   for(const cell of [...row.cells])if(cell.tagName.toLowerCase()!==tag){
    const replacement=tableCell(tag,[],true);
    replacement.append(...cell.childNodes);
    cell.replaceWith(replacement);
   }
  }
 }
 function editTable(action,cell){
  const table=cell.closest('table'),body=table.tBodies[0];
  let row=cell.parentElement.rowIndex,column=cell.cellIndex;
  const header=table.rows[0].cells[0].tagName==='TH';
  switch(action){
   case 'above':case 'below':{
    if(table.rows.length>=WIKI_LIMITS.rows)return;
    if(action==='below')row++;
    const next=body.insertRow(row);
    for(let i=0;i<table.rows[row===0?1:0].cells.length;i++)next.append(tableCell('td',[],true));
    break;
   }
   case 'left':case 'right':
    if(table.rows[0].cells.length>=WIKI_LIMITS.columns)return;
    if(action==='right')column++;
    for(const tr of table.rows)tr.insertBefore(tableCell('td',[],true),tr.cells[column]??null);
    break;
   case 'row':
    if(table.rows.length===1)return;
    table.deleteRow(row);
    row=Math.min(row,table.rows.length-1);
    break;
   case 'column':
    if(table.rows[0].cells.length===1)return;
    for(const tr of table.rows)tr.deleteCell(column);
    column=Math.min(column,table.rows[0].cells.length-1);
    break;
   case 'table':{
    const target=paragraph();
    table.closest('.wiki-table').replaceWith(target);
    place(target);
    changed();
    return;
   }
  }
  headerRow(table,action==='header'?!header:header);
  place(table.rows[row].cells[column]);
  changed();
 }

 const typeOptions=[
  ['p','Odstavec'],['h1','Nadpis 1'],['h2','Nadpis 2'],['h3','Nadpis 3'],['blockquote','Citace'],['pre','Blok kódu'],
 ];
 const type=el('select',{'aria-label':t('Typ odstavce'),onchange:()=>command('formatBlock',type.value)},
  typeOptions.map(([value,label])=>el('option',{value},t(label))));
 const formatting=[
  ['Tučně','B','bold'],['Kurzíva','I','italic'],['Přeškrtnutí','S','strikeThrough'],['Kód','</>','fontName'],
  ['Odrážky','•','insertUnorderedList'],['Číslovaný seznam','1.','insertOrderedList'],
 ].slice(0,inlineOnly?4:6).map(([label,text,name])=>{
  const pressed=()=>name==='fontName'?document.queryCommandValue(name)==='monospace':document.queryCommandState(name);
  const control=button(text,()=>{
   restore();
   command(name,name==='fontName'?(pressed()?'sans-serif':'monospace'):undefined);
  },{title:t(label),'aria-label':t(label),'aria-pressed':'false',onmousedown:event=>event.preventDefault()});
  return {control,pressed};
 });
 const editButton=(label,action)=>button(label,action,{onmousedown:event=>event.preventDefault()});
 const ticketButton=editButton(t('Ticket'),pickTicket);
 const toolbar=el('div',{class:'wiki-toolbar',role:'group','aria-label':t('Formátování')},
  inlineOnly?null:type,...formatting.map(({control})=>control),editButton(t('Odkaz'),link),standalone?null:ticketButton,
  ...(inlineOnly?[]:[
   editButton(t('Tabulka'),newTable),
   editButton(t('Tabulka inventáře'),()=>openIsland({t:'inventory',id:newWikiItemId('inventory'),
    columns:[{id:newWikiItemId('column'),label:t('Název')}],rows:[]})),
   editButton(t('Skupina příloh'),()=>openIsland({t:'attachments',id:newWikiItemId('group'),attachments:[]})),
   editButton(t('Blok HTML'),()=>editHtml()),editButton(t('Oddělovač'),()=>insertBlock(el('hr',{contenteditable:'false'}))),
  ]));
 const tableActions=[
  ['above','Řádek nad'],['below','Řádek pod'],['left','Sloupec vlevo'],['right','Sloupec vpravo'],
  ['row','Odebrat řádek'],['column','Odebrat sloupec'],['header','Záhlaví'],['table','Odebrat tabulku'],
 ].map(([action,label])=>[action,editButton(t(label),()=>{if(activeCell)editTable(action,activeCell);})]);
 tableTools.append(...tableActions.map(([,control])=>control));
 tableTools.setAttribute('role','group');
 tableTools.setAttribute('aria-label',t('Úpravy tabulky'));

 function syncTools(){
  const current=getSelection();
  if(!current.rangeCount)return;
  const range=current.getRangeAt(0);
  if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return;
  const start=selectedElement(range);
  const cell=start.closest('td,th');
  if(cell&&!cell.contains(range.endContainer))return;
  selection=range.cloneRange();
  activeCell=cell;
  tableTools.hidden=!activeCell;
  type.disabled=Boolean(cell);
  const tag=start.closest('h1,h2,h3,blockquote,pre')?.tagName.toLowerCase();
  type.value=tag??'p';
  ticketButton.disabled=tag==='pre';
  for(const {control,pressed} of formatting){
   control.disabled=Boolean(cell)&&['•','1.'].includes(control.textContent);
   control.setAttribute('aria-pressed',String(pressed()));
  }
  if(!cell)return;
  const table=cell.closest('table'),rows=table.rows.length,columns=table.rows[0].cells.length;
  const disabled={above:cell.tagName==='TH'||rows>=WIKI_LIMITS.rows,below:rows>=WIKI_LIMITS.rows,left:columns>=WIKI_LIMITS.columns,
   right:columns>=WIKI_LIMITS.columns,row:rows===1,column:columns===1};
  for(const [action,control] of tableActions){
   control.disabled=disabled[action]??false;
   if(action==='header')control.setAttribute('aria-pressed',String(table.rows[0].cells[0].tagName==='TH'));
  }
 }

 const picker=referencePicker(root,{project:()=>standalone?null:(projectId??page.project),canGlobal,standalone,context:()=>richSelection(root,(range,record)=>{
  const chip=record.kind==='ticket'?ticketChip(record.id,tickets.get(record.id),true):referenceChip(record,true);
  const space=document.createTextNode(' ');
  range.deleteContents();range.insertNode(space);range.insertNode(chip);
  root.focus();range.setStartAfter(space);range.collapse(true);
  const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
  syncTools();changed();
 })});
 root.replaceChildren(...wikiBlocks(doc,context));
 ensureCaret();
 root.addEventListener('input',()=>{ensureCaret();syncTools();changed();});
 root.addEventListener('paste',event=>{
  event.preventDefault();
  const text=event.clipboardData?.getData('text/plain');
  if(!text)return;
  if(event.target.closest('td,th')){
   // Prevent the browser from inserting nested paragraphs into an inline-only cell.
   const range=restore(),node=document.createTextNode(text);
   range.deleteContents();range.insertNode(node);
   range.setStartAfter(node);range.collapse(true);
   const current=getSelection();current.removeAllRanges();current.addRange(range);
   syncTools();changed();
  }else command('insertText',text);
 });
 root.addEventListener('drop',event=>event.preventDefault());
 root.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='k'){
   event.preventDefault();event.stopPropagation();link();return;
  }
  const cell=event.target.closest('td,th');
  if(!cell)return;
  if(event.key==='Enter'){event.preventDefault();command('insertLineBreak');return;}
  if(event.key!=='Tab')return;
  const table=cell.closest('table'),cells=[...table.querySelectorAll('th,td')],i=cells.indexOf(cell),next=cells[i+(event.shiftKey?-1:1)];
  if(next){event.preventDefault();place(next);}
  else if(!event.shiftKey&&table.rows.length<WIKI_LIMITS.rows){
   event.preventDefault();
   editTable('below',cell);
   place(table.rows[table.rows.length-1].cells[0]);
  }
 });
 document.addEventListener('selectionchange',syncTools);
 return {node:el('div',{class:'wiki-form'},el('div',{class:'wiki-tool-stack'},toolbar,tableTools),el('div',{class:'ref-editor'},root,picker),error),error,
  read:()=>inlineOnly?inlineBlocks(root):serializeWiki(root,islands),
  focus:()=>place([...root.children].find(node=>node.getAttribute('contenteditable')!=='false')??root),
  stop:()=>document.removeEventListener('selectionchange',syncTools)};
}

export function wikiValidationMessage(error){
 if(error.status)return error.message;
 if(error.message==='limit')return t('Obsah překročil limit wiki.');
 if(error.message==='invalid')return t('Zkontroluj název a obsah stránky.');
 return t('Požadavek selhal.');
}
