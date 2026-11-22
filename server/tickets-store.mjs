// Ticket tracker for your own development work: projects, releases and tickets,
// one row each in state/hub.db (server/db.mjs; an old state/tickets/tickets.json is imported once). Every
// write goes through one queue and one transaction, which also updates the full-text index. Each ticket and
// release carries `rev`; an update must send the rev it read, otherwise it is refused as a conflict (read
// again, reapply). Comments are append-only and need no rev.
// Epics (docs/projects-v2.md §2) are one row each too (coll 'epics', id <KEY>-E<n>); a ticket names at most one
// epic of its own project. Errors are thrown as Error('invalid' | 'not-found' | 'conflict' | 'limit').
import {createMentionGuard} from './references.mjs';
import {createWikiProjectLookup} from './wiki-store.mjs';
import {referenceHref} from '../public/reference-format.js';
import {markdownReferences} from '../public/tracker-markdown-format.js';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openDb} from './db.mjs';

export const TICKET_TYPES=Object.freeze(['bug','feature','task']);
export const TICKET_STATUSES=Object.freeze(['open','in-progress','done','cancelled']);
export const TICKET_PRIORITIES=Object.freeze(['low','normal','high','urgent']);
export const RELEASE_STATUSES=Object.freeze(['planned','released']);
export const PROJECT_TYPES=Object.freeze(['web','app','game','other']);
// projectVersion: 1 for a project from before Projects v2 (until the upgrade wizard completes), 2 for a new one.
export const PROJECT_VERSIONS=Object.freeze([1,2]);
// Project settings (docs/project-settings.md): presentation choices kept on the project row and changed with the
// project's rev. Every projection carries all six; a row without them (seeded, imported, written before epoch 11)
// reads as these defaults. releases, reviews and wiki only show or hide those parts of the project's pages;
// globalReferences decides whether reference suggestions in the project offer global and other projects' sources.
export const PROJECT_COLORS=Object.freeze(['slate','red','orange','amber','green','teal','blue','violet']);
export const PROJECT_VIEWS=Object.freeze(['board','table']);
export const PROJECT_SETTINGS=Object.freeze({color:null,view:'board',releases:true,reviews:true,wiki:true,globalReferences:true});
const SETTING_VALID={color:v=>v===null||PROJECT_COLORS.includes(v),view:v=>PROJECT_VIEWS.includes(v),
 releases:v=>typeof v==='boolean',reviews:v=>typeof v==='boolean',wiki:v=>typeof v==='boolean',globalReferences:v=>typeof v==='boolean'};
// The stored settings with every field present; a missing or unusable field takes its default.
export function projectSettings(stored){
 const own=plain(stored)?stored:{};
 return Object.fromEntries(Object.entries(PROJECT_SETTINGS).map(([k,d])=>[k,Object.hasOwn(own,k)&&SETTING_VALID[k](own[k])?own[k]:d]));
}
// A partial change: only known fields, each with an allowed value. Omitted fields keep what the project has.
function settingsPatch(v){
 if(!plain(v)||!Object.entries(v).every(([k,x])=>Object.hasOwn(SETTING_VALID,k)&&SETTING_VALID[k](x)))fail('invalid');
 return {...v};
}
export const CLOSED=Object.freeze(['done','cancelled']);
export const TICKET_ID=/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$/;
export const PROJECT_ID=/^[a-z][a-z0-9-]{1,39}$/;
export const EPIC_ID=/^[A-Z][A-Z0-9]{1,9}-E[1-9][0-9]{0,5}$/;
const PROJECT_KEY=/^[A-Z][A-Z0-9]{1,9}$/,VERSION=/^(?!none$)[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/,LABEL=/^[a-z0-9][a-z0-9-]{0,29}$/,DAY=/^\d{4}-\d{2}-\d{2}$/;
// How many files one ticket holds. The upload route asks before it stores a file (server/core/tracker.mjs).
export const TICKET_ATTACHMENTS=20;
const LIMITS={projects:50,releases:500,tickets:5000,epics:1000,comments:200,history:200,labels:10,refs:20,attachments:TICKET_ATTACHMENTS,assign:500,upgradeEpics:20};
// An epic's spec is Markdown of up to 64 KiB in UTF-8; the rest of a write stays within TICKET_BODY_LIMIT. A route
// that takes a spec accepts EPIC_BODY_LIMIT bytes of JSON, room for the spec with every character escaped.
export const EPIC_SPEC_LIMIT=65536,EPIC_BODY_LIMIT=524288;
const fail=code=>{throw new Error(code);};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const onlyKeys=(x,keys)=>plain(x)&&Object.keys(x).every(k=>keys.includes(k));
// Trimmed text of 1..max characters (or 0..max when empty is allowed); anything else is invalid.
function text(v,max,{empty=false}={}){if(typeof v!=='string')fail('invalid');const t=v.trim();if((!empty&&!t)||t.length>max)fail('invalid');return t;}
const oneOf=(v,list)=>list.includes(v)?v:fail('invalid');
const nullable=(v,fn)=>v===null||v===''?null:fn(v);
const day=v=>nullable(v,x=>typeof x==='string'&&DAY.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x?x:fail('invalid'));
const validRev=v=>Number.isSafeInteger(v)&&v>0;
export const TICKET_BODY_LIMIT=16384;
const writeInput=(input,keys)=>onlyKeys(input,keys)&&Buffer.byteLength(JSON.stringify(input))<=TICKET_BODY_LIMIT;
// The same, with any spec counted on its own against EPIC_SPEC_LIMIT (spec text is checked again by specText).
const epicInput=(input,keys)=>{if(!onlyKeys(input,keys))return false;const {spec,...rest}=input;return Buffer.byteLength(JSON.stringify(rest))<=TICKET_BODY_LIMIT&&(spec===undefined||typeof spec==='string'&&Buffer.byteLength(spec)<=EPIC_SPEC_LIMIT);};
function specText(value){
 if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||Buffer.byteLength(value)>EPIC_SPEC_LIMIT)fail('invalid');
 return value;
}
function labels(v){if(!Array.isArray(v)||v.length>LIMITS.labels)fail('invalid');const out=[...new Set(v.map(l=>typeof l==='string'?l.trim().toLowerCase():''))];if(!out.every(l=>LABEL.test(l)))fail('invalid');return out;}
function refs(v){if(!Array.isArray(v)||v.length>LIMITS.refs)fail('invalid');return [...new Set(v.map(r=>text(r,300)))];}
export const compareVersions=(a,b)=>a.localeCompare(b,'en',{numeric:true,sensitivity:'base'});

