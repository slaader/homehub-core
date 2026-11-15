import {el} from './views.js';
import {t} from './i18n.js';
import {authGuard,sessionTicket} from './session-cache.js';
import {pageHeader,copyBlock,emptyState} from './ui.js';

export const QWEN_EXAMPLE=`# Run an installed llama.cpp server with a local Qwen embedding GGUF:
llama-server -m /path/to/Qwen3-Embedding-0.6B-Q8_0.gguf --embedding --pooling last --host 127.0.0.1 --port 8081 --alias ticket-embeddings

# Add these to the Home Hub service environment, then restart Home Hub:
HOME_HUB_TICKET_EMBEDDING_URL=http://127.0.0.1:8081/v1/embeddings
HOME_HUB_TICKET_EMBEDDING_MODEL=ticket-embeddings
HOME_HUB_TICKET_EMBEDDING_REVISION=qwen3-0.6b-v1
HOME_HUB_TICKET_EMBEDDING_QUERY_PREFIX='Instruct: Given a question, retrieve relevant tickets and attachment passages.\nQuery: '

# Then enable semantic search on this page.`;
async function request(body){
 const lost=authGuard(),r=await fetch('/api/admin/platform/search',{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 if(r.status===401)lost(r);
 const data=await r.json();if(!r.ok)throw new Error(data.error?.message||t('Požadavek selhal.'));return data;
}
export function platformSettingsPage({me}){
 if(!me?.canAdmin)return emptyState({icon:'◇',title:t('Vyžaduje správce'),body:t('Nastavení platformy je jen pro správce přihlášeného heslem.')});
 const live=sessionTicket(),content=el('div',{'aria-live':'polite'},t('Načítám…'));
 async function load(){
  try{const data=await request();if(live())draw(data);}catch(e){if(live())content.replaceChildren(el('p',{class:'set-status bad',role:'alert'},e.message),el('button',{type:'button',onclick:load},t('Zkusit znovu')));}
 }
 function draw(data){
  const status=el('p',{class:'set-status',role:'status'});
  const toggle=el('input',{id:'semantic-enabled',type:'checkbox',checked:data.enabled?'':null,disabled:!data.configured?'':null,onchange:async()=>{
   toggle.disabled=true;status.textContent=t('Ukládám…');
   try{const saved=await request({enabled:toggle.checked});if(live())draw(saved);}catch(e){if(live()){toggle.checked=data.enabled;toggle.disabled=!data.configured;status.textContent=e.message;status.className='set-status bad';}}
  }});
  content.replaceChildren(
   el('section',{class:'set-card'},el('h3',{},t('Hledání')),
    el('p',{},t('Fulltext je výchozí. Hledá přesné chyby, identifikátory, metadata příloh a podporovaný textový obsah.')),
    el('label',{class:'set-toggle',for:'semantic-enabled'},toggle,t('Povolit sémantické hledání')),
    el('p',{class:'set-dim'},t('Volitelné hledání podle významu pro tickety. Obsah ticketů a přijatých textových příloh se odešle nastavenému poskytovateli embeddingů. Fulltext zůstává výchozí i po zapnutí.')),
    el('p',{class:'set-dim'},data.configured?t('Poskytovatel je nastaven. Model: {model}',{model:data.model}):t('Nejdřív nastav poskytovatele na serveru a restartuj Home Hub. Potom lze hledání zapnout tady.')),
    el('p',{class:'set-dim'},t('Stav: {state} · Vektory: {done}/{total}',{state:data.status.semanticState,done:data.status.coverage?.embedded??0,total:data.status.coverage?.chunks??0})),status,
    el('button',{type:'button',class:'ui-button',onclick:load},t('Obnovit stav'))),
   el('section',{class:'set-card'},el('h3',{},t('Jak zapnout sémantické hledání')),
    el('ol',{},[t('Spusť poskytovatele embeddingů s OpenAI kompatibilním endpointem /v1/embeddings. Použij embedding model, například Qwen3-Embedding, ne chatovací model.'),
     t('Na serveru nastav URL a model podle příkladu. Volitelný token patří do prostředí služby; nezadávej ho do URL nebo do ticketu.'),
     t('Restartuj Home Hub, obnov tuto stránku a zapni sémantické hledání. První indexace probíhá na pozadí; fulltext funguje dál.'),
     t('V hledání zvol „Podle významu“ nebo „Hybridní“. Při změně modelu změň i REVISION a ověř kvalitu na vlastních otázkách.')].map(s=>el('li',{},s))),
    copyBlock(t('Příklad: Qwen embedding'),QWEN_EXAMPLE),
    el('p',{class:'set-dim'},t('Příklad předpokládá nainstalovaný llama.cpp a stažený GGUF model. HTTP je povolené jen na loopbacku; pro vzdálený server použij HTTPS.')),
    el('p',{},el('a',{href:'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF',target:'_blank',rel:'noopener noreferrer'},'Qwen3-Embedding · model card')),
    el('p',{class:'set-dim'},t('Alternativa: EmbeddingGemma. Potřebuje embedding server se správným formátováním dotazů i dokumentů podle model card; běžný Gemma chat endpoint nestačí.')),
    el('a',{href:'https://huggingface.co/google/embeddinggemma-300m',target:'_blank',rel:'noopener noreferrer'},'EmbeddingGemma · model card')));
 }
 load();return el('div',{class:'set'},pageHeader({eyebrow:t('Správa'),title:t('Nastavení platformy'),lead:t('Nastavení pro všechny uživatele Home Hubu.')}),content);
}
