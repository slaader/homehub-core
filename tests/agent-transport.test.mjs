// The push agent's transport (scripts/agent/transport.mjs over server/endpoint-http.mjs; docs/agent.md §4, §6): the
// hub is trusted by the system store, a CA file or one or two pins, and fails closed: a wrong pin, an unknown CA or a
// wrong name, plain HTTP to anything but 127.0.0.1 and a redirect write no request. The answer is bounded in size
// and time, and only its status, Retry-After and acknowledgement are read. Against real servers on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createHash,X509Certificate} from 'node:crypto';
import {endpointRequest,trustOf} from '../server/endpoint-http.mjs';
import {sendReport,readAck,retryAfterOf,TRANSPORT_LIMITS} from '../scripts/agent/transport.mjs';
import {parseHub,parseConfig,transportTrust} from '../scripts/agent/config.mjs';

const fx=n=>readFileSync(new URL(`./fixtures/${n}`,import.meta.url),'utf8');
const [cert,key,otherCert,otherKey]=['tls-test.crt','tls-test.key','tls-other.crt','tls-other.key'].map(fx);
const pin=pem=>createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
const TOKEN='hha_'+'c'.repeat(64);
const envelope={v:1,agentVersion:'1.6.0',platform:'macos',sentAt:'2026-11-13T10:00:00Z',parts:{heartbeat:{schema:1,interval:60}}};
// A hub stand-in: records what arrived (path, Authorization, body length) and answers with handler.
async function serve(t,handler,{secure=true,pair=[cert,key]}={}){
 const seen=[];
 const on=(q,r)=>{const chunks=[];q.on('data',c=>chunks.push(c));q.on('end',()=>{seen.push({url:q.url,method:q.method,auth:q.headers.authorization||null,type:q.headers['content-type'],body:Buffer.concat(chunks).toString('utf8')});handler(q,r);});};
 const s=secure?https.createServer({cert:pair[0],key:pair[1]},on):http.createServer(on);
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections?.();s.close(r);}));
 return {port:s.address().port,seen};
}
const answer=(status,body,headers={})=>(q,r)=>{r.writeHead(status,{'Content-Type':'application/json',...headers});r.end(typeof body==='string'?body:JSON.stringify(body));};
const ok=answer(200,{receivedAt:'2026-11-13T10:00:01.000Z',accepted:['heartbeat'],refused:[]});
const hubAt=(host,port,secure=true)=>({host,port,secure});

