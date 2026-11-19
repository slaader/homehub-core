// Keep socket directories at their live names. Only their durable children become rename units.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdirSync,readlinkSync,realpathSync,rmSync} from 'node:fs';
import {children,exists,inode,stat,walkRoot} from './backup-scan.mjs';
import {cleanAbsolute,withinPath} from './backup-policy.mjs';
import {syncDirectory} from './release-trust.mjs';

const fail=(_,message)=>{throw new Error(message);};
const identity=st=>inode(st)+':'+st.birthtimeNs;
const mode=st=>st&&Number(st.mode&0o777n);
const statuses=['prepared','moving-old','old-moved','installing','installed'];
const asideName=/^[a-f0-9-]{36}$/;
export const hasPayload=root=>root.existed&&!root.runtimeSocket;
export const socketConflict=live=>new Error(`Restore would replace a UNIX socket, its alias, or a containing directory: ${live}`);
export const entryPath=(entry,root,base)=>entry.path===root.id?base:path.join(base,entry.path.slice(root.id.length+1));

// Follow links relative to their logical parent, even when a journal maps that parent to an aside.
export function resolveRestorePath(logical,locate=p=>p,visit){
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

export function scanRestoreSockets(roots,maxEntries){
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

export function checkSocketEntry(layout,e,root,pendingAliases){
 const live=entryPath(e,root,root.canonical),alias=layout.aliases.get(live);
 let st;
 try{st=stat(live);}catch(e){if(e.code!=='ENOTDIR')throw e;}
 if(st?.isSocket()||(layout.anchors.has(live)&&e.type!=='directory')||
  (alias&&(e.type!=='symlink'||e.link!==alias.link||e.mode!==mode(st))))throw socketConflict(live);
 if(alias)pendingAliases.delete(live);
}

export function planSocketRestore(roots,progress,layout){
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
     if(!archived.has(name)||!st?.isSymbolicLink()||readlinkSync(staged)!==alias.link||mode(st)!==mode(stat(live)))
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

export function validateSocketRestore(layout,roots,progress){
 if(!layout)return;
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
  const aside=bases.get(id)?.aside,st=aside&&stat(aside);
  if(!aside||(st&&(!st.isDirectory()||st.uid!==BigInt(process.getuid())||(st.mode&0o777n)!==0o700n)))
   throw new Error('unsafe failed socket-directory state path');
 }
 for(const alias of layout.aliases??[]){
  const {id,live,link,target}=alias;
  if(anchors.get(path.dirname(live))?.id!==id||aliases.has(live)||anchors.has(live)||
    !cleanAbsolute(live)||!cleanAbsolute(target)||typeof link!=='string'||!/^[0-9]+:[0-9]+:[0-9]+$/.test(alias.identity))
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
     !asideName.test(path.basename(u.aside))||u.stageDir!==base.stageDir||
     u.staged!==path.join(base.staged,path.relative(root.canonical,u.live))||
     typeof u.existed!=='boolean'||!statuses.includes(u.status))throw new Error('invalid journalled socket directory child');
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

export function activeRestoreUnits(layout,progress){
 if(!layout)return progress;
 const kept=new Set(layout.anchors.map(a=>a.live)),sockets=new Set(layout.sockets);
 return [...progress.filter(p=>!kept.has(p.live)&&!sockets.has(p.id)),...layout.units];
}

export function prepareSocketAsides(layout){
 for(const aside of new Set(layout?.units.map(u=>path.dirname(u.aside))??[])){
  if(!exists(aside)){
   mkdirSync(aside,{mode:0o700});
   syncDirectory(path.dirname(aside));
  }
 }
}

export function removeRestoreStage(stageDir){
 refuseSocketReplacement(stageDir,{aliases:false});
 rmSync(stageDir,{recursive:true,force:true});
}
