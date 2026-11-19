// Keep socket directories at their live names. Only their durable children become rename units.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdirSync,rmSync} from 'node:fs';
import {children,exists,inode,stat,walkRoot} from './backup-scan.mjs';
import {cleanAbsolute,withinPath} from './backup-policy.mjs';
import {syncDirectory} from './release-trust.mjs';

const fail=(_,message)=>{throw new Error(message);};
const identity=st=>inode(st)+':'+st.birthtimeNs;
const statuses=['prepared','moving-old','old-moved','installing','installed'];
const asideName=/^[a-f0-9-]{36}$/;
export const hasPayload=root=>root.existed&&!root.runtimeSocket;
export const socketConflict=live=>new Error(`Restore would replace a UNIX socket or its containing directory: ${live}`);
export const entryPath=(entry,root,base)=>entry.path===root.id?base:path.join(base,entry.path.slice(root.id.length+1));

export function scanRestoreSockets(roots,maxEntries){
 const anchors=new Map(),sockets=new Map();
 let visited=0;
 for(const root of roots){
  if(!exists(root.canonical))continue;
  for(const item of walkRoot({...root,existed:true},fail,{archive:false,includeSockets:true})){
   if(++visited>maxEntries)throw new Error(`Live restore inventory exceeds maxEntries (${maxEntries})`);
   if(!item.socket)continue;
   sockets.set(item.source,root.id);
   for(let dir=path.dirname(item.source);withinPath(dir,root.canonical)&&!anchors.has(dir);dir=path.dirname(dir)){
    const st=stat(dir);
    if(!st?.isDirectory())throw socketConflict(dir);
    anchors.set(dir,{id:root.id,live:dir,identity:identity(st)});
   }
  }
 }
 return {anchors,sockets};
}

export function refuseSocketReplacement(live){
 if(!exists(live))return;
 // A symlink is itself replaceable even when its target is a socket. Never follow it.
 for(const item of walkRoot({canonical:live,existed:true,id:'live'},fail,{archive:false,includeSockets:true}))
  if(item.socket)throw socketConflict(item.source);
}

export function checkSocketEntry(layout,e,root){
 const live=entryPath(e,root,root.canonical);
 if(layout.sockets.has(live)||stat(live)?.isSocket()||(layout.anchors.has(live)&&e.type!=='directory'))throw socketConflict(live);
}

export function planSocketRestore(roots,progress,layout){
 if(!layout.sockets.size)return null;
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
 return {anchors,sockets,units};
}

export function validateSocketRestore(layout,roots,progress){
 if(!layout)return;
 const bases=new Map(progress.map(p=>[p.id,p])),byId=new Map(roots.map(r=>[r.id,r]));
 const anchors=new Map(),livePaths=new Set(),asidePaths=new Set(),rootSockets=new Set(),split=new Set();
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
 for(const u of layout.units){
  const root=byId.get(u.id),base=bases.get(u.id),dir=path.dirname(u.live);
  if(!root||!base||anchors.get(dir)?.id!==u.id||!cleanAbsolute(u.live)||!cleanAbsolute(u.aside)||
     livePaths.has(u.live)||asidePaths.has(u.aside)||anchors.has(u.live)||path.dirname(u.aside)!==base.aside||
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
  }else if(!livePaths.has(live)&&!anchors.has(live))
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
 refuseSocketReplacement(stageDir);
 rmSync(stageDir,{recursive:true,force:true});
}
