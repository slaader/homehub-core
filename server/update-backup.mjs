// Pre-update instance snapshot, streaming v2 archive, socket-preserving restore and legacy v1 recovery.
// Static imports only: the updater may run from the checkout it switches.
import {constants,lstatSync,fstatSync,realpathSync,readlinkSync,opendirSync,readdirSync,statfsSync,mkdirSync,mkdtempSync,rmdirSync,rmSync,cpSync,renameSync,openSync,readSync,writeSync,closeSync,fchmodSync,fsyncSync,linkSync,symlinkSync,lchmodSync,createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {extractArchive,inspectArchive,archivePath,header,Reader,ARCHIVE_LIMITS} from './release-archive.mjs';
import {trustDestination} from './release-trust.mjs';
import {sha256,fileHash,canonicalPath,cleanAbsolute,withinPath,boundedRegularFile,strictJson,fields,durableWrite,syncDirectory} from './safe-fs.mjs';
import {JOURNAL_SCHEMA,RESTORE_STATUSES,validateRestoreRoots,validateSocketRestoreLayout,writeUpdateJournal} from './update-journal.mjs';
import {UpdateError} from './update-errors.mjs';

export const BACKUP_SCHEMA=2;
export const POLICY_SCHEMA=1;
export const DRIVER_CAPABILITIES=Object.freeze(['backup-v1','backup-v2','hardlinks','budget','journal-3','staged-fsync','socket-aware']);

const MiB=1024**2,GiB=1024**3;
const DEFAULT_BUDGET=Object.freeze({maxBytes:ARCHIVE_LIMITS.expanded,maxEntries:ARCHIVE_LIMITS.entries,maxFileBytes:ARCHIVE_LIMITS.file,maxRoots:64,gzipLevel:1});
const MAX_BACKUP_ROOTS=1000;
const MAX_BUDGET={maxBytes:64*GiB,maxEntries:200000,maxFileBytes:8*GiB-1,maxRoots:MAX_BACKUP_ROOTS,gzipLevel:9};
const MANIFEST_LIMIT=128*MiB;
const MANIFEST_HEADER_LIMIT=4*MiB;
const MANIFEST_ENTRY_LIMIT=8192;
const FS_MARGIN=16*MiB;
const HASH_RE=/^[a-f0-9]{64}$/;
const UUID_RE=/^[a-f0-9-]{36}$/;
const ZERO_BLOCKS=Buffer.alloc(1024);

const fail=(_,message)=>{throw new Error(message);};
const int=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const hash=()=>createHash('sha256');
const stat=p=>{try{return lstatSync(p,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const exists=p=>stat(p)!==null;
const inode=s=>`${s.dev}:${s.ino}`;
const identity=st=>`${inode(st)}:${st.birthtimeNs}`;
const fileMode=st=>st&&Number(st.mode&0o777n);
const exactIdentity=(root,s)=>s?.isFile()&&inode(s)===root.originalInode&&String(s.birthtimeNs)===root.originalBirthtime;
const signature=s=>[inode(s),s.nlink,s.size,s.mtimeNs,s.ctimeNs,s.mode].map(String).join(':');
const fold=s=>s.normalize('NFC').toLowerCase();
const padded=n=>Math.ceil(n/512)*512;
const compressedBound=n=>n+Math.ceil(n/100)+65536;
const hasPayload=root=>root.existed&&!root.runtimeSocket;
const rootPrefix=root=>root.legacyName??root.id;
const entryPath=(entry,root,base)=>{const prefix=rootPrefix(root);return entry.path===prefix?base:path.join(base,entry.path.slice(prefix.length+1));};
const socketConflict=live=>new Error(`Restore would replace a UNIX socket, its alias, or a containing directory: ${live}`);

function existingAncestor(p){
 while(!exists(p))p=path.dirname(p);
 return p;
}

function assertOwnerOnlyDir(dir,message){
 const st=stat(dir);
 if(st&&(!st.isDirectory()||st.uid!==BigInt(process.getuid())||(st.mode&0o777n)!==0o700n))throw new Error(message);
}

// --- policy & budget -----------------------------------------------------------------------------------

function backupBudget(raw={}){
 fields(raw,Object.keys(DEFAULT_BUDGET),'backup budget');
 const budget={...DEFAULT_BUDGET,...raw};
 for(const [name,value] of Object.entries(budget)){
  if(!Number.isSafeInteger(value)||value<(name==='gzipLevel'?0:1)||value>MAX_BUDGET[name])throw new Error(`invalid backup budget ${name} (maximum ${MAX_BUDGET[name]})`);
 }
 return budget;
}

// The hub server never reads this file. An alternate path is explicit on each backup or apply.
function backupPolicy(inst){
 const named=inst.backupPolicyFile??(inst.home?path.join(inst.home,'update','backup-policy.json'):null);
 const defaults={file:null,digest:null,budget:backupBudget(),coverFiles:[]};
 if(!named)return defaults;
 let st;
 try{st=lstatSync(named);}catch(e){if(e.code==='ENOENT'&&!inst.backupPolicyFile)return defaults;throw e;}
 const file=trustDestination(named,{forbidden:[inst.root,...(inst.sources??[]).map(s=>s.dir)]});
 const policyStatError='backup policy must be an owner-only regular file with one name, at most 4 MiB';
 const checkPolicyStat=s=>{
  if(!s.isFile()||s.nlink!==1||s.size>4*MiB||(s.mode&0o077)||s.uid!==(process.getuid?.()??s.uid))throw new Error(policyStatError);
 };
 checkPolicyStat(st);
 const bytes=boundedRegularFile(file,4*MiB,'backup policy',{onSymlink:()=>{throw new Error(policyStatError);},checkStat:checkPolicyStat});
 const raw=strictJson(bytes,{limit:4*MiB});
 fields(raw,['schemaVersion','budget','coverFiles'],'backup policy');
 if(raw.schemaVersion!==POLICY_SCHEMA)throw new Error('unsupported backup policy schema');
 const coverFiles=raw.coverFiles??[];
 if(!Array.isArray(coverFiles)||coverFiles.length>MAX_BUDGET.maxRoots||!coverFiles.every(cleanAbsolute)||new Set(coverFiles).size!==coverFiles.length)throw new Error('coverFiles must list distinct, exact absolute file paths');
 return {file,digest:sha256(bytes),budget:backupBudget(raw.budget),coverFiles};
}

// --- scanning, planning & space budgets ----------------------------------------------------------------

function protectedDirectories(inst){
 return [inst.backups,inst.driver,inst.driverSource,...(inst.home?[path.join(inst.home,'update')]:[])].filter(Boolean).map(canonicalPath);
}

function protectedPaths(inst,policyFile){
 return [inst.backups,inst.files.journal,inst.files.lock,inst.staging,inst.trustFile,inst.driver,inst.driverSource,
  ...(inst.home?[path.join(inst.home,'update')]:[]),policyFile].filter(Boolean).map(canonicalPath);
}

function buildRoots(inst,policy,issue){
 const p=inst.paths,env=inst.env,dirs=[p.data,p.state,p.private,p.config];
 const required=[...dirs,...(inst.home?[path.join(inst.home,'instance.json')]:[]),
  p.siteConfig,p.softwareWatch,p.authFile,env.HOME_HUB_SECRET_KEY_FILE||path.join(path.dirname(p.authFile),'secret.key'),
  env.INTEGRATION_SECRETS_FILE,env.GITHUB_TOKEN_FILE,env.TLS_KEY,env.TLS_CERT,...(inst.backupRoots??[])].filter(Boolean).map(p=>path.resolve(p));
 const candidates=[];
 for(const logical of new Set(required)){
  try{
   const s=stat(logical),resolved=canonicalPath(logical);
   if(!cleanAbsolute(resolved)){issue('UNSAFE_ROOT',`refusing filesystem-root or unsafe backup path: ${logical}`);continue;}
   const runtimeSocket=stat(resolved)?.isSocket();
   candidates.push({logical,canonical:resolved,existed:!!s,...(runtimeSocket?{runtimeSocket:true}:{}),link:s?.isSymbolicLink()?readlinkSync(logical):null,role:(inst.backupRoots??[]).includes(logical)?'extra':'instance'});
  }catch(e){issue('UNREADABLE',`cannot resolve backup root ${logical}: ${e.message}`);}
 }
 const roots=[];
 for(const e of candidates){
  const parent=candidates.find(o=>o.canonical!==e.canonical&&withinPath(e.canonical,o.canonical)&&(dirs.includes(o.logical)||stat(o.canonical)?.isDirectory()));
  if(parent)continue;
  const same=roots.find(o=>o.canonical===e.canonical);
  if(!same)roots.push({...e,aliases:[]});
 }
 for(const c of candidates){
  const root=roots.find(r=>withinPath(c.canonical,r.canonical));
  if(root&&root.logical!==c.logical&&c.link!==null)root.aliases.push({logical:c.logical,link:c.link,canonical:c.canonical});
 }
 const sources=[inst.root,...(inst.sources??[]).map(s=>s.dir)].filter(Boolean).map(canonicalPath);
 for(const logical of policy.coverFiles){
  try{
   const s=stat(logical),resolved=canonicalPath(logical);
   if(!s?.isFile()||s.nlink<2n){issue('INVALID_EXACT_FILE',`coverFiles must name an existing hard-linked regular file: ${logical}`);continue;}
   if([...sources,...roots.map(r=>r.canonical)].some(p=>withinPath(resolved,p)||withinPath(p,resolved))){
    issue('POLICY_OVERLAP',`exact file overlaps a backup root or installed source: ${logical}`);continue;
   }
   roots.push({logical,canonical:resolved,existed:true,link:null,aliases:[],role:'exact-file',originalInode:inode(s),originalBirthtime:String(s.birthtimeNs)});
  }catch(e){issue('UNREADABLE',`cannot resolve exact file ${logical}: ${e.message}`);}
 }
 const protectedRoots=protectedPaths(inst,policy.file),protectedDirs=protectedDirectories(inst);
 for(const [i,e] of roots.entries()){
  e.id=`root-${String(i+1).padStart(4,'0')}`;
  e.name=path.basename(e.logical);
  e.parent=path.dirname(e.logical);
  const parentDev=stat(existingAncestor(path.dirname(e.canonical))).dev;
  const rootDev=stat(e.canonical)?.dev??parentDev;
  if(rootDev!==parentDev)issue('ROOT_IS_MOUNTPOINT',`backup root is a mountpoint: ${e.logical}`);
  for(const p of protectedRoots)if(withinPath(p,e.canonical))issue('PROTECTED_INSIDE_ROOT',`The backup/recovery path ${p} is inside ${e.logical}, which is archived. Choose external backup/staging/trust paths.`);
  if(protectedDirs.some(p=>withinPath(e.canonical,p))||sources.some(p=>withinPath(p,e.canonical)||withinPath(e.canonical,path.join(p,'.git'))))
   issue('PROTECTED_ROOT',`backup root overlaps source or recovery metadata: ${e.logical}`);
 }
 return roots;
}

function* children(source,sorted=false){
 const dir=opendirSync(source);
 try{
  let item;
  if(!sorted){while((item=dir.readSync()))yield item.name;return;}
  const names=[];
  while((item=dir.readSync())){
   if(names.length>=200000)throw new Error('directory exceeds the maximum backup entry count');
   names.push(item.name);
  }
  yield* names.sort();
 }finally{dir.closeSync();}
}

// The traversal and ordering are shared by the stat-only scan and the archive writer.
function* walkRoot(root,issue,{archive=true,includeSockets=false}={}){
 function* walk(source,name,dev){
  try{
   const st=stat(source);
   if(!st)throw new Error('file disappeared');
   if(st.dev!==dev){issue('MOUNT_INSIDE_ROOT',`mounted filesystem inside backup root: ${source}`);return;}
   if(st.isSocket()){if(includeSockets)yield {source,st,socket:true};return;}
   let type;
   if(st.isFile())type='file';
   else if(st.isDirectory())type='directory';
   else if(st.isSymbolicLink())type='symlink';
   else{issue('SPECIAL_FILE',`unsupported backup special file: ${source}`);return;}
   if(type==='symlink'&&st.nlink>1n){issue('HARDLINK_SYMLINK',`unsupported hard-linked symbolic link: ${source}`);return;}
   const mode=Number(st.mode&0o777n);
   if(archive&&(st.mode&0o7000n))issue('SPECIAL_MODE',`unsupported backup special mode: ${source}`);
   const entry={path:name,type,mode,bytes:type==='file'?Number(st.size):0,...(type==='symlink'?{link:readlinkSync(source)}:{})};
   if(archive){
    if(entry.bytes>=8*1024**3){issue('USTAR_FILE_TOO_LARGE',`file exceeds USTAR size limit: ${source}`);return;}
    try{archivePath(name,{release:false});header(entry);}
    catch(e){issue('USTAR_PATH',`${source}: ${e.message}`);return;}
   }
   yield {source,entry,st};
   if(type==='directory'){
    const folds=new Set();
    for(const child of children(source,archive)){
     if(archive&&folds.has(fold(child))){issue('PATH_COLLISION',`case-fold backup path collision: ${path.join(source,child)}`);continue;}
     if(archive)folds.add(fold(child));
     yield* walk(path.join(source,child),name+'/'+child,dev);
    }
   }
  }catch(e){issue('UNREADABLE',`cannot scan ${source}: ${e.message}`);}
 }
 if(root.existed)yield* walk(root.canonical,root.id,stat(path.dirname(root.canonical))?.dev);
}

function checkSpace(filesystems,issue,space=statfsSync){
 for(const x of filesystems){
  const fs=space(x.path,{bigint:true});
  x.freeBytes=Number(fs.bavail*fs.bsize);
  x.requiredBytes=x.backupBytes+x.restoreBytes+x.packageBytes+FS_MARGIN;
  if(x.freeBytes<x.requiredBytes)issue('INSUFFICIENT_SPACE',`insufficient space on device ${x.dev} at ${x.path}: need ${x.requiredBytes} bytes, have ${x.freeBytes}`);
 }
}

function filesystem(map,destination){
 const ancestor=existingAncestor(canonicalPath(destination)),dev=String(stat(ancestor).dev);
 if(!map.has(dev))map.set(dev,{dev,path:ancestor,backupBytes:0,restoreBytes:0,packageBytes:0,retainedBytes:0});
 return map.get(dev);
}

function discover(groups,roots,searchRoots,maxEntries,warn){
 const missing=new Map([...groups].filter(([,g])=>g.count<g.expected)),found=new Map();
 const devices=new Set([...missing.keys()].map(key=>key.split(':')[0])),seen=new Set();
 let scanned=0,truncated=false;
 function search(p){
  if(truncated||roots.some(r=>withinPath(p,r.canonical)))return;
  if(++scanned>maxEntries){truncated=true;return;}
  const st=stat(p);
  if(!st||!devices.has(String(st.dev)))return;
  if(st.isFile()&&missing.has(inode(st))){if(!found.has(p))found.set(p,inode(st));return;}
  if(!st.isDirectory()||seen.has(inode(st)))return;
  seen.add(inode(st));
  try{
   const dir=opendirSync(p);
   try{let item;while(!truncated&&(item=dir.readSync()))search(path.join(p,item.name));}
   finally{dir.closeSync();}
  }catch(e){warn('SEARCH_UNREADABLE',`cannot search ${p}: ${e.message}`);}
 }
 if(missing.size)for(const root of searchRoots){
  try{
   if(!stat(root)?.isDirectory())throw new Error('expected a directory');
   search(realpathSync.native(root));
  }catch(e){warn('SEARCH_UNREADABLE',`cannot search ${root}: ${e.message}`);}
 }
 if(truncated)warn('SEARCH_TRUNCATED',`alias search stopped after ${maxEntries} entries`);
 return {found,scanned:Math.min(scanned,maxEntries)};
}

export function scanBackup(inst,{searchRoots=[],searchMaxEntries=2000000,examples=0,candidates=false,packageBytes=0,space=statfsSync}={}){
 const blockers=[],warnings=[],counts={};
 const issue=(code,message)=>{counts[code]=(counts[code]??0)+1;if(blockers.length<100)blockers.push({code,message});};
 const warn=(code,message)=>{if(warnings.length<100)warnings.push({code,message});};
 let policy,roots;
 try{policy=backupPolicy(inst);}
 catch(e){issue('POLICY_INVALID',e.message);return {blockers,warnings,counts};}
 try{roots=buildRoots(inst,policy,issue);}
 catch(e){issue('UNREADABLE',e.message);return {blockers,warnings,counts};}
 const {budget}=policy,groups=new Map(),filesystems=new Map(),rootStats=[];
 const totals={entries:0,bytes:0,expanded:1024,groups:0},runtimeSockets={count:0,examples:[]};
 let visited=0;
 const managed=new Set([inst.files.history,inst.files.updates,inst.files.run].filter(Boolean).map(canonicalPath));
 const digest=hash();
 let manifestBytes=Buffer.byteLength(JSON.stringify(roots))+8192;
 if(manifestBytes>MANIFEST_HEADER_LIMIT)issue('MANIFEST_TOO_LARGE','backup root metadata exceeds manifest header limit');
 if(roots.length>budget.maxRoots)issue('OVER_BUDGET_ROOTS',`backup exceeds maxRoots (${budget.maxRoots})`);
 scan: for(const root of roots){
  const dest=filesystem(filesystems,path.dirname(root.canonical));
  const info={id:root.id,logical:root.logical,canonical:root.canonical,role:root.role,dev:dest.dev,files:0,directories:0,symlinks:0,apparentBytes:0,allocatedBytes:0,largestFileBytes:0,longestPathBytes:0};
  rootStats.push(info);
  for(const item of walkRoot(root,issue,{includeSockets:true})){
   if(++visited>budget.maxEntries)break scan;
   const {source,entry:e,st}=item;
   if(item.socket){
    runtimeSockets.count++;
    if(runtimeSockets.examples.length<examples)runtimeSockets.examples.push(source);
    continue;
   }
   digest.update(JSON.stringify([e,signature(st)])+'\n');
   totals.entries++;
   let bytes=e.bytes,hardlink=false;
   info.longestPathBytes=Math.max(info.longestPathBytes,Buffer.byteLength(e.path));
   if(e.type==='file'){
    info.files++;info.apparentBytes+=bytes;info.allocatedBytes+=Number(st.blocks)*512;
    info.largestFileBytes=Math.max(info.largestFileBytes,bytes);
    if(bytes>budget.maxFileBytes)issue('OVER_BUDGET_FILE',`backup exceeds maxFileBytes (${budget.maxFileBytes}): ${source}`);
    if(st.nlink>1n){
     if(managed.has(source))issue('MANAGED_HARDLINK',`unsupported hard-linked updater-managed file: ${source}`);
     const key=inode(st);
     let group=groups.get(key);
     if(!group){group={first:e.path,source,bytes,count:0,regular:0,expected:Number(st.nlink),root:root.id,crossRoot:false};groups.set(key,group);}
     else{bytes=0;hardlink=true;}
     group.count++;if(root.role!=='exact-file')group.regular++;
     if(group.root!==root.id)group.crossRoot=true;
     if(group.expected!==Number(st.nlink))issue('HARDLINK_CHANGED',`hard-linked backup file changed during scan: ${source}`);
    }
   }else if(e.type==='directory')info.directories++;
   else{
    info.symlinks++;
    try{
     const target=realpathSync.native(source),lexical=path.resolve(path.dirname(source),e.link);
     const covered=p=>roots.some(r=>r.existed&&withinPath(p,r.canonical));
     if(!covered(target)||!(covered(lexical)||roots.some(r=>[r.logical,...r.aliases.map(a=>a.logical)].some(a=>withinPath(lexical,a)))))
      issue('UNCOVERED_LINK',`uncovered escaping backup link: ${source} → ${target}; add --backup-root for the target`);
    }catch{issue('DANGLING_LINK',`dangling or looping backup link: ${source}`);}
   }
   totals.bytes+=bytes;
   if(!hardlink)totals.expanded+=512+padded(bytes);
   dest.restoreBytes+=Math.ceil(bytes/4096)*4096+4096;
   manifestBytes+=Buffer.byteLength(JSON.stringify(e))+256;
  }
 }
 if(visited>budget.maxEntries)issue('OVER_BUDGET_ENTRIES',`backup exceeds maxEntries (${budget.maxEntries})`);
 totals.groups=groups.size;
 if(totals.bytes>budget.maxBytes)issue('OVER_BUDGET_BYTES',`backup exceeds maxBytes (${budget.maxBytes})`);
 if(manifestBytes>MANIFEST_LIMIT)issue('MANIFEST_TOO_LARGE','backup exceeds manifest byte limit');
 for(const g of groups.values()){
  if(g.count!==g.expected)issue('HARDLINK_UNACCOUNTED',`hard-linked backup file has ${g.expected} names and ${g.count} covered: ${g.source}; enroll every alias in coverFiles or a backup root`);
  if(!g.regular)issue('INVALID_EXACT_FILE',`exact file is unrelated to any other backup root: ${g.source}`);
 }
 const missingNames=[...groups.values()].reduce((n,g)=>n+Math.max(0,g.expected-g.count),0);
 const {found,scanned}=discover(groups,roots,searchRoots,searchMaxEntries,warn),byParent=new Map();
 const excluded=[...protectedPaths(inst,policy.file),...[inst.root,...(inst.sources??[]).map(s=>s.dir)].filter(Boolean).map(canonicalPath)];
 const eligible=candidates?[...found.keys()].filter(file=>cleanAbsolute(file)&&!excluded.some(p=>withinPath(file,p))).sort():[];
 const proposedRoots=roots.length+eligible.length;
 const candidatePolicy=eligible.length&&eligible.length===missingNames&&eligible.length===found.size&&proposedRoots<=MAX_BACKUP_ROOTS?
  {schemaVersion:POLICY_SCHEMA,budget:{...budget,maxRoots:Math.max(budget.maxRoots,proposedRoots)},coverFiles:[...policy.coverFiles,...eligible].sort()}:undefined;
 for(const [file,key] of found){
  const parent=path.dirname(file),extension=path.extname(file)||'(none)';
  if(!byParent.has(parent))byParent.set(parent,{parent,names:0,bytes:0,extensions:{}});
  const row=byParent.get(parent);row.names++;row.bytes+=groups.get(key).bytes;row.extensions[extension]=(row.extensions[extension]??0)+1;
 }
 try{
  const archiveFs=filesystem(filesystems,inst.backups);
  archiveFs.backupBytes=compressedBound(totals.expanded)+manifestBytes;
  const backupDir=canonicalPath(inst.backups);
  if(stat(backupDir)?.isDirectory())for(const name of readdirSync(backupDir)){
   if(/^pre-.*\.tgz(?:\..*)?$/.test(name))archiveFs.retainedBytes+=Number(stat(path.join(backupDir,name))?.blocks??0n)*512;
  }
  if(packageBytes)filesystem(filesystems,path.dirname(inst.root)).packageBytes+=packageBytes;
  checkSpace(filesystems.values(),issue,space);
 }catch(e){issue('SPACE_CHECK_FAILED',e.message);}
 const prerequisites=[...(inst.env.HOME_HUB_SECRET_KEY?['HOME_HUB_SECRET_KEY from the service secret store']:[]),
  ...(inst.env.HOME_HUB_SECRET_KEYCHAIN==='1'?['macOS login Keychain secret-key']:[])];
 return {roots,rootStats,policy,totals,groups,manifestBytes,scanDigest:digest.digest('hex'),
  prerequisites,runtimeSockets,candidatePolicy,
  filesystems:[...filesystems.values()],blockers,warnings,counts,
  links:{groups:groups.size,crossRoot:[...groups.values()].filter(g=>g.crossRoot).length,missingNames,
   foundNames:found.size,unfoundNames:Math.max(0,missingNames-found.size),searchedEntries:scanned,parents:[...byParent.values()],
   ...(examples?{examples:[...found.keys()].sort().slice(0,examples)}:{}),
   ...(candidates?{candidateCoverFiles:eligible}:{})}};
}

export function backupRootSummary(roots){
 const names=roots.filter(r=>r.role!=='exact-file'&&!r.runtimeSocket).map(r=>r.name);
 const aliases=roots.filter(r=>r.role==='exact-file').length;
 return [...names,...(aliases?[`${aliases} exact alias paths`]:[])].join(', ');
}

export function backupPlan(inst,options){
 const plan=scanBackup(inst,options);
 if(plan.blockers.length)throw new UpdateError(plan.blockers.map(b=>b.code+': '+b.message).join('\n'));
 return plan;
}

function verifyBackupRoots(inst,plan){
 const roots=buildRoots(inst,plan.policy,fail);
 if(JSON.stringify(roots)!==JSON.stringify(plan.roots))throw new Error('backup root topology changed');
}

function verifyCurrentCoverage(roots){
 const groups=new Map();
 for(const root of roots){
  const s=stat(root.canonical);
  if(root.role==='exact-file'&&s&&!exactIdentity(root,s))throw new Error(`exact alias identity changed; refusing to replace ${root.canonical}`);
  if(!s)continue;
  for(const {source,st} of walkRoot({...root,existed:true},fail,{archive:false})){
   if(!st.isFile()||st.nlink===1n)continue;
   const key=inode(st),g=groups.get(key)??{source,count:0,expected:Number(st.nlink)};
   if(g.expected!==Number(st.nlink))throw new Error(`hard-link topology changed: ${source}`);
   g.count++;groups.set(key,g);
  }
 }
 for(const g of groups.values())if(g.count!==g.expected)throw new Error(`HARDLINK_UNACCOUNTED: live hard-linked file has outside names: ${g.source}`);
}

// --- streaming v2 archive & authenticated JSONL manifest -----------------------------------------------

function writeAll(fd,bytes){
 let offset=0;
 while(offset<bytes.length){
  const wrote=writeSync(fd,bytes,offset,bytes.length-offset);
  if(!wrote)throw new Error('short backup write');
  offset+=wrote;
 }
}

async function writeBackupArchive(file,manifest,plan){
 const manifestFd=openSync(manifest,'wx',0o600),manifestHash=hash(),archiveHash=hash(),seen=hash(),seenAfter=hash();
 const requires=['backup-v2','socket-aware',...(plan.groups.size?['hardlinks']:[])];
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
   if(padding)yield ZERO_BLOCKS.subarray(0,padding);
   line({...e,sha256:digest.digest('hex'),...(group?{names:group.expected}:{})});
  }
  if(seen.digest('hex')!==plan.scanDigest||entries!==plan.totals.entries||expanded!==plan.totals.expanded)throw new Error('backup inventory changed while streaming');
  yield ZERO_BLOCKS;
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

function validateIntegrity(i){
 fields(i,['schemaVersion','archiveBytes','manifestBytes','archiveSha256','manifestSha256'],'backup integrity');
 if(i.schemaVersion!==BACKUP_SCHEMA||!HASH_RE.test(i.archiveSha256)||!HASH_RE.test(i.manifestSha256)||
  !int(i.archiveBytes,1,compressedBound(65*GiB))||!int(i.manifestBytes,1,MANIFEST_LIMIT))throw new Error('invalid backup integrity metadata');
 return i;
}

function validLink(link,limit=100){return typeof link==='string'&&!!link&&Buffer.byteLength(link)<=limit&&!/[\x00-\x1f]/.test(link);}

function parseMetadata(raw){
 fields(raw,['schemaVersion','roots','budget','requires','totals','prerequisites'],'backup manifest header');
 if(raw.schemaVersion!==BACKUP_SCHEMA||!Array.isArray(raw.requires)||!raw.requires.includes('backup-v2')||
  raw.requires.some(c=>!DRIVER_CAPABILITIES.includes(c)))throw new Error('unsupported backup format/capabilities; use the retained updater driver');
 const budget=backupBudget(raw.budget);
 if(!Array.isArray(raw.roots)||!raw.roots.length||raw.roots.length>budget.maxRoots)throw new Error('invalid backup root count');
 for(const [index,r] of raw.roots.entries()){
  fields(r,['id','name','parent','logical','canonical','existed','link','aliases','role','originalInode','originalBirthtime','runtimeSocket'],'backup root');
  if(r.id!==`root-${String(index+1).padStart(4,'0')}`||!cleanAbsolute(r.canonical)||!cleanAbsolute(r.logical)||
    r.name!==path.basename(r.logical)||r.parent!==path.dirname(r.logical)||typeof r.existed!=='boolean'||
    !(r.link===null||validLink(r.link,4096))||!Array.isArray(r.aliases)||!['instance','extra','exact-file'].includes(r.role))throw new Error('invalid backup root roles');
  if(r.runtimeSocket!==undefined&&(r.runtimeSocket!==true||!r.existed||r.role==='exact-file'||!raw.requires.includes('socket-aware')))throw new Error('invalid runtime socket root');
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
async function walkBackup(file,manifest,integrity,visitor={}){
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
    metadata=parseMetadata(raw);present=metadata.roots.filter(hasPayload);
    if(integrity.archiveBytes>compressedBound(metadata.totals.expanded))throw new Error('compressed backup exceeds its format bound');
    visitor.header?.(metadata);
    continue;
   }
   fields(raw,['path','type','mode','bytes','sha256','link','target','names'],'backup manifest entry');
   const e=raw;
   archivePath(e.path,{release:false});
   if(++entries>metadata.totals.entries)throw new Error('excess backup manifest entries');
   const parent=path.dirname(e.path),name=path.basename(e.path);
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
     (e.type==='file'?(!HASH_RE.test(e.sha256)||e.link!==undefined||(e.names!==undefined&&!int(e.names,2,metadata.totals.entries))):
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
     if(padding&&!(await reader.take(padding)).equals(ZERO_BLOCKS.subarray(0,padding)))throw new Error('nonzero backup padding');
    }
    visitor.closeFile?.(e,root);
   }
  }
  while(directories.length)leave();
  if(!metadata||rootIndex!==present.length||entries!==metadata.totals.entries||bytes!==metadata.totals.bytes||expanded!==metadata.totals.expanded||
   leaders.size!==metadata.totals.groups||[...leaders.values()].some(g=>g.entry.names!==g.count))throw new Error('backup inventory does not match its recorded totals or hard-link coverage');
  if(reader&&(!(await reader.take(1024)).equals(ZERO_BLOCKS)||(await reader.take(1,{eof:true}))!==null||
    compressed!==integrity.archiveBytes||archiveHash.digest('hex')!==integrity.archiveSha256))throw new Error('backup archive integrity mismatch');
  return metadata;
 }finally{
  source?.destroy();unzip?.destroy();visitor.cleanup?.();
 }
}

// Stream the authenticated v2 manifest with bounded memory to resolve a single file (or hard-link alias).
function findManifestEntry(manifestFile,integrity,wantedPath){
 const fd=openSync(manifestFile,constants.O_RDONLY|constants.O_NOFOLLOW);
 const h=hash(),buf=Buffer.allocUnsafe(65536),leaders=new Map();
 const wantedToken=JSON.stringify(wantedPath);
 let size=0,parts=[],length=0,first=true,done=false,found=null;
 try{
  const fst=fstatSync(fd,{bigint:true});
  if(!fst.isFile()||fst.size!==BigInt(integrity.manifestBytes))throw new Error('backup manifest integrity mismatch');
  for(;;){
   const n=readSync(fd,buf,0,buf.length,null);
   if(!n)break;
   const block=buf.subarray(0,n);
   size+=n;
   if(size>integrity.manifestBytes)throw new Error('backup manifest length mismatch');
   h.update(block);
   for(let start=0;start<n;){
    const end=block.indexOf(10,start),part=block.subarray(start,end<0?n:end+1);
    length+=part.length;
    const limit=first?MANIFEST_HEADER_LIMIT:MANIFEST_ENTRY_LIMIT;
    if(length>limit)throw new Error('backup manifest line exceeds its limit');
    if(end<0){parts.push(Buffer.from(part));break;}
    if(!first&&!done){
     const text=(parts.length?Buffer.concat([...parts,part],length):part).toString('utf8');
     if(text.includes(wantedToken)||text.includes('"names"')){
      const e=JSON.parse(text);
      if(e.type==='file'&&e.names!==undefined)leaders.set(e.path,e);
      if(e.path===wantedPath){
       if(e.type==='file')found=e;
       else if(e.type==='hardlink')found=leaders.get(e.target)??null;
       done=true;
      }
     }
    }
    parts=[];length=0;first=false;start=end+1;
   }
  }
 }finally{closeSync(fd);}
 if(length||first||size!==integrity.manifestBytes||h.digest('hex')!==integrity.manifestSha256)throw new Error('backup manifest integrity mismatch');
 return found;
}

export async function createBackup(inst,ctx,name,{plan=backupPlan(inst)}={}){
 if(!/^[A-Za-z0-9.-]+$/.test(name)||name==='.'||name==='..')throw new Error('invalid backup name');
 if(plan.runtimeSockets.count)ctx.log(`  preserving ${plan.runtimeSockets.count} filesystem UNIX socket(s) in place, outside the archive`);
 mkdirSync(inst.backups,{recursive:true,mode:0o700});
 const file=path.join(inst.backups,name+'.tgz'),manifest=file+'.manifest.jsonl',integrity=file+'.integrity.json';
 if([file,manifest,integrity].some(exists))throw new Error(`archive already exists: ${file}`);
 const temp=file+'.'+randomUUID()+'.tmp',tempManifest=temp+'.jsonl';
 try{
  verifyBackupRoots(inst,plan);
  const data=await writeBackupArchive(temp,tempManifest,plan);
  await walkBackup(temp,tempManifest,data);
  const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  const description=JSON.stringify(data)+'\n';
  verifyBackupRoots(inst,plan);
  renameSync(tempManifest,manifest);durableWrite(integrity,description);renameSync(temp,file);syncDirectory(inst.backups);
  return {schemaVersion:BACKUP_SCHEMA,file,manifest,integrity,integritySha256:sha256(description),entries:plan.roots,
   bytes:data.archiveBytes,files:plan.totals.entries,verified:true};
 }finally{rmSync(temp,{force:true});rmSync(tempManifest,{force:true});}
}

// --- live UNIX socket preservation & restore path resolution -------------------------------------------

// Follow links relative to their logical parent, even when a journal maps that parent to an aside.
function resolveRestorePath(logical,locate=p=>p,visit){
 const root=path.parse(logical).root;
 let file=root,st=stat(root),pending=logical.slice(root.length).split(path.sep),hops=0;
 while(pending.length){
  const part=pending.shift();
  if(st&&!st.isDirectory())return null;
  if(!part||part==='.')continue;
  if(part==='..'){
   if(!st)return null;
   file=path.dirname(file);st=stat(locate(file));continue;
  }
  const next=path.join(file,part),physical=locate(next);
  st=stat(physical);
  if(st)visit?.(next,st);
  if(st?.isSymbolicLink()){
   if(++hops>40)return null;
   const link=readlinkSync(physical);
   if(path.isAbsolute(link))file=root;
   pending=link.split(path.sep).concat(pending);
   st=stat(locate(file));
  }else file=next;
 }
 return {file,st};
}

function linkTarget(live){
 try{const file=realpathSync.native(live);return {file,st:stat(file)};}
 catch(e){if(!['ENOENT','ENOTDIR','ELOOP'].includes(e.code))throw e;return null;}
}

function scanRestoreSockets(roots,maxEntries){
 const anchors=new Map(),sockets=new Map(),aliases=new Map();
 const linksByDirectory=new Map(),reachableDirs=new Set(),queue=[];
 const byPath=new Map(roots.map(r=>[r.canonical,r]));
 const anchorDirectories=(first,root)=>{
  for(let dir=first;withinPath(dir,root.canonical)&&!anchors.has(dir);dir=path.dirname(dir)){
   const st=stat(dir);
   if(!st?.isDirectory())throw socketConflict(dir);
   anchors.set(dir,{id:root.id,live:dir,identity:identity(st)});
  }
 };
 const markReachable=live=>{
  for(let dir=path.dirname(live);!reachableDirs.has(dir);dir=path.dirname(dir)){
   reachableDirs.add(dir);queue.push(dir);
  }
 };
 const keepAlias=(live,st,root,target)=>{
  if(aliases.has(live))return;
  aliases.set(live,{id:root.id,live,identity:identity(st),link:readlinkSync(live),target});
  anchorDirectories(path.dirname(live),root);
  markReachable(live);
 };
 // A link can traverse a directory or another link before a ".." step. Keep those paths too.
 const trace=live=>{
  const resolved=resolveRestorePath(live,undefined,(file,st)=>{
   let parent=file;
   while(!byPath.has(parent)&&parent!==path.dirname(parent))parent=path.dirname(parent);
   const root=byPath.get(parent);
   if(!root)return;
   if(st.isDirectory())anchorDirectories(file,root);
   if(st.isSymbolicLink()&&!aliases.has(file)){
    const target=linkTarget(file);
    if(!target)throw socketConflict(file);
    keepAlias(file,st,root,target.file);
   }
  });
  if(!resolved?.st)throw socketConflict(live);
 };
 const consider=live=>{
  const target=linkTarget(live);
  if(target?.st?.isSocket())trace(live);
  if(target?.st?.isDirectory()){
   if(!linksByDirectory.has(target.file))linksByDirectory.set(target.file,[]);
   linksByDirectory.get(target.file).push(live);
  }
 };
 let visited=0;
 for(const root of roots){
  if(root.link)consider(root.logical);
  for(const alias of root.aliases??[])if(alias.link)consider(alias.logical);
  if(!exists(root.canonical))continue;
  for(const item of walkRoot({...root,existed:true},fail,{archive:false,includeSockets:true})){
   if(++visited>maxEntries)throw new Error(`Live restore inventory exceeds maxEntries (${maxEntries})`);
   if(item.socket){
    sockets.set(item.source,root.id);
    anchorDirectories(path.dirname(item.source),root);
    markReachable(item.source);
   }else if(item.entry.type==='symlink')consider(item.source);
  }
 }
 for(let i=0;i<queue.length;i++)for(const live of linksByDirectory.get(queue[i])??[])
  if(!aliases.has(live))trace(live);
 return {anchors,sockets,aliases};
}

export function refuseSocketReplacement(live,{aliases=true}={}){
 if(!exists(live))return;
 for(const item of walkRoot({canonical:live,existed:true,id:'live'},fail,{archive:false,includeSockets:true})){
  if(item.socket||(aliases&&item.entry.type==='symlink'&&linkTarget(item.source)?.st?.isSocket()))
   throw socketConflict(item.source);
 }
}

function checkSocketEntry(layout,e,root,pendingAliases){
 const live=entryPath(e,root,root.canonical),alias=layout.aliases.get(live);
 let st;
 try{st=stat(live);}catch(e){if(e.code!=='ENOTDIR')throw e;}
 if(st?.isSocket()||(layout.anchors.has(live)&&e.type!=='directory')||
  (alias&&(e.type!=='symlink'||e.link!==alias.link||e.mode!==fileMode(st))))throw socketConflict(live);
 if(alias)pendingAliases.delete(live);
}

function planSocketRestore(roots,progress,layout){
 if(!layout.sockets.size&&!layout.aliases.size)return null;
 const anchors=[...layout.anchors.values()].sort((a,b)=>a.live.length-b.live.length),sockets=[],units=[];
 const bases=new Map(progress.map(p=>[p.id,p]));
 for(const root of roots){
  const base=bases.get(root.id);
  if(layout.sockets.has(root.canonical)){
   if(hasPayload(root))throw socketConflict(root.canonical);
   sockets.push(root.id);
  }
  for(const anchor of anchors){
   if(anchor.id!==root.id)continue;
   const stagedDir=path.join(base.staged,path.relative(root.canonical,anchor.live));
   const staged=stat(stagedDir);
   if(staged&&!staged.isDirectory())throw socketConflict(anchor.live);
   const archived=new Set(staged?children(stagedDir):[]);
   const names=new Set([...archived,...children(anchor.live)]);
   for(const name of names){
    const live=path.join(anchor.live,name);
    if(layout.anchors.has(live))continue;
    const alias=layout.aliases.get(live);
    if(alias){
     const staged=path.join(stagedDir,name),st=stat(staged);
     if(!archived.has(name)||!st?.isSymbolicLink()||readlinkSync(staged)!==alias.link||fileMode(st)!==fileMode(stat(live)))
      throw socketConflict(live);
     continue;
    }
    const present=archived.has(name);
    if(layout.sockets.has(live)){
     if(present)throw socketConflict(live);
     continue;
    }
    units.push({id:root.id,live,staged:path.join(stagedDir,name),stageDir:base.stageDir,
     aside:path.join(base.aside,randomUUID()),existed:present,status:'prepared'});
   }
  }
 }
 return {anchors,sockets,units,aliases:[...layout.aliases.values()]};
}

function validateSocketRestore(layout,roots,progress){
 if(!layout)return;
 validateSocketRestoreLayout(layout);
 const bases=new Map(progress.map(p=>[p.id,p])),byId=new Map(roots.map(r=>[r.id,r]));
 const anchors=new Map(),aliases=new Map(),livePaths=new Set(),asidePaths=new Set(),rootSockets=new Set(),split=new Set();
 for(const a of layout.anchors){
  const root=byId.get(a.id);
  if(!root||root.role==='exact-file'||!cleanAbsolute(a.live)||!withinPath(a.live,root.canonical)||
     anchors.has(a.live)||!/^\d+:\d+:\d+$/.test(a.identity))throw new Error('invalid preserved socket directory');
  anchors.set(a.live,a);split.add(a.id);
 }
 for(const a of anchors.values()){
  if(a.live!==byId.get(a.id).canonical&&anchors.get(path.dirname(a.live))?.id!==a.id)
   throw new Error('missing parent of preserved socket directory');
  const st=stat(a.live);
  if(!st?.isDirectory()||identity(st)!==a.identity||st.dev!==stat(path.dirname(a.live))?.dev)
   throw new Error(`Preserved socket directory changed during restore: ${a.live}`);
 }
 for(const id of layout.sockets){
  const root=byId.get(id);
  if(!root||hasPayload(root)||root.role==='exact-file'||rootSockets.has(id)||anchors.has(root.canonical))
   throw new Error('invalid preserved socket root');
  rootSockets.add(id);
  const st=stat(root.canonical);
  if(st&&!st.isSocket())throw socketConflict(root.canonical);
 }
 for(const id of split){
  const aside=bases.get(id)?.aside;
  if(!aside)throw new Error('unsafe failed socket-directory state path');
  assertOwnerOnlyDir(aside,'unsafe failed socket-directory state path');
 }
 for(const alias of layout.aliases??[]){
  const {id,live,link,target}=alias;
  if(anchors.get(path.dirname(live))?.id!==id||aliases.has(live)||anchors.has(live)||
    !cleanAbsolute(live)||!cleanAbsolute(target)||typeof link!=='string'||!/^\d+:\d+:\d+$/.test(alias.identity))
   throw new Error('invalid preserved UNIX socket alias');
  const st=stat(live),resolved=linkTarget(live);
  if(!st?.isSymbolicLink()||identity(st)!==alias.identity||readlinkSync(live)!==link||resolved?.file!==target||
    !(resolved.st?.isSocket()||resolved.st?.isDirectory()))
   throw new Error(`Preserved UNIX socket alias changed during restore: ${live}`);
  aliases.set(live,alias);
 }
 for(const u of layout.units){
  const root=byId.get(u.id),base=bases.get(u.id),dir=path.dirname(u.live);
  if(!root||!base||anchors.get(dir)?.id!==u.id||!cleanAbsolute(u.live)||!cleanAbsolute(u.aside)||
     livePaths.has(u.live)||aliases.has(u.live)||asidePaths.has(u.aside)||anchors.has(u.live)||path.dirname(u.aside)!==base.aside||
     !UUID_RE.test(path.basename(u.aside))||u.stageDir!==base.stageDir||
     u.staged!==path.join(base.staged,path.relative(root.canonical,u.live))||
     typeof u.existed!=='boolean'||!RESTORE_STATUSES.includes(u.status))throw new Error('invalid journalled socket directory child');
  livePaths.add(u.live);asidePaths.add(u.aside);
 }
 // Check membership on every resume. A daemon may rebind an endpoint in a retained directory.
 // A new durable path requires operator reconciliation so it cannot be lost or silently left behind.
 for(const a of anchors.values())for(const name of children(a.live)){
  const live=path.join(a.live,name),st=stat(live);
  if(!st)continue;
  if(st.isSocket()){
   if(livePaths.has(live)||anchors.has(live))throw socketConflict(live);
  }else if(!livePaths.has(live)&&!anchors.has(live)&&!aliases.has(live))
   throw new Error(`Unplanned path in preserved socket directory: ${live}`);
 }
}

function activeRestoreUnits(layout,progress){
 if(!layout)return progress;
 const kept=new Set(layout.anchors.map(a=>a.live)),sockets=new Set(layout.sockets);
 return [...progress.filter(p=>!kept.has(p.live)&&!sockets.has(p.id)),...layout.units];
}

function prepareSocketAsides(layout){
 for(const aside of new Set(layout?.units.map(u=>path.dirname(u.aside))??[])){
  if(!exists(aside)){
   mkdirSync(aside,{mode:0o700});
   syncDirectory(path.dirname(aside));
  }
 }
}

function removeRestoreStage(stageDir){
 refuseSocketReplacement(stageDir,{aliases:false});
 rmSync(stageDir,{recursive:true,force:true});
}

// --- journalled restore state machine (v2 streaming + v1/legacy compatibility) -------------------------

function validateRoots(inst,roots,progress=[],policyFile=null){
 const protectedRoots=protectedPaths(inst,policyFile),protectedDirs=protectedDirectories(inst);
 // Look up each component in its recorded location, with relative links interpreted at their live names.
 const moved=new Map();
 for(const row of progress)if(['moving-old','old-moved','installing'].includes(row.status)&&!exists(row.live)){
  if(exists(row.aside))moved.set(row.live,row.aside);
  else if(exists(row.staged))moved.set(row.live,row.staged);
 }
 const locate=logical=>{
  if(!moved.size)return logical;
  for(let parent=logical;;parent=path.dirname(parent)){
   if(moved.has(parent))return path.join(moved.get(parent),path.relative(parent,logical));
   if(parent===path.dirname(parent))return logical;
  }
 };
 const resolveFollowed=logical=>{
  try{return realpathSync.native(logical);}
  catch(e){
   // A covered target may have been removed since the backup and is about to be restored.
   if(e.code==='ENOENT')return resolveRestorePath(logical)?.file;
   if(!['ENOTDIR','ELOOP'].includes(e.code))throw e;
   return null;
  }
 };
 const linkMatches=(logical,link,target)=>{
  if(!moved.size)return stat(logical)?.isSymbolicLink()&&readlinkSync(logical)===link&&resolveFollowed(logical)===target;
  const parent=resolveRestorePath(path.dirname(logical),locate);
  if(!parent?.st?.isDirectory())return false;
  const file=locate(path.join(parent.file,path.basename(logical)));
  return stat(file)?.isSymbolicLink()&&readlinkSync(file)===link&&resolveRestorePath(logical,locate)?.file===target;
 };
 for(const e of roots){
  if(!e||!/^root-\d{4}$/.test(e.id)||!path.isAbsolute(e.canonical)||e.canonical===path.parse(e.canonical).root||!path.isAbsolute(e.logical))throw new Error('invalid backup root roles');
  if(canonicalPath(path.dirname(e.canonical))!==path.dirname(e.canonical)||(exists(e.canonical)&&lstatSync(e.canonical).isSymbolicLink()))throw new Error('restore destination topology changed');
  for(const alias of e.aliases??[])if(alias.link!==null&&!linkMatches(alias.logical,alias.link,alias.canonical??e.canonical))throw new Error('restore alias topology changed');
  for(const protectedPath of protectedRoots)if(withinPath(protectedPath,e.canonical))throw new Error('restore would replace recovery metadata or trust');
  if(e.role&&protectedDirs.some(p=>withinPath(e.canonical,p)))throw new Error('restore would replace recovery metadata or trust');
  if(e.role&&e.link===null&&(moved.size?resolveRestorePath(e.logical,locate)?.file:canonicalPath(e.logical))!==e.canonical)throw new Error('restore logical root topology changed');
  if(stat(e.canonical)&&stat(e.canonical).dev!==stat(path.dirname(e.canonical)).dev)throw new Error('restore root is a mountpoint');
  if(e.link!==null&&e.link!==undefined&&!linkMatches(e.logical,e.link,e.canonical))throw new Error('top-level symlink topology changed; manual recovery required');
 }
 for(let i=0;i<roots.length;i++)for(let j=0;j<i;j++)if(withinPath(roots[i].canonical,roots[j].canonical)||withinPath(roots[j].canonical,roots[i].canonical))throw new Error('overlapping restore roots');
}

function validateLink(entry,root,roots,{includeAliases=true}={}){
 const target=path.resolve(path.dirname(entryPath(entry,root,root.canonical)),entry.link);
 const covered=roots.some(r=>r.existed&&(includeAliases?[r.canonical,r.logical,...(r.aliases??[]).map(a=>a.logical)]:[r.canonical]).some(p=>withinPath(target,p)));
 if(!covered)throw new Error(`uncovered restore link target: ${entry.path}`);
}

function failedStateDir(inst,ctx,journal){
 const named=path.join(inst.backups,`failed-${new Date(ctx.now()).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)}`);
 const aside=journal?.failedState??(exists(named)?`${named}-${randomUUID()}`:named);
 if(path.dirname(aside)!==path.resolve(inst.backups)||!path.basename(aside).startsWith('failed-')||
   (stat(aside)&&!stat(aside).isDirectory()))throw new Error('invalid failed-state index path');
 return aside;
}

function makeRestoreUnit(root,status){
 const stageDir=path.join(path.dirname(root.canonical),'.hub-restore-'+randomUUID());
 return {id:root.id,live:root.canonical,stageDir,staged:path.join(stageDir,'root'),aside:root.canonical+'.failed-'+randomUUID(),existed:hasPayload(root),status};
}

function createStageDirectory(unit){
 mkdirSync(path.dirname(unit.live),{recursive:true,mode:0o700});
 mkdirSync(unit.stageDir,{mode:0o700});
 syncDirectory(path.dirname(unit.live));
}

function stagedInventory(rootId,stagedPath){
 const files=[];
 let bytes=0;
 for(const item of walkRoot({id:rootId,canonical:stagedPath,existed:true},fail,{archive:true,includeSockets:true})){
  if(item.socket)throw new Error(`unsupported backup type: ${item.source}`);
  const {source,entry}=item;
  if(files.length>=ARCHIVE_LIMITS.entries||(entry.type==='file'&&(entry.bytes>ARCHIVE_LIMITS.file||(bytes+=entry.bytes)>ARCHIVE_LIMITS.expanded)))
   throw new Error('backup exceeds local archive limits; relocate or use an independently verified backup procedure');
  files.push({path:entry.path,type:entry.type,mode:entry.mode,bytes:entry.bytes,sha256:entry.type==='file'?fileHash(source):null,...(entry.type==='symlink'?{link:entry.link}:{})});
 }
 return files;
}

async function restoreLegacy(inst,ctx,backup,journal,{manifest,legacy}){
 const scratch=mkdtempSync(path.join(inst.backups,'.restore-'));
 const aside=failedStateDir(inst,ctx,journal);
 const save=()=>{if(journal){journal.failedState=aside;journal.restoreRoots??=[];writeUpdateJournal(inst.files.journal,journal);}};
 try{
  const allowedRoots=legacy?new Set(manifest.roots.map(r=>r.legacyName)):null;
  const entries=await extractArchive(backup.file,scratch,{release:false,legacy,allowedRoots,expected:manifest.files?new Map(manifest.files.map(f=>[f.path,f])):null});
  // Inspect link destinations as archive data, never by traversing a staged link into the live filesystem.
  for(const e of entries.filter(e=>e.type==='symlink')){
   const r=manifest.roots.find(r=>e.path===rootPrefix(r)||e.path.startsWith(rootPrefix(r)+'/'));
   if(!r)throw new Error('unmapped backup symlink');
   validateLink(e,r,manifest.roots,{includeAliases:false});
  }
  save();
  const progress=journal?.restoreRoots??[];
  // Prepare every root on its destination filesystem before the first live rename.
  for(const r of manifest.roots){
   if(progress.some(p=>p.id===r.id))continue;
   const unit=makeRestoreUnit(r,'prepared');
   createStageDirectory(unit);
   if(r.existed){
    const from=path.join(scratch,rootPrefix(r));
    if(!exists(from))throw new Error(`missing archive root: ${r.id}`);
    cpSync(from,unit.staged,{recursive:true,dereference:false,preserveTimestamps:true,verbatimSymlinks:true});
   }
   progress.push(unit);save();
  }
  if(manifest.files){
   for(const p of progress.filter(p=>p.status==='prepared'&&p.existed)){
    const staged=stagedInventory(p.id,p.staged),expected=manifest.files.filter(f=>f.path===p.id||f.path.startsWith(p.id+'/'));
    if(JSON.stringify(staged)!==JSON.stringify(expected))throw new Error('destination staging validation failed');
   }
  }
  validateRoots(inst,manifest.roots,progress);
  verifyOldGraph(manifest.roots,progress);
  const result=installRoots(inst,ctx,manifest.roots,progress,aside,save);
  // Legacy progress records do not prove the stage directory is empty or isolated; remove it only when empty.
  for(const p of progress){
   try{rmdirSync(p.stageDir);syncDirectory(path.dirname(p.stageDir));}
   catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;}
  }
  return result;
 }finally{rmSync(scratch,{recursive:true,force:true});}
}

function restoreDescription(inst,backup){
 if(!backup||!cleanAbsolute(backup.file)||!stat(backup.file)?.isFile())throw new Error(`the archive ${backup?.file??'(none)'} is gone or is not a regular file`);
 const modern=backup.schemaVersion===BACKUP_SCHEMA||backup.manifest?.endsWith('.jsonl');
 if(modern){
  if(backup.manifest!==backup.file+'.manifest.jsonl'||backup.integrity!==backup.file+'.integrity.json'||
   path.dirname(canonicalPath(backup.file))!==canonicalPath(inst.backups))throw new Error('invalid backup sidecar paths');
  const bytes=boundedRegularFile(backup.integrity,16384,'backup metadata');
  if(sha256(bytes)!==backup.integritySha256)throw new Error('backup integrity sidecar mismatch');
  const integrity=validateIntegrity(strictJson(bytes,{limit:16384}));
  return {integrity};
 }
 if(backup.manifest||backup.integrity){
  if(!backup.manifest||!backup.integrity)throw new Error('backup integrity sidecar missing');
  const bytes=boundedRegularFile(backup.manifest,8*MiB,'backup metadata'),integrity=strictJson(boundedRegularFile(backup.integrity,16384,'backup metadata'));
  if(integrity.schemaVersion!==1||sha256(bytes)!==integrity.manifestSha256||lstatSync(backup.file).size!==integrity.archiveBytes||
   fileHash(backup.file,integrity.archiveBytes)!==integrity.archiveSha256)throw new Error('backup integrity mismatch');
  const manifest=strictJson(bytes);
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!Array.isArray(manifest.roots))throw new Error('unsupported backup manifest');
  return {manifest,legacy:false};
 }
 const roots=backup.entries.map((e,i)=>({id:`root-${String(i+1).padStart(4,'0')}`,logical:path.join(e.parent,e.name),
  canonical:canonicalPath(path.join(e.parent,e.name)),link:null,existed:true,legacyName:e.name}));
 return {manifest:{roots,files:null},legacy:true};
}

