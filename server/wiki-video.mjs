import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const MAX_INPUT=64*1024**2,MAX_OUTPUT=16*1024**2,MAX_PIXELS=8_294_400;
const CACHE_BYTES=48*1024**2,CACHE_ENTRIES=32,FAILURES=2048,MAX_WAITING=2;
const EBML=Buffer.from('1a45dfa3','hex');
export const WIKI_VIDEO_BUSY=Symbol('Wiki video converter busy');

async function transcode(binary,{file}){
 const scratch=await mkdtemp(path.join(os.tmpdir(),'wiki-video-'));
 const output=path.join(scratch,'preview.webm');
 try{
  const edge=axis=>`'max(2,trunc(${axis}*min(1,min(960/iw,540/ih))/2)*2)'`;
  await exec(binary,['-nostdin','-hide_banner','-loglevel','error','-xerror','-max_alloc',String(128*1024**2),
   '-filter_threads','1','-probesize','1048576','-analyzeduration','3000000',
   '-protocol_whitelist','file','-format_whitelist','mov','-codec_whitelist','h264,hevc,mpeg4,vp9,av1,aac,mp3,alac,opus',
   '-threads','1','-max_pixels',String(MAX_PIXELS),'-enable_drefs','0','-use_absolute_path','0','-f','mov','-i',file,
   '-map','0:v:0','-map','0:a:0?','-map_metadata','-1','-map_chapters','-1',
   '-vf',`scale=${edge('iw')}:${edge('ih')},fps=30,format=yuv420p`,
   '-c:v','libvpx','-deadline','realtime','-cpu-used','5','-crf','36','-b:v','1100k','-threads:v','1',
   '-c:a','libopus','-ac','2','-b:a','96k','-threads:a','1','-fs',String(MAX_OUTPUT),'-f','webm',output],
  {cwd:'/',env:{LC_ALL:'C'},timeout:20_000,maxBuffer:32*1024,killSignal:'SIGKILL'});
  // FFmpeg can finish successfully at its file-size limit. Do not offer a potentially cut-off clip.
  if((await stat(output)).size>=MAX_OUTPUT-64*1024)return null;
  return await readFile(output);
 }catch(error){
  if(Number.isInteger(error.code)||error.killed||error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return null;
  throw error;
 }finally{await rm(scratch,{recursive:true,force:true});}
}

function validWebM(bytes){
 return Buffer.isBuffer(bytes)&&bytes.length>=32&&bytes.length<MAX_OUTPUT&&
  bytes.subarray(0,4).equals(EBML)&&bytes.subarray(4,128).includes('webm');
}

export function createWikiVideos({binary=process.env.HOME_HUB_WIKI_FFMPEG,render=transcode}={}){
 const cache=new Map(),failed=new Set(),pending=new Map(),waiting=[];
 let active=false,cachedBytes=0;
 function remember(key,preview){
  while(cache.size>=CACHE_ENTRIES||cachedBytes+preview.size>CACHE_BYTES){
   const oldest=cache.keys().next().value;
   cachedBytes-=cache.get(oldest).size;
   cache.delete(oldest);
  }
  cache.set(key,preview);
  cachedBytes+=preview.size;
 }
 async function convert(file,resolve){
  active=true;
  let preview=null;
  try{
   const bytes=await render(binary,file);
   if(validWebM(bytes)){
    preview={bytes,size:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')};
    remember(file.digest,preview);
   }else{
    if(failed.size>=FAILURES)failed.delete(failed.values().next().value);
    failed.add(file.digest);
   }
  }catch{/* A temporary filesystem or helper failure can be retried. */}
  pending.delete(file.digest);
  active=false;
  resolve(preview);
  waiting.shift()?.();
 }
 function eligible(file){
  return binary&&path.isAbsolute(binary)&&file.type==='video/mp4'&&Number.isSafeInteger(file.size)&&file.size>0&&file.size<=MAX_INPUT;
 }
 return {
  info(file){return eligible(file)?cache.get(file.digest):null;},
  get(file){
   if(!eligible(file))return null;
   if(failed.has(file.digest)){
    failed.delete(file.digest);
    failed.add(file.digest);
    return null;
   }
   const cached=cache.get(file.digest);
   if(cached){
    cache.delete(file.digest);
    cache.set(file.digest,cached);
    return cached;
   }
   if(pending.has(file.digest))return pending.get(file.digest);
   if(waiting.length>=MAX_WAITING)return WIKI_VIDEO_BUSY;
   const {promise,resolve}=Promise.withResolvers();
   pending.set(file.digest,promise);
   const job=()=>convert(file,resolve);
   if(active)waiting.push(job);
   else job();
   return promise;
  },
 };
}
