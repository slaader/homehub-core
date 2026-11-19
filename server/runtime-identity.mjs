import {randomUUID,createHash} from 'node:crypto';
import {lstatSync,readdirSync,openSync,readSync,closeSync,readlinkSync,existsSync,realpathSync} from 'node:fs';
import path from 'node:path';
export const READINESS_PROTOCOL=1;
export const bootId=randomUUID();
const pluginIdentities=new WeakMap();
export function rememberPluginIdentity(module,identity){pluginIdentities.set(module,identity);return module;}
function hashFile(hash,file){
 const fd=openSync(file,'r'),buffer=Buffer.allocUnsafe(65536);
 try{
  let count;
  while((count=readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,count));
 }finally{closeSync(fd);}
}
export function contentFingerprint(directory){
 const hash=createHash('sha256');const visit=(file,rel)=>{const st=lstatSync(file);hash.update(rel+'\0'+(st.mode&0o777)+'\0');if(st.isSymbolicLink())hash.update('link\0'+readlinkSync(file));else if(st.isDirectory()){hash.update('dir\0');for(const name of readdirSync(file).sort())if(!['.git','node_modules'].includes(name))visit(path.join(file,name),rel?rel+'/'+name:name);}else if(st.isFile()){hash.update('file\0');hashFile(hash,file);}else hash.update('special\0'+(st.mode&0o170000));};visit(directory,'');return hash.digest('hex');
}
export function pluginSourceFingerprint(directory){
 const parent=path.dirname(directory),pkg=path.join(parent,'package.json');
 const source=existsSync(pkg)&&realpathSync(pkg)!==realpathSync(new URL('../package.json',import.meta.url))?parent:directory;
 return contentFingerprint(source);
}
export function loadedPluginIdentities(plugins){return plugins.map(p=>({id:p.id,...(p.version?{version:p.version}:{}),...(pluginIdentities.get(p)??(p.directory&&existsSync(path.dirname(p.directory))?{fingerprint:contentFingerprint(path.dirname(p.directory))}:{}))})).sort((a,b)=>a.id.localeCompare(b.id));}
export function runtimeIdentity({version,plugins=[],pid=process.pid,now=Date.now(),runId=bootId}){return {version:version.version,commit:version.commit,exact:version.exact,dataEpoch:version.dataEpoch,pid,startedAt:new Date(now).toISOString(),plugins:loadedPluginIdentities(plugins),readinessProtocol:READINESS_PROTOCOL,bootId:runId,fullCommit:version.fullCommit??null,packageDigest:version.packageDigest??null};}
