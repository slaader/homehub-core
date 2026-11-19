import {el} from './views.js';
import {t} from './i18n.js';
import {normalizeDoc,WIKI_LIMITS,wikiDisplayType} from './wiki-doc.js';
import {wikiApi,wikiRequest} from './wiki-content.js';
import {wikiFileSize} from './wiki-media.js';
import {wikiInventory} from './wiki-inventory.js';

const button=(label,onclick,attrs={})=>el('button',{type:'button',class:'acc-btn small',onclick,...attrs},label);
const alert=()=>el('p',{class:'acc-status error',role:'alert'});
const actions=(...children)=>el('div',{class:'wiki-actions'},children);
const label=(name,input)=>el('label',{},t(name),input);
const input=(value='',max=120,oninput)=>el('input',{value,maxlength:max,...(oninput?{oninput}:{})});
const note=message=>el('p',{class:'sec-dim'},t(message));
const option=(value,label)=>el('option',{value},label);
export const newWikiItemId=prefix=>prefix+'-'+Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('');
const validate=block=>normalizeDoc({v:1,blocks:[block]}).blocks[0];
const assetText=asset=>asset.name+' · '+wikiFileSize(asset.size);
const transfers=new Map();

function errorMessage(error){
 if(error.message==='limit')return t('Obsah překročil limit wiki.');
 if(error.message==='invalid')return t('Zkontroluj název a obsah stránky.');
 return error.message;
}

async function uploadFile(project,file,progress,signal){
 if(file.size>256*1024**2)throw new Error(t('Soubor nebo část nahrávky překročily limit.'));
 if(!crypto.subtle)throw new Error(t('Nahrávání v prohlížeči vyžaduje HTTPS nebo localhost.'));
 const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
 const digest=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
 signal.throwIfAborted();
 const key=JSON.stringify([project,digest,file.name]);
 let state;
 const prior=transfers.get(key);
 if(prior){
  try{state=await wikiApi('/api/wiki/uploads/'+prior);}
  catch(error){if(![403,410].includes(error.status))throw error;transfers.delete(key);}
 }
 if(!state){
  state=await wikiApi('/api/wiki/uploads',{project,name:file.name,size:file.size,digest,type:file.type});
  if(transfers.size>=32)transfers.delete(transfers.keys().next().value);
  transfers.set(key,state.uploadId);
 }
 while(state.nextOffset<file.size){
  const offset=state.nextOffset;
  progress(offset,file.size);
  state=await wikiRequest('/api/wiki/uploads/'+state.uploadId+'?offset='+offset,
   {method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(offset,offset+state.rawChunkSize),signal});
 }
 signal.throwIfAborted();
 const result=await wikiApi('/api/wiki/uploads/finish',{uploadId:state.uploadId});
 transfers.delete(key);
 return result.asset;
}

function reviewSource(project,set,area,pick){
 const message=alert(),options=el('select',{disabled:''});
 const use=button(t('Zkopírovat variantu'),()=>{
  const selection=choices[Number(options.value)];
  if(selection)pick(async()=>{
   const {asset,captionSuggestion}=await wikiApi('/api/wiki/assets/import',{project,source:selection.source});
   return {...asset,captionSuggestion};
  },use,message);
 },{disabled:''});
 const choices=[];
 area.replaceChildren(label('Soubor varianty',options),use,message);
 wikiApi('/api/review/sets/'+set).then(review=>{
  for(const round of [...review.rounds].reverse())for(const item of round.items)for(const variant of item.variants){
   for(const [media,file] of variant.media.entries())choices.push({
    label:`#${round.n} · ${item.title} · ${variant.title||variant.label} · ${file.name||file.type}`,
    source:{kind:'review',set,round:round.n,item:item.id,variant:variant.id,media},
   });
  }
  options.replaceChildren(...choices.map((entry,index)=>option(index,entry.label)));
  options.disabled=use.disabled=!choices.length;
 }).catch(error=>{message.textContent=error.message;});
}

