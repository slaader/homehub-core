#!/usr/bin/env node
// Stream local attachments without putting base64 in an agent's context.
// HOME_HUB_URL=https://example.lan HOME_HUB_TOKEN=<tickets:write key>
// node scripts/ticket-push.mjs APP-12 screenshot.png notes.txt
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {TICKET_ID} from '../server/tickets-store.mjs';
import {FILE_LIMITS,cleanName} from '../server/ticket-files.mjs';

function baseUrl(value){
 const url=new URL(value);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname)))throw new Error('HOME_HUB_URL must be an HTTPS origin (HTTP is allowed only on loopback).');
 return url.origin;
}
export async function uploadTicketFile(url,token,id,file,{fetcher=fetch}={}){
 const base=baseUrl(url);if(!TICKET_ID.test(id))throw new Error('Invalid ticket id.');
 if(typeof token!=='string'||!/^hhk_[a-f0-9]{64}$/.test(token))throw new Error('HOME_HUB_TOKEN must be a service-account key with tickets:write.');
 const size=(await stat(file)).size;if(!size||size>FILE_LIMITS.file)throw new Error('Attachments must be 1 byte to 100 MiB.');
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 const sha256=hash.digest('hex'),headers={Authorization:'Bearer '+token},ticketUrl=`${base}/api/tickets/${id}`;
 const read=async()=>{
  const r=await fetcher(ticketUrl,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error(`Read ticket: HTTP ${r.status}.`);return r.json();
 };
 const existing=ticket=>ticket.attachments?.find(a=>a.sha256===sha256);
 const before=await read(),same=existing(before);
 if(same)return {ticket:id,attachment:same,uploaded:false};
 if(before.attachments?.length>=20)throw new Error('The ticket already has 20 attachments.');
 const name=cleanName(path.basename(file)),body=createReadStream(file);let saved;
 try{
  const r=await fetcher(`${ticketUrl}/attachments?name=${encodeURIComponent(name)}`,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(size)},
   body,duplex:'half',redirect:'error',signal:AbortSignal.timeout(20*60*1000)});
  if(!r.ok)throw new Error(`Upload: HTTP ${r.status}.`);saved=await r.json();
 }catch{
  // A lost response can follow a committed upload. Read once; never replay a write blindly.
  try{const attachment=existing(await read());if(attachment)return {ticket:id,attachment,uploaded:true,reconciled:true};}catch{}
  throw new Error('Upload outcome could not be confirmed. Read the ticket before retrying; no automatic retry was made.');
 }finally{body.destroy();}
 const attachment=existing(saved);
 if(!attachment)throw new Error('Uploaded bytes differ from the local hash; the file may have changed. Inspect the ticket before retrying.');
 return {ticket:id,attachment,uploaded:true};
}

async function main(args){
 if(args.length<2||args.includes('--help')){
  console.log('Usage: HOME_HUB_URL=https://example.lan HOME_HUB_TOKEN=<key> node scripts/ticket-push.mjs APP-12 file [file ...]');
  if(!args.includes('--help'))process.exitCode=2;return;
 }
 const [id,...files]=args;
 for(const file of files)console.log(JSON.stringify(await uploadTicketFile(process.env.HOME_HUB_URL,process.env.HOME_HUB_TOKEN,id,file)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(e=>{console.error('ticket-push: '+e.message);process.exitCode=1;});
