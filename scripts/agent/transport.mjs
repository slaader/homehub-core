// The push agent's one request (docs/agent.md §4): POST /api/agent/report to the hub of agent.json, through
// server/endpoint-http.mjs, so trust is checked before a byte of the request is written (the system store, a CA
// file, or one or two pins; fail closed), no redirect is followed, nothing compressed is read, there is a deadline,
// and the reply is capped at 64 KiB. The key goes only into the Authorization header: never a log line, never an error.
//
// Of the hub's answer the agent reads three things and nothing else: the status code, Retry-After, and the
// acknowledgement ({receivedAt, accepted, refused}), each value checked against what was sent. Any other field, a
// body that is not JSON, or anything that looks like an instruction is ignored: the hub has no way to make the agent
// run, fetch or change anything (the invariant of docs/agent.md).
import {endpointRequest} from '../../server/endpoint-http.mjs';
import {PART_CODES} from '../../server/agent-report.mjs';

export const REPORT_PATH='/api/agent/report';
export const TRANSPORT_LIMITS=Object.freeze({replyBytes:65536,timeoutMs:30000,retryAfterMax:3600});
const TAG=/^[A-Z][A-Z0-9_]{0,19}$/,ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;

/** Retry-After as whole seconds (1–3600), or null. An HTTP date is not read: the hub sends seconds. */
export function retryAfterOf(headers){
 const v=headers?.['retry-after'];
 if(typeof v!=='string'||!/^\d{1,6}$/.test(v.trim()))return null;
 return Math.min(Math.max(1,Number(v.trim())),TRANSPORT_LIMITS.retryAfterMax);
}
/** The acknowledgement of a 200, reduced to the parts that were sent → {receivedAt, accepted, refused}. Never throws. */
export function readAck(body,sent){
 let raw=null;try{raw=JSON.parse(Buffer.isBuffer(body)?body.toString('utf8'):String(body??''));}catch{}
 const out={receivedAt:null,accepted:[],refused:[]};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
 if(typeof raw.receivedAt==='string'&&ISO.test(raw.receivedAt))out.receivedAt=raw.receivedAt;
 if(Array.isArray(raw.accepted))out.accepted=[...new Set(raw.accepted.filter(p=>typeof p==='string'&&sent.includes(p)))];
 if(Array.isArray(raw.refused))for(const r of raw.refused.slice(0,32)){
  if(!r||typeof r!=='object'||!sent.includes(r.part)||!PART_CODES.includes(r.code)||out.accepted.includes(r.part)||out.refused.some(x=>x.part===r.part))continue;
  out.refused.push({part:r.part,code:r.code,...(typeof r.tag==='string'&&TAG.test(r.tag)?{tag:r.tag}:{}),...(Number.isSafeInteger(r.field)&&r.field>=0&&r.field<=64?{field:r.field}:{})});
 }
 return out;
}

/**
 * Sends one envelope. hub: {host, port, secure}; trust: endpoint-http's trust (null for http://127.0.0.1).
 * → {status, retryAfter, ack} for any answer (status 0 and error: a code when nothing usable came back).
 */
export async function sendReport({hub,trust,token,envelope,request=endpointRequest,timeoutMs=TRANSPORT_LIMITS.timeoutMs}){
 const sent=Object.keys(envelope.parts);
 const body=Buffer.from(JSON.stringify(envelope),'utf8');
 try{
  const r=await request({host:hub.host,port:hub.port,path:REPORT_PATH,method:'POST',trust:hub.secure?trust:null,loopbackAuth:!hub.secure,
   headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json','User-Agent':'home-hub-agent'},body,
   timeoutMs,maxBytes:TRANSPORT_LIMITS.replyBytes,okStatus:[200]});
  return {status:200,retryAfter:null,ack:readAck(r.body,sent)};
 }catch(e){
  if(e?.message==='http'&&Number.isSafeInteger(e.status))return {status:e.status,retryAfter:retryAfterOf(e.headers),ack:null};
  const code=/^[a-z-]{2,20}$/.test(e?.message||'')?e.message:'error';
  return {status:0,retryAfter:null,ack:null,error:code};
 }
}
