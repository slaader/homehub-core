// Operator-owned trust. Nothing downloaded or restored is allowed to supply these roots.
import {readFileSync,lstatSync,realpathSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createPublicKey,createHash,verify,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {validRepo} from './version.mjs';
import {compare,parse} from './semver.mjs';
export const TRUST_SCHEMA=1;
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const within=(child,parent)=>child===parent||child.startsWith(parent+path.sep);
export function durableWrite(file,bytes,mode=0o600){
 mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${randomUUID()}.tmp`;let fd;
 try{fd=openSync(tmp,'wx',mode);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,file);syncDirectory(path.dirname(file));}finally{if(fd!==undefined)closeSync(fd);rmSync(tmp,{force:true});}
}
export function syncDirectory(dir){let fd;try{fd=openSync(dir,'r');fsyncSync(fd);}catch(e){if(!['EINVAL','ENOTSUP','EISDIR','EBADF'].includes(e.code))throw e;}finally{if(fd!==undefined)closeSync(fd);}}
// A small JSON recognizer rejects duplicate names before JSON.parse can discard evidence.
export function strictJson(bytes,{limit=8*1024*1024}={}){
 if(bytes.length>limit)throw new Error('JSON exceeds local byte limit');const s=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let i=0;const literal=/(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
 const ws=()=>{while(/[\t\n\r ]/.test(s[i]??'x'))i++;};
 const string=()=>{const start=i++;while(i<s.length){if(s[i]==='"'){i++;return JSON.parse(s.slice(start,i));}if(s[i]==='\\')i++;i++;}throw new Error('unterminated JSON string');};
 const value=()=>{ws();if(s[i]==='{'){i++;ws();const seen=new Set();if(s[i]==='}'){i++;return;}for(;;){ws();if(s[i]!=='"')throw new Error('invalid JSON object');const key=string();if(seen.has(key))throw new Error(`duplicate JSON key: ${key}`);seen.add(key);ws();if(s[i++]!==':')throw new Error('invalid JSON colon');value();ws();const c=s[i++];if(c==='}')return;if(c!==',')throw new Error('invalid JSON object');}}
 if(s[i]==='['){i++;ws();if(s[i]===']'){i++;return;}for(;;){value();ws();const c=s[i++];if(c===']')return;if(c!==',')throw new Error('invalid JSON array');}}
 if(s[i]==='"'){string();return;}literal.lastIndex=i;const m=literal.exec(s);if(!m)throw new Error('invalid JSON value');i+=m[0].length;};value();ws();if(i!==s.length)throw new Error('trailing JSON content');return JSON.parse(s);
}
export function fields(value,names,where){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k)))throw new Error(`invalid ${where} fields`);}
export function publicKey(pem){if(typeof pem!=='string'||!/-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem)||pem.includes('PRIVATE KEY'))throw new Error('package trust requires a public SPKI key');const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw new Error('only Ed25519 package keys are supported');const der=key.export({type:'spki',format:'der'});return {key,id:sha256(der)};}
export function gitPublicKey(text){
 if(typeof text!=='string')throw new Error('Git signer must be an SSH Ed25519 public key');const m=/^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(text.trim());if(!m)throw new Error('only SSH Ed25519 Git signer keys are supported');const blob=Buffer.from(m[1],'base64');if(blob.toString('base64')!==m[1]||blob.length!==51||blob.readUInt32BE(0)!==11||blob.subarray(4,15).toString()!=='ssh-ed25519'||blob.readUInt32BE(15)!==32)throw new Error('invalid SSH public key encoding');return {line:'ssh-ed25519 '+m[1],id:sha256(blob),fingerprint:'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,'')};
}
export const TRUST_REQUIREMENT_SCHEMA=1;
export function canonicalPath(value){const full=path.resolve(value);try{return realpathSync(full);}catch(e){if(e.code!=='ENOENT')throw e;return path.join(canonicalPath(path.dirname(full)),path.basename(full));}}
function present(file){try{lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export function selectTrustFile({home,explicit=null}={}){
 if(explicit!==null&&explicit!==undefined){if(typeof explicit!=='string'||!explicit)throw new Error('explicit trust path is empty');return path.resolve(explicit);}
 if(!home)return null;const marker=path.join(home,'update','trust-required.json');
 if(present(marker)){const doc=strictJson(readFileSync(marker),{limit:16384});fields(doc,['schemaVersion','file'],'trust requirement');if(doc.schemaVersion!==TRUST_REQUIREMENT_SCHEMA||typeof doc.file!=='string'||!path.isAbsolute(doc.file))throw new Error('invalid trust requirement; refusing legacy fallback');return doc.file;}
 const candidate=path.join(home,'update','trust.json');return present(candidate)?candidate:null;
}
export function rememberTrustSelection(home,file){if(!home)return;const marker=path.join(home,'update','trust-required.json');trustDestination(marker);durableWrite(marker,JSON.stringify({schemaVersion:TRUST_REQUIREMENT_SCHEMA,file:canonicalPath(file)})+'\n');}
export function trustDestination(file,{forbidden=[]}={}){
 const named=path.resolve(file);let parent=path.dirname(named),suffix=[];
 while(true){try{lstatSync(parent);break;}catch(e){if(e.code!=='ENOENT')throw e;suffix.unshift(path.basename(parent));parent=path.dirname(parent);}}
 const resolved=path.join(realpathSync(parent),...suffix,path.basename(named));for(const root of forbidden)if(root&&within(resolved,canonicalPath(root)))throw new Error(`trust must be outside replaced/restored root: ${root}`);
 let dir=realpathSync(parent);while(dir!==path.dirname(dir)){const st=lstatSync(dir);if((st.mode&0o022)||![0,process.getuid?.()??st.uid].includes(st.uid))throw new Error(`unsafe trust parent permissions/ownership: ${dir}`);dir=path.dirname(dir);}return resolved;
}
export function validateTrust(doc){
 fields(doc,['schemaVersion','publishers'],'trust');if(doc.schemaVersion!==TRUST_SCHEMA)throw new Error('unsupported trust schema');fields(doc.publishers,Object.keys(doc.publishers??{}),'publishers');
 const seen=new Map();for(const [repo,pub] of Object.entries(doc.publishers)){
  if(!validRepo(repo))throw new Error('invalid publisher repository');fields(pub,['gitSigners','packageKeys'],'publisher');
  for(const role of ['gitSigners','packageKeys']){if(!Array.isArray(pub[role]))throw new Error(`missing ${role}`);for(const record of pub[role]){
   fields(record,['id','publicKey','fingerprint','role','status','minimumVersion','maximumVersion','provenance'],'key');
   if(record.role!==(role==='packageKeys'?'package':'git')||!['active','revoked','retired'].includes(record.status))throw new Error('invalid key authorization');
   for(const bound of ['minimumVersion','maximumVersion'])if(record[bound]!==undefined&&!parse(record[bound]))throw new Error('invalid version bound');
   if(typeof record.publicKey!=='string'||record.publicKey.length>16384||typeof record.fingerprint!=='string')throw new Error('invalid public key');
   const parsed=role==='packageKeys'?{...publicKey(record.publicKey),fingerprint:publicKey(record.publicKey).id}:gitPublicKey(record.publicKey),id=parsed.id;
   if(record.id!==id||record.fingerprint!==parsed.fingerprint)throw new Error('key fingerprint mismatch');
   if(seen.has(id)&&seen.get(id)!==JSON.stringify(record))throw new Error('conflicting key ID');seen.set(id,JSON.stringify(record));
  }}
 }return doc;
}
export function loadTrust(file,{forbidden=[]}={}){
 trustDestination(file,{forbidden});const named=path.resolve(file),st=lstatSync(named);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o022)||st.uid!==(process.getuid?.()??st.uid))throw new Error('trust must be an owner-controlled regular file, not writable by other users');
 const real=realpathSync(named);for(const root of forbidden)if(root&&within(real,canonicalPath(root)))throw new Error(`trust must be outside replaced/restored root: ${root}`);
 // Parent directories must not permit another account to substitute the file.
 let dir=path.dirname(real);while(dir!==path.dirname(dir)){const p=lstatSync(dir);if(p.mode&0o022)throw new Error(`unsafe trust parent permissions: ${dir}`);dir=path.dirname(dir);}
 return validateTrust(strictJson(readFileSync(real),{limit:1024*1024}));
}
export function authorizedKeys(trust,repository,role,version){
 const records=trust.publishers[repository]?.[role==='package'?'packageKeys':'gitSigners']??[];
 return records.filter(k=>k.status==='active'&&(!k.minimumVersion||compare(version,k.minimumVersion)>=0)&&(!k.maximumVersion||compare(version,k.maximumVersion)<=0));
}
export const MANIFEST_DOMAIN=Buffer.from('home-hub-release-manifest-v1\n');
export function verifyManifestSignature(bytes,sidecar,trust,repository,version){
 fields(sidecar,['schemaVersion','algorithm','keyId','signature'],'signature');if(sidecar.schemaVersion!==1||sidecar.algorithm!=='ed25519'||!/^[0-9a-f]{64}$/.test(sidecar.keyId)||typeof sidecar.signature!=='string')throw new Error('invalid signature metadata');
 const sig=Buffer.from(sidecar.signature,'base64');if(sig.length!==64||sig.toString('base64')!==sidecar.signature)throw new Error('invalid canonical signature');
 const key=authorizedKeys(trust,repository,'package',version).find(k=>k.id===sidecar.keyId);if(!key)throw new Error('unknown or unauthorized package signing key');
 if(!verify(null,Buffer.concat([MANIFEST_DOMAIN,bytes]),publicKey(key.publicKey).key,sig))throw new Error('invalid package signature');return sidecar.keyId;
}
