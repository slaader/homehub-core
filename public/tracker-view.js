import {referencesSection,projectReferences} from './references-view.js';
import {referencePicker} from './reference-picker.js';
import {referenceToken,validReference} from './reference-format.js';
import {editableMarkdownRange,markdownReferences} from './tracker-markdown-format.js';
import {reviewDialog} from './review-guidance.js';
// Project Tracker: a development tracker for your own projects.
//   #projects        projects overview: health ring, activity, next release, create a project
//   #projects/<id>   one project's items (and /epics tab) in its saved board or table view
//   #projects/<id>/settings[/look|features|references]   revisioned project settings and deletion
//   #epics/<ID>      one epic: spec, description, progress bar, linked tickets, bulk assign, reviews, comments, history
//   #items           items (tickets) with project chips and quick filters, as a table or a board
//   #items/<ID>      one item, read view first: description with its files under it, comments, history; "Edit"
//                    (or e) swaps the description for the edit form, so every field is on the page once. Files
//                    come in by button, drop or paste (tracker-attach.js); ![name] in a text is a file's chip
//   #releases        releases per project as a timeline with progress, countdown and their items
// Reads need any sign-in; writes need canWrite (the server checks again, API keys need tickets:write).
// Every edit sends the rev it read; a 409 means someone else changed it — reload and redo.
// Text: Czech source strings through t() (English in i18n-en-tracker.js); dates follow the active language and
// the site's time zone. A ticket is called `tk` in this file, because `t` is the translation function.
// Keys on the list pages: / filter, n new item, j / k move, Enter open, v table ↔ board; on an item: c comment, e edit.
import {el,onLeave} from './views.js';
import {onSessionReset,authGuard} from './session-cache.js';
import {markdown} from './tracker-md.js';
import {FILE_MAX,FILES_MAX,fileToken,attachmentName,savedFile,pendingFile,releaseFile,pastedFiles,fileChip,fileStrip,openViewer,chipEditor} from './tracker-attach.js';
import {timeZone} from './site.js';
import {t,tp,locale} from './i18n.js';
import {pageHeader,emptyState,provenanceBadge,banner,toast} from './ui.js';
import {canWriteWiki,notifyWikiNavigation,setupWikiAction,wikiApi,wikiApiPath,wikiHref} from './wiki-content.js';

// Label lists are functions: t() has to run when the page is drawn, in the language active then.
const TYPES=()=>[['bug',t('Chyba'),'crit'],['feature',t('Funkce'),'ok'],['task',t('Úkol'),'']];
const STATUSES=()=>[['open',t('Otevřený'),'warn'],['in-progress',t('Rozpracovaný'),'info'],['done',t('Hotovo'),'ok'],['cancelled',t('Zrušený'),'dim']];
const PROJECT_TYPES=()=>[['web','Web'],['app',t('Aplikace')],['game',t('Hra')],['other',t('Jiné')]];
const PRIORITIES=()=>[['urgent',t('Urgentní'),'crit'],['high',t('Vysoká'),'warn'],['normal',t('Normální'),''],['low',t('Nízká'),'dim']];
const EPIC_ID=/^[A-Z][A-Z0-9]{1,9}-E[1-9][0-9]{0,5}$/;
const LABEL_RE=/^[a-z0-9][a-z0-9-]{0,29}$/;
const SPEC_MAX_BYTES=65536;
const utf8Bytes=s=>new TextEncoder().encode(String(s??'')).length;
const makeReferenceToken=record=>record.kind==='epic'&&!validReference('epic',record.id)
 ?'@['+record.label.replace(/[\\\[\]]/g,'\\$&')+'](ref:epic/'+record.id+')':referenceToken(record);
