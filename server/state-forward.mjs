// Reading what Home Hub 1.x wrote (AGENTS.md → Versioning: migrations are forward-only).
//
// In 2.0 a "machine" became a "device" in every stored format. Each store reads its own 1.x form once, writes the
// 2.0 form in its place (a whole file under a temporary name, then a rename: at every instant one complete file
// exists) and from then on sees only the new one. The 1.x names live here and nowhere else in the code, so a search
// for them finds this file: V1 maps a 2.0 key to the key 1.x used for it.
//
// One exception: the router observation's 1.x names (`devices`, `unifiDevices`) are in server/router-data.mjs
// (forwardObservation), so that the plugin API, which a host agent carries, needs no more files than it did.
//
// None of this is an alias: a request, a site file or a command that still uses a 1.x name is refused. It is only
// for files a 1.x hub (or its collectors and installers) wrote by itself.
import {writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {readFile,writeFile,rename,stat,utimes,open,rm} from 'node:fs/promises';
import path from 'node:path';

export const V1=Object.freeze({
 device:'machine',devices:'machines',deviceCreatedAt:'machineCreatedAt',clientDevice:'clientMachine',extraDevices:'extraMachines',
});
/** The command-line flags 1.x had under another name (scripts/manage-access.mjs, import-runtime-history, install-host-agent). */
export const V1_FLAGS=Object.freeze({'--machine':'--device'});
/** "--machine was renamed to --device in 2.0" for the first 1.x flag in argv (also as --machine=x), else null. */
export function renamedFlag(argv){
 for(const a of argv){const flag=String(a).split('=')[0];if(Object.hasOwn(V1_FLAGS,flag))return `${flag} was renamed to ${V1_FLAGS[flag]} in 2.0`;}
 return null;
}
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const OLD=new Map(Object.entries(V1).map(([now,old])=>[old,now]));
/** The 2.0 name of a key 1.x used ("machine" → "device"), or null: for a refusal that names the new one. */
export const renamedKey=old=>OLD.get(old)??null;

/** Has this object a key 1.x used for one of `names` (2.0 names), and not the 2.0 key? */
export const hasV1=(o,...names)=>plain(o)&&names.some(n=>Object.hasOwn(o,V1[n])&&!Object.hasOwn(o,n));
/** A copy with the 1.x keys of `names` (2.0 names) renamed, in place in the key order; the object itself when it has none. */
export function forwardKeys(o,...names){
 if(!hasV1(o,...names))return o;
 const want=new Set(names),out={};
 for(const [k,v] of Object.entries(o)){const now=OLD.get(k);if(now&&want.has(now)){if(!Object.hasOwn(o,now))out[now]=v;}else out[k]=v;}
 return out;
}
/** "machine-removed" → "device-removed", "machine mini" → "device mini": the stored words 1.x wrote as values. */
export const forwardWord=v=>typeof v==='string'&&(v.startsWith(V1.device+'-')||v.startsWith(V1.device+' '))?'device'+v.slice(V1.device.length):v;
/**
 * The Czech sentences (the UI's source language) 1.x stored in the findings of ssh-keys.json, in a template and in
 * its rendered text, as 2.0 says them: 1.x called a device "stroj", 2.0 "zařízení". A template is a key of today's
 * dictionary, so the old wording would not be found there.
 */
export const V1_TEXT=Object.freeze([
 ['je root na cílovém stroji.','je root na cílovém zařízení.'],
 ['není na žádném z prověřených strojů (jiné zařízení nebo zapomenutý klíč).','není na žádném z prověřených zařízení (neprověřené zařízení nebo zapomenutý klíč).'],
 ['Privátní část není na žádném z prověřených strojů.','Privátní část není na žádném z prověřených zařízení.'],
 ['kteří na stroji nejsou.','kteří na zařízení nejsou.'],
]);
/** A stored text (a finding's title or detail) in 2.0's wording. */
export const forwardText=v=>typeof v==='string'?V1_TEXT.reduce((s,[old,now])=>s.replaceAll(old,now),v):v;
/** A stored text template: its placeholder ("{machine}: …" → "{device}: …") and its wording (forwardText). */
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
 * A JSON-lines file moved forward: forwardLine(object) → the 2.0 object (the same object when nothing changes).
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
/** A trend line of the systems collector or of the agents: {at, machines: {…}} → {at, devices: {…}}. */
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
/** The descriptor directory, data/devices (1.x: data/machines), or DEVICES_DIR. */
export const devicesDirectory=(directory,env=process.env)=>env.DEVICES_DIR||forwardDirectory(directory,'devices',V1.devices);