function sourcePicker(project,area,pick){
 area.replaceChildren(note('Načítám zdroje…'));
 wikiApi('/api/wiki/'+project+'/sources').then(sources=>{
  const sections=[];
  if(sources.repositories.length){
   const repos=el('select',{},sources.repositories.map((entry,index)=>option(index,entry.repo+' · '+entry.connection)));
   const ref=input('HEAD',240),file=input('',1024),message=alert();
   const suggestions=el('datalist',{id:newWikiItemId('wiki-paths')});
   file.setAttribute('list',suggestions.id);
   function suggestPaths(){
    const selected=repos.value,{connection,repo}=sources.repositories[Number(selected)];
    const query=new URLSearchParams({connection,repo,status:'current',limit:100,sort:'path',dir:'asc'});
    wikiApi('/api/git-lfs/objects?'+query).then(data=>{
     if(repos.value!==selected)return;
     const paths=new Set(data.items.flatMap(entry=>entry.currentPaths??[]));
     suggestions.replaceChildren(...[...paths].sort().slice(0,200).map(path=>option(path,path)));
    }).catch(()=>{});
   }
   repos.addEventListener('change',()=>{suggestions.replaceChildren();suggestPaths();});
   const use=button(t('Zkopírovat soubor z Git LFS'),()=>{
    const {connection,repo}=sources.repositories[Number(repos.value)];
    if(!ref.value.trim()||!file.value.trim()){message.textContent=t('Zadej revizi a cestu k souboru.');return;}
    pick(()=>wikiApi('/api/wiki/assets/import',{project,source:{kind:'lfs',connection,repo,ref:ref.value.trim(),path:file.value.trim()}})
     .then(value=>value.asset),use,message);
   });
   sections.push(el('fieldset',{class:'wiki-form'},el('legend',{},'Git LFS'),label('Repozitář',repos),
    label('Větev, tag nebo commit',ref),label('Cesta v repozitáři',file),suggestions,use,message));
   suggestPaths();
  }
  if(sources.reviewSets.length){
   const panel=el('div',{class:'wiki-form'});
   const sets=el('select',{onchange:()=>reviewSource(project,sets.value,panel,pick)},
    sources.reviewSets.map(set=>option(set.id,set.id+' · '+set.title)));
   sections.push(el('fieldset',{class:'wiki-form'},el('legend',{},t('Použít z Review')),label('Sada Review',sets),panel));
   reviewSource(project,sources.reviewSets[0].id,panel,pick);
  }
  area.replaceChildren(note('Po uložení stránky uvidí kopii všichni čtenáři projektu.'),
   ...sections,...(!sections.length?[note('Pro tento projekt nejsou dostupné zdroje importu.')]:[]));
 }).catch(error=>area.replaceChildren(el('p',{role:'alert'},error.message)));
}

function chooseAsset(context,onAsset,accept=()=>true){
 const {project,dialog,assets}=context;
 const modes=[['local','Nahrát soubor'],['existing','Použít přílohu projektu'],['source','Importovat ze zdroje']];
 const area=el('div',{class:'wiki-form'}),controller=new AbortController();
 const selector=el('select',{onchange:draw},modes.map(([value,name])=>option(value,t(name))));
 const d=dialog(t('Vybrat přílohu'),[label('Zdroj přílohy',selector),area]);
 d.addEventListener('close',()=>controller.abort(),{once:true});

 async function pick(load,control,message){
  control.disabled=true;
  selector.disabled=true;
  message.textContent='';
  try{
   const asset=await load();
   if(!d.open)return;
   if(!accept(asset))throw new Error(t('Vyber kompatibilní náhledový soubor.'));
   assets.set(asset.id,asset);
   d.close();
   onAsset(asset);
  }catch(error){if(d.open)message.textContent=error.message;}
  finally{selector.disabled=false;control.disabled=false;}
 }

 function draw(){
  if(selector.value==='source'){
   const panel=el('div',{class:'wiki-form'});
   area.replaceChildren(panel);
   sourcePicker(project,panel,pick);
   return;
  }
  if(selector.value==='existing'){
   area.replaceChildren(note('Načítám přílohy…'));
   wikiApi('/api/wiki/'+project+'/assets').then(data=>{
    if(selector.value!=='existing')return;
    const eligible=data.assets.filter(accept);
    const options=el('select',{},eligible.map(asset=>option(asset.id,assetText(asset))));
    const use=button(t('Použít přílohu'),()=>{
     const asset=eligible.find(asset=>asset.id===options.value);
     if(asset)pick(()=>asset,use,message);
    });
    const message=alert();
    area.replaceChildren(eligible.length?label('Příloha',options):note('Projekt zatím nemá dostupné přílohy.'),
     eligible.length?use:null,message);
   }).catch(error=>{if(selector.value==='existing')area.replaceChildren(el('p',{role:'alert'},error.message));});
   return;
  }
  const file=el('input',{type:'file'}),message=alert(),progress=el('progress',{'aria-label':t('Průběh nahrávání'),max:1,value:0,hidden:''});
  const upload=button(t('Nahrát nebo pokračovat'),()=>{
   if(!file.files[0]){message.textContent=t('Nejprve vyber soubor.');return;}
   pick(()=>uploadFile(project,file.files[0],(done,size)=>{progress.hidden=false;progress.value=done/size;},controller.signal),upload,message);
  });
  area.replaceChildren(label('Soubor',file),upload,progress,message);
 }
 draw();
}

