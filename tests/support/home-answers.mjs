// What the overview and the machine lists answer on the fixture site (push agent step 4, docs/agent.md §7): GET
// /api/home, GET /api/home/devices, the MCP tool machine_list, GET /api/admin/integrations and GET /api/admin/machines.
// tests/fixtures/home/no-agents.json holds them as the hub answered before step 4 (fa6829a), with one added device;
// a hub without agent keys must still answer exactly that, apart from what the contract adds (tests/agent-home.test.mjs).
// Times and ids that move with the clock or the run are replaced by a mark, and so is the repository the update check
// names: core writes it once, in package.json (tests/leak.test.mjs).
import {readFileSync} from 'node:fs';
import {hub} from '../hub-helper.mjs';

const REPO=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).homeHub?.updates?.repo||null;
const MOVING=new Set(['generatedAt','ageSeconds','createdAt','updatedAt','hash','at','lastSuccessAt','checkedAt','origin','pluginsDirectory']);
const unnamed=v=>typeof v==='string'&&REPO?v.split(REPO).join('<updates repo>'):v;
export const steady=v=>Array.isArray(v)?v.map(steady):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,MOVING.has(k)&&x!==null?'<moving>':steady(x)])):unnamed(v);
export const DEVICE={id:'pi-box',name:'Pi box',hostname:'pi.example.lan',ip:'10.0.0.40',role:'computer',platform:'linux',hardware:{cpu:'4c',gpu:'—',ramGb:8}};
// A Thermo poller that never reaches anything.
export const quietThermo={status:()=>({}),seconds:()=>[],minutes:()=>[],live:()=>({}),disks:()=>({}),interval:()=>({intervalSeconds:15,lastPollAt:null}),addHost(){},removeHost(){},start:async()=>{},stop:async()=>{},hosts:()=>[]};

// A hub on the fixture site with one added device (DEVICE); extra: more hub() options.
export async function homeHub(t,extra={}){
 const h=await hub(t,{thermoPoller:quietThermo,...extra});
 const writer=await h.account('writer',['home:write']);
 const r=await h.post('/api/home/devices',{machine:DEVICE},writer.headers);if(r.status!==201)throw new Error(`device: ${r.status}`);
 return {...h,writer};
}
// The answers, each {status, body}, with moving values marked. reader: headers of a key with read.
export async function homeAnswers(h){
 const get=async(url,headers=h.admin)=>{const r=await fetch(h.origin+url,{headers});return {status:r.status,body:steady(await r.json())};};
 const rpc=await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...h.writer.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'machine_list',arguments:{}}})});
 const list=(await rpc.json()).result;
 return {home:await get('/api/home'),machines:await get('/api/home/devices'),machineList:{status:rpc.status,body:steady(list.structuredContent)},
  integrations:await get('/api/admin/integrations'),adminMachines:await get('/api/admin/machines')};
}
