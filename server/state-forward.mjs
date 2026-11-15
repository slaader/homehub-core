// Compatibility readers for legacy stored fields. Writes use current fields atomically.
import {writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {readFile,writeFile,rename,stat,utimes,open,rm} from 'node:fs/promises';
import path from 'node:path';

// Legacy field names.
export const V1=Object.freeze({
 device:'machine',devices:'machines',deviceCreatedAt:'machineCreatedAt',clientDevice:'clientMachine',extraDevices:'extraMachines',
});
/** Legacy command-line flags (scripts/manage-access.mjs, import-runtime-history, install-host-agent). */
export const V1_FLAGS=Object.freeze({['--'+V1.device]:'--device'});
/** Compatibility mapping for legacy stored values. */
export function renamedFlag(argv){
 for(const a of argv){const flag=String(a).split('=')[0];if(Object.hasOwn(V1_FLAGS,flag))return `unsupported option; use ${V1_FLAGS[flag]}`;}
 return null;
}
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const OLD=new Map(Object.entries(V1).map(([now,old])=>[old,now]));
/** Compatibility mapping for legacy stored values. */
export const renamedKey=old=>OLD.get(old)??null;

/** Does this object contain a legacy key for one of `names` (current names) without its current counterpart? */
export const hasV1=(o,...names)=>plain(o)&&names.some(n=>Object.hasOwn(o,V1[n])&&!Object.hasOwn(o,n));
/** A copy with the legacy keys of `names` (current names) renamed, in place in the key order; the object itself when it has none. */
export function forwardKeys(o,...names){
 if(!hasV1(o,...names))return o;
 const want=new Set(names),out={};
 for(const [k,v] of Object.entries(o)){const now=OLD.get(k);if(now&&want.has(now)){if(!Object.hasOwn(o,now))out[now]=v;}else out[k]=v;}
 return out;
}
/** Compatibility mapping for legacy stored values. */
export const forwardWord=v=>typeof v==='string'&&(v.startsWith(V1.device+'-')||v.startsWith(V1.device+' '))?'device'+v.slice(V1.device.length):v;
/**
 * The Czech sentences (the UI's source language) legacy stored in the findings of ssh-keys.json, in a template and in
 * its rendered text, using current wording. A template is a key of today's
 * dictionary, so the old wording would not be found there.
 */
export const V1_TEXT=Object.freeze([
 ['je root na cílovém stroji.','je root na cílovém zařízení.'],
 ['není na žádném z prověřených strojů (jiné zařízení nebo zapomenutý klíč).','není na žádném z prověřených zařízení (neprověřené zařízení nebo zapomenutý klíč).'],
 ['Privátní část není na žádném z prověřených strojů.','Privátní část není na žádném z prověřených zařízení.'],
 ['kteří na stroji nejsou.','kteří na zařízení nejsou.'],
]);
/** A stored finding title or detail using current wording. */
export const forwardText=v=>typeof v==='string'?V1_TEXT.reduce((s,[old,now])=>s.replaceAll(old,now),v):v;
/** Compatibility mapping for legacy stored values. */
export const forwardTemplate=key=>typeof key==='string'?forwardText(key.replaceAll(`{${V1.device}}`,'{device}')):key;

/** Writes one JSON file whole: a temporary name beside it, then a rename. */
export function writeJsonSync(file,doc,{mode=0o600,pretty=false}={}){
 mkdirSync(path.dirname(file),{recursive:true});
 const tmp=`${file}.${process.pid}.forward.tmp`;
 writeFileSync(tmp,pretty===false?JSON.stringify(doc):JSON.stringify(doc,null,pretty)+'\n',{mode});renameSync(tmp,file);
}
/**
 * A JSON file parsed, with what the file was when it was read (seen: inode, size, modification time), for
 * writeJson's `seen`. Rejects as readFile and JSON.parse do.
 */
export async function readJsonSeen(file){
 const handle=await open(file,'r');
 try{const s=await handle.stat();return {doc:JSON.parse(await handle.readFile('utf8')),seen:{ino:s.ino,size:s.size,mtimeMs:s.mtimeMs}};}
 finally{await handle.close();}
}
const sameFile=(s,seen)=>Boolean(s)&&s.ino===seen.ino&&s.size===seen.size&&s.mtimeMs===seen.mtimeMs;
/**
 * The same, async. → true when written. keepTimes: the file keeps its modification time (a collector's file, whose
 * age the hub reads from it). seen (from readJsonSeen): the file is replaced only while it is still the one that was
 * read; when another writer (a collector's run) replaced or changed it meanwhile, nothing is written and → false,
 * so a newer file is never overwritten with an older one moved forward. The check is made just before the rename.
 */
export async function writeJson(file,doc,{mode=0o600,pretty=false,keepTimes=false,seen=null}={}){
 const tmp=`${file}.${process.pid}.forward.tmp`,was=keepTimes?await stat(file).catch(()=>null):null;
 await writeFile(tmp,pretty===false?JSON.stringify(doc):JSON.stringify(doc,null,pretty)+'\n',{mode});
 if(was)await utimes(tmp,was.atime,was.mtime).catch(()=>{});
 if(seen&&!sameFile(await stat(file).catch(()=>null),seen)){await rm(tmp,{force:true});return false;}
 await rename(tmp,file);
 return true;
}
/**
 * A JSON-lines file moved forward: forwardLine(object) → the current object (the same object when nothing changes).
 * Rewritten whole, once, only when a line changed; a line that is not JSON is kept as it is. → lines changed.
 * A file that is not there, or cannot be written (a read-only data directory), is left alone: the readers
 * forward each line they read as well, so nothing is lost by waiting for the next start.
 */
export async function forwardJsonl(file,forwardLine,{mode=0o600}={}){
 let text;try{text=await readFile(file,'utf8');}catch{return 0;}
 let changed=0;
 const lines=text.split('\n').map(line=>{if(!line)return line;let x;try{x=JSON.parse(line);}catch{return line;}const y=forwardLine(x);if(y===x)return line;changed++;return JSON.stringify(y);});
 if(!changed)return 0;
 try{const tmp=`${file}.${process.pid}.forward.tmp`;await writeFile(tmp,lines.join('\n'),{mode});await rename(tmp,file);}catch{return 0;}
 return changed;
}
/** Compatibility mapping for legacy stored values. */
export const forwardTrendLine=x=>forwardKeys(x,'devices');
/**
 * A directory that changed its name: moved once, while the new name is free. → the directory to read (the old
 * one when it could not be moved, so nothing disappears from a data directory this process may not write).
 */
export function forwardDirectory(parent,name,oldName){
 const dir=path.join(parent,name),old=path.join(parent,oldName);
 if(existsSync(dir)||!existsSync(old))return dir;
 try{renameSync(old,dir);return dir;}catch{return old;}
}
/** Compatibility mapping for legacy stored values. */
export const devicesDirectory=(directory,env=process.env)=>env.DEVICES_DIR||forwardDirectory(directory,'devices',V1.devices);
