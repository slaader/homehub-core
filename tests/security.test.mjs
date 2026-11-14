import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {buildSecurity,parseAuthorizedLine,parseProbe,sudoVerdict,classifyKey,readableComment,fingerprintOf} from '../server/security-data.mjs';
import {createHandler} from '../server/index.mjs';
import {hashPassword} from '../server/auth.mjs';

// Throwaway public keys (private halves discarded); fingerprints from ssh-keygen -lf.
const A={pub:'AAAAC3NzaC1lZDI1NTE5AAAAIFfQ8Wbh6Bm3L2SvIBI8IhN2Z4+/6xWmUrll9fX44L6N',fp:'SHA256:hw9LTx1XLrOYQQmR5CvKNvxy8zEUy+t8ZjYo44mM6zg'};
const B={pub:'AAAAC3NzaC1lZDI1NTE5AAAAIDia2/QPcp+YZqgHSzGzCRJgmOljAYsfVR2qjoJPDego',fp:'SHA256:8bX+tphjMek330TUGqiYcVLJAp/KUNNHcg7EImOoLBM'};
const T='\t';
const rec=(...f)=>f.join(T);

test('fingerprints match ssh-keygen',()=>{
 assert.equal(fingerprintOf(A.pub),A.fp);
 assert.equal(fingerprintOf(B.pub),B.fp);
});

test('authorized_keys options: quoted commas, from list, restrict, permitopen',()=>{
 const e=parseAuthorizedLine(`from="10.0.0.25,10.0.0.220",command="python3 -u relay.py a,b",no-pty,restrict,permitopen="127.0.0.1:8788" ssh-ed25519 ${A.pub} mac mini key`);
 assert.equal(e.fingerprint,A.fp);assert.equal(e.type,'ssh-ed25519');assert.equal(e.comment,'mac mini key');
 assert.deepEqual(e.options.from,['10.0.0.25','10.0.0.220']);
 assert.equal(e.options.command,'python3 -u relay.py a,b');
 assert.equal(e.options.restrict,true);assert.deepEqual(e.options.permitOpen,['127.0.0.1:8788']);assert.deepEqual(e.options.flags,['no-pty']);
 assert.equal(parseAuthorizedLine('# comment only'),null);
 assert.equal(parseAuthorizedLine(`ssh-ed25519 ${B.pub}`).comment,'');
});

test('sudo verdicts: password-less ALL, password, limited, expired, none, root',()=>{
 const v=rules=>sudoVerdict({user:'u',uid:501,sudoState:'rules',sudoRules:rules},Date.parse('2026-11-08T12:00:00Z'));
 assert.equal(v(['(ALL) ALL, NOPASSWD: ALL']).level,'nopasswd');
 assert.equal(v(['(ALL) ALL']).level,'password');
 assert.equal(v(['(ALL : ALL) ALL']).level,'password');
 const limited=v(['(root) NOPASSWD: /bin/launchctl kickstart -k system/x, /bin/launchctl bootout system/y']);
 assert.equal(limited.level,'limited');assert.equal(limited.commands.length,2);
 const expired=v(['(root) NOTAFTER=20261106155726Z NOPASSWD: ALL','(ALL) ALL']);
 assert.equal(expired.level,'password');assert.equal(expired.expired.length,1);
 assert.equal(v(['(root) NOTAFTER=20991106155726Z NOPASSWD: ALL']).level,'nopasswd');
 assert.equal(sudoVerdict({user:'x',uid:3001,sudoState:'none',sudoRules:[]}).level,'none');
 assert.equal(sudoVerdict({user:'root',uid:0,sudoState:'rules',sudoRules:['(ALL) ALL']}).level,'root');
});

test('key classification and comment clean-up',()=>{
 assert.equal(classifyKey('/Users/alice/.ssh/id_ed25519',true).kind,'ssh');
 assert.equal(classifyKey('/Users/alice/local-ai/runtime/forgejo/data/ssh/forgejo.ed25519',true).kind,'ssh-host');
 assert.equal(classifyKey('/Users/alice/local-ai/runtime/certs/home-wildcard/privkey.pem',true).kind,'tls');
 assert.equal(classifyKey('/mnt/HDDs/Applications/gitea/data/jwt/private.pem',true).kind,'signing');
 assert.equal(classifyKey('/Users/alice/.t3/userdata/secrets/cloud-link-ed25519-key-pair.bin',false).kind,'app');
 assert.equal(readableComment('alice@0e\\303\\257\\302\\277\\302\\275U'),'');
 assert.equal(readableComment('studio->mini'),'studio->mini');
});

