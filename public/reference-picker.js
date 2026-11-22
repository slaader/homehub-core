import {el} from './views.js';
import {t} from './i18n.js';
import {referenceApi} from './reference-chip.js';
import {validLabel} from './reference-format.js';

let serial=0;
const selectionEditors=new WeakMap(),observedDocuments=new WeakSet();
function observeSelection(node,update){
 const doc=node.ownerDocument??document;
 selectionEditors.set(node,update);
 if(observedDocuments.has(doc))return;
 observedDocuments.add(doc);
 doc.addEventListener('selectionchange',()=>{
  for(let focused=doc.activeElement;focused;focused=focused.parentElement){
   const refresh=selectionEditors.get(focused);
   if(refresh){refresh();break;}
  }
 });
}
const trigger=/(?:^|[\s(])@([\p{L}\p{N}_.\/-]{0,120})$/u;
const button=(label,action)=>el('button',{type:'button',class:'acc-btn small',onmousedown:e=>e.preventDefault(),onclick:action},label);
export const kindName=kind=>t(({custom:'Vlastní',model:'Model',project:'Projekt',machine:'Zařízení',wiki:'Wiki',ticket:'Ticket',epic:'Epic'})[kind]||kind);

// Each editor supplies a snapshot of its actual selection and a replacement operation against that snapshot.
export function referencePicker(node,{context,project,canGlobal=false,standalone=false}){
 const id='reference-picker-'+(++serial),panel=el('div',{class:'ref-picker',hidden:''}),list=el('div',{id,role:'listbox'});
 let sequence=0,current=null,items=[],active=-1,formOpen=false,last=null,createButton=null;
 const originalShortcuts=node.getAttribute('aria-keyshortcuts');
 const allowGlobal=()=>Boolean(typeof canGlobal==='function'?canGlobal():canGlobal);
 const isStandalone=()=>Boolean(typeof standalone==='function'?standalone():standalone);
 const hide=()=>{
  sequence++;current=null;last=null;items=[];formOpen=false;panel.hidden=true;panel.replaceChildren();
  if(createButton){
   if(originalShortcuts===null)node.removeAttribute('aria-keyshortcuts');
   else node.setAttribute('aria-keyshortcuts',originalShortcuts);
   createButton=null;
  }
  for(const attr of ['aria-controls','aria-activedescendant'])node.removeAttribute(attr);
 };
 function show(...parts){
  panel.replaceChildren(...parts);panel.hidden=false;
  const editor=node.getBoundingClientRect?.(),range=globalThis.getSelection?.();
  const rect=range?.rangeCount&&node.contains(range.anchorNode)?range.getRangeAt(0).getBoundingClientRect?.():null;
  if(editor&&rect&&rect.height){
   panel.style.top=Math.max(0,rect.bottom-editor.top)+'px';
   panel.style.insetInlineStart=Math.max(0,Math.min(rect.left-editor.left,editor.width-panel.offsetWidth))+'px';
  }
 }
 function choose(record){
  if(!current||!node.isConnected||record.scope==='local'&&record.project!==project())return hide();
  if(current.fits&&!current.fits(record)){
   items=[];show(el('span',{role:'alert'},t('Reference překračuje limit textu.')));return;
  }
  current.replace(record);hide();
 }
 function create(selection){
  formOpen=true;const owner=project(),label=el('input',{maxlength:200,value:selection.trim(),'aria-label':t('Název')});
  const note=el('textarea',{rows:2,maxlength:8000,'aria-label':t('Popis'),placeholder:t('Popis')});
  const offerGlobal=Boolean(owner)&&allowGlobal();
  const hintId=id+'-scope-hint';
  const global=el('input',{type:'checkbox',id:id+'-global','aria-describedby':hintId}),error=el('span',{class:'acc-status error',role:'alert'});
  const save=button(t('Uložit'),async()=>{
   if(save.disabled||!validLabel(label.value))return;
   if(owner!==project()||!current)return hide();
   const local=Boolean(owner)&&!(offerGlobal&&global.checked),selection=current;
   if(selection.fits&&!selection.fits({kind:'custom',id:'r'+'0'.repeat(32),label:label.value})){
    error.textContent=t('Reference překračuje limit textu.');return;
   }
   save.disabled=true;
   try{
    const record=await referenceApi(local?'/local/save':'/global/save',{kind:'custom',label:label.value,description:note.value,...(local?{project:owner}:{})});
    if(selection===current&&owner===project())choose(record);
   }catch(e){error.textContent=e.message;}finally{save.disabled=false;}
  });
  const globalLabel=el('div',{class:'ref-scope'},
   el('label',{class:'ref-scope-label',for:id+'-global',onmousedown:e=>{
    if(e.target!==global){e.preventDefault();global.focus();}
   }},global,el('span',{},t('Globální reference'))),
   el('small',{id:hintId},t('Po zaškrtnutí bude reference dostupná ve všech projektech.')));
  show(label,note,offerGlobal?globalLabel:el('small',{},owner??t('Globální reference')),
   error,el('div',{class:'wiki-actions'},save,button(t('Zrušit'),hide)));
  label.focus();
 }
 function highlight(){
  Array.from(list.children).forEach((b,i)=>b.setAttribute('aria-selected',String(i===active)));
  if(active>=0)node.setAttribute('aria-activedescendant',id+'-'+active);
 }
 async function update(){
  if(formOpen)return;
  const selection=context(),owner=project();
  if(!selection||(!owner&&!isStandalone()))return hide();
  const selected=selection.selected;
  const query=selected?'':selection.before.match(trigger)?.[1];
  if((selected&&!validLabel(selected))||(!selected&&query===undefined))return hide();
  if(selected&&!owner&&!allowGlobal())return hide();
  const identity=JSON.stringify([selected||query,selection.position,owner]);
  if(!selected)selection.trim=query.length+1;
  if(selection.accepts&&!selection.accepts(selection.trim))return hide();
  current=selection;
  if(last===identity)return;
  hide();current=selection;last=identity;
  if(selected){
   createButton=button(t('Vytvořit referenci'),()=>create(selected));
   node.setAttribute('aria-keyshortcuts',[originalShortcuts,'Alt+Shift+R'].filter(Boolean).join(' '));show(createButton);return;
  }

  const turn=sequence;
  try{
   const params=new URLSearchParams(owner?{project:owner,q:query}:{q:query});
   const {items:matches}=await referenceApi('/suggest?'+params);
   if(sequence!==turn||!node.isConnected||owner!==project())return;
   items=matches;active=query?0:-1;
   if(!items.length)return hide();
   list.replaceChildren(...items.map((r,i)=>el('button',{type:'button',role:'option',id:id+'-'+i,tabindex:'-1',
    onmousedown:e=>e.preventDefault(),onclick:()=>choose(r)},el('strong',{},r.label),' · '+kindName(r.kind)+' · '+(r.project??r.id))));
   show(list);node.setAttribute('aria-controls',id);highlight();
  }catch{if(turn===sequence)hide();}
 }
 function key(e){
  if(e.isComposing||e.ctrlKey||e.metaKey)return;
  if(e.altKey&&e.shiftKey&&e.code==='KeyR'&&createButton){
   e.preventDefault();e.stopImmediatePropagation();createButton.click();return;
  }
  if(e.altKey)return;
  if(e.key==='Escape'&&!panel.hidden){e.preventDefault();e.stopImmediatePropagation();hide();return;}
  if(!items.length)return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
   e.preventDefault();e.stopImmediatePropagation();active=active<0?(e.key==='ArrowDown'?0:items.length-1):(active+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;highlight();return;
  }
  if(e.key==='Enter'||e.key==='Tab'){
   if(active<0){hide();return;}
   e.preventDefault();e.stopImmediatePropagation();choose(items[active]);
  }
 }
 observeSelection(node,update);
 node.addEventListener('input',update);node.addEventListener('pointerup',update);node.addEventListener('select',update);
 node.addEventListener('keyup',e=>{if(!['Escape','Enter','Tab','ArrowDown','ArrowUp'].includes(e.key))update();});
 node.addEventListener('keydown',key,true);
 const blur=e=>{if(!panel.contains(e.relatedTarget)&&!node.contains(e.relatedTarget))hide();};
 node.addEventListener('compositionstart',hide);
 node.addEventListener('focusout',blur);panel.addEventListener('focusout',blur);
 panel.addEventListener('mousedown',e=>{if(!e.target.closest('input,textarea,label,button'))e.preventDefault();});
 panel.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.tagName==='INPUT'&&e.target.type!=='checkbox'){e.preventDefault();panel.querySelector('button')?.click();}if(e.key==='Escape'){e.preventDefault();hide();node.focus();}});
 return panel;
}

export function richSelection(root,insert){
 const sel=globalThis.getSelection?.();
 if(!sel?.rangeCount)return null;
 const range=sel.getRangeAt(0).cloneRange(),text=range.startContainer;
 if(!root.contains(text)||text!==range.endContainer||text.nodeType!==3)return null;
 const parent=text.parentElement;
 if(parent.closest('a,pre,code,[data-ref-id],[data-ticket]')||parent.closest('[contenteditable]')?.getAttribute('contenteditable')==='false')return null;
 const ctx={selected:range.toString(),before:text.data.slice(0,range.startOffset),position:range.startOffset,trim:0,
  replace(record){if(!root.contains(text))return;range.setStart(text,range.startOffset-ctx.trim);insert(range,record);}};
 return ctx;
}
