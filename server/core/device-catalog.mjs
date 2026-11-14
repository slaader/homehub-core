import {catalog,serviceRegistration,SERVICE_KINDS,SERVICE_PLATFORMS} from '../device-catalog.mjs';
import {toolError} from '../mcp.mjs';
const error=e=>[({invalid:422,conflict:409,busy:429})[e.message]||503,'SERVICE_REGISTRATION_FAILED',e.detail||({invalid:'Invalid service registration.',conflict:'The inventory entry changed. Read it again and pass its current hash.',busy:'Another inventory edit is in progress.'})[e.message]||'The catalog is unavailable.'];
const only=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw Object.assign(new Error('invalid'),{detail:`Expected only ${keys.join(', ')||'no arguments'}`});};
async function inputs(hub){
 const inventory=await hub.state('inventory').read();if(!inventory)throw new Error('unavailable');
 const runtime=hub.state('runtimes'),watch=(await hub.state('security').watch.read()).registry;
 const endpoints=await runtime.endpoints();return {inventory,endpoints,watch};
}
async function read(hub){
 const data=await inputs(hub),runtime=hub.state('runtimes'),runtimeIds=await runtime.poller.runtimeIds();
 const added=await hub.state('home').homeDevices.list();
 const models=await hub.state('models').read();
 return {...catalog({...data,devices:[...hub.site.devices,...added],models,endpoints:data.endpoints.map(e=>({...e,runtimeId:runtimeIds.get(e.id),status:runtime.poller.status(e.id).state}))}),
  generatedAt:new Date().toISOString(),kinds:SERVICE_KINDS,platforms:SERVICE_PLATFORMS};
}
async function register(hub,input,principal){
 const change=serviceRegistration(input,await inputs(hub));
 const result=await hub.state('inventory').put(change,principal.authKind==='api-key'&&principal.accountId?principal.username:null);
 if(!result?.ok)throw Object.assign(new Error('invalid'),{detail:(result?.errors||[]).slice(0,10).join('; ')||'Inventory validation failed'});
 return {ok:true,entry:result.entry,hash:result.hash,published:result.published!==false};
}
const FIELDS={id:{type:'string'},name:{type:'string'},device:{type:'string'},kind:{type:'string',enum:SERVICE_KINDS},binary:{type:'string'},
 platform:{type:'string',enum:SERVICE_PLATFORMS},mode:{type:'string',enum:['server','on-demand']},port:{type:['integer','null']},address:{type:'string'},endpointId:{type:'string'},watchId:{type:'string'},base:{type:'string'}};
const tool=async fn=>{try{return await fn();}catch(e){throw toolError(error(e)[2]);}};
export default {
 id:'device-catalog',title:'Devices and services',
 assets:['device-catalog.js','device-catalog.css','i18n-en-catalog.js'],
 nav:[{groupKey:'Inventář',hash:'device-catalog',labelKey:'Zařízení a služby',view:'device-catalog.js#deviceCatalogPage',scope:'security:read',admin:true,order:19,icon:'flow'}],
 strings:{en:{'Zařízení a služby':'Devices and services'}},
 routes:[
  // Watch rules are security:read information, so the joined catalog retains that boundary.
  {method:'GET',path:'/api/device-catalog',scope:'security:read',error,handler:async({json,hub})=>json(200,await read(hub))},
  {method:'POST',path:'/api/service-registrations',scope:'inventory:write',error,handler:async c=>{c.subject=typeof c.input?.id==='string'?c.input.id:null;return c.json(200,await register(c.hub,c.input,c.principal));}},
 ],
 mcpInstructions:[
  {scope:'security:read',text:'device_catalog joins devices, services, software, models and client/service links from existing sources.'},
  {scope:'inventory:write',text:'service_register records installed service metadata. Read inventory_get for its hash before replacing; no binary is run.'},
 ],
 mcpTools:[
  {name:'device_catalog',scope:'security:read',title:'Devices: services, software and model relationships',description:'Read the joined device catalog. Services come from inventory and runtime endpoints, software from watch rules and inventory tools, models and clients from runtime observations. Configured software rules do not prove an installation was observed. Unknown clients or service references stay null.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},run:(args,{hub})=>tool(async()=>{only(args,[]);return read(hub);})},
  {name:'service_register',scope:'inventory:write',title:'Services: register installed service',description:'Create or update the typed descriptor of an inventory runtime entry. Device must already be an inventory device. Binary is a path, never executed. A server needs a port; on-demand uses null. Optional endpointId and watchId must exist on that device. Existing entry requires its inventory hash as base. Notes, dependencies and secret pointers are preserved.',inputSchema:{type:'object',properties:FIELDS,required:['id','name','device','kind','binary','platform','port'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},run:(args,{hub,principal})=>tool(()=>register(hub,args,principal))},
 ],
 apiDocs:[{title:'Device catalog',routes:[
  ['GET','/api/device-catalog','security:read','Devices, services, software, model deployments and client/service links from existing stores. MCP device_catalog.'],
  ['POST','/api/service-registrations','inventory:write','Register an installed service in inventory, preserving other fields; existing records require base. MCP service_register.'],
 ]}],
};
