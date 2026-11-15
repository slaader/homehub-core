// Administrator-controlled semantic opt-in. Provider credentials remain in the server environment.
import {createTicketSearchService,ticketSearchSettings} from './ticket-search-service.mjs';
import {createTicketEmbedder} from './ticket-embeddings.mjs';

export const PLATFORM_SEARCH_SCHEMA=1;
export function createPlatformSearch(directory,{db,tickets,ticketFiles,...options}){
 const configuredSettings={...ticketSearchSettings(options.env??process.env),...options};
 const configured=Boolean(options.embed||configuredSettings.url);
 // Validate configuration before any preference is persisted. Construction sends no requests.
 const provider=options.embed??(configuredSettings.url?createTicketEmbedder(configuredSettings):undefined);
 const store=db.collection('platform-search',{empty:()=>({schema:PLATFORM_SEARCH_SCHEMA,enabled:false}),
  split:doc=>({meta:doc,colls:{}}),join:meta=>meta,valid:doc=>doc.schema===PLATFORM_SEARCH_SCHEMA&&typeof doc.enabled==='boolean'});
 let enabled=false,started=false,closed=false,ready,queue=Promise.resolve(),generation=0;
 const make=()=>createTicketSearchService(directory,{...options,tickets,ticketFiles,env:{},...configuredSettings,
  url:enabled?configuredSettings.url:undefined,embed:enabled?provider:undefined});
 let service=make();
 const status=()=>({...service.status(),enabled,configured,defaultMode:'text'});
 async function start(){
  if(closed)throw new Error('Search is closed');
  return ready??=(async()=>{const doc=await store.read({forWrite:false});
   if(doc.schema!==PLATFORM_SEARCH_SCHEMA||typeof doc.enabled!=='boolean')throw new Error('Invalid platform search settings');
   enabled=configured&&(options.semanticEnabled??doc.enabled);
   if(enabled){await service.close();service=make();}service.start();started=true;
  })().catch(e=>{ready=null;throw e;});
 }
 async function settings(){await start();return {defaultMode:'text',configured,enabled,model:configured?configuredSettings.model??'injected':null,status:status()};}
 async function setEnabled(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='enabled')||typeof input.enabled!=='boolean'||input.enabled&&!configured)throw new Error('invalid');
  const change=queue.then(async()=>{await start();if(closed)throw new Error('Search is closed');
   await store.write({schema:PLATFORM_SEARCH_SCHEMA,enabled:input.enabled});
   if(enabled!==input.enabled){generation++;enabled=input.enabled;await service.close();service=make();if(started)service.start();}
   return settings();
  });queue=change.catch(()=>{});return change;
 }
 return {start,status,settings,setEnabled,async search(input){await start();const before=generation,out=await service.search(input);return before===generation?out:{...out,state:'indexing',results:[]};},
  async whenIdle(){await start();await queue;return service.whenIdle();},async close(){closed=true;await ready?.catch(()=>{});await queue;await service.close();}};
}