const savedEpicFile=(epicId,a)=>{const url=`/api/tickets/epics/${encodeURIComponent(epicId)}/attachments/${a.id}`;return {...a,url,download:url+'?download=1'};};
function parseLabels(raw){
 const list=[...new Set(splitList(String(raw||'')).map(v=>v.toLowerCase()))];
 if(list.length>10)throw new Error(t('Projekt může mít nejvýš 10 štítků.'));
 const bad=list.find(v=>!LABEL_RE.test(v));
 if(bad)throw new Error(t('Neplatný štítek „{label}“. Použij malá písmena, číslice a pomlčky.',{label:bad}));
 return list;
}
const TONE={open:'warn','in-progress':'info',done:'ok',cancelled:'dim'};
const label=(list,v)=>list.find(x=>x[0]===v)?.[1]||v;
const pill=(list,v)=>{const x=list.find(y=>y[0]===v);return el('span',{class:`sec-pill tk-pill ${x?.[2]||''}`},x?.[1]||v);};
const validTime=iso=>Boolean(iso)&&Number.isFinite(Date.parse(iso));
const when=iso=>validTime(iso)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'—';
const dayOf=iso=>validTime(iso)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',timeZone:timeZone()}).format(new Date(iso)):'—';
// A calendar day (YYYY-MM-DD) has no time zone: it is formatted as that day, wherever the reader is.
const dayText=d=>d?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T00:00:00Z')):'—';
const TYPE_GLYPH={bug:'🐞',feature:'✦',task:'⚙'};
const glyph=type=>el('span',{class:`tk-glyph ${type}`,role:'img',title:label(TYPES(),type),'aria-label':label(TYPES(),type)},TYPE_GLYPH[type]||'•');
const PRIO_ORDER={urgent:0,high:1,normal:2,low:3};
const ACTIVE=['open','in-progress'],CLOSED=['done','cancelled'];
const initials=s=>s?s.split(/[\s._@-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''):'';
// Calendar day in the site's time zone as YYYY-MM-DD, so "today" and the activity bars follow local midnight.
const dayKey=d=>new Intl.DateTimeFormat('en-CA',{timeZone:timeZone(),year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const relative=(n,unit,style='short')=>new Intl.RelativeTimeFormat(locale(),{numeric:'auto',style}).format(n,unit);
function ago(iso){
 const m=Math.round((Date.parse(iso)-Date.now())/60000);if(!Number.isFinite(m))return '—';
 if(m>-1)return t('právě teď');if(m>-60)return relative(m,'minute');
 const h=Math.round(m/60);if(h>-24)return relative(h,'hour');
 const d=Math.round(h/24);return d>-30?relative(d,'day'):dayOf(iso);
}
const statusCounts=tickets=>Object.fromEntries(STATUSES().map(([s])=>[s,tickets.filter(x=>x.status===s).length]));
const activeBugs=tickets=>tickets.filter(x=>x.type==='bug'&&ACTIVE.includes(x.status)).length;
// The next release is the planned one with the nearest target date; undated ones come after, by version.
const plannedOrder=(a,b)=>(a.targetDate||'9999')<(b.targetDate||'9999')?-1:(a.targetDate||'9999')>(b.targetDate||'9999')?1:a.version.localeCompare(b.version,'en',{numeric:true,sensitivity:'base'});
const nextRelease=(releases,project)=>releases.filter(r=>r.project===project&&r.status==='planned').sort(plannedOrder)[0];
function due(r){
 if(r.status!=='planned'||!r.targetDate)return null;
 const days=Math.round((Date.parse(r.targetDate+'T00:00:00Z')-Date.parse(dayKey(new Date())+'T00:00:00Z'))/864e5),left=r.counts.open+r.counts['in-progress'];
 const text=days>=0?relative(days,'day','long'):tp(-days,'{n} den po termínu|{n} dny po termínu|{n} dní po termínu');
 return {days,text,tone:left&&days<0?'crit':left&&days<=3?'warn':''};
}
// Release progress: done and in-progress shares of everything that is not cancelled, with the percentage done.
function progressBar(counts,scope){
 const done=counts.done||0,doing=counts['in-progress']||0,pct=scope?Math.round(done/scope*100):0;
 const a=el('span',{class:'done'}),b=el('span',{class:'doing'});a.style.width=(scope?done/scope*100:0)+'%';b.style.width=(scope?doing/scope*100:0)+'%';
 return el('div',{class:'tk-progress'},el('div',{class:'tk-bar',role:'progressbar','aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(pct),'aria-label':t('Hotovo {pct} %',{pct})},a,b),el('span',{class:'tk-progress-pct'},pct+' %'));
}
const options=(list,value,empty)=>[...(empty?[el('option',{value:''},empty)]:[]),...list.map(([v,text])=>{const o=el('option',{value:v},text);if(v===value)o.selected=true;return o;})];

async function api(url,body,{maxBytes=16384}={}){
 if(body!==undefined&&utf8Bytes(JSON.stringify(body))>maxBytes)throw new Error(maxBytes>16384?t('Požadavek překročil maximální povolenou velikost.'):t('Požadavek je příliš dlouhý (maximum 16 kB). Zkrať text nebo odešli změny po částech.'));
 const lost=authGuard(),r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const data=await r.json().catch(()=>({}));
 // The server's messages are Czech source text too; t() translates the ones the dictionary knows.
 if(!r.ok){const e=new Error(data.error?.message?t(data.error.message):t('Požadavek selhal.'));e.status=r.status;e.data=data;throw e;}
 return data;
}
// Filters survive navigation between list and detail within one page load.
const defaults={project:'',status:'active',type:'',priority:'',release:'',epic:'',assignee:'',label:'',q:''},filters={...defaults};
const projectFilters=new Map(),releaseFilters={project:''},projectsListFilters={type:'',label:''},epicListFilters=new Map();
// notices: what is left to say on an item's page the next time it is shown (files that did not upload), by item id.
const prefs={view:'table',focusComment:false,notices:new Map()};
const leaveNotice=(id,text)=>prefs.notices.set(id,[prefs.notices.get(id),text].filter(Boolean).join(' '));
try{if(globalThis.localStorage?.getItem('tk-view')==='board')prefs.view='board';}catch{}
let sessionEpoch=0;const draws=new WeakMap(),dialogs=new Set();
onSessionReset(()=>{sessionEpoch++;projectFilters.clear();releaseFilters.project='';projectsListFilters.type='';projectsListFilters.label='';epicListFilters.clear();Object.assign(filters,defaults);prefs.focusComment=false;prefs.notices.clear();sendings.clear();for(const d of dialogs)d.close();});
// Only the latest load for this view and sign-in may replace its contents.
async function load(wrap,request){
 const epoch=sessionEpoch,n=(draws.get(wrap)||0)+1;draws.set(wrap,n);
 const current=()=>epoch===sessionEpoch&&draws.get(wrap)===n;
 try{const data=await request;return current()?data:null;}catch(e){if(current())throw e;return null;}
}
function showDialog(dialog,onClose){
 dialogs.add(dialog);dialog.addEventListener('close',()=>{dialogs.delete(dialog);dialog.remove();onClose?.();});
 document.body.append(dialog);dialog.showModal();
}
const status=()=>el('p',{class:'acc-status',role:'status'});
// replaceChildren() would print a null child as the text "null"; optional parts are skipped instead.
const show=(wrap,...nodes)=>wrap.replaceChildren(...nodes.flat().filter(n=>n!=null&&n!==false));
const fail=(node,e)=>{node.textContent=e.message;node.classList.add('error');};
// provenance: where the page's data comes from (the `provenance` of the tickets answer), shown next to the title.
const head=(title,lead,actions,provenance)=>pageHeader({eyebrow:'Project Tracker',title,lead,actions:(actions||[]).filter(Boolean),provenance});

// Keyboard shortcuts of one page: plain keys, never while typing or with a dialog open. A handler returns
// false to let the key through. The listener goes away with the page (onLeave) or when its view is replaced.
const keyHandlers=new WeakMap();
const typing=node=>Boolean(node)&&(['INPUT','TEXTAREA','SELECT'].includes(node.tagName)||node.isContentEditable===true);
function shortcuts(wrap,handlers){
 if(typeof addEventListener!=='function')return;
 const old=keyHandlers.get(wrap);if(old)removeEventListener('keydown',old);
 const onKey=e=>{
  if(!wrap.isConnected){removeEventListener('keydown',onKey);return;}
  if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||typing(document.activeElement)||document.querySelector('dialog[open]'))return;
  const run=handlers[e.key];if(run&&run(e)!==false)e.preventDefault();
 };
 keyHandlers.set(wrap,onKey);addEventListener('keydown',onKey);onLeave(()=>removeEventListener('keydown',onKey));
}
// j / k walk the rows or cards in page order; the marked one opens with Enter.
function moveCursor(wrap,step){
 const items=[...wrap.querySelectorAll('.tk-row,.tk-card')];if(!items.length)return;
 // A button or link that still has the focus would take the next Enter; the cursor takes it instead.
 if(document.activeElement?.closest?.('a,button'))document.activeElement.blur();
 let i=items.findIndex(n=>n.classList.contains('tk-cursor'));items[i]?.classList.remove('tk-cursor');
 i=i<0?(step>0?0:items.length-1):Math.max(0,Math.min(items.length-1,i+step));
 items[i].classList.add('tk-cursor');items[i].scrollIntoView?.({block:'nearest'});
}
function openCursor(wrap){
 if(document.activeElement?.closest?.('a,button'))return false;
 const id=wrap.querySelector('.tk-cursor')?.dataset?.id;if(!id)return false;location.hash='#items/'+id;
}
const keysHint=(...keys)=>el('p',{class:'tk-keys','aria-label':t('Klávesové zkratky')},keys.flatMap(([key,text])=>[el('kbd',{},key),el('span',{},text)]));

export const TRACKER_PAGES=Object.freeze(['projects','items','releases','epics']);
export function trackerView(me,page,sub){
 const wrap=el('section',{class:'sec tk'},el('p',{class:'sec-dim',role:'status'},t('Načítám…')));
 const ctx={me,canWrite:me?.canWrite===true&&(!me.scopes||me.scopes.includes('tickets:write')),canWriteWiki:canWriteWiki(me),user:typeof me?.username==='string'?me.username:'',id:sub};
 const draw=page==='projects'?(sub?projectPage:projectsPage):page==='releases'?releasesPage:page==='epics'?(sub?epicPage:projectsPage):sub?ticketPage:listPage;
 // A failed load says what failed and offers the way out: try again, or back to the list.
 const run=()=>draw(wrap,ctx).catch(e=>show(wrap,emptyState({icon:'⚠',
  title:e.status===404?(page==='projects'?t('Projekt neexistuje'):page==='epics'?t('Epic neexistuje'):t('Položka neexistuje')):t('Project Tracker nejde načíst'),body:e.message,
  actions:[e.status===404?null:{label:t('Zkusit znovu'),primary:true,onclick:()=>{show(wrap,el('p',{class:'sec-dim',role:'status'},t('Načítám…')));run();}},
   page==='projects'||page==='epics'?{label:`← ${t('Projekty')}`,href:'#projects'}:{label:`← ${t('Položky')}`,href:'#items'}]})));
 run();
 return wrap;
}

// A tracker without a project: how to start, by hand or by handing the job to a coding agent.
function noProjects({canWrite},redraw){
 return emptyState({icon:'◆',title:t('Zatím tu není žádný projekt'),
  body:t('Project Tracker drží projekty, jejich releasy a položky: chyby, funkce a úkoly. Každý projekt má zkratku, kterou ponesou čísla jeho položek, například APP-1.'),
  steps:[canWrite?t('Založ projekt tlačítkem „+ Nový projekt“: název, id a zkratka.'):t('Požádej správce o účet s právem zápisu, nebo nech projekt založit agenta.'),
   t('Přidej první položky a případně release, do kterého patří.'),
   t('Agenti pracují se stejnými daty přes MCP: servisní účet potřebuje scope tickets:write (Uživatelé a API → Servisní účty).')],
  agentPrompt:t('Připoj se k mému Home Hubu přes MCP (příkaz níže; servisní účet potřebuje scope tickets:write). Nástrojem project_save založ pro tento repozitář projekt: krátké id malými písmeny, zkratku ze 2–5 velkých písmen, název, jednořádkový popis a typ app, game nebo other. Potom nástrojem ticket_create založ první položky (project, title, description s kritérii přijetí, type bug|feature|task, priority). Nakonec je vypiš přes tickets_list a napiš mi jejich id.'),
  mcpSnippet:true,
  actions:canWrite?[{label:t('+ Nový projekt'),primary:true,onclick:()=>newProject(redraw)}]:[]});
}
function projectChips(projects,onPick,state=filters){
 return el('div',{class:'sys-chips tk-chips'},[['',t('Všechny projekty')],...projects.map(p=>[p.id,p.name,p.settings?.color])].map(([id,name,color])=>
  el('button',{type:'button',class:`sys-chip${state.project===id?' on':''}`,'aria-pressed':String(state.project===id),'data-project-color':color,'aria-label':id?t('Projekt {name}',{name}):name,onclick:()=>{state.project=id;if('release'in state)state.release='';if('epic'in state)state.epic='';onPick();}},
   color?el('span',{class:'dot','aria-hidden':'true'}):null,name)));
}

// List ------------------------------------------------------------------------------------------
async function listPage(wrap,ctx,project=null,initial=null){
 const {canWrite,user}=ctx;
 const local=project?projectFilters.get(project.id):filters,board=project?project.settings?.view!=='table':prefs.view==='board';
 if(project?.settings?.releases===false)local.release='';
 const picked={...local,...(board?{status:''}:{})},query=new URLSearchParams(Object.entries(picked).filter(([,v])=>v));
 const result=await load(wrap,Promise.all([api('/api/tickets?'+query),initial??api('/api/tickets'+(picked.project?'?project='+encodeURIComponent(picked.project):''))]));if(!result)return;
 const [data,all]=result;
 const redraw=()=>listPage(wrap,ctx,project).catch(e=>fail(msg,e)),msg=status();
 const add=canWrite&&data.projects.length?{label:t('+ Nová položka'),primary:true,onclick:()=>newTicket(data.projects,project?.id,project?{...ctx,lockProject:true}:ctx)}:null;
 const title=project?null:head(t('Položky'),t('Chyby, funkce a úkoly všech projektů. Filtry zůstávají, dokud stránku neopustíš.'),[add],all.provenance);
 if(!data.projects.length)return show(wrap,title,noProjects(ctx,redraw));
 const count=s=>all.tickets.filter(x=>s.includes(x.status)).length,bugs=activeBugs(all.tickets);
 const setView=v=>{if(prefs.view===v)return;prefs.view=v;try{globalThis.localStorage?.setItem('tk-view',v);}catch{}redraw();};
 // The numbers double as quick filters: one click narrows the table to that status.
 const stat=(k,v,s,tone,change)=>el('button',{type:'button',class:`sec-stat tk-stat ${tone}`,title:t('Zobrazit jen tyto položky'),onclick:()=>{
   Object.assign(local,{type:'',priority:''},change);
   if(!project&&prefs.view!=='table'){prefs.view='table';try{globalThis.localStorage?.setItem('tk-view','table');}catch{}}
   redraw();
  }},
  el('div',{class:'k'},k),el('div',{class:'v'},String(v)),el('div',{class:'s'},s));
 const select=(key,list,empty)=>el('select',{class:local[key]?'on':'','aria-label':empty,onchange:e=>{local[key]=e.target.value;redraw();}},options(list,local[key],empty));
 const showReleases=project?.settings?.releases!==false;
 const releaseColumn=showReleases||all.tickets.some(t=>t.release);
 const releases=[...new Set(data.releases.map(r=>r.version))].map(v=>[v,v]);
 const knownEpics=Array.isArray(ctx.epics)?ctx.epics:Array.isArray(data.epics)?data.epics:Array.isArray(all.epics)?all.epics:[];
 const epicMap=new Map(knownEpics.map(e=>[e.id,e]));
 const epicIds=[...new Set([...knownEpics.map(e=>e.id),...all.tickets.map(x=>x.epic).filter(Boolean),...(local.epic&&local.epic!=='none'?[local.epic]:[])])];
 const epicChoices=epicIds.map(eid=>[eid,epicMap.get(eid)?`${eid} · ${epicMap.get(eid).title}`:eid]);
 const showEpicFilter=Boolean(project||epicChoices.length||local.epic);
 const names=[...new Set([user,...all.tickets.map(x=>x.assignee)].filter(Boolean))],labels=[...new Set(all.tickets.flatMap(x=>x.labels||[]))].sort();
 let debounce;
 const search=el('input',{type:'search',maxlength:'100','data-slash':'',placeholder:t('Hledat (id, název, popis, štítek)'),value:local.q,'aria-label':t('Hledat'),'aria-keyshortcuts':'/',oninput:e=>{local.q=e.target.value.trim();clearTimeout(debounce);debounce=setTimeout(()=>{if(search.isConnected)redraw();},300);}});
 const narrowed=['type','priority','release','epic','assignee','label','q'].some(k=>local[k])||(!board&&local.status!==defaults.status);
 const clear=narrowed?el('button',{type:'button',class:'acc-btn small tk-clear',onclick:()=>{Object.assign(local,defaults,{project:local.project});redraw();}},t('Zrušit filtry')):null;
 const rows=data.tickets.map(tk=>el('tr',{class:`tk-row prio-${tk.priority}${CLOSED.includes(tk.status)?' tk-closed':''}`,'data-id':tk.id,onclick:()=>{location.hash='#items/'+tk.id;}},
  el('td',{class:'tk-id'},el('a',{href:'#items/'+tk.id},tk.id)),
  el('td',{},el('div',{class:'tk-name'},glyph(tk.type),' ',tk.title),
   tk.epic||tk.labels?.length?el('div',{class:'tk-labels'},
    tk.epic?el('a',{class:'tk-chip',href:'#epics/'+tk.epic,onclick:e=>e.stopPropagation()},tk.epic):null,
    (tk.labels||[]).map(l=>el('span',{class:'tk-label'},l))):null),
  el('td',{},pill(PRIORITIES(),tk.priority)),el('td',{},canWrite?statusSelect(tk,msg,ctx.afterMove??redraw):pill(STATUSES(),tk.status)),
  releaseColumn?el('td',{class:'tk-mono'},tk.release||'—'):null,el('td',{class:'tk-mono'},tk.assignee||'—'),
  el('td',{class:'tk-mono',title:t('Komentáře a přílohy')},[tk.comments?`💬 ${tk.comments}`:'',tk.attachments?`📎 ${tk.attachments}`:''].filter(Boolean).join(' ')),el('td',{class:'tk-mono tk-dim',title:when(tk.updatedAt)},ago(tk.updatedAt)),
  el('td',{class:'tk-actions'},canWrite?quickActions(tk,msg,ctx.afterMove??redraw):null)));
 const viewToggle=project?null:el('div',{class:'tk-view',role:'group','aria-label':t('Zobrazení')},[['table',`☰ ${t('Tabulka')}`],['board',`▦ ${t('Nástěnka')}`]].map(([v,text])=>
  el('button',{type:'button',class:prefs.view===v?'on':'','aria-pressed':String(prefs.view===v),onclick:()=>setView(v)},text)));
 const focused=document.activeElement,focusLabel=wrap.contains(focused)?focused.getAttribute('aria-label'):null,caret=focused?.selectionStart;
 const nothing=()=>all.total
  ?el('div',{class:'tk-none'},el('h2',{},t('Filtrům nic neodpovídá')),el('p',{class:'sec-dim'},t('Zkus ubrat filtr nebo hledat jinými slovy.')),clear?el('button',{type:'button',class:'acc-btn',onclick:()=>{Object.assign(local,defaults,{project:local.project});redraw();}},t('Zrušit filtry')):null)
  :emptyState({icon:'✦',title:t('Zatím žádné položky'),body:t('Položka je chyba, funkce nebo úkol. Má stav, prioritu, řešitele, štítky a může patřit do releasu.'),
    agentPrompt:t('Přes MCP mého Home Hubu (scope tickets:write) založ nástrojem ticket_create položky pro práci, kterou v tomto repozitáři vidíš: project podle tickets_list → projects, title, description s kritérii přijetí, type bug|feature|task a priority. Než začneš na některé pracovat, nastav jí přes ticket_update stav in-progress a sebe jako assignee; po dokončení přidej ticket_comment s tím, co se změnilo.'),
    actions:[add].filter(Boolean)});
 show(wrap,title,project?null:el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},projectChips(data.projects,redraw)),viewToggle),
  project&&board?null:el('div',{class:'sec-stats tk-stats'},stat(t('Otevřené'),count(['open']),t('čeká na práci'),'warn',{status:'open'}),stat(t('Rozpracované'),count(['in-progress']),t('právě se dělá'),'',{status:'in-progress'}),stat(t('Hotové'),count(['done']),t('uzavřeno'),'',{status:'done'}),
   stat(t('Aktivní chyby'),bugs,t('otevřené + rozpracované'),bugs?'crit':'',{status:'active',type:'bug'}),showReleases?el('div',{class:'sec-stat'},el('div',{class:'k'},t('Releasy')),el('div',{class:'v'},String(data.releases.filter(r=>r.status==='planned').length)),el('div',{class:'s'},t('naplánované'))):null),
  el('div',{class:'tk-filters'},
   board?null:select('status',[['active',t('Aktivní (otevřené + rozpracované)')],...STATUSES()],t('Všechny stavy')),select('type',TYPES(),t('Všechny typy')),
   select('priority',PRIORITIES(),t('Všechny priority')),showReleases?select('release',[['none',t('Bez releasu')],...releases],t('Všechny releasy')):null,
   showEpicFilter?select('epic',[['none',t('Bez epicu')],...epicChoices],t('Všechny epicy')):null,
   select('assignee',[['none',t('Nepřiřazené')],...names.map(n=>[n,n===user?t('{name} (já)',{name:n}):n])],t('Všichni řešitelé')),
   labels.length||local.label?select('label',[...new Set([...labels,local.label].filter(Boolean))].map(l=>[l,'#'+l]),t('Všechny štítky')):null,search,clear),
  msg,
  board&&all.total?boardView(data.tickets,{canWrite,msg,redraw:ctx.afterMove??redraw,projects:data.projects,showProject:!picked.project}):
  data.tickets.length?el('div',{class:'sec-scroll'},el('table',{class:'sec-table tk-table'},
   el('thead',{},el('tr',{},['ID',t('Název položky'),t('Priorita'),t('Stav'),...(releaseColumn?['Release']:[]),t('Řeší'),'',t('Změněno'),''].map(h=>el('th',{scope:'col'},h)))),el('tbody',{},rows)))
   :nothing(),
  all.total?keysHint(['/',t('hledat')],['n',t('nová položka')],['j k',t('další / předchozí')],['Enter',t('otevřít')],...(project?[]:[['v',t('tabulka / nástěnka')]])):null);
 shortcuts(wrap,{n:()=>add?void add.onclick():false,v:()=>project?false:setView(prefs.view==='board'?'table':'board'),j:()=>moveCursor(wrap,1),k:()=>moveCursor(wrap,-1),Enter:()=>openCursor(wrap)});
 if(focusLabel){const control=[...wrap.querySelectorAll('[aria-label]')].find(n=>n.getAttribute('aria-label')===focusLabel);control?.focus();if(control===search)search.setSelectionRange(caret??search.value.length,caret??search.value.length);}
}

// Status moves, shared by the table rows and the board cards: a select in the row, one-click buttons, drag and drop.
const NEXT=()=>({open:[['in-progress','▶',t('Začít')],['done','✓',t('Hotovo')]],'in-progress':[['done','✓',t('Hotovo')]]});
async function setStatus(tk,next,control,msg,redraw){
 const hadFocus=Boolean(control)&&document.activeElement===control,epoch=sessionEpoch;
 if(control)control.disabled=true;
 try{await api('/api/tickets/update',{id:tk.id,rev:tk.rev,status:next});}
 catch(e){
  if(epoch===sessionEpoch){
   fail(msg,e);
   if(control){
    control.disabled=false;
    if('value'in control&&control.tagName==='SELECT')control.value=tk.status;
    if(hadFocus&&document.activeElement===document.body)control.focus();
   }
  }
  return;
 }
 if(epoch===sessionEpoch)await redraw(hadFocus?control:null);
}
function statusSelect(tk,msg,redraw){
 const stop=e=>e.stopPropagation();
 const select=el('select',{class:`tk-status ${TONE[tk.status]||''}`,'aria-label':t('Stav položky {id}',{id:tk.id}),onclick:stop,onkeydown:stop,onchange:e=>{e.stopPropagation();setStatus(tk,e.target.value,select,msg,redraw);}},options(STATUSES(),tk.status));
 return select;
}
function quickActions(tk,msg,redraw){
 const stop=fn=>e=>{e.stopPropagation();fn(e);};
 return el('div',{class:'tk-quickrow'},...(NEXT()[tk.status]||[]).map(([next,icon,text])=>
   el('button',{type:'button',class:`tk-qa${next==='done'?' ok':''}`,title:text,'aria-label':`${text}: ${tk.id}`,onclick:stop(e=>setStatus(tk,next,e.currentTarget,msg,redraw))},icon)),
  el('button',{type:'button',class:'tk-qa',title:t('Komentovat'),'aria-label':`${t('Komentovat')}: ${tk.id}`,onclick:stop(()=>{prefs.focusComment=true;location.hash='#items/'+tk.id;})},'💬'));
}
// Board: open → in progress → done (the latest few), cancelled stays out. A writer can drag a card to another column.
const DONE_SHOWN=8,drag={ticket:null};
function boardView(tickets,ctx){
 const cols=[['open',t('Otevřené'),'warn'],['in-progress',t('Rozpracované'),'info'],['done',t('Hotové'),'ok']];
 return el('div',{class:'tk-board'},cols.map(([s,name,tone])=>{
  const all=tickets.filter(x=>x.status===s);
  const list=s==='done'?[...all].sort((a,b)=>(b.closedAt||b.updatedAt).localeCompare(a.closedAt||a.updatedAt)).slice(0,DONE_SHOWN)
   :[...all].sort((a,b)=>PRIO_ORDER[a.priority]-PRIO_ORDER[b.priority]||b.updatedAt.localeCompare(a.updatedAt));
  const col=el('section',{class:`tk-col ${tone}`,'aria-label':name,
    ondragover:e=>{if(!drag.ticket||drag.ticket.status===s)return;e.preventDefault();col.classList.add('tk-drop');},ondragleave:()=>col.classList.remove('tk-drop'),
    ondrop:e=>{e.preventDefault();col.classList.remove('tk-drop');const tk=drag.ticket;drag.ticket=null;if(tk&&tk.status!==s)setStatus(tk,s,null,ctx.msg,ctx.redraw);}},
   el('h3',{class:'tk-col-head'},el('span',{class:'tk-dot'}),name,el('span',{class:'tk-count'},String(all.length))),
   list.length?list.map(tk=>boardCard(tk,ctx)):el('p',{class:'tk-col-empty'},s==='in-progress'?t('Nikdo na ničem nedělá.'):s==='done'?t('Zatím nic hotového.'):t('Nic nečeká. 🎉')),
   all.length>list.length?el('p',{class:'tk-col-more'},tp(all.length-list.length,'+ {n} starší|+ {n} starší|+ {n} starších')):null);
  return col;
 }));
}
function boardCard(tk,{canWrite,msg,redraw,projects,showProject}){
 const project=showProject?projects.find(p=>p.id===tk.project):null;
 return el('article',{class:`tk-card prio-${tk.priority}`,'data-id':tk.id,draggable:canWrite?'true':null,onclick:()=>{location.hash='#items/'+tk.id;},
   ondragstart:e=>{if(!canWrite)return;drag.ticket=tk;try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',tk.id);}catch{}},ondragend:()=>{drag.ticket=null;}},
  el('div',{class:'tk-card-top'},glyph(tk.type),el('a',{href:'#items/'+tk.id,class:'tk-card-id'},tk.id),project?el('span',{class:'tk-dim tk-mono'},project.key):null,
   ['urgent','high'].includes(tk.priority)?pill(PRIORITIES(),tk.priority):null,
   tk.assignee?el('span',{class:'tk-avatar',title:tk.assignee,'aria-label':t('Řeší {name}',{name:tk.assignee})},initials(tk.assignee)):null),
  el('div',{class:'tk-card-title'},tk.title),
  tk.labels?.length?el('div',{class:'tk-labels'},tk.labels.map(l=>el('span',{class:'tk-label'},l))):null,
  el('div',{class:'tk-card-foot'},tk.epic?el('a',{class:'tk-chip',href:'#epics/'+tk.epic,onclick:e=>e.stopPropagation()},tk.epic):null,tk.release?el('span',{class:'tk-chip'},tk.release):null,tk.comments?el('span',{class:'tk-dim tk-mono'},`💬 ${tk.comments}`):null,tk.attachments?el('span',{class:'tk-dim tk-mono'},`📎 ${tk.attachments}`):null,
   el('span',{class:'tk-dim tk-mono',title:when(tk.updatedAt)},ago(tk.updatedAt)),canWrite&&!CLOSED.includes(tk.status)?quickActions(tk,msg,redraw):null));
}

// Markdown text with a preview: the textarea stays the field; "Náhled" swaps it for the rendered text.
// With `files` ({resolve(name) → file | null, onOpen(file), label}) the field shows the ![name] of the ticket's
// files as chips while it is edited, and so does the preview (tracker-attach.js → chipEditor).
const chipsOf=files=>files?name=>{const item=files.resolve(name);return item?fileChip(item,{onOpen:files.onOpen}):null;}:null;
function mdEditor(area,keys,files=null){
 const editor=files?chipEditor(area,files):null,field=editor?.node||area;
 const picker=files?.project&&files.canReference?referencePicker(field,{project:files.project,canGlobal:files.canGlobal,context:()=>{
  const range=editor?.rich?editor.selection():{start:area.selectionStart,end:area.selectionEnd};
  if(!range||!Number.isInteger(range.start))return null;
  const {start,end}=range,value=area.value;
  const selection={selected:value.slice(start,end),before:value.slice(0,start),position:start,trim:0,
   replace(record){
    const from=start-selection.trim,piece=makeReferenceToken(record)+' ';
    const maxLen=Number(area.getAttribute('maxlength'))||Infinity;
    const nextValue=value.slice(0,from)+piece+value.slice(end);
    if(area.value!==value||nextValue.length>maxLen||(files.maxBytes&&utf8Bytes(nextValue)>files.maxBytes))return;
    if(editor?.rich){editor.replace(from,end,piece);field.focus();}
    else {area.setRangeText(piece,from,end,'end');area.focus();area.dispatchEvent(new Event('input',{bubbles:true}));}
   }};
  if(selection.selected.includes('\n'))return null;
  selection.fits=record=>{
   const piece=makeReferenceToken(record)+' ';
   const maxLen=Number(area.getAttribute('maxlength'))||Infinity;
   const nextValue=value.slice(0,start-selection.trim)+piece+value.slice(end);
   return nextValue.length<=maxLen&&(!files.maxBytes||utf8Bytes(nextValue)<=files.maxBytes);
  };
  selection.accepts=trim=>editableMarkdownRange(value,start-trim,end,{keys,files:files.resolve});
  return selection;
 }}):null;
 const preview=el('div',{class:'tk-md-preview',hidden:''}),toggle=el('button',{type:'button',class:'tk-md-toggle','aria-pressed':'false',onclick:()=>{
   const on=toggle.getAttribute('aria-pressed')!=='true';
   // An empty field stays editable: there is nothing to preview, and a hidden required field cannot be submitted.
   if(on&&!area.value.trim()){field.focus();return;}
   toggle.setAttribute('aria-pressed',String(on));toggle.textContent=on?t('Upravit text'):t('Náhled');
   if(on)preview.replaceChildren(markdown(area.value,{keys,files:chipsOf(files),references:true}));
   preview.hidden=!on;field.hidden=on;if(!on)field.focus();}},t('Náhled'));
 // redraw(): the preview again, when what its chips stand for has changed while it is shown.
 const redraw=()=>{if(toggle.getAttribute('aria-pressed')==='true')preview.replaceChildren(markdown(area.value,{keys,files:chipsOf(files),references:true}));};
 return {node:el('div',{class:'tk-md-edit ref-editor'},area,field===area?null:field,picker,preview),toggle,editor,redraw};
}
const mdHint=toggle=>el('div',{class:'tk-md-hint'},el('span',{},t('Formátování: **tučně**, `kód`, - seznam, 1. kroky, APP-12 = odkaz')),toggle||null);
const splitList=v=>v.split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
// Who can be assigned: hub accounts, service accounts and names already on tickets. A failed read just means no suggestions.
const peopleNames=data=>Array.isArray(data?.people)?data.people.map(p=>p?.name).filter(n=>typeof n==='string'&&n):[];
let listSeq=0;
function assigneeInput(value,people,user){
 const id='tk-people-'+(++listSeq),names=[...new Set([user,...people].filter(Boolean))];
 const input=el('input',{name:'assignee',maxlength:'60',list:id,autocomplete:'off',value:value||'',placeholder:names.length?t('Vyber nebo napiš jméno'):t('Jméno řešitele')});
 return {input,list:el('datalist',{id},names.map(n=>el('option',{value:n}))),
  mine:user&&value!==user?el('button',{type:'button',class:'tk-inline-btn',onclick:()=>{input.value=user;input.focus();}},t('Přiřadit mně')):null};
}

// Files: what is wrong with one before it is sent (the server checks again), the upload itself, a place to drop them.
const fileProblem=(file,count)=>count>=FILES_MAX?t('Položka může mít nejvýš {n} příloh.',{n:FILES_MAX})
 :file.size>FILE_MAX?t('{name}: soubor je větší než 100 MB.',{name:file.name||t('soubor')}):!file.size?t('{name}: soubor je prázdný.',{name:file.name||t('soubor')}):'';
async function uploadFile(id,name,file,endpoint=`/api/tickets/${encodeURIComponent(id)}/attachments`){
 const lost=authGuard(),r=await fetch(`${endpoint}?name=${encodeURIComponent(name)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file});lost(r);
 const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error?.message?t(data.error.message):t('Nahrání se nepovedlo.'));return data;
}
// Only a drag of files counts: text, and the cards of the board, pass through. onFiles(files, event).
function dropTarget(node,onFiles){
 const files=e=>[...(e.dataTransfer?.types||[])].includes('Files');
 node.addEventListener('dragover',e=>{if(!files(e))return;e.preventDefault();node.classList.add('tk-drop');});
 node.addEventListener('dragleave',e=>{if(!e.relatedTarget||!node.contains(e.relatedTarget))node.classList.remove('tk-drop');});
 node.addEventListener('drop',e=>{node.classList.remove('tk-drop');if(!files(e))return;e.preventDefault();onFiles([...e.dataTransfer.files],e);});
 return node;
}
const attachHint=()=>el('p',{class:'tk-attach-hint'},t('Vlož ze schránky (Cmd/Ctrl+V), přetáhni sem soubory nebo použij tlačítko. Nejvýš 100 MB na soubor.'));

// New ticket dialog ------------------------------------------------------------------------------
async function newTicket(projects,preset,ctx={}){
 const epoch=sessionEpoch;
 const releaseQuery=new URLSearchParams({limit:1,...(ctx.lockProject?{project:preset}:{})});
 const [releasesData,peopleData,epicsData]=await Promise.all([
  api('/api/tickets?'+releaseQuery).catch(()=>({releases:[]})),
  api('/api/tickets/people').catch(()=>null),
  Array.isArray(ctx.epics)?{epics:ctx.epics}:api('/api/tickets/epics'+(ctx.lockProject&&preset?'?project='+encodeURIComponent(preset):'')).catch(()=>({epics:[]})),
 ]);
 if(epoch!==sessionEpoch)return;
 const allEpics=Array.isArray(epicsData?.epics)?epicsData.epics:[];
 const msg=status(),field=(text,...input)=>el('label',{},text,...input),keys=projects.map(p=>p.key);
 const choices=ctx.lockProject?projects.filter(p=>p.id===preset):projects;
 const project=el('select',{name:'project'},options(choices.map(p=>[p.id,p.name]),preset||filters.project||projects[0]?.id));
 const release=el('select',{name:'release'});
 const releaseField=field('Release',release);
 const epic=el('select',{name:'epic'});
 const epicField=field('Epic',epic);
 const projectInfo=()=>projects.find(p=>p.id===project.value);
 const fillProjectOptions=()=>{
  release.disabled=projectInfo()?.settings?.releases===false;
  releaseField.hidden=release.disabled;
  release.replaceChildren(...options((releasesData.releases||[]).filter(r=>r.project===project.value&&r.status==='planned').map(r=>[r.version,r.version]),'',t('Bez releasu')));
  const projectEpics=allEpics.filter(e=>e.project===project.value);
  const selectedEpic=ctx.presetEpic&&projectEpics.some(e=>e.id===ctx.presetEpic)?ctx.presetEpic:(ctx.presetEpic||'');
  const epicList=[...projectEpics.map(e=>[e.id,`${e.id} · ${e.title}`]),...(ctx.presetEpic&&!projectEpics.some(e=>e.id===ctx.presetEpic)?[[ctx.presetEpic,ctx.presetEpic]]:[])];
  epicField.hidden=!epicList.length;
  epic.replaceChildren(...options(epicList,selectedEpic,t('Bez epicu')));
 };
 project.addEventListener('change',fillProjectOptions);fillProjectOptions();
 const assignee=assigneeInput('',peopleNames(peopleData),ctx.user);
 // Files wait here until the item exists; they are uploaded right after it is created. A paste into the
 // description also leaves a chip where the caret is.
 const pending=[],view=item=>{const i=pending.indexOf(item);if(i>=0)openViewer(pending,i,showDialog);};let busy=false;
 const descriptionField=el('textarea',{name:'description','aria-label':t('Popis'),rows:'7',maxlength:'12000',placeholder:t('Co a proč. U chyby kroky k reprodukci, u funkce kritéria přijetí.')});
 const description=mdEditor(descriptionField,keys,
  {project:()=>project.value,canGlobal:()=>projectInfo()?.settings?.globalReferences!==false&&ctx.me?.scopes?.includes('references:write'),canReference:ctx.me?.scopes?.includes('tickets:write'),resolve:name=>pending.find(p=>p.name===name)||null,onOpen:view,label:t('Popis')});
 project.addEventListener('change',()=>{
  if(descriptionField.value.includes('@[')&&markdownReferences(descriptionField.value).length)msg.textContent=t('Projekt se změnil. Zkontroluj, zda jsou reference dostupné v novém projektu.');
 });
 const picker=el('input',{type:'file',multiple:'',hidden:'','aria-label':t('+ Přidat soubor'),onchange:e=>{const list=[...e.target.files];e.target.value='';add(list);}});
 const filesBox=el('div',{class:'tk-attach'});
 const drawFiles=()=>show(filesBox,
  el('div',{class:'tk-attach-head'},el('h4',{},t('Přílohy ({n})',{n:pending.length})),el('button',{type:'button',class:'acc-btn small',onclick:()=>picker.click()},t('+ Přidat soubor'))),
  pending.length?fileStrip(pending,{onOpen:i=>view(pending[i]),onRemove:remove}):null,attachHint());
 const remove=item=>{if(busy||!pending.includes(item))return;pending.splice(pending.indexOf(item),1);releaseFile(item);description.editor.drop(item.name);description.redraw();drawFiles();};
 const add=(list,inline=false)=>{
  if(busy)return;msg.textContent='';msg.classList.remove('error');
  for(const file of list){
   const problem=fileProblem(file,pending.length);if(problem){fail(msg,new Error(problem));continue;}
   const item=pendingFile(file,attachmentName(file,pending.map(p=>p.name)));pending.push(item);
   if(inline)description.editor.insert(item.name);
  }
  drawFiles();
 };
 // While the item is created and its files go up there is nothing to cancel: the button says so by being off.
 const cancel=el('button',{type:'button',class:'acc-btn',onclick:()=>{if(!busy)dialog.close();}},t('Zrušit'));
 const form=el('form',{class:'tk-form',onsubmit:async e=>{e.preventDefault();if(busy)return;const f=e.currentTarget,b=f.querySelector('button[type=submit]');busy=true;b.disabled=true;cancel.disabled=true;
   try{const made=await api('/api/tickets',{project:f.project.value,title:f.title.value,description:f.description.value,type:f.type.value,priority:f.priority.value,release:release.disabled?null:f.release.value||null,...(f.epic?.value?{epic:f.epic.value}:{}),assignee:f.assignee.value.trim()||null,labels:splitList(f.labels.value)});
    // The item exists from here on. A file that does not upload is reported on its page; the dialog does not stay for it.
    const failed=[];
    for(const [i,item] of [...pending].entries()){
     if(epoch!==sessionEpoch)return;
     msg.classList.remove('error');msg.textContent=t('Nahrávám přílohu {i} z {n}: {name}…',{i:i+1,n:pending.length,name:item.name});
     try{await uploadFile(made.id,item.name,item.file);}catch(err){failed.push(`${item.name} (${err.message})`);}
    }
    if(epoch!==sessionEpoch)return;
    if(failed.length)leaveNotice(made.id,t('Položka je založená, ale tyto přílohy se nenahrály: {list}',{list:failed.join(', ')}));
    busy=false;dialog.close();if(ctx.onCreated)await ctx.onCreated(made);else location.hash='#items/'+made.id;}catch(err){fail(msg,err);}finally{busy=false;b.disabled=false;cancel.disabled=false;}}},
  el('div',{class:'tk-grid3'},field(t('Projekt'),project),field(t('Typ'),el('select',{name:'type'},options(TYPES(),'feature'))),field(t('Priorita'),el('select',{name:'priority'},options(PRIORITIES(),'normal')))),
  field(t('Název položky'),el('input',{name:'title',required:'',maxlength:'200',autocomplete:'off'})),
  el('div',{class:'tk-editor-field'},t('Popis'),description.node),mdHint(description.toggle),
  el('div',{class:'tk-grid3'},releaseField,epicField,field(t('Řeší'),assignee.input,assignee.list)),
  field(t('Štítky'),el('input',{name:'labels',placeholder:'ui, api, docs'})),
  el('hr',{class:'tk-divider'}),filesBox,picker,
  msg,el('div',{class:'acc-actions'},cancel,el('button',{type:'submit',class:'acc-btn primary'},t('Založit položku'))));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog','aria-label':t('Nová položka'),
   onpaste:e=>{const list=pastedFiles(e);if(!list.length)return;e.preventDefault();add(list,description.editor.has(e.target));},
   // While the item is being created and its files go up, Esc does not close the dialog under them.
   oncancel:e=>{if(busy)e.preventDefault();}},el('h3',{},t('Nová položka')),form);
 dropTarget(dialog,(list,e)=>add(list,description.editor.has(e.target)));drawFiles();
 showDialog(dialog,()=>pending.forEach(releaseFile));form.title.focus();
}

// Detail ----------------------------------------------------------------------------------------
// Where the user came to a ticket from (a project page, a review set, releases, the open-items list), so the path
// back leads there instead of always to the list. Going from one ticket to another keeps the first origin.
// Kept per tab in sessionStorage, so a reload keeps it too; a link opened in a new tab falls back to the list.
export const ORIGIN_KEY='tk-origin';
export function ticketOrigin(from,to,current){
 const ticket=h=>/^#items\/[^/]+$/.test(h||'');
 if(!ticket(to))return current;
 if(ticket(from))return current;
 if(/^#projects\/[a-z][a-z0-9-]{1,39}\/settings\/references$/.test(from))return from;
 if(/^#projects\/[a-z][a-z0-9-]{1,39}\/epics$/.test(from))return from;
 if(/^#epics\/[A-Z][A-Z0-9]{1,9}-E[1-9][0-9]{0,5}$/.test(from))return from;
 return /^#(projects|review|releases|items|search)(\/[^/]*)?$/.test(from||'')?from:'';
}
let originHash='';
try{originHash=globalThis.sessionStorage?.getItem(ORIGIN_KEY)||'';}catch{}
if(typeof addEventListener==='function')addEventListener('hashchange',e=>{
 let from='',to='';try{from=new URL(e.oldURL).hash;to=new URL(e.newURL).hash;}catch{return;}
 const next=ticketOrigin(from,to,originHash);if(next===originHash)return;originHash=next;try{globalThis.sessionStorage?.setItem(ORIGIN_KEY,next);}catch{}
});
// The path back from a ticket: Projects / <project> / <id> when it was opened from the project, else one link back.
// The project in the path is the one the user came from: after APP-2 → GAME-7 it still leads back to the first project.
export function backPath(tk,projects,origin=originHash){
 const sep=()=>el('span',{class:'tk-dim'},'/');
 if(/^#projects\/[a-z][a-z0-9-]{1,39}\/settings\/references$/.test(origin))return el('a',{href:origin,class:'tk-back'},'← '+t('Reference projektu'));
 const epicOrigin=/^#epics\/([A-Z][A-Z0-9]{1,9}-E[1-9][0-9]{0,5})$/.exec(origin);
 if(epicOrigin)return el('a',{href:origin,class:'tk-back'},'← Epic '+epicOrigin[1]);
 if(/^#projects(\/|$)/.test(origin)){
  const id=/^#projects\/([^/]+)/.exec(origin)?.[1]||tk.project,p=projects.find(x=>x.id===id);
  return el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},
   el('a',{href:'#projects'},t('Projekty')),sep(),el('a',{href:'#projects/'+encodeURIComponent(id)},p?.name||id),sep(),el('b',{},tk.id));
 }
 const review=/^#review\/(R-[1-9][0-9]{0,5})$/.exec(origin);
 if(review)return el('a',{href:origin,class:'tk-back'},'← Review '+review[1]);
 if(/^#review(\/|$)/.test(origin))return el('a',{href:origin,class:'tk-back'},'← Review');
 if(/^#releases$/.test(origin))return el('a',{href:'#releases',class:'tk-back'},`← ${t('Releasy')}`);
 if(/^#search(\/|$)/.test(origin))return el('a',{href:origin,class:'tk-back'},`← ${t('Hledání')}`);
 return el('a',{href:'#items',class:'tk-back'},`← ${t('Položky')}`);
}
async function ticketPage(wrap,ctx){
 const result=await load(wrap,Promise.all([api('/api/tickets/'+encodeURIComponent(ctx.id)),api('/api/tickets?limit=1'),api('/api/tickets/people').catch(()=>null),api('/api/review?'+new URLSearchParams({ticket:ctx.id,status:'all'})).catch(()=>null)]));if(!result)return;
 // What is left to say about files that did not reach this item (from the new-item dialog, or from an upload that
 // ended after its page was left) is said here, once.
 // It waits for a page of that item that is on the screen: a view the user already left does not use it up.
 const [tk,meta,people,reviews]=result,mine=wrap.isConnected&&prefs.notices.has(tk.id),notice=mine?{notice:prefs.notices.get(tk.id),noticeError:true}:{};if(mine)prefs.notices.delete(tk.id);
 const epicsData=await load(wrap,api('/api/tickets/epics?project='+encodeURIComponent(tk.project)).catch(()=>({epics:[]})));if(!epicsData)return;
 const epics=Array.isArray(epicsData?.epics)?epicsData.epics:[];
 // Wiki pages that mention the ticket are listed once, under References and where used.
 const referenceLinks=referencesSection('ticket',tk.id,ctx.me);
 renderTicket(wrap,{...ctx,meta,epics,referenceLinks,reviews:Array.isArray(reviews?.sets)?reviews:null,people:peopleNames(people)},tk,{fields:{},comment:'',...notice});
}
// Unsaved input on a ticket page: the comment box and every edit-form field that differs from what was rendered,
// whether the edit form is open, and which field the keyboard is in (and where). A write re-renders from
// the ticket the server returned (no second request that could fail), carrying these over.
const pages=new WeakMap(),pastes=new WeakMap(),drops=new WeakSet();
// By item id: the files on their way up (name → file), and the page that shows the item now. An upload outlives
// the page that started it, and a later visit of the item has to know its files and hear how it ended.
const sendings=new Map(),views=new Map();
const viewOf=id=>{const wrap=views.get(id)?.deref();return wrap?.isConnected?wrap:null;};
function drafts(wrap){
 const page=pages.get(wrap);if(!page)return {fields:{},comment:'',editing:false};
 const active=document.activeElement,focusIn=Object.keys(page.editors).find(k=>page.editors[k].has(active))||null;
 const focusInput=focusIn?null:Object.keys(page.inputs).find(k=>page.inputs[k]===active)||null;let caret=null;
 try{caret=focusIn?page.editors[focusIn].caret():focusInput&&typeof active.selectionStart==='number'?active.selectionStart:null;}catch{}
 // The text fields keep their undo steps and the one in use its scroll position across the re-render.
 const histories=Object.fromEntries(Object.entries(page.editors).map(([k,editor])=>[k,editor.history()])),scroll=focusIn?page.editors[focusIn].node.scrollTop??null:null;
 return {comment:page.comment?.value||'',editing:page.editing===true,focusIn,focusInput,caret,histories,scroll,
  fields:Object.fromEntries(Object.entries(page.inputs).filter(([k,input])=>input.value!==page.initial[k]).map(([k,input])=>[k,input.value]))};
}
// Shows the ticket a write returned on the item's page `wrap`, with the unsaved input carried over; `adjust` drops
// from it what the write just saved. Another write may have re-rendered meanwhile: never an older ticket than
// the one on the page.
function redraw(wrap,updated,adjust=()=>{}){
 const page=pages.get(wrap);if(!page)return;
 const next=drafts(wrap);adjust(next);next.notice=t('Uloženo.');
 inPlace(()=>renderTicket(wrap,page.ctx,updated.updatedAt>=page.ticket.updatedAt?updated:page.ticket,next));
}
// A page drawn again under the reader (a file of theirs finished uploading) stays where it was scrolled to.
function inPlace(draw){
 const y=globalThis.scrollY;draw();
 if(Number.isFinite(y)&&typeof globalThis.scrollTo==='function'&&globalThis.scrollY!==y)globalThis.scrollTo(globalThis.scrollX||0,y);
}
function renderTicket(wrap,ctx,tk,keep){
 const {canWrite,meta,user}=ctx,project=meta.projects.find(p=>p.id===tk.project),msg=status(),keys=meta.projects.map(p=>p.key);
 if(keep.notice){msg.textContent=keep.notice;if(keep.noticeError)msg.classList.add('error');}
 const rerender=(updated,adjust)=>redraw(wrap,updated,adjust);
 const write=async(button,request,saved)=>{
  if(button)button.disabled=true;const epoch=sessionEpoch;let updated;
  try{updated=await request();}catch(e){if(wrap.isConnected){fail(msg,e);if(button)button.disabled=false;}return;}
  if(epoch!==sessionEpoch||!wrap.isConnected)return;
  rerender(updated,saved);
 };
 // A save from the edit form closes it (back to the read view); any other write leaves it as it is.
 const save=(change,button,fromEdit=false)=>write(button,()=>api('/api/tickets/update',{id:tk.id,rev:tk.rev,...change}),next=>{if(fromEdit){next.fields={};next.editing=false;}else for(const k of Object.keys(change))delete next.fields[k];});
 // The read view is the default. The edit form is drawn only while editing: opened with the button or e, and
 // kept open across a re-render while it is open or still holds unsaved changes.
 const editing=canWrite&&(keep.editing===true||Object.keys(keep.fields||{}).length>0);
 const shownTicket=()=>pages.get(wrap)?.ticket||tk;
 const openEdit=()=>{if(!canWrite||pages.get(wrap)?.editing)return false;renderTicket(wrap,ctx,shownTicket(),{...drafts(wrap),editing:true,focus:'title'});};
 const closeEdit=()=>{
  if(Object.keys(drafts(wrap).fields).length&&!confirm(t('Zahodit neuložené úpravy?')))return;
  renderTicket(wrap,ctx,shownTicket(),{...drafts(wrap),fields:{},editing:false,focus:'edit'});
 };
 const quick=[],editButton=canWrite&&!editing?el('button',{type:'button',class:'acc-btn small tk-edit-open','aria-keyshortcuts':'e',onclick:()=>void openEdit()},`✎ ${t('Upravit')}`):null;
 if(canWrite){
  const b=(text,next,cls='')=>el('button',{type:'button',class:`acc-btn small ${cls}`,onclick:e=>save({status:next},e.currentTarget)},text);
  if(tk.status==='open')quick.push(b(`▶ ${t('Začít')}`,'in-progress'));
  if(ACTIVE.includes(tk.status))quick.push(b(`✓ ${t('Hotovo')}`,'done','primary'),b(t('Zrušit položku'),'cancelled'));
  if(CLOSED.includes(tk.status))quick.push(b(`↺ ${t('Znovu otevřít')}`,'open'));
  if(editButton)quick.push(editButton);
 }
 const fact=(k,v)=>[el('dt',{},k),el('dd',{},v)];
 // Files: the saved ones, the ones on their way up (a chip can already name them), and the names of files that
 // were taken away again, so that a ![name] left in a text says so instead of turning back into its token.
 const files=(tk.attachments||[]).map(a=>({...savedFile(tk.id,a),note:`${a.by} · ${ago(a.at)}`}));views.set(tk.id,new WeakRef(wrap));
 const removed=new Set(tk.history.filter(h=>h.field==='attachment'&&h.to===null).map(h=>h.from));
 const resolve=name=>files.find(f=>f.name===name)||sendings.get(tk.id)?.get(name)||(removed.has(name)?{name,gone:true}:null);
 const view=item=>{const i=files.indexOf(item);if(i>=0)openViewer(files,i,showDialog);};
 const inText={resolve,onOpen:view,project:()=>tk.project,canGlobal:project?.settings?.globalReferences!==false&&ctx.me?.scopes?.includes('references:write'),canReference:ctx.me?.scopes?.includes('tickets:write')},chips=chipsOf(inText);
 const commentBox=canWrite?el('textarea',{name:'text',rows:'3',required:'',maxlength:'8000',placeholder:t('Komentář, postup, commit…'),'aria-label':t('Nový komentář'),'aria-keyshortcuts':'c'}):null;
 if(commentBox)commentBox.value=keep.comment||'';
 const commentEditor=commentBox?mdEditor(commentBox,keys,{...inText,history:keep.histories?.comment}):null;
 // Upload with the button, by dropping files on the page, or by pasting (Cmd/Ctrl+V) anywhere on it. A paste or a
 // drop into the description or the comment also leaves the files' chips in that text, at the caret: at once and
 // side by side, in the draft the next render keeps; a failed upload takes its chip out again. The files then go
 // up one by one. That outlives the renders its own writes cause, and the page itself: every file that was
 // handed over goes up even when the user moves on (only the end of the session stops it). So it works on the
 // page that shows the item when a file is through (this one, or one of a later visit), never on what was there
 // when it started.
 const upload=async(list,target=null)=>{
  const epoch=sessionEpoch,page=()=>{const w=viewOf(tk.id);return w?pages.get(w):null;},failed=[],queue=[];
  const note=(text,error=false)=>{const m=page()?.msg;if(m){m.textContent=text;m.classList.toggle('error',error);}};
  let sending=sendings.get(tk.id);if(!sending)sendings.set(tk.id,sending=new Map());
  const taken=[...((pages.get(wrap)?.ticket||tk).attachments||[]).map(a=>a.name),...sending.keys()];
  for(const file of list){
   const problem=fileProblem(file,taken.length);if(problem){failed.push(problem);continue;}
   const name=attachmentName(file,taken),item=pendingFile(file,name);taken.push(name);sending.set(name,item);queue.push({file,name,item});
   if(target)page()?.editors[target]?.insert(name);
  }
  const over=entry=>{if(sending.get(entry.name)===entry.item)sending.delete(entry.name);releaseFile(entry.item);};
  for(const [i,entry] of queue.entries()){
   if(epoch!==sessionEpoch){queue.slice(i).forEach(over);return;}
   note(t('Nahrávám {name}…',{name:entry.name}));
   let updated=null,error=null;
   try{updated=await uploadFile(tk.id,entry.name,entry.file);}catch(e){error=e;}
   if(sending.get(entry.name)===entry.item)sending.delete(entry.name);
   if(epoch!==sessionEpoch){queue.slice(i).forEach(over);return;}
   const shown=viewOf(tk.id),now=shown&&pages.get(shown);
   if(error){
    failed.push(`${entry.name}: ${error.message}`);
    // The text may have been saved with the token meanwhile: draw the page again, so that no chip stands for a file that is not there.
    if(now){if(target)now.editors[target]?.drop(entry.name);inPlace(()=>renderTicket(shown,now.ctx,now.ticket,drafts(shown)));}
   }else if(now){
    // The server has the last word on the name (it changes one the ticket already has); the chip follows it.
    const stored=updated.attachments?.at(-1)?.name,follow=text=>typeof text==='string'&&stored&&stored!==entry.name?text.split(fileToken(entry.name)).join(fileToken(stored)):text;
    redraw(shown,updated,next=>{next.comment=follow(next.comment);if('description'in next.fields)next.fields.description=follow(next.fields.description);});
   }
   releaseFile(entry.item);
  }
  if(!sending.size&&sendings.get(tk.id)===sending)sendings.delete(tk.id);
  // What did not go up is said at the end, where a later file's "saved" cannot cover it; when no page shows the item, its next visit says it.
  if(!failed.length||epoch!==sessionEpoch)return;
  const text=failed.length===1?failed[0]:t('Tyto přílohy se nenahrály: {list}',{list:failed.join('; ')});
  if(page())note(text,true);else leaveNotice(tk.id,text);
 };
 const picker=canWrite?el('input',{type:'file',multiple:'',hidden:'','aria-label':t('+ Přidat soubor'),onchange:e=>{const list=[...e.target.files];e.target.value='';upload(list);}}):null;
 const removeFile=(item,button)=>{if(!confirm(t('Odebrat přílohu {name}?',{name:item.name})))return;write(button,()=>api('/api/tickets/attachments/delete',{id:tk.id,attachment:item.id}),()=>{});};
 // After the fields, under a divider: the files as tiles. A reader sees it only when there is a file to see.
 const attach=files.length||canWrite?[el('hr',{class:'tk-divider'}),el('div',{class:'tk-attach'},
  el('div',{class:'tk-attach-head'},el('h4',{},t('Přílohy ({n})',{n:files.length})),canWrite?el('button',{type:'button',class:'acc-btn small',onclick:()=>picker.click()},t('+ Přidat soubor')):null,picker),
  files.length?fileStrip(files,{onOpen:i=>openViewer(files,i,showDialog),onRemove:canWrite?removeFile:null}):null,canWrite?attachHint():null)]:null;
 const edit=editing?editForm(tk,meta,save,ctx,closeEdit,{draft:keep.fields||{},files:{...inText,history:keep.histories?.description},attach}):null;
 // While editing, the form takes the place of the rendered description: the text is never shown twice.
 const main=edit?edit.form:el('section',{class:'acc-card tk-desc'},el('h3',{},t('Popis')),tk.description?markdown(tk.description,{keys,files:chips,references:true}):el('p',{class:'acc-dim'},t('Bez popisu.')),attach);
 const editors=Object.fromEntries(Object.entries({comment:commentEditor?.editor,description:edit?.editor}).filter(([,editor])=>editor));
 pages.set(wrap,{ticket:tk,ctx,comment:commentBox,editing,inputs:edit?.inputs||{},initial:edit?.initial||{},editors,msg,upload});
 // Files dropped anywhere on the page are attached (a file dropped beside a drop target would replace the page
 // with itself); dropped on the description editor or the comment box they also get their chip there. The
 // listeners are the page's, set once; they hand over to the upload of the latest render.
 const field=node=>{const now=pages.get(wrap)?.editors||{};return Object.keys(now).find(k=>now[k].has(node))||null;};
 if(canWrite&&!drops.has(wrap)){drops.add(wrap);dropTarget(wrap,(list,e)=>pages.get(wrap)?.upload(list,field(e.target)));}
 const comments=el('section',{class:'acc-card'},el('h3',{},t('Komentáře ({n})',{n:tk.comments.length})),
  tk.comments.length?el('ol',{class:'tk-comments'},tk.comments.map(c=>el('li',{class:'tk-comment'},
   el('div',{class:'tk-comment-head'},el('span',{class:'tk-avatar','aria-hidden':'true'},initials(c.by)||'?'),el('b',{},c.by),el('span',{class:'tk-dim',title:when(c.at)},ago(c.at))),
   markdown(c.text,{keys,files:chips,references:true})))):el('p',{class:'acc-dim'},t('Zatím bez komentářů.')),
  // The comment box is required, but as a hidden field behind the chip editor the browser cannot say so: an empty one just gets the caret.
  canWrite?el('form',{class:'tk-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget,text=f.text.value;if(!text.trim()){editors.comment.focusAt(null);return;}
    return write(f.querySelector('button[type=submit]'),()=>api('/api/tickets/comment',{id:tk.id,text}),next=>{if(next.comment===text)next.comment='';});}},
   commentEditor.node,el('div',{class:'acc-actions tk-comment-actions'},mdHint(commentEditor.toggle),el('button',{type:'submit',class:'acc-btn'},t('Přidat komentář')))):null);
 if(canWrite&&typeof addEventListener==='function'){const old=pastes.get(wrap);if(old)removeEventListener('paste',old);
  const onPaste=e=>{
   if(!wrap.isConnected){removeEventListener('paste',onPaste);return;}
   if(e.defaultPrevented||document.querySelector('dialog[open]'))return;
   const list=pastedFiles(e);if(!list.length)return;e.preventDefault();
   upload(list,field(e.target));
  };
  pastes.set(wrap,onPaste);addEventListener('paste',onPaste);onLeave(()=>removeEventListener('paste',onPaste));}
 const reviewsEnabled=project?.settings?.reviews!==false;
 const reviewBlock=reviewsEnabled||ctx.reviews?.sets.length||!ctx.reviews?el('section',{class:'acc-card'},
  el('h3',{},'Review'+(ctx.reviews?' ('+ctx.reviews.sets.length+')':'')),
  ctx.reviews?ctx.reviews.sets.map(s=>el('p',{},el('a',{href:'#review/'+s.id},s.id+' · '+s.title),s.feedbackPending?el('span',{class:'sec-pill warn'},'Review feedback available'):null)):
   el('p',{},'Review links could not be loaded. Reopen this ticket to retry.'),
  reviewsEnabled?(canWrite?el('button',{type:'button',class:'acc-btn',onclick:()=>reviewDialog({project:tk.project,ticket:tk})},'Request review · agent publishing instructions'):el('p',{},'Publishing requires review write access.')):null):null;
 const assignMe=canWrite&&user&&tk.assignee!==user&&!CLOSED.includes(tk.status)?el('button',{type:'button',class:'tk-inline-btn',onclick:e=>save({assignee:user},e.currentTarget)},t('Vezmu si to')):null;
 show(wrap,
  backPath(tk,meta.projects),
  // Each field is on the page once: type, priority, status and labels in the head, the rest under "Údaje".
  el('div',{class:'tk-head'},el('div',{},el('div',{class:'tk-mono tk-dim'},`${tk.id} · ${project?.name||tk.project}`),
    el('div',{class:'ui-title'},el('h1',{class:'tk-title'},glyph(tk.type),' ',tk.title),provenanceBadge(tk.provenance)),
    el('div',{class:'tk-pills'},pill(TYPES(),tk.type),pill(PRIORITIES(),tk.priority),pill(STATUSES(),tk.status),
     (tk.labels||[]).map(l=>el('span',{class:'tk-label'},l)))),
   el('div',{class:'tk-quick'},quick)),
  msg,
  el('div',{class:'tk-detail'},
   el('div',{class:'acc-stack'},main,reviewBlock,ctx.referenceLinks,comments,timeline(tk)),
   el('div',{class:'acc-stack'},
    el('section',{class:'acc-card'},el('h3',{},t('Údaje')),el('dl',{class:'acc-dl'},
     project?.settings?.releases!==false||tk.release?fact('Release',tk.release?el('a',{class:'sys-link',href:'#releases',onclick:()=>{releaseFilters.project=tk.project;}},tk.release):'—'):null,
     (ctx.epics?.length||tk.epic)?fact('Epic',tk.epic?el('a',{class:'sys-link',href:'#epics/'+tk.epic},(()=>{const ep=ctx.epics?.find(x=>x.id===tk.epic);return ep?`${ep.id} · ${ep.title}`:tk.epic;})()):'—'):null,
     fact(t('Řeší'),el('span',{class:'tk-fact-row'},tk.assignee?[el('span',{class:'tk-avatar','aria-hidden':'true'},initials(tk.assignee)),tk.assignee]:'—',assignMe)),fact(t('Nahlásil'),tk.reporter||'—'),
     fact(t('Odkazy'),tk.refs.length?el('div',{class:'tk-refs'},tk.refs.map(r=>/^https?:\/\//.test(r)?el('a',{href:r,target:'_blank',rel:'noopener noreferrer',class:'sys-link'},r):EPIC_ID.test(r)?el('a',{href:'#epics/'+r,class:'sys-link'},r):TICKETISH.test(r)?el('a',{href:'#items/'+r,class:'sys-link'},r):el('code',{},r))):'—'),
     fact(t('Založeno'),when(tk.createdAt)),fact(t('Změněno'),when(tk.updatedAt)),...(tk.closedAt?fact(t('Uzavřeno'),when(tk.closedAt)):[]),fact(t('Revize'),String(tk.rev)))))));
 shortcuts(wrap,{c:()=>editors.comment?void editors.comment.focusAt(null):false,e:openEdit});
 if(prefs.focusComment){prefs.focusComment=false;editors.comment?.focusAt(null);}
 // Opening the form puts the keyboard in its first field; closing it puts it back on the button that opened it.
 // A write that re-drew the page while the keyboard was in a field (a file that finished uploading, say) puts it
 // back there, or the next keys would go to the page's shortcuts.
 if(keep.focus==='title')edit?.inputs.title?.focus();
 else if(keep.focus==='edit')editButton?.focus();
 else if(keep.focusIn&&editors[keep.focusIn]){editors[keep.focusIn].focusAt(keep.caret);if(keep.scroll!=null)editors[keep.focusIn].node.scrollTop=keep.scroll;}
 else if(keep.focusInput&&edit?.inputs[keep.focusInput]){const input=edit.inputs[keep.focusInput];input.focus();if(keep.caret!=null)try{input.setSelectionRange(keep.caret,keep.caret);}catch{}}
}
const TICKETISH=/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$/;
const FIELD_NAMES=()=>({attachment:t('Příloha'),created:t('Založeno'),title:t('Název položky'),description:t('Popis'),spec:t('Specifikace'),type:t('Typ'),status:t('Stav'),priority:t('Priorita'),release:'Release',epic:'Epic',assignee:t('Řeší'),labels:t('Štítky'),refs:t('Odkazy')});
function historyText(h,entity='ticket'){
 if(h.field==='created')return entity==='epic'?t('Epic založen'):t('Položka založena');
 if(h.field==='attachment')return h.to?t('Příloha přidána: {name}',{name:h.to}):t('Příloha odebrána: {name}',{name:h.from});
 const name=FIELD_NAMES()[h.field]||h.field;
 if(h.from===null&&h.to===null)return t('{field}: upraveno',{field:name});
 const v=x=>x===null||x===undefined||(Array.isArray(x)&&!x.length)?'—':Array.isArray(x)?x.join(', '):h.field==='status'?label(STATUSES(),x):h.field==='type'?label(TYPES(),x):h.field==='priority'?label(PRIORITIES(),x):String(x);
 return `${name}: ${v(h.from)} → ${v(h.to)}`;
}
// History as a timeline, newest first: the latest changes are shown, older ones fold away.
const EVENT_ICON={created:'✚',status:'◐',attachment:'📎',assignee:'☺',release:'⚑',epic:'◈',priority:'▲',labels:'#',refs:'↗',title:'✎',description:'✎',spec:'✎',type:'◆'},EVENTS_SHOWN=6;
function timeline(tk,entity='ticket'){
 const events=[...(tk.history||[])].reverse();
 const row=h=>el('li',{class:`tk-event ${h.field==='status'?TONE[h.to]||'':''}`},el('span',{class:'tk-event-icon','aria-hidden':'true'},EVENT_ICON[h.field]||'•'),
  el('div',{},el('b',{},historyText(h,entity)),el('div',{class:'tk-dim tk-event-meta',title:when(h.at)},`${h.by} · ${ago(h.at)}`)));
 const older=events.slice(EVENTS_SHOWN);
 return el('section',{class:'acc-card'},el('h3',{},t('Historie změn ({n})',{n:events.length})),el('ol',{class:'tk-events'},events.slice(0,EVENTS_SHOWN).map(row)),
  older.length?el('details',{class:'tk-events-more'},el('summary',{},tp(older.length,'{n} starší změna|{n} starší změny|{n} starších změn')),el('ol',{class:'tk-events'},older.map(row))):null);
}
// The edit form of one ticket: every editable field once, description included. onCancel closes it. `draft` is
// the unsaved input of an earlier render; `files` lets the description show the ticket's files as chips, and
// `attach` (the divider and the files) goes after the fields.
function editForm(tk,meta,save,ctx={},onCancel,{draft={},files=null,attach=null}={}){
 const inputs={},field=(text,input,...more)=>{if(input.getAttribute('name'))inputs[input.getAttribute('name')]=input;return el('label',{},text,input,...more);};
 const showRelease=meta.projects.find(p=>p.id===tk.project)?.settings?.releases!==false;
 const releases=meta.releases.filter(r=>r.project===tk.project&&(r.status==='planned'||r.version===tk.release)).map(r=>[r.version,r.status==='released'?t('{version} (vydáno)',{version:r.version}):r.version]);
 const epics=(ctx.epics||[]).filter(e=>e.project===tk.project).map(e=>[e.id,`${e.id} · ${e.title}`]);
 if(tk.epic&&!epics.some(([id])=>id===tk.epic))epics.unshift([tk.epic,tk.epic]);
 const assignee=assigneeInput(tk.assignee,ctx.people||[],ctx.user);
 // "Unchanged" is what the field makes of the saved text (its line ends); the draft goes in after that, and
 // before the editor draws the text.
 const description=el('textarea',{name:'description','aria-label':t('Popis'),rows:'8',maxlength:'12000'});description.value=tk.description;
 const saved=description.value;if(typeof draft.description==='string')description.value=draft.description;
 const editor=mdEditor(description,meta.projects.map(p=>p.key),files&&{...files,label:t('Popis')});inputs.description=description;
 const form=el('form',{class:'acc-card tk-form tk-edit','aria-label':t('Upravit položku {id}',{id:tk.id}),onsubmit:e=>{e.preventDefault();const f=e.currentTarget;
   const values={title:f.title.value.trim(),description:f.description.value.trim(),type:f.type.value,status:f.status.value,priority:f.priority.value,...(showRelease?{release:f.release.value||null}:{}),...(f.epic?{epic:f.epic.value||null}:{}),assignee:f.assignee.value.trim()||null,labels:[...new Set(splitList(f.labels.value).map(v=>v.toLowerCase()))],refs:[...new Set(f.refs.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))]};
   const changed=Object.fromEntries(Object.entries(values).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(k==='epic'?(tk.epic??null):tk[k])));
   if(Object.keys(changed).length)return save(changed,f.querySelector('button[type=submit]'),true);}},
  el('h3',{},t('Upravit')),
  field(t('Název položky'),el('input',{name:'title',required:'',maxlength:'200',value:tk.title})),
  el('div',{class:'tk-grid2'},field(t('Stav'),el('select',{name:'status'},options(STATUSES(),tk.status))),field(t('Typ'),el('select',{name:'type'},options(TYPES(),tk.type))),
   field(t('Priorita'),el('select',{name:'priority'},options(PRIORITIES(),tk.priority))),showRelease?field('Release',el('select',{name:'release'},options(releases,tk.release||'',t('Bez releasu')))):tk.release?el('div',{},'Release · ',tk.release):null),
  epics.length?field('Epic',el('select',{name:'epic'},options(epics,tk.epic||'',t('Bez epicu')))):null,
  field(t('Řeší'),assignee.input,assignee.list),assignee.mine,
  field(t('Štítky (čárkou)'),el('input',{name:'labels',value:tk.labels.join(', ')})),
  field(t('Odkazy (commit, PR, položka; každý na vlastní řádek)'),(()=>{const a=el('textarea',{name:'refs',rows:'2'});a.value=tk.refs.join('\n');return a;})()),
  el('div',{class:'tk-editor-field'},t('Popis'),editor.node),mdHint(editor.toggle),
  attach,
  el('div',{class:'acc-actions'},onCancel?el('button',{type:'button',class:'acc-btn',onclick:onCancel},t('Zrušit úpravy')):null,el('button',{type:'submit',class:'acc-btn primary'},t('Uložit změny'))));
 const initial={...Object.fromEntries(Object.entries(inputs).map(([k,input])=>[k,input.value])),description:saved};
 for(const [k,v] of Object.entries(draft))if(k!=='description'&&inputs[k])inputs[k].value=v;
 return {form,inputs,initial,editor:editor.editor};
}

// Releases --------------------------------------------------------------------------------------
async function releasesPage(wrap,ctx){
 const data=await load(wrap,api('/api/tickets'+(releaseFilters.project?'?project='+encodeURIComponent(releaseFilters.project):'')));if(!data)return;
 renderReleases(wrap,ctx,data);
}
const NO_COUNTS=Object.freeze({open:0,'in-progress':0,done:0,cancelled:0});
function renderReleases(wrap,ctx,data,notice=''){
 const {canWrite}=ctx,msg=status(),redraw=()=>releasesPage(wrap,ctx).catch(e=>fail(msg,e));if(notice)msg.textContent=notice;
 const add=canWrite&&data.projects.length?{label:t('+ Nová položka'),onclick:()=>newTicket(data.projects,releaseFilters.project||null,ctx)}:null;
 const title=head(t('Releasy'),t('Verze, do kterých položky patří: co zbývá, co je hotové a kdy má release vyjít.'),[add],data.provenance);
 if(!data.projects.length)return show(wrap,title,noProjects(ctx,redraw));
 // The saved release is shown at once from the POST reply; the follow-up refresh (new counts) may fail on its own.
 const saveRelease=async(body,button)=>{
  if(button)button.disabled=true;const epoch=sessionEpoch;let saved;
  try{saved=await api('/api/tickets/releases',body);}catch(e){if(wrap.isConnected){fail(msg,e);if(button)button.disabled=false;}return;}
  if(epoch!==sessionEpoch||!wrap.isConnected)return;
  const same=r=>r.project===saved.project&&r.version===saved.version,old=data.releases.find(same);
  const releases=[...data.releases.filter(r=>!same(r)),{counts:{...NO_COUNTS},total:0,...old,...saved}].sort((a,b)=>a.project.localeCompare(b.project)||a.version.localeCompare(b.version,'en',{numeric:true,sensitivity:'base'}));
  renderReleases(wrap,ctx,{...data,releases},t('Uloženo.'));
  try{const fresh=await load(wrap,api('/api/tickets'+(releaseFilters.project?'?project='+encodeURIComponent(releaseFilters.project):'')));if(fresh)renderReleases(wrap,ctx,fresh,t('Uloženo.'));}
  catch(e){const m=wrap.querySelector('p[role=status]');if(m)fail(m,new Error(t('Uloženo, ale přehled se nepodařilo obnovit: {error}',{error:e.message})));}
 };
 const projects=data.projects.filter(p=>!releaseFilters.project||p.id===releaseFilters.project);
 const item=tk=>el('li',{class:CLOSED.includes(tk.status)?'tk-closed':''},glyph(tk.type),el('a',{href:'#items/'+tk.id},tk.id),el('span',{class:'tk-mini-title'},tk.title),pill(STATUSES(),tk.status));
 const card=(r,hero)=>{
  const mine=data.tickets.filter(x=>x.project===r.project&&x.release===r.version),scope=r.total-r.counts.cancelled,d=due(r);
  const left=mine.filter(x=>ACTIVE.includes(x.status)),done=mine.filter(x=>!ACTIVE.includes(x.status));
  return el('section',{class:`acc-card tk-release${r.status==='released'?' tk-released':''}${hero?' tk-hero':''}${d?.tone?' tk-due-'+d.tone:''}`},
   el('div',{class:'tk-release-head'},el('div',{},hero?el('div',{class:'tk-eyebrow'},t('Další release')):null,el('b',{class:'tk-version'},r.version),' ',el('span',{class:`sec-pill ${r.status==='released'?'ok':'warn'}`},r.status==='released'?t('vydáno'):t('plánováno')),
     d?el('span',{class:`sec-pill tk-countdown ${d.tone}`,title:t('cíl {date}',{date:dayText(r.targetDate)})},d.text):null,
     el('div',{class:'sec-dim'},r.status==='released'?t('vydáno {date}',{date:dayText(r.releasedAt)}):t('cíl {date}',{date:dayText(r.targetDate)}),` · ${t('{done}/{scope} hotovo',{done:r.counts.done,scope})} · ${t('otevřené: {n}',{n:r.counts.open})} · ${t('rozpracované: {n}',{n:r.counts['in-progress']})}`)),
    canWrite?el('div',{},r.status==='planned'?el('button',{type:'button',class:'acc-btn small primary',title:r.counts.open+r.counts['in-progress']?t('Release má ještě nedokončené položky.'):'',onclick:e=>saveRelease({project:r.project,version:r.version,rev:r.rev,status:'released'},e.currentTarget)},t('Označit jako vydané'))
     :el('button',{type:'button',class:'acc-btn small',onclick:e=>saveRelease({project:r.project,version:r.version,rev:r.rev,status:'planned'},e.currentTarget)},t('Vrátit do plánu'))):null),
   progressBar(r.counts,scope),r.notes?markdown(r.notes,{keys:data.projects.map(p=>p.key),cls:'tk-md tk-md-dim'}):null,
   !mine.length?el('p',{class:'acc-dim'},t('Zatím bez položek.'))
   :hero?el('div',{class:'tk-split'},
     el('div',{},el('h4',{class:'tk-eyebrow'},t('Zbývá ({n})',{n:left.length})),left.length?el('ul',{class:'tk-mini'},left.map(item)):el('p',{class:'acc-dim'},t('Vše hotovo — můžeš vydat. 🚀'))),
     el('div',{},el('h4',{class:'tk-eyebrow'},t('Hotovo ({n})',{n:done.length})),done.length?el('ul',{class:'tk-mini'},done.map(item)):el('p',{class:'acc-dim'},t('Zatím nic.'))))
   :el('ul',{class:'tk-mini'},mine.map(item)));
 };
 const node=(r,hero)=>el('li',{class:`tk-tl ${r.status}${hero?' next':''}`},el('span',{class:'tk-tl-dot','aria-hidden':'true'}),card(r,hero));
 const addForm=p=>el('form',{class:'acc-form tk-release-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget;saveRelease({project:p.id,version:f.version.value.trim(),targetDate:f.targetDate.value||null,notes:f.notes.value},f.querySelector('button'));}},
  el('label',{},t('Verze'),el('input',{name:'version',required:'',maxlength:'40',pattern:'(?!none$)[A-Za-z0-9][A-Za-z0-9._+\\-]{0,39}',placeholder:t('např. 2.4 nebo v0.5.0')})),
  el('label',{},t('Cílové datum'),el('input',{name:'targetDate',type:'date'})),el('label',{},t('Poznámka'),el('input',{name:'notes',maxlength:'2000',placeholder:t('Co release přináší')})),
  el('button',{type:'submit',class:'acc-btn primary'},t('Přidat release')));
 show(wrap,title,el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},projectChips(data.projects,redraw,releaseFilters))),msg,
  ...projects.map(p=>{
   const releases=data.releases.filter(r=>r.project===p.id),planned=releases.filter(r=>r.status==='planned').sort(plannedOrder),released=releases.filter(r=>r.status==='released').reverse();
   const unplanned=data.tickets.filter(x=>x.project===p.id&&!x.release&&ACTIVE.includes(x.status)).length,recent=released.slice(0,3),older=released.slice(3);
   return el('div',{class:'acc-stack tk-project'},el('h2',{class:'tk-project-name'},el('a',{href:'#projects/'+p.id},p.name),' ',el('span',{class:'sec-dim'},`${p.key} · ${t('aktivní položky bez releasu: {n}',{n:unplanned})}`)),
    canWrite&&p.settings?.releases!==false?addForm(p):null,
    planned.length||released.length?el('ol',{class:'tk-timeline'},...planned.map((r,i)=>node(r,i===0)),...recent.map(r=>node(r,false)))
     :el('p',{class:'tk-none-line'},canWrite&&p.settings?.releases!==false?t('Zatím žádný release. Přidej první formulářem výše, nebo ho nech založit agenta nástrojem release_save.'):t('Zatím žádný release.')),
    older.length?el('details',{class:'sec-findings'},el('summary',{},t('Starší vydané ({n})',{n:older.length})),el('ol',{class:'tk-timeline'},older.map(r=>node(r,false)))):null);
  }));
 shortcuts(wrap,{n:()=>add?void add.onclick():false});
}

// Projects --------------------------------------------------------------------------------------
// Health ring: share of open / in progress / done (cancelled left out), done % in the middle.
function healthRing(c){
 const total=c.open+c['in-progress']+c.done,pct=total?Math.round(c.done/total*100):0,a=total?c.open/total*100:0,b=total?(c.open+c['in-progress'])/total*100:0;
 const ring=el('div',{class:'tk-ring',role:'img','aria-label':t('Hotovo {pct} % ({done} z {total})',{pct,done:c.done,total})},el('div',{class:'tk-ring-hole'},el('b',{},pct+'%'),el('span',{},`${c.done}/${total}`)));
 if(total)ring.style.background=`conic-gradient(var(--warn) 0 ${a}%, var(--accent2) ${a}% ${b}%, var(--ok) ${b}% 100%)`;
 return ring;
}
function health(tickets){
 const c=statusCounts(tickets),bugs=activeBugs(tickets);
 const row=(tone,k,v)=>el('li',{class:tone},el('span',{class:'tk-dot'}),el('span',{},k),el('b',{},String(v)));
 return el('div',{class:'tk-health'},healthRing(c),el('div',{class:'tk-legend-wrap'},
  el('ul',{class:'tk-legend'},row('warn',t('Otevřené'),c.open),row('info',t('Rozpracované'),c['in-progress']),row('ok',t('Hotové'),c.done)),
  bugs?el('span',{class:'sec-pill crit tk-bugs'},`🐞 ${tp(bugs,'{n} aktivní chyba|{n} aktivní chyby|{n} aktivních chyb')}`):null));
}
// Closed items per day over the last 14 days, plus the latest changes.
const DAYS=14;
function activity(tickets,recent=3){
 const days=[...Array(DAYS)].map((_,i)=>dayKey(new Date(Date.now()-(DAYS-1-i)*864e5))),hits=Object.fromEntries(days.map(d=>[d,0]));
 for(const tk of tickets)if(tk.status==='done'&&tk.closedAt){const k=dayKey(new Date(tk.closedAt));if(k in hits)hits[k]++;}
 const max=Math.max(1,...Object.values(hits)),sum=Object.values(hits).reduce((x,y)=>x+y,0),caption=t('Uzavřeno za {days} dní: {n}',{days:DAYS,n:sum});
 const spark=el('div',{class:'tk-spark',role:'img','aria-label':caption},days.map(d=>{const bar=el('span',{title:`${dayText(d)}: ${hits[d]}`,class:hits[d]?'hit':''});bar.style.height=Math.max(8,hits[d]/max*100)+'%';return bar;}));
 const latest=[...tickets].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,recent);
 return el('div',{class:'tk-activity'},el('div',{class:'tk-eyebrow'},caption),spark,
  latest.length?el('ul',{class:'tk-feed'},latest.map(tk=>el('li',{},el('a',{href:'#items/'+tk.id},tk.id),' → ',el('span',{class:`tk-feed-st ${TONE[tk.status]||''}`},label(STATUSES(),tk.status).toLowerCase()),el('span',{class:'tk-dim'},' · '+ago(tk.updatedAt))))):null);
}
function nextBlock(releases,project){
 const next=nextRelease(releases,project);
 if(!next)return el('p',{class:'sec-dim tk-next'},t('Žádný naplánovaný release.'));
 const scope=next.total-next.counts.cancelled,d=due(next);
 return el('div',{class:`tk-next${d?.tone?' tk-due-'+d.tone:''}`},el('div',{class:'tk-next-head'},el('span',{class:'tk-eyebrow'},t('Další release')),el('a',{href:'#releases',class:'tk-version',onclick:()=>{releaseFilters.project=project;}},next.version),
   d?el('span',{class:`sec-pill tk-countdown ${d.tone}`,title:t('cíl {date}',{date:dayText(next.targetDate)})},d.text):null),progressBar(next.counts,scope));
}
async function projectsPage(wrap,ctx){
 const {canWrite}=ctx,data=await load(wrap,api('/api/tickets'));if(!data)return;
 const msg=status(),redraw=()=>projectsPage(wrap,ctx).catch(e=>fail(msg,e));
 const addProject=canWrite&&data.projects.length?{label:t('+ Nový projekt'),primary:true,onclick:()=>newProject(redraw)}:null;
 const title=head(t('Projekty'),t('Na čem se pracuje: stav položek, aktivita a nejbližší release každého projektu.'),[addProject],data.provenance);
 if(!data.projects.length)return show(wrap,title,noProjects(ctx,redraw));
 const allLabels=[...new Set(data.projects.flatMap(p=>p.labels||[]))].sort();
 if(projectsListFilters.label&&!allLabels.includes(projectsListFilters.label))allLabels.push(projectsListFilters.label);
 const select=(key,list,empty)=>el('select',{class:projectsListFilters[key]?'on':'','aria-label':empty,onchange:e=>{projectsListFilters[key]=e.target.value;redraw();}},options(list,projectsListFilters[key],empty));
 const narrowed=Boolean(projectsListFilters.type||projectsListFilters.label);
 const clear=narrowed?el('button',{type:'button',class:'acc-btn small tk-clear',onclick:()=>{projectsListFilters.type='';projectsListFilters.label='';redraw();}},t('Zrušit filtry')):null;
 const visible=data.projects.filter(p=>(!projectsListFilters.type||p.type===projectsListFilters.type)&&(!projectsListFilters.label||(p.labels||[]).includes(projectsListFilters.label)));
 const card=p=>{
  const mine=data.tickets.filter(x=>x.project===p.id);
  const v1Badge=p.projectVersion===1
   ?(canWrite?el('button',{type:'button',class:'sec-pill warn tk-upgrade-pill',onclick:e=>{e.stopPropagation();openUpgradeWizard(p,ctx,redraw);}},`v1 · ${t('Upgradovat')}`)
    :el('span',{class:'sec-pill warn'},'v1')):null;
  return el('section',{class:'acc-card tk-project-card','data-project-color':p.settings?.color,onclick:e=>{if(!e.target?.closest?.('a,button'))location.hash='#projects/'+p.id;}},
   el('div',{class:'tk-release-head'},el('div',{},el('h2',{class:'tk-project-name'},el('a',{href:'#projects/'+p.id},p.name)),
     el('div',{class:'tk-pills'},el('span',{class:'sec-pill'},p.key),p.type?el('span',{class:'sec-pill'},label(PROJECT_TYPES(),p.type)):null,v1Badge)),
    el('a',{class:'acc-btn small',href:settingsHref(p),'aria-label':t('Nastavení projektu {name}',{name:p.name})},'⚙ ',t('Nastavení'))),
   p.labels?.length?el('div',{class:'tk-labels'},p.labels.map(l=>el('span',{class:'tk-label'},l))):null,
   p.description?el('p',{class:'tk-text acc-dim'},p.description):null,
   mine.length?[health(mine),activity(mine,2),p.settings?.releases!==false?nextBlock(data.releases,p.id):null]
    :el('div',{class:'tk-fresh'},el('div',{class:'tk-fresh-icon','aria-hidden':'true'},'✨'),el('p',{},t('Čistý štít — zatím tu nic není.')),
      canWrite?el('button',{type:'button',class:'acc-btn small primary',onclick:e=>{e.stopPropagation();newTicket(data.projects,p.id,{...ctx,lockProject:true});}},t('+ První položka')):null),
   el('div',{class:'tk-links'},el('a',{href:'#projects/'+p.id,class:'acc-btn small'},`${t('Detail projektu')} →`),
    el('a',{href:'#projects/'+p.id+'/epics',class:'acc-btn small'},`${t('Epicy')} →`),
    el('a',{class:'acc-btn small',href:'#items',onclick:()=>{Object.assign(filters,defaults,{project:p.id});}},`${t('Položky')} →`),
    p.settings?.releases!==false?el('a',{class:'acc-btn small',href:'#releases',onclick:()=>{releaseFilters.project=p.id;}},`${t('Releasy')} →`):null,
    p.settings?.reviews!==false?el('a',{class:'acc-btn small',href:'#review/'+p.id},'Review →'):null));
 };
 const toolbar=el('div',{class:'tk-filters'},
  select('type',PROJECT_TYPES(),t('Všechny typy')),
  select('label',allLabels.map(l=>[l,'#'+l]),t('Všechny štítky')),clear);
 show(wrap,title,toolbar,msg,
  visible.length?el('div',{class:'tk-projects'},visible.map(card))
   :el('div',{class:'tk-none'},el('h2',{},t('Filtrům nic neodpovídá')),el('p',{class:'sec-dim'},t('Zkus ubrat filtr nebo vybrat jiný typ projektu.')),clear?el('button',{type:'button',class:'acc-btn',onclick:()=>{projectsListFilters.type='';projectsListFilters.label='';redraw();}},t('Zrušit filtry')):null));
 shortcuts(wrap,{n:()=>addProject?void addProject.onclick():false});
}
const settingsHref=(p,tab='')=>'#projects/'+p.id+'/settings'+(tab?'/'+tab:'');
const projectColors=()=>[['',t('Výchozí barva')],['slate',t('Břidlicová')],['red',t('Červená')],['orange',t('Oranžová')],['amber',t('Jantarová')],
 ['green',t('Zelená')],['teal',t('Tyrkysová')],['blue',t('Modrá')],['violet',t('Fialová')]];

// Epics -----------------------------------------------------------------------------------------
function epicCounts(epic,tickets){
 if(epic.counts&&typeof epic.counts==='object'){
  const open=epic.counts.open||0,doing=epic.counts['in-progress']||0,done=epic.counts.done||0,cancelled=epic.counts.cancelled||0;
  return {open,'in-progress':doing,done,cancelled,scope:open+doing+done,total:open+doing+done+cancelled};
 }
 const linked=tickets.filter(t=>t.epic===epic.id),c=statusCounts(linked);
 return {...c,scope:c.open+c['in-progress']+c.done,total:linked.length};
}

async function newEpic(project,meta,ctx,onCreated){
 const epoch=sessionEpoch;
 const peopleData=await api('/api/tickets/people').catch(()=>null);if(epoch!==sessionEpoch)return;
 const msg=status(),field=(text,...input)=>el('label',{},text,...input),keys=meta.projects.map(p=>p.key);
 const showRelease=project?.settings?.releases!==false;
 const releases=(meta.releases||[]).filter(r=>r.project===project.id&&r.status==='planned').map(r=>[r.version,r.version]);
 const assignee=assigneeInput('',peopleNames(peopleData),ctx.user);
 const inText={resolve:()=>null,project:()=>project.id,canGlobal:project?.settings?.globalReferences!==false&&ctx.me?.scopes?.includes('references:write'),canReference:ctx.me?.scopes?.includes('tickets:write')};
 const descField=el('textarea',{name:'description','aria-label':t('Popis'),rows:'3',maxlength:'2000',placeholder:t('Krátké shrnutí cíle epicu.')});
 const descEditor=mdEditor(descField,keys,{...inText,label:t('Popis')});
 const specField=el('textarea',{name:'spec','aria-label':t('Specifikace'),rows:'8',placeholder:t('Podrobný plán a specifikace (Markdown, až 64 kB).')});
 const specCounter=el('span',{class:'tk-dim tk-mono'},`0 / ${SPEC_MAX_BYTES} B`);
 const updateSpecBytes=()=>{const n=utf8Bytes(specField.value);specCounter.textContent=`${n} / ${SPEC_MAX_BYTES} B`;specCounter.classList.toggle('error',n>SPEC_MAX_BYTES);};
 specField.addEventListener('input',updateSpecBytes);
 const specEditor=mdEditor(specField,keys,{...inText,label:t('Specifikace'),maxBytes:SPEC_MAX_BYTES});
 specEditor.node.addEventListener('input',updateSpecBytes);
 const cancel=el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit'));
 const form=el('form',{class:'tk-form',onsubmit:async e=>{
  e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');
  msg.textContent='';msg.classList.remove('error');
  const title=f.title.value.trim(),spec=f.spec.value;
  if(!title){fail(msg,new Error(t('Název epicu je povinný.')));return;}
  if(utf8Bytes(spec)>SPEC_MAX_BYTES){fail(msg,new Error(t('Specifikace překračuje limit 64 kB.')));return;}
  let labels=[];
  try{labels=parseLabels(f.labels.value);}catch(err){fail(msg,err);return;}
  b.disabled=true;
  try{
   const body={project:project.id,title,description:f.description.value,spec,status:f.status.value,priority:f.priority.value,
    ...(showRelease?{release:f.release.value||null}:{}),assignee:f.assignee.value.trim()||null,labels};
   const made=await api('/api/tickets/epics/create',body,{maxBytes:131072});
   dialog.close();if(onCreated)await onCreated(made);else location.hash='#epics/'+made.id;
  }catch(err){fail(msg,err);b.disabled=false;}
 }},
  field(t('Název epicu'),el('input',{name:'title',required:'',maxlength:'200',autocomplete:'off'})),
  el('div',{class:'tk-grid3'},field(t('Stav'),el('select',{name:'status'},options(STATUSES(),'open'))),
   field(t('Priorita'),el('select',{name:'priority'},options(PRIORITIES(),'normal'))),
   showRelease?field('Release',el('select',{name:'release'},options(releases,'',t('Bez releasu')))):null),
  el('div',{class:'tk-grid2'},field(t('Řeší'),assignee.input,assignee.list),field(t('Štítky'),el('input',{name:'labels',placeholder:'ui, api, docs'}))),
  el('div',{class:'tk-editor-field'},t('Popis'),descEditor.node),mdHint(descEditor.toggle),
  el('div',{class:'tk-editor-field'},el('div',{class:'tk-field-head'},el('span',{},t('Specifikace')),specCounter),specEditor.node),mdHint(specEditor.toggle),
  msg,el('div',{class:'acc-actions'},cancel,el('button',{type:'submit',class:'acc-btn primary'},t('Založit epic'))));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog','aria-label':t('Nový epic')},el('h3',{},t('Nový epic')),form);
 showDialog(dialog);form.title.focus();
}

function renderEpicsTab(wrap,ctx,project,data,epics,redraw){
 const {canWrite}=ctx;
 if(!epicListFilters.has(project.id))epicListFilters.set(project.id,{status:'active',q:''});
 const local=epicListFilters.get(project.id);
 const msg=status();
 const add=canWrite?el('button',{type:'button',class:'acc-btn primary',onclick:()=>newEpic(project,data,ctx,made=>{location.hash='#epics/'+made.id;})},t('+ Nový epic')):null;
 const paint=()=>{
  const q=local.q.trim().toLowerCase();
  const filtered=epics.filter(ep=>{
   if(local.status==='active'&&!ACTIVE.includes(ep.status))return false;
   if(local.status&&local.status!=='active'&&ep.status!==local.status)return false;
   if(q&&!`${ep.id} ${ep.title} ${ep.description||''} ${(ep.labels||[]).join(' ')}`.toLowerCase().includes(q))return false;
   return true;
  });
  const narrowed=local.status!=='active'||Boolean(local.q);
  const clear=narrowed?el('button',{type:'button',class:'acc-btn small tk-clear',onclick:()=>{local.status='active';local.q='';paint();}},t('Zrušit filtry')):null;
  const statusSelect=el('select',{class:local.status?'on':'','aria-label':t('Všechny stavy'),onchange:e=>{local.status=e.target.value;paint();}},
   options([['active',t('Aktivní (otevřené + rozpracované)')],...STATUSES()],local.status,t('Všechny stavy')));
  const search=el('input',{type:'search',maxlength:'100','data-slash':'',value:local.q,placeholder:t('Hledat epicy (id, název, popis, štítek)'),'aria-label':t('Hledat epicy'),oninput:e=>{local.q=e.target.value;paint();}});
  const card=ep=>{
   const counts=epicCounts(ep,data.tickets);
   return el('article',{class:`acc-card tk-epic-card prio-${ep.priority||'normal'}`,onclick:e=>{if(!e.target?.closest?.('a,button'))location.hash='#epics/'+ep.id;}},
    el('div',{class:'tk-release-head'},
     el('div',{},
      el('div',{class:'tk-pills'},el('a',{class:'tk-card-id',href:'#epics/'+ep.id},ep.id),pill(STATUSES(),ep.status),pill(PRIORITIES(),ep.priority||'normal'),
       ep.release?el('span',{class:'tk-chip'},ep.release):null,ep.assignee?el('span',{class:'tk-dim tk-mono'},ep.assignee):null),
      el('h3',{class:'tk-epic-title'},el('a',{href:'#epics/'+ep.id},ep.title))),
     el('span',{class:'tk-dim tk-mono'},t('{done}/{scope} hotovo',{done:counts.done,scope:counts.scope}))),
    ep.description?el('p',{class:'tk-text acc-dim'},ep.description):null,
    ep.labels?.length?el('div',{class:'tk-labels'},ep.labels.map(l=>el('span',{class:'tk-label'},l))):null,
    progressBar(counts,counts.scope));
  };
  const body=!epics.length
   ?emptyState({icon:'◈',title:t('Zatím žádné epicy'),body:t('Epic sdružuje související položky, má vlastní specifikaci a sleduje jejich společný postup.'),
     actions:canWrite?[{label:t('+ Nový epic'),primary:true,onclick:()=>newEpic(project,data,ctx,made=>{location.hash='#epics/'+made.id;})}]:[]})
   :filtered.length?el('div',{class:'tk-epics-list'},filtered.map(card))
   :el('div',{class:'tk-none'},el('h2',{},t('Filtrům nic neodpovídá')),el('p',{class:'sec-dim'},t('Zkus ubrat filtr nebo hledat jinými slovy.')),clear);
  show(wrap,el('div',{class:'tk-toolbar'},el('div',{class:'tk-toolbar-left'},statusSelect,search,clear),add),msg,body);
 };
 paint();
}

function assignTicketsDialog(epic,projectTickets,onDone){
 const candidates=projectTickets.filter(tk=>tk.epic!==epic.id);
 const selected=new Set();
 const msg=status(),listBox=el('div',{class:'tk-assign-list'});
 const search=el('input',{type:'search',placeholder:t('Hledat položky podle ID nebo názvu'),'aria-label':t('Hledat položky')});
 const submit=el('button',{type:'submit',class:'acc-btn primary',disabled:''},t('Přiřadit vybrané'));
 const countLabel=el('span',{class:'sec-dim'},t('Vybráno: {n}',{n:0}));
 const updateCount=()=>{countLabel.textContent=t('Vybráno: {n}',{n:selected.size});submit.disabled=selected.size===0;};
 const drawList=()=>{
  const q=search.value.trim().toLowerCase();
  const matches=candidates.filter(tk=>!q||`${tk.id} ${tk.title} ${tk.status} ${(tk.labels||[]).join(' ')}`.toLowerCase().includes(q));
  if(!matches.length){listBox.replaceChildren(el('p',{class:'sec-dim'},t('Žádné odpovídající položky k přiřazení.')));return;}
  listBox.replaceChildren(...matches.map(tk=>el('label',{class:'tk-choice tk-assign-row'},
   el('input',{type:'checkbox',checked:selected.has(tk.id)?'':null,onchange:e=>{if(e.target.checked)selected.add(tk.id);else selected.delete(tk.id);updateCount();}}),
   el('span',{class:'tk-assign-text'},el('strong',{class:'tk-mono'},tk.id),' ',tk.title,' ',pill(STATUSES(),tk.status),
    tk.epic?el('span',{class:'sec-pill warn'},t('aktuálně v {epic}',{epic:tk.epic})):null))));
 };
 search.addEventListener('input',drawList);
 drawList();
 const form=el('form',{class:'tk-form',onsubmit:async e=>{
  e.preventDefault();if(!selected.size)return;
  submit.disabled=true;msg.textContent='';msg.classList.remove('error');
  const tickets=[...selected].map(id=>{const tk=candidates.find(x=>x.id===id);return {id:tk.id,rev:tk.rev};});
  try{
   await api(`/api/tickets/epics/${encodeURIComponent(epic.id)}/assign`,{tickets});
   dialog.close();await onDone?.();
  }catch(err){
   fail(msg,err);submit.disabled=selected.size===0;
   if(err.status===409)msg.append(' ',el('button',{type:'button',class:'acc-btn small',onclick:()=>{dialog.close();onDone?.();}},t('Načíst znovu')));
  }
 }},el('p',{class:'sec-dim'},t('Vyber existující položky projektu, které chceš přesunout do epicu {id}.',{id:epic.id})),
  search,listBox,msg,el('div',{class:'acc-actions'},countLabel,el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),submit));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog','aria-label':t('Přiřadit existující položky')},el('h3',{},t('Přiřadit existující položky')),form);
 showDialog(dialog);search.focus();
}

function deleteEpicDialog(epic,linkedCount,onDeleted){
 const msg=status();
 const submit=el('button',{type:'submit',class:'acc-btn danger'},t('Smazat epic'));
 const form=el('form',{class:'tk-form',onsubmit:async e=>{
  e.preventDefault();submit.disabled=true;msg.textContent='';msg.classList.remove('error');
  try{
   await api('/api/tickets/epics/delete',{id:epic.id,rev:epic.rev});
   dialog.close();onDeleted?.();
  }catch(err){fail(msg,err);submit.disabled=false;}
 }},el('p',{},t('Smazání epicu {id} ({title}) odstraní samotný epic a odpojí jeho položky ({n}). Položky samotné zůstanou zachovány.',{id:epic.id,title:epic.title,n:linkedCount})),
  msg,el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),submit));
 const dialog=el('dialog',{class:'acc-dialog tk-dialog','aria-label':t('Smazat epic')},el('h3',{},t('Smazat epic')),form);
 showDialog(dialog);
}

async function epicPage(wrap,ctx){
 const first=await load(wrap,Promise.all([
  api('/api/tickets/epics/'+encodeURIComponent(ctx.id)),
  api('/api/tickets/people').catch(()=>null),
 ]));
 if(!first)return;
 const [epic,people]=first;
 const second=await load(wrap,Promise.all([
  api('/api/tickets?project='+encodeURIComponent(epic.project)+'&limit=200'),
  api('/api/review?project='+encodeURIComponent(epic.project)+'&status=all').catch(()=>null),
 ]));
 if(!second)return;
 const [meta,reviews]=second;
 const referenceLinks=referencesSection('epic',epic.id,ctx.me);
 renderEpic(wrap,{...ctx,meta,referenceLinks,reviews:Array.isArray(reviews?.sets)?reviews.sets:[],people:peopleNames(people)},epic,{editing:false,doneWarning:false});
}

function renderEpic(wrap,ctx,epic,state={}){
 const {canWrite,meta,user}=ctx,project=meta.projects.find(p=>p.id===epic.project),keys=meta.projects.map(p=>p.key);
 const msg=status();
 if(state.notice){msg.textContent=state.notice;if(state.noticeError)msg.classList.add('error');}
 const projectTickets=(meta.tickets||[]).filter(tk=>tk.project===epic.project);
 const linkedTickets=projectTickets.filter(tk=>tk.epic===epic.id);
 const counts=epicCounts(epic,projectTickets);
 const openCount=linkedTickets.filter(tk=>ACTIVE.includes(tk.status)).length;
 const reloadEpic=()=>epicPage(wrap,ctx).catch(e=>fail(msg,e));
 const write=async(button,request,nextState={})=>{
  if(button)button.disabled=true;const epoch=sessionEpoch;let updated;
  try{updated=await request();}catch(e){if(wrap.isConnected){fail(msg,e);if(button)button.disabled=false;}return;}
  if(epoch!==sessionEpoch||!wrap.isConnected)return;
  renderEpic(wrap,ctx,updated,{...state,...nextState,notice:t('Uloženo.')});
 };
 const save=(change,button,fromEdit=false)=>{
  const warnDone=change.status==='done'&&openCount>0;
  return write(button,()=>api('/api/tickets/epics/update',{id:epic.id,rev:epic.rev,...change},{maxBytes:131072}),{editing:fromEdit?false:state.editing,doneWarning:warnDone||(state.doneWarning&&change.status!=='open'&&change.status!=='in-progress')});
 };
 const editing=canWrite&&state.editing===true;
 const files=(epic.attachments||[]).map(a=>({...savedEpicFile(epic.id,a),note:`${a.by} · ${ago(a.at)}`}));
 const removed=new Set((epic.history||[]).filter(h=>h.field==='attachment'&&h.to===null).map(h=>h.from));
 const resolve=name=>files.find(f=>f.name===name)||(removed.has(name)?{name,gone:true}:null);
 const viewFile=item=>{const i=files.indexOf(item);if(i>=0)openViewer(files,i,showDialog);};
 const inText={resolve,onOpen:viewFile,project:()=>epic.project,canGlobal:project?.settings?.globalReferences!==false&&ctx.me?.scopes?.includes('references:write'),canReference:ctx.me?.scopes?.includes('tickets:write')},chips=chipsOf(inText);
 const uploadEpicFiles=async list=>{
  for(const file of list){
   const problem=fileProblem(file,files.length);if(problem){fail(msg,new Error(problem));continue;}
   const name=attachmentName(file,files.map(f=>f.name));
   msg.classList.remove('error');msg.textContent=t('Nahrávám {name}…',{name});
   try{
    const updated=await uploadFile(epic.id,name,file,`/api/tickets/epics/${encodeURIComponent(epic.id)}/attachments`);
    if(wrap.isConnected)return renderEpic(wrap,ctx,updated,{...state,notice:t('Uloženo.')});
   }catch(err){fail(msg,err);}
  }
 };
 const filePicker=canWrite?el('input',{type:'file',multiple:'',hidden:'','aria-label':t('+ Přidat soubor'),onchange:e=>{const list=[...e.target.files];e.target.value='';uploadEpicFiles(list);}}):null;
 const removeFile=(item,button)=>{
  if(!confirm(t('Odebrat přílohu {name}?',{name:item.name})))return;
  write(button,()=>api('/api/tickets/epics/attachments/delete',{id:epic.id,attachment:item.id}));
 };
 const attachBlock=files.length||canWrite?[el('hr',{class:'tk-divider'}),el('div',{class:'tk-attach'},
  el('div',{class:'tk-attach-head'},el('h4',{},t('Přílohy ({n})',{n:files.length})),canWrite?el('button',{type:'button',class:'acc-btn small',onclick:()=>filePicker.click()},t('+ Přidat soubor')):null,filePicker),
  files.length?fileStrip(files,{onOpen:i=>openViewer(files,i,showDialog),onRemove:canWrite?removeFile:null}):null,canWrite?attachHint():null)]:null;

 const quick=[];
 if(canWrite){
  const b=(text,next,cls='')=>el('button',{type:'button',class:`acc-btn small ${cls}`,onclick:e=>save({status:next},e.currentTarget)},text);
  if(epic.status==='open')quick.push(b(`▶ ${t('Začít')}`,'in-progress'));
  if(ACTIVE.includes(epic.status))quick.push(b(`✓ ${t('Hotovo')}`,'done','primary'),b(t('Zrušit epic'),'cancelled'));
  if(CLOSED.includes(epic.status))quick.push(b(`↺ ${t('Znovu otevřít')}`,'open'));
  if(!editing)quick.push(el('button',{type:'button',class:'acc-btn small tk-edit-open','aria-keyshortcuts':'e',onclick:()=>renderEpic(wrap,ctx,epic,{...state,editing:true})},`✎ ${t('Upravit')}`));
  quick.push(el('button',{type:'button',class:'acc-btn small danger',onclick:()=>deleteEpicDialog(epic,linkedTickets.length,()=>{location.hash='#projects/'+epic.project+'/epics';})},t('Smazat epic')));
 }

 const doneNotice=state.doneWarning&&epic.status==='done'&&openCount>0
  ?banner({tone:'warn',title:t('Epic je označený jako hotový, ale má ještě nedokončené položky.'),
   body:t('Zbývá {n} otevřených nebo rozpracovaných položek. Změna stavu epicu stav jeho položek nemění.',{n:openCount})}):null;

 let main;
 if(editing){
  const field=(text,input,...more)=>el('label',{},text,input,...more);
  const showRelease=project?.settings?.releases!==false;
  const releases=(meta.releases||[]).filter(r=>r.project===epic.project&&(r.status==='planned'||r.version===epic.release)).map(r=>[r.version,r.status==='released'?t('{version} (vydáno)',{version:r.version}):r.version]);
  const assignee=assigneeInput(epic.assignee,ctx.people||[],ctx.user);
  const descArea=el('textarea',{name:'description','aria-label':t('Popis'),rows:'4',maxlength:'2000'});descArea.value=epic.description||'';
  const descEd=mdEditor(descArea,keys,{...inText,label:t('Popis')});
  const specArea=el('textarea',{name:'spec','aria-label':t('Specifikace'),rows:'10'});specArea.value=epic.spec||'';
  const specCounter=el('span',{class:'tk-dim tk-mono'},`${utf8Bytes(specArea.value)} / ${SPEC_MAX_BYTES} B`);
  const updateSpecBytes=()=>{const n=utf8Bytes(specArea.value);specCounter.textContent=`${n} / ${SPEC_MAX_BYTES} B`;specCounter.classList.toggle('error',n>SPEC_MAX_BYTES);};
  specArea.addEventListener('input',updateSpecBytes);
  const specEd=mdEditor(specArea,keys,{...inText,label:t('Specifikace'),maxBytes:SPEC_MAX_BYTES});
  specEd.node.addEventListener('input',updateSpecBytes);
  main=el('form',{class:'acc-card tk-form tk-edit','aria-label':t('Upravit epic {id}',{id:epic.id}),onsubmit:e=>{
   e.preventDefault();const f=e.currentTarget;
   if(utf8Bytes(f.spec.value)>SPEC_MAX_BYTES){fail(msg,new Error(t('Specifikace překračuje limit 64 kB.')));return;}
   let labels=[];
   try{labels=parseLabels(f.labels.value);}catch(err){fail(msg,err);return;}
   const values={title:f.title.value.trim(),description:f.description.value,spec:f.spec.value,status:f.status.value,priority:f.priority.value,
    ...(showRelease?{release:f.release.value||null}:{}),assignee:f.assignee.value.trim()||null,labels,
    refs:[...new Set(f.refs.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))]};
   const changed=Object.fromEntries(Object.entries(values).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(epic[k]??(k==='labels'||k==='refs'?[]:k==='description'||k==='spec'?'':null))));
   if(Object.keys(changed).length)return save(changed,f.querySelector('button[type=submit]'),true);
   renderEpic(wrap,ctx,epic,{...state,editing:false});
  }},
   el('h3',{},t('Upravit')),
   field(t('Název epicu'),el('input',{name:'title',required:'',maxlength:'200',value:epic.title})),
   el('div',{class:'tk-grid3'},field(t('Stav'),el('select',{name:'status'},options(STATUSES(),epic.status))),
    field(t('Priorita'),el('select',{name:'priority'},options(PRIORITIES(),epic.priority||'normal'))),
    showRelease?field('Release',el('select',{name:'release'},options(releases,epic.release||'',t('Bez releasu')))):null),
   field(t('Řeší'),assignee.input,assignee.list),assignee.mine,
   field(t('Štítky (čárkou)'),el('input',{name:'labels',value:(epic.labels||[]).join(', ')})),
   field(t('Odkazy (commit, PR, položka; každý na vlastní řádek)'),(()=>{const a=el('textarea',{name:'refs',rows:'2'});a.value=(epic.refs||[]).join('\n');return a;})()),
   el('div',{class:'tk-editor-field'},t('Popis'),descEd.node),mdHint(descEd.toggle),
   el('div',{class:'tk-editor-field'},el('div',{class:'tk-field-head'},el('span',{},t('Specifikace')),specCounter),specEd.node),mdHint(specEd.toggle),
   attachBlock,
   el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>renderEpic(wrap,ctx,epic,{...state,editing:false})},t('Zrušit úpravy')),
    el('button',{type:'submit',class:'acc-btn primary'},t('Uložit změny'))));
 }else{
  main=el('div',{class:'acc-stack'},
   el('section',{class:'acc-card tk-desc'},el('h3',{},t('Popis')),epic.description?markdown(epic.description,{keys,files:chips,references:true}):el('p',{class:'acc-dim'},t('Bez popisu.'))),
   el('section',{class:'acc-card tk-desc'},el('h3',{},t('Specifikace')),epic.spec?markdown(epic.spec,{keys,files:chips,references:true}):el('p',{class:'acc-dim'},t('Zatím bez specifikace.')),attachBlock));
 }

 const linkedIds=new Set(linkedTickets.map(tk=>tk.id));
 const linkedTicketRows=linkedTickets.length?el('ul',{class:'tk-mini tk-epic-tickets'},linkedTickets.map(tk=>
  el('li',{class:CLOSED.includes(tk.status)?'tk-closed':''},
   glyph(tk.type),el('a',{href:'#items/'+tk.id},tk.id),el('span',{class:'tk-mini-title'},tk.title),
   pill(PRIORITIES(),tk.priority),pill(STATUSES(),tk.status),
   canWrite?el('button',{type:'button',class:'tk-qa',title:t('Odebrat z epicu'),'aria-label':t('Odebrat {id} z epicu',{id:tk.id}),onclick:async e=>{
    const b=e.currentTarget;b.disabled=true;
    try{await api('/api/tickets/update',{id:tk.id,rev:tk.rev,epic:null});await reloadEpic();}catch(err){fail(msg,err);b.disabled=false;}
   }},'×'):null)))
  :el('p',{class:'acc-dim'},t('K tomuto epicu zatím nejsou přiřazené žádné položky.'));

 const linkedSection=el('section',{class:'acc-card'},
  el('div',{class:'tk-release-head'},el('h3',{},t('Propojené položky ({n})',{n:linkedTickets.length})),
   canWrite?el('div',{class:'tk-quick'},
    el('button',{type:'button',class:'acc-btn small primary',onclick:()=>newTicket(meta.projects,epic.project,{...ctx,lockProject:true,presetEpic:epic.id,epics:[epic],onCreated:()=>reloadEpic()})},t('+ Nová položka v tomto epicu')),
    el('button',{type:'button',class:'acc-btn small',onclick:()=>assignTicketsDialog(epic,projectTickets,reloadEpic)},t('+ Přiřadit existující položky'))):null),
  progressBar(counts,counts.scope),
  el('p',{class:'sec-dim'},`${t('{done}/{scope} hotovo',{done:counts.done,scope:counts.scope})} · ${t('otevřené: {n}',{n:counts.open})} · ${t('rozpracované: {n}',{n:counts['in-progress']})}`),
  linkedTicketRows);

 const linkedReviews=(ctx.reviews||[]).filter(s=>Array.isArray(s.tickets)&&s.tickets.some(tid=>linkedIds.has(tid)));
 const reviewSection=project?.settings?.reviews!==false||linkedReviews.length?el('section',{class:'acc-card'},
  el('h3',{},t('Propojená Review ({n})',{n:linkedReviews.length})),
  linkedReviews.length?el('ul',{class:'tk-mini'},linkedReviews.map(s=>el('li',{},
   el('a',{href:'#review/'+s.id},`${s.id} · ${s.title}`),
   s.feedbackPending?el('span',{class:'sec-pill warn'},t('čeká na agenta')):null,
   el('span',{class:'tk-dim tk-mono'},s.tickets.filter(tid=>linkedIds.has(tid)).join(', ')))))
   :el('p',{class:'acc-dim'},t('Žádné review není navázané na položky tohoto epicu.'))):null;

 const commentBox=canWrite?el('textarea',{name:'text',rows:'3',required:'',maxlength:'8000',placeholder:t('Komentář, postup, rozhodnutí…'),'aria-label':t('Nový komentář')}):null;
 const commentEditor=commentBox?mdEditor(commentBox,keys,inText):null;
 const comments=el('section',{class:'acc-card'},el('h3',{},t('Komentáře ({n})',{n:(epic.comments||[]).length})),
  (epic.comments||[]).length?el('ol',{class:'tk-comments'},epic.comments.map(c=>el('li',{class:'tk-comment'},
   el('div',{class:'tk-comment-head'},el('span',{class:'tk-avatar','aria-hidden':'true'},initials(c.by)||'?'),el('b',{},c.by),el('span',{class:'tk-dim',title:when(c.at)},ago(c.at))),
   markdown(c.text,{keys,files:chips,references:true})))):el('p',{class:'acc-dim'},t('Zatím bez komentářů.')),
  canWrite?el('form',{class:'tk-form',onsubmit:e=>{e.preventDefault();const f=e.currentTarget,text=f.text.value;if(!text.trim()){commentEditor.editor?.focusAt(null);return;}
   return write(f.querySelector('button[type=submit]'),()=>api('/api/tickets/epics/comment',{id:epic.id,text}));}},
   commentEditor.node,el('div',{class:'acc-actions tk-comment-actions'},mdHint(commentEditor.toggle),el('button',{type:'submit',class:'acc-btn'},t('Přidat komentář')))):null);

 const fact=(k,v)=>[el('dt',{},k),el('dd',{},v)];
 const assignMe=canWrite&&user&&epic.assignee!==user&&!CLOSED.includes(epic.status)?el('button',{type:'button',class:'tk-inline-btn',onclick:e=>save({assignee:user},e.currentTarget)},t('Vezmu si to')):null;
 const sep=()=>el('span',{class:'tk-dim'},'/');
 show(wrap,
  el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},
   el('a',{href:'#projects'},t('Projekty')),sep(),
   el('a',{href:'#projects/'+encodeURIComponent(epic.project)},project?.name||epic.project),sep(),
   el('a',{href:'#projects/'+encodeURIComponent(epic.project)+'/epics'},t('Epicy')),sep(),
   el('b',{},epic.id)),
  el('div',{class:'tk-head'},el('div',{},el('div',{class:'tk-mono tk-dim'},`${epic.id} · ${project?.name||epic.project}`),
    el('div',{class:'ui-title'},el('h1',{class:'tk-title'},epic.title),provenanceBadge(epic.provenance)),
    el('div',{class:'tk-pills'},pill(STATUSES(),epic.status),pill(PRIORITIES(),epic.priority||'normal'),
     (epic.labels||[]).map(l=>el('span',{class:'tk-label'},l)))),
   el('div',{class:'tk-quick'},quick)),
  doneNotice,msg,
  el('div',{class:'tk-detail'},
   el('div',{class:'acc-stack'},main,linkedSection,reviewSection,ctx.referenceLinks,comments,timeline(epic,'epic')),
   el('div',{class:'acc-stack'},
    el('section',{class:'acc-card'},el('h3',{},t('Údaje')),el('dl',{class:'acc-dl'},
     project?.settings?.releases!==false||epic.release?fact('Release',epic.release?el('a',{class:'sys-link',href:'#releases',onclick:()=>{releaseFilters.project=epic.project;}},epic.release):'—'):null,
     fact(t('Řeší'),el('span',{class:'tk-fact-row'},epic.assignee?[el('span',{class:'tk-avatar','aria-hidden':'true'},initials(epic.assignee)),epic.assignee]:'—',assignMe)),
     fact(t('Nahlásil'),epic.reporter||'—'),
     fact(t('Odkazy'),(epic.refs||[]).length?el('div',{class:'tk-refs'},epic.refs.map(r=>/^https?:\/\//.test(r)?el('a',{href:r,target:'_blank',rel:'noopener noreferrer',class:'sys-link'},r):EPIC_ID.test(r)?el('a',{href:'#epics/'+r,class:'sys-link'},r):TICKETISH.test(r)?el('a',{href:'#items/'+r,class:'sys-link'},r):el('code',{},r))):'—'),
     fact(t('Založeno'),when(epic.createdAt)),fact(t('Změněno'),when(epic.updatedAt)),...(epic.closedAt?fact(t('Uzavřeno'),when(epic.closedAt)):[]),fact(t('Revize'),String(epic.rev)))))));
 shortcuts(wrap,{e:()=>canWrite&&!editing?void renderEpic(wrap,ctx,epic,{...state,editing:true}):false});
}

// Project page ----------------------------------------------------------------------------------
async function projectPage(wrap,ctx){
 const {canWrite,id}=ctx,encoded=encodeURIComponent(id);
 const [route,routeId,section,tab,...extra]=location.hash.split('?')[0].split('/');
 const sameProject=route==='#projects'&&routeId===id;
 const settings=sameProject&&section==='settings';
 const epicsSection=sameProject&&section==='epics'&&tab===undefined&&!extra.length;
 if(sameProject&&section!==undefined&&!epicsSection&&(!settings||extra.length||tab!==undefined&&!['look','features','references'].includes(tab)))
  throw Object.assign(new Error(t('Stránka nastavení neexistuje.')),{status:404});
 const result=await load(wrap,Promise.all([
  api('/api/tickets?project='+encoded+(settings?'&limit=1':'')).catch(e=>{if(e.status===400)e.status=404;throw e;}),
  settings?null:wikiApi(wikiApiPath(encoded)).catch(()=>null),
  settings?null:api('/api/tickets/epics?project='+encoded).catch(()=>({epics:[]})),
 ]));if(!result)return;
 const [data,wiki,epicsData]=result,p=data.projects.find(x=>x.id===id);
 if(!p){const e=new Error(t('Projekt „{id}“ v trackeru není.',{id}));e.status=404;throw e;}
 if(settings)return renderProjectSettings(wrap,ctx,p,tab);
 const epics=Array.isArray(epicsData?.epics)?epicsData.epics:(Array.isArray(data.epics)?data.epics:[]);
 const msg=status(),redraw=()=>projectPage(wrap,ctx).catch(e=>fail(msg,e));
 const mine=data.tickets.filter(x=>x.project===id);
 const newItem=()=>newTicket(data.projects,id,{...ctx,lockProject:true,epics});
 const add=canWrite?{label:t('+ Nová položka'),primary:true,onclick:newItem}:null;
 const wikiAction=wiki?.enabled===false?(ctx.canWriteWiki?setupWikiAction(id,error=>fail(msg,error)):null):{label:'Wiki →',href:wikiHref(wiki?.id||id)};
 const tabWrap=el('div',{class:'tk-project-table'});
 const afterMove=async(previousControl)=>{
  const active=document.activeElement;
  const focus=active===document.body&&previousControl?previousControl:active;
  const wasInside=tabWrap.contains(focus),label=wasInside?focus.getAttribute('aria-label'):null;
  await redraw();
  if(!wasInside||!wrap.isConnected||document.activeElement!==document.body)return;
  const restored=label?[...wrap.querySelectorAll('.tk-project-table [aria-label]')].find(node=>node.getAttribute('aria-label')===label):null;
  (restored??wrap.querySelector('.tk-project-table [data-slash]'))?.focus();
 };
 const header=pageHeader({title:p.name,lead:p.description||undefined,provenance:data.provenance,actions:[
  {label:'⚙ '+t('Nastavení projektu'),href:settingsHref(p)},
  p.settings?.releases!==false?{label:t('Releasy')+' →',onclick:()=>{releaseFilters.project=id;location.hash='#releases';}}:null,
  p.settings?.reviews!==false?{label:'Review →',href:'#review/'+id}:null,p.settings?.wiki!==false?wikiAction:null,add]});
 const v1Banner=p.projectVersion===1?banner({tone:'info',title:t('Tento projekt je ve verzi v1.'),
  body:t('Projekt můžeš dál normálně používat, nebo ho průvodcem převést na v2.'),
  actions:canWrite?[{label:t('Spustit průvodce upgradem'),primary:true,onclick:()=>openUpgradeWizard(p,ctx,redraw)}]:[]}):null;
 const sectionTabs=el('nav',{class:'tk-settings-tabs','aria-label':t('Sekce projektu')},
  el('a',{href:'#projects/'+p.id,'aria-current':!epicsSection?'page':null},t('Položky')),
  el('a',{href:'#projects/'+p.id+'/epics','aria-current':epicsSection?'page':null},t('Epicy')));
 show(wrap,
  el('nav',{class:'tk-crumbs','aria-label':t('Drobečková navigace')},el('a',{href:'#projects'},t('Projekty')),el('span',{class:'tk-dim'},'/'),el('b',{},p.name),el('span',{class:'sec-pill'},p.key),
   p.type?el('span',{class:'sec-pill'},label(PROJECT_TYPES(),p.type)):null,
   ...(p.labels||[]).map(l=>el('span',{class:'tk-label'},l))),
  v1Banner,
  el('div',{class:'tk-project-header','data-project-color':p.settings?.color},header),msg,
  referencesSection('project',id,ctx.me),
  mine.length?el('div',{class:'acc-card tk-hero-row'},health(mine),activity(mine,4),p.settings?.releases!==false?nextBlock(data.releases,id):null):null,
  sectionTabs,
  tabWrap);
 if(epicsSection)return renderEpicsTab(tabWrap,ctx,p,data,epics,redraw);
 if(!projectFilters.has(id))projectFilters.set(id,{...defaults,project:id});
 await listPage(tabWrap,{...ctx,afterMove,epics},p,data);
}

// Project deletion dialog -----------------------------------------------------------------------
function deleteProjectDialog(p,ctx){
 const canDeleteReviews=ctx.me?.canWrite===true&&(!ctx.me.scopes||ctx.me.scopes.includes('review:write'));
 const canPromoteRefs=ctx.me?.canWrite===true&&(!ctx.me.scopes||ctx.me.scopes.includes('references:write'));
 const body=el('div',{class:'tk-form'},el('p',{class:'sec-dim',role:'status'},t('Načítám…')));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog','aria-label':t('Smazat projekt')},el('h3',{},t('Smazat projekt {name}',{name:p.name})),body);
 showDialog(dialog);

 async function loadPreview(){
  body.replaceChildren(el('p',{class:'sec-dim',role:'status'},t('Načítám…')));
  const epoch=sessionEpoch;
  let preview;
  try{preview=await api(`/api/tickets/projects/${encodeURIComponent(p.id)}/delete-preview`);}
  catch(err){
   if(epoch!==sessionEpoch||!dialog.open)return;
   body.replaceChildren(el('p',{class:'acc-status error',role:'alert'},err.message),
    el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zavřít')),
     el('button',{type:'button',class:'acc-btn primary',onclick:loadPreview},t('Zkusit znovu'))));
   return;
  }
  if(epoch!==sessionEpoch||!dialog.open)return;
  const counts=preview.counts||{epics:0,tickets:0,releases:0,wikiPages:0,reviewSets:0,localReferences:0};
  const collisions=Array.isArray(preview.collisions)?preview.collisions:[];
  const msg=status();
  const wikiCheck=counts.wikiPages>0?el('input',{type:'checkbox',name:'deleteWiki'}):null;
  const reviewCheck=counts.reviewSets>0?el('input',{type:'checkbox',name:'deleteReviews',disabled:canDeleteReviews?null:''}):null;
  const promoteCheck=counts.localReferences>0?el('input',{type:'checkbox',name:'promoteReferences',checked:canPromoteRefs?'':null,disabled:canPromoteRefs?null:''}):null;
  const collisionBox=el('div',{});
  const paintCollisions=()=>{
   if(collisions.length&&promoteCheck?.checked){
    collisionBox.replaceChildren(banner({tone:'warn',title:t('Kolize názvů globálních referencí'),
     body:t('Tyto lokální reference se při povýšení automaticky přejmenují: {list}',{list:collisions.map(c=>`${c.label} → ${c.newLabel}`).join(', ')})}));
   }else collisionBox.replaceChildren();
  };
  promoteCheck?.addEventListener('change',paintCollisions);
  paintCollisions();
  const confirmInput=el('input',{name:'confirmation',autocomplete:'off',placeholder:`${p.key} / ${p.name}`});
  const submit=el('button',{type:'submit',class:'acc-btn danger',disabled:''},t('Trvale smazat projekt'));
  const matches=()=>confirmInput.value.trim()===p.key||confirmInput.value.trim()===p.name;
  confirmInput.addEventListener('input',()=>{submit.disabled=!matches();});
  const summary=el('ul',{class:'tk-delete-counts'},
   el('li',{},t('Epicy: {n}',{n:counts.epics||0})),
   el('li',{},t('Položky: {n}',{n:counts.tickets||0})),
   el('li',{},t('Releasy: {n}',{n:counts.releases||0})));
  const optionsBox=[];
  if(wikiCheck){
   optionsBox.push(el('label',{class:'tk-choice'},wikiCheck,el('span',{},
    el('strong',{},t('Smazat wiki ({n} stránek)',{n:counts.wikiPages})),
    el('small',{},t('Bez zaškrtnutí se wiki odpojí jako samostatná wiki a všechny stránky zůstanou zachovány.')))));
  }
  if(reviewCheck){
   optionsBox.push(el('label',{class:'tk-choice'},reviewCheck,el('span',{},
    el('strong',{},t('Smazat sady Review ({n})',{n:counts.reviewSets})),
    el('small',{},canDeleteReviews
     ?t('Bez zaškrtnutí se sady odpojí do sekce Bez projektu (jen pro čtení).')
     :t('Vyžaduje oprávnění review:write. Sady se místo smazání odpojí do sekce Bez projektu.')))));
  }
  if(promoteCheck){
   optionsBox.push(el('label',{class:'tk-choice'},promoteCheck,el('span',{},
    el('strong',{},t('Povýšit lokální reference na globální ({n})',{n:counts.localReferences})),
    el('small',{},canPromoteRefs
     ?t('Zachová ID i odkazy @ zmínek. Bez zaškrtnutí budou lokální reference projektu smazány.')
     :t('Vyžaduje oprávnění references:write. Lokální reference projektu budou smazány.')))));
  }
  const form=el('form',{class:'tk-form',onsubmit:async e=>{
   e.preventDefault();if(!matches())return;
   submit.disabled=true;msg.textContent='';msg.classList.remove('error');
   const payload={id:preview.id??p.id,rev:preview.rev??p.rev,confirmation:confirmInput.value.trim(),snapshot:preview.snapshot,
    ...(wikiCheck?{deleteWiki:wikiCheck.checked}:{}),
    ...(reviewCheck?{deleteReviews:reviewCheck.checked}:{}),
    ...(promoteCheck?{promoteReferences:promoteCheck.checked}:{})};
   try{
    const result=await api('/api/tickets/projects/delete',payload);
    projectFilters.delete(p.id);
    if(filters.project===p.id)filters.project='';
    if(releaseFilters.project===p.id)releaseFilters.project='';
    notifyWikiNavigation(p.id,true);
    dialog.close();
    const renamed=Array.isArray(result?.renamedReferences)?result.renamedReferences:[];
    if(renamed.length)toast.good(t('Projekt smazán. Přejmenované reference: {list}',{list:renamed.map(r=>`${r.label} → ${r.newLabel}`).join(', ')}));
    else toast.good(t('Projekt „{name}“ byl smazán.',{name:p.name}));
    location.hash='#projects';
   }catch(err){
    fail(msg,err);submit.disabled=!matches();
    if(err.status===409)msg.append(' ',el('button',{type:'button',class:'acc-btn small',onclick:loadPreview},t('Načíst znovu náhled')));
   }
  }},
   el('p',{},t('Smazání projektu vždy trvale odstraní projekt, všechny jeho epicy, položky, releasy a poznámky k referencím.')),
   summary,
   optionsBox.length?el('fieldset',{class:'tk-settings-fields'},el('legend',{},t('Propojené položky')),optionsBox):null,
   collisionBox,
   el('label',{},t('Pro potvrzení napiš zkratku ({key}) nebo název ({name}) projektu',{key:p.key,name:p.name}),confirmInput),
   msg,
   el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),submit));
  body.replaceChildren(form);
  confirmInput.focus();
 }
 loadPreview();
}

// Guided v1 → v2 Upgrade Wizard -----------------------------------------------------------------
function openUpgradeWizard(p,ctx,onDone){
 const body=el('div',{class:'tk-form'},el('p',{class:'sec-dim',role:'status'},t('Načítám…')));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog tk-wizard','aria-label':t('Průvodce upgradem projektu')},
  el('h3',{},t('Upgrade projektu {name} na v2',{name:p.name})),body);
 showDialog(dialog);

 async function start(){
  const epoch=sessionEpoch;
  let ticketData,wikiData,reviewData,refData;
  try{
   [ticketData,wikiData,reviewData,refData]=await Promise.all([
    api('/api/tickets?project='+encodeURIComponent(p.id)+'&limit=200'),
    wikiApi(wikiApiPath(encodeURIComponent(p.id))).catch(()=>({enabled:false,pages:[]})),
    api('/api/review?project='+encodeURIComponent(p.id)+'&status=all').catch(()=>({sets:[]})),
    api('/api/references?'+new URLSearchParams({scope:'local',project:p.id,kind:'custom',limit:'100'})).catch(()=>({items:[],total:0})),
   ]);
  }catch(err){
   if(epoch!==sessionEpoch||!dialog.open)return;
   body.replaceChildren(el('p',{class:'acc-status error',role:'alert'},err.message),
    el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zavřít'))));
   return;
  }
  if(epoch!==sessionEpoch||!dialog.open)return;
  const freshProject=ticketData.projects?.find(x=>x.id===p.id)||p;
  const tickets=(ticketData.tickets||[]).filter(tk=>tk.project===p.id);
  const wikiEnabled=wikiData?.enabled===true;
  const wikiPages=Array.isArray(wikiData?.pages)?wikiData.pages:[];
  const homePage=wikiPages.find(pg=>pg.id===wikiData?.home);
  const offerRenameHome=Boolean(wikiEnabled&&homePage?.title==='Home');
  const reviewSets=Array.isArray(reviewData?.sets)?reviewData.sets:[];
  const localRefs=Array.isArray(refData?.items)?refData.items:[];
  const localRefTotal=refData?.total??localRefs.length;

  const steps=['profile','linked',...(localRefTotal>0?['references']:[]),'epics'];
  const state={
   step:0,
   type:freshProject.type||'',
   labelsText:(freshProject.labels||[]).join(', '),
   wiki:freshProject.settings?.wiki!==false,
   reviews:freshProject.settings?.reviews!==false,
   renameWikiHome:offerRenameHome,
   createEpics:false,
   epics:[{title:'',description:'',spec:'',ticketIds:[]}],
  };
  const msg=status();

  function draw(){
   msg.textContent='';msg.classList.remove('error');
   const current=steps[state.step],stepLabel=t('Krok {i} z {n}',{i:state.step+1,n:steps.length});
   const content=el('div',{class:'tk-form'});
   if(current==='profile'){
    const typeSel=el('select',{name:'type',onchange:e=>{state.type=e.target.value;}},options(PROJECT_TYPES(),state.type,t('Bez typu')));
    const labelsIn=el('input',{name:'labels',value:state.labelsText,placeholder:'web, core, internal',oninput:e=>{state.labelsText=e.target.value;}});
    content.append(el('h4',{},t('1. Profil projektu')),
     el('p',{class:'sec-dim'},t('Zkontroluj typ projektu (nově včetně typu Web) a volitelně přidej štítky projektu.')),
     el('label',{},t('Typ'),typeSel),
     el('label',{},t('Štítky (čárkou)'),labelsIn));
   }else if(current==='linked'){
    const wikiCheck=el('input',{type:'checkbox',name:'wiki',checked:state.wiki?'':null,onchange:e=>{state.wiki=e.target.checked;}});
    const reviewCheck=el('input',{type:'checkbox',name:'reviews',checked:state.reviews?'':null,onchange:e=>{state.reviews=e.target.checked;}});
    const renameCheck=offerRenameHome?el('input',{type:'checkbox',name:'renameWikiHome',checked:state.renameWikiHome?'':null,onchange:e=>{state.renameWikiHome=e.target.checked;}}):null;
    content.append(el('h4',{},t('2. Propojená Wiki a Review')),
     el('p',{},wikiEnabled?t('Nalezená wiki: {n} stránek.',{n:wikiPages.length}):t('Projekt zatím nemá založenou wiki.')),
     renameCheck?el('label',{class:'tk-choice'},renameCheck,el('span',{},el('strong',{},t('Přejmenovat domovskou stránku na „{title}“',{title:`${freshProject.name} Home`})),
      el('small',{},t('Aktuální název domovské stránky je „Home“.'))) ):null,
     el('p',{},reviewSets.length?t('Nalezené sady Review ({n}): {ids}',{n:reviewSets.length,ids:reviewSets.map(s=>s.id).join(', ')}):t('Žádné sady Review nebyly nalezeny.')),
     el('label',{class:'tk-choice'},wikiCheck,el('span',{},el('strong',{},'Wiki'),el('small',{},t('Zobrazit wiki v projektu a v postranním panelu.')))),
     el('label',{class:'tk-choice'},reviewCheck,el('span',{},el('strong',{},'Review'),el('small',{},t('Nabízet Review pro položky projektu.')))));
   }else if(current==='references'){
    content.append(el('h4',{},t('Lokální reference')),
     el('p',{class:'sec-dim'},t('Projekt má {n} lokálních vlastních referencí. Po upgradu zůstanou dál omezené na tento projekt.',{n:localRefTotal})),
     el('ul',{class:'tk-delete-counts'},localRefs.map(r=>el('li',{},r.label))));
   }else{
    const skipRadio=el('input',{type:'radio',name:'epicMode',value:'skip',checked:!state.createEpics?'':null,onchange:()=>{state.createEpics=false;draw();}});
    const createRadio=el('input',{type:'radio',name:'epicMode',value:'create',checked:state.createEpics?'':null,onchange:()=>{state.createEpics=true;draw();}});
    const assignedElsewhere=(idx,tid)=>state.epics.some((ep,i)=>i!==idx&&ep.ticketIds.includes(tid));
    const builder=state.createEpics?el('div',{class:'acc-stack'},
     ...state.epics.map((ep,idx)=>el('fieldset',{class:'tk-wizard-epic'},
      el('legend',{},t('Epic {n}',{n:idx+1})),
      el('label',{},t('Název epicu'),el('input',{name:`epic-title-${idx}`,maxlength:'200',value:ep.title,oninput:e=>{ep.title=e.target.value;}})),
      el('label',{},t('Popis'),el('input',{name:`epic-desc-${idx}`,maxlength:'2000',value:ep.description,oninput:e=>{ep.description=e.target.value;}})),
      el('label',{},t('Specifikace'),el('textarea',{name:`epic-spec-${idx}`,rows:'3',oninput:e=>{ep.spec=e.target.value;}},ep.spec)),
      tickets.length?el('div',{class:'tk-wizard-tickets'},el('span',{class:'tk-eyebrow'},t('Přiřadit položky')),
       ...tickets.map(tk=>{
        const taken=assignedElsewhere(idx,tk.id);
        return el('label',{class:'tk-choice'},
         el('input',{type:'checkbox',checked:ep.ticketIds.includes(tk.id)?'':null,disabled:taken?'':null,onchange:e=>{
          if(e.target.checked){if(!ep.ticketIds.includes(tk.id))ep.ticketIds.push(tk.id);}
          else ep.ticketIds=ep.ticketIds.filter(x=>x!==tk.id);
          draw();
         }}),
         el('span',{},`${tk.id} · ${tk.title}`));
       })):null,
      state.epics.length>1?el('button',{type:'button',class:'acc-btn small',onclick:()=>{state.epics.splice(idx,1);draw();}},t('Odebrat epic')):null)),
     el('button',{type:'button',class:'acc-btn small',onclick:()=>{state.epics.push({title:'',description:'',spec:'',ticketIds:[]});draw();}},t('+ Přidat další epic'))):null;
    content.append(el('h4',{},t('Epicy a existující položky')),
     el('p',{class:'sec-dim'},t('Projekt obsahuje {n} existujících položek.',{n:tickets.length})),
     el('label',{class:'tk-choice'},skipRadio,el('span',{},t('Epic teď nepotřebuji — nechat položky nepřiřazené (epicy mohu založit a položky přiřadit později)'))),
     el('label',{class:'tk-choice'},createRadio,el('span',{},t('Vytvořit první epicy hned teď'))),
     builder);
   }

   const isLast=state.step===steps.length-1;
   const nextBtn=el('button',{type:'button',class:'acc-btn primary',onclick:async()=>{
    msg.textContent='';msg.classList.remove('error');
    if(current==='profile'){
     try{parseLabels(state.labelsText);}catch(err){fail(msg,err);return;}
    }
    if(!isLast){state.step++;draw();return;}
    let labels=[];
    try{labels=parseLabels(state.labelsText);}catch(err){fail(msg,err);return;}
    const epicsPayload=[];
    if(state.createEpics){
     for(const ep of state.epics){
      const title=ep.title.trim();
      if(!title){fail(msg,new Error(t('Každý zakládaný epic musí mít název.')));return;}
      if(utf8Bytes(ep.spec)>SPEC_MAX_BYTES){fail(msg,new Error(t('Specifikace překračuje limit 64 kB.')));return;}
      epicsPayload.push({title,...(ep.description.trim()?{description:ep.description.trim()}:{}),...(ep.spec?{spec:ep.spec}:{}),...(ep.ticketIds.length?{ticketIds:[...ep.ticketIds]}:{})});
     }
    }
    nextBtn.disabled=true;
    try{
     await api('/api/tickets/projects/upgrade',{
      id:freshProject.id,rev:freshProject.rev,type:state.type||null,labels,
      settings:{...freshProject.settings,wiki:state.wiki,reviews:state.reviews},
      ...(offerRenameHome?{renameWikiHome:state.renameWikiHome}:{}),
      epics:epicsPayload,
     },{maxBytes:131072});
     notifyWikiNavigation(freshProject.id,true);
     dialog.close();
     toast.good(t('Projekt „{name}“ byl úspěšně převeden na v2.',{name:freshProject.name}));
     await onDone?.();
    }catch(err){
     fail(msg,err);nextBtn.disabled=false;
     if(err.status===409)msg.append(' ',el('button',{type:'button',class:'acc-btn small',onclick:start},t('Načíst znovu')));
    }
   }},isLast?t('Dokončit upgrade na v2'):`${t('Další')} →`);

   body.replaceChildren(
    el('div',{class:'tk-wizard-step'},stepLabel),
    content,msg,
    el('div',{class:'acc-actions'},
     state.step>0?el('button',{type:'button',class:'acc-btn',onclick:()=>{state.step--;draw();}},`← ${t('Předchozí')}`):null,
     el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),
     nextBtn));
  }
  draw();
 }
 start();
}

function renderProjectSettings(wrap,ctx,p,section,notice=''){
 const tabs=[['',t('Obecné')],['look',t('Vzhled projektu')],['features',t('Funkce projektu')],['references',t('Reference')]];
 const tab=section??'',settings=p.settings??{};
 const header=pageHeader({back:{label:p.name,href:'#projects/'+p.id},eyebrow:p.name,title:t('Nastavení projektu')});
 const navigation=el('nav',{class:'tk-settings-tabs','aria-label':t('Nastavení projektu')},tabs.map(([key,title])=>
  el('a',{href:settingsHref(p,key),'aria-current':tab===key?'page':null},title)));
 if(tab==='references')return show(wrap,header,navigation,projectReferences(ctx.me,p.id));
 const writable=ctx.me?.canWrite===true&&ctx.me.scopes?.includes('tickets:write');
 const field=(title,input)=>el('label',{},title,input);
 const group=(title,items)=>el('fieldset',{class:'tk-choices'},el('legend',{},title),items);
 const toggle=(key,title,hint)=>el('label',{class:'tk-choice'},
  el('input',{type:'checkbox',name:key,checked:settings[key]!==false?'':null}),
  el('span',{},el('strong',{},title),el('small',{},hint)));
 const choice=(name,value,selected,text,swatch=false)=>el('label',{class:'tk-choice'},
  el('input',{type:'radio',name,value,checked:value===selected?'':null}),
  swatch?el('span',{class:'tk-swatch','aria-hidden':'true','data-project-color':value}):null,text);
 const controls=[];
 if(tab==='look'){
  controls.push(group(t('Barva projektu'),projectColors().map(([v,text])=>choice('color',v,settings.color??'',text,true))),
   group(t('Výchozí pohled'),[['board',t('Nástěnka')],['table',t('Tabulka')]].map(([v,text])=>choice('view',v,settings.view??'board',text))));
 }else if(tab==='features'){
  controls.push(toggle('releases',t('Releasy'),t('Zobrazit plánování releasů v projektu.')),
   toggle('reviews','Review',t('Nabízet vytvoření review pro položky projektu.')),
   toggle('wiki','Wiki',t('Zobrazit odkaz na wiki nebo možnost ji založit.')),
   toggle('globalReferences',t('Globální reference'),t('Nabízet sdílené reference a povolit jejich vytváření v tomto projektu.')));
 }else{
  const ver=p.projectVersion??2;
  controls.push(el('div',{class:'tk-grid3'},field('ID',el('input',{readonly:'',value:p.id})),field(t('Zkratka (prefix položek)'),el('input',{readonly:'',value:p.key})),
    field(t('Verze projektu'),el('input',{readonly:'',value:`v${ver}`}))),
   el('p',{class:'acc-dim'},t('ID a zkratku položek nelze změnit.')),
   ver===1&&writable?el('div',{},el('button',{type:'button',class:'acc-btn small primary',onclick:()=>openUpgradeWizard(p,ctx,()=>projectPage(wrap,ctx))},t('Spustit průvodce upgradem'))):null,
   field(t('Název'),el('input',{name:'name',required:'',maxlength:80,value:p.name})),
   field(t('Popis'),el('textarea',{name:'description',rows:3,maxlength:500},p.description||'')),
   field(t('Typ'),el('select',{name:'type'},options(PROJECT_TYPES(),p.type||'',t('Bez typu')))),
   field(t('Štítky (čárkou)'),el('input',{name:'labels',value:(p.labels||[]).join(', '),placeholder:'web, core, docs'})));
 }
 const msg=status();msg.textContent=notice;
 const submit=el('button',{type:'submit',class:'acc-btn primary'},t('Uložit změny'));
 const form=el('form',{class:'acc-card tk-form tk-settings',onsubmit:async event=>{
  event.preventDefault();if(!writable||submit.disabled)return;
  msg.textContent='';msg.classList.remove('error');
  const fields=event.currentTarget.elements,body={id:p.id,rev:p.rev};
  if(!tab){
   let labels=[];
   try{labels=parseLabels(fields.labels?.value||'');}catch(err){fail(msg,err);return;}
   Object.assign(body,{name:fields.namedItem('name').value,description:fields.description.value,type:fields.type.value||null,labels});
  }
  else if(tab==='look')body.settings={color:fields.color.value||null,view:fields.view.value};
  else if(tab==='features')body.settings={
   releases:fields.releases.checked,reviews:fields.reviews.checked,wiki:fields.wiki.checked,globalReferences:fields.globalReferences.checked};
  submit.disabled=true;const epoch=sessionEpoch;
  try{
   const saved=await api('/api/tickets/projects',body);
   if(!tab||tab==='features')notifyWikiNavigation(p.id,true);
   if(epoch===sessionEpoch&&form.isConnected)renderProjectSettings(wrap,ctx,saved,tab,t('Uloženo.'));
  }catch(error){
   fail(msg,error);
   if(error.status===409)msg.append(' ',el('button',{type:'button',class:'acc-btn small',onclick:()=>projectPage(wrap,ctx).catch(e=>fail(msg,e))},t('Načíst znovu')));
  }finally{submit.disabled=false;}
 }},el('fieldset',{class:'tk-settings-fields',disabled:writable?null:''},
  el('legend',{},tabs.find(([key])=>key===tab)[1]),controls),
  writable?el('div',{class:'acc-actions'},submit):el('p',{class:'acc-dim'},t('Nastavení je pouze pro čtení.')),msg);
 const dangerZone=!tab?el('section',{class:'acc-card tk-settings tk-danger'},
  el('h3',{},t('Nebezpečná zóna')),
  el('p',{class:'sec-dim'},t('Smazání projektu odstraní jeho epicy, položky a releasy. Propojenou wiki, Review a lokální reference si zvolíš v potvrzovacím dialogu.')),
  writable?el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn danger',onclick:()=>deleteProjectDialog(p,ctx)},t('Smazat projekt')))
   :el('p',{class:'acc-dim'},t('Ke smazání projektu potřebuješ oprávnění zápisu.'))):null;
 show(wrap,header,navigation,form,dangerZone);
}
// A new project: the name proposes an id and a key until either is typed by hand; both are permanent.
const slugOf=name=>name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^[^a-z]+|-+$/g,'').slice(0,40);
const keyOf=name=>{const words=name.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
 return (words.length>1?words.map(w=>w[0]).join(''):(words[0]||'')).replace(/^[^A-Z]+/,'').slice(0,words.length>1?5:4);};
function newProject(done){
 const msg=status(),touched={id:false,key:false};
 const name=el('input',{name:'name',required:'',maxlength:'80',autocomplete:'off',oninput:()=>{if(!touched.id)id.value=slugOf(name.value);if(!touched.key)key.value=keyOf(name.value);}});
 const id=el('input',{name:'id',required:'',pattern:'[a-z][a-z0-9\\-]{1,39}',placeholder:'my-app',autocomplete:'off',oninput:()=>{touched.id=true;}});
 const key=el('input',{name:'key',required:'',pattern:'[A-Za-z][A-Za-z0-9]{1,9}',placeholder:'APP',autocomplete:'off',oninput:()=>{touched.key=true;}});
 const wikiOpt=el('input',{type:'checkbox',name:'wiki'});
 const reviewsOpt=el('input',{type:'checkbox',name:'reviews'});
 const form=el('form',{class:'tk-form',onsubmit:async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');
   msg.textContent='';msg.classList.remove('error');
   let labels=[];
   try{labels=parseLabels(f.labels?.value||'');}catch(err){fail(msg,err);return;}
   const wikiChecked=Boolean(f.wiki?.checked),reviewsChecked=Boolean(f.reviews?.checked);
   b.disabled=true;
   try{
    const made=await api('/api/tickets/projects',{id:f.id.value.trim(),key:f.key.value.trim().toUpperCase(),name:f.name.value,description:f.description.value,type:f.type.value||null,...(labels.length?{labels}:{}),settings:{wiki:wikiChecked,reviews:reviewsChecked},...(wikiChecked?{createWiki:true}:{})});
    if(wikiChecked)notifyWikiNavigation(made.id,true);
    dialog.close();if(location.hash==='#projects')await done?.();else location.hash='#projects/'+made.id;
   }catch(err){fail(msg,err);b.disabled=false;}}},
  el('label',{},t('Název'),name),
  el('div',{class:'tk-grid3'},el('label',{},'Id',id),el('label',{},t('Zkratka (prefix položek)'),key),el('label',{},t('Typ'),el('select',{name:'type'},options(PROJECT_TYPES(),'',t('Bez typu'))))),
  el('label',{},t('Popis'),el('input',{name:'description',maxlength:'500'})),
  el('label',{},t('Štítky (čárkou)'),el('input',{name:'labels',placeholder:'web, core, docs'})),
  el('fieldset',{class:'tk-settings-fields'},el('legend',{},t('Volitelné funkce')),
   el('label',{class:'tk-choice'},wikiOpt,el('span',{},el('strong',{},'Wiki'),el('small',{},t('Založí propojenou wiki s domovskou stránkou projektu.')))),
   el('label',{class:'tk-choice'},reviewsOpt,el('span',{},el('strong',{},'Review'),el('small',{},t('Zapne Review pro položky tohoto projektu.'))))),
  el('p',{class:'acc-dim'},t('Id a zkratka se později nedají změnit; položky budou mít čísla jako APP-1.')),
  msg,el('div',{class:'acc-actions'},el('button',{type:'button',class:'acc-btn',onclick:()=>dialog.close()},t('Zrušit')),el('button',{type:'submit',class:'acc-btn primary'},t('Založit projekt'))));
 const dialog=el('dialog',{class:'acc-dialog wide tk-dialog','aria-label':t('Nový projekt')},el('h3',{},t('Nový projekt')),form);
 showDialog(dialog);name.focus();
}
// Page entry for the shell (app.js): every page module exports (context) => Node, and the server's UI
// manifest names it. context = {me, page, sub, device, site}.
export const trackerPage=({me,page,sub})=>trackerView(me,page,sub);

export async function createReviewTicket(project,me){
 const query=new URLSearchParams({limit:1,...(project?{project}:{})});
 const meta=await api('/api/tickets?'+query);
 return newTicket(meta.projects,project,{me,user:me?.username,lockProject:Boolean(project)});
}