test('the hub origin: https to a name or IPv4, http only to the literal 127.0.0.1; trust fails closed',()=>{
 assert.deepEqual(parseHub('https://hub.example.lan'),{host:'hub.example.lan',port:443,secure:true,origin:'https://hub.example.lan'});
 assert.deepEqual(parseHub('http://127.0.0.1:8781/'),{host:'127.0.0.1',port:8781,secure:false,origin:'http://127.0.0.1:8781'});
 for(const bad of ['http://10.0.0.5:8781','http://localhost:8781','http://[::1]:8781','https://[::1]','http://127.0.0.2','https://user:pw@hub.example.lan','https://hub.example.lan/api',
  'https://hub.example.lan?x=1','ftp://hub.example.lan','hub.example.lan','https://-x.example.lan',42,null])assert.equal(parseHub(bad),null,String(bad));
 const cfg=(trust,hub='https://hub.example.lan')=>parseConfig(JSON.stringify({schema:1,hub,...(trust===undefined?{}:{trust})}),{platform:'macos'});
 assert.equal(cfg(undefined).config.trust.mode,'system');
 assert.deepEqual(cfg({pins:['a'.repeat(64),'b'.repeat(64)]}).config.trust,{mode:'pin',pins:['a'.repeat(64),'b'.repeat(64)]});
 for(const bad of [{pins:[]},{pins:['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]},{pins:['A'.repeat(64)]},{pins:['a'.repeat(64),'a'.repeat(64)]},{ca:'relative.pem'},{insecure:true},{pins:['a'.repeat(64)],ca:'/x.pem'},{}])
  assert.equal(cfg(bad).ok,false,JSON.stringify(bad));
 assert.equal(cfg({pins:['a'.repeat(64)]},'http://127.0.0.1:8781').ok,false,'no pin on plain HTTP');
 assert.equal(transportTrust(cfg(undefined,'http://127.0.0.1:8781').config),null);
 assert.throws(()=>transportTrust(cfg({ca:'/etc/home-hub-agent/hub-ca.pem'}).config,'not a pem'),/ca-invalid/);
 // endpoint-http: one or two pins, a CA PEM, the system store; nothing else.
 assert.deepEqual(trustOf({mode:'pin',pin:'a'.repeat(64)}),{pins:['a'.repeat(64)]});
 assert.deepEqual(trustOf({mode:'system'}),{system:true});assert.deepEqual(trustOf({mode:'ca'}),{system:true});
 for(const bad of [{mode:'pin',pins:[]},{mode:'pin',pins:['x']},{mode:'ca',ca:'x'},{mode:'insecure'},null])assert.equal(trustOf(bad),null,JSON.stringify(bad));
});

test('pins: the right one (of two) sends; a wrong pin writes no request and no body',async t=>{
 const s=await serve(t,ok);
 const r=await sendReport({hub:hubAt('127.0.0.1',s.port),trust:{mode:'pin',pins:[pin(otherCert),pin(cert)]},token:TOKEN,envelope});
 assert.equal(r.status,200);assert.deepEqual(r.ack.accepted,['heartbeat']);
 assert.equal(s.seen.length,1);assert.equal(s.seen[0].url,'/api/agent/report');assert.equal(s.seen[0].method,'POST');
 assert.equal(s.seen[0].auth,`Bearer ${TOKEN}`);assert.equal(s.seen[0].type,'application/json','exactly application/json, no charset');
 assert.deepEqual(JSON.parse(s.seen[0].body),envelope);
 const wrong=await sendReport({hub:hubAt('127.0.0.1',s.port),trust:{mode:'pin',pins:[pin(otherCert)]},token:TOKEN,envelope});
 assert.deepEqual([wrong.status,wrong.error],[0,'tls-pin']);
 assert.equal(s.seen.length,1,'nothing reached the server: no header, no body');
});

test('CA mode: the CA file replaces the store, the name is checked; an unknown CA or a wrong name writes nothing',async t=>{
 const s=await serve(t,ok);
 assert.equal((await sendReport({hub:hubAt('localhost',s.port),trust:{mode:'ca',ca:cert},token:TOKEN,envelope})).status,200);
 assert.equal((await sendReport({hub:hubAt('127.0.0.1',s.port),trust:{mode:'ca',ca:cert},token:TOKEN,envelope})).status,200,'the certificate names 127.0.0.1 too');
 const unknown=await sendReport({hub:hubAt('localhost',s.port),trust:{mode:'ca',ca:otherCert},token:TOKEN,envelope});
 assert.deepEqual([unknown.status,unknown.error],[0,'tls-untrusted']);
 const system=await sendReport({hub:hubAt('localhost',s.port),trust:{mode:'system'},token:TOKEN,envelope});
 assert.deepEqual([system.status,system.error],[0,'tls-untrusted'],'a self-signed certificate is not in the system store');
 const other=await serve(t,ok,{pair:[otherCert,otherKey]});
 const name=await sendReport({hub:hubAt('localhost',other.port),trust:{mode:'ca',ca:otherCert},token:TOKEN,envelope});
 assert.deepEqual([name.status,name.error],[0,'tls-hostname'],'the CA is right, the name is not');
 assert.equal(s.seen.length,2);assert.equal(other.seen.length,0);
});

test('plain HTTP: the key goes only to the literal 127.0.0.1, and only when the caller asks',async t=>{
 const s=await serve(t,ok,{secure:false});
 const r=await sendReport({hub:hubAt('127.0.0.1',s.port,false),trust:null,token:TOKEN,envelope});
 assert.equal(r.status,200);assert.equal(s.seen[0].auth,`Bearer ${TOKEN}`);
 await assert.rejects(endpointRequest({host:'localhost',port:s.port,path:'/api/agent/report',method:'POST',headers:{Authorization:'Bearer x'},loopbackAuth:true}),/invalid/);
 await assert.rejects(endpointRequest({host:'127.0.0.1',port:s.port,path:'/x',headers:{Authorization:'Bearer x'}}),/invalid/,'never without loopbackAuth');
 const lan=await sendReport({hub:hubAt('10.0.0.5',s.port,false),trust:null,token:TOKEN,envelope});
 assert.deepEqual([lan.status,lan.error],[0,'invalid'],'a LAN address over HTTP is refused before a socket opens');
 assert.equal(s.seen.length,1);
});

test('the answer: status codes, Retry-After, a redirect, a 10 MB or slow answer; nothing but the acknowledgement is read',async t=>{
 const routes={
  '429':answer(429,{error:{code:'AGENT_TOO_SOON'}},{'Retry-After':'17'}),'401':answer(401,{error:{code:'AUTH_REQUIRED'}}),'503':answer(503,'down'),
  'redirect':(q,r)=>{r.writeHead(307,{Location:'https://hub.example.lan/elsewhere'});r.end();},
  'huge':(q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end('x'.repeat(10*1024*1024));},
  'slow':()=>{},
 };
 let mode='429';
 const s=await serve(t,(q,r)=>routes[mode](q,r));
 const send=(o={})=>sendReport({hub:hubAt('127.0.0.1',s.port),trust:{mode:'pin',pins:[pin(cert)]},token:TOKEN,envelope,...o});
 assert.deepEqual(await send(),{status:429,retryAfter:17,ack:null});
 mode='401';assert.equal((await send()).status,401);
 mode='503';assert.equal((await send()).status,503);
 mode='redirect';assert.deepEqual([(await send()).status,(await send()).error],[0,'redirect']);
 assert.equal(s.seen.filter(x=>x.url==='/elsewhere').length,0,'never followed');
 mode='huge';assert.equal((await send()).error,'too-large');
 mode='slow';assert.equal((await send({timeoutMs:200})).error,'timeout');
 assert.equal(TRANSPORT_LIMITS.replyBytes,65536);
 assert.equal(retryAfterOf({'retry-after':'99999'}),3600);assert.equal(retryAfterOf({'retry-after':'Wed, 21 Oct 2026 07:28:00 GMT'}),null);assert.equal(retryAfterOf({}),null);
});

test('the acknowledgement: only parts that were sent, only known codes; anything else in the answer is ignored',()=>{
 const hostile=JSON.stringify({receivedAt:'2026-11-13T10:00:01Z',accepted:['heartbeat','os','__proto__'],refused:[{part:'heartbeat',code:'invalid'},{part:'runtimes',code:'exec',run:'rm -rf /'},{part:'sshkeys',code:'too-soon',tag:'<img>',field:'x'}],
  command:'reboot',exec:['/bin/sh','-c','id'],config:{hub:'https://evil.example.lan'},specs:'x|cmd|/bin/sh|-c id|',interval:1});
 assert.deepEqual(readAck(hostile,['heartbeat','sshkeys']),{receivedAt:'2026-11-13T10:00:01Z',accepted:['heartbeat'],refused:[{part:'sshkeys',code:'too-soon'}]});
 for(const junk of ['','not json','[1,2]','null',Buffer.from('{"accepted":"heartbeat"}')])assert.deepEqual(readAck(junk,['heartbeat']),{receivedAt:null,accepted:[],refused:[]});
});

test('trust {mode:"ca"} keeps its meaning from before the agent: {mode:"ca", ca: undefined} and {mode:"system"} open exactly the same connection',async t=>{
 // What 8c22ea7 passed to tls.connect for {mode:"ca"}: Node's store, the name checked, nothing else.
 const before={host:'hub.example.lan',port:8443,servername:'hub.example.lan',rejectUnauthorized:true,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']};
 const seen=[];
 const tlsConnect=o=>{seen.push(o);const s=new EventEmitter();s.destroy=()=>{};setImmediate(()=>s.emit('error',Object.assign(new Error('refused'),{code:'ECONNREFUSED'})));return s;};
 for(const trust of [{mode:'ca'},{mode:'ca',ca:undefined},{mode:'system'}]){
  assert.deepEqual(trustOf(trust),{system:true},JSON.stringify(trust));
  await assert.rejects(endpointRequest({host:'hub.example.lan',port:8443,path:'/x',trust,tlsConnect,timeoutMs:2000}),/refused/);
 }
 assert.deepEqual(seen,[before,before,before]);
 assert.ok(seen.every(o=>!('ca' in o)),'no CA of its own: the store is not replaced');
 // Against a real server with a certificate the store does not know: the three fail alike, before any request.
 const s=await serve(t,ok);
 const errors=[];
 for(const trust of [{mode:'ca'},{mode:'ca',ca:undefined},{mode:'system'}])
  errors.push(await endpointRequest({host:'127.0.0.1',port:s.port,path:'/x',trust,timeoutMs:3000}).then(()=>'sent',e=>e.message));
 assert.equal(new Set(errors).size,1,errors.join(', '));assert.notEqual(errors[0],'sent');assert.equal(s.seen.length,0);
});
