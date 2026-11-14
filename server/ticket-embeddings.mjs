import {createHash} from 'node:crypto';

export function normalizeTicketVector(vector) {
 if (!Array.isArray(vector) || !vector.length || vector.length>16384 || vector.some(n=>typeof n!=='number'||!Number.isFinite(n))) throw new Error('Invalid embedding vector');
 const norm=Math.hypot(...vector); if(!Number.isFinite(norm)||norm===0)throw new Error('Invalid embedding vector');
 return vector.map(n=>n/norm);
}

export function createTicketEmbedder({url,model,token,queryPrefix='',timeoutMs=15000,fetchImpl=globalThis.fetch,maxResponseBytes=4*1024*1024,maxInputChars=65536,maxConcurrency=2,maxQueued=128}={}) {
 const endpoint=new URL(url);
 if(endpoint.username||endpoint.password||endpoint.hash||endpoint.search||!(endpoint.protocol==='https:'||(endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))))throw new Error('Invalid embedding endpoint');
 if(typeof model!=='string'||!model.trim()||model.length>256||typeof queryPrefix!=='string'||queryPrefix.length>4096)throw new Error('Invalid embedding configuration');
 if(token!==undefined&&(typeof token!=='string'||token.length>16384||/[\r\n]/.test(token)))throw new Error('Invalid embedding credential');
 for(const [n,lo,hi] of [[timeoutMs,1,120000],[maxResponseBytes,1,16777216],[maxInputChars,1,1048576],[maxConcurrency,1,16],[maxQueued,0,1024]])if(!Number.isInteger(n)||n<lo||n>hi)throw new Error('Invalid embedding bound');
 let active=0,dimensions=null;const queue=[];
 function acquire(query,signal){
  return new Promise((resolve,reject)=>{
   const entry={query,start(){signal.removeEventListener('abort',cancel);active++;resolve(()=>{active--;while(active<maxConcurrency&&queue.length)queue.shift().start();});}};
   function cancel(){const i=queue.indexOf(entry);if(i>=0)queue.splice(i,1);reject(new Error('Embedding cancelled'));}
   if(signal.aborted)return cancel();
   if(active<maxConcurrency)return entry.start();
   if(queue.length>=maxQueued)return reject(new Error('Embedding queue is full'));
   // Interactive queries go ahead of queued backfill batches, never ahead of an active request.
   const firstBatch=query?queue.findIndex(item=>!item.query):-1;
   if(firstBatch<0)queue.push(entry);else queue.splice(firstBatch,0,entry);
   signal.addEventListener('abort',cancel,{once:true});
  });
 }
 const embed=async(texts,{query=false,signal}={})=>{
  if(!Array.isArray(texts)||!texts.length||texts.length>64||texts.some(t=>typeof t!=='string')||texts.reduce((n,t)=>n+t.length+(query?queryPrefix.length:0),0)>maxInputChars)throw new Error('Embedding input exceeds bounds');
  if(signal?.aborted)throw new Error('Embedding cancelled');
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);let release;
  const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('Embedding cancelled')),{once:true}));
  // Install a handler even when cancellation happens while acquiring a queued slot.
  cancelled.catch(()=>{});
  try{
   release=await acquire(query,controller.signal);
   if(controller.signal.aborted)throw new Error();
   const request=async()=>{
   const response=await fetchImpl(endpoint.href,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({model,input:texts.map(t=>query?queryPrefix+t:t)})});
   if(controller.signal.aborted)throw new Error();
   if(!response.ok||response.redirected)throw new Error();
   if(Number(response.headers?.get('content-length'))>maxResponseBytes)throw new Error();
   const reader=response.body?.getReader();if(!reader)throw new Error();
   let size=0;const chunks=[];
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxResponseBytes||controller.signal.aborted)throw new Error();chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
   const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!Array.isArray(parsed.data)||parsed.data.length!==texts.length)throw new Error();
   const rows=[...parsed.data].sort((a,b)=>a.index-b.index);
   if(rows.some((r,i)=>r.index!==i))throw new Error();
   const vectors=rows.map(r=>normalizeTicketVector(r.embedding));
   if(controller.signal.aborted||vectors.some(v=>v.length!==vectors[0].length)||(dimensions!==null&&vectors[0].length!==dimensions))throw new Error();dimensions=vectors[0].length;
   return vectors;
   };
   return await Promise.race([request(),cancelled]);
  }catch{const cancelled=controller.signal.aborted;controller.abort();throw new Error(cancelled?'Embedding cancelled or timed out':'Embedding request failed');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);release?.();}
 };
 embed.modelFingerprint=createHash('sha256').update(JSON.stringify([endpoint.href,model,queryPrefix])).digest('hex');
 return embed;
}
