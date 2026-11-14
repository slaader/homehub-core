import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,open} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTicketStore} from '../server/tickets-store.mjs';
import {openDb} from '../server/db.mjs';
import {createTicketFiles,FILE_LIMITS} from '../server/ticket-files.mjs';
import {uploadTicketFile} from '../scripts/ticket-push.mjs';
import {hub} from './hub-helper.mjs';

async function tmp(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hub-ticket-fast-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const call=async(h,account,name,args)=>(await (await fetch(h.origin+'/mcp',{method:'POST',headers:{...account.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;

test('selected tracker transactions preserve unrelated rows, atomic numbering, revisions and search',async t=>{
 const dir=await tmp(t),db=openDb(path.join(dir,'hub.db'));t.after(()=>db.close());
 const a=createTicketStore(dir,{db}),b=createTicketStore(dir,{db});
 await a.saveProject({id:'example-app',key:'APP',name:'Example app'},'alice');
 await a.saveRelease({project:'example-app',version:'1.0'},'alice');
 const made=await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).create({project:'example-app',title:`Item ${i}`,release:'1.0'},'alice')));
 assert.equal(new Set(made.map(x=>x.id)).size,20);
 const row=db.db.prepare("SELECT doc FROM docs WHERE kind='tickets' AND coll='tickets' AND id=?"),untouched=row.get('APP-20').doc;
 const results=await Promise.allSettled([a.update({id:'APP-1',rev:1,title:'New title'},'alice'),b.update({id:'APP-1',rev:1,title:'Other title'},'bob')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/conflict/);
 const before=(await a.get('APP-1')).title;
 await assert.rejects(a.update({id:'APP-1',rev:2,title:'Must roll back',release:'missing'},'alice'),/invalid/);
 assert.equal((await a.get('APP-1')).title,before);assert.equal(db.search({q:'roll back'}).total,0);
 await b.comment({id:'APP-1',text:'Find this unique comment'},'bob');
 assert.deepEqual(db.search({q:'unique'}).results.map(x=>x.id),['APP-1']);
 const projects=await a.projects();await b.saveProject({id:'example-app',rev:projects[0].rev,name:'Renamed'},'alice');
 assert.equal(row.get('APP-20').doc,untouched,'unrelated ticket bytes are preserved');
 const list=await a.list({status:'done'});assert.equal(list.total,0);assert.equal(list.releases[0].total,20,'release counts ignore ticket filters');
 assert.equal((await a.list()).total,20);
});

test('ticket creation enforces the global limit when only the new row is loaded',async t=>{
 const dir=await tmp(t),db=openDb(path.join(dir,'hub.db'));t.after(()=>db.close());const s=createTicketStore(dir,{db});
 await s.saveProject({id:'example-app',key:'APP',name:'Example app'},'alice');
 const one=await s.create({project:'example-app',title:'Item'},'alice');
 const insert=db.db.prepare("INSERT INTO docs(kind,coll,id,doc) VALUES('tickets','tickets',?,?)");
 db.db.exec('BEGIN');for(let i=2;i<=5000;i++)insert.run('APP-'+i,JSON.stringify({...one,id:'APP-'+i}));db.db.exec('COMMIT');
 const meta=db.db.prepare("SELECT doc FROM meta WHERE kind='tickets'").get().doc;
 await assert.rejects(s.create({project:'example-app',title:'Over the limit'},'alice'),/limit/);
 assert.equal(db.db.prepare("SELECT doc FROM meta WHERE kind='tickets'").get().doc,meta,'a refused create writes nothing');
});

test('MCP project discovery and small attachments: scopes, canonical bytes, collisions, retries and audit',async t=>{
 const h=await hub(t),writer=await h.account('ticket-agent',['tickets:write']),reader=await h.account('reader',[]);
 const projects=await call(h,reader,'projects_list',{});assert.equal(projects.isError,false);assert.ok(projects.structuredContent.projects.some(p=>p.id==='home-hub'&&p.rev===1));assert.equal(projects.structuredContent.tickets,undefined);
 const made=(await call(h,writer,'ticket_create',{project:'home-hub',title:'Files'})).structuredContent;
 const put=(account,data,name='notes.txt')=>call(h,account,'ticket_attachment_put',{id:made.id,name,data});
 const bytes=Buffer.from('Résumé and notes'),data=bytes.toString('base64');
 assert.equal((await put(reader,data)).isError,true);
 for(const bad of ['a','!!!!','Zg','Zh==',Buffer.alloc(32769).toString('base64')])assert.equal((await put(writer,bad)).isError,true,bad.slice(0,20));
 const first=await put(writer,data);assert.equal(first.isError,false,first.content[0].text);assert.equal(first.structuredContent.attachments.length,1);
 const collision=await put(writer,Buffer.from('Different bytes').toString('base64'));assert.equal(collision.structuredContent.attachments[1].name,'notes-2.txt');
 const again=await put(writer,Buffer.from('Different bytes').toString('base64'));assert.equal(again.structuredContent.attachments.length,2,'a renamed attachment is retry-safe');
 const parallel=await Promise.all([put(writer,Buffer.from('Concurrent').toString('base64'),'a.txt'),put(writer,Buffer.from('Concurrent').toString('base64'),'b.txt')]);
 assert.ok(parallel.every(x=>!x.isError));
 const current=(await call(h,reader,'ticket_get',{id:made.id})).structuredContent;assert.equal(current.attachments.length,3);
 const file=await call(h,reader,'ticket_attachment_get',{id:made.id,attachment:current.attachments[0].id});assert.equal(file.content[1].text,bytes.toString());
 const boundary=await put(writer,Buffer.alloc(32768,65).toString('base64'),'boundary.txt');assert.equal(boundary.isError,false);
 for(let i=4;i<20;i++)assert.equal((await put(writer,Buffer.from('File '+i).toString('base64'),`file-${i}.txt`)).isError,false);
 assert.equal((await put(writer,data)).isError,false,'retry succeeds when the ticket is full');
 assert.equal((await put(writer,Buffer.from('over limit').toString('base64'))).isError,true);
 assert.equal((await readdir(path.join(h.dir,'tickets','attachments'))).length,20,'refused content is not stored');
 const audit=await readFile(path.join(h.dir,'api-audit.jsonl'),'utf8');assert.ok(!audit.includes(data));assert.ok(!audit.includes('Different bytes'));
 const logs=audit.trim().split('\n').map(x=>JSON.parse(x)).filter(x=>x.tool==='ticket_attachment_put'&&x.status==='ok');assert.ok(logs.length>=4);assert.ok(logs.every(x=>x.subject===made.id));
});

test('streaming attachment helper reconciles lost responses and skips identical content',async t=>{
 const h=await hub(t),writer=await h.account('ticket-agent',['tickets:write']);
 const ticket=(await call(h,writer,'ticket_create',{project:'home-hub',title:'Local files'})).structuredContent;
 const file=path.join(h.dir,'large.txt');await writeFile(file,'streamed notes\n'.repeat(5000));
 const result=await uploadTicketFile(h.origin,writer.token,ticket.id,file);assert.equal(result.uploaded,true);assert.ok(result.attachment.size>32768);
 assert.equal((await uploadTicketFile(h.origin,writer.token,ticket.id,file)).uploaded,false);
 await writeFile(file,'changed notes\n'.repeat(5000));let puts=0;
 const fetcher=async(url,options)=>{const r=await fetch(url,options);if(options.method==='PUT'){puts++;await r.arrayBuffer();throw new Error('lost response');}return r;};
 const recovered=await uploadTicketFile(h.origin,writer.token,ticket.id,file,{fetcher});assert.equal(recovered.reconciled,true);assert.equal(puts,1);
 assert.equal((await call(h,writer,'ticket_get',{id:ticket.id})).structuredContent.attachments.length,2);
 await assert.rejects(uploadTicketFile('http://example.lan',writer.token,ticket.id,file),/HTTPS/);
 await assert.rejects(uploadTicketFile('https://user:password@example.lan',writer.token,ticket.id,file),/HTTPS/);
});

test('attachment reservations enforce the shared quota during simultaneous streams and recover after failure',async t=>{
 const dir=await tmp(t),blobs=path.join(dir,'attachments');await mkdir(blobs);
 const sparse=await open(path.join(blobs,'a'.repeat(64)),'w');await sparse.truncate(FILE_LIMITS.total-12);await sparse.close();
 const files=createTicketFiles(dir);
 const outcomes=await Promise.allSettled([files.put([Buffer.alloc(8,1)],{name:'a.bin'}),files.put([Buffer.alloc(8,2)],{name:'b.bin'})]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.match(outcomes.find(x=>x.status==='rejected').reason.message,/limit/);
 assert.equal((await readdir(blobs)).filter(n=>n.startsWith('.upload-')).length,0);
 await files.remove('a'.repeat(64));
 async function* broken(){yield Buffer.alloc(10);throw new Error('disconnected');}
 await assert.rejects(files.put(broken(),{name:'bad.bin'}),/disconnected/);
 const content=Buffer.alloc(100,3),stored=await files.put([content],{name:'ok.bin'});assert.deepEqual(await readFile((await files.read(stored.sha256)).path),content);
});
