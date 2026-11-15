#!/usr/bin/env node
// Converts legacy site fields in place, keeping the original beside the file.
// Offline utility; use the update driver for a running installation.
import {readFileSync,writeFileSync,renameSync,copyFileSync,statSync,realpathSync,rmSync,existsSync,constants} from 'node:fs';
import path from 'node:path';
import {V1} from '../server/state-forward.mjs';
import {fileURLToPath} from 'node:url';
import {validateSite,siteConfigPath} from '../server/site-config.mjs';

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const refuse=message=>{const e=new Error(message);e.refused=true;throw e;};

/** The current form of a parsed legacy site file. → {site, renamed: [converted fields], notes}. Throws (refused) otherwise. */
export function convertSite(raw){
 if(!plain(raw))refuse('the file is not a JSON object, so not a site file');
 if(!Object.hasOwn(raw,V1.devices)){
  if(Object.hasOwn(raw,'devices'))refuse('the file already uses devices');
  if(Array.isArray(raw.runtimes)&&raw.runtimes.some(r=>plain(r)&&Object.hasOwn(r,'device')))refuse('the file is already in the current form: runtimes name a "device"');
 }
 if(Object.hasOwn(raw,'devices'))refuse('conflicting device fields: not a legacy file');
 const renamed=[],site={};
 // The keys keep their place in the file.
 for(const [k,v] of Object.entries(raw)){
  if(k===V1.devices){site.devices=v;renamed.push(`device list converted (${Array.isArray(v)?v.length:0})`);}
  else if(k==='runtimes'&&Array.isArray(v)){
   let n=0;
   site.runtimes=v.map(r=>{
    if(!plain(r))return r;
    if(Object.hasOwn(r,'device'))refuse('a runtime names "device": the legacy input must not also contain that field');
    if(!Object.hasOwn(r,V1.device))return r;
    n++;return Object.fromEntries(Object.entries(r).map(([rk,rv])=>[rk===V1.device?'device':rk,rv]));
   });
   if(n)renamed.push(`runtime device fields converted (${n})`);
  }else site[k]=v;
 }
 // Validate the converted fields with the current configuration rules.
 try{validateSite(site);}catch(e){refuse(`not a valid legacy site file: ${e.message.replace(/^site config: /,'')}`);}
 const notes=[];
 // The Czech source texts use "zařízení"; legacy overrides use "stroj": an override of one no longer applies.
 const old=Object.values(plain(raw.strings)?raw.strings:{}).flatMap(d=>plain(d)?Object.keys(d):[]).filter(k=>/stroj/i.test(k));
 if(old.length)notes.push(`strings: ${old.length} text(s) override a Czech source text with "stroj", which uses "zařízení"; they no longer apply until their keys follow`);
 return {site,renamed,notes};
}

/** Where the legacy copy goes: site.json → site.v1.json. */
export const v1Path=file=>{const ext=path.extname(file);return path.join(path.dirname(file),`${path.basename(file,ext)}.v1${ext||'.json'}`);};

/** Converts the file in place. → {file, kept, renamed, notes}. Throws (refused) with nothing written. */
export function convertSiteFile(given){
 if(!given)refuse('there is no site file to convert (HOME_HUB_SITE_CONFIG is "none"); name one');
 let file;try{file=realpathSync(given);}catch(e){refuse(e.code==='ENOENT'?`${given} does not exist`:`cannot read ${given}: ${e.message}`);}
 let raw;try{raw=JSON.parse(readFileSync(file,'utf8'));}catch(e){refuse(`${file} is not valid JSON: ${e.message}`);}
 const {site,renamed,notes}=convertSite(raw);
 const kept=v1Path(file);
 if(existsSync(kept))refuse(`${kept} already exists; move it away first (it may be the legacy copy of an earlier run)`);
 const mode=statSync(file).mode&0o777,tmp=path.join(path.dirname(file),`.${path.basename(file)}.${process.pid}.tmp`);
 try{
  writeFileSync(tmp,`${JSON.stringify(site,null,2)}\n`,{mode,flag:'wx'});
  copyFileSync(file,kept,constants.COPYFILE_EXCL);
  renameSync(tmp,file);
 }catch(e){rmSync(tmp,{force:true});throw e;}
 return {file,kept,renamed,notes};
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.some(a=>a==='-h'||a==='--help')){console.log('usage: node scripts/convert-site.mjs [<site.json>]   converts a legacy site file to the current format, keeping the legacy file as <name>.v1.json');process.exit(0);}
 const bad=args.find(a=>a.startsWith('-'));
 if(bad||args.length>1){console.error(`convert-site: ${bad?`unknown option ${bad}`:'name one file'}\nusage: node scripts/convert-site.mjs [<site.json>]`);process.exit(2);}
 try{
  const r=convertSiteFile(args[0]??siteConfigPath());
  console.log(`${r.file}: converted to the current format`);
  for(const line of r.renamed.length?r.renamed:['no legacy fields; content unchanged'])console.log(`  ${line}`);
  console.log(`  the legacy file is kept as ${r.kept}`);
  for(const n of r.notes)console.log(`  note: ${n}`);
 }catch(e){console.error(`convert-site: ${e.message}`);process.exit(e.refused?1:3);}
}
