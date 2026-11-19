import {exactKeys,PAGE_ID,WIKI_ITEM_ID,WIKI_LIMITS,wikiAssetIds} from '../public/wiki-doc.js';
import {validImportPath} from './git-lfs-git.mjs';
import {validFullName} from './git-lfs-providers.mjs';
import {SHA} from './review-store.mjs';
import {checkRevision} from './wiki-store.mjs';

const fail=code=>{throw new Error(code);};
export const MAX_LIST=100,MAX_ROWS=20;
const ROW_BYTES=48*1024;
const MODES=['full','summary','inventory','assets'];
const sourceKinds=['lfs','review','lfs-member'];
const assetKeys=['project','query','type','digest','sourceKind','minSize','maxSize','offset','limit'];
const matches=(value,pattern)=>typeof value==='string'&&pattern.test(value);
const itemId=value=>matches(value,WIKI_ITEM_ID);
const size=value=>Number.isSafeInteger(value)&&value>=0;

export function wikiArchiveMember(input){
 const keys=['connection','repo','commit','archivePath','archiveOid','memberPath','originalDigest'];
 if(!exactKeys(input,keys)||!matches(input.connection,/^c[a-f0-9]{10}$/)||!validFullName(input.repo)||
  !matches(input.commit,/^[a-f0-9]{40}([a-f0-9]{24})?$/)||!validImportPath(input.archivePath)||
  !matches(input.archiveOid,SHA)||!validImportPath(input.memberPath)||!matches(input.originalDigest,SHA))fail('invalid-target');
 return {kind:'lfs-member',verification:'author-reported',...Object.fromEntries(keys.map(key=>[key,input[key]]))};
}

export function pagination({offset=0,limit},{max=MAX_LIST,defaultLimit=20}={}){
 if(limit===undefined)limit=defaultLimit;
 if(!size(offset)||!Number.isSafeInteger(limit)||limit<1||limit>max)fail('invalid');
 return {offset,limit};
}

export function collectionPage(items,window){
 const {offset,limit}=pagination(window),page=items.slice(offset,offset+limit);
 return {items:page,total:items.length,offset,limit,nextOffset:offset+page.length<items.length?offset+page.length:null};
}

export function assetPage(items,input,view){
 if(!exactKeys(input,assetKeys))fail('invalid');
 const {query,type,digest,sourceKind,minSize,maxSize}=input;
 if(query!==undefined&&(typeof query!=='string'||query.length>200)||
  type!==undefined&&!matches(type,/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i)||
  digest!==undefined&&!matches(digest,SHA)||sourceKind!==undefined&&!sourceKinds.includes(sourceKind)||
  minSize!==undefined&&!size(minSize)||maxSize!==undefined&&!size(maxSize)||minSize>maxSize)fail('invalid');
 const needle=query?.trim().toLowerCase();
 const matchesFilter=asset=>(!type||asset.type===type.toLowerCase())&&(!digest||asset.digest===digest)&&
  (!sourceKind||asset.source?.kind===sourceKind)&&(minSize===undefined||asset.size>=minSize)&&(maxSize===undefined||asset.size<=maxSize)&&
  (!needle||[asset.name,asset.id,asset.digest,asset.source?.path,asset.source?.memberPath].some(value=>value?.toLowerCase().includes(needle)));
 const {items:page,...window}=collectionPage(items.filter(matchesFilter),input);
 return {...window,assets:page.map(view)};
}

function inventory(page,tableId){
 if(!itemId(tableId))fail('invalid-target');
 return page.doc.blocks.find(block=>block.t==='inventory'&&block.id===tableId)??fail('invalid-target');
}

function expectIds(ids,max){
 if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>max||
  !ids.every(itemId)||new Set(ids).size!==ids.length))fail('invalid-target');
}

