import {toolError} from './tool-error.mjs';
import {WIKI_LIMITS} from '../public/wiki-doc.js';
import {wikiPageUrl} from './wiki-store.mjs';
import {wikiProblem} from './wiki-errors.mjs';
import {decodeWikiChunk,MANIFEST_FILES,MCP_CHUNK} from './wiki-assets.mjs';
import {MAX_LIST,MAX_ROWS,wikiPatch,wikiRead} from './wiki-authoring.mjs';

export const wikiActor=({principal:p})=>p.authKind+':'+(p.accountId??p.id??p.username);

const str=(description,extra={})=>({type:'string',description,...extra});
const id=str('Stable ID');
const project=str('Project ID from projects_list');
const pageId=str('Stable wiki page ID');
const tableId=str('Stable inventory table ID');
const rowId=str('Stable inventory row ID');
const rev={type:'integer',minimum:1,description:'Expected page revision'};
const requestId=str('Unique per principal, project and operation. Reuse only to retry the same request.',{maxLength:100});
const index={type:'integer',minimum:0};
const doc={type:'object',description:'Version 1 wiki document. Blocks support p, h, quote, ul, ol, code, hr, table, html, inventory and attachments. See docs/wiki.md for field shapes.',
 properties:{v:{const:1},blocks:{type:'array',items:{type:'object',properties:{t:{enum:['p','h','quote','ul','ol','code','hr','table','html','inventory','attachments']}},required:['t']}}},
 required:['v','blocks'],additionalProperties:false};
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const stringList=(description,maxItems)=>({type:'array',description,items:id,minItems:1,maxItems,uniqueItems:true});
const window=(maximum=MAX_LIST)=>({offset:index,limit:{type:'integer',minimum:1,maximum}});
const inventoryLimit={
 if:{properties:{mode:{const:'inventory'}},required:['mode']},
 then:{properties:{limit:{maximum:MAX_ROWS}}},
};
const query=str('Search text',{maxLength:200});
const type=str('Media type',{maxLength:80});
const source={oneOf:[
 object({kind:{const:'lfs'},connection:id,repo:str('Repository as owner/name'),ref:str('Branch, full ref, tag or commit SHA'),path:str('Repository-relative file path')},['kind','connection','repo','ref','path']),
 object({kind:{const:'review'},set:id,round:{type:'integer',minimum:1},item:id,variant:id,media:index},['kind','set','round','item','variant']),
]};
const title=str('Page title',{maxLength:120});
const pageArgs={project,pageId,rev};
const uploadId=str('Upload session ID');
const digest=str('Lowercase SHA-256 in hexadecimal',{pattern:'^[a-f0-9]{64}$'});
const archiveMember=object({
 connection:id,repo:str('Repository as owner/name'),commit:str('Immutable Git commit SHA'),
 archivePath:str('Archive path in the repository'),archiveOid:digest,memberPath:str('Member path inside the archive'),
 originalDigest:digest,
},['connection','repo','commit','archivePath','archiveOid','memberPath','originalDigest']);
const files={type:'array',minItems:1,maxItems:MANIFEST_FILES,items:object({
 name:str('Filename only',{maxLength:200}),size:index,digest,type,archiveMember,
},['name','size','digest'])};
const patch=object({tableId,rowId,cells:{type:'object',minProperties:1,maxProperties:WIKI_LIMITS.columns,
 description:'Map existing column IDs to replacement inventory cells or null to remove the cell.',
 additionalProperties:{oneOf:[{type:'null'},object({c:{type:'array'},stats:{type:'array'},attachments:{type:'array'}},[])]}}},
 ['tableId','rowId','cells']);
const withUrl=(project,id)=>'/'+wikiPageUrl(project,id);

function mutation(page){
 const {id:pageId,project,parentId,rev,title,replayed}=page;
 return {id:pageId,pageId,project,parentId,rev,title,url:withUrl(project,pageId),...(replayed?{replayed}:{})};
}

