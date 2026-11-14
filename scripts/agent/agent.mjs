#!/usr/bin/env node
// The Home Hub push agent for macOS and Linux (docs/agent.md §5): a thin wrapper that runs the probes that already
// exist on this machine and posts what they print to the hub. Installed and started by
// scripts/install-host-agent.mjs --core; it updates only when that is run again from a newer checkout.
//
//   node scripts/agent/agent.mjs --config DIR [--state DIR] [--key FILE]     run: report until stopped
//   node scripts/agent/agent.mjs --config DIR --once                         collect every part once, check it and print
//                                                                            the envelope; nothing is sent, no key is read
//   node scripts/agent/agent.mjs --config DIR [--state DIR] [--key FILE] --once --send
//                                                                            the same, sent once; prints the hub's status
//                                                                            and which parts it accepted (exit 0 on a 200
//                                                                            with at least one accepted part)
//
// DIR holds agent.json (scripts/agent/config.mjs) and specs.txt (the watch list; docs/agent.md → The watch list).
// specs.txt is checked with validateSpecs at every start, and a file that fails stops the agent before anything runs
// (status lastError "specs-invalid", exit 78). The key: --key FILE (the token alone), else on Linux
// $CREDENTIALS_DIRECTORY/agent-key when systemd hands it over. It is never printed, logged or passed to a probe.
//
// What it sends: heartbeat; os + updates + packages from one run of the systems probe (mac-probe.sh with
// HOME_HUB_NARROW_SUDO=1, or linux-probe.sh); sshkeys (ssh-probe.sh, keys own or all-accounts); runtimes (agent.json →
// runtimes, loopback only). Each part by its interval with jitter; what falls due within 20 s of another goes in one
// report. Backs off: a network error or 5xx doubles the wait up to 15 min, 429 waits Retry-After, 401 tries again
// once an hour, 400/403/409/413 wait for the next interval. Writes <state>/status.json:
// {lastAttemptAt, lastAcceptedAt, lastError, parts: {<part>: {lastSentAt, lastAcceptedAt, lastRefused}}}.
// The hub's answer is read for its status, Retry-After and acknowledgement, and for nothing else.
// HOME_HUB_LAUNCHD_DOMAIN=gui/<uid> (macOS, set by the launchd daemon's plist; only this account's own uid is taken):
// passed to mac-probe.sh, which then reads the RUN state of the owner's launchd agents in that domain.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateReport,validateSpecs,PARTS,REPORT_LIMITS,REPORT_VERSION} from '../../server/agent-report.mjs';
import {parseConfig,transportTrust,parseToken,specsPathErrors} from './config.mjs';
import {collectSystems,collectSshKeys,runCommand,stopRunning} from './probes.mjs';
import {readRuntimes} from './runtimes.mjs';
import {sendReport} from './transport.mjs';
import {endpointRequest} from '../../server/endpoint-http.mjs';

export const agentRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
export const EXIT_CONFIG=78;
export const AGENT_TIMING=Object.freeze({batchMs:REPORT_LIMITS.floorSeconds*1000,floorMs:REPORT_LIMITS.floorSeconds*1000,backoffStartS:30,backoffMaxS:900,unauthorizedS:3600,collectRetryS:900,jitter:0.1});
const PLATFORMS={darwin:'macos',linux:'linux'};
const iso=ms=>new Date(ms).toISOString();

/** The agent's status.json from its state: a pure function. */
export function renderStatus(status){
 const parts={};
 for(const name of Object.keys(status.parts).sort())parts[name]={lastSentAt:status.parts[name].lastSentAt??null,lastAcceptedAt:status.parts[name].lastAcceptedAt??null,lastRefused:status.parts[name].lastRefused??null};
 return JSON.stringify({lastAttemptAt:status.lastAttemptAt??null,lastAcceptedAt:status.lastAcceptedAt??null,lastError:status.lastError??null,parts},null,1)+'\n';
}
// The next wait after a network error or 5xx: 30 s, doubling, at most 15 min.
export const nextBackoff=previous=>previous?Math.min(previous*2,AGENT_TIMING.backoffMaxS):AGENT_TIMING.backoffStartS;
// An interval with ±10 % jitter, never below the part's minimum (the hub refuses a part sent again sooner).
export const jittered=(part,seconds,random)=>Math.max(PARTS[part].interval.min,seconds*(1-AGENT_TIMING.jitter+2*AGENT_TIMING.jitter*random()))*1000;

