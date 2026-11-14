import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTicketEmbedder} from '../server/ticket-embeddings.mjs';
test('provider validates endpoints and normalizes ordered vectors',async()=>{
 for(const url of ['http://example.com','https://alice:secret@example.com','file:///tmp/example','https://example.com/#fragment'])assert.throws(()=>createTicketEmbedder({url,model:'test'}));
 let request;const embed=createTicketEmbedder({url:'http://127.0.0.1:1234/v1/embeddings',model:'test',queryPrefix:'Query: ',fetchImpl:async(u,r)=>{request=r;return new Response(JSON.stringify({data:[{index:0,embedding:[3,4]}]}));}});
 assert.deepEqual(await embed(['hello'],{query:true}),[[.6,.8]]);assert.equal(JSON.parse(request.body).input[0],'Query: hello');assert.equal(request.redirect,'error');
});
test('provider bounds response and hides provider errors',async()=>{
 const embed=createTicketEmbedder({url:'https://example.com/v1/embeddings',model:'test',maxResponseBytes:10,fetchImpl:async()=>new Response('secret provider text')});await assert.rejects(embed(['hello']),/^Error: Embedding request failed$/);
});

test('provider queues a normal concurrent burst within bounds and cancels queued work',async()=>{
 let active=0,peak=0,calls=0;
 const embed=createTicketEmbedder({url:'http://127.0.0.1:1234/v1/embeddings',model:'test',maxConcurrency:1,fetchImpl:async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return new Response(JSON.stringify({data:[{index:0,embedding:[1,0]}]}));}});
 const first=embed(['first']),controller=new AbortController(),cancelled=embed(['cancelled'],{signal:controller.signal});controller.abort();await assert.rejects(cancelled,/cancelled/);
 const burst=Array.from({length:8},()=>embed(['question'],{query:true}));await first;const vectors=await Promise.all(burst);assert.equal(vectors.length,8);assert.equal(peak,1);assert.equal(calls,9);
});

test('timeout releases the provider slot even when a transport ignores cancellation',async()=>{
 let calls=0;const embed=createTicketEmbedder({url:'http://127.0.0.1:1234/v1/embeddings',model:'test',timeoutMs:10,maxConcurrency:1,fetchImpl:async()=>++calls===1?new Promise(()=>{}):new Response(JSON.stringify({data:[{index:0,embedding:[1,0]}]}))});
 await assert.rejects(embed(['hung']),/timed out/);assert.deepEqual(await embed(['recovered']),[[1,0]]);
});