// Two devices: key A lives on "studio" and is authorized on "nas" (sudo without password);
// key B is authorized on nas but its private half is nowhere; a stale key C opens nothing.
const studioProbe=[
 rec('HOST','studio','Darwin','alice','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.151'),rec('LISTEN','on'),
 rec('SSHD','passwordauthentication','yes'),rec('SSHD','allowusers','alice@10.0.0.25'),
 rec('USER','alice','501','/Users/alice','/bin/zsh','1'),rec('SUDO','alice','rule','(ALL) NOPASSWD: ALL'),
 rec('CFG','alice','nas','10.0.0.74','22','admin','~/.ssh/id_a|','','yes'),
 rec('CFG','alice','gone','10.0.0.74','22','root','~/.ssh/id_a|','','yes'),
 rec('KEY','/Users/alice/.ssh/id_a','600','alice','1793480361','OPENSSH','no',`256 ${A.fp} studio->nas (ED25519)`),
 rec('KEY','/Users/alice/.ssh/backup-1/id_a','644','alice','1793480361','OPENSSH','no',`256 ${A.fp} old name (ED25519)`),
 rec('KEY','/Users/alice/.ssh/id_c','600','alice','1793480361','OPENSSH','yes','256 SHA256:ccccccccccccccccccccccccccccccccccccccccccc stale (ED25519)'),
 rec('KEY','/Users/alice/certs/privkey.pem','600','alice','1793480361','','no','256 SHA256:dddd no comment (ECDSA)'),
 rec('END','ok')].join('\n');
const nasProbe=[
 rec('HOST','nas','Linux','admin','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.74','172.16.0.1'),rec('LISTEN','on'),rec('SSHD','passwordauthentication','no'),
 rec('USER','root','0','/root','/usr/bin/zsh','1'),rec('SUDO','root','rule','(ALL : ALL) ALL'),
 rec('USER','admin','3003','/mnt/home/admin','/usr/bin/zsh','1'),rec('SUDO','admin','rule','(ALL) ALL, NOPASSWD: ALL'),
 rec('AUTH','admin','/mnt/home/admin/.ssh/authorized_keys',`from="10.0.0.151" ssh-ed25519 ${A.pub} studio->nas`),
 rec('AUTH','admin','/mnt/home/admin/.ssh/authorized_keys',`ssh-ed25519 ${B.pub} phone`),
 rec('END','ok')].join('\n');

test('probe records parse into accounts, routes and keys',()=>{
 const h=parseProbe(nasProbe);
 assert.equal(h.complete,true);assert.deepEqual(h.ips,['10.0.0.74','172.16.0.1']);
 assert.equal(h.accounts.length,2);assert.equal(h.auth.length,2);assert.equal(h.auth[0].file,'/mnt/home/admin/.ssh/authorized_keys');
 const s=parseProbe(studioProbe);assert.equal(s.routes[0].identityFiles[0],'~/.ssh/id_a');assert.equal(s.keys[0].encrypted,false);
});

