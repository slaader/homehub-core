import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm,lstat,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAccessStore} from '../../../server/access-store.mjs';
import {createRustMcpBridge,RUST_MCP_LIMITS} from '../../../server/mcp-rust-bridge.mjs';

// These are bridge-boundary tests, not replacements for the parent's real-business comparison.
export async function fixture(t,limits={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'rmcp-'));
 const store=createAccessStore(dir,{});let bridge;const calls=[];
 t.after(async()=>{await bridge?.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25});});
 const account=await store.createAccount({name:'experiment-reader',scopes:[]});
 const issued=await store.issueAccountKey({accountId:account.account.id});
 const tools=[{name:'extension_read',scope:'read',description:'test extension',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'extension_write',scope:'tickets:write',annotations:{readOnlyHint:false}}];
 const business={catalog:()=>tools,initialize:principal=>({serverInfo:{name:'home-hub',title:'Home Hub',version:'test'},instructions:`Live ${principal.username}`}),
  callTool:async(name,args,principal)=>{calls.push({name,args,principal});if(name==='throw')throw new Error('private error');if(name==='unknown')throw Object.assign(new Error('Unknown tool: unknown'),{code:-32602});return {content:[{type:'text',text:'test'}],structuredContent:{name,args,username:principal.username},isError:false};}};
 bridge=await createRustMcpBridge({socketPath:path.join(dir,'ipc','bridge.sock'),accessStore:store,business,limits});
 return {dir,store,account:account.account,issued,bridge,calls,business,authorization:'Bearer '+issued.token};
}
export function rpc(socketPath,input,{split=false}={}){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(socketPath);const chunks=[];
  socket.setTimeout(2000,()=>socket.destroy(new Error('test deadline')));
  socket.on('error',reject);socket.on('data',data=>chunks.push(data));
  socket.on('end',()=>{try{const buffer=Buffer.concat(chunks);assert.equal(buffer.readUInt32BE(),buffer.length-4);resolve(JSON.parse(buffer.subarray(4)));}catch(e){reject(e);}});
  socket.on('connect',()=>{const raw=Buffer.from(JSON.stringify(input));const header=Buffer.alloc(4);header.writeUInt32BE(raw.length);
   if(split){socket.write(header.subarray(0,2));setImmediate(()=>{socket.write(header.subarray(2));socket.write(raw.subarray(0,1));setImmediate(()=>socket.write(raw.subarray(1)));});}
   else socket.write(Buffer.concat([header,raw]));});
 });
}