function arrange(items,index,redraw,remove){
 const move=direction=>{
  const [entry]=items.splice(index,1);
  items.splice(index+direction,0,entry);
  redraw(index+direction);
 };
 return actions(
  button('↑',()=>move(-1),{'aria-label':t('Posunout výš'),disabled:index===0?'':null}),
  button('↓',()=>move(1),{'aria-label':t('Posunout níž'),disabled:index===items.length-1?'':null}),
  button(t('Odebrat'),()=>{const [entry]=items.splice(index,1);remove?.(entry);redraw(Math.min(index,items.length-1));}));
}

function groupEditor(initial,context){
 const refs=structuredClone(initial??[]),list=el('div',{class:'wiki-edit-list'});
 const add=button(t('Přidat přílohu'),()=>chooseAsset(context,asset=>{refs.push({assetId:asset.id,label:'',caption:''});draw(refs.length-1);}));
 function draw(focus){
  list.replaceChildren(...refs.map((ref,index)=>{
   const asset=context.assets.get(ref.assetId);
   const display=context.assets.get(ref.displayAssetId);
   const acceptsPreview=next=>next.id!==ref.assetId&&wikiDisplayType(asset?.type,next.type);
   const replace=button(t('Nahradit soubor'),()=>chooseAsset(context,next=>{
    ref.assetId=next.id;
    if(display&&(display.id===next.id||!wikiDisplayType(next.type,display.type)))delete ref.displayAssetId;
    if(next.type!=='model/gltf-binary')delete ref.initialClip;
    draw(index);
   }));
   const name=input(ref.label,WIKI_LIMITS.label,e=>{ref.label=e.target.value;});
   const caption=el('textarea',{rows:2,maxlength:WIKI_LIMITS.caption,oninput:e=>{ref.caption=e.target.value;}},ref.caption);
   const useReviewCaption=asset?.captionSuggestion?button(t('Použít popis z Review'),()=>{
    caption.value=ref.caption=asset.captionSuggestion;
    caption.focus();
   }):null;
   const preview=wikiDisplayType(asset?.type,asset?.type)?el('div',{class:'wiki-form'},
    display?el('span',{},t('Náhledový soubor: {name}',{name:assetText(display)})):null,
    actions(button(t(display?'Změnit náhledový soubor':'Přidat náhledový soubor'),()=>chooseAsset(context,next=>{
     ref.displayAssetId=next.id;
     draw(index);
    },acceptsPreview)),display?button(t('Odebrat náhledový soubor'),()=>{delete ref.displayAssetId;draw(index);}):null)):null;
   const clip=asset?.type==='model/gltf-binary'?label('Počáteční animace (volitelné)',input(ref.initialClip??'',WIKI_LIMITS.clip,e=>{
    if(e.target.value)ref.initialClip=e.target.value;
    else delete ref.initialClip;
   })):null;
   return el('fieldset',{class:'wiki-form'},el('legend',{},asset?.name??t('Příloha')),
    label('Popisek přílohy',name),label('Titulek přílohy',caption),useReviewCaption,preview,clip,actions(replace,arrange(refs,index,draw)));
  }));
  add.disabled=refs.length>=WIKI_LIMITS.attachments;
  if(focus!==undefined)(list.children[focus]?.querySelector('input')??add).focus();
 }
 draw();
 return {refs,node:el('div',{class:'wiki-form'},list,add)};
}

