// Which /api/systems rows describe an inventory entry (data/knowledge.json), for the version block in
// the inventory map. Pure functions: no DOM, no fetch (tests/inventory-versions.test.mjs).
//
// 1. Explicit: a watched-software detect entry lists the inventory id (config/software-watch.json
//    `inventory`, carried on each row). When any row names the entry, only those rows are used.
// 2. Heuristic, same device only: the entry id without device words (mini-, studio-, -mini-server…)
//    or its name without "(Studio)" / "· mini" equals the software id or name; NAS apps and Docker
//    containers match by their name (a container "local-ai-searxng" also matches "searxng").
// Devices: an inventory id may use a hyphen where the site's device id has an underscore
// (mini-server ↔ mini_server), so both spellings name the same device.
const DEVICE_WORDS=new Set(['mini','studio','server','nas','m1','m4']);
const key=s=>String(s||'').toLowerCase().replace(/\([^)]*\)/g,' ').split(/\s+·\s+/)[0].replace(/\s+/g,' ').trim();
const idKey=id=>String(id||'').toLowerCase().split('-').filter(w=>w&&!DEVICE_WORDS.has(w)).join('-');
export const systemDeviceOf=entry=>{const id=entry?.kind==='device'?entry.id:entry?.device;return typeof id==='string'&&id?id.replaceAll('-','_'):null;};

function entryKeys(entry){return new Set([idKey(entry.id),key(entry.name)].filter(k=>k.length>=2));}
function heuristic(entry,row){
 const keys=entryKeys(entry);
 const prefixed=/^(app|docker):(.+)$/.exec(row.id||'');
 if(prefixed){const n=prefixed[2].toLowerCase();return [...keys].some(k=>k===n||n.endsWith(`-${k}`));}
 return keys.has(String(row.id||'').toLowerCase())||keys.has(key(row.name));
}

// Rows for one entry, in the order Systémy lists them. [] when nothing matches or there is no doc.
export function versionRows(entry,systems){
 const device=systemDeviceOf(entry),rows=Array.isArray(systems?.software)?systems.software:[];
 if(!entry||!device||entry.kind==='device'||!rows.length)return [];
 const here=rows.filter(r=>r.device===device);
 const explicit=here.filter(r=>Array.isArray(r.inventory)&&r.inventory.includes(entry.id));
 return explicit.length?explicit:here.filter(r=>heuristic(entry,r));
}

// A device entry gets its operating system from the same payload.
export function deviceOs(entry,systems){
 if(entry?.kind!=='device')return null;const id=systemDeviceOf(entry);
 const m=(systems?.devices||[]).find(x=>x.id===id);if(!m?.os)return null;
 const ups=m.os.updates||[],next=m.os.status==='update'?ups.find(u=>u.kind==='minor')||ups[0]:null;
 return {name:m.os.name,installed:m.os.version,status:m.os.status,latest:next?.version||null,device:id,stale:Boolean(m.stale)};
}

// What the version block says, matching the Verze a aktualizace page: an update is shown even when the
// upstream check is stale (it still proves a newer release exists) but is then flagged "neověřeno";
// a stale "current" is already reported by the server as status unknown (neověřeno).
export function versionSummary(row){
 const update=row.status==='update'&&row.latest?row.latest:null;
 return {installed:row.installed||null,status:row.status,update,unverified:row.status==='unknown'||Boolean(row.upstreamStale),note:row.note||null};
}
