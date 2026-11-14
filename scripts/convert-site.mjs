#!/usr/bin/env node
// Converts a site file of Home Hub 1.x to 2.0, in place, and keeps the 1.x file beside it.
//
//   node scripts/convert-site.mjs [<site.json>]      default: the site file the hub reads (server/paths.mjs)
//
// 2.0 renamed `machines` to `devices` and `runtimes[].machine` to `runtimes[].device`; nothing else in the file
// changes. The 1.x file is kept as site.v1.json (<name>.v1<ext>) in the same directory: 1.x refuses the 2.0 file,
// so going back to 1.x means putting that copy back (docs/updating.md). The new file is written whole (a temporary
// file, then a rename). Refused, and nothing written: a file that is already 2.0, one that is not a valid 1.x file,
// and a directory that already holds the 1.x copy.
// Run it from a checkout of 2.0 (it validates the result with 2.0's rules), before `scripts/update.mjs apply`.
import {readFileSync,writeFileSync,renameSync,copyFileSync,statSync,realpathSync,rmSync,existsSync,constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSite,siteConfigPath} from '../server/site-config.mjs';

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const refuse=message=>{const e=new Error(message);e.refused=true;throw e;};

/** The 2.0 form of a parsed 1.x site file. → {site, renamed: [what was renamed], notes}. Throws (refused) otherwise. */
export function convertSite(raw){
 if(!plain(raw))refuse('the file is not a JSON object, so not a site file');
 if(!Object.hasOwn(raw,'machines')){
  if(Object.hasOwn(raw,'devices'))refuse('the file is already in the 2.0 form: it has "devices" and no "machines"');
  if(Array.isArray(raw.runtimes)&&raw.runtimes.some(r=>plain(r)&&Object.hasOwn(r,'device')))refuse('the file is already in the 2.0 form: runtimes name a "device"');
 }
 if(Object.hasOwn(raw,'devices'))refuse('the file has both "machines" and "devices": 1.x does not know "devices", so this is not a 1.x file');
 const renamed=[],site={};
 // The keys keep their place in the file.
 for(const [k,v] of Object.entries(raw)){
  if(k==='machines'){site.devices=v;renamed.push(`machines → devices (${Array.isArray(v)?v.length:0})`);}
  else if(k==='runtimes'&&Array.isArray(v)){
   let n=0;
   site.runtimes=v.map(r=>{
    if(!plain(r))return r;
    if(Object.hasOwn(r,'device'))refuse('a runtime names "device": 1.x does not know that field, so this is not a 1.x file');
    if(!Object.hasOwn(r,'machine'))return r;
    n++;return Object.fromEntries(Object.entries(r).map(([rk,rv])=>[rk==='machine'?'device':rk,rv]));
   });
   if(n)renamed.push(`runtimes[].machine → runtimes[].device (${n})`);
  }else site[k]=v;
 }
 // Valid 1.x is exactly what is valid 2.0 after the renames above.
 try{validateSite(site);}catch(e){refuse(`not a valid 1.x site file: ${e.message.replace(/^site config: /,'')}`);}
 const notes=[];
 // The Czech source texts said "stroj" in 1.x and say "zařízení" in 2.0: an override of one no longer applies.
 const old=Object.values(plain(raw.strings)?raw.strings:{}).flatMap(d=>plain(d)?Object.keys(d):[]).filter(k=>/stroj/i.test(k));
 if(old.length)notes.push(`strings: ${old.length} text(s) override a Czech source text with "stroj", which 2.0 words with "zařízení"; they no longer apply until their keys follow (CHANGELOG.md, 2.0.0)`);
 return {site,renamed,notes};
}

/** Where the 1.x copy goes: site.json → site.v1.json. */
export const v1Path=file=>{const ext=path.extname(file);return path.join(path.dirname(file),`${path.basename(file,ext)}.v1${ext||'.json'}`);};

/** Converts the file in place. → {file, kept, renamed, notes}. Throws (refused) with nothing written. */
export function convertSiteFile(given){
 if(!given)refuse('there is no site file to convert (HOME_HUB_SITE_CONFIG is "none"); name one');
 let file;try{file=realpathSync(given);}catch(e){refuse(e.code==='ENOENT'?`${given} does not exist`:`cannot read ${given}: ${e.message}`);}
 let raw;try{raw=JSON.parse(readFileSync(file,'utf8'));}catch(e){refuse(`${file} is not valid JSON: ${e.message}`);}
 const {site,renamed,notes}=convertSite(raw);
 const kept=v1Path(file);
 if(existsSync(kept))refuse(`${kept} already exists; move it away first (it may be the 1.x copy of an earlier run)`);
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
 if(args.some(a=>a==='-h'||a==='--help')){console.log('usage: node scripts/convert-site.mjs [<site.json>]   converts a 1.x site file to 2.0, keeping the 1.x file as <name>.v1.json');process.exit(0);}
 const bad=args.find(a=>a.startsWith('-'));
 if(bad||args.length>1){console.error(`convert-site: ${bad?`unknown option ${bad}`:'name one file'}\nusage: node scripts/convert-site.mjs [<site.json>]`);process.exit(2);}
 try{
  const r=convertSiteFile(args[0]??siteConfigPath());
  console.log(`${r.file}: converted to 2.0`);
  for(const line of r.renamed.length?r.renamed:['nothing named a machine; the file is unchanged in content'])console.log(`  ${line}`);
  console.log(`  the 1.x file is kept as ${r.kept}`);
  for(const n of r.notes)console.log(`  note: ${n}`);
 }catch(e){console.error(`convert-site: ${e.message}`);process.exit(e.refused?1:3);}
}