function statsEditor(initial){
 const stats=structuredClone(initial??[]),list=el('div',{class:'wiki-edit-list'});
 const add=button(t('Přidat údaj'),()=>{stats.push({name:'',value:''});draw(stats.length-1);});
 function draw(focus){
  list.replaceChildren(...stats.map((entry,index)=>el('fieldset',{class:'wiki-stat-edit'},el('legend',{},t('Údaj {index}',{index:index+1})),
   label('Název údaje',input(entry.name,WIKI_LIMITS.label,e=>{entry.name=e.target.value;})),
   label('Hodnota',input(entry.value,WIKI_LIMITS.cell,e=>{
    const value=e.target.value;
    entry.value=typeof entry.value==='number'&&value.trim()&&Number.isFinite(Number(value))?Number(value):value;
   })),
   label('Jednotka',input(entry.unit??'',WIKI_LIMITS.label,e=>{entry.unit=e.target.value;})),arrange(stats,index,draw))));
  add.disabled=stats.length>=WIKI_LIMITS.stats;
  if(focus!==undefined)(list.children[focus]?.querySelector('input')??add).focus();
 }
 draw();
 return {stats,node:el('div',{class:'wiki-form'},list,add)};
}

export function editAttachments(block,context,onSave){
 const group=groupEditor(block.attachments,context),message=alert();
 const apply=button(t('Použít změny'),()=>{
  try{const value=validate({...block,attachments:group.refs});d.close();onSave(value);}
  catch(error){message.textContent=errorMessage(error);}
 });
 const d=context.dialog(t('Skupina příloh'),[group.node,message,actions(apply)]);
}

function showCellEditor(block,row,column,context,onSave){
 const cell=Object.hasOwn(row.cells,column.id)?row.cells[column.id]:{};
 const rich=context.richEditor(cell.c??[]);
 const stats=statsEditor(cell.stats),group=groupEditor(cell.attachments,context),message=alert();
 const apply=button(t('Použít změny'),()=>{
  const c=rich.read(),cells={...row.cells,[column.id]:{
   ...(c.length?{c}:{}),...(stats.stats.length?{stats:stats.stats}:{}),...(group.refs.length?{attachments:group.refs}:{}),
  }};
  try{validate({...block,rows:[{id:row.id,cells}]});}
  catch(error){message.textContent=errorMessage(error);return;}
  row.cells=cells;
  d.close();
  onSave(row.id,column.id);
 });
 const d=context.dialog(column.label,[el('div',{class:'wiki-form'},
  el('fieldset',{},el('legend',{},t('Text buňky')),rich.node),
  el('fieldset',{},el('legend',{},t('Statistiky')),stats.node),
  el('fieldset',{},el('legend',{},t('Přílohy')),group.node),message,actions(apply))]);
 d.addEventListener('close',rich.stop,{once:true});
 rich.focus();
}

export function editInventory(value,context,onSave){
 const block=structuredClone(value),columns=el('div',{class:'wiki-edit-list'}),table=el('div',{}),message=alert();
 const rowMenu=el('select',{}),rowActions=el('div',{}),cellButtons=new Map();
 const addColumn=button(t('Přidat sloupec'),()=>{
  block.columns.push({id:newWikiItemId('column'),label:t('Sloupec {index}',{index:block.columns.length+1})});
  drawColumns(block.columns.length-1);
  drawTable();
 });
 const addRow=button(t('Přidat řádek'),()=>{
  const row={id:newWikiItemId('row'),cells:{}};
  block.rows.push(row);
  drawTable(row.id);
  cellButtons.get(row.id)?.get(block.columns[0].id)?.focus();
 });
 const apply=button(t('Použít změny'),()=>{
  try{const saved=validate(block);d.close();onSave(saved);}
  catch(error){message.textContent=errorMessage(error);}
 });
 const d=context.dialog(t('Tabulka inventáře'),[el('div',{class:'wiki-form'},
  el('fieldset',{class:'wiki-form'},el('legend',{},t('Sloupce')),columns,addColumn),
  el('fieldset',{class:'wiki-form'},el('legend',{},t('Řádky')),actions(addRow,label('Vybrat řádek',rowMenu),rowActions),table),
  message,actions(apply))],{className:'wiki-inventory-dialog'});

 function drawColumns(focus){
  columns.replaceChildren(...block.columns.map((column,index)=>{
   const name=input(column.label,WIKI_LIMITS.label,e=>{column.label=e.target.value;});
   name.addEventListener('change',()=>drawTable(rowMenu.value));
   const controls=arrange(block.columns,index,i=>{drawColumns(i);drawTable(rowMenu.value);},removed=>{
    for(const row of block.rows)delete row.cells[removed.id];
   });
   if(block.columns.length===1)controls.lastElementChild.disabled=true;
   return el('div',{class:'wiki-column-edit'},label('Název sloupce',name),controls);
  }));
  addColumn.disabled=block.columns.length>=WIKI_LIMITS.columns;
  if(focus!==undefined)columns.children[focus]?.querySelector('input')?.focus();
 }
 function drawRows(){
  const index=block.rows.findIndex(row=>row.id===rowMenu.value);
  rowActions.replaceChildren(...(index===-1?[]:[arrange(block.rows,index,i=>{drawTable(block.rows[i]?.id);rowMenu.focus();})]));
 }
 function drawTable(rowId){
  cellButtons.clear();
  rowMenu.replaceChildren(...block.rows.map((row,index)=>option(row.id,t('Řádek {index}',{index:index+1}))));
  if(rowId)rowMenu.value=rowId;
  rowMenu.disabled=!block.rows.length;
  drawRows();
  addRow.disabled=block.rows.length>=WIKI_LIMITS.rows;
  table.replaceChildren(wikiInventory(block,{inline:context.inline,group:refs=>refs.length?note(t('Přílohy ({count})',{count:refs.length})):null,
   editCell(row,column,index){
    const edit=button(t('Upravit buňku'),()=>showCellEditor(block,row,column,context,(rowId,columnId)=>{
     drawTable(rowId);
     cellButtons.get(rowId)?.get(columnId)?.focus();
    }),{'aria-label':t('Upravit buňku {column}, řádek {index}',{column:column.label,index:index+1})});
    if(!cellButtons.has(row.id))cellButtons.set(row.id,new Map());
    cellButtons.get(row.id).set(column.id,edit);
    return edit;
   }}));
 }
 rowMenu.addEventListener('change',drawRows);
 drawColumns();
 drawTable();
}