function summary(page){
 const inventories=[],attachmentGroups=[];
 for(const block of page.doc.blocks){
  if(block.t==='inventory')inventories.push({id:block.id,rows:block.rows.length,columns:block.columns.length});
  if(block.t==='attachments')attachmentGroups.push({id:block.id,attachments:block.attachments.length});
 }
 return {blocks:page.doc.blocks.length,assetCount:wikiAssetIds(page.doc).length,ticketCount:page.links.tickets.length,
  inventories,attachmentGroups};
}

function inventoryPage(table,input){
 const {rowIds,columnIds}=input;
 expectIds(rowIds,WIKI_LIMITS.rows);
 expectIds(columnIds,WIKI_LIMITS.columns);
 const {offset,limit}=pagination(input,{max:MAX_ROWS,defaultLimit:10});
 const columns=columnIds?table.columns.filter(column=>columnIds.includes(column.id)):table.columns;
 const matchingRows=rowIds?table.rows.filter(row=>rowIds.includes(row.id)):table.rows;
 if(columnIds&&columns.length!==columnIds.length||rowIds&&matchingRows.length!==rowIds.length)fail('invalid-target');
 const rows=[];
 let remaining=ROW_BYTES;
 for(const {id,cells} of matchingRows.slice(offset,offset+limit)){
  const row={id,cells:Object.fromEntries(columns.filter(column=>Object.hasOwn(cells,column.id)).map(column=>[column.id,cells[column.id]]))};
  remaining-=Buffer.byteLength(JSON.stringify(row));
  if(remaining<0){
   if(!rows.length)fail('selection-too-large');
   break;
  }
  rows.push(row);
 }
 return {tableId:table.id,columns,rows,total:matchingRows.length,offset,limit,nextOffset:offset+rows.length<matchingRows.length?offset+rows.length:null};
}

export async function wikiRead(wiki,page,input){
 const {mode='full'}=input;
 if(!MODES.includes(mode))fail('invalid');
 const filters=['tableId','rowIds','columnIds'],window=['offset','limit'];
 if(mode!=='inventory'&&filters.some(key=>input[key]!==undefined)||
  !['inventory','assets'].includes(mode)&&window.some(key=>input[key]!==undefined))fail('invalid');
 if(mode==='full')return wiki.withAssets(page);
 if(mode==='summary')return summary(page);
 if(mode==='inventory')return inventoryPage(inventory(page,input.tableId),input);
 const {items, ...meta}=collectionPage(wikiAssetIds(page.doc),input);
 const {assets}=await wiki.withAssets({project:page.project,doc:{blocks:[{t:'attachments',attachments:items.map(assetId=>({assetId}))}]}});
 return {...meta,assets};
}

export async function wikiPatch(wiki,input,by,actor){
 const {id,project,rev,patch,title}=input;
 if(!exactKeys(input,['id','project','rev','patch','title'])||!matches(id,PAGE_ID)||!Number.isSafeInteger(rev)||rev<1||!exactKeys(patch,['tableId','rowId','cells'])||
  !itemId(patch.rowId))fail('invalid');
 await wiki.projectOf(project);
 const page=await wiki.get(project,id);
 checkRevision(page,rev);
 const table=inventory(page,patch.tableId),row=table.rows.find(row=>row.id===patch.rowId);
 if(!row||!exactKeys(patch.cells,table.columns.map(column=>column.id)))fail('invalid-target');
 const edits=Object.entries(patch.cells);
 if(!edits.length)fail('invalid-target');
 for(const [column,cell] of edits){
  if(cell===null)delete row.cells[column];
  else row.cells[column]=cell;
 }
 const saved=await wiki.update({id,project,rev,title,doc:page.doc},by,actor);
 const savedRow=inventory(saved,patch.tableId).rows.find(row=>row.id===patch.rowId);
 return {page:saved,patch:{tableId:patch.tableId,rowId:patch.rowId,
  cells:Object.fromEntries(edits.map(([column])=>[column,Object.hasOwn(savedRow.cells,column)?savedRow.cells[column]:null]))}};
}
