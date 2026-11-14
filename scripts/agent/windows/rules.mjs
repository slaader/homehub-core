#!/usr/bin/env node
// The rules the Windows agent checks with, as data: report-rules.json beside this file, generated from the hub's own
// constants so that the PowerShell agent checks a line, a watch list and the hub's origin with exactly what the hub
// and the Node agent use (docs/agent.md → Windows: PowerShell only). The agent reads the file at every start and stops
// when it is missing or not schema 1.
//
//   node scripts/agent/windows/rules.mjs --write     write report-rules.json (after a change to one of the sources)
//   node scripts/agent/windows/rules.mjs --check     exit 1 when the file differs from what the sources give
//
// tests/agent-windows-fixtures.test.mjs fails while the file differs. Sources: the field table and limits
// (server/agent-report.mjs, FIELDS, PARTS, REPORT_LIMITS, PART_CODES), the secret patterns (server/secret-patterns.mjs),
// semver (server/semver.mjs), the watch-list rules (validateSpecs's id and label, read from its source because they are
// not exported; WINREG_NAME), the hub origin rules (server/endpoint-http.mjs, read from its source for the same reason).
//
// The typed values (num, iso, kb, run, sha256) are written as regular expressions with [0-9] where the hub's code has
// \d or a test of its own: .NET's \d also matches digits of other scripts, which the hub refuses. The secret patterns
// are translated (asciiPattern): .NET's \b, \w, \d and \s are Unicode-aware and its IgnoreCase folds more than
// JavaScript's, so a boundary after a non-ASCII letter ("Gitč" + a key) is one to the hub and none to .NET, and the
// agent would send a line the hub refuses. The translation spells each of them out in ASCII (a boundary as lookarounds
// on [A-Za-z0-9_], a letter of an "i" pattern as [xX]), so .NET and JavaScript read the pattern the same way.
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FIELDS,PARTS,REPORT_LIMITS,PART_CODES,HOST_PLATFORM} from '../../../server/agent-report.mjs';
import {SECRET_PATTERNS} from '../../../server/secret-patterns.mjs';
import {SEMVER} from '../../../server/semver.mjs';
import {WINREG_NAME} from '../../../server/watch-rules.mjs';
import {CERT_PIN} from '../../../server/endpoint-http.mjs';
import {WINDOWS_SPEC_KINDS} from './specs.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..','..','..');
export const RULES_FILE=path.join(here,'report-rules.json');
// The tags the Windows agent prints, per part (HomeHubAgent.psm1). No PRIV (Windows has no privileged list), no sshkeys.
export const WINDOWS_TAGS=Object.freeze({
 os:Object.freeze(['HOST','OS','HW','UPTIME','LISTEN','DEFENDER','BITLOCKER','WINFW','RDP','ERROR','END']),
 updates:Object.freeze(['WINUP','WINUP_NONE','WINUP_ERR']),
 packages:Object.freeze(['SW','RUN','SPECS'])});
// The parts it sends, in this series: the heartbeat and one run of the systems probe.
export const WINDOWS_PARTS=Object.freeze(['heartbeat','os','updates','packages']);
const TYPES=Object.freeze({num:'^[0-9]{0,20}$',iso:'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$',kb:'^KB[0-9]{1,10}$',
 run:'^(absent|loaded|[0-9]{0,10})$',sha256:'^[a-f0-9]{64}$'});