function validateProgress(roots,progress,modern){
 if(progress.length)validateRestoreRoots(progress,modern?JOURNAL_SCHEMA:2);
 const ids=new Set(),staging=new Set(),asides=new Set();
 for(const p of progress){
  const r=roots.find(r=>r.id===p.id);
  if(!r||ids.has(p.id)||p.live!==r.canonical||!p.aside.startsWith(p.live+'.failed-')||
   !path.basename(p.stageDir).startsWith('.hub-restore-')||
   p.staged!==path.join(p.stageDir,'root')||p.existed!==hasPayload(r)||staging.has(p.stageDir)||asides.has(p.aside))
   throw new Error('restore progress does not match authenticated backup root roles');
  ids.add(p.id);staging.add(p.stageDir);asides.add(p.aside);
  if(modern){
   if(!UUID_RE.test(path.basename(p.stageDir).slice('.hub-restore-'.length))||
    !UUID_RE.test(p.aside.slice(p.live.length+8)))throw new Error('invalid streaming restore recovery paths');
   assertOwnerOnlyDir(p.stageDir,'unsafe restore stage directory');
   if(roots.some(r=>withinPath(p.stageDir,r.canonical)||withinPath(p.aside,r.canonical)))throw new Error('restore recovery paths overlap a live root');
  }
 }
 if(modern&&progress.length&&(progress.length!==roots.length||
  (progress.some(p=>p.status==='preparing')&&!progress.every(p=>p.status==='preparing'))))throw new Error('incomplete restore transaction');
}

