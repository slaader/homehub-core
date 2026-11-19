import {el,onLeave} from './views.js';
import {t,locale} from './i18n.js';
import {timeZone} from './site.js';
import {banner,emptyState,errorState,loadingState,pageHeader} from './ui.js';
import {normalizeDoc,PAGE_ID,WIKI_LIMITS,wikiTitle} from './wiki-doc.js';
import {canWriteWiki,editWikiHref,notifyWikiNavigation,readWikiTree,setupWikiAction,ticketChip,wikiApi,wikiApiPath,wikiBlocks,wikiHref} from './wiki-content.js';
import {wikiEditor,wikiValidationMessage} from './wiki-editor.js';
import {manageWikiSources,newWikiItemId} from './wiki-inventory-editor.js';
import {wikiMedia} from './wiki-media.js';

const drafts=new Map();
const date=value=>new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeStyle:'short',timeZone:timeZone()}).format(new Date(value));
const button=(label,onclick,attrs={})=>el('button',{class:'acc-btn',type:'button',onclick,...attrs},label);
const status=()=>el('p',{class:'acc-status error',role:'alert'});

function confirmPage(page,project,id){
 if(page?.project!==project||!PAGE_ID.test(page.id)||(id&&page.id!==id)||
  !Number.isSafeInteger(page.rev)||page.rev<1||page.doc?.v!==1||!Array.isArray(page.doc.blocks))throw new Error('Incomplete page response');
}

function draftKey(me,page){
 return 'wiki-draft:'+JSON.stringify([me.authKind,me.id??me.username,page.project,page.id]);
}
function savedDraft(key){
 if(drafts.has(key))return drafts.get(key);
 try{
  const value=JSON.parse(sessionStorage.getItem(key));
  if(Number.isSafeInteger(value?.rev)&&typeof value.title==='string'&&value.doc?.v===1&&Array.isArray(value.doc.blocks))return value;
 }catch{}
 return null;
}
function storeDraft(key,draft){
 if(draft)drafts.set(key,draft);
 else drafts.delete(key);
 try{
  if(draft)sessionStorage.setItem(key,JSON.stringify(draft));
  else sessionStorage.removeItem(key);
 }catch{}
}

