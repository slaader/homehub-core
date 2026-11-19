import {el} from './views.js';
import {t} from './i18n.js';

export function wikiStats(stats=[]){
 if(!stats.length)return null;
 return el('dl',{class:'wiki-stats'},stats.map(({name,value,unit})=>
  el('div',{},el('dt',{},name),el('dd',{},value,unit?' '+unit:null))));
}

export function wikiInventory(block,{inline,group,editCell}){
 return el('div',{class:'wiki-table wiki-inventory',tabindex:'0',role:'region','aria-label':t('Tabulka inventáře')},
  el('table',{},el('thead',{},el('tr',{},block.columns.map(column=>el('th',{scope:'col'},column.label)))),
   el('tbody',{},block.rows.map((row,index)=>el('tr',{},block.columns.map(column=>{
    const cell=Object.hasOwn(row.cells,column.id)?row.cells[column.id]:{};
    return el('td',{},cell.c?.length?el('p',{},inline(cell.c)):null,wikiStats(cell.stats),
     group(cell.attachments??[]),editCell?.(row,column,index));
   }))))));
}
