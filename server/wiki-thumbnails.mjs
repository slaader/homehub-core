import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

const EDGE=384;
const MAX_INPUT=32*1024**2,MAX_PIXELS=24_000_000,MAX_OUTPUT=640*1024;
const CACHE_BYTES=8*1024**2,CACHE_ENTRIES=128,WORKERS=2,MAX_WAITING=12;
const DESCRIPTIONS=2048;
const PNG=Buffer.from('89504e470d0a1a0a','hex');
const formats=new Map([
 ['image/png',['png_pipe','png']],
 ['image/jpeg',['jpeg_pipe','mjpeg']],
 ['image/gif',['gif','gif']],
 ['image/webp',['webp_pipe','webp']],
]);

function renderThumbnail(binary,{file,size,type}){
 const [format,codec]=formats.get(type);
 const edge=axis=>`'max(1,round(${axis}*min(1,${EDGE}/max(iw,ih))))'`;
 const args=['-nostdin','-hide_banner','-loglevel','error','-xerror','-max_alloc',String(128*1024**2),
  '-filter_threads','1','-probesize','32768','-analyzeduration','1','-fpsprobesize','0',
  '-protocol_whitelist','pipe','-format_whitelist',format,'-codec_whitelist',codec,
  '-threads','1','-max_pixels',String(MAX_PIXELS),'-f',format,'-c:v',codec,'-i','pipe:0',
  '-map','0:v:0','-map_metadata','-1','-frames:v','1','-vf',`scale=${edge('iw')}:${edge('ih')},setsar=1`,
  '-c:v','png','-pix_fmt','rgba','-threads','1','-f','image2pipe','pipe:1'];
 return new Promise(resolve=>{
  // Originals are private local blobs. The helper receives only bounded bytes on stdin.
  const child=execFile(binary,args,{cwd:'/',env:{LC_ALL:'C'},encoding:'buffer',timeout:4000,
   maxBuffer:MAX_OUTPUT,killSignal:'SIGKILL'},(error,out)=>resolve(error?null:out));
  pipeline(createReadStream(file,{end:size-1}),child.stdin).catch(()=>{});
 });
}

function validPreview(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<33||bytes.length>MAX_OUTPUT||
  !bytes.subarray(0,8).equals(PNG)||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')return false;
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 return width>0&&width<=EDGE&&height>0&&height<=EDGE;
}

export function createWikiThumbnails({binary=process.env.HOME_HUB_WIKI_FFMPEG,render=renderThumbnail}={}){
 const cache=new Map(),descriptions=new Map(),pending=new Map(),waiting=[];
 let active=0,cachedBytes=0;

 function keyFor(file){
  if(!binary||!path.isAbsolute(binary)||!formats.has(file.type)||
   !Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_INPUT)return null;
  return file.type+':'+file.digest;
 }

 function remember(key,bytes){
  while(cache.size>=CACHE_ENTRIES||cachedBytes+bytes.length>CACHE_BYTES){
   const oldest=cache.keys().next().value;
   cachedBytes-=cache.get(oldest).length;
   cache.delete(oldest);
  }
  cache.set(key,bytes);
  cachedBytes+=bytes.length;
  descriptions.delete(key);
  if(descriptions.size>=DESCRIPTIONS)descriptions.delete(descriptions.keys().next().value);
  descriptions.set(key,{size:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')});
 }

 async function run(key,file,resolve){
  active++;
  let result=null;
  try{
   const bytes=await render(binary,file);
   if(validPreview(bytes)){
    remember(key,bytes);
    result=bytes;
   }else descriptions.delete(key);
  }catch{descriptions.delete(key);}
  pending.delete(key);
  active--;
  resolve(result);
  waiting.shift()?.();
 }

 return {
  info(file){return descriptions.get(keyFor(file))??null;},
  get(file){
   const key=keyFor(file);
   if(!key)return null;
   const cached=cache.get(key);
   if(cached){
    cache.delete(key);
    cache.set(key,cached);
    return cached;
   }
   if(pending.has(key))return pending.get(key);
   if(waiting.length>=MAX_WAITING)return null;
   const {promise,resolve}=Promise.withResolvers();
   pending.set(key,promise);
   const job=()=>run(key,file,resolve);
   if(active<WORKERS)job();
   else waiting.push(job);
   return promise;
  },
 };
}
