// Core module "review": sets of variants (HTML mockups, images, 3D models) an agent publishes for the
// owner to decide on, with content-addressed uploads (docs/review.md).
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createReviewStore,setAuthors,REVIEW_ID,REVIEW_KINDS,SHA,LIMITS as REVIEW_LIMITS} from '../review-store.mjs';
import {TICKET_ID} from '../tickets-store.mjs';
import {authoredProvenance} from '../provenance.mjs';
import {byteRange} from '../http-range.mjs';
import {toolError} from '../tool-error.mjs';

// Messages come in two languages: Czech source text for the web UI (which translates it through its
// dictionary, like every other string) and English for an API key, i.e. the push script or an agent.
// An optional third string gives the MCP tool refusal phrasing; otherwise MCP shares the English API message.
const REVIEW_MESSAGES={
 invalid:['Neplatný požadavek na review (zkontroluj pole, projekt, tikety a typy souborů).','Invalid review request (check the fields, the project, the tickets and the file types).','Invalid review request: check the fields, that the project exists, that the tickets belong to it, that each media type matches its item kind and that files look like their type.'],
 'missing-blob':['Některý soubor ještě není nahraný (nahraj ho přes PUT /api/review/blobs/<sha256> nebo scripts/review-push.mjs).','A file is not uploaded yet (upload it with PUT /api/review/blobs/<sha256> or scripts/review-push.mjs).','A referenced file is not uploaded yet. Upload it with scripts/review-push.mjs (or PUT /api/review/blobs/<sha256>), or pass small HTML inline.'],
 'digest-mismatch':['Nahraný soubor nesouhlasí se svým sha256; nahraj ho znovu od začátku.','The uploaded file does not match its sha256; upload it again from the start.'],
 'not-found':['Review neexistuje.','The review does not exist.','No such review set or round. Use review_list to find it.'],
 conflict:['Záznam se mezitím změnil (nebo už existuje novější kolo). Načti ho znovu a změnu zopakuj.','The record changed in the meantime (or a newer round exists). Read it again and repeat the change.','The set is archived, attached or changed; read it again with review_get.'],
 detached:['Sada je odpojená od smazaného projektu a je jen pro čtení. Přiřaď ji k projektu nebo ji smaž.','This review set is detached from a deleted project and is read-only. Reassign it to a project or delete it.','This review set is detached from a deleted project and is read-only. Use review_set_reassign or review_set_delete.'],
 limit:['Byl dosažen limit (počet záznamů nebo místo pro soubory).','A limit was reached (the number of records or the space for files).','A review limit was reached; nothing was changed.'],
 'too-large':['Soubor nebo jeho část je příliš velká.','The file or a part of it is too large.','An inline HTML mockup is too large (upload it as a file instead), or a .glb model is over 128 MiB.'],
 forbidden:['Upravit nebo smazat jde jen vlastní připomínku.','Only the author of a comment can edit or delete it.'],
 unavailable:['Review teď nejde načíst ani uložit.','Review cannot be loaded or saved right now.','Review is not available right now. Refetch before retrying a write; the previous attempt may have succeeded.'],
};
const REVIEW_MCP_CODES=new Set(['invalid','missing-blob','not-found','conflict','detached','limit','too-large']);
async function runReview(state,fn){
 if(!state?.review)throw toolError('Review is not available on this Home Hub.');
 try{return await fn(state.review);}
 catch(e){
  if(e?.toolError===true)throw e;
  const row=REVIEW_MCP_CODES.has(e.message)?REVIEW_MESSAGES[e.message]:REVIEW_MESSAGES.unavailable;
  throw toolError(row[2]??row[1]);
 }
}
const reviewError=(e,c)=>[({invalid:400,'missing-blob':400,'digest-mismatch':400,'not-found':404,forbidden:403,conflict:409,detached:409,limit:409,'too-large':413})[e.message]||503,'REVIEW_FAILED',
 (REVIEW_MESSAGES[e.message]||REVIEW_MESSAGES.unavailable)[c?.principal?.authKind==='api-key'?1:0]];
const who=c=>c.principal.username;
const write=(path,options,run)=>({method:'POST',path,scope:'review:write',error:reviewError,...options,async handler(c){c.subject=null;return run(c);}});