test('build joins keys to what they open and flags the risks',()=>{
 const doc=buildSecurity({probes:{studio:{text:studioProbe},nas:{text:nasProbe},mini:{error:'ssh: connect timed out'}},
  descriptors:{studio:{id:'studio',name:'Mac Studio',addresses:[{ip:'10.0.0.151'}]},nas:{id:'nas',name:'NAS',hostname:'nas.example.lan',addresses:[{ip:'10.0.0.74'}]}},
  forgejo:{users:[{login:'alice',isAdmin:true,keys:[{title:'studio',key:`ssh-ed25519 ${A.pub}`}]}],deployKeys:[]},
  extraDevices:[{id:'router',sshOpen:false,note:'SSH off'}],now:Date.parse('2026-11-08T12:00:00Z')});
 const a=doc.keys.find(k=>k.fingerprint===A.fp);
 assert.equal(a.name,'id_a','label comes from the primary copy, not the backup');assert.equal(a.comment,'studio->nas');
 assert.equal(a.copies.length,2);assert.equal(a.copies.find(c=>c.path.includes('backup')).backup,true);
 const nas=a.access.find(x=>x.target.kind==='host');
 assert.equal(nas.target.device,'nas');assert.equal(nas.target.user,'admin');assert.deepEqual(nas.target.ips,['10.0.0.74']);
 assert.equal(nas.sudo,'nopasswd');assert.deepEqual(nas.from,['10.0.0.151']);
 assert.ok(a.access.some(x=>x.target.kind==='forgejo'&&x.sudo==='forgejo-admin'));
 assert.equal(a.routes.find(r=>r.alias==='nas').accepted,true);
 assert.equal(a.routes.find(r=>r.alias==='gone').accepted,false,'root@nas does not accept the key');
 assert.deepEqual(doc.unknownAuthorized.map(u=>u.comment),['phone']);
 assert.equal(doc.otherKeys[0].kind,'tls');
 assert.equal(doc.devices.find(m=>m.id==='mini').reachable,false);
 assert.equal(doc.devices.at(-1).id,'router');
 const titles=doc.findings.map(f=>f.title).join('\n');
 assert.match(titles,/klíčů bez passphrase otevírá účet se sudo bez hesla/);
 assert.match(titles,/id_c \(stale\): nikam nevede/);
 assert.match(titles,/soubor čitelný i pro ostatní \(644\)/);
 assert.match(titles,/cizí klíč „phone“/);
 assert.match(titles,/Mac Studio: SSH přijímá i heslo/);
 assert.match(titles,/alias „gone“/);
 assert.equal(doc.findings[0].level,'high','most severe first');
 assert.doesNotMatch(JSON.stringify(doc),/AAAAC3/,'snapshot keeps fingerprints, not key blobs');
});

test('/api/security: sign-in required, admin only, 404 until collected',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-sec-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const origin='http://127.0.0.1:8998',credentials={username:'admin',...hashPassword('test-security-password')};
 const server=http.createServer(createHandler({directory:dir,stateDirectory:dir,credentials,origin,secure:false,bridgeRequest:async()=>{throw new Error('offline');}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections?.();return new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(`${base}/api/security`)).status,401);
 const login=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password:'test-security-password'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const missing=await fetch(`${base}/api/security`,{headers:{Cookie:cookie}});
 assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'SECURITY_MISSING');
 const doc=buildSecurity({probes:{nas:{text:nasProbe}},now:Date.now()});
 await mkdir(path.join(dir,'security'),{recursive:true});await writeFile(path.join(dir,'security','ssh-keys.json'),JSON.stringify(doc));
 const ok=await fetch(`${base}/api/security`,{headers:{Cookie:cookie}});
 assert.equal(ok.status,200);assert.equal((await ok.json()).devices[0].id,'nas');
 const js=await fetch(`${base}/security-view.js`);assert.equal(js.status,200);
 const css=await fetch(`${base}/security.css`);assert.equal(css.status,200);
});

test('authorized_keys `restrict` does not count as a command restriction; only command= does',()=>{
 const probe=(opts)=>[
  rec('HOST','nas','Linux','admin','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.74'),rec('LISTEN','on'),rec('SSHD','passwordauthentication','no'),
  rec('USER','admin','3003','/mnt/home/admin','/usr/bin/zsh','1'),rec('SUDO','admin','rule','(ALL) NOPASSWD: ALL'),
  rec('AUTH','admin','/mnt/home/admin/.ssh/authorized_keys',`${opts} ssh-ed25519 ${A.pub} studio->nas`),rec('END','ok')].join('\n');
 const studio=[rec('HOST','studio','Darwin','alice','1','2026-11-08T12:00:00Z'),rec('NET','10.0.0.151'),rec('LISTEN','on'),
  rec('USER','alice','501','/Users/alice','/bin/zsh','1'),
  rec('KEY','/Users/alice/.ssh/id_a','600','alice','1793480361','OPENSSH','no',`256 ${A.fp} studio->nas (ED25519)`),rec('END','ok')].join('\n');
 const build=opts=>buildSecurity({probes:{studio:{text:studio},nas:{text:probe(opts)}},
  descriptors:{studio:{id:'studio',name:'Mac Studio',addresses:[{ip:'10.0.0.151'}]},nas:{id:'nas',name:'NAS',addresses:[{ip:'10.0.0.74'}]}},now:Date.parse('2026-11-08T12:00:00Z')});
 for(const opts of ['restrict','restrict,permitopen="127.0.0.1:8788"']){
  const doc=build(opts);
  const access=doc.keys.find(k=>k.fingerprint===A.fp).access.find(x=>x.target.kind==='host');
  assert.equal(access.restricted,false,`${opts}: commands are still allowed`);assert.equal(access.noForwarding,true);
  const entry=doc.devices.find(m=>m.id==='nas').accounts[0].authorizedKeys[0];assert.equal(entry.restricted,false);assert.equal(entry.noForwarding,true);
  const titles=doc.findings.map(f=>f.title).join('\n');
  assert.match(titles,/klíčů bez passphrase otevírá účet se sudo bez hesla/,`${opts}: root warning stays`);
  assert.match(titles,/NAS \(admin\): klíč „studio->nas“ bez omezení adresy/,`${opts}: unrestricted-address warning stays`);
 }
 const forced=build('restrict,command="/usr/local/bin/backup-only"');
 const fa=forced.keys.find(k=>k.fingerprint===A.fp).access.find(x=>x.target.kind==='host');
 assert.equal(fa.restricted,true);assert.equal(fa.noForwarding,true);
 const ft=forced.findings.map(f=>f.title).join('\n');
 assert.doesNotMatch(ft,/klíčů bez passphrase otevírá účet se sudo bez hesla/,'a forced command does constrain the key');
 assert.doesNotMatch(ft,/bez omezení adresy/);
});

