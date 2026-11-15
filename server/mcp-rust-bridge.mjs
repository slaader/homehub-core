// Experimental, opt-in business bridge. It is never imported by the normal HTTP endpoint.
// No JSON-RPC parsing here: Rust sends sequential already-dispatched operations.
import net from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {mkdir,lstat,chmod,unlink} from 'node:fs/promises';
import {apiBearerOf} from './access-store.mjs';

export const RUST_MCP_LIMITS=Object.freeze({requestBytes:128*1024,responseBytes:16*1024*1024,connections:128,timeoutMs:30_000});
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fault=(code,message)=>({ok:false,error:{code,message}});

/**
 * Embeds in the SAME process/store/registry as the Node endpoint.
 * business = createMcpBusiness(the exact options passed to createMcp).
 * accessStore = that running hub's existing access store (not a second file-backed instance).
 * No credential/principal/scope caching; normal verifyKey runs for every IPC operation.
 * Directory must be owned by the process user with mode 0700. Socket is mode 0600.
 * Caller owns directory cleanup; close() destroys sockets and unlinks only this listener's socket.
 */
export async function createRustMcpBridge({socketPath,accessStore,business,limits={}}){
 if(!path.isAbsolute(socketPath||'')||Buffer.byteLength(socketPath)>100)throw new Error('Use an absolute Unix socket path of at most 100 bytes.');
 if(typeof accessStore?.verifyKey!=='function'||!['catalog','initialize','callTool'].every(k=>typeof business?.[k]==='function'))throw new Error('A live access store and MCP business factory are required.');
 const bounds={...RUST_MCP_LIMITS,...limits};
 if(Object.keys(limits).some(k=>!Object.hasOwn(RUST_MCP_LIMITS,k))||Object.values(bounds).some(v=>!Number.isSafeInteger(v)||v<1)||Object.entries(bounds).some(([k,v])=>v>RUST_MCP_LIMITS[k]))throw new Error('Limits may only lower the default bounds.');
 const directory=path.dirname(socketPath);
 try{await mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const dir=await lstat(directory);
 if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077)!==0)throw new Error('The socket directory must be private (0700) and owned by this user.');
 try{await lstat(socketPath);throw new Error('Socket path already exists; refusing to replace it.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const sockets=new Set();let closed=false,identity,executions=0;
 async function execute(input){
  if(!plain(input)||(input.persistent!==undefined&&typeof input.persistent!=='boolean')||(input.catalogRevision!==undefined&&(typeof input.catalogRevision!=='string'||!/^([a-f0-9]{64})$/.test(input.catalogRevision)))||input.v!==1||typeof input.operation!=='string'||Object.keys(input).some(k=>!['v','operation','authorization','name','arguments','persistent','catalogRevision'].includes(k)))return fault(-32600,'Invalid bridge request');
  // Take no principal supplied by Rust. Re-resolve account disable/revoke/scope changes live.
  const token=apiBearerOf(input.authorization),principal=token?accessStore.verifyKey(token):null;
  if(principal?.authKind!=='api-key')return {ok:false,status:401};
  try{
   switch(input.operation){
    case 'authenticate':return {ok:true};
    case 'initialize':return {ok:true,result:await business.initialize(principal)};
    case 'list':{
     const tools=await business.catalog();
     const serialized=JSON.stringify(tools);
     const revision=createHash('sha256').update(serialized).digest('hex');
     return {ok:true,result:{scopes:principal.scopes,revision,...(input.catalogRevision===revision?{}:{tools:JSON.parse(serialized)})}};
    }
    case 'lookup':{
     if(typeof input.name!=='string')return fault(-32602,'Invalid tool name');
     return {ok:true,result:{known:(await business.catalog()).some(tool=>tool.name===input.name)}};
    }
    case 'call':{
     if(typeof input.name!=='string'||!plain(input.arguments))return fault(-32602,'Invalid tool call');
     return {ok:true,result:await business.callTool(input.name,input.arguments,principal)};
    }
    default:return fault(-32601,'Unknown bridge operation');
   }
  }catch(e){return fault(Number.isInteger(e?.code)?e.code:-32603,Number.isInteger(e?.code)?e.message:'Internal error');}
 }
 const server=net.createServer(socket=>{
  if(closed||sockets.size>=bounds.connections||executions>=bounds.connections){socket.destroy();return;}
  sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
  let deadline;const arm=()=>{clearTimeout(deadline);deadline=setTimeout(()=>socket.destroy(),bounds.timeoutMs);deadline.unref();};arm();socket.once('close',()=>clearTimeout(deadline));
  let expected=null,buffer,length=0,header=Buffer.alloc(0),dispatched=false;
  socket.on('data',chunk=>{
   if(dispatched){socket.destroy();return;}
   if(expected===null){
    const needed=4-header.length;
    header=Buffer.concat([header,chunk.subarray(0,needed)]);chunk=chunk.subarray(needed);
    if(header.length<4)return;
    expected=header.readUInt32BE();
    if(expected<1||expected>bounds.requestBytes){socket.destroy();return;}
    buffer=Buffer.allocUnsafe(expected);
   }
   length+=chunk.length;
   if(length>expected){socket.destroy();return;}
   chunk.copy(buffer,length-chunk.length);if(length!==expected)return;
   dispatched=true;socket.pause();arm();
   let input;try{input=JSON.parse(buffer.toString('utf8'));}catch{socket.destroy();return;}
   buffer=null;
   // The execution is not cancelled by a disconnected client; a write may already have happened.
   // Never retry it here. The caller must inspect state before retrying after a timeout.
   // Sockets accepted before other clients disconnected must pass admission again.
   if(executions>=bounds.connections){socket.destroy();return;}
   executions++;
   execute(input).then(output=>{
    if(socket.destroyed)return;
    let bytes;try{bytes=Buffer.from(JSON.stringify(output));}catch{bytes=Buffer.from(JSON.stringify(fault(-32603,'Internal error')));}
    if(bytes.length>bounds.responseBytes)bytes=Buffer.from(JSON.stringify(fault(-32603,'Bridge response exceeds configured limit')));
    if(bytes.length>bounds.responseBytes){socket.destroy();return;}
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(bytes.length);
    const frame=Buffer.concat([prefix,bytes]);
    if(input.persistent===true){
     socket.write(frame,()=>{
      if(socket.destroyed)return;
      expected=null;buffer=null;length=0;header=Buffer.alloc(0);dispatched=false;arm();socket.resume();
     });
    }else socket.end(frame,()=>socket.destroy());
   }).catch(()=>socket.destroy()).finally(()=>{executions--;});
  });
 });
 // A race with another process in the private directory is not an authorization boundary:
 // same-user processes can already read the socket's bearer requests and the hub's private files.
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});
  identity=await lstat(socketPath);await chmod(socketPath,0o600);
 }catch(e){server.close();if(identity)await unlink(socketPath).catch(()=>{});throw e;}
 server.on('error',()=>{for(const socket of sockets)socket.destroy();});
 return Object.freeze({socketPath,limits:Object.freeze(bounds),async close(){
  if(closed)return;closed=true;
  for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>server.close(resolve));
  const current=await lstat(socketPath).catch(()=>null);
  if(current?.ino===identity.ino&&current?.dev===identity.dev)await unlink(socketPath);
 }});
}
