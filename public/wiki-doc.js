// The browser and the wiki store share the same structured document format.
export const PAGE_ID=/^w[a-z2-7]{11}$/;
export const HTML_ID=/^h[a-z2-7]{8}$/;
export const ASSET_ID=/^a[a-f0-9]{32}$/;
export const WIKI_ITEM_ID=/^[a-z][a-z0-9-]{0,39}$/;
export const WIKI_LIMITS=Object.freeze({
 title:120,pages:500,docBytes:256*1024,blocks:1000,rows:100,columns:20,cell:2000,
 htmlBlocks:10,htmlBytes:64*1024,label:120,minHeight:80,maxHeight:2000,bodyBytes:512*1024,
 attachments:50,stats:50,caption:1000,clip:200,
});
export const WIKI_MARKS=Object.freeze(['b','i','s','code']);

const fail=code=>{throw new Error(code);};
const invalid=()=>fail('invalid');
const bytes=value=>new TextEncoder().encode(value).length;
export const exactKeys=(value,keys)=>value!==null&&typeof value==='object'&&
 (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)&&
 Object.keys(value).every(key=>keys.includes(key));

function string(value){
 if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0'))invalid();
 return value;
}

export function wikiTitle(value){
 const title=string(value).trim();
 if(!title||title.length>WIKI_LIMITS.title)invalid();
 return title;
}