// A new store starts with the projects the site asks for (site.json → tracker.projects); none by default.
const empty=(seed=[])=>({schema:1,revision:0,updatedAt:null,projects:seed.map(p=>({...p,description:'',labels:[],settings:{...PROJECT_SETTINGS},createdAt:null,rev:1,next:1,nextEpic:1,projectVersion:2})),releases:[],tickets:[],epics:[]});
// A row without the Projects v2 fields (imported, or not yet migrated) reads as a version-1 project without labels.
const projectVersionOf=p=>PROJECT_VERSIONS.includes(p.projectVersion)?p.projectVersion:1;
const publicProject=({next,nextEpic,...p})=>({...p,type:p.type??null,labels:Array.isArray(p.labels)?p.labels:[],projectVersion:projectVersionOf(p),settings:projectSettings(p.settings)});
const ticketOut=t=>({...t,epic:t.epic??null,attachments:t.attachments||[]});
const summary=({comments,history,attachments,...t})=>({...t,epic:t.epic??null,comments:comments.length,attachments:(attachments||[]).length});
const epicSummary=({comments,history,attachments,spec,...e})=>({...e,comments:comments.length,attachments:(attachments||[]).length});

const rows=(list,key)=>(list||[]).map(x=>[key(x),x]),docs=list=>(list||[]).map(([,d])=>d);
// What a project's rows are selected by in one transaction: its key prefixes its tickets and epics (keys are unique
// and permanent, and the hyphen ends the prefix), its id its releases.
export const projectSelection=p=>({projects:[p.id],releases:p.id+'/',tickets:p.key+'-',epics:p.key+'-'});
// What the search box finds a ticket by: id and title (weighted), then description, comments, attachment names, labels, refs and people.
export const ticketSearch=(coll,t)=>coll!=='tickets'?null:{kind:'ticket',id:t.id,project:t.project,updated:t.updatedAt,title:`${t.id} ${t.title}`,
 body:[t.description,...t.comments.map(c=>c.text),...(t.attachments||[]).map(a=>a.name),t.labels.join(' '),t.refs.join(' '),t.assignee,t.reporter].filter(Boolean).join('\n')};

// An epic is found by its id and title (weighted), then description, spec, comments, attachment names, labels, refs and people.
export const epicSearch=(coll,e)=>coll!=='epics'?null:{kind:'epic',id:e.id,project:e.project,updated:e.updatedAt,title:`${e.id} ${e.title}`,
 body:[e.description,e.spec,...e.comments.map(c=>c.text),...(e.attachments||[]).map(a=>a.name),e.labels.join(' '),e.refs.join(' '),e.assignee,e.reporter].filter(Boolean).join('\n')};
const trackerSearch=(coll,d)=>ticketSearch(coll,d)??epicSearch(coll,d);

// Who made a ticket and who changed it later, as [name, at] pairs (server/provenance.mjs → authoredProvenance).
export const ticketAuthors=t=>({created:[[t.reporter,t.createdAt]],
 changes:[...(t.history||[]).filter(h=>h.field!=='created').map(h=>[h.by,h.at]),...(t.comments||[]).map(c=>[c.by,c.at])]});

const FILTERS=['project','status','type','priority','release','assignee','label','epic','q','limit'];
 // Validates the field filters shared by list() and search(); returns the cleaned filter and a ticket predicate.
export function ticketFilter(filter,keys=FILTERS){
  if(!onlyKeys(filter,keys))fail('invalid');
  const f=Object.fromEntries(Object.entries(filter).filter(([,v])=>v!==undefined&&v!==''));
  for(const [k,v] of Object.entries(f))if(typeof v!=='string'&&(k!=='limit'||typeof v!=='number'))fail('invalid');
  if(f.status&&f.status.length>60)fail('invalid');
  if(f.type)oneOf(f.type,TICKET_TYPES);if(f.priority)oneOf(f.priority,TICKET_PRIORITIES);
  if(f.project&&!PROJECT_ID.test(f.project)||f.release&&f.release!=='none'&&!VERSION.test(f.release)||f.label&&!LABEL.test(f.label)||f.assignee&&f.assignee.length>60)fail('invalid');
  if(f.epic&&f.epic!=='none'&&!EPIC_ID.test(f.epic))fail('invalid');
  const statuses=f.status?String(f.status).split(',').map(s=>oneOf(s,[...TICKET_STATUSES,'active'])).flatMap(s=>s==='active'?['open','in-progress']:[s]):null;
  const match=t=>(!f.project||t.project===f.project)&&(!statuses||statuses.includes(t.status))&&(!f.type||t.type===f.type)
   &&(!f.priority||t.priority===f.priority)&&(!f.release||(f.release==='none'?t.release===null:t.release===f.release))
   &&(!f.assignee||(f.assignee==='none'?t.assignee===null:t.assignee===f.assignee))&&(!f.label||t.labels.includes(f.label))
   &&(!f.epic||(f.epic==='none'?(t.epic??null)===null:t.epic===f.epic));
  return {f,match};
 }