// --- push agents: the inventory rebuilt with the agents' sshkeys parts (docs/agent.md §3, §6; step 2) -------------
import {readFile as readText,utimes,stat} from 'node:fs/promises';
import {loadSecurity,agentKeysProbe,SECURITY_PROBES_SCHEMA} from '../server/security-data.mjs';
import {collectSecurity} from '../scripts/collect-security.mjs';
import {SITE} from './hub-helper.mjs';
import {readerHub,READERS_DIR} from './support/readers.mjs';
import {envelope,reportTo,issueAgent,quiet} from './support/agent.mjs';

// A stored agent record with one sshkeys part.
const keysRecord=(lines,{receivedAt='2026-11-13T11:45:00.000Z',interval=21600}={})=>({schemaVersion:2,device:'x',agentId:'0123456789abcdef',agentVersion:'1.6.0',platform:'macos',
 lastSeenAt:receivedAt,lastSentAt:receivedAt,parts:{sshkeys:{schema:1,collectedAt:'2026-11-13T11:44:00Z',receivedAt,interval,digest:'0'.repeat(64),withheld:[],records:lines}}});
const withRoot=(text,root)=>text.replace(/^(HOST\t[^\t]*\t[^\t]*\t[^\t]*\t)[01]/m,`$1${root}`);

test('an agent\'s sshkeys cannot change another device\'s routes or records: its HOST name and NET decide nothing',()=>{
 // "pi" (an added device: no address in the site) says it is "nas" at nas's address, and authorizes key A for admin.
 const liar=[rec('HOST','nas','Linux','alice','1','2026-11-13T11:44:00Z'),rec('NET','10.0.0.74'),rec('LISTEN','on'),
  rec('USER','admin','3003','/home/admin','/bin/sh','1'),rec('SUDO','admin','rule','(ALL) NOPASSWD: ALL'),
  rec('AUTH','admin','/home/admin/.ssh/authorized_keys',`ssh-ed25519 ${A.pub} planted`),rec('END','ok')].join('\n');
 // studio also has a route to the short name "nas", which pi's HOST line claims too.
 const studio=studioProbe.replace(rec('END','ok'),[rec('CFG','alice','nasname','nas','22','admin','~/.ssh/id_a|','','yes'),rec('END','ok')].join('\n'));
 const build=agent=>buildSecurity({probes:{studio:{text:studio},nas:{text:nasProbe},pi:{text:liar,...(agent?{agent:true,receivedAt:'2026-11-13T11:45:00.000Z',source:'agent',sourceAt:'2026-11-13T11:45:00.000Z'}:{})}},
  descriptors:{studio:{id:'studio',name:'Mac Studio',addresses:[{ip:'10.0.0.151'}]},pi:{id:'pi',name:'Pi'}},now:Date.parse('2026-11-08T12:00:00Z')});
 const doc=build(true),a=doc.keys.find(k=>k.fingerprint===A.fp);
 assert.equal(a.routes.find(r=>r.alias==='nas').target.device,'nas','studio\'s route to 10.0.0.74 still reaches the NAS');
 assert.equal(a.routes.find(r=>r.alias==='nasname').target.device,'nas','and its route to the name "nas" too: the HOST name decides nothing');
 assert.ok(a.copies.every(c=>c.source===undefined),'studio\'s copies are the collector\'s');
 assert.deepEqual(a.access.filter(x=>x.target.device==='pi').map(x=>x.source),['agent'],'what pi says about itself is marked as the agent\'s');
 assert.deepEqual(doc.devices.find(m=>m.id==='nas').ips,['10.0.0.74']);assert.deepEqual(doc.devices.find(m=>m.id==='pi').ips,[]);
 assert.deepEqual(doc.devices.find(m=>m.id==='nas').accounts.map(x=>x.user),['root','admin'],'the NAS record is the NAS probe\'s');
 assert.ok(a.access.some(x=>x.target.device==='pi'),'what pi says lands on pi alone');
 assert.deepEqual(a.access.filter(x=>x.target.device==='nas').map(x=>x.target.user),['admin']);
 const pi=doc.devices.find(m=>m.id==='pi');
 assert.deepEqual([pi.source,pi.collectedAt,pi.deviceCollectedAt],['agent','2026-11-13T11:45:00.000Z','2026-11-13T11:44:00Z'],'the receive time in place of HOST');
 // The same probe from a collector would have taken the name and the address: that is what the rule prevents.
 const collected=build(false).keys.find(k=>k.fingerprint===A.fp);
 assert.equal(collected.routes.find(r=>r.alias==='nas').target.device,'pi');assert.equal(collected.routes.find(r=>r.alias==='nasname').target.device,'pi');
});

