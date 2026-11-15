// scripts/convert-site.mjs: a legacy site file becomes the current file in place, with the legacy file kept beside it, so a
// rollback to legacy can put it back. Refused, with nothing written: a current file, a file that is not valid legacy, a second run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir,stat,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {convertSite,convertSiteFile,v1Path} from '../scripts/convert-site.mjs';
import {validateSite} from '../server/site-config.mjs';

const script=fileURLToPath(new URL('../scripts/convert-site.mjs',import.meta.url));
const V1={siteName:'Example',lanCidrs:['10.0.0.0/24'],
 machines:[{id:'alpha',name:'Alpha',ip:'10.0.0.2',role:'computer'},{id:'nas',name:'NAS',ip:'10.0.0.3',role:'nas'}],
 security:{order:['nas','alpha']},
 runtimes:[{id:'alpha-llm',machine:'alpha',kind:'ollama',url:'http://10.0.0.2:11434'}],
 plugins:{example:{agents:{push:{alpha:{}}}}}};
const run=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',env:{...process.env,HOME_HUB_SITE_CONFIG:'none'}});
async function dir(){return mkdtemp(path.join(os.tmpdir(),'hh-convert-site-'));}

test('convertSite converts legacy device fields, keeps everything else and the key order',()=>{
 const {site,renamed}=convertSite(V1);
 assert.deepEqual(Object.keys(site),['siteName','lanCidrs','devices','security','runtimes','plugins']);
 assert.deepEqual(site.devices,V1.machines);
 assert.deepEqual(site.runtimes,[{id:'alpha-llm',device:'alpha',kind:'ollama',url:'http://10.0.0.2:11434'}]);
 assert.deepEqual(site.plugins,V1.plugins);
 assert.deepEqual(renamed,['device list converted (2)','runtime device fields converted (1)']);
 assert.equal(validateSite(site).devices.length,2);
 assert.equal(V1.runtimes[0].machine,'alpha','the input is not changed');
});

test('convertSite refuses a current file and a file that is not valid legacy',()=>{
 const refused=(raw,re)=>assert.throws(()=>convertSite(raw),e=>e.refused===true&&re.test(e.message),re);
 refused(convertSite(V1).site,/already (?:uses devices|in the current form)/);
 refused({runtimes:[{machine:'x',device:'x'}]},/already (?:uses devices|in the current form)/);
 refused({machines:[],runtimes:[{machine:'x',device:'x'}]},/must not also contain that field/);
 refused({...V1,devices:[]},/conflicting device fields/);
 refused({...V1,machines:[{id:'Bad id'}]},/not a valid legacy site file: machines|not a valid legacy site file: devices\[0\]\.id/);
 refused({...V1,runtimes:[{machine:'gone',kind:'ollama',url:'http://10.0.0.9:11434'}]},/not a valid legacy site file/);
 refused({...V1,colour:'blue'},/unknown field/);
 refused([],/not a JSON object/);
});

test('convertSite notes Czech string overrides that name a "stroj"',()=>{
 const {notes}=convertSite({...V1,strings:{en:{'Upravit stroj':'Edit computer','Jiný text':'Other'}}});
 assert.equal(notes.length,1);assert.match(notes[0],/1 text/);
 assert.deepEqual(convertSite(V1).notes,[]);
});

test('convertSiteFile writes the current file in place, keeps the legacy copy and its mode, and refuses a second run',async()=>{
 const d=await dir();
 try{
  const file=path.join(d,'site.json'),text=`${JSON.stringify(V1,null,1)}\n`;
  await writeFile(file,text);await chmod(file,0o640);
  const r=convertSiteFile(file);
  assert.equal(r.kept,path.join(await import('node:fs').then(fs=>fs.realpathSync(d)),'site.v1.json'));
  assert.equal(await readFile(r.kept,'utf8'),text,'the legacy file is kept byte for byte');
  const now=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(now,convertSite(V1).site);
  assert.equal((await stat(file)).mode&0o777,0o640);
  assert.deepEqual((await readdir(d)).sort(),['site.json','site.v1.json'],'no temporary file is left');
  // Again: the file is 2.0 now.
  assert.throws(()=>convertSiteFile(file),/already (?:uses devices|in the current form)/);
  // A legacy file again, but the copy of the first run is in the way: nothing is written.
  await writeFile(file,text);
  assert.throws(()=>convertSiteFile(file),/site\.v1\.json already exists/);
  assert.equal(await readFile(file,'utf8'),text);
 }finally{await rm(d,{recursive:true,force:true});}
});

test('v1Path keeps the name and the extension',()=>{
 assert.equal(v1Path('/x/site.json'),'/x/site.v1.json');
 assert.equal(v1Path('/x/other'),'/x/other.v1.json');
});

test('the command: says what it renamed, exits 1 on a refusal, 2 on usage, and touches nothing it refuses',async()=>{
 const d=await dir();
 try{
  const file=path.join(d,'site.json');
  await writeFile(file,JSON.stringify(V1));
  const ok=run(file);
  assert.equal(ok.status,0,ok.stderr);
  assert.match(ok.stdout,/converted to the current format/);assert.match(ok.stdout,/device list converted \(2\)/);
  assert.match(ok.stdout,/runtime device fields converted \(1\)/);assert.match(ok.stdout,/site\.v1\.json/);
  const again=run(file);
  assert.equal(again.status,1);assert.match(again.stderr,/already (?:uses devices|in the current form)/);
  const bad=path.join(d,'bad.json');await writeFile(bad,'{"machines":[{"id":"Bad"}]}');
  const invalid=run(bad);
  assert.equal(invalid.status,1);assert.match(invalid.stderr,/not a valid legacy site file/);
  assert.equal(await readFile(bad,'utf8'),'{"machines":[{"id":"Bad"}]}');
  assert.deepEqual((await readdir(d)).sort(),['bad.json','site.json','site.v1.json']);
  assert.equal(run(path.join(d,'missing.json')).status,1);
  assert.equal(run('--machine').status,2);
  assert.equal(run().status,1,'no file named and HOME_HUB_SITE_CONFIG=none');
 }finally{await rm(d,{recursive:true,force:true});}
});
