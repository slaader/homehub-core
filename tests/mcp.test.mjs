import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {hub} from './hub-helper.mjs';

const rpc=(h,headers,method,params,id=1)=>fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},
 body:JSON.stringify({jsonrpc:'2.0',...(id===null?{}:{id}),method,...(params?{params}:{})})});
const call=async(h,headers,name,args)=>(await (await rpc(h,headers,'tools/call',{name,arguments:args})).json()).result;

test('MCP handshake, auth and transport rules',async t=>{
 const h=await hub(t);const agent=await h.account('agent-studio',['inventory:write']);
 const init=await rpc(h,agent.headers,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
 assert.equal(init.status,200);const r=(await init.json()).result;
 assert.equal(r.protocolVersion,'2025-06-18');assert.equal(r.serverInfo.name,'home-hub');assert.ok(r.capabilities.tools);assert.match(r.instructions,/agent-studio/);
 assert.equal((await (await rpc(h,agent.headers,'initialize',{protocolVersion:'1999-01-01'})).json()).result.protocolVersion,'2025-11-25','unknown version → latest');
 assert.equal((await rpc(h,agent.headers,'notifications/initialized',undefined,null)).status,202);
 assert.deepEqual((await (await rpc(h,agent.headers,'ping')).json()).result,{});
 assert.equal((await (await rpc(h,agent.headers,'resources/list')).json()).error.code,-32601);
 const none=await rpc(h,{},'tools/list');assert.equal(none.status,401);assert.match(none.headers.get('www-authenticate'),/Bearer/);
 assert.equal((await rpc(h,h.admin,'tools/list')).status,401,'browser sessions do not get MCP');
 assert.equal((await rpc(h,{Authorization:'Bearer hhk_'+'0'.repeat(64)},'tools/list')).status,401);
 assert.equal((await fetch(h.origin+'/mcp',{headers:agent.headers})).status,405);
 assert.equal((await rpc(h,{...agent.headers,Origin:'https://evil.example'},'tools/list')).status,403);
 const batch=await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...agent.headers},body:JSON.stringify([{jsonrpc:'2.0',id:1,method:'ping'}])});
 assert.equal(batch.status,400);
 const oversized=await rpc(h,agent.headers,'tools/call',{name:'wiki_page_save',arguments:{title:'x'.repeat(96000)}});
 assert.equal(oversized.status,413);
 assert.equal(oversized.headers.get('connection'),'close');
 assert.equal((await oversized.json()).error.code,'TOO_LARGE');
 const tracker=await h.account('tracker-writer',['tickets:write']);
 const oversizedWiki=await rpc(h,tracker.headers,'tools/call',{name:'wiki_page_save',arguments:{title:'x'.repeat(96000)}});
 assert.equal(oversizedWiki.status,413,'the larger Epic envelope does not enlarge other tool requests');
 assert.equal(oversizedWiki.headers.get('connection'),'close');

 assert.deepEqual((await (await rpc(h,agent.headers,'ping')).json()).result,{});
 const bad=await fetch(h.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...agent.headers},body:'{'});
 assert.equal((await bad.json()).error.code,-32700);
});

