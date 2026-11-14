import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {parseSystemsProbe,buildSystems,versionStatus,systemsSpecs,listenEntry} from '../server/systems-data.mjs';
import {compareVersions,extractVersion} from '../server/versions.mjs';
import {pickRelease,resolveUpstream,checkUpstreams,upstreamKey,collectUpstreams} from '../server/systems-upstream.mjs';
import {createHandler} from '../server/index.mjs';
import {hashPassword} from '../server/auth.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const T='\t',rec=(...f)=>f.join(T);

const macProbe=[
 rec('HOST','mini','Darwin','alice','1','2026-11-08T12:00:00Z'),
 rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),
 rec('HW','Macmini9,1','Apple M1','17179869184','8'),
 rec('UPTIME',String(Date.parse('2026-11-08T12:00:00Z')/1000-7200)),
 rec('SWU','* Label: Safari27.2TahoeAuto-27.2'),rec('SWU','Title: Safari, Version: 27.2, Size: 250130KiB, Recommended: YES, '),
 rec('SWU','* Label: macOS Tahoe 26.7.2-25G332'),rec('SWU','Title: macOS Tahoe 26.7.2, Version: 26.7.2, Size: 2994108KiB, Recommended: YES, Action: restart, '),
 rec('SWU','* Label: macOS 27.2-26B123'),rec('SWU','Title: macOS 27.2, Version: 27.2, Size: 11185069KiB, Recommended: YES, Action: restart, '),
 rec('AUTO','CriticalUpdateInstall','unset'),rec('AUTO','ConfigDataInstall','1'),rec('AUTO','AutomaticallyInstallMacOSUpdates','unset'),
 rec('FW','global','0'),rec('FW','stealth','off'),rec('PF','Disabled','2'),
 rec('FV','FileVault is On.'),rec('SIP','System Integrity Protection status: enabled.'),rec('GK','assessments enabled'),
 rec('SSHD','remotelogin','on'),rec('SSHD','PasswordAuthentication','yes'),rec('SSHD','KbdInteractiveAuthentication','yes'),
 rec('SSHD','AllowUsers','alice@10.0.0.151'),rec('SSHD','AllowUsers','alice@10.0.0.25'),
 rec('SHARE','com.apple.screensharing','loaded'),rec('SHARE','com.apple.smbd','off'),
 rec('LISTEN','launchd','root','*:22'),rec('LISTEN','T3\\x20Code','alice','*:3773'),rec('LISTEN','Python','alice','127.0.0.1:8000'),rec('LISTEN','launchd','root','*:22'),
 rec('SW','llama.cpp','cmd','version: 8670 (af76639f7) built with AppleClang','/u/llama-b8670/llama-server',''),
 rec('SW','llama.cpp','cmd','version: 0.5.0-dev (build 11200, commit 81bc6b83f)','/u/llama-b11200/llama-server','running'),
 rec('RUN','llama.cpp','4711','com.example.ob1-embeddings'),
 rec('SW','omlx','pydist','0.3.9.dev2','/u/omlx/venv/lib/python3.11/site-packages'),rec('SW','omlx','pydist','0.7.3','/u/omlx/venv-0.7.3/lib/python3.12/site-packages'),
 rec('SW','llama-swap','brew','268','llama-swap','mostlygeek/llama-swap'),rec('RUN','llama-swap','absent','com.openai.local-ai.llama-swap'),
 rec('SW','node','cmd','v25.9.0','/u/node'),
 rec('SW','thermo','app','0.8.1','/Applications/Thermo.app','103'),
 rec('SW','grok','missing','','/u/.grok/bin/grok'),
 rec('BREWOUT','fmt','12.2.0','12.2.1'),
 rec('DOCKER','open-design','vanjayak/open-design:latest','Up 2 days (healthy)','2026-05-08T10:00:00Z'),
 rec('END','ok')].join('\n');

const nasProbe=[
 rec('HOST','nas','Linux','svc_hub','1','2026-11-08T12:00:00Z'),
 rec('OS','TrueNAS','25.10.7','Debian GNU/Linux 12 (bookworm)','6.12.105-production+truenas','x86_64'),
 rec('HW','MS-7D73','AMD Ryzen 9 7900 12-Core Processor','100388098048','24'),rec('UPTIME','1394522'),
 rec('TNUPDATE','NORMAL','TrueNAS-SCALE-Goldeye','MISSION_CRITICAL','25.10.8','2026-11-03','Updates the Linux kernel to address more than 1,600 upstream CVEs.'),
 rec('APP','immich','RUNNING','1.14.58','v3.3.5_1.14.58','true','false','false','community','immich'),rec('APPUP','immich','1.14.62','v3.3.6_1.14.62','v3.3.6_1.14.62'),
 rec('APP','wiki','RUNNING','1.0.0','1.0.0_custom','true','true','true','stable','custom-app'),rec('APPUP','wiki','1.0.0','1.0.0_custom','1.0.0_custom'),
 rec('APP','home-hub','STOPPED','1.0.0','1.0.0_custom','false','false','true','stable','custom-app'),
 rec('SERVICE','ftp','RUNNING','true'),rec('SERVICE','cifs','RUNNING','true'),rec('SERVICE','ups','STOPPED','false'),
 rec('FTP','21','false','false','false'),
 rec('SSHD','passwordauthentication','no'),rec('SSHD','kbdinteractiveauthentication','no'),rec('SSHD','permitrootlogin','without-password'),rec('SSHD','allowtcpforwarding','no'),
 rec('NFT','accept:1 ','141','ip nat,ip filter,inet cf_metrics'),
 rec('LISTEN','proftpd','root','*:21'),rec('LISTEN','smbd','root','0.0.0.0:445'),rec('LISTEN','?','root','127.0.0.1:6000'),
 rec('END','ok')].join('\n');

const registry={categories:{ai:'AI runtimes',infra:'Servers'},items:[
 {id:'llama.cpp',name:'llama.cpp',category:'ai',scheme:'llamacpp',upstream:{type:'github',repo:'ggml-org/llama.cpp'},
  detect:{mini:{kind:'cmd',path:'~/x/llama-b*/llama-server',args:'--version',match:'version: (\\S+)',launchd:'com.example.ob1-embeddings',source:{label:'GitHub release',url:'https://github.com/ggml-org/llama.cpp/releases'}}}},
 {id:'omlx',name:'oMLX',category:'ai',upstream:{type:'github',repo:'jundot/omlx'},detect:{mini:{kind:'pydist',glob:'~/omlx/venv*/lib/python*/site-packages',package:'omlx'}}},
 {id:'llama-swap',name:'llama-swap',category:'ai',upstream:{type:'github',repo:'mostlygeek/llama-swap'},detect:{mini:{kind:'brew',formula:'llama-swap',launchd:'com.openai.local-ai.llama-swap'}}},
 {id:'node',name:'Node.js',category:'infra',scheme:'node',upstream:{type:'node'},detect:{mini:{kind:'cmd',path:'~/.local/bin/node',args:'--version'}}},
 {id:'thermo',name:'Thermo',category:'infra',upstream:{type:'thermo-feed',url:'https://feed.example/stable.json'},detect:{mini:{kind:'app',path:'/Applications/Thermo.app'}}},
 {id:'grok',name:'Grok',category:'infra',upstream:{type:'none',note:'no feed'},detect:{mini:{kind:'cmd',path:'~/.grok/bin/grok',args:'--version'}}}]};
const upstream={checkedAt:'2026-11-08T12:00:00Z',results:{
 'github:ggml-org/llama.cpp':{ok:true,version:'0.9.0',url:'https://github.com/ggml-org/llama.cpp/releases/tag/v0.9.0'},
 'github:jundot/omlx':{ok:true,version:'0.7.3'},'github:mostlygeek/llama-swap':{ok:true,version:'271'},
 'node':{ok:true,version:'26.13.0',ltsMajor:26,ltsMajors:[22,24,26],latestByMajor:{26:'26.13.0',25:'25.9.0',24:'24.22.2'}},
 'thermo-feed:https://feed.example/stable.json':{ok:true,version:'0.8.1',build:104}}};

test('versions: pre-releases, Homebrew revisions, tag prefixes, extraction',()=>{
 assert.equal(compareVersions('0.7.3rc1','0.7.3'),-1);
 assert.equal(compareVersions('0.5.0-dev','0.5.0'),-1);
 assert.equal(compareVersions('268','271'),-1);
 assert.equal(compareVersions('2026.3.0','2026.10.7'),-1);
 assert.equal(compareVersions('26.13.0_2','26.13.0'),0);
 assert.equal(compareVersions('v.0.24.0','0.24.0'),0);
 assert.equal(compareVersions('0.44.2','0.44.0'),1);
 assert.equal(compareVersions('latest','1.0'),null);
 assert.equal(extractVersion('2.1.316 (Claude Code)'),'2.1.316');
 assert.equal(extractVersion('codex-cli 0.166.0'),'0.166.0');
 assert.equal(extractVersion('t3 v0.1.6'),'0.1.6');
 assert.equal(extractVersion('v2.11.9 h1:bhZtcRKQOq0fuLvEg='),'2.11.9');
 assert.equal(extractVersion('forgejo version 17.0.1 (release name 17.0.1)','version (\\S+)'),'17.0.1');
 assert.equal(extractVersion('version: v268 (2576af3), built at x','version: v?(\\S+)'),'268');
});

test('listen entries: scope from the bound address',()=>{
 assert.equal(listenEntry('launchd','root','*:22').scope,'all');
 assert.equal(listenEntry('nginx','root','[::]:80').scope,'all');
 assert.equal(listenEntry('Python','u','127.0.0.1:8000').scope,'loopback');
 assert.equal(listenEntry('x','u','[::1]:8000').scope,'loopback');
 assert.equal(listenEntry('caddy','root','10.0.0.74:443').scope,'address');
 assert.equal(listenEntry('T3\\x20Code','u','*:3773').proc,'T3 Code');
 assert.equal(listenEntry('x','u','garbage'),null);
});

