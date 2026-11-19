// A caller chooses a trusted driver. Keep those exact executable bytes alongside the recovery journal.
import {lstatSync,readdirSync,mkdirSync,copyFileSync,openSync,closeSync,fsyncSync,renameSync,rmSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileHash,canonical} from './update-backup.mjs';
import {withinPath,DRIVER_CAPABILITIES} from './backup-policy.mjs';
import {syncDirectory} from './release-trust.mjs';

const closure=['package.json','public','scripts','server'];
function digestTree(root,destination=null){
 const hash=createHash('sha256');
 function walk(relative){
  const abs=path.join(root,relative),st=lstatSync(abs),mode=st.mode&0o777;
  if(st.isDirectory()){
   if(destination)mkdirSync(path.join(destination,relative),{mode:0o700});
   for(const name of readdirSync(abs).sort())walk(path.join(relative,name));
   if(destination)syncDirectory(path.join(destination,relative));
  }else{
   if(!st.isFile()||st.mode&0o7000)throw new Error(`unsupported retained driver entry: ${relative}`);
   hash.update(JSON.stringify([relative,mode,fileHash(abs)])+'\n');
   if(destination){
    const file=path.join(destination,relative);
    copyFileSync(abs,file);chmodSync(file,mode);
    const fd=openSync(file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
   }
  }
 }
 for(const name of closure)walk(name);
 return hash.digest('hex');
}

export function retainDriver(inst,journal,source,{version,commit}){
 const parent=inst.home?path.join(inst.home,'update','drivers'):path.join(inst.backups,'drivers');
 const driver=path.join(parent,journal.id+'-'+randomUUID()),temp=driver+'.tmp';
 const resolved=canonical(driver),driverSource=canonical(source);
 if(withinPath(resolved,driverSource)&&closure.some(name=>withinPath(resolved,path.join(driverSource,name))))throw new Error('driver retention overlaps the executable tree');
 mkdirSync(parent,{recursive:true,mode:0o700});
 const parentStat=lstatSync(parent);
 if(!parentStat.isDirectory()||parentStat.uid!==process.getuid()||(parentStat.mode&0o077))throw new Error('retained driver parent must be owner-only');
 mkdirSync(temp,{mode:0o700});
 try{
  const treeSha256=digestTree(driverSource,temp);
  if(treeSha256!==digestTree(temp))throw new Error('retained driver differs from its source');
  syncDirectory(temp);renameSync(temp,driver);syncDirectory(parent);
  journal.driver=driver;
  journal.driverInfo={version,commit,treeSha256,capabilities:[...DRIVER_CAPABILITIES]};
 }finally{rmSync(temp,{recursive:true,force:true});}
}

export function checkRetainedDriver(journal){
 if(!journal.driverInfo)return;
 const {driver,driverInfo}=journal;
 try{
  const st=lstatSync(driver);
  if(!st.isDirectory()||st.mode&0o077||st.uid!==process.getuid()||digestTree(driver)!==driverInfo.treeSha256)
   throw new Error('retained driver does not match its recovery record');
 }catch(e){throw new Error(`Invalid retained updater driver at ${driver}: ${e.message}`);}
}
