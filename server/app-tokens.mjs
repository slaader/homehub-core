import {mkdir,writeFile,rename,appendFile} from 'node:fs/promises';
import {readFileSync,writeFileSync,renameSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
// App tokens: long-lived bearer tokens for native clients (a phone app). Only SHA-256 hashes are stored, in
// state/app-tokens.json; what was issued and revoked is in state/app-tokens-audit.jsonl (metadata only).
// Schema 2 is {schemaVersion:2,tokens:[{id,name,createdAt,lastUsedAt,hash}]}. Schema 1 was the same list under
// another key in another file (LEGACY, below), written by 1.0.0; it is moved forward once, at start.
export const APP_TOKENS_SCHEMA=2;
export const maxAppTokens=20;
const FILE='app-tokens.json',AUDIT='app-tokens-audit.jsonl';
const LEGACY={file:'device-tokens.json',audit:'device-tokens-audit.jsonl',key:'devices',schemaVersion:1};
const sha=token=>createHash('sha256').update(token).digest();
const tokenPattern=/^hh_[a-f0-9]{64}$/;
export function bearerOf(header=''){const m=/^Bearer (\S+)$/.exec(header);return m&&tokenPattern.test(m[1])?m[1]:null;}
export function validAppName(name){return typeof name==='string'&&name.trim().length>0&&name.length<=60&&!/[\u0000-\u001f\u007f]/.test(name);}
const view=(a,current)=>({id:a.id,name:a.name,createdAt:a.createdAt,lastUsedAt:a.lastUsedAt,...(current===undefined?{}:{current:a.id===current})});
const sound=list=>list.filter(x=>x&&/^[a-f0-9]{16}$/.test(x.id)&&/^[a-f0-9]{64}$/.test(x.hash));
const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return undefined;throw e;}};
// The one-time move from the 1.0.0 files. Each file moves on its own, and only while its new name is free, so a
// start that was interrupted half way finishes the rest the next time and never overwrites newer state. The token
// file is written whole under a temporary name and renamed into place before the old one goes: at every instant
// one complete file exists, with the same ids and hashes, so every issued token keeps working.
// Both names at once means a 1.x hub ran on this state after the move (a rollback without the archive) and wrote a
// token file of its own: those tokens are not merged, and the warning says so at every start until one file goes.
function migrate(directory,warn){
 const file=path.join(directory,FILE),oldFile=path.join(directory,LEGACY.file),audit=path.join(directory,AUDIT),oldAudit=path.join(directory,LEGACY.audit);
 if(existsSync(file)&&existsSync(oldFile))warn(`App tokens: both ${oldFile} and ${file} exist. Only ${FILE} is read: tokens in ${LEGACY.file} (issued by Home Hub 1.x after this state was moved forward) are refused, and the file is left as it is. Issue those apps new tokens, then remove ${LEGACY.file}.`);
 if(existsSync(audit)&&existsSync(oldAudit))warn(`App tokens: both ${oldAudit} and ${audit} exist. Only ${AUDIT} is read; the lines in ${LEGACY.audit} are not shown.`);
 if(!existsSync(file)&&existsSync(oldFile)){
  const old=readJson(oldFile);
  if(!old||old.schemaVersion!==LEGACY.schemaVersion||!Array.isArray(old[LEGACY.key]))throw new Error(`Invalid app token store: ${LEGACY.file} is not a 1.0 token file`);
  mkdirSync(directory,{recursive:true,mode:0o700});
  writeFileSync(file+'.tmp',JSON.stringify({schemaVersion:APP_TOKENS_SCHEMA,tokens:sound(old[LEGACY.key])}),{mode:0o600});renameSync(file+'.tmp',file);rmSync(oldFile,{force:true});
 }
 if(!existsSync(audit)&&existsSync(oldAudit))renameSync(oldAudit,audit);
}
function load(directory,warn){
 migrate(directory,warn);
 const data=readJson(path.join(directory,FILE));if(data===undefined)return [];
 // Older code refuses newer state; it never "tries anyway" and then writes over it.
 if(Number.isInteger(data?.schemaVersion)&&data.schemaVersion>APP_TOKENS_SCHEMA)throw new Error(`The app token store has schema ${data.schemaVersion}; this Home Hub reads up to ${APP_TOKENS_SCHEMA}. Update Home Hub, or restore the backup made before the update.`);
 return data?.schemaVersion===APP_TOKENS_SCHEMA&&Array.isArray(data.tokens)?sound(data.tokens):[];
}
// warn: where a problem with the files on disk is told (the start-up log).
export function createAppTokens(directory,{now=Date.now,warn=message=>console.warn(message)}={}){
 const file=path.join(directory,FILE);
 let tokens=load(directory,warn);
 let queue=Promise.resolve();
 const save=()=>{const op=queue.then(async()=>{await mkdir(directory,{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify({schemaVersion:APP_TOKENS_SCHEMA,tokens}),{mode:0o600});await rename(file+'.tmp',file);});queue=op.catch(()=>{});return op;};
 // Metadata only; never the token or its hash.
 const audit=(event,a)=>appendFile(path.join(directory,AUDIT),JSON.stringify({at:new Date(now()).toISOString(),event,id:a.id,name:a.name})+'\n',{mode:0o600}).catch(()=>{});
 return {
  // Returns the app token's id for a valid token, else null. lastUsedAt is written at most once a minute.
  verify(token){
   if(!token)return null;const digest=sha(token);
   const a=tokens.find(x=>timingSafeEqual(Buffer.from(x.hash,'hex'),digest));if(!a)return null;
   const t=now();if(!a.lastUsedAt||t-Date.parse(a.lastUsedAt)>60000){a.lastUsedAt=new Date(t).toISOString();save().catch(()=>{});}
   return a.id;
  },
  list:current=>tokens.map(a=>view(a,current??null)),
  async issue(name){
   if(!validAppName(name))throw new Error('invalid');if(tokens.length>=maxAppTokens)throw new Error('limit');
   const token='hh_'+randomBytes(32).toString('hex'),a={id:randomBytes(8).toString('hex'),name:name.trim(),createdAt:new Date(now()).toISOString(),lastUsedAt:null,hash:sha(token).toString('hex')};
   tokens.push(a);await save();await audit('issued',a);return {token,app:view(a)};
  },
  async revoke(id){
   const a=tokens.find(x=>x.id===id);if(typeof id!=='string'||!a)throw new Error('not-found');
   tokens=tokens.filter(x=>x!==a);await save();await audit('revoked',a);
  }
 };
}
