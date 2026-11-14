// The readers' answers for the fixture site, from the collector files in tests/fixtures/readers/ (written by the
// collectors of 1.4: no probedAt, no probes.json): GET /api/systems, /api/security, /api/runtimes/endpoints,
// /api/models and the runtimes of GET /api/home. tests/fixtures/readers/golden.json holds them as the hub answered
// before the push agent's readers existed; with no agent state the hub must still answer exactly that
// (tests/systems.test.mjs). Times that move with the clock (generatedAt, ageSeconds) are replaced by a mark.
import {mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hub} from '../hub-helper.mjs';

export const READERS_DIR=fileURLToPath(new URL('../fixtures/readers/',import.meta.url));
const MOVING=new Set(['generatedAt','ageSeconds']);
export const steady=v=>Array.isArray(v)?v.map(steady):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,MOVING.has(k)?'<moving>':steady(x)])):v;

// A hub on a temp dir with the fixture collector files; extra: more hub() options.
export async function readerHub(t,extra={}){
 const h=await hub(t,{...extra,softwareWatchFile:path.join(READERS_DIR,'watch.json')});
 await mkdir(path.join(h.dir,'systems'),{recursive:true});await mkdir(path.join(h.dir,'security'),{recursive:true});
 for(const [from,to] of [['snapshot.json','systems/snapshot.json'],['upstream.json','systems/upstream.json'],['ssh-keys.json','security/ssh-keys.json']])
  await copyFile(path.join(READERS_DIR,from),path.join(h.dir,to));
 return h;
}
// The answers, each {status, body}, with moving times marked.
export async function readerAnswers(h){
 const get=async url=>{const r=await fetch(h.origin+url,{headers:h.admin});return {status:r.status,body:steady(await r.json())};};
 const home=await get('/api/home');
 return {systems:await get('/api/systems'),security:await get('/api/security'),endpoints:await get('/api/runtimes/endpoints'),models:await get('/api/models'),
  homeRuntimes:{status:home.status,body:(home.body.machines||[]).map(m=>({id:m.id,runtimes:m.runtimes??null,work:m.work??null}))}};
}
