// No PID-based stale-lock deletion. A killed owner leaves evidence for manual maintenance.
import {mkdirSync,lstatSync,readFileSync,writeFileSync,rmSync,rmdirSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {sha256,syncDirectory} from './release-trust.mjs';
import {UpdateError} from './update-errors.mjs';
function privateParent(dir){
 mkdirSync(dir,{recursive:true,mode:0o700});const st=lstatSync(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o022)||st.uid!==(process.getuid?.()??st.uid))throw new UpdateError(`Unsafe update lock parent: ${dir}`);
}
export function acquireLock(file,{transactionId=randomUUID(),now=Date.now}={}){
 mkdirSync(path.dirname(file),{recursive:true,mode:0o700});privateParent(realpathSync(path.dirname(file)));file=path.join(realpathSync(path.dirname(file)),path.basename(file));const token=randomUUID();
 try{mkdirSync(file,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new UpdateError(`Update lock already exists: ${file}. No automatic stale-lock breaking. Establish that no updater or child remains active, preserve the lock and journal, then move the lock aside manually (legacy file locks included).`);throw e;}
 const identity=lstatSync(file),owner=path.join(file,'owner.json');
 // Failure after mkdir deliberately leaves a closed lock with missing metadata.
 writeFileSync(owner,JSON.stringify({schemaVersion:1,token,pid:process.pid,at:new Date(now()).toISOString(),transactionId})+'\n',{flag:'wx',mode:0o600});syncDirectory(file);syncDirectory(path.dirname(file));
 return ()=>{
  let st,doc;try{st=lstatSync(file);doc=JSON.parse(readFileSync(owner,'utf8'));}catch{return;}
  if(st.dev!==identity.dev||st.ino!==identity.ino||doc.token!==token)return;
  rmSync(owner);rmdirSync(file);syncDirectory(path.dirname(file));
 };
}
function canonicalName(dir){try{return realpathSync(dir);}catch(e){if(e.code!=='ENOENT')throw e;return path.join(canonicalName(path.dirname(dir)),path.basename(dir));}}
export function sourceLockPath(dir){
 const canonical=canonicalName(path.resolve(dir)),registry=path.join(['darwin','linux'].includes(process.platform)?'/tmp':os.tmpdir(),`home-hub-updater-${process.getuid?.()??'user'}`);privateParent(registry);
 return path.join(registry,sha256(Buffer.from(canonical))+'.lock');
}
export function acquireSourceLocks(sources,options){
 const names=[...new Set(sources.flatMap(s=>{const dir=s.dir??s,locks=[sourceLockPath(dir)];try{const dot=path.join(canonicalName(path.resolve(dir)),'.git');let common=lstatSync(dot).isDirectory()?dot:path.resolve(dir,readFileSync(dot,'utf8').trim().replace(/^gitdir: /,''));try{common=path.resolve(common,readFileSync(path.join(common,'commondir'),'utf8').trim());}catch(e){if(e.code!=='ENOENT')throw e;}locks.push(sourceLockPath(common));}catch(e){if(e.code!=='ENOENT')throw e;}return locks;}))].sort(),held=[];
 try{for(const file of names)held.push(acquireLock(file,options));}catch(e){for(const release of held.reverse())release();throw e;}
 return ()=>{for(const release of held.reverse())release();};
}
