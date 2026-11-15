import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {fixture} from './bridge-fixture.mjs';

const binary=process.env.RUST_MCP_BINARY||fileURLToPath(new URL('../target/debug/home-hub-rust-mcp',import.meta.url));
async function frontend(t,f){
 const child=spawn(binary,['--socket',f.bridge.socketPath],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',d=>{stderr+=d;});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}assert.equal(stderr,'');});
 const lines=createInterface({input:child.stdout});
 const ready=await Promise.race([once(lines,'line').then(([line])=>JSON.parse(line)),once(child,'error').then(([error])=>{throw error;}),once(child,'exit').then(()=>{throw new Error('Frontend exited before readiness');})]);
 assert.equal(ready.event,'listening');return ready.origin;
}
const msg=(method,params,id=1)=>JSON.stringify({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})});

test('Rust HTTP owns envelopes, notifications, catalog filtering and protocol negotiation',async t=>{
 const f=await fixture(t),origin=await frontend(t,f);
 const post=(body,headers={})=>fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:f.authorization,...headers},body});
 assert.equal((await post('{')).status,400);
 assert.equal((await (await post('{')).json()).error.code,-32700);
 assert.equal((await post('[]')).status,400);
 assert.equal((await post(msg('notifications/initialized',undefined,null))).status,202);
 assert.equal((await post(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))).status,202);
 assert.equal(f.calls.length,0,'Rust notifications never call business tools');
 assert.deepEqual((await (await post(msg('ping'))).json()).result,{});
 assert.equal((await (await post(msg('initialize',{protocolVersion:'2025-06-18'}))).json()).result.protocolVersion,'2025-06-18');
 assert.equal((await (await post(msg('initialize',{protocolVersion:'unknown'}))).json()).result.protocolVersion,'2025-11-25');
 const list=async()=>(await (await post(msg('tools/list'))).json()).result.tools;
 assert.deepEqual((await list()).map(t=>t.name),['extension_read']);assert.equal((await list())[0].annotations.readOnlyHint,true);assert.ok(!('scope'in (await list())[0]));
 await f.store.updateAccount({id:f.account.id,scopes:['tickets:write']});assert.deepEqual((await list()).map(t=>t.name),['extension_read','extension_write']);
 const out=await (await post(msg('tools/call',{name:'extension_read',arguments:{id:'APP-1'}}))).json();assert.equal(out.result.structuredContent.args.id,'APP-1');assert.equal(f.calls.length,1);
 assert.equal((await (await post(msg('resources/list'))).json()).error.code,-32601);
 assert.equal((await (await post(msg('tools/call',{name:'extension_read',arguments:[]}))).json()).error.message,'arguments must be an object');
 assert.equal((await (await post(msg('tools/call',{name:'absent',arguments:[]}))).json()).error.message,'Unknown tool: absent');
 assert.equal((await (await post(msg('tools/call',{name:'throw'}))).json()).error.message,'Internal error');
 await f.store.revokeKey({id:f.issued.key.id});assert.equal((await post(msg('ping'))).status,401);assert.equal((await post('{')).status,401);
});

test('HTTP method, origin, auth, content type and body limits',async t=>{
 const f=await fixture(t),origin=await frontend(t,f);
 assert.equal((await fetch(origin+'/mcp')).status,405);assert.equal((await fetch(origin+'/else')).status,404);
 const post=(body,headers={})=>fetch(origin+'/mcp',{method:'POST',headers:{Authorization:f.authorization,'Content-Type':'application/json',...headers},body});
 assert.equal((await post(msg('ping'),{Origin:'https://evil.example'})).status,403);
 assert.equal((await post(msg('ping'),{Authorization:''})).status,401);
 assert.equal((await post(msg('ping'),{'Content-Type':'text/plain'})).status,415);
 assert.equal((await post('x'.repeat(65_537))).status,413);
 assert.equal((await post('x'.repeat(65_537),{Authorization:''})).status,401);
 assert.equal((await post('x'.repeat(65_536))).status,400,'exact body limit reaches JSON parsing');
 await f.bridge.close();assert.equal((await post(msg('ping'))).status,503);
});

test('rejects browser DNS rebinding Host values',async t=>{
 const f=await fixture(t),origin=await frontend(t,f),url=new URL(origin);
 const raw=await new Promise((resolve,reject)=>{
  const socket=net.createConnection({host:url.hostname,port:Number(url.port)});const chunks=[];
  socket.on('error',reject);socket.on('data',d=>chunks.push(d));socket.on('end',()=>resolve(Buffer.concat(chunks).toString()));
  socket.on('connect',()=>socket.write('POST /mcp HTTP/1.1\r\nHost: evil.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
 });assert.match(raw,/HTTP\/1\.1 403/);
});

test('chunked bodies and oversized headers stay bounded before business execution',async t=>{
 const f=await fixture(t),origin=await frontend(t,f),url=new URL(origin);
 const send=raw=>new Promise((resolve,reject)=>{
  const socket=net.createConnection({host:url.hostname,port:Number(url.port)});const chunks=[];
  socket.setTimeout(3000,()=>socket.destroy(new Error('test deadline')));
  socket.on('error',error=>{if(error.code==='ECONNRESET')resolve(Buffer.concat(chunks).toString());else reject(error);});socket.on('data',d=>chunks.push(d));socket.on('end',()=>resolve(Buffer.concat(chunks).toString()));socket.on('connect',()=>socket.write(raw));
 });
 const body='x'.repeat(65_537);
 const chunked=await send(`POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nAuthorization: ${f.authorization}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
 assert.match(chunked,/HTTP\/1\.1 413/);
 const header=await send(`POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nX-Large: ${'x'.repeat(20_000)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
 assert.match(header,/HTTP\/1\.1 (431|400)/);assert.equal(f.calls.length,0);
});
