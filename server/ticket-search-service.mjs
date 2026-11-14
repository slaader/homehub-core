// Derived search: canonical writes schedule work; extraction and models never run in a write request.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {createTicketSearchIndex} from './ticket-search-index.mjs';
import {createTicketEmbedder} from './ticket-embeddings.mjs';

export function ticketSearchSettings(env=process.env){
 const url=env.HOME_HUB_TICKET_EMBEDDING_URL,model=env.HOME_HUB_TICKET_EMBEDDING_MODEL;
 if(Boolean(url)!==Boolean(model))throw new Error('Invalid ticket embedding configuration');
 const minScore=env.HOME_HUB_TICKET_SEARCH_MIN_SCORE===undefined?0.5:Number(env.HOME_HUB_TICKET_SEARCH_MIN_SCORE);
 if(!Number.isFinite(minScore)||minScore<0||minScore>1)throw new Error('Invalid ticket search minimum score');
 return {url,model,token:env.HOME_HUB_TICKET_EMBEDDING_TOKEN,queryPrefix:env.HOME_HUB_TICKET_EMBEDDING_QUERY_PREFIX,minScore,
  modelFingerprint:createHash('sha256').update(JSON.stringify([url,model,env.HOME_HUB_TICKET_EMBEDDING_REVISION,env.HOME_HUB_TICKET_EMBEDDING_QUERY_PREFIX])).digest('hex')};
}
export function textChunks(text,size=800,overlap=100){
 if(typeof text!=='string'||!Number.isInteger(size)||!Number.isInteger(overlap)||size<1||overlap<0||overlap>=size)throw new Error('Invalid text chunk bounds');
 const chars=Array.from(text),out=[];for(let i=0;i<chars.length;i+=size-overlap){out.push(chars.slice(i,i+size).join(''));if(i+size>=chars.length)break;}return out;
}
const blankCoverage=()=>({attachments:0,indexed:0,unsupported:0,oversize:0,invalid:0,missing:0,capacity:0,metadataCapacity:0,ticketCapacity:0});
const bound=(v,fallback,min,max)=>{v??=fallback;if(!Number.isInteger(v)||v<min||v>max)throw new Error('Invalid ticket extraction bound');return v;};
const chunkCount=text=>{const n=Array.from(text).length;return n?Math.max(1,Math.ceil((n-100)/700)):0;};

