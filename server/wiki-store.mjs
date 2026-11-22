import {createHash,randomBytes} from 'node:crypto';
import {exactKeys,extractLinks,normalizeDoc,PAGE_ID,WIKI_ITEM_ID,WIKI_LIMITS,wikiTitle,wikiAssetIds,wikiAttachment,wikiAttachmentRefs,wikiDisplayType} from '../public/wiki-doc.js';
import {PROJECT_ID,TICKET_ID} from './tickets-store.mjs';
import {createMentionGuard} from './references.mjs';

export const WIKI_SCHEMA=5;
export const WIKI_SPACE_ID=/^[a-z][a-z0-9-]{1,39}$/;
export const MAX_LIST=100,MAX_ROWS=20;
const ROW_BYTES=48*1024;
const MODES=['full','summary','inventory','assets'];
const RESERVED_SPACE_IDS=new Set(['setup','spaces','pages','uploads','assets','attachments','preview','frame','tickets','sources']);
const ALPHABET='abcdefghijklmnopqrstuvwxyz234567';
const fail=code=>{throw new Error(code);};
const matches=(value,pattern)=>typeof value==='string'&&pattern.test(value);
const itemId=value=>matches(value,WIKI_ITEM_ID);
const size=value=>Number.isSafeInteger(value)&&value>=0;
const pageId=()=> 'w'+Array.from(randomBytes(11),byte=>ALPHABET[byte&31]).join('');
export function wikiKey(space,id){return space+'/'+id;}
const pageRow=page=>wikiKey(page.project,page.id);
const rows=(items,key)=>items.map(item=>[key(item),item]);
const docs=items=>(items??[]).map(([,value])=>value);
const projection=({id,project,parentId,title,rev,updatedAt,updatedBy,links})=>({id,project,parentId,title,rev,updatedAt,updatedBy,links});
const plainText=text=>[{t:'text',text:text.toWellFormed().replaceAll('\0','\ufffd')}];
const emptyDoc=()=>({v:1,blocks:[]});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
export function wikiSpaceName(value){
 if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0'))fail('invalid');
 const name=value.trim();
 if(!name||name.length>80)fail('invalid');
 return name;
}
export function wikiPageUrl(space,id){return `#wiki/${space}${id?'/'+id:''}`;}
export function wikiAssetView({id,project,name,type,size,digest,source}){
 return {id,project,name,type,size,digest,...(source?{source}:{}),url:`/api/wiki/${project}/assets/${id}`};
}
export function canUseAsset(asset,actor){
 return Boolean(asset)&&(asset.references>0||Boolean(actor)&&asset.owner===actor);
}
export function usableAsset(assets,id,actor){
 const asset=assets instanceof Map?assets.get(id):assets;
 if(!canUseAsset(asset,actor))fail('invalid-asset');
 return asset;
}
export function checkWikiAttachment(ref,assets,actor){
 const asset=usableAsset(assets,ref.assetId,actor);
 if(ref.initialClip&&asset.type!=='model/gltf-binary')fail('invalid-asset');
 if(ref.displayAssetId&&!wikiDisplayType(asset.type,usableAsset(assets,ref.displayAssetId,actor).type))fail('invalid-asset');
}
export function publishWikiAsset(asset){
 asset.references++;
 asset.published=true;
 asset.orphanedAt=null;
}
export function updateAssetReferences(assetList,doc,previous,actor,at=Date.now()){
 const before=new Set(previous?wikiAssetIds(previous):[]),after=new Set(wikiAssetIds(doc));
 const assets=new Map(assetList.map(asset=>[asset.id,asset]));
 for(const ref of wikiAttachmentRefs(doc))checkWikiAttachment(ref,assets,actor);
 for(const id of after){
  if(!before.has(id))publishWikiAsset(assets.get(id));
 }
 for(const id of before){
  if(after.has(id))continue;
  const asset=assets.get(id);
  if(asset&&--asset.references===0)asset.orphanedAt=at;
 }
}
export function wikiActor(input){
 const p=input?.principal??input;
 return p.authKind+':'+(p.accountId??p.id??p.username);
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

function spaceKey(space){return space.id??space.project;}
function spaceRecord(space){
 if(!space)return null;
 const id=space.id??space.project;
 const projectId=Object.hasOwn(space,'projectId')?space.projectId:(space.project??null);
 const name=typeof space.name==='string'&&space.name.trim()?space.name.trim():id;
 return {id,name,projectId,home:space.home,count:space.count,createdAt:space.createdAt,createdBy:space.createdBy};
}

export function wikiCollection(db){
 const keys={wikis:spaceKey,pages:pageRow,summaries:pageRow,assets:pageRow,uploads:u=>u.id,blobs:b=>b.digest,receipts:r=>r.key,grants:g=>g.key};
 const names=Object.keys(keys);
 function checkMeta(meta){if(meta.schema!==WIKI_SCHEMA)throw new Error('Unsupported wiki schema');}
 return db.collection('wiki',{
  checkMeta,empty:()=>({schema:WIKI_SCHEMA,revision:0,updatedAt:null}),
  split:data=>{
   const meta={...data},colls={};
   for(const name of names){colls[name]=rows(data[name]??[],keys[name]);delete meta[name];}
   return {meta,colls};
  },
  join:(meta,colls)=>{
   checkMeta(meta);
   return {...meta,...Object.fromEntries(names.map(name=>[name,docs(colls[name])]))};
  },
 });
}

export function checkRevision(page,rev){
 if(!page)fail('not-found');
 if(page.rev!==rev){
  const {rev,updatedAt,updatedBy}=page;
  throw Object.assign(new Error('conflict'),{current:{rev,updatedAt,updatedBy}});
 }
}

function checkedIdentity(input){
 if(typeof input.id!=='string'||!PAGE_ID.test(input.id)||!Number.isSafeInteger(input.rev)||input.rev<1)fail('invalid');
}

function retryKey(space,operation,id,actor,required=false){
 if(id===undefined&&!required)return null;
 if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)||!actor)fail('invalid');
 return wikiKey(space,hash([actor,operation,id]));
}

