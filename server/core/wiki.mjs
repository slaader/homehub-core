import {createReadStream} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createWikiStore} from '../wiki-store.mjs';
import {createWikiAssets,RAW_CHUNK,UPLOAD_ID,readWikiChunk} from '../wiki-assets.mjs';
import {createWikiSources} from '../wiki-sources.mjs';
import {createWikiPreviews,staticWikiHtml,WIKI_FRAME_CSP} from '../wiki-frame.mjs';
import {wikiProblem} from '../wiki-errors.mjs';
import {wikiActor,wikiSave,wikiTools} from '../wiki-mcp.mjs';
import {authoredProvenance} from '../provenance.mjs';
import {byteRange} from '../http-range.mjs';
import {ASSET_ID,exactKeys,HTML_ID,PAGE_ID,WIKI_LIMITS} from '../../public/wiki-doc.js';
import {PROJECT_ID,TICKET_ID} from '../tickets-store.mjs';

const who=c=>c.principal.username;
const canDraft=c=>c.canWrite&&c.principal.scopes.includes('tickets:write');
async function withProvenance(c,page){
 if(!page.doc)return page; // A retry receipt is the original mutation result.
 return {...await c.state.wiki.withAssets(page),provenance:authoredProvenance(c.hub.accessStore,{
  created:[[page.createdBy,page.createdAt]],changes:page.history.filter(h=>h.field!=='created').map(h=>[h.by,h.at]),
 },{unit:'records'})};
}
const pattern=regex=>regex.source.slice(1,-1);
const project=pattern(PROJECT_ID),page=pattern(PAGE_ID),block=pattern(HTML_ID),ticket=pattern(TICKET_ID),asset=pattern(ASSET_ID),upload=pattern(UPLOAD_ID);
function route(method,path,handler,options={}){
 return {method,...(typeof path==='string'?{path}:{match:path}),...options,async handler(c){
  try{return await handler(c);}
  catch(error){
   c.subject=null;
   if(options.raw)c.req.resume();
   const {status,body}=wikiProblem(error,{english:c.principal?.authKind==='api-key',legacy:true});
   return c.json(status,body);
  }
 }};
}
const write=(path,handler,options={})=>route('POST',path,async c=>{
 c.subject=null;
 return handler(c);
},{scope:'tickets:write',bodyLimit:WIKI_LIMITS.bodyBytes,...options});
const savePage=(status,run)=>async c=>{
 const saved=await run(c);
 c.subject=saved.id;
 return c.json(saved.replayed?200:status,await withProvenance(c,saved));
};

function frame(c,source){
 c.res.setHeader('Content-Security-Policy',WIKI_FRAME_CSP);
 c.res.setHeader('X-Frame-Options','SAMEORIGIN');
 c.res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 c.res.end(staticWikiHtml(source));
}

