// Isolated benchmark server process. Temporary credentials cross only the private fork IPC channel.
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../..',import.meta.url));
for(const key of Object.keys(process.env))if(/^HOME_HUB_(HOME|CONFIG_DIR|PRIVATE_DIR|PLUGINS_DIR|TICKET_.*)$/.test(key))delete process.env[key];
Object.assign(process.env,{HOME_HUB_SITE_CONFIG:path.join(root,'tests/fixtures/site.json'),HOME_HUB_SECRET_KEY:randomBytes(32).toString('hex'),HOME_HUB_PLUGINS_DIR:path.join(root,'not-installed')});
const {hub}=await import('../../tests/hub-helper.mjs'),{rustFrontend}=await import('../../tests/support/rust-mcp-harness.mjs');
let h,rust,closing=false;const cleanup=[];
async function close(){if(closing)return;closing=true;await rust?.close();await h?.handler.stop();for(const fn of cleanup.reverse())await fn();process.disconnect();}
process.on('message',async input=>{
 try{
  if(input.operation==='start'){
   h=await hub({after:fn=>cleanup.push(fn)},{ticketSearch:{env:{}}});
   const agent=await h.account('benchmark-agent',['tickets:write']),{tickets,ticketFiles,ticketSearch}=h.handler.state('tracker');
   let first,project;
   if(input.corpus){
    const manifest=JSON.parse(await readFile(path.join(input.corpus,'manifest.json'),'utf8')),all=JSON.parse(await readFile(path.join(input.corpus,'corpus-tickets.json'),'utf8'));
    const {specimen}=await import(pathToFileURL(path.join(input.corpus,'corpus.mjs')));
    await tickets.list();const projects=manifest.projects.map(p=>({...p,createdAt:manifest.createdAt,updatedAt:manifest.createdAt,createdBy:'alice',rev:1,next:401}));
    const releases=projects.flatMap(p=>['0.1.0','0.2.0'].map(version=>({project:p.id,version,status:'planned',targetDate:null,releasedAt:null,notes:'Synthetic benchmark',createdAt:manifest.createdAt,updatedAt:manifest.createdAt,createdBy:'alice',rev:1})));
    await h.handler.hub.db.collection('tickets').write({schema:1,revision:1,updatedAt:manifest.createdAt,projects,releases,tickets:all});
    const blobs=path.join(h.dir,'tickets','attachments');await mkdir(blobs,{recursive:true});
    for(const record of manifest.records)for(const file of specimen(record.index,manifest.run).files){const a=record.attachments.find(a=>a.name===file.name);if(createHash('sha256').update(file.text).digest('hex')!==a.sha256)throw new Error('Fixture hash mismatch');await writeFile(path.join(blobs,a.sha256),file.text);}
    first=manifest.records[0];project=projects[0].id;
   }else{
    await tickets.saveProject({id:'benchmark',key:'BM',name:'Benchmark'},'alice');project='benchmark';
    for(let i=0;i<800;i++){
     const ticket=await tickets.create({project,title:`Synthetic issue ${i} EAUTH_${i}`,description:`Component ${i%20}: network diagnostics and regression notes`},'alice');
     await tickets.comment({id:ticket.id,text:'Synthetic progress evidence'},'alice');
     for(let n=0;n<2;n++){const file=await ticketFiles.put([Buffer.from(`Synthetic attachment ${i}/${n}\nUnique content marker CONTENT_${i}_${n}\n`+'diagnostics '.repeat(90))],{name:`evidence-${i}-${n}.txt`});await tickets.attach(ticket.id,file,'alice');}
     first??={id:ticket.id,contentToken:'CONTENT_0_0'};
    }
   }
   await ticketSearch.whenIdle();
   if(input.variant==='rust')rust=await rustFrontend(h);
   process.send({ready:true,origin:rust?.origin??h.origin,authorization:agent.headers.Authorization,first,project,corpus:{tickets:800,attachments:1600,chunks:ticketSearch.status().chunks},pid:process.pid,rustPid:rust?.pid??null});
  }else if(input.operation==='resources'){
   let extra=null;if(rust){const [time,rss]=execFileSync('ps',['-p',String(rust.pid),'-o','time=,rss='],{encoding:'utf8'}).trim().split(/\s+/);const parts=time.split(':').map(Number);let seconds=0;for(const p of parts)seconds=seconds*60+p;extra={cpuMs:seconds*1000,rssBytes:Number(rss)*1024};}
   process.send({id:input.id,usage:process.resourceUsage(),memory:process.memoryUsage(),rust:extra});
  }else if(input.operation==='close')await close();
 }catch(e){process.send({error:e.message});await close();}
});
process.on('disconnect',()=>{if(!closing)close().catch(()=>{});});
