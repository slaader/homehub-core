// Exact identity plus ten consecutive seconds. The startup deadline and stability interval are distinct.
import {performance} from 'node:perf_hooks';
export const STABLE_MS=10000;
export async function healthSample(url){
 try{const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(3000),headers:{'user-agent':'home-hub-update'}});let bytes=0,text='';if(response.body)for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024){await response.body.cancel().catch(()=>{});return {ok:false};}text+=Buffer.from(chunk).toString('utf8');}let body;try{body=JSON.parse(text);}catch{return {ok:false};}return {ok:response.status===200&&body?.ok===true&&Object.keys(body).length===1,bootId:response.headers.get('x-home-hub-run-id')};}catch{return {ok:false};}
}
export function identityMismatch(run,expect,{since=0,pidAlive,previousBootId=null}={}){
 if(!run)return 'run.json is missing: the hub has not finished starting';
 if(run.version!==expect.version)return `the hub that wrote run.json is ${run.version}, not ${expect.version}`;
 if(!pidAlive(run.pid))return `the process in run.json (pid ${run.pid}) is not running`;
 if(since&&expect.readinessProtocol!==1&&expect.previousPid===run.pid)return 'the previous process is still running (legacy reduced assurance)';
 if(since&&!(Date.parse(run.startedAt)>=since-2000))return 'run.json is from before this start';
 for(const field of ['dataEpoch','fullCommit','packageDigest'])if(expect[field]!==undefined&&run[field]!==expect[field])return `${field} mismatch (missing identity never downgrades)`;
 if(expect.readinessProtocol===1){if(run.readinessProtocol!==1||typeof run.bootId!=='string'||!run.bootId)return 'modern boot identity is missing';if(previousBootId&&run.bootId===previousBootId)return 'the previous boot is still running';}
 if(expect.plugins){const have=Array.isArray(run.plugins)?run.plugins:[];if(new Set(have.map(p=>p.id)).size!==have.length)return 'duplicate plugin identities';const missing=expect.plugins.filter(p=>!have.some(a=>a.id===p.id)),extra=have.filter(p=>!expect.plugins.some(a=>a.id===p.id));if(missing.length)return `plugin(s) not loaded: ${missing.map(p=>p.id).join(', ')}`;if(extra.length)return `unexpected plugin(s) loaded: ${extra.map(p=>p.id).join(', ')}`;for(const p of expect.plugins){const actual=have.find(a=>a.id===p.id);if(!actual)return `plugin(s) not loaded: ${p.id}`;if(p.version&&actual.version!==p.version)return `plugin ${p.id} is ${actual.version??'unversioned'}, not ${p.version}`;if(p.sourceFingerprint&&p.sourceFingerprint!==actual.sourceFingerprint)return `plugin ${p.id} source fingerprint differs`;if(p.fingerprint&&p.fingerprint!==actual.fingerprint)return `plugin ${p.id} content fingerprint differs`;}}
 return '';
}
export async function observeReadiness({inst,ctx,expect,since,readRun,previousBootId=null,interruptible=true}){
 const mono=ctx.monotonic??ctx.now??(()=>performance.now()),start=mono(),startupDeadline=start+inst.health.seconds*1000,finalDeadline=start+inst.health.seconds*1000+STABLE_MS;let stableSince=null,identity=null,last='no sample';
 for(;;){if(interruptible)ctx.checkpoint();const sample=await ctx.probe(inst.health.url),run=readRun(inst),now=mono();let why=!(typeof sample==='object'?sample.ok:sample)?`no answer from ${inst.health.url}`:identityMismatch(run,expect,{since,pidAlive:ctx.pidAlive,previousBootId});
  if(!why&&expect.readinessProtocol===1&&(typeof sample!=='object'||sample.bootId!==run.bootId))why='HTTP boot ID does not match the local process identity';
  const key=run?JSON.stringify([run.pid,run.bootId,run.startedAt,run.fullCommit,run.packageDigest,run.plugins]):null;
  if(!why&&identity!==null&&identity!==key){why='process identity changed during observation';}
  if(why){stableSince=null;identity=null;last=why;}else{identity=key;if(stableSince===null)stableSince=now;if(now-stableSince>=STABLE_MS)return;}
  if((stableSince===null&&now>=startupDeadline)||now>=finalDeadline)throw new Error(`health check failed: ${last} (waited ${inst.health.seconds} s${stableSince===null?'':'; stable observation incomplete'})`);
  await ctx.sleep(1000);
 }
}
