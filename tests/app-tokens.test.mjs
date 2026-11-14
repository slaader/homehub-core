import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {hashPassword} from '../server/auth.mjs';
import {createHandler} from '../server/index.mjs';
import {createAppTokens,bearerOf,maxAppTokens,validAppName,APP_TOKENS_SCHEMA} from '../server/app-tokens.mjs';
import {readAccessAudit} from '../server/access-store.mjs';
const credentials={username:'admin',...hashPassword('test-only-password')};
const fixture={observed_at:'2026-10-29T19:00:00Z',devices:[{ip:'10.0.0.86',mac:'1c:90:ff:32:b6:07',identity_status:'Confirmed'}]};
async function serve(fn,{before}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-tokens-'));await writeFile(path.join(dir,'inventory.json'),JSON.stringify(fixture));
 if(before)await before(dir);
 const origin='http://127.0.0.1:8892',start=()=>{const server=http.createServer(createHandler({directory:dir,credentials,origin,secure:false}));return new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server)));};
 const servers=[];const open=async()=>{const s=await start();servers.push(s);return `http://127.0.0.1:${s.address().port}`;};
 try{await fn({dir,origin,open});}finally{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true});}
}
const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('bearer header parsing accepts only well-formed app tokens',()=>{
 assert.equal(bearerOf('Bearer hh_'+'a'.repeat(64)),'hh_'+'a'.repeat(64));
 for(const h of [undefined,'','Bearer','Basic abc','Bearer hh_'+'a'.repeat(63),'Bearer hh_'+'A'.repeat(64),'bearer hh_'+'a'.repeat(64)])assert.equal(bearerOf(h),null);
});
test('a password sign-in issues an app token that then works without cookie or Origin, and revoking it locks it out',()=>serve(async({dir,origin,open})=>{
 const base=await open();
 const login=await post(`${base}/api/session`,{username:'admin',password:'test-only-password'},{Origin:origin});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');
 assert.equal((await post(`${base}/api/app-tokens`,{name:'Test phone'},{Cookie:cookie})).status,403,'cookie POST still needs Origin');
 assert.equal((await post(`${base}/api/app-tokens`,{name:''},{Cookie:cookie,Origin:origin})).status,400);
 assert.equal((await post(`${base}/api/app-tokens`,{name:'x',extra:1},{Cookie:cookie,Origin:origin})).status,400);
 const issued=await post(`${base}/api/app-tokens`,{name:'Test phone'},{Cookie:cookie,Origin:origin});assert.equal(issued.status,201);
 const answer=await issued.json(),{token,app}=answer;assert.deepEqual(Object.keys(answer).sort(),['app','token']);
 assert.match(token,/^hh_[a-f0-9]{64}$/);assert.match(app.id,/^[a-f0-9]{16}$/);assert.equal(app.name,'Test phone');
 const stored=await readFile(path.join(dir,'state','app-tokens.json'),'utf8');assert(!stored.includes(token.slice(3)),'only the hash is stored');
 assert.deepEqual(Object.keys(JSON.parse(stored)).sort(),['schemaVersion','tokens']);assert.equal(JSON.parse(stored).schemaVersion,APP_TOKENS_SCHEMA);
 assert(!(await readFile(path.join(dir,'state','app-tokens-audit.jsonl'),'utf8')).includes(token.slice(3)));
 const auth={Authorization:`Bearer ${token}`};
 assert.equal((await fetch(`${base}/api/home`,{headers:auth})).status,200);
 const me=await (await fetch(`${base}/api/me`,{headers:auth})).json();assert.equal(me.authKind,'app');assert.equal(me.username,'Native app');assert.equal(me.canAdmin,false);
 const list=await (await fetch(`${base}/api/app-tokens`,{headers:auth})).json();assert.deepEqual(Object.keys(list),['tokens']);assert.equal(list.tokens.length,1);assert.equal(list.tokens[0].current,true);assert(list.tokens[0].lastUsedAt);assert(!('hash' in list.tokens[0]));
 assert.equal((await post(`${base}/api/app-tokens`,{name:'Another'},auth)).status,401,'a token cannot mint tokens');
 assert.equal((await post(`${base}/api/app-tokens/revoke`,{id:'0000000000000000'},auth)).status,404);
 // Tokens and browser sessions both survive a restart (sessions live in state/hub.db, hashed).
 const restarted=await open();assert.equal((await fetch(`${restarted}/api/home`,{headers:auth})).status,200);assert.equal((await fetch(`${restarted}/api/home`,{headers:{Cookie:cookie}})).status,200);
 const revoked=await post(`${restarted}/api/app-tokens/revoke`,{id:app.id},auth);assert.equal(revoked.status,200);assert.deepEqual(await revoked.json(),{ok:true,tokens:[]});
 const after=await fetch(`${restarted}/api/home`,{headers:auth});assert.equal(after.status,401);assert.equal((await after.json()).error.code,'AUTH_REQUIRED');
 assert.equal((await post(`${restarted}/api/home/settings`,{intervalSeconds:30},auth)).status,401,'revoked token is rejected on POST too, not reported as an Origin problem');
 assert.equal((await fetch(`${base}/api/home`,{headers:{Authorization:'Bearer hh_'+'0'.repeat(64)}})).status,401);
 const audit=await (await fetch(`${restarted}/api/admin/audit?kind=app`,{headers:{Cookie:cookie}})).json();
 assert.deepEqual(audit.events.map(e=>[e.kind,e.event,e.subject]).reverse(),[['app','app-token-issued','Test phone'],['app','app-token-revoked','Test phone']]);
 assert.equal((await fetch(`${restarted}/api/admin/audit?kind=device`,{headers:{Cookie:cookie}})).status,400,'the old audit kind is gone');
}));
test('the routes the tokens had before 2.0 are gone, with no alias',()=>serve(async({origin,open})=>{
 const base=await open();const cookie=(await post(`${base}/api/session`,{username:'admin',password:'test-only-password'},{Origin:origin})).headers.get('set-cookie');
 assert.equal((await fetch(`${base}/api/devices/tokens`,{headers:{Cookie:cookie}})).status,404);
 assert.equal((await post(`${base}/api/devices/tokens`,{name:'x'},{Cookie:cookie,Origin:origin})).status,404);
 assert.equal((await post(`${base}/api/devices/tokens/revoke`,{id:'x'},{Cookie:cookie,Origin:origin})).status,404);
}));
test('the browser can list and revoke app access with its cookie',()=>serve(async({origin,open})=>{
 const base=await open();const cookie=(await post(`${base}/api/session`,{username:'admin',password:'test-only-password'},{Origin:origin})).headers.get('set-cookie');
 const {app}=await (await post(`${base}/api/app-tokens`,{name:'Old phone'},{Cookie:cookie,Origin:origin})).json();
 const list=await (await fetch(`${base}/api/app-tokens`,{headers:{Cookie:cookie}})).json();assert.equal(list.tokens[0].current,false);
 assert.equal((await post(`${base}/api/app-tokens/revoke`,{id:app.id},{Cookie:cookie})).status,403,'cookie revoke needs Origin');
 assert.equal((await post(`${base}/api/app-tokens/revoke`,{id:app.id},{Cookie:cookie,Origin:origin})).status,200);
 assert.equal((await fetch(`${base}/api/app-tokens`)).status,401);
}));
test('the store caps the number of app tokens and rejects bad names',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hub-tokens-'));
 try{const store=createAppTokens(dir);await assert.rejects(store.issue('bad\u0007name'),/invalid/);await assert.rejects(store.issue('x'.repeat(61)),/invalid/);assert.equal(validAppName('Phone'),true);
  for(let i=0;i<maxAppTokens;i++)await store.issue(`Phone ${i}`);await assert.rejects(store.issue('One more'),/limit/);
  assert.equal(createAppTokens(dir).list().length,maxAppTokens);
 }finally{await rm(dir,{recursive:true});}
});
test('the twenty-first app token is refused with APP_TOKEN_LIMIT',()=>serve(async({origin,open})=>{
 const base=await open();const cookie=(await post(`${base}/api/session`,{username:'admin',password:'test-only-password'},{Origin:origin})).headers.get('set-cookie');
 for(let i=0;i<maxAppTokens;i++)assert.equal((await post(`${base}/api/app-tokens`,{name:`Phone ${i}`},{Cookie:cookie,Origin:origin})).status,201);
 const full=await post(`${base}/api/app-tokens`,{name:'One more'},{Cookie:cookie,Origin:origin});assert.equal(full.status,409);assert.equal((await full.json()).error.code,'APP_TOKEN_LIMIT');
}));