function installRoots(inst,ctx,roots,progress,aside,save){
 const exact=new Map(roots.filter(r=>r.role==='exact-file').map(r=>[r.id,r]));
 for(const p of progress){
  if(p.status==='installed')continue;
  if(p.status==='installing'&&p.existed&&!exists(p.staged)&&exists(p.live)){
   syncDirectory(path.dirname(p.live));p.status='installed';save();continue;
  }
  if(p.status==='prepared'||p.status==='moving-old'){
   p.status='moving-old';save();
   if(exists(p.live)){
    if(exists(p.aside))throw new Error('ambiguous partial restore: both live and failed root exist');
    const r=exact.get(p.id),live=stat(p.live);
    if(r&&!exactIdentity(r,live))throw new Error(`exact alias identity changed: ${p.live}`);
    refuseSocketReplacement(p.live);
    renameSync(p.live,p.aside);ctx.checkpoint?.('restore-old-renamed');
   }
   syncDirectory(path.dirname(p.live));
   if(path.dirname(p.aside)!==path.dirname(p.live))syncDirectory(path.dirname(p.aside));
   p.status='old-moved';save();
  }
  if(p.status==='old-moved'||p.status==='installing'){
   if(exists(p.live))throw new Error('unexpected live root during restore');
   p.status='installing';save();
   if(exists(p.live))throw new Error('live root appeared while recording the restore intent');
   if(p.existed){refuseSocketReplacement(p.staged,{aliases:false});renameSync(p.staged,p.live);ctx.checkpoint?.('restore-new-renamed');}
   syncDirectory(path.dirname(p.live));syncDirectory(p.stageDir);p.status='installed';save();
  }
  if(!exact.has(p.id))ctx.log(`  restored ${p.live}; failed state preserved at ${p.aside}`);
 }
 if(exact.size)ctx.log(`  restored ${exact.size} exact alias paths; failed-state index at ${aside}`);
 mkdirSync(aside,{recursive:true,mode:0o700});
 durableWrite(path.join(aside,'roots.json'),JSON.stringify(progress.map(({live,aside})=>({live,aside})),null,1)+'\n');
 return aside;
}

