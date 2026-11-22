// The update check in the browser (server/core/updates.mjs, GET /api/updates): the release block on the
// "Home Hub update check" card of Administration → Integrations, and what the footer needs to point at a
// newer release. Home Hub only tells; nothing here installs anything.
// Text-safe DOM only: the release text is somebody else's prose and lands in a text node, never as HTML,
// and the only link made from the answer must lead to the repository's releases on GitHub.
import {el} from './views.js';
import {authGuard,sessionTicket} from './session-cache.js';
import {t,say,locale} from './i18n.js';
import {timeZone} from './site.js';
import {toast} from './ui.js';

export async function loadUpdates(){
 const lost=authGuard(),r=await fetch('/api/updates',{signal:AbortSignal.timeout(15000)});
 if(!r.ok){lost(r);throw new Error('updates');}
 return r.json();
}
/** The release page, or null when the address is not under https://github.com/<repo>/releases/. */
export function releaseLink(u){
 const url=u?.latest?.url,prefix=typeof u?.repo==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(u.repo)?`https://github.com/${u.repo}/releases/`:null;
 return prefix&&typeof url==='string'&&url.startsWith(prefix)&&!/[\s<>"'`\\]/.test(url)?url:null;
}
/** The command that applies the newest release (docs/updating.md), or null when the answer holds none of that shape. */
export const applyCommand=u=>typeof u?.apply?.command==='string'&&/^node scripts\/update\.mjs apply v[0-9A-Za-z.+-]{1,64}$/.test(u.apply.command)?u.apply.command:null;
/** What the footer shows an administrator: only a newer release that is known and was not dismissed. */
export const footerHint=u=>u&&u.updateAvailable===true&&!u.dismissed&&typeof u.latest?.version==='string'?{latest:u.latest.version}:null;
const announce=u=>{try{dispatchEvent(new CustomEvent('updateschange',{detail:u}));}catch{}};
const day=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',timeZone:timeZone()}).format(new Date(v)):'';

function packageSelection(box,u){
 const releases=u.package?.releases??[];if(!releases.length)return null;
 const panel=el('div',{class:'up-package'}),select=el('select',{'aria-label':t('Vybrané vydání')}),details=el('div',{});
 for(const release of releases)select.append(el('option',{value:release.tag},release.version));
 const render=()=>{const r=releases.find(r=>r.tag===select.value)??releases[0];
  const commands=Object.entries(r.commands??{}).filter(([,command])=>typeof command==='string'&&/^node scripts\/update\.mjs (?:download|preflight|apply) [A-Za-z0-9._ /-]+$/.test(command));
  details.replaceChildren(...[
   el('p',{},t('Běží {installed}; vybráno {selected}.',{installed:u.installed.label,selected:r.version})),
   el('p',{},t('Vydavatel / repozitář: {repo}',{repo:u.repo})),
   el('p',{},t('Otisk manifestu: {digest}',{digest:r.manifestDigest??t('Neznámý')})),
   el('p',{},t('Podpis: {signature}; kompatibilita: {compatibility}.',{signature:t('Dosud neověřený'),compatibility:t('Neznámá')})),
   el('p',{class:'ig-dim'},t('Požadavek na Node a změnu datového formátu ověří podepsaný manifest a místní preflight. Úplná kompatibilita instance zatím není známá.')),
   el('p',{class:'ig-dim'},t('Zjištěno: {time}; kryptograficky ověřeno: {verified}.',{time:u.checkedAt??t('Neznámý'),verified:r.verifiedAt??t('Dosud neověřeno')})),
   (r.quarantine||u.quarantined?.version===r.version)?el('p',{},t('Tohle vydání se tu zkoušelo a vrátilo zpět.')):null,
   ...r.assets.filter(a=>typeof a.url==='string'&&a.url.startsWith(`https://github.com/${u.repo}/releases/download/`)).map(a=>el('p',{},el('a',{href:a.url,rel:'noopener noreferrer'},a.name))),
   el('p',{},t('Příkazy spouští správce na serveru s místní důvěrou. Pro přechod z Gitu přidej --migrate-from-git. Stahování připne ověřený otisk; použij jej i v dalších příkazech.')),
   ...commands.map(([,command])=>el('code',{class:'up-command'},command)),
  ].filter(Boolean));};select.addEventListener('change',render);render();panel.append(el('label',{},t('Vybrané vydání'),select),details);return panel;
}

function paint(box,u){
 announce(u);
 const latest=u.latest;
 if(!latest){box.hidden=true;box.replaceChildren();return;}
 const link=releaseLink(u),date=day(latest.publishedAt);
 const dismiss=u.updateAvailable&&!u.dismissed?el('button',{type:'button',class:'ui-button small quiet',onclick:async e=>{
  const button=e.currentTarget;button.disabled=true;
  try{
   const lost=authGuard(),r=await fetch('/api/updates/dismiss',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:latest.version}),signal:AbortSignal.timeout(15000)});
   const data=await r.json().catch(()=>({}));if(!r.ok){lost(r);throw new Error(t(data.error?.message||'Požadavek selhal.'));}
   toast.good(t('Vydání {version} se už v patičce nepřipomíná.',{version:latest.version}));paint(box,data.updates);
  }catch(err){toast.bad(err.message);button.disabled=false;}}},t('V patičce nepřipomínat')):null;
 box.hidden=false;
 // replaceChildren() would print a missing part as the word "null": only the parts that exist go in.
 box.replaceChildren(...[
  el('p',{class:'up-head'},el('b',{},t('Vydání {version}',{version:latest.version})),date?el('span',{class:'ig-dim'},` · ${date}`):null,
   link?el('a',{href:link,target:'_blank',rel:'noopener noreferrer'},t('Otevřít na GitHubu')):null),
  // The command is the server's own text for a plain release tag (GET /api/updates → apply.command); it goes in a text node.
  u.updateAvailable?el('p',{},applyCommand(u)?t('Home Hub se neaktualizuje sám. Na serveru spusť v jeho checkoutu příkaz níže: zkontroluje vydání {tag} podle místní politiky, zazálohuje data, přepne, restartuje a při potížích se vrátí zpět. Postup je v docs/updating.md.',{tag:latest.tag})
   :t('Home Hub se neaktualizuje sám. Aktualizaci provede správce na serveru příkazem scripts/update.mjs; postup je v docs/updating.md.')):null,
  u.updateAvailable&&applyCommand(u)?el('code',{class:'up-command'},applyCommand(u)):null,
  latest.notes?el('details',{class:'up-notes',...(u.updateAvailable?{open:''}:{})},el('summary',{},t('Poznámky k vydání')),el('pre',{},latest.notes)):null,
  packageSelection(box,u),
  dismiss,u.updateAvailable&&u.dismissed?el('p',{class:'ig-dim'},t('V patičce se tohle vydání nepřipomíná.')):null].filter(Boolean));
}
/** The block under the card's summary. It fills in once the answer is here and stays out of the way otherwise. */
export function updateDetails(){
 const box=el('div',{class:'up-box',hidden:''});
 loadUpdates().then(u=>paint(box,u)).catch(()=>{});
 return box;
}

