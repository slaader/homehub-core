import {createHash} from 'node:crypto';
import {exactKeys} from '../public/wiki-doc.js';
import {PROJECT_ID,PROJECT_SETTINGS} from './tickets-store.mjs';

const fail=code=>{throw new Error(code);};
const validId=id=>typeof id==='string'&&PROJECT_ID.test(id);
const validRev=rev=>Number.isSafeInteger(rev)&&rev>=1;
const flag=(input,key)=>!Object.hasOwn(input,key)||typeof input[key]==='boolean';
const deletionFlags=['deleteWiki','deleteReviews','promoteReferences'];
const settingKeys=Object.keys(PROJECT_SETTINGS);

function requireScope(principal,scope){
 if(!principal?.scopes?.includes(scope))fail('forbidden');
}

function projectAt(data,id,rev){
 const project=data.projects.find(row=>row.id===id);
 if(!project)fail('not-found');
 if(rev!==undefined&&project.rev!==rev)fail('conflict');
 return project;
}

function recordsIn(data,collection,project){
 return data[collection].filter(row=>row.project===project);
}

function fingerprint(rows,identify){
 return rows.map(row=>[identify(row),row.rev??null]).sort(([a],[b])=>a.localeCompare(b));
}

function describeDeletion(project,tracker,wiki,review,references,wikiAdapter,refsAdapter){
 const epics=recordsIn(tracker,'epics',project.id),tickets=recordsIn(tracker,'tickets',project.id);
 const releases=recordsIn(tracker,'releases',project.id),sets=recordsIn(review,'sets',project.id);
 const space=wikiAdapter.space(wiki,project.id);
 const pages=space?recordsIn(wiki,'summaries',space.id):[];
 const local=recordsIn(references,'local',project.id);
 const collisions=refsAdapter.planPromotion(references,project);
 const counts={epics:epics.length,tickets:tickets.length,releases:releases.length,wikiPages:pages.length,reviewSets:sets.length,localReferences:local.length};
 const dependencies=[
  [project.id,project.key,project.createdAt,project.rev],space?.id??null,
  fingerprint(epics,row=>row.id),fingerprint(tickets,row=>row.id),fingerprint(releases,row=>row.version),
  fingerprint(pages,row=>row.id),fingerprint(sets,row=>row.id),fingerprint(local,row=>row.id),collisions,
 ];
 const snapshot=createHash('sha256').update(JSON.stringify(dependencies)).digest('hex');
 return {preview:{id:project.id,rev:project.rev,counts,collisions,snapshot},space,tickets,epics};
}

