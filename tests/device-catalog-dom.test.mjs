import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire} from './fixtures/mini-dom.mjs';
const {document}=installDom();
const {setPrincipal}=await import('../public/session-cache.js');
const {leaveView}=await import('../public/views.js');
const {deviceCatalogPage}=await import('../public/device-catalog.js');
const nodes=n=>[n,...n.children.flatMap(nodes)];
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
const data={devices:[{id:'server',name:'Server'},{id:'laptop',name:'Laptop'}],services:[{id:'svc',name:'<img src=x>',device:'server',kind:'omlx',status:'running',address:'http://10.0.0.2:8000',software:'sw'}],
 software:[{id:'sw',name:'oMLX',device:'server',version:null,status:'configured'}],models:[{name:'Example model',kind:'llm',device:'server',service:'svc',status:'loaded'}],clients:[{id:'cli',name:'Editor',device:'laptop'}],uses:[{client:'cli',service:'svc',targetDevice:'server',requests:3,source:'request-history'}],warnings:[]};

test('device catalog renders related services/models/clients as text and filters both ends of client links',async()=>{
 leaveView();setPrincipal({authKind:'session',role:'admin',username:'catalog-admin'});
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>data});document.body.replaceChildren(deviceCatalogPage());await tick();
 assert.match(document.body.textContent,/Example model/);assert.match(document.body.textContent,/oMLX/);assert.match(document.body.textContent,/Editor/);
 assert.match(document.body.textContent,/<img src=x>/);assert.equal(nodes(document.body).filter(n=>n.tagName==='img').length,0);
 const select=nodes(document.body).find(n=>n.tagName==='select');select.value='laptop';fire(select,'change');
 assert(!document.body.textContent.includes('Example model'));assert.match(document.body.textContent,/Editor/);assert.match(document.body.textContent,/<img src=x>/,'service remains in outgoing relationship');
 leaveView();
});

test('catalog discards a response after the account changes',async()=>{
 leaveView();setPrincipal({authKind:'session',role:'admin',username:'catalog-old'});let finish;
 globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});document.body.replaceChildren(deviceCatalogPage());
 setPrincipal({authKind:'session',role:'viewer',username:'catalog-new'});finish({ok:true,status:200,json:async()=>data});await tick();
 assert(!document.body.textContent.includes('Example model'));leaveView();
});
