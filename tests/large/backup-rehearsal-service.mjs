// A stand-in service with the same local process/HTTP readiness contract as the tagged hub.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';

const [operation,fixture]=process.argv.slice(2);
const settings=JSON.parse(readFileSync(fixture,'utf8'));
const {root,runFile,calls,portFile}=settings;

if(operation==='start'){
 appendFileSync(calls,'start\n');
 const worker=spawn(process.execPath,[import.meta.filename,'serve',fixture],{detached:true,stdio:'ignore'});
 worker.unref();
}else if(operation==='stop'){
 appendFileSync(calls,'stop\n');
 if(existsSync(runFile)){
  const {pid}=JSON.parse(readFileSync(runFile,'utf8'));
  try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
 }
}else if(operation==='serve'){
 const {version,homeHub:{dataEpoch}}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
 const fullCommit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),bootId=randomUUID();
 const run={version,dataEpoch,fullCommit,commit:fullCommit.slice(0,7),packageDigest:null,readinessProtocol:1,bootId,pid:process.pid,
  startedAt:new Date().toISOString(),plugins:[]};
 const port=existsSync(portFile)?Number(readFileSync(portFile,'utf8')):0;
 const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('x-home-hub-run-id',bootId);res.end('{"ok":true}');
 });
 server.listen(port,'127.0.0.1',()=>{
  writeFileSync(runFile,JSON.stringify(run)+'\n',{mode:0o600});
  writeFileSync(portFile,String(server.address().port));
 });
 process.on('SIGTERM',()=>{server.close();server.closeAllConnections();});
}else throw new Error('unknown rehearsal service operation');
