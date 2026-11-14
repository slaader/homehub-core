// Inventory map layout: every card gets a column (a device entry the site did not list gets one of its own;
// unknown device ids and categories land in Ostatní) and the map size is always a finite number, so the SVG
// is never collapsed by a NaN viewBox.
import './support/site-inventory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {columnGroups,mapExtent} from '../public/inventory-view.js';

const SP={COL:220,ROW:48,TOP:48};
const entries=[
 {id:'mini',kind:'device',name:'Mac mini'},
 {id:'svc',kind:'runtime',name:'Service',device:'mini'},
 {id:'router',kind:'network',name:'Router'},
 {id:'gh',kind:'external',name:'GitHub'},
 {id:'hue-bridge',kind:'device',name:'Hue Bridge'},// a device the site's places do not list
 {id:'hue-app',kind:'runtime',name:'Hue app',device:'hue-bridge'},
 {id:'pi',kind:'tool',name:'Pi tool',device:'garage-pi'},// unknown device id
 {id:'lost',kind:'runtime',name:'No device'},// missing device
 {id:'blank',kind:'tool',name:'Blank device',device:''},
 {id:'odd',kind:'gadget',name:'Unknown kind'}];
const where=gs=>Object.fromEntries(gs.flatMap(g=>g.cards.map(c=>[c.id,g.label])));
const once=(gs,list)=>{const ids=gs.flatMap(g=>g.cards.map(c=>c.id));assert.deepEqual([...ids].sort(),list.map(e=>e.id).sort(),'every card exactly once');};

test('device columns: an unlisted device entry gets its own column; an unknown device id goes to Ostatní, last',()=>{
 const gs=columnGroups(entries,'device'),w=where(gs);once(gs,entries);
 assert.equal(gs.at(-1).label,'Ostatní');
 for(const id of ['pi','lost','blank','odd'])assert.equal(w[id],'Ostatní',id);
 for(const id of ['hue-bridge','hue-app'])assert.equal(w[id],'Hue Bridge',id);
 assert.equal(w.mini,'mini · M4');assert.equal(w.svc,'mini · M4');assert.equal(w.router,'Síť');assert.equal(w.gh,'Mimo dům');
 const labels=gs.map(g=>g.label);
 assert.deepEqual(labels,['mini · M4','Hue Bridge','Síť','Mimo dům','Ostatní'],'site columns, then device entries, then the shared lanes');
 assert.equal(gs.find(g=>g.label==='Hue Bridge').cards[0].id,'hue-bridge','the device card leads its column, as elsewhere');
 assert.ok(!columnGroups(entries.slice(0,4),'device').some(g=>g.label==='Ostatní'),'no empty Ostatní column');
});
test('device columns come from the whole inventory, not only from the cards shown',()=>{
 // The hardware category is hidden: the Hue app still sits in its device's column, not in Ostatní.
 const shown=entries.filter(e=>e.kind!=='device'),w=where(columnGroups(shown,'device',entries));
 assert.equal(w['hue-app'],'Hue Bridge');assert.equal(w.svc,'mini · M4');
 assert.equal(where(columnGroups(shown,'device'))['hue-app'],'Ostatní','without the full list the device is unknown');
});

test('category columns: an unknown category goes to Ostatní; every card once',()=>{
 const gs=columnGroups(entries,'category'),w=where(gs);once(gs,entries);
 assert.equal(w.odd,'Ostatní');assert.equal(w['hue-bridge'],'Hardware');assert.equal(w.pi,'Nástroje');
 assert.equal(gs.at(-1).label,'Ostatní');
 const store=[{id:'k',kind:'secret-store',name:'Store'},{id:'s1',kind:'secret-item',category:'secret',store:'gone',name:'Item'}];
 once(columnGroups(store,'category'),store);
});

test('the map size is finite whatever the positions are',()=>{
 assert.deepEqual(mapExtent([],0,SP),{width:0,height:96},'empty map');
 assert.deepEqual(mapExtent([{x:12,y:48},{x:232,y:96}],2,SP),{width:232+180+150,height:96+40+24});
 const bad=mapExtent([{x:NaN,y:NaN},{},undefined,{x:12,y:48}],NaN,SP);
 assert.ok(Number.isFinite(bad.width)&&Number.isFinite(bad.height),JSON.stringify(bad));
});

test('the view draws from columnGroups and mapExtent',async()=>{
 const view=await readFile(new URL('../public/inventory-view.js',import.meta.url),'utf8');
 assert.match(view,/gs=columnGroups\(list,layout\.columns,doc\.entries\)/);
 assert.match(view,/const \{width,height\}=mapExtent\(\[\.\.\.pos\.values\(\)\],laneList\.length,\{COL,ROW,TOP\}\);/);
 assert.doesNotMatch(view,/function groups\(list\)/,'no second grouping that could drop a card');
});
