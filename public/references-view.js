import {el} from './views.js';
import {locale,t} from './i18n.js';
import {timeZone} from './site.js';
import {pageHeader,emptyState} from './ui.js';
import {referenceApi} from './reference-chip.js';
import {kindName} from './reference-picker.js';
import {markdown} from './tracker-md.js';
import {referenceKinds} from './reference-format.js';

const btn=(label,action)=>el('button',{type:'button',class:'acc-btn small',onclick:action},label);
const field=(name,input)=>el('label',{},t(name),input);
const scopeName=r=>r.scope==='local'?r.project:t('Globální reference');
const may=(me,scope)=>me?.canWrite&&me.scopes?.includes(scope);
function pager(offset,total,next){
 const actions=[];
 if(offset>0)actions.push(btn(t('Předchozí'),()=>next(offset-50)));
 if(offset+50<total)actions.push(btn(t('Další'),()=>next(offset+50)));
 return actions.length?el('div',{class:'wiki-actions'},actions):null;
}
function form(record,done,reload){
 const label=el('input',{required:'',maxlength:200,value:record.label??''});
 const description=el('textarea',{rows:4,maxlength:8000},record.description??'');
 const message=el('p',{role:'alert',class:'acc-status error'}),local=record.scope==='local';
 const submit=el('button',{class:'acc-btn primary'},t('Uložit'));
 return el('form',{class:'wiki-form',onsubmit:async e=>{
  e.preventDefault();submit.disabled=true;
  try{
   const saved=await referenceApi(local?'/local/save':'/global/save',{kind:record.kind,label:label.value,
    description:description.value,...(record.id?{id:record.id,rev:record.rev}:{}),...(local?{project:record.project}:{})});
   done(saved);
  }catch(error){message.textContent=error.message;if(error.status===409&&reload)message.append(' ',btn(t('Načíst znovu'),reload));}finally{submit.disabled=false;}
 }},field('Název',label),field('Popis',description),message,submit);
}
function details(kind,id,me,standalone=false,allowSharing=true){
 const box=el('div',{class:'ref-usages'});let request=0;
 async function load(offset=0){
  const turn=++request;
  try{
   const {record:r,note,usages,usageTotal}=await referenceApi('/item?'+new URLSearchParams({kind,id,offset}));
   if(turn!==request)return;
   const error=el('p',{class:'acc-status error',role:'alert'}),edit=el('div',{}),global=may(me,'references:write'),local=may(me,'tickets:write');
   const action=(label,path,args)=>btn(t(label),async e=>{
    if(!window.confirm(t(label)))return;
    const button=e.currentTarget;button.disabled=true;
    try{await referenceApi(path,args);await load();}catch(e){error.textContent=e.message;}finally{button.disabled=false;}
   });
   const authored=['model','custom'].includes(kind),controls=[];
   if(authored&&(r.scope==='local'?local:global))controls.push(btn(t('Upravit'),()=>edit.replaceChildren(form(r,()=>load(),()=>load()))));
   if(allowSharing&&r.scope==='local'&&global&&local)controls.push(action('Zpřístupnit ve všech projektech',authored?'/promote':'/share',
    authored?{kind,id,project:r.project,rev:r.rev}:{kind,id,rev:note?.rev??0}));
   if(!authored&&global)controls.push(btn(t('Upravit poznámku'),()=>{
    const text=el('textarea',{rows:3,maxlength:8000},note?.description??'');
    const save=btn(t('Uložit'),async()=>{
     save.disabled=true;
     try{await referenceApi('/note',{kind,id,description:text.value,rev:note?.rev??0});await load();}
     catch(e){error.textContent=e.message;}finally{save.disabled=false;}
    });edit.replaceChildren(field('Popis',text),save);
   }));
   const description=authored?r.description:note?.description;
   const day=new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeZone:timeZone()});
   box.replaceChildren(...[
    standalone?pageHeader({title:r.label,eyebrow:kindName(kind),back:{href:'#references',label:t('Reference')}}):null,
    standalone?el('p',{},scopeName(r),' · ',r.id):null,
    kind==='machine'?el('p',{},[r.role,r.ip].filter(Boolean).join(' · ')):null,
    kind==='machine'&&me?.canAdmin?el('a',{href:'#integrations/device/'+r.id},t('Podrobnosti zařízení')):null,
    description?markdown(description):null,controls.length?el('div',{class:'wiki-actions'},controls):null,edit,error,
    el('h3',{},t('Místa použití ({n})',{n:usageTotal})),
    usages.length?el('ul',{},usages.map(u=>el('li',{},el('a',{href:u.source.href},u.source.label),
     el('small',{},' · '+(u.field?.startsWith('comment/')?t('Komentář'):kindName(u.source.kind))+' · '+day.format(new Date(u.updatedAt))),
     el('p',{},u.excerpt)))):el('p',{class:'tk-dim'},t('Zatím bez odkazů.')),
    pager(offset,usageTotal,load),
   ].filter(Boolean));
  }catch(e){if(turn===request)box.replaceChildren(el('p',{role:'alert'},e.message),btn(t('Zkusit znovu'),()=>load(offset)));}
 }
 return {box,load};
}
export function referencesSection(kind,id,me,allowSharing=true){
 const {box,load}=details(kind,id,me,false,allowSharing),section=el('details',{class:'acc-card'},el('summary',{},t('Reference a místa použití')),box);
 section.addEventListener('toggle',()=>{if(section.open)load();});
 return section;
}
export function referencesPage({me}){
 const [,kind,...parts]=location.hash.split('/');
 if(kind){
  const {box,load}=details(kind,parts.join('/'),me,true);load();return el('section',{class:'sec tk'},box);
 }
 return catalog(me);
}

