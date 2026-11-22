import {el} from './views.js';
import {t,locale} from './i18n.js';
import {navIcon} from './icons.js';
import {readWikiTree,wikiApi,wikiHref} from './wiki-content.js';

const INDEX_RECHECK_MS=30_000;
const parentOf=(entry,home)=>entry.id===home?null:entry.parentId??home;

function pageTree({home,pages}){
 const entries=new Map(pages.map(entry=>[entry.id,entry]));
 const children=new Map();
 for(const entry of pages){
  if(entry.id===home)continue;
  const parent=parentOf(entry,home);
  if(!children.has(parent))children.set(parent,[]);
  children.get(parent).push(entry);
 }
 for(const siblings of children.values())siblings.sort((a,b)=>a.title.localeCompare(b.title,locale())||a.id.localeCompare(b.id));
 return {entries,children};
}

function routePath(tree,selected,entries=new Map(tree?.pages.map(entry=>[entry.id,entry]))){
 const path=[];
 for(let entry=entries.get(selected);entry&&path.length<entries.size;entry=entries.get(parentOf(entry,tree.home)))path.push(entry.id);
 return path;
}

const visibleSpace=item=>Boolean(item)&&item.enabled!==false&&item.hidden!==true&&item.sidebarHidden!==true&&item.wikiEnabled!==false&&item.settings?.wiki!==false;
const indexSpaces=data=>(Array.isArray(data?.spaces)?data.spaces:Array.isArray(data?.projects)?data.projects:[]).filter(visibleSpace);