// A constant regular expression of a source file that does not export it: `const NAME=/…/` (or `,NAME=/…/`).
export function sourceRegex(file,name){
 const text=readFileSync(path.join(root,file),'utf8');
 const m=new RegExp(`(?:const |,)${name}=\\/((?:\\\\.|[^/\\\\\\n])+)\\/([a-z]*)[,;]`).exec(text);
 if(!m)throw new Error(`${name} not found in ${file}`);
 return {source:m[1],flags:m[2]};
}
// JavaScript's \s without the u flag, and its word characters.
const JS_SPACE='\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff',WORD='A-Za-z0-9_';
const BOUNDARY=`(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`,NOT_BOUNDARY=`(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
const OUTSIDE={b:BOUNDARY,B:NOT_BOUNDARY,d:'[0-9]',D:'[^0-9]',w:`[${WORD}]`,W:`[^${WORD}]`,s:`[${JS_SPACE}]`,S:`[^${JS_SPACE}]`};
const INSIDE={d:'0-9',w:WORD,s:JS_SPACE};
const letter=c=>/^[A-Za-z]$/.test(c),other=c=>c===c.toLowerCase()?c.toUpperCase():c.toLowerCase();
/** A JavaScript pattern (no u flag; flags "" or "i") → one that .NET (CultureInvariant, never IgnoreCase) and
 *  JavaScript (no flags) read alike: no \b \B \d \D \w \W \s \S and no case folding left. Throws on what it does not
 *  know how to spell (a negated class escape inside [...], a range across letters and other characters, a dot). */
export function asciiPattern(source,flags=''){
 if(!/^i?$/.test(flags))throw new Error(`flags ${flags}`);
 const ci=flags==='i';let out='',i=0;
 while(i<source.length){
  const c=source[i];
  if(c==='\\'){const e=source[i+1];if(e===undefined)throw new Error('a trailing backslash');
   if(Object.hasOwn(OUTSIDE,e))out+=OUTSIDE[e];else if(/[A-Za-z0-9]/.test(e))throw new Error(`the escape \\${e}`);else out+='\\'+e;
   i+=2;continue;}
  if(c==='.')throw new Error('a dot');
  if(c==='['){
   let j=i+1,body='';
   if(source[j]==='^'){body+='^';j++;}
   const items=[];
   while(j<source.length&&source[j]!==']'){
    if(source[j]==='\\'){const e=source[j+1];
     if(Object.hasOwn(INSIDE,e))items.push({raw:INSIDE[e]});else if(/[DWSbB]/.test(e)||/[A-Za-z0-9]/.test(e))throw new Error(`the class escape \\${e}`);else items.push({ch:'\\'+e,lit:e});
     j+=2;continue;}
    items.push({ch:source[j],lit:source[j]});j++;
   }
   if(source[j]!==']')throw new Error('an open class');
   for(let k=0;k<items.length;k++){
    const a=items[k],dash=items[k+1],b=items[k+2];
    if(a.lit!==undefined&&dash?.ch==='-'&&b?.lit!==undefined){
     body+=a.ch+'-'+b.ch;
     if(ci){const lo=a.lit,hi=b.lit;
      if(letter(lo)&&letter(hi)&&(lo<='Z')===(hi<='Z'))body+=other(lo)+'-'+other(hi);
      else for(let x=lo.charCodeAt(0);x<=hi.charCodeAt(0);x++)if(letter(String.fromCharCode(x)))throw new Error(`the range ${lo}-${hi}`);}
     k+=2;continue;
    }
    body+=a.raw??a.ch;
    if(ci&&a.lit!==undefined&&letter(a.lit))body+=other(a.lit);
   }
   out+='['+body+']';i=j+1;continue;
  }
  out+=ci&&letter(c)?`[${c}${other(c)}]`:c;i++;
 }
 return out;
}
const typeOf=t=>t.t==='text'?{t:'text',n:t.n,check:t.check}:t.t==='enum'?{t:'enum',v:[...t.v]}:{t:t.t};

/** The rules object report-rules.json holds. */
export function windowsRules(){
 const parts={};
 for(const [part,tags] of Object.entries(WINDOWS_TAGS)){
  parts[part]={};
  for(const tag of tags){
   const row=FIELDS[part][tag];
   if(!row||row.rest||row.restAs)throw new Error(`${part} ${tag}: not a plain row`);
   parts[part][tag]={fields:row.fields.map(typeOf),min:row.min,max:row.max};
  }
 }
 const used=new Set(Object.values(parts).flatMap(p=>Object.values(p)).flatMap(r=>r.fields).map(f=>f.t).filter(t=>t!=='text'&&t!=='enum'));
 for(const t of used)if(!Object.hasOwn(TYPES,t))throw new Error(`no rule for the type ${t}`);
 const plainRegex=(file,name)=>{const r=sourceRegex(file,name);if(r.flags)throw new Error(`${name}: flags`);return r.source;};
 return {
  $comment:'Generated by node scripts/agent/windows/rules.mjs --write from the hub\'s constants; do not edit. The Windows agent reads it at every start.',
  schema:1,
  platform:'windows',host:HOST_PLATFORM.windows,
  limits:{body:REPORT_LIMITS.body,lineBytes:REPORT_LIMITS.lineBytes,lines:REPORT_LIMITS.lines,withheld:REPORT_LIMITS.withheld,floorSeconds:REPORT_LIMITS.floorSeconds},
  intervals:Object.fromEntries(WINDOWS_PARTS.map(p=>[p,{...PARTS[p].interval}])),
  caps:Object.fromEntries(WINDOWS_PARTS.filter(p=>PARTS[p].cap).map(p=>[p,PARTS[p].cap])),
  partCodes:[...PART_CODES],
  control:'[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f]',
  tag:'^[A-Z][A-Z0-9_]{0,19}$',
  secret:SECRET_PATTERNS.map(([re,,shape])=>({pattern:asciiPattern(re.source,re.flags),ignoreCase:false,shape})),
  types:{...TYPES},
  parts,
  specs:{kinds:[...WINDOWS_SPEC_KINDS],id:plainRegex('server/agent-report.mjs','SPEC_ID'),label:plainRegex('server/agent-report.mjs','LABEL'),displayName:WINREG_NAME.source},
  hub:{host:plainRegex('server/endpoint-http.mjs','HOST'),ipv4:plainRegex('server/endpoint-http.mjs','IPV4'),pin:CERT_PIN.source},
  semver:SEMVER.source,
 };
}
export const rulesText=()=>JSON.stringify(windowsRules(),null,1)+'\n';

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];
 if(mode==='--write'){writeFileSync(RULES_FILE,rulesText());console.log(`wrote ${path.relative(root,RULES_FILE)}`);}
 else if(mode==='--check'){const same=readFileSync(RULES_FILE,'utf8')===rulesText();console.log(same?'report-rules.json is current':'report-rules.json differs: run node scripts/agent/windows/rules.mjs --write');process.exitCode=same?0:1;}
 else{console.error('node scripts/agent/windows/rules.mjs --write | --check');process.exitCode=2;}
}
