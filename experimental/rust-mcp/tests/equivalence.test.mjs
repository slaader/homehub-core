// Independent parent-owned comparison against actual core + plugin business execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hub} from '../../../tests/hub-helper.mjs';
import {rustFrontend} from '../../../tests/support/rust-mcp-harness.mjs';

test('Node and Rust: actual core/plugin catalog, reads, envelopes, writes, conflicts, scopes and audit',async t=>{
 const cleanup=[],plugin={id:'experiment',mcpTools:[{name:'experiment_echo',scope:'read',description:'Plugin parity probe',inputSchema:{type:'object',properties:{text:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true},run:args=>({echo:args.text})}]};
 const h=await hub({after:fn=>cleanup.push(fn)},{plugins:[plugin],ticketSearch:{env:{}}});let rust;
 t.after(async()=>{await rust?.close();await h.handler.stop();for(const fn of cleanup.reverse())await fn();});
 rust=await rustFrontend(h);
 const writer=await h.account('parity-writer',['tickets:write']),reader=await h.account('parity-reader',[]);
 const request=async(origin,body,key=writer.headers)=>{
  const r=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...key},body:typeof body==='string'?body:JSON.stringify(body)});return {status:r.status,body:await r.text()};
 };
 const json=(method,params,id=1)=>({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})});
 async function compare(body,key){const [a,b]=await Promise.all([request(h.origin,body,key),request(rust.origin,body,key)]);assert.equal(b.status,a.status);assert.deepEqual(b.body?JSON.parse(b.body):null,a.body?JSON.parse(a.body):null);return a.body?JSON.parse(a.body):null;}
 const call=(origin,name,args,key)=>request(origin,json('tools/call',{name,arguments:args}),key).then(r=>JSON.parse(r.body));
 for(const body of ['{','[]','null',json('initialize',{protocolVersion:'unknown'}),json('initialize',{protocolVersion:'2025-03-26'}),json('ping'),json('unknown'),json('tools/list'),json('tools/call',{name:'absent',arguments:[]}),json('tools/call',{name:'ticket_get',arguments:[]}),json('tools/call',{name:'ticket_get',arguments:{id:'missing'}}),json('notifications/initialized',{},null),{jsonrpc:'2.0',id:1,result:{}}])await compare(body);
 const catalog=await compare(json('tools/list'),reader.headers);assert.ok(catalog.result.tools.some(x=>x.name==='experiment_echo'));assert.ok(!catalog.result.tools.some(x=>x.name==='ticket_create'));
 await compare(json('tools/call',{name:'experiment_echo',arguments:{text:'<script> résumé 🦊'}}));
 await compare(json('tools/call',{name:'ticket_create',arguments:{project:'sample',title:'Denied'}}),reader.headers);
 let project=await call(h.origin,'project_save',{id:'sample',key:'SM',name:'Sample'});assert.equal(project.result.isError,false);
 const a=await call(h.origin,'ticket_create',{project:'sample',title:'Node issue EAUTH_42'}),b=await call(rust.origin,'ticket_create',{project:'sample',title:'Rust issue EAUTH_42'});
 assert.equal(a.result.structuredContent.id,'SM-1');assert.equal(b.result.structuredContent.id,'SM-2');
 for(const id of ['SM-1','SM-2']){
  await compare(json('tools/call',{name:'ticket_get',arguments:{id}}));
  const saved=await call(rust.origin,'ticket_update',{id,rev:1,priority:'high'});assert.equal(saved.result.structuredContent.rev,2);
  await compare(json('tools/call',{name:'ticket_update',arguments:{id,rev:1,priority:'low'}}));
 }
 const encoded=Buffer.from('Attachment-only ENETRESET_990 socket hang up').toString('base64');
 const attached=await call(rust.origin,'ticket_attachment_put',{id:'SM-2',name:'errors.txt',data:encoded});assert.equal(attached.result.structuredContent.attachments.length,1);
 await h.handler.state('tracker').ticketSearch.whenIdle();
 for(const [name,args]of [['projects_list',{}],['tickets_list',{status:'active'}],['ticket_search',{query:'EAUTH_42'}],['ticket_hybrid_search',{query:'ENETRESET_990'}],['search',{query:'ENETRESET_990'}],['ticket_attachment_get',{id:'SM-2',attachment:attached.result.structuredContent.attachments[0].id}],['whoami',{}]])await compare(json('tools/call',{name,arguments:args}));
 const audit=(await readFile(h.dir+'/api-audit.jsonl','utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(audit.some(x=>x.tool==='ticket_create'&&x.status==='denied'));
 assert.ok(audit.some(x=>x.tool==='ticket_attachment_put'&&x.status==='ok'));
 assert.ok(audit.some(x=>x.tool==='ticket_update'&&x.status==='error'));
 await h.handler.hub.accessStore.updateAccount({id:writer.account.id,scopes:[]});
 await compare(json('tools/list'));await compare(json('tools/call',{name:'ticket_comment',arguments:{id:'SM-2',text:'Denied after role change'}}));
 await h.handler.hub.accessStore.updateAccount({id:writer.account.id,disabled:true});
 assert.equal((await request(h.origin,json('ping'))).status,401);assert.equal((await request(rust.origin,json('ping'))).status,401);
 assert.equal(rust.stderr(),'');
});
