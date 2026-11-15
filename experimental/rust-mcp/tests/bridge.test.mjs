import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {lstat,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRustMcpBridge,RUST_MCP_LIMITS} from '../../../server/mcp-rust-bridge.mjs';
import {fixture,rpc} from './bridge-fixture.mjs';

test('bridge authenticates with the normal live store and takes no caller principal',async t=>{
 const f=await fixture(t);const send=(extra)=>rpc(f.bridge.socketPath,{v:1,operation:'authenticate',authorization:f.authorization,...extra});
 assert.deepEqual(await send({}),{ok:true});
 assert.equal((await send({principal:{scopes:['*']}})).ok,false);
 assert.deepEqual(await send({authorization:'Bearer hhk_'+'0'.repeat(64)}),{ok:false,status:401});
 await f.store.updateAccount({id:f.account.id,disabled:true});
 assert.deepEqual(await send({}),{ok:false,status:401});
 await f.store.updateAccount({id:f.account.id,disabled:false});
 assert.deepEqual(await send({}),{ok:true});
 await f.store.revokeKey({id:f.issued.key.id});
 assert.deepEqual(await send({}),{ok:false,status:401});
});

test('catalog includes extensions and updated scopes; call gets a server-resolved principal',async t=>{
 const f=await fixture(t);const send=(operation,more={})=>rpc(f.bridge.socketPath,{v:1,operation,authorization:f.authorization,...more},{split:true});
 assert.deepEqual((await send('list')).result.scopes,['read']);
 await f.store.updateAccount({id:f.account.id,scopes:['tickets:write']});
 const listed=await send('list');assert.deepEqual(listed.result.tools,f.business.catalog());assert.ok(listed.result.scopes.includes('tickets:write'));
 const call=await send('call',{name:'extension_read',arguments:{a:1}});assert.equal(call.result.isError,false);assert.equal(f.calls[0].principal.authKind,'api-key');assert.equal(f.calls[0].principal.accountId,f.account.id);
 assert.deepEqual((await send('call',{name:'throw',arguments:{}})).error,{code:-32603,message:'Internal error'});
 assert.deepEqual((await send('call',{name:'unknown',arguments:{}})).error,{code:-32602,message:'Unknown tool: unknown'});
 assert.equal((await send('initialize')).result.instructions,'Live experiment-reader');
});

test('private socket and directory; refuses existing files and loose directories',async t=>{
 const f=await fixture(t);
 assert.equal((await lstat(f.bridge.socketPath)).mode&0o777,0o600);
 assert.equal((await lstat(path.dirname(f.bridge.socketPath))).mode&0o777,0o700);
 await assert.rejects(createRustMcpBridge({socketPath:f.bridge.socketPath,accessStore:f.store,business:f.business}),/already exists/);
 const loose=path.join(f.dir,'loose');await mkdir(loose,{mode:0o755});
 await assert.rejects(createRustMcpBridge({socketPath:path.join(loose,'x.sock'),accessStore:f.store,business:f.business}),/private/);
 await assert.rejects(createRustMcpBridge({socketPath:path.join(f.dir,'ipc','x.sock'),accessStore:f.store,business:f.business,limits:{connections:129}}),/lower/);
 const existing=path.join(f.dir,'ipc','existing');await writeFile(existing,'keep');
 await assert.rejects(createRustMcpBridge({socketPath:existing,accessStore:f.store,business:f.business}),/already exists/);
});

test('repeated one-shot IPC requests release connection slots',async t=>{
 const f=await fixture(t,{connections:2});
 for(let i=0;i<40;i++)assert.deepEqual(await rpc(f.bridge.socketPath,{v:1,operation:'authenticate',authorization:f.authorization}),{ok:true});
});

test('oversized frames are refused without an allocation or execution',async t=>{
 const f=await fixture(t);await new Promise((resolve,reject)=>{
  const socket=net.createConnection(f.bridge.socketPath);socket.on('error',reject);socket.on('close',resolve);
  socket.on('connect',()=>{const size=Buffer.alloc(4);size.writeUInt32BE(RUST_MCP_LIMITS.requestBytes+1);socket.write(size);});
 });assert.equal(f.calls.length,0);
});

test('response cap returns a safe error and close releases the socket path',async t=>{
 const f=await fixture(t,{responseBytes:200});f.business.catalog=()=>[{name:'long',description:'x'.repeat(500)}];
 assert.deepEqual((await rpc(f.bridge.socketPath,{v:1,operation:'list',authorization:f.authorization})).error,{code:-32603,message:'Bridge response exceeds configured limit'});
 await f.bridge.close();await assert.rejects(lstat(f.bridge.socketPath),{code:'ENOENT'});await f.bridge.close();
});

test('timed-out execution still occupies its slot and is never retried',async t=>{
 const f=await fixture(t,{connections:1,timeoutMs:40});let entered,finish;
 const started=new Promise(resolve=>{entered=resolve;});const pending=new Promise(resolve=>{finish=resolve;});let count=0;
 f.business.callTool=async()=>{count++;entered();await pending;return {isError:false,content:[]};};
 const first=rpc(f.bridge.socketPath,{v:1,operation:'call',authorization:f.authorization,name:'slow',arguments:{}});
 const refused=assert.rejects(first);await started;await refused;
 await assert.rejects(rpc(f.bridge.socketPath,{v:1,operation:'call',authorization:f.authorization,name:'slow',arguments:{}}));
 assert.equal(count,1);finish();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(await rpc(f.bridge.socketPath,{v:1,operation:'authenticate',authorization:f.authorization}),{ok:true});
});

test('persistent connection reauthenticates each frame and catalog revisions follow mutations',async t=>{
 const f=await fixture(t);const socket=net.createConnection(f.bridge.socketPath);t.after(()=>socket.destroy());
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
 const send=extra=>new Promise((resolve,reject)=>{
  let buffer=Buffer.alloc(0);const timer=setTimeout(()=>done(new Error('frame deadline')),2000);
  const done=(error,value)=>{clearTimeout(timer);socket.off('data',data);socket.off('error',fail);error?reject(error):resolve(value);};
  const fail=e=>done(e);const data=chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>=4&&buffer.length===buffer.readUInt32BE()+4)done(null,JSON.parse(buffer.subarray(4)));};
  socket.on('data',data);socket.once('error',fail);
  const raw=Buffer.from(JSON.stringify({v:1,persistent:true,operation:'list',authorization:f.authorization,...extra}));const prefix=Buffer.alloc(4);prefix.writeUInt32BE(raw.length);socket.write(Buffer.concat([prefix,raw]));
 });
 const first=await send({});assert.ok(first.result.tools.length);const revision=first.result.revision;
 const cached=await send({catalogRevision:revision});assert.equal(cached.result.revision,revision);assert.equal(cached.result.tools,undefined);
 await f.store.updateAccount({id:f.account.id,scopes:['tickets:write']});
 assert.ok((await send({catalogRevision:revision})).result.scopes.includes('tickets:write'));
 f.business.catalog().push({name:'new_extension',scope:'read'});
 const changed=await send({catalogRevision:revision});assert.notEqual(changed.result.revision,revision);assert.equal(changed.result.tools.at(-1).name,'new_extension');
 await f.store.revokeKey({id:f.issued.key.id});assert.deepEqual(await send({catalogRevision:revision}),{ok:false,status:401});
});
