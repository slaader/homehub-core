import {el,onLeave} from './views.js';
import {pageHeader,emptyState,loadingState,errorState} from './ui.js';
import {t} from './i18n.js';
import {sessionTicket,authGuard} from './session-cache.js';
const dash=value=>value===null||value===undefined||value===''?'—':String(value);
const table=(headers,rows)=>el('div',{class:'catalog-scroll'},el('table',{class:'catalog-table'},el('thead',{},el('tr',{},headers.map(h=>el('th',{scope:'col'},h)))),el('tbody',{},rows.map(r=>el('tr',{},r.map(c=>el('td',{},dash(c))))))));
export function deviceCatalogPage(){
 const root=el('section',{class:'device-catalog'},pageHeader({title:t('Zařízení a služby'),lead:t('Služby, sledovaný software a vazby modelů na jednotlivých zařízeních.')}),loadingState());
 const current=sessionTicket(),lost=authGuard(current),abort=new AbortController();onLeave(()=>abort.abort());
 fetch('/api/device-catalog',{signal:abort.signal}).then(async response=>{lost(response);const data=await response.json();if(!response.ok)throw new Error(data.error?.message||t('Katalog se nepodařilo načíst'));return data;}).then(data=>{
  if(!current())return;
  const names=new Map(data.devices.map(d=>[d.id,d.name])),services=new Map(data.services.map(s=>[s.id,s])),clients=new Map([...data.clients,...data.software,...data.services].map(c=>[c.id,c]));
  const content=el('div',{}),select=el('select',{'aria-label':t('Zařízení')},el('option',{value:''},t('Všechna zařízení')),data.devices.map(d=>el('option',{value:d.id},d.name)));
  const panel=(title,headers,rows,empty)=>el('section',{},el('h2',{},title),rows.length?table(headers,rows):el('p',{},empty));
  const draw=()=>{const device=select.value,has=row=>!device||row.device===device;
   content.replaceChildren(...[
    panel(t('Služby'),[t('Název'),t('Zařízení'),t('Druh'),t('Stav'),t('Adresa'),t('Port'),t('Cesta k programu'),t('Software')],data.services.filter(has).map(s=>[s.name,names.get(s.device)||s.device,s.kind,s.status,s.address,s.port,s.binary,clients.get(s.software)?.name]),t('Pro toto zařízení nejsou zapsané služby.')),
    panel(t('Software'),[t('Název'),t('Zařízení'),t('Verze'),t('Podklad')],data.software.filter(has).map(s=>[s.name,names.get(s.device)||s.device,s.version,s.status==='configured'?t('Nastavené sledování; instalace není potvrzená'):t('Zapsáno v inventáři')]),t('Pro toto zařízení není zapsaný software.')),
    panel(t('Nasazení modelů'),[t('Model'),t('Druh'),t('Zařízení'),t('Obsluhující služba'),t('Stav')],data.models.filter(has).map(m=>[m.name,m.kind,names.get(m.device)||m.device,services.get(m.service)?.name||t('Neznámé'),m.status]),t('Zatím nejsou pozorování modelů.')),
    panel(t('Klienti využívající služby'),[t('Klient'),t('Zařízení klienta'),t('Služba'),t('Zařízení služby'),t('Podklad')],data.uses.filter(u=>!device||u.targetDevice===device||clients.get(u.client)?.device===device).map(u=>[clients.get(u.client)?.name||u.client,names.get(clients.get(u.client)?.device)||clients.get(u.client)?.device||t('Neznámé'),services.get(u.service)?.name||u.targetRuntime||t('Neznámé'),names.get(u.targetDevice)||u.targetDevice,u.source==='inventory'?t('Zapsaná závislost'):t('{n} požadavků',{n:u.requests})]),t('Nejsou zapsané vazby klientů na služby.')),
    data.warnings.length?el('aside',{},el('h2',{},t('Vazby ke kontrole')),el('ul',{},data.warnings.map(w=>el('li',{},w)))):null].filter(Boolean));
  };select.addEventListener('change',draw);draw();
  root.replaceChildren(pageHeader({title:t('Zařízení a služby'),lead:t('Zařízení může poskytovat služby a využívat jiné služby. Verze softwaru a pozorování modelů mají své stávající zdroje.')}),
   data.devices.length?el('label',{},t('Zařízení '),select):emptyState({title:t('Zatím nejsou zařízení'),body:t('Začni přidáním zařízení do přehledu nebo inventáře.')}),
   el('p',{},t('Nainstalovanou službu zaregistruj skriptem pro macOS, Linux nebo Windows. Zápis uloží název, druh, cestu k programu a port; službu nespouští. '),el('a',{href:'#inventory-map/services'},t('Otevřít inventář služeb'))),content);
 }).catch(e=>{if(e.name!=='AbortError'&&current())root.replaceChildren(pageHeader({title:t('Zařízení a služby')}),errorState({title:t('Katalog není dostupný'),body:e.message}));});
 return root;
}
