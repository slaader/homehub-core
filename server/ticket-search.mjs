// Unified Ticket Search: administrator semantic opt-in (hub.db → platform-search),
// canonical Ticket & UTF-8 attachment extraction, bounded LRU text cache, incremental
// SQLite FTS5 + vector cache (state/tickets/search/ticket-search.db), single-pass
// validation, unified background runner, and global search merging.
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {createTicketEmbedder,normalizeTicketVector} from './ticket-embeddings.mjs';
import {ticketFilter} from './tickets-store.mjs';

export const TICKET_SEARCH_SCHEMA=1;
export const PLATFORM_SEARCH_SCHEMA=1;

const SEARCH_MODES=Object.freeze(['text','hybrid','semantic']);
const SEARCH_KEYS=Object.freeze(['query','project','status','type','priority','release','assignee','label','limit','mode','minScore']);
const SEARCH_ALL_KEYS=Object.freeze(['q','kind','project','limit','mode']);
const QUERY_WORD=/[\p{L}\p{N}_]/u;
const QUERY_TERMS=/[\p{L}\p{N}_]+/gu;

const sha256=text=>createHash('sha256').update(text).digest('hex');
const plain=x=>Boolean(x)&&typeof x==='object'&&!Array.isArray(x);
const blankExtraction=()=>({attachments:0,indexed:0,unsupported:0,oversize:0,invalid:0,missing:0,capacity:0,metadataCapacity:0,ticketCapacity:0});
const chunkCount=text=>{const n=Array.from(text).length;return n?Math.max(1,Math.ceil((n-100)/700)):0;};
const lexicalText=d=>[d.text,d.ticket,d.project,d.attachment,d.name,d.type,d.by,d.at,d.createdAt,d.size,d.sha256,...Object.values(d.fields??{}).flat()].filter(v=>v!==undefined&&v!==null).join(' ');

function bounded(value,fallback,min,max,message='Invalid ticket search bound'){
 const v=value??fallback;
 if(!Number.isInteger(v)||v<min||v>max)throw new Error(message);
 return v;
}

function raceAbort(promise,signal){
 if(signal.aborted){promise.catch(()=>{});return Promise.reject(new Error('Aborted'));}
 return new Promise((resolve,reject)=>{
  const onAbort=()=>reject(new Error('Aborted'));
  signal.addEventListener('abort',onAbort,{once:true});
  promise.then(
   value=>{signal.removeEventListener('abort',onAbort);resolve(value);},
   err=>{signal.removeEventListener('abort',onAbort);reject(err);}
  );
 });
}

export function ticketSearchSettings(env=process.env){
 const url=env.HOME_HUB_TICKET_EMBEDDING_URL,model=env.HOME_HUB_TICKET_EMBEDDING_MODEL;
 if(Boolean(url)!==Boolean(model))throw new Error('Invalid ticket embedding configuration');
 const minScore=env.HOME_HUB_TICKET_SEARCH_MIN_SCORE===undefined?0.5:Number(env.HOME_HUB_TICKET_SEARCH_MIN_SCORE);
 if(!Number.isFinite(minScore)||minScore<0||minScore>1)throw new Error('Invalid ticket search minimum score');
 return {
  url,
  model,
  token:env.HOME_HUB_TICKET_EMBEDDING_TOKEN,
  queryPrefix:env.HOME_HUB_TICKET_EMBEDDING_QUERY_PREFIX,
  minScore,
  modelFingerprint:createHash('sha256').update(JSON.stringify([url,model,env.HOME_HUB_TICKET_EMBEDDING_REVISION,env.HOME_HUB_TICKET_EMBEDDING_QUERY_PREFIX])).digest('hex'),
 };
}

export function textChunks(text,size=800,overlap=100){
 if(typeof text!=='string'||!Number.isInteger(size)||!Number.isInteger(overlap)||size<1||overlap<0||overlap>=size)throw new Error('Invalid text chunk bounds');
 const chars=Array.from(text),out=[];
 for(let i=0;i<chars.length;i+=size-overlap){
  out.push(chars.slice(i,i+size).join(''));
  if(i+size>=chars.length)break;
 }
 return out;
}

