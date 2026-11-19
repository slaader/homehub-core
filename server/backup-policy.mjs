import {lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {ARCHIVE_LIMITS} from './release-archive.mjs';
import {fields,strictJson,trustDestination,sha256} from './release-trust.mjs';

const MiB=1024**2,GiB=1024**3;
export const POLICY_SCHEMA=1;
export const DRIVER_CAPABILITIES=Object.freeze(['backup-v1','backup-v2','hardlinks','budget','journal-3','staged-fsync','socket-aware']);
export const DEFAULT_BUDGET=Object.freeze({maxBytes:ARCHIVE_LIMITS.expanded,maxEntries:ARCHIVE_LIMITS.entries,maxFileBytes:ARCHIVE_LIMITS.file,maxRoots:64,gzipLevel:1});
export const MAX_BACKUP_ROOTS=1000;
const MAX_BUDGET={maxBytes:64*GiB,maxEntries:200000,maxFileBytes:8*GiB-1,maxRoots:MAX_BACKUP_ROOTS,gzipLevel:9};
export const MANIFEST_LIMIT=128*MiB;
export const MANIFEST_HEADER_LIMIT=4*MiB;
export const MANIFEST_ENTRY_LIMIT=8192;
export const cleanAbsolute=p=>typeof p==='string'&&p.length<=4096&&path.isAbsolute(p)&&path.resolve(p)===p&&p!==path.parse(p).root&&!/\p{Cc}/u.test(p);
export const withinPath=(child,parent)=>child===parent||child.startsWith(parent.endsWith(path.sep)?parent:parent+path.sep);

export function backupBudget(raw={}){
 fields(raw,Object.keys(DEFAULT_BUDGET),'backup budget');
 const budget={...DEFAULT_BUDGET,...raw};
 for(const [name,value] of Object.entries(budget)){
  if(!Number.isSafeInteger(value)||value<(name==='gzipLevel'?0:1)||value>MAX_BUDGET[name])throw new Error(`invalid backup budget ${name} (maximum ${MAX_BUDGET[name]})`);
 }
 return budget;
}

// The hub server never reads this file. An alternate path is explicit on each backup or apply.
export function backupPolicy(inst){
 const named=inst.backupPolicyFile??(inst.home?path.join(inst.home,'update','backup-policy.json'):null);
 const defaults={file:null,digest:null,budget:backupBudget(),coverFiles:[]};
 if(!named)return defaults;
 let st;
 try{st=lstatSync(named);}catch(e){if(e.code==='ENOENT'&&!inst.backupPolicyFile)return defaults;throw e;}
 const file=trustDestination(named,{forbidden:[inst.root,...(inst.sources??[]).map(s=>s.dir)]});
 if(!st.isFile()||st.nlink!==1||st.size>4*MiB||(st.mode&0o077)||st.uid!==(process.getuid?.()??st.uid))throw new Error('backup policy must be an owner-only regular file with one name, at most 4 MiB');
 const bytes=readFileSync(file),raw=strictJson(bytes,{limit:4*MiB});
 fields(raw,['schemaVersion','budget','coverFiles'],'backup policy');
 if(raw.schemaVersion!==POLICY_SCHEMA)throw new Error('unsupported backup policy schema');
 const coverFiles=raw.coverFiles??[];
 if(!Array.isArray(coverFiles)||coverFiles.length>MAX_BUDGET.maxRoots||!coverFiles.every(cleanAbsolute)||new Set(coverFiles).size!==coverFiles.length)throw new Error('coverFiles must list distinct, exact absolute file paths');
 return {file,digest:sha256(bytes),budget:backupBudget(raw.budget),coverFiles};
}
