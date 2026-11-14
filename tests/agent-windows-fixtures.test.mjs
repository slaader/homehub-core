// The Windows push agent (docs/agent.md → Windows: PowerShell only; step 5). There is no PowerShell in core's test run,
// so nothing here runs a script: it checks what the scripts are and what they send.
//   - the envelope fixtures (tests/fixtures/agent-windows/report-*.json), what the agent emits, pass the real
//     validateReport, are taken by the hub over HTTP from a Windows agent key, and are read by the step-2 readers as
//     reader kind "windows" with the Windows checks;
//   - the shared vectors (vectors.json) give the hub's own code (validateSpecs, parseHub, checkLine) the answers the
//     PowerShell agent must give too; home-hub-agent.ps1 -SelfTest runs the same file (check-scripts.ps1, the owner's
//     check where PowerShell exists);
//   - report-rules.json, which the agent checks with, is exactly what rules.mjs makes from the hub's constants;
//   - the hub's side of the winreg detect kind (the watch list, the specs generator);
//   - the script text: nothing forbidden (no code from elsewhere, no update installed, no certificate check turned off),
//     Windows PowerShell 5.1 syntax, writes only into its own state, the key never on a command line, in the
//     environment or in a log.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateReport,validateSpecs,checkLine,FIELDS,REPORT_LIMITS} from '../server/agent-report.mjs';
import {parseSystemsProbe,agentSystemsHost,buildSystems,systemsSpecs,specsFileText} from '../server/systems-data.mjs';
import {validateItem,DETECT_KINDS} from '../server/software-watch.mjs';
import {CERT_PIN} from '../server/endpoint-http.mjs';
import {parseHub} from '../scripts/agent/config.mjs';
import {agentSpecs} from '../scripts/agent-specs.mjs';
import {validateWindowsSpecs,matchDisplayName,WINDOWS_SPEC_KINDS} from '../scripts/agent/windows/specs.mjs';
import {windowsRules,rulesText,asciiPattern,RULES_FILE,WINDOWS_TAGS,WINDOWS_PARTS} from '../scripts/agent/windows/rules.mjs';
import {SECRET_PATTERNS} from '../server/secret-patterns.mjs';
import {WINREG_NAME} from '../server/watch-rules.mjs';
import {existsSync} from 'node:fs';
import {readerHub} from './support/readers.mjs';
import {quiet,reportTo,issueAgent} from './support/agent.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FIX=path.join(root,'tests','fixtures','agent-windows'),WIN=path.join(root,'scripts','agent','windows');
const json=f=>JSON.parse(readFileSync(path.join(FIX,f),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const REPORTS=readdirSync(FIX).filter(f=>/^report-.*\.json$/.test(f)).sort();
const vectors=json('vectors.json');
const specsBytes=readFileSync(path.join(FIX,'specs.txt'));
// What the hub keeps for a machine after it accepted a report (server/agent-store.mjs), for the readers.
const stored=(report,receivedAt='2026-11-13T10:01:13.000Z')=>({schemaVersion:1,machine:'winbox',agentId:'0123456789abcdef',agentVersion:report.agentVersion,platform:report.platform,
 lastSeenAt:receivedAt,lastSentAt:report.sentAt,parts:Object.fromEntries(Object.entries(report.parts).map(([n,p])=>[n,{...p,receivedAt,digest:'0'.repeat(64),withheld:p.withheld||[]}]))});
// The watch list the fixtures were made for: a winreg rule per item of specs.txt.
const registry={categories:{tools:'Tools'},items:[
 {id:'git',name:'Git',category:'tools',upstream:{type:'none'},detect:{winbox:{kind:'winreg',displayName:'Git'}}},
 {id:'7zip',name:'7-Zip',category:'tools',upstream:{type:'none'},detect:{winbox:{kind:'winreg',displayName:'7-Zip*'}}},
 {id:'node',name:'Node.js',category:'tools',upstream:{type:'none'},detect:{winbox:{kind:'winreg',displayName:'Node.js'}}},
 {id:'example-agent',name:'Example Agent',category:'tools',upstream:{type:'none'},detect:{winbox:{kind:'winreg',displayName:'Example Agent*',launchd:'ExampleSvc'}}},
 {id:'example-tool',name:'Example Tool',category:'tools',upstream:{type:'none'},detect:{winbox:{kind:'winreg',displayName:'Example Tool',launchd:'ExampleToolSvc'}}}]};

// --- the PowerShell text --------------------------------------------------------------------------------------------
const PS_FILES=readdirSync(WIN).filter(f=>/\.ps(m?)1$/.test(f)).sort();
const raw=f=>readFileSync(path.join(WIN,f),'utf8');
// The code of a PowerShell file with every comment and string blanked (line breaks kept, so offsets and lines stay).
export function psCode(text){
 const blank=s=>s.replace(/[^\n]/g,' ');
 let out='',i=0;
 const take=end=>{out+=blank(text.slice(i,end));i=end;};
 while(i<text.length){
  const c=text[i],n=text[i+1];
  if(c==='<'&&n==='#'){const j=text.indexOf('#>',i+2);take(j<0?text.length:j+2);continue;}
  if(c==='#'){const j=text.indexOf('\n',i);take(j<0?text.length:j);continue;}
  if(c==='@'&&(n==="'"||n==='"')&&/[\r\n]/.test(text[i+2]||'')){const j=text.indexOf(`\n${n}@`,i+2);take(j<0?text.length:j+3);continue;}
  if(c==="'"){let j=i+1;for(;j<text.length;j++){if(text[j]==="'"){if(text[j+1]==="'"){j++;continue;}break;}}take(j+1);continue;}
  if(c==='"'){let j=i+1;for(;j<text.length;j++){if(text[j]==='`'){j++;continue;}if(text[j]==='"'){if(text[j+1]==='"'){j++;continue;}break;}}take(j+1);continue;}
  out+=c;i++;
 }
 return out;
}
const lineOf=(text,index)=>text.slice(0,index).split('\n').length;
// The body of a function: from its name to the brace that closes it, in blanked code.
function functionSpan(code,name){
 const at=code.search(new RegExp(`function ${name}\\b`));
 assert.ok(at>=0,`function ${name}`);
 let i=code.indexOf('{',at),depth=0;
 for(;i<code.length;i++){if(code[i]==='{')depth++;else if(code[i]==='}'&&--depth===0)break;}
 return [at,i];
}

test('report-rules.json is exactly what rules.mjs makes from the hub\'s constants (node scripts/agent/windows/rules.mjs --write)',()=>{
 assert.equal(readFileSync(RULES_FILE,'utf8'),rulesText());
 const r=windowsRules();
 assert.deepEqual(Object.keys(r.parts),['os','updates','packages']);
 for(const [part,tags] of Object.entries(WINDOWS_TAGS))for(const tag of tags)assert.ok(Object.hasOwn(FIELDS[part],tag),`${part} ${tag} is a tag of the field table`);
 assert.deepEqual(r.specs.kinds,[...WINDOWS_SPEC_KINDS]);
 assert.equal(r.limits.lineBytes,REPORT_LIMITS.lineBytes);
 // The rules the agent compiles are valid expressions here too.
 for(const s of [r.control,r.tag,...Object.values(r.types),r.specs.id,r.specs.label,r.specs.displayName,r.hub.host,r.hub.ipv4,r.hub.pin,r.semver,...r.secret.map(x=>x.pattern)])assert.doesNotThrow(()=>new RegExp(s),s);
});

test('envelope fixtures: what the Windows agent emits passes the real validateReport, every part accepted',()=>{
 assert.deepEqual(REPORTS,['report-degraded.json','report-first-run.json','report-full.json','report-heartbeat.json']);
 for(const f of REPORTS){
  const report=json(f),v=validateReport(report);
  assert.equal(v.ok,true,f);assert.deepEqual(v.refused,[],f);
  assert.deepEqual(Object.keys(v.parts),Object.keys(report.parts),f);
  assert.equal(report.platform,'windows');
  assert.ok(Object.keys(report.parts).every(p=>WINDOWS_PARTS.includes(p)),`${f}: no sshkeys and no runtimes part on Windows`);
  for(const [name,part] of Object.entries(report.parts)){
   for(const line of part.records||[]){
    const tag=line.split('\t')[0];
    assert.ok(WINDOWS_TAGS[name].includes(tag),`${f}: ${name} ${tag} is a tag the Windows agent prints`);
    assert.equal(checkLine(name,line,'windows'),null,`${f}: ${line}`);
   }
  }
  if(report.parts.os){
   const host=report.parts.os.records[0].split('\t');
   assert.deepEqual([host[0],host[2],host[4]],['HOST','Windows','0'],'HOST: Windows, never root');
   assert.equal(report.parts.os.records.some(l=>l.startsWith('PRIV\t')),false,'no PRIV line: the Windows privileged list is empty');
   const {collectedAt,interval}=report.parts.os;
   for(const n of ['updates','packages'])assert.deepEqual([report.parts[n].collectedAt,report.parts[n].interval],[collectedAt,interval],'one run of the probe');
   assert.equal(report.parts.packages.records.at(-1).split('\t')[0],'SPECS','SPECS last');
  }
 }
 assert.equal(json('report-full.json').parts.packages.records.at(-1),`SPECS\t${sha(specsBytes)}`,'the digest of specs.txt, its bytes');
 assert.equal(json('report-degraded.json').parts.packages.records.at(-1),`SPECS\t${sha(Buffer.alloc(0))}`,'an empty watch list');
 // A Windows record under another platform is refused, as the hub refuses it.
 const mac={...json('report-full.json'),platform:'macos'};
 assert.deepEqual(validateReport(mac).refused.find(r=>r.part==='os'),{part:'os',code:'platform-mismatch',tag:'HOST',field:2});
});

test('the readers read the fixtures as reader kind "windows" with the Windows checks and the winreg rows',()=>{
 const now=Date.parse('2026-11-13T10:05:00Z');
 const doc=buildSystems({snapshot:null,upstream:null,registry,now,machines:[],
  agents:[{id:'winbox',name:'Win box',record:stored(json('report-full.json'))},{id:'winlap',name:'Win laptop',record:stored(json('report-degraded.json'))}]});
 const at=id=>doc.machines.find(m=>m.id===id),c=(m,id)=>m.checks.find(x=>x.id===id);
 const w=at('winbox');
 assert.deepEqual([w.kind,w.source,w.reachable,w.stale,w.os.name,w.os.version,w.os.build,w.os.status],['windows','agent',true,false,'Windows 11 Pro','24H2','26100.2605','update']);
 assert.deepEqual(w.checks.map(x=>x.id),['defender','bitlocker','firewall','rdp','os-update','exposed']);
 assert.deepEqual(['defender','bitlocker','firewall','rdp','os-update','exposed'].map(id=>c(w,id).state),['ok','crit','ok','ok','warn','info']);
 assert.equal(c(w,'exposed').detail,'22 sshd · 135 svchost · 445 System','loopback ports are not exposed');
 assert.deepEqual(w.withheld,[{part:'updates',tag:'WINUP',field:1,reason:'invalid',count:1}]);
 assert.equal(w.uptimeSeconds,86400);assert.equal(w.hw.ramGb,17);
 const rows=Object.fromEntries(doc.software.filter(r=>r.machine==='winbox').map(r=>[r.id,r]));
 assert.deepEqual([rows.git.installed,rows.git.path,rows.git.status],['2.47.1','Git','n/a']);
 assert.equal(rows['7zip'].installed,'24.08');
 assert.deepEqual([rows.node.installed,rows.node.status],[null,'missing']);
 assert.deepEqual([rows['example-agent'].installed,rows['example-agent'].others,rows['example-agent'].running],['1.10.0',['1.2.0 (Example Agent)'],'running'],'winreg: the highest version, the others listed');
 assert.deepEqual([rows['example-tool'].running,rows['example-tool'].runLabel],['loaded','ExampleToolSvc']);
 const d=at('winlap');
 assert.deepEqual(['defender','bitlocker','firewall','rdp','os-update'].map(id=>c(d,id).state),['unknown','unknown','warn','info','unknown'],'what LocalService may not read is unknown, never off');
 assert.equal(c(d,'os-update').detail,'search failed (0x80070005)');
 assert.equal(c(d,'firewall').detail,'Vypnuté profily: public.');
 // The record's reader kind follows the envelope's platform: the same lines under another platform are not Windows.
 assert.equal(agentSystemsHost({...stored(json('report-full.json')),platform:'windows'}).kind,'windows');
 assert.equal(parseSystemsProbe(json('report-full.json').parts.os.records.join('\n')).platform,'windows');
});

test('over HTTP: the hub takes each fixture from a Windows agent key, and /api/systems reads it as a Windows machine',async t=>{
 const h=await readerHub(t,{thermoPoller:quiet});
 const writer=await h.account('agent-windows',['home:write']),report=reportTo(h);
 for(const [id,file] of [['winbox','report-full.json'],['winlap','report-degraded.json']]){
  const r=await h.post('/api/home/machines',{machine:{id,name:id,hostname:`${id}.example.lan`,ip:id==='winbox'?'10.0.0.61':'10.0.0.62',role:'computer',platform:'windows'}},writer.headers);
  assert.ok(r.status<300,`add ${id}: ${r.status}`);
  const key=await issueAgent(h,id);
  const answer=await report(key.token,json(file));
  assert.equal(answer.status,200,file);
  const body=await answer.json();
  assert.deepEqual([body.accepted,body.refused],[['heartbeat','os','updates','packages'],[]],file);
  // The exact Content-Type matters: a charset is refused, which is why the agent sets it itself.
  assert.equal((await report(key.token,json('report-heartbeat.json'),{'Content-Type':'application/json; charset=utf-8'})).status,403);
 }
 // The first run on a real machine: an added device whose platform was never set takes the agent's report, as it
 // did (report-first-run.json has the shape of the envelope LocalService sent, every value invented, none the machine's).
 {
  const r=await h.post('/api/home/machines',{machine:{id:'winnew',name:'winnew',hostname:'winnew.example.lan',ip:'10.0.0.63',role:'computer'}},writer.headers);
  assert.ok(r.status<300,`add winnew: ${r.status}`);
  const key=await issueAgent(h,'winnew'),answer=await report(key.token,json('report-first-run.json'));
  assert.equal(answer.status,200);
  const {accepted,refused}=await answer.json();
  assert.deepEqual([accepted,refused],[['heartbeat','os','updates','packages'],[]],'a device without a platform');
 }
 const systems=await (await fetch(`${h.origin}/api/systems`,{headers:h.admin})).json();
 const box=systems.machines.find(m=>m.id==='winbox'),lap=systems.machines.find(m=>m.id==='winlap');
 const first=systems.machines.find(m=>m.id==='winnew');
 assert.deepEqual([first.kind,first.source,first.os.version,first.checks.find(c=>c.id==='os-update').state],['windows','agent','25H2','unknown'],'the update search refused to LocalService is unknown');
 assert.deepEqual([box.kind,box.source,box.os.name],['windows','agent','Windows 11 Pro']);
 assert.deepEqual([lap.kind,lap.checks.find(c=>c.id==='defender').state],['windows','unknown']);
 assert.ok(!box.checks.some(c=>['filevault','sip','gatekeeper','ssh-password'].includes(c.id)),'never the Mac or Linux checks');
});

test('specs vectors: validateSpecs (macOS, Linux) and validateWindowsSpecs give the answers the PowerShell agent must give',()=>{
 assert.ok(vectors.specs.filter(c=>c.platform==='windows').length>=25);
 for(const c of vectors.specs){
  const r=c.platform==='windows'?validateWindowsSpecs(c.text):validateSpecs(c.text,{platform:c.platform});
  assert.deepEqual([r.ok,r.errors[0]?.line,r.errors[0]?.reason],[c.ok,c.line,c.reason],`${c.platform}: ${c.case}`);
 }
 // The rules Windows shares with validateSpecs (the file, the line, the id, the label) have a twin on another platform
 // that the frozen validateSpecs answers the same way, so the two cannot drift apart unnoticed.
 const shared=['the file must end with a newline','a line is id|kind|a|b|label','id','label','kind'];
 for(const c of vectors.specs.filter(c=>c.platform==='windows'&&!c.ok&&shared.includes(c.reason))){
  const twin=vectors.specs.find(x=>x.platform!=='windows'&&x.case===c.case);
  assert.ok(twin,`a twin for ${c.case}`);assert.deepEqual([twin.line,twin.reason],[c.line,c.reason],c.case);
 }
 // The Windows checker and the hub's generator agree on the fixture's watch list.
 assert.deepEqual(validateWindowsSpecs(specsBytes.toString('utf8')),{ok:true,lines:specsBytes.toString('utf8').trimEnd().split('\n'),errors:[]});
 assert.equal(validateSpecs(specsBytes.toString('utf8'),{platform:'windows'}).ok,false,'the frozen validateSpecs has no watch list for Windows: that is why validateWindowsSpecs exists');
});

test('hub vectors: parseHub (the Node agent) gives the verdict and the origin the PowerShell agent must give',()=>{
 for(const c of vectors.hubs){
  const r=parseHub(c.origin);
  assert.equal(Boolean(r),c.ok,JSON.stringify(c.origin));
  if(c.ok)assert.equal(r.origin,c.normalized,c.origin);
 }
});

test('line vectors: the frozen checkLine gives the verdict, the tag and the field the PowerShell agent must give',()=>{
 for(const c of vectors.lines){
  const want=c.ok?null:{code:c.code,...(c.tag?{tag:c.tag}:{}),...(c.field?{field:c.field}:{})};
  assert.deepEqual(checkLine(c.part,c.line,'windows'),want,c.case);
 }
 const rules=windowsRules();
 for(const c of vectors.lines)if(c.tag&&c.ok===false&&c.field)assert.ok(rules.parts[c.part]?.[c.tag],`${c.case}: a vector with a field names a tag the agent's rules hold`);
});

test('config vectors: the accepted ones name an origin parseHub accepts and pins CERT_PIN accepts; the refused ones each break one rule',()=>{
 for(const c of vectors.configs){
  let o=null;try{o=JSON.parse(c.text);}catch{}
  if(!c.ok)continue;
  assert.ok(o&&typeof o==='object'&&!Array.isArray(o),c.case);
  assert.ok(parseHub(o.hub),c.case);
  for(const p of o.trust?.pins||[])assert.match(p,CERT_PIN);
  assert.ok(Object.keys(o).every(k=>['schema','hub','trust','intervals','$comment'].includes(k)),c.case);
 }
 assert.ok(vectors.configs.filter(c=>!c.ok).length>=10);
});

test('the winreg detect kind: the watch list takes it, the specs generator writes it, and agent-specs checks it for Windows',()=>{
 assert.ok(DETECT_KINDS.includes('winreg'));
 assert.deepEqual(validateItem(registry.items[3],{categories:['tools']}).errors,[]);
 for(const displayName of ['Git$(x)','7-Zip (x64)','*','Git ',' Git','x'.repeat(121),'Example [x]',"Git'"])
  assert.ok(validateItem({...registry.items[0],detect:{winbox:{kind:'winreg',displayName}}},{categories:['tools']}).errors.length,displayName);
 assert.ok(validateItem({...registry.items[0],detect:{winbox:{kind:'winreg',path:'C:\\x'}}},{categories:['tools']}).errors.length,'winreg takes displayName only');
 assert.equal(specsFileText(registry,'winbox'),specsBytes.toString('utf8'),'the fixture specs.txt is what the hub prints for the watch list');
 assert.equal(systemsSpecs(registry,'winbox').split('\n')[3],'example-agent|winreg|Example Agent*||ExampleSvc');
 const r=agentSpecs({registry,machine:'winbox',platform:'windows'});
 assert.deepEqual([r.ok,r.errors],[true,[]]);
 const bad={...registry,items:[{...registry.items[0],detect:{winbox:{kind:'cmd',path:'/usr/bin/git',args:'--version'}}}]};
 assert.deepEqual(agentSpecs({registry:bad,machine:'winbox',platform:'windows'}).errors,[{line:1,reason:'kind'}],'a cmd rule is refused for a Windows machine');
});

test('the PowerShell scripts: nothing forbidden, nothing from elsewhere, read-only probes, TLS 1.2 and the exact Content-Type',()=>{
 assert.deepEqual(PS_FILES,['HomeHubAgent.psm1','check-scripts.ps1','home-hub-agent.ps1','install-agent.ps1']);
 const anywhere=/Invoke-Expression|\biex\b|SkipCertificateCheck|Set-ExecutionPolicy|wuauclt|usoclient|Install-WindowsUpdate|Start-Process|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Net\.WebClient|Download(String|File|Data)\b/i;
 const inCode=new RegExp(['\\biwr\\b','\\birm\\b','\\bcurl\\b','\\bwget\\b','\\bInstall-[A-Za-z]','\\bUpdate-[A-Za-z]','CreateUpdateInstaller','CreateUpdateDownloader','\\.Download\\(','\\.Install\\(',
  '\\bInvoke-Command\\b','\\bInvoke-Item\\b','\\bcmd(\\.exe)?\\b','\\[scriptblock\\]::Create','\\.AddScript\\(','EncodedCommand','\\bAdd-MpPreference\\b','\\bSet-MpPreference\\b','\\bSet-NetFirewall',
  '\\b(Enable|Disable|Suspend)-BitLocker\\b','\\bSet-ItemProperty\\b','\\bNew-ItemProperty\\b','CreateSubKey','SetValue\\(','DeleteSubKey','DeleteValue','OpenSubKey\\([^)]*\\$true','\\$env:\\w+\\s*=','SetEnvironmentVariable',
  'ServicePointManager\\]::ServerCertificateValidationCallback','ServerCertificateValidationCallback\\s*=\\s*\\{','ValidationCallback[^\\n]*\\{\\s*(return\\s+)?\\$true','RemoteCertificateValidationCallback\\]\\s*\\{','#Requires\\s+-Version\\s+[67]'].join('|'),'i');
 for(const f of PS_FILES){
  const text=raw(f),code=psCode(text);
  const a=anywhere.exec(text);assert.equal(a,null,`${f}:${a&&lineOf(text,a.index)}: ${a?.[0]}`);
  const b=inCode.exec(code);assert.equal(b,null,`${f}:${b&&lineOf(code,b.index)}: ${b?.[0]}`);
 }
 const mod=raw('HomeHubAgent.psm1'),modCode=psCode(mod);
 // Trust: C# compares the pins or the CA; nothing in it returns true outright, and no callback is a script block.
 const cs=/\$script:TrustSource = @'\n([\s\S]*?)\n'@/.exec(mod)?.[1];
 assert.ok(cs,'the trust class');assert.doesNotMatch(cs,/return\s+true\b|=>\s*true\b/);
 assert.match(cs,/SslPolicyErrors\.RemoteCertificateNameMismatch/);assert.match(cs,/Sha256Hex\(der\)/);
 // CA: the chain is built with the intermediates the hub sent in the handshake (a hub behind an intermediate of the
 // private CA), and the leaf must be valid for server authentication; the last element is still exactly the CA.
 const build=cs.indexOf('own.Build(');
 for(const need of ['own.ChainPolicy.ExtraStore.Add(this.ca);','foreach (X509ChainElement e in chain.ChainElements) own.ChainPolicy.ExtraStore.Add(e.Certificate);',
  'foreach (X509Certificate2 x in chain.ChainPolicy.ExtraStore) own.ChainPolicy.ExtraStore.Add(x);','own.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));']){
  const at=cs.indexOf(need);assert.ok(at>0&&at<build,need);
 }
 assert.match(cs,/accepted = Same\(own\.ChainElements\[own\.ChainElements\.Count - 1\]\.Certificate\.RawData, this\.ca\.RawData\);/);
 assert.deepEqual([...mod.matchAll(/ServerCertificateValidationCallback\s*=\s*([^\n]+)/g)].map(m=>m[1]),['$script:Trust.Callback }'],'one per-request callback, the class\'s');
 // TLS 1.2 at least, set once at start and never to Tls12 alone (that would turn TLS 1.3 off where Windows has it).
 assert.deepEqual([...mod.matchAll(/\[Net\.ServicePointManager\]::SecurityProtocol = ([^\n]+)/g)].map(m=>m[1]),['[Net.SecurityProtocolType]$want']);
 assert.match(mod,/\$now = \[int\]\[Net\.ServicePointManager\]::SecurityProtocol\n  if \(\$now -eq 0\) \{ return \}\n  \$want = \(\$now -bor \[int\]\[Net\.SecurityProtocolType\]::Tls12\) -band \(-bnot \[int\]\[Net\.SecurityProtocolType\]::Ssl3\)\n/,'SystemDefault is left to Windows; else TLS 1.2 added, SSL 3 removed');
 {const [a,b]=functionSpan(modCode,'Initialize-Agent');assert.match(modCode.slice(a,b),/\n  Set-AgentTls\n/);}
 {const [a,b]=functionSpan(modCode,'Send-AgentReport');assert.doesNotMatch(modCode.slice(a,b),/SecurityProtocol/,'not per send');}
 assert.deepEqual([...mod.matchAll(/\.ContentType\s*=\s*([^\n]+)/g)].map(m=>m[1]),["'application/json'"],'exactly application/json: the hub refuses a charset');
 assert.match(mod,/\$req\.AllowAutoRedirect = \$false/);assert.match(mod,/AutomaticDecompression = \[Net\.DecompressionMethods\]::None/);
 assert.match(mod,/\$req\.Proxy = \$null/);assert.match(mod,/65537/,'the answer is capped at 64 KiB');
 // The update search reads the agent's own cache and never asks Microsoft's servers, downloads or installs.
 assert.match(mod,/\$searcher\.Online = \$false/);assert.match(mod,/Search\('IsInstalled=0 and IsHidden=0'\)/);
 // An optional or preview update is not pending; an empty cache is an all-clear only after a recent search by Windows.
 assert.match(mod,/if \(\$u\.BrowseOnly\) \{ continue \}/);
 assert.match(mod,/Microsoft\.Update\.AutoUpdate'\)\.Results\.LastSearchSuccessDate/);
 const none=mod.indexOf("$lines.Add('WINUP_NONE')"),age=mod.indexOf('TotalDays -gt $MaxAgeDays');assert.ok(age>0&&age<none,'WINUP_NONE only after the age check');
 assert.match(mod,/Start-Job -ScriptBlock \$script:UpdateSearch -ArgumentList \$script:UpdateSearchMaxAgeDays/);
 // The firewall is read from the active store (Group Policy over the local setting), not the local store alone.
 assert.match(mod,/Get-NetFirewallProfile -CimSession \$fwSession -PolicyStore ActiveStore -ErrorAction Stop/);assert.doesNotMatch(mod,/Get-Cim 'MSFT_NetFirewallProfile'/);
 // Over a local DCOM session with an operation timeout, removed in a finally; not read: each profile unknown.
 assert.match(mod,/\$fwSession = New-CimSession -SessionOption \(New-CimSessionOption -Protocol Dcom\) -OperationTimeoutSec \$script:CimTimeoutSeconds -ErrorAction Stop\n/);
 assert.match(mod,/\} catch \{ \$profiles = \$null \} finally \{ if \(\$fwSession\) \{ Remove-CimSession -CimSession \$fwSession -ErrorAction SilentlyContinue \} \}\n  if \(\$null -eq \$profiles\) \{\n    foreach \(\$name in @\('domain', 'private', 'public'\)\) \{ \$out\.Add\(\(Join-Record 'WINFW' @\(\$name, 'unknown'\)\)\) \}/);
 assert.match(mod,/Wait-Job -Job \$Job -Timeout/);assert.match(mod,/Stop-Job -Job \$Job/);
 // The registry is only opened for reading.
 assert.ok([...modCode.matchAll(/OpenSubKey\(/g)].length>=3);for(const m of mod.matchAll(/OpenSubKey\(([^)]*)\)/g))assert.match(m[1],/,\s*\$false$/,m[0]);
 // The envelope is the Node agent's.
 assert.match(mod,/\[ordered\]@\{ v = 1; agentVersion = \$Setup\.version; platform = 'windows'; sentAt = \(Format-Iso \$SentMs\); parts = \$Parts \}/);
});

test('the PowerShell scripts are Windows PowerShell 5.1: no ternary, no ?? or ?., no && or || chains, no -Parallel, no PowerShell 7 parameters',()=>{
 const ps7=/\?|&&|\|\||-Parallel\b|-AsHashtable\b|-AsByteStream\b|-AdditionalChildPath\b|-SkipHeaderValidation\b|-ResponseHeadersVariable\b|-SslProtocol\b|\$IsWindows\b|\$IsLinux\b|\$IsMacOS\b|\bTest-Json\b|ConvertFrom-Json[^\n|]*-Depth\b|\bForEach-Object\s+-Parallel|\bclean\s*\{/i;
 for(const f of PS_FILES){
  const code=psCode(raw(f)),m=ps7.exec(code);
  assert.equal(m,null,`${f}:${m&&lineOf(code,m.index)}: ${m?.[0]}`);
  // Every brace, bracket and parenthesis outside strings and comments is closed: a cheap guard while no parser runs here.
  const pairs={'(':')','[':']','{':'}'},stack=[];
  for(const ch of code){if(pairs[ch])stack.push(pairs[ch]);else if(Object.values(pairs).includes(ch))assert.equal(stack.pop(),ch,`${f}: unbalanced ${ch}`);}
  assert.deepEqual(stack,[],`${f}: unclosed`);
 }
});

test('Windows PowerShell 5.1 at run time: the classes of error the first run on a real machine found',()=>{
 // 1. $null passed to a .NET method arrives as "" when the parameter is a string ([IO.File]::Replace($tmp, $full, $null)
 //    threw "The path is not of a legal form": no status.json after the first). [NullString]::Value is a real null.
 //    The pattern sees $null after at most one level of nested parentheses in the argument list: [X]::M((f (g)), $null)
 //    would slip through. That is accepted; the scripts have no call of that shape.
 const nullArg=/(\]::|\.)[A-Za-z]\w*\((?:[^()\n]|\([^()\n]*\))*\$null\b/g;
 for(const f of PS_FILES){
  const code=psCode(raw(f));
  const m=[...code.matchAll(nullArg)].map(x=>`${lineOf(code,x.index)}: ${x[0]}`);
  assert.deepEqual(m,[],`${f}: $null as an argument of a .NET method`);
 }
 assert.equal([...psCode('    if ($x) { [IO.File]::Replace($tmp, $full, $null) }\n').matchAll(nullArg)].length,1,'the check sees the line it replaced');
 assert.match(raw('HomeHubAgent.psm1'),/\[IO\.File\]::Replace\(\$tmp, \$full, \[NullString\]::Value\)/);
 // 2. A function that returns its array as one object (return , $x) must be assigned, never wrapped in @(): @() of
 //    that one object is an array of one element, the whole list (@(Get-UninstallEntries) made every winreg rule miss).
 const wholeIn=code=>[...code.matchAll(/\bfunction ([A-Za-z0-9-]+)/g)].map(m=>m[1]).filter(n=>{const [a,b]=functionSpan(code,n);return /\breturn\s*,/.test(code.slice(a,b));});
 const whole=new Set(PS_FILES.flatMap(f=>wholeIn(psCode(raw(f)))));
 assert.ok(whole.has('Get-UninstallEntries')&&whole.has('Get-OsRecords')&&whole.has('Receive-UpdateSearch'),'the functions that return an array whole');
 for(const f of PS_FILES){
  const code=psCode(raw(f));
  for(const n of whole){const m=new RegExp(`@\\(\\s*${n}\\b`).exec(code);assert.equal(m,null,`${f}:${m&&lineOf(code,m.index)}: @(${n} …) wraps the array it returns whole`);}
 }
 assert.match('  if (x) { $entries = @(Get-UninstallEntries) }',new RegExp('@\\(\\s*Get-UninstallEntries\\b'),'the check sees the line it replaced');
 // 3. @($null) is one element: the heartbeat, the one part without records, is skipped by the self-test, not read as one
 //    empty line. Any other part without records is a failure, so a fixture that lost its records cannot pass silently.
 assert.match(raw('home-hub-agent.ps1'),/if \(\$null -eq \$records\) \{\n\s*if \(\$p\.Name -cne 'heartbeat'\) \{ \$ran\+\+; \$failed\+\+; \[Console\]::Out\.WriteLine\([^\n]*has no records'\) \}\n\s*continue\n\s*\}\n\s*foreach \(\$line in @\(\$records\)\)/);
 for(const f of REPORTS){
  const parts=Object.entries(json(f).parts).filter(([,v])=>!Array.isArray(v.records)).map(([k])=>k);
  assert.ok(parts.every(k=>k==='heartbeat'),`${f}: only the heartbeat may have no records (${parts})`);
 }
});

test('the PowerShell scripts: every CIM, WMI and Get-Net* read is bounded by an operation timeout (the probe runs on the loop that sends the heartbeat)',()=>{
 const mod=raw('HomeHubAgent.psm1');
 assert.match(mod,/\n\$script:CimTimeoutSeconds = 30\n/);
 assert.match(mod,/\$a = @\{ ClassName = \$Class; Namespace = \$Namespace; OperationTimeoutSec = \$script:CimTimeoutSeconds; ErrorAction = 'Stop' \}/,'Get-Cim: every read with the timeout');
 const reads=/\b(Get-Net[A-Za-z]*|Get-Cim[A-Za-z]*|New-CimSession)\b(?!-)/gi;
 // A call is bounded when its line carries the timeout, or names a CimSession or a splat that the same function made
 // with it.
 const bounded=(code,at)=>{
  const ls=code.lastIndexOf('\n',at)+1,le=code.indexOf('\n',at),line=code.slice(ls,le<0?code.length:le);
  if(/-OperationTimeoutSec \$script:CimTimeoutSeconds\b/.test(line))return true;
  const fns=[...code.slice(0,at).matchAll(/\bfunction ([A-Za-z-]+)/g)];if(!fns.length)return false;
  const [fa,fb]=functionSpan(code,fns[fns.length-1][1]);if(at>fb)return false;
  const body=code.slice(fa,fb),s=/-CimSession \$(\w+)\b/.exec(line),splat=/\s@(\w+)\b/.exec(line);
  if(s)return new RegExp(`\\$${s[1]} = New-CimSession [^\\n]*-OperationTimeoutSec \\$script:CimTimeoutSeconds\\b`).test(body);
  if(splat)return new RegExp(`\\$${splat[1]} = @\\{[^\\n]*\\bOperationTimeoutSec = \\$script:CimTimeoutSeconds\\b`).test(body);
  return false;
 };
 const unbounded=text=>{
  const code=psCode(text),own=new Set([...code.matchAll(/\bfunction ([A-Za-z-]+)/g)].map(m=>m[1].toLowerCase()));
  return [...code.matchAll(reads)].filter(m=>!own.has(m[1].toLowerCase())&&!bounded(code,m.index)).map(m=>`${lineOf(code,m.index)}: ${m[1]}`);
 };
 let calls=0;
 for(const f of PS_FILES){
  const code=psCode(raw(f));
  const wmi=/\bGet-WmiObject\b|\bgwmi\b|\bGet-CimAssociatedInstance\b|\bInvoke-CimMethod\b|\[wmi(searcher|class)?\]|ManagementObjectSearcher/i.exec(code);
  assert.equal(wmi,null,`${f}:${wmi&&lineOf(code,wmi.index)}: ${wmi?.[0]}, which has no timeout here`);
  assert.deepEqual(unbounded(raw(f)),[],`${f}: a read without an operation timeout`);
  calls+=[...code.matchAll(reads)].filter(m=>m[1]!=='Get-NetErrorCode'&&m[1]!=='Get-Cim').length;
 }
 assert.ok(calls>=3,'Get-CimInstance, New-CimSession and Get-NetFirewallProfile were looked at');
 // The check itself: the unbounded firewall read this replaced, a session without the timeout and a bare
 // Get-CimInstance are refused.
 assert.equal(unbounded(mod.replace('Get-NetFirewallProfile -CimSession $fwSession -PolicyStore','Get-NetFirewallProfile -PolicyStore')).length,1);
 assert.equal(unbounded(mod.replace(' -OperationTimeoutSec $script:CimTimeoutSeconds -ErrorAction Stop\n',' -ErrorAction Stop\n')).length,2);
 assert.equal(unbounded(mod.replace('function Get-RegistryValue {','function Get-RegistryValue {\n  $x = Get-CimInstance -ClassName Win32_BIOS')).length,1);
});

test('the agent writes only into its own state and logs, through Write-AgentFile, and never shows the key',()=>{
 const writes=/\[IO\.File\]::(Write|Append|Move|Replace|Delete|Copy|Create|Open|SetAccess)|\[IO\.Directory\]::|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bNew-Item\b|\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b|\bRename-Item\b|\bSet-Item\b|\bClear-Content\b|\bSet-Acl\b|\bTee-Object\b|\bExport-(?!ModuleMember)|\bRegister-ScheduledTask\b|\bUnregister-ScheduledTask\b|StreamWriter|FileStream|>/g;
 for(const f of ['HomeHubAgent.psm1','home-hub-agent.ps1']){
  const code=psCode(raw(f)),span=f==='HomeHubAgent.psm1'?functionSpan(code,'Write-AgentFile'):[-1,-1];
  for(const m of code.matchAll(writes))assert.ok(m.index>span[0]&&m.index<span[1],`${f}:${lineOf(code,m.index)}: ${m[0]} outside Write-AgentFile`);
 }
 assert.match(raw('HomeHubAgent.psm1'),/if \(-not \$inside\) \{ throw 'write-outside-state' \}/);
 // The key: read from its file, put into the Authorization header, never into a log, an error, a command line or the environment.
 const tokenLine=/\$(script:)?token\b|\.token\b/i;
 for(const f of PS_FILES){
  const text=raw(f),code=psCode(text);
  const codeLines=code.split('\n');
  text.split('\n').forEach((line,i)=>{
   if(!tokenLine.test(codeLines[i]))return;
   // An output, an error, a job, a task or a call that takes the key as an argument (the prefix alone may be shown).
   const out=/(Write-(Host|Output|Verbose|Warning|Error|Information|Debug|Progress|AgentLog)\b|\[Console\]::\w+|\bthrow\b|\bSay\b|Stop-Install|Start-Job|Register-\w+|ArgumentList|-Argument\b|&)[^\n]*\$(script:)?token\b(?!\.Substring\(0, 12\))/i;
   assert.doesNotMatch(line,out,`${f}:${i+1}: the key passed to output or a command`);
   assert.doesNotMatch(codeLines[i],/\$env:/i,`${f}:${i+1}: the key next to the environment`);
  });
  assert.doesNotMatch(text,/"[^"\n]*\$(script:)?token/i,`${f}: the key inside a string`);
 }
 assert.deepEqual([...raw('HomeHubAgent.psm1').matchAll(/Bearer[^\n]*/g)].map(m=>m[0]),["Bearer ' + $script:Token)"]);
 const agentParams=/param\(([\s\S]*?)\n\)/.exec(raw('home-hub-agent.ps1'))[1];
 assert.doesNotMatch(agentParams,/token|key/i,'no parameter carries the key');
 const installer=raw('install-agent.ps1');
 assert.ok(installer.split('\n').filter(l=>/\bSay\b[^\n]*\$token/i.test(l)).every(l=>/\$token\.Substring\(0, 12\)/.test(l)),'the installer shows the prefix only');
});

test('the installer: LocalService, never SYSTEM; the key ACL\'d to LocalService and Administrators; a dry run, -Once, uninstall and update',()=>{
 const text=raw('install-agent.ps1'),code=psCode(text);
 const [a,b]=functionSpan(code,'Register-AgentTask'),task=text.slice(a,b);
 assert.match(task,/New-ScheduledTaskPrincipal -UserId \$account -LogonType ServiceAccount -RunLevel Limited/);
 assert.match(task,/\(New-Object Security\.Principal\.SecurityIdentifier\(\$SidLocalService\)\)\.Translate/);
 assert.doesNotMatch(task,/SidSystem|SYSTEM|Highest/);
 assert.match(text,/\$SidLocalService = 'S-1-5-19'/);
 assert.match(text,/\$KeyGrants = @\(@\{ sid = \$SidAdmins; rights = 'FullControl' \}, @\{ sid = \$SidLocalService; rights = 'Read' \}\)/);
 assert.match(text,/\$keyPath = Join-Path \$Dirs\.private 'agent\.key'\n\$keyBytes = \$Utf8\.GetBytes\(\$token \+ "`n"\)\n\$token = \$null\n\[IO\.File\]::WriteAllBytes\(\$keyPath \+ '\.new', \$keyBytes\)\nSet-PrivateAcl -Path \(\$keyPath \+ '\.new'\) -Grants \$KeyGrants\n/);
 assert.match(text,/SetAccessRuleProtection\(\$true, \$false\)/,'no inheritance from ProgramData');
 assert.match(text,/-ExecutionPolicy RemoteSigned -File/);
 for(const s of ['[switch]$DryRun','[switch]$Once','[switch]$Uninstall','SupportsShouldProcess = $true','$WhatIfPreference','Wait-FirstReport','Home Hub Agent Backups','Read-AgentSpecs $specsBytes','Read-AgentConfig $configText'])
  assert.ok(text.includes(s),s);
 // A dry run stops before anything is written, -Once included (it writes a temporary directory); -Once stops before
 // anything is written to the agent's directories.
 const firstWrite=code.search(/New-PrivateDirectory \$Root/),dry=text.search(/foreach \(\$l in \$specsCheck\.lines\) \{ Say \('    ' \+ \$l\) \}\nif \(\$Dry\) \{ Say 'Dry run: nothing changed\.'; exit 0 \}\n/),once=code.search(/\nif \(\$Once\) \{/);
 assert.ok(dry>0&&once>0&&dry<once&&once<firstWrite,'the plan is printed and checked before the first write, and a dry run stops before -Once');
 {const [a,b]=[once,code.indexOf('\n}\n',once)];assert.doesNotMatch(code.slice(a,b),/New-Item/,'-Once makes its directory with .NET (New-Item obeys -WhatIf)');}
});

// --- review fixes -----------------------------------------------------------------------------------------------------
test('the key is never a parameter: Module Logging (event 4103) records every parameter a module command is called with',()=>{
 // No param block anywhere declares a key or token.
 for(const f of PS_FILES){
  for(const m of raw(f).matchAll(/param\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g))assert.doesNotMatch(m[1],/\$(token|key|bearer|secret)\b/i,`${f}: ${m[0].slice(0,80)}`);
 }
 // Each line of code that names the key is one of these statements, each a .NET call or an assignment: never an argument
 // of a function or a cmdlet (the output of Read-AgentToken, a path's reader, is assigned, not passed on).
 const allowed=[/^\$script:Token = \$null$/,/^try \{ \$script:Token = Read-AgentToken \$KeyFile \} catch \{ \$script:Token = \$null \}$/,
  /^if \(\$null -eq \$script:Token\) \{ return (@\{ status = 0; retryAfter = \$null; ack = \$null; error = 'key-missing' \}|\(& \$no 'key-invalid' 'the key file does not hold an agent key'\)) \}$/,
  /^\$req\.Headers\.Add\('Authorization', 'Bearer ' \+ \$script:Token\)$/,
  /^\$token = \$null(; \$agentId = \$null; \$machine = \$null)?$/,/^\$token = \$found\[0\]\.Value$/,/^\$masked = \$keyText\.Replace\(\$token, \$placeholder\); \$keyText = \$null; \$found = \$null$/,
  /^if \(\(Get-Prop \$k 'schema'\) -ne 1 -or \(Get-Prop \$k 'token'\) -cne \$placeholder -or -not \(\(Get-Prop \$agentInfo 'machine'\) -is \[string\]\)\) \{ \$token = \$null; Stop-Install '[^']*' \}$/,
  /^if \(\$token\) \{ Say \('  key        ' \+ \$token\.Substring\(0, 12\) \+ '\.\.\. for machine ' \+ \$machine \+ ' -> ' \+ \(Join-Path \$Dirs\.private 'agent\.key'\)\) \}$/,
  /^\$keyBytes = \$Utf8\.GetBytes\(\$token \+ "`n"\)$/];
 for(const f of PS_FILES){
  const text=raw(f),codeLines=psCode(text).split('\n');
  text.split('\n').forEach((line,i)=>{
   if(!/\$(script:)?token\b/i.test(codeLines[i]))return;
   assert.ok(allowed.some(re=>re.test(line.trim())),`${f}:${i+1}: the key in a statement that is not a known .NET call or assignment: ${line.trim()}`);
  });
 }
 const mod=raw('HomeHubAgent.psm1'),agent=raw('home-hub-agent.ps1'),installer=raw('install-agent.ps1');
 assert.match(mod,/function Send-AgentReport \{\n  param\(\$Config, \[byte\[\]\]\$Body, \[string\[\]\]\$Sent\)/);
 assert.match(agent,/Send-AgentReport \$setup\.config \(\(New-Object/);assert.match(mod,/Send-AgentReport \$config \$body \$sent/);
 assert.doesNotMatch(mod,/token = \$token|\.token\b/i,'the setup holds no key');
 assert.doesNotMatch(/Export-ModuleMember[\s\S]*$/.exec(mod)[0],/Read-AgentToken/,'the key reader is the module\'s own');
 // The installer: the key file's text reaches ConvertFrom-Json only with the token cut out; the key is written inline.
 assert.deepEqual([...installer.matchAll(/ConvertFrom-Json -InputObject (\$masked\b|\(\[IO\.File\]::ReadAllText\(\$[\w.]+, \$Utf8|[^\n]{0,40})/g)].map(m=>m[1]).sort(),['$masked','([IO.File]::ReadAllText($f, $Utf8','([IO.File]::ReadAllText($m.FullName, $Utf8'].sort(),
  'ConvertFrom-Json reads the key file only masked (and status.json and .agent-install.json)');
 assert.doesNotMatch(installer,/Write-CheckedFile[^\n]*\$(token|keyBytes)/i);
});

test('the agent runs from a checkout: every file Initialize-Agent opens beside it is there, and the version comes from the checkout\'s package.json',()=>{
 const mod=psCode(raw('HomeHubAgent.psm1')),modText=raw('HomeHubAgent.psm1');
 const [a,b]=functionSpan(mod,'Initialize-Agent'),init=modText.slice(a,b);
 const beside=[...init.matchAll(/Join-Path \$AgentDir '([^']+)'/g)].map(m=>m[1]);
 assert.deepEqual(beside,['report-rules.json'],'Initialize-Agent opens only report-rules.json from the agent\'s directory');
 const installer=raw('install-agent.ps1');
 const agentFiles=JSON.parse('['+/\$AgentFiles = @\(([^)]*)\)/.exec(installer)[1].replaceAll("'",'"')+']');
 for(const f of beside){assert.ok(existsSync(path.join(WIN,f)),`${f} is in scripts/agent/windows`);assert.ok(agentFiles.includes(f),`the installer copies ${f}`);}
 for(const f of agentFiles)assert.ok(existsSync(path.join(WIN,f)),`the installer copies ${f}, which is in scripts/agent/windows`);
 assert.match(init,/\$version = Read-AgentVersion \$VersionFile/);assert.doesNotMatch(init,/package\.json'\)/);
 // home-hub-agent.ps1: package.json beside it (installed), else the checkout's root when it is scripts\agent\windows.
 const agent=raw('home-hub-agent.ps1');
 assert.match(agent,/\$VersionFile = Join-Path \$PSScriptRoot 'package\.json'\nif \(-not \(Test-Path -LiteralPath \$VersionFile -PathType Leaf\) -and \$PSScriptRoot -match '\[\\\\\/\]scripts\[\\\\\/\]agent\[\\\\\/\]windows\$'\) \{\n  \$VersionFile = \[IO\.Path\]::GetFullPath\(\(Join-Path \$PSScriptRoot '\.\.\\\.\.\\\.\.\\package\.json'\)\)\n\}/);
 assert.ok(/[\\/]scripts[\\/]agent[\\/]windows$/.test(WIN),'this checkout\'s directory is the one the fallback names');
 assert.ok(existsSync(path.join(WIN,'..','..','..','package.json')),'the checkout\'s package.json is three levels up');
 assert.ok(!existsSync(path.join(WIN,'package.json')),'and none beside the scripts, so the fallback is what -Once from the checkout uses');
 assert.match(agent,/Initialize-Agent -AgentDir \$PSScriptRoot -VersionFile \$VersionFile /);
 // The installed layout: package.json beside the agent; the installer's -Once runs the checkout's script.
 assert.match(installer,/\$files\['package\.json'\] = \[IO\.File\]::ReadAllBytes\(\(Join-Path \$Checkout 'package\.json'\)\)/);
 assert.match(installer,/& \(Join-Path \$PSScriptRoot 'home-hub-agent\.ps1'\) -Once -ConfigDir \$tmp/);
});

test('the installer never follows a link as an administrator, and touches only a -Root that is the agent\'s',()=>{
 const text=raw('install-agent.ps1'),code=psCode(text);
 // Nothing removes a tree with Remove-Item -Recurse (Windows PowerShell 5.1 follows a junction inside it).
 assert.doesNotMatch(code,/Remove-Item[^\n]*-Recurse/i);
 const [ra,rb]=functionSpan(code,'Remove-Tree'),walk=text.slice(ra,rb);
 const link=walk.indexOf('if (Test-Link $e) {'),down=walk.indexOf('Remove-Tree $e.FullName');
 assert.ok(link>0&&down>link,'a link is looked at before a directory is walked');
 assert.match(walk,/if \(\$isDir\) \{ \[IO\.Directory\]::Delete\(\$e\.FullName, \$false\) \} else \{ \[IO\.File\]::Delete\(\$e\.FullName\) \}/,'a link is removed as the link');
 assert.match(walk,/foreach \(\$e in @\(\$dir\.GetFileSystemInfos\(\)\)\)/,'from the directory listing');
 // A plain file: deleted first; only an access-denied read-only file with no other link (LinkType empty) has the
 // read-only bit cleared (and nothing else) and is deleted again. A hard link's attributes are its target's.
 const fileAt=walk.indexOf('try { [IO.File]::Delete($e.FullName) } catch {'),attr=walk.indexOf('$e.Attributes =');
 assert.ok(fileAt>0&&attr>fileAt,'the delete comes before any attribute change');
 assert.equal([...walk.matchAll(/\$e\.Attributes =/g)].length,1,'one attribute change');assert.doesNotMatch(walk,/FileAttributes\]::Normal/);
 assert.match(walk,/if \(-not \(\$x -is \[UnauthorizedAccessException\]\)\) \{ throw \}\n\s*\$e\.Refresh\(\)\n\s*if \(-not \(\$e\.Attributes -band \[IO\.FileAttributes\]::ReadOnly\)\) \{ throw \}/,'only access denied on a read-only file');
 const lt=walk.indexOf("$linkType = 'unknown'"),keep=walk.indexOf('if ($linkType) {\n          $script:KeptFiles.Add($e.FullName)\n        } else {');
 assert.ok(lt>fileAt&&keep>lt&&attr>keep,'more than one link, or not readable: kept; one link: cleared');
 assert.match(walk,/try \{ \$linkType = \[string\]\$e\.LinkType \} catch \{ \$linkType = 'unknown' \}/);
 assert.match(walk,/\$e\.Attributes = \[IO\.FileAttributes\]\(\[int\]\$e\.Attributes -band \(-bnot \[int\]\[IO\.FileAttributes\]::ReadOnly\)\)\n\s*\[IO\.File\]::Delete\(\$e\.FullName\)/);
 assert.match(walk,/if \(\$script:KeptFiles\.Count -eq \$kept\) \{\n    if \(\$Last\) \{\n/,'a directory holding a kept file stays, and so does its -Last');
 // -Last goes the way the walk removes any entry (a link as the link itself), and a directory still not empty then
 // (an administrator's link as the marker, an entry added since the listing) is named, never an exception.
 const last=walk.slice(walk.indexOf('if ($Last) {\n'));
 assert.match(last,/foreach \(\$e in @\(\$dir\.GetFileSystemInfos\(\) \| Where-Object \{ \$_\.Name -eq \$Last \}\)\) \{\n\s*\$isDir = [^\n]*\n\s*if \(Test-Link \$e\) \{\n\s*if \(\$isDir\) \{ \[IO\.Directory\]::Delete\(\$e\.FullName, \$false\) \} else \{ \[IO\.File\]::Delete\(\$e\.FullName\) \}\n\s*\} elseif \(-not \$isDir\) \{ \[IO\.File\]::Delete\(\$e\.FullName\) \}/);
 assert.match(last,/try \{ \[IO\.Directory\]::Delete\(\$Path, \$false\) \} catch \{\n\s*\$x = \$_\.Exception; if \(\$x\.InnerException\) \{ \$x = \$x\.InnerException \}\n\s*if \(-not \(\$x -is \[IO\.IOException\]\)\) \{ throw \}\n\s*\$script:KeptFiles\.Add\(\$Path\)\n\s*\}/);
 assert.doesNotMatch(walk,/\n\s*\[IO\.Directory\]::Delete\(\$Path, \$false\)\n/,'the last delete of Path is never outside the handler');
 const show=text.slice(...functionSpan(code,'Show-KeptFiles'));
 assert.match(show,/if \(\[IO\.Directory\]::Exists\(\$f\)\) \{\n[^\n]*not empty when it was removed last/,'a kept directory is named as one');
 assert.match(walk,/if \(\$Last -and \$e\.Name -eq \$Last\) \{ continue \}/,'-Last is skipped by the walk');
 // -Uninstall keeps .agent-install.json until nothing is left: found on a real machine, a hard link left in state made the
 // next -Uninstall (and an install) refuse the directory, the marker being gone with the first.
 assert.match(text,/Remove-Tree \$Root -Last \$Marker\n  if \(-not \(Show-KeptFiles\)\) \{ Stop-Install/,'-Uninstall names what is left and exits 1');
 assert.match(text,/Remove-Tree \$old\n  \$null = Show-KeptFiles\n/);assert.match(text,/finally \{ Remove-Tree \$tmp; \$null = Show-KeptFiles \}/);
 // -Root is checked first, for every mode; -Uninstall removes only a <Root> holding .agent-install.json.
 const rootCheck=code.indexOf('$rootWhy = Test-RootPath $Root'),uninstall=code.indexOf('if ($Uninstall) {');
 assert.ok(rootCheck>0&&rootCheck<uninstall);
 const ub=code.indexOf('\n}\n',uninstall),un=text.slice(uninstall,ub);
 const owned=un.indexOf('Test-AgentRoot $Root -Installed'),unreg=un.indexOf('Unregister-ScheduledTask'),rm=un.indexOf('Remove-Tree $Root');
 assert.ok(owned>0&&owned<unreg&&unreg<rm,'checked before the task or a file is touched');
 const [pa,pb]=functionSpan(code,'Test-RootPath'),rp=text.slice(pa,pb);
 assert.match(rp,/if \(\$Path\.EndsWith\('\\'\)\)/,'no drive root and no trailing backslash');assert.match(rp,/\[IO\.Path\]::GetFullPath\(\$Path\) -cne \$Path/);
 const [ta,tb]=functionSpan(code,'Test-AgentRoot'),tr=text.slice(ta,tb);
 assert.match(tr,/\(Get-Prop \$record 'account'\) -ceq \$SidLocalService/);assert.match(tr,/if \(\$Installed\) \{ return \$false \}\n  return \(@\(Get-ChildItem -LiteralPath \$Path -Force\)\.Count -eq 0\)/,'an install takes an empty directory, an uninstall never');
 assert.match(code,/if \(-not \$Once -and -not \(Test-AgentRoot \$Root\)\) \{ Stop-Install/);
 // state and logs are made anew, never given an ACL over what LocalService left in them; <Root> keeps its ACL on update.
 assert.match(text,/New-WritableDirectory \$Dirs\.state \$Writable\nNew-WritableDirectory \$Dirs\.logs \$Writable -Keep/);
 assert.doesNotMatch(text,/New-PrivateDirectory \$Dirs\.(state|logs)/);
 assert.match(text,/New-PrivateDirectory \$Root \$Read -KeepAcl:\$previous/);
 const [wa,wb]=functionSpan(code,'New-WritableDirectory'),wd=text.slice(wa,wb);
 const move=wd.indexOf('[IO.Directory]::Move($Path, $old)'),make=wd.indexOf('[IO.Directory]::CreateDirectory($Path)'),acl=wd.indexOf('Set-PrivateAcl -Path $Path'),carry=wd.indexOf('[IO.File]::Move($from, $to)'),gone=wd.indexOf('Remove-Tree $old');
 assert.ok(move>0&&move<make&&make<acl&&acl<carry&&carry<gone,'moved aside, made empty, ACL\'d while empty, then the old one removed');
 // Only what LocalService owns is carried over, and it is moved, never copied: a copy would be the administrator's and
 // the next update would drop it (found on a real machine). What arrives is checked again; a link or another owner's
 // file is removed as a name.
 assert.match(wd,/if \(-not \$f\.Exists -or \(Test-Link \$f\) -or \(Get-FileOwnerSid \$from\) -cne \$SidLocalService\) \{ continue \}\n\s*\[IO\.File\]::Move\(\$from, \$to\)/);
 assert.match(wd,/if \(\(Test-Link \$t\) -or \(Get-FileOwnerSid \$to\) -cne \$SidLocalService\) \{ \[IO\.File\]::Delete\(\$to\) \}/);
 assert.doesNotMatch(wd,/WriteAllBytes|Copy-Item|\[IO\.File\]::Copy/,'never a copy');
 {const [ga,gb]=functionSpan(code,'Get-FileOwnerSid');assert.match(text.slice(ga,gb),/\$fs\.GetAccessControl\(\)\.GetOwner\(/,'the owner through a handle');}
 // A rollback puts back exactly the previous files and waits for the previous agent too.
 const back=text.slice(text.indexOf('if ($backup) {\n  # The previous agent'));
 assert.match(back,/if \(\$keep -notcontains \$f\.Name\) \{ Remove-Item -LiteralPath \$f\.FullName -Force \}/);assert.match(back,/if \(Start-AgentAndWait\)/);
});

test('winreg names: matched by their pieces, never by a regular expression that backtracks; at most four *',()=>{
 for(const c of vectors.names)assert.equal(matchDisplayName(c.pattern,c.name),c.match,c.case);
 // The same answers as the anchored, case-insensitive expression the rule means, on names short enough for it.
 const re=p=>new RegExp('^'+p.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s\\S]*')+'$','i');
 const alphabet=['a','b','A','.','-',' '];
 let seed=7;const rnd=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
 for(let i=0;i<4000;i++){
  const pat=Array.from({length:1+rnd(7)},()=>rnd(4)===0?'*':alphabet[rnd(alphabet.length)]).join('');
  const name=Array.from({length:rnd(12)},()=>alphabet[rnd(alphabet.length)]).join('');
  assert.equal(matchDisplayName(pat,name),re(pat).test(name),JSON.stringify([pat,name]));
 }
 // The rule from the review: 47 s with a backtracking expression on a 40-character name; here, a long name is instant.
 const t=Date.now();for(let i=0;i<200;i++)matchDisplayName('*a*a*a*b','a'.repeat(10000));assert.ok(Date.now()-t<2000);
 assert.ok(WINREG_NAME.test('*a*b*c*'));assert.ok(!WINREG_NAME.test('*a*a*a*a*b'),'five * are refused');
 assert.ok(validateItem({...registry.items[0],detect:{winbox:{kind:'winreg',displayName:'*a*a*a*a*b'}}},{categories:['tools']}).errors.length);
 // The agent: Test-DisplayName, IndexOf with OrdinalIgnoreCase; no expression made from a rule.
 const mod=raw('HomeHubAgent.psm1'),code=psCode(mod);
 assert.doesNotMatch(mod,/ConvertTo-NamePattern|Regex\]::Escape|\[regex\]::Escape/i);
 const [a,b]=functionSpan(code,'Test-DisplayName'),fn=mod.slice(a,b);
 assert.match(fn,/\$at = \$Name\.IndexOf\(\$piece, \$pos, \$cmp\)/);assert.match(fn,/\$cmp = \[StringComparison\]::OrdinalIgnoreCase/);assert.doesNotMatch(fn,/Regex|-match|-like/i);
 assert.match(mod,/Where-Object \{ Test-DisplayName \$pattern \$_\.name \}/);
 assert.match(raw('home-hub-agent.ps1'),/foreach \(\$c in @\(\$v\.names\)\)/,'-SelfTest runs the name vectors');
});

test('the secret patterns the agent compiles are ASCII-exact: .NET reads them as the hub\'s JavaScript does',()=>{
 const rules=windowsRules();
 assert.equal(rules.secret.length,SECRET_PATTERNS.length);
 rules.secret.forEach((s,i)=>{
  assert.equal(s.ignoreCase,false,'no IgnoreCase: .NET folds more than JavaScript (the Kelvin sign is a k)');
  assert.doesNotMatch(s.pattern.replace(/\\\\/g,''),/\\[bBdDwWsS]/,`no Unicode-aware escape left: ${s.pattern}`);
  assert.doesNotMatch(s.pattern.replace(/\\./g,''),/\./,'no dot');
  assert.equal(s.shape,SECRET_PATTERNS[i][2]);
 });
 // The same verdict as the hub's pattern on every string here: the line vectors' fields, non-ASCII neighbours, case.
 const key='hha_'+'0123456789abcdef'.repeat(4);
 const corpus=[...vectors.lines.flatMap(c=>c.line.split('\t')),key,`Git${key}`,`Gitč${key}`,`GitK${key}`,`é${key}é`,`x ${key.toUpperCase()} y`,`HHA_${'A'.repeat(64)}`,
  'password = hunter22','PASSWORD:hunter22','éToken=abcdef1','ßsecret: 123456','ſecret=abcdefgh','apiKey=abcdef','api-KEY:\u00a0abcdefg','token=\u2028abcdefg','token=\u0085abcdefg',
  'https://alice:pw@example.lan','sk-abcdefghijklmnop12','ghp_abcdefghij12','éeyJabcdefghijk.abcdefghijk','a'.repeat(40),'é'+'ab12'.repeat(10)+'é','ab12'.repeat(10)+'K',
  'Aa1'.repeat(11),'é'+'Aa1'.repeat(11),'-----BEGIN RSA PRIVATE KEY-----'];
 let seed=11;const rnd=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
 const pieces=['hh_','hha_','hhk_',key.slice(4,20),'0123456789abcdef'.repeat(4),'é','č','K','ſ',' ','\u00a0','=',':','token','Secret','sk-','eyJ','.','_','Aa1'.repeat(11),'A','f'];
 for(let i=0;i<3000;i++)corpus.push(Array.from({length:1+rnd(6)},()=>pieces[rnd(pieces.length)]).join(''));
 SECRET_PATTERNS.forEach(([re],i)=>{
  const ascii=new RegExp(rules.secret[i].pattern);
  for(const s of corpus)assert.equal(ascii.test(s),re.test(s),`${re} on ${JSON.stringify(s)}`);
 });
 assert.equal(asciiPattern('\\bx[a-c]\\d','i'),'(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))[xX][a-cA-C][0-9]');
 assert.throws(()=>asciiPattern('[\\W]'));assert.throws(()=>asciiPattern('a.b'));
});

test('the loop waits on a monotonic clock, stamps sentAt just before the envelope, and fits the packages cap',()=>{
 const mod=raw('HomeHubAgent.psm1'),code=psCode(mod);
 const [a,b]=functionSpan(code,'Invoke-AgentLoop'),loop=mod.slice(a,b);
 assert.match(loop,/\$clock = \[Diagnostics\.Stopwatch\]::StartNew\(\)/);
 assert.deepEqual([...loop.matchAll(/\$t = ([^\n;]+)/g)].map(m=>m[1]),['[long]$clock.ElapsedMilliseconds','[long]$clock.ElapsedMilliseconds'],'$t is the monotonic clock, read again before a send');
 // The wall clock is read only for what is written down.
 assert.deepEqual([...loop.matchAll(/(\$[A-Za-z.]+) = Get-NowMs/g)].map(m=>m[1]),['$sys.jobStartedWall','$sentWall','$afterWall']);
 assert.match(loop,/\$sentWall = Get-NowMs\n        \$body = \$script:Utf8\.GetBytes\(\(ConvertTo-AgentJson \(New-Envelope \$Setup \$sentWall \$parts\)\)\)/);
 for(const v of ['blockedUntil','lastSendMs'])for(const m of loop.matchAll(new RegExp(`\\$${v} = ([^;\\n]+)`,'g')))assert.doesNotMatch(m[1],/Get-NowMs|Wall/,`${v}: ${m[1]}`);
 // packages: every rule's first SW, every RUN and SPECS fit under the cap, whatever the length of the list.
 const cap=windowsRules().caps.packages;
 assert.match(mod,/return \[int\]\[Math\]::Max\(1\.0, \[Math\]::Min\(10\.0, \[Math\]::Floor\(\(\$Cap - 1 - \$Labels - \$Rules\) \/ \$Rules\) \+ 1\)\)/);
 const perRule=(rules,labels)=>Math.max(1,Math.min(10,Math.floor((cap-1-labels-rules)/rules)+1));
 for(let rules=1;rules<=600;rules++)for(const labels of [0,Math.floor(rules/2),rules])assert.ok(rules*perRule(rules,labels)+labels+1<=cap,`${rules} rules, ${labels} services`);
 assert.equal(perRule(5,2),10);assert.match(mod,/Select-Object -First \$perRule\)/);
 // The language mode is checked before anything else in both scripts.
 for(const f of ['home-hub-agent.ps1','install-agent.ps1']){
  const t=psCode(raw(f)),check=t.indexOf('if ($ExecutionContext.SessionState.LanguageMode -ne'),firstType=t.search(/\[[A-Z][A-Za-z.]+\]::|New-Object|Import-Module/);
  assert.ok(check>0&&check<firstType,`${f}: the language mode first`);
 }
});
