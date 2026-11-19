// Backup format 2. Tar contains unique payloads; the authenticated JSON Lines inventory carries the link graph.
import {constants,createReadStream,createWriteStream,openSync,closeSync,fstatSync,writeSync,fsyncSync,readSync} from 'node:fs';
import {basename as pathBasename,dirname as pathDirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {fields,strictJson} from './release-trust.mjs';
import {archivePath,header,Reader} from './release-archive.mjs';
import {backupBudget,cleanAbsolute,DRIVER_CAPABILITIES,MANIFEST_LIMIT,MANIFEST_HEADER_LIMIT,MANIFEST_ENTRY_LIMIT} from './backup-policy.mjs';
import {compressedBound,fold,inode,padded,signature,stat,walkRoot} from './backup-scan.mjs';

export const BACKUP_SCHEMA=2;
const HASH=/^[a-f0-9]{64}$/;
const zero=Buffer.alloc(1024);
const fail=(_,message)=>{throw new Error(message);};
const int=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const hash=()=>createHash('sha256');

export function writeAll(fd,bytes){
 let offset=0;
 while(offset<bytes.length){
  const wrote=writeSync(fd,bytes,offset,bytes.length-offset);
  if(!wrote)throw new Error('short backup write');
  offset+=wrote;
 }
}

export async function writeBackupArchive(file,manifest,plan){
 const manifestFd=openSync(manifest,'wx',0o600),manifestHash=hash(),archiveHash=hash(),seen=hash(),seenAfter=hash();
 const requires=['backup-v2',...(plan.groups.size?['hardlinks']:[])];
 const metadata={schemaVersion:BACKUP_SCHEMA,roots:plan.roots,budget:plan.policy.budget,requires,totals:plan.totals,prerequisites:plan.prerequisites};
 let manifestBytes=0,archiveBytes=0;
 const line=(value,limit=MANIFEST_ENTRY_LIMIT)=>{
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  manifestBytes+=bytes.length;
  if(bytes.length>limit||manifestBytes>MANIFEST_LIMIT)throw new Error('backup manifest exceeds its byte limit');
  writeAll(manifestFd,bytes);manifestHash.update(bytes);
 };
 async function* blocks(){
  line(metadata,MANIFEST_HEADER_LIMIT);
  let entries=0,expanded=1024;
  for(const root of plan.roots)for(const {source,entry:e,st} of walkRoot(root,fail)){
   if(++entries>plan.totals.entries)throw new Error('backup inventory changed before streaming');
   const sig=signature(st),group=st.nlink>1n&&e.type==='file'?plan.groups.get(inode(st)):null;
   seen.update(JSON.stringify([e,sig])+'\n');
   if(group&&group.first!==e.path){line({path:e.path,type:'hardlink',target:group.first});continue;}
   expanded+=512+padded(e.bytes);
   if(expanded>plan.totals.expanded||e.bytes>plan.policy.budget.maxFileBytes)throw new Error('backup size changed before streaming');
   yield header(e);
   if(e.type!=='file'){line(e);continue;}
   const fd=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW),digest=hash();
   try{
    if(signature(fstatSync(fd,{bigint:true}))!==sig)throw new Error(`backup source changed: ${source}`);
    let count=0;
    while(count<e.bytes){
     const buffer=Buffer.allocUnsafe(Math.min(65536,e.bytes-count));
     const read=readSync(fd,buffer,0,buffer.length,null);
     if(!read)break;
     const chunk=buffer.subarray(0,read);
     count+=read;digest.update(chunk);yield chunk;
    }
    if(count!==e.bytes||signature(fstatSync(fd,{bigint:true}))!==sig)throw new Error(`backup source changed: ${source}`);
   }finally{closeSync(fd);}
   const padding=padded(e.bytes)-e.bytes;
   if(padding)yield zero.subarray(0,padding);
   line({...e,sha256:digest.digest('hex'),...(group?{names:group.expected}:{})});
  }
  if(seen.digest('hex')!==plan.scanDigest||entries!==plan.totals.entries||expanded!==plan.totals.expanded)throw new Error('backup inventory changed while streaming');
  yield zero;
 }
 const count=new Transform({transform(chunk,_,next){
  archiveBytes+=chunk.length;
  if(archiveBytes>compressedBound(plan.totals.expanded)){next(new Error('compressed backup exceeds its byte limit'));return;}
  archiveHash.update(chunk);next(null,chunk);
 }});
 try{
  await pipeline(Readable.from(blocks()),createGzip({level:plan.policy.budget.gzipLevel}),count,createWriteStream(file,{flags:'wx',mode:0o600}));
  for(const root of plan.roots)for(const {entry,st} of walkRoot(root,fail))seenAfter.update(JSON.stringify([entry,signature(st)])+'\n');
  if(seenAfter.digest('hex')!==plan.scanDigest)throw new Error('backup inventory changed during archive creation');
  fsyncSync(manifestFd);
 }finally{closeSync(manifestFd);}
 return {schemaVersion:BACKUP_SCHEMA,archiveBytes,manifestBytes,archiveSha256:archiveHash.digest('hex'),manifestSha256:manifestHash.digest('hex')};
}

