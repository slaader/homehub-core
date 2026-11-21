import {createReferences} from '../references.mjs';
import {toolError} from '../tool-error.mjs';
import {referenceKinds} from '../../public/reference-format.js';

const base='/api/references',local='tickets:write',global='references:write';
const errors={
 invalid:[400,'Neplatná reference nebo projekt.','Invalid reference or project.'],
 'not-found':[404,'Reference nebyla nalezena.','Reference not found.'],
 conflict:[409,'Reference se změnila nebo název už existuje.','The reference changed or its name already exists.'],
 limit:[409,'Byl dosažen limit referencí.','The reference limit has been reached.'],
 denied:[403,'Chybí oprávnění pro sdílení reference.','Sharing requires both ticket and reference write scopes.'],
};
const problem=e=>errors[e.message]??[503,'Reference nelze načíst.','References are unavailable.'];
function error(e,c){const [status,cs,en]=problem(e);return [status,'REFERENCES_FAILED',c.principal?.authKind==='api-key'?en:cs];}
const str={type:'string'},kind={enum:referenceKinds},rev={type:'integer',minimum:0},page={offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}};
const identity={kind,id:str},search={kind,project:str,q:str,scope:{enum:['global','local']},...page};
const record={kind:{enum:['custom','model']},label:str,description:str,id:str,rev};
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
function sharing(c){
 if(!c.principal.scopes.includes(local))throw new Error('denied');
}
// Each mutation has a static scope (also used for MCP discovery). The storage destination is fixed by the operation.
const writes=[
 ['local/save','project_reference_save',local,{...record,kind:{const:'custom'},project:str},['kind','label','project'],'Create or revise a project-owned Custom record.',(s,i,c)=>s.save(i,c.principal.username,true)],
 ['global/save','reference_save',global,record,['kind','label'],'Create or revise a global Custom or documented model.',(s,i,c)=>s.save(i,c.principal.username,false)],
 ['local/delete','project_reference_delete',local,{...identity,project:str,rev},['kind','id','project','rev'],'Delete a project-owned Custom record.',(s,i)=>s.remove(i,true)],
 ['global/delete','reference_delete',global,{...identity,rev},['kind','id','rev'],'Delete a global Custom or model record.',(s,i)=>s.remove(i,false)],
 ['promote','reference_promote',global,{...identity,project:str,rev},['kind','id','project','rev'],'Move a local Custom record to Settings. Also requires tickets:write.',(s,i,c)=>{sharing(c);return s.promote(i,c.principal.username);}],
 ['share','reference_share',global,{...identity,rev},['kind','id','rev'],'Share a native wiki or tracker ticket across projects. Also requires tickets:write. Use note.rev or zero.',(s,i,c)=>{sharing(c);return s.annotate(i,c.principal.username,true);}],
 ['note','reference_note_save',global,{...identity,description:str,rev},['kind','id','description','rev'],'Annotate a native source. Use note.rev or zero.',(s,i,c)=>s.annotate(i,c.principal.username,false)],
];
function tool(name,scope,properties,required,description,run){
 return {name,scope,inputSchema:object(properties,required),description,annotations:{readOnlyHint:scope==='read',destructiveHint:name.endsWith('_delete'),openWorldHint:false},
  async run(input,c){
   try{return await run(c.state,input,c);}
   catch(e){throw toolError(problem(e)[2]);}
  }};
}
export default {
 id:'references',title:'References',setup:createReferences,
 assets:['reference-format.js','tracker-markdown-format.js','reference-chip.js','reference-picker.js','references-view.js','references.css','i18n-en-references.js'],
 nav:[{groupKey:'Správa',labelKey:'Reference',hash:'references',order:65,view:'references-view.js#referencesPage'}],
 mcpInstructions:'references_search and reference_get read shared documentation and where-used. Wiki mentions use {t:"ref",kind,id,label} or {t:"ticket",id}. Ticket descriptions/comments use @[Label](ref:kind/id). Use project context to discover available mentions.',
 mcpTools:[
  tool('references_search','read',search,[],'Find references by prefix. With project, return mentionable local and global sources.',(s,i)=>s.search(i,Boolean(i.project))),
  tool('reference_get','read',{...identity,...page},['kind','id'],'Read a reference, description and paged incoming mentions.',(s,i)=>s.get(i)),
  ...writes.map(([,name,scope,props,required,description,run])=>tool(name,scope,props,required,description,run)),
 ],
 routes:[
  {method:'GET',path:base,error,handler:async c=>c.json(200,await c.state.search(c.query))},
  {method:'GET',path:base+'/suggest',error,handler:async c=>c.json(200,await c.state.search(c.query,true))},
  {method:'GET',path:base+'/item',error,handler:async c=>c.json(200,await c.state.get(c.query))},
  {method:'POST',path:base+'/resolve',scope:'read',write:false,error,handler:async c=>c.json(200,await c.state.resolve(c.input))},
  ...writes.map(([path,,scope,,,,run])=>({method:'POST',path:base+'/'+path,scope,error,async handler(c){
   c.subject=null;const result=await run(c.state,c.input,c);c.subject=result.id;return c.json(200,result);
  }})),
 ],
 apiDocs:[{title:'References',routes:[
  ['GET',base,'read','Reference podle druhu a projektu.'],['GET',base+'/suggest','read','Doplnění reference v projektu.'],
  ['GET',base+'/item','read','Zdroj reference a místa použití.'],['POST',base+'/resolve','read','Názvy odkazovaných záznamů.'],
  ...writes.map(([path,,scope,,,description])=>['POST',base+'/'+path,scope,description]),
 ]}],
};