test('MCP tools follow scopes; inventory_update is hash-checked, secret-proof and logged',async t=>{
 const h=await hub(t);
 const agent=await h.account('agent-studio',['inventory:write']),reader=await h.account('reader-mini',[]);
 const names=async hd=>(await (await rpc(h,hd,'tools/list')).json()).result.tools.map(x=>x.name).sort();
 assert.deepEqual(await names(agent.headers),['backup_jobs_list','device_list','epic_get','epics_list','home_status','hub_version','integrations_status','inventory_bulk_upsert','inventory_delete','inventory_describe','inventory_get','inventory_search','inventory_update','models_overview','projects_list','reference_get','references_search','references_suggest','review_get','review_list','runtime_endpoints_list','search','service_register','ticket_attachment_get','ticket_get','ticket_hybrid_search','ticket_search','ticket_search_status','tickets_list','whoami','wiki_assets_list','wiki_get','wiki_list']);
 assert.deepEqual(await names(reader.headers),['backup_jobs_list','device_list','epic_get','epics_list','home_status','hub_version','integrations_status','inventory_describe','inventory_get','inventory_search','models_overview','projects_list','reference_get','references_search','references_suggest','review_get','review_list','runtime_endpoints_list','search','ticket_attachment_get','ticket_get','ticket_hybrid_search','ticket_search','ticket_search_status','tickets_list','whoami','wiki_assets_list','wiki_get','wiki_list']);
 const tools=(await (await rpc(h,agent.headers,'tools/list')).json()).result.tools;
 assert.ok(tools.every(x=>x.inputSchema?.type==='object'&&typeof x.description==='string'&&!('scope'in x)));

 const found=await call(h,reader.headers,'inventory_search',{query:'8081'});
 assert.equal(found.isError,false);assert.deepEqual(found.structuredContent.entries.map(e=>e.id),['studio-llama-swap']);
 // An argument the schema does not list is refused, not ignored; the legacy name says what it is now.
 assert.equal((await call(h,reader.headers,'inventory_search',{query:'8081',device:'studio'})).structuredContent.count,1);
 assert.equal((await call(h,reader.headers,'inventory_search',{query:'8081',device:'nas'})).structuredContent.count,0);
 const old=await call(h,reader.headers,'inventory_search',{query:'8081',machine:'nas'});
 assert.equal(old.isError,true);assert.match(old.content[0].text,/inventory_search does not take the argument "machine" \(use "device"\)/);
 const typo=await call(h,reader.headers,'inventory_search',{query:'8081',limt:3});
 assert.equal(typo.isError,true);assert.match(typo.content[0].text,/"limt"\. It takes: query, kind, device, limit\./);
 assert.match((await call(h,agent.headers,'device_list',{machines:true})).content[0].text,/"machines"\. It takes: runtime/,'a legacy name with no 2.0 counterpart in that tool is only unknown');
 const got=await call(h,reader.headers,'inventory_get',{id:'studio'});
 assert.deepEqual(got.structuredContent.dependents,[{id:'studio-llama-swap',via:'runs-on'}]);
 const entry=(await call(h,agent.headers,'inventory_get',{id:'studio-llama-swap'})).structuredContent;
 assert.equal((await call(h,agent.headers,'inventory_get',{id:'nope'})).isError,true);

 const denied=await call(h,reader.headers,'inventory_update',{entry:{...entry.entry,version:'x'},base:entry.hash});
 assert.equal(denied.isError,true);assert.match(denied.content[0].text,/inventory:write/);

 const stale=await call(h,agent.headers,'inventory_update',{entry:{...entry.entry,version:'v191'},base:'0'.repeat(64)});
 assert.equal(stale.isError,true);assert.match(stale.content[0].text,/changed since you read it/);
 const secret=await call(h,agent.headers,'inventory_update',{entry:{...entry.entry,notes:'password=hunter2hunter2'},base:entry.hash});
 assert.equal(secret.isError,true);assert.match(secret.content[0].text,/rejected/);
 const badId=await call(h,agent.headers,'inventory_update',{entry:{id:'BAD ID',kind:'runtime',name:'Bad'}});
 assert.equal(badId.isError,true);assert.match(badId.content[0].text,/Invalid request/);
 const done=await call(h,agent.headers,'inventory_update',{entry:{...entry.entry,version:'v191'},base:entry.hash});
 assert.equal(done.isError,false,done.content[0].text);assert.equal(done.structuredContent.by,'agent-studio');
 const onDisk=JSON.parse(await readFile(path.join(h.dir,'knowledge.json'),'utf8')).entries.find(e=>e.id==='studio-llama-swap');
 assert.equal(onDisk.version,'v191');assert.equal(onDisk.verified_by,'Home Hub API · agent-studio','the change names the service account');assert.ok(!JSON.stringify(onDisk).includes('hunter2'));
 const created=await call(h,agent.headers,'inventory_update',{entry:{id:'studio-omlx',kind:'runtime',device:'studio',name:'oMLX',address:'127.0.0.1:8000'}});
 assert.equal(created.isError,false,created.content[0].text);

 const status=await call(h,reader.headers,'home_status',{});
 assert.equal(status.isError,false);assert.ok(Array.isArray(status.structuredContent.devices));
 assert.equal((await (await rpc(h,agent.headers,'tools/call',{name:'rm_rf',arguments:{}})).json()).error.code,-32602);

 const audit=await (await fetch(h.origin+'/api/admin/audit',{headers:h.admin})).json();
 const mcp=audit.events.filter(e=>e.event==='mcp-call').map(e=>[e.subject,e.detail,e.status]).sort();
 // the reader's refused call never ran the tool but is logged as denied (no entry id from its arguments);
 // the agent's three failures (two with a valid entry id, one with an invalid id) and two writes are all logged
 assert.deepEqual(mcp,[['agent-studio','inventory_update · studio-llama-swap','error'],['agent-studio','inventory_update · studio-llama-swap','error'],
  ['agent-studio','inventory_update · studio-llama-swap','ok'],['agent-studio','inventory_update · studio-omlx','ok'],
  ['agent-studio','inventory_update','error'],['reader-mini','inventory_update','denied']]);
 const rawLines=(await readFile(path.join(h.dir,'api-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 const raw=rawLines.find(e=>e.status==='denied');
 assert.equal(raw.tool,'inventory_update');assert.equal(raw.name,'reader-mini');assert.ok(raw.account&&raw.key);assert.equal(raw.subject,undefined,'no request contents');
 assert.equal(rawLines.filter(e=>e.status==='error'&&e.subject==='studio-llama-swap').length,2,'validated entry.id is recorded on error');
 assert.equal(rawLines.filter(e=>e.status==='error'&&e.subject===undefined).length,1,'invalid entry.id is omitted from audit subject');
 assert.deepEqual(rawLines.filter(e=>e.status==='ok').map(e=>e.subject),['studio-llama-swap','studio-omlx'],'validated entry.id is recorded on success');
 assert.ok(audit.events.filter(e=>e.event==='mcp-call').every(e=>e.subject!=='reader-mini'||e.status==='denied'),'read-only tool calls are not logged');
 assert.ok(h.handler.mcpBusiness.catalog().every(t=>!('run'in t)&&!('module'in t)&&!('subject'in t)),'catalog exposes no internal hooks');
});

// Users and API → Connect draws its tool table from the UI manifest. That list is the registry itself:
// the same tools, in the same order, as a key with every scope gets from tools/list.
test('the UI manifest lists the MCP tools of the running registry, without handlers or schemas',async t=>{
 const h=await hub(t);const full=await h.account('agent-full',['*']);
 const listed=(await (await rpc(h,full.headers,'tools/list')).json()).result.tools;
 const manifest=await (await fetch(h.origin+'/api/ui/manifest',{headers:h.admin})).json();
 assert.deepEqual(manifest.tools.map(x=>x.name),listed.map(x=>x.name));
 for(const name of ['whoami','device_list','device_upsert','device_remove','runtime_publish','inventory_describe','inventory_bulk_upsert','inventory_delete','software_watch_list','software_watch_put','ticket_search'])
  assert.ok(manifest.tools.some(x=>x.name===name),name);
 for(const tool of manifest.tools){
  assert.deepEqual(Object.keys(tool).sort(),['description','module','name','scope','title','write'],tool.name);
  const real=listed.find(x=>x.name===tool.name);
  assert.equal(tool.description,real.description);assert.equal(tool.title,real.title||tool.name);
  assert.ok(manifest.modules.some(m=>m.id===tool.module),`${tool.name}: module ${tool.module} is a loaded module`);
 }
 const by=Object.fromEntries(manifest.tools.map(x=>[x.name,x]));
 assert.deepEqual([by.home_status.scope,by.home_status.write,by.home_status.module],['read',false,'home']);
 assert.deepEqual([by.device_upsert.scope,by.device_upsert.write,by.device_upsert.module],['home:write',true,'home']);
 assert.deepEqual([by.inventory_update.scope,by.inventory_update.write,by.inventory_update.module],['inventory:write',true,'inventory']);
 assert.deepEqual([by.tickets_list.scope,by.tickets_list.write,by.tickets_list.module],['read',false,'tracker']);
 assert.deepEqual([by.search.scope,by.search.write,by.search.module],['read',false,'tracker']);
 assert.deepEqual([by.review_list.scope,by.review_list.write,by.review_list.module],['read',false,'review']);
 assert.deepEqual([by.software_watch_put.scope,by.software_watch_put.write],['software:write',true]);
 // a reader's manifest carries the same reference (what exists and what it needs), a signed-out one nothing
 assert.equal((await (await fetch(h.origin+'/api/ui/manifest')).json()).tools,undefined);
 const view=await import('../public/access-view.js');
 assert.equal(/MCP_TOOLS\s*=/.test(await readFile(path.join(import.meta.dirname,'..','public','access-view.js'),'utf8')),false,'the page keeps no tool list of its own');
 const rows=view.toolRows(manifest.tools,manifest.modules);
 assert.equal(rows.length,listed.length);assert.ok(rows.every(r=>r.plugin===null),'core modules are not shown as plugins');
 // server/mcp.mjs is a domain-free dispatcher: every tool lives in its owning module.
 const mcpSource=await readFile(path.join(import.meta.dirname,'..','server','mcp.mjs'),'utf8');
 assert.doesNotMatch(mcpSource,/knowledge-edit|tickets-store|ticket-files|review-store|node:fs|node:crypto/,'server/mcp.mjs has zero domain store imports');
});

// What an agent reads on connect: short, generic, and only about tools its key can see.
test('initialize instructions: an orientation assembled from the modules, cut to the key\'s scopes',async t=>{
 const h=await hub(t);
 const full=await h.account('agent-full',['*']),reader=await h.account('reader',[]),inv=await h.account('agent-inventory',['inventory:write']);
 const read=async k=>(await (await rpc(h,k.headers,'initialize',{protocolVersion:'2025-06-18'})).json()).result.instructions;
 const tools=async k=>(await (await rpc(h,k.headers,'tools/list')).json()).result.tools.map(x=>x.name);
 const all=await read(full),plain=await read(reader),some=await read(inv);
 assert.match(all,/^Home Hub: /);assert.match(all,/service account "agent-full"/);assert.match(plain,/with scopes: read\./);
 // every area is covered: devices, runtime stacks, inventory (describe first, search before update, hashes), software watch, tracker, review
 for(const word of ['whoami','home_status','device_list','device_upsert','runtime_publish','inventory_describe','inventory_search','inventory_get','inventory_update','inventory_bulk_upsert','inventory_delete','software_watch_list','software_watch_put','tickets_list','ticket_search','ticket_get','ticket_create','references_suggest','review_list','review_get','review_publish'])
  assert.ok(all.includes(word),word);
 assert.match(all,/inventory_describe once[^\n]*inventory_search before you add/);assert.match(all,/hash you read as base/);assert.match(all,/Never store a secret/);
 assert.ok(all.length<4000&&plain.length<2100,`short: ${all.length} / ${plain.length} characters`);
 // a tool the text names is a tool that exists, and one the key can call
 const named=text=>[...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g))];
 for(const [key,text] of [[full,all],[reader,plain],[inv,some]]){const listed=await tools(key);for(const name of named(text))assert.ok(listed.includes(name),`${key.account.name}: ${name} is named but not listed`);}
 for(const word of ['device_upsert','runtime_publish','inventory_update','software_watch','ticket_create','review_publish','Never store a secret'])assert.ok(!plain.includes(word),`a read-only key is not told about ${word}`);
 assert.ok(some.includes('inventory_update')&&!some.includes('device_upsert')&&!some.includes('ticket_create'));
 // generic: nothing of one household, in either direction
 const {SITE}=await import('./hub-helper.mjs');
 for(const m of SITE.devices)assert.ok(!all.includes(m.name)&&!all.includes(m.hostname||'\u0000'),m.id);
 assert.ok(!all.includes(SITE.siteName));
});

test('registered MCP tools preserve method this-binding and ignore non-string or throwing subject hooks',async()=>{
 const {createMcp,toolError}=await import('../server/mcp.mjs');
 const {defineModule,createRegistry}=await import('../server/plugins.mjs');
 const logged=[];
 const strictLog=async entry=>{
  // Mimic access-store logApi stringifying subject if defined (null-prototype objects throw on String(x)).
  if(entry.subject!==undefined)String(entry.subject);
  logged.push(entry);
 };
 const schema={type:'object',properties:{fail:{type:'boolean'}},additionalProperties:false};
 const mod=defineModule({
  id:'demo',
  scopes:{'demo:write':{label:'Demo',desc:'Demo',write:true}},
  mcpTools:[
   {name:'demo_write',scope:'demo:write',title:'Demo write',description:'Writes demo.',inputSchema:schema,
    subject:()=>Object.create(null),
    run(args){if(args.fail)throw toolError('refused');return {name:this.name};}},
   {name:'demo_throw_subject',scope:'demo:write',title:'Demo throw',description:'Throws subject.',inputSchema:schema,
    subject:()=>{throw new Error('boom');},
    run(args){if(args.fail)throw toolError('refused');return {ok:true};}},
   {name:'demo_reject_subject',scope:'demo:write',title:'Demo reject',description:'Rejects subject.',inputSchema:schema,
    subject:async()=>{throw new Error('async boom');},
    run(args){if(args.fail)throw toolError('refused');return {ok:true};}},
  ],
 });
 const reg=createRegistry([mod]);
 const mcp=createMcp({tools:reg.tools,instructions:reg.instructions,ctx:{log:strictLog,moduleContext:()=>({state:{},hub:{}})}});
 const principal={id:'k1',accountId:'a1',username:'bot',permission:'write',scopes:['demo:write']};
 const call=async(name,args)=>JSON.parse((await mcp(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),principal)).body);

 const unhandled=[];
 const onUnhandled=reason=>unhandled.push(reason);
 process.on('unhandledRejection',onUnhandled);
 try{
  const okNullProto=await call('demo_write',{});
  assert.equal(okNullProto.error,undefined);
  assert.equal(okNullProto.result.isError,false);
  assert.deepEqual(okNullProto.result.structuredContent,{name:'demo_write'},'preserves registered tool this-binding');

  const errNullProto=await call('demo_write',{fail:true});
  assert.equal(errNullProto.error,undefined);
  assert.equal(errNullProto.result.isError,true);
  assert.equal(errNullProto.result.content[0].text,'refused');

  const okThrow=await call('demo_throw_subject',{});
  assert.equal(okThrow.error,undefined);
  assert.equal(okThrow.result.isError,false);

  const errThrow=await call('demo_throw_subject',{fail:true});
  assert.equal(errThrow.error,undefined);
  assert.equal(errThrow.result.isError,true);

  const okReject=await call('demo_reject_subject',{});
  assert.equal(okReject.error,undefined);
  assert.equal(okReject.result.isError,false);
  assert.deepEqual(okReject.result.structuredContent,{ok:true});

  const errReject=await call('demo_reject_subject',{fail:true});
  assert.equal(errReject.error,undefined);
  assert.equal(errReject.result.isError,true);
  assert.equal(errReject.result.content[0].text,'refused');

  await new Promise(resolve=>setImmediate(resolve));
 }finally{process.off('unhandledRejection',onUnhandled);}
 assert.deepEqual(unhandled,[],'rejected subject hook never triggers unhandledRejection');

 assert.deepEqual(logged.map(e=>[e.tool,e.status,e.subject]),[
  ['demo_write','ok',undefined],
  ['demo_write','error',undefined],
  ['demo_throw_subject','ok',undefined],
  ['demo_throw_subject','error',undefined],
  ['demo_reject_subject','ok',undefined],
  ['demo_reject_subject','error',undefined],
 ]);
});
