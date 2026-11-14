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
import {readFile,writeFile,rename,stat,utimes} from 'node:fs/promises';
import path from 'node:path';

export const V1=Object.freeze({
 device:'machine',devices:'machines',deviceCreatedAt:'machineCreatedAt',clientDevice:'clientMachine',extraDevices:'extraMachines',
});
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const OLD=new Map(Object.entries(V1).map(([now,old])=>[old,now]));

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
/** The same, async. keepTimes: the file keeps its modification time (a collector's file, whose age the hub reads from it). */
export async function writeJson(file,doc,{mode=0o600,pretty=false,keepTimes=false}={}){
 const tmp=`${file}.${process.pid}.forward.tmp`,was=keepTimes?await stat(file).catch(()=>null):null;
 await writeFile(tmp,pretty===false?JSON.stringify(doc):JSON.stringify(doc,null,pretty)+'\n',{mode});
 if(was)await utimes(tmp,was.atime,was.mtime).catch(()=>{});
 await rename(tmp,file);
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
