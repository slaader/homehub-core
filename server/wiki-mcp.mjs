import {toolError} from './tool-error.mjs';
import {wikiPageUrl} from './wiki-store.mjs';
import {wikiProblem} from './wiki-errors.mjs';
import {decodeWikiChunk,MCP_CHUNK} from './wiki-assets.mjs';

export const wikiActor=({principal:p})=>p.authKind+':'+(p.accountId??p.id??p.username);

const str=(description,extra={})=>({type:'string',description,...extra});
const id=str('Stable ID');
const project=str('Project ID from projects_list');
const pageId=str('Stable wiki page ID');
const rev={type:'integer',minimum:1,description:'Expected page revision'};
const requestId=str('Unique per principal, project and operation. Reuse only to retry the same request.',{maxLength:100});
const index={type:'integer',minimum:0};
const doc={type:'object',description:'Version 1 wiki document. Blocks support p, h, quote, ul, ol, code, hr, table, html, inventory and attachments. See docs/wiki.md for field shapes.',
 properties:{v:{const:1},blocks:{type:'array',items:{type:'object',properties:{t:{enum:['p','h','quote','ul','ol','code','hr','table','html','inventory','attachments']}},required:['t']}}},
 required:['v','blocks'],additionalProperties:false};
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const source={oneOf:[
 object({kind:{const:'lfs'},connection:id,repo:str('Repository as owner/name'),ref:str('Branch, full ref, tag or commit SHA'),path:str('Repository-relative file path')},['kind','connection','repo','ref','path']),
 object({kind:{const:'review'},set:id,round:{type:'integer',minimum:1},item:id,variant:id,media:index},['kind','set','round','item','variant']),
]};
const title=str('Page title',{maxLength:120});
const pageArgs={project,pageId,rev};
const uploadId=str('Upload session ID');
const digest=str('Lowercase SHA-256 in hexadecimal',{pattern:'^[a-f0-9]{64}$'});
const withUrl=(project,id)=>'/'+wikiPageUrl(project,id);

function mutation(page){
 const {id:pageId,project,parentId,rev,title,replayed}=page;
 return {id:pageId,pageId,project,parentId,rev,title,url:withUrl(project,pageId),...(replayed?{replayed}:{})};
}

export async function wikiSave(state,input,by,actor){
 if(input?.documentUploadId===undefined)return state.wiki.update(input,by,actor);
 const {documentUploadId,...rest}=input;
 if(rest.doc!==undefined)throw new Error('invalid');
 return state.wiki.update({...rest,doc:await state.assets.document(documentUploadId,rest.project,actor)},by,actor);
}

function tool(name,description,properties,required,run,{read=false,retry=false}={}){
 return {name:'wiki_'+name,description,scope:read?'read':'tickets:write',inputSchema:object(properties,required),
  annotations:{readOnlyHint:read,destructiveHint:!read&&name==='page_save',idempotentHint:read||retry,openWorldHint:name==='asset_import'},
  async run(input,c){
   try{
    if(!read&&c.principal.permission!=='write')throw new Error('denied');
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
 tool('get','Read a page, its revision, source document, ticket links and referenced asset metadata. Omit pageId for Home.',
  {project,pageId},['project'],async ({project,pageId},{state})=>{
   if(pageId===undefined)pageId=(await state.wiki.list(project)).home;
   if(!pageId)throw new Error('not-found');
   const page=await state.wiki.withAssets(await state.wiki.get(project,pageId));
   return {...page,...mutation(page)};
  },{read:true}),
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
 tool('page_save','Rename or replace a page document using its revision. For JSON that exceeds the MCP request limit, upload UTF-8 JSON with purpose=document, finish, then pass documentUploadId.',
  {...pageArgs,title,doc,documentUploadId:uploadId},['project','pageId','rev'],async ({pageId:id,...input},{state},by,actor)=>
   mutation(await wikiSave(state,{...input,id},by,actor))),
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
 tool('asset_import','Copy a pinned Git LFS object or Review variant file into the destination wiki. Project readers can view it once attached. Git repositories and cross-project Review sets require an administrator grant.',
  {project,source},['project','source'],async (input,c,by,actor)=>{
   const {assetId,asset}=await c.state.sources.importAsset(input,actor,c.principal);
   return {project:input.project,assetId,asset,source:asset.source,url:asset.url};
  }),
 tool('attachment_add','Attach an asset to groupId, or tableId + rowId + columnId. Position is zero-based and defaults to append. Retry with the same request ID and original revision.',
  {...pageArgs,groupId:id,tableId:id,rowId:id,columnId:id,assetId:id,label:str('Display label'),caption:str('Caption'),position:index,requestId},
  ['project','pageId','rev','assetId','requestId'],async ({pageId:id,...input},{state},by,actor)=>
   mutation(await state.wiki.attach({...input,id},by,actor)),{retry:true}),
];