test('collect-security writes probes.json beside its file; loadSecurity rebuilds with the winner per device, or leaves ssh-keys.json as it was',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-keys-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const out=path.join(dir,'security','ssh-keys.json'),site={...SITE,devices:SITE.devices.filter(m=>['studio','nas'].includes(m.id))};
 const exec=async(cmd,argv)=>cmd==='hostname'?{code:0,stdout:'collector\n',stderr:''}:cmd==='/bin/sh'?{code:0,stdout:studioProbe+'\n',stderr:''}:{code:0,stdout:nasProbe+'\n',stderr:''};
 const now=Date.parse('2026-11-13T11:00:00Z');
 const doc=await collectSecurity({site,hosts:new Map([['studio','local'],['nas','nas-admin']]),out,exec,forgejo:false,portOpen:async()=>false,now,clock:()=>now,devicesDir:path.join(dir,'devices')});
 const probes=JSON.parse(await readText(path.join(dir,'security','probes.json'),'utf8'));
 assert.deepEqual(Object.keys(probes),['schemaVersion','collectedAt','collectedFrom','probes','forgejo','extraDevices']);
 assert.equal(probes.schemaVersion,SECURITY_PROBES_SCHEMA);assert.equal(probes.collectedAt,doc.collectedAt);
 assert.deepEqual(probes.probes.studio,{text:studioProbe+'\n',probedAt:'2026-11-13T11:00:00.000Z'});
 assert.deepEqual((await stat(path.join(dir,'security','probes.json'))).mode&0o777,0o600);
 await utimes(path.join(dir,'security','probes.json'),new Date(now),new Date(now));
 const load=(agents,at=Date.parse('2026-11-13T12:00:00Z'))=>loadSecurity(dir,out,{agents,site,now:at,devicesDir:path.join(dir,'devices')});
 // Without an agent's sshkeys part: the file exactly as it was.
 assert.deepEqual(await load([]),JSON.parse(await readText(out,'utf8')));
 const studioAgent=root=>[{id:'studio',name:'Mac Studio',record:keysRecord(withRoot(studioProbe,root).replaceAll('/id_a','/id_agent').split('\n'))}];
 // Root 0 against the collector's current root 1: less access never replaces more.
 let joined=await load(studioAgent('0')),studio=joined.devices.find(m=>m.id==='studio');
 assert.deepEqual(joined.agents,{joined:true,devices:1,fresh:1,noNews:0});
 assert.deepEqual([studio.source,studio.sourceAt],['collector','2026-11-13T11:00:00.000Z']);assert.equal(joined.keys.find(k=>k.fingerprint===A.fp).copies[0].path,'/Users/alice/.ssh/id_a');
 assert.equal(joined.collectedAt,'2026-11-13T11:45:00.000Z');assert.equal(joined.collectorCollectedAt,doc.collectedAt);
 // Root 1 and newer: the agent's; its HOST time replaced by the receive time. Forgejo and the router stay the collector's.
 joined=await load(studioAgent('1'));studio=joined.devices.find(m=>m.id==='studio');
 assert.deepEqual([studio.source,studio.collectedAt,studio.deviceCollectedAt],['agent','2026-11-13T11:45:00.000Z','2026-11-08T12:00:00Z']);
 assert.equal(joined.keys.find(k=>k.fingerprint===A.fp).copies[0].path,'/Users/alice/.ssh/id_agent');
 assert.equal(joined.devices.find(m=>m.id==='nas').source,undefined,'a device without an agent is as it was');
 // A collector probe without its END line is not complete, so not current: a fresh, complete agent record wins with less access.
 const complete=await readText(path.join(dir,'security','probes.json'),'utf8'),cut=JSON.parse(complete);
 cut.probes.studio.text=cut.probes.studio.text.replace(/END\tok\n?/,'');await writeFile(path.join(dir,'security','probes.json'),JSON.stringify(cut));
 await utimes(path.join(dir,'security','probes.json'),new Date(now),new Date(now));
 studio=(await load(studioAgent('0'))).devices.find(m=>m.id==='studio');
 assert.deepEqual([studio.source,studio.complete],['agent',true]);
 await writeFile(path.join(dir,'security','probes.json'),complete);await utimes(path.join(dir,'security','probes.json'),new Date(now),new Date(now));
 // The collector's record older than its stale-after (30 h): the agent wins with less access.
 joined=await load(studioAgent('0'),Date.parse('2026-11-14T18:00:00Z'));
 assert.equal(joined.devices.find(m=>m.id==='studio').source,'agent');assert.deepEqual(joined.agents,{joined:true,devices:1,fresh:0,noNews:1});
 // An older collector rewrote ssh-keys.json only: probes.json is from another run, so nothing is joined.
 const legacy={...JSON.parse(await readText(out,'utf8')),collectedAt:'2026-11-13T11:30:00.000Z'};await writeFile(out,JSON.stringify(legacy));
 assert.deepEqual(await load(studioAgent('1')),{...legacy,agents:{joined:false,reason:'probes-outdated',devices:1,fresh:1,noNews:0}});
 await rm(path.join(dir,'security','probes.json'));
 assert.equal((await load(studioAgent('1'))).agents.reason,'probes-missing');
 // No inventory at all, only an agent: built from the agent alone.
 await rm(out);assert.equal(await load([]),null);
 const alone=await load(studioAgent('0'));assert.deepEqual(alone.devices.map(m=>[m.id,m.source]),[['studio','agent']]);assert.equal(alone.collectorCollectedAt,null);
 assert.equal(agentKeysProbe({parts:{}}),null);
});

