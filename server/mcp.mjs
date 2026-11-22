// Home Hub MCP endpoint: POST /mcp, Streamable HTTP transport answered with plain JSON (stateless,
// no session id, no server-initiated stream). Agents authenticate with a service-account key
// (Authorization: Bearer hhk_…). tools/list shows only what the key's scopes allow and
// tools/call checks the scope again. Every call of a write tool is logged (access-store logApi).
// Every tool (core and plugin alike) is registered through mcpTools in its module definition
// (server/plugins.mjs), each with a run(args, {principal, state, hub}) function and an optional
// subject(args, data) hook for the write audit log. The initialize instructions are assembled from
// the modules' mcpInstructions, so each module describes its own tools.
import {toolError} from './tool-error.mjs';
import {SCOPES} from './scopes.mjs';
import {renamedKey} from './state-forward.mjs';

export const MCP_PROTOCOLS=Object.freeze(['2025-11-25','2025-06-18','2025-03-26']);
const text=(v,n=200)=>typeof v==='string'?v.slice(0,n):'';

// What a person may read about the tools (Users and API → Connect, from the UI manifest): the name, the
// title, the scope a key needs, whether that scope writes, the description written for agents and the
// module that registered the tool. Never the run/subject functions, and no input schemas: tools/list has those.
// tools: the tools modules registered (registry.tools), in the order tools/list returns them.
export const toolCatalog=(tools=[])=>tools
 .map(t=>({name:t.name,title:typeof t.title==='string'&&t.title?t.title:t.name,scope:t.scope,write:!SCOPES[t.scope]?.readOnly,description:t.description,module:t.module}));

/**
 * A tool whose schema says additionalProperties:false takes only the arguments it lists; anything else is refused.
 * A legacy argument (server/state-forward.mjs) is told its new name instead of being ignored.
 */
function unknownArguments(tool,args){
 const schema=tool.inputSchema;
 if(!schema||schema.additionalProperties!==false)return null;
 const known=Object.keys(schema.properties||{}),extra=Object.keys(args).filter(k=>!Object.hasOwn(schema.properties||{},k));
 if(!extra.length)return null;
 const said=extra.slice(0,5).map(k=>{const name=JSON.stringify(text(k,40));const now=renamedKey(k);return now&&known.includes(now)?`${name} (use "${now}")`:name;});
 return `${tool.name} does not take the argument${extra.length>1?'s':''} ${said.join(', ')}${extra.length>5?', …':''}. It takes: ${known.join(', ')||'no arguments'}.`;
}
// Write-audit subject: a tool may supply subject(args, data) when a validated identifier should be logged
// on error too; otherwise subjects come only from successful store results, never rejected argument text.
const subjectString=v=>typeof v==='string'&&v?v:undefined;
const subjectOf=async(entry,args,data)=>{
 if(!entry.raw.subject)return subjectString(data?.id)||subjectString(data?.project);
 try{return subjectString(await entry.raw.subject(args,data));}catch{return undefined;}
};

/**
 * ctx.log(entry): Promise; ctx.moduleContext(moduleId): {state, hub}
 */
