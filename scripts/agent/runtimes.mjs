// The push agent's runtimes part (docs/agent.md §5): the local LLM runtimes listed in agent.json, read through the
// hub's own read-only adapters (server/runtime-adapters.mjs: GET only, an allowlist of paths, bounded bodies, short
// timeouts) and only on loopback. → one machine's entry of home.runtimes, its documented fields only.
import {createReader,readRuntime,errorCode,KIND_NAMES} from '../../server/runtime-adapters.mjs';
import {loopbackOrigin} from '../../server/agent-report.mjs';

const RUNTIME_KEYS=['id','name','kind','status','url','version','source','mode','activity','pids','role','memory','models','stats'];
const MODEL_KEYS=['id','name','state','kind','sizeGb','contextTokens','ttlRemainingSeconds','active','queued','since','capabilities','engine','via','target','lastRequestAt','ttlSeconds','pids'];
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));

/**
 * Reads each runtime once. list: [{id, kind, url}] from agent.json. memo: a Map kept across reads (the detected kind
 * and the adapters' own memory). → {runtimes: [...]}; a runtime that does not answer is "stopped" (refused) or
 * "unknown" (any other failure), never left out.
 */
export async function readRuntimes(list,{fetcher=fetch,memo=new Map(),now=Date.now}={}){
 const runtimes=[];
 for(const r of list){
  if(!loopbackOrigin(r.url))continue;
  const m=memo.get(r.id)||{detected:null,memo:{}};memo.set(r.id,m);
  const base={id:r.id,name:KIND_NAMES[m.detected||r.kind]||r.id,kind:m.detected||(r.kind==='auto'?'':r.kind),url:r.url};
  try{
   const read=await readRuntime(createReader({base:r.url,fetcher}),{kind:r.kind,detected:m.detected,now:now(),memo:m.memo});
   if(r.kind==='auto')m.detected=read.kind;
   runtimes.push(pick({...base,name:KIND_NAMES[read.kind]||r.id,kind:read.kind,status:'running',version:read.version||null,
    models:(read.models||[]).slice(0,30).map(x=>pick(x,MODEL_KEYS)),stats:(read.stats||[]).slice(0,12),...(read.activity?{activity:read.activity}:{})},RUNTIME_KEYS));
  }catch(e){
   runtimes.push({...base,status:errorCode(e)==='refused'?'stopped':'unknown',version:null,models:[],stats:[]});
  }
 }
 return {runtimes:runtimes.slice(0,20)};
}
