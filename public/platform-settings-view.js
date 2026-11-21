import {el} from './views.js';
import {t,tp} from './i18n.js';
import {authGuard,sessionTicket} from './session-cache.js';
import {pageHeader,copyBlock,emptyState,banner,statusPill} from './ui.js';

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
 // A proxy's HTML error page is not JSON: say the request failed instead of showing a parser error.
 const data=await r.json().catch(()=>null);
 if(!r.ok||!data||typeof data!=='object')throw new Error(data?.error?.message||t('Požadavek selhal.'));return data;
}
const count=v=>Number.isInteger(v)&&v>0?v:0;
const FULL_TEXT=()=>({ready:[t('Připraveno'),'good'],indexing:[t('Indexuje se'),'info'],degraded:[t('Neúplné'),'warn'],closed:[t('Zastaveno'),'']});
const SEMANTIC=()=>({ready:[t('Připraveno'),'good'],indexing:[t('Indexuje se'),'info'],degraded:[t('Chyby poskytovatele'),'bad'],closed:[t('Zastaveno'),''],disabled:[t('Vypnuto'),'']});
const OMITTED=()=>[['unsupported',t('nepodporovaný typ')],['oversize',t('příliš velké')],['invalid',t('neplatné UTF-8')],['missing',t('chybí soubor')],['capacity',t('nad limit indexu')]];
// What GET /api/admin/platform/search says, read once from the canonical status: state (the full-text index),
// semanticState, coverage (vectors) and extraction (attachment contents) are top-level fields of `status`;
// a missing one counts as zero, an unknown state word is shown as it is.
// → {fullText:{label,tone}, semantic:{label,tone}, vectors:{done,total,failed}, attachments:{total,indexed,omitted:[{key,label,n}]}}
export function searchStatusView(data){
 const s=data?.status&&typeof data.status==='object'?data.status:{},c=s.coverage||{},x=s.extraction||{};
 const pick=(table,state)=>{const [label,tone]=table[state]||[String(state??'—'),''];return {label,tone};};
 const semantic=!data?.configured?{label:t('Nenastaveno'),tone:''}:!data.enabled?{label:t('Vypnuto'),tone:''}:pick(SEMANTIC(),s.semanticState);
 return {fullText:pick(FULL_TEXT(),s.state),semantic,
  vectors:{done:count(c.embedded),total:count(c.chunks),failed:count(c.failed)},
  attachments:{total:count(x.attachments),indexed:count(x.indexed),
   omitted:OMITTED().map(([key,label])=>({key,label,n:key==='capacity'?count(x.capacity)+count(x.metadataCapacity)+count(x.ticketCapacity):count(x[key])})).filter(o=>o.n)}};
}
function statusList(data){
 const v=searchStatusView(data),row=(term,...value)=>[el('dt',{},term),el('dd',{},...value)];
 return el('dl',{class:'set-dl'},
  row(t('Fulltext'),statusPill(v.fullText.label,v.fullText.tone)),
  row(t('Sémantické hledání'),statusPill(v.semantic.label,v.semantic.tone)),
  data?.configured?row(t('Vektory'),`${v.vectors.done}/${v.vectors.total}`,v.vectors.failed?statusPill(tp(v.vectors.failed,'{n} selhal|{n} selhaly|{n} selhalo'),'bad'):null):null,
  v.attachments.total?row(t('Obsah příloh'),t('{indexed} z {total} v indexu',{indexed:v.attachments.indexed,total:v.attachments.total}),
   ...v.attachments.omitted.map(o=>el('span',{class:'set-dim'},`· ${o.label}: ${o.n}`))):null);
}
export function platformSettingsPage({me}){
 if(!me?.canAdmin)return emptyState({icon:'◇',title:t('Vyžaduje správce'),body:t('Nastavení platformy je jen pro správce přihlášeného heslem.')});
 const live=sessionTicket(),content=el('div',{'aria-live':'polite'},t('Načítám…'));
 // focus: which control gets the keyboard back after the card is drawn again ('toggle' | 'refresh').
 async function load(focus){
  try{const data=await request();if(live())draw(data,{focus});}
  catch(e){if(!live())return;const retry=el('button',{type:'button',class:'ui-button',onclick:()=>load('refresh')},t('Zkusit znovu'));
   content.replaceChildren(el('p',{class:'set-status bad',role:'alert'},e.message),retry);if(focus)retry.focus();}
 }
 function draw(data,{focus,saved}={}){
  const status=el('p',{class:`set-status${saved?' good':''}`,role:'status'},saved?t('Uloženo.'):'');
  const toggle=el('input',{id:'semantic-enabled',type:'checkbox',checked:data.enabled?'':null,disabled:!data.configured?'':null,'aria-describedby':data.configured?null:'semantic-provider-missing',onchange:async()=>{
   toggle.disabled=true;status.className='set-status';status.textContent=t('Ukládám…');
   try{const next=await request({enabled:toggle.checked});if(live())draw(next,{focus:'toggle',saved:true});}
   catch(e){if(live()){toggle.checked=data.enabled;toggle.disabled=!data.configured;status.textContent=e.message;status.className='set-status bad';toggle.focus();}}
  }});
  const refresh=el('button',{type:'button',class:'ui-button',onclick:()=>load('refresh')},t('Obnovit stav'));
  const provider=data.configured?el('p',{class:'set-dim'},t('Poskytovatel je nastaven. Model: {model}',{model:data.model??'—'}))
   :banner({tone:'warn',body:t('Nejdřív nastav poskytovatele na serveru a restartuj Home Hub. Potom lze hledání zapnout tady.')});
  if(!data.configured)provider.setAttribute('id','semantic-provider-missing');
  content.replaceChildren(
   el('section',{class:'set-card'},el('h3',{},t('Hledání')),
    el('p',{},t('Fulltext je výchozí. Hledá přesné chyby, identifikátory, metadata příloh a podporovaný textový obsah.')),
    el('label',{class:'set-toggle',for:'semantic-enabled'},toggle,t('Povolit sémantické hledání')),
    el('p',{class:'set-dim'},t('Volitelné hledání podle významu pro tickety. Obsah ticketů a přijatých textových příloh se odešle nastavenému poskytovateli embeddingů. Fulltext zůstává výchozí i po zapnutí.')),
    provider,statusList(data),status,refresh),
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
  if(focus==='toggle')toggle.focus();else if(focus==='refresh')refresh.focus();
 }
 load();return el('div',{class:'set'},pageHeader({eyebrow:t('Správa'),title:t('Nastavení platformy'),lead:t('Nastavení pro všechny uživatele Home Hubu.')}),content);
}