function archiveEntryPathFor(roots,file){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))return null;
 const matchTarget=target=>{
  for(const r of roots){
   if(!hasPayload(r))continue;
   for(const base of [r.canonical,r.logical]){
    if(!base||!withinPath(target,base))continue;
    const prefix=rootPrefix(r);
    return target===base?prefix:`${prefix}/${path.relative(base,target).split(path.sep).join('/')}`;
   }
  }
  return null;
 };
 // Match the normalized path directly first, then canonicalize outer prefixes TOP-DOWN (shallowest first,
 // e.g. /tmp -> /private/tmp) so paths beneath an archived root stay strictly lexical and never follow a
 // nested live symlink into a different archived root.
 const resolved=path.resolve(file);
 const direct=matchTarget(resolved);
 if(direct)return direct;
 const fsRoot=path.parse(resolved).root;
 const parts=resolved.slice(fsRoot.length).split(path.sep).filter(Boolean);
 for(let i=1;i<parts.length;i++){
  const outer=path.join(fsRoot,...parts.slice(0,i));
  const tail=parts.slice(i);
  try{
   const candidate=path.join(canonicalPath(outer),...tail);
   const hit=matchTarget(candidate);
   if(hit)return hit;
  }catch{}
 }
 return null;
}

function matchExpect(entry,expect){
 if(!entry)return false;
 if(!expect)return true;
 if(expect.sha256!==undefined&&entry.sha256!==expect.sha256)return false;
 if(expect.mode!==undefined&&entry.mode!==expect.mode)return false;
 return true;
}

