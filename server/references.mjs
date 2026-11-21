import {deviceList} from './home-data.mjs';
import {createReferenceRecords,fold} from './reference-records.mjs';
import {exactKeys,wikiInlineGroups} from '../public/wiki-doc.js';
import {referenceHref,referenceKey,referenceKinds,validReference} from '../public/reference-format.js';
import {markdownReferences} from '../public/tracker-markdown-format.js';

const fail=code=>{throw new Error(code);};
function number(value,fallback,min,max){
 if(value===undefined)return fallback;
 if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))fail('invalid');
 const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)fail('invalid');return n;
}
function entry(kind,id,title,project=null){
 const label=title.toWellFormed().replace(/[\x00-\x1f\x7f]/g,' ').trim()||id;
 return {kind,id,label,project,scope:project?'local':'global',href:referenceHref(kind,id)};
}
const available=(r,project)=>r.scope==='global'||r.project===project;

function wikiExcerpt(doc,kind,id){
 for(const runs of wikiInlineGroups(doc)){
  const index=runs.findIndex(r=>r.t==='ticket'?kind==='ticket'&&r.id===id:r.t==='ref'&&r.kind===kind&&r.id===id);
  if(index<0)continue;
  const text=r=>r.text??r.label??r.id??r.c.map(t=>t.text).join('');
  return (runs.slice(0,index).map(text).join('').slice(-60)+runs.slice(index).map(text).join('')).slice(0,150);
 }
 return '';
}

