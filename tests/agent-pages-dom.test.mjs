// Push agent, step 4 (docs/agent.md §7) on a small DOM (tests/fixtures/mini-dom.mjs): the agent line on a tile and
// the section on a machine page (public/home-agent.js), and the agent keys on Users and API (public/access-view.js →
// agentsTab). Every string an agent or a machine supplies is drawn as text, English is complete, "no news" is the word
// for a quiet agent (never off), and the token appears once, in the one-time dialog, and nowhere after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,fire,Element} from './fixtures/mini-dom.mjs';
import {buildHome} from '../server/home-data.mjs';
import {SITE} from './hub-helper.mjs';
import {quiet} from './support/agent.mjs';

const {document}=installDom();
// What the dialogs need from a browser: showModal, and close() firing "close".
Element.prototype.showModal=function(){this.setAttribute('open','');};
Element.prototype.close=function(){this.removeAttribute('open');fire(this,'close');};
Element.prototype.select=function(){};
const bus=new EventTarget();
globalThis.addEventListener??=bus.addEventListener.bind(bus);
globalThis.dispatchEvent??=bus.dispatchEvent.bind(bus);
globalThis.location={origin:'https://hub.example.lan',hash:'#access/agents',pathname:'/'};
const i18n=await import('../public/i18n.js');
const {agentLine,agentSection,agentState}=await import('../public/home-agent.js');
const {accessView,agentMachines,agentKeyFile}=await import('../public/access-view.js');
const {setPrincipal}=await import('../public/session-cache.js');

