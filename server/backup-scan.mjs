import {lstatSync,realpathSync,readlinkSync,opendirSync,readdirSync,statfsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {archivePath,header} from './release-archive.mjs';
import {backupPolicy,cleanAbsolute,withinPath,MAX_BACKUP_ROOTS,POLICY_SCHEMA,MANIFEST_HEADER_LIMIT,MANIFEST_ENTRY_LIMIT,MANIFEST_LIMIT} from './backup-policy.mjs';

export const stat=p=>{try{return lstatSync(p,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export const exists=p=>stat(p)!==null;
export function canonical(p){
 p=path.resolve(p);
 if(exists(p))return realpathSync.native(p);
 return path.join(canonical(path.dirname(p)),path.basename(p));
}
export function existingAncestor(p){
 while(!exists(p))p=path.dirname(p);
 return p;
}
export const inode=s=>`${s.dev}:${s.ino}`;
export const exactIdentity=(root,s)=>s?.isFile()&&inode(s)===root.originalInode&&String(s.birthtimeNs)===root.originalBirthtime;
export const signature=s=>[inode(s),s.nlink,s.size,s.mtimeNs,s.ctimeNs,s.mode].map(String).join(':');
export const fold=s=>s.normalize('NFC').toLowerCase();
export const padded=n=>Math.ceil(n/512)*512;
export const compressedBound=n=>n+Math.ceil(n/100)+65536;
const fsMargin=16*1024**2;

export function protectedDirectories(inst){
 return [inst.backups,inst.driver,inst.driverSource,...(inst.home?[path.join(inst.home,'update')]:[])].filter(Boolean).map(canonical);
}
export function protectedPaths(inst,policyFile){
 return [inst.backups,inst.files.journal,inst.files.lock,inst.staging,inst.trustFile,inst.driver,inst.driverSource,
  ...(inst.home?[path.join(inst.home,'update')]:[]),policyFile].filter(Boolean).map(canonical);
}

function buildRoots(inst,policy,issue){
 const p=inst.paths,env=inst.env,dirs=[p.data,p.state,p.private,p.config];
 const required=[...dirs,...(inst.home?[path.join(inst.home,'instance.json')]:[]),
  p.siteConfig,p.softwareWatch,p.authFile,env.HOME_HUB_SECRET_KEY_FILE||path.join(path.dirname(p.authFile),'secret.key'),
  env.INTEGRATION_SECRETS_FILE,env.GITHUB_TOKEN_FILE,env.TLS_KEY,env.TLS_CERT,...(inst.backupRoots??[])].filter(Boolean).map(p=>path.resolve(p));
 const candidates=[];
 for(const logical of new Set(required)){
  try{
   const s=stat(logical),resolved=canonical(logical);
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
 const sources=[inst.root,...(inst.sources??[]).map(s=>s.dir)].filter(Boolean).map(canonical);
 for(const logical of policy.coverFiles){
  try{
   const s=stat(logical),resolved=canonical(logical);
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

export function* children(source,sorted=false){
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
export function* walkRoot(root,issue,{archive=true,includeSockets=false}={}){
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

export function checkSpace(filesystems,issue,space=statfsSync){
 for(const x of filesystems){
  const fs=space(x.path,{bigint:true});
  x.freeBytes=Number(fs.bavail*fs.bsize);
  x.requiredBytes=x.backupBytes+x.restoreBytes+x.packageBytes+fsMargin;
  if(x.freeBytes<x.requiredBytes)issue('INSUFFICIENT_SPACE',`insufficient space on device ${x.dev} at ${x.path}: need ${x.requiredBytes} bytes, have ${x.freeBytes}`);
 }
}
export function filesystem(map,destination){
 const ancestor=existingAncestor(canonical(destination)),dev=String(stat(ancestor).dev);
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
 const managed=new Set([inst.files.history,inst.files.updates,inst.files.run].filter(Boolean).map(canonical));
 const digest=createHash('sha256');
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
 const excluded=[...protectedPaths(inst,policy.file),...[inst.root,...(inst.sources??[]).map(s=>s.dir)].filter(Boolean).map(canonical)];
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
  const backupDir=canonical(inst.backups);
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
   ...(candidates?{candidateCoverFiles:eligible}: {})}};
}

export function verifyCurrentCoverage(roots){
 const groups=new Map();
 const issue=(_,message)=>{throw new Error(message);};
 for(const root of roots){
  const s=stat(root.canonical);
  if(root.role==='exact-file'&&s&&!exactIdentity(root,s))throw new Error(`exact alias identity changed; refusing to replace ${root.canonical}`);
  if(!s)continue;
  for(const {source,st} of walkRoot({...root,existed:true},issue,{archive:false})){
   if(!st.isFile()||st.nlink===1n)continue;
   const key=inode(st),g=groups.get(key)??{source,count:0,expected:Number(st.nlink)};
   if(g.expected!==Number(st.nlink))throw new Error(`hard-link topology changed: ${source}`);
   g.count++;groups.set(key,g);
  }
 }
 for(const g of groups.values())if(g.count!==g.expected)throw new Error(`HARDLINK_UNACCOUNTED: live hard-linked file has outside names: ${g.source}`);
}