test('macOS probe parses OS, updates, protection, software and dedupes sockets',()=>{
 const h=parseSystemsProbe(macProbe);
 assert.equal(h.complete,true);assert.equal(h.platform,'mac');
 assert.deepEqual(h.os,{name:'macOS',version:'26.7.1',build:'25G241',kernel:'25.6.0',arch:'arm64'});
 assert.equal(h.uptimeSeconds,7200);
 assert.equal(h.osUpdates.items.length,3);assert.equal(h.osUpdates.items[1].restart,true);assert.equal(h.osUpdates.items[0].label,'Safari27.2TahoeAuto-27.2');
 assert.equal(h.sshd.passwordauthentication,'yes');assert.deepEqual(h.sshd.allowUsers,['alice@10.0.0.151','alice@10.0.0.25']);
 assert.equal(h.listening.length,3,'duplicate *:22 collapsed');
 assert.equal(h.software['llama.cpp'].length,2);assert.equal(h.running['llama.cpp'].pid,4711);assert.equal(h.running['llama-swap'].state,'absent');
 assert.equal(h.fileVault,'on');assert.equal(h.sip,'on');assert.equal(h.gatekeeper,'on');assert.equal(h.pf.status,'disabled');
 assert.equal(parseSystemsProbe(macProbe.replace('END\tok','')).complete,false);
});

test('TrueNAS probe parses update, apps with targets, services and firewall',()=>{
 const h=parseSystemsProbe(nasProbe);
 assert.equal(h.platform,'linux');assert.equal(h.truenasUpdate.version,'25.10.8');
 assert.equal(h.apps.find(a=>a.name==='immich').latestHuman,'v3.3.6_1.14.62');
 assert.deepEqual(h.nft.inputPolicies,[{policy:'accept',chains:1}]);
 assert.equal(h.ftp.tls,false);assert.equal(h.uptimeSeconds,1394522);
});

test('version status: legacy llama.cpp builds, Node lines, feed builds, gaps',()=>{
 assert.equal(versionStatus({installed:'8670',scheme:'llamacpp',upstream:{ok:true,version:'0.9.0'},up:{type:'github'}}).status,'update');
 assert.equal(versionStatus({installed:'0.9.0',scheme:'llamacpp',upstream:{ok:true,version:'0.9.0'},up:{type:'github'}}).status,'current');
 const node=upstream.results.node;
 const odd=versionStatus({installed:'25.9.0',scheme:'node',upstream:node,up:{type:'node'}});assert.equal(odd.status,'update');assert.equal(odd.latest,'26.13.0');
 const lts24=versionStatus({installed:'24.22.2',scheme:'node',upstream:node,up:{type:'node'}});assert.equal(lts24.status,'current');assert.equal(lts24.latest,'24.22.2');
 assert.equal(versionStatus({installed:'0.8.1',build:'103',upstream:{ok:true,version:'0.8.1',build:104},up:{type:'thermo-feed'}}).status,'update');
 assert.equal(versionStatus({installed:'1.0',upstream:null,up:{type:'none'}}).status,'n/a');
 assert.equal(versionStatus({installed:'1.0',upstream:{ok:false,error:'HTTP 500'},up:{type:'pypi'}}).status,'unknown');
 assert.equal(versionStatus({installed:null,upstream:{ok:true,version:'1'},up:{type:'pypi'}}).status,'missing');
 assert.equal(versionStatus({installed:'0.44.2',upstream:{ok:true,version:'0.44.0'},up:{type:'github'}}).status,'ahead');
});

test('payload: rows pick the running binary and the newest venv; checks and summary per machine',()=>{
 const snapshot={collectedAt:'2026-11-08T12:00:00Z',machines:{mini:parseSystemsProbe(macProbe),nas:parseSystemsProbe(nasProbe)}};
 const doc=buildSystems({snapshot,upstream,registry,now:Date.parse('2026-11-08T12:05:00Z')});
 const row=(id,m='mini')=>doc.software.find(r=>r.id===id&&r.machine===m);
 assert.equal(row('llama.cpp').installed,'0.5.0-dev','running candidate wins over the older install');
 assert.deepEqual(row('llama.cpp').others,['8670 (/u/llama-b8670/llama-server)']);
 assert.equal(row('llama.cpp').status,'update');assert.equal(row('llama.cpp').running,'running');
 assert.equal(row('omlx').installed,'0.7.3');assert.equal(row('omlx').status,'current');
 assert.equal(row('llama-swap').source.label,'Homebrew tap mostlygeek/llama-swap');assert.equal(row('llama-swap').source.url,'https://github.com/mostlygeek/homebrew-llama-swap');
 assert.equal(row('node').status,'update');assert.equal(row('thermo').status,'update');
 assert.equal(row('grok').status,'missing');
 assert.equal(row('docker:open-design').status,'floating');
 assert.equal(row('app:immich','nas').status,'update');assert.equal(row('app:immich','nas').latest,'v3.3.6_1.14.62');
 assert.match(row('app:wiki','nas').note,/nový obraz/);assert.equal(row('app:home-hub','nas').running,'absent');
 const mini=doc.machines.find(m=>m.id==='mini'),nas=doc.machines.find(m=>m.id==='nas');
 assert.equal(mini.os.status,'update','26.7.2 is in the same major line');
 assert.deepEqual(mini.os.updates.map(u=>u.kind),['app','minor','major']);
 const c=(m,id)=>m.checks.find(x=>x.id===id);
 assert.equal(c(mini,'firewall').state,'warn');assert.equal(c(mini,'filevault').state,'ok');
 assert.equal(c(mini,'ssh-password').state,'warn');assert.match(c(mini,'ssh-password').detail,/10\.0\.0\.151/);
 assert.equal(c(mini,'security-responses').state,'ok');
 assert.equal(c(nas,'firewall').state,'warn');assert.equal(c(nas,'ftp').state,'warn');assert.equal(c(nas,'ssh-password').state,'ok');
 assert.match(c(nas,'os-update').detail,/^Bezpečnostní vydání/);
 assert.equal(c(nas,'exposed').value,'2 portů');
 assert.equal(nas.summary.appUpdates,2);assert.equal(nas.summary.osUpdate,1);
 assert.equal(doc.machines.find(m=>m.id==='studio').reachable,false);
});

test('upstream: highest stable release, prefixes, patterns, ETag reuse and stale fallback',async()=>{
 const rel=(tag,extra={})=>({tag_name:tag,html_url:`https://x/${tag}`,published_at:'2026-11-01T00:00:00Z',...extra});
 assert.equal(pickRelease([rel('v1.19.5'),rel('v2.2.6'),rel('v2.3.0-beta.1',{prerelease:true}),rel('v2.2.5')]).version,'2.2.6');
 assert.equal(pickRelease([rel('v0.7.4.dev1'),rel('v0.7.3')]).version,'0.7.3','dev tags are skipped even without the prerelease flag');
 assert.equal(pickRelease([rel('rust-v0.167.0'),rel('rust-v0.166.0'),rel('v9.9.9')],{tagPrefix:'rust-v'}).version,'0.167.0');
 assert.equal(pickRelease([rel('b12001'),rel('v0.9.0')],{tagPattern:'^v?\\d+\\.\\d+\\.\\d+$'}).version,'0.9.0');
 assert.equal(pickRelease([rel('v1.0.0',{draft:true})]),null);
 const calls=[];
 const fetchJson=async(url,{etag}={})=>{calls.push([url,etag]);
  if(url.endsWith('/releases/latest'))return {status:200,json:rel('v0.9.0')};
  if(url.includes('api.github.com'))return etag==='"e1"'?{status:304,etag}:{status:200,etag:'"e1"',json:[rel('b12001'),rel('b12000')]};
  if(url.includes('dist-tags'))return {status:200,json:{latest:'2.1.319',stable:'2.1.311'}};
  if(url.includes('pypi.org'))return {status:200,json:{info:{version:'0.6.4'},releases:{'0.6.4':[{upload_time_iso_8601:'2026-11-02T00:00:00Z'}]}}};
  if(url.includes('nodejs.org'))return {status:200,json:[{version:'v27.0.0-alpha.1',lts:false},{version:'v26.13.0',lts:'Lithium'},{version:'v25.9.0',lts:false},{version:'v24.22.2',lts:'Krypton'},{version:'v24.21.0',lts:'Krypton'}]};
  if(url.includes('formulae.brew.sh/api/cask'))return {status:200,json:{version:'4.23118.0,8175c354'}};
  if(url.includes('feed.example'))return {status:200,json:{manifest:Buffer.from(JSON.stringify({version:'0.8.1',build:104})).toString('base64')}};
  throw new Error('HTTP 503 '+url);};
 const gh=await resolveUpstream({type:'github',repo:'ggml-org/llama.cpp',tagPattern:'^v?\\d+\\.\\d+\\.\\d+$'},{fetchJson});
 assert.equal(gh.version,'0.9.0','latest release joins the page when builds crowd it out');assert.equal(gh.cache.list.etag,'"e1"');
 const again=await resolveUpstream({type:'github',repo:'ggml-org/llama.cpp'},{fetchJson,previous:gh});
 assert.equal(again.version,'0.9.0');assert.equal(calls.at(-2)[1],'"e1"','second call sends If-None-Match');assert.match(calls.at(-1)[0],/\/releases\/latest$/,'a list 304 does not skip /latest');
 assert.equal((await resolveUpstream({type:'npm',package:'@anthropic-ai/claude-code'},{fetchJson})).version,'2.1.319');
 assert.equal((await resolveUpstream({type:'pypi',package:'mlx-audio'},{fetchJson})).publishedAt,'2026-11-02T00:00:00Z');
 const node=await resolveUpstream({type:'node'},{fetchJson});
 assert.equal(node.version,'26.13.0');assert.deepEqual(node.ltsMajors.sort(),[24,26]);assert.equal(node.latestByMajor[24],'24.22.2');assert.equal(node.latestByMajor[27],undefined);
 assert.equal((await resolveUpstream({type:'brew-cask',name:'claude'},{fetchJson})).version,'4.23118.0');
 assert.equal((await resolveUpstream({type:'thermo-feed',url:'https://feed.example/stable.json'},{fetchJson})).build,104);
 const reg={items:[{id:'a',upstream:{type:'pypi',package:'x'}},{id:'b',upstream:{type:'codeberg',repo:'f/f'}}]};
 assert.deepEqual([...collectUpstreams(reg).keys()],['pypi:x','codeberg:f/f']);
 const first=await checkUpstreams(reg,{fetchJson,now:()=>'t1'});
 assert.equal(first.results['pypi:x'].ok,true);assert.equal(first.results['codeberg:f/f'].ok,false);
 const prev={results:{'codeberg:f/f':{ok:true,version:'17.0.1'}}};
 const second=await checkUpstreams(reg,{fetchJson,previous:prev,now:()=>'t2'});
 assert.equal(second.results['codeberg:f/f'].version,'17.0.1');assert.equal(second.results['codeberg:f/f'].stale,true);
 assert.equal(upstreamKey({type:'none'}),null);
});

