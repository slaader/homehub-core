// Core module "tracker": projects, releases, tickets with attachments, and the full-text search over
// tickets and review sets. Projects are created in the UI (or seeded once from site.json → tracker.projects).
import path from 'node:path';
import {createTicketSearch} from '../ticket-search.mjs';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {createTicketStore,ticketAuthors,TICKET_ID,TICKET_TYPES,TICKET_STATUSES,TICKET_PRIORITIES,RELEASE_STATUSES,PROJECT_TYPES,PROJECT_COLORS,PROJECT_VIEWS,TICKET_ATTACHMENTS} from '../tickets-store.mjs';
import {authoredProvenance} from '../provenance.mjs';
import {createTicketFiles,cleanName,inline as inlineFile,FILE_LIMITS} from '../ticket-files.mjs';
import {byteRange} from '../http-range.mjs';
import {toolError} from '../tool-error.mjs';

// Messages come in two languages: Czech source text for the web UI (which translates it through its
// dictionary, like every other string) and English for an API key, i.e. a script or an agent. An optional
// third string gives the MCP tool refusal phrasing; otherwise MCP shares the English API message.
const TICKET_MESSAGES={
 'unavailable-reference':['Reference neexistuje nebo není dostupná v tomto projektu.','A reference is missing or unavailable in this project.'],
 'too-large':['Soubor je příliš velký (nejvýš 100 MB).','The file is too large (100 MB at most).'],
 invalid:['Neplatný požadavek na ticket (zkontroluj pole, projekt a release).','Invalid ticket request (check the fields, the project and the release).','Invalid ticket request: check the field values, that the project exists and that the release exists in that project.'],
 'not-found':['Ticket neexistuje.','The ticket does not exist.','No such ticket or release. Use tickets_list to find the right id.'],
 conflict:['Záznam se mezitím změnil nebo už existuje. Načti ho znovu a změnu zopakuj.','The record changed in the meantime or already exists. Read it again and repeat the change.','It changed since you read it (or already exists). Read it again (ticket_get / tickets_list), then reapply your change with the new rev.'],
 limit:['Byl dosažen limit počtu záznamů.','The record limit has been reached.','A ticket limit was reached; nothing was changed.'],
 unavailable:['Tickety teď nejdou načíst ani uložit.','Tickets cannot be loaded or saved right now.','Tickets are not available right now. Read the target before retrying a write; a previous attempt may have succeeded.'],
};
const TICKET_MCP_CODES=new Set(['unavailable-reference','invalid','not-found','conflict','limit']);
async function runTickets(state,fn){
 if(!state?.tickets)throw toolError('Tickets are not available on this Home Hub.');
 try{return await fn(state.tickets);}
 catch(e){
  if(e?.toolError===true)throw e;
  const row=TICKET_MCP_CODES.has(e.message)?TICKET_MESSAGES[e.message]:TICKET_MESSAGES.unavailable;
  throw toolError(row[2]??row[1]);
 }
}
const SEARCH_MESSAGES={
 invalid:['Neplatné hledání (nejvýš 200 znaků, kind ticket|review, limit 1–100).','Invalid search (200 characters at most, kind ticket|review, limit 1-100).'],
 unavailable:['Hledání teď nejde.','Search is unavailable right now.'],
};
const say=(pair,c)=>pair[c?.principal?.authKind==='api-key'?1:0];
const ticketsError=(e,c)=>[({'too-large':413,'unavailable-reference':400,invalid:400,'not-found':404,conflict:409,limit:409})[e.message]||503,'TICKETS_FAILED',say(TICKET_MESSAGES[e.message]||TICKET_MESSAGES.unavailable,c)];
const searchError=(e,c)=>[e.message==='invalid'?400:503,'SEARCH_FAILED',say(SEARCH_MESSAGES[e.message]||SEARCH_MESSAGES.unavailable,c)];
// Provenance (server/provenance.mjs): who made and changed the records, people or service accounts, read from
// the records themselves. The list counts projects, releases and items together (unit records); projects the
// site configuration seeded count as configuration (unit projects).
const SEEDED='site.json → tracker.projects';
async function listed(c){
 const {authors,...data}=await c.state.tickets.list(c.query,{authors:true});
 return {...data,provenance:authoredProvenance(c.hub.accessStore,authors,{unit:'records',extra:authors.seeded?[{kind:'config',source:SEEDED,count:authors.seeded,unit:'projects'}]:[]})};
}
// A full ticket (it has its history) gets the same for itself; a release or a project passes through.
const withProvenance=(c,ticket)=>ticket&&Array.isArray(ticket.history)?{...ticket,provenance:authoredProvenance(c.hub.accessStore,ticketAuthors(ticket))}:ticket;
// The write log names what a write touched; a failed write names nothing (never rejected argument text).
const write=(path,status,run)=>({method:'POST',path,scope:'tickets:write',error:ticketsError,async handler(c){c.subject=null;const saved=await run(c);c.subject=saved.subject;return c.json(typeof status==='function'?status(c):status,withProvenance(c,saved.body));}});
const who=c=>c.principal.username;
// Names the assignee field offers: sign-in accounts and service accounts that are not disabled, then every
// name the tickets already carry. Only names and counts leave the server, never ids, roles or scopes.
async function people({state,hub}){
 const out=new Map(),add=(name,kind)=>{if(typeof name==='string'&&name&&!out.has(name))out.set(name,{name,kind,assigned:0,active:0});};
 try{for(const u of hub.accessStore?.users?.()||[])if(!u.disabled)add(u.username,'user');}catch{}
 try{for(const a of hub.accessStore?.accounts?.()||[])if(!a.disabled)add(a.name,'agent');}catch{}
 for(const p of await state.tickets.people()){add(p.name,'other');Object.assign(out.get(p.name),{assigned:p.assigned,active:p.active});}
 return [...out.values()].sort((a,b)=>b.active-a.active||b.assigned-a.assigned||a.name.localeCompare(b.name,'en')).slice(0,200);
}
// What a search hit is right now (a ticket's status, a review set's state), so a result list can show it
// without one request per hit. The index itself only knows the text.
async function describeHits(results,{state,hub}){
 if(!results.length)return results;
 const missingTicketIds=[...new Set(results.filter(r=>r.kind==='ticket'&&!r.meta).map(r=>r.id))];
 const tickets=new Map();
 if(missingTicketIds.length){
  const loaded=await Promise.all(missingTicketIds.map(id=>state.tickets.get(id).catch(()=>null)));
  for(const t of loaded)if(t)tickets.set(t.id,t);
 }
 let sets=new Map();
 if(results.some(r=>r.kind==='review'&&!r.meta))try{sets=new Map((await hub.state('review').review.list({status:'all'})).sets.map(s=>[s.id,s]));}catch{}
 return results.map(r=>{
  if(r.meta)return r;
  const t=r.kind==='ticket'?tickets.get(r.id):null,s=r.kind==='review'?sets.get(r.id):null;
  return {...r,...(t?{meta:{status:t.status,type:t.type,priority:t.priority,assignee:t.assignee,release:t.release}}:{}),
   ...(s?{meta:{status:s.status,done:s.done,feedbackPending:s.feedbackPending,round:s.round.n,items:s.round.items,decided:s.round.decided}}:{})};
 });
}
const SEARCH_ARGS=['query','project','status','type','priority','release','assignee','label','limit'];
const TICKET_PROPS={
 title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:12000,description:'What and why: steps to reproduce, acceptance criteria, notes. Shown as light Markdown (lists, **bold**, `code`, ``` fences, links); ticket ids such as APP-12 become links.'},
 type:{type:'string',enum:[...TICKET_TYPES]},status:{type:'string',enum:[...TICKET_STATUSES]},priority:{type:'string',enum:[...TICKET_PRIORITIES]},
 release:{type:['string','null'],maxLength:40,description:'Version of an existing release in the project, or null for unplanned.'},
 assignee:{type:['string','null'],maxLength:60,description:'Who works on it: the name of a user or service account of this hub (free text is accepted); null for nobody. The word none is reserved for filtering.'},
 labels:{type:'array',maxItems:10,items:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,29}$'},description:'Lowercase tags (a-z, 0-9, hyphen), e.g. ui, api, docs.'},
 refs:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:300},description:'Commits, pull-request links, related ticket ids.'}};