export function validateIntegrity(i){
 fields(i,['schemaVersion','archiveBytes','manifestBytes','archiveSha256','manifestSha256'],'backup integrity');
 if(i.schemaVersion!==BACKUP_SCHEMA||!HASH.test(i.archiveSha256)||!HASH.test(i.manifestSha256)||
  !int(i.archiveBytes,1,compressedBound(65*1024**3))||!int(i.manifestBytes,1,MANIFEST_LIMIT))throw new Error('invalid backup integrity metadata');
 return i;
}

function parseMetadata(raw){
 fields(raw,['schemaVersion','roots','budget','requires','totals','prerequisites'],'backup manifest header');
 if(raw.schemaVersion!==BACKUP_SCHEMA||!Array.isArray(raw.requires)||!raw.requires.includes('backup-v2')||
  raw.requires.some(c=>!DRIVER_CAPABILITIES.includes(c)))throw new Error('unsupported backup format/capabilities; use the retained updater driver');
 const budget=backupBudget(raw.budget);
 if(!Array.isArray(raw.roots)||!raw.roots.length||raw.roots.length>budget.maxRoots)throw new Error('invalid backup root count');
 for(const [index,r] of raw.roots.entries()){
  fields(r,['id','name','parent','logical','canonical','existed','link','aliases','role','originalInode','originalBirthtime'],'backup root');
  if(r.id!==`root-${String(index+1).padStart(4,'0')}`||!cleanAbsolute(r.canonical)||!cleanAbsolute(r.logical)||
    r.name!==pathBasename(r.logical)||r.parent!==pathDirname(r.logical)||typeof r.existed!=='boolean'||
    !(r.link===null||validLink(r.link,4096))||!Array.isArray(r.aliases)||!['instance','extra','exact-file'].includes(r.role))throw new Error('invalid backup root roles');
  for(const a of r.aliases){
   fields(a,['logical','canonical','link'],'backup alias');
   if(!cleanAbsolute(a.logical)||!cleanAbsolute(a.canonical)||!validLink(a.link,4096))throw new Error('invalid backup alias');
  }
  if(r.role==='exact-file'&&(!r.existed||r.link!==null||r.aliases.length||typeof r.originalInode!=='string'||!/^\d+:\d+$/.test(r.originalInode)||
    typeof r.originalBirthtime!=='string'||!/^\d+$/.test(r.originalBirthtime)))throw new Error('invalid exact file root');
 }
 const t=raw.totals;
 fields(t,['entries','bytes','expanded','groups'],'backup totals');
 if(!int(t.entries,0,budget.maxEntries)||!int(t.bytes,0,budget.maxBytes)||!int(t.expanded,1024,1024+budget.maxBytes+1024*t.entries)||
  !int(t.groups,0,t.entries)||raw.requires.includes('hardlinks')!==Boolean(t.groups))throw new Error('invalid backup inventory totals');
 return {...raw,budget};
}

function validLink(link,limit=100){return typeof link==='string'&&!!link&&Buffer.byteLength(link)<=limit&&!/[\x00-\x1f]/.test(link);}

async function* lines(file,integrity){
 const h=hash();let size=0,parts=[],length=0,first=true;
 for await(const block of createReadStream(file,{highWaterMark:65536})){
  size+=block.length;
  if(size>integrity.manifestBytes)throw new Error('backup manifest length mismatch');
  h.update(block);
  for(let start=0;start<block.length;){
   const end=block.indexOf(10,start),part=block.subarray(start,end<0?block.length:end+1);
   length+=part.length;
   const limit=first?MANIFEST_HEADER_LIMIT:MANIFEST_ENTRY_LIMIT;
   if(length>limit)throw new Error('backup manifest line exceeds its limit');
   parts.push(part);
   if(end<0)break;
   yield strictJson(parts.length===1?parts[0]:Buffer.concat(parts,length),{limit});
   parts=[];length=0;first=false;start=end+1;
  }
 }
 if(length||first||size!==integrity.manifestBytes||h.digest('hex')!==integrity.manifestSha256)throw new Error('backup manifest integrity mismatch');
}