function replay({receipts},fingerprint){
 const receipt=receipts[0];
 if(!receipt)return null;
 if(receipt.fingerprint!==fingerprint)fail('request-conflict');
 return {...receipt.result,replayed:true};
}

const RECEIPT_LIFETIME=7*24*60*60*1000;
function remember(data,key,fingerprint,page){
 if(key)data.receipts.push({key,fingerprint,expiresAt:Date.now()+RECEIPT_LIFETIME,result:projection(page)});
}

function record(data,page){
 const index=data.summaries.findIndex(other=>other.project===page.project&&other.id===page.id);
 if(index===-1)data.summaries.push(projection(page));
 else data.summaries[index]=projection(page);
 data.revision++;
 data.updatedAt=page.updatedAt;
}

function changePage(data,page,by,fields,at=now()){
 if(fields.length){
  const rev=++page.rev;
  page.updatedAt=at;
  page.updatedBy=by;
  page.history.push(...fields.map(field=>({at,by,rev,field})));
  page.history=page.history.slice(-50);
  record(data,page);
 }
 return page;
}

function makePage(space,id,parentId,title,doc,by,at){
 return {id,project:space,parentId,title,doc,links:extractLinks(doc),rev:1,createdAt:at,createdBy:by,updatedAt:at,updatedBy:by,
  history:[{at,by,rev:1,field:'created'}]};
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

function patchCandidateRefs(cells){
 if(!cells||typeof cells!=='object')return [];
 const seen=new Map();
 for(const cell of Object.values(cells)){
  if(!Array.isArray(cell?.c))continue;
  for(const run of cell.c){
   if(run?.t==='ticket'&&typeof run.id==='string')seen.set('ticket\0'+run.id,{kind:'ticket',id:run.id});
   else if(run?.t==='ref'&&typeof run.kind==='string'&&typeof run.id==='string')seen.set(run.kind+'\0'+run.id,{kind:run.kind,id:run.id});
  }
 }
 return [...seen.values()];
}

function parentOf(input){
 if(typeof input!=='string'||!PAGE_ID.test(input))fail('invalid-parent');
 return input;
}

function orderedTree(pages){
 const children=new Map();
 for(const page of pages){
  if(!children.has(page.parentId))children.set(page.parentId,[]);
  children.get(page.parentId).push(page);
 }
 const ordered=[];
 function walk(parent){
  const siblings=children.get(parent)??[];
  siblings.sort((a,b)=>a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
  for(const page of siblings){ordered.push(page);walk(page.id);}
 }
 walk(null);
 return ordered;
}

export function createWikiTargetLookup(db){
 const query=db.db.prepare(`SELECT json_extract(p.doc,'$.project') AS spaceId,
  COALESCE(json_extract(w.doc,'$.projectId'),CASE WHEN json_type(w.doc,'$.projectId')='null' THEN NULL ELSE json_extract(w.doc,'$.project') END) AS projectId
  FROM docs p
  JOIN docs w ON w.kind='wiki' AND w.coll='wikis' AND w.id=json_extract(p.doc,'$.project')
  WHERE p.kind='wiki' AND p.coll='summaries' AND p.id=?`);
 return id=>{
  const row=query.get(id);
  return row?{spaceId:row.spaceId,projectId:row.projectId??null}:null;
 };
}

export function createWikiProjectLookup(db){
 const lookup=createWikiTargetLookup(db);
 return id=>lookup(id)?.projectId??null;
}

function defaultHomeTitle(name){return wikiTitle(`${name} Home`);}

function createSpaceInData(data,{id,name,projectId=null,description='',homeTitle},by,at){
 if(data.wikis.some(w=>spaceKey(w)===id||(projectId!==null&&spaceRecord(w).projectId===projectId)))fail('conflict');
 if(data.pages.some(p=>p.project===id))fail('conflict');
 const rootId=pageId();
 const blocks=[{t:'h',level:1,c:plainText(name)}];
 if(description)blocks.push({t:'p',c:plainText(description)});
 const space={id,name,projectId,home:rootId,count:1,createdAt:at,createdBy:by};
 const page=makePage(id,rootId,null,homeTitle,normalizeDoc({v:1,blocks}),by,at);
 data.wikis.push(space);
 data.pages.push(page);
 record(data,page);
 return {space,home:rootId,page};
}

function renameHomeInData(data,space,oldTitle,newTitle,by,at){
 if(!space)return {renamed:false,page:null};
 const target=spaceRecord(space);
 const page=data.pages.find(entry=>entry.project===target.id&&entry.id===target.home);
 if(!page)return {renamed:false,page:null};
 if(oldTitle!==undefined&&oldTitle!==null&&page.title!==oldTitle)return {renamed:false,page};
 const title=wikiTitle(newTitle);
 if(page.title===title)return {renamed:false,page};
 page.title=title;
 changePage(data,page,by,['title'],at);
 return {renamed:true,page};
}

function removeSpaceInData(data,space,at=now()){
 if(!space)return {removed:false,spaceId:null,pageIds:[],pageKeys:[],assetIds:[],orphanedDigests:[],removedUploads:[]};
 const spaceId=spaceKey(space),prefix=spaceId+'/';
 data.wikis=data.wikis.filter(entry=>spaceKey(entry)!==spaceId);
 const removedPages=data.pages.filter(page=>page.project===spaceId);
 const pageIds=removedPages.map(page=>page.id);
 const pageKeys=removedPages.map(page=>wikiKey(spaceId,page.id));
 data.pages=data.pages.filter(page=>page.project!==spaceId);
 data.summaries=data.summaries.filter(entry=>entry.project!==spaceId);
 data.grants=data.grants.filter(grant=>grant.project!==spaceId);
 data.receipts=data.receipts.filter(receipt=>!receipt.key.startsWith(prefix));
 const removedUploads=data.uploads.filter(upload=>upload.project===spaceId).map(upload=>upload.id);
 data.uploads=data.uploads.filter(upload=>upload.project!==spaceId);
 const removedAssets=data.assets.filter(asset=>asset.project===spaceId);
 const assetIds=removedAssets.map(asset=>asset.id);
 const blobs=new Map(data.blobs.map(blob=>[blob.digest,blob]));
 const orphanedDigests=new Set();
 for(const asset of removedAssets){
  const blob=blobs.get(asset.digest);
  if(blob){
   blob.references--;
   if(blob.references<=0)orphanedDigests.add(blob.digest);
  }
 }
 data.assets=data.assets.filter(asset=>asset.project!==spaceId);
 data.blobs=data.blobs.filter(blob=>blob.references>0);
 data.revision++;
 data.updatedAt=at;
 return {removed:true,spaceId,pageIds,pageKeys,assetIds,orphanedDigests:[...orphanedDigests],removedUploads};
}

export function createWikiStore(db,tickets,{mentionGuard=null,readDocument=null,cleanupFiles=null}={}){
 const store=wikiCollection(db);
 const wikiTargetSync=createWikiTargetLookup(db);
 const wikiProjectSync=id=>wikiTargetSync(id)?.projectId??null;
 const guardMentions=mentionGuard??createMentionGuard({db,tickets,wiki:{wikiTargetSync,wikiProjectSync}});
 const getAssetRow=db.db.prepare("SELECT doc FROM docs WHERE kind='wiki' AND coll='assets' AND id=?");
 const putAssetRow=db.db.prepare("INSERT INTO docs(kind,coll,id,doc) VALUES('wiki','assets',?,?) ON CONFLICT(kind,coll,id) DO UPDATE SET doc=excluded.doc");
 const hasProjectRow=db.db.prepare("SELECT 1 FROM docs WHERE kind='tickets' AND coll='projects' AND id=?");
 const projectExistsSync=id=>tickets?.hasProjectSync?tickets.hasProjectSync(id):Boolean(hasProjectRow.get(id));
 let cached=null;

 async function allProjects(){return typeof tickets?.projects==='function'?await tickets.projects():[];}

 async function projectOf(id){
  if(!matches(id,PROJECT_ID))fail('invalid');
  return (await allProjects()).find(project=>project.id===id)??fail('not-found');
 }

 async function resolveSpaceView(raw,projectsMap){
  const s=spaceRecord(raw);
  const project=s.projectId?(projectsMap?projectsMap.get(s.projectId):(await allProjects()).find(p=>p.id===s.projectId)):null;
  return {...s,name:project?project.name:s.name};
 }

 async function spaceOf(id){
  if(!matches(id,WIKI_SPACE_ID))fail('invalid');
  const raw=await store.get('wikis',id);
  if(!raw)fail('not-found');
  return resolveSpaceView(raw);
 }

 async function spaceOrProjectOf(id){
  if(!matches(id,WIKI_SPACE_ID))fail('invalid');
  const raw=await store.get('wikis',id);
  if(raw)return resolveSpaceView(raw);
  const project=(await allProjects()).find(p=>p.id===id);
  if(!project)fail('not-found');
  return {id:project.id,name:project.name,projectId:project.id};
 }

 async function spaceForProject(projectId){
  if(!matches(projectId,PROJECT_ID))fail('invalid');
  const wikis=await store.list('wikis');
  const found=wikis.map(spaceRecord).find(w=>w.projectId===projectId);
  if(!found)return null;
  return resolveSpaceView(found);
 }

 async function spaces({includeHidden=true}={}){
  const [projects,wikis]=await Promise.all([allProjects(),store.list('wikis')]);
  const byProject=new Map(projects.map(p=>[p.id,p]));
  const items=[];
  for(const raw of wikis){
   const s=spaceRecord(raw);
   const project=s.projectId?byProject.get(s.projectId):null;
   if(s.projectId&&!project)continue;
   const visible=project?project.settings?.wiki!==false:true;
   if(!includeHidden&&!visible)continue;
   items.push({...s,name:project?project.name:s.name,visible});
  }
  items.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  return items;
 }

 async function list(id){
  if(!matches(id,WIKI_SPACE_ID))fail('invalid');
  const direct=await store.get('wikis',id);
  if(direct){
   const view=await resolveSpaceView(direct);
   return {enabled:true,id:view.id,name:view.name,projectId:view.projectId,home:view.home,pages:orderedTree(await store.list('summaries',view.id+'/'))};
  }
  const project=(await allProjects()).find(p=>p.id===id);
  if(!project)fail('not-found');
  const linked=(await store.list('wikis')).map(spaceRecord).find(w=>w.projectId===project.id);
  if(!linked)return {enabled:false};
  return {enabled:true,id:linked.id,name:project.name,projectId:project.id,home:linked.home,pages:orderedTree(await store.list('summaries',linked.id+'/'))};
 }

 async function index({includeHidden=false}={}){
  const [projects,wikis]=await Promise.all([allProjects(),store.list('wikis')]);
  const byProjectId=new Map();
  const projectMap=new Map(projects.map(p=>[p.id,p]));
  const allSpaces=wikis.map(spaceRecord);
  for(const s of allSpaces)if(s.projectId)byProjectId.set(s.projectId,s);
  const linkedProjects=projects.filter(p=>byProjectId.has(p.id)).map(p=>({
   id:p.id,name:p.name,home:byProjectId.get(p.id).home,
  }));
  const listedSpaces=allSpaces.filter(s=>{
   if(!s.projectId)return true;
   const p=projectMap.get(s.projectId);
   return Boolean(p)&&(includeHidden||p.settings?.wiki!==false);
  }).map(s=>{
   const p=s.projectId?projectMap.get(s.projectId):null;
   return {...s,name:p?p.name:s.name,...(includeHidden?{visible:p?p.settings?.wiki!==false:true}:{})};
  }).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  return {projects:linkedProjects,spaces:listedSpaces};
 }

 async function summaries(){
  const version=await store.version();
  if(cached?.version===version)return cached.pages;
  const pages=await store.list('summaries');
  cached=Buffer.byteLength(JSON.stringify(pages))<=16*1024*1024?{version,pages}:null;
  return pages;
 }

 async function get(spaceId,id){
  if(!matches(spaceId,WIKI_SPACE_ID)||typeof id!=='string'||!PAGE_ID.test(id))fail('invalid');
  return await store.get('pages',wikiKey(spaceId,id))??fail('not-found');
 }

 async function assetsByIds(spaceId,ids){
  const assets=await Promise.all(ids.map(id=>store.get('assets',wikiKey(spaceId,id))));
  return assets.filter(Boolean).map(wikiAssetView);
 }

 async function withAssets(page){
  if(!page.doc)return page;
  return {...page,assets:await assetsByIds(page.project,wikiAssetIds(page.doc))};
 }

 async function read(page,input={}){
  if(!exactKeys(input,['mode','tableId','rowIds','columnIds','offset','limit']))fail('invalid');
  const {mode='full'}=input;
  if(!MODES.includes(mode))fail('invalid');
  const filters=['tableId','rowIds','columnIds'],window=['offset','limit'];
  if(mode!=='inventory'&&filters.some(key=>input[key]!==undefined)||
   !['inventory','assets'].includes(mode)&&window.some(key=>input[key]!==undefined))fail('invalid');
  if(mode==='full')return withAssets(page);
  if(mode==='summary')return summary(page);
  if(mode==='inventory')return inventoryPage(inventory(page,input.tableId),input);
  const {items,...meta}=collectionPage(wikiAssetIds(page.doc),input);
  return {...meta,assets:await assetsByIds(page.project,items)};
 }

 async function setup(input,by){
  if(!exactKeys(input,['project']))fail('invalid');
  const project=await projectOf(input.project);
  return store.change({wikis:null,pages:project.id+'/',summaries:project.id+'/'},data=>{
   const existing=data.wikis.map(spaceRecord).find(w=>w.projectId===project.id);
   if(existing)return {created:false,home:existing.home,...(existing.id!==project.id?{id:existing.id}:{})};
   if(data.wikis.some(w=>spaceKey(w)===project.id))fail('conflict');
   if(!projectExistsSync(project.id))fail('not-found');
   const {home}=createSpaceInData(data,{id:project.id,name:project.name,projectId:project.id,description:project.description,homeTitle:'Home'},by,now());
   return {created:true,home};
  });
 }

 async function saveSpace(input,by,{mode='auto'}={}){
  if(!exactKeys(input,['id','name','projectId','create']))fail('invalid');
  if(!matches(input.id,WIKI_SPACE_ID))fail('invalid');
  if(input.create!==undefined&&typeof input.create!=='boolean')fail('invalid');
  const intent=mode!=='auto'?mode:input.create===true?'create':input.create===false?'update':'auto';
  const name=input.name===undefined?undefined:wikiSpaceName(input.name);
  const hasProjectId=Object.hasOwn(input,'projectId');
  const projectId=input.projectId;
  if(hasProjectId&&projectId!==null&&!matches(projectId,PROJECT_ID))fail('invalid');
  let targetProject=null;
  if(typeof projectId==='string')targetProject=await projectOf(projectId);
  else await allProjects();
  return store.change({wikis:null,pages:input.id+'/',summaries:input.id+'/'},data=>{
   const existing=data.wikis.find(w=>spaceKey(w)===input.id);
   if(!existing){
    if(intent==='update')fail('not-found');
    if(targetProject){
     if(!projectExistsSync(targetProject.id))fail('not-found');
     if(RESERVED_SPACE_IDS.has(input.id)&&input.id!==targetProject.id)fail('invalid');
     const {space}=createSpaceInData(data,{
      id:input.id,name:targetProject.name,projectId:targetProject.id,
      description:targetProject.description,homeTitle:defaultHomeTitle(targetProject.name),
     },by,now());
     return {...space,created:true};
    }
    if(RESERVED_SPACE_IDS.has(input.id))fail('invalid');
    if(name===undefined)fail('invalid');
    if(projectExistsSync(input.id))fail('conflict');
    const {space}=createSpaceInData(data,{id:input.id,name,projectId:null,homeTitle:defaultHomeTitle(name)},by,now());
    return {...space,created:true};
   }
   if(intent==='create')fail('conflict');
   if(name===undefined&&!hasProjectId)fail('invalid');
   const current=spaceRecord(existing);
   const at=now();
   let changed=false;
   if(hasProjectId){
    if(projectId===null){
     if(current.projectId!==null)fail('invalid');
    }else{
     if(!projectExistsSync(projectId))fail('not-found');
     if(current.projectId!==null&&current.projectId!==projectId)fail('conflict');
     if(data.wikis.some(w=>spaceKey(w)!==current.id&&spaceRecord(w).projectId===projectId))fail('conflict');
     if(current.projectId===null){
      existing.projectId=projectId;
      existing.name=targetProject.name;
      changed=true;
     }
    }
   }
   if(name!==undefined){
    const effectiveProjectId=existing.projectId??null;
    if(effectiveProjectId!==null)fail('invalid');
    if(name!==existing.name){
     const oldName=existing.name;
     existing.name=name;
     renameHomeInData(data,existing,`${oldName} Home`,defaultHomeTitle(name),by,at);
     changed=true;
    }
   }
   if(changed){
    data.revision++;
    data.updatedAt=at;
   }
   return {...spaceRecord(existing),created:false};
  });
 }

 const createSpace=(input,by)=>saveSpace(input,by,{mode:'create'});
 const updateSpace=(input,by)=>saveSpace(input,by,{mode:'update'});

 async function deleteSpace(input){
  if(!exactKeys(input,['id'])||!matches(input.id,WIKI_SPACE_ID))fail('invalid');
  const spaceId=input.id,prefix=spaceId+'/';
  const result=await store.change({wikis:[spaceId],pages:prefix,summaries:prefix,assets:prefix,uploads:null,blobs:null,receipts:prefix,grants:prefix},data=>{
   const raw=data.wikis[0];
   if(!raw)fail('not-found');
   const space=spaceRecord(raw);
   if(space.projectId!==null)fail('conflict');
   return removeSpaceInData(data,space,now());
  },{durable:true});
  if(cleanupFiles)await cleanupFiles(result);
  return {id:result.spaceId,deleted:true,removedPages:result.pageIds.length,removedAssets:result.assetIds.length};
 }

 function docRefs(doc){
  const {tickets,refs=[]}=extractLinks(doc);
  return [...refs,...tickets.map(id=>({kind:'ticket',id}))];
 }

 async function create(input,by,actor=by,{requireRequestId=false}={}){
  if(!exactKeys(input,['project','parentId','title','doc','requestId']))fail('invalid');
  const title=wikiTitle(input.title);
  if(!matches(input.project,WIKI_SPACE_ID))fail('invalid');
  const spaceId=input.project,id=pageId(),key=wikiKey(spaceId,id);
  const parent=input.parentId===undefined?undefined:parentOf(input.parentId);
  const doc=input.doc===undefined?emptyDoc():normalizeDoc(input.doc);
  const validate=await guardMentions(docRefs(doc));
  const receipt=retryKey(spaceId,'create',input.requestId,actor,requireRequestId),fingerprint=hash([parent,title,doc]);
  const selection={wikis:[spaceId],pages:[key],summaries:spaceId+'/',assets:wikiAssetIds(doc).map(id=>wikiKey(spaceId,id)),
   receipts:receipt?[receipt]:[]};
  return store.change(selection,data=>{
   const prior=replay(data,fingerprint);
   if(prior)return prior;
   const wiki=data.wikis[0];
   if(!wiki)fail('not-found');
   const space=spaceRecord(wiki);
   if(wiki.count>=WIKI_LIMITS.pages)fail('page-limit');
   const parentId=parent??wiki.home;
   if(!data.summaries.some(page=>page.id===parentId))fail('invalid-parent');
   if(data.pages.length)fail('conflict');
   validate(space.projectId);
   updateAssetReferences(data.assets,doc,null,actor);
   const page=makePage(spaceId,id,parentId,title,doc,by,now());
   wiki.count++;
   data.pages.push(page);
   record(data,page);
   remember(data,receipt,fingerprint,page);
   return page;
  });
 }

 async function update(input,by,actor=by){
  if(!exactKeys(input,['project','id','rev','title','doc'])||(input.title===undefined&&input.doc===undefined))fail('invalid');
  checkedIdentity(input);
  if(!matches(input.project,WIKI_SPACE_ID))fail('invalid');
  const title=input.title===undefined?undefined:wikiTitle(input.title),spaceId=input.project;
  const key=wikiKey(spaceId,input.id);
  // Read only the previous asset IDs here. The revision and space ownership are checked again inside the write transaction.
  const doc=input.doc===undefined?undefined:normalizeDoc(input.doc);
  const validate=await guardMentions(doc?docRefs(doc):[]);
  const old=doc===undefined?null:await get(spaceId,input.id);
  if(old)checkRevision(old,input.rev);
  const assets=old?[...new Set([...wikiAssetIds(old.doc),...wikiAssetIds(doc)])].map(id=>wikiKey(spaceId,id)):[];
  return store.change({wikis:[spaceId],pages:[key],summaries:[key],assets},data=>{
   const wiki=data.wikis[0];
   if(!wiki)fail('not-found');
   const space=spaceRecord(wiki);
   const page=data.pages[0];
   checkRevision(page,input.rev);
   const fields=[];
   if(title!==undefined&&title!==page.title){page.title=title;fields.push('title');}
   if(doc!==undefined&&JSON.stringify(doc)!==JSON.stringify(page.doc)){
    validate(space.projectId,docRefs(page.doc));
    updateAssetReferences(data.assets,doc,page.doc,actor);
    page.doc=doc;
    page.links=extractLinks(doc);
    fields.push('content');
   }
   return changePage(data,page,by,fields);
  });
 }

 async function save(input,by,actor=by){
  if(input?.documentUploadId===undefined)return update(input,by,actor);
  const {documentUploadId,...rest}=input;
  if(rest.doc!==undefined||!readDocument)fail('invalid');
  return update({...rest,doc:await readDocument(documentUploadId,rest.project,actor)},by,actor);
 }

 async function patch(input,by,actor=by){
  if(!exactKeys(input,['id','project','rev','patch','title']))fail('invalid');
  checkedIdentity(input);
  const {id,rev,patch:edit}=input;
  if(!exactKeys(edit,['tableId','rowId','cells'])||!itemId(edit.rowId)||!matches(input.project,WIKI_SPACE_ID))fail('invalid');
  const spaceId=input.project,key=wikiKey(spaceId,id);
  const validate=await guardMentions(patchCandidateRefs(edit.cells));
  return store.change({wikis:[spaceId],pages:[key],summaries:[key]},data=>{
   const wiki=data.wikis[0];
   if(!wiki)fail('not-found');
   const space=spaceRecord(wiki);
   const page=data.pages[0];
   checkRevision(page,rev);
   const table=inventory(page,edit.tableId),row=table.rows.find(row=>row.id===edit.rowId);
   if(!row||!exactKeys(edit.cells,table.columns.map(column=>column.id)))fail('invalid-target');
   const edits=Object.entries(edit.cells);
   if(!edits.length)fail('invalid-target');
   const title=input.title===undefined?undefined:wikiTitle(input.title);
   const nonNullCols=table.columns.filter(column=>Object.hasOwn(edit.cells,column.id)&&edit.cells[column.id]!==null);
   const normalized=nonNullCols.length
    ?normalizeDoc({v:1,blocks:[{t:'inventory',id:table.id,columns:nonNullCols.map(column=>({id:column.id,label:'c'})),
     rows:[{id:row.id,cells:Object.fromEntries(nonNullCols.map(column=>[column.id,edit.cells[column.id]]))}]}]}).blocks[0].rows[0].cells
    :{};
   const merged={...row.cells};
   for(const [column,cell] of edits){
    if(cell===null)delete merged[column];
    else merged[column]=normalized[column];
   }
   const nextCells={};
   for(const column of table.columns)if(Object.hasOwn(merged,column.id))nextCells[column.id]=merged[column.id];
   const nextTable={...table,rows:table.rows.map(entry=>entry===row?{...row,cells:nextCells}:entry)};
   const nextDoc={...page.doc,blocks:page.doc.blocks.map(block=>block===table?nextTable:block)};
   if(Buffer.byteLength(JSON.stringify(nextDoc))>WIKI_LIMITS.docBytes)fail('limit');
   const fields=[];
   if(title!==undefined&&title!==page.title){page.title=title;fields.push('title');}
   if(JSON.stringify(nextDoc)!==JSON.stringify(page.doc)){
    validate(space.projectId,docRefs(page.doc));
    const editedRefs=[],oldEditedIds=new Set(),newEditedIds=new Set();
    for(const [column] of edits){
     for(const ref of row.cells[column]?.attachments??[]){
      oldEditedIds.add(ref.assetId);
      if(ref.displayAssetId)oldEditedIds.add(ref.displayAssetId);
     }
     for(const ref of nextCells[column]?.attachments??[]){
      editedRefs.push(ref);
      newEditedIds.add(ref.assetId);
      if(ref.displayAssetId)newEditedIds.add(ref.displayAssetId);
     }
    }
    if(oldEditedIds.size||newEditedIds.size){
     const before=new Set(wikiAssetIds(page.doc)),after=new Set(wikiAssetIds(nextDoc));
     const added=[...newEditedIds].filter(assetId=>!before.has(assetId));
     const removed=[...oldEditedIds].filter(assetId=>!after.has(assetId));
     const needed=[...new Set([...newEditedIds,...removed])];
     const loaded=new Map();
     for(const assetId of needed){
      const raw=getAssetRow.get(wikiKey(spaceId,assetId));
      if(raw)loaded.set(assetId,JSON.parse(raw.doc));
     }
     for(const ref of editedRefs)checkWikiAttachment(ref,loaded,actor);
     const at=Date.now(),dirty=new Set();
     for(const assetId of added){
      publishWikiAsset(loaded.get(assetId));
      dirty.add(assetId);
     }
     for(const assetId of removed){
      const asset=loaded.get(assetId);
      if(asset){
       if(--asset.references===0)asset.orphanedAt=at;
       dirty.add(assetId);
      }
     }
     for(const assetId of dirty)putAssetRow.run(wikiKey(spaceId,assetId),JSON.stringify(loaded.get(assetId)));
    }
    page.doc=nextDoc;
    page.links=extractLinks(nextDoc);
    fields.push('content');
   }
   const saved=changePage(data,page,by,fields);
   const savedRow=inventory(saved,edit.tableId).rows.find(entry=>entry.id===edit.rowId);
   return {page:saved,patch:{tableId:edit.tableId,rowId:edit.rowId,
    cells:Object.fromEntries(edits.map(([column])=>[column,Object.hasOwn(savedRow.cells,column)?savedRow.cells[column]:null]))}};
  });
 }

 async function move(input,by){
  if(!exactKeys(input,['project','id','rev','parentId']))fail('invalid');
  checkedIdentity(input);
  if(!matches(input.project,WIKI_SPACE_ID))fail('invalid');
  const parentId=parentOf(input.parentId),spaceId=input.project,key=wikiKey(spaceId,input.id);
  return store.change({wikis:[spaceId],pages:[key],summaries:spaceId+'/'},data=>{
   if(!data.wikis.length)fail('not-found');
   const page=data.pages[0],tree=new Map(data.summaries.map(entry=>[entry.id,entry]));
   checkRevision(page,input.rev);
   if(page.parentId===null)fail('invalid-parent');
   for(let id=parentId;id!==null;){
    const parent=tree.get(id);
    if(!parent||id===page.id)fail('invalid-parent');
    id=parent.parentId;
   }
   if(page.parentId===parentId)return page;
   page.parentId=parentId;
   return changePage(data,page,by,['parentId']);
  });
 }

 async function attach(input,by,actor=by){
  if(!exactKeys(input,['project','id','rev','requestId','assetId','label','caption','displayAssetId','initialClip','position','groupId','tableId','rowId','columnId']))fail('invalid');
  checkedIdentity(input);
  if(!matches(input.project,WIKI_SPACE_ID))fail('invalid');
  const {groupId,tableId,rowId,columnId,position}=input;
  if(groupId===undefined?[tableId,rowId,columnId].some(id=>typeof id!=='string'):[tableId,rowId,columnId].some(id=>id!==undefined))fail('invalid-target');
  const {assetId,label,caption,displayAssetId,initialClip}=input;
  const ref=wikiAttachment({assetId,label,caption,displayAssetId,initialClip});
  const ids=ref.displayAssetId?[assetId,ref.displayAssetId]:[assetId];
  const spaceId=input.project,key=wikiKey(spaceId,input.id);
  const receipt=retryKey(spaceId,'attach',input.requestId,actor,true),fingerprint=hash([input.id,input.rev,groupId,tableId,rowId,columnId,position,ref]);
  return store.change({wikis:[spaceId],pages:[key],summaries:[key],assets:ids.map(id=>wikiKey(spaceId,id)),receipts:[receipt]},data=>{
   const prior=replay(data,fingerprint);
   if(prior)return prior;
   if(!data.wikis.length)fail('not-found');
   const page=data.pages[0];
   checkRevision(page,input.rev);
   const assets=new Map(data.assets.map(asset=>[asset.id,asset]));
   checkWikiAttachment(ref,assets,actor);
   const previous=new Set(wikiAssetIds(page.doc));
   let target;
   if(groupId!==undefined)target=page.doc.blocks.find(block=>block.t==='attachments'&&block.id===groupId);
   else{
    const table=page.doc.blocks.find(block=>block.t==='inventory'&&block.id===tableId);
    const row=table?.rows.find(row=>row.id===rowId);
    if(row&&table.columns.some(column=>column.id===columnId)){
     if(!Object.hasOwn(row.cells,columnId))row.cells[columnId]={};
     target=row.cells[columnId];
    }
   }
   if(!target)fail('invalid-target');
   const group=target.attachments??=[],index=position===undefined?group.length:position;
   if(!Number.isSafeInteger(index)||index<0||index>group.length)fail('invalid-target');
   group.splice(index,0,ref);
   page.doc=normalizeDoc(page.doc);
   for(const id of ids)if(!previous.has(id))publishWikiAsset(assets.get(id));
   changePage(data,page,by,['content']);
   remember(data,receipt,fingerprint,page);
   return page;
  });
 }

 async function backlinks(id){
  if(typeof id!=='string'||!TICKET_ID.test(id))fail('invalid');
  try{await tickets.get(id);}catch(error){if(error.message==='not-found')return [];throw error;}
  return (await summaries()).filter(page=>page.links.tickets.includes(id))
   .map(({project,id,title,updatedAt})=>({project,id,title,updatedAt}))
   .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
 }

 async function pruneReceipts(){
  const cutoff=Date.now();
  const expiry=receipt=>receipt.expiresAt??Date.parse(receipt.result.updatedAt)+RECEIPT_LIFETIME;
  const keys=(await store.list('receipts')).filter(receipt=>expiry(receipt)<=cutoff).map(receipt=>receipt.key);
  if(keys.length)await store.change({receipts:keys},data=>{
   data.receipts=data.receipts.filter(receipt=>expiry(receipt)>cutoff);
  });
 }

 const lifecycle={
  store,
  select(projectId,action){
   if(action==='create'){
    const prefix=matches(projectId,WIKI_SPACE_ID)?projectId+'/':null;
    return {wikis:null,pages:prefix,summaries:prefix};
   }
   if(action==='rename'||action==='renameHome'||action==='upgrade')return {wikis:null,pages:null,summaries:null};
   if(action==='preview')return {wikis:null,summaries:null};
   if(action==='detach')return {wikis:null};
   return {wikis:null,pages:null,summaries:null,assets:null,uploads:null,blobs:null,receipts:null,grants:null};
  },
  space(data,projectId){
   return data.wikis.find(entry=>spaceRecord(entry).projectId===projectId)??null;
  },
  create(data,project,by,at=now()){
   if(!project||!matches(project.id,WIKI_SPACE_ID))fail('invalid');
   const name=wikiSpaceName(project.name);
   return createSpaceInData(data,{
    id:project.id,name,projectId:project.id,description:project.description??'',homeTitle:defaultHomeTitle(name),
   },by,at);
  },
  rename(data,space,oldName,updatedName,by,at=now()){
   if(!space)return {renamed:false,homeRenamed:false,space:null};
   const nextName=wikiSpaceName(updatedName);
   space.name=nextName;
   const homeResult=oldName?renameHomeInData(data,space,`${oldName} Home`,defaultHomeTitle(nextName),by,at):{renamed:false};
   if(!homeResult.renamed){
    data.revision++;
    data.updatedAt=at;
   }
   return {renamed:true,homeRenamed:homeResult.renamed,space:spaceRecord(space)};
  },
  renameHome(data,space,oldTitle,newTitle,by,at=now()){
   return renameHomeInData(data,space,oldTitle,newTitle,by,at);
  },
  detach(data,space,projectName,at=now()){
   if(!space)return {detached:false,space:null};
   const name=wikiSpaceName(projectName||space.name||spaceKey(space));
   space.id=spaceKey(space);
   space.projectId=null;
   space.name=name;
   delete space.project;
   data.revision++;
   data.updatedAt=at;
   return {detached:true,space:spaceRecord(space)};
  },
  remove(data,space,at=now()){
   return removeSpaceInData(data,space,at);
  },
  async cleanup(result){
   cached=null;
   if(result?.removed&&cleanupFiles)await cleanupFiles(result);
  },
  async notify(result){
   cached=null;
   if(result?.removed&&cleanupFiles)await cleanupFiles(result);
  },
 };

 return {summaries,version:store.version,projectOf,spaceOf,spaceOrProjectOf,spaceForProject,spaces,index,list,get,withAssets,read,setup,saveSpace,createSpace,updateSpace,deleteSpace,create,update,save,patch,move,attach,backlinks,pruneReceipts,wikiTargetSync,wikiProjectSync,lifecycle};
}