function disposition(name,inline){
 const fallback=name.replace(/[^\x20-\x7e]|["\\]/g,'_');
 const encoded=encodeURIComponent(name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 return `${inline?'inline':'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function media(c){
 const {params,req,res,state}=c;
 const file=await state.assets.media(params[1],params[2],canDraft(c)?wikiActor(c):null);
 let range;
 try{range=byteRange(req.headers.range,file.size);}
 catch{
  res.setHeader('Content-Range',`bytes */${file.size}`);
  return c.error(416,'INVALID_RANGE','Invalid media range.');
 }
 const inline=c.query.download!=='1'&&file.type!=='application/octet-stream';
 res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
 res.setHeader('Cache-Control','private, no-store');
 res.writeHead(range.status,{'Content-Type':file.type,'Accept-Ranges':'bytes','Content-Length':range.end-range.start+1,
  'Content-Disposition':disposition(file.name,inline),
  ...(range.status===206?{'Content-Range':`bytes ${range.start}-${range.end}/${file.size}`}:{})});
 if(req.method==='HEAD'||file.size===0)return res.end();
 try{await pipeline(createReadStream(file.file,{start:range.start,end:range.end}),res);}
 catch{res.destroy();}
}

function uploadResult(status,run){
 return async c=>{
  const result=await run(c,wikiActor(c));
  c.subject=result.assetId??result.project??null;
  return c.json(status,result);
 };
}

export default {
 id:'wiki',title:'Wiki',
 assets:['wiki-doc.js','wiki-view.js','wiki-editor.js','wiki-content.js','wiki-inventory.js','wiki-inventory-editor.js',
  'wiki-media.js','wiki.css','i18n-en-wiki.js'],
 nav:[{hash:'wiki',label:'Wiki',view:'wiki-view.js#wikiPage',hidden:true}],
 setup:hub=>{
  const wiki=createWikiStore(hub.db,hub.state('tracker').tickets);
  const assets=createWikiAssets(hub.db,path.join(hub.stateDirectory,'wiki'),wiki,hub.options.wikiAssets);
  const sources=createWikiSources(hub.db,wiki,assets,{lfs:()=>hub.state('git-lfs')?.store,review:()=>hub.state('review')?.review});
  return {wiki,assets,sources,previews:createWikiPreviews()};
 },
 mcpTools:wikiTools,
 mcpInstructions:'wiki_list, wiki_get.',
 pollers:[{id:'wiki-media-cleanup',start(state){
  const sweep=()=>Promise.all([state.assets.sweep(),state.wiki.pruneReceipts()]).catch(()=>console.error('Wiki media cleanup could not finish.'));
  state.timer=setInterval(sweep,3600000);
  state.timer.unref();
  return sweep();
 },stop(state){clearInterval(state.timer);}}],
 routes:[
  route('GET',new RegExp(`^/api/wiki/tickets/(${ticket})/backlinks$`),async c=>
   c.json(200,{pages:await c.state.wiki.backlinks(c.params[1])})),
  route('GET',new RegExp(`^/api/wiki/(${project})$`),async c=>c.json(200,await c.state.wiki.list(c.params[1]))),
  route('GET',new RegExp(`^/api/wiki/(${project})/pages/(${page})$`),async c=>
   c.json(200,await withProvenance(c,await c.state.wiki.get(c.params[1],c.params[2])))),
  write('/api/wiki/setup',async c=>{
   const result=await c.state.wiki.setup(c.input,who(c));
   c.subject=result.home;
   return c.json(result.created?201:200,result);
  }),
  write('/api/wiki/pages',savePage(201,c=>c.state.wiki.create(c.input,who(c),wikiActor(c)))),
  write('/api/wiki/pages/update',savePage(200,c=>wikiSave(c.state,c.input,who(c),wikiActor(c)))),
  write('/api/wiki/pages/move',savePage(200,c=>c.state.wiki.move(c.input,who(c)))),
  write('/api/wiki/attachments/add',savePage(200,c=>c.state.wiki.attach(c.input,who(c),wikiActor(c)))),
  write('/api/wiki/uploads',uploadResult(201,(c,actor)=>c.state.assets.begin(c.input,actor))),
  write('/api/wiki/uploads/finish',uploadResult(200,(c,actor)=>{
   if(!exactKeys(c.input,['uploadId']))throw new Error('invalid');
   return c.state.assets.finish(c.input.uploadId,actor);
  })),
  route('GET',new RegExp(`^/api/wiki/uploads/(${upload})$`),uploadResult(200,(c,actor)=>c.state.assets.status(c.params[1],actor)),{scope:'tickets:write'}),
  route('PUT',new RegExp(`^/api/wiki/uploads/(${upload})$`),uploadResult(200,async (c,actor)=>{
   if(Number(c.req.headers['content-length'])>RAW_CHUNK)throw new Error('too-large');
   const offset=/^\d{1,12}$/.test(c.query.offset)?Number(c.query.offset):NaN;
   if(!Number.isSafeInteger(offset))throw new Error('invalid');
   const state=await c.state.assets.status(c.params[1],actor);
   if(offset>state.nextOffset)throw Object.assign(new Error('upload-offset'),{nextOffset:state.nextOffset});
   const bytes=await readWikiChunk(c.req.iterator({destroyOnReturn:false}),Math.min(RAW_CHUNK,state.size-offset));
   return c.state.assets.chunk(c.params[1],offset,bytes,actor);
  }),{scope:'tickets:write',raw:true,contentType:'application/octet-stream'}),
  route('GET',new RegExp(`^/api/wiki/(${project})/assets$`),async c=>
   c.json(200,{assets:await c.state.assets.list(c.params[1],canDraft(c)?wikiActor(c):null)})),
  route('GET',new RegExp(`^/api/wiki/(${project})/assets/(${asset})$`),media,{head:true}),
  route('GET',new RegExp(`^/api/wiki/(${project})/sources$`),async c=>
   c.json(200,await c.state.sources.list(c.params[1],c.principal,{admin:c.canAdmin})),{scope:'tickets:write'}),
  write('/api/wiki/assets/import',uploadResult(201,(c,actor)=>c.state.sources.importAsset(c.input,actor,c.principal))),
  write('/api/admin/wiki/sources',async c=>{
   const result=await c.state.sources.setGrant(c.input);
   c.subject=result.project;
   return c.json(200,result);
  },{scope:null,session:true}),
  write('/api/wiki/preview',c=>{
   if(!exactKeys(c.input,['source']))throw new Error('invalid');
   return c.json(200,{token:c.state.previews.put(wikiActor(c),c.input.source)});
  }),
  route('GET',new RegExp(`^/api/wiki/frame/(${project})/(${page})/(${block})$`),async c=>{
   const saved=await c.state.wiki.get(c.params[1],c.params[2]);
   const html=saved.doc.blocks.find(b=>b.t==='html'&&b.id===c.params[3]);
   if(!html)throw new Error('not-found');
   return frame(c,html.source);
  }),
  route('GET',/^\/api\/wiki\/frame\/preview\/([A-Za-z0-9_-]{32})$/,c=>frame(c,c.state.previews.get(wikiActor(c),c.params[1]))),
 ],
 apiDocs:[{title:'Wiki',routes:[
  ['GET','/api/wiki/<project>','read','Seznam stránek projektové wiki a jejich rodiče.'],
  ['GET','/api/wiki/<project>/pages/<id>','read','Obsah, revize a přílohy stránky wiki.'],
  ['GET','/api/wiki/tickets/<ID>/backlinks','read','Stránky wiki odkazující na ticket.'],
  ['POST','/api/wiki/setup','tickets:write','Založení wiki s domovskou stránkou {project}.'],
  ['POST','/api/wiki/pages','tickets:write','Nová stránka wiki {project, parentId?, title, doc?, requestId?}.'],
  ['POST','/api/wiki/pages/update','tickets:write','Uložení stránky wiki {project, id, rev, title?, doc?}.'],
  ['POST','/api/wiki/pages/move','tickets:write','Přesunutí stránky {project, id, rev, parentId}.'],
  ['POST','/api/wiki/attachments/add','tickets:write','Přidání přílohy do skupiny nebo buňky s kontrolou revize a ID požadavku.'],
  ['POST','/api/wiki/uploads','tickets:write','Založení soukromé nahrávky {project, name, size, digest, type?}.'],
  ['GET','/api/wiki/uploads/<uploadId>','tickets:write','Stav a další offset vlastní nahrávky.'],
  ['PUT','/api/wiki/uploads/<uploadId>?offset=','tickets:write','Nahrání souboru po částech (max. 8 MiB).'],
  ['POST','/api/wiki/uploads/finish','tickets:write','Ověření a dokončení nahrávky {uploadId}.'],
  ['GET','/api/wiki/<project>/assets','read','Přílohy dostupné v projektu.'],
  ['GET','/api/wiki/<project>/assets/<assetId>','read','Příloha projektu s podporou rozsahů.'],
  ['GET','/api/wiki/<project>/sources','tickets:write','Povolené repozitáře a sady Review pro import.'],
  ['POST','/api/wiki/assets/import','tickets:write','Kopie povoleného souboru z Git LFS nebo Review {project, source}.'],
  ['POST','/api/admin/wiki/sources','admin','Povolení nebo odebrání zdroje pro cílový projekt.'],
  ['POST','/api/wiki/preview','tickets:write','Dočasný náhled HTML {source}.'],
  ['GET','/api/wiki/frame/<project>/<id>/<block>','read','Izolovaný HTML blok wiki.'],
  ['GET','/api/wiki/frame/preview/<token>','read','Izolovaný náhled HTML pro autora.'],
 ]}],
};