test('probe specs: one line per watched item, separators stripped',()=>{
 const reg={items:[{id:'x',detect:{mini:{kind:'cmd',path:"/a b/c|d'e",args:'--version',launchd:'system/l'}}},{id:'y',detect:{studio:{kind:'brew',formula:'f'}}}]};
 assert.equal(systemsSpecs(reg,'mini'),'x|cmd|/a b/c d e|--version|system/l');
 assert.equal(systemsSpecs(reg,'nas'),'');
});

test('shipped registry: every item resolves to a known upstream and detect kind',async()=>{
 const reg=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'config','software-watch.json'),'utf8'));
 for(const item of reg.items){
  assert.ok(reg.categories[item.category],`${item.id}: category`);
  assert.ok(item.upstream.type==='none'||upstreamKey(item.upstream),`${item.id}: upstream`);
  for(const [m,d] of Object.entries(item.detect)){
   assert.ok(['mini','studio','mini_server'].includes(m),`${item.id}: machine ${m}`);
   assert.ok(['brew','cask','app','cmd','pydist','json'].includes(d.kind),`${item.id}/${m}: kind`);
   assert.doesNotMatch(systemsSpecs({items:[item]},m),/\n/);
  }
 }
});

test('probe scripts are valid POSIX sh',()=>{
 for(const f of ['mac-probe.sh','nas-probe.sh']){const r=spawnSync('/bin/sh',['-n',path.join(root,'scripts','systems',f)]);assert.equal(r.status,0,`${f}: ${r.stderr}`);}
});

test('/api/systems: sign-in required, admin only, 404 until collected, assets served',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-sys-'));let server=null;
 // One teardown, server first (as tests/hub-helper.mjs): hooks run in the order they were registered and one that
 // fails skips the rest, so an rm registered before the close could leave the server listening and the run never ends.
 t.after(async()=>{try{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:25});}});
 const origin='http://127.0.0.1:8997',credentials={username:'admin',...hashPassword('test-systems-password')};
 server=http.createServer(createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,bridgeRequest:async()=>{throw new Error('offline');}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(`${base}/api/systems`)).status,401);
 const login=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'test-systems-password'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const missing=await fetch(`${base}/api/systems`,{headers:{Cookie:cookie}});
 assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'SYSTEMS_MISSING');
 await mkdir(path.join(dir,'systems'),{recursive:true});
 await writeFile(path.join(dir,'systems','snapshot.json'),JSON.stringify({collectedAt:'2026-11-08T12:00:00Z',machines:{nas:parseSystemsProbe(nasProbe)}}));
 const ok=await fetch(`${base}/api/systems`,{headers:{Cookie:cookie}});
 assert.equal(ok.status,200);const doc=await ok.json();
 assert.equal(doc.machines.length,4);assert.equal(doc.machines.find(m=>m.id==='nas').os.status,'update');
 assert.ok(doc.software.some(r=>r.id==='app:immich'));
 for(const asset of ['/systems-view.js','/systems.css','/session-cache.js'])assert.equal((await fetch(`${base}${asset}`)).status,200,asset);
});

test('nftables without input hooks is unfiltered ingress (warn), not a policy named "none"',()=>{
 const withNft=line=>nasProbe.replace(/NFT\t[^\n]*/,line);
 const fw=probe=>{const h=parseSystemsProbe(probe);return {nft:h.nft,check:buildSystems({snapshot:{machines:{nas:{...h,complete:true}}},upstream,registry}).machines.find(m=>m.id==='nas').checks.find(c=>c.id==='firewall')};};
 // Empty ruleset: no tables, no chains.
 let r=fw(withNft(rec('NFT','none','0','')));
 assert.deepEqual(r.nft.inputPolicies,[]);assert.equal(r.nft.inputHooks,0);
 assert.equal(r.check.state,'warn');assert.equal(r.check.value,'vstup nefiltrován');assert.match(r.check.detail,/ruleset je prázdný/);
 // Tables exist (Docker NAT, metrics) but no chain hooks input.
 r=fw(withNft(rec('NFT','none','141','ip nat,ip filter,inet cf_metrics')));
 assert.equal(r.nft.inputHooks,0);assert.equal(r.check.state,'warn');assert.match(r.check.detail,/ip nat, ip filter, inet cf_metrics/);
 // A dropping input chain is a real firewall; accept-only stays a warning.
 assert.equal(fw(withNft(rec('NFT','drop:1 ','20','inet filter'))).check.state,'ok');
 assert.equal(fw(withNft(rec('NFT','accept:2 drop:1 ','20','inet filter'))).check.state,'ok');
 assert.equal(fw(withNft(rec('NFT','accept:1 ','141','ip nat'))).check.value,'vstup povolen (accept)');
 assert.equal(fw(withNft(rec('NFT','unknown'))).check.state,'unknown');
 // Snapshot persisted by the old parser (policy "none") still reads as unfiltered.
 const legacy=parseSystemsProbe(nasProbe);legacy.nft={inputPolicies:[{policy:'none',chains:null}],rules:0,tables:[]};
 assert.equal(buildSystems({snapshot:{machines:{nas:{...legacy,complete:true}}},upstream,registry}).machines.find(m=>m.id==='nas').checks.find(c=>c.id==='firewall').value,'vstup nefiltrován');
});