/**
 * The agent's loop, with the world passed in (exec, request, fetcher, clock, random, writeStatus, log), so a test
 * drives it step by step. step() starts what is due, sends what is ready and returns how long to sleep; settled()
 * waits for the collections that are running.
 */
export function createAgent({config,trust,token,specsText,platform,root=agentRoot,home,version,launchdDomain=null,world}){
 const {exec=runCommand,request=endpointRequest,fetcher=fetch,now=Date.now,random=Math.random,writeStatus=()=>{},log=()=>{},probePath=null}=world;
 const memo=new Map();
 const date=()=>new Date(now());
 const groups=[{id:'heartbeat',parts:['heartbeat'],interval:config.intervals.heartbeat,collect:null}];
 groups.push({id:'systems',parts:['os','updates','packages'],interval:config.intervals.os,
  collect:async()=>{const r=await collectSystems({root,platform,home,specsText,interval:config.intervals.os,exec,now:date,probePath,launchdDomain});return r.ok?{ok:true,parts:r.parts}:r;}});
 if(config.keys!=='off')groups.push({id:'sshkeys',parts:['sshkeys'],interval:config.intervals.sshkeys,
  collect:async()=>{const r=await collectSshKeys({root,platform,home,keys:config.keys,interval:config.intervals.sshkeys,exec,now:date,probePath});return r.ok?{ok:true,parts:{sshkeys:r.part}}:r;}});
 if(config.runtimes.length)groups.push({id:'runtimes',parts:['runtimes'],interval:config.intervals.runtimes,
  collect:async()=>({ok:true,parts:{runtimes:{schema:1,collectedAt:date().toISOString(),interval:config.intervals.runtimes,data:await readRuntimes(config.runtimes,{fetcher,memo,now})}}})});
 const start=now();
 for(const g of groups)Object.assign(g,{nextDue:start,running:null,ready:null,readyAt:0,lastSentMs:-Infinity,tooSoonRetried:false});
 const status={lastAttemptAt:null,lastAcceptedAt:null,lastError:null,parts:Object.fromEntries(groups.flatMap(g=>g.parts).map(p=>[p,{}]))};
 let blockedUntil=0,backoff=0,lastSendMs=-Infinity,waiters=[];
 const notify=()=>{const w=waiters;waiters=[];for(const f of w)f();};
 const save=()=>{try{writeStatus(renderStatus(status));}catch(e){log(`status.json not written: ${e.code||e.message}`);}};
 const minMs=g=>Math.max(...g.parts.map(p=>PARTS[p].interval.min))*1000;

 function startCollections(t){
  for(const g of groups){
   if(!g.collect||g.running||g.ready||g.nextDue>t+AGENT_TIMING.batchMs)continue;
   const began=t;
   g.running=g.collect().then(r=>{
    if(r.ok){g.ready=r.parts;g.readyAt=began;}
    else{g.nextDue=now()+Math.min(g.interval,AGENT_TIMING.collectRetryS)*1000;status.lastError=r.error;log(`${g.id}: ${r.error}`);save();}
   },e=>{g.nextDue=now()+Math.min(g.interval,AGENT_TIMING.collectRetryS)*1000;status.lastError='collect-failed';log(`${g.id}: collect-failed (${e?.code||e?.name||'error'})`);save();})
    .finally(()=>{g.running=null;notify();});
  }
 }
 // What goes now: every ready part, and the heartbeat when it falls due within the batch window; each only when the
 // hub's minimum since its last send has passed.
 function batch(t){
  const hb=groups[0],eligible=g=>t-g.lastSentMs>=minMs(g);
  const ready=groups.filter(g=>g.ready&&eligible(g));
  const hbDue=hb.nextDue<=t+AGENT_TIMING.batchMs&&eligible(hb);
  if(!ready.length&&!(hbDue&&hb.nextDue<=t))return [];
  return [...(hbDue?[hb]:[]),...ready];
 }
 async function send(chosen,t){
  const parts={};
  for(const g of chosen){if(g.id==='heartbeat')parts.heartbeat={schema:1,interval:g.interval};else Object.assign(parts,g.ready);}
  const envelope={v:REPORT_VERSION,agentVersion:version,platform,sentAt:iso(t),parts};
  // Checked here before it leaves, as the hub will check it: what it would refuse is not sent.
  const v=validateReport(envelope);
  if(!v.ok){status.lastError='report-invalid';log(`report-invalid (${v.field})`);for(const g of chosen){g.ready=null;g.nextDue=t+jittered(g.parts[0],g.interval,random);}save();return;}
  for(const r of v.refused){status.parts[r.part].lastRefused={code:r.code,...(r.tag?{tag:r.tag}:{}),...(r.field?{field:r.field}:{}),local:true};delete envelope.parts[r.part];}
  if(!Object.keys(envelope.parts).length){status.lastError='report-invalid';for(const g of chosen){g.ready=null;g.nextDue=t+jittered(g.parts[0],g.interval,random);}save();return;}
  status.lastAttemptAt=iso(t);lastSendMs=t;
  const r=await sendReport({hub:config.hub,trust,token,envelope,request});
  const after=now();
  const sentGroups=chosen.filter(g=>g.parts.some(p=>p in envelope.parts));
  if(r.status===200){
   backoff=0;
   for(const g of chosen){
    for(const p of g.parts){
     if(!(p in envelope.parts))continue;
     const s=status.parts[p];s.lastSentAt=iso(t);
     if(r.ack.accepted.includes(p)){s.lastAcceptedAt=iso(after);s.lastRefused=null;}
     else{const ref=r.ack.refused.find(x=>x.part===p);s.lastRefused=ref?{code:ref.code,...(ref.tag?{tag:ref.tag}:{}),...(ref.field?{field:ref.field}:{})}:{code:'unanswered'};}
    }
    g.lastSentMs=t;g.nextDue=(g.collect?g.readyAt:t)+jittered(g.parts[0],g.interval,random);g.ready=null;
    // Every part of it refused as too-soon: the hub holds this key's previous copy from less than the part's minimum
    // ago (an agent restarted or installed again within it). Collected again once that minimum has passed, not a whole
    // interval later: a new watch list would otherwise reach the hub only hours after the install. Only once in a row:
    // when the early try is refused too (another install with the same key, a hub holding a stale copy), the group goes
    // back to its interval rather than running its probe, and its sudo reads, every 15 min for good.
    const sent=g.parts.filter(p=>p in envelope.parts);
    const tooSoon=g.collect&&sent.length&&sent.every(p=>r.ack.refused.some(x=>x.part===p&&x.code==='too-soon'));
    if(tooSoon&&!g.tooSoonRetried)g.nextDue=after+minMs(g)+AGENT_TIMING.batchMs;
    if(g.collect&&sent.length)g.tooSoonRetried=Boolean(tooSoon);
   }
   if(r.ack.accepted.length){status.lastAcceptedAt=iso(after);status.lastError=null;}else status.lastError='refused';
   log(`sent ${Object.keys(envelope.parts).join(',')}: 200, accepted ${r.ack.accepted.join(',')||'none'}${r.ack.refused.length?`, refused ${r.ack.refused.map(x=>`${x.part} ${x.code}`).join(', ')}`:''}`);
  }else if(r.status===429){
   blockedUntil=after+(r.retryAfter??REPORT_LIMITS.floorSeconds)*1000;status.lastError='too-soon';
   log(`429: again in ${Math.round((blockedUntil-after)/1000)} s`);
  }else if(r.status===401){
   for(const g of chosen){g.ready=null;g.nextDue=after+AGENT_TIMING.unauthorizedS*1000;}
   blockedUntil=after+AGENT_TIMING.unauthorizedS*1000;status.lastError='unauthorized';
   log('401: the key is not accepted (revoked?); trying again in an hour');
  }else if(r.status>=400&&r.status<500){
   for(const g of sentGroups){g.ready=null;g.lastSentMs=t;g.nextDue=after+jittered(g.parts[0],g.interval,random);}
   status.lastError=`http-${r.status}`;log(`${r.status}: waiting for the next interval`);
  }else{
   backoff=nextBackoff(backoff);blockedUntil=after+backoff*1000;status.lastError=r.status?`http-${r.status}`:r.error||'error';
   log(`${status.lastError}: again in ${backoff} s`);
  }
  save();
 }
 return {
  status,groups,
  async step(){
   const t=now();
   // A collected part waits for a send at most one interval; after that it is collected again.
   for(const g of groups)if(g.ready&&t-g.readyAt>g.interval*1000){g.ready=null;g.nextDue=t;}
   startCollections(t);
   if(t>=blockedUntil&&t>=lastSendMs+AGENT_TIMING.floorMs){const chosen=batch(t);if(chosen.length)await send(chosen,t);}
   const t2=now();
   const events=[blockedUntil,lastSendMs+AGENT_TIMING.floorMs,...groups.filter(g=>!g.running&&!g.ready).map(g=>g.collect?g.nextDue-AGENT_TIMING.batchMs:g.nextDue),
    ...groups.filter(g=>g.ready).map(g=>g.lastSentMs+minMs(g))].filter(x=>x>t2);
   return Math.max(250,Math.min(...events,t2+60000)-t2);
  },
  settled:()=>Promise.all(groups.map(g=>g.running).filter(Boolean)),
  changed:()=>new Promise(r=>waiters.push(r)),
  // Everything once, for --once: → the envelope (checked) and what the check refused.
  async collectAll(){
   const t=now(),parts={};
   for(const g of groups){
    if(!g.collect){parts.heartbeat={schema:1,interval:g.interval};continue;}
    const r=await g.collect();
    if(r.ok)Object.assign(parts,r.parts);else{status.lastError=r.error;log(`${g.id}: ${r.error}`);}
   }
   const envelope={v:REPORT_VERSION,agentVersion:version,platform,sentAt:iso(t),parts};
   const v=validateReport(envelope);
   if(v.ok)for(const r of v.refused)delete envelope.parts[r.part];
   return {envelope,check:v};
  },
  async sendOnce(envelope){
   const t=now();status.lastAttemptAt=iso(t);
   const r=await sendReport({hub:config.hub,trust,token,envelope,request});
   if(r.status===200){for(const p of Object.keys(envelope.parts)){const s=status.parts[p]||(status.parts[p]={});s.lastSentAt=iso(t);
     if(r.ack.accepted.includes(p)){s.lastAcceptedAt=iso(now());s.lastRefused=null;}else s.lastRefused=r.ack.refused.find(x=>x.part===p)||{code:'unanswered'};}
    if(r.ack.accepted.length){status.lastAcceptedAt=iso(now());status.lastError=null;}else status.lastError='refused';}
   else status.lastError=r.status?`http-${r.status}`:r.error||'error';
   save();return r;
  },
 };
}

