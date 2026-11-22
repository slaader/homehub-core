// Users & API → Connect → MCP tools: the table is the manifest's tool list as tools/list returns it, headed by
// the module that registered each run of tools. Every core module's tool (home, inventory, tracker, review, …,
// and the older catch-all "core") is the core's, never a plugin's; a plugin's tools say whose they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDom,Element,Text} from './fixtures/mini-dom.mjs';

installDom();
const {toolRows,toolGroups,toolsCard}=await import('../public/access-view.js');
const {setLang,addStrings}=await import('../public/i18n.js');

// What GET /api/ui/manifest sends once the legacy tools live in their own core modules.
const MODULES=[{id:'core',core:true,title:'Home Hub'},{id:'home',core:true,title:'Overview'},{id:'inventory',core:true,title:'Inventory'},
 {id:'tracker',core:true,title:'Project Tracker'},{id:'review',core:true,title:'Review'},{id:'wiki',core:true,title:'Wiki'},{id:'references',core:true},
 {id:'notes',core:false,title:'Notes',version:'1.0.0'},{id:'lab',core:false}];
const MIGRATED={home:['home_status'],inventory:['inventory_search','inventory_get','inventory_update'],
 tracker:['projects_list','tickets_list','ticket_get','ticket_create','ticket_update','ticket_comment','release_save','project_save','ticket_attachment_get','ticket_attachment_put','search'],
 review:['review_list','review_get','review_set_save','review_publish']};
const tool=(name,module,scope='read',more={})=>({name,title:`${name} title`,scope,write:scope!=='read',description:`Does ${name}. Then more about ${name}.`,module,...more});
const TOOLS=[tool('whoami','core'),
 ...MIGRATED.home.map(n=>tool(n,'home')),tool('device_upsert','home','home:write'),
 ...MIGRATED.inventory.map(n=>tool(n,'inventory',n==='inventory_update'?'inventory:write':'read')),
 ...MIGRATED.tracker.map(n=>tool(n,'tracker',/create|update|comment|save|put/.test(n)?'tickets:write':'read')),
 ...MIGRATED.review.map(n=>tool(n,'review',/save|publish/.test(n)?'review:write':'read')),
 tool('wiki_page_get','wiki'),tool('references_suggest','references'),
 tool('notes_add','notes','notes:write'),tool('lab_probe','lab'),tool('notes_list','notes')];

const walk=(node,keep,out=[])=>{for(const c of node.childNodes){if(c instanceof Element&&keep(c))out.push(c);walk(c,keep,out);}return out;};
const tags=(node,tag)=>walk(node,e=>e.tagName===tag);
const pills=node=>walk(node,e=>e.classList.contains('ax-pill'));

test('every migrated core tool is the core\'s: plugin null under its own module, a plugin\'s tool is tagged',()=>{
 const rows=toolRows(TOOLS,MODULES),by=Object.fromEntries(rows.map(r=>[r.name,r]));
 for(const [module,names] of Object.entries(MIGRATED))for(const name of names){
  assert.equal(by[name].plugin,null,`${name} is not a plugin's`);
  assert.equal(by[name].module,module,name);
  assert.equal(by[name].area,MODULES.find(m=>m.id===module).title,name);
 }
 assert.deepEqual([by.whoami.plugin,by.whoami.area],[null,'Home Hub'],'the older catch-all module "core" is core as well');
 assert.deepEqual([by.references_suggest.plugin,by.references_suggest.area],[null,'references'],'a core module without a title is named by its id');
 assert.deepEqual([by.notes_add.plugin,by.notes_list.plugin,by.lab_probe.plugin],['Notes','Notes','lab'],'a plugin is named by its title, else its id');
 // A module the manifest does not list is not made a plugin either: nothing is claimed that is not known.
 assert.deepEqual(toolRows([tool('x_get','gone'),tool('y_get',undefined)],MODULES).map(r=>[r.plugin,r.area]),[[null,'gone'],[null,null]]);
});

test('the order is tools/list\'s: rows keep it, and groups only join neighbours, never sort',()=>{
 const rows=toolRows(TOOLS,MODULES),groups=toolGroups(rows);
 assert.deepEqual(rows.map(r=>r.name),TOOLS.map(t=>t.name));
 assert.deepEqual(groups.flatMap(g=>g.rows.map(r=>r.name)),TOOLS.map(t=>t.name));
 assert.deepEqual(groups.map(g=>[g.module,g.rows.length]),[['core',1],['home',2],['inventory',3],['tracker',11],['review',4],['wiki',1],['references',1],['notes',1],['lab',1],['notes',1]]);
 assert.deepEqual(toolGroups([]),[]);
});

test('read or write: the flag the server sent, and a read scope never writes',()=>{
 const rows=toolRows([tool('a','home','read',{write:true}),tool('b','home','home:write',{write:undefined}),tool('c','home','home:write',{write:false}),tool('d','home','security',{write:false})],MODULES);
 assert.deepEqual(rows.map(r=>r.write),[false,true,false,false]);
});

