import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRustMcpBridge} from '../../server/mcp-rust-bridge.mjs';

export const rustBinary=fileURLToPath(new URL('../../experimental/rust-mcp/target/release/home-hub-rust-mcp',import.meta.url));
export async function rustFrontend(h,{binary=rustBinary}={}){
 const bridge=await createRustMcpBridge({socketPath:path.join(h.dir,'ipc','bridge.sock'),accessStore:h.handler.hub.accessStore,business:h.handler.mcpBusiness});
 const child=spawn(binary,['--socket',bridge.socketPath],{stdio:['ignore','pipe','pipe']});
 let stderr='',closed=false;child.stderr.on('data',d=>{stderr+=d;});
 const lines=createInterface({input:child.stdout});
 async function close(){if(closed)return;closed=true;lines.close();if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}await bridge.close();}
 try{
  const ready=await Promise.race([once(lines,'line').then(([line])=>JSON.parse(line)),once(child,'error').then(([e])=>{throw e;}),once(child,'exit').then(()=>{throw new Error('Rust frontend exited before readiness');})]);
  if(ready.event!=='listening')throw new Error('Rust frontend did not listen');
  return {origin:ready.origin,pid:child.pid,close,stderr:()=>stderr};
 }catch(e){await close();throw e;}
}
