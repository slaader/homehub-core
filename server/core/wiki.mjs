import {createWikiStore} from '../wiki-store.mjs';
import {createWikiPreviews,staticWikiHtml,WIKI_FRAME_CSP} from '../wiki-frame.mjs';
import {authoredProvenance} from '../provenance.mjs';
import {exactKeys,HTML_ID,PAGE_ID,WIKI_LIMITS} from '../../public/wiki-doc.js';
import {PROJECT_ID,TICKET_ID} from '../tickets-store.mjs';

const messages={
 invalid:['Neplatný požadavek na wiki.','Invalid wiki request.'],
 'not-found':['Stránka nebo wiki neexistuje.','The page or wiki does not exist.'],
 conflict:['Stránka se mezitím změnila.','The page changed while you were editing.'],
 limit:['Byl dosažen limit wiki.','A wiki limit was reached.'],
 unavailable:['Wiki teď nejde načíst ani uložit.','The wiki is unavailable right now.'],
};
const message=(c,error)=>(messages[error]??messages.unavailable)[c.principal?.authKind==='api-key'?1:0];
const wikiError=(error,c)=>[({invalid:400,'not-found':404,conflict:409,limit:409})[error.message]??503,'WIKI_FAILED',message(c,error.message)];
const who=c=>c.principal.username;
const owner=({principal:p})=>p.authKind+':'+(p.accountId??p.id??p.username);
const withProvenance=(c,page)=>({...page,provenance:authoredProvenance(c.hub.accessStore,{
 created:[[page.createdBy,page.createdAt]],changes:page.history.filter(h=>h.field!=='created').map(h=>[h.by,h.at]),
 },{unit:'records'})});
const pattern=regex=>regex.source.slice(1,-1);
const project=pattern(PROJECT_ID),page=pattern(PAGE_ID),block=pattern(HTML_ID),ticket=pattern(TICKET_ID);
const route=(method,path,handler,options={})=>({method,...(typeof path==='string'?{path}:{match:path}),error:wikiError,handler,...options});

function write(path,handler){
 return route('POST',path,async c=>{
  c.subject=null;
  try{return await handler(c);}catch(error){
   if(error.message!=='conflict'||!error.current)throw error;
   return c.json(409,{error:{code:'WIKI_FAILED',message:message(c,'conflict')},current:error.current});
  }
 },{scope:'tickets:write',bodyLimit:WIKI_LIMITS.bodyBytes});
}

function frame(c,source){
 c.res.setHeader('Content-Security-Policy',WIKI_FRAME_CSP);
 c.res.setHeader('X-Frame-Options','SAMEORIGIN');
 c.res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 c.res.end(staticWikiHtml(source));
}

export default {
 id:'wiki',title:'Wiki',
 assets:['wiki-doc.js','wiki-view.js','wiki-editor.js','wiki-content.js','wiki.css','i18n-en-wiki.js'],
 nav:[{hash:'wiki',label:'Wiki',view:'wiki-view.js#wikiPage',hidden:true}],
 setup:hub=>({wiki:createWikiStore(hub.db,hub.state('tracker').tickets),previews:createWikiPreviews()}),
 routes:[
  route('GET',new RegExp(`^/api/wiki/tickets/(${ticket})/backlinks$`),async c=>
   c.json(200,{pages:await c.state.wiki.backlinks(c.params[1])})),
  route('GET',new RegExp(`^/api/wiki/(${project})$`),async c=>c.json(200,await c.state.wiki.list(c.params[1]))),
  route('GET',new RegExp(`^/api/wiki/(${project})/pages/(${page})$`),async c=>
   c.json(200,withProvenance(c,await c.state.wiki.get(c.params[1],c.params[2])))),
  write('/api/wiki/setup',async c=>{
   const result=await c.state.wiki.setup(c.input,who(c));
   c.subject=result.home;
   return c.json(result.created?201:200,result);
  }),
  write('/api/wiki/pages',async c=>{
   const saved=await c.state.wiki.create(c.input,who(c));
   c.subject=saved.id;
   return c.json(201,withProvenance(c,saved));
  }),
  write('/api/wiki/pages/update',async c=>{
   const saved=await c.state.wiki.update(c.input,who(c));
   c.subject=saved.id;
   return c.json(200,withProvenance(c,saved));
  }),
  write('/api/wiki/preview',c=>{
   if(!exactKeys(c.input,['source']))throw new Error('invalid');
   return c.json(200,{token:c.state.previews.put(owner(c),c.input.source)});
  }),
  route('GET',new RegExp(`^/api/wiki/frame/(${project})/(${page})/(${block})$`),async c=>{
   const saved=await c.state.wiki.get(c.params[1],c.params[2]);
   const html=saved.doc.blocks.find(b=>b.t==='html'&&b.id===c.params[3]);
   if(!html)throw new Error('not-found');
   return frame(c,html.source);
  }),
  route('GET',/^\/api\/wiki\/frame\/preview\/([A-Za-z0-9_-]{32})$/,c=>frame(c,c.state.previews.get(owner(c),c.params[1]))),
 ],
 apiDocs:[{title:'Wiki',routes:[
  ['GET','/api/wiki/<project>','read','Seznam stránek projektové wiki.'],
  ['GET','/api/wiki/<project>/pages/<id>','read','Obsah a revize stránky wiki.'],
  ['GET','/api/wiki/tickets/<ID>/backlinks','read','Stránky wiki odkazující na ticket.'],
  ['POST','/api/wiki/setup','tickets:write','Založení wiki s domovskou stránkou {project}.'],
  ['POST','/api/wiki/pages','tickets:write','Nová stránka wiki {project, title, doc?}.'],
  ['POST','/api/wiki/pages/update','tickets:write','Uložení stránky wiki {project, id, rev, title?, doc?}.'],
  ['POST','/api/wiki/preview','tickets:write','Dočasný náhled HTML {source}.'],
  ['GET','/api/wiki/frame/<project>/<id>/<block>','read','Izolovaný HTML blok wiki.'],
  ['GET','/api/wiki/frame/preview/<token>','read','Izolovaný náhled HTML pro autora.'],
 ]}],
};