// Validate a depth-first tree without indexing every entry. Only hard-linked file leaders outlive their directory.
export async function walkBackup(file,manifest,integrity,visitor={}){
 validateIntegrity(integrity);
 const manifestStat=stat(manifest),archiveStat=file?stat(file):null;
 if(!manifestStat?.isFile()||manifestStat.size!==BigInt(integrity.manifestBytes)||
  (file&&(!archiveStat?.isFile()||archiveStat.size!==BigInt(integrity.archiveBytes))))throw new Error('backup integrity length or file type mismatch');
 const source=file?createReadStream(file,{highWaterMark:65536}):null,unzip=file?createGunzip():null,archiveHash=hash();
 let compressed=0;
 if(source){
  source.on('error',e=>unzip.destroy(e));
  source.on('data',block=>{
   compressed+=block.length;
   if(compressed>integrity.archiveBytes)unzip.destroy(new Error('compressed backup exceeds its recorded length'));
   else archiveHash.update(block);
  });
  source.pipe(unzip);
  // A manifest failure can occur before the reader begins consuming the stream.
  unzip.on('error',()=>{});
 }
 const reader=unzip?new Reader(unzip):null;
 try{
  let metadata,root,rootIndex=0,entries=0,bytes=0,expanded=1024;
  const directories=[],leaders=new Map();
  let present;
  const leave=()=>{
   const dir=directories.pop();
   visitor.leaveDirectory?.(dir.entry,dir.root);
  };
  for await(const raw of lines(manifest,integrity)){
   if(!metadata){
    metadata=parseMetadata(raw);present=metadata.roots.filter(r=>r.existed);
    if(integrity.archiveBytes>compressedBound(metadata.totals.expanded))throw new Error('compressed backup exceeds its format bound');
    visitor.header?.(metadata);
    continue;
   }
   fields(raw,['path','type','mode','bytes','sha256','link','target','names'],'backup manifest entry');
   const e=raw;
   archivePath(e.path,{release:false});
   if(++entries>metadata.totals.entries)throw new Error('excess backup manifest entries');
   const parent=pathDirname(e.path),name=pathBasename(e.path);
   while(directories.length&&directories.at(-1).entry.path!==parent)leave();
   if(parent==='.'){
    root=present[rootIndex++];
    if(root?.id!==e.path||(root.role==='exact-file'&&e.type!=='hardlink'))throw new Error('missing or unordered backup root');
   }else{
    const dir=directories.at(-1);
    if(!dir||dir.last>=name||dir.folds.has(fold(name)))throw new Error('invalid, duplicate or unordered backup entry');
    dir.last=name;dir.folds.add(fold(name));
   }
   if(e.type==='hardlink'){
    const leader=leaders.get(e.target);
    if(Object.keys(e).length!==3||!leader||++leader.count>leader.entry.names)throw new Error('invalid backup hard link');
    visitor.hardlink?.(e,root,leader.entry,leader.root);
    continue;
   }
   if(!['file','directory','symlink'].includes(e.type)||!int(e.mode,0,0o777)||!int(e.bytes,0,metadata.budget.maxFileBytes)||
     (e.type==='file'?(!HASH.test(e.sha256)||e.link!==undefined||(e.names!==undefined&&!int(e.names,2,metadata.totals.entries))):
      (e.bytes!==0||e.sha256!==undefined||e.names!==undefined||(e.type==='symlink'?!validLink(e.link):e.link!==undefined)))||
     e.target!==undefined)throw new Error('invalid backup manifest entry metadata');
   bytes+=e.bytes;expanded+=512+padded(e.bytes);
   if(bytes>metadata.totals.bytes||expanded>metadata.totals.expanded)throw new Error('backup payload exceeds recorded size');
   if(reader&&!(await reader.take(512)).equals(header(e)))throw new Error(`backup header mismatch: ${e.path}`);
   if(e.type==='directory'){
    directories.push({entry:e,root,last:'',folds:new Set()});visitor.directory?.(e,root);
   }else if(e.type==='symlink')visitor.symlink?.(e,root);
   else{
    if(e.names!==undefined)leaders.set(e.path,{entry:e,root,count:1});
    const digest=hash();
    visitor.openFile?.(e,root);
    if(reader){
     for(let remaining=e.bytes;remaining;){
      const chunk=await reader.take(Math.min(remaining,65536));
      digest.update(chunk);visitor.chunk?.(chunk);remaining-=chunk.length;
     }
     if(digest.digest('hex')!==e.sha256)throw new Error(`backup content hash mismatch: ${e.path}`);
     const padding=padded(e.bytes)-e.bytes;
     if(padding&&!(await reader.take(padding)).equals(zero.subarray(0,padding)))throw new Error('nonzero backup padding');
    }
    visitor.closeFile?.(e,root);
   }
  }
  while(directories.length)leave();
  if(!metadata||rootIndex!==present.length||entries!==metadata.totals.entries||bytes!==metadata.totals.bytes||expanded!==metadata.totals.expanded||
   leaders.size!==metadata.totals.groups||[...leaders.values()].some(g=>g.entry.names!==g.count))throw new Error('backup inventory does not match its recorded totals or hard-link coverage');
  if(reader&&(!(await reader.take(1024)).equals(zero)||(await reader.take(1,{eof:true}))!==null||
    compressed!==integrity.archiveBytes||archiveHash.digest('hex')!==integrity.archiveSha256))throw new Error('backup archive integrity mismatch');
  return metadata;
 }finally{
  source?.destroy();unzip?.destroy();visitor.cleanup?.();
 }
}
