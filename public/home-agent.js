// The push agent of a device on the overview (GET /api/home → devices[].agent; docs/agent.md §7, step 4): a line on
// its tile and a section on its page. A device without an agent key has agent: null and shows neither.
// "No news" is the word for an agent that went quiet: never off, offline or down. A quiet agent says nothing about
// whether the device runs, and the tile's online state does not follow it.
// refused: the integration agent.reports is turned off on this hub (GET /api/home → integrations.disabled), so the hub
// refuses every report; the line and the section say that instead of "no news", since the agent may well be sending.
// Text-safe DOM only: the version and every time land in text nodes or attributes.
import {el} from './views.js';
import {t,locale} from './i18n.js';
import {timeZone} from './site.js';
import {statusPill} from './ui.js';

const valid=iso=>typeof iso==='string'&&Number.isFinite(Date.parse(iso));
const when=iso=>valid(iso)?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:timeZone()}).format(new Date(iso)):'';
// "5 minutes ago", for when an agent was last heard.
export function since(iso,now=Date.now()){
 if(!valid(iso))return '';
 const s=Math.round((Date.parse(iso)-now)/1000),f=new Intl.RelativeTimeFormat(locale(),{numeric:'auto'});
 for(const [unit,size] of [['day',86400],['hour',3600],['minute',60]])if(Math.abs(s)>=size)return f.format(Math.round(s/size),unit);
 return t('právě teď');
}
// freshness → [label, tone]. Unknown values read as never: the page never claims more than the server said.
const STATE={fresh:['hlásí se','good'],'no-news':['žádné zprávy','warn'],never:['zatím se neozval','']};
const REFUSED=['hub hlášení nepřijímá','warn'];
export const agentState=(a,{refused=false}={})=>refused?REFUSED:STATE[a?.freshness]||STATE.never;
const SAYS={fresh:'Agent na stroji posílá zprávy.',
 'no-news':'Agent se odmlčel. Neznamená to, že je stroj vypnutý: agent třeba neběží, nebo se nedostane k hubu.',
 never:'Klíč je vydaný, ale agent zatím nic neposlal. Nainstaluj ho na stroji instalátorem s tímhle klíčem.',
 refused:'Hub hlášení agentů nepřijímá: integrace Push agenti je v Administrace → Integrace zakázaná. Agent je možná dál posílá, hub je odmítá a nic neukládá.'};

// The tile's line: "Agent · reporting", or since when there is no news, and what needs a re-install.
export function agentLine(m,{refused=false}={}){
 const a=m?.agent;if(!a||typeof a!=='object')return null;
 const [label,tone]=agentState(a,{refused});
 return el('p',{class:'hv-agent',title:a.lastReportAt?t('Naposledy se ozval {when}',{when:when(a.lastReportAt)}):null},
  el('span',{class:'hv-k'},t('Agent')),statusPill(t(label),tone),
  (refused||a.freshness==='no-news')&&a.lastReportAt?el('span',{class:'hv-agent-when'},since(a.lastReportAt)):null,
  a.behind===true?el('span',{class:'hv-agent-flag'},t('starší verze')):null,
  a.specsDiffer===true?el('span',{class:'hv-agent-flag'},t('jiný seznam sledování')):null);
}

// The device page's section. admin: the signed-in account manages the keys (Users and API → Push agents).
export function agentSection(m,{admin=false,refused=false}={}){
 const a=m?.agent;if(!a||typeof a!=='object')return null;
 const [label,tone]=agentState(a,{refused});
 const row=(k,...v)=>el('div',{},el('dt',{},k),el('dd',{},...v));
 return el('section',{class:'hv-sec hv-agent-sec'},
  el('div',{class:'hv-sec-head'},el('h2',{},t('Push agent')),el('p',{},t('Co stroj sám posílá hubu. Stav agenta neříká, jestli stroj běží.'))),
  el('dl',{class:'hv-agent-facts'},
   row(t('Stav'),statusPill(t(label),tone),el('span',{class:'hv-agent-note'},t(refused?SAYS.refused:SAYS[a.freshness]||SAYS.never))),
   row(t('Naposledy'),a.lastReportAt?el('time',{datetime:a.lastReportAt,title:when(a.lastReportAt)},`${when(a.lastReportAt)} · ${since(a.lastReportAt)}`):'—'),
   row(t('Verze agenta'),a.agentVersion?el('code',{},a.agentVersion):'—',
    a.behind===true?el('span',{class:'hv-agent-note warn'},t('Starší než hub. Aktualizuje se jen znovu spuštěným instalátorem z novější verze.')):null),
   row(t('Seznam sledování'),el('span',{class:`hv-agent-note${a.specsDiffer===true?' warn':''}`},a.specsDiffer===true?t('Liší se od seznamu v hubu. Vytvoř nový specs.txt (node scripts/agent-specs.mjs) a spusť instalátor znovu.')
    :a.specsDiffer===false?t('Stejný jako v hubu.'):t('Agent ho neposlal.')))),
  admin?el('p',{class:'hv-agent-links'},el('a',{class:'hv-badge hv-badge-link',href:'#access/agents'},t('Klíče agentů →'))):null);
}