test('a failed upstream check (403/429) reaches the payload as stale/unverified, never as fresh "current"',async()=>{
 const reg={categories:{ai:'AI'},items:[
  {id:'omlx',name:'oMLX',category:'ai',upstream:{type:'github',repo:'jundot/omlx'},detect:{mini:{kind:'pydist',glob:'~/omlx/venv*/lib/python*/site-packages',package:'omlx'}}},
  {id:'llama-swap',name:'llama-swap',category:'ai',upstream:{type:'github',repo:'mostlygeek/llama-swap'},detect:{mini:{kind:'brew',formula:'llama-swap'}}}]};
 const snapshot={machines:{mini:parseSystemsProbe(macProbe)}};
 const rel=v=>({tag_name:`v${v}`,html_url:`https://x/${v}`});
 // First run succeeds: omlx is current (0.7.3), llama-swap has an update (installed 268 < 271).
 const ok=async url=>url.includes('jundot/omlx')?{status:200,etag:'"o"',json:[rel('0.7.3')]}:{status:200,etag:'"l"',json:[rel('271')]};
 const first=await checkUpstreams(reg,{fetchJson:ok,now:()=>'2026-11-08T06:00:00.000Z'});
 const row=(up,id)=>buildSystems({snapshot,upstream:up,registry:reg}).software.find(r=>r.id===id&&r.machine==='mini');
 const omlx0=row(first,'omlx');
 assert.equal(omlx0.upstreamStale,false);assert.equal(omlx0.upstreamCheckedAt,'2026-11-08T06:00:00.000Z');
 // Second run: GitHub rate-limits every request.
 const limited=async url=>{throw new Error(`HTTP ${url.includes('omlx')?403:429} ${url}`);};
 const second=await checkUpstreams(reg,{fetchJson:limited,previous:first,now:()=>'2026-11-08T18:00:00.000Z'});
 const r=second.results['github:jundot/omlx'];
 assert.equal(r.stale,true);assert.match(r.error,/HTTP 403/);assert.equal(r.checkedAt,'2026-11-08T06:00:00.000Z','checkedAt stays the last success');assert.equal(r.failedAt,'2026-11-08T18:00:00.000Z');
 const doc=buildSystems({snapshot,upstream:second,registry:reg});
 const omlx=doc.software.find(x=>x.id==='omlx'&&x.machine==='mini');
 assert.equal(omlx0.status,'current');assert.equal(omlx.status,'unknown','a stale source cannot claim current');assert.match(omlx.note,/selhala \(HTTP 403/);
 const swap=doc.software.find(x=>x.id==='llama-swap'&&x.machine==='mini');assert.equal(swap.status,'update','a known newer release stays an update');assert.equal(swap.upstreamStale,true);
 assert.equal(omlx.upstreamStale,true);assert.match(omlx.upstreamError,/HTTP 403/);
 assert.equal(omlx.upstreamCheckedAt,'2026-11-08T06:00:00.000Z');assert.equal(omlx.upstreamFailedAt,'2026-11-08T18:00:00.000Z');
 assert.equal(doc.upstreamFailed,2);
 // A third run that succeeds (here via ETag 304) clears the stale marker.
 const fresh=async(url,{etag}={})=>etag?{status:304,etag}:{status:200,json:rel('0.7.3')};
 const third=await checkUpstreams(reg,{fetchJson:fresh,previous:second,now:()=>'2026-11-09T06:00:00.000Z'});
 assert.equal(third.results['github:jundot/omlx'].stale,undefined);assert.equal(third.results['github:jundot/omlx'].error,undefined);
 assert.equal(buildSystems({snapshot,upstream:third,registry:reg}).software.find(x=>x.id==='omlx').upstreamStale,false);
 // Never-succeeded source: ok:false → unknown and flagged too.
 const none=await checkUpstreams(reg,{fetchJson:limited,now:()=>'t'});
 const n=buildSystems({snapshot,upstream:none,registry:reg}).software.find(x=>x.id==='omlx');assert.equal(n.status,'unknown');assert.equal(n.upstreamStale,true);
});
test('versionStatus: stale upstream keeps an update but demotes current/ahead to unknown',()=>{
 const up={type:'github'};
 assert.equal(versionStatus({installed:'1.0.0',upstream:{ok:true,version:'1.0.0',stale:true,error:'HTTP 429 x',checkedAt:'2026-11-01T00:00:00Z'},up}).status,'unknown');
 assert.equal(versionStatus({installed:'2.0.0',upstream:{ok:true,version:'1.0.0',stale:true,error:'HTTP 429 x'},up}).status,'unknown');
 const u=versionStatus({installed:'0.9.0',upstream:{ok:true,version:'1.0.0',stale:true,error:'HTTP 429 x'},up});assert.equal(u.status,'update');assert.match(u.note,/HTTP 429/);
 assert.equal(versionStatus({installed:'1.0.0',upstream:{ok:true,version:'1.0.0'},up}).status,'current');
});

import {createFetchJson,loadGithubToken} from '../server/systems-upstream.mjs';
test('optional GitHub token: only api.github.com gets it, never across redirects, never in the output',async t=>{
 const TOKEN='github_pat_'+'A1b2'.repeat(10);
 const seen=[];
 const fake=async(url,{headers})=>{seen.push([url,headers.Authorization||null]);
  const u=new URL(url);
  if(u.pathname==='/redirect-away')return new Response(null,{status:302,headers:{location:'https://objects.example.net/x'}});
  if(u.pathname==='/repos/old/name/releases')return new Response(null,{status:301,headers:{location:'https://api.github.com/repositories/1/releases'}});
  if(u.hostname==='api.github.com'&&u.pathname.includes('limited'))return new Response('{}',{status:403});
  return Response.json([{tag_name:'v1.2.3',html_url:'https://x'}],{headers:{etag:'"e"'}});};
 const withToken=createFetchJson({token:TOKEN,fetchImpl:fake});
 await withToken('https://api.github.com/repos/a/b/releases?per_page=20');
 await withToken('https://codeberg.org/api/v1/repos/a/b/releases');
 await withToken('https://pypi.org/pypi/x/json');
 await withToken('https://evil.example/?u=https://api.github.com/');
 await withToken('https://api.github.com.evil.example/repos/a/b');
 await withToken('http://api.github.com/repos/a/b');
 await withToken('https://api.github.com/redirect-away');
 await withToken('https://api.github.com/repos/old/name/releases');
 assert.deepEqual(seen.map(([u,a])=>[u,a?'token':null]),[
  ['https://api.github.com/repos/a/b/releases?per_page=20','token'],['https://codeberg.org/api/v1/repos/a/b/releases',null],['https://pypi.org/pypi/x/json',null],
  ['https://evil.example/?u=https://api.github.com/',null],['https://api.github.com.evil.example/repos/a/b',null],['http://api.github.com/repos/a/b',null],
  ['https://api.github.com/redirect-away','token'],['https://objects.example.net/x',null],
  ['https://api.github.com/repos/old/name/releases','token'],['https://api.github.com/repositories/1/releases','token']]);
 assert.equal(seen[0][1],`Bearer ${TOKEN}`);
 // Without a token nothing changes: no Authorization header anywhere.
 seen.length=0;await createFetchJson({fetchImpl:fake})('https://api.github.com/repos/a/b/releases');assert.equal(seen[0][1],null);
 // The token never reaches errors or the upstream.json document.
 const reg={items:[{id:'a',upstream:{type:'github',repo:'x/limited'}},{id:'b',upstream:{type:'github',repo:'x/ok'}}]};
 const doc=await checkUpstreams(reg,{fetchJson:withToken});
 assert.match(doc.results['github:x/limited'].error,/HTTP 403/);assert.equal(doc.results['github:x/ok'].version,'1.2.3');
 assert.doesNotMatch(JSON.stringify(doc),new RegExp(TOKEN));
 // Sources: env wins, then the private file; junk is ignored; missing file means anonymous.
 const dir=await mkdtemp(path.join(os.tmpdir(),'gh-token-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'github-token');
 assert.deepEqual(await loadGithubToken({env:{},file}),{token:null,source:null});
 await writeFile(file,TOKEN+'\n',{mode:0o600});
 assert.deepEqual(await loadGithubToken({env:{},file}),{token:TOKEN,source:'file'});
 assert.deepEqual(await loadGithubToken({env:{GITHUB_TOKEN:'ghp_'+'z'.repeat(36)},file}),{token:'ghp_'+'z'.repeat(36),source:'env'});
 assert.deepEqual(await loadGithubToken({env:{GITHUB_TOKEN_FILE:file}}),{token:TOKEN,source:'file'});
 await writeFile(file,'not a token\nsecond line');
 assert.equal((await loadGithubToken({env:{},file})).token,null);assert.equal((await loadGithubToken({env:{},file})).invalid,true);
});
test('check-upstream script prints no token and gitignore covers the token file',async()=>{
 const src=await (await import('node:fs/promises')).readFile(path.join(root,'scripts','check-upstream.mjs'),'utf8');
 assert.doesNotMatch(src,/console\.(log|warn|error)\([^)]*github\.token\b(?!\?)/,'only the token source is printed');
 assert.match(await (await import('node:fs/promises')).readFile(path.join(root,'.gitignore'),'utf8'),/^private\/$/m);
});

test('a failed GitHub /releases/latest fails the source: the shipped llama.cpp entry keeps 2.0.0 (stale), 1.0.0 is never "current"',async()=>{
 const shipped=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'config','software-watch.json'),'utf8'));
 const reg={categories:shipped.categories,items:shipped.items.filter(i=>i.id==='llama.cpp')};
 const key=upstreamKey(reg.items[0].upstream);assert.equal(key,'github:ggml-org/llama.cpp');
 const snapshot={machines:{mini_server:{...parseSystemsProbe([rec('HOST','mini_server','Darwin','alice','1','2026-11-08T12:00:00Z'),
  rec('SW','llama.cpp','cmd','version: 1.0.0 (build 12100, commit abc)','/u/llama-b12100/llama-server','running'),rec('END','ok')].join('\n')),complete:true}}};
 const row=up=>buildSystems({snapshot,upstream:up,registry:reg}).software.find(r=>r.id==='llama.cpp'&&r.machine==='mini_server');
 const rel=tag=>({tag_name:tag,html_url:`https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`});
 // The first 20 releases are build tags plus 1.0.0; 2.0.0 is only reachable through /releases/latest.
 const page=[...Array.from({length:19},(_,i)=>rel(`b${12200-i}`)),rel('v1.0.0')];
 const site=({latest,listEtag})=>async url=>{const u=new URL(url);
  if(u.hostname==='formulae.brew.sh')return Response.json({versions:{stable:'1.0.0'}});
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases/latest')return latest===200?Response.json(rel('v2.0.0')):new Response('{"message":"rate limited"}',{status:latest});
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases')return Response.json(page,{headers:{etag:listEtag}});
  return new Response('{}',{status:500});};
 const first=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:200,listEtag:'"e1"'})}),now:()=>'2026-11-08T06:00:00.000Z'});
 assert.equal(first.results[key].version,'2.0.0');assert.equal(first.results[key].cache.list.etag,'"e1"');
 assert.equal(row(first).status,'update');assert.equal(row(first).latest,'2.0.0');
 // Next check: the list still answers (new builds, new ETag), but /latest is rate-limited.
 const second=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:403,listEtag:'"e2"'})}),previous:first,now:()=>'2026-11-08T18:00:00.000Z'});
 const r=second.results[key];
 assert.equal(r.version,'2.0.0','the partial page (1.0.0) does not replace the known 2.0.0');
 assert.equal(r.stale,true);assert.match(r.error,/HTTP 403 .*\/releases\/latest/);
 assert.equal(r.checkedAt,'2026-11-08T06:00:00.000Z');assert.equal(r.failedAt,'2026-11-08T18:00:00.000Z');
 assert.equal(r.cache.list.etag,'"e1"','the ETag of the rejected page is not stored, so a later 304 cannot confirm it');
 const doc=buildSystems({snapshot,upstream:second,registry:reg}),x=doc.software.find(s=>s.id==='llama.cpp'&&s.machine==='mini_server');
 assert.notEqual(x.status,'current');assert.equal(x.status,'update');assert.equal(x.latest,'2.0.0');
 assert.equal(x.upstreamStale,true);assert.match(x.upstreamError,/HTTP 403/);assert.equal(x.upstreamCheckedAt,'2026-11-08T06:00:00.000Z');
 assert.ok(doc.upstreamFailed>=1);
 // Without an earlier success the same failure is unverified (unknown), not "current".
 const cold=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:429,listEtag:'"e3"'})}),now:()=>'t'});
 assert.equal(cold.results[key].ok,false);assert.equal(row(cold).status,'unknown');assert.equal(row(cold).upstreamStale,true);
 // 404 from /latest is an answer ("no latest release"), not a failure; the page alone decides.
 const none=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:site({latest:404,listEtag:'"e4"'})}),previous:first,now:()=>'t4'});
 assert.equal(none.results[key].version,'1.0.0');assert.equal(none.results[key].stale,undefined);assert.equal(row(none).status,'current');
 // A list answer that is not an array is a failure too, not an empty page.
 const junk=await checkUpstreams(reg,{fetchJson:async url=>url.includes('/releases/latest')?{status:200,json:rel('v2.0.0')}:url.includes('/releases')?{status:200,json:{message:'x'}}:{status:200,json:{versions:{stable:'1.0.0'}}},previous:first,now:()=>'t5'});
 assert.equal(junk.results[key].stale,true);assert.match(junk.results[key].error,/not an array/);
});

// A GitHub source needs two requests (release list and /releases/latest); an ETag validates only its own.
// site() answers each endpoint per run: 200 (with an ETag), 304 (only to a request that sent If-None-Match,
// else 200), or an error status. Every request and the If-None-Match it carried are recorded.
function releaseSite({list=200,latest=200,listEtag='"L1"',latestEtag='"R1"',latestTag='v1.0.0'}={},seen=[]){
 const rel=tag=>({tag_name:tag,html_url:`https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`,published_at:'2026-11-01T00:00:00Z'});
 const page=[...Array.from({length:19},(_,i)=>rel(`b${12200-i}`)),rel('v1.0.0')];
 const answer=(mode,inm,etag,body)=>mode===304&&inm?new Response(null,{status:304}):mode===200||mode===304?Response.json(body,{headers:{etag}}):new Response('{"message":"rate limited"}',{status:mode});
 return async(url,{headers})=>{const u=new URL(url),inm=headers['If-None-Match']||null;
  if(u.hostname==='formulae.brew.sh')return Response.json({versions:{stable:'1.0.0'}});
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases/latest'){seen.push(['latest',inm]);return answer(latest,inm,latestEtag,rel(latestTag));}
  if(u.pathname==='/repos/ggml-org/llama.cpp/releases'){seen.push(['list',inm]);return answer(list,inm,listEtag,page);}
  return new Response('{}',{status:500});};
}
async function llamaFixture(){
 const shipped=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'config','software-watch.json'),'utf8'));
 const reg={categories:shipped.categories,items:shipped.items.filter(i=>i.id==='llama.cpp')};
 const snapshot={machines:{mini_server:{...parseSystemsProbe([rec('HOST','mini_server','Darwin','alice','1','2026-11-08T12:00:00Z'),
  rec('SW','llama.cpp','cmd','version: 1.0.0 (build 12100, commit abc)','/u/llama-b12100/llama-server','running'),rec('END','ok')].join('\n')),complete:true}}};
 const row=up=>buildSystems({snapshot,upstream:up,registry:reg}).software.find(r=>r.id==='llama.cpp'&&r.machine==='mini_server');
 const run=async(spec,previous,now)=>{const seen=[];const doc=await checkUpstreams(reg,{fetchJson:createFetchJson({fetchImpl:releaseSite(spec,seen)}),previous,now:()=>now});return {doc,seen,r:doc.results['github:ggml-org/llama.cpp']};};
 return {row,run};
}

