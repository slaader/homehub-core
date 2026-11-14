// Shared by the push agent tests (tests/agent-*.test.mjs): a report envelope, one run of the systems probe split into
// its three parts, and a POST to the report route with an agent key. Placeholder values only.
export const T='\t',rec=(...f)=>f.join(T);
export const AT='2026-11-13T10:00:00Z';
// A Thermo poller that never reads anything.
export const quiet={status:()=>({}),seconds:()=>[],minutes:()=>[],live:()=>({}),disks:()=>({}),interval:()=>({intervalSeconds:15,lastPollAt:null}),addHost(){},removeHost(){},start:async()=>{},hosts:()=>[]};
export const envelope=(parts={heartbeat:{schema:1,interval:60}},extra={})=>({v:1,agentVersion:'1.6.0',platform:'macos',sentAt:AT,parts,...extra});
export function systemsParts({name='studio',host='Darwin',collectedAt=AT,interval=21600,os=[],updates=[rec('SWU_NONE')],packages=[rec('SW','node','cmd','v22.13.0','/opt/homebrew/bin/node')]}={}){
 const p=records=>({schema:1,collectedAt,interval,records});
 return {os:p([rec('HOST',name,host,'alice','0',collectedAt.replace(/\.\d+Z$/,'Z')),rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),rec('PRIV','listen','denied'),...os,rec('END','ok')]),
  updates:p(updates),packages:p(packages)};
}
export const reportTo=h=>(token,body,headers={})=>fetch(`${h.origin}/api/agent/report`,{method:'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
export const issueAgent=async(h,device,name)=>{const r=await h.post('/api/admin/agents',{device,...(name?{name}:{})},h.admin);if(r.status!==201)throw new Error(`issue ${device}: ${r.status}`);return r.json();};
export const errorCode=async r=>(await r.json()).error?.code;
