import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs,registrationFrom,hubOrigin,registerRemote} from '../scripts/setup-service.mjs';
const fields={id:'server-example',device:'server',name:'Example',kind:'generic',binary:'/opt/bin/example',port:'8080',platform:'linux'};

test('service setup parses literal paths and supported OS descriptors without executing binary values',()=>{
 assert.equal(registrationFrom(fields).port,8080);
 assert.equal(registrationFrom({...fields,platform:'windows',binary:'C:\\Program Files\\Example\\service.exe'}).platform,'windows');
 assert.equal(registrationFrom({...fields,kind:'mflux',mode:'on-demand',port:'none'}).port,null);
 assert.equal(parseArgs(['--binary','/opt/a folder/service','--dry-run']).binary,'/opt/a folder/service');
 for(const args of [['--token','secret'],['--port'],['--port','1','--port','2'],['--apply','--dry-run'],['--token-file','file','--token-stdin']])assert.throws(()=>parseArgs(args));
 assert.throws(()=>registrationFrom({...fields,port:'1.5'}));assert.throws(()=>registrationFrom({...fields,binary:'../bin/service'}));
});

test('service setup refuses token-bearing non-TLS remote requests and redirects',async()=>{
 for(const origin of ['http://example.lan','https://user:pass@example.lan','https://example.lan/path','file:///tmp/x'])assert.throws(()=>hubOrigin(origin));
 assert.equal(hubOrigin('http://127.0.0.1:8999'),'http://127.0.0.1:8999');
 let seen;
 const result=await registerRemote({hub:'https://hub.example.lan',token:'hhk_'+'a'.repeat(64),registration:registrationFrom(fields),fetcher:async(url,options)=>{seen={url,options};return {ok:true,json:async()=>({entry:{id:fields.id},hash:'b'.repeat(64),published:true})};}});
 assert.equal(seen.url,'https://hub.example.lan/api/service-registrations');assert.equal(seen.options.redirect,'error');assert.equal(seen.options.method,'POST');
 assert.deepEqual(JSON.parse(seen.options.body),registrationFrom(fields));assert.equal(result.id,fields.id);assert(!JSON.stringify(result).includes('hhk_'));
});

test('per-OS shell wrappers produce a dry-run plan and never invoke the recorded service binary',()=>{
 for(const os of ['macos','linux']){
  const wrapper=fileURLToPath(new URL(`../scripts/service-setup/${os}.sh`,import.meta.url));
  const result=spawnSync('/bin/sh',[wrapper,...Object.entries(fields).filter(([k])=>k!=='platform').flatMap(([k,v])=>['--'+k,v]),'--dry-run'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,new RegExp(`"platform": "${os}"`));assert.match(result.stdout,/Dry run/);
 }
});
