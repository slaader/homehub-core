import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeTicketVector} from './ticket-embeddings.mjs';
import {ticketFilter} from './tickets-store.mjs';
export const TICKET_SEARCH_SCHEMA=1;
const hash=text=>createHash('sha256').update(text).digest('hex');
const bounded=(value,fallback,min,max)=>{value??=fallback;if(!Number.isInteger(value)||value<min||value>max)throw new Error('Invalid ticket search bound');return value;};
const lexicalText=d=>[d.text,d.ticket,d.project,d.attachment,d.name,d.type,d.by,d.at,d.createdAt,d.size,d.sha256,...Object.values(d.fields??{}).flat()].filter(v=>v!==undefined&&v!==null).join(' ');

export function createTicketSearchIndex(directory,options={}) {
 const {embed,modelFingerprint=embed?.modelFingerprint??'default',minScore=.5}=options;
 if(embed!==undefined&&typeof embed!=='function')throw new Error('Invalid embedding function');
 if(typeof modelFingerprint!=='string'||!modelFingerprint||modelFingerprint.length>1024||!Number.isFinite(minScore)||minScore<0||minScore>1)throw new Error('Invalid ticket search configuration');
 const batchSize=bounded(options.batchSize,8,1,64),maxVectors=bounded(options.maxVectors,20000,1,1000000),maxQueryCache=bounded(options.maxQueryCache,128,0,10000),maxRetries=bounded(options.maxRetries,2,0,5),retryMs=bounded(options.retryMs,100,1,60000),recoveryMs=bounded(options.recoveryMs,60000,1,3600000),maxDocuments=bounded(options.maxDocuments,200000,1,1000000),maxTextChars=bounded(options.maxTextChars,32768,1,1048576);
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite');
 mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 const file=path.join(directory,'ticket-search.db'),db=new DatabaseSync(file);
 try{
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>TICKET_SEARCH_SCHEMA)throw new Error('Ticket search cache is newer than this code');
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
   CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, hash TEXT NOT NULL, doc TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS lexical USING fts5(id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
   CREATE TABLE IF NOT EXISTS vectors(model TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(model,hash));
   CREATE TABLE IF NOT EXISTS dimensions(model TEXT PRIMARY KEY, size INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cache_info(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
   PRAGMA user_version=1;`);chmodSync(file,0o600);
 }catch(e){db.close();throw e;}
 let closed=false,revision=null,running=null,timer=null,recoveryTimer=null,generation=0,controller=null,lastError=null;
 let clock=Math.max(Date.now(),db.prepare('SELECT max(used) used FROM vectors').get().used??0);
 const persisted=db.prepare('SELECT rowid,id,hash,doc FROM documents').all(),serialized=new Map(persisted.map(r=>[r.id,r.doc])),rowids=new Map(persisted.map(r=>[r.id,r.rowid]));
 let docs=new Map(persisted.map(r=>[r.id,{...JSON.parse(r.doc),hash:r.hash}]));
 const failures=new Map(),queryCache=new Map(),queryPromises=new Map();
 const assertOpen=()=>{if(closed)throw new Error('Ticket search index is closed');};
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
 // Link the FTS rowid to its document so incremental updates do not scan the complete index.
 if(db.prepare("SELECT value FROM cache_info WHERE key='lexical'").get()?.value!==1)tx(()=>{
  db.exec('DELETE FROM lexical');const put=db.prepare('INSERT INTO lexical(rowid,id,text) VALUES(?,?,?)');
  for(const r of persisted)put.run(r.rowid,r.id,lexicalText(docs.get(r.id)));
  db.prepare("INSERT OR REPLACE INTO cache_info VALUES('lexical',1)").run();
 });
 let allowed=new Set([...new Set([...docs.values()].map(d=>d.hash))].slice(0,maxVectors));
 const allowedHashes=()=>allowed;
 const vectorCache=new Map(),missingVectors=new Set();
 const readVector=db.prepare('SELECT vector FROM vectors WHERE model=? AND hash=?');
 const cached=h=>{
  if(!allowed.has(h)||missingVectors.has(h))return null;if(vectorCache.has(h))return vectorCache.get(h);
  const r=readVector.get(modelFingerprint,h);if(!r){missingVectors.add(h);return null;}
  try{const v=Float32Array.from(normalizeTicketVector(JSON.parse(r.vector)));vectorCache.set(h,v);return v;}
  catch{db.prepare('DELETE FROM vectors WHERE model=? AND hash=?').run(modelFingerprint,h);missingVectors.add(h);return null;}
 };
 function validateVectors(vectors,count){
  if(!Array.isArray(vectors)||vectors.length!==count)throw new Error('Invalid embedding batch');
  const normalized=vectors.map(normalizeTicketVector),size=normalized[0]?.length;
  const prior=db.prepare('SELECT size FROM dimensions WHERE model=?').get(modelFingerprint)?.size;
  if(normalized.some(v=>v.length!==size)||(prior&&size!==prior))throw new Error('Embedding dimension changed');
  db.prepare('INSERT OR IGNORE INTO dimensions VALUES(?,?)').run(modelFingerprint,size);
  return normalized;
 }
 function prune(){
  const count=db.prepare('SELECT count(*) n FROM vectors').get().n;if(count<=maxVectors)return;
  const entries=db.prepare('SELECT model,hash,used FROM vectors').all();
  entries.sort((a,b)=>Number(b.model===modelFingerprint&&allowed.has(b.hash))-Number(a.model===modelFingerprint&&allowed.has(a.hash))||b.used-a.used);
  const del=db.prepare('DELETE FROM vectors WHERE model=? AND hash=?');
  // Active hashes fit within the capacity and sort first. Evicted hashes are not eligible in RAM.
  for(const r of entries.slice(maxVectors))del.run(r.model,r.hash);
 }
 function status(){
  assertOpen();let embedded=0,failed=0;
  for(const d of docs.values()){if(embed&&cached(d.hash))embedded++;else if(!allowedHashes().has(d.hash)||failures.get(d.hash)?.attempts>maxRetries)failed++;}
  const pending=embed?docs.size-embedded-failed:0;
  return {state:!embed?'disabled':pending?'indexing':failed?'degraded':'ready',readiness:!embed?'disabled':pending?'indexing':failed?'degraded':'ready',chunks:docs.size,embedded,pending,failed,model:embed?modelFingerprint:null,revision,coverage:{chunks:docs.size,embedded,pending,failed,ratio:docs.size?embedded/docs.size:1},errors:lastError?[lastError]:[]};
 }
 function schedule(delay=0){if(closed||!embed||timer||running)return;timer=setTimeout(()=>{timer=null;running=work().catch(()=>{lastError='Embedding cache unavailable';}).finally(()=>{running=null;if(!closed){if(needsWork())schedule(nextDelay());scheduleRecovery();}});},delay);}
 function scheduleRecovery(){
  clearTimeout(recoveryTimer);recoveryTimer=null;let next=Infinity;
  for(const f of failures.values())if(f.attempts>maxRetries)next=Math.min(next,f.recoverAt);
  if(!Number.isFinite(next)||closed)return;
  recoveryTimer=setTimeout(()=>{recoveryTimer=null;for(const[h,f]of failures)if(f.recoverAt<=Date.now())failures.delete(h);schedule();},Math.max(0,next-Date.now()));recoveryTimer.unref?.();
 }
 function retryFailed(){assertOpen();failures.clear();lastError=null;clearTimeout(recoveryTimer);recoveryTimer=null;schedule();return status();}
 function needsWork(){return [...docs.values()].some(d=>allowedHashes().has(d.hash)&&!cached(d.hash)&&(failures.get(d.hash)?.attempts??0)<=maxRetries);}
 function nextDelay(){let next=Infinity;for(const d of docs.values())if(allowedHashes().has(d.hash)&&!cached(d.hash)){const f=failures.get(d.hash);if((f?.attempts??0)<=maxRetries)next=Math.min(next,f?.next??0);}return Math.max(0,next-Date.now());}
 async function work(){
  const seen=new Set(),batch=[];for(const d of docs.values())if(allowedHashes().has(d.hash)&&!cached(d.hash)&&!seen.has(d.hash)){const f=failures.get(d.hash);if((f?.attempts??0)<=maxRetries&&(!f||f.next<=Date.now())){batch.push(d);seen.add(d.hash);if(batch.length===batchSize||batch.reduce((n,item)=>n+item.text.length,0)+maxTextChars>65536)break;}}
  if(!batch.length)return;
  controller=new AbortController();
  try{
   const vectors=await embed(batch.map(d=>d.text),{signal:controller.signal});if(closed)return;
   const normalized=validateVectors(vectors,batch.length);
   const accepted=[];
   tx(()=>{batch.forEach((d,i)=>{if(!allowed.has(d.hash))return;db.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?)').run(modelFingerprint,d.hash,JSON.stringify(normalized[i]),++clock);accepted.push({hash:d.hash,vector:normalized[i]});});prune();});
   // Publish vectors to readers only after the entire persisted batch committed.
   for(const r of accepted){vectorCache.set(r.hash,Float32Array.from(r.vector));missingVectors.delete(r.hash);failures.delete(r.hash);}lastError=null;
  }catch{if(!closed){lastError='Embedding batch failed';for(const d of batch){if(!allowed.has(d.hash))continue;const attempts=(failures.get(d.hash)?.attempts??0)+1;failures.set(d.hash,{attempts,next:Date.now()+retryMs*2**(attempts-1),recoverAt:Date.now()+recoveryMs});}}}
  finally{controller=null;}
 }
 function sync(documents,{revision:rev,replaceTickets}={}){
  assertOpen();if(!Array.isArray(documents)||documents.length>maxDocuments)throw new Error('Too many ticket search documents');
  if(replaceTickets!==undefined&&(!Array.isArray(replaceTickets)||replaceTickets.some(id=>typeof id!=='string')))throw new Error('Invalid ticket replacement');
  const replaced=replaceTickets?new Set(replaceTickets):null,next=replaced?new Map([...docs].filter(([,d])=>!replaced.has(d.ticket))):new Map(),incoming=new Set();
  for(const input of documents){
   if(!input||!['ticket','attachment'].includes(input.source)||['id','ticket','project'].some(k=>typeof input[k]!=='string'||!input[k]||input[k].length>512)||typeof input.text!=='string'||input.text.length>maxTextChars||incoming.has(input.id)||replaced&&!replaced.has(input.ticket))throw new Error('Invalid ticket search document');
   incoming.add(input.id);
   const d=JSON.parse(JSON.stringify(input));d.hash=hash(d.text);next.set(d.id,d);
  }
  if(next.size>maxDocuments)throw Object.assign(new Error('Ticket search document capacity reached'),{code:'capacity'});
  const changes=[];for(const d of next.values()){const json=JSON.stringify(d);if(serialized.get(d.id)!==json)changes.push({d,json});}
  const removed=[...docs.keys()].filter(id=>!next.has(id));
  tx(()=>{
   const put=db.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,doc=excluded.doc'),fts=db.prepare('INSERT INTO lexical(rowid,id,text) VALUES(?,?,?)');
   for(const id of removed){db.prepare('DELETE FROM lexical WHERE rowid=?').run(rowids.get(id));db.prepare('DELETE FROM documents WHERE id=?').run(id);}
   for(const{d,json}of changes){put.run(d.id,d.hash,json);const rowid=db.prepare('SELECT rowid FROM documents WHERE id=?').get(d.id).rowid;db.prepare('DELETE FROM lexical WHERE rowid=?').run(rowid);fts.run(rowid,d.id,lexicalText(d));}
  });
  for(const id of removed){serialized.delete(id);rowids.delete(id);}
  for(const{d,json}of changes){serialized.set(d.id,json);rowids.set(d.id,db.prepare('SELECT rowid FROM documents WHERE id=?').get(d.id).rowid);}
  if(changes.length||removed.length)generation++;
  docs=next;allowed=new Set([...new Set([...docs.values()].map(d=>d.hash))].slice(0,maxVectors));
  for(const h of vectorCache.keys())if(!allowed.has(h))vectorCache.delete(h);for(const h of missingVectors)if(!allowed.has(h))missingVectors.delete(h);revision=rev??null;
  const hashes=new Set([...docs.values()].map(d=>d.hash));for(const h of failures.keys())if(!hashes.has(h))failures.delete(h);
  prune();schedule();return status();
 }
 async function queryVector(query){
  const key=hash(query);if(queryCache.has(key))return queryCache.get(key);if(queryPromises.has(key))return queryPromises.get(key);
  if(queryPromises.size>=128)throw new Error('Too many pending ticket queries');
  const ctl=new AbortController();queryControllers.add(ctl);
  const promise=Promise.resolve().then(async()=>{try{
   const raw=await embed([query],{query:true,signal:ctl.signal});if(closed)throw new Error('Closed');
   const vector=validateVectors(raw,1)[0];
   if(maxQueryCache){queryCache.set(key,vector);while(queryCache.size>maxQueryCache)queryCache.delete(queryCache.keys().next().value);}return vector;
  }finally{queryControllers.delete(ctl);queryPromises.delete(key);}});
  queryPromises.set(key,promise);return promise;
 }
 async function search({query,project,status:filterStatus,type,priority,release,assignee,label,limit=20,mode='hybrid',minScore:cutoff=minScore}={}){
  assertOpen();if(typeof query!=='string'||!query.trim()||query.length>4096||!['hybrid','text','semantic'].includes(mode)||!Number.isInteger(limit)||limit<1||limit>100||!Number.isFinite(cutoff)||cutoff<0||cutoff>1)throw new Error('Invalid ticket search query');
  const initial=status(),gen=generation;
  const {match}=ticketFilter({project,status:filterStatus,type,priority,release,assignee,label});
  const eligible=new Map([...docs].filter(([,d])=>match({...d.fields,project:d.project,labels:d.fields?.labels??[]})));
  const terms=query.normalize('NFC').match(/[\p{L}\p{N}_]+/gu)?.slice(0,12)??[];
  const lexical=mode==='semantic'||!terms.length?[]:db.prepare('SELECT id,bm25(lexical) rank FROM lexical WHERE lexical MATCH ? ORDER BY rank').all(terms.map(t=>'"'+t+'"*').join(' ')).filter(r=>eligible.has(r.id));
  const ready=embed&&[...eligible.values()].every(d=>cached(d.hash));
  if(mode==='semantic'&&(!embed||!ready))return {query,requestedMode:mode,mode,state:!embed?'disabled':initial.failed?'degraded':'indexing',semanticState:initial.state,coverage:initial.coverage,results:[]};
  let semantic=[],queryFailed=false;
  if(mode!=='text'&&ready&&eligible.size){
   try{
    const vector=await queryVector(query);if(closed)throw new Error('Closed');
    for(const d of eligible.values()){const v=cached(d.hash);if(v&&v.length===vector.length){let cosine=0;for(let i=0;i<v.length;i++)cosine+=v[i]*vector[i];if(cosine>=cutoff)semantic.push({id:d.id,cosine});}}
    semantic.sort((a,b)=>b.cosine-a.cosine);
   }catch{queryFailed=true;}
  }
  if(closed||gen!==generation)return {query,requestedMode:mode,mode,state:closed?'closed':'indexing',coverage:initial.coverage,results:[]};
  const ranked=new Map();lexical.forEach((r,i)=>ranked.set(r.id,{score:1/(60+i+1),matchKind:'text'}));
  semantic.forEach((r,i)=>{const old=ranked.get(r.id);ranked.set(r.id,{score:(old?.score??0)+1/(60+i+1),cosine:r.cosine,matchKind:old?'hybrid':'semantic'});});
  const groups=new Set(),results=[];
  for(const [id,rank] of [...ranked].sort((a,b)=>b[1].score-a[1].score||a[0].localeCompare(b[0]))){const d=eligible.get(id),group=JSON.stringify([d.ticket,d.source,d.attachment??null]);if(groups.has(group))continue;groups.add(group);const {text,hash:unused,fields,...citation}=d;const position=terms.map(t=>text.toLowerCase().indexOf(t.toLowerCase())).filter(n=>n>=0).sort((a,b)=>a-b)[0]??0;const start=Math.max(0,Array.from(text.slice(0,position)).length-100);results.push({...citation,snippet:Array.from(text).slice(start,start+600).join(''),...rank});if(results.length===limit)break;}
  return {query,requestedMode:mode,mode:mode==='hybrid'&&(!ready||queryFailed)?'text':mode,state:queryFailed?'degraded':'ready',semanticState:queryFailed?'degraded':initial.state,coverage:initial.coverage,results};
 }
 const queryControllers=new Set();
 async function whenIdle(){assertOpen();while(timer||running){await new Promise(resolve=>setTimeout(resolve,5));assertOpen();}return status();}
 async function close(){if(closed)return;closed=true;generation++;clearTimeout(timer);clearTimeout(recoveryTimer);timer=null;controller?.abort();for(const ctl of queryControllers)ctl.abort();/* Providers must honor signal; late continuations are guarded. */db.close();}
 prune();
 // A service may require canonical reconciliation before any persisted text leaves the cache.
 if(embed&&options.autoStart!==false)schedule();
 return {sync,search,status,close,whenIdle,retryFailed};
}