const ensureSpace=fs=>checkSpace(fs,fail);
const needsStages=progress=>!progress.length||progress[0].status==='preparing';

// Read-only validation precedes service stop, code checkout and live state renames.
export async function assessRestore(inst,backup,journal=null){
 inst={...inst,driver:journal?.driver??inst.driver,trustFile:journal?.trustFile??inst.trustFile};
 const description=restoreDescription(inst,backup),progress=journal?.restoreRoots??[];
 if(!description.integrity){
  validateProgress(description.manifest.roots,progress,false);
  validateRoots(inst,description.manifest.roots,progress);
  for(const r of description.manifest.roots)refuseSocketReplacement(r.canonical);
  verifyOldGraph(description.manifest.roots,progress);
  const {manifest,legacy}=description;
  let legacyFiles=null;
  if(legacy){
   const allowedRoots=new Set(manifest.roots.map(r=>r.legacyName));
   const entries=await inspectArchive(backup.file,{release:false,legacy:true,allowedRoots});
   const presentRoots=new Set(entries.map(e=>e.path.split('/')[0]));
   for(const r of manifest.roots)if(r.existed&&!presentRoots.has(rootPrefix(r)))throw new Error(`missing archive root: ${r.id}`);
   for(const e of entries.filter(e=>e.type==='symlink')){
    const r=manifest.roots.find(r=>e.path===rootPrefix(r)||e.path.startsWith(rootPrefix(r)+'/'));
    if(!r)throw new Error('unmapped backup symlink');
    validateLink(e,r,manifest.roots,{includeAliases:false});
   }
   legacyFiles=new Map(entries.map(e=>[e.path,e]));
  }else if(manifest.files){
   const presentRoots=new Set(manifest.files.map(e=>e.path.split('/')[0]));
   for(const r of manifest.roots)if(r.existed&&!presentRoots.has(rootPrefix(r)))throw new Error(`missing archive root: ${r.id}`);
  }
  const coversFile=(file,expect)=>{
   const wanted=archiveEntryPathFor(manifest.roots,file);
   if(!wanted)return false;
   const entry=legacyFiles?legacyFiles.get(wanted):manifest.files?.find(e=>e.path===wanted);
   if(!entry||entry.type!=='file')return false;
   return matchExpect(entry,expect);
  };
  return {...description,coversFile};
 }
 const {integrity}=description,devices=new Map(),filesystems=new Map(),policyFile=journal?.backupPolicy?.file??inst.backupPolicyFile;
 let roots,liveSockets,pendingAliases;
 const socketRestore=journal?.socketRestore;
 const units=activeRestoreUnits(socketRestore,progress);
 const checkEntry=(e,r)=>{
  if(liveSockets&&(liveSockets.sockets.size||liveSockets.aliases.size))checkSocketEntry(liveSockets,e,r,pendingAliases);
 };
 const cost=(root,bytes)=>{devices.get(root.id).restoreBytes+=Math.ceil(bytes/4096)*4096+4096;};
 const metadata=await walkBackup(null,backup.manifest,integrity,{
  header(m){
   roots=m.roots;
   if(JSON.stringify(roots)!==JSON.stringify(backup.entries))throw new Error('backup manifest differs from journal root roles');
   validateProgress(roots,progress,true);
   validateSocketRestore(socketRestore,roots,progress);
   validateRoots(inst,roots,units,policyFile);
   liveSockets=scanRestoreSockets(roots,m.budget.maxEntries);
   if(socketRestore){
    // A previously installed link can now resolve to a preserved socket. Only pending moves can disrupt it.
    const pendingUnits=new Set(units.filter(p=>p.status==='prepared'||p.status==='moving-old').map(p=>p.live));
    const willMove=live=>{
     for(let dir=live;dir!==path.dirname(dir);dir=path.dirname(dir))if(pendingUnits.has(dir))return true;
     return false;
    };
    for(const live of [...liveSockets.sockets.keys(),...liveSockets.aliases.keys()])if(willMove(live))throw socketConflict(live);
    liveSockets.aliases=new Map((socketRestore.aliases??[]).map(a=>[a.live,a]));
   }else if((liveSockets.sockets.size||liveSockets.aliases.size)&&progress.some(p=>!['preparing','prepared'].includes(p.status)))
    throw new Error('A UNIX socket or alias appeared during whole-root restore; preserve the endpoint and reconcile the journal before retrying');
   pendingAliases=new Set(liveSockets.aliases.keys());
   for(const root of roots)devices.set(root.id,filesystem(filesystems,path.dirname(root.canonical)));
  },
  directory(e,r){checkEntry(e,r);cost(r,0);},
  openFile(e,r){checkEntry(e,r);cost(r,e.bytes);},
  symlink(e,r){checkEntry(e,r);validateLink(e,r,roots);cost(r,0);},
  hardlink(e,r,leader,source){
   checkEntry(e,r);
   if(devices.get(r.id).dev!==devices.get(source.id).dev)throw new Error('restore destinations for a hard-link group are on different filesystems');
   cost(r,0);
  }
 });
 if(pendingAliases.size)throw socketConflict(pendingAliases.values().next().value);
 if(!stat(backup.file)?.isFile()||stat(backup.file).size!==BigInt(integrity.archiveBytes)||
  fileHash(backup.file,integrity.archiveBytes)!==integrity.archiveSha256)throw new Error('backup archive integrity mismatch');
 if(needsStages(progress)){
  verifyOldGraph(roots,units,socketRestore);
  // An interrupted preparation reclaims its staging allocation before the final check.
  if(!progress.length)ensureSpace(filesystems.values());
 }else{
  verifyOldGraph(roots,units,socketRestore);
  await verifyStages(backup,integrity,progress,socketRestore);
 }
 const coversFile=(file,expect)=>{
  const wanted=archiveEntryPathFor(metadata.roots,file);
  if(!wanted)return false;
  const entry=findManifestEntry(backup.manifest,integrity,wanted);
  return matchExpect(entry,expect);
 };
 return {integrity,metadata,filesystems,policyFile,coversFile};
}

