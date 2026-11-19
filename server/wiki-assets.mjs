import {createHash,randomBytes} from 'node:crypto';
import {closeSync,createReadStream,existsSync,fsyncSync,linkSync,mkdirSync,openSync,readSync,statSync,unlinkSync,writeSync,ftruncateSync} from 'node:fs';
import {open,readdir} from 'node:fs/promises';
import path from 'node:path';
import {ASSET_ID,exactKeys,WIKI_LIMITS} from '../public/wiki-doc.js';
import {LIMITS,matchesReviewMedia,SHA} from './review-store.mjs';
import {wikiAssetView,wikiCollection,wikiKey} from './wiki-store.mjs';

export const UPLOAD_ID=/^u[a-f0-9]{32}$/;
export const MCP_CHUNK=32*1024;
export const RAW_CHUNK=LIMITS.chunk;
export const UPLOAD_TTL=24*60*60*1000;
export const ASSET_GRACE=7*UPLOAD_TTL;
const DEFAULT_BUDGET=20*1024**3;
const MAX_SESSIONS=128,MAX_PER_OWNER=16,MAX_PROJECT_ASSETS=5000;
const FILE_TYPE='application/octet-stream';
const extensions=new Map(Object.entries({
 png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',
 mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',flac:'audio/flac',m4a:'audio/mp4',
 glb:'model/gltf-binary',mp4:'video/mp4',webm:'video/webm',
}));
const previewTypes=new Set([...extensions.values(),'audio/webm']);
const id=prefix=>prefix+randomBytes(16).toString('hex');
const fail=code=>{throw new Error(code);};
const stamp=ms=>new Date(ms).toISOString();
function existsSize(file){
 try{return statSync(file).size;}catch(error){if(error.code==='ENOENT')return 0;throw error;}
}
const remove=file=>{try{unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}};
const openPart=file=>openSync(file,existsSync(file)?'r+':'wx+',0o600);
const folder=dir=>mkdirSync(dir,{mode:0o700,recursive:true});
function syncFolder(dir){
 const fd=openSync(dir,'r');
 try{fsyncSync(fd);}finally{closeSync(fd);}
}

function filename(value){
 if(typeof value!=='string'||!value.isWellFormed())fail('invalid');
 const name=value.trim();
 if(!name||name.length>200||/[\x00-\x1f\x7f/\\]/.test(name)||name==='.'||name==='..')fail('invalid');
 return name;
}

function uploadInfo(input){
 if(!exactKeys(input,['project','name','size','digest','type','purpose'])||typeof input.digest!=='string'||!SHA.test(input.digest)||
  !Number.isSafeInteger(input.size)||input.size<0)fail('invalid');
 const name=filename(input.name),suffix=name.split('.').at(-1).toLowerCase();
 if(input.type!==undefined&&(typeof input.type!=='string'||input.type.length>80))fail('invalid');
 const purpose=input.purpose??'asset';
 if(!['asset','document'].includes(purpose))fail('invalid');
 const type=purpose==='document'?FILE_TYPE:previewTypes.has(input.type)?input.type:extensions.get(suffix)??FILE_TYPE;
 // A caller's claimed type must not turn a known active extension into an inline format.
 const activeType=/^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/pdf)$/i.test(input.type??'');
 const safeType=activeType||/\.(?:html?|xhtml|svg|xml|js|mjs|css|pdf)$/i.test(name)?FILE_TYPE:type;
 const max=purpose==='document'?WIKI_LIMITS.docBytes:safeType==='model/gltf-binary'?LIMITS.model:LIMITS.blob;
 if(input.size>max)fail('too-large');
 return {name,type:safeType,purpose,size:input.size,digest:input.digest};
}

