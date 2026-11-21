// Filesystem and strict-JSON primitives shared by the updater, backup, and release-trust modules.
// Static Node builtin imports only: the updater may run from the checkout it switches.
import {constants,lstatSync,fstatSync,realpathSync,readFileSync,mkdirSync,openSync,readSync,writeFileSync,fsyncSync,closeSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function fileHash(file,expectedBytes=null){
 const h=createHash('sha256'),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65536);
 try{
  let n,total=0;
  while((n=readSync(fd,buffer,0,buffer.length,null))){
   total+=n;
   if(expectedBytes!==null&&total>expectedBytes)throw new Error('hash input exceeds its expected size');
   h.update(buffer.subarray(0,n));
  }
  if(expectedBytes!==null&&total!==expectedBytes)throw new Error('hash input does not match its expected size');
 }finally{closeSync(fd);}
 return h.digest('hex');
}

export function withinPath(child,parent){
 if(typeof child!=='string'||typeof parent!=='string'||!child||!parent)return false;
 const c=path.resolve(child),p=path.resolve(parent);
 return c===p||c.startsWith(p.endsWith(path.sep)?p:p+path.sep);
}

export const cleanAbsolute=p=>typeof p==='string'&&p.length<=4096&&path.isAbsolute(p)&&path.resolve(p)===p&&p!==path.parse(p).root&&!/\p{Cc}/u.test(p);

export function canonicalPath(value){
 const full=path.resolve(value);
 try{return realpathSync.native(full);}
 catch(e){
  if(e.code!=='ENOENT')throw e;
  try{lstatSync(full);}
  catch(statErr){
   if(statErr.code!=='ENOENT')throw statErr;
   const parent=path.dirname(full);
   if(parent===full)return full;
   return path.join(canonicalPath(parent),path.basename(full));
  }
  throw e;
 }
}

export function boundedRegularFile(file,maxBytes,label='file'){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new Error(`invalid byte limit for ${label}`);
 const st=lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.size>maxBytes)throw new Error(`${label} must be a bounded regular file`);
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const fst=fstatSync(fd);
  if(!fst.isFile()||fst.size>maxBytes)throw new Error(`${label} must be a bounded regular file`);
  const bytes=readFileSync(fd);
  if(bytes.length>maxBytes)throw new Error(`${label} exceeds its byte limit`);
  return bytes;
 }finally{closeSync(fd);}
}

export function syncDirectory(dir){
 let fd;
 try{fd=openSync(dir,'r');fsyncSync(fd);}
 catch(e){if(!['EINVAL','ENOTSUP','EISDIR','EBADF'].includes(e.code))throw e;}
 finally{if(fd!==undefined)closeSync(fd);}
}

export function durableWrite(file,bytes,mode=0o600,beforeRename){
 mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=`${file}.${randomUUID()}.tmp`;
 let fd;
 try{
  fd=openSync(tmp,'wx',mode);
  writeFileSync(fd,bytes);
  fsyncSync(fd);
  closeSync(fd);
  fd=undefined;
  beforeRename?.();
  renameSync(tmp,file);
  syncDirectory(path.dirname(file));
 }finally{
  if(fd!==undefined)closeSync(fd);
  rmSync(tmp,{force:true});
 }
}

// A small JSON recognizer rejects duplicate names before JSON.parse can discard evidence.
export function strictJson(bytes,{limit=8*1024*1024}={}){
 if(bytes.length>limit)throw new Error('JSON exceeds local byte limit');
 const s=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 let i=0;
 const literal=/(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
 const ws=()=>{while(/[\t\n\r ]/.test(s[i]??'x'))i++;};
 const string=()=>{
  const start=i++;
  while(i<s.length){
   if(s[i]==='"'){i++;return JSON.parse(s.slice(start,i));}
   if(s[i]==='\\')i++;
   i++;
  }
  throw new Error('unterminated JSON string');
 };
 const value=()=>{
  ws();
  if(s[i]==='{'){
   i++;ws();const seen=new Set();
   if(s[i]==='}'){i++;return;}
   for(;;){
    ws();if(s[i]!=='"')throw new Error('invalid JSON object');
    const key=string();
    if(seen.has(key))throw new Error(`duplicate JSON key: ${key}`);
    seen.add(key);ws();if(s[i++]!==':')throw new Error('invalid JSON colon');
    value();ws();const c=s[i++];if(c==='}')return;if(c!==',')throw new Error('invalid JSON object');
   }
  }
  if(s[i]==='['){
   i++;ws();if(s[i]===']'){i++;return;}
   for(;;){value();ws();const c=s[i++];if(c===']')return;if(c!==',')throw new Error('invalid JSON array');}
  }
  if(s[i]==='"'){string();return;}
  literal.lastIndex=i;const m=literal.exec(s);if(!m)throw new Error('invalid JSON value');i+=m[0].length;
 };
 value();ws();if(i!==s.length)throw new Error('trailing JSON content');
 return JSON.parse(s);
}

export function fields(value,names,where){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k)))throw new Error(`invalid ${where} fields`);
}