export function createTicketSearchService(directory,{tickets,ticketFiles,env=process.env,indexFactory=createTicketSearchIndex,...options}){
 const settings={...ticketSearchSettings(env),...options},embed=options.embed??(settings.url?createTicketEmbedder(settings):undefined);
 const maxDocuments=bound(options.maxDocuments,200000,1,1000000),maxCacheBytes=bound(options.maxExtractionBytes,16*1024*1024,0,256*1024*1024),maxCacheEntries=bound(options.maxExtractionEntries,4096,0,100000);
 const retryMs=bound(options.buildRetryMs,250,1,60000),maxRetries=bound(options.maxBuildRetries,2,0,5),recoveryMs=bound(options.buildRecoveryMs,60000,1,3600000);
 const index=indexFactory(path.join(directory,'search'),{...settings,embed,maxDocuments});
 let closed=false,started=false,dirty=true,running=null,timer=null,recoveryTimer=null,contentTimer=null,unsubscribe=null,indexedRevision=null,error=null,attempts=0,nextDelay=0,closePromise=null;
 let resolveClosed;const closedSignal=new Promise(resolve=>{resolveClosed=resolve;});
 let extraction=blankCoverage(),entries=new Map(),cachedBytes=0,lastIndexStatus=null;
 const textCache=new Map(),forceTickets=new Set();
 const countDocs=entry=>entry.base.length+entry.content.length;
 const status=()=>{
  const view=closed?(lastIndexStatus??{}):index.status(),lexicalReady=indexedRevision!==null&&!dirty&&!running&&!error;
  return {...view,semanticState:view.state,state:closed?'closed':error?'degraded':!lexicalReady?'indexing':extraction.capacity||extraction.metadataCapacity||extraction.ticketCapacity?'degraded':view.state==='disabled'?'ready':view.state,
   extraction:{...extraction},extracting:Boolean(running),revision:indexedRevision,lexicalReady,error};
 };
 function arm(delay=0){if(!closed&&started&&!running&&!timer){timer=setTimeout(()=>{timer=null;run();},delay);timer.unref?.();}}
 function schedule(){dirty=true;if(error&&attempts>maxRetries)return;arm(5);}
 async function readContent(a){
  if(a.type!=='text/plain')return {state:'unsupported'};
  if(textCache.has(a.sha256)){const value=textCache.get(a.sha256);textCache.delete(a.sha256);textCache.set(a.sha256,value);return value;}
  let value;try{value=await ticketFiles.readText(a.sha256);}catch{value={state:'missing'};}
  if(closed)return {state:'missing'};
  if(!['indexed','oversize','invalid','missing'].includes(value.state))value={state:'invalid'};
  const bytes=value.state==='indexed'?Buffer.byteLength(value.text):0;
  if(value.state!=='missing'&&maxCacheEntries&&bytes<=maxCacheBytes){
   textCache.set(a.sha256,{...value,bytes});cachedBytes+=bytes;
   while(textCache.size>maxCacheEntries||cachedBytes>maxCacheBytes){const key=textCache.keys().next().value;cachedBytes-=textCache.get(key).bytes;textCache.delete(key);}
  }
  return value;
 }
 function describe(t){
  const fields=Object.fromEntries(['type','status','priority','release','assignee','labels'].map(k=>[k,t[k]])),base={ticket:t.id,project:t.project,fields};
  const entry={signature:JSON.stringify(t),base:[{...base,id:t.id+':metadata',source:'ticket',by:t.reporter,at:t.updatedAt,createdAt:t.createdAt,text:[t.title,...(t.labels||[])].join('\n')}],content:[],coverage:blankCoverage(),ticket:t};
  for(const a of t.attachments||[])entry.base.push({...base,id:t.id+':'+a.id+':metadata',source:'attachment',attachment:a.id,name:a.name,type:a.type,by:a.by,at:a.at,size:a.size,sha256:a.sha256,text:[a.name,a.type,a.by].filter(Boolean).join('\n')});
  return entry;
 }
 function addText(entry,base,text,budget){
  const count=chunkCount(text);if(count>budget)return false;
  textChunks(text).forEach((text,n)=>entry.content.push({...base,id:base.id+':'+n,text}));return true;
 }
 async function build(){
  const snapshot=await tickets.searchSnapshot(),next=new Map(entries),replaced=new Set(),live=new Set(snapshot.tickets.map(t=>t.id));
  for(const id of entries.keys())if(!live.has(id)){next.delete(id);replaced.add(id);}
  let initial=indexedRevision===null;
  for(const t of snapshot.tickets){const old=entries.get(t.id);if(initial||!old||old.signature!==JSON.stringify(t)||forceTickets.has(t.id)||old.coverage.capacity||old.coverage.ticketCapacity||old.coverage.metadataCapacity){next.set(t.id,describe(t));replaced.add(t.id);}}
  // Reserve all ticket/attachment metadata ahead of body chunks. If a new source needs room,
  // reallocate from scratch rather than allowing old content to crowd out its metadata.
  let used=[...next].reduce((n,[id,e])=>n+(replaced.has(id)?e.base.length:countDocs(e)),0);
  if(used>maxDocuments&&!initial){initial=true;next.clear();replaced.clear();for(const t of snapshot.tickets){next.set(t.id,describe(t));replaced.add(t.id);}used=[...next.values()].reduce((n,e)=>n+e.base.length,0);}
  let baseBudget=maxDocuments;
  for(const [id,e]of next)if(replaced.has(id)){
   const available=Math.max(0,baseBudget),keep=Math.min(e.base.length,available);
   if(keep<e.base.length){e.coverage.metadataCapacity=e.base.slice(keep).filter(d=>d.source==='attachment').length;if(!keep)e.coverage.ticketCapacity++;e.base=e.base.slice(0,keep);}
   baseBudget-=e.base.length;
  }else baseBudget-=countDocs(e);
  let remaining=Math.max(0,maxDocuments-[...next.values()].reduce((n,e)=>n+countDocs(e),0));
  for(const id of replaced){
   const e=next.get(id);if(!e)continue;if(closed)return;await yieldTurn();
   const t=e.ticket,fields=Object.fromEntries(['type','status','priority','release','assignee','labels'].map(k=>[k,t[k]])),base={ticket:t.id,project:t.project,fields};
   const body=[t.title,t.description,...(t.comments||[]).map(c=>`${c.by}\n${c.text}`),...(t.refs||[]),t.assignee,t.reporter].filter(Boolean).join('\n');
   const before=e.content.length;if(!addText(e,{...base,id:t.id+':content',source:'ticket'},body,remaining))e.coverage.ticketCapacity++;remaining-=e.content.length-before;
   for(const a of t.attachments||[]){
    e.coverage.attachments++;const source={...base,id:t.id+':'+a.id+':content',source:'attachment',attachment:a.id,name:a.name,type:a.type,by:a.by,at:a.at,size:a.size,sha256:a.sha256};
    const content=await readContent(a);if(closed)return;
    if(content.state==='indexed'){
     const before=e.content.length;if(addText(e,source,content.text,remaining)){e.coverage.indexed++;remaining-=e.content.length-before;}else e.coverage.capacity++;
    }else e.coverage[content.state]++;
   }
  }
  if(closed)return;if(tickets.searchRevision()!==snapshot.revision){dirty=true;return;}
  const changed=[...replaced].flatMap(id=>{const e=next.get(id);return e?[...e.base,...e.content]:[];});
  await index.sync(initial?[...next.values()].flatMap(e=>[...e.base,...e.content]):changed,{revision:snapshot.revision,...(initial?{}:{replaceTickets:[...replaced]})});
  if(closed)return;entries=next;forceTickets.clear();indexedRevision=snapshot.revision;extraction=blankCoverage();
  for(const e of entries.values())for(const key of Object.keys(extraction))extraction[key]+=e.coverage[key];
  error=null;attempts=0;
 }
 function run(){
  if(closed||running)return running;dirty=false;nextDelay=0;
  running=build().catch(()=>{
   if(closed)return;
   error='Ticket search extraction unavailable';attempts++;
   if(attempts<=maxRetries){dirty=true;nextDelay=retryMs*2**(attempts-1);}
   else{clearTimeout(recoveryTimer);recoveryTimer=setTimeout(()=>{recoveryTimer=null;attempts=0;dirty=true;arm();},recoveryMs);recoveryTimer.unref?.();}
  }).finally(()=>{running=null;if(dirty&&attempts<=maxRetries)arm(nextDelay);});return running;
 }
 function start(){
  if(started||closed)return;started=true;unsubscribe=tickets.onSearchChange(schedule);schedule();
  contentTimer=setInterval(()=>{for(const[id,e]of entries)if(e.coverage.missing)forceTickets.add(id);if(forceTickets.size)schedule();},30000);contentTimer.unref?.();
 }
 async function search(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['query','project','status','type','priority','release','assignee','label','limit','mode','minScore'].includes(k)))throw new Error('invalid');
  const {query,mode='hybrid',minScore,...raw}=input;
  if(typeof query!=='string'||query.length>200||!/[\p{L}\p{N}_]/u.test(query)||!['text','hybrid','semantic'].includes(mode)||minScore!==undefined&&(typeof minScore!=='number'||!Number.isFinite(minScore)||minScore<0||minScore>1))throw new Error('invalid');
  const {f:filters}=tickets.validateSearchFilters(raw);
  if(filters.limit!==undefined&&(!/^\d+$/.test(String(filters.limit))||Number(filters.limit)<1||Number(filters.limit)>100))throw new Error('invalid');
  const before=tickets.searchRevision();
  if(indexedRevision!==before||dirty||running||error)return {query,requestedMode:mode,mode,state:error&&!running?'degraded':'indexing',coverage:status(),results:[]};
  const result=await index.search({...filters,limit:Number(filters.limit??20),query,mode,...(minScore===undefined?{}:{minScore})});
  if(before!==tickets.searchRevision())return {query,requestedMode:mode,mode,state:'indexing',coverage:status(),results:[]};
  return {...result,...(extraction.capacity||extraction.metadataCapacity||extraction.ticketCapacity?{state:'degraded'}:{}),extraction:{...extraction}};
 }
 function close(){
  if(closePromise)return closePromise;lastIndexStatus=index.status();closed=true;resolveClosed();unsubscribe?.();clearTimeout(timer);clearTimeout(recoveryTimer);clearInterval(contentTimer);timer=null;
  closePromise=(async()=>{await index.close();textCache.clear();entries.clear();})();return closePromise;
 }
 async function whenIdle(){
  if(closed)throw new Error('Ticket search service is closed');
  if(timer&&attempts===0){clearTimeout(timer);timer=null;await Promise.race([run(),closedSignal]);if(closed)throw new Error('Ticket search service is closed');}
  while(running||timer||dirty&&attempts<=maxRetries){if(running)await Promise.race([running,closedSignal]);else if(timer)await new Promise(r=>setTimeout(r,5));else await run();if(closed)throw new Error('Ticket search service is closed');}
  await index.whenIdle?.();return status();
 }
 return {start,close,status,search,whenIdle};
}