// The core tracker exposes these operations through HTTP and MCP. Each store owns its own
// mutations. This module checks cross-store preconditions and gives them one commit.
export function createProjectLifecycle(hub,tickets){
 const tracker=()=>tickets.lifecycle;
 const wiki=()=>hub.state('wiki').wiki.lifecycle;
 const review=()=>hub.state('review').review.lifecycle;
 const refs=()=>hub.state('references').lifecycle;
 const trackerSelection=id=>({projects:[id],releases:id+'/',tickets:null,epics:null});

 async function save(input,by){
  if(!validId(input?.id)||!flag(input,'createWiki'))fail('invalid');
  const {createWiki,...fields}=input;
  if(createWiki&&(fields.rev!==undefined||Object.hasOwn(fields,'settings')&&
   (!exactKeys(fields.settings,settingKeys)||
    Object.hasOwn(fields.settings,'wiki')&&fields.settings.wiki!==true)))fail('invalid');
  if(!createWiki&&!(fields.rev!==undefined&&Object.hasOwn(fields,'name')))return tickets.saveProject(fields,by);
  const a=tracker(),w=wiki();
  return hub.db.changeCollections([
   {store:a.store,selection:{projects:null}},
   {store:w.store,selection:w.select(input.id,'save')},
  ],([data,wikis])=>{
   const at=new Date().toISOString(),existing=data.projects.find(row=>row.id===input.id),oldName=existing?.name;
   if(createWiki)fields.settings={...fields.settings,wiki:true};
   const saved=a.save(data,fields,by,at);
   if(createWiki)w.create(wikis,saved,by,at);
   else if(oldName!==saved.name){
    const space=w.space(wikis,saved.id);
    if(space)w.rename(wikis,space,oldName,saved.name,by,at);
   }
   return saved;
  },{durable:true});
 }

 function deletion(id,run,readOnly=false){
  const a=tracker(),w=wiki(),r=review(),f=refs();
  return hub.db.changeCollections([
   {store:a.store,selection:trackerSelection(id)},
   {store:w.store,selection:w.select(id,'delete')},
   {store:r.store,selection:r.select(id)},
   {store:f.store,selection:f.select(id)},
  ],([trackerData,wikiData,reviewData,refsData])=>{
   const record=projectAt(trackerData,id);
   const details=describeDeletion(record,trackerData,wikiData,reviewData,refsData,w,f);
   return run(record,details,{a,w,r,f,trackerData,wikiData,reviewData,refsData});
  },readOnly?{readOnly:true}:{durable:true});
 }

 function preview(id,principal){
  requireScope(principal,'tickets:write');
  if(!validId(id))fail('invalid');
  return deletion(id,(_project,details)=>details.preview,true);
 }

 async function remove(input,by,principal){
  requireScope(principal,'tickets:write');
  if(!exactKeys(input,['id','rev','confirmation','snapshot',...deletionFlags])||
   !validId(input.id)||!validRev(input.rev)||typeof input.confirmation!=='string'||
   typeof input.snapshot!=='string'||!/^[a-f0-9]{64}$/.test(input.snapshot)||
   !deletionFlags.every(key=>flag(input,key)))fail('invalid');
  if(input.deleteReviews)requireScope(principal,'review:write');
  if(input.promoteReferences)requireScope(principal,'references:write');

  const {result,reviewCleanup,trackerCleanup}=await deletion(input.id,(project,details,stores)=>{
   const {preview,space,tickets:items,epics}=details;
   if(input.rev!==project.rev||input.snapshot!==preview.snapshot)fail('conflict');
   if(input.confirmation!==project.key&&input.confirmation!==project.name)fail('invalid');
   if(preview.counts.localReferences&&input.promoteReferences===undefined)fail('invalid');
   const {a,w,r,f,trackerData,wikiData,reviewData,refsData}=stores;
   const at=new Date().toISOString();
   const trackerCleanup=a.remove(trackerData,project,by,at);
   if(space){
    if(input.deleteWiki)w.remove(wikiData,space);
    else w.detach(wikiData,space,project.name);
   }
   const reviewCleanup=r.removeProject(reviewData,project,input.deleteReviews===true,by,at);
   f.removeProject(refsData,project,{promote:input.promoteReferences===true,collisions:preview.collisions,
    ticketIds:items.map(item=>item.id),epicIds:epics.map(epic=>epic.id),by,at});
   const result={id:project.id,counts:preview.counts,renamedReferences:input.promoteReferences?preview.collisions:[]};
   return {result,trackerCleanup,reviewCleanup};
  });
  tracker().notify();
  await Promise.all([trackerCleanup?.cleanup?.(),review().notify(reviewCleanup)]);
  return result;
 }

 async function upgrade(input,by){
  if(!exactKeys(input,['id','rev','type','labels','settings','renameWikiHome','epics'])||
   !validId(input.id)||!validRev(input.rev)||!flag(input,'renameWikiHome'))fail('invalid');
  const a=tracker(),w=wiki(),guard=await a.prepareUpgrade(input);
  const saved=await hub.db.changeCollections([
   {store:a.store,selection:trackerSelection(input.id)},
   {store:w.store,selection:w.select(input.id,'upgrade')},
  ],([data,wikis])=>{
   const project=projectAt(data,input.id,input.rev);
   if(project.projectVersion!==1)fail('conflict');
   const at=new Date().toISOString(),space=w.space(wikis,input.id);
   if(input.renameWikiHome){
    if(!space)fail('conflict');
    w.renameHome(wikis,space,'Home',project.name+' Home',by,at);
   }
   return a.upgrade(data,input,by,at,guard);
  },{durable:true});
  await a.notify();
  return saved;
 }

 return {save,preview,remove,upgrade};
}
