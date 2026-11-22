import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire} from './fixtures/mini-dom.mjs';
const {document}=installDom();
const {settingsView}=await import('../public/settings-view.js');
const {platformSettingsPage}=await import('../public/platform-settings-view.js');
const {searchView}=await import('../public/search-view.js');
const {setPrincipal}=await import('../public/session-cache.js');
const {setLang}=await import('../public/i18n.js');
const nodes=n=>[n,...n.children.flatMap(nodes)];
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
const admin={id:'owner',username:'alice',name:'Alice',role:'admin',roleId:'owner',roleName:'Vlastník',authKind:'session',canAdmin:true};
const cachedUpdate={installed:{label:'1.8.0'},repo:'example/core',
 latest:{version:'1.8.1',url:'https://github.com/example/core/releases/tag/v1.8.1'},updateAvailable:true,
 summaryT:[{key:'Je dostupné vydání {latest}. Běží {installed}.',params:{latest:'1.8.1',installed:'1.8.0'}}]};
const profile=me=>({user:me,permissions:[],prefs:{timeZone:null},site:{timeZone:null}});

test('profile groups account/password and user preferences, and only admins get management links',async()=>{
 setLang('en');
 for(const me of [admin,{...admin,role:'viewer',roleName:'Čtenář',canAdmin:false}]){
  setPrincipal(me);globalThis.fetch=async url=>Response.json(url==='/api/updates'?cachedUpdate:profile(me));
  document.body.replaceChildren(settingsView(me));await tick();
  const all=nodes(document.body),headers=all.filter(n=>n.tagName==='h2').map(n=>n.textContent);
  assert.deepEqual(headers,['Info','User settings']);
  const info=all.find(n=>n.getAttribute?.('aria-label')==='Info');assert.match(info.textContent,/alice/);assert.ok(nodes(info).some(n=>n.getAttribute?.('name')==='current'));
  const user=all.find(n=>n.getAttribute?.('aria-label')==='User settings');assert.match(user.textContent,/Language/);assert.match(user.textContent,/Time zone/);
  const hrefs=all.filter(n=>n.tagName==='a').map(n=>n.getAttribute('href'));
  assert.equal(hrefs.includes('#access/roles'),me.canAdmin);assert.equal(hrefs.includes('#access/people'),me.canAdmin);
 }
});

test('profile uses freshly fetched role permissions and drops responses from a previous sign-in',async()=>{
 setLang('en');setPrincipal(admin);
 const viewer={...admin,role:'viewer',roleId:'viewer',roleName:'Čtenář',canAdmin:false};
 globalThis.fetch=async url=>Response.json(url==='/api/updates'?cachedUpdate:profile(viewer));
 document.body.replaceChildren(settingsView(admin));await tick();
 assert.ok(!nodes(document.body).some(n=>n.getAttribute?.('href')==='#access/roles'),'freshly downgraded permissions remove the role link');
 let finish;globalThis.fetch=url=>url==='/api/updates'?Promise.resolve(Response.json(cachedUpdate)):new Promise(resolve=>{finish=resolve;});
 document.body.replaceChildren(settingsView(admin));setPrincipal({...viewer,username:'another-user'});
 finish({ok:true,status:200,json:async()=>profile({...admin,username:'late-profile'})});await tick();
 assert.ok(!document.body.textContent.includes('late-profile'));
});

test('platform settings guide is admin-only, exposes explicit toggle and saves without provider secrets',async()=>{
 setLang('en');let calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({configured:true,enabled:options.body?JSON.parse(options.body).enabled:false,model:'example-model',status:{semanticState:'disabled',coverage:{chunks:4,embedded:0}}})};};
 document.body.replaceChildren(platformSettingsPage({me:{...admin,canAdmin:false}}));await tick();assert.equal(calls.length,0);assert.match(document.body.textContent,/Administrator required/);
 setPrincipal(admin);document.body.replaceChildren(platformSettingsPage({me:admin}));await tick();
 assert.match(document.body.textContent,/Full-text search is the default/);assert.match(document.body.textContent,/Qwen3-Embedding/);assert.match(document.body.textContent,/EmbeddingGemma/);
 assert.match(document.body.textContent,/HOME_HUB_TICKET_EMBEDDING_URL/);
 const toggle=nodes(document.body).find(n=>n.getAttribute?.('id')==='semantic-enabled');toggle.checked=true;fire(toggle,'change');await tick();
 assert.deepEqual(JSON.parse(calls.find(c=>c.options.method==='POST').options.body),{enabled:true});
});

test('search begins in full-text mode and requests semantics only after the user selects it',async()=>{
 setLang('en');setPrincipal(admin);const requests=[];
 globalThis.fetch=async url=>{requests.push(String(url));return {ok:true,status:200,json:async()=>({semanticAvailable:true,indexed:{ticket:1,review:0},results:[]})};};
 document.body.replaceChildren(searchView(admin,'EAUTH_42'));await tick();
 assert.equal(new URL(requests[0],'http://example.test').searchParams.get('mode'),'text');
 const select=nodes(document.body).find(n=>n.tagName==='select');assert.ok(select);select.value='semantic';fire(select,'change');await tick();
 assert.equal(new URL(requests[1],'http://example.test').searchParams.get('mode'),'semantic');
});

test('settings reports installed and available versions and only administrators can check now',async()=>{
 setLang('en');
 const reader={...admin,role:'viewer',canAdmin:false},calls=[];
 let updates=cachedUpdate;
 globalThis.fetch=async(url,options={})=>{
  calls.push([url,options.method]);
  if(url==='/api/updates/check'){
   assert.equal(options.body,'{}');
   const latest={version:'1.8.2',url:'https://github.com/example/core/releases/tag/v1.8.2'};
   return Response.json({checked:true,updates:{...cachedUpdate,latest}});
  }
  return Response.json(url==='/api/updates'?updates:profile(reader));
 };
 const button=()=>nodes(document.body).find(n=>n.tagName==='button'&&n.textContent==='Check for updates');
 setPrincipal(reader);document.body.replaceChildren(settingsView(reader));await tick();
 assert.match(document.body.textContent,/Installed version1\.8\.0Latest known release1\.8\.1/);
 assert.match(document.body.textContent,/is available/);
 assert.equal(button(),undefined);
 setPrincipal(admin);document.body.replaceChildren(settingsView(admin));await tick();
 assert.ok(button());
 fire(button(),'click');await tick();
 assert.ok(calls.some(([url,method])=>url==='/api/updates/check'&&method==='POST'));
 assert.match(document.body.textContent,/Latest known release1\.8\.2/);
 updates={installed:{label:'1.8.0'},code:'disabled',summary:'Kontrola aktualizací je vypnutá. Home Hub nekontaktuje nikoho.'};
 document.body.replaceChildren(settingsView(admin));await tick();
 assert.match(document.body.textContent,/Update check is off|Update check is disabled|Update checking is off/i);
 assert.equal(button().disabled,true);
 assert.doesNotMatch(document.body.textContent,/up to date/i);
});
