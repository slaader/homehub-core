// Restricted USTAR, no external extractor and no ownership restoration. Payloads are streamed and bounded.
import {createReadStream,createWriteStream,openSync,closeSync,writeSync,mkdirSync,lstatSync,chmodSync,symlinkSync,readdirSync} from 'node:fs';
import {createGzip,createGunzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
export const ARCHIVE_LIMITS=Object.freeze({entries:20000,compressed:256*1024*1024,expanded:1024*1024*1024,file:64*1024*1024});
const utf8=new TextDecoder('utf-8',{fatal:true});
export function archivePath(value,{release=true}={}){
 if(typeof value!=='string'||!value||value.length>256||/[\\\p{Cc}:]/u.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error(`unsafe archive path: ${JSON.stringify(value)}`);
 if(release&&value.split('/').some(p=>p.toLowerCase()==='.git'||p.toLowerCase()==='.home-hub-package.json'))throw new Error('reserved installation metadata in archive');return value;
}
function field(b,start,size){const part=b.subarray(start,start+size),end=part.indexOf(0);if(end>=0&&part.subarray(end).some(v=>v!==0))throw new Error('nonzero archive field after NUL');return utf8.decode(end<0?part:part.subarray(0,end));}
function octal(b,start,size){const raw=b.subarray(start,start+size);if(raw[0]&128)throw new Error('unsupported archive numeric encoding');const text=raw.toString('ascii').replace(/[\0 ]+$/,'').replace(/^ +/,'');if(!/^[0-7]*$/.test(text))throw new Error('invalid archive octal');const v=parseInt(text||'0',8);if(!Number.isSafeInteger(v))throw new Error('unsafe archive integer');return v;}
export function header(entry){
 const b=Buffer.alloc(512),put=(text,start,size)=>{const data=Buffer.from(text);if(data.length>size)throw new Error('USTAR field exceeds format limit');data.copy(b,start);};
 let name=entry.path,prefix='';if(Buffer.byteLength(name)>100){const cuts=[...name.matchAll(/\//g)].map(m=>m.index).reverse();const cut=cuts.find(i=>Buffer.byteLength(name.slice(0,i))<=155&&Buffer.byteLength(name.slice(i+1))<=100);if(cut===undefined)throw new Error(`path cannot fit USTAR: ${name}`);prefix=name.slice(0,cut);name=name.slice(cut+1);}
 put(name,0,100);const num=(v,start,len)=>put(v.toString(8).padStart(len-1,'0')+'\0',start,len);
 num(entry.mode,100,8);num(0,108,8);num(0,116,8);num(entry.type==='file'?entry.bytes:0,124,12);num(0,136,12);b.fill(32,148,156);put(entry.type==='directory'?'5':entry.type==='symlink'?'2':'0',156,1);if(entry.type==='symlink')put(entry.link,157,100);put('ustar\0',257,6);put('00',263,2);put(prefix,345,155);const sum=b.reduce((a,v)=>a+v,0);put(sum.toString(8).padStart(6,'0')+'\0 ',148,8);return b;
}
export async function writeArchive(file,entries,{release=true,limits=ARCHIVE_LIMITS}={}){
 if(entries.length>limits.entries)throw new Error('too many archive entries');let expanded=1024;
 async function* blocks(){for(const e of entries){archivePath(e.path,{release});if(e.bytes>limits.file)throw new Error('individual file exceeds local limit');expanded+=512+Math.ceil((e.bytes??0)/512)*512;if(expanded>limits.expanded)throw new Error('expanded archive exceeds local limit');yield header(e);if(e.type==='file'){let count=0;for await(const chunk of createReadStream(e.source)){count+=chunk.length;yield chunk;}if(count!==e.bytes)throw new Error('source changed during archive creation');const pad=(512-e.bytes%512)%512;if(pad)yield Buffer.alloc(pad);}}yield Buffer.alloc(1024);}
 await pipeline(Readable.from(blocks()),createGzip({level:6}),createWriteStream(file,{flags:'wx',mode:0o600}));
}
export class Reader{
 constructor(iter){this.iter=iter[Symbol.asyncIterator]();this.buffer=Buffer.alloc(0);this.offset=0;this.total=0;}
 async take(n,{eof=false}={}){const out=[];let length=0;while(length<n){if(this.offset===this.buffer.length){const next=await this.iter.next();if(next.done){if(eof&&length===0)return null;throw new Error('truncated archive');}this.buffer=next.value;this.offset=0;}const size=Math.min(n-length,this.buffer.length-this.offset);out.push(this.buffer.subarray(this.offset,this.offset+size));this.offset+=size;length+=size;this.total+=size;}return out.length===1?out[0]:Buffer.concat(out,length);}
}
const APPLEDOUBLE_MAGIC=Buffer.from([0x00,0x05,0x16,0x07]);
function parsePax(buf){
 const attrs={};
 let i=0;
 while(i<buf.length){
  const sp=buf.indexOf(0x20,i);if(sp<0)throw new Error('invalid PAX record');
  const lenText=buf.subarray(i,sp).toString('ascii');
  const len=Number(lenText);if(!/^\d+$/.test(lenText)||!Number.isInteger(len)||len<=0||i+len>buf.length)throw new Error('invalid PAX record length');
  const end=i+len;
  if(buf[end-1]!==0x0a)throw new Error('unterminated PAX record');
  const eq=buf.indexOf(0x3d,sp+1);
  if(eq>sp+1&&eq<end-1){
   const key=buf.subarray(sp+1,eq).toString('utf8');
   // Only decode standard UTF-8 PAX attributes; vendor xattr payloads (e.g. LIBARCHIVE.xattr.*) may hold raw binary bytes.
   if(key==='path'||key==='linkpath'||key==='size')attrs[key]=utf8.decode(buf.subarray(eq+1,end-1));
  }
  i=end;
 }
 return attrs;
}
function safeParents(root,name){const parts=name.split('/');parts.pop();let dir=root;for(const part of parts){dir=path.join(dir,part);try{mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;const st=lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('archive parent is not a directory');}}}
async function walkArchive(file,root,{release=true,limits=ARCHIVE_LIMITS,expected=null,legacy=false,expectedExpanded=null,allowedRoots=null}={}){
 if(lstatSync(file).size>limits.compressed)throw new Error('compressed archive exceeds local limit');
 if(root!==null){if(!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink())throw new Error('archive root must be a regular private staging directory');if(readdirSync(root).length)throw new Error('archive extraction requires an empty directory');}
 const input=createReadStream(file),unzip=createGunzip();input.on('error',e=>unzip.destroy(e));input.pipe(unzip);const reader=new Reader(unzip),seen=new Map(),folded=new Map(),entries=[],links=[],directoryModes=[],directories=new Set();let ended=false,pax=null;
 try{for(;;){const b=await reader.take(512);if(reader.total>limits.expanded)throw new Error('expanded archive exceeds local limit');if(b.every(v=>v===0)){const next=await reader.take(512);if(next.some(v=>v!==0))throw new Error('invalid archive end marker');ended=true;break;}
  if(entries.length>=limits.entries)throw new Error('too many archive entries');const declared=octal(b,148,8),sum=b.reduce((a,v,i)=>a+(i>=148&&i<156?32:v),0);if(sum!==declared)throw new Error('invalid archive header checksum');
  const magic=field(b,257,6),ver=field(b,263,2),gnu=legacy&&magic==='ustar '&&ver===' ';
  if(!gnu&&(magic!=='ustar'||!['00','  ',''].includes(ver)))throw new Error('unsupported archive format');
  const type=String.fromCharCode(b[156]||48),bytes=octal(b,124,12),mode=octal(b,100,8);
  // Historical BSD/macOS tar emits PAX extended headers ('x'/'g') and AppleDouble '._*' metadata sidecars;
  // GNU tar emits 'ustar  \0' headers and optional 'L'/'K' long-name records.
  if(legacy&&(type==='x'||type==='g'||type==='L'||type==='K')){
   if(bytes>65536)throw new Error('extended archive header exceeds local limit');
   const payload=bytes?await reader.take(bytes):Buffer.alloc(0);
   if(reader.total>limits.expanded)throw new Error('expanded archive exceeds local limit');
   const padding=(512-bytes%512)%512;if(padding&&(await reader.take(padding)).some(v=>v!==0))throw new Error('nonzero archive padding');
   if(type==='x')pax={...(pax??{}),...parsePax(payload)};
   else if(type==='L'||type==='K')pax={...(pax??{}),[type==='L'?'path':'linkpath']:utf8.decode(payload).replace(/\0+$/,'')};
   continue;
  }
  const entryPax=pax;pax=null;
  const prefix=gnu?'':field(b,345,155);let name=entryPax?.path??((prefix?prefix+'/':'')+field(b,0,100));
  if(type==='5'&&name.endsWith('/'))name=name.slice(0,-1);if(legacy&&name.startsWith('./'))name=name.slice(2);
  const actualBytes=entryPax?.size!==undefined?Number(entryPax.size):bytes;
  if(!Number.isSafeInteger(actualBytes)||actualBytes<0||actualBytes>limits.file||mode&0o7000)throw new Error('unsafe archive size or mode');
  let prefetched=null;
  if(legacy&&type==='0'&&path.posix.basename(name).startsWith('._')&&actualBytes>=4){
   const head=await reader.take(4);
   if(reader.total>limits.expanded)throw new Error('expanded archive exceeds local limit');
   if(head.equals(APPLEDOUBLE_MAGIC)){
    let left=actualBytes-4;
    while(left){const chunk=await reader.take(Math.min(left,65536));if(reader.total>limits.expanded)throw new Error('expanded archive exceeds local limit');left-=chunk.length;}
    const padding=(512-actualBytes%512)%512;if(padding&&(await reader.take(padding)).some(v=>v!==0))throw new Error('nonzero archive padding');
    continue;
   }
   prefetched=head;
  }
  archivePath(name,{release});
  if(allowedRoots&&!allowedRoots.has(name.split('/')[0]))throw new Error('legacy archive has unplanned roots');
  if(seen.has(name))throw new Error('duplicate archive path');const components=name.split('/');for(let i=1;i<=components.length;i++){const pfx=components.slice(0,i).join('/'),fold=pfx.normalize('NFC').toLowerCase();if(folded.has(fold)&&folded.get(fold)!==pfx)throw new Error('case-fold archive path collision');folded.set(fold,pfx);}
  const parentParts=name.split('/');parentParts.pop();for(let i=1;i<=parentParts.length;i++){const p=parentParts.slice(0,i).join('/');if(seen.has(p)&&seen.get(p)!=='directory')throw new Error('file/directory prefix collision');}if(type!=='5'&&directories.has(name))throw new Error('file/directory prefix collision');for(let i=1;i<=parentParts.length;i++)directories.add(parentParts.slice(0,i).join('/'));
  if(!['0','5',...(!release?['2']:[])].includes(type))throw new Error('unsupported archive entry type');if(type!=='0'&&actualBytes!==0)throw new Error('non-file archive entry has data');
  const kind=type==='0'?'file':type==='5'?'directory':'symlink';const spec=expected?.get(name);if(expected&&(!spec||spec.type!==kind||spec.bytes!==actualBytes||((kind==='file'||kind==='directory')&&spec.mode!==(mode&0o777))))throw new Error(`unlisted or mismatched archive entry: ${name}`);
  if(release&&![0o644,0o755].includes(mode))throw new Error('unsupported release file mode');
  const dest=root!==null?(safeParents(root,name),path.join(root,name)):null;let hash=null,linkTarget=null;
  if(kind==='directory'){if(dest){try{mkdirSync(dest,{mode:0o700});}catch(e){if(e.code!=='EEXIST'||!lstatSync(dest).isDirectory())throw e;}directoryModes.push([dest,mode]);}}
  else if(kind==='symlink'){linkTarget=entryPax?.linkpath??field(b,157,100);if(!linkTarget||/[\x00-\x1f]/.test(linkTarget))throw new Error('invalid archive link');if(expected&&spec.link!==linkTarget)throw new Error('archive link mismatch');if(dest)links.push([dest,linkTarget]);}
  else {
   const fd=dest?openSync(dest,'wx',0o600):null,h=createHash('sha256');
   const emit=chunk=>{if(fd!==null){let offset=0;while(offset<chunk.length){const written=writeSync(fd,chunk,offset,chunk.length-offset);if(!written)throw new Error('short archive write');offset+=written;}}h.update(chunk);};
   try{
    let left=actualBytes;
    if(prefetched){emit(prefetched);left-=prefetched.length;}
    while(left){const chunk=await reader.take(Math.min(left,65536));if(reader.total>limits.expanded)throw new Error('expanded archive exceeds local limit');emit(chunk);left-=chunk.length;}
    hash=h.digest('hex');
   }finally{if(fd!==null)closeSync(fd);}
   if(spec&&hash!==spec.sha256)throw new Error(`archive content hash mismatch: ${name}`);if(dest)chmodSync(dest,spec?.mode??(mode&0o777));const padding=(512-actualBytes%512)%512;if(padding&&(await reader.take(padding)).some(v=>v!==0))throw new Error('nonzero archive padding');
  }
  seen.set(name,kind);entries.push({path:name,type:kind,bytes:actualBytes,mode:mode&0o777,sha256:hash,...(kind==='symlink'?{link:linkTarget}:{})});
 }
 // Read through the gzip trailer and every trailing byte (tar blocking zeros allowed).
 if(reader.buffer.subarray(reader.offset).some(v=>v!==0))throw new Error('unexpected trailing archive content');let tail=reader.buffer.length-reader.offset;for(;;){const next=await reader.iter.next();if(next.done)break;tail+=next.value.length;if(next.value.some(v=>v!==0))throw new Error('unexpected trailing archive content');if(reader.total+tail>limits.expanded)throw new Error('expanded archive exceeds local limit');}
 if(expectedExpanded!==null&&reader.total+tail!==expectedExpanded)throw new Error('signed expanded payload length mismatch');if(!ended)throw new Error('missing archive terminator');if(expected&&(entries.length!==expected.size||[...expected.keys()].some(p=>!seen.has(p))))throw new Error('archive incomplete');
 // Links are created last: no extraction write can follow one. Restore validates graph separately.
 if(root!==null){for(const [dest,link] of links)symlinkSync(link,dest);for(const [dir,mode] of directoryModes.reverse())chmodSync(dir,mode&0o777);}
 return entries;
 }finally{input.destroy();unzip.destroy();}
}
export function extractArchive(file,root,options={}){return walkArchive(file,root,options);}
export function inspectArchive(file,options={}){return walkArchive(file,null,options);}
