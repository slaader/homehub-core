import {el} from './views.js';
import {t} from './i18n.js';
import {authGuard,onSessionReset} from './session-cache.js';
import {referenceKey,referenceHref} from './reference-format.js';

export async function referenceApi(path,body){
 const lost=authGuard();
 const response=await fetch('/api/references'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 lost(response);
 const result=await response.json();
 if(!response.ok)throw Object.assign(new Error(t(result.error?.message??'Požadavek selhal.')),{status:response.status});
 return result;
}
let waiting=new Map(),generation=0;
onSessionReset(()=>{waiting.clear();generation++;});
async function flush(){
 const batch=[...waiting.values()],current=generation;
 waiting=new Map();
 for(let i=0;i<batch.length;i+=100){
  const group=batch.slice(i,i+100);
  try{
   const {items}=await referenceApi('/resolve',{refs:group.map(({kind,id})=>({kind,id}))});
   if(current!==generation)return;
   const records=new Map(items.map(r=>[referenceKey(r),r]));
   for(const item of group)for(const paint of item.listeners)paint(records.get(referenceKey(item)));
  }catch{/* Keep the saved text and source link if the lookup could not complete. */}
 }
}
export function referenceChip(ref,editing=false){
 const href=referenceHref(ref.kind,ref.id);
 const chip=el(editing?'span':'a',{class:'wiki-ticket ref-chip',href:editing?null:href,contenteditable:editing?'false':null,
  'data-ref-kind':ref.kind,'data-ref-id':ref.id,'data-ref-label':ref.label},ref.label);
 if(!waiting.size)queueMicrotask(flush);
 const key=referenceKey(ref),item=waiting.get(key)??{kind:ref.kind,id:ref.id,listeners:[]};
 waiting.set(key,item);
 item.listeners.push(record=>{
  if(record){chip.textContent=record.label;return;}
  chip.removeAttribute('href');chip.classList.add('wiki-ticket-missing');chip.title=t('Reference nebyla nalezena.');
 });
 return chip;
}