test('the table: one body per module run, plugin headings tagged, words beside the colour, long text folds',()=>{
 setLang('cs');
 const card=toolsCard(toolRows(TOOLS,MODULES));
 const [table]=tags(card,'table'),bodies=tags(table,'tbody');
 assert.equal(bodies.length,10);
 assert.equal(walk(card,e=>e.tagName==='h3')[0].textContent,`Nástroje MCP ${TOOLS.length}`);
 const heads=bodies.map(b=>tags(b,'th')[0]);
 for(const th of heads)assert.deepEqual([th.getAttribute('scope'),th.getAttribute('colspan')],['rowgroup','3']);
 assert.deepEqual(heads.map(th=>th.childNodes[0].textContent),['Home Hub','Overview','Inventory','Project Tracker','Review','Wiki','references','Notes','lab','Notes']);
 // Core headings carry no plugin tag; each plugin heading does, with whose it is.
 const tagged=heads.map(th=>pills(th).map(p=>[p.textContent,p.getAttribute('title')]));
 assert.deepEqual(tagged.slice(0,7),[[],[],[],[],[],[],[]]);
 assert.deepEqual(tagged.slice(7),[[['plugin','Nástroje z pluginu Notes']],[['plugin','Nástroje z pluginu lab']],[['plugin','Nástroje z pluginu Notes']]]);
 // A tool row: the name, the scope pill with the same meaning in words, the title, the first sentence, the rest on demand.
 const rows=bodies.flatMap(b=>tags(b,'tr').slice(1));
 assert.deepEqual(rows.map(tr=>tags(tr,'code')[0].textContent),TOOLS.map(t=>t.name));
 for(const tr of rows){
  const [name,scope,what]=tags(tr,'td'),src=TOOLS.find(t=>t.name===tags(tr,'code')[0].textContent);
  assert.equal(pills(name).length,0,`${src.name}: no tag beside the name`);
  const [pill]=pills(scope);
  assert.equal(pill.textContent,src.scope);assert.ok(pill.classList.contains(src.write?'warn':'good'),src.name);
  assert.deepEqual(walk(scope,e=>e.classList.contains('ax-rw')).map(e=>e.textContent),[],`${src.name}: ${src.scope} already says it`);
  assert.equal(tags(what,'b')[0].textContent,src.title);assert.equal(tags(what,'span')[0].textContent,`Does ${src.name}.`);
  const [summary]=tags(what,'summary');
  assert.deepEqual([summary.textContent,summary.getAttribute('aria-label')],['Celý popis',`Celý popis: ${src.name}`]);
  assert.equal(tags(tags(what,'details')[0],'p')[0].textContent,`Then more about ${src.name}.`);
 }
 // A one-sentence description has nothing to open.
 const short=toolsCard(toolRows([tool('one','home','read',{description:'Only this.'})],MODULES));
 assert.equal(tags(short,'details').length,0);
 assert.equal(walk(short,e=>e.tagName==='td'&&e.classList.contains('ax-dim'))[0].textContent,'one titleOnly this.');
});

test('read or write in words where the scope\'s name does not say it, or says otherwise',()=>{
 setLang('cs');
 const words=tools=>walk(toolsCard(toolRows(tools,MODULES)),e=>e.classList.contains('ax-rw')).map(e=>e.textContent);
 assert.deepEqual(words([tool('a','home'),tool('b','home','security:read',{write:false}),tool('c','home','home:write'),tool('d','notes','notes:write'),tool('w','notes','write',{write:true})]),[]);
 assert.deepEqual(words([tool('e','lab','lab',{write:true}),tool('f','lab','security',{write:false}),tool('g','lab','tickets:write',{write:false}),tool('h','lab','thread',{write:false}),tool('i','lab','override',{write:true})]),['zápis','čtení','čtení','čtení','zápis']);
});

test('the table in English and without a manifest',()=>{
 addStrings({en:{'Poznámky':'Notes',lab:'Should not translate raw id'}});
 setLang('en');
 try{
  const mods=[{id:'home',core:true,title:'Přehled'},{id:'notes',core:false,title:'Poznámky',version:'1.0.0'},{id:'lab',core:false}];
  const card=toolsCard(toolRows([tool('notes_add','notes','notes',{write:true}),tool('notes_save','notes','write',{write:true}),tool('lab_probe','lab','read',{write:false}),tool('home_status','home','security',{write:false})],mods));
  const areaHeads=tags(card,'tbody').map(b=>tags(b,'th')[0]);
  assert.deepEqual(areaHeads.map(th=>th.childNodes[0].textContent),['Notes','lab','Overview'],'titles translate at render time, raw IDs stay literal');
  assert.deepEqual(pills(card).filter(p=>p.textContent==='plugin').map(p=>p.getAttribute('title')),['Tools added by the Notes plugin','Tools added by the lab plugin']);
  assert.deepEqual(walk(card,e=>e.classList.contains('ax-rw')).map(e=>e.textContent),['write','read'],'bare write scope does not duplicate "write"');
  assert.deepEqual(tags(card,'summary').map(s=>[s.textContent,s.getAttribute('aria-label')]),[['Full description','Full description: notes_add'],['Full description','Full description: notes_save'],['Full description','Full description: lab_probe'],['Full description','Full description: home_status']]);
  assert.deepEqual(tags(card,'th').slice(0,3).map(th=>th.textContent),['Tool','Permissions','What it does']);
  const empty=toolsCard([]);
  assert.equal(tags(empty,'table').length,0);
  assert.match(empty.textContent,/sent no tool list/);
 }finally{setLang('cs');}
});

test('text-safe: server strings land in text nodes, no inline style, no HTML sinks',async()=>{
 const evil='<img src=x onerror=alert(1)>';
 const card=toolsCard(toolRows([tool(evil,'lab',evil,{title:evil,description:`${evil}. ${evil}`})],[{id:'lab',core:false,title:evil}]));
 assert.equal(tags(card,'img').length,0);
 const texts=[];const visit=n=>{for(const c of n.childNodes){if(c instanceof Text)texts.push(c.data);else visit(c);}};visit(card);
 assert.ok(texts.filter(x=>x.includes(evil)).length>=5,'name, scope, title, lead, rest and heading are plain text');
 assert.equal(walk(card,e=>e.hasAttribute('style')).length,0);
 const src=await readFile(new URL('../public/access-view.js',import.meta.url),'utf8');
 assert.doesNotMatch(src,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|style:/);
});