// ---- state written by 1.0.0 ---------------------------------------------------------------------
// What 1.0.0 left in state/: the token file under its old name, key and schema, and its audit file.
const OLD_TOKEN='hh_'+'5'.repeat(64),OLD_ID='00112233aabbccdd',GONE_ID='ffeeddccbbaa9988';
const oldRecord={id:OLD_ID,name:'Old phone',createdAt:'2026-10-01T08:00:00.000Z',lastUsedAt:'2026-10-02T09:00:00.000Z',hash:createHash('sha256').update(OLD_TOKEN).digest('hex')};
const oldAudit=[{at:'2026-09-30T08:00:00.000Z',event:'issued',id:GONE_ID,name:'Tablet'},{at:'2026-10-01T08:00:00.000Z',event:'issued',id:OLD_ID,name:'Old phone'},{at:'2026-10-03T08:00:00.000Z',event:'revoked',id:GONE_ID,name:'Tablet'}];
async function stateOf100(state){
 await mkdir(state,{recursive:true});
 await writeFile(path.join(state,'device-tokens.json'),JSON.stringify({schemaVersion:1,devices:[oldRecord]}));
 await writeFile(path.join(state,'device-tokens-audit.jsonl'),oldAudit.map(l=>JSON.stringify(l)).join('\n')+'\n');
}
test('state from 1.0.0: device-tokens.json and its audit file move to the app-token files once, and the token keeps working',()=>serve(async({dir,origin,open})=>{
 const state=path.join(dir,'state'),base=await open(),auth={Authorization:`Bearer ${OLD_TOKEN}`};
 const names=(await readdir(state)).filter(n=>/tokens/.test(n)).sort();
 assert.deepEqual(names,['app-tokens-audit.jsonl','app-tokens.json'],'the old files are gone, nothing temporary is left');
 const moved=JSON.parse(await readFile(path.join(state,'app-tokens.json'),'utf8'));
 assert.deepEqual(moved,{schemaVersion:2,tokens:[oldRecord]},'same id, hash and dates under the new key');
 // The token an app got from 1.0.0 still signs it in, lists itself and writes under the new author name.
 assert.equal((await fetch(`${base}/api/home`,{headers:auth})).status,200);
 const list=await (await fetch(`${base}/api/app-tokens`,{headers:auth})).json();
 assert.deepEqual(list.tokens.map(a=>[a.id,a.name,a.createdAt,a.current]),[[OLD_ID,'Old phone','2026-10-01T08:00:00.000Z',true]]);
 // The old audit lines are read and shown, under the new kind and event names.
 const cookie=(await post(`${base}/api/session`,{username:'admin',password:'test-only-password'},{Origin:origin})).headers.get('set-cookie');
 const audit=async()=>(await (await fetch(`${base}/api/admin/audit?kind=app`,{headers:{Cookie:cookie}})).json()).events.map(e=>[e.kind,e.event,e.id,e.subject]);
 assert.deepEqual(await audit(),[['app','app-token-revoked',GONE_ID,'Tablet'],['app','app-token-issued',OLD_ID,'Old phone'],['app','app-token-issued',GONE_ID,'Tablet']]);
 // New events join the same file; a second start changes nothing and the token still works.
 const {app}=await (await post(`${base}/api/app-tokens`,{name:'New phone'},{Cookie:cookie,Origin:origin})).json();
 assert.equal((await audit()).length,4);assert.deepEqual((await audit())[0].slice(1),['app-token-issued',app.id,'New phone']);
 const again=await open();assert.equal((await fetch(`${again}/api/home`,{headers:auth})).status,200);
 assert.deepEqual((await readdir(state)).filter(n=>/tokens/.test(n)).sort(),['app-tokens-audit.jsonl','app-tokens.json']);
 assert.equal((await (await fetch(`${again}/api/app-tokens`,{headers:auth})).json()).tokens.length,2);
 // Revoking the migrated token is how that app signs out.
 assert.equal((await post(`${again}/api/app-tokens/revoke`,{id:OLD_ID},auth)).status,200);assert.equal((await fetch(`${again}/api/home`,{headers:auth})).status,401);
},{before:dir=>stateOf100(path.join(dir,'state'))}));
test('the migration never writes over newer state, finishes an interrupted move, and newer state is refused',async t=>{
 const scratch=async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'hub-tokens-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
 // Interrupted after the token file moved: the audit file follows at the next start.
 const warned=[],warn=m=>warned.push(m);
 const half=await scratch();await stateOf100(half);createAppTokens(half,{warn});
 await writeFile(path.join(half,'device-tokens-audit.jsonl'),JSON.stringify(oldAudit[0])+'\n');await rm(path.join(half,'app-tokens-audit.jsonl'));
 assert.equal(createAppTokens(half,{warn}).verify(OLD_TOKEN),OLD_ID);
 assert.deepEqual(warned,[],'a move, whole or finished later, warns of nothing');
 assert.deepEqual((await readAccessAudit(half,{kind:'app'})).map(e=>e.event),['app-token-issued']);
 // Both generations present (a 1.0.0 file put back beside 2.0 state): the new file wins and is not touched.
 const both=await scratch();const store=createAppTokens(both,{warn});const {token,app}=await store.issue('Current');const before=await readFile(path.join(both,'app-tokens.json'),'utf8');
 await stateOf100(both);const reopened=createAppTokens(both,{warn});
 // Not merged, and not silent: the start-up log names both files, the token file and the audit file.
 assert.equal(warned.length,2);
 assert.match(warned[0],/both .*device-tokens\.json and .*app-tokens\.json exist/);assert.match(warned[0],/refused/);
 assert.match(warned[1],/both .*device-tokens-audit\.jsonl and .*app-tokens-audit\.jsonl exist/);
 assert.ok((await readdir(both)).includes('device-tokens.json'),'the 1.x file is left as it is');
 assert.equal(reopened.verify(token),app.id);assert.equal(reopened.verify(OLD_TOKEN),null);assert.equal(JSON.parse(await readFile(path.join(both,'app-tokens.json'),'utf8')).tokens.length,1);
 assert.equal(JSON.parse(before).tokens[0].id,app.id);assert.match(await readFile(path.join(both,'app-tokens-audit.jsonl'),'utf8'),/"Current"/,'the newer audit file is kept');
 // Nothing to migrate: no file is created by reading.
 const empty=await scratch();assert.deepEqual(createAppTokens(empty).list(),[]);assert.deepEqual(await readdir(empty),[]);
 // A file from a later Home Hub is refused, not emptied and overwritten.
 const newer=await scratch();const later=JSON.stringify({schemaVersion:APP_TOKENS_SCHEMA+1,grants:[]});await writeFile(path.join(newer,'app-tokens.json'),later);
 assert.throws(()=>createAppTokens(newer),/schema 3/);assert.equal(await readFile(path.join(newer,'app-tokens.json'),'utf8'),later);
 // An old file that is not what 1.0.0 wrote is refused too, and stays where it is.
 const odd=await scratch();await writeFile(path.join(odd,'device-tokens.json'),JSON.stringify({schemaVersion:7,devices:[]}));
 assert.throws(()=>createAppTokens(odd),/not a 1\.0 token file/);assert.deepEqual(await readdir(odd),['device-tokens.json']);
});