function stageVisitor(ctx,progress){
 const stages=new Map(progress.map(p=>[p.id,p.staged]));
 const at=(e,r)=>entryPath(e,r,stages.get(r.id));
 let fd;
 return {
  directory(e,r){mkdirSync(at(e,r),{mode:0o700});},
  leaveDirectory(e,r){
   const dir=openSync(at(e,r),'r');
   try{fchmodSync(dir,e.mode);fsyncSync(dir);}finally{closeSync(dir);}
  },
  symlink(e,r){const dest=at(e,r);symlinkSync(e.link,dest);if(Number(stat(dest).mode&0o777n)!==e.mode)lchmodSync(dest,e.mode);},
  hardlink(e,r,leader,source){linkSync(at(leader,source),at(e,r));},
  openFile(e,r){fd=openSync(at(e,r),'wx',0o600);},
  chunk(bytes){writeAll(fd,bytes);},
  closeFile(e){
   fchmodSync(fd,e.mode);fsyncSync(fd);closeSync(fd);fd=undefined;
   ctx.checkpoint?.('restore-prepare-mid');
  },
  cleanup(){if(fd!==undefined)closeSync(fd);}
 };
}

// Resolve each root through journaled renames. Cross-root links span these locations on resume.
function restoreLocation(p){
 const live=exists(p.live),staged=exists(p.staged);
 if(p.status==='installed'||(p.status==='installing'&&p.existed&&!staged&&live)){
  if(live!==p.existed||staged)throw new Error('installed restore root changed');
  return p.live;
 }
 if(staged!==p.existed||(['old-moved','installing'].includes(p.status)&&live)||
  (p.status==='moving-old'&&live&&exists(p.aside)))throw new Error('ambiguous restore root state');
 return p.staged;
}