export function wikiUrl(value){
 const href=string(value).trim();
 if(href.length>2048||!/^https?:\/\//i.test(href))invalid();
 let url;
 try{url=new URL(href);}catch{invalid();}
 if(url.href.length>2048||url.username||url.password)invalid();
 return url.href;
}

export function htmlSource(value){
 const source=string(value);
 if(bytes(source)>WIKI_LIMITS.htmlBytes)fail('limit');
 return source;
}

function array(value,max=WIKI_LIMITS.docBytes){
 if(!Array.isArray(value))invalid();
 if(value.length>max)fail('limit');
 return value;
}

function textRun(run){
 if(run?.t!=='text'||!exactKeys(run,['t','text','m']))invalid();
 const text=string(run.text);
 if(run.m===undefined)return {t:'text',text};
 const marks=array(run.m,WIKI_MARKS.length);
 if(!marks.every(mark=>WIKI_MARKS.includes(mark)))invalid();
 const m=WIKI_MARKS.filter(mark=>marks.includes(mark));
 return m.length?{t:'text',text,m}:{t:'text',text};
}

function inline(value){
 return array(value).map(run=>{
  switch(run?.t){
   case 'text':return textRun(run);
   case 'link':
    if(!exactKeys(run,['t','href','c']))invalid();
    return {t:'link',href:wikiUrl(run.href),c:array(run.c).map(textRun)};
   case 'ticket':
    if(!exactKeys(run,['t','id'])||typeof run.id!=='string'||!/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$/.test(run.id))invalid();
    return {t:'ticket',id:run.id};
   default:return invalid();
  }
 });
}

function table(block){
 if(!exactKeys(block,['t','header','rows'])||typeof block.header!=='boolean')invalid();
 const rows=array(block.rows,WIKI_LIMITS.rows);
 const columns=array(rows[0],WIKI_LIMITS.columns).length;
 if(!columns)invalid();
 return {t:'table',header:block.header,rows:rows.map(row=>{
  if(array(row,WIKI_LIMITS.columns).length!==columns)invalid();
  return row.map(value=>{
   return cellRuns(value);
  });
 })};
}

function cellRuns(value){
 const runs=inline(value);
 const chars=runs.reduce((sum,run)=>sum+(run.text?.length??run.id?.length??run.c.reduce((n,text)=>n+text.text.length,0)),0);
 if(chars>WIKI_LIMITS.cell)fail('limit');
 return runs;
}

function boundedText(value,max,required=false){
 const text=string(value).trim();
 if(required&&!text)invalid();
 if(text.length>max)fail('limit');
 return text;
}

export function wikiAttachment(ref){
 if(!exactKeys(ref,['assetId','label','caption','displayAssetId','initialClip'])||typeof ref.assetId!=='string'||!ASSET_ID.test(ref.assetId))invalid();
 const {displayAssetId}=ref;
 if(displayAssetId!==undefined&&(typeof displayAssetId!=='string'||!ASSET_ID.test(displayAssetId)||displayAssetId===ref.assetId))invalid();
 const initialClip=ref.initialClip===undefined?'':string(ref.initialClip);
 if(initialClip.length>WIKI_LIMITS.clip)fail('limit');
 return {assetId:ref.assetId,label:boundedText(ref.label??'',WIKI_LIMITS.label),caption:boundedText(ref.caption??'',WIKI_LIMITS.caption),
  ...(displayAssetId===undefined?{}:{displayAssetId}),...(initialClip?{initialClip}:{})};
}

export function wikiDisplayType(original,preview){
 return original==='model/gltf-binary'?preview===original:Boolean(original?.startsWith('video/')&&preview?.startsWith('video/'));
}

function group(value){
 return array(value,WIKI_LIMITS.attachments).map(wikiAttachment);
}

function itemId(id,ids){
 if(typeof id!=='string'||!WIKI_ITEM_ID.test(id)||ids.has(id))invalid();
 ids.add(id);
 return id;
}

function stats(value){
 return array(value,WIKI_LIMITS.stats).map(stat=>{
  if(!exactKeys(stat,['name','value','unit']))invalid();
  const name=boundedText(stat.name,WIKI_LIMITS.label,true);
  const number=typeof stat.value==='number'&&Number.isFinite(stat.value);
  const val=number?stat.value:boundedText(stat.value,WIKI_LIMITS.cell,true);
  return {name,value:val,...(stat.unit===undefined?{}:{unit:boundedText(stat.unit,WIKI_LIMITS.label)})};
 });
}

function inventory(block,ids){
 if(!exactKeys(block,['t','id','columns','rows']))invalid();
 const id=itemId(block.id,ids),columnIds=new Set(),rowIds=new Set();
 const columns=array(block.columns,WIKI_LIMITS.columns).map(column=>{
  if(!exactKeys(column,['id','label']))invalid();
  return {id:itemId(column.id,columnIds),label:boundedText(column.label,WIKI_LIMITS.label,true)};
 });
 if(!columns.length)invalid();
 const rows=array(block.rows,WIKI_LIMITS.rows).map(row=>{
  if(!exactKeys(row,['id','cells'])||!exactKeys(row.cells,[...columnIds]))invalid();
  const cells={};
  for(const column of columns){
   if(!Object.hasOwn(row.cells,column.id))continue;
   const cell=row.cells[column.id];
   if(!exactKeys(cell,['c','stats','attachments']))invalid();
   cells[column.id]={
    ...(cell.c===undefined?{}:{c:cellRuns(cell.c)}),
    ...(cell.stats===undefined?{}:{stats:stats(cell.stats)}),
    ...(cell.attachments===undefined?{}:{attachments:group(cell.attachments)}),
   };
  }
  return {id:itemId(row.id,rowIds),cells};
 });
 return {t:'inventory',id,columns,rows};
}

function html(block,ids){
 if(!exactKeys(block,['t','id','label','height','source'])||typeof block.id!=='string'||!HTML_ID.test(block.id)||
    ids.has(block.id)||!Number.isInteger(block.height)||block.height<WIKI_LIMITS.minHeight||block.height>WIKI_LIMITS.maxHeight)invalid();
 const label=string(block.label).trim();
 if(!label||label.length>WIKI_LIMITS.label)invalid();
 ids.add(block.id);
 if(ids.size>WIKI_LIMITS.htmlBlocks)fail('limit');
 return {t:'html',id:block.id,label,height:block.height,source:htmlSource(block.source)};
}

function blockValue(block,htmlIds,inventoryIds){
 switch(block?.t){
  case 'p':case 'quote':
   if(!exactKeys(block,['t','c']))invalid();
   return {t:block.t,c:inline(block.c)};
  case 'h':
   if(!exactKeys(block,['t','level','c'])||![1,2,3].includes(block.level))invalid();
   return {t:'h',level:block.level,c:inline(block.c)};
  case 'ul':case 'ol':
   if(!exactKeys(block,['t','items']))invalid();
   return {t:block.t,items:array(block.items,WIKI_LIMITS.blocks).map(inline)};
  case 'code':
   if(!exactKeys(block,['t','text']))invalid();
   return {t:'code',text:string(block.text)};
  case 'hr':
   if(!exactKeys(block,['t']))invalid();
   return {t:'hr'};
  case 'table':return table(block);
  case 'html':return html(block,htmlIds);
  case 'inventory':return inventory(block,inventoryIds);
  case 'attachments':
   if(!exactKeys(block,['t','id','attachments']))invalid();
   return {t:'attachments',id:itemId(block.id,inventoryIds),attachments:group(block.attachments)};
  default:return invalid();
 }
}

export function normalizeDoc(doc){
 if(!exactKeys(doc,['v','blocks'])||doc.v!==1)invalid();
 const htmlIds=new Set(),inventoryIds=new Set();
 const result={v:1,blocks:array(doc.blocks,WIKI_LIMITS.blocks).map(block=>blockValue(block,htmlIds,inventoryIds))};
 if(bytes(JSON.stringify(result))>WIKI_LIMITS.docBytes)fail('limit');
 return result;
}

export function extractLinks(doc){
 const tickets=new Set();
 const visit=runs=>{for(const run of runs)if(run.t==='ticket')tickets.add(run.id);};
 for(const block of doc.blocks){
  if(block.c)visit(block.c);
  for(const item of block.items??[])visit(item);
  if(block.t==='table')for(const row of block.rows)for(const cell of row)visit(cell);
  if(block.t==='inventory')for(const row of block.rows)for(const cell of Object.values(row.cells))visit(cell.c??[]);
 }
 return {tickets:[...tickets]};
}

export function* wikiAttachmentRefs(doc){
 for(const block of doc.blocks){
  if(block.t==='attachments')yield* block.attachments;
  if(block.t==='inventory')for(const row of block.rows)for(const cell of Object.values(row.cells))yield* cell.attachments??[];
 }
}

export function wikiAssetIds(doc){
 const ids=new Set();
 for(const ref of wikiAttachmentRefs(doc)){
  ids.add(ref.assetId);
  if(ref.displayAssetId)ids.add(ref.displayAssetId);
 }
 return [...ids];
}