export function createWikiNavigation({readIndex=()=>wikiApi('/api/wiki'),readTree=readWikiTree,isRail=()=>false,expandSidebar=()=>{},canWrite=()=>false,now=Date.now}={}){
 let slot,route='',project=null,page=null,globalOpen=false,projects=null,indexRequest=null,reveal=false,scrollTop=0;
 let indexCheckedAt=-Infinity;
 const trees=new Map(),projectsOpen=new Set(),pagesOpen=new Map();
 const writable=()=>Boolean(typeof canWrite==='function'?canWrite():canWrite);
 const caret=()=>el('span',{class:'hh-wiki-caret','aria-hidden':'true'},'›');
 function reset(){
  slot=null;
  route='';
  project=page=projects=indexRequest=null;
  indexCheckedAt=-Infinity;
  globalOpen=reveal=false;
  scrollTop=0;
  trees.clear();
  projectsOpen.clear();
  pagesOpen.clear();
 }
 function loadIndex(force=false){
  if(indexRequest||!force&&now()-indexCheckedAt<INDEX_RECHECK_MS)return;
  indexCheckedAt=now();
  const request={discovered:new Map()};
  indexRequest=request;
  readIndex().then(data=>{
   if(indexRequest!==request)return;
   const listed=indexSpaces(data);
   for(const {id} of listed)request.discovered.delete(id);
   projects=[...listed,...request.discovered.values()];
   paint();
  },()=>{}).finally(()=>{if(indexRequest===request)indexRequest=null;});
 }
 function loadTree(id){
  const entry={};
  trees.set(id,entry);
  readTree(id).then(tree=>{
   if(trees.get(id)!==entry)return;
   if(!tree.enabled)throw new Error();
   entry.tree=tree;
   paint();
  }).catch(()=>{
   if(trees.get(id)!==entry)return;
   entry.error=true;
   paint();
  });
  return entry;
 }
 function invalidate({project:id,index=false}){
  if(id)trees.delete(id);
  if(id&&id===project&&globalOpen&&projectsOpen.has(id))reveal=true;
  if(index){
   indexRequest=null;
   loadIndex(true);
  }
  paint();
 }
 function observe(id,tree,name,options={}){
  if(!tree.enabled)return;
  const previous=trees.get(id)?.tree;
  trees.set(id,{tree});
  const hidden=Boolean(options?.sidebarHidden||tree.sidebarHidden||tree.wikiEnabled===false||tree.projectSettings?.wiki===false);
  if(hidden){
   if(projects?.some(item=>item.id===id))projects=projects.filter(item=>item.id!==id);
   indexRequest?.discovered.delete(id);
   paint();
   return;
  }
  const existing=projects?.find(item=>item.id===id);
  if(existing){
   if(name)existing.name=name;
  }else{
   const item={id,name:name??tree.name??id,home:tree.home,projectId:tree.projectId??null};
   projects=[...(projects??[]),item];
   indexRequest?.discovered.set(id,item);
  }
  if(id===project&&globalOpen&&projectsOpen.has(id)){
   const path=routePath(tree,page||tree.home),before=routePath(previous,page||previous?.home);
   if(path.length!==before.length||path.some((entry,index)=>entry!==before[index]))reveal=true;
  }
  paint();
 }
 function mount(hash){
  const path=hash.split('?')[0];
  if(route!==path){
   route=path;
   const [prefix,id,selected]=path.split('/');
   project=prefix==='#wiki'&&id?id:null;
   page=project?selected:null;
   reveal=Boolean(project);
   if(reveal){
    globalOpen=true;
    projectsOpen.add(project);
   }
  }
  slot=el('div',{class:'hh-wiki-nav',hidden:''});
  loadIndex();
  paint();
  return slot;
 }
 function paint(focused=document.activeElement?.getAttribute?.('data-wiki-focus')){
  if(!slot)return;
  const canCreate=writable();
  slot.hidden=!projects?.length&&!canCreate;
  if(slot.hidden){slot.replaceChildren();return;}
  const focusable=new Map();
  const mark=(key,node)=>{
   node.setAttribute('data-wiki-focus',key);
   focusable.set(key,node);
   return node;
  };
  const button=(key,attrs,...kids)=>mark(key,el('button',{type:'button',...attrs},kids));
  const visible=globalOpen&&!isRail();
  const panel=el('div',{class:'hh-wiki-projects',id:'hh-wiki-projects',hidden:visible?null:''});
  panel.addEventListener('scroll',()=>{if(panel.isConnected&&!panel.hidden)scrollTop=panel.scrollTop;},{passive:true});
  const activeRoute=Boolean(project)||route==='#wiki';
  const opener=button('wiki',{class:'hh-wiki-trigger'+(activeRoute?' on':''),'aria-label':'Wiki',
   'aria-expanded':String(visible),'aria-controls':'hh-wiki-projects',title:'Wiki',onclick:()=>{
    const fromRail=isRail();
    globalOpen=fromRail||!globalOpen;
    if(!globalOpen)reveal=false;
    else loadIndex();
    if(fromRail)expandSidebar();
    paint();
   }},navIcon({hash:'wiki'}),el('span',{class:'hh-nav-label'},'Wiki'),caret());
  let activeLink;
  function projectItem({id,name}){
   const open=projectsOpen.has(id),panelId='hh-wiki-project-'+id;
   const trigger=button('project:'+id,{class:'hh-wiki-branch','aria-expanded':String(open),'aria-controls':panelId,title:name,onclick:()=>{
    if(open){
     projectsOpen.delete(id);
     if(project===id)reveal=false;
    }else projectsOpen.add(id);
    paint();
   }},caret(),el('span',{},name));
   return el('li',{},trigger,el('div',{id:panelId,hidden:open?null:''},open?projectPages(id):null));
  }
  function projectPages(id){
   const result=trees.get(id)??loadTree(id);
   if(result.error)return el('div',{class:'hh-wiki-state'},
    el('span',{role:'status'},t('Stránky wiki se nepodařilo načíst.')),
    button('retry:'+id,{class:'hh-wiki-branch',onclick:()=>{
     trees.delete(id);
     paint('project:'+id);
    }},t('Zkusit znovu')));
   if(!result.tree)return el('div',{class:'hh-wiki-state',role:'status'},t('Načítám…'));
   const {home}=result.tree,{entries,children}=pageTree(result.tree);
   const selected=id===project?(page||home):null;
   if(!pagesOpen.has(id))pagesOpen.set(id,new Set());
   const expanded=pagesOpen.get(id);
   if(reveal&&id===project){
    for(const ancestor of routePath(result.tree,selected,entries).slice(1))expanded.add(ancestor);
   }
   function pageItem(entry,depth){
    const descendants=children.get(entry.id)??[],open=expanded.has(entry.id),key=id+':'+entry.id;
    const branchId='hh-wiki-descendants-'+id+'-'+entry.id;
    const branch=descendants.length?button('branch:'+key,{
     class:'hh-wiki-toggle','aria-expanded':String(open),'aria-controls':branchId,
     'aria-label':t('Podstránky stránky {title}',{title:entry.title}),onclick:()=>{
      if(open)expanded.delete(entry.id);
      else expanded.add(entry.id);
      reveal=false;
      paint();
     }},caret()):null;
    const link=mark('page:'+key,el('a',{class:entry.id===selected?'on':null,
     href:wikiHref(id,entry.id),title:entry.title,'aria-current':entry.id===selected?'page':null},entry.title));
    if(entry.id===selected)activeLink=link;
    return el('li',{},el('div',{class:'hh-wiki-row','data-depth':Math.min(depth,3)},branch,link),
     descendants.length?el('ul',{id:branchId,hidden:open?null:''},open?descendants.map(child=>pageItem(child,depth+1)):null):null);
   }
   const homeEntry=entries.get(home);
   return homeEntry?el('ul',{},pageItem(homeEntry,0)):null;
  }
  if(visible){
   if(projects?.length)panel.append(el('ul',{},[...projects].sort((a,b)=>(a.name||a.id).localeCompare(b.name||b.id,locale())||a.id.localeCompare(b.id)).map(projectItem)));
   if(canCreate)panel.append(el('div',{class:'hh-wiki-foot'},mark('new',el('a',{class:'hh-wiki-new',href:'#wiki?new'},t('+ Nová wiki')))));
  }
  slot.replaceChildren(opener,panel);
  if(slot.isConnected)panel.scrollTop=scrollTop;
  else queueMicrotask(()=>{if(panel.isConnected)panel.scrollTop=scrollTop;});
  if(focused)focusable.get(focused)?.focus({preventScroll:true});
  if(reveal&&activeLink){
   const showActive=()=>{
    if(!activeLink.isConnected)return;
    const target=activeLink.getBoundingClientRect(),bounds=panel.getBoundingClientRect();
    if(target.top<bounds.top)panel.scrollTop+=target.top-bounds.top;
    else if(target.bottom>bounds.bottom)panel.scrollTop+=target.bottom-bounds.bottom;
   };
   if(slot.isConnected)showActive();
   else queueMicrotask(showActive);
   reveal=false;
  }
 }
 return {mount,invalidate,observe,reset,layout:()=>paint(),revalidate:()=>{if(slot)loadIndex();}};
}