export default {
 id:'review',title:'Review',
 mcpInstructions:[
  'Review: review_list feedbackPending:true finds feedback; review_get reads decisions and comments.',
  {scope:'review:write',text:'With review:write: review_publish publishes individual assets or selected revisions with addresses; review_set_save links tickets via rev. Use choose for alternatives, approve for deliverables; inspect motion and listen.'},
 ],
 assets:['review-view.js','review-media.js','review-guidance.js','review.css','model-viewer.js','vendor/model-viewer.min.js','i18n-en-review.js'],
 nav:[{group:'Project Tracker',hash:'review',label:'Review',view:'review-view.js#reviewPage',order:43}],
 setup:hub=>({review:createReviewStore(path.join(hub.stateDirectory,'review'),{tickets:hub.state('tracker').tickets,db:hub.db})}),
 mcpTools:[
  {name:'review_list',scope:'read',title:'Review: list sets',
   description:'Review sets: variants (HTML mockups, images, 3D models, video and audio clips) published for a project so that a person can compare them and decide, with those decisions. Newest change first. Filter by project, detached, or ticket; feedbackPending:true returns only sets whose latest round has decisions or comments newer than that round, i.e. feedback waiting for the publisher. Use review_get for the content.',
   inputSchema:{type:'object',properties:{project:{type:'string',maxLength:40,description:'Project id.'},detached:{type:'boolean',description:'When true, list only detached sets whose project was deleted; when false, exclude detached sets.'},ticket:{type:'string',description:'Ticket id, or unlinked for sets needing repair.'},status:{type:'string',enum:['open','active','done','archived','all'],description:'open (default) = not archived; active = open and not yet decided; done = open with a variant taken for every item.'},feedbackPending:{type:'boolean'}},additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   run:({feedbackPending,...args},{state})=>runReview(state,r=>r.list({...args,...(feedbackPending?{feedback:'pending'}:{})}))},
  {name:'review_get',scope:'read',title:'Review: read one set',
   description:'One review set with one round (latest by default): items, their variants and media, and per item the decision: chosen variant, status (accept = take it as is; revise = take it and apply the comments; reject = none fits, propose new variants; pending = undecided) and comments. For an item with mode approve there is no chosen variant: approvals maps each variant to approved or changes (apply the comments on that variant), and status is accept when all are approved, revise when any has changes. An HTML comment anchor names the element (data-mock-id, CSS selector, the start of its outerHTML, document x/y in the mockup viewport); an image anchor is a point as 0..1 fractions; a video anchor (kind frame) is the time t in seconds plus a point as 0..1 fractions; an audio anchor (kind time) is the time t in seconds; a 3D model anchor (kind surface) is the hit point and its normal in the model\'s own coordinates (glTF, metres, Y up), the camera pose (theta/phi in radians, radius in metres, target, fov in degrees), and what was hit: node (glTF node path, root first, \" / \" separated), mesh and material names, plus the playing animation and its time if any. A decision\'s note and each comment may carry links and attachments (screenshots, with url); a reject explains in them what to redo. unaddressed lists comments of earlier rounds that no later round listed in addresses.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:REVIEW_ID.source,description:'Set id, e.g. R-3.'},round:{type:'integer',minimum:1,description:'Round number; the latest when omitted.'}},required:['id'],additionalProperties:false},
   annotations:{readOnlyHint:true,openWorldHint:false},
   async run({id,round,...rest},{state}){
    if(Object.keys(rest).length||round!==undefined&&!Number.isInteger(round))throw toolError('Invalid review request.');
    const s=await runReview(state,r=>r.get(id)),r=round===undefined?s.rounds[s.rounds.length-1]:s.rounds.find(x=>x.n===round);
    if(!r)throw toolError(`Set ${s.id} has rounds 1-${s.rounds.length}.`);
    const later=new Set(s.rounds.filter(x=>x.n>r.n).flatMap(x=>x.addresses)),answered=new Set(s.rounds.flatMap(x=>x.addresses));
    const items=r.items.map(i=>({...i,variants:i.variants.map(v=>({...v,media:v.media.map(m=>({...m,url:'/api/review/blobs/'+m.sha256,...(m.poster?{poster:{...m.poster,url:'/api/review/blobs/'+m.poster.sha256}}:{})}))})),
     decision:Object.hasOwn(r.feedback,i.id)?{...r.feedback[i.id],attachments:(r.feedback[i.id].attachments||[]).map(a=>({...a,url:'/api/review/blobs/'+a.sha256})),comments:r.feedback[i.id].comments.map(c=>({...c,...(c.attachments?{attachments:c.attachments.map(x=>({...x,url:'/api/review/blobs/'+x.sha256}))}:{}),addressed:later.has(c.id)}))}:{rev:0,variant:null,status:'pending',note:'',comments:[],attachments:[]}}));
    const unaddressed=s.rounds.filter(x=>x.n<r.n).flatMap(x=>Object.entries(x.feedback).flatMap(([item,d])=>d.comments.filter(c=>!answered.has(c.id)).map(c=>({round:x.n,item,...c}))));
    return {id:s.id,rev:s.rev,project:s.project,detached:s.project===null,...(s.project===null&&s.detachedProjectName?{detachedProjectName:s.detachedProjectName}:{}),
     title:s.title,description:s.description,tickets:s.tickets,status:s.status,feedbackPending:s.feedbackPending,
     rounds:s.rounds.map(x=>({n:x.n,publishedAt:x.publishedAt,publishedBy:x.publishedBy,notes:x.notes,addresses:x.addresses.length})),
     round:{n:r.n,notes:r.notes,publishedAt:r.publishedAt,items},unaddressed,url:'#review/'+s.id};
   }},
  {name:'review_set_save',scope:'review:write',title:'Review: change set metadata',
   description:'Rename, archive/reopen or replace ticket links without publishing a round or changing feedback. Read review_get for rev; stale rev conflicts. Tickets must exist in the same project; duplicates normalize. Omitted tickets preserves links; [] clears them for compatibility. Prefer at least one ticket.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:'^R-[1-9][0-9]{0,5}$'},rev:{type:'integer',minimum:1},title:{type:'string',minLength:1,maxLength:160},status:{type:'string',enum:['open','archived']},tickets:{type:'array',maxItems:20,items:{type:'string',pattern:TICKET_ID.source}}},required:['id','rev'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state})=>runReview(state,r=>r.saveSet(args))},
  {name:'review_set_delete',scope:'review:write',title:'Review: delete detached set',
   description:'Permanently delete a detached review set (whose project was deleted), unindex it from search, and remove unreferenced blobs. Requires current rev from review_get.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:REVIEW_ID.source},rev:{type:'integer',minimum:1}},required:['id','rev'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
   run:(args,{state})=>runReview(state,r=>r.deleteSet(args))},
  {name:'review_set_reassign',scope:'review:write',title:'Review: reassign detached set',
   description:'Reassign a detached review set to an existing project, clearing unavailable or cross-project ticket associations. Requires current rev from review_get.',
   inputSchema:{type:'object',properties:{id:{type:'string',pattern:REVIEW_ID.source},rev:{type:'integer',minimum:1},project:{type:'string',pattern:'^[a-z][a-z0-9-]{1,39}$'}},required:['id','rev','project'],additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state})=>runReview(state,r=>r.reassignSet(args))},
  {name:'review_publish',scope:'review:write',title:'Review: publish a set or a new round',
   description:'Publish review artifacts for an existing project, preferably linked to existing same-project tickets. Omit set to create (project and title required); pass set for the next round. Unlinked creation remains compatible but is deprecated; the result includes linkage warnings. First determine whether genuine alternatives are needed (mode choose) or independent deliverables need approval (mode approve); never manufacture 2-3 choices. Publish every separately reviewed asset/shot as individually inspectable media with meaningful names/captions. A contact sheet is supplemental only. Use separate items for separate decisions, or media[] within one deliverable sharing one decision. Supported kinds: html, image, model, video, audio. Motion needs a playable clip, not only still frames. Revisions start from the selected work and requested changes, keep stable item ids and the same set, and list only comment ids actually addressed in addresses. Earlier rejected/superseded work included as context must be clearly labeled reference:true; references are commentable but excluded from choices and approvals. Do not carry approvals to new media. Set aligned:true only on image/video comparisons of the same shot, camera, framing, pixel dimensions and timing, never sheets or unrelated deliverables. Approve permits explicit aligned before/after against a reference; independent deliverables are not synchronized. Upload images/models/clips first with scripts/review-push.mjs or PUT /api/review/blobs/<sha256>; media references sha256 and type. Small self-contained HTML may use {type:"text/html",html}, inline CSS/JS/data assets, no network, data-mock-id on meaningful elements. GLB (model/gltf-binary) is binary glTF without Draco/meshopt/KTX2, up to 128 MiB. Models/videos may carry poster {sha256,type}. Use captions/round notes to explain intended sound or intentional silence, representative review intervals, captions/transcripts and workstation QA evidence tied to the blob hash. Check decode, motion/timing and listen to the actual uploaded artifact before publishing. Signatures and muted playback do not prove audio presence or quality; browser video stream presence is unknown. Quiet/silent media is advisory, never automatically rejected. If ticket creation succeeds but publication fails, retain the ticket id and retry publication without creating another ticket. Returns the set summary, id and warnings.',
   inputSchema:{type:'object',properties:{
    project:{type:'string',maxLength:40},set:{type:'string',pattern:REVIEW_ID.source},title:{type:'string',minLength:1,maxLength:160},description:{type:'string',maxLength:4000},
    tickets:{type:'array',maxItems:20,items:{type:'string',pattern:TICKET_ID.source}},notes:{type:'string',maxLength:4000,description:'What this round changes.'},
    addresses:{type:'array',maxItems:500,items:{type:'string',maxLength:64}},
    items:{type:'array',minItems:1,maxItems:REVIEW_LIMITS.items,items:{type:'object',required:['id','title','kind','variants'],additionalProperties:false,properties:{
     id:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,39}$'},title:{type:'string',minLength:1,maxLength:160},description:{type:'string',maxLength:4000},kind:{type:'string',enum:[...REVIEW_KINDS]},mode:{type:'string',enum:['choose','approve']},aligned:{type:'boolean',description:'Image and video items only: every variant is the same shot (same camera, framing and pixel size; for clips also the same timing), e.g. one unit rendered before and after a change. The page offers swipe after verifying actual dimensions and compatible clip durations (a keyboard-operable divider across two distinct single files). Never for contact sheets or grids whose cells differ between variants.'},
     variants:{type:'array',minItems:1,maxItems:REVIEW_LIMITS.variants,items:{type:'object',required:['id','media'],additionalProperties:false,properties:{
      id:{type:'string',pattern:'^[a-f]$'},label:{type:'string',maxLength:40},reference:{type:'boolean'},title:{type:'string',maxLength:160},description:{type:'string',maxLength:4000},
      media:{type:'array',minItems:1,maxItems:REVIEW_LIMITS.media,items:{type:'object',required:['type'],additionalProperties:false,properties:{
       type:{type:'string',enum:['text/html','image/png','image/jpeg','image/webp','image/gif','model/gltf-binary','video/mp4','video/webm','audio/mpeg','audio/wav','audio/ogg','audio/flac','audio/mp4','audio/webm']},poster:{type:'object',required:['sha256','type'],additionalProperties:false,properties:{sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},type:{type:'string',enum:['image/png','image/jpeg','image/webp']}}},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},html:{type:'string',maxLength:REVIEW_LIMITS.inlineHtml},
       name:{type:'string',maxLength:200},caption:{type:'string',maxLength:1000},viewport:{type:'object',properties:{width:{type:'integer',minimum:200,maximum:3840},height:{type:'integer',minimum:200,maximum:4000}},required:['width','height'],additionalProperties:false}}}}}}}}}}},
    additionalProperties:false},
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
   run:(args,{state,principal})=>runReview(state,r=>r.publish(args,principal.username))},
 ],
 routes:[
  // Review uploads: raw chunks of one content-addressed blob, appended in order (docs/review.md).
  {method:'PUT',match:/^\/api\/review\/blobs\/(.*)$/,scope:'review:write',raw:true,contentType:'application/octet-stream',error:reviewError,async handler(c){
    const {req,url,params,state}=c,sha=params[1],length=Number(req.headers['content-length']);
    if(Number.isFinite(length)&&length>REVIEW_LIMITS.chunk)return c.error(413,'TOO_LARGE',`One chunk may be at most ${REVIEW_LIMITS.chunk} bytes.`);
    const n=k=>/^\d{1,12}$/.test(url.searchParams.get(k)||'')?Number(url.searchParams.get(k)):NaN;
    const out=await state.review.putChunk(sha,{offset:n('offset'),size:n('size')},req);req.resume();c.subject=sha.slice(0,12);
    if(out.mismatch)return c.json(409,{error:{code:'REVIEW_FAILED',message:'Upload offset does not match; continue from received.'},received:out.received,size:out.size});
    return c.json(out.complete?201:200,out);}},
  write('/api/review/publish',{bodyLimit:65536},async c=>{const saved=await c.state.review.publish(c.input,who(c));c.subject=saved.id;return c.json(c.input?.set===undefined?201:200,saved);}),
  write('/api/review/feedback',{bodyLimit:65536},async c=>{const saved=await c.state.review.feedback(c.input,who(c));c.subject=saved.set;return c.json(200,saved);}),
  write('/api/review/sets',{},async c=>{const saved=await c.state.review.saveSet(c.input);c.subject=saved.id;return c.json(200,saved);}),
  write('/api/review/sets/delete',{},async c=>{const deleted=await c.state.review.deleteSet(c.input);c.subject=deleted.id;return c.json(200,deleted);}),
  write('/api/review/sets/reassign',{},async c=>{const saved=await c.state.review.reassignSet(c.input);c.subject=saved.id;return c.json(200,saved);}),
  // provenance (server/provenance.mjs): who published the rounds (agents, as a rule) and who decided on them (people).
  {method:'GET',path:'/api/review',error:reviewError,async handler(c){const {authors,...data}=await c.state.review.list(c.query,{authors:true});
    return c.json(200,{...data,provenance:authoredProvenance(c.hub.accessStore,authors,{unit:'rounds'})});}},
  {method:'GET',match:/^\/api\/review\/sets\/(.*)$/,error:reviewError,async handler({params,json,state,hub}){if(!REVIEW_ID.test(params[1]))throw new Error('not-found');
    const set=await state.review.get(params[1]);return json(200,{...set,provenance:authoredProvenance(hub.accessStore,setAuthors(set),{unit:'rounds'})});}},
  // An HTML mockup runs sandboxed in an opaque origin: no cookies, no Home Hub API, no network (docs/review.md).
  {method:'GET',match:/^\/api\/review\/frame\/(.*)$/,error:reviewError,async handler({params,res,state}){
    const html=await state.review.frame(params[1]);
    res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Frame-Options','SAMEORIGIN');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);}},
  {method:'GET',match:/^\/api\/review\/blobs\/(.*)$/,head:true,error:reviewError,async handler({req,res,params,principal,error,state}){
    const review=state.review,sha=params[1];
    // The push script asks with HEAD whether an upload can be skipped, before the blob is published.
    if(req.method==='HEAD'&&principal.authKind==='api-key'&&SHA.test(sha)&&!(await review.media(sha).then(()=>true,()=>false))){res.writeHead(await review.hasBlob(sha)?200:404,{'X-Review-Blob':'unpublished'});return res.end();}
    const media=await review.media(sha);let range;
    try{range=byteRange(req.headers.range,media.size);}catch{res.setHeader('Content-Range',`bytes */${media.size}`);return error(416,'INVALID_RANGE','Invalid media range.');}
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");res.setHeader('Cache-Control','private, max-age=31536000, immutable');
    res.writeHead(range.status,{'Content-Type':media.type,'Accept-Ranges':'bytes','Content-Length':range.end-range.start+1,...(range.status===206?{'Content-Range':`bytes ${range.start}-${range.end}/${media.size}`}:{})});
    if(req.method==='HEAD')res.end();else try{await pipeline(createReadStream(media.file,{start:range.start,end:range.end}),res);}catch{res.destroy();}}},
 ],
 // Rows for the API reference (Users and API). The MCP tools review_list, review_get and review_publish do the same for agents.
 apiDocs:[{title:'Review',routes:[
  ['GET','/api/review?project=&detached=true|false&ticket=&status=active|done|archived|all&feedback=pending','read','Sady variant k posouzení se stavem posledního kola.'],
  ['GET','/api/review/sets/<R-n>','read','Celá sada: kola, položky, varianty, rozhodnutí a připomínky.'],
  ['PUT','/api/review/blobs/<sha256>?offset=&size=','review:write','Nahrání souboru po částech (nejvýš 8 MiB na požadavek).'],
  ['POST','/api/review/publish','review:write','Nová sada {project, title, items} nebo další kolo {set, items, addresses?}.'],
  ['POST','/api/review/feedback','review:write','Rozhodnutí k položce {set, round, item, rev, variant, status, note?, comments?, editComments?, deleteComments?}.'],
  ['POST','/api/review/sets','review:write','Archivace, přejmenování nebo propojení tiketů {id, rev, status?, title?, tickets?}.'],
  ['POST','/api/review/sets/delete','review:write','Smazání odpojené sady {id, rev}.'],
  ['POST','/api/review/sets/reassign','review:write','Přiřazení odpojené sady k projektu {id, rev, project}.']]}],
};