export function manageWikiSources(project,dialog){
 const content=el('div',{class:'wiki-form'},note('Načítám zdroje…'));
 const d=dialog(t('Povolené zdroje wiki'),[note('Po uložení stránky uvidí kopii všichni čtenáři projektu.'),content]);
 async function load(){
  const [sources,git]=await Promise.all([wikiApi('/api/wiki/'+project+'/sources'),wikiApi('/api/git-lfs').catch(()=>null)]);
  if(!d.open)return;
  const message=alert();
  async function set(data,control){
   control.disabled=true;
   try{await wikiApi('/api/admin/wiki/sources',{project,...data});await load();}
   catch(error){message.textContent=error.message;control.disabled=false;}
  }
  const configured=git?.connections??[];
  const conn=el('select',{},configured.map(entry=>option(entry.id,entry.name)));
  const repo=input('',201),origin=input('',300),review=input('',12);
  const authorize=button(t('Povolit repozitář'),()=>{
   if(!conn.value||!repo.value.trim()){message.textContent=t('Vyber připojení a zadej repozitář.');return;}
   set({kind:'lfs',enabled:true,connection:conn.value,repo:repo.value.trim(),downloadOrigin:origin.value.trim()},authorize);
  });
  const useReview=button(t('Povolit sadu Review'),()=>{
   if(!review.value.trim()){message.textContent=t('Zadej ID sady Review.');return;}
   set({kind:'review',enabled:true,set:review.value.trim()},useReview);
  });
  function remove(data,label){
   const revoke=button(t('Odebrat povolení'),()=>set({...data,enabled:false},revoke));
   return el('li',{},actions(el('span',{},label),revoke));
  }
  const existing=[
   ...sources.repositories.map(grant=>remove({kind:'lfs',connection:grant.connection,repo:grant.repo},
    grant.repo+' · '+grant.connection+(grant.current?'':' · '+t('Připojení se změnilo')))),
   ...sources.reviewGrants.map(set=>remove({kind:'review',set},'Review '+set)),
  ];
  content.replaceChildren(
   existing.length?el('ul',{class:'wiki-grants'},existing):note('Nemáš nastavená další povolení.'),
   el('fieldset',{class:'wiki-form'},el('legend',{},'Git LFS'),
    configured.length?label('Připojení Git LFS',conn):note('Nejprve nastav připojení v Git LFS.'),
    configured.length?label('Repozitář (vlastník/název)',repo):null,configured.length?label('Povolený původ souborů HTTPS (volitelné)',origin):null,
    configured.length?authorize:null),
   el('fieldset',{class:'wiki-form'},el('legend',{},'Review'),label('ID sady z jiného projektu',review),useReview),message);
 }
 load().catch(error=>content.replaceChildren(el('p',{role:'alert'},error.message)));
}