test('GitHub ETag: a 304 on the release list does not skip /releases/latest, so a failed /latest stays stale (unknown, not current)',async()=>{
 const {row,run}=await llamaFixture();
 const one=await run({},null,'2026-11-08T06:00:00.000Z');
 assert.equal(one.r.version,'1.0.0');assert.equal(row(one.doc).status,'current');
 const two=await run({list:200,latest:403},one.doc,'2026-11-08T18:00:00.000Z');
 assert.equal(two.r.stale,true);assert.equal(row(two.doc).status,'unknown');
 // Third run: the list is unchanged (304 to its ETag), /latest is still rate-limited.
 const three=await run({list:304,latest:403},two.doc,'2026-11-09T06:00:00.000Z');
 assert.deepEqual(three.seen,[['list','"L1"'],['latest','"R1"']],'both endpoints are asked, each with its own ETag');
 assert.equal(three.r.stale,true,'a list 304 alone cannot clear the failure');assert.match(three.r.error,/HTTP 403 .*\/releases\/latest/);
 assert.equal(three.r.checkedAt,'2026-11-08T06:00:00.000Z');assert.equal(three.r.failedAt,'2026-11-09T06:00:00.000Z');
 const x=row(three.doc);assert.equal(x.status,'unknown');assert.equal(x.upstreamStale,true);
});

test('GitHub ETag: list 304 + /latest 200 answers with the new latest; both 304 reuse the stored combination',async()=>{
 const {row,run}=await llamaFixture();
 const one=await run({},null,'2026-11-08T06:00:00.000Z');assert.equal(one.r.version,'1.0.0');
 // (b) The list did not change, but a new release became "latest" (off the first page).
 const two=await run({list:304,latest:200,latestEtag:'"R2"',latestTag:'v2.0.0'},one.doc,'2026-11-08T18:00:00.000Z');
 assert.deepEqual(two.seen,[['list','"L1"'],['latest','"R1"']]);
 assert.equal(two.r.version,'2.0.0');assert.equal(two.r.stale,undefined);assert.equal(two.r.checkedAt,'2026-11-08T18:00:00.000Z');
 assert.equal(two.r.cache.list.etag,'"L1"');assert.equal(two.r.cache.latest.etag,'"R2"');
 assert.equal(row(two.doc).status,'update');assert.equal(row(two.doc).latest,'2.0.0');
 // (c) Nothing changed: both answer 304 to their own ETags → fresh, same combined answer.
 const three=await run({list:304,latest:304},two.doc,'2026-11-09T06:00:00.000Z');
 assert.deepEqual(three.seen,[['list','"L1"'],['latest','"R2"']]);
 assert.equal(three.r.version,'2.0.0');assert.equal(three.r.stale,undefined);assert.equal(three.r.error,undefined);
 assert.equal(three.r.checkedAt,'2026-11-09T06:00:00.000Z');assert.equal(row(three.doc).upstreamStale,false);
 // A 304 recovers a stale source only if both endpoints validate it in the same run.
 const stale=await run({list:304,latest:503},three.doc,'t4');assert.equal(stale.r.stale,true);
 const back=await run({list:304,latest:304},stale.doc,'t5');assert.equal(back.r.stale,undefined);assert.equal(back.r.version,'2.0.0');
 // A 404 on /latest is an answer and is not cached; the next run asks without If-None-Match.
 const gone=await run({list:304,latest:404},back.doc,'t6');assert.equal(gone.r.version,'1.0.0');assert.equal(gone.r.stale,undefined);
 const after=await run({list:304,latest:200},gone.doc,'t7');assert.deepEqual(after.seen,[['list','"L1"'],['latest',null]]);
});

test('GitHub ETag: a cache written by older code (no cache version) is not trusted: full fetch, its ETags are not sent',async()=>{
 const {row,run}=await llamaFixture();
 // Pre-fix shape: one list ETag at the top level, here from a list-only answer (1.0.0) while 2.0.0 is latest.
 const legacy={schemaVersion:1,checkedAt:'2026-11-07T06:00:00.000Z',results:{'github:ggml-org/llama.cpp':{ok:true,version:'1.0.0',url:'https://x',publishedAt:null,etag:'"L1"',checkedAt:'2026-11-07T06:00:00.000Z'}}};
 const one=await run({list:304,latest:304,latestTag:'v2.0.0'},legacy,'2026-11-08T06:00:00.000Z');
 assert.deepEqual(one.seen,[['list',null],['latest',null]],'no If-None-Match from the legacy cache');
 assert.equal(one.r.version,'2.0.0','the partial legacy answer is not resurrected');assert.equal(row(one.doc).status,'update');
 assert.equal(one.r.etag,undefined);assert.equal(one.r.cache.v,2);assert.equal(one.doc.schemaVersion,2);
 // A legacy entry kept on failure stays untrusted: the next run still sends no ETag.
 const failed=await run({list:403},legacy,'t2');assert.equal(failed.r.stale,true);
 const next=await run({list:304,latest:304},failed.doc,'t3');assert.deepEqual(next.seen,[['list',null],['latest',null]]);assert.equal(next.r.stale,undefined);
 // A wrong cache version is ignored too.
 const bumped=structuredClone(next.doc);bumped.results['github:ggml-org/llama.cpp'].cache.v=1;
 assert.deepEqual((await run({list:304,latest:304},bumped,'t4')).seen,[['list',null],['latest',null]]);
});

test('ETag on other providers: Codeberg revalidates its single request; a 304 nobody asked for fails a source',async()=>{
 const seen=[];
 const fetchJson=createFetchJson({fetchImpl:async(url,{headers})=>{const u=new URL(url),inm=headers['If-None-Match']||null;seen.push([u.hostname+u.pathname,inm]);
  if(u.hostname==='codeberg.org')return inm==='"C1"'?new Response(null,{status:304}):Response.json([{tag_name:'v17.0.1',html_url:'https://codeberg.org/x'}],{headers:{etag:'"C1"'}});
  return new Response(null,{status:304,headers:{etag:'"bogus"'}});}});
 const cb={type:'codeberg',repo:'forgejo/forgejo'};
 const legacy={ok:true,version:'16.0.0',etag:'"C1"'};
 const one=await resolveUpstream(cb,{fetchJson,previous:legacy});
 assert.equal(one.version,'17.0.1');assert.deepEqual(seen.at(-1),['codeberg.org/api/v1/repos/forgejo/forgejo/releases',null],'legacy Codeberg ETag not sent');
 assert.equal(one.cache.latest,undefined,'Codeberg has no second request');
 const two=await resolveUpstream(cb,{fetchJson,previous:one});assert.equal(two.version,'17.0.1');assert.equal(seen.at(-1)[1],'"C1"');
 // PyPI, npm, Homebrew, Node and the Thermo feed never send If-None-Match; a 304 is a failure, not "unchanged".
 const reg={items:[{id:'p',upstream:{type:'pypi',package:'x'}},{id:'n',upstream:{type:'npm',package:'y'}},{id:'f',upstream:{type:'brew-formula',name:'z'}},
  {id:'c',upstream:{type:'brew-cask',name:'w'}},{id:'node',upstream:{type:'node'}},{id:'t',upstream:{type:'thermo-feed',url:'https://feed.example/stable.json'}}]};
 const previous={results:Object.fromEntries([...collectUpstreams(reg).keys()].map(k=>[k,{ok:true,version:'1.0.0',etag:'"bogus"',cache:{v:2}}]))};
 seen.length=0;const doc=await checkUpstreams(reg,{fetchJson,previous,now:()=>'t'});
 assert.ok(seen.length===6&&seen.every(([,inm])=>inm===null),'no conditional requests outside GitHub/Codeberg');
 for(const r of Object.values(doc.results)){assert.equal(r.stale,true);assert.match(r.error,/HTTP 304 without If-None-Match/);}
});

// --- push agents: the readers join agent records (docs/agent.md §3, §6; step 2) ------------------------------------
import {readFile as readText,readdir as listDir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {agentSystemsHost,pickSource,collectorTime,systemMachines} from '../server/systems-data.mjs';
import {splitSystemsRecords,checkLine} from '../server/agent-report.mjs';
import {collectSystems} from '../scripts/collect-systems.mjs';
import {SITE} from './hub-helper.mjs';
import {readerHub,readerAnswers,READERS_DIR} from './support/readers.mjs';
import {envelope,systemsParts,reportTo,issueAgent,quiet} from './support/agent.mjs';

const probeLines=name=>readFileSync(path.join(root,'tests','fixtures','probes',name),'utf8').split('\n').filter(Boolean);
// A stored agent record (server/agent-store.mjs) whose os, updates and packages parts hold one run of a systems probe.
function agentRecord(lines,{platform='macos',receivedAt='2026-11-13T11:45:00.000Z',interval=21600,collectedAt='2026-11-13T11:44:00Z',withheld=[]}={}){
 const split=splitSystemsRecords(lines),part=records=>({schema:1,collectedAt,receivedAt,interval,digest:'0'.repeat(64),withheld,records});
 return {schemaVersion:1,machine:'x',agentId:'0123456789abcdef',agentVersion:'1.6.0',platform,lastSeenAt:receivedAt,lastSentAt:receivedAt,
  parts:{os:part(split.os),updates:part(split.updates),packages:part(split.packages)}};
}
const macAgent=(root,priv,time='2026-11-13T11:44:00Z')=>[rec('HOST','mini','Darwin','alice',root,time),rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),...priv,
 rec('FV','FileVault is On.'),rec('LISTEN','sshd','root','*:22'),rec('END','ok'),rec('SWU_NONE')];
// The four privileged reads reported ok, with the records they leave (macAgent adds a LISTEN line itself).
const ALL_MAC_PRIV=[...['pf-info','pf-rules','listen','sshd'].map(id=>rec('PRIV',id,'ok')),rec('PF','Enabled','12'),rec('SSHD','passwordauthentication','no')];
const windowsLines=[rec('HOST','winbox','Windows','LocalService','0','2026-11-13T11:44:00Z'),rec('OS','Windows 11 Pro','24H2','26100.2605','10.0.26100','x64'),
 rec('HW','Example Desktop','Intel(R) Core(TM) i5','17179869184','8'),rec('UPTIME','3600'),rec('DEFENDER','on','2'),rec('BITLOCKER','C:','on'),rec('BITLOCKER','D:','off'),
 rec('WINFW','domain','on'),rec('WINFW','private','on'),rec('WINFW','public','off'),rec('RDP','on'),rec('LISTEN','svchost','SYSTEM','0.0.0.0:3389'),rec('END','ok'),
 rec('WINUP','KB5044284','2024-10 Cumulative Update for Windows 11','Critical','1'),rec('WINUP','KB890830','Malicious Software Removal Tool','Unspecified','0')];