test('over HTTP: /api/security joins an agent\'s sshkeys part with the receive time; the collector state stays the collector\'s',async t=>{
 let clock=Date.parse('2026-11-13T10:00:00Z');
 const h=await readerHub(t,{thermoPoller:quiet,agentClock:()=>clock});
 // The fixture inventory with the probes.json its collector run wrote (texts from tests/fixtures/readers).
 const texts=Object.fromEntries(await Promise.all(['studio','nas'].map(async id=>[id,(await readText(path.join(READERS_DIR,`ssh-probe-${id}.txt`),'utf8')).trimEnd()]))),inv=JSON.parse(await readText(path.join(h.dir,'security','ssh-keys.json'),'utf8'));
 await writeFile(path.join(h.dir,'security','probes.json'),JSON.stringify({schemaVersion:2,collectedAt:inv.collectedAt,collectedFrom:'studio',
  probes:{studio:{text:texts.studio,probedAt:inv.collectedAt},nas:{text:texts.nas,probedAt:inv.collectedAt},mini:{error:'ssh: connect timed out'}},forgejo:null,extraDevices:[{id:'router',sshOpen:false,note:'SSH off'}]}));
 const key=await issueAgent(h,'mini');
 const lines=[rec('HOST','mini','Darwin','alice','0','2027-11-13T10:00:00Z'),rec('NET','10.0.0.74'),rec('LISTEN','on'),rec('USER','alice','501','/Users/alice','/bin/zsh','1'),
  rec('KEY','/Users/alice/.ssh/id_a','600','alice','1793480361','OPENSSH','no',`256 ${A.fp} mini copy (ED25519)`),rec('END','ok')];
 const r=await reportTo(h)(key.token,envelope({sshkeys:{schema:1,collectedAt:'2027-11-13T10:00:00Z',interval:21600,records:lines}},{sentAt:'2027-11-13T10:00:00Z'}));
 assert.equal(r.status,200);const {receivedAt}=await r.json();
 const doc=await (await fetch(h.origin+'/api/security',{headers:h.admin})).json(),mini=doc.devices.find(m=>m.id==='mini');
 assert.deepEqual([mini.source,mini.reachable,mini.collectedAt,mini.deviceCollectedAt],['agent',true,receivedAt,'2027-11-13T10:00:00Z']);
 assert.deepEqual(mini.ips,['10.0.0.25'],'the site\'s address, not the NET line');
 assert.deepEqual(doc.keys.find(k=>k.fingerprint===A.fp).copies.map(c=>[c.device,c.source??null]).sort(),[['mini','agent'],['studio',null]],'a copy the agent reported is marked');
 assert.equal(doc.collectedAt,receivedAt);assert.equal(doc.collector.collectedAt,'2026-11-08T12:00:00.000Z','the collector state is the collector\'s');
 assert.deepEqual(doc.provenance.kinds.map(k=>[k.id,k.kind,k.count]),[['security','collector',2],['agents','telemetry',1]]);
 assert.equal(doc.devices.at(-1).id,'router','the router entry stays the collector\'s');
});

