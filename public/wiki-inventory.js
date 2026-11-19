import {el} from './views.js';
import {t} from './i18n.js';

const VISIBLE_STATS=4;

function statList(stats){
 return el('dl',{class:'wiki-stats'},stats.map(({name,value,unit})=>
  el('div',{},el('dt',{},name),el('dd',{},value,unit?' '+unit:null))));
}

function wikiStats(stats=[],compact){
 if(!stats.length)return null;
 if(!compact||stats.length<=VISIBLE_STATS)return statList(stats);
 return el('div',{class:'wiki-stat-group'},statList(stats.slice(0,VISIBLE_STATS)),
  el('details',{class:'wiki-stat-disclosure'},el('summary',{},t('Všechny údaje ({count})',{count:stats.length})),
   statList(stats.slice(VISIBLE_STATS))));
}

function cellText(runs,inline,compact){
 if(!runs?.length)return null;
 const text=el('p',{},inline(runs));
 if(!compact||(text.textContent.length<=160&&text.textContent.split('\n').length<=4))return text;
 const preview=el('span',{class:'wiki-cell-teaser','aria-hidden':'true'},text.textContent.replace(/\s+/g,' ').trim());
 return el('details',{class:'wiki-cell-text'},el('summary',{},t('Text buňky'),preview),text);
}

export function wikiInventory(block,{inline,group,editCell}){
 const compact=!editCell;
 return el('div',{class:'wiki-table wiki-inventory',tabindex:'0',role:'region','aria-label':t('Tabulka inventáře')},
  el('table',{},el('thead',{},el('tr',{},block.columns.map(column=>el('th',{scope:'col'},column.label)))),
   el('tbody',{},block.rows.map((row,index)=>el('tr',{},block.columns.map(column=>{
    const cell=Object.hasOwn(row.cells,column.id)?row.cells[column.id]:{};
    return el('td',{},cellText(cell.c,inline,compact),wikiStats(cell.stats,compact),
     group(cell.attachments??[]),editCell?.(row,column,index));
   }))))));
}