test('readers: no agent state answers byte for byte what 1.4 answered on /api/systems, /api/security, the runtimes endpoints and the home runtimes',async t=>{
 const golden=JSON.parse(readFileSync(path.join(READERS_DIR,'golden.json'),'utf8'));
 const h=await readerHub(t,{thermoPoller:quiet});
 const now=await readerAnswers(h);
 for(const name of ['systems','security','endpoints','homeRuntimes'])assert.equal(JSON.stringify(now[name]),JSON.stringify(golden[name]),name);
 // /api/models lists every home.runtimes provider: the agent module is one more, with no machine. Nothing else moves.
 const agentSource={module:'agent',source:'agent',machines:0,lastAt:null,failed:false};
 assert.deepEqual(now.models.body.providers.runtimes.at(-1),agentSource);
 now.models.body.providers.runtimes.pop();assert.equal(JSON.stringify(now.models),JSON.stringify(golden.models),'models');
 // The snapshot is an old one (no probedAt anywhere) and loads as it did.
 assert.ok(Object.values(JSON.parse(readFileSync(path.join(READERS_DIR,'snapshot.json'),'utf8')).machines).every(m=>!('probedAt' in m)));
});

test('parser: PKGUP, WINUP, PRIV and the Windows records, additively; a record without them has none of the fields',()=>{
 const debian=parseSystemsProbe(probeLines('linux-debian-apt.txt').join('\n'));
 assert.deepEqual(debian.packageUpdates,{manager:'apt',checked:true,cacheAgeSeconds:null,error:null,items:[
  {name:'openssl',installed:'3.0.13-0ubuntu3.4',candidate:'3.0.13-0ubuntu3.5',security:true},{name:'curl',installed:'8.5.0-2ubuntu10.5',candidate:'8.5.0-2ubuntu10.6',security:false},
  {name:'tzdata',installed:'2025a-0ubuntu0.24.04.1',candidate:'2025b-0ubuntu0.24.04.1',security:false}]});
 assert.deepEqual(debian.privileged,{sshd:true,listen:true,nft:true});
 const fedora=parseSystemsProbe(probeLines('linux-fedora-dnf.txt').join('\n'));
 assert.equal(fedora.packageUpdates.manager,'dnf');assert.equal(fedora.packageUpdates.items[1].installed,null);assert.equal(fedora.packageUpdates.items[1].security,true);
 assert.deepEqual(fedora.privileged,{sshd:false,listen:true,nft:false});
 assert.deepEqual(parseSystemsProbe(probeLines('linux-minimal.txt').join('\n')).packageUpdates,{manager:'apt',checked:false,cacheAgeSeconds:null,items:[],error:'no package index readable (apt-cache stats)'});
 assert.deepEqual(parseSystemsProbe(['HOST\tx\tLinux\tu\t0\t2026-11-13T10:00:00Z','PKGUP_NONE\tdnf\t5400','END\tok'].join('\n')).packageUpdates,{manager:'dnf',checked:true,cacheAgeSeconds:5400,items:[],error:null});
 for(const line of windowsLines)assert.equal(checkLine(line.startsWith('WINUP')?'updates':'os',line,'windows'),null,line);
 const win=parseSystemsProbe(windowsLines.join('\n'));
 assert.equal(win.platform,'windows');assert.deepEqual(win.os,{name:'Windows 11 Pro',version:'24H2',build:'26100.2605',kernel:'10.0.26100',arch:'x64'});
 assert.equal(win.uptimeSeconds,3600);
 assert.deepEqual(win.windows,{defender:'on',signatureAgeDays:2,bitlocker:{'C:':'on','D:':'off'},firewall:{domain:'on',private:'on',public:'off'},rdp:'on'});
 assert.deepEqual(win.windowsUpdates,{checked:true,error:null,items:[{kb:'KB5044284',title:'2024-10 Cumulative Update for Windows 11',severity:'Critical',restart:true},
  {kb:'KB890830',title:'Malicious Software Removal Tool',severity:'Unspecified',restart:false}]});
 assert.deepEqual(parseSystemsProbe('HOST\tw\tWindows\tu\t0\t2026-11-13T10:00:00Z\nWINUP_ERR\tthe search failed\nEND\tok').windowsUpdates,{checked:false,items:[],error:'the search failed'});
 const mac=parseSystemsProbe(macProbe);
 for(const k of ['packageUpdates','windowsUpdates','privileged','windows'])assert.equal(k in mac,false,`${k}: an older record's shape is unchanged`);
 const odd=parseSystemsProbe('PRIV\t__proto__\tok\nPRIV\tconstructor\tok\nBITLOCKER\t__proto__\ton');
 assert.equal(odd.privileged,undefined,'no inherited names');assert.equal(Object.getPrototypeOf(odd.windows.bitlocker),Object.prototype);
});

test('who wins per machine: current, then coverage, then the hub\'s time (collector record vs agent part)',()=>{
 const now=Date.parse('2026-11-13T12:00:00Z');
 const C={...parseSystemsProbe(macProbe),stale:false,lastError:null,probedAt:'2026-11-13T11:30:00.000Z'};// root 1, complete
 const pick=({record=C,lines,receivedAt,snapshotTime=null,interval})=>buildSystems({snapshot:{collectedAt:'2026-11-13T11:30:00.000Z',machines:{mini:record}},upstream,registry,now,snapshotTime,
  agents:[{id:'mini',name:'Mac mini',record:agentRecord(lines,{receivedAt,interval})}]}).machines.find(m=>m.id==='mini');
 // A lower-coverage agent part never beats a current root collector record, however new.
 let m=pick({lines:macAgent('0',[rec('PRIV','listen','denied'),rec('PRIV','sshd','ok'),rec('PRIV','pf-info','ok'),rec('PRIV','pf-rules','ok')]),receivedAt:'2026-11-13T11:59:00.000Z'});
 assert.equal(m.source,'collector');assert.equal(m.sourceAt,'2026-11-13T11:30:00.000Z');assert.equal(m.os.version,'26.7.1');assert.equal(m.checks.find(c=>c.id==='ssh-password').state,'warn');
 // Full coverage: the newer wins; a tie goes to the agent.
 m=pick({lines:macAgent('0',ALL_MAC_PRIV),receivedAt:'2026-11-13T11:45:00.000Z'});assert.equal(m.source,'agent');assert.equal(m.collectedAt,'2026-11-13T11:45:00.000Z');
 assert.equal(pick({lines:macAgent('0',ALL_MAC_PRIV),receivedAt:'2026-11-13T11:00:00.000Z'}).source,'collector','older than the collector record');
 assert.equal(pick({lines:macAgent('0',ALL_MAC_PRIV),receivedAt:'2026-11-13T11:30:00.000Z'}).source,'agent','a tie');
 // A collector record marked stale (its last probe failed) against a fresh agent part: the agent, whatever its coverage.
 m=pick({record:{...C,stale:true,lastError:'ssh: timed out'},lines:macAgent('0',[rec('PRIV','listen','denied')]),receivedAt:'2026-11-13T11:00:00.000Z'});
 assert.equal(m.source,'agent');assert.equal(m.stale,false);
 // Older than the collector's stale-after (7.5 h): not current either.
 assert.equal(pick({record:{...C,probedAt:'2026-11-13T04:00:00.000Z'},lines:macAgent('0',[]),receivedAt:'2026-11-13T05:00:00.000Z',interval:21600}).source,'agent');
 // A collector clock that runs ahead cannot win: its time is the earlier of probedAt and the file's modification time.
 const ahead={...C,probedAt:'2026-11-13T13:00:00.000Z'};
 assert.equal(pick({record:ahead,lines:macAgent('0',ALL_MAC_PRIV),receivedAt:'2026-11-13T11:45:00.000Z'}).source,'collector','without the file time the clock ahead would win');
 assert.equal(pick({record:ahead,lines:macAgent('0',ALL_MAC_PRIV),receivedAt:'2026-11-13T11:45:00.000Z',snapshotTime:Date.parse('2026-11-13T11:30:00Z')}).source,'agent');
 // Neither current: the newer, shown stale (no news, never unreachable).
 m=pick({record:{...C,probedAt:'2026-11-12T00:00:00.000Z'},lines:macAgent('0',ALL_MAC_PRIV),receivedAt:'2026-11-12T10:00:00.000Z',interval:900});
 assert.equal(m.source,'agent');assert.equal(m.stale,true);assert.equal(m.reachable,true);assert.equal(m.error,null);
 m=pick({record:{...C,probedAt:'2026-11-12T11:00:00.000Z'},lines:macAgent('0',ALL_MAC_PRIV),receivedAt:'2026-11-12T10:00:00.000Z',interval:900});
 assert.equal(m.source,'collector');assert.equal(m.stale,true);
 assert.equal(pickSource(null,null),null);assert.equal(pickSource({current:true,time:1},null),'collector');assert.equal(pickSource(null,{current:false,time:0}),'agent');
 assert.equal(collectorTime({collectedAt:'2026-11-08T12:00:00Z'},{collectedAt:'2026-11-08T12:01:00Z'}),Date.parse('2026-11-08T12:00:00Z'),'a record from before probedAt: the earlier of the file\'s collectedAt and its own');
 assert.equal(collectorTime({collectedAt:'2026-11-08T13:00:00Z'},{collectedAt:'2026-11-08T12:00:00Z'}),Date.parse('2026-11-08T12:00:00Z'),'never newer than the file');
 assert.ok(Number.isNaN(collectorTime({complete:false},{collectedAt:'2026-11-08T12:00:00Z',fileTime:Date.parse('2026-11-08T12:00:00Z')})),'a record that never carried a probe has no time');
});

