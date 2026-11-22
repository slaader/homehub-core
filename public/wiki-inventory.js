import {el} from './views.js';
import {t} from './i18n.js';
import {inlineTeaserChip} from './wiki-content.js';

const VISIBLE_STATS=4,TEASER_LENGTH=160;

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

// The first TEASER_LENGTH characters of a long cell, which CSS folds to two lines. A chip is never cut, and an
// ellipsis says that more of the cell is in the body of the disclosure.
function cellTeaser(runs,text){
 const items=[];
 let shown=0;
 for(const [i,run] of runs.entries()){
  if(shown>=TEASER_LENGTH)break;
  const part=text.childNodes[i]?.textContent??'',chip=inlineTeaserChip(run,part);
  const kept=chip?part:part.slice(0,TEASER_LENGTH-shown);
  items.push(chip??kept.replace(/\s+/g,' '));
  shown+=kept.length;
 }
 if(shown<text.textContent.length){
  while(typeof items.at(-1)==='string'){
   const trimmed=items.at(-1).trimEnd();
   if(trimmed){items[items.length-1]=trimmed;break;}
   items.pop();
  }
  items.push('…');
 }
 return el('span',{class:'wiki-cell-teaser','aria-hidden':'true'},items);
}

function cellText(runs,inline,compact){
 if(!runs?.length)return null;
 const text=el('p',{},inline(runs));
 if(!compact||(text.textContent.length<=TEASER_LENGTH&&text.textContent.split('\n').length<=4))return text;
 return el('details',{class:'wiki-cell-text'},el('summary',{},t('Text buňky'),cellTeaser(runs,text)),text);
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