export function projectReferences(me,project){return catalog(me,project);}

function catalog(me,fixedProject){
 const root=el('section',{class:fixedProject?'tk-project-refs':'sec tk'});
 const filter=el('select',{'aria-label':t('Druh reference')},el('option',{value:''},t('Všechny druhy')),referenceKinds.map(k=>el('option',{value:k},kindName(k))));
 const q=el('input',{type:'search','aria-label':t('Hledat'),placeholder:t('Hledat')});
 const scope=fixedProject?null:el('select',{'aria-label':t('Rozsah')},[['','Vše'],['global','Globální reference'],['local','Projektové reference']].map(([v,k])=>el('option',{value:v},t(k))));
 const project=fixedProject?null:el('select',{'aria-label':t('Projekt')},el('option',{value:''},t('Všechny projekty')));
 const list=el('div',{class:'acc-card'}),edit=el('div',{});let sequence=0;
 async function draw(offset=0){
  const turn=++sequence,params=new URLSearchParams({offset});
  for(const [key,v] of Object.entries({kind:filter.value,scope:fixedProject?'local':scope.value,project:fixedProject||project.value,q:q.value}))if(v)params.set(key,v);
  try{
   const {items,total}=await referenceApi('?'+params);
   if(sequence!==turn)return;
   const result=items.length?el('table',{class:'ref-table'},
    el('thead',{},el('tr',{},(fixedProject?['Název','Druh reference']:['Název','Druh reference','Rozsah']).map(k=>el('th',{scope:'col'},t(k))))),
    el('tbody',{},items.map(r=>el('tr',{},el('td',{},el('a',{href:r.href},r.label)),el('td',{},kindName(r.kind)),fixedProject?null:el('td',{},scopeName(r)))))):
    emptyState({icon:'box',compact:true,title:t('Žádné odpovídající reference.')});
   list.replaceChildren(result,...[pager(offset,total,draw)].filter(Boolean));
  }catch(e){if(sequence===turn)list.textContent=e.message;}
 }
 for(const input of [filter,scope,project,q].filter(Boolean))input.addEventListener('input',()=>draw());
 if(fixedProject){
  const add=may(me,'tickets:write')?btn(t('Přidat vlastní referenci'),()=>{
   edit.replaceChildren(form({kind:'custom',scope:'local',project:fixedProject},()=>{
    edit.replaceChildren();filter.value='';q.value='';draw();
   }));
   edit.querySelector('input')?.focus();
  }):null;
  root.append(el('div',{class:'tk-toolbar'},el('h2',{},t('Reference projektu')),add),
   el('div',{class:'tk-toolbar'},q,filter),edit,list);
  draw();return root;
 }
 const actions=may(me,'references:write')?['model','custom'].map(kind=>({label:kind==='model'?t('Přidat model'):t('Přidat vlastní referenci'),
  onclick:()=>edit.replaceChildren(form({kind,scope:'global'},r=>{location.hash='#references/'+kind+'/'+r.id;}))})):[];
 root.append(pageHeader({title:t('Reference'),eyebrow:t('Nastavení'),actions}),el('div',{class:'tk-toolbar'},q,filter,scope,project),edit,list);
 referenceApi('?kind=project&limit=100').then(({items})=>project.append(...items.map(r=>el('option',{value:r.id},r.label)))).catch(()=>{});
 draw();return root;
}
