#!/usr/bin/env node
// Synthetic local tracker benchmark. No server, credentials or household data.
// node scripts/benchmark-tickets.mjs [ticket count: 1..5000] [samples: 5..200]
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createTicketStore} from '../server/tickets-store.mjs';
import {openDb} from '../server/db.mjs';

const count=Number(process.argv[2]??1000),samples=Number(process.argv[3]??30);
if(!Number.isInteger(count)||count<1||count>5000||!Number.isInteger(samples)||samples<5||samples>200){
 console.error('Usage: benchmark-tickets.mjs [ticket count: 1..5000] [samples: 5..200]');process.exit(2);
}
const dir=await mkdtemp(path.join(os.tmpdir(),'hub-ticket-benchmark-')),db=openDb(path.join(dir,'hub.db'));
try{
 const at='2026-01-01T00:00:00.000Z',project={id:'example-app',key:'APP',name:'Example app',description:'',rev:1,next:count+1,createdAt:at};
 const releases=Array.from({length:100},(_,i)=>({project:project.id,version:`1.${i}`,status:'planned',rev:1,targetDate:null,releasedAt:null,notes:'',createdAt:at,updatedAt:at}));
 const tickets=Array.from({length:count},(_,i)=>({id:`APP-${i+1}`,project:project.id,title:`Example ticket ${i+1}`,description:'Reproduce the issue and verify acceptance criteria. '.repeat(40),
  type:'task',status:'open',priority:'normal',release:`1.${i%100}`,assignee:null,labels:[],refs:[],reporter:'alice',createdAt:at,updatedAt:at,closedAt:null,rev:1,
  comments:Array.from({length:5},(_,j)=>({id:`comment-${j}`,by:'alice',at,text:'Investigation and verification notes. '.repeat(10)})),attachments:[],history:[{at,by:'alice',field:'created',from:null,to:'open'}]}));
 await writeFile(path.join(dir,'tickets.json'),JSON.stringify({schema:1,revision:1,updatedAt:at,projects:[project],releases,tickets}));
 const store=createTicketStore(dir,{db});await store.list();
 const results={};
 async function measure(name,run){
  for(let i=0;i<3;i++)await run(i);
  const times=[];for(let i=0;i<samples;i++){const start=performance.now();await run(i+3);times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);results[name]={medianMs:+times[Math.floor(times.length/2)].toFixed(3),p95Ms:+times[Math.ceil(times.length*.95)-1].toFixed(3)};
 }
 await measure('ticket_get',()=>store.get('APP-1'));
 await measure('tickets_list',()=>store.list({limit:20}));
 await measure('ticket_search',()=>store.search({q:'acceptance',limit:20}));
 if(store.projects)await measure('projects_list',()=>store.projects());
 await measure('project_save',i=>store.saveProject({id:project.id,rev:i+1,name:`Example app ${i}`},'alice'));
 console.log(JSON.stringify({node:process.version,tickets:count,releases:releases.length,commentsPerTicket:5,samples,results},null,2));
}finally{db.close();await rm(dir,{recursive:true,force:true});}
