// The push agent's report (server/agent-report.mjs, POST /api/agent/report; docs/agent.md §3, §6): the closed
// envelope and field table, the limits, the receive time, the per-machine store and the agent audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateReport,validateSpecs,checkLine,splitSystemsRecords,systemsPartOf,FIELDS,PARTS,REPORT_LIMITS,loopbackOrigin,freshUntil} from '../server/agent-report.mjs';
import {PRIVILEGED,privilegedIds} from '../server/agent-privileged.mjs';
import {parseSystemsProbe} from '../server/systems-data.mjs';
import {parseProbe} from '../server/security-data.mjs';
import {runtimeEndpoint} from '../server/site-config.mjs';
import {hub} from './hub-helper.mjs';
import {T,rec,AT,quiet,envelope,systemsParts,reportTo,issueAgent,errorCode} from './support/agent.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const part=(records,{collectedAt=AT,interval=21600}={})=>({schema:1,collectedAt,interval,records});
const one=(name,records,platform='macos')=>validateReport(envelope({[name]:part(records)},{platform}));
const refusedOf=r=>r.refused.map(x=>({...x}));
const HEX40='0123456789abcdef0123456789abcdef01234567',SHA='a'.repeat(64);
// What a secret looks like for each kind of check: one that every pattern finds, one that only the shape patterns find.
const TOKEN='hha_'+'b'.repeat(64),JWT='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0',SHAPE=HEX40;

test('the envelope is closed: an unknown key, a missing or wrong value refuses the report, naming the field',()=>{
 const good=envelope();
 assert.equal(validateReport(good).ok,true);
 const cases=[[{...good,machine:'mini'},'machine'],[{...good,agentId:'x'},'agentId'],[(({parts,...rest})=>rest)(good),'parts'],[{...good,v:2},'v'],
  [{...good,agentVersion:'1.6'},'agentVersion'],[{...good,agentVersion:' 1.6.0'},'agentVersion'],[{...good,platform:'beos'},'platform'],[{...good,platform:'other'},'platform'],
  [{...good,sentAt:'yesterday'},'sentAt'],[{...good,sentAt:'2026-13-01T00:00:00Z'},'sentAt'],[{...good,parts:{}},'parts'],[{...good,parts:[]},'parts'],
  [{...good,parts:{'Bad Name':{}}},'parts'],[{...good,parts:Object.fromEntries(Array.from({length:17},(_,i)=>[`p${i}`,{}]))},'parts'],
  [[],'body'],[null,'body'],['x','body'],[{...good,['<img src=x>']:1},'body']];
 for(const [input,field] of cases)assert.deepEqual(validateReport(input),{ok:false,field},JSON.stringify(input).slice(0,80));
 assert.equal(validateReport({...good,agentVersion:'1.6.0+dev'}).ok,true,'build metadata is allowed');
 assert.equal(validateReport({...good,sentAt:'2026-11-13T10:00:00.123Z'}).ok,true);
 // More than 8000 lines in a report, whatever the parts: the envelope is wrong.
 const many=Array.from({length:4001},()=>rec('SWU','x'));
 assert.deepEqual(validateReport(envelope({updates:part(many),sshkeys:part(many)})),{ok:false,field:'parts'});
});

test('parts: unknown names and schemas are refused alone; intervals in range; os, updates and packages travel together',()=>{
 const r=validateReport(envelope({heartbeat:{schema:1,interval:60},telemetry:{schema:1},runtimes:{schema:2,interval:120,collectedAt:AT,data:{runtimes:[]}}}));
 assert.deepEqual(Object.keys(r.parts),['heartbeat']);
 assert.deepEqual(refusedOf(r),[{part:'telemetry',code:'unknown-part'},{part:'runtimes',code:'unknown-schema'}]);
 for(const [hb,ok] of [[{schema:1,interval:30},true],[{schema:1,interval:900},true],[{schema:1,interval:29},false],[{schema:1,interval:901},false],[{schema:1,interval:60.5},false],
  [{schema:1,interval:60,collectedAt:AT},false],[{schema:1},false],[{schema:'1',interval:60},false],[{schema:1,interval:60,extra:1},false],[[],false],
  [{schema:1,interval:60,withheld:[{tag:'SW',field:3,reason:'secret',count:2}]},true],[{schema:1,interval:60,withheld:Array(51).fill({tag:'SW',field:3,reason:'secret',count:1})},false],
  [{schema:1,interval:60,withheld:[{tag:'SW',field:3,reason:'other',count:1}]},false]])
  assert.equal(Boolean(validateReport(envelope({heartbeat:hb})).parts.heartbeat),ok,JSON.stringify(hb));
 const s=systemsParts();
 assert.deepEqual(Object.keys(validateReport(envelope(s)).parts),['os','updates','packages']);
 const alone=validateReport(envelope({os:s.os}));assert.deepEqual(refusedOf(alone),[{part:'os',code:'invalid'}],'os without its run is invalid');
 const apart=validateReport(envelope({...s,updates:{...s.updates,collectedAt:'2026-11-13T10:00:01Z'}}));
 assert.deepEqual(refusedOf(apart).map(x=>x.part).sort(),['os','packages','updates'],'a different collectedAt: none of the three');
 const interval=validateReport(envelope({...s,packages:{...s.packages,interval:43200}}));assert.equal(Object.keys(interval.parts).length,0);
 const secret=validateReport(envelope(systemsParts({packages:[rec('SW','x','cmd','v1',`/opt/${TOKEN}`)]})));
 assert.deepEqual(refusedOf(secret),[{part:'packages',code:'secret',tag:'SW',field:4},{part:'os',code:'invalid'},{part:'updates',code:'invalid'}]);
 // Caps: lines per part.
 assert.deepEqual(refusedOf(one('sshkeys',Array(4001).fill('LISTEN\ton'))),[{part:'sshkeys',code:'too-large'}]);
 assert.deepEqual(refusedOf(validateReport(envelope(systemsParts({os:Array(397).fill(rec('AUTO','k','v'))})))).find(x=>x.part==='os'),{part:'os',code:'too-large'});
 assert.equal(Object.keys(validateReport(envelope(systemsParts({os:Array(396).fill(rec('AUTO','k','v'))}))).parts).length,3,'400 os lines fit');
});