export function wikiPage({me,sub:project,onWikiTree}){
 const root=el('section',{class:'sec tk wiki'},loadingState());
 const [, , selected]=location.hash.split('?')[0].split('/');
 const wantsEdit=location.hash.endsWith('?edit');
 const writable=canWriteWiki(me);
 let live=true,disposeEdit=null;
 const dialogs=new Set(),media=wikiMedia({dialog});
 onLeave(()=>{
  live=false;
  media.stop();
  disposeEdit?.();
  for(const d of [...dialogs].reverse())d.close();
 });
 const back={label:t('Projekty'),href:'#projects'};
 function fail(error){
  const missing=error.status===404;
  root.replaceChildren(errorState({title:missing?t('Stránka nebo wiki neexistuje.'):t('Wiki teď nejde načíst ani uložit.'),
   body:error.message,actions:[back],retry:missing?null:load}));
 }
 function dialog(title,children,{closeButton=true,className='',opener=document.activeElement}={}){
  const x=window.scrollX,y=window.scrollY;
  const titleId=newWikiItemId('wiki-dialog-title');
  const d=el('dialog',{class:'wiki-dialog '+className,'aria-labelledby':titleId},
   el('h2',{id:titleId},title),...children,closeButton?button(t('Zavřít'),()=>d.close()):null);
  d.addEventListener('close',()=>{
   dialogs.delete(d);
   d.remove();
   if(!live||[...dialogs].some(other=>other.open&&!other.contains(opener)))return;
   if(opener?.isConnected)opener.focus({preventScroll:true});
   if(window.scrollX!==x||window.scrollY!==y)window.scrollTo({left:x,top:y,behavior:'instant'});
  });
  dialogs.add(d);
  document.body.append(d);
  d.showModal();
  return d;
 }

 async function load(){
  root.replaceChildren(loadingState());
  try{
   if(!/^[a-z][a-z0-9-]{1,39}$/.test(project??'')||(selected&&!PAGE_ID.test(selected)))
    throw Object.assign(new Error(t('Stránka nebo wiki neexistuje.')),{status:404});
   const [meta,tracker]=await Promise.all([
    readWikiTree(project),
    wikiApi('/api/tickets?project='+project).catch(()=>null),
   ]);
   if(!live)return;
   const projectName=tracker?.projects.find(p=>p.id===project)?.name??project;
   const tickets=new Map((tracker?.tickets??[]).map(ticket=>[ticket.id,ticket]));
   onWikiTree?.(project,meta,projectName);
   if(!meta.enabled){
    root.replaceChildren(emptyState({icon:'box',title:t('Wiki projektu zatím není založena.'),
     actions:[writable?setupWikiAction(project,fail):null,{label:projectName,href:'#projects/'+project}]}));
    return;
   }
   const page=await wikiApi(wikiApiPath(project,selected||meta.home));
   if(!live)return;
   show(meta,page,{projectName,tickets},writable&&(wantsEdit||Boolean(savedDraft(draftKey(me,page)))));
  }catch(error){if(live)fail(error);}
 }

 function show(meta,page,context,editing=false){
  media.stop();
  disposeEdit?.();
  disposeEdit=null;
  const {projectName,tickets}=context,desc=t('Upravil(a) {who} · {when}',{who:page.updatedBy,when:date(page.updatedAt)});
  const key=draftKey(me,page);
  const currentHref=wikiHref(project,page.id);
  const assets=new Map((page.assets??[]).map(asset=>[asset.id,asset]));
  const entries=new Map(meta.pages.map(entry=>[entry.id,entry]));
  const parent=entry=>entry.parentId??(entry.id===meta.home?null:meta.home);
  const children=new Map();
  for(const entry of meta.pages){
   const id=parent(entry);
   if(!children.has(id))children.set(id,[]);
   children.get(id).push(entry);
  }
  for(const list of children.values())list.sort((a,b)=>a.title.localeCompare(b.title,locale())||a.id.localeCompare(b.id));
  const branch=[];
  for(let id=parent(page);id&&entries.has(id)&&branch.length<meta.pages.length;id=parent(entries.get(id)))branch.unshift(entries.get(id));
  const clearEditHash=()=>{if(location.hash===editWikiHref(project,page.id))history.replaceState(history.state,'',currentHref);};
  const redraw=(next,edit=false)=>{
   const list=meta.pages.map(entry=>entry.id===next.id?next:entry);
   if(!list.some(entry=>entry.id===next.id))list.push(next);
   show({...meta,pages:list},next,context,edit);
  };

  function makePage(){
   const title=el('input',{required:'',maxlength:WIKI_LIMITS.title,autofocus:''});
   const message=status();
   const submit=el('button',{class:'acc-btn primary'},t('Vytvořit stránku'));
   let requestId=newWikiItemId('request');
   title.addEventListener('input',()=>{requestId=newWikiItemId('request');});
   const form=el('form',{class:'wiki-form',onsubmit:async event=>{
    event.preventDefault();
    submit.disabled=true;
    message.textContent='';
    try{
     const result=await wikiApi('/api/wiki/pages',{project,parentId:page.id,title:wikiTitle(title.value),requestId});
     confirmPage(result,project);
     notifyWikiNavigation(project);
     if(live&&d.open){d.close();location.hash=editWikiHref(project,result.id);}
    }catch(error){message.textContent=wikiValidationMessage(error);}
    finally{submit.disabled=false;}
   }},el('label',{},t('Název stránky'),title),message,
    el('div',{class:'wiki-actions'},submit,button(t('Zrušit'),()=>d.close())));
   const d=dialog(t('Nová podstránka'),[form],{closeButton:false});
  }

  function movePage(){
   const descendants=new Set();
   function collect(id){
    descendants.add(id);
    for(const entry of children.get(id)??[])collect(entry.id);
   }
   collect(page.id);
   const options=[];
   function addOptions(id,level){
    for(const entry of children.get(id)??[]){
     if(descendants.has(entry.id))continue;
     options.push(el('option',{value:entry.id},'\u00a0\u00a0'.repeat(level)+entry.title));
     addOptions(entry.id,level+1);
    }
   }
   addOptions(null,0);
   const select=el('select',{},options),message=status();
   select.value=parent(page);
   const submit=el('button',{class:'acc-btn primary'},t('Přesunout'));
   const form=el('form',{class:'wiki-form',onsubmit:async event=>{
    event.preventDefault();
    submit.disabled=true;
    try{
     const saved=await wikiApi('/api/wiki/pages/move',{project,id:page.id,rev:page.rev,parentId:select.value});
     confirmPage(saved,project,page.id);
     notifyWikiNavigation(project);
     if(live&&d.open){d.close();redraw(saved);}
    }catch(error){message.textContent=wikiValidationMessage(error);}
    finally{submit.disabled=false;}
   }},el('label',{},t('Nadřazená stránka'),select),message,submit);
   const d=dialog(t('Přesunout stránku'),[form]);
  }

  const content=el('div',{class:'wiki-body'});
  const edit=()=>show(meta,page,context,true);
  const actions=writable&&!editing?[{label:t('Upravit'),primary:true,onclick:edit},{label:t('Nová podstránka'),onclick:makePage},
   ...(page.id===meta.home?[]:[{label:t('Přesunout stránku'),onclick:movePage}]),
   ...(me.canAdmin?[{label:t('Povolené zdroje wiki'),onclick:()=>manageWikiSources(project,dialog)}]:[])]:[];
  const sep=()=>el('span',{class:'tk-dim'},'/');
  root.replaceChildren(el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},
   el('a',{href:'#projects'},t('Projekty')),sep(),el('a',{href:'#projects/'+project},projectName),sep(),
   el('a',{href:wikiHref(project)},'Wiki'),sep(),
   branch.map(entry=>[el('a',{href:wikiHref(project,entry.id)},entry.title),sep()]),el('b',{},page.title)),
   pageHeader({title:page.title,lead:desc,provenance:page.provenance,actions}),
   content);

  if(!editing){
   const linked=page.links.tickets;
   content.append(page.doc.blocks.length?
    el('article',{class:'acc-card wiki-article'},wikiBlocks(page.doc,{
     page,tickets,media:refs=>media.group(refs,assets),inventoryMedia:refs=>media.inventory(refs,assets),
    })):
    emptyState({icon:'box',compact:true,title:t('Tahle stránka je prázdná.'),
     actions:writable?[{label:t('Upravit'),primary:true,onclick:edit}]:[]}));
   const subpages=children.get(page.id)??[];
   if(subpages.length)content.append(el('section',{class:'acc-card wiki-linked'},
    el('h2',{},t('Podstránky')),el('ul',{},subpages.map(entry=>el('li',{},el('a',{href:wikiHref(project,entry.id)},entry.title))))));
   if(linked.length)content.append(el('section',{class:'acc-card wiki-linked'},
    el('h2',{},t('Propojené tickety')),el('ul',{},linked.map(id=>el('li',{},ticketChip(id,tickets.get(id)))))));
   if(writable){
    const keydown=event=>{
     if(event.key==='e'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.defaultPrevented&&
        !event.target.closest?.('input,select,textarea,[contenteditable],dialog')){
      event.preventDefault();edit();
     }
    };
    document.addEventListener('keydown',keydown);
    disposeEdit=()=>document.removeEventListener('keydown',keydown);
   }
   return;
  }

  const draft=savedDraft(key);
  const rev=draft?.rev??page.rev;
  const title=el('input',{required:'',maxlength:WIKI_LIMITS.title,value:draft?.title??page.title});
  let conflict=rev!==page.rev?page:null,busy=false,dirty=Boolean(draft),disposed=false,copyRequest=null;
  const conflictNotice=el('div',{});
  const editor=wikiEditor({page,doc:draft?.doc??page.doc,tickets,api:wikiApi,dialog,changed});
  const read=()=>({rev,title:title.value,doc:editor.read()});
  const initialBody=JSON.stringify(editor.read());
  const original=draft?null:JSON.stringify(read());
  const saveButton=el('button',{class:'acc-btn primary'},t('Uložit'));
  const cancelButton=button(t('Zrušit'),cancel);
  const form=el('form',{class:'wiki-form',onsubmit:event=>{event.preventDefault();save();}},
   el('label',{},t('Název stránky'),title),editor.node,el('div',{class:'wiki-actions'},saveButton,cancelButton));
  title.addEventListener('input',changed);
  content.append(conflictNotice,form);

  function changed(){
   if(disposed)return;
   const value=read();
   dirty=JSON.stringify(value)!==original;
   storeDraft(key,dirty?value:null);
  }

  function displayConflict(){
   conflictNotice.replaceChildren();
   saveButton.disabled=Boolean(conflict);
   if(!conflict)return;
   conflictNotice.append(banner({tone:'warn',title:t('Stránka se mezitím změnila.'),
    body:t('Poslední změna od {who} · {when}. Tvůj koncept je zachován.',
     {who:conflict.updatedBy,when:date(conflict.updatedAt)}),
    actions:[{label:t('Načíst uloženou verzi'),onclick:reload},{label:t('Uložit jako novou stránku'),onclick:()=>save(true)}]}));
  }

  function finish(){
   dirty=false;
   disposeEdit?.();
   disposeEdit=null;
   storeDraft(key,null);
   clearEditHash();
  }

  function discard(){
   return !dirty||confirm(t('Zahodit neuložené změny?'));
  }

  function cancel(){
   if(busy||!discard())return;
   finish();
   redraw(page);
  }

  async function reload(){
   if(busy||!discard())return;
   busy=true;
   form.inert=true;
   try{
    const latest=await wikiApi(wikiApiPath(project,page.id));
    confirmPage(latest,project,page.id);
    if(disposed)return;
    notifyWikiNavigation(project);
    finish();
    redraw(latest);
   }catch(error){editor.error.textContent=wikiValidationMessage(error);}
   finally{busy=false;form.inert=false;}
  }

  async function save(copy=false){
   if(busy||(conflict&&!copy))return;
   editor.error.textContent='';
   let input,snapshot;
   try{
    const value=read();
    snapshot=JSON.stringify(value);
    let name=wikiTitle(value.title);
    if(copy){
     const suffix=t(' (kopie)');
     name=name.slice(0,WIKI_LIMITS.title-suffix.length).replace(/[\uD800-\uDBFF]$/,'').trimEnd()+suffix;
    }
    if(copy&&copyRequest?.snapshot!==snapshot)copyRequest={snapshot,id:newWikiItemId('request')};
    input={project,title:name,...(copy||draft||JSON.stringify(value.doc)!==initialBody?{doc:normalizeDoc(value.doc)}:{}),
     ...(copy?{requestId:copyRequest.id,parentId:parent(page)??meta.home}:{id:page.id,rev})};
   }catch(error){editor.error.textContent=wikiValidationMessage(error);return;}
   busy=true;
   form.inert=true;
   try{
    const saved=await wikiApi(copy?'/api/wiki/pages':'/api/wiki/pages/update',input);
    confirmPage(saved,project,copy?undefined:page.id);
    notifyWikiNavigation(project);
    if(disposed){if(JSON.stringify(savedDraft(key))===snapshot)storeDraft(key,null);return;}
    finish();
    if(copy)location.hash=wikiHref(project,saved.id);
    else redraw(saved);
   }catch(error){
    if(disposed)return;
    if(error.status===409&&error.current){
     conflict=error.current;
     changed();
     displayConflict();
     return;
    }
    editor.error.textContent=wikiValidationMessage(error);
   }finally{busy=false;form.inert=false;}
  }

  const beforeUnload=event=>{if(dirty){event.preventDefault();event.returnValue='';}};
  const leaveClick=event=>{
   const link=event.target.closest?.('a[href^="#"]');
   if(!dirty||!link||link.hash===location.hash||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
   if(!confirm(t('Opustit stránku? Koncept zůstane v této kartě.'))){event.preventDefault();event.stopImmediatePropagation();}
  };
  const keydown=event=>{
   if([...dialogs].some(d=>d.open))return;
   if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(!conflict)save();}
   else if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();cancel();}
  };
  addEventListener('beforeunload',beforeUnload);
  document.addEventListener('click',leaveClick,true);
  document.addEventListener('keydown',keydown);
  disposeEdit=()=>{
   if(dirty)changed();
   disposed=true;
   editor.stop();
   removeEventListener('beforeunload',beforeUnload);
   document.removeEventListener('click',leaveClick,true);
   document.removeEventListener('keydown',keydown);
  };
  displayConflict();
  editor.focus();
 }

 load();
 return root;
}
