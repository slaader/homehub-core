import {referencesSection} from './references-view.js';
import {el,onLeave} from './views.js';
import {t,tp,locale} from './i18n.js';
import {timeZone} from './site.js';
import {banner,emptyState,errorState,loadingState,pageHeader} from './ui.js';
import {normalizeDoc,PAGE_ID,WIKI_LIMITS,wikiTitle} from './wiki-doc.js';
import {canWriteWiki,editWikiHref,notifyWikiNavigation,readWikiTree,setupWikiAction,ticketChip,wikiApi,wikiApiPath,wikiBlocks,wikiHref} from './wiki-content.js';
import {wikiEditor,wikiValidationMessage} from './wiki-editor.js';
import {manageWikiSources,newWikiItemId} from './wiki-inventory-editor.js';
import {wikiMedia} from './wiki-media.js';

const drafts=new Map();
const SPACE_ID=/^[a-z][a-z0-9-]{1,39}$/;
const slugOf=name=>name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^[^a-z]+|-+$/g,'').slice(0,40);
const listSpaces=data=>Array.isArray(data?.spaces)?data.spaces:Array.isArray(data?.projects)?data.projects:[];
const date=value=>new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeStyle:'short',timeZone:timeZone()}).format(new Date(value));
const button=(label,onclick,attrs={})=>el('button',{class:'acc-btn',type:'button',onclick,...attrs},label);
const status=()=>el('p',{class:'acc-status error',role:'alert'});