test('lines: closed tags and field counts, typed fields, 4096 bytes, no control character but the tab',()=>{
 const ok=(p,line,platform='macos')=>assert.equal(checkLine(p,line,platform),null,line);
 const no=(p,line,expected,platform='macos')=>assert.deepEqual(checkLine(p,line,platform),expected,line);
 ok('os',rec('PF','unknown'));ok('os',rec('PF','Enabled','12'));no('os',rec('PF','Enabled','12','x'),{code:'invalid',tag:'PF'});
 ok('os',rec('NFT','unknown'));ok('os',rec('NFT','accept:1 ','141','ip nat,ip filter'));
 no('os',rec('HOST','mini','Darwin','alice','2','2026-11-13T10:00:00Z'),{code:'invalid',tag:'HOST',field:4});
 no('os',rec('HOST','mini','Darwin','alice','0','2026-11-13 10:00:00'),{code:'invalid',tag:'HOST',field:5});
 no('os',rec('HW','m','c','16 GB','8'),{code:'invalid',tag:'HW',field:3});
 no('os',rec('SWU','x'),{code:'invalid',tag:'SWU'},'a tag of another part');
 no('os','<img src=x onerror=alert(1)>',{code:'invalid'},'markup is no tag, and is never echoed');
 no('os',rec('SHARE','com.apple.smbd','<b>loaded</b>'),{code:'invalid',tag:'SHARE',field:2});
 ok('os',rec('LISTEN','<img src=x onerror=alert(1)>','alice','*:22'));// text: kept as text, rendered as text by the pages
 no('os',rec('OS','x'.repeat(41),'1','b','k','arm64'),{code:'invalid',tag:'OS',field:1});
 no('updates',rec('SWU','x'.repeat(4100)),{code:'invalid',tag:'SWU'});
 no('updates',`SWU${T}a\u0007b`,{code:'invalid',tag:'SWU'});no('updates',`SWU${T}a\rb`,{code:'invalid',tag:'SWU'});
 // C1 control characters too (U+0080–U+009F: NEL, CSI, …), not only C0 and DEL.
 for(const c of ['\u0080','\u0085','\u009b','\u009f'])no('updates',`SWU${T}a${c}b`,{code:'invalid',tag:'SWU'});
 ok('updates',`SWU${T}a\u00a0b é`);// a no-break space and letters are text
 ok('updates','SWU_NONE');no('updates',rec('SWU_NONE','x'),{code:'invalid',tag:'SWU_NONE'});
 ok('updates',rec('PKGUP','apt','openssl','3.0.13-0ubuntu3.4','3.0.13-0ubuntu3.5','1'));ok('updates',rec('PKGUP_NONE','dnf','3600'));
 ok('updates',rec('WINUP','KB5034441','2024-01 Security Update','Critical','1'));no('updates',rec('WINUP','5034441','t','Critical','1'),{code:'invalid',tag:'WINUP',field:1});
 ok('packages',rec('RUN','x','absent','l'));ok('packages',rec('RUN','x','4711','l'));ok('packages',rec('RUN','x','','l'));no('packages',rec('RUN','x','up','l'),{code:'invalid',tag:'RUN',field:2});
 ok('packages',rec('SPECS',SHA));no('packages',rec('SPECS',SHA.toUpperCase()),{code:'invalid',tag:'SPECS',field:1});
 ok('sshkeys','NET');ok('sshkeys',rec('NET','10.0.0.5','172.16.0.1'));no('sshkeys',rec('NET','10.0.0.256'),{code:'invalid',tag:'NET',field:1});
 no('sshkeys',rec('NET',...Array(33).fill('10.0.0.1')),{code:'invalid',tag:'NET'});
 no('sshkeys','ACCESSGROUP',{code:'invalid',tag:'ACCESSGROUP'});ok('sshkeys',rec('ACCESSGROUP','*','alice','%admin'));
 ok('sshkeys',rec('KEY','/k','600','alice','1','OPENSSH','no',''));no('sshkeys',rec('KEY','/k','800','alice','1','OPENSSH','no',''),{code:'invalid',tag:'KEY',field:2});
 ok('sshkeys',rec('CFG','alice','nas','10.0.0.74','22','admin','~/.ssh/id_a|','',''));
 // PRIV names an id of the platform's privileged list.
 ok('os',rec('PRIV','pf-info','ok'));no('os',rec('PRIV','pf-info','ok'),{code:'invalid',tag:'PRIV',field:1},'linux');ok('os',rec('PRIV','nft','denied'),'linux');
 no('os',rec('PRIV','sshd','ok'),{code:'invalid',tag:'PRIV',field:1},'windows');
});