function compact(meta){
 return {id:meta.id,project:meta.project,meta,mcpContent:[{type:'text',text:JSON.stringify(meta)}]};
}

export async function wikiSave(state,input,by,actor){
 if(input?.documentUploadId===undefined)return state.wiki.update(input,by,actor);
 const {documentUploadId,...rest}=input;
 if(rest.doc!==undefined)throw new Error('invalid');
 return state.wiki.update({...rest,doc:await state.assets.document(documentUploadId,rest.project,actor)},by,actor);
}

function tool(name,description,properties,required,run,{read=false,retry=false,scope=read?'read':'tickets:write',constraints}={}){
 const inputSchema={...object(properties,required),...constraints};
 return {name:'wiki_'+name,description,scope,inputSchema,
  annotations:{readOnlyHint:read,destructiveHint:!read&&name==='page_save',idempotentHint:read||retry,openWorldHint:['asset_import','sources_list'].includes(name)},
  async run(input,c){
   try{
    if(scope!=='read'&&c.principal.permission!=='write')throw new Error('denied');
    return await run(input,c,c.principal.username,wikiActor(c));
   }catch(error){
    const {body}=wikiProblem(error);
    throw Object.assign(toolError(body.error.message),{details:body});
   }
  }};
}

export const wikiTools=[
 tool('list','List the project wiki in tree order. Each entry has a stable ID, parent ID, revision and page URL.',
  {project},['project'],async ({project},{state})=>{
   const result=await state.wiki.list(project);
   return {...result,project,url:withUrl(project),...(result.pages?{pages:result.pages.map(mutation)}:{})};
  },{read:true}),
 tool('get','Read a wiki page. Omit pageId for Home. Use mode=summary for counts, mode=inventory for up to 20 selected rows and columns, or mode=assets for up to 100 referenced asset records.',
  {project,pageId,mode:{enum:['full','summary','inventory','assets']},tableId,rowIds:stringList('Filter by row IDs',WIKI_LIMITS.rows),
   columnIds:stringList('Filter by column IDs',WIKI_LIMITS.columns),...window()},['project'],async ({project,pageId,...input},{state})=>{
   if(pageId===undefined)pageId=(await state.wiki.list(project)).home;
   if(!pageId)throw new Error('not-found');
   const page=await state.wiki.get(project,pageId),data=await wikiRead(state.wiki,page,input);
   const result={...data,...mutation(page)};
   if(input.mode===undefined||input.mode==='full')return result;
   return compact({...result,mode:input.mode});
  },{read:true,constraints:inventoryLimit}),
 tool('setup','Enable a project wiki if needed and return its Home page.',
  {project},['project'],async (input,{state},by)=>{
   const {home,created}=await state.wiki.setup(input,by);
   return {...mutation(await state.wiki.get(input.project,home)),home,created};
  },{retry:true}),
 tool('page_create','Create a page under the selected parent, or Home when parentId is omitted. Retry with the same request ID.',
  {project,parentId:pageId,title,doc,requestId},['project','title','requestId'],async (input,{state},by,actor)=>
   mutation(await state.wiki.create(input,by,actor,{requireRequestId:true})),{retry:true}),
 tool('page_move','Move a page and its children to a new parent using the expected revision. Home stays at the root.',
  {...pageArgs,parentId:pageId},['project','pageId','rev','parentId'],async ({pageId:id,...input},{state},by)=>
   mutation(await state.wiki.move({...input,id},by))),
 tool('page_save','Rename, replace or patch inventory cells on a page using its revision. Upload oversized UTF-8 JSON with purpose=document and pass documentUploadId after finish.',
  {...pageArgs,title,doc,documentUploadId:uploadId,patch},['project','pageId','rev'],async ({pageId:id,...input},{state},by,actor)=>{
   if(input.patch===undefined)return mutation(await wikiSave(state,{...input,id},by,actor));
   const {page,patch}=await wikiPatch(state.wiki,{...input,id},by,actor);
   return compact({...mutation(page),patch});
  }),
 tool('upload_manifest','Plan uploads for up to 50 local files by SHA-256. Use each uploaded asset ID, or send file bytes to a new or resumable session. Retry the manifest to recover IDs and offsets.',
  {project,files},['project','files'],async (input,{state},by,actor)=>
   compact(await state.assets.manifest(input,actor)),{retry:true}),
 tool('upload_begin','Reserve a private upload using its byte size and SHA-256 digest. Optional purpose=document stages a large wiki document for page_save.',
  {project,name:str('Filename only',{maxLength:200}),size:index,digest,type:str('Optional media type'),purpose:{enum:['asset','document']}},
  ['project','name','size','digest'],(input,{state},by,actor)=>state.assets.begin(input,actor)),
 tool('upload_status','Read the current offset and expiry for an upload owned by this principal.',
  {uploadId},['uploadId'],({uploadId},{state},by,actor)=>state.assets.status(uploadId,actor),{retry:true}),
 tool('upload_chunk','Append up to 32 KiB of canonical base64 file bytes at the indicated offset. Repeating identical bytes is safe.',
  {uploadId,offset:index,data:str('RFC 4648 base64 bytes with padding',{maxLength:4*Math.ceil(MCP_CHUNK/3)})},
  ['uploadId','offset','data'],({uploadId,offset,data},{state},by,actor)=>state.assets.chunk(uploadId,offset,decodeWikiChunk(data),actor),{retry:true}),
 tool('upload_finish','Verify a complete upload. Return a project asset ID, or the document upload ID for a staged wiki document. Repeating finish is safe.',
  {uploadId},['uploadId'],({uploadId},{state},by,actor)=>state.assets.finish(uploadId,actor),{retry:true}),
 tool('sources_list','List approved source choices for the destination project. Select a Review set and round for importable media and decisions, or an approved Git connection and repository for browse hints.',
  {project,kind:{enum:['lfs','review']},connection:id,repo:str('Repository as owner/name'),set:id,
   round:{type:'integer',minimum:1},item:id,variant:id,query,...window(20)},['project'],async (input,c)=>
   compact(await c.state.sources.discover(input,c.principal)),{read:true,scope:'tickets:write'}),
 tool('assets_list','Find project assets referenced by saved pages and your own private assets. Filter by exact SHA-256 or MIME type, filename or path text, size or source kind.',
  {project,query,type,digest,sourceKind:{enum:['lfs','review','lfs-member']},minSize:index,maxSize:index,...window()},
  ['project'],async (input,{state,principal},by,actor)=>{
   const canDraft=principal.permission==='write'&&principal.scopes.includes('tickets:write');
   return compact(await state.assets.find(input,canDraft?actor:null));
  },{read:true}),
 tool('asset_import','Copy a pinned Git LFS object or Review variant file into the destination wiki. Project readers can view it once attached. Git repositories and cross-project Review sets require an administrator grant.',
  {project,source},['project','source'],async (input,c,by,actor)=>{
   const {assetId,asset,review,captionSuggestion}=await c.state.sources.importAsset(input,actor,c.principal);
   return {project:input.project,assetId,asset,source:asset.source,url:asset.url,...(review?{review,captionSuggestion}:{})};
  }),
 tool('attachment_add','Attach an asset to groupId, or tableId + rowId + columnId. GLB and video attachments can have a second asset for playback. Position is zero-based and defaults to append. Retry with the same request ID and original revision.',
  {...pageArgs,groupId:id,tableId:id,rowId:id,columnId:id,assetId:id,displayAssetId:str('Optional GLB or video preview asset ID'),
   initialClip:str('Optional initial GLB animation name',{maxLength:WIKI_LIMITS.clip}),label:str('Display label'),caption:str('Caption'),position:index,requestId},
  ['project','pageId','rev','assetId','requestId'],async ({pageId:id,...input},{state},by,actor)=>
   mutation(await state.wiki.attach({...input,id},by,actor)),{retry:true}),
];
