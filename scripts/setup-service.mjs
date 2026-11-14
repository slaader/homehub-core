#!/usr/bin/env node
// Register an installed service; this never runs its binary or changes the operating system.
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {SERVICE_KINDS,serviceProblems,ENTRY_ID,secretLike} from '../public/inventory-rules.js';
const bools=new Set(['apply','dry-run','token-stdin','help','list-kinds']);
const values=new Set(['id','device','name','kind','binary','port','platform','mode','address','endpoint-id','watch-id','base','hub','token-file']);
export function parseArgs(args){
 const out={};
 for(let i=0;i<args.length;i++){
  const k=args[i].startsWith('--')?args[i].slice(2):'';
  if(!bools.has(k)&&!values.has(k))throw new Error(`Unknown option: ${args[i]}`);
  if(Object.hasOwn(out,k))throw new Error(`Repeated option: --${k}`);
  if(bools.has(k))out[k]=true;
  else {const v=args[++i];if(v===undefined||v.startsWith('--'))throw new Error(`--${k} needs a value`);out[k]=v;}
 }
 if(out.apply&&out['dry-run'])throw new Error('Choose --apply or --dry-run');
 if(out['token-file']&&out['token-stdin'])throw new Error('Choose --token-file or --token-stdin');
 return out;
}
export function registrationFrom(options){
 const platform=options.platform||({darwin:'macos',linux:'linux',win32:'windows'})[process.platform];
 const mode=options.mode||'server',port=options.port==='none'||options.port==='null'?null:options.port!==undefined?Number(options.port):null;
 const result={id:options.id,device:options.device,name:options.name,kind:options.kind,binary:options.binary,platform,mode,port};
 for(const [flag,key] of [['address','address'],['endpoint-id','endpointId'],['watch-id','watchId'],['base','base']])if(options[flag]!==undefined)result[key]=options[flag];
 if(!ENTRY_ID.test(result.id||'')||!ENTRY_ID.test(result.device||''))throw new Error('id and device must be inventory ids (lowercase letters, numbers, hyphens)');
 if(typeof result.name!=='string'||!result.name.trim()||result.name.length>120)throw new Error('name must have 1..120 characters');
 const descriptor={kind:result.kind,binary:result.binary,platform,mode,port,...(result.endpointId?{endpointId:result.endpointId}:{}),...(result.watchId?{watchId:result.watchId}:{})};
 const issues=serviceProblems(descriptor);if(issues.length)throw new Error(issues.join('; '));
 if(result.base!==undefined&&!/^[a-f0-9]{64}$/.test(result.base))throw new Error('base must be the inventory hash');
 const sensitive=Object.entries(result).filter(([k])=>k!=='base').find(([,v])=>typeof v==='string'&&secretLike(v));
 if(sensitive)throw new Error(`${sensitive[0]} looks like a secret; store only a description or location`);
 return result;
}
export function hubOrigin(value){
 let url;try{url=new URL(value);}catch{throw new Error('--hub must be an HTTPS origin (or HTTP on loopback)');}
 const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new Error('--hub must be an HTTPS origin (or HTTP on loopback), without credentials or path');
 return url.origin;
}
export async function registerRemote({hub,token,registration,fetcher=fetch}){
 const url=hubOrigin(hub);
 if(typeof token!=='string'||!/^hhk?_[a-f0-9]{64}$/.test(token))throw new Error('The credential is not a Home Hub token');
 const response=await fetcher(url+'/api/service-registrations',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(registration)});
 let result;try{result=await response.json();}catch{throw new Error(`Hub returned HTTP ${response.status}`);}
 if(!response.ok)throw new Error(result.error?.message||`Hub refused registration (HTTP ${response.status})`);
 return {id:result.entry.id,hash:result.hash,published:result.published};
}
async function readToken(options){
 let token;
 if(options['token-file']){
  const file=options['token-file'],s=await stat(file);
  if(!s.isFile()||process.platform!=='win32'&&((s.mode&0o077)!==0||typeof process.getuid==='function'&&s.uid!==process.getuid()))throw new Error('Token file must belong to this user and have no group/other permissions');
  token=await readFile(file,'utf8');
 }else if(options['token-stdin']){token='';for await(const chunk of process.stdin){token+=chunk;if(token.length>1024)throw new Error('Token input is too long');}}
 else throw new Error('--apply needs --token-file or --token-stdin (never put a token on the command line)');
 return token.trim();
}
export async function main(args){
 const options=parseArgs(args);
 if(options['list-kinds']){console.log(SERVICE_KINDS.join('\n'));return 0;}
 if(options.help){console.log(`Register an already installed service in Home Hub. No binary is run or installed.

node scripts/setup-service.mjs [options]              interactive when fields are missing; prints the plan
node scripts/setup-service.mjs --apply --hub URL --token-file FILE [options]

Fields: --id ID --device ID --name NAME --kind KIND --binary PATH --port PORT
        --platform macos|linux|windows --mode server|on-demand (default server; on-demand uses --port none)
Links:  --endpoint-id ID --watch-id ID --address URL
Update: --base HASH (required to replace an existing service; read inventory_get first)
Auth:   --token-file FILE or --token-stdin; never a command-line token
Other:  --dry-run (default) --apply --list-kinds --help

Kinds: ${SERVICE_KINDS.join(', ')}
See docs/services.md. Devices must already exist in the inventory.`);return 0;}
 if(process.stdin.isTTY){
  const prompt=createInterface({input:process.stdin,output:process.stdout});
  try{for(const [key,label] of [['device','Inventory device id'],['id','Service inventory id'],['name','Service name'],['kind',`Kind (${SERVICE_KINDS.join(', ')})`],['binary','Installed binary path'],['port','Port (or none for on-demand)']])if(options[key]===undefined)options[key]=await prompt.question(label+': ');}finally{prompt.close();}
 }
 if(options.port==='none'&&options.mode===undefined)options.mode='on-demand';
 const registration=registrationFrom(options);
 if(!options.apply){console.log(JSON.stringify(registration,null,2));console.log('Dry run. Add --apply --hub URL --token-file FILE to register this service.');return 0;}
 const token=await readToken(options);const result=await registerRemote({hub:options.hub,token,registration});
 console.log(`Registered ${result.id}; inventory hash ${result.hash}.`);return 0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(e=>{console.error(e.message);process.exitCode=1;});