test('a part takes only its own tags: never a name every object inherits',()=>{
 const inherited=['constructor','__proto__','toString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable','toLocaleString','__defineGetter__'];
 for(const p of ['os','updates','packages','sshkeys'])for(const name of inherited){
  assert.deepEqual(checkLine(p,name,'macos'),{code:'invalid'},`${p}: ${name}`);
  assert.deepEqual(checkLine(p,`${name}${T}x`,'macos'),{code:'invalid'},`${p}: ${name} with a field`);
 }
 assert.deepEqual(checkLine('nothing','SWU_NONE','macos'),{code:'invalid',tag:'SWU_NONE'},'a part with no table');
 assert.deepEqual(checkLine('constructor','SWU_NONE','macos'),{code:'invalid',tag:'SWU_NONE'},'a part name every object inherits');
 // In a report, as the reviewer sent it: every part with such a line is refused, nothing is taken.
 const r=validateReport(envelope(systemsParts({os:['constructor','__proto__','toString'],updates:['SWU_NONE','hasOwnProperty'],packages:['valueOf']})));
 assert.deepEqual(Object.keys(r.parts),[]);assert.deepEqual(refusedOf(r).map(x=>[x.part,x.code]).sort(),[['os','invalid'],['packages','invalid'],['updates','invalid']]);
 const ssh=one('sshkeys',[rec('HOST','studio','Darwin','alice','0','2026-11-13T10:00:00Z'),'toString','END\tok']);
 assert.deepEqual(refusedOf(ssh),[{part:'sshkeys',code:'invalid'}]);
});

test('a name from the body is echoed and audited only when it is a name and not a secret',()=>{
 const good=envelope();
 for(const name of ['ghp_abcdefghijklmnopqrstuvwxyz0123','sk-abcdefghijklmnopqrstu','glpat-abcdefghij0123']){
  const r=validateReport({...good,[name]:1});assert.equal(r.ok,false);
  assert.ok(!JSON.stringify(r).includes(name),`envelope key ${name}`);
 }
 assert.deepEqual(validateReport({...good,['ghp_abcdefghijklmnopqrstuvwxyz0123']:1}),{ok:false,field:'body'});
 assert.deepEqual(validateReport({...good,machineName:1}),{ok:false,field:'machineName'},'a plain name is still named');
 // A part name is echoed in refused[] and the audit: one that looks like a secret refuses the report as "parts".
 for(const name of ['sk-abcdefghijklmnopqrstu','ghp_abcdefghijkl']){
  const r=validateReport(envelope({heartbeat:{schema:1,interval:60},[name]:{}}));
  assert.deepEqual(r,{ok:false,field:'parts'},name);
 }
 assert.deepEqual(refusedOf(validateReport(envelope({heartbeat:{schema:1,interval:60},telemetry:{}}))),[{part:'telemetry',code:'unknown-part'}],'a plain unknown name is refused alone');
});