export default {
 id:'tracker',title:'Project Tracker',
 mcpInstructions:[
  'Tracker: projects_list, tickets_list, ticket_get. ticket_search finds words; ticket_hybrid_search includes attachments (ticket_search_status: coverage). search includes reviews. ticket_attachment_get reads files.',
  {scope:'tickets:write',text:'With tickets:write: project_save then ticket_create. ticket_update uses the returned rev; ticket_comment appends. release_save/project_save: omit rev to create. ticket_attachment_put: up to 32 KiB; larger files use HTTP.'},
 ],
 assets:['tracker-view.js','tracker-md.js','tracker-attach.js','search-view.js','platform-settings-view.js','tickets.css','i18n-en-tracker.js'],
 nav:[
  {group:'Project Tracker',hash:'projects',labelKey:'Projekty',view:'tracker-view.js#trackerPage',order:40},
  {group:'Project Tracker',hash:'items',labelKey:'Otevřené položky',view:'tracker-view.js#trackerPage',order:41},
  {group:'Project Tracker',hash:'releases',labelKey:'Releasy',view:'tracker-view.js#trackerPage',order:42},
  {groupKey:'Správa',hash:'platform-settings',labelKey:'Nastavení platformy',view:'platform-settings-view.js#platformSettingsPage',admin:true,order:49},
  {hash:'search',label:'Search',view:'search-view.js#searchPage',hidden:true},
 ],
 setup(hub){
  const dir=path.join(hub.stateDirectory,'tickets');
  const tickets=createTicketStore(dir,{db:hub.db,seedProjects:hub.site.tracker.projects,mentionGuard:refs=>hub.state('references').prepareMentionGuard(refs)}),ticketFiles=createTicketFiles(dir);
  const ticketSearch=createTicketSearch(dir,{db:hub.db,tickets,ticketFiles,...hub.options.ticketSearch});
  return {tickets,ticketFiles,ticketSearch};
 },
 pollers:[{id:'ticket-search',start:state=>state.ticketSearch.start(),stop:state=>state.ticketSearch.close()}],
 routes:[
  {method:'GET',path:'/api/admin/platform/search',scope:null,error:ticketsError,handler:async c=>c.json(200,await c.state.ticketSearch.settings())},
  {method:'POST',path:'/api/admin/platform/search',scope:null,error:ticketsError,handler:async c=>c.json(200,await c.state.ticketSearch.setEnabled(c.input))},
  // Ticket attachments: the raw file in one request (at most 100 MiB); the name comes in the query.
  {method:'PUT',match:/^\/api\/tickets\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5})\/attachments$/,scope:'tickets:write',raw:true,contentType:'application/octet-stream',error:ticketsError,
   async handler(c){const {tickets,ticketFiles}=c.state,id=c.params[1];
    // A ticket that is full (or is not there) refuses before the file is stored: a file no ticket points at would
    // stay on the disk. The rest of the upload is still read, up to the size limit: an answer sent under a client
    // that is still sending reaches many of them as a broken connection, not as the 409 or 404 it is.
    try{if((await tickets.get(id)).attachments.length>=TICKET_ATTACHMENTS)throw new Error('limit');}
    catch(e){let read=0;try{for await(const chunk of c.req){read+=chunk.length;if(read>FILE_LIMITS.file)break;}}catch{}throw e;}
    const file=await ticketFiles.put(c.req,{name:c.url.searchParams.get('name'),declaredLength:Number(c.req.headers['content-length'])});
    c.subject=id;return c.json(201,withProvenance(c,await tickets.attach(id,file,who(c))));}},
  write('/api/tickets',201,async c=>{const ticket=await c.state.tickets.create(c.input,who(c));return {subject:ticket.id,body:ticket};}),
  write('/api/tickets/update',200,async c=>{const saved=await c.state.tickets.update(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  write('/api/tickets/comment',200,async c=>{const saved=await c.state.tickets.comment(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  write('/api/tickets/releases',200,async c=>{const saved=await c.state.tickets.saveRelease(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  write('/api/tickets/attachments/delete',200,async c=>{const out=await c.state.tickets.detach(c.input,who(c));if(!out.used)await c.state.ticketFiles.remove(out.removed.sha256);return {subject:out.ticket.id,body:out.ticket};}),
  write('/api/tickets/projects',c=>c.input?.rev===undefined?201:200,async c=>{const saved=await c.state.tickets.saveProject(c.input,who(c));return {subject:saved.id||saved.project,body:saved};}),
  {method:'GET',path:'/api/tickets',error:ticketsError,handler:async c=>c.json(200,await listed(c))},
  // Full-text search inside tickets with the list's field filters (status, assignee, label, release, …).
  {method:'GET',path:'/api/tickets/search',error:ticketsError,handler:async c=>c.json(200,await c.state.tickets.search(c.query))},
  {method:'GET',path:'/api/tickets/people',error:ticketsError,handler:async c=>c.json(200,{people:await people(c)})},
  {method:'GET',path:'/api/tickets/search/hybrid',error:ticketsError,handler:async c=>c.json(200,await c.state.ticketSearch.search({...c.query,...(c.query.minScore===undefined?{}:{minScore:c.query.minScore.trim()===''?NaN:Number(c.query.minScore)})}))},
  {method:'GET',path:'/api/tickets/search/status',error:ticketsError,handler:c=>{if(Object.keys(c.query).length)throw new Error('invalid');return c.json(200,c.state.ticketSearch.status());}},
  // An attachment: images, plain text, audio and video inline, everything else as a download; always sandboxed and
  // nosniff. One byte range per request (a player seeks with them); anything else in Range is a 416.
  {method:'GET',match:/^\/api\/tickets\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5})\/attachments\/([0-9a-f-]{36})$/,error:ticketsError,async handler({params,url,req,res,state,error}){
    const a=await state.tickets.attachment(params[1],params[2]),f=await state.ticketFiles.read(a.sha256),show=inlineFile(a.type)&&url.searchParams.get('download')!=='1';let range;
    try{range=byteRange(req.headers.range,f.size);}catch{res.setHeader('Content-Range',`bytes */${f.size}`);return error(416,'INVALID_RANGE','Invalid attachment range.');}
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'");res.setHeader('Cache-Control','private, max-age=31536000, immutable');
    res.writeHead(range.status,{'Content-Type':a.type==='text/plain'?'text/plain; charset=utf-8':show?a.type:'application/octet-stream','Accept-Ranges':'bytes','Content-Length':range.end-range.start+1,
     ...(range.status===206?{'Content-Range':`bytes ${range.start}-${range.end}/${f.size}`}:{}),
     'Content-Disposition':`${show?'inline':'attachment'}; filename="${a.name.replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(a.name)}`});
    try{await pipeline(createReadStream(f.path,{start:range.start,end:range.end}),res);}catch{res.destroy();}}},
  {method:'GET',match:/^\/api\/tickets\/(.*)$/,error:ticketsError,async handler(c){const {params,json,state}=c;if(!TICKET_ID.test(params[1]))throw new Error('not-found');return json(200,withProvenance(c,await state.tickets.get(params[1])));}},
  // Full-text search over tickets and review sets (title, description, comments, notes); plain words, diacritics ignored.
  // `indexed` counts what the index holds per kind (0 everywhere = nothing to search yet); each hit carries `meta`.
  {method:'GET',path:'/api/search',error:searchError,async handler(c){const {query,json,hub}=c;if(Object.keys(query).some(k=>!['q','kind','project','limit','mode'].includes(k)))throw new Error('invalid');
    const found=await c.state.ticketSearch.searchAll({...query,limit:query.limit===undefined?20:query.limit});
    return json(200,{...found,results:await describeHits(found.results,c),indexed:hub.db.searchStats()});}},
 ],
 mcpTools:[
  {name:'projects_list',scope:'read',title:'Tickets: list projects',
   description:'List project ids, ticket prefixes, names, descriptions, types, settings and revs without loading tickets or releases. Use this to find a project or its rev for project_save; use tickets_list for tickets and releases.',
   inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
   run:(_args,{state})=>runTickets(state,t=>t.projects()).then(projects=>({projects}))},
  {name:'tickets_list',scope:'read',title:'Tickets: list',
   description:'List tickets with field filters, plus every project and release (releases carry per-status ticket counts over all their tickets). Sorted by status, then priority, then latest change; total is the number of matches before limit. Tickets come without comment text, history or attachments (comments and attachments are counts); use ticket_get for the full record and its rev, and ticket_search to look for words in comments too.',
   inputSchema:{type:'object',properties:{
    project:{type:'string',maxLength:40,description:'Project id as listed in projects, e.g. my-app.'},
    status:{type:'string',maxLength:60,description:'open, in-progress, done, cancelled, or "active" (open + in-progress); comma-separated for several.'},
    type:{type:'string',enum:[...TICKET_TYPES]},priority:{type:'string',enum:[...TICKET_PRIORITIES]},
    release:{type:'string',maxLength:40,description:'Release version, or "none" for unplanned tickets.'},
    assignee:{type:'string',maxLength:60,description:'Assignee name, or "none".'},label:{type:'string',maxLength:30},
    query:{type:'string',maxLength:100,description:'Text contained in the id, title, description or a label (case-insensitive substring).'},
    limit:{type:'integer',minimum:1,maximum:200,description:'Maximum tickets (default 50).'}},additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   async run({query,limit=50,...args},{state}){
    if(!Number.isInteger(limit)||limit<1||limit>200||'q'in args)throw toolError('Invalid ticket filters: limit must be an integer from 1 to 200; use query for text search.');
    const data=await runTickets(state,t=>t.list({...args,...(query!==undefined?{q:query}:{}),limit}));
    return {...data,releases:data.releases.map(({createdBy,createdAt,...r})=>r)};
   }},
  {name:'ticket_get',scope:'read',title:'Tickets: read one',
   description:'Read one ticket in full: description, comments, attachments (metadata), change history and rev (needed for ticket_update).',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source,description:'Ticket id: the project key, a hyphen and a number, e.g. APP-12.'}},required:['id'],additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   run:(args,{state})=>{if(Object.keys(args).some(k=>k!=='id'))throw toolError('Invalid ticket request.');return runTickets(state,t=>t.get(args.id));}},
  {name:'ticket_create',scope:'tickets:write',title:'Tickets: create',
   description:'File a new ticket in an existing project (create the project first with project_save). Defaults: type task, status open, priority normal. A release must already exist in that project (see tickets_list → releases, or create it with release_save). Returns the new ticket with its id and rev.',
   inputSchema:{type:'object',properties:{...TICKET_PROPS,project:{type:'string',maxLength:40,description:'Project id as listed by tickets_list → projects, e.g. my-app.'}},required:['project','title'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state,principal})=>runTickets(state,t=>t.create(args,principal.username))},
  {name:'ticket_update',scope:'tickets:write',title:'Tickets: change fields',
   description:'Change fields of a ticket (status, release, assignee, …). Pass only the fields to change and the rev from ticket_get; if the ticket changed in between, the update is refused and you must read it again. Pass null to clear release or assignee. Every change is recorded in the ticket history.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source},rev:{type:'integer',minimum:1,description:'rev from ticket_get.'},...TICKET_PROPS},required:['id','rev'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state,principal})=>runTickets(state,t=>t.update(args,principal.username))},
  {name:'ticket_comment',scope:'tickets:write',title:'Tickets: add comment',
   description:'Add a comment to a ticket, e.g. what was done, the commit or a finding (light Markdown, as in the description). Comments need no rev and cannot be edited or removed.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source},text:{type:'string',minLength:1,maxLength:8000}},required:['id','text'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state,principal})=>runTickets(state,t=>t.comment(args,principal.username))},
  {name:'release_save',scope:'tickets:write',title:'Tickets: create or change a release',
   description:'Create a release (a version tickets can be planned into) in a project, or change one. Omit rev to create; to change an existing release pass the rev shown in tickets_list → releases. Setting status "released" stamps today as releasedAt unless you pass one; "planned" clears it. Dates are YYYY-MM-DD.',
   inputSchema:{type:'object',properties:{project:{type:'string',maxLength:40},version:{type:'string',pattern:'^(?!none$)[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$',description:'e.g. 2.4 or v0.5.0.'},
    status:{type:'string',enum:[...RELEASE_STATUSES]},targetDate:{type:['string','null'],pattern:'^\\d{4}-\\d{2}-\\d{2}$'},releasedAt:{type:['string','null'],pattern:'^\\d{4}-\\d{2}-\\d{2}$'},notes:{type:'string',maxLength:2000},rev:{type:'integer',minimum:1}},required:['project','version'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state,principal})=>runTickets(state,t=>t.saveRelease(args,principal.username))},
  {name:'project_save',scope:'tickets:write',title:'Tickets: create or change a project',
   description:'Create a project (id, key, name, type) or change the name, description, type or settings of an existing one. The key is the ticket prefix (key APP → tickets APP-1, APP-2, …); id and key can never change, and both must be unused. Omit rev to create; to change a project pass the rev shown in projects_list. settings is partial: pass only the fields to change, the others keep their values. releases, reviews and wiki only show or hide those parts of the project pages; globalReferences:false limits reference suggestions in the project to its own sources, machines and projects.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:'^[a-z][a-z0-9-]{1,39}$',description:'Lowercase id used in URLs and filters, e.g. my-app.'},key:{type:'string',pattern:'^[A-Z][A-Z0-9]{1,9}$',description:'Ticket prefix: 2-10 capital letters or digits, e.g. APP. Required when creating.'},
    name:{type:'string',minLength:1,maxLength:80},description:{type:'string',maxLength:500},type:{type:['string','null'],enum:[...PROJECT_TYPES,null],description:'app, game or other; decides which kind of review variants a set opens on.'},
    settings:{type:'object',description:'Fields to change; omitted fields keep their values. Defaults: color null, view board, the rest true.',properties:{
     color:{type:['string','null'],enum:[...PROJECT_COLORS,null],description:'Named project color, or null for none.'},view:{type:'string',enum:[...PROJECT_VIEWS],description:'How the project page lists its tickets.'},
     releases:{type:'boolean'},reviews:{type:'boolean'},wiki:{type:'boolean'},globalReferences:{type:'boolean',description:'Offer global references and other projects\' shared sources in suggestions.'}},additionalProperties:false},
    rev:{type:'integer',minimum:1}},required:['id'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state,principal})=>runTickets(state,t=>t.saveProject(args,principal.username))},
  {name:'ticket_attachment_get',scope:'read',title:'Tickets: read an attachment',
   description:'Read a file attached to a ticket (ids come from ticket_get → attachments). Images up to 5 MB come back as an image, plain-text files up to 256 kB as text; anything else returns only its metadata and download path. In a ticket description or comment, ![name] points at the attachment with that name.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source,description:'Ticket id, e.g. APP-12.'},attachment:{type:'string',pattern:'^[0-9a-f-]{36}$'}},required:['id','attachment'],additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   async run({id,attachment,...rest},{state}){
    if(Object.keys(rest).length)throw toolError('Invalid attachment request.');
    const a=await runTickets(state,t=>t.attachment(id,attachment));if(!state.ticketFiles)throw toolError('Attachments are not available on this Home Hub.');
    const meta={id:a.id,ticket:id,name:a.name,type:a.type,size:a.size,by:a.by,at:a.at,url:`/api/tickets/${id}/attachments/${a.id}`};
    let f;try{f=await state.ticketFiles.read(a.sha256);}catch{throw toolError('The attachment file is missing on the server.');}
    if(a.type.startsWith('image/')&&f.size<=5*1024*1024)return {mcpContent:[{type:'text',text:JSON.stringify(meta)},{type:'image',data:(await readFile(f.path)).toString('base64'),mimeType:a.type}],meta};
    if(a.type==='text/plain'&&f.size<=256*1024)return {mcpContent:[{type:'text',text:JSON.stringify(meta)},{type:'text',text:await readFile(f.path,'utf8')}],meta};
    return {...meta,note:'Binary or large file: only metadata is returned. Download it from url with a session or API key.'};
   }},
  {name:'ticket_attachment_put',scope:'tickets:write',title:'Tickets: attach a small file',
   description:'Attach up to 32 KiB of file bytes, encoded as canonical base64, to an existing ticket. The server detects the type from bytes; no server-local paths or remote URLs. If these bytes are already attached, returns the existing ticket without duplication (even if the file name differs). Returns the full saved ticket; use its stored attachment name. For larger files stream PUT /api/tickets/<ID>/attachments?name=<name> (up to 100 MiB), or use scripts/ticket-push.mjs. Never generate base64 for a large file in conversation.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:TICKET_ID.source},name:{type:'string',minLength:1,maxLength:120},data:{type:'string',minLength:4,maxLength:43692,description:'Canonical padded base64 for 1..32768 file bytes.'}},required:['id','name','data'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
   async run({id,name,data},{state,principal}){
    if(typeof name!=='string'||!name.trim()||name.length>120||typeof data!=='string'||!data.length||data.length>43692)throw toolError('Use a file name and canonical base64 for 1-32768 bytes; stream larger files with PUT /api/tickets/<ID>/attachments?name=<name>.');
    const bytes=Buffer.from(data,'base64');
    if(!bytes.length||bytes.length>32768||bytes.toString('base64')!==data)throw toolError('data must be canonical padded base64 for 1-32768 bytes.');
    if(!state.ticketFiles)throw toolError('Attachments are not available on this Home Hub.');
    return runTickets(state,async t=>{
     const ticket=await t.get(id),own=cleanName(name);
     // A retry still succeeds when the ticket is full. Hashing here avoids an unnecessary blob write.
     const sha=createHash('sha256').update(bytes).digest('hex');
     if(ticket.attachments.some(a=>a.sha256===sha))return ticket;
     if(ticket.attachments.length>=TICKET_ATTACHMENTS)throw new Error('limit');
     const file=await state.ticketFiles.put([bytes],{name:own,declaredLength:bytes.length});
     return t.attach(id,file,principal.username,{deduplicate:true});
    });
   }},
  {name:'search',scope:'read',title:'Home Hub: full-text search',
   description:'Full-text search across tickets (id, title, description, comments, attachment metadata and supported UTF-8 contents, labels, refs, people) and review sets (title, description, round notes, item and variant texts, decisions and comments). Plain words, never query syntax: every word must match as a prefix; case and diacritics are ignored (resume finds Résumé). Best match first, a title hit above a body hit; matched words are wrapped in \\u0001…\\u0002 in title and snippet. Use ticket_get or review_get for the full record, and ticket_search to narrow tickets by status, assignee, label or release.',
   inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:200,description:'Up to 12 words.'},kind:{type:'string',enum:['ticket','review'],description:'Only tickets or only review sets.'},project:{type:'string',maxLength:40,description:'Project id.'},limit:{type:'integer',minimum:1,maximum:100,description:'Maximum results (default 20).'}},required:['query'],additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   async run({query,kind,project,limit=20,...rest},{state}){
    if(!state?.ticketSearch)throw toolError('Search is not available on this Home Hub.');
    if(Object.keys(rest).length)throw toolError('Invalid search: use query, kind, project, limit.');
    try{return await state.ticketSearch.searchAll({q:query,kind,project,limit});}catch{throw toolError('Invalid search: query is 1-200 characters, kind ticket|review, limit 1-100.');}
   }},
  {name:'ticket_search_status',scope:'read',description:'Ticket search readiness, semantic availability and attachment content coverage.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},run(args,{state}){if(Object.keys(args).length)throw toolError('Invalid ticket search status request.');return state.ticketSearch.status();}},
  {name:'ticket_hybrid_search',scope:'read',description:'Search ticket text and attachment metadata and complete bounded UTF-8 text. Full-text mode is the default; optional hybrid/semantic modes require administrator opt-in and a configured provider. Returns source citations and explicit readiness/coverage.',
   inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:200},project:{type:'string'},status:{type:'string'},type:{type:'string'},priority:{type:'string'},release:{type:'string'},assignee:{type:'string'},label:{type:'string'},limit:{type:'integer',minimum:1,maximum:100},mode:{enum:['text','hybrid','semantic'],default:'text'},minScore:{type:'number',minimum:0,maximum:1}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false},
   async run(args,{state}){try{if(args.limit!==undefined&&!Number.isInteger(args.limit))throw new Error('invalid');return await state.ticketSearch.search(args);}catch(e){throw toolError(e.message==='invalid'?'Invalid ticket hybrid search request.':'Ticket search unavailable.');}}},
  {name:'ticket_search',scope:'read',title:'Tickets: full-text search with filters',
   description:'Find tickets by words in their title, description, comments, attachment names, labels, refs or people, narrowed by the same field filters as tickets_list. Plain words, never query syntax: every word must match as a prefix, and case and diacritics are ignored. Best match first. Each ticket comes as in tickets_list plus snippet, the matching text with the matched words wrapped in \\u0001…\\u0002. Use tickets_list when you only filter by fields, and search to look in review sets too.',
   inputSchema:{type:'object',properties:{
    query:{type:'string',minLength:1,maxLength:200,description:'Words to look for, e.g. "login timeout".'},
    project:{type:'string',maxLength:40,description:'Project id.'},
    status:{type:'string',maxLength:60,description:'open, in-progress, done, cancelled, or "active" (open + in-progress); comma-separated for several.'},
    type:{type:'string',enum:[...TICKET_TYPES]},priority:{type:'string',enum:[...TICKET_PRIORITIES]},
    release:{type:'string',maxLength:40,description:'Release version, or "none" for tickets without a release.'},
    assignee:{type:'string',maxLength:60,description:'Assignee name, or "none" for unassigned tickets.'},
    label:{type:'string',maxLength:30},
    limit:{type:'integer',minimum:1,maximum:100,description:'Maximum tickets (default 20).'}},required:['query'],additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   async run(args,{state}){
    if(Object.keys(args).some(k=>!SEARCH_ARGS.includes(k))||typeof args.query!=='string'||args.limit!==undefined&&!Number.isInteger(args.limit))throw toolError('Invalid ticket search: use query, project, status, type, priority, release, assignee, label and an integer limit.');
    const {query,...filter}=args;
    try{return await state.tickets.search({...filter,q:query});}
    catch(e){throw toolError(e.message==='invalid'?'Invalid ticket search: query needs at least one letter or digit (at most 200 characters), limit is 1-100, and the filters take the same values as tickets_list.':'Tickets are not available right now.');}
   }},
 ],
 // Rows for the API reference (Users and API); the first card of the same title already lists the basic routes.
 apiDocs:[
  {title:'Project Tracker',routes:[
   ['GET','/api/tickets/search/hybrid?query=&mode=text','read','Hybrid ticket and attachment text search with citations and coverage.'],
   ['GET','/api/tickets/search/status','read','Ticket search readiness and attachment extraction coverage.'],
   ['GET','/api/tickets/search?q=&status=&assignee=&label=&release=','read','Fulltext v ticketech (i komentáře) se stejnými filtry jako seznam.'],
   ['GET','/api/tickets/people','read','Jména pro pole Řeší: účty, servisní účty a lidé z ticketů.'],
   ['PUT','/api/tickets/<ID>/attachments?name=','tickets:write','Příloha ticketu: soubor jako application/octet-stream, nejvýš 100 MB.'],
   ['GET','/api/tickets/<ID>/attachments/<id>','read','Soubor přílohy; obrázky, text, zvuk a video přímo (i po částech přes Range), ostatní ke stažení.']]},
  {title:'Hledání',routes:[['GET','/api/search?q=&kind=ticket|review&project=&limit=','read','Fulltext přes tickety a review; slova jako předpony, bez diakritiky.']]},
 ],
};