const MARKUP='<img src=x onerror=alert(1)>';
const NOW=Date.now(),iso=ms=>new Date(NOW-ms).toISOString();
const clean=text=>{assert.doesNotMatch(text,/[ěščřžýáíůúťďňĚŠČŘŽÝÁÍŮÚŤĎŇ]/,'a Czech string without English');assert.doesNotMatch(text,/undefined|NaN|\[object|\{\w+\}/);return text;};
const all=(node,cls)=>{const out=[],visit=n=>{for(const k of n.children||[]){if((k.getAttribute('class')||'').split(' ').includes(cls))out.push(k);visit(k);}};visit(node);return out;};
const byTag=(node,tag)=>{const out=[],visit=n=>{for(const k of n.children||[]){if(k.tagName===tag)out.push(k);visit(k);}};visit(node);return out;};
// Every attribute value under a node: a token must not hide in one either.
const attrs=node=>{const out=[],visit=n=>{for(const k of n.children||[]){out.push(...k.attrs.values());visit(k);}};visit(node);return out;};
const tick=()=>new Promise(r=>setImmediate(r));
const settle=async()=>{for(let i=0;i<10;i++)await tick();};

// The overview's machines as the server builds them, with the agent entries the agent module would hand over.
function home(agents,now=NOW){
 return buildHome({site:SITE,thermo:quiet,now,agentNow:now,hubVersion:'1.6.0',agents}).machines;
}

test('a tile\'s agent line: reporting, no news with since when, not heard from yet; nothing without a key; markup stays text',()=>{
 const at=iso(10*60_000);
 const machines=home({
  mini:{lastReportAt:iso(30_000),agentVersion:`1.6.0+${MARKUP}`,parts:{heartbeat:{receivedAt:iso(30_000),interval:60}}},
  studio:{lastReportAt:at,agentVersion:'1.5.0',parts:{heartbeat:{receivedAt:at,interval:60}},specs:'a'.repeat(64),hubSpecs:'b'.repeat(64)},
  mini_server:{lastReportAt:null,parts:{}}});
 const by=id=>machines.find(m=>m.id===id);
 assert.equal(agentLine(by('nas')),null,'a machine without a key has no line');assert.equal(agentSection(by('nas')),null);
 const fresh=agentLine(by('mini'));
 assert.equal(clean(fresh.textContent),'Agentreporting');assert.equal(all(fresh,'ui-pill')[0].getAttribute('class'),'ui-pill good');
 const quietLine=agentLine(by('studio'));
 assert.equal(by('studio').agent.freshness,'no-news');assert.equal(by('mini').agent.agentVersion,`1.6.0+${MARKUP}`);assert.equal(by('mini').agent.behind,null,'not a version: not behind either');
 const text=clean(quietLine.textContent);
 assert.match(text,/^Agentno news10 minutes agoolder versiondifferent watch list$/);
 assert.doesNotMatch(text,/off|offline|down/i,'a quiet agent is never off');
 assert.equal(all(quietLine,'ui-pill')[0].getAttribute('class'),'ui-pill warn');
 assert.match(quietLine.getAttribute('title'),/^Last heard from /);
 assert.equal(clean(agentLine(by('mini_server')).textContent),'Agentnot heard from yet');
 // An unknown freshness is read as never: the page claims nothing the server did not say.
 assert.deepEqual(agentState({freshness:'online'}),agentState({freshness:'never'}));
 // The machine page: the agent's version as text, never as an element.
 const own=agentSection(by('mini'));
 assert.ok(clean(own.textContent).includes(`1.6.0+${MARKUP}`));assert.equal(byTag(own,'img').length,0,'no element was made of the version');
 const sec=agentSection(by('studio'),{admin:true});
 const page=clean(sec.textContent);
 for(const s of [/Push agent/,/does not say whether the machine is running/,/no news/,/That does not mean the machine is off/,/Older than the hub/,/Differs from the hub's list/,/Agent keys →/])assert.match(page,s);
 assert.deepEqual(all(sec,'hv-badge-link').map(a=>a.getAttribute('href')),['#access/agents']);
 assert.equal(all(agentSection(by('studio')),'hv-badge-link').length,0,'the keys link is for administrators');
 assert.match(clean(agentSection(by('mini')).textContent),/The same as in the hub\.|The agent did not send one\./);
 // Czech is the source.
 i18n.setLang('cs');
 try{assert.match(agentLine(by('studio')).textContent,/žádné zprávy/);assert.match(agentLine(by('mini_server')).textContent,/zatím se neozval/);}
 finally{i18n.setLang('en');}
});

test('with agent.reports turned off, the line and the section say the hub refuses the reports, not that the agent went quiet',()=>{
 const at=iso(10*60_000);
 const machines=home({studio:{lastReportAt:at,agentVersion:'1.6.0',parts:{heartbeat:{receivedAt:at,interval:60}}},mini:{lastReportAt:iso(30_000),agentVersion:'1.6.0',parts:{heartbeat:{receivedAt:iso(30_000),interval:60}}}});
 const by=id=>machines.find(m=>m.id===id);
 for(const id of ['studio','mini']){
  const line=agentLine(by(id),{refused:true}),text=clean(line.textContent);
  assert.match(text,/^Agentreports refused by the hub/,id);assert.doesNotMatch(text,/no news|reporting/,`${id}: neither quiet nor reporting is claimed`);
  assert.doesNotMatch(text,/\boff\b|offline|down/i);assert.equal(all(line,'ui-pill')[0].getAttribute('class'),'ui-pill warn');
  const page=clean(agentSection(by(id),{refused:true}).textContent);
  assert.match(page,/The hub is not taking agent reports: the Push agents integration is disabled/);
  assert.doesNotMatch(page,/gone quiet|may not be running/,'not the no-news text');
 }
 assert.match(clean(agentLine(by('studio'),{refused:true}).textContent),/10 minutes ago$/,'when it was last heard');
 assert.equal(clean(agentLine(by('studio')).textContent).startsWith('Agentno news'),true,'on: no news as before');
});

test('the overview draws the agent line on each tile and the section on the machine page, and refreshes them in place',async()=>{
 const view=await readFile(new URL('../public/home-view.js',import.meta.url),'utf8');
 assert.match(view,/import \{agentLine,agentSection\} from '\.\/home-agent\.js';/);
 assert.match(view,/propsLine\(m\),\n[^\n]*\n   agentLine\(m,\{refused:agentRefused\(\)\}\),/,'the line sits under the hardware on the tile');
 assert.match(view,/agentSection\(machine,\{admin:canAdmin,refused:agentRefused\(\)\}\),\n  stackSection\(machine\)/,'the section on the machine page');
 assert.match(view,/const agentRefused=\(\)=>\(cache\?\.integrations\?\.disabled\|\|\[\]\)\.some\(i=>i\?\.id==='agent\.reports'\);/,'refused while the integration is in integrations.disabled');
 assert.equal((view.match(/agentLine\(m,\{refused:agentRefused\(\)\}\)/g)||[]).length,2,'the tile and its refresh');
 assert.equal((view.match(/agentSection\(machine,\{admin:canAdmin,refused:agentRefused\(\)\}\)/g)||[]).length,2,'the page and its refresh');
 assert.match(view,/querySelector\('\.hv-agent'\)/);assert.match(view,/querySelector\('\.hv-agent-sec'\)/);
 for(const file of ['home-agent.js','home-view.js']){const src=await readFile(new URL(`../public/${file}`,import.meta.url),'utf8');assert.doesNotMatch(src,/innerHTML|insertAdjacentHTML|outerHTML/,file);}
 const css=await readFile(new URL('../public/home.css',import.meta.url),'utf8');
 assert.match(css,/\.hv-agent\{[^}]*var\(--/);assert.doesNotMatch(css.slice(css.indexOf('.hv-agent{')),/#[0-9a-fA-F]{3,6}\b|rgb\(/,'design tokens only');
});

// --- Users and API → Push agents -----------------------------------------------------------------
const TOKEN='hha_'+'c'.repeat(64);
function server({agents,machines}){
 const calls=[];
 globalThis.fetch=async(url,opts={})=>{
  const body=opts.body?JSON.parse(opts.body):null;calls.push({url:String(url),method:opts.method||'GET',body});
  const reply=(status,json)=>({ok:status<300,status,json:async()=>structuredClone(json)});
  if(url==='/api/admin/agents'&&!body)return reply(200,{agents});
  if(url==='/api/home/machines')return reply(200,{machines});
  if(url==='/api/admin/agents'&&body){const agent={id:'1111111111111111',machine:body.machine,name:body.name||`${body.machine} · 2026-11-13`,prefix:TOKEN.slice(0,12),createdAt:iso(0),createdBy:'admin',revokedAt:null,revokedBy:null,lastReportAt:null,agentVersion:null,platform:null};
   agents.push(agent);return reply(201,{token:TOKEN,agent});}
  if(url==='/api/admin/agents/revoke'){const a=agents.find(x=>x.id===body.id);a.revokedAt=iso(0);a.revokedBy='admin';return reply(200,{agent:a});}
  return reply(404,{error:{code:'NOT_FOUND',message:'x'}});};
 return calls;
}
const ADMIN={canAdmin:true,authKind:'session',role:'admin',username:'admin',name:'Admin'};

test('agent keys: listed per machine with names as text, issued with the key file shown once, revoked',async()=>{
 const agents=[
  {id:'aaaaaaaaaaaaaaaa',machine:'mini',name:MARKUP,prefix:'hha_0123abcd',createdAt:iso(86400e3),createdBy:'admin',revokedAt:null,revokedBy:null,lastReportAt:iso(60e3),agentVersion:`1.6.0+${MARKUP}`,platform:'macos'},
  {id:'bbbbbbbbbbbbbbbb',machine:'mini',name:'old',prefix:'hha_9999ffff',createdAt:iso(9*86400e3),createdBy:'admin',revokedAt:iso(86400e3),revokedBy:'machine-removed',lastReportAt:null,agentVersion:null,platform:null}];
 const machines=[{id:'mini',name:`Mac ${MARKUP}`,role:'computer',platform:null},{id:'router',name:'Router',role:'router',platform:null},{id:'pi',name:'Pi',role:'computer',platform:'other'},{id:'studio',name:'Studio',role:'computer',platform:'macos'}];
 const calls=server({agents,machines});
 setPrincipal(null);setPrincipal(ADMIN);
 document.body.replaceChildren(accessView(ADMIN,{open:'agents'}));await settle();
 let text=clean(document.body.textContent);
 for(const s of [/Push agents/,/Keys of the agents that send reports/,/1 valid key/,/active/,/revoked/,/hha_0123abcd…/,/1 minute ago|now/])assert.match(text,s);
 assert.ok(text.includes(`Mac ${MARKUP}`)&&text.includes(MARKUP)&&text.includes(`1.6.0+${MARKUP}`),'names and the version as text');
 assert.equal(byTag(document.body,'img').length,0,'no element was made of them');
 assert.ok(attrs(document.body).some(v=>/hub: the machine was removed/.test(v)),'who revoked it, in English');
 assert.deepEqual(agentMachines(machines).map(m=>m.id),['mini','studio'],'neither the router nor platform "other" is offered');
 // Issue: the form, then the one-time dialog with the key file the installer reads.
 fire(all(document.body,'ax-section-actions')[0].children[0],'click');await settle();
 const form=byTag(document.body,'form')[0];
 assert.deepEqual(byTag(form,'option').map(o=>o.getAttribute('value')),['mini','studio']);
 byTag(form,'select')[0].value='studio';byTag(form,'input')[0].value='  ';
 fire(form,'submit');await settle();
 assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>[c.url,c.body]),[['/api/admin/agents',{machine:'studio'}]],'a blank name is not sent');
 const dialog=all(document.body,'ax-dialog').at(-1),secret=all(dialog,'ax-secret')[0];
 const file=JSON.parse(secret.getAttribute('value'));
 assert.deepEqual(file,{schema:1,agent:{id:'1111111111111111',machine:'studio',name:'studio · 2026-11-13',prefix:TOKEN.slice(0,12),createdAt:file.agent.createdAt},token:TOKEN},'the file create-agent-key --output writes');
 text=clean(dialog.textContent);assert.match(text,/SHOWN ONLY ONCE/);assert.match(text,/--key-file/);
 assert.equal(attrs(document.body).filter(v=>v.includes(TOKEN)).length,1,'the token is in the one-time field only');
 assert.ok(!document.body.textContent.includes(TOKEN));
 // Closed: gone from the page, from the field, from the address and from storage.
 fire(byTag(dialog,'button').find(b=>/saved it/i.test(b.textContent)),'click');await settle();
 assert.equal(secret.value,'','the field is wiped');
 assert.ok(!dialog.isConnected,'the dialog is gone');
 assert.ok(!attrs(document.body).some(v=>v.includes(TOKEN))&&!document.body.textContent.includes(TOKEN),'nowhere on the page');
 assert.ok(!location.hash.includes('hha_'));assert.equal(localStorage.getItem('token'),null);
 assert.equal(calls.filter(c=>c.url.includes('hha_')).length,0,'never in a URL');
 const src=await readFile(new URL('../public/access-view.js',import.meta.url),'utf8');
 // The only address it writes is the open tab's, #access/<tab>.
 const ADDRESS="const want=`#access/${tab}`;";assert.ok(src.includes(ADDRESS)&&src.includes("history.replaceState?.(null,'',want)"));
 assert.doesNotMatch(src.replace("history.replaceState?.(null,'',want)",''),/localStorage|sessionStorage|console\.|history\.(push|replace)State|location\.hash=/,'the page keeps no secret in storage, a log or the address');
 // Revoke: confirmed, then the route.
 // Each Revoke button names its key for a screen reader, and the actions column has a header.
 const revokes=byTag(document.body,'button').filter(b=>b.textContent==='Revoke');
 assert.ok(revokes.length>=2);
 assert.deepEqual(revokes.map(b=>b.getAttribute('aria-label')).sort(),[`Revoke key ${MARKUP}`,'Revoke key studio · 2026-11-13'].sort());
 for(const th of byTag(document.body,'th'))assert.notEqual(th.textContent.trim(),'','every column header says something');
 assert.ok(byTag(document.body,'th').some(th=>th.textContent==='Actions'&&all(th,'ax-vh').length===1),'visually hidden');
 const revoke=revokes[0];fire(revoke,'click');await settle();
 const confirm=all(document.body,'ax-dialog').at(-1);clean(confirm.textContent);
 fire(byTag(confirm,'button').find(b=>b.textContent==='Revoke'),'click');await settle();
 assert.deepEqual(calls.filter(c=>c.url==='/api/admin/agents/revoke').map(c=>c.body.id).length,1);
 assert.equal(agentKeyFile({token:'t',agent:{id:'i',machine:'m',name:'n',prefix:'p',createdAt:'c',lastReportAt:'x'}}),'{"schema":1,"agent":{"id":"i","machine":"m","name":"n","prefix":"p","createdAt":"c"},"token":"t"}');
});

test('the address follows the open tab, so a link to #access/agents works from another tab',async()=>{
 server({agents:[],machines:[]});
 const written=[];globalThis.history={replaceState:(s,title,url)=>{written.push(url);location.hash=url;}};
 try{
  location.hash='#access/agents';
  document.body.replaceChildren(accessView(ADMIN,{open:'agents'}));await settle();
  assert.deepEqual(written,[],'already there: nothing written');
  fire(byTag(document.body,'button').find(b=>b.dataset?.tab==='keys'||b.getAttribute('data-tab')==='keys'),'click');await settle();
  assert.deepEqual(written,['#access/keys'],'replaced, not pushed');
  location.hash='#access';document.body.replaceChildren(accessView(ADMIN,{}));await settle();
  assert.equal(written.at(-1),'#access/keys','a bare #access names the tab it shows');
  const count=written.length;
  location.hash='#overview';document.body.replaceChildren(accessView(ADMIN,{}));await settle();
  assert.equal(written.length,count,'never written outside the page');
 }finally{delete globalThis.history;location.hash='#access/agents';}
});

test('agent keys: none yet explains what a push agent is and how to install one',async()=>{
 server({agents:[],machines:[{id:'mini',name:'Mac mini',role:'computer',platform:null}]});
 document.body.replaceChildren(accessView(ADMIN,{open:'agents'}));await settle();
 const text=clean(document.body.textContent);
 for(const s of [/No push agent yet/,/The hub does not sign in to the machine/,/install-host-agent\.mjs --core/,/\+ New agent key/])assert.match(text,s);
 // Someone who is not an administrator never gets the tab.
 document.body.replaceChildren(accessView({canAdmin:false,authKind:'session',role:'viewer'},{open:'agents'}));await settle();
 assert.doesNotMatch(document.body.textContent,/Push agents/);
});

test('the integrations page knows the kind "agent"',async()=>{
 const src=await readFile(new URL('../public/integrations-view.js',import.meta.url),'utf8');
 assert.match(src,/agent:'Push agenti'/);assert.match(src,/agent:'bolt'/);
 const {kindLabel}=await import('../public/integrations-view.js');
 assert.equal(kindLabel('agent'),'Push agents');
});
