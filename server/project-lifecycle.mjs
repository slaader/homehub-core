import {createHash} from 'node:crypto';
import {exactKeys} from '../public/wiki-doc.js';
import {PROJECT_ID} from './tickets-store.mjs';

const fail=code=>{throw new Error(code);};
const validId=id=>typeof id==='string'&&PROJECT_ID.test(id);
const validRev=rev=>Number.isSafeInteger(rev)&&rev>=1;
const flag=(input,key)=>!Object.hasOwn(input,key)||typeof input[key]==='boolean';
const deletionFlags=['deleteWiki','deleteReviews','promoteReferences'];

function requireScope(principal,scope){
 if(!principal?.scopes?.includes(scope))fail('forbidden');
}

function projectAt(data,id){
 const project=data.projects.find(row=>row.id===id);
 if(!project)fail('not-found');
 return project;
}

function recordsIn(data,collection,project){
 return data[collection].filter(row=>row.project===project);
}

function fingerprint(rows,identify){
 return rows.map(row=>[identify(row),row.rev??null]).sort(([a],[b])=>a.localeCompare(b));
}

function describeDeletion(project,tracker,wiki,review,references,wikiAdapter,refsAdapter){
 const sets=recordsIn(review,'sets',project.id);
 const space=wikiAdapter.space(wiki,project.id);
 const pages=space?recordsIn(wiki,'summaries',space.id):[];
 const local=recordsIn(references,'local',project.id);
 const collisions=refsAdapter.planPromotion(references,project);
 const counts={...tracker.counts,wikiPages:pages.length,reviewSets:sets.length,localReferences:local.length};
 const dependencies=[
  [project.id,project.key,project.createdAt,project.rev],space?.id??null,
  tracker.digest,
  fingerprint(pages,row=>row.id),fingerprint(sets,row=>row.id),fingerprint(local,row=>row.id),collisions,
 ];
 const snapshot=createHash('sha256').update(JSON.stringify(dependencies)).digest('hex');
 return {preview:{id:project.id,rev:project.rev,counts,collisions,snapshot},space};
}

// The core tracker exposes these operations through HTTP and MCP. Each store owns its own
// mutations. This module checks cross-store preconditions and gives them one commit.
export function createProjectLifecycle(hub,tickets){
 const tracker=()=>tickets.lifecycle;
 const wiki=()=>hub.state('wiki').wiki.lifecycle;
 const review=()=>hub.state('review').review.lifecycle;
 const refs=()=>hub.state('references').lifecycle;
 async function selectedProject(adapter,id){
  const project=await adapter.store.get('projects',id);
  if(!project)fail('not-found');
  return project;
 }
 function checkSelection(data,selected){
  const project=projectAt(data,selected.id);
  if(project.key!==selected.key||project.createdAt!==selected.createdAt)fail('conflict');
  return project;
 }

 async function save(input,by){
  const a=tracker(),prepared=a.prepareProject(input);
  if(prepared.createWiki&&(prepared.rev!==undefined||prepared.settings.wiki===false))fail('invalid');
  if(!prepared.createWiki&&!(prepared.rev!==undefined&&prepared.name!==undefined))return tickets.saveProject(input,by);
  const w=wiki(),fields=prepared.createWiki?{...input,settings:{...input.settings,wiki:true}}:input;
  return hub.db.changeCollections([
   {store:a.store,selection:{projects:null}},
   {store:w.store,selection:w.select(input.id,'save')},
  ],([data,wikis])=>{
   const at=new Date().toISOString(),{project,previous,createWiki}=a.save(data,fields,by,at);
   if(createWiki)w.create(wikis,project,by,at);
   else if(previous&&previous.name!==project.name){
    const space=w.space(wikis,project.id);
    if(space)w.rename(wikis,space,previous.name,project.name,by,at);
   }
   return project;
  },{durable:true});
 }

 async function deletion(id,run,readOnly=false){
  const a=tracker(),selected=await selectedProject(a,id),w=wiki(),r=review(),f=refs();
  return hub.db.changeCollections([
   {store:a.store,selection:a.selection(selected)},
   {store:w.store,selection:w.select(id,'delete')},
   {store:r.store,selection:r.select(id)},
   {store:f.store,selection:f.select(id)},
  ],([trackerData,wikiData,reviewData,refsData])=>{
   const record=checkSelection(trackerData,selected);
   const details=describeDeletion(record,a.footprint(trackerData,id),wikiData,reviewData,refsData,w,f);
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
   !validId(input.id)||!validRev(input.rev)||typeof input.confirmation!=='string'||input.confirmation.length>80||
   typeof input.snapshot!=='string'||!/^[a-f0-9]{64}$/.test(input.snapshot)||
   !deletionFlags.every(key=>flag(input,key)))fail('invalid');
  if(input.deleteReviews)requireScope(principal,'review:write');
  if(input.promoteReferences)requireScope(principal,'references:write');

  const {result,reviewCleanup,trackerCleanup}=await deletion(input.id,(project,details,stores)=>{
   const {preview,space}=details;
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
    ticketIds:trackerCleanup.ticketIds,epicIds:trackerCleanup.epicIds,by,at});
   const result={id:project.id,deleted:trackerCleanup.counts,counts:preview.counts,renamedReferences:input.promoteReferences?preview.collisions:[]};
   return {result,trackerCleanup,reviewCleanup};
  });
  tracker().notify();
  await Promise.allSettled([trackerCleanup.cleanup(),review().notify(reviewCleanup)]);
  return result;
 }

 async function upgrade(input,by){
  if(!exactKeys(input,['id','rev','type','labels','settings','renameWikiHome','epics'])||
   !validId(input.id)||!validRev(input.rev)||!flag(input,'renameWikiHome'))fail('invalid');
  const a=tracker(),prepared=await a.prepareUpgrade(input),selected=await selectedProject(a,prepared.id);
  const w=wiki();
  const saved=await hub.db.changeCollections([
   {store:a.store,selection:a.selection(selected)},
   {store:w.store,selection:w.select(input.id,'upgrade')},
  ],([data,wikis],[count])=>{
   const project=checkSelection(data,selected);
   if(project.rev!==prepared.rev)fail('conflict');
   const at=new Date().toISOString(),space=w.space(wikis,input.id);
   if(input.renameWikiHome){
    if(!space)fail('conflict');
    w.renameHome(wikis,space,'Home',project.name+' Home',by,at);
   }
   return a.upgrade(data,prepared,by,at,count);
  },{durable:true});
  await a.notify();
  return saved;
 }

 return {save,preview,remove,upgrade};
}