test('agent records: receive time in place of HOST, source "agent", reader kinds mac, linux and windows from the platform, never HOST',()=>{
 const now=Date.parse('2026-11-13T12:00:00Z');
 const debian=agentRecord(probeLines('linux-debian-apt.txt'),{platform:'linux'}),win=agentRecord(windowsLines,{platform:'windows',withheld:[{tag:'SW',field:3,reason:'secret',count:1}]});
 const doc=buildSystems({snapshot:{collectedAt:'2026-11-08T12:00:00Z',machines:{nas:{...parseSystemsProbe(nasProbe),stale:false}}},upstream,registry,now,machines:systemMachines(SITE),
  agents:[{id:'nas',name:'NAS',record:agentRecord(probeLines('linux-debian-apt.txt'),{platform:'linux'})},{id:'pi',name:'Pi',record:debian},{id:'winbox',name:'Win box',record:win},
   {id:'laptop',name:'Laptop',record:agentRecord(probeLines('linux-fedora-dnf.txt'),{platform:'linux'})},{id:'box',name:'Box',record:agentRecord(probeLines('linux-minimal.txt'),{platform:'linux'})},
   {id:'alp',name:'Alpine',record:agentRecord(probeLines('linux-alpine-apk.txt'),{platform:'linux'})}]});
 const at=id=>doc.machines.find(m=>m.id===id),ids=m=>m.checks.map(c=>c.id),c=(m,id)=>m.checks.find(x=>x.id===id);
 // The NAS stays agent-less: an agent record for it is not read, and its checks stay the NAS ones.
 const nas=at('nas');assert.equal('source' in nas,false);assert.equal(nas.kind,'nas');assert.ok(ids(nas).includes('ftp'));
 const pi=at('pi');
 assert.deepEqual([pi.kind,pi.source,pi.name,pi.reachable,pi.stale],['linux','agent','Pi',true,false]);
 assert.equal(pi.collectedAt,'2026-11-13T11:45:00.000Z','the hub\'s receive time');assert.equal(pi.machineCollectedAt,'2026-11-13T09:40:12Z','the machine\'s own, as information');
 assert.deepEqual(ids(pi),['firewall','ssh-password','ssh-root','security-updates','os-update','auto-updates','exposed'],'Linux checks: never the NAS or the Mac ones');
 assert.deepEqual([c(pi,'firewall').state,c(pi,'ssh-password').state,c(pi,'security-updates').state,c(pi,'auto-updates').state],['ok','ok','warn','ok']);
 assert.equal(c(pi,'security-updates').detail,'openssl');assert.equal(c(pi,'exposed').value,'2 portů');
 assert.deepEqual([pi.os.name,pi.os.version,pi.os.status,pi.os.securityUpdates,pi.os.channel,pi.uptimeSeconds],['Ubuntu','24.04','update',1,'apt',864213]);
 assert.equal(pi.summary.osUpdate,1);
 const laptop=at('laptop');
 assert.deepEqual([c(laptop,'firewall').state,c(laptop,'firewall').detail],['unknown','nft list ruleset potřebuje sudo.']);
 assert.deepEqual([c(laptop,'ssh-password').state,c(laptop,'ssh-password').detail],['unknown','sshd -T potřebuje sudo.']);
 assert.equal(c(laptop,'security-updates').state,'warn');assert.equal(c(laptop,'auto-updates').state,'ok');
 const box=at('box');assert.equal(c(box,'security-updates').state,'unknown');assert.equal(c(box,'os-update').state,'unknown');assert.equal(c(box,'auto-updates').value,'nenastaveno');
 const alp=at('alp');assert.equal(alp.os.status,'unknown');assert.equal(c(alp,'auto-updates').state,'unknown');
 const w=at('winbox');
 assert.deepEqual([w.kind,w.source,w.os.name,w.os.build,w.os.status],['windows','agent','Windows 11 Pro','26100.2605','update']);
 assert.deepEqual(ids(w),['defender','bitlocker','firewall','rdp','os-update','exposed'],'Windows checks: never FileVault or nftables');
 assert.deepEqual(['defender','bitlocker','firewall','rdp','os-update'].map(id=>c(w,id).state),['ok','crit','warn','info','warn']);
 assert.equal(c(w,'bitlocker').detail,'Nešifrované svazky: D:.');assert.equal(c(w,'exposed').detail,'3389 svchost');
 assert.deepEqual(w.withheld,[{part:'os',tag:'SW',field:3,reason:'secret',count:1},{part:'updates',tag:'SW',field:3,reason:'secret',count:1},{part:'packages',tag:'SW',field:3,reason:'secret',count:1}]);
 // A Linux record behind a Mac site machine is read as Linux: the kind follows the platform of the record that won.
 const studio=buildSystems({snapshot:{machines:{}},upstream,registry,now,machines:systemMachines(SITE),agents:[{id:'studio',name:'Mac Studio',record:debian}]}).machines.find(m=>m.id==='studio');
 assert.equal(studio.kind,'linux');assert.equal(studio.checks.some(x=>['filevault','sip','gatekeeper'].includes(x.id)),false);
 // The top level: the newest of the collector's time and the receive times; the collector's state stays the collector's.
 assert.equal(doc.collectedAt,'2026-11-13T11:45:00.000Z');assert.equal(doc.collector.collectedAt,'2026-11-08T12:00:00Z');
 assert.deepEqual(doc.collector.agents,{machines:6,fresh:6,noNews:0});
 assert.deepEqual(doc.provenance.kinds.map(k=>[k.id,k.kind]),[['systems','collector'],['agents','telemetry'],['upstream','collector']]);
 assert.equal(agentSystemsHost(agentRecord(windowsLines,{platform:'other'})),null,'no reader kind, no record');
});

test('collect-systems writes probedAt per machine: the collecting machine\'s clock when that probe came back; a failed probe leaves it',async t=>{
 const outDir=await mkdtemp(path.join(os.tmpdir(),'hub-probed-'));t.after(()=>rm(outDir,{recursive:true,force:true}));
 const site={...SITE,machines:SITE.machines.filter(m=>m.id==='mini')};
 const exec=fail=>async(cmd)=>cmd==='hostname'?{code:0,stdout:'collector\n',stderr:''}:fail?{code:255,stdout:'',stderr:'ssh: timed out'}:{code:0,stdout:macProbe+'\n',stderr:''};
 let n=0;const now=()=>new Date(Date.parse('2026-11-13T10:00:00Z')+(n++)*1000).toISOString();
 const r1=await collectSystems({site,registry:{items:[]},outDir,exec:exec(false),now});
 assert.equal(r1.snapshot.machines.mini.probedAt,'2026-11-13T10:00:00.000Z');
 const r2=await collectSystems({site,registry:{items:[]},outDir,exec:exec(true),now});
 assert.equal(r2.snapshot.machines.mini.probedAt,'2026-11-13T10:00:00.000Z','kept from the last probe that came back');assert.equal(r2.snapshot.machines.mini.stale,true);
});