function openCacheDb(directory){
 const {DatabaseSync}=process.getBuiltinModule('node:sqlite');
 const searchDir=path.join(directory,'search');
 mkdirSync(searchDir,{recursive:true,mode:0o700});
 chmodSync(searchDir,0o700);
 const file=path.join(searchDir,'ticket-search.db'),db=new DatabaseSync(file);
 try{
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>TICKET_SEARCH_SCHEMA)throw new Error('Ticket search cache is newer than this code');
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
   CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, hash TEXT NOT NULL, doc TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS lexical USING fts5(id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
   CREATE TABLE IF NOT EXISTS vectors(model TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(model,hash));
   CREATE TABLE IF NOT EXISTS dimensions(model TEXT PRIMARY KEY, size INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cache_info(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
   PRAGMA user_version=1;`);
  chmodSync(file,0o600);
  return db;
 }catch(e){
  db.close();
  throw e;
 }
}

function validateSearchInput(input,defaultMinScore){
 if(!plain(input)||Object.keys(input).some(k=>!SEARCH_KEYS.includes(k)))throw new Error('invalid');
 const {query,mode='text',minScore,...raw}=input;
 if(typeof query!=='string'||query.length>200||!QUERY_WORD.test(query)||!SEARCH_MODES.includes(mode))throw new Error('invalid');
 const cutoff=minScore===undefined?defaultMinScore:minScore;
 if(typeof cutoff!=='number'||!Number.isFinite(cutoff)||cutoff<0||cutoff>1)throw new Error('invalid');
 const {f,match}=ticketFilter(raw);
 const limit=f.limit===undefined?20:Number(f.limit);
 if(f.limit!==undefined&&(!/^\d+$/.test(String(f.limit))||!Number.isInteger(limit)||limit<1||limit>100))throw new Error('invalid');
 return {query,mode,cutoff,limit,match};
}

export function createTicketSearch(directory,{db,tickets,ticketFiles,env=process.env,embed,...options}={}){
 const envSettings=ticketSearchSettings(env);
 const configuredSettings={...envSettings,...options};
 if(embed!==undefined&&typeof embed!=='function')throw new Error('Invalid embedding function');
 const configured=Boolean(embed||configuredSettings.url);
 // Validate provider configuration synchronously before any preference is persisted. Construction sends no requests.
 const provider=embed??(configuredSettings.url?createTicketEmbedder(configuredSettings):undefined);
 const modelFingerprint=options.modelFingerprint??envSettings.modelFingerprint??provider?.modelFingerprint??'default';
 const minScore=configuredSettings.minScore;
 if(typeof modelFingerprint!=='string'||!modelFingerprint||modelFingerprint.length>1024||!Number.isFinite(minScore)||minScore<0||minScore>1){
  throw new Error('Invalid ticket search configuration');
 }

 const maxDocuments=bounded(options.maxDocuments,200000,1,1000000,'Invalid ticket extraction bound');
 const maxTextChars=bounded(options.maxTextChars,32768,1,1048576);
 const maxCacheBytes=bounded(options.maxExtractionBytes,16*1024*1024,0,256*1024*1024,'Invalid ticket extraction bound');
 const maxCacheEntries=bounded(options.maxExtractionEntries,4096,0,100000,'Invalid ticket extraction bound');
 const batchSize=bounded(options.batchSize,8,1,64);
 const maxVectors=bounded(options.maxVectors,20000,1,1000000);
 const maxQueryCache=bounded(options.maxQueryCache,128,0,10000);
 const buildRetryMs=bounded(options.buildRetryMs,250,1,60000,'Invalid ticket extraction bound');
 const maxBuildRetries=bounded(options.maxBuildRetries,2,0,5,'Invalid ticket extraction bound');
 const buildRecoveryMs=bounded(options.buildRecoveryMs,60000,1,3600000,'Invalid ticket extraction bound');
 const retryMs=bounded(options.retryMs,100,1,60000);
 const maxRetries=bounded(options.maxRetries,2,0,5);
 const recoveryMs=bounded(options.recoveryMs,60000,1,3600000);

 let memorySettings={schema:PLATFORM_SEARCH_SCHEMA,enabled:false};
 const settingsStore=db
  ?db.collection('platform-search',{
   empty:()=>({schema:PLATFORM_SEARCH_SCHEMA,enabled:false}),
   split:doc=>({meta:doc,colls:{}}),
   join:meta=>meta,
   valid:doc=>doc.schema===PLATFORM_SEARCH_SCHEMA&&typeof doc.enabled==='boolean',
  })
  :{read:async()=>({...memorySettings}),write:async doc=>{memorySettings={...doc};}};

 const cacheDb=openCacheDb(directory);
 const cacheTx=fn=>{
  cacheDb.exec('BEGIN IMMEDIATE');
  try{const value=fn();cacheDb.exec('COMMIT');return value;}
  catch(e){try{cacheDb.exec('ROLLBACK');}catch{}throw e;}
 };

 const st={
  maxUsed:cacheDb.prepare('SELECT max(used) used FROM vectors'),
  allDocs:cacheDb.prepare('SELECT rowid,id,hash,doc FROM documents'),
  lexicalReady:cacheDb.prepare("SELECT value FROM cache_info WHERE key='lexical'"),
  setLexicalReady:cacheDb.prepare("INSERT OR REPLACE INTO cache_info VALUES('lexical',1)"),
  putDoc:cacheDb.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,doc=excluded.doc'),
  delDoc:cacheDb.prepare('DELETE FROM documents WHERE id=?'),
  docRowid:cacheDb.prepare('SELECT rowid FROM documents WHERE id=?'),
  putLexical:cacheDb.prepare('INSERT INTO lexical(rowid,id,text) VALUES(?,?,?)'),
  delLexical:cacheDb.prepare('DELETE FROM lexical WHERE rowid=?'),
  searchLexical:cacheDb.prepare('SELECT id,bm25(lexical) rank FROM lexical WHERE lexical MATCH ? ORDER BY rank'),
  readVector:cacheDb.prepare('SELECT vector FROM vectors WHERE model=? AND hash=?'),
  putVector:cacheDb.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?)'),
  delVector:cacheDb.prepare('DELETE FROM vectors WHERE model=? AND hash=?'),
  countVectors:cacheDb.prepare('SELECT count(*) n FROM vectors'),
  allVectorsMeta:cacheDb.prepare('SELECT model,hash,used FROM vectors'),
  readDim:cacheDb.prepare('SELECT size FROM dimensions WHERE model=?'),
  putDim:cacheDb.prepare('INSERT OR IGNORE INTO dimensions VALUES(?,?)'),
 };

 let clock=Math.max(Date.now(),st.maxUsed.get().used??0);
 const persisted=st.allDocs.all();
 const serialized=new Map(persisted.map(r=>[r.id,r.doc]));
 const rowids=new Map(persisted.map(r=>[r.id,r.rowid]));
 let docs=new Map(persisted.map(r=>[r.id,{...JSON.parse(r.doc),hash:r.hash}]));

 // Link the FTS rowid to its document so incremental updates do not scan the complete index.
 if(st.lexicalReady.get()?.value!==1)cacheTx(()=>{
  cacheDb.exec('DELETE FROM lexical');
  for(const r of persisted)st.putLexical.run(r.rowid,r.id,lexicalText(docs.get(r.id)));
  st.setLexicalReady.run();
 });

 let allowed=new Set([...new Set([...docs.values()].map(d=>d.hash))].slice(0,maxVectors));
 const vectorCache=new Map(),missingVectors=new Set();
 const embedFailures=new Map(),queryCache=new Map(),queryPromises=new Map(),queryControllers=new Set();
 const textCache=new Map(),forceTickets=new Set();

 let enabled=false,started=false,closed=false,ready=null,settingsQueue=Promise.resolve(),closePromise=null;
 let generation=0,semanticGeneration=0,indexedRevision=null;
 let extractDirty=true,extracting=false,extractError=null,extractAttempts=0,extractNextAt=0,extractRecoverAt=0;
 let embedError=null,embedController=null;
 let extractRunning=null,extractTimer=null,extractTimerAt=Infinity;
 let embedRunning=null,embedTimer=null,embedTimerAt=Infinity;
 let recoveryTimer=null,contentTimer=null,unsubscribe=null;
 let entries=new Map(),extraction=blankExtraction(),cachedBytes=0,closedStatus=null;
 let resolveClosed;
 const closedSignal=new Promise(resolve=>{resolveClosed=resolve;});

 const countDocs=entry=>entry.base.length+entry.content.length;
 const hasExtractionCapacity=()=>Boolean(extraction.capacity||extraction.metadataCapacity||extraction.ticketCapacity);

 function cachedVector(h){
  if(!allowed.has(h)||missingVectors.has(h))return null;
  if(vectorCache.has(h))return vectorCache.get(h);
  const row=st.readVector.get(modelFingerprint,h);
  if(!row){missingVectors.add(h);return null;}
  try{
   const v=Float32Array.from(normalizeTicketVector(JSON.parse(row.vector)));
   vectorCache.set(h,v);
   return v;
  }catch{
   st.delVector.run(modelFingerprint,h);
   missingVectors.add(h);
   return null;
  }
 }

 function validateVectors(vectors,count){
  if(!Array.isArray(vectors)||vectors.length!==count)throw new Error('Invalid embedding batch');
  const normalized=vectors.map(normalizeTicketVector),size=normalized[0]?.length;
  const prior=st.readDim.get(modelFingerprint)?.size;
  if(normalized.some(v=>v.length!==size)||(prior&&size!==prior))throw new Error('Embedding dimension changed');
  st.putDim.run(modelFingerprint,size);
  return normalized;
 }

 function pruneVectors(){
  const count=st.countVectors.get().n;
  if(count<=maxVectors)return;
  const rows=st.allVectorsMeta.all();
  rows.sort((a,b)=>Number(b.model===modelFingerprint&&allowed.has(b.hash))-Number(a.model===modelFingerprint&&allowed.has(a.hash))||b.used-a.used);
  // Active hashes fit within capacity and sort first; evicted hashes are not eligible in RAM.
  for(const r of rows.slice(maxVectors))st.delVector.run(r.model,r.hash);
 }

 function computeStatus(){
  const semanticOn=Boolean(enabled&&provider);
  let embedded=0,failed=0;
  if(semanticOn){
   for(const d of docs.values()){
    if(cachedVector(d.hash))embedded++;
    else if(!allowed.has(d.hash)||(embedFailures.get(d.hash)?.attempts??0)>maxRetries)failed++;
   }
  }
  const pending=semanticOn?docs.size-embedded-failed:0;
  const semanticState=!semanticOn?'disabled':pending?'indexing':failed?'degraded':'ready';
  const lexicalReady=indexedRevision!==null&&!extractDirty&&!extracting&&!extractError;
  const state=closed?'closed':extractError?'degraded':!lexicalReady?'indexing':hasExtractionCapacity()?'degraded':semanticState==='disabled'?'ready':semanticState;
  const errors=[...(extractError?[extractError]:[]),...(semanticOn&&embedError?[embedError]:[])];
  const providerSummary={configured,model:configured?(configuredSettings.model??'injected'):null};
  return {
   state,
   semanticState,
   readiness:semanticState,
   enabled,
   configured,
   provider:providerSummary,
   defaultMode:'text',
   chunks:docs.size,
   embedded,
   pending,
   failed,
   model:semanticOn?modelFingerprint:null,
   revision:indexedRevision,
   lexicalReady,
   extracting,
   extraction:{...extraction},
   coverage:{chunks:docs.size,embedded,pending,failed,ratio:docs.size?embedded/docs.size:1},
   error:extractError,
   errors,
  };
 }

 function status(){
  if(closed)return closedStatus?{...closedStatus,provider:{...closedStatus.provider},extraction:{...closedStatus.extraction},coverage:{...closedStatus.coverage},errors:[...closedStatus.errors]}:{state:'closed',semanticState:'disabled',readiness:'disabled',enabled:false,configured,provider:{configured,model:configured?(configuredSettings.model??'injected'):null},defaultMode:'text',chunks:0,embedded:0,pending:0,failed:0,model:null,revision:indexedRevision,lexicalReady:false,extracting:false,extraction:{...extraction},coverage:{chunks:0,embedded:0,pending:0,failed:0,ratio:1},error:extractError,errors:[]};
  return computeStatus();
 }

 function needsExtractWork(){
  return extractDirty&&extractAttempts<=maxBuildRetries;
 }

 function needsEmbedWork(){
  if(!enabled||!provider||extractDirty||indexedRevision===null||extractError)return false;
  for(const d of docs.values()){
   if(allowed.has(d.hash)&&!cachedVector(d.hash)&&(embedFailures.get(d.hash)?.attempts??0)<=maxRetries)return true;
  }
  return false;
 }

 function nextEmbedDelay(now){
  let next=Infinity;
  for(const d of docs.values()){
   if(allowed.has(d.hash)&&!cachedVector(d.hash)){
    const f=embedFailures.get(d.hash);
    if((f?.attempts??0)<=maxRetries)next=Math.min(next,f?.next??0);
   }
  }
  return Number.isFinite(next)?Math.max(0,next-now):Infinity;
 }

 function scheduleRecovery(){
  clearTimeout(recoveryTimer);
  recoveryTimer=null;
  if(closed||!started)return;
  let next=Infinity;
  if(extractDirty&&extractAttempts>maxBuildRetries&&extractRecoverAt)next=Math.min(next,extractRecoverAt);
  if(enabled&&provider){
   for(const f of embedFailures.values())if(f.attempts>maxRetries)next=Math.min(next,f.recoverAt);
  }
  if(!Number.isFinite(next))return;
  recoveryTimer=setTimeout(()=>{
   recoveryTimer=null;
   const now=performance.now();
   if(extractDirty&&extractAttempts>maxBuildRetries&&extractRecoverAt&&extractRecoverAt<=now){
    extractAttempts=0;extractRecoverAt=0;extractNextAt=0;
   }
   for(const [h,f] of embedFailures)if(f.attempts>maxRetries&&f.recoverAt<=now)embedFailures.delete(h);
   scheduleNext(0);
  },Math.max(0,next-performance.now()));
  recoveryTimer.unref?.();
 }

 function scheduleExtract(minDelay=0){
  if(closed||!started||extractRunning||!needsExtractWork())return;
  const now=performance.now(),delay=Math.max(minDelay,extractNextAt-now);
  if(!Number.isFinite(delay))return;
  if(extractTimer){
   if(now+delay>=extractTimerAt)return;
   clearTimeout(extractTimer);
   extractTimer=null;
  }
  extractTimerAt=now+delay;
  extractTimer=setTimeout(()=>{
   extractTimer=null;
   extractTimerAt=Infinity;
   kickExtract();
  },delay);
  extractTimer.unref?.();
 }

 function scheduleEmbed(minDelay=0){
  if(closed||!started||embedRunning||!needsEmbedWork())return;
  const now=performance.now(),delay=Math.max(minDelay,nextEmbedDelay(now));
  if(!Number.isFinite(delay))return;
  if(embedTimer){
   if(now+delay>=embedTimerAt)return;
   clearTimeout(embedTimer);
   embedTimer=null;
  }
  embedTimerAt=now+delay;
  embedTimer=setTimeout(()=>{
   embedTimer=null;
   embedTimerAt=Infinity;
   kickEmbed();
  },delay);
  embedTimer.unref?.();
 }

 function scheduleNext(minDelay=0){
  if(closed||!started)return;
  scheduleRecovery();
  scheduleExtract(minDelay);
  scheduleEmbed(minDelay);
 }

 function onTicketsChange(){
  extractDirty=true;
  if(extractError&&extractAttempts>maxBuildRetries)return;
  scheduleExtract(5);
 }

 async function readContent(a){
  if(a.type!=='text/plain')return {state:'unsupported'};
  if(textCache.has(a.sha256)){
   const value=textCache.get(a.sha256);
   textCache.delete(a.sha256);
   textCache.set(a.sha256,value);
   return value;
  }
  let value;
  try{value=await ticketFiles.readText(a.sha256);}catch{value={state:'missing'};}
  if(closed)return {state:'missing'};
  if(!['indexed','oversize','invalid','missing'].includes(value?.state))value={state:'invalid'};
  const bytes=value.state==='indexed'?Buffer.byteLength(value.text):0;
  if(value.state!=='missing'&&maxCacheEntries&&bytes<=maxCacheBytes){
   textCache.set(a.sha256,{...value,bytes});
   cachedBytes+=bytes;
   while(textCache.size>maxCacheEntries||cachedBytes>maxCacheBytes){
    const key=textCache.keys().next().value;
    cachedBytes-=textCache.get(key).bytes;
    textCache.delete(key);
   }
  }
  return value;
 }

 function describe(t){
  const fields=Object.fromEntries(['type','status','priority','release','assignee','labels'].map(k=>[k,t[k]]));
  const base={ticket:t.id,project:t.project,fields};
  const entry={
   signature:JSON.stringify(t),
   base:[{...base,id:t.id+':metadata',source:'ticket',by:t.reporter,at:t.updatedAt,createdAt:t.createdAt,text:[t.title,...(t.labels||[])].join('\n')}],
   content:[],
   coverage:blankExtraction(),
   ticket:t,
  };
  for(const a of t.attachments||[]){
   entry.base.push({...base,id:t.id+':'+a.id+':metadata',source:'attachment',attachment:a.id,name:a.name,type:a.type,by:a.by,at:a.at,size:a.size,sha256:a.sha256,text:[a.name,a.type,a.by].filter(Boolean).join('\n')});
  }
  return entry;
 }

 function addText(entry,base,text,budget){
  const count=chunkCount(text);
  if(count>budget)return false;
  textChunks(text).forEach((chunk,n)=>entry.content.push({...base,id:base.id+':'+n,text:chunk}));
  return true;
 }

 function syncDocuments(documents,{replaceTickets}={}){
  if(!Array.isArray(documents)||documents.length>maxDocuments)throw new Error('Too many ticket search documents');
  const replaced=replaceTickets?new Set(replaceTickets):null;
  const next=replaced?new Map([...docs].filter(([,d])=>!replaced.has(d.ticket))):new Map();
  const incoming=new Set();
  for(const input of documents){
   if(!input||!['ticket','attachment'].includes(input.source)||['id','ticket','project'].some(k=>typeof input[k]!=='string'||!input[k]||input[k].length>512)||typeof input.text!=='string'||input.text.length>maxTextChars||incoming.has(input.id)||(replaced&&!replaced.has(input.ticket))){
    throw new Error('Invalid ticket search document');
   }
   incoming.add(input.id);
   const d=JSON.parse(JSON.stringify(input));
   d.hash=sha256(d.text);
   next.set(d.id,d);
  }
  if(next.size>maxDocuments)throw Object.assign(new Error('Ticket search document capacity reached'),{code:'capacity'});
  const changes=[];
  for(const d of next.values()){
   const json=JSON.stringify(d);
   if(serialized.get(d.id)!==json)changes.push({d,json});
  }
  const removed=[...docs.keys()].filter(id=>!next.has(id));
  cacheTx(()=>{
   for(const id of removed){st.delLexical.run(rowids.get(id));st.delDoc.run(id);}
   for(const {d,json} of changes){
    st.putDoc.run(d.id,d.hash,json);
    const rowid=st.docRowid.get(d.id).rowid;
    st.delLexical.run(rowid);
    st.putLexical.run(rowid,d.id,lexicalText(d));
   }
  });
  for(const id of removed){serialized.delete(id);rowids.delete(id);}
  for(const {d,json} of changes){serialized.set(d.id,json);rowids.set(d.id,st.docRowid.get(d.id).rowid);}
  if(changes.length||removed.length)generation++;
  docs=next;
  allowed=new Set([...new Set([...docs.values()].map(d=>d.hash))].slice(0,maxVectors));
  for(const h of vectorCache.keys())if(!allowed.has(h))vectorCache.delete(h);
  for(const h of missingVectors)if(!allowed.has(h))missingVectors.delete(h);
  const liveHashes=new Set([...docs.values()].map(d=>d.hash));
  for(const h of embedFailures.keys())if(!liveHashes.has(h))embedFailures.delete(h);
  pruneVectors();
 }

 async function extractBuild(){
  const snapshot=await tickets.searchSnapshot();
  if(closed)return;
  const next=new Map(entries),replaced=new Set(),live=new Set(snapshot.tickets.map(t=>t.id));
  for(const id of entries.keys())if(!live.has(id)){next.delete(id);replaced.add(id);}
  let initial=indexedRevision===null;
  for(const t of snapshot.tickets){
   const old=entries.get(t.id);
   if(initial||!old||old.signature!==JSON.stringify(t)||forceTickets.has(t.id)||old.coverage.capacity||old.coverage.ticketCapacity||old.coverage.metadataCapacity){
    next.set(t.id,describe(t));
    replaced.add(t.id);
   }
  }
  // Reserve all ticket/attachment metadata ahead of body chunks. If a new source needs room,
  // reallocate from scratch rather than allowing old content to crowd out its metadata.
  let used=[...next].reduce((n,[id,e])=>n+(replaced.has(id)?e.base.length:countDocs(e)),0);
  if(used>maxDocuments&&!initial){
   initial=true;next.clear();replaced.clear();
   for(const t of snapshot.tickets){next.set(t.id,describe(t));replaced.add(t.id);}
  }
  let baseBudget=maxDocuments;
  for(const [id,e] of next){
   if(replaced.has(id)){
    const available=Math.max(0,baseBudget),keep=Math.min(e.base.length,available);
    if(keep<e.base.length){
     e.coverage.metadataCapacity=e.base.slice(keep).filter(d=>d.source==='attachment').length;
     if(!keep)e.coverage.ticketCapacity++;
     e.base=e.base.slice(0,keep);
    }
    baseBudget-=e.base.length;
   }else{
    baseBudget-=countDocs(e);
   }
  }
  let remaining=Math.max(0,maxDocuments-[...next.values()].reduce((n,e)=>n+countDocs(e),0));
  for(const id of replaced){
   const e=next.get(id);if(!e)continue;
   if(closed)return;
   await yieldTurn();
   if(closed)return;
   const t=e.ticket,fields=Object.fromEntries(['type','status','priority','release','assignee','labels'].map(k=>[k,t[k]]));
   const base={ticket:t.id,project:t.project,fields};
   const body=[t.title,t.description,...(t.comments||[]).map(c=>`${c.by}\n${c.text}`),...(t.refs||[]),t.assignee,t.reporter].filter(Boolean).join('\n');
   const beforeBody=e.content.length;
   if(!addText(e,{...base,id:t.id+':content',source:'ticket'},body,remaining))e.coverage.ticketCapacity++;
   remaining-=e.content.length-beforeBody;
   for(const a of t.attachments||[]){
    e.coverage.attachments++;
    const source={...base,id:t.id+':'+a.id+':content',source:'attachment',attachment:a.id,name:a.name,type:a.type,by:a.by,at:a.at,size:a.size,sha256:a.sha256};
    const content=await readContent(a);
    if(closed)return;
    if(content.state==='indexed'){
     const beforeFile=e.content.length;
     if(addText(e,source,content.text,remaining)){e.coverage.indexed++;remaining-=e.content.length-beforeFile;}
     else e.coverage.capacity++;
    }else{
     e.coverage[content.state]++;
    }
   }
  }
  if(closed)return;
  if(tickets.searchRevision()!==snapshot.revision){extractDirty=true;return;}
  const changed=[...replaced].flatMap(id=>{const e=next.get(id);return e?[...e.base,...e.content]:[];});
  syncDocuments(initial?[...next.values()].flatMap(e=>[...e.base,...e.content]):changed,initial?{}:{replaceTickets:[...replaced]});
  if(closed)return;
  entries=next;
  forceTickets.clear();
  indexedRevision=snapshot.revision;
  extraction=blankExtraction();
  for(const e of entries.values())for(const key of Object.keys(extraction))extraction[key]+=e.coverage[key];
  extractError=null;
  extractAttempts=0;
  extractNextAt=0;
  extractRecoverAt=0;
 }

 async function embedBatch(){
  if(!enabled||!provider)return;
  const now=performance.now(),seen=new Set(),batch=[];
  for(const d of docs.values()){
   if(allowed.has(d.hash)&&!cachedVector(d.hash)&&!seen.has(d.hash)){
    const f=embedFailures.get(d.hash);
    if((f?.attempts??0)<=maxRetries&&(!f||f.next<=now)){
     batch.push(d);seen.add(d.hash);
     if(batch.length===batchSize||batch.reduce((n,item)=>n+item.text.length,0)+maxTextChars>65536)break;
    }
   }
  }
  if(!batch.length)return;
  const ctl=new AbortController(),toggleGen=semanticGeneration;
  embedController=ctl;
  try{
   const vectors=await raceAbort(Promise.resolve().then(()=>provider(batch.map(d=>d.text),{signal:ctl.signal})),ctl.signal);
   if(closed||!enabled||toggleGen!==semanticGeneration)return;
   const normalized=validateVectors(vectors,batch.length);
   const accepted=[];
   cacheTx(()=>{
    batch.forEach((d,i)=>{
     if(!allowed.has(d.hash))return;
     st.putVector.run(modelFingerprint,d.hash,JSON.stringify(normalized[i]),++clock);
     accepted.push({hash:d.hash,vector:normalized[i]});
    });
    pruneVectors();
   });
   // Publish vectors to readers only after the entire persisted batch committed.
   for(const r of accepted){vectorCache.set(r.hash,Float32Array.from(r.vector));missingVectors.delete(r.hash);embedFailures.delete(r.hash);}
   embedError=null;
  }catch{
   if(!closed&&enabled&&toggleGen===semanticGeneration){
    embedError='Embedding batch failed';
    const failedAt=performance.now();
    for(const d of batch){
     if(!allowed.has(d.hash))continue;
     const attempts=(embedFailures.get(d.hash)?.attempts??0)+1;
     embedFailures.set(d.hash,{attempts,next:failedAt+retryMs*2**(attempts-1),recoverAt:failedAt+recoveryMs});
    }
   }
  }finally{
   if(embedController===ctl)embedController=null;
  }
 }

 function kickExtract(){
  if(closed||extractRunning||!needsExtractWork())return extractRunning;
  if(performance.now()<extractNextAt){scheduleExtract(0);return null;}
  extractDirty=false;
  extracting=true;
  extractRunning=(async()=>{
   try{
    await extractBuild();
   }catch{
    if(!closed){
     extractError='Ticket search extraction unavailable';
     extractAttempts++;
     extractDirty=true;
     if(extractAttempts<=maxBuildRetries)extractNextAt=performance.now()+buildRetryMs*2**(extractAttempts-1);
     else extractRecoverAt=performance.now()+buildRecoveryMs;
    }
   }finally{
    extracting=false;
   }
  })().finally(()=>{
   extractRunning=null;
   if(!closed)scheduleNext(0);
  });
  return extractRunning;
 }

 function kickEmbed(){
  if(closed||embedRunning||!needsEmbedWork())return embedRunning;
  if(nextEmbedDelay(performance.now())>0){scheduleEmbed(0);return null;}
  embedRunning=embedBatch().finally(()=>{
   embedRunning=null;
   if(!closed)scheduleNext(0);
  });
  return embedRunning;
 }

 function cancelSemanticWork(){
  semanticGeneration++;
  embedController?.abort();
  embedController=null;
  for(const ctl of queryControllers)ctl.abort();
  embedFailures.clear();
  embedError=null;
  clearTimeout(embedTimer);embedTimer=null;embedTimerAt=Infinity;
  scheduleRecovery();
 }

 async function start(){
  if(closed)throw new Error('Search is closed');
  return ready??=(async()=>{
   const doc=await settingsStore.read({forWrite:false});
   if(closed)throw new Error('Search is closed');
   if(doc.schema!==PLATFORM_SEARCH_SCHEMA||typeof doc.enabled!=='boolean')throw new Error('Invalid platform search settings');
   enabled=configured&&(options.semanticEnabled??doc.enabled);
   if(!started){
    started=true;
    unsubscribe=tickets.onSearchChange(onTicketsChange);
    contentTimer=setInterval(()=>{
     for(const [id,e] of entries)if(e.coverage.missing)forceTickets.add(id);
     if(forceTickets.size)onTicketsChange();
    },30000);
    contentTimer.unref?.();
   }
   scheduleNext(5);
  })().catch(e=>{ready=null;throw e;});
 }

 function buildSettings(){
  return {defaultMode:'text',configured,enabled,model:configured?(configuredSettings.model??'injected'):null,status:status()};
 }

 async function settings(){
  await start();
  return buildSettings();
 }

 async function setEnabled(input){
  if(!plain(input)||Object.keys(input).some(k=>k!=='enabled')||typeof input.enabled!=='boolean'||(input.enabled&&!configured))throw new Error('invalid');
  const change=settingsQueue.then(async()=>{
   await start();
   if(closed)throw new Error('Search is closed');
   await settingsStore.write({schema:PLATFORM_SEARCH_SCHEMA,enabled:input.enabled});
   if(enabled!==input.enabled){
    generation++;
    enabled=input.enabled;
    if(!enabled){
     cancelSemanticWork();
    }else{
     semanticGeneration++;
     embedFailures.clear();
     embedError=null;
     scheduleNext(0);
    }
   }
   return buildSettings();
  });
  settingsQueue=change.catch(()=>{});
  return change;
 }

 async function queryVector(query){
  const key=sha256(query);
  if(queryCache.has(key))return queryCache.get(key);
  if(queryPromises.has(key))return queryPromises.get(key);
  if(queryPromises.size>=128)throw new Error('Too many pending ticket queries');
  const ctl=new AbortController(),toggleGen=semanticGeneration;
  queryControllers.add(ctl);
  const promise=Promise.resolve().then(async()=>{
   try{
    const raw=await raceAbort(Promise.resolve().then(()=>provider([query],{query:true,signal:ctl.signal})),ctl.signal);
    if(closed||!enabled||toggleGen!==semanticGeneration)throw new Error('Cancelled');
    const vector=validateVectors(raw,1)[0];
    if(maxQueryCache){
     queryCache.set(key,vector);
     while(queryCache.size>maxQueryCache)queryCache.delete(queryCache.keys().next().value);
    }
    return vector;
   }finally{
    queryControllers.delete(ctl);
    queryPromises.delete(key);
   }
  });
  queryPromises.set(key,promise);
  return promise;
 }

 async function search(input){
  if(closed)throw new Error('Search is closed');
  const {query,mode,cutoff,limit,match}=validateSearchInput(input,minScore);
  await start();
  if(closed)throw new Error('Search is closed');
  const revBefore=tickets.searchRevision(),genBefore=generation;
  const stNow=status();
  if(indexedRevision!==revBefore||extractDirty||extracting||extractError){
   return {query,requestedMode:mode,mode,state:extractError&&!extracting?'degraded':'indexing',semanticState:stNow.semanticState,coverage:{...stNow.coverage,extraction:stNow.extraction},extraction:stNow.extraction,results:[]};
  }
  const eligible=new Map([...docs].filter(([,d])=>match({...d.fields,project:d.project,labels:d.fields?.labels??[]})));
  const terms=query.normalize('NFC').match(QUERY_TERMS)?.slice(0,12)??[];
  const lexical=mode==='semantic'||!terms.length?[]:st.searchLexical.all(terms.map(t=>'"'+t+'"*').join(' ')).filter(r=>eligible.has(r.id));
  const semanticOn=Boolean(enabled&&provider);
  const vectorsReady=semanticOn&&[...eligible.values()].every(d=>cachedVector(d.hash));
  if(mode==='semantic'&&(!semanticOn||!vectorsReady)){
   return {query,requestedMode:mode,mode,state:!semanticOn?'disabled':stNow.failed?'degraded':'indexing',semanticState:stNow.semanticState,coverage:{...stNow.coverage,extraction:stNow.extraction},extraction:stNow.extraction,results:[]};
  }
  let semantic=[],queryFailed=false;
  if(mode!=='text'&&vectorsReady&&eligible.size){
   try{
    const vector=await queryVector(query);
    if(closed)throw new Error('Closed');
    for(const d of eligible.values()){
     const v=cachedVector(d.hash);
     if(v&&v.length===vector.length){
      let cosine=0;
      for(let i=0;i<v.length;i++)cosine+=v[i]*vector[i];
      if(cosine>=cutoff)semantic.push({id:d.id,cosine});
     }
    }
    semantic.sort((a,b)=>b.cosine-a.cosine);
   }catch{
    queryFailed=true;
   }
  }
  if(closed||genBefore!==generation||revBefore!==tickets.searchRevision()){
   const stAfter=status();
   return {query,requestedMode:mode,mode,state:closed?'closed':'indexing',semanticState:stAfter.semanticState,coverage:{...stAfter.coverage,extraction:stAfter.extraction},extraction:stAfter.extraction,results:[]};
  }
  const ranked=new Map();
  lexical.forEach((r,i)=>ranked.set(r.id,{score:1/(60+i+1),matchKind:'text'}));
  semantic.forEach((r,i)=>{
   const old=ranked.get(r.id);
   ranked.set(r.id,{score:(old?.score??0)+1/(60+i+1),cosine:r.cosine,matchKind:old?'hybrid':'semantic'});
  });
  const groups=new Set(),results=[];
  for(const [id,rank] of [...ranked].sort((a,b)=>b[1].score-a[1].score||a[0].localeCompare(b[0]))){
   const d=eligible.get(id),group=JSON.stringify([d.ticket,d.source,d.attachment??null]);
   if(groups.has(group))continue;
   groups.add(group);
   const {text,hash:unused,fields,...citation}=d;
   const position=terms.map(t=>text.toLowerCase().indexOf(t.toLowerCase())).filter(n=>n>=0).sort((a,b)=>a-b)[0]??0;
   const startPos=Math.max(0,Array.from(text.slice(0,position)).length-100);
   results.push({...citation,snippet:Array.from(text).slice(startPos,startPos+600).join(''),...rank});
   if(results.length===limit)break;
  }
  const effectiveMode=mode==='hybrid'&&(!vectorsReady||queryFailed)?'text':mode;
  const resultState=queryFailed||hasExtractionCapacity()?'degraded':'ready';
  return {query,requestedMode:mode,mode:effectiveMode,state:resultState,semanticState:queryFailed?'degraded':stNow.semanticState,coverage:stNow.coverage,extraction:stNow.extraction,results};
 }

 async function searchAll(input){
  if(closed)throw new Error('Search is closed');
  if(!db)throw new Error('Search database is required');
  if(!plain(input)||Object.keys(input).some(k=>!SEARCH_ALL_KEYS.includes(k)))throw new Error('invalid');
  const {mode='text',...query}=input;
  // Epics and review sets have only the full-text index; the hybrid modes search tickets.
  if(!SEARCH_MODES.includes(mode)||(mode!=='text'&&(input.kind==='review'||input.kind==='epic')))throw new Error('invalid');
  const revision=tickets.searchRevision();
  const base=db.search(query);
  const limit=Number(input.limit??20);
  await start();
  if(closed)throw new Error('Search is closed');
  let available=enabled===true;
  if(input.kind==='review'||input.kind==='epic'||!QUERY_WORD.test(input.q))return {...base,mode,semanticAvailable:available};
  const loadedTickets=new Map();
  async function loadTicket(id){
   if(loadedTickets.has(id))return loadedTickets.get(id);
   const ticket=await tickets.get(id).catch(()=>null);
   loadedTickets.set(id,ticket);
   return ticket;
  }
  async function hydrateTicketHits(sources,initial){
   const results=[...initial],seen=new Set(results.filter(r=>r.kind==='ticket').map(r=>r.id));
   for(const source of sources){
    if(seen.has(source.ticket))continue;
    seen.add(source.ticket);
    const ticket=await loadTicket(source.ticket);
    if(!ticket||(source.attachment&&!ticket.attachments.some(a=>a.id===source.attachment)))continue;
    results.push({
     kind:'ticket',
     id:ticket.id,
     project:ticket.project,
     updatedAt:ticket.updatedAt,
     title:ticket.id+' '+ticket.title,
     snippet:source.snippet,
     score:source.score,
     source:source.source,
     ...(source.attachment?{attachment:source.attachment,name:source.name}:{}),
     meta:{status:ticket.status,type:ticket.type,priority:ticket.priority,assignee:ticket.assignee,release:ticket.release},
    });
   }
   return results;
  }
  const toggleGen=semanticGeneration;
  const found=await search({query:input.q,...(input.project?{project:input.project}:{}),mode,limit:100});
  if(mode!=='text')base.results=[];
  const results=await hydrateTicketHits(found.results,base.results);
  available=enabled===true;
  if(mode!=='text'&&toggleGen!==semanticGeneration){
   if(mode==='hybrid'){
    // Opt-out or semantic change during hydration: discard stale semantic hits and return ticket-only lexical hits.
    const lex=await search({query:input.q,...(input.project?{project:input.project}:{}),mode:'text',limit:100});
    const lexResults=await hydrateTicketHits(lex.results,[]);
    if(revision!==tickets.searchRevision()){
     return {q:query.q,total:0,results:[],mode:'text',semanticAvailable:enabled===true,attachmentSearch:{state:'indexing',extraction:status().extraction}};
    }
    return {...base,total:lexResults.length,results:lexResults.slice(0,limit),mode:'text',semanticAvailable:enabled===true,attachmentSearch:{state:lex.state,extraction:lex.extraction}};
   }
   return {q:query.q,total:0,results:[],mode,semanticAvailable:available,attachmentSearch:{state:available?'indexing':'disabled',extraction:status().extraction}};
  }
  if(revision!==tickets.searchRevision()){
   return {...(mode==='text'?db.search(query):{q:query.q,total:0,results:[]}),mode,semanticAvailable:available,attachmentSearch:{state:'indexing',extraction:status().extraction}};
  }
  return {...base,total:results.length,results:results.slice(0,limit),mode:found.mode,semanticAvailable:available,attachmentSearch:{state:found.state,extraction:found.extraction}};
 }

 function retryFailed(){
  if(closed)throw new Error('Ticket search is closed');
  embedFailures.clear();
  embedError=null;
  if(extractAttempts>maxBuildRetries){extractAttempts=0;extractRecoverAt=0;extractNextAt=0;extractError=null;}
  clearTimeout(recoveryTimer);
  recoveryTimer=null;
  scheduleNext(0);
  return status();
 }

 function sleepRef(ms){
  let timerId;
  const wait=new Promise(resolve=>{timerId=setTimeout(resolve,ms);});
  return Promise.race([wait,closedSignal]).finally(()=>clearTimeout(timerId));
 }

 async function whenIdle(){
  if(closed)throw new Error('Ticket search is closed');
  await Promise.race([start(),closedSignal]);
  if(closed)throw new Error('Ticket search is closed');
  await Promise.race([settingsQueue,closedSignal]);
  if(closed)throw new Error('Ticket search is closed');
  if(extractTimer&&extractAttempts===0&&needsExtractWork()&&performance.now()>=extractNextAt){
   clearTimeout(extractTimer);extractTimer=null;extractTimerAt=Infinity;
   kickExtract();
  }
  while(extractRunning||embedRunning||extractTimer||embedTimer||needsExtractWork()||needsEmbedWork()){
   if(extractRunning){
    await Promise.race([extractRunning,closedSignal]);
   }else if(needsExtractWork()&&performance.now()>=extractNextAt){
    clearTimeout(extractTimer);extractTimer=null;extractTimerAt=Infinity;
    kickExtract();
   }else if(embedRunning){
    await Promise.race([embedRunning,closedSignal]);
   }else if(needsEmbedWork()&&nextEmbedDelay(performance.now())===0){
    clearTimeout(embedTimer);embedTimer=null;embedTimerAt=Infinity;
    kickEmbed();
   }else{
    scheduleNext(0);
    const nextAt=Math.min(extractTimerAt,embedTimerAt);
    const waitMs=Number.isFinite(nextAt)?Math.min(25,Math.max(1,nextAt-performance.now())):5;
    await sleepRef(waitMs);
   }
   if(closed)throw new Error('Ticket search is closed');
  }
  return status();
 }

 function close(){
  if(closePromise)return closePromise;
  closedStatus={...computeStatus(),state:'closed',extracting:false,lexicalReady:false};
  closed=true;
  generation++;
  semanticGeneration++;
  resolveClosed();
  unsubscribe?.();
  unsubscribe=null;
  clearTimeout(extractTimer);extractTimer=null;extractTimerAt=Infinity;
  clearTimeout(embedTimer);embedTimer=null;embedTimerAt=Infinity;
  clearTimeout(recoveryTimer);recoveryTimer=null;
  clearInterval(contentTimer);contentTimer=null;
  embedController?.abort();embedController=null;
  for(const ctl of queryControllers)ctl.abort();
  closePromise=(async()=>{
   await ready?.catch(()=>{});
   await settingsQueue;
   cacheDb.close();
   textCache.clear();
   entries.clear();
   vectorCache.clear();
   missingVectors.clear();
   queryCache.clear();
  })();
  return closePromise;
 }

 pruneVectors();
 return {start,close,whenIdle,status,settings,setEnabled,search,searchAll,retryFailed};
}
