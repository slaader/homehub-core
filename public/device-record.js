// Render a device record in the caller's dialog. The caller owns access and persistence.
import {el,date,badge,onLeave} from './views.js';

let recordDialog;
function dialogForRecord(){
  if(recordDialog?.open)return recordDialog;
  recordDialog=el('dialog',{class:'device-record-dialog','aria-labelledby':'device-record-title'});
  document.body.append(recordDialog);
  return recordDialog;
}

function open(dialog){
  if(dialog.open)return;
  dialog.showModal();
  function dispose(){
    unregister();
    dialog.remove();
    if(recordDialog===dialog)recordDialog=null;
  }
  const unregister=onLeave(()=>{
    dialog.close();
    dispose();
  });
  dialog.addEventListener('close',dispose,{once:true});
}

export const deviceLabel=d=>d.recognition==='known'?'Known':d.recognition==='unknown'?'Unknown':d.confidence;
export const needsReview=d=>d.recognition==='unknown'||d.recognition!=='known'&&d.confidence!=='Confirmed';
const field=(label,value)=>[el('dt',{},label),el('dd',{},value||'Not checked')];
export function showDeviceRecord(d,{edit}={}){
  const dialog=dialogForRecord();
  dialog.replaceChildren(el('header',{class:'detail-head'},el('span',{class:'eyebrow'},'DEVICE RECORD'),edit?el('button',{class:'ui-button secondary',onclick:()=>edit(d)},'Edit inventory'):null,el('button',{class:'ui-button quiet',onclick:()=>dialog.close(),'aria-label':'Close device details'},'Close ×')),
    el('h2',{id:'device-record-title'},d.name),el('p',{class:'mono muted'},d.ip,' / ',d.mac),badge(deviceLabel(d),needsReview(d)?'amber':'good'),
    el('h3',{},'Identity & connection'),el('dl',{class:'details'},field('Recognition',d.recognition==='known'?'You recognize this device':d.recognition==='unknown'?'You marked this device unknown':'Not reviewed by you'),field('Original name',d.recordedName||d.name),field('Your alias',d.alias||'Not set'),field('Description',d.description||'Not set'),field('Room',d.room||'Not assigned'),field('Model',d.model),field('Type',d.role),field('Connection',d.connection),field('Connection evidence',d.connectionNote),field('Router presence',d.routerPresence?`${({'reporting':'Router responding','associated':'Wi-Fi association','reachable':'Reachable neighbor','lease-only':'DHCP lease only','cache-only':'Neighbor cache only'})[d.routerPresence]} · ${d.routerFreshness==='fresh'?'current observation':'last known observation'}`:'Not in the latest router import'),field('Router checked',d.routerObservedAt?date(d.routerObservedAt):'Not recorded'),field('Identification',d.identity)),
    el('h3',{},'Versions & assessment'),el('dl',{class:'details'},field('Firmware',d.firmware),field('Operating system',d.software),field('Vendor support',d.support)),
    el('div',{class:'note'},'An unknown version is an information gap, not a vulnerability finding.'),
    ...(d.userNotes?[el('section',{},el('h3',{},'Your notes'),el('p',{class:'user-notes'},d.userNotes))]:[]),el('h3',{},'Observation'),el('p',{},d.observation,' · ',date(d.observedAt)),...(d.notes??[]).map(n=>el('p',{class:'muted'},n)),
    el('p',{class:'muted'},'Names and identity annotations are saved inventory data. A DHCP lease or cached neighbor does not prove a device is currently connected.'),
    el('details',{},el('summary',{},'Sources & evidence'),el('dl',{class:'details evidence'},(d.evidence??[]).flatMap(e=>field(e.label,e.value)))));
  open(dialog);
}

export function editDeviceRecord(d,{saveRecord,view,onSaved}){
 const dialog=dialogForRecord();
 const original=d.manualValues||{},inputs={},initial={};
 const specs=[['alias','Your alias',160],['description','Device description',1000],['room','Room',80],['model','Model',160],['role','Device type',80],['firmware','Firmware version',160],['notes','Your notes',4000]];
 const fields=specs.map(([key,label,max])=>{const observed=key==='notes'?d.userNotes||'':d[key]||'';const value=original[key]||(['Not checked','Unknown'].includes(observed)?'':observed);initial[key]=value;inputs[key]=el(['notes','description'].includes(key)?'textarea':'input',{id:'edit-'+key,maxlength:max,...(['notes','description'].includes(key)?{rows:key==='notes'?4:2}:{value}),placeholder:key==='alias'?(d.recordedName||d.name):observed});if(['notes','description'].includes(key))inputs[key].value=value;return el('div',{},el('label',{for:'edit-'+key},label),inputs[key]);});
 const recognition=el('select',{id:'edit-recognition'},el('option',{value:''},'Not reviewed'),el('option',{value:'known'},'Known — I recognize this device'),el('option',{value:'unknown'},'Unknown — needs investigation'));recognition.value=d.recognition||'';
 const serviceHost=el('select',{id:'edit-service-host'},el('option',{value:''},'No'),el('option',{value:'yes'},'Yes — show a tile on Home'));serviceHost.value=original.serviceHost||'';
 const confidence=el('select',{id:'edit-confidence'},el('option',{value:''},`Use recorded evidence (${d.recordedConfidence||d.confidence})`),['Confirmed','Inferred','Needs review'].map(v=>el('option',{value:v},v)));confidence.value=original.confidence||'';
 const status=el('p',{role:'alert',class:'error'}),save=el('button',{class:'ui-button primary',type:'submit'},'Save inventory record');
 const form=el('form',{class:'device-edit-form',onsubmit:async event=>{event.preventDefault();save.disabled=true;status.textContent='';
  const values={...original,recognition:recognition.value,confidence:confidence.value,serviceHost:serviceHost.value};for(const [key,input]of Object.entries(inputs)){if(input.value!==initial[key])values[key]=input.value;}
  try{
   const updated=await saveRecord(d,values);
   if(dialog.open&&form.isConnected)view(updated);
   onSaved?.(updated);
  }catch(error){
   status.textContent=error?.message||'Could not confirm the save. Reload this record before retrying.';
  }finally{save.disabled=false;}
 }},el('div',{},el('label',{for:'edit-recognition'},'Do you recognize this device?'),recognition),...fields,el('div',{},el('label',{for:'edit-confidence'},'Identity confidence'),confidence),el('div',{},el('label',{for:'edit-service-host'},'Serves services (PC, laptop, server)?'),serviceHost),status,el('div',{class:'form-actions'},el('button',{type:'button',class:'ui-button secondary',onclick:()=>view(d)},'Cancel'),save));
 dialog.replaceChildren(el('header',{class:'detail-head'},el('span',{class:'eyebrow'},'INVENTORY / EDIT'),el('button',{class:'ui-button quiet','aria-label':'Close inventory editor',onclick:()=>dialog.close()},'Close ×')),el('h2',{id:'device-record-title'},'Edit '+d.name),el('p',{class:'muted'},'Changes are saved in Home Hub and survive router sync. Your alias is shown in lists; the original reported name remains in the details. Clear an alias to use the original name. IP and MAC addresses come from observations.'),form);open(dialog);inputs.alias.focus();
}
