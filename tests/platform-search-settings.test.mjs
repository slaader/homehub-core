import test from 'node:test';
import assert from 'node:assert/strict';
import {hub} from './hub-helper.mjs';
import {createPlatformSearch} from '../server/platform-search-settings.mjs';

test('platform search: session-admin only, explicit opt-in, persistent opt-out and no default query embeddings',async t=>{
 let inputs=0,queries=0;
 const embed=async(texts,{query}={})=>{inputs+=texts.length;if(query)queries++;return texts.map(()=>[1,0]);};
 const h=await hub(t,{ticketSearch:{env:{},embed,modelFingerprint:'platform-test'}});
 t.after(()=>h.handler.stop());
 const agent=await h.account('search-writer',['tickets:write']),reader=await h.account('search-reader',[]);
 const get=headers=>fetch(h.origin+'/api/admin/platform/search',{headers});
 assert.equal((await get()).status,401);
 assert.equal((await get(agent.headers)).status,403,'API keys cannot configure platform search');
 const app=await (await h.post('/api/app-tokens',{name:'settings-test'},h.admin)).json();
 assert.equal((await get({Authorization:'Bearer '+app.token})).status,403,'an app token is not an administrator password session');
 await h.post('/api/admin/users',{username:'viewer',password:'viewer-test-password'},h.admin);
 const login=await h.post('/api/session',{username:'viewer',password:'viewer-test-password'});
 const viewer={Cookie:login.headers.get('set-cookie').split(';')[0]};
 assert.equal((await get(viewer)).status,403);
 assert.equal((await h.post('/api/admin/platform/search',{enabled:true},viewer)).status,403);
 const first=await (await get(h.admin)).json();assert.equal(first.enabled,false);assert.equal(first.configured,true);assert.equal(first.defaultMode,'text');
 await h.post('/api/tickets/projects',{id:'sample',key:'SM',name:'Sample'},h.admin);
 const ticket=await (await h.post('/api/tickets',{project:'sample',title:'Exact identifier EAUTH_42'},h.admin)).json();
 const file=await fetch(h.origin+`/api/tickets/${ticket.id}/attachments?name=errors.txt`,{method:'PUT',headers:{...agent.headers,'Content-Type':'application/octet-stream'},body:'Only attachment has EATTACH_930 and socket hang up'});assert.equal(file.status,201);
 const service=h.handler.state('tracker').ticketSearch;
 await service.whenIdle();assert.equal(inputs,0,'configured provider has zero traffic until enabled');
 const defaultResult=await service.search({query:'EATTACH_930'});assert.equal(defaultResult.mode,'text');assert.ok(defaultResult.results.some(x=>x.ticket===ticket.id));
 const global=await (await fetch(h.origin+'/api/search?q=EATTACH_930',{headers:reader.headers})).json();assert.equal(global.results[0].id,ticket.id);assert.ok(global.results[0].attachment);assert.equal(global.semanticAvailable,false);
 const rpc=await h.post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search',arguments:{query:'EATTACH_930'}}},reader.headers);
 assert.equal((await rpc.json()).result.structuredContent.results[0].id,ticket.id,'default MCP search includes file bodies');
 for(const body of [{enabled:'true'},{enabled:true,url:'https://example.com'},{}])assert.equal((await h.post('/api/admin/platform/search',body,h.admin)).status,400);
 assert.equal((await h.post('/api/admin/platform/search',{enabled:true},h.admin)).status,200);
 await service.whenIdle();assert.ok(inputs>0);const before=queries;
 assert.equal((await service.search({query:'EAUTH_42'})).mode,'text');assert.equal(queries,before,'even enabled search defaults to full-text');
 await service.search({query:'meaning',mode:'semantic'});assert.equal(queries,before+1);
 assert.equal((await h.post('/api/admin/platform/search',{enabled:false},h.admin)).status,200);await service.whenIdle();const stopped=inputs;
 assert.equal((await service.search({query:'meaning',mode:'semantic'})).state,'disabled');assert.equal(inputs,stopped);
 const {tickets,ticketFiles}=h.handler.state('tracker');const reopened=createPlatformSearch(h.handler.hub.stateDirectory+'/tickets',{db:h.handler.hub.db,tickets,ticketFiles,env:{},embed,modelFingerprint:'platform-test'});
 t.after(()=>reopened.close());assert.equal((await reopened.settings()).enabled,false,'administrator preference survives reopen');
 const manifest=async headers=>(await (await fetch(h.origin+'/api/ui/manifest',{headers})).json()).nav.flatMap(x=>x.items||[]);
 assert.ok((await manifest(h.admin)).some(x=>x.hash==='platform-settings'));
 assert.ok(!(await manifest(viewer)).some(x=>x.hash==='platform-settings'));
});

test('platform opt-in survives a restart while default search remains text',async t=>{
 const h=await hub(t,{ticketSearch:{env:{},embed:async xs=>xs.map(()=>[1,0]),modelFingerprint:'persist-opt-in'}});
 const {tickets,ticketFiles,ticketSearch}=h.handler.state('tracker');
 await ticketSearch.setEnabled({enabled:true});await ticketSearch.close();
 const reopened=createPlatformSearch(h.dir+'/tickets',{db:h.handler.hub.db,tickets,ticketFiles,env:{},embed:async xs=>xs.map(()=>[1,0]),modelFingerprint:'persist-opt-in'});
 t.after(()=>reopened.close());
 const settings=await reopened.settings();assert.equal(settings.enabled,true);assert.equal(settings.defaultMode,'text');
 await reopened.whenIdle();assert.equal((await reopened.search({query:'unmatched'})).requestedMode,'text');
});

test('platform search: unconfigured provider cannot be enabled and semantic settings never reveal credentials',async t=>{
 const h=await hub(t,{ticketSearch:{env:{}}});t.after(()=>h.handler.stop());
 const settings=await (await fetch(h.origin+'/api/admin/platform/search',{headers:h.admin})).json();
 assert.equal(settings.configured,false);assert.equal(settings.enabled,false);
 assert.equal((await h.post('/api/admin/platform/search',{enabled:true},h.admin)).status,400);
 assert.equal('token'in settings,false);assert.equal('url'in settings,false);
 const {tickets,ticketFiles}=h.handler.state('tracker');
 assert.throws(()=>createPlatformSearch(h.dir+'/tickets',{db:h.handler.hub.db,tickets,ticketFiles,env:{HOME_HUB_TICKET_EMBEDDING_URL:'http://example.com/v1/embeddings',HOME_HUB_TICKET_EMBEDDING_MODEL:'example'}}),/embedding endpoint/,'invalid provider configuration is refused before opt-in can be persisted');
 for(const asset of ['/platform-settings-view.js','/settings-view.js','/settings.css'])assert.equal((await fetch(h.origin+asset)).status,200);
 assert.equal((await fetch(h.origin+'/healthz')).status,200);
});