// Settings shows the cached result for everyone. Only an administrator's password session can check now.
export function updateStatusCard({canCheck=false}={}){
 const live=sessionTicket(),body=el('div',{'aria-live':'polite'},t('Načítám…'));
 const feedback=el('p',{class:'set-status',role:'status'});
 let checkUnavailable=true;
 const check=canCheck?el('button',{type:'button',class:'ui-button',disabled:'',onclick:async()=>{
  if(check.disabled)return;
  check.disabled=true;feedback.textContent=t('Načítám…');
  try{
   const lost=authGuard(),response=await fetch('/api/updates/check',{
    method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000),
   });
   if(!live())return;
   if(!response.ok){lost(response);const data=await response.json().catch(()=>({}));throw new Error(t(data.error?.message||'Kontrolu aktualizací se nepodařilo načíst.'));}
   const {checked,updates}=await response.json();
   if(!live())return;
   render(updates);
   feedback.textContent=checked?'':t('Používá se výsledek poslední kontroly.');
  }catch(error){if(live())feedback.textContent=error.message;}
  finally{if(live())check.disabled=checkUnavailable;}
 }},t('Zkontrolovat aktualizace')):null;
 const render=u=>{
  checkUnavailable=['disabled','env-off','no-repo'].includes(u.code);
  if(check)check.disabled=checkUnavailable;
  announce(u);
  const link=releaseLink(u);
  body.replaceChildren(el('dl',{class:'set-dl'},
   el('dt',{},t('Nainstalovaná verze')),el('dd',{},u.installed?.label??'—'),
   u.latest?el('dt',{},t('Nejnovější známé vydání')):null,
   u.latest?el('dd',{},link?el('a',{href:link,rel:'noopener noreferrer'},u.latest.version):u.latest.version):null),
   el('p',{class:'set-dim'},say(u.summary,u.summaryT)));
 };
 loadUpdates().then(u=>{if(live())render(u);}).catch(()=>{
  if(!live())return;
  body.textContent=t('Kontrolu aktualizací se nepodařilo načíst.');
  if(check){checkUnavailable=false;check.disabled=false;}
 });
 return el('section',{class:'set-card'},el('h3',{},t('Aktualizace Home Hubu')),body,check,feedback);
}