function verifyOldGraph(roots,units,socketRestore){
 const active=new Map(units.map(p=>[p.live,p]));
 const split=new Set(socketRestore?.anchors.map(a=>a.id)??[]),sockets=new Set(socketRestore?.sockets??[]);
 const originals=roots.flatMap(r=>sockets.has(r.id)?[]:split.has(r.id)?
  units.filter(u=>u.id===r.id).map(u=>({...r,canonical:u.live})):[r]);
 const old=[];
 for(const r of originals){
  const p=active.get(r.canonical);
  if(p&&exists(p.aside))old.push({...r,canonical:p.aside});
  else if(!p||['preparing','prepared','moving-old'].includes(p.status))old.push(r);
 }
 verifyCurrentCoverage(old);
}

async function verifyStages(backup,integrity,progress,socketRestore){
 const stageBases=new Map(progress.map(p=>[p.id,p.staged]));
 const units=activeRestoreUnits(socketRestore,progress);
 const locations=new Map(units.map(p=>[p.live,restoreLocation(p)]));
 const awaitingPayload=new Set(units.filter(p=>p.existed).map(p=>p.live));
 const anchorPaths=new Set(socketRestore?.anchors.map(a=>a.live));
 const aliasPaths=new Set(socketRestore?.aliases?.map(a=>a.live));
 const dirs=[],leaders=new Map(),payloadRoots=new Set();
 const finished=units.every(p=>p.status==='installed');
 const retained=finished?anchorPaths:new Set();
 const locate=(e,r)=>{
  const live=entryPath(e,r,r.canonical);
  if(anchorPaths.has(live)||aliasPaths.has(live))return finished?live:entryPath(e,r,stageBases.get(r.id));
  awaitingPayload.delete(live);
  for(let p=live;withinPath(p,r.canonical);p=path.dirname(p)){
   if(locations.has(p))return path.join(locations.get(p),path.relative(p,live));
   if(anchorPaths.has(p))break;
  }
  throw new Error(`Archive entry has no journalled restore unit: ${live}`);
 };
 const verify=(e,r,type)=>{
  const file=locate(e,r);
  if(dirs.length&&dirs.at(-1).root===r&&path.dirname(file)===dirs.at(-1).file)dirs.at(-1).count++;
  if(e.path===r.id)payloadRoots.add(r.id);
  const s=stat(file);
  if(!s||!s[type]()||(!retained.has(file)&&e.mode!==undefined&&Number(s.mode&0o7777n)!==e.mode))throw new Error(`destination staging type or mode mismatch: ${file}`);
  return {s,file};
 };
 await walkBackup(null,backup.manifest,integrity,{
  directory(e,r){const {file}=verify(e,r,'isDirectory');dirs.push({file,root:r,count:0});},
  leaveDirectory(){const {file,count}=dirs.pop();if(!retained.has(file)&&readdirSync(file).length!==count)throw new Error(`unexpected staged entries: ${file}`);},
  symlink(e,r){const {file}=verify(e,r,'isSymbolicLink');if(readlinkSync(file)!==e.link)throw new Error(`destination staging link mismatch: ${file}`);},
  openFile(e,r){
   const {s,file}=verify(e,r,'isFile');
   if(s.nlink!==BigInt(e.names??1)||s.size!==BigInt(e.bytes)||fileHash(file,e.bytes)!==e.sha256)throw new Error(`destination staging content or hard-link mismatch: ${file}`);
   if(e.names)leaders.set(e.path,inode(s));
  },
  hardlink(e,r){
   const {s,file}=verify(e,r,'isFile');
   if(inode(s)!==leaders.get(e.target))throw new Error(`destination staging hard-link target mismatch: ${file}`);
  }
 });
 if(awaitingPayload.size)throw new Error('restore unit has no matching archive entry');
 // An anchored, live-only directory has no payload or staging tree.
 for(const p of progress)if(!payloadRoots.has(p.id)&&exists(p.staged))throw new Error('unexpected staged root');
}