// --- start ----------------------------------------------------------------------------------------------------------
const FLAGS=['--config','--state','--key'],SWITCHES=['--once','--send','--help'];
/** argv → {config, state, key, once, send} or {error}. */
export function parseArgs(argv){
 const out={config:null,state:null,key:null,once:false,send:false,help:false};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(FLAGS.includes(a)){const v=argv[++i];if(!v||!path.isAbsolute(v))return {error:`${a} needs an absolute path`};out[a.slice(2)]=path.resolve(v);}
  else if(SWITCHES.includes(a))out[a.slice(2)]=true;
  else return {error:`unknown argument: ${String(a).slice(0,40)}`};
 }
 if(out.help)return out;
 if(!out.config)return {error:'--config DIR is required'};
 if(out.send&&!out.once)return {error:'--send goes with --once'};
 return out;
}

/**
 * Everything the agent reads at start, checked: → {ok:true, setup} or {ok:false, error, detail, exit}. Nothing is run
 * before this passes; a specs.txt that fails is "specs-invalid". fs: {readFile(file) → text}, env, platform.
 */
export function prepare({args,fs={readFile:f=>readFileSync(f,'utf8')},env=process.env,platform=PLATFORMS[process.platform],root=agentRoot}){
 const no=(error,detail)=>({ok:false,error,detail,exit:EXIT_CONFIG});
 if(!platform)return no('platform','the Node agent runs on macOS and Linux');
 let text;try{text=fs.readFile(path.join(args.config,'agent.json'));}catch(e){return no('config-invalid',`cannot read agent.json (${e.code||'error'})`);}
 const c=parseConfig(text,{platform});if(!c.ok)return no('config-invalid',c.error);
 let specsText;try{specsText=fs.readFile(path.join(args.config,'specs.txt'));}catch(e){return no('specs-invalid',`cannot read specs.txt (${e.code||'error'})`);}
 const specs=validateSpecs(specsText,{platform});
 const errors=specs.ok?specsPathErrors(specsText):specs.errors;
 if(errors.length)return no('specs-invalid',errors.slice(0,20).map(e=>`line ${e.line}: ${e.reason}`).join('; '));
 let trust;
 try{trust=transportTrust(c.config,c.config.trust.mode==='ca'?fs.readFile(c.config.trust.caFile):null);}catch(e){return no('ca-invalid',`cannot use the CA file ${c.config.trust.caFile} (${e.code||e.message})`);}
 let token=null;
 if(!args.once||args.send){
  // --key wins; systemd's credential only on Linux and only without --key, so a stray CREDENTIALS_DIRECTORY (macOS,
  // a shell) never swaps the key.
  const file=args.key||(platform==='linux'&&env.CREDENTIALS_DIRECTORY?path.join(env.CREDENTIALS_DIRECTORY,'agent-key'):null);
  if(!file)return no('key-missing','no key: --key FILE, or the agent-key credential');
  let raw;try{raw=fs.readFile(file);}catch(e){return no('key-missing',`cannot read the key file (${e.code||'error'})`);}
  token=parseToken(raw);if(!token)return no('key-invalid','the key file does not hold an agent key');
 }
 let version;try{version=JSON.parse(fs.readFile(path.join(root,'package.json'))).version;}catch{return no('version','cannot read the version (package.json)');}
 return {ok:true,setup:{config:c.config,trust,token,specsText,platform,version,root}};
}

