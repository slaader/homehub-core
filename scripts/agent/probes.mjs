// The push agent's probes (docs/agent.md §5): the scripts that already exist, run on this computer as files with a
// fixed environment and a timeout. Nothing here builds script text: a probe is always `/bin/sh <file>`, and the watch
// list reaches it only as the environment variable SPECS, from the local specs.txt the agent checked at start.
//
// What comes back is split into the report's parts and checked line by line against the field table
// (server/agent-report.mjs) before anything is sent: a line that fails is left out and counted in `withheld`, so a
// device loses the line, not the part.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {checkLine,splitSystemsRecords,REPORT_LIMITS,HOST_PLATFORM} from '../../server/agent-report.mjs';
import {PRIVILEGED} from '../../server/agent-privileged.mjs';

// Paths inside the agent's copy (or a checkout of core): the installer copies these with the code.
export const PROBE_FILES=Object.freeze({macos:'scripts/systems/mac-probe.sh',linux:'scripts/systems/linux-probe.sh',ssh:'scripts/security/ssh-probe.sh'});
export const PROBE_PATH=Object.freeze({macos:'/usr/bin:/bin:/usr/sbin:/sbin',linux:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'});
export const PROBE_LIMITS=Object.freeze({systemsMs:600000,sshMs:300000,outputBytes:4*1024*1024});
const SUDO='/usr/bin/sudo';
const TAG=/^[A-Z][A-Z0-9_]{0,19}$/;

/**
 * The probe's whole environment: nothing of the agent's own is passed down. probePath: tests only (stub commands).
 * launchdDomain: gui/<uid> when the agent runs as a launchd daemon (macOS), so mac-probe.sh reads the owner's agents
 * there; absent otherwise.
 */
export const probeEnv=({platform,home,specs,probePath=null,launchdDomain=null})=>({PATH:probePath||PROBE_PATH[platform],HOME:home||'/nonexistent',LC_ALL:'C',SPECS:specs,HOME_HUB_NARROW_SUDO:'1',
 ...(launchdDomain?{HOME_HUB_LAUNCHD_DOMAIN:launchdDomain}:{})});

// The process groups of the commands running now, so the agent can stop them when it stops (stopRunning).
const running=new Set();
const killGroup=pid=>{try{process.kill(-pid,'SIGKILL');}catch{}};
/** Kills every command runCommand started that is still running (the agent calls it when it is stopped). */
export function stopRunning(){for(const pid of running)killGroup(pid);running.clear();}

/**
 * Runs one command without a shell; never throws. → {code, stdout, stderr, timedOut}. stdin is closed. The command
 * gets a process group of its own, and the timeout (or too much output) kills the whole group, so a probe's children
 * (softwareupdate, brew, a watched binary) go with it. It settles even when a process that left the group still holds
 * the output open: graceMs after the kill, or after the command itself exited, with what was read by then.
 */
export function runCommand(cmd,args,{env={},timeoutMs=60000,maxBytes=PROBE_LIMITS.outputBytes,cwd='/',graceMs=2000}={}){
 return new Promise(resolve=>{
  let child;
  try{child=spawn(cmd,args,{env,cwd,stdio:['ignore','pipe','pipe'],detached:true});}catch(e){return resolve({code:-1,stdout:'',stderr:String(e.code||'spawn'),timedOut:false});}
  const pid=child.pid;if(pid)running.add(pid);
  const out=[],err=[];let size=0,timedOut=false,done=false,grace=null,exitCode=null;
  const result=code=>({code,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8').slice(0,2000),timedOut});
  const finish=v=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(grace);running.delete(pid);child.stdout?.destroy();child.stderr?.destroy();resolve(v);};
  // The group is killed only while something of it still holds the output, so its id cannot have been reused.
  const settleSoon=()=>{if(!grace)grace=setTimeout(()=>{if(pid)killGroup(pid);finish(result(exitCode??-1));},graceMs);};
  const stop=()=>{if(pid)killGroup(pid);else child.kill('SIGKILL');settleSoon();};
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  child.stdout.on('data',d=>{if(done)return;size+=d.length;if(size>maxBytes)stop();else out.push(d);});
  child.stderr.on('data',d=>{if(!done&&err.length<64)err.push(d);});
  child.on('error',e=>finish({code:-1,stdout:'',stderr:String(e.code||'spawn'),timedOut}));
  // The command is gone; what it left running in its group is stopped if the output is not closed within graceMs.
  child.on('exit',code=>{exitCode=code??-1;settleSoon();});
  child.on('close',code=>finish(result(code??exitCode??-1)));
 });
}

/**
 * The lines of one part → {records, withheld}: every line checked against the field table for this part; one that
 * fails is left out and counted by tag, field and reason (secret, long, invalid). Never the value.
 */
export function cleanPart(part,lines,platform){
 const records=[],counts=new Map();
 for(const line of lines){
  let why=null;
  if(Buffer.byteLength(line)>REPORT_LIMITS.lineBytes){const tag=line.split('\t')[0];why={tag:TAG.test(tag)?tag:'UNKNOWN',field:0,reason:'long'};}
  else{const bad=checkLine(part,line,platform);if(bad)why={tag:bad.tag||'UNKNOWN',field:bad.field||0,reason:bad.code==='secret'?'secret':'invalid'};}
  if(!why){records.push(line);continue;}
  const key=`${why.tag}\t${why.field}\t${why.reason}`;counts.set(key,{...why,count:(counts.get(key)?.count||0)+1});
 }
 const withheld=[...counts.values()].slice(0,REPORT_LIMITS.withheld).map(w=>({tag:w.tag,field:w.field,reason:w.reason,count:Math.min(w.count,REPORT_LIMITS.lines)}));
 return {records,withheld};
}
const linesOf=text=>String(text).split('\n').map(l=>l.replace(/\r$/,'')).filter(l=>l!=='');
// A probe's own part (os or sshkeys) is usable when exactly one HOST of this platform with a probe time survived and it
// ends with END ok: else the hub would refuse it whole.
const complete=(records,platform)=>{
 const hosts=records.filter(l=>l.startsWith('HOST\t'));
 return hosts.length===1&&hosts[0].split('\t')[2]===HOST_PLATFORM[platform]&&records.filter(l=>l.split('\t')[0]==='END').length===1&&records.at(-1)==='END\tok';
};
export const specsDigest=specsText=>createHash('sha256').update(Buffer.from(specsText,'utf8')).digest('hex');

/**
 * One run of the systems probe → {ok:true, parts:{os, updates, packages}} (each {schema, collectedAt, interval,
 * records, withheld?}) or {ok:false, error}. The packages part ends with SPECS <sha256 of specs.txt>.
 */
export async function collectSystems({root,platform,home,specsText,interval,exec=runCommand,now=()=>new Date(),probePath=null,launchdDomain=null}){
 const collectedAt=now().toISOString();
 const file=path.join(root,PROBE_FILES[platform]);
 const r=await exec('/bin/sh',[file],{env:probeEnv({platform,home,specs:specsText,probePath,launchdDomain}),timeoutMs:PROBE_LIMITS.systemsMs});
 if(r.timedOut)return {ok:false,error:'probe-timeout'};
 const split=splitSystemsRecords(linesOf(r.stdout));
 split.packages.push(`SPECS\t${specsDigest(specsText)}`);
 const parts={};
 for(const name of ['os','updates','packages']){
  const {records,withheld}=cleanPart(name,split[name],platform);
  parts[name]={schema:1,collectedAt,interval,records,...(withheld.length?{withheld}:{})};
 }
 if(!complete(parts.os.records,platform))return {ok:false,error:'probe-incomplete'};
 return {ok:true,parts};
}

/**
 * The SSH key inventory (scripts/security/ssh-probe.sh) → {ok, part} | {ok:false, error}. keys: own runs the copy
 * beside the agent as this account; all-accounts runs the root-owned copy through its one sudo rule (PRIVILEGED).
 */
export async function collectSshKeys({root,platform,home,keys,interval,exec=runCommand,now=()=>new Date(),probePath=null}){
 if(keys==='off')return {ok:false,error:'off'};
 const collectedAt=now().toISOString();
 const env=probeEnv({platform,home,specs:'',probePath});
 let r;
 if(keys==='all-accounts'){
  const rule=PRIVILEGED[platform].find(e=>e.id==='ssh-probe');
  r=await exec(SUDO,['-n',...rule.argv],{env,timeoutMs:PROBE_LIMITS.sshMs});
 }else r=await exec('/bin/sh',[path.join(root,PROBE_FILES.ssh)],{env,timeoutMs:PROBE_LIMITS.sshMs});
 if(r.timedOut)return {ok:false,error:'probe-timeout'};
 const {records,withheld}=cleanPart('sshkeys',linesOf(r.stdout),platform);
 if(!complete(records,platform))return {ok:false,error:'probe-incomplete'};
 return {ok:true,part:{schema:1,collectedAt,interval,records,...(withheld.length?{withheld}:{})}};
}
