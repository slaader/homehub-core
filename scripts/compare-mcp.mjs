#!/usr/bin/env node
// Real HTTP MCP comparison. Never takes a production URL or key; both servers use temporary fixtures.
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const args=process.argv.slice(2),get=(flag,fallback)=>{const i=args.indexOf(flag);return i<0?fallback:args[i+1];};
const corpus=get('--corpus'),out=path.resolve(get('--out',path.join(process.cwd(),'mcp-comparison.json'))),samples=Number(get('--samples','100')),rounds=Number(get('--rounds','3')),firstVariant=get('--first','node');
if(!Number.isInteger(samples)||samples<10||samples>1000||!Number.isInteger(rounds)||rounds<1||rounds>10||(samples+10)*rounds>2000||!['node','rust'].includes(firstVariant))throw new Error('Invalid benchmark bounds');
const result={startedAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,samplesPerRound:samples,rounds,firstVariant,warmups:10,variantBoundary:'Node HTTP MCP vs Rust HTTP/JSON-RPC plus shared Node business over Unix IPC',client:'Separate Node driver; HTTP keep-alive via the same fetch implementation',providers:'Disabled; full-text search with attachment contents',runs:[],errors:0};
const workers=[];
async function start(variant){
 const child=fork(fileURLToPath(new URL('../experimental/rust-mcp/benchmark-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',d=>{stderr+=d;});workers.push(child);
 const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.error)reject(new Error(m.error));else if(m.ready)resolve(m);});child.once('error',reject);child.once('exit',()=>reject(new Error('Worker exited before ready: '+stderr)));});
 child.send({operation:'start',variant,corpus:corpus?path.resolve(corpus):undefined});
 return {...await ready,child,variant};
}
const resources=w=>new Promise(resolve=>{const id=Math.random().toString(36);const listener=m=>{if(m.id===id){w.child.off('message',listener);resolve(m);}};w.child.on('message',listener);w.child.send({operation:'resources',id});});
const percentile=(a,q)=>a[Math.ceil(a.length*q)-1];
const stats=times=>{const a=[...times].sort((a,b)=>a-b);return {samples:a.length,p50Ms:percentile(a,.5),p95Ms:percentile(a,.95),p99Ms:percentile(a,.99)};};
let id=0;
async function request(w,method,params){
 const response=await fetch(w.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:w.authorization},signal:AbortSignal.timeout(30000),body:JSON.stringify({jsonrpc:'2.0',id:++id,method,...(params===undefined?{}:{params})})});
 const raw=await response.text(),body=JSON.parse(raw);assert.equal(response.status,200);assert.ok(!body.error,JSON.stringify(body.error));assert.ok(!body.result?.isError,raw);return {data:body.result.structuredContent??body.result,bytes:Buffer.byteLength(raw)};
}
const call=(w,name,args={})=>request(w,'tools/call',{name,arguments:args});
async function measure(w,name,run,round,count=samples){
 for(let i=0;i<10;i++)await run(i);const before=await resources(w),times=[],bytes=[];
 const start=performance.now();for(let i=0;i<count;i++){const at=performance.now(),reply=await run(i+10);times.push(performance.now()-at);bytes.push(reply.bytes);}const elapsedMs=performance.now()-start,after=await resources(w);
 const cpuMs=(after.usage.userCPUTime+after.usage.systemCPUTime-before.usage.userCPUTime-before.usage.systemCPUTime)/1000+(after.rust?.cpuMs??0)-(before.rust?.cpuMs??0);
 const runResult={variant:w.variant,name,round,...stats(times),elapsedMs,cpuMs,nodeRssBytes:after.memory.rss,rustRssBytes:after.rust?.rssBytes??0,totalRssBytes:after.memory.rss+(after.rust?.rssBytes??0),minResponseBytes:Math.min(...bytes),maxResponseBytes:Math.max(...bytes),times};
 result.runs.push(runResult);console.log(JSON.stringify({...runResult,times:undefined}));
}
try{
 const node=await start('node'),rust=await start('rust');result.corpus=node.corpus;assert.deepEqual(node.corpus,rust.corpus);
 const order=firstVariant==='node'?[node,rust]:[rust,node];
 for(let round=0;round<rounds;round++)for(const w of round%2?[...order].reverse():order){
  await measure(w,'ping',()=>request(w,'ping'),round);
  await measure(w,'initialize',()=>request(w,'initialize',{protocolVersion:'2025-11-25',capabilities:{}}),round);
  await measure(w,'tools_list',()=>request(w,'tools/list'),round);
  await measure(w,'ticket_get',()=>call(w,'ticket_get',{id:w.first.id}),round);
  await measure(w,'projects_list',()=>call(w,'projects_list'),round);
  await measure(w,'tickets_list',()=>call(w,'tickets_list',{project:w.project,limit:20}),round);
  await measure(w,'ticket_search',()=>call(w,'ticket_search',{query:'synthetic',project:w.project,limit:20}),round);
  await measure(w,'attachment_text_search',async()=>{const reply=await call(w,'ticket_hybrid_search',{query:w.first.contentToken,limit:10});assert.ok(reply.data.results.some(x=>x.ticket===w.first.id&&x.attachment));return reply;},round);
  await measure(w,'global_attachment_search',async()=>{const reply=await call(w,'search',{query:w.first.contentToken,limit:10});assert.ok(reply.data.results.some(x=>x.id===w.first.id&&x.attachment));return reply;},round);
  // Project creation is bounded by the real 50-project quota: one 30-sample batch per variant.
  if(round===0)await measure(w,'project_create',i=>call(w,'project_save',{id:'perf-create-'+i,key:'PC'+i,name:'Benchmark project '+i}),round,Math.min(30,samples));
  let rev=(await call(w,'projects_list')).data.projects.find(p=>p.id===w.project).rev;
  await measure(w,'project_save',async i=>{const reply=await call(w,'project_save',{id:w.project,rev,name:'Benchmark project '+round+' '+i});rev=reply.data.rev;return reply;},round);
  await measure(w,'ticket_create',i=>call(w,'ticket_create',{project:w.project,title:'Benchmark create '+round+' '+i}),round);
  let ticketRev=(await call(w,'ticket_get',{id:w.first.id})).data.rev;
  await measure(w,'ticket_update',async i=>{const reply=await call(w,'ticket_update',{id:w.first.id,rev:ticketRev,priority:i%2?'low':'high'});ticketRev=reply.data.rev;return reply;},round);
  await measure(w,'attachment_put_deduplicated',()=>call(w,'ticket_attachment_put',{id:w.first.id,name:'benchmark-small.txt',data:Buffer.from('Benchmark attachment upload').toString('base64')}),round);
  await measure(w,'create_and_attach',async i=>{const ticket=await call(w,'ticket_create',{project:w.project,title:'Benchmark file ticket '+round+' '+i});const reply=await call(w,'ticket_attachment_put',{id:ticket.data.id,name:'fresh-evidence.txt',data:Buffer.from('New synthetic file '+round+'/'+i).toString('base64')});assert.equal(reply.data.attachments.length,1);return reply;},round);
  // Finish indexing write effects before mixed concurrent reads, for both variants.
  const status=()=>call(w,'ticket_search_status');let s=await status();while(!s.data.lexicalReady){await new Promise(r=>setTimeout(r,10));s=await status();}
  for(const concurrency of [8,32]){
   const jobs=[()=>call(w,'ticket_get',{id:w.first.id}),()=>call(w,'tickets_list',{limit:20}),()=>call(w,'ticket_hybrid_search',{query:w.first.contentToken,limit:10}),()=>call(w,'projects_list')];
   const before=await resources(w),times=[],start=performance.now();let next=0;
   await Promise.all(Array.from({length:concurrency},async()=>{while(next<samples*4){const n=next++,at=performance.now();await jobs[n%jobs.length]();times.push(performance.now()-at);}}));
   const elapsedMs=performance.now()-start,after=await resources(w);
   result.runs.push({variant:w.variant,name:'mixed_'+concurrency,round,...stats(times),elapsedMs,requestsPerSecond:times.length*1000/elapsedMs,cpuMs:(after.usage.userCPUTime+after.usage.systemCPUTime-before.usage.userCPUTime-before.usage.systemCPUTime)/1000+(after.rust?.cpuMs??0)-(before.rust?.cpuMs??0),nodeRssBytes:after.memory.rss,rustRssBytes:after.rust?.rssBytes??0,totalRssBytes:after.memory.rss+(after.rust?.rssBytes??0),times});
  }
 }
 result.requestCount=id;result.completedAt=new Date().toISOString();
}catch(e){result.errors++;result.error=e.message;throw e;}
finally{
 for(const child of workers){if(child.connected){const exited=once(child,'exit');child.send({operation:'close'});await exited;}}
 await mkdir(path.dirname(out),{recursive:true,mode:0o700});await writeFile(out,JSON.stringify(result,null,2),{mode:0o600});
}