async function verifyModel(file,size,head){
 if(head.length<20||head.readUInt32LE(8)!==size||head.readUInt32LE(16)!==0x4e4f534a)fail('invalid-media');
 const length=head.readUInt32LE(12);
 if(!length||length%4||length>RAW_CHUNK||20+length>size)fail('invalid-media');
 const handle=await open(file,'r');
 let json;
 try{
  const bytes=Buffer.alloc(length);
  if((await handle.read(bytes,0,length,20)).bytesRead!==length)fail('invalid-media');
  json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch{fail('invalid-media');}
 finally{await handle.close();}
 if(json?.asset?.version!=='2.0')fail('invalid-media');
 // A published model only reads its own data. External URI resources could reach endpoints with the viewer's session.
 const nodes=[json];
 while(nodes.length){
  const node=nodes.pop();
  for(const [key,value] of Object.entries(node)){
   if(key==='uri'&&(typeof value!=='string'||!/^data:[^,]*;base64,/i.test(value)))fail('invalid-media');
   if(value&&typeof value==='object')nodes.push(value);
  }
 }
}

async function verify(file,upload){
 const {digest,size,type,purpose}=upload;
 const hash=createHash('sha256'),head=Buffer.alloc(20);
 let seen=0;
 if(size){
  for await(const chunk of createReadStream(file)){
   if(seen<head.length)chunk.copy(head,seen,0,head.length-seen);
   seen+=chunk.length;
   if(seen>size)fail('too-large');
   hash.update(chunk);
  }
 }
 if(seen!==size)fail('upload-offset');
 if(hash.digest('hex')!==digest)fail('digest-mismatch');
 if(previewTypes.has(type)){
  const prefix=head.subarray(0,Math.min(size,head.length));
  if(!matchesReviewMedia(type,prefix))fail('invalid-media');
  if(type==='model/gltf-binary')await verifyModel(file,size,prefix);
 }
 if(purpose==='document')await readDoc(file,size);
}

async function readDoc(file,size){
 if(size===0)fail('invalid');
 const handle=await open(file,'r');
 try{
  const bytes=Buffer.alloc(size);
  if((await handle.read(bytes,0,size,0)).bytesRead!==size)fail('invalid');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch{fail('invalid');}
 finally{await handle.close();}
}

function uploadView(upload,nextOffset){
 const {id:uploadId,project,expiresAt,size,assetId,purpose,finished}=upload;
 return {uploadId,project,expiresAt:stamp(expiresAt),size,nextOffset,chunkSize:MCP_CHUNK,rawChunkSize:RAW_CHUNK,
  ...(assetId?{assetId}:{}),...(purpose==='document'&&finished?{documentUploadId:uploadId}:{})};
}

function checkUpload(upload,actor,now){
 if(!upload||upload.expiresAt<=now)fail('upload-expired');
 if(upload.owner!==actor)fail('denied');
 return upload;
}

function writeChunk(file,offset,bytes,size){
 const have=existsSize(file);
 const end=offset+bytes.length;
 if(end>size)fail('too-large');
 if(offset>have||offset<have&&end>have)throw Object.assign(new Error('upload-offset'),{nextOffset:have});
 const fd=openPart(file);
 try{
  if(offset<have){
   const old=Buffer.alloc(bytes.length);
   let count=0;
   while(count<old.length){
    const next=readSync(fd,old,count,old.length-count,offset+count);
    if(!next)fail('upload-offset');
    count+=next;
   }
   if(!old.equals(bytes))throw Object.assign(new Error('upload-offset'),{nextOffset:have});
   return have;
  }
  try{
   let written=0;
   while(written<bytes.length)written+=writeSync(fd,bytes,written,bytes.length-written,offset+written);
   fsyncSync(fd);
  }catch(error){ftruncateSync(fd,have);throw error;}
  return end;
 }finally{closeSync(fd);}
}

export function decodeWikiChunk(data){
 if(typeof data!=='string')fail('invalid');
 if(data.length>4*Math.ceil(MCP_CHUNK/3))fail('too-large');
 if(!data.length||data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))fail('invalid');
 const bytes=Buffer.from(data,'base64');
 if(bytes.length>MCP_CHUNK)fail('too-large');
 if(bytes.toString('base64')!==data)fail('invalid');
 return bytes;
}

export async function readWikiChunk(stream,max=RAW_CHUNK){
 const chunks=[];
 let length=0;
 for await(const buffer of stream){
  length+=buffer.length;
  if(length>max)fail('too-large');
  chunks.push(buffer);
 }
 return Buffer.concat(chunks,length);
}

export function createWikiAssets(db,root,wiki,{now=Date.now,maxBytes=Number(process.env.WIKI_MAX_BYTES||process.env.REVIEW_MAX_BYTES)||DEFAULT_BUDGET}={}){
 const store=wikiCollection(db),parts=path.join(root,'uploads'),payloads=path.join(root,'blobs');
 const part=id=>path.join(parts,id);
 const payload=digest=>path.join(payloads,digest);

 async function begin(input,actor){
  const info=uploadInfo(input),{id:project}=await wiki.projectOf(input.project);
  if(!(await store.get('wikis',project)))fail('not-found');
  const upload={...info,id:id('u'),project,owner:actor,expiresAt:now()+UPLOAD_TTL};
  const accept=()=>store.change({uploads:null,blobs:null},data=>{
   const reserved=data.uploads.filter(session=>!session.assetId);
   const pending=reserved.filter(session=>!session.finished);
   const bytes=data.blobs.reduce((total,blob)=>total+blob.size,0)+reserved.reduce((total,session)=>total+session.size,0);
   if(bytes+upload.size>maxBytes)fail('disk-limit');
   if(pending.length>=MAX_SESSIONS||pending.filter(session=>session.owner===actor).length>=MAX_PER_OWNER)fail('upload-limit');
   data.uploads.push(upload);
   return uploadView(upload,0);
  });
  try{return await accept();}
  catch(error){
   if(!['disk-limit','upload-limit'].includes(error.message))throw error;
   await sweep();
   return accept();
  }
 }

 async function getUpload(id,actor){
  if(typeof id!=='string'||!UPLOAD_ID.test(id))fail('invalid');
  return checkUpload(await store.get('uploads',id),actor,now());
 }

 async function status(id,actor){
  const upload=await getUpload(id,actor);
  return uploadView(upload,upload.finished?upload.size:existsSize(part(id)));
 }

 async function chunk(id,offset,bytes,actor){
  if(typeof id!=='string'||!UPLOAD_ID.test(id)||!Number.isSafeInteger(offset)||offset<0||!Buffer.isBuffer(bytes)||!bytes.length)fail('invalid');
  if(bytes.length>RAW_CHUNK)fail('too-large');
  return store.change({uploads:[id]},data=>{
   const upload=checkUpload(data.uploads[0],actor,now());
   if(upload.assetId){
    // A sender may retry its final chunk after finish removed the staging link.
    const blob=payload(upload.digest);
    if(!existsSync(blob)||offset+bytes.length>upload.size)fail('upload-offset');
    const fd=openSync(blob,'r');
    try{
     const old=Buffer.alloc(bytes.length);
     if(readSync(fd,old,0,old.length,offset)!==old.length||!old.equals(bytes))
      throw Object.assign(new Error('upload-offset'),{nextOffset:upload.size});
    }finally{closeSync(fd);}
    return uploadView(upload,upload.size);
   }
   folder(parts);
   const nextOffset=writeChunk(part(id),offset,bytes,upload.size);
   return uploadView(upload,nextOffset);
  });
 }

 async function finish(id,actor,{source,grant}={}){
  const upload=await getUpload(id,actor);
  const assetKey=()=>wikiKey(upload.project,upload.assetId);
  if(upload.assetId){
   const asset=await store.get('assets',assetKey());
   if(!asset)fail('upload-expired');
   return {...uploadView(upload,upload.size),asset:wikiAssetView(asset)};
  }
  if(upload.finished)return uploadView(upload,upload.size);
  const file=part(id),have=existsSize(file);
  if(have!==upload.size)throw Object.assign(new Error('upload-offset'),{nextOffset:have});
  try{await verify(file,upload);}
  catch(error){
   const current=await getUpload(id,actor);
   if(current.assetId||current.finished)return finish(id,actor,{source,grant});
   if(['digest-mismatch','invalid-media','invalid'].includes(error.message))await abandon(id,actor);
   throw error;
  }
  const result=await store.change({uploads:[id],assets:upload.project+'/',blobs:[upload.digest],grants:grant?[grant.key]:[]},data=>{
   const current=checkUpload(data.uploads[0],actor,now());
   if(current.assetId){
    const asset=data.assets.find(asset=>asset.id===current.assetId);
    if(!asset)fail('upload-expired');
    return {...uploadView(current,current.size),asset:wikiAssetView(asset)};
   }
   if(current.finished)return uploadView(current,current.size);
   if(grant&&JSON.stringify(data.grants[0])!==JSON.stringify(grant))fail('denied');
   current.finished=true;
   if(current.purpose==='document')return uploadView(current,current.size);
   if(data.assets.length>=MAX_PROJECT_ASSETS)fail('asset-limit');
   const blob=data.blobs[0]??{digest:current.digest,size:current.size,references:0};
   if(blob.size!==current.size)fail('digest-mismatch');
   const target=payload(current.digest);
   folder(payloads);
   if(!existsSync(target)){
    if(!current.size){
     folder(parts);
     closeSync(openPart(file));
    }
    linkSync(file,target);
    syncFolder(payloads);
   }
   blob.references++;
   if(!data.blobs.length)data.blobs.push(blob);
   const {project,name,type,size,digest,owner}=current;
   const asset={id:(current.assetId=makeAssetId(data.assets)),project,name,type,size,digest,owner,references:0,published:false,orphanedAt:now(),
    ...(source?{source}:{})};
   data.assets.push(asset);
   return {...uploadView(current,size),asset:wikiAssetView(asset)};
  });
  if(result.assetId)remove(file);
  return result;
 }

 function makeAssetId(assets){
  let next;
  do{next=id('a');}while(assets.some(asset=>asset.id===next));
  return next;
 }

 async function document(id,project,actor){
  const upload=await getUpload(id,actor);
  if(upload.project!==project||upload.purpose!=='document'||!upload.finished)fail('invalid-target');
  return readDoc(part(id),upload.size);
 }

 async function abandon(id,actor){
  return store.change({uploads:[id]},data=>{
   const upload=data.uploads[0];
   if(upload?.owner===actor&&!upload.finished){
    remove(part(id));
    data.uploads.pop();
   }
  });
 }

 async function ingest(project,{name,type,size,digest,body,source},actor,grant){
  const {uploadId}=await begin({project,name,type,size,digest},actor);
  let offset=0,buffered=0,pending=[];
  async function flush(){
   const block=Buffer.concat(pending,buffered);
   const result=await chunk(uploadId,offset,block,actor);
   offset=result.nextOffset;
   pending=[];
   buffered=0;
  }
  try{
   for await(const buffer of await body()){
    const bytes=Buffer.from(buffer);
    if(offset+buffered+bytes.length>size)fail('too-large');
    for(let i=0;i<bytes.length;){
     const length=Math.min(RAW_CHUNK-buffered,bytes.length-i);
     pending.push(bytes.subarray(i,i+length));
     i+=length;
     buffered+=length;
     if(buffered===RAW_CHUNK)await flush();
    }
   }
   if(buffered)await flush();
   return await finish(uploadId,actor,{source,grant});
  }catch(error){await abandon(uploadId,actor);throw error;}
 }

 function canUse(asset,actor){return asset.references>0||asset.owner===actor;}
 async function list(project,actor){
  await wiki.projectOf(project);
  return (await store.list('assets',project+'/')).filter(asset=>canUse(asset,actor)).map(wikiAssetView);
 }
 async function media(project,id,actor){
  if(typeof id!=='string'||!ASSET_ID.test(id))fail('not-found');
  const asset=await store.get('assets',wikiKey(project,id));
  if(!asset||!canUse(asset,actor))fail('not-found');
  const file=payload(asset.digest);
  if(!existsSync(file)||statSync(file).size!==asset.size)fail('not-found');
  return {file,...wikiAssetView(asset),draft:asset.references===0};
 }

 async function sweep(){
  const time=now();
  const candidates=(await store.list('assets')).filter(asset=>asset.references===0&&time-asset.orphanedAt>=ASSET_GRACE);
  const expired=(await store.list('uploads')).filter(upload=>upload.expiresAt<=time);
  await store.change({uploads:expired.map(upload=>upload.id),assets:candidates.map(page=>wikiKey(page.project,page.id)),
   blobs:candidates.map(asset=>asset.digest)},data=>{
   data.uploads=data.uploads.filter(upload=>{
    if(upload.expiresAt>time)return true;
    remove(part(upload.id));
    return false;
   });
   const blobs=new Map(data.blobs.map(blob=>[blob.digest,blob]));
   data.assets=data.assets.filter(asset=>{
    if(asset.references||time-asset.orphanedAt<ASSET_GRACE)return true;
    const blob=blobs.get(asset.digest);
    if(blob)blob.references--;
    return false;
   });
  });
  // File deletion runs with the same SQLite writer lock as publication and only after metadata stopped referencing it.
  const names=await readdir(payloads).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const blobs=await store.list('blobs'),known=new Map(blobs.map(blob=>[blob.digest,blob]));
  const obsolete=[...new Set([...blobs.filter(blob=>!blob.references).map(blob=>blob.digest),...names.filter(name=>SHA.test(name)&&!known.has(name))])];
  if(obsolete.length)await store.change({blobs:obsolete},data=>{
   const pinned=new Set(data.blobs.filter(blob=>blob.references).map(blob=>blob.digest));
   for(const digest of obsolete)if(!pinned.has(digest))remove(payload(digest));
   data.blobs=data.blobs.filter(blob=>blob.references);
  });
  const staged=await readdir(parts).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const unused=staged.filter(name=>UPLOAD_ID.test(name));
  if(unused.length)await store.change({uploads:unused},data=>{
   const active=new Set(data.uploads.filter(upload=>!upload.assetId).map(upload=>upload.id));
   for(const name of unused)if(!active.has(name))remove(part(name));
  });
 }

 return {begin,status,chunk,finish,document,ingest,list,media,sweep};
}