async function verifyAssessedRestore(plan,backup,journal){
 const progress=journal?.restoreRoots??[];
 const roots=plan.integrity?plan.metadata.roots:plan.manifest.roots;
 const sockets=journal?.socketRestore;
 verifyOldGraph(roots,activeRestoreUnits(sockets,progress),sockets);
 if(plan.integrity&&!needsStages(progress))await verifyStages(backup,plan.integrity,progress,sockets);
}

export async function restoreBackup(inst,ctx,backup,journal=null,assessed=null){
 const plan=assessed??await assessRestore(inst,backup,journal);
 if(assessed)await verifyAssessedRestore(plan,backup,journal);
 if(journal?.driver)inst={...inst,driver:journal.driver};
 if(!plan.integrity){
  if(plan.legacy)ctx.log('  LEGACY archive: no integrity provenance; strict staged inspection required');
  return restoreLegacy(inst,ctx,backup,journal,plan);
 }
 const {metadata:{roots,budget},integrity,policyFile}=plan;
 let socketRestore=journal?.socketRestore;
 const progress=journal?.restoreRoots??[];
 const aside=failedStateDir(inst,ctx,journal);
 const save=()=>{if(journal){
  journal.failedState=aside;journal.restoreRoots=progress;
  if(socketRestore)journal.socketRestore=socketRestore;
  writeUpdateJournal(inst.files.journal,journal);
 }};
 validateProgress(roots,progress,true);
 validateSocketRestore(socketRestore,roots,progress);
 validateRoots(inst,roots,activeRestoreUnits(socketRestore,progress),policyFile);
 try{
  if(needsStages(progress)){
   verifyOldGraph(roots,progress,socketRestore);
   if(!progress.length){
    for(const r of roots)progress.push(makeRestoreUnit(r,'preparing'));
    save();
   }else for(const p of progress)removeRestoreStage(p.stageDir);
   ensureSpace(plan.filesystems.values());
   for(const p of progress)createStageDirectory(p);
   await walkBackup(backup.file,backup.manifest,integrity,stageVisitor(ctx,progress));
   for(const p of progress)syncDirectory(p.stageDir);
   await verifyStages(backup,integrity,progress);
   for(const p of progress)p.status='prepared';
   socketRestore=planSocketRestore(roots,progress,scanRestoreSockets(roots,budget.maxEntries));
   save();ctx.checkpoint?.('restore-all-prepared');
  }else if(!socketRestore&&progress.every(p=>p.status==='prepared')){
   socketRestore=planSocketRestore(roots,progress,scanRestoreSockets(roots,budget.maxEntries));
   if(socketRestore)save();
  }
  validateSocketRestore(socketRestore,roots,progress);
  if(socketRestore?.anchors.length)ctx.log(`  preserving ${socketRestore.anchors.length} socket-containing directories during restore`);
  const units=activeRestoreUnits(socketRestore,progress);
  verifyOldGraph(roots,units,socketRestore);
  prepareSocketAsides(socketRestore);
  const result=installRoots(inst,ctx,roots,units,aside,save);
  for(const p of progress)removeRestoreStage(p.stageDir);
  ctx.checkpoint?.('restore-cleaned');
  return result;
 }finally{
  if(!journal&&activeRestoreUnits(socketRestore,progress).every(p=>['preparing','prepared'].includes(p.status)))
   for(const p of progress)removeRestoreStage(p.stageDir);
 }
}