function confirmPage(page,project,id){
 if((page?.project!==project&&page?.space!==project)||!PAGE_ID.test(page.id)||(id&&page.id!==id)||
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

export function wikiPage({me,sub:routeSpace,onWikiTree}){
 let project=routeSpace;
 const root=el('section',{class:'sec tk wiki'},loadingState());
 const [hashPath,hashQuery='']=location.hash.split('?');
 const [, , selected]=hashPath.split('/');
 const wantsEdit=hashQuery==='edit';
 const wantsNew=hashQuery==='new';
 const writable=canWriteWiki(me);
 let live=true,disposeEdit=null;
 const dialogs=new Set(),media=wikiMedia({dialog});
 onLeave(()=>{
  live=false;
  media.stop();
  disposeEdit?.();
  for(const d of [...dialogs].reverse())d.close();
 });
 const back={label:project?t('Wiki'):t('Projekty'),href:project?'#wiki':'#projects'};
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

 function newSpaceDialog(){
  let touched=false;
  const name=el('input',{name:'name',required:'',maxlength:'80',autocomplete:'off',autofocus:'',oninput:()=>{if(!touched)idInput.value=slugOf(name.value);}});
  const idInput=el('input',{name:'id',required:'',pattern:'[a-z][a-z0-9\\-]{1,39}',placeholder:'my-wiki',autocomplete:'off',oninput:()=>{touched=true;}});
  const message=status();
  const submit=el('button',{type:'submit',class:'acc-btn primary'},t('Vytvořit wiki'));
  const form=el('form',{class:'wiki-form',onsubmit:async event=>{
   event.preventDefault();
   const cleanName=name.value.trim(),cleanId=idInput.value.trim();
   if(!cleanName||!SPACE_ID.test(cleanId)){message.textContent=t('Zadej platný název a ID wiki.');return;}
   submit.disabled=true;message.textContent='';
   try{
    const saved=await wikiApi('/api/wiki/spaces',{id:cleanId,name:cleanName,create:true});
    const spaceId=saved.id??cleanId;
    notifyWikiNavigation(spaceId,true);
    if(live&&d.open){d.close();location.hash=saved.home?editWikiHref(spaceId,saved.home):wikiHref(spaceId);}
   }catch(error){message.textContent=wikiValidationMessage(error);}
   finally{submit.disabled=false;}
  }},el('label',{},t('Název wiki'),name),el('label',{},t('ID (slug)'),idInput),
   el('small',{class:'tk-dim'},t('Vytvoří samostatnou wiki s domovskou stránkou.')),message,
   el('div',{class:'wiki-actions'},submit,button(t('Zrušit'),()=>d.close())));
  const d=dialog(t('Nová wiki'),[form],{closeButton:false});
 }

 function renameSpaceDialog(spaceId,currentName,onDone){
  const name=el('input',{name:'name',required:'',maxlength:'80',value:currentName,autofocus:''});
  const message=status();
  const submit=el('button',{type:'submit',class:'acc-btn primary'},t('Uložit'));
  const form=el('form',{class:'wiki-form',onsubmit:async event=>{
   event.preventDefault();
   const cleanName=name.value.trim();
   if(!cleanName){message.textContent=t('Zadej platný název wiki.');return;}
   submit.disabled=true;message.textContent='';
   try{
    await wikiApi('/api/wiki/spaces',{id:spaceId,name:cleanName,create:false});
    notifyWikiNavigation(spaceId,true);
    if(live&&d.open){d.close();onDone?.();}
   }catch(error){message.textContent=wikiValidationMessage(error);}
   finally{submit.disabled=false;}
  }},el('label',{},t('Název wiki'),name),message,
   el('div',{class:'wiki-actions'},submit,button(t('Zrušit'),()=>d.close())));
  const d=dialog(t('Přejmenovat wiki'),[form],{closeButton:false});
 }

 async function linkSpaceDialog(spaceId,spaceName,onDone){
  const message=status();
  const select=el('select',{name:'projectId'});
  const submit=el('button',{type:'submit',class:'acc-btn primary'},t('Propojit'));
  const body=el('div',{class:'wiki-form'},loadingState());
  const d=dialog(t('Propojit wiki s projektem'),[body],{closeButton:false});
  try{
   const [tracker,index]=await Promise.all([wikiApi('/api/tickets?limit=1'),wikiApi('/api/wiki?includeHidden=1')]);
   if(!live||!d.open)return;
   const taken=new Set(listSpaces(index).map(s=>s.projectId!==undefined?s.projectId:s.id).filter(Boolean));
   const eligible=(tracker?.projects??[]).filter(p=>!taken.has(p.id));
   if(!eligible.length){
    body.replaceChildren(el('p',{class:'sec-dim'},t('Všechny existující projekty už mají vlastní wiki.')),
     el('div',{class:'wiki-actions'},button(t('Zavřít'),()=>d.close())));
    return;
   }
   select.replaceChildren(...eligible.map(p=>el('option',{value:p.id},`${p.name} (${p.key})`)));
   const form=el('form',{class:'wiki-form',onsubmit:async event=>{
    event.preventDefault();
    submit.disabled=true;message.textContent='';
    try{
     await wikiApi('/api/wiki/spaces',{id:spaceId,projectId:select.value,create:false});
     notifyWikiNavigation(spaceId,true);
     if(live&&d.open){d.close();onDone?.();}
    }catch(error){message.textContent=wikiValidationMessage(error);}
    finally{submit.disabled=false;}
   }},el('p',{class:'sec-dim'},t('Prostor „{name}“ se propojí s vybraným projektem. Adresy stránek zůstanou zachovány.',{name:spaceName})),
    el('label',{},t('Projekt'),select),message,
    el('div',{class:'wiki-actions'},submit,button(t('Zrušit'),()=>d.close())));
   body.replaceChildren(form);
  }catch(error){
   if(live&&d.open)body.replaceChildren(el('p',{class:'acc-status error',role:'alert'},wikiValidationMessage(error)),
    el('div',{class:'wiki-actions'},button(t('Zavřít'),()=>d.close())));
  }
 }

 function deleteSpaceDialog(spaceId,spaceName,onDone){
  const confirmInput=el('input',{name:'confirmation',autocomplete:'off',placeholder:spaceName,autofocus:''});
  const message=status();
  const submit=el('button',{type:'submit',class:'acc-btn danger',disabled:''},t('Smazat wiki'));
  const matches=()=>confirmInput.value.trim()===spaceName||confirmInput.value.trim()===spaceId;
  confirmInput.addEventListener('input',()=>{submit.disabled=!matches();});
  const form=el('form',{class:'wiki-form',onsubmit:async event=>{
   event.preventDefault();
   if(!matches())return;
   submit.disabled=true;message.textContent='';
   try{
    await wikiApi('/api/wiki/spaces/delete',{id:spaceId});
    notifyWikiNavigation(spaceId,true);
    if(live&&d.open){d.close();onDone?.();}
   }catch(error){message.textContent=wikiValidationMessage(error);submit.disabled=!matches();}
  }},el('p',{},t('Smazání wiki „{name}“ odstraní všechny její stránky, přehledy a povolení zdrojů. Tato akce je nevratná.',{name:spaceName})),
   el('label',{},t('Pro potvrzení napiš název nebo ID wiki ({id})',{id:spaceId}),confirmInput),message,
   el('div',{class:'wiki-actions'},submit,button(t('Zrušit'),()=>d.close())));
  const d=dialog(t('Smazat wiki'),[form],{closeButton:false});
 }

 async function loadOverview(){
  root.replaceChildren(loadingState());
  try{
   const [index,tracker]=await Promise.all([wikiApi('/api/wiki'),wikiApi('/api/tickets?limit=1').catch(()=>({projects:[]}))]);
   if(!live)return;
   const projects=new Map((tracker?.projects??[]).map(p=>[p.id,p]));
   const spaces=listSpaces(index).sort((a,b)=>(a.name||a.id).localeCompare(b.name||b.id,locale())||a.id.localeCompare(b.id));
   const header=pageHeader({eyebrow:'Project Tracker',title:'Wiki',lead:t('Projektové i samostatné wiki prostory.'),
    actions:writable?[{label:t('+ Nová wiki'),primary:true,onclick:newSpaceDialog}]:[]});
   const cards=spaces.length?el('div',{class:'wiki-spaces'},spaces.map(space=>{
    const linkedId=space.projectId!==undefined?space.projectId:(projects.has(space.id)?space.id:null);
    const linkedProject=linkedId?projects.get(linkedId):null;
    const displayName=linkedProject?.name??space.name??space.id;
    const standalone=!linkedId;
    return el('article',{class:'acc-card wiki-space-card'},
     el('div',{class:'wiki-space-head'},
      el('h2',{class:'wiki-space-title'},el('a',{href:wikiHref(space.id)},displayName)),
      el('span',{class:`sec-pill${standalone?'':' info'}`},standalone?t('Samostatná wiki'):(linkedProject?.name??linkedId))),
     el('div',{class:'wiki-space-meta'},el('span',{class:'tk-mono'},space.id),
      Number.isInteger(space.count)?el('span',{},tp(space.count,'{n} stránka|{n} stránky|{n} stránek')):null),
     el('div',{class:'wiki-space-actions'},
      el('a',{class:'acc-btn small',href:wikiHref(space.id)},t('Otevřít')+' →'),
      ...(writable&&standalone?[
       button(t('Přejmenovat'),()=>renameSpaceDialog(space.id,displayName,loadOverview),{class:'acc-btn small'}),
       button(t('Propojit s projektem'),()=>linkSpaceDialog(space.id,displayName,loadOverview),{class:'acc-btn small'}),
       button(t('Smazat'),()=>deleteSpaceDialog(space.id,displayName,loadOverview),{class:'acc-btn small'}),
      ]:[])));
   })):emptyState({icon:'box',title:t('Zatím tu není žádná wiki'),
    body:t('Založ samostatnou wiki, nebo zapni wiki u některého projektu.'),
    actions:writable?[{label:t('+ Nová wiki'),primary:true,onclick:newSpaceDialog}]:[]});
   root.replaceChildren(header,cards);
   if(wantsNew&&writable){
    if(location.hash==='#wiki?new')history.replaceState(history.state,'','#wiki');
    newSpaceDialog();
   }
  }catch(error){if(live)fail(error);}
 }

 async function load(){
  if(!project)return loadOverview();
  root.replaceChildren(loadingState());
  try{
   if(!SPACE_ID.test(project??'')||(selected&&!PAGE_ID.test(selected)))
    throw Object.assign(new Error(t('Stránka nebo wiki neexistuje.')),{status:404});
   const [meta,initialTracker]=await Promise.all([
    readWikiTree(project),
    wikiApi('/api/tickets?project='+project).catch(()=>null),
   ]);
   if(!live)return;
   if(meta.enabled&&meta.id&&meta.id!==project){
    project=meta.id;
    const canonical=wikiHref(project,selected);
    history.replaceState(history.state,'',canonical+(hashQuery?'?'+hashQuery:''));
   }
   let tracker=initialTracker;
   const linkedProjectId=meta.projectId!==undefined?meta.projectId:(tracker?.projects?.some(p=>p.id===project)?project:null);
   if(linkedProjectId&&linkedProjectId!==project){
    tracker=await wikiApi('/api/tickets?project='+encodeURIComponent(linkedProjectId)).catch(()=>tracker);
    if(!live)return;
   }
   const info=linkedProjectId?tracker?.projects?.find(p=>p.id===linkedProjectId):null;
   const projectName=info?.name??meta.name??project;
   const tickets=new Map((linkedProjectId?(tracker?.tickets??[]):[]).map(ticket=>[ticket.id,ticket]));
   const sidebarHidden=Boolean(info&&info.settings?.wiki===false);
   onWikiTree?.(project,meta,projectName,{sidebarHidden});
   if(!meta.enabled){
    if(!info)throw Object.assign(new Error(t('Stránka nebo wiki neexistuje.')),{status:404});
    root.replaceChildren(emptyState({icon:'box',title:t('Wiki projektu zatím není založena.'),
     actions:[writable&&info?.settings?.wiki!==false?setupWikiAction(project,fail):null,{label:projectName,href:'#projects/'+linkedProjectId}]}));
    return;
   }
   const page=await wikiApi(wikiApiPath(project,selected||meta.home));
   if(!live)return;
   const globalReferences=linkedProjectId?Boolean(info)&&info.settings?.globalReferences!==false:true;
   show(meta,page,{projectName,tickets,linkedProjectId,standalone:!linkedProjectId,globalReferences},writable&&(wantsEdit||Boolean(savedDraft(draftKey(me,page)))));
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
  const {linkedProjectId,standalone}=context;
  const actions=writable&&!editing?[{label:t('Upravit'),primary:true,onclick:edit},{label:t('Nová podstránka'),onclick:makePage},
   ...(page.id===meta.home?[]:[{label:t('Přesunout stránku'),onclick:movePage}]),
   ...(standalone?[
    {label:t('Přejmenovat wiki'),onclick:()=>renameSpaceDialog(project,projectName,load)},
    {label:t('Propojit s projektem'),onclick:()=>linkSpaceDialog(project,projectName,load)},
    {label:t('Smazat wiki'),danger:true,onclick:()=>deleteSpaceDialog(project,projectName,()=>{location.hash='#wiki';})},
   ]:[]),
   ...(me.canAdmin?[{label:t('Povolené zdroje wiki'),onclick:()=>manageWikiSources(project,dialog)}]:[])]:[];
  const sep=()=>el('span',{class:'tk-dim'},'/');
  const rootCrumbs=linkedProjectId
   ?[el('a',{href:'#projects'},t('Projekty')),sep(),el('a',{href:'#projects/'+linkedProjectId},projectName),sep(),el('a',{href:wikiHref(project)},'Wiki'),sep()]
   :[el('a',{href:'#wiki'},'Wiki'),sep(),el('a',{href:wikiHref(project)},projectName),sep()];
  root.replaceChildren(el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},
   ...rootCrumbs,
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
   content.append(referencesSection('wiki',project+'/'+page.id,me));
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
  const editor=wikiEditor({page,doc:draft?.doc??page.doc,tickets,api:wikiApi,dialog,canGlobal:context.globalReferences&&me?.scopes?.includes('references:write'),projectId:linkedProjectId,standalone,changed});
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