/**
 * HOME_HUB_LAUNCHD_DOMAIN (the launchd daemon's plist sets it to gui/<uid>, docs/agent.md section 5) → the domain the
 * systems probe reads the owner's agents in, or null: macOS only, and only this account's own GUI domain.
 */
export const launchdDomainOf=({env,platform,uid})=>{
 const v=env?.HOME_HUB_LAUNCHD_DOMAIN;
 return platform==='macos'&&typeof v==='string'&&Number.isSafeInteger(uid)&&v===`gui/${uid}`?v:null;
};

const writeStatusFile=dir=>text=>{mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'status.json'),tmp=`${file}.${process.pid}.tmp`;writeFileSync(tmp,text,{mode:0o644});renameSync(tmp,file);};
const say=(...a)=>console.log(new Date().toISOString(),...a);

/**
 * The agent process: argv → exit code. Everything it touches comes in through `io` (tests pass their own): fs
 * (readFile), env, platform, root, out/err (lines for a person), writeStatusTo(dir) and the agent's world (exec,
 * request, fetcher, now, random). A check that fails at start returns before anything is run.
 */
export async function runAgent(argv,io={}){
 const {fs:files={readFile:f=>readFileSync(f,'utf8')},env=process.env,platform=PLATFORMS[process.platform],root=agentRoot,out=console.log,err=console.error,
  writeStatusTo=writeStatusFile,world={},loop=null,uid=process.getuid?.()??null}=io;
 const args=parseArgs(argv);
 if(args.help){out(readFileSync(fileURLToPath(import.meta.url),'utf8').split('\n').slice(1,23).map(l=>l.replace(/^\/\/ ?/,'')).join('\n'));return 0;}
 if(args.error){err(args.error);return 2;}
 const stateDir=args.state||(env.STATE_DIRECTORY?path.resolve(env.STATE_DIRECTORY.split(':')[0]):null);
 const writeStatus=stateDir&&(!args.once||args.send)?writeStatusTo(stateDir):()=>{};
 const p=prepare({args,fs:files,env,platform,root});
 if(!p.ok){
  err(`${p.error}: ${p.detail}`);
  try{writeStatus(renderStatus({lastError:p.error,parts:{}}));}catch{}
  return p.exit;
 }
 const home=env.HOME||os.homedir();
 const launchdDomain=launchdDomainOf({env,platform,uid});
 const agent=createAgent({...p.setup,home,launchdDomain,world:{log:say,...world,writeStatus}});
 if(args.once){
  const {envelope,check}=await agent.collectAll();
  if(!check.ok){err(`report-invalid: ${check.field}`);return 1;}
  if(!args.send){
   out(JSON.stringify(envelope,null,1));
   for(const r of check.refused)err(`would be refused: ${r.part} ${r.code}${r.tag?` ${r.tag}`:''}${r.field?` field ${r.field}`:''}`);
   return Object.keys(envelope.parts).length?0:1;
  }
  const r=await agent.sendOnce(envelope);
  out(JSON.stringify({status:r.status,...(r.error?{error:r.error}:{}),...(r.retryAfter?{retryAfter:r.retryAfter}:{}),...(r.ack?{accepted:r.ack.accepted,refused:r.ack.refused}:{}),
   ...(check.refused.length?{withheldLocally:check.refused.map(x=>({part:x.part,code:x.code}))}:{})}));
  return r.status===200&&r.ack.accepted.length?0:1;
 }
 say(`home-hub-agent ${p.setup.version} on ${p.setup.platform}: reporting to ${p.setup.config.hub.origin} (${p.setup.config.trust.mode})`);
 if(loop)return loop(agent);
 for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{say(`${sig}: stopping`);stopRunning();process.exit(0);});
 for(;;){
  const ms=await agent.step();
  await Promise.race([new Promise(r=>setTimeout(r,ms)),agent.changed()]);
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runAgent(process.argv.slice(2)).then(code=>{process.exitCode=code;},e=>{console.error(e?.stack||String(e));process.exitCode=1;});