export function createMcpBusiness({version='2',ctx,tools=[],instructions=[]}){
 const allowed=(principal,tool)=>principal.scopes.includes(tool.scope);
 // What an agent reads when it connects: what this is, who it is here, then a few lines per module that has
 // something to say (mcpInstructions in the module definitions, core and plugins alike, in load order).
 // A part that names a scope is left out for a key without it, so nothing points at a tool the key cannot see.
 const orientation=principal=>{
  const lines=new Map();
  for(const part of instructions)if(!part.scope||principal.scopes.includes(part.scope))lines.set(part.module,[...(lines.get(part.module)||[]),part.text]);
  return [`Home Hub: devices and runtimes, inventory, project tracking, and design review. You are service account "${principal.username}" with scopes: ${principal.scopes.join(', ')}. tools/list shows only what these scopes allow.${principal.permission==='write'?' Read a thing before you change it: the change takes the hash or rev you read and is refused when that is stale; then read again, never force. Never store a secret (password, token, key) here: record where it is kept.':''}`,
   ...[...lines.values()].map(parts=>parts.join(' '))].join('\n');
 };
 // Tools registered by modules, in registration order; a name can only be claimed once (checked by the registry).
 const TOOLS=tools.map(({run,module,subject,...tool})=>tool);
 if(new Set(TOOLS.map(t=>t.name)).size!==TOOLS.length)throw new Error('MCP tool names must be unique');
 const entries=new Map(tools.map((t,i)=>[t.name,{tool:TOOLS[i],raw:t}]));

 async function dispatch(msg,principal){
  const {method,params}=msg;
  if(method==='initialize'){
   const asked=params?.protocolVersion;
   return {protocolVersion:MCP_PROTOCOLS.includes(asked)?asked:MCP_PROTOCOLS[0],capabilities:{tools:{listChanged:false}},
    serverInfo:{name:'home-hub',title:'Home Hub',version},
    instructions:orientation(principal)};
  }
  if(method==='ping')return {};
  if(method==='tools/list')return {tools:TOOLS.filter(t=>allowed(principal,t)).map(({scope,...t})=>t)};
  if(method==='tools/call'){
   const entry=entries.get(params?.name);
   if(!entry)throw Object.assign(new Error(`Unknown tool: ${text(params?.name,60)}`),{code:-32602});
   const {tool}=entry;
   const args=params.arguments??{};
   if(!args||typeof args!=='object'||Array.isArray(args))throw Object.assign(new Error('arguments must be an object'),{code:-32602});
   const write=tool.scope!=='read';
   // Refused write attempts are logged too (account, tool, status only; nothing from the arguments).
   if(!allowed(principal,tool)){
    if(write)await ctx.log({key:principal.id,account:principal.accountId,name:principal.username,tool:tool.name,status:'denied'}).catch(()=>{});
    const message=`This service account lacks the "${tool.scope}" scope needed for ${tool.name}.`;
    return {content:[{type:'text',text:message}],structuredContent:{error:{code:'SCOPE_REQUIRED',reason:'denied',message}},isError:true};
   }
   try{
    const unknown=unknownArguments(tool,args);if(unknown)throw toolError(unknown);
    const data=await entry.raw.run(args,{principal,...ctx.moduleContext?.(entry.raw.module)});
    if(write)await ctx.log({key:principal.id,account:principal.accountId,name:principal.username,tool:tool.name,status:'ok',subject:await subjectOf(entry,args,data)}).catch(()=>{});
    if(data?.mcpContent)return {content:data.mcpContent,structuredContent:data.meta,isError:false};
    return {content:[{type:'text',text:JSON.stringify(data,null,1)}],structuredContent:data,isError:false};
   }catch(e){
    if(write)await ctx.log({key:principal.id,account:principal.accountId,name:principal.username,tool:tool.name,status:'error',subject:await subjectOf(entry,args)}).catch(()=>{});
    if(e?.toolError===true)return {content:[{type:'text',text:e.message}],
     ...(e.details?{structuredContent:e.details}:{}),isError:true};
    throw e;
   }
  }
  throw Object.assign(new Error(`Method not found: ${text(method,60)}`),{code:-32601});
 }

 return Object.freeze({
  catalog:()=>TOOLS,
  initialize:principal=>({serverInfo:{name:'home-hub',title:'Home Hub',version},instructions:orientation(principal)}),
  callTool:(name,args,principal)=>dispatch({method:'tools/call',params:{name,arguments:args}},principal),
  dispatch
 });
}

export function createMcp(options){
 const business=createMcpBusiness(options),{dispatch}=business;
 // Returns {status, headers, body}; the HTTP layer does auth, origin and size checks first.
 const handle=async function handle(raw,principal){
  let msg;try{msg=JSON.parse(raw);}catch{return reply(400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
  if(Array.isArray(msg))return reply(400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Batch requests are not supported.'}});
  if(!msg||typeof msg!=='object'||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'){
   if(msg&&typeof msg==='object'&&('result'in msg||'error'in msg))return {status:202};
   return reply(400,{jsonrpc:'2.0',id:msg?.id??null,error:{code:-32600,message:'Invalid Request'}});
  }
  if(!('id'in msg)||msg.id===null)return {status:202}; // notification (e.g. notifications/initialized)
  try{return reply(200,{jsonrpc:'2.0',id:msg.id,result:await dispatch(msg,principal)});}
  catch(e){return reply(200,{jsonrpc:'2.0',id:msg.id,error:{code:Number.isInteger(e.code)?e.code:-32603,message:Number.isInteger(e.code)?e.message:'Internal error'}});}
 };
 handle.business=business;return handle;
}
const reply=(status,body)=>({status,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
// toolError (server/tool-error.mjs): for a module tool's run(), an error whose message goes back to the agent as the
// tool result (isError: true). Anything else a tool throws is reported as an internal error.
export {toolError};