test('over HTTP: a report a year ahead makes nothing look fresh; receivedAt is the time shown; no news is stale, not unreachable; runtimes and the trend',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await readerHub(t,{thermoPoller:quiet,agentClock:()=>clock});
 const key=await issueAgent(h,'mini'),report=reportTo(h);
 const ahead='2027-11-13T10:00:00Z',runtimes={schema:1,collectedAt:ahead,interval:120,data:{runtimes:[{id:'ollama',name:'Ollama',kind:'ollama',status:'running',url:'http://127.0.0.1:11434',
  activity:{active:1,queued:0},pids:[4242],models:[{id:'qwen3:8b',state:'loaded',sizeGb:5,active:1,queued:0,pids:[4243]}],stats:[{label:'tokens/s',value:42}]}]}};
 const answer=await report(key.token,envelope({...systemsParts({name:'mini',collectedAt:ahead}),runtimes},{sentAt:ahead}));
 assert.equal(answer.status,200);const {receivedAt,accepted}=await answer.json();assert.deepEqual(accepted,['os','updates','packages','runtimes']);
 const systems=async()=>(await (await fetch(h.origin+'/api/systems',{headers:h.admin})).json());
 let doc=await systems(),mini=doc.machines.find(m=>m.id==='mini');
 assert.equal(receivedAt,'2026-11-13T10:00:00.000Z');
 assert.deepEqual([mini.source,mini.collectedAt,mini.machineCollectedAt,mini.stale],['agent',receivedAt,ahead,false]);
 assert.equal(doc.collectedAt,receivedAt,'the top level shows the receive time, not the machine\'s year ahead');
 assert.equal(doc.collector.collectedAt,'2026-11-08T12:00:00Z','the collector state stays the collector\'s');assert.deepEqual(doc.collector.agents,{machines:1,fresh:1,noNews:0});
 const home=async()=>(await (await fetch(h.origin+'/api/home',{headers:h.admin})).json()).machines.find(m=>m.id==='mini').runtimes;
 let rt=await home();assert.equal(rt.source,'agent');assert.equal(rt.observedAt,receivedAt);assert.equal(rt.runtimes[0].status,'running');assert.deepEqual(rt.runtimes[0].activity,{active:1,queued:0});
 // Past receivedAt + 3 × interval by the hub's clock: no news. The runtimes part (120 s) first.
 clock+=361_000;
 rt=await home();assert.equal(rt.runtimes[0].status,'unknown');assert.equal(rt.runtimes[0].activity,undefined);assert.equal(rt.runtimes[0].models[0].state,'unknown');
 // What the provider hands home: no process id that could name a live process now, the runtime's or a model's; stats [].
 const provided=(await h.handler.state('agent').runtimes()).mini.runtimes[0];
 assert.deepEqual([provided.pids,provided.models[0].pids,provided.stats,provided.activity],[undefined,undefined,[],undefined]);
 clock+=3*21600_000;
 doc=await systems();mini=doc.machines.find(m=>m.id==='mini');
 assert.deepEqual([mini.source,mini.stale,mini.reachable,mini.error],['agent',true,true,null],'no news: stale, never off');
 assert.deepEqual(doc.collector.agents,{machines:1,fresh:0,noNews:1});
 // The trend: one line per machine at most every six hours, beside the record, never in the collector's history.jsonl.
 const trend=async()=>(await readText(path.join(h.dir,'agent','history.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual((await trend()).map(l=>[l.at,Object.keys(l.machines)]),[[receivedAt,['mini']]]);
 assert.deepEqual(Object.keys((await trend())[0].machines.mini),['os','software','apps','warn','crit','stale']);
 clock+=60_000;
 assert.equal((await report(key.token,envelope(systemsParts({name:'mini',collectedAt:'2026-11-14T05:00:00Z'})))).status,200);
 assert.equal((await trend()).length,2,'more than six hours later: a second line');
 clock+=1000_000;
 assert.equal((await report(key.token,envelope(systemsParts({name:'mini',collectedAt:'2026-11-14T05:20:00Z'})))).status,200);
 assert.equal((await trend()).length,2,'within six hours: none');
 assert.equal((await listDir(path.join(h.dir,'systems'))).includes('history.jsonl'),false);
});

test('agent records naming what every object inherits (SW, RUN, SHARE, AUTO, FW, SSHD) are data: no reader throws',()=>{
 const odd=[rec('SW','constructor','cmd','v1','/x'),rec('SW','toString','cmd','v2','/y'),rec('RUN','hasOwnProperty','123','job'),rec('RUN','__proto__','absent',''),
  rec('SHARE','constructor','loaded'),rec('SHARE','__proto__','loaded'),rec('AUTO','__proto__','1'),rec('AUTO','toString','0'),rec('SSHD','constructor','x'),rec('SSHD','__proto__','y')];
 const h=parseSystemsProbe([rec('HOST','mini','Darwin','alice','0','2026-11-13T11:44:00Z'),...odd,rec('END','ok')].join('\n'));
 assert.deepEqual(h.software.constructor.map(r=>r.value),['v1']);assert.equal(h.software.toString[0].value,'v2');
 assert.equal(h.running.hasOwnProperty.pid,123);assert.equal(h.running.__proto__.state,'absent');assert.equal(h.sharing.constructor,true);
 assert.equal(h.sshd.constructor,'x');assert.ok(Object.hasOwn(h.sshd,'__proto__'));assert.equal(Object.getPrototypeOf(h.sshd),Object.prototype);
 const now=Date.parse('2026-11-13T12:00:00Z');
 const lines=[...macAgent('0',ALL_MAC_PRIV),...odd];
 const doc=buildSystems({snapshot:{collectedAt:'2026-11-13T11:30:00.000Z',machines:{}},upstream,registry,now,agents:[{id:'mini',name:'Mac mini',record:agentRecord(lines)}]});
 const mini=doc.machines.find(m=>m.id==='mini');assert.equal(mini.source,'agent');assert.ok(mini.summary);
 // A watch item whose id is an inherited name reads nothing it was not given (a snapshot read back from JSON).
 const named={items:[{id:'constructor',name:'C',category:'ai',upstream:{type:'none'},detect:{studio:{kind:'cmd',path:'/x',args:'--version'}}}]};
 const json=buildSystems({snapshot:JSON.parse(JSON.stringify({collectedAt:'2026-11-08T12:00:00Z',machines:{studio:{...parseSystemsProbe(macProbe),stale:false}}})),upstream,registry:named,now});
 assert.equal(json.software.find(r=>r.id==='constructor').installed,null);
 // One machine's record that cannot be read at all is left out, and its collector record stands; the answer is whole.
 const bad=agentRecord(macAgent('0',ALL_MAC_PRIV));bad.parts.os.records=[{toString(){throw new Error('unreadable');}}];
 const C={...parseSystemsProbe(macProbe),stale:false,lastError:null,probedAt:'2026-11-13T11:30:00.000Z'};
 const both=buildSystems({snapshot:{collectedAt:'2026-11-13T11:30:00.000Z',machines:{mini:C}},upstream,registry,now,agents:[{id:'mini',name:'Mac mini',record:bad},{id:'studio',name:'Mac Studio',record:agentRecord(lines)}]});
 assert.equal(both.machines.find(m=>m.id==='mini').source,undefined,'the collector\'s, as without an agent');assert.equal(both.machines.find(m=>m.id==='studio').source,'agent');
});

test('a collector placeholder for a machine never reached has no time: an agent record that is no news wins, stale and reachable',()=>{
 // collect-systems' emptyRecord: complete false, no probedAt, no HOST time, no data.
 const placeholder={host:'mini',alias:'mini',complete:false,stale:false,lastError:'ssh: connect timed out',lastAttemptAt:'2026-11-13T11:00:00Z',os:{},hw:{},osUpdates:{checked:false,items:[]},
  autoUpdate:{},firewall:{},sshd:{allowUsers:[]},sharing:{},listening:[],software:{},running:{},brewOutdated:[],docker:[],apps:[],services:[],errors:[]};
 const m=buildSystems({snapshot:{collectedAt:'2026-11-13T11:00:00Z',machines:{mini:placeholder}},upstream,registry,now:Date.parse('2026-11-13T12:00:00Z'),snapshotTime:Date.parse('2026-11-13T11:00:00Z'),
  agents:[{id:'mini',name:'Mac mini',record:agentRecord(macAgent('0',ALL_MAC_PRIV,'2026-11-13T00:00:00Z'),{receivedAt:'2026-11-13T00:00:00.000Z',interval:900})}]}).machines.find(x=>x.id==='mini');
 assert.deepEqual([m.source,m.stale,m.reachable,m.error,m.os.version],['agent',true,true,null,'26.7.1']);
});

test('coverage counts a PRIV ok only with the records that read leaves',()=>{
 const now=Date.parse('2026-11-13T12:00:00Z');
 const C={...parseSystemsProbe(macProbe),stale:false,lastError:null,probedAt:'2026-11-13T11:30:00.000Z'};// root 1, current
 const pick=lines=>buildSystems({snapshot:{collectedAt:'2026-11-13T11:30:00.000Z',machines:{mini:C}},upstream,registry,now,
  agents:[{id:'mini',name:'Mac mini',record:agentRecord(lines,{receivedAt:'2026-11-13T11:45:00.000Z'})}]}).machines.find(m=>m.id==='mini');
 const bare=['pf-info','pf-rules','listen','sshd'].map(id=>rec('PRIV',id,'ok'));
 const without=[rec('HOST','mini','Darwin','alice','0','2026-11-13T11:44:00Z'),rec('OS','macOS','26.7.1','25G241','25.6.0','arm64'),...bare,rec('END','ok'),rec('SWU_NONE')];
 assert.equal(pick(without).source,'collector','four PRIV ok lines and no PF, SSHD or LISTEN record');
 assert.equal(pick(macAgent('0',[...bare,rec('PF','Enabled','12')])).source,'collector','no SSHD record from sshd -T');
 assert.equal(pick(macAgent('0',ALL_MAC_PRIV)).source,'agent');
});

test('readers: a revoked key, a reused device id, a changed platform and a machine that takes no key leave the agent records unread',async t=>{
 const {createAgentStore}=await import('../server/agent-store.mjs');
 const {mkdtemp:temp}=await import('node:fs/promises');
 // The router: an active key (written straight to the store, as no admin route issues one) and a stored os part.
 const state=await temp(path.join(os.tmpdir(),'hub-readers-'));let h,clock;
 try{
  await createAgentStore(state).issue({id:'router',createdAt:null});
  const routerRecord={...agentRecord(macAgent('0',ALL_MAC_PRIV),{receivedAt:'2026-11-13T09:59:00.000Z'}),machine:'router'};
  await mkdir(path.join(state,'agent'),{recursive:true});await writeFile(path.join(state,'agent','router.json'),JSON.stringify(routerRecord));
  // The hub's clock is the real one here: a device's createdAt is written by it.
  clock=Date.now();
  h=await readerHub(t,{thermoPoller:quiet,agentClock:()=>clock,stateDirectory:state});
 }finally{
  // state is the hub's state directory, so it goes after the hub: hooks run in the order they were registered, and one
  // that fails skips the rest. The hub still writes there after its last answer (the API write log is appended once
  // the response is out, server/index.mjs): an rm registered before the hub met such a line (ENOTEMPTY), the hub's
  // teardown never ran and its server kept the run alive. Hence also the retries, as in tests/hub-helper.mjs.
  t.after(()=>rm(state,{recursive:true,force:true,maxRetries:10,retryDelay:25}));}
 const report=reportTo(h),writer=await h.account('agent-home',['home:write']);
 const systems=async()=>(await (await fetch(h.origin+'/api/systems',{headers:h.admin})).json()).machines;
 const agentIds=async()=>(await systems()).filter(m=>m.source==='agent').map(m=>m.id).sort();
 assert.deepEqual(await agentIds(),[],'the router never takes an agent, whatever is stored');
 assert.equal((await systems()).some(m=>m.id==='router'),false);
 // A Mac site machine: read while its key lives, not once it is revoked.
 const mini=await issueAgent(h,'mini');
 // Its packages name what every object inherits: stored, shown, and the trend is written (no 500, no failed history).
 assert.equal((await report(mini.token,envelope(systemsParts({name:'mini',packages:[rec('SW','constructor','cmd','v1','/x'),rec('RUN','toString','123','job')]})))).status,200);
 assert.equal((await fetch(h.origin+'/api/systems',{headers:h.admin})).status,200);
 assert.deepEqual(await agentIds(),['mini']);
 assert.deepEqual(Object.keys(JSON.parse(await readText(path.join(state,'agent','history.jsonl'),'utf8')).machines),['mini']);
 assert.equal((await h.post('/api/admin/agents/revoke',{id:mini.agent.id},h.admin)).status,200);
 assert.deepEqual(await agentIds(),[],'revoked: no longer trusted');
 // An added device: a report, then the device goes and one with the same id comes; a new key, no report yet.
 const pi={id:'pi-hole',name:'Pi-hole',hostname:'pi.example.lan',ip:'10.0.0.53',role:'other'};
 let made=await (await h.post('/api/home/machines',{machine:pi},writer.headers)).json();
 const k1=await issueAgent(h,'pi-hole');await new Promise(r=>setTimeout(r,3));clock=Date.now();
 assert.equal((await report(k1.token,envelope(systemsParts({name:'pi'})))).status,200);
 assert.deepEqual(await agentIds(),['pi-hole']);
 // The platform is set to linux: the stored macos record is not read, though the key stays.
 const listed=async()=>(await (await fetch(h.origin+'/api/home/machines',{headers:h.admin})).json()).machines.find(m=>m.id==='pi-hole');
 made=await (await h.post('/api/home/machines',{machine:{...pi,platform:'linux'},base:(await listed()).hash},writer.headers)).json();
 assert.deepEqual(await agentIds(),[],'a record of another platform than the machine now says');
 assert.equal((await h.post('/api/home/machines/remove',{id:'pi-hole',base:(await listed()).hash},writer.headers)).status,200);
 await new Promise(r=>setTimeout(r,3));
 assert.equal((await h.post('/api/home/machines',{machine:pi},writer.headers)).status,201);
 await issueAgent(h,'pi-hole');// the sweep revokes the old key
 assert.deepEqual(await agentIds(),[],'parts received before the device was created belong to the earlier machine');
});
