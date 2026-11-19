import {el} from './views.js';
import {t} from './i18n.js';
import {authGuard} from './session-cache.js';

export const wikiHref=(project,id)=>`#wiki/${project}${id?'/'+id:''}`;
export const wikiApiPath=(project,id)=>`/api/wiki/${project}${id?'/pages/'+id:''}`;
export const canWriteWiki=me=>me?.canWrite===true&&Boolean(me.scopes?.includes('tickets:write'));
export const editWikiHref=(project,id)=>wikiHref(project,id)+'?edit';

export async function wikiApi(url,body){
 const lost=authGuard();
 const response=await fetch(url,body===undefined?{}:{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
 });
 lost(response);
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw Object.assign(new Error(result.error?.message?t(result.error.message):t('Požadavek selhal.')),
  {status:response.status,current:result.current});
 return result;
}

const blockFrame=(page,id)=>`/api/wiki/frame/${page.project}/${page.id}/${id}`;

const ticketStates={
 open:['Otevřený','warn'],'in-progress':['Rozpracovaný','info'],done:['Hotovo','ok'],cancelled:['Zrušený','dim'],
};
export function ticketChip(id,ticket,editing=false){
 const [label,tone]=ticketStates[ticket?.status]??[];
 const contents=[el('b',{class:'tk-mono'},id),ticket?.title,
  label?el('span',{class:`sec-pill ${tone}`},t(label)):null];
 if(editing)return el('span',{class:'wiki-ticket',contenteditable:'false','data-ticket':id},contents);
 return ticket?el('a',{class:'wiki-ticket',href:'#items/'+id},contents):
  el('span',{class:'wiki-ticket wiki-ticket-missing',title:t('Ticket se nepodařilo načíst.')},id);
}

function textNode(run){
 return (run.m??[]).reduce((node,mark)=>el(mark,{},node),run.text);
}
function inlineNodes(runs,{tickets,editing}){
 return runs.map(run=>{
  if(run.t==='ticket')return ticketChip(run.id,tickets.get(run.id),editing);
  if(run.t==='link')return el('a',{href:run.href,target:'_blank',rel:'noopener noreferrer'},run.c.map(textNode));
  return textNode(run);
 });
}

export function tableCell(tag,children=[],editing=false){
 return el(tag,{scope:tag==='th'?'col':null,contenteditable:editing?'true':null,tabindex:editing?'0':null},children);
}
function tableNode(block,context){
 const rows=block.rows.map((row,i)=>el('tr',{},row.map(cell=>
  tableCell(i===0&&block.header?'th':'td',inlineNodes(cell,context),context.editing))));
 return el('div',{class:'wiki-table',contenteditable:context.editing?'false':null},
  el('table',{},
   block.header&&!context.editing?el('thead',{},rows.shift()):null,
   el('tbody',{},rows)));
}

export function htmlFrame(src,label,height){
 return el('iframe',{class:'wiki-frame',src,title:label,height,sandbox:'',referrerpolicy:'no-referrer',loading:'lazy'});
}

export function wikiBlocks(doc,context){
 const inline=runs=>inlineNodes(runs,context);
 return doc.blocks.map(block=>{
  switch(block.t){
   case 'p':return el('p',{},inline(block.c));
   case 'h':return el('h'+block.level,{},inline(block.c));
   case 'quote':return el('blockquote',{},inline(block.c));
   case 'ul':case 'ol':return el(block.t,{},block.items.map(item=>el('li',{},inline(item))));
   case 'code':return el('pre',{},block.text);
   case 'hr':return el('hr',{contenteditable:context.editing?'false':null});
   case 'table':return tableNode(block,context);
   case 'html':return context.htmlCard?.(block)??htmlFrame(blockFrame(context.page,block.id),block.label,block.height);
  }
 });
}