test('secrets: "all" fields refuse every pattern, "named" fields not the shape patterns; the answer never holds the value',()=>{
 const sec=(p,line,field)=>{const r=checkLine(p,line,'macos');assert.equal(r?.code,'secret',line);assert.equal(r.field,field,line);};
 // A version with a 40-hex commit, an image digest, a sudo digest rule: named fields take them.
 for(const [p,line] of [['packages',rec('SW','llama.cpp','cmd',`version: 8670 (${HEX40})`,'/u/llama-server')],['packages',rec('DOCKER','web',`nginx@sha256:${SHA}`,'Up 2 days','2026-05-08T10:00:00Z')],
  ['updates',rec('BREWOUT','fmt',HEX40,HEX40)],['sshkeys',rec('SUDO','alice','rule',`(root) NOPASSWD: sha256:${SHA} /usr/bin/x`)]])assert.equal(checkLine(p,line,'macos'),null,line);
 // The same shapes in an "all" field are refused.
 sec('packages',rec('SW','x','cmd','v1',`/opt/${SHAPE}`),4);sec('os',rec('OS','macOS','26.7.1',SHAPE,'k','arm64'),3);
 // Every field type with text: a token, a JWT, an assignment.
 sec('os',rec('HOST',JWT,'Darwin','alice','0','2026-11-13T10:00:00Z'),1);
 sec('packages',rec('SW','x','cmd',`password=${'h'.repeat(12)}`,'/x'),3);
 sec('sshkeys',rec('SUDO','alice','rule',`echo ${TOKEN}`),3);
 sec('sshkeys',rec('CFG','alice','nas','10.0.0.74','22','admin','~/.ssh/id_a|',`https://alice:${'p'.repeat(10)}@jump.example.lan`,''),7);
 // Keys: the key type and the blob are typed (a FIDO type and a blob trip the patterns as text), the comment named.
 const blob='AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
 assert.equal(checkLine('sshkeys',rec('AUTH','alice','/h/.ssh/authorized_keys',`sk-ssh-ed25519@openssh.com ${blob} phone`),'macos'),null,'a FIDO key type');
 assert.equal(checkLine('sshkeys',rec('AUTH','alice','/h/.ssh/authorized_keys',`from="10.0.0.25,10.0.0.220",command="python3 -u relay.py a,b",no-pty,restrict,permitopen="127.0.0.1:8788" ssh-ed25519 ${blob} mini key`),'macos'),null);
 sec('sshkeys',rec('AUTH','alice','/f',`ssh-ed25519 ${blob} ${TOKEN}`),3);
 sec('sshkeys',rec('AUTH','alice','/f',`command="curl -H token:${'t'.repeat(20)}" ssh-ed25519 ${blob} x`),3);
 assert.equal(checkLine('sshkeys',rec('AUTH','alice','/f',`ssh-ed25519 not*base64 x`),'macos')?.code,'invalid');
 assert.equal(checkLine('sshkeys',rec('AUTH','alice','/f',`one two ssh-ed25519 ${blob}`),'macos')?.code,'invalid','one options token at most');
 assert.equal(checkLine('sshkeys',rec('KEY','/k','600','alice','1','OPENSSH','no',`256 SHA256:${'Ab1'.repeat(14)}x laptop (ED25519)`),'macos'),null,'a fingerprint is typed');
 sec('sshkeys',rec('KEY','/k','600','alice','1','OPENSSH','no',`256 SHA256:${'a'.repeat(43)} ${TOKEN} (ED25519)`),7);
 // In a report: the part is refused, naming tag and field, and nothing of the value comes back.
 const r=validateReport(envelope({sshkeys:part([rec('HOST','studio','Darwin','alice','0','2026-11-13T10:00:00Z'),rec('SUDO','alice','rule',`echo ${TOKEN}`),rec('END','ok')])}));
 assert.deepEqual(r.refused,[{part:'sshkeys',code:'secret',tag:'SUDO',field:3}]);assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test('os and sshkeys parts need HOST and END ok; HOST names the envelope\'s platform',()=>{
 const host=rec('HOST','studio','Darwin','alice','0','2026-11-13T10:00:00Z');
 assert.deepEqual(refusedOf(one('sshkeys',[host,'LISTEN\ton'])),[{part:'sshkeys',code:'invalid'}],'no END');
 assert.deepEqual(refusedOf(one('sshkeys',['LISTEN\ton','END\tok'])),[{part:'sshkeys',code:'invalid'}],'no HOST');
 assert.deepEqual(refusedOf(one('sshkeys',[host,host,'END\tok'])),[{part:'sshkeys',code:'invalid'}],'two HOST lines');
 assert.deepEqual(refusedOf(one('sshkeys',[host,'END\tok','LISTEN\ton'])),[{part:'sshkeys',code:'invalid'}],'END is last');
 assert.deepEqual(one('sshkeys',[host,'END\tok']).refused,[]);
 assert.deepEqual(refusedOf(one('sshkeys',[host,'END\tok'],'linux')),[{part:'sshkeys',code:'platform-mismatch',tag:'HOST',field:2}]);
 assert.deepEqual(one('sshkeys',[rec('HOST','box','Linux','alice','1','2026-11-13T10:00:00Z'),'END\tok'],'linux').refused,[]);
});

test('runtimes: the home.runtimes shape, closed; core\'s bounds; secrets; endpoints on loopback or the bound machine\'s LAN',()=>{
 const runtime={id:'ollama',name:'Ollama',kind:'ollama',status:'running',url:'http://127.0.0.1:11434',version:'0.5.1',models:[{id:'gemma-3-27b-it-Q4_K_M.gguf',state:'loaded',sizeGb:17.2,contextTokens:8192}],stats:[{label:'tok/s',value:42}]};
 const rt=(data,opts)=>validateReport(envelope({runtimes:{schema:1,interval:120,collectedAt:AT,data}}),opts);
 assert.deepEqual(rt({runtimes:[runtime]}).refused,[]);assert.deepEqual(rt({runtimes:[]}).refused,[]);
 const code=(data,opts)=>rt(data,opts).refused[0]?.code;
 assert.equal(code({runtimes:Array.from({length:21},(_,i)=>({...runtime,id:`r${i}`}))}),'too-large');
 assert.equal(code({runtimes:[{...runtime,models:Array(31).fill(runtime.models[0])}]}),'too-large');
 assert.equal(code({runtimes:[{...runtime,stats:Array(13).fill(runtime.stats[0])}]}),'too-large');
 assert.equal(code({runtimes:[{...runtime,name:'x'.repeat(60),models:Array(30).fill({...runtime.models[0],id:'m'.repeat(120)}),stats:Array(12).fill({label:'l'.repeat(40),value:'v'.repeat(40)})}],extra:1}),'invalid');
 assert.equal(code({runtimes:[{...runtime,secretSauce:1}]}),'invalid','an unknown field');
 assert.equal(code({runtimes:[{...runtime,status:'up'}]}),'invalid');
 assert.equal(code({runtimes:[{...runtime,models:[{id:`model-${TOKEN}`}]}]}),'secret');
 assert.equal(code({runtimes:[{...runtime,url:'http://8.8.8.8:11434'}]}),'invalid','not loopback');
 assert.equal(code({runtimes:[{...runtime,url:'http://127.0.0.1:11434/api'}]}),'invalid','an origin only');
 assert.equal(code({runtimes:[{...runtime,url:'http://alice:pw@127.0.0.1:11434'}]}),'secret');
 // Big as a whole: 64 KiB.
 const big={runtimes:Array.from({length:20},(_,i)=>({...runtime,id:`r${i}`,models:Array.from({length:30},(_,j)=>({id:`${'m'.repeat(110)}${j}`,state:'loaded',engine:'e'.repeat(40),target:'t'.repeat(110)}))}))};
 assert.equal(code(big),'too-large');
 // The hub's check: runtimeEndpoint for the bound machine, with the site's networks.
 const hubCheck={runtimeUrl:url=>{try{runtimeEndpoint({machine:'studio',url},{lanCidrs:['10.0.0.0/24']});return true;}catch{return false;}}};
 assert.deepEqual(rt({runtimes:[{...runtime,url:'http://10.0.0.151:1234'}]},hubCheck).refused,[]);
 assert.equal(code({runtimes:[{...runtime,url:'http://192.168.1.5:1234'}]},hubCheck),'invalid');
 assert.equal(loopbackOrigin('http://127.0.0.1:8081'),true);assert.equal(loopbackOrigin('http://localhost:8081'),false);
 // What is stored is the origin, as runtimeEndpoint returns it, whatever spelling the URL parser forgave.
 for(const [url,origin] of [['http://0x0a000005/','http://10.0.0.5'],['HTTP://10.0.0.5','http://10.0.0.5'],['http://10.0.0.5:/','http://10.0.0.5'],['http://10.0.0.5:80','http://10.0.0.5'],['http://10.0.0.151:1234/','http://10.0.0.151:1234']]){
  const r=rt({runtimes:[{...runtime,url}]},hubCheck);assert.deepEqual(r.refused,[],url);
  assert.equal(r.parts.runtimes.data.runtimes[0].url,origin,url);
 }
 // No control character in any runtimes string: C0, DEL, C1; a tab the URL parser would drop included.
 for(const bad of [{url:'http://10.0.0.5\t/'},{url:'http://10.0.0.5\n'},{name:'Olla\u0007ma'},{name:'Olla\u0085ma'},{version:'0.5\u007f'},{stats:[{label:'tok\u009b',value:1}]},{models:[{id:'m\r'}]}])
  assert.equal(code({runtimes:[{...runtime,...bad}]},hubCheck),'invalid',JSON.stringify(bad));
});

// Every probe record of today's fixtures fits the table, but the one the note names: a shortened fingerprint that
// ssh-keygen never prints. The records are read from the four test files: each rec(...) call whose arguments are
// plain string literals (records built from expressions are skipped). A tag only the NAS probe prints is no agent tag.
const NAS_ONLY=['TNUPDATE','APP','APPUP','SERVICE','FTP'];
async function fixtureRecords(){
 const out=[];
 for(const file of ['systems.test.mjs','collectors.test.mjs','collectors-dom.test.mjs','security.test.mjs']){
  const source=await readFile(path.join(here,file),'utf8');
  for(const m of source.matchAll(/\brec\(((?:'(?:[^'\\]|\\.)*'\s*,?\s*)+)\)/g)){
   const args=[...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(a=>a[1].replace(/\\(.)/g,(_,c)=>c==='t'?'\t':c));
   out.push({file,line:args.join(T)});
  }
 }
 return out;
}
test('every record of today\'s probe fixtures is accepted, but the shortened fingerprint',async()=>{
 const records=await fixtureRecords(),refused=[];let checked=0;
 for(const {file,line} of records){
  const tag=line.split(T)[0];if(NAS_ONLY.includes(tag))continue;
  const parts=Object.keys(FIELDS).filter(p=>Object.hasOwn(FIELDS[p],tag));
  assert.ok(parts.length,`${file}: ${tag} is a tag of no part`);
  checked++;
  // Fixtures are macOS and the NAS (Linux); a line passes when it fits one part that has its tag on either platform.
  if(!parts.some(p=>['macos','linux'].some(platform=>checkLine(p,line,platform)===null)))refused.push(line);
 }
 assert.ok(checked>=100,`records checked: ${checked}`);
 assert.deepEqual([...new Set(refused)],[rec('KEY','/Users/alice/certs/privkey.pem','600','alice','1793480361','','no','256 SHA256:dddd no comment (ECDSA)')]);
});

test('one run of the systems probe splits into its three parts and parses back as the collector\'s record',()=>{
 const run=[rec('HOST','mini','Darwin','alice','0','2026-11-08T12:00:00Z'),rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),rec('UPTIME','1793827174'),rec('SWU','* Label: Safari-27.2'),
  rec('SWU','Title: Safari, Version: 27.2, Size: 250130KiB, Recommended: YES, '),rec('FW','global','0'),rec('LISTEN','launchd','root','*:22'),rec('SW','node','brew','24.1.0','node',''),
  rec('RUN','node','4711','com.example.node'),rec('BREWOUT','fmt','12.2.0','12.2.1'),rec('DOCKER','web','nginx:latest','Up 2 days','2026-05-08T10:00:00Z'),rec('SPECS',SHA),rec('END','ok')];
 const split=splitSystemsRecords(run);
 assert.deepEqual(split.updates,[run[3],run[4],run[9]]);assert.deepEqual(split.packages,[run[7],run[8],run[10],run[11]]);
 assert.equal(split.os.at(-1),'END\tok');assert.equal(systemsPartOf('LISTEN'),'os');
 const r=validateReport(envelope({os:part(split.os),updates:part(split.updates),packages:part(split.packages)}));
 assert.deepEqual(r.refused,[]);
 const joined=['os','updates','packages'].flatMap(n=>r.parts[n].records).join('\n');
 const parsed=parseSystemsProbe(joined);assert.equal(parsed.complete,true);assert.equal(parsed.osUpdates.items.length,1);assert.equal(parsed.software.node[0].value,'24.1.0');
});

test('malformed input: generated junk through validateReport and the parsers never throws',()=>{
 let seed=7;const rand=n=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed%n;};
 const alphabet=['\t','\t','\n','\r','\u0000','x','0','1','-',':','<','>','"','\'','\\','/','HOST','END','ok','SW','AUTH','KEY','SHA256:','ssh-ed25519','AAAA','=','é','\u2028','Darwin',' ','{','}','[',']'];
 const junk=()=>Array.from({length:rand(40)},()=>alphabet[rand(alphabet.length)]).join('');
 for(let i=0;i<1500;i++){
  const lines=Array.from({length:rand(12)},junk);
  for(const p of Object.keys(FIELDS))for(const line of lines)checkLine(p,line,['macos','linux','windows'][rand(3)]);
  const r=validateReport(envelope({os:part(lines),updates:part(lines),packages:part(lines),sshkeys:part(lines),runtimes:{schema:1,interval:120,collectedAt:AT,data:{runtimes:[{id:junk(),status:junk(),url:junk()}]}}}));
  assert.equal(r.ok,true);
  parseSystemsProbe(lines.join('\n'));parseProbe(lines.join('\n'));
 }
 for(const v of [undefined,0,true,'{',Symbol('x'),new Proxy({},{ownKeys:()=>{throw new Error('boom');}})])assert.equal(validateReport(v).ok,false);
 assert.equal(validateReport(envelope({os:{schema:1,interval:21600,collectedAt:AT,records:[{},null,1]}})).refused[0].code,'invalid');
});

test('the watch list on the machine: validateSpecs refuses anything a shell could read as code',()=>{
 const good=['node|cmd|/opt/homebrew/bin/node|--version|','llama|cmd|~/x/llama-b*/llama-server|--version|com.example.llama','uv|brew|uv,uv@0.9||','app|app|/Applications/Thermo.app||',
  'omlx|pydist|~/omlx/venv*/lib/python*/site-packages|omlx|','cfg|json|~/.config/x/package.json|version|system/com.example.x','x|unsupported-args|||'].map(l=>l+'\n').join('');
 assert.deepEqual(validateSpecs(good),{ok:true,lines:good.trim().split('\n'),errors:[]});
 assert.deepEqual(validateSpecs(''),{ok:true,lines:[],errors:[]},'an empty list is an empty file');
 for(const bad of ['x|cmd|/bin/sh|-c id|','x|cmd|/bin/sh|$(id)|','x|cmd|/usr/bin/`id`|--version|','x|cmd|/bin/ls;id|--version|','x|json|/a/../etc/passwd||',
  'x|app|relative/path||','x|brew|uv;id||','x|cmd|/bin/sh|--version|$(id)','x|cmd|/bin/sh|--version','x|cmd|/bin/sh|--version||extra','x y|cmd|/bin/sh|--version|',
  'x|app|/Applications/A*.app||','x|json|/a/b.json|"key"|','x|cmd|/bin/a&b|--version|','x|cmd|/bin/a>b|--version|','x|cmd|/bin/(a)|--version|',"x|cmd|/bin/'a'|--version|"])
  assert.equal(validateSpecs(bad+'\n').ok,false,bad);
 assert.equal(validateSpecs('node|cmd|/usr/bin/node|--version|').ok,false,'every line ends with a newline');
 assert.equal(validateSpecs('node|cmd|/usr/bin/node|--version|\n',{platform:'linux'}).ok,true);
 assert.equal(validateSpecs('uv|brew|uv||\n',{platform:'linux'}).ok,false,'Linux: cmd, json, pydist only');
 assert.equal(validateSpecs('x|cmd|/bin/x|--version|system/com.example.x\n',{platform:'linux'}).ok,false,'system/ only on macOS');
});

test('the privileged list: one id per command family, full paths, no wildcard',()=>{
 assert.deepEqual(privilegedIds('macos'),['pf-info','pf-rules','listen','sshd','ssh-probe']);
 assert.deepEqual(privilegedIds('linux'),['sshd','nft','listen','ssh-probe']);
 assert.deepEqual(privilegedIds('windows'),[]);
 for(const e of Object.values(PRIVILEGED).flat()){assert.ok(e.argv[0].startsWith('/'),e.id);assert.ok(!e.argv.some(a=>/[*?$`;&|<>()\s]/.test(a)),e.id);}
});

// --- over HTTP ------------------------------------------------------------------------------------------------------
const start=Date.parse('2026-11-13T10:00:00Z');
async function agentHub(t,machine='studio'){
 const clock={now:start};
 const h=await hub(t,{thermoPoller:quiet,agentClock:()=>clock.now});
 const {token,agent}=await issueAgent(h,machine);
 return {h,clock,token,agent,report:(body,headers)=>reportTo(h)(token,body,headers),state:h.handler.state('agent'),file:path.join(h.dir,'agent',`${machine}.json`)};
}

test('a report is stored at the hub\'s receive time; the machine\'s clock is information only',async t=>{
 const {clock,report,state,file,agent}=await agentHub(t);
 // collectedAt, the HOST time and sentAt a year ahead of the hub.
 const ahead='2027-11-13T10:00:00Z';
 const r=await report(envelope({heartbeat:{schema:1,interval:60},...systemsParts({collectedAt:ahead})},{sentAt:ahead}));
 assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{receivedAt:'2026-11-13T10:00:00.000Z',accepted:['heartbeat','os','updates','packages'],refused:[]});
 const doc=JSON.parse(await readFile(file,'utf8'));
 assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
 assert.deepEqual(Object.keys(doc),['schemaVersion','machine','agentId','agentVersion','platform','lastSeenAt','lastSentAt','parts']);
 assert.deepEqual([doc.schemaVersion,doc.machine,doc.agentId,doc.agentVersion,doc.platform,doc.lastSeenAt,doc.lastSentAt],[1,'studio',agent.id,'1.6.0','macos','2026-11-13T10:00:00.000Z',ahead]);
 assert.deepEqual(Object.keys(doc.parts.os),['schema','collectedAt','receivedAt','interval','digest','withheld','records']);
 assert.equal(doc.parts.os.receivedAt,'2026-11-13T10:00:00.000Z');assert.equal(doc.parts.os.collectedAt,ahead,'kept, as the machine said it');
 assert.match(doc.parts.os.digest,/^[a-f0-9]{64}$/);assert.equal(doc.parts.heartbeat.digest,null);
 // Flagged, fresh by the hub's clock, and no news after 3 × interval: never "off".
 const now=state.status('studio');
 assert.equal(now.skewed,true);assert.equal(now.clockSkewSeconds,365*86400);
 assert.deepEqual(now.parts,{heartbeat:'fresh',os:'fresh',updates:'fresh',packages:'fresh'});
 assert.deepEqual(state.status('studio',start+3*60_000+1).parts,{heartbeat:'no-news',os:'fresh',updates:'fresh',packages:'fresh'});
 assert.deepEqual(state.status('studio',start+3*21600_000+1).parts,{heartbeat:'no-news',os:'no-news',updates:'no-news',packages:'no-news'});
 assert.equal(freshUntil(doc.parts.os),start+3*21600_000,'a future collectedAt does not stretch freshness');
 // A clock a year behind: the same receive time rules.
 clock.now+=60_000;
 const behind=await report(envelope(undefined,{sentAt:'2025-11-13T10:01:00Z'}));assert.equal(behind.status,200);
 assert.equal(state.status('studio').clockSkewSeconds,-365*86400);
 assert.equal(state.record('studio').parts.heartbeat.receivedAt,'2026-11-13T10:01:00.000Z');
});

test('flooding: 20 s floor (429 with Retry-After), 512 KiB (413), per-part minimums (too-soon)',async t=>{
 const {clock,report,state}=await agentHub(t);
 assert.equal((await report(envelope({heartbeat:{schema:1,interval:60},...systemsParts()}))).status,200);
 clock.now+=5_000;
 const soon=await report(envelope());assert.equal(soon.status,429);assert.equal(await errorCode(soon),'AGENT_TOO_SOON');assert.equal(soon.headers.get('retry-after'),'15');
 clock.now+=14_500;
 const still=await report(envelope());assert.equal(still.status,429);assert.equal(still.headers.get('retry-after'),'1');
 clock.now+=500;
 // 20 s after: the report is taken, but the heartbeat (30 s minimum) and the systems run (900 s) are too soon.
 const r=await (await report(envelope({heartbeat:{schema:1,interval:60},...systemsParts({collectedAt:'2026-11-13T10:00:20Z'})}))).json();
 assert.deepEqual(r.accepted,[]);assert.deepEqual(r.refused.map(x=>[x.part,x.code]),[['heartbeat','too-soon'],['os','too-soon'],['updates','too-soon'],['packages','too-soon']]);
 assert.equal(state.record('studio').parts.os.collectedAt,AT,'not stored');
 clock.now+=20_000;
 assert.deepEqual((await (await report(envelope())).json()).accepted,['heartbeat'],'40 s after the first heartbeat');
 // Over 512 KiB: 413 before the route sees it.
 clock.now+=60_000;
 const huge=await report(JSON.stringify(envelope({updates:part(Array.from({length:200},()=>rec('SWU','x'.repeat(2700))))})));
 assert.equal(huge.status,413);assert.equal(await errorCode(huge),'TOO_LARGE');
 const notJson=await report('{"v":1,');assert.equal(notJson.status,400);
});

test('the disk: one bounded file per machine, written when something changed, the audit rate-limited; no token or body is logged',async t=>{
 const logged=[];const original={log:console.log,info:console.info,warn:console.warn,error:console.error};
 for(const k of Object.keys(original))console[k]=(...a)=>{logged.push(a.map(String).join(' '));};
 t.after(()=>Object.assign(console,original));
 const {h,clock,report,file,token}=await agentHub(t);
 const body=envelope({heartbeat:{schema:1,interval:60},...systemsParts(),sshkeys:part([rec('HOST','studio','Darwin','alice','0','2026-11-13T10:00:00Z'),rec('SUDO','alice','rule',`echo ${TOKEN}`),rec('END','ok')])});
 assert.equal((await report(body)).status,200);
 const first=(await stat(file)).size;
 // 1000 reports, 21 s apart: each refused part costs an audit line at most every ten minutes, and the file stays one copy.
 for(let i=0;i<1000;i++){clock.now+=21_000;const r=await report(envelope({heartbeat:{schema:1,interval:60},sshkeys:body.parts.sshkeys,bogus:{}}));assert.equal(r.status,200);await r.arrayBuffer();}
 const size=(await stat(file)).size;
 assert.ok(size<=first+200,`the machine file does not grow: ${first} → ${size}`);
 // Beside it only the trend, one line per machine at most every six hours (docs/agent.md §3): here the one systems run.
 assert.deepEqual((await readdir(path.join(h.dir,'agent'))).sort(),['history.jsonl','studio.json'],'nothing else beside it');
 assert.equal((await readFile(path.join(h.dir,'agent','history.jsonl'),'utf8')).trim().split('\n').length,1,'the trend is not appended per report');
 const audit=(await readFile(path.join(h.dir,'agent-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 const minutes=1000*21/60;
 assert.ok(audit.length<=3*(Math.ceil(minutes/10)+1)+1,`audit lines bounded: ${audit.length}`);
 assert.equal(audit[0].event,'agent-first-report');
 assert.ok(audit.some(e=>e.event==='agent-refused'&&e.code==='secret'&&e.detail==='sshkeys SUDO field 3'));
 assert.ok(audit.some(e=>e.code==='unknown-part'));assert.ok(audit.some(e=>e.code==='too-soon'));
 const everything=[await readFile(path.join(h.dir,'agent-audit.jsonl'),'utf8'),await readFile(file,'utf8'),await readFile(path.join(h.dir,'access-audit.jsonl'),'utf8'),...logged].join('\n');
 assert.ok(!everything.includes(token),'the agent key is in no file and no log line');
 assert.ok(!everything.includes(TOKEN),'nor is the refused secret');
 assert.ok(!logged.some(l=>/SUDO|HOST\t/.test(l)),'no body in the log');
});

test('writes: a changed digest at once, only times at most once a minute; the audit notes a new version and a return after no news',async t=>{
 const {h,clock,report,file,state}=await agentHub(t);
 const onDisk=async()=>JSON.parse(await readFile(file,'utf8'));
 assert.equal((await report(envelope())).status,200);
 clock.now+=30_000;assert.equal((await report(envelope())).status,200);
 assert.equal((await onDisk()).lastSeenAt,'2026-11-13T10:00:00.000Z','only times changed, 30 s later: not written yet');
 assert.equal(state.record('studio').lastSeenAt,'2026-11-13T10:00:30.000Z','but known');
 clock.now+=30_000;assert.equal((await report(envelope())).status,200);
 assert.equal((await onDisk()).lastSeenAt,'2026-11-13T10:01:00.000Z','a minute after the last write');
 clock.now+=30_000;assert.equal((await report(envelope({heartbeat:{schema:1,interval:60},...systemsParts()}))).status,200);
 assert.ok((await onDisk()).parts.os,'a new part is written at once');
 clock.now+=30_000;assert.equal((await report(envelope(undefined,{agentVersion:'1.7.0'}))).status,200);
 assert.equal((await onDisk()).agentVersion,'1.7.0','a new version is written at once');
 clock.now+=30_000;assert.equal((await report(envelope(undefined,{agentVersion:'1.7.0'}))).status,200);
 await state.stop();
 assert.equal((await onDisk()).lastSeenAt,'2026-11-13T10:02:30.000Z','stop flushes what was not written');
 // Quiet for a day: everything is no news; the next report says so in the audit.
 clock.now+=86400_000;assert.equal((await report(envelope(undefined,{agentVersion:'1.7.0'}))).status,200);
 const events=(await (await fetch(h.origin+'/api/admin/audit?kind=agent',{headers:h.admin})).json()).events.map(e=>[e.event,e.subject]);
 assert.deepEqual(events.reverse(),[['agent-first-report','studio'],['agent-version-changed','studio'],['agent-report-after-no-news','studio']]);
});

test('runtimes over HTTP: an endpoint inside the site networks is fine for the bound machine, a public one is not',async t=>{
 const {report,clock}=await agentHub(t);
 const data=url=>envelope({runtimes:{schema:1,interval:120,collectedAt:AT,data:{runtimes:[{id:'ollama',status:'running',url}]}}});
 assert.deepEqual((await (await report(data('http://10.0.0.151:11434'))).json()).accepted,['runtimes']);
 clock.now+=60_000;
 assert.deepEqual((await (await report(data('http://8.8.8.8:11434'))).json()).refused,[{part:'runtimes',code:'invalid'}]);
 clock.now+=60_000;
 assert.deepEqual((await (await report(data('http://127.0.0.1:11434'))).json()).accepted,['runtimes'],'loopback');
 assert.equal(PARTS.runtimes.interval.min,30);assert.equal(REPORT_LIMITS.floorSeconds,20);
});

test('the 20 s floor holds for reports that arrive together: one 200, the rest 429, a refused one gives the slot back',async t=>{
 const {report,clock,state}=await agentHub(t);
 const answers=await Promise.all(Array.from({length:10},()=>report(envelope())));
 const statuses=answers.map(r=>r.status).sort();await Promise.all(answers.map(r=>r.arrayBuffer()));
 assert.deepEqual(statuses,[200,...Array(9).fill(429)]);
 assert.equal(state.record('studio').parts.heartbeat.receivedAt,'2026-11-13T10:00:00.000Z');
 // A malformed report takes no slot: the good one right after it is accepted.
 clock.now+=20_000;
 assert.equal((await report(envelope(undefined,{v:2}))).status,400);
 assert.equal((await report(envelope())).status,200,'the 400 did not keep the slot');
});

test('the audit stays bounded when every part is refused, and when the version flaps',async t=>{
 const {h,clock,report}=await agentHub(t);
 const writer=await h.account('agent-home',['home:write']);
 await h.post('/api/home/machines',{machine:{id:'box',name:'Box',hostname:'box.example.lan',ip:'10.0.0.60',role:'computer',platform:'linux'}},writer.headers);
 const box=await issueAgent(h,'box');
 const lines=async()=>(await readFile(path.join(h.dir,'agent-audit.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 // A platform-mismatched machine: 50 reports, 21 s apart, every part refused. Nothing is stored, so it never
 // "comes back after no news".
 for(let i=0;i<50;i++){const r=await reportTo(h)(box.token,envelope());assert.equal(r.status,200);await r.arrayBuffer();clock.now+=21_000;}
 const forBox=(await lines()).filter(e=>e.agent===box.agent.id);
 assert.deepEqual(forBox.filter(e=>e.event!=='agent-refused').map(e=>e.event),['agent-first-report']);
 assert.ok(forBox.length<=4,`refusals rate-limited: ${forBox.length}`);
 // A version that flaps on every report: at most one line per ten minutes.
 for(let i=0;i<50;i++){const r=await report(envelope(undefined,{agentVersion:i%2?'1.7.0':'1.6.0'}));assert.equal(r.status,200);await r.arrayBuffer();clock.now+=21_000;}
 const changed=(await lines()).filter(e=>e.event==='agent-version-changed');
 assert.ok(changed.length>=1&&changed.length<=Math.ceil(50*21/600)+1,`version lines bounded: ${changed.length}`);
});