// files: the attachment blobs (server/ticket-files.mjs), for the cleanup a project deletion hands back.
export function createTicketStore(root,{db=openDb(path.join(root,'hub.db')),seedProjects=[],mentionGuard=null,files:blobs=null}={}){
 let queue=Promise.resolve(),searchRevision=0;const searchListeners=new Set();
 const store=db.collection('tickets',{empty:()=>empty(seedProjects),legacy:path.join(root,'tickets.json'),searchKinds:['ticket','epic'],search:trackerSearch,
  valid:d=>d?.schema===1&&Array.isArray(d.projects)&&Array.isArray(d.releases)&&Array.isArray(d.tickets)&&(d.epics===undefined||Array.isArray(d.epics)),
  split:({projects,releases,tickets,epics,...meta})=>({meta,colls:{projects:rows(projects,p=>p.id),releases:rows(releases,r=>r.project+'/'+r.version),tickets:rows(tickets,t=>t.id),epics:rows(epics,e=>e.id)}}),
  join:(meta,c)=>({...meta,projects:docs(c.projects),releases:docs(c.releases),tickets:docs(c.tickets),epics:docs(c.epics)})});
 const refSummaryQuery=db.db.prepare("SELECT id,json_extract(doc,'$.title') AS title,json_extract(doc,'$.project') AS project FROM docs WHERE kind='tickets' AND coll='tickets'");
 const epicSummaryQuery=db.db.prepare("SELECT id,json_extract(doc,'$.title') AS title,json_extract(doc,'$.project') AS project FROM docs WHERE kind='tickets' AND coll='epics'");
 const mentionCandidatesQuery=db.db.prepare("SELECT coll,doc FROM docs WHERE kind='tickets' AND coll IN ('tickets','epics') AND instr(doc,?)>0");
 const hasProjectQuery=db.db.prepare("SELECT 1 FROM docs WHERE kind='tickets' AND coll='projects' AND id=?");
 const ticketProjectQuery=db.db.prepare("SELECT json_extract(doc,'$.project') AS project FROM docs WHERE kind='tickets' AND coll='tickets' AND id=?");
 const epicProjectQuery=db.db.prepare("SELECT json_extract(doc,'$.project') AS project FROM docs WHERE kind='tickets' AND coll='epics' AND id=?");
 const epicProgressQuery=db.db.prepare("SELECT json_extract(doc,'$.status') AS status,count(*) AS n FROM docs WHERE kind='tickets' AND coll='tickets' AND json_extract(doc,'$.epic')=? GROUP BY 1");
 // Whether a row other than coll/id still names this attachment file. Tickets and epics share the blobs.
 const fileUsedQuery=db.db.prepare("SELECT 1 FROM docs WHERE kind='tickets' AND coll IN ('tickets','epics') AND instr(doc,?)>0 AND NOT (coll=? AND id=?) LIMIT 1");
 const fileUsedSync=(sha,coll='',id='')=>Boolean(fileUsedQuery.get(`"sha256":"${sha}"`,coll,id));
 const hasProjectSync=id=>Boolean(hasProjectQuery.get(id));
 const ticketProjectSync=id=>ticketProjectQuery.get(id)?.project??null;
 const epicProjectSync=id=>typeof id==='string'&&EPIC_ID.test(id)?epicProjectQuery.get(id)?.project??null:null;
 const wikiProjectSync=createWikiProjectLookup(db);
 const guardMentions=mentionGuard??createMentionGuard({db,tickets:{hasProjectSync,ticketProjectSync,epicProjectSync},wiki:{wikiProjectSync}});
 function notify(){searchRevision++;for(const listener of searchListeners)try{listener();}catch{}}
 // Serialised read-modify-write; fn mutates the document and returns the reply. A throw writes nothing.
 function write(fn,selection={projects:null,releases:null,tickets:null,epics:null},{durable=false}={}){
  const run=queue.then(()=>store.change(selection,(data,count)=>{
    const now=new Date().toISOString(),result=fn(data,now,count);data.revision++;data.updatedAt=now;return result;
   },{durable})).then(result=>{if(Object.hasOwn(selection,'tickets'))notify();return result;});queue=run.catch(()=>{});return run;
 }
 const projectOf=(data,id)=>data.projects.find(p=>p.id===id)||fail('invalid');
 function releaseOf(data,project,version){
  if(version===null)return null;
  if(typeof version!=='string'||!VERSION.test(version))fail('invalid');
  return data.releases.find(r=>r.project===project&&r.version===version)?.version||fail('invalid');
 }
 const ticketOf=(data,id)=>(typeof id==='string'&&TICKET_ID.test(id)&&data.tickets.find(t=>t.id===id))||fail('not-found');
 const epicOf=(data,id)=>(typeof id==='string'&&EPIC_ID.test(id)&&data.epics.find(e=>e.id===id))||fail('not-found');
 // A ticket's epic: null, or an epic of the ticket's own project.
 function epicFor(data,project,value){
  if(value===null||value==='')return null;
  if(typeof value!=='string'||!EPIC_ID.test(value))fail('invalid');
  return data.epics.find(e=>e.id===value&&e.project===project)?.id||fail('invalid');
 }
 const keyOfEpic=id=>id.slice(0,id.lastIndexOf('-E'));
 const pushHistory=(x,entry)=>{x.history.push(entry);x.history=x.history.slice(-LIMITS.history);};

 // Cache only the list projection, never comments/history/file contents. A returned document is
 // always detached from this internal view. Bound retained JSON size; oversized sites use cold reads.
 let readView=null,buildingView=null,lastViewVersion=null;
 async function view(){
  const version=await store.version();
  if(readView?.version===version)return readView.data;
  if(buildingView?.version===version)return buildingView.promise;
  // Admit on repeated reads: write/read alternation avoids cache-sizing work.
  const retain=lastViewVersion===version;lastViewVersion=version;
  const promise=(async()=>{
   const data=await store.read({forWrite:false});
   if(retain){data.tickets=data.tickets.map(summary);data.epics=data.epics.map(epicSummary);}
   const bytes=retain?Buffer.byteLength(JSON.stringify(data)):Infinity;
   const value={data,summarized:retain};
   readView=bytes<=16*1024*1024?{version,data:value}:null;
   return value;
  })();
  const pending={version,promise};buildingView=pending;
  try{return await promise;}finally{if(buildingView===pending)buildingView=null;}
 }
 const emptyCounts=()=>Object.fromEntries(TICKET_STATUSES.map(s=>[s,0]));
 const withTotal=counts=>({counts,total:Object.values(counts).reduce((a,b)=>a+b,0)});

 // Read side ---------------------------------------------------------------------------------

 // authors: true adds `authors` = {created, changes, seeded} over the projects, releases and tickets of the
 // project filter (not the other filters): who made and changed them, and how many projects the site seeded.
 async function list(filter={},{authors=false}={}){
  const {f,match}=ticketFilter(filter);
  if(f.q&&f.q.length>100)fail('invalid');
  const {data,summarized}=await view();
  const q=f.q?f.q.toLowerCase():null,limit=f.limit===undefined?null:Number(f.limit);
  if(limit!==null&&!(Number.isInteger(limit)&&limit>0&&limit<=LIMITS.tickets))fail('invalid');
  let tickets=data.tickets.filter(t=>match(t)&&(!q||[t.id,t.title,t.description,...t.labels].join('\n').toLowerCase().includes(q)));
  tickets.sort((a,b)=>TICKET_STATUSES.indexOf(a.status)-TICKET_STATUSES.indexOf(b.status)||TICKET_PRIORITIES.indexOf(b.priority)-TICKET_PRIORITIES.indexOf(a.priority)||b.updatedAt.localeCompare(a.updatedAt));
  const total=tickets.length;if(limit)tickets=tickets.slice(0,limit);
  // Release progress is counted over all tickets, not just the filtered ones.
  const progress=new Map();
  for(const t of data.tickets)if(t.release!==null){const key=t.project+'/'+t.release,counts=progress.get(key)||emptyCounts();counts[t.status]++;progress.set(key,counts);}
  const releases=data.releases.filter(r=>!f.project||r.project===f.project).map(r=>{
   const counts=progress.get(r.project+'/'+r.version)||emptyCounts();
   return {...r,counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};}).sort((a,b)=>a.project.localeCompare(b.project)||compareVersions(a.version,b.version));
  // The epics of the listed projects, briefly (id, title, status), for the epic filter and the ticket rows.
  const epics=data.epics.filter(e=>!f.project||e.project===f.project).map(({id,project,title,status,rev})=>({id,project,title,status,rev}));
  const out={updatedAt:data.updatedAt,projects:data.projects.map(publicProject),releases,epics,total,tickets:summarized?tickets:tickets.map(summary)};
  if(!authors)return structuredClone(out);
  const facts={created:[],changes:[],seeded:0},mine=x=>!f.project||(x.project??x.id)===f.project;
  // A project without an author was seeded from the site configuration (site.json → tracker.projects).
  for(const p of data.projects.filter(mine)){if(p.createdBy)facts.created.push([p.createdBy,p.createdAt]);else facts.seeded++;}
  for(const r of data.releases.filter(mine))facts.created.push([r.createdBy,r.createdAt]);
  for(const t of (summarized?await store.list('tickets'):data.tickets).filter(mine)){const a=ticketAuthors(t);facts.created.push(...a.created);facts.changes.push(...a.changes);}
  return structuredClone({...out,authors:facts});
 }
 async function projects(){return (await store.list('projects')).map(publicProject);}
 async function get(id){
  if(typeof id!=='string'||!TICKET_ID.test(id))fail('not-found');
  const t=await store.get('tickets',id);if(!t)fail('not-found');return ticketOut(t);
 }
 // Full-text search over tickets (title, description, comments, attachment names, labels, refs, people) with the
 // same field filters as list(). Plain words, every word a prefix match; best match first. Each hit is the list
 // summary plus `snippet` (matched words wrapped in \u0001…\u0002) and `score`.
 async function search(filter={}){
  const {f,match}=ticketFilter(filter);
  if(typeof f.q!=='string'||f.q.length>200||!/[\p{L}\p{N}_]/u.test(f.q))fail('invalid');
  const limit=f.limit===undefined?20:Number(f.limit);if(!(Number.isInteger(limit)&&limit>0&&limit<=100))fail('invalid');
  const {data,summarized}=await view(),byId=new Map(data.tickets.map(t=>[t.id,t]));
  const query={q:f.q,kind:'ticket',...(f.project?{project:f.project}:{})};
  // Apply field filters before ranking, then materialize/snippet only the requested page.
  const filtered=Object.keys(f).some(k=>!['q','project','limit'].includes(k));
  const ids=filtered?data.tickets.filter(match).map(t=>t.id):null;
  const hits=db.search({...query,limit},{ids,countAll:true,snippets:false});
  const page=hits.results.map(r=>({r,t:byId.get(r.id)})).filter(x=>x.t);
  const snippets=new Map(db.search({...query,limit},{ids:page.map(x=>x.t.id)}).results.map(r=>[r.id,r.snippet]));
  return {q:f.q,total:hits.total,tickets:page.map(({r,t})=>({...structuredClone(summarized?t:summary(t)),snippet:snippets.get(t.id),score:r.score}))};
 }
 // The names tickets and epics know: assignees (with how many tickets they hold, and how many of those are
 // active), reporters and comment authors. The assignee field suggests them.
 async function people(){
  const data=await store.read({forWrite:false}),seen=new Map();
  const of=name=>{if(typeof name!=='string'||!name)return null;if(!seen.has(name))seen.set(name,{name,assigned:0,active:0});return seen.get(name);};
  for(const t of data.tickets){
   const a=of(t.assignee);if(a){a.assigned++;if(!CLOSED.includes(t.status))a.active++;}
   of(t.reporter);for(const c of t.comments)of(c.by);
  }
  for(const e of data.epics){of(e.assignee);of(e.reporter);for(const c of e.comments)of(c.by);}
  return [...seen.values()].sort((a,b)=>b.active-a.active||b.assigned-a.assigned||a.name.localeCompare(b.name,'en'));
 }

 // Attachments: the file itself lives in ticket-files (content-addressed, shared by tickets and epics); the record
 // keeps the metadata. Like comments they need no rev; adding or removing one is recorded in the history. A name
 // is one file of the record (a text points at a file as ![name]): a name it already has, in any case, gets
 // -2, -3, … before its extension.
 const recordOf=(coll,data,id)=>coll==='epics'?epicOf(data,id):ticketOf(data,id);
 function attachTo(coll,id,file,by,{deduplicate=false}={}){
  if(!plain(file)||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size)||typeof file.type!=='string')fail('invalid');
  const name=text(file.name,120);
  return write((data,now)=>{
   const t=recordOf(coll,data,id);t.attachments=t.attachments||[];
   if(deduplicate&&t.attachments.some(a=>a.sha256===file.sha256))return coll==='epics'?epicOut(t):ticketOut(t);
   if(t.attachments.length>=LIMITS.attachments)fail('limit');
   const used=new Set(t.attachments.map(a=>a.name.toLowerCase())),dot=name.lastIndexOf('.'),ext=dot>0&&name.length-dot<=12?name.slice(dot):'',stem=ext?name.slice(0,dot):name;
   let own=name;for(let i=2;used.has(own.toLowerCase());i++)own=`${stem.slice(0,120-ext.length-String(i).length-1)}-${i}${ext}`;
   t.attachments.push({id:randomUUID(),name:own,type:file.type,size:file.size,sha256:file.sha256,by,at:now});
   pushHistory(t,{at:now,by,field:'attachment',from:null,to:own});t.updatedAt=now;return coll==='epics'?epicOut(t):ticketOut(t);
  },{[coll]:typeof id==='string'?[id]:[]});
 }
 // Returns the record and whether any ticket or epic still references the removed file.
 function detachFrom(coll,input,by){
  if(!writeInput(input,['id','attachment'])||typeof input.attachment!=='string')fail('invalid');
  return write((data,now)=>{
   const t=recordOf(coll,data,input.id),list=t.attachments||[],a=list.find(x=>x.id===input.attachment)||fail('not-found');
   t.attachments=list.filter(x=>x!==a);pushHistory(t,{at:now,by,field:'attachment',from:a.name,to:null});t.updatedAt=now;
   const used=t.attachments.some(y=>y.sha256===a.sha256)||fileUsedSync(a.sha256,coll,t.id);
   return {[coll==='epics'?'epic':'ticket']:coll==='epics'?epicOut(t):ticketOut(t),removed:a,used};
  },{[coll]:typeof input?.id==='string'?[input.id]:[]});
 }
 async function attachment(id,attachmentId){const t=await get(id);return t.attachments.find(a=>a.id===attachmentId)||fail('not-found');}
 const attach=(id,file,by,options)=>attachTo('tickets',id,file,by,options);
 const detach=(input,by)=>detachFrom('tickets',input,by);
 async function fileInUse(sha){await store.version();return fileUsedSync(sha);}

 // Write side --------------------------------------------------------------------------------
 const TICKET_FIELDS=['title','description','type','status','priority','release','assignee','labels','refs','epic'];
 function fields(input,project,data){
  const out={};
  if('title'in input)out.title=text(input.title,200);
  if('description'in input)out.description=text(input.description,12000,{empty:true});
  if('type'in input)out.type=oneOf(input.type,TICKET_TYPES);
  if('status'in input)out.status=oneOf(input.status,TICKET_STATUSES);
  if('priority'in input)out.priority=oneOf(input.priority,TICKET_PRIORITIES);
  if('release'in input)out.release=releaseOf(data,project,input.release===''?null:input.release);
  if('assignee'in input)out.assignee=nullable(input.assignee,v=>{const name=text(v,60);return name==='none'?fail('invalid'):name;});
  if('labels'in input)out.labels=labels(input.labels);
  if('refs'in input)out.refs=refs(input.refs);
  if('epic'in input)out.epic=epicFor(data,project,input.epic);
  return out;
 }
 async function referenceSummaries(){await store.version();return refSummaryQuery.all();}
 async function epicSummaries(){await store.version();return epicSummaryQuery.all();}
 async function findMentionUsages(kind,id){
  const keys=(await projects()).map(p=>p.key),hits=[];
  // A token (including a legacy ticket link) always contains its literal ID. Preselect candidate documents in SQLite.
  for(const row of mentionCandidatesQuery.iterate(id)){
   const tk=JSON.parse(row.doc),epic=row.coll==='epics';
   const attachmentNames=[...(tk.attachments??[]).map(a=>a.name),...(tk.history??[]).filter(h=>h.field==='attachment'&&h.to===null).map(h=>h.from)];
   const texts=[[tk.description,'description',tk.updatedAt],...(epic?[[tk.spec,'spec',tk.updatedAt]]:[]),...tk.comments.map(c=>[c.text,'comment/'+c.id,c.at])];
   for(const [text,field,updatedAt] of texts){
    if(typeof text!=='string'||!text.includes(id))continue;
    const hit=markdownReferences(text,{keys,attachmentNames}).find(r=>r.kind===kind&&r.id===id);
    if(hit)hits.push({source:{kind:epic?'epic':'ticket',id:tk.id,label:tk.title,project:tk.project,href:epic?referenceHref('epic',tk.id)??'#epics/'+tk.id:referenceHref('ticket',tk.id)},field,updatedAt,excerpt:hit.excerpt});
   }
  }
  return hits;
 }
 async function guardText(value){
  if(typeof value!=='string'||!value.includes('@['))return ()=>{};
  // File chip resolution changes the presentation, while the shared parser keeps filename text isolated.
  const validate=await guardMentions(markdownReferences(value));
  return (project,previous='')=>validate(project,markdownReferences(previous));
 }
 // The same over several texts of one record (an epic's description and spec); previous is their old values.
 async function guardTexts(values){
  const texts=values.filter(v=>typeof v==='string'&&v.includes('@['));
  if(!texts.length)return ()=>{};
  const validate=await guardMentions(texts.flatMap(v=>markdownReferences(v)));
  return (project,previous=[])=>validate(project,previous.flatMap(v=>typeof v==='string'?markdownReferences(v):[]));
 }
 async function create(input,by){
  if(!writeInput(input,['project',...TICKET_FIELDS])||typeof input.project!=='string'||!('title'in input))fail('invalid');
  const description='description'in input?text(input.description,12000,{empty:true}):undefined;
  const validate=await guardText(description);
  return write((data,now,count)=>{
   const project=projectOf(data,input.project);validate(project.id);if(count('tickets')>=LIMITS.tickets)fail('limit');
   const f=fields(input,project.id,data),id=`${project.key}-${project.next}`;
   if(!TICKET_ID.test(id))fail('limit');
   project.next++;
   const ticket={id,project:project.id,title:f.title,description:f.description??'',type:f.type??'task',status:f.status??'open',priority:f.priority??'normal',
    release:f.release??null,assignee:f.assignee??null,labels:f.labels??[],refs:f.refs??[],epic:f.epic??null,reporter:by,createdAt:now,updatedAt:now,
    closedAt:CLOSED.includes(f.status)?now:null,rev:1,comments:[],attachments:[],history:[{at:now,by,field:'created',from:null,to:f.status??'open'}]};
   data.tickets.push(ticket);return ticket;
  },{projects:null,releases:null,tickets:[],epics:typeof input.epic==='string'?[input.epic]:[]});
 }
 async function update(input,by){
  if(!writeInput(input,['id','rev',...TICKET_FIELDS])||!validRev(input.rev)||!TICKET_FIELDS.some(k=>k in input))fail('invalid');
  const description='description'in input?text(input.description,12000,{empty:true}):undefined;
  const validate=await guardText(description);
  return write((data,now)=>{
   const t=ticketOf(data,input.id);
   if(t.rev!==input.rev)fail('conflict');
   validate(t.project,t.description);
   const f=fields(input,t.project,data),current=k=>k==='epic'?t.epic??null:t[k],changed=Object.keys(f).filter(k=>JSON.stringify(f[k])!==JSON.stringify(current(k)));
   if(!changed.length)return ticketOut(t);
   // History keeps values for the short fields; title/description record only that they changed.
   for(const k of changed)t.history.push({at:now,by,field:k,from:['title','description'].includes(k)?null:current(k),to:['title','description'].includes(k)?null:f[k]});
   if('status'in f&&f.status!==t.status)t.closedAt=CLOSED.includes(f.status)?now:null;
   Object.assign(t,f);t.history=t.history.slice(-LIMITS.history);t.updatedAt=now;t.rev++;return ticketOut(t);
  },{releases:null,tickets:typeof input.id==='string'?[input.id]:[],epics:typeof input.epic==='string'?[input.epic]:[]});
 }
 async function comment(input,by){
  if(!writeInput(input,['id','text'])||!('text'in input))fail('invalid');
  const body=text(input.text,8000),validate=await guardText(body);
  return write((data,now)=>{
   const t=ticketOf(data,input.id);
   validate(t.project);
   if(t.comments.length>=LIMITS.comments)fail('limit');
   t.comments.push({id:randomUUID(),at:now,by,text:body});t.updatedAt=now;return ticketOut(t);
  },{tickets:typeof input.id==='string'?[input.id]:[]});
 }
 // Create a release (no rev) or change one (rev required). Released → releasedAt defaults to today.
 async function saveRelease(input,by){
  if(!writeInput(input,['project','version','status','targetDate','releasedAt','notes','rev'])||typeof input.version!=='string'||!VERSION.test(input.version))fail('invalid');
  if(input.rev!==undefined&&!validRev(input.rev))fail('invalid');
  return write((data,now)=>{
   const project=projectOf(data,input.project),old=data.releases.find(r=>r.project===project.id&&r.version===input.version);
   if(old?input.rev!==old.rev:input.rev!==undefined)fail(old||input.rev===undefined?'conflict':'not-found');
   if(!old&&data.releases.length>=LIMITS.releases)fail('limit');
   const r=old||{project:project.id,version:input.version,status:'planned',targetDate:null,releasedAt:null,notes:'',createdAt:now,createdBy:by,rev:0};
   if('status'in input)r.status=oneOf(input.status,RELEASE_STATUSES);
   if('targetDate'in input)r.targetDate=day(input.targetDate);
   if('releasedAt'in input)r.releasedAt=day(input.releasedAt);
   if('notes'in input)r.notes=text(input.notes,2000,{empty:true});
   if(r.status==='released'&&!r.releasedAt)r.releasedAt=now.slice(0,10);
   if(r.status==='planned')r.releasedAt=null;
   r.updatedAt=now;r.rev++;if(!old)data.releases.push(r);return r;
  },{projects:null,releases:null});
 }

 // Projects -----------------------------------------------------------------------------------
 // Validation shared by saveProject and the project lifecycle (server/project-lifecycle.mjs). createWiki asks the
 // lifecycle for a linked wiki; this store alone cannot make one. projectVersion is read-only: it may only repeat
 // the value the project has (2 for a new one); the upgrade wizard is what moves it.
 const PROJECT_KEYS=['id','key','name','description','type','labels','settings','projectVersion','createWiki','rev'];
 function prepareProject(input){
  if(!writeInput(input,PROJECT_KEYS)||typeof input.id!=='string'||!PROJECT_ID.test(input.id))fail('invalid');
  if(input.rev!==undefined&&!validRev(input.rev))fail('invalid');
  if(input.createWiki!==undefined&&typeof input.createWiki!=='boolean')fail('invalid');
  if(input.projectVersion!==undefined&&!PROJECT_VERSIONS.includes(input.projectVersion))fail('invalid');
  return {id:input.id,key:input.key,hasKey:'key'in input,rev:input.rev,projectVersion:input.projectVersion,createWiki:input.createWiki===true,
   name:'name'in input?text(input.name,80):undefined,description:'description'in input?text(input.description,500,{empty:true}):undefined,
   type:'type'in input?nullable(input.type,v=>oneOf(v,PROJECT_TYPES)):undefined,labels:'labels'in input?labels(input.labels):undefined,
   settings:'settings'in input?settingsPatch(input.settings):{}};
 }
 // Inside a transaction over data.projects (all of them, for the key and the count). Returns the saved project,
 // whether it was created, and the name it had before (for a linked wiki to follow a rename).
 function applyProject(data,prep,by,now){
  const old=data.projects.find(p=>p.id===prep.id);
  if(old){
   if(prep.rev!==old.rev)fail('conflict');
   if(prep.hasKey&&prep.key!==old.key||prep.createWiki||prep.projectVersion!==undefined&&prep.projectVersion!==projectVersionOf(old))fail('invalid');
   const previous={name:old.name};
   if(prep.name!==undefined)old.name=prep.name;if(prep.description!==undefined)old.description=prep.description;if(prep.type!==undefined)old.type=prep.type;
   if(prep.labels!==undefined)old.labels=prep.labels;else if(!Array.isArray(old.labels))old.labels=[];
   old.projectVersion=projectVersionOf(old);if(!Number.isSafeInteger(old.nextEpic))old.nextEpic=1;
   old.settings={...projectSettings(old.settings),...prep.settings};
   old.updatedAt=now;old.rev++;return {project:publicProject(old),created:false,previous,createWiki:false};
  }
  if(prep.rev!==undefined)fail('not-found');
  if(typeof prep.key!=='string'||!PROJECT_KEY.test(prep.key)||prep.name===undefined||prep.projectVersion===1)fail('invalid');
  if(data.projects.some(p=>p.key===prep.key))fail('conflict');
  if(data.projects.length>=LIMITS.projects)fail('limit');
  const {next=1,nextEpic=1}=data.retiredKeys?.[prep.key]??{};
  if(data.retiredKeys)delete data.retiredKeys[prep.key];
  const p={id:prep.id,key:prep.key,name:prep.name,description:prep.description??'',type:prep.type??null,labels:prep.labels??[],settings:{...PROJECT_SETTINGS,...prep.settings},
   createdAt:now,createdBy:by,updatedAt:now,rev:1,next,nextEpic,projectVersion:2};
  data.projects.push(p);return {project:publicProject(p),created:true,previous:null,createWiki:prep.createWiki};
 }
 // Create a project (no rev; id and key are permanent) or change its name/description/type/labels/settings (rev
 // required). settings is partial: the fields it names replace the project's, the others stay as they are.
 async function saveProject(input,by){
  const prep=prepareProject(input);if(prep.createWiki)fail('invalid');
  return write((data,now)=>applyProject(data,prep,by,now).project,{projects:null});
 }

 // Epics --------------------------------------------------------------------------------------
 const EPIC_FIELDS=['title','description','spec','status','priority','release','assignee','labels','refs'];
 function epicFields(input,project,data){
  const out={};
  if('title'in input)out.title=text(input.title,200);
  if('description'in input)out.description=text(input.description,2000,{empty:true});
  if('spec'in input)out.spec=specText(input.spec);
  if('status'in input)out.status=oneOf(input.status,TICKET_STATUSES);
  if('priority'in input)out.priority=oneOf(input.priority,TICKET_PRIORITIES);
  if('release'in input)out.release=releaseOf(data,project,input.release===''?null:input.release);
  if('assignee'in input)out.assignee=nullable(input.assignee,v=>{const name=text(v,60);return name==='none'?fail('invalid'):name;});
  if('labels'in input)out.labels=labels(input.labels);
  if('refs'in input)out.refs=refs(input.refs);
  return out;
 }
 const hasEpicQuery=db.db.prepare("SELECT 1 FROM docs WHERE kind='tickets' AND coll='epics' AND id=?");
 // A new epic of project p, numbered from p.nextEpic. Inside a transaction; count is the transaction's row count.
 function addEpic(data,p,f,by,now,count){
  if(count('epics')>=LIMITS.epics)fail('limit');
  let n=Number.isSafeInteger(p.nextEpic)&&p.nextEpic>0?p.nextEpic:1;
  while(hasEpicQuery.get(`${p.key}-E${n}`)||data.epics.some(e=>e.id===`${p.key}-E${n}`))n++;
  const id=`${p.key}-E${n}`;
  if(!EPIC_ID.test(id))fail('limit');
  const epic={id,project:p.id,title:f.title,description:f.description??'',spec:f.spec??'',status:f.status??'open',priority:f.priority??'normal',
   release:f.release??null,assignee:f.assignee??null,labels:f.labels??[],refs:f.refs??[],reporter:by,createdAt:now,updatedAt:now,
   closedAt:CLOSED.includes(f.status)?now:null,rev:1,comments:[],attachments:[],history:[{at:now,by,field:'created',from:null,to:f.status??'open'}]};
  p.nextEpic=n+1;data.epics.push(epic);return epic;
 }
 const epicOut=(e,counts=null)=>({...e,attachments:e.attachments||[],...(counts?withTotal(counts):{})});
 function progressOf(id){const counts=emptyCounts();for(const r of epicProgressQuery.all(id))if(Object.hasOwn(counts,r.status))counts[r.status]=Number(r.n);return counts;}
 // Moves tickets into an epic (a ticket belongs to at most one: one in another epic moves). Validates all first.
 function assignTickets(data,epic,items,by,now){
  const found=items.map(({id,rev})=>{
   const t=data.tickets.find(x=>x.id===id)||fail('not-found');
   if(t.project!==epic.project)fail('invalid');
   if(rev!==undefined&&t.rev!==rev)fail('conflict');
   return t;
  });
  const changed=[];
  for(const t of found){
   if((t.epic??null)===epic.id)continue;
   pushHistory(t,{at:now,by,field:'epic',from:t.epic??null,to:epic.id});t.epic=epic.id;t.updatedAt=now;t.rev++;changed.push(t);
  }
  return changed;
 }
 const EPIC_FILTERS=['project','status','priority','release','assignee','label','limit'];
 async function listEpics(filter={}){
  if(!onlyKeys(filter,EPIC_FILTERS))fail('invalid');
  const f=Object.fromEntries(Object.entries(filter).filter(([,v])=>v!==undefined&&v!==''));
  for(const [k,v] of Object.entries(f))if(typeof v!=='string'&&(k!=='limit'||typeof v!=='number'))fail('invalid');
  if(f.priority)oneOf(f.priority,TICKET_PRIORITIES);
  if(f.status&&f.status.length>60||f.project&&!PROJECT_ID.test(f.project)||f.release&&f.release!=='none'&&!VERSION.test(f.release)||f.label&&!LABEL.test(f.label)||f.assignee&&f.assignee.length>60)fail('invalid');
  const statuses=f.status?String(f.status).split(',').map(s=>oneOf(s,[...TICKET_STATUSES,'active'])).flatMap(s=>s==='active'?['open','in-progress']:[s]):null;
  const limit=f.limit===undefined?null:Number(f.limit);
  if(limit!==null&&!(Number.isInteger(limit)&&limit>0&&limit<=LIMITS.epics))fail('invalid');
  const {data,summarized}=await view(),progress=new Map();
  for(const t of data.tickets)if(t.epic){const c=progress.get(t.epic)||emptyCounts();c[t.status]++;progress.set(t.epic,c);}
  let epics=data.epics.filter(e=>(!f.project||e.project===f.project)&&(!statuses||statuses.includes(e.status))&&(!f.priority||e.priority===f.priority)
   &&(!f.release||(f.release==='none'?e.release===null:e.release===f.release))&&(!f.assignee||(f.assignee==='none'?e.assignee===null:e.assignee===f.assignee))&&(!f.label||e.labels.includes(f.label)));
  epics.sort((a,b)=>TICKET_STATUSES.indexOf(a.status)-TICKET_STATUSES.indexOf(b.status)||TICKET_PRIORITIES.indexOf(b.priority)-TICKET_PRIORITIES.indexOf(a.priority)||b.updatedAt.localeCompare(a.updatedAt));
  const total=epics.length;if(limit)epics=epics.slice(0,limit);
  return structuredClone({total,epics:epics.map(e=>({...(summarized?e:epicSummary(e)),...withTotal(progress.get(e.id)||emptyCounts())}))});
 }
 async function getEpic(id){
  if(typeof id!=='string'||!EPIC_ID.test(id))fail('not-found');
  const e=await store.get('epics',id);if(!e)fail('not-found');return epicOut(e,progressOf(id));
 }
 async function createEpic(input,by){
  if(!epicInput(input,['project',...EPIC_FIELDS])||typeof input.project!=='string'||!PROJECT_ID.test(input.project)||!('title'in input))fail('invalid');
  const f0=epicFields({...input,release:null},null,{releases:[]}),validate=await guardTexts([f0.description,f0.spec]);
  return write((data,now,count)=>{
   const p=projectOf(data,input.project);validate(p.id);
   return epicOut(addEpic(data,p,epicFields(input,p.id,data),by,now,count),emptyCounts());
  },{projects:[input.project],releases:input.project+'/',epics:[]});
 }
 async function updateEpic(input,by){
  if(!epicInput(input,['id','rev',...EPIC_FIELDS])||!validRev(input.rev)||typeof input.id!=='string'||!EPIC_ID.test(input.id)||!EPIC_FIELDS.some(k=>k in input))fail('invalid');
  const f0=epicFields({...input,release:null},null,{releases:[]}),validate=await guardTexts([f0.description,f0.spec]);
  const result=await write((data,now)=>{
   const e=epicOf(data,input.id);
   if(e.rev!==input.rev)fail('conflict');
   validate(e.project,[e.description,e.spec]);
   const f=epicFields(input,e.project,data),changed=Object.keys(f).filter(k=>JSON.stringify(f[k])!==JSON.stringify(e[k]));
   if(!changed.length)return e;
   const long=['title','description','spec'];
   for(const k of changed)e.history.push({at:now,by,field:k,from:long.includes(k)?null:e[k],to:long.includes(k)?null:f[k]});
   if('status'in f&&f.status!==e.status)e.closedAt=CLOSED.includes(f.status)?now:null;
   Object.assign(e,f);e.history=e.history.slice(-LIMITS.history);e.updatedAt=now;e.rev++;return e;
  },{epics:[input.id],...('release'in input?{releases:null}:{})});
  return epicOut(result,progressOf(result.id));
 }
 async function commentEpic(input,by){
  if(!writeInput(input,['id','text'])||!('text'in input))fail('invalid');
  const body=text(input.text,8000),validate=await guardText(body);
  const result=await write((data,now)=>{
   const e=epicOf(data,input.id);
   validate(e.project);
   if(e.comments.length>=LIMITS.comments)fail('limit');
   e.comments.push({id:randomUUID(),at:now,by,text:body});e.updatedAt=now;return e;
  },{epics:typeof input.id==='string'?[input.id]:[]});
  return epicOut(result,progressOf(result.id));
 }
 // Deletes an epic (rev-checked). Its tickets stay and lose the link; files no other record names are returned in
 // unused, for the caller to remove once this durable commit is done.
 async function deleteEpic(input,by){
  if(!writeInput(input,['id','rev'])||typeof input.id!=='string'||!EPIC_ID.test(input.id)||!validRev(input.rev))fail('invalid');
  return write((data,now)=>{
   const e=epicOf(data,input.id);
   if(e.rev!==input.rev)fail('conflict');
   const detached=[];
   for(const t of data.tickets)if(t.epic===e.id){pushHistory(t,{at:now,by,field:'epic',from:e.id,to:null});t.epic=null;t.updatedAt=now;t.rev++;detached.push(t.id);}
   data.epics=data.epics.filter(x=>x!==e);
   const unused=[...new Set((e.attachments||[]).map(a=>a.sha256))].filter(sha=>!fileUsedSync(sha,'epics',e.id));
   return {id:e.id,project:e.project,detached,unused};
  },{epics:[input.id],tickets:keyOfEpic(input.id)+'-'},{durable:true});
 }
 async function assignEpic(id,input,by){
  if(typeof id!=='string'||!EPIC_ID.test(id))fail('not-found');
  if(!writeInput(input,['tickets'])||!Array.isArray(input.tickets)||!input.tickets.length||input.tickets.length>LIMITS.assign)fail('invalid');
  const items=input.tickets.map(x=>onlyKeys(x,['id','rev'])&&typeof x.id==='string'&&TICKET_ID.test(x.id)&&validRev(x.rev)?{id:x.id,rev:x.rev}:fail('invalid'));
  if(new Set(items.map(x=>x.id)).size!==items.length)fail('invalid');
  return write((data,now)=>{
   const e=epicOf(data,id),changed=assignTickets(data,e,items,by,now);
   return {epic:epicSummary(e),tickets:changed.map(summary)};
  },{epics:[id],tickets:items.map(x=>x.id)});
 }
 async function epicAttachment(id,attachmentId){const e=await getEpic(id);return e.attachments.find(a=>a.id===attachmentId)||fail('not-found');}
 const attachEpic=(id,file,by,options)=>attachTo('epics',id,file,by,options);
 const detachEpic=(input,by)=>detachFrom('epics',input,by);

 // Project lifecycle (server/project-lifecycle.mjs) ---------------------------------------------------
 // Synchronous steps for one db.changeCollections transaction with store; data is this store's selected data.
 // The caller checks scopes, previews and the other stores, and calls notify() after the commit.
 const UPGRADE_KEYS=['id','rev','type','labels','settings','renameWikiHome','epics'];
 // Validates an upgrade before the transaction and prepares the mention check of its epics' texts.
 async function prepareUpgrade(input){
  if(!onlyKeys(input,UPGRADE_KEYS)||typeof input.id!=='string'||!PROJECT_ID.test(input.id)||!validRev(input.rev))fail('invalid');
  if(input.renameWikiHome!==undefined&&typeof input.renameWikiHome!=='boolean')fail('invalid');
  if(!Array.isArray(input.epics)||input.epics.length>LIMITS.upgradeEpics)fail('invalid');
  const {epics,...rest}=input;
  if(Buffer.byteLength(JSON.stringify(rest))>TICKET_BODY_LIMIT)fail('invalid');
  const type='type'in input?nullable(input.type,v=>oneOf(v,PROJECT_TYPES)):undefined,labelList='labels'in input?labels(input.labels):undefined;
  const settings='settings'in input?settingsPatch(input.settings):{};
  const seen=new Set(),plan=epics.map(x=>{
   if(!epicInput(x,['title','description','spec','ticketIds'])||!('title'in x))fail('invalid');
   const ids=x.ticketIds===undefined?[]:Array.isArray(x.ticketIds)?x.ticketIds:fail('invalid');
   for(const id of ids){if(typeof id!=='string'||!TICKET_ID.test(id)||seen.has(id))fail('invalid');seen.add(id);}
   const {ticketIds,...f}=x;return {fields:epicFields(f,null,{releases:[]}),ticketIds:ids};
  });
  if(seen.size>LIMITS.assign)fail('invalid');
  const validate=await guardTexts(plan.flatMap(x=>[x.fields.description,x.fields.spec]));
  return {id:input.id,rev:input.rev,type,labels:labelList,settings,renameWikiHome:input.renameWikiHome===true,plan,validate};
 }
 // Applies a prepared upgrade (data: the project, its tickets and epics). projectVersion moves 1 → 2 once.
 function upgrade(data,prepared,by,now,count){
  const p=data.projects.find(x=>x.id===prepared.id)||fail('not-found');
  if(p.rev!==prepared.rev||projectVersionOf(p)!==1)fail('conflict');
  prepared.validate(p.id);
  if(prepared.type!==undefined)p.type=prepared.type;
  p.labels=prepared.labels??(Array.isArray(p.labels)?p.labels:[]);
  p.settings={...projectSettings(p.settings),...prepared.settings};
  const counter=count??(()=>data.epics.length);
  if(counter('epics')+prepared.plan.length>LIMITS.epics)fail('limit');
  // Every ticket is checked before any is moved; the plan's ids are distinct.
  // An id that is not one of this project's tickets is invalid, whether it is missing or another project's.
  for(const {ticketIds} of prepared.plan)for(const id of ticketIds){const t=data.tickets.find(x=>x.id===id);if(!t||t.project!==p.id)fail('invalid');}
  const epics=[],tickets=[];
  for(const {fields:f,ticketIds} of prepared.plan){
   const e=addEpic(data,p,f,by,now,()=>0);epics.push(e);
   tickets.push(...assignTickets(data,e,ticketIds.map(id=>({id})),by,now).map(t=>t.id));
  }
  p.projectVersion=2;p.updatedAt=now;p.rev++;
  return {project:publicProject(p),epics:epics.map(e=>epicOut(e)),tickets};
 }
 // What a project holds in this store, and a digest of it (ids and revs) for a deletion preview to compare.
 function footprint(data,projectId){
  const p=data.projects.find(x=>x.id===projectId)||fail('not-found');
  const mine=x=>x.project===p.id,epics=data.epics.filter(mine),tickets=data.tickets.filter(mine),releases=data.releases.filter(mine);
  const recordVersion=record=>[record.rev,record.updatedAt,record.comments?.at(-1)?.id,record.attachments?.map(file=>file.id)];
  const lines=[
   ['project',p.id,p.rev],
   ...epics.map(e=>['epic',e.id,...recordVersion(e)]),
   ...tickets.map(t=>['ticket',t.id,...recordVersion(t)]),
   ...releases.map(r=>['release',r.version,r.rev]),
  ].map(row=>JSON.stringify(row)).sort();
  return {project:publicProject(p),counts:{epics:epics.length,tickets:tickets.length,releases:releases.length},digest:createHash('sha256').update(lines.join('\n')).digest('hex')};
 }
 // Removes the project row with its epics, tickets and releases from data (their search entries go with the rows).
 // Returns the counts, the ids, and cleanup(): after a durable commit, removes the attachment files that no
 // remaining ticket or epic names.
 function remove(data,project,by,now){
  const id=typeof project==='string'?project:project?.id;
  const p=data.projects.find(x=>x.id===id)||fail('not-found');
  const mine=x=>x.project===p.id,epics=data.epics.filter(mine),tickets=data.tickets.filter(mine),releases=data.releases.filter(mine);
  // A detached document may still link to this key's old ticket or epic IDs.
  if(p.next>1||p.nextEpic>1){
   data.retiredKeys??={};
   data.retiredKeys[p.key]={next:p.next??1,nextEpic:p.nextEpic??1};
  }
  data.projects=data.projects.filter(x=>x!==p);data.epics=data.epics.filter(x=>!mine(x));data.tickets=data.tickets.filter(x=>!mine(x));data.releases=data.releases.filter(x=>!mine(x));
  const shas=[...new Set([...epics,...tickets].flatMap(x=>(x.attachments||[]).map(a=>a.sha256)))];
  return {project:publicProject(p),counts:{epics:epics.length,tickets:tickets.length,releases:releases.length},
   epicIds:epics.map(e=>e.id),ticketIds:tickets.map(t=>t.id),files:shas,
   async cleanup(){const removed=[];if(!blobs)return removed;for(const sha of shas)if(await blobs.remove(sha,fileInUse))removed.push(sha);return removed;}};
 }
 // Standalone upgrade with the tracker alone (no wiki rename): the same steps in one transaction of this store.
 async function upgradeProject(input,by){
  const prepared=await prepareUpgrade(input),p=await store.get('projects',prepared.id);if(!p)fail('not-found');
  return write((data,now,count)=>{
   if(data.projects[0]?.key!==p.key)fail('conflict');
   return upgrade(data,prepared,by,now,count);
  },projectSelection(p));
 }
 const stamped=(data,now,out)=>{data.revision++;data.updatedAt=now;return out;};
 const lifecycle={store,selection:projectSelection,
  save:(data,input,by,now)=>stamped(data,now,applyProject(data,prepareProject(input),by,now)),
  upgrade:(data,prepared,by,now,count)=>stamped(data,now,upgrade(data,prepared,by,now,count)),
  remove:(data,project,by,now)=>stamped(data,now,remove(data,project,by,now)),
  prepareProject,prepareUpgrade,footprint,notify,fileInUse};

 return {version:store.version,searchSnapshot:async()=>({revision:searchRevision,tickets:await store.list('tickets')}),searchRevision:()=>searchRevision,onSearchChange:fn=>{searchListeners.add(fn);return ()=>searchListeners.delete(fn);},validateSearchFilters:filter=>ticketFilter(filter),
  list,projects,get,search,people,create,update,comment,saveRelease,saveProject,upgradeProject,attach,detach,attachment,fileInUse,
  listEpics,getEpic,createEpic,updateEpic,commentEpic,deleteEpic,assignEpic,attachEpic,detachEpic,epicAttachment,
  referenceSummaries,epicSummaries,findMentionUsages,hasProjectSync,ticketProjectSync,epicProjectSync,lifecycle};
}