test('an agent\'s sshkeys naming an inherited key (SSHD constructor) is data, and a part that cannot be read is left out',async t=>{
 const h=parseProbe([rec('HOST','x','Darwin','alice','0','2026-11-13T11:44:00Z'),rec('SSHD','constructor','x'),rec('SSHD','__proto__','y'),rec('SSHD','passwordauthentication','no'),rec('END','ok')].join('\n'));
 assert.deepEqual(h.sshd.constructor,['x']);assert.deepEqual(h.sshd.__proto__,['y']);
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-keys-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const out=path.join(dir,'security','ssh-keys.json'),site={...SITE,devices:SITE.devices.filter(m=>['studio','nas'].includes(m.id))};
 const exec=async(cmd)=>cmd==='hostname'?{code:0,stdout:'collector\n',stderr:''}:cmd==='/bin/sh'?{code:0,stdout:studioProbe+'\n',stderr:''}:{code:0,stdout:nasProbe+'\n',stderr:''};
 const now=Date.parse('2026-11-13T11:00:00Z');
 await collectSecurity({site,hosts:new Map([['studio','local'],['nas','nas-admin']]),out,exec,forgejo:false,portOpen:async()=>false,now,clock:()=>now,devicesDir:path.join(dir,'devices')});
 const lines=[rec('HOST','studio','Darwin','alice','1','2026-11-13T11:44:00Z'),rec('SSHD','constructor','x'),rec('USER','alice','501','/Users/alice','/bin/zsh','1'),rec('END','ok')];
 const bad=keysRecord(lines);bad.parts.sshkeys.records=[{toString(){throw new Error('unreadable');}}];
 const doc=await loadSecurity(dir,out,{agents:[{id:'studio',name:'Mac Studio',record:keysRecord(lines)},{id:'nas',name:'NAS',record:bad}],site,now:Date.parse('2026-11-13T12:00:00Z'),devicesDir:path.join(dir,'devices')});
 assert.deepEqual(doc.devices.map(m=>[m.id,m.source??null]),[['studio','agent'],['nas',null]]);
 assert.deepEqual(doc.agents,{joined:true,devices:1,fresh:1,noNews:0});
});

test('collect-security writes probes.json before ssh-keys.json: a write that fails on the inventory leaves the older inventory alone',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-keys-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const out=path.join(dir,'security','ssh-keys.json'),site={...SITE,devices:SITE.devices.filter(m=>m.id==='studio')};
 await mkdir(out,{recursive:true});// the inventory cannot be renamed into place
 const exec=async cmd=>cmd==='hostname'?{code:0,stdout:'collector\n',stderr:''}:{code:0,stdout:studioProbe+'\n',stderr:''};
 await assert.rejects(collectSecurity({site,hosts:new Map([['studio','local']]),out,exec,forgejo:false,portOpen:async()=>false,devicesDir:path.join(dir,'devices')}));
 assert.equal(JSON.parse(await readText(path.join(dir,'security','probes.json'),'utf8')).schemaVersion,SECURITY_PROBES_SCHEMA,'probes.json came first');
});