export function createReferences(hub){
 const records=createReferenceRecords(hub.db),tickets=hub.state('tracker').tickets,wiki=hub.state('wiki').wiki;
 async function machines(){
  const home=hub.state('home').homeDevices;
  const [added,siteOverrides]=await Promise.all([home.list(),home.siteOverrides()]);
  const {devices}=deviceList({site:hub.site,added,siteOverrides});
  return devices.map(d=>({...entry('machine',d.id,d.name),role:d.role,ip:d.ip??null}));
 }
 // Only lightweight fields enter the catalog. Wiki bodies and ticket comments are read on demand.
 let cached;
 async function catalog(){
  const stamp=JSON.stringify(await Promise.all([records.version(),tickets.version(),wiki.version()]));
  if(cached?.stamp!==stamp){
   const [projects,pages]=await Promise.all([tickets.projects(),wiki.summaries()]);
   const rows=hub.db.db.prepare("SELECT id,json_extract(doc,'$.title') AS title,json_extract(doc,'$.project') AS project FROM docs WHERE kind='tickets' AND coll='tickets'").all();
   const shared=records.shared();
   const entries=[...projects.map(p=>entry('project',p.id,p.name)),...rows.map(r=>entry('ticket',r.id,r.title,r.project)),
    ...pages.map(p=>entry('wiki',p.project+'/'+p.id,p.title,p.project)),...records.brief()];
   cached={stamp,entries:entries.map(r=>{
    return {...r,href:referenceHref(r.kind,r.id),...(shared.has(referenceKey(r))?{scope:'global'}:{})};
   })};
  }
  return {entries:[...cached.entries,...await machines()]};
 }
 async function search(input={},suggest=false){
  if(!exactKeys(input,['kind','project','scope','q','limit','offset'])||input.kind!==undefined&&!referenceKinds.includes(input.kind)||
    input.scope!==undefined&&!['local','global'].includes(input.scope)||input.project!==undefined&&!validReference('project',input.project)||
    input.q!==undefined&&(typeof input.q!=='string'||input.q.length>200))fail('invalid');
  const limit=number(input.limit,suggest?8:50,1,suggest?20:100),offset=number(input.offset,0,0,1000000),q=fold(input.q??'').trim();
  const {entries}=await catalog(),matches=[];
  for(const r of entries){
   if(input.kind&&input.kind!==r.kind||input.scope&&input.scope!==r.scope)continue;
   if(suggest?!available(r,input.project):input.project&&input.project!==r.project)continue;
   const label=fold(r.label),prefix=label.startsWith(q);
   if(!prefix&&!fold(r.id).startsWith(q)&&!label.split(/[^\p{L}\p{N}]+/u).some(word=>word.startsWith(q)))continue;
   matches.push({r,rank:(prefix?0:2)+(r.project===input.project?0:1)});
  }
  matches.sort((a,b)=>a.rank-b.rank||a.r.label.localeCompare(b.r.label)||referenceKey(a.r).localeCompare(referenceKey(b.r)));
  return {total:matches.length,items:matches.slice(offset,offset+limit).map(({r})=>projection(r))};
 }
 function projection({kind,id,label,scope,project,href}){return {kind,id,label,scope,project,href};}
 async function resolve(input){
  if(!exactKeys(input,['refs'])||!Array.isArray(input.refs)||input.refs.length>100||
    !input.refs.every(r=>exactKeys(r,['id','kind'])&&validReference(r.kind,r.id)))fail('invalid');
  const wanted=new Set(input.refs.map(referenceKey));
  return {items:(await catalog()).entries.filter(r=>wanted.has(referenceKey(r))).map(projection)};
 }
 async function usages(kind,id,offset,limit){
  const source=(kind,id,label,project)=>({kind,id,label,project,href:referenceHref(kind,id)});
  const hits=[];
  for(const page of await wiki.summaries()){
   const found=kind==='ticket'?page.links.tickets.includes(id):page.links.refs?.some(r=>r.id===id&&r.kind===kind);
   if(found)hits.push({source:source('wiki',page.project+'/'+page.id,page.title,page.project),updatedAt:page.updatedAt});
  }
  const projects=await tickets.projects();
  const opts={keys:projects.map(p=>p.key)};
  // A token (including a legacy ticket link) always contains its literal ID. Preselect candidate documents in SQLite.
  const candidates=hub.db.db.prepare("SELECT doc FROM docs WHERE kind='tickets' AND coll='tickets' AND instr(doc,?)>0");
  for(const row of candidates.iterate(id)){
   const tk=JSON.parse(row.doc);
   opts.attachmentNames=[...(tk.attachments??[]).map(a=>a.name),...tk.history.filter(h=>h.field==='attachment'&&h.to===null).map(h=>h.from)];
   for(const [text,field,updatedAt] of [[tk.description,'description',tk.updatedAt],...tk.comments.map(c=>[c.text,'comment/'+c.id,c.at])]){
    if(!text.includes(id))continue;
    const hit=markdownReferences(text,opts).find(r=>r.kind===kind&&r.id===id);
    if(hit)hits.push({source:source('ticket',tk.id,tk.title,tk.project),field,updatedAt,excerpt:hit.excerpt});
   }
  }
  hits.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.source.id.localeCompare(b.source.id));
  const window=hits.slice(offset,offset+limit);
  await Promise.all(window.filter(h=>h.source.kind==='wiki').map(async hit=>{
   const [project,page]=hit.source.id.split('/');hit.excerpt=wikiExcerpt((await wiki.get(project,page)).doc,kind,id);
  }));
  return {usages:window,usageTotal:hits.length};
 }
 async function target(kind,id){
  if(!validReference(kind,id))fail('invalid');
  const {entries}=await catalog(),source=entries.find(r=>r.kind===kind&&r.id===id);
  if(!source)fail('not-found');
  if(kind==='model'||kind==='custom'){
   const record=await records.get(source);if(!record)fail('not-found');
   return {record:{...record,href:source.href},note:null};
  }
  return {record:source,note:await records.note(source)};
 }
 async function get(input){
  if(!exactKeys(input,['kind','id','offset','limit']))fail('invalid');
  const offset=number(input.offset,0,0,1000000),limit=number(input.limit,50,1,100);
  const {kind,id}=input,{record,note}=await target(kind,id);
  return {record,note,...await usages(kind,id,offset,limit)};
 }
 async function save(input,by,local){
  if(local&&!(await tickets.projects()).some(p=>p.id===input?.project))fail('invalid');
  return records.save(input,by,local);
 }
 async function annotate(input,by,share){
  await target(input?.kind,input?.id);
  return records.annotate(input,by,share);
 }
 return {machines,search,resolve,get,save,remove:records.remove,promote:records.promote,annotate};
}
