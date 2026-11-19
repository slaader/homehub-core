import test from 'node:test';
import assert from 'node:assert/strict';
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,linkSync,symlinkSync,writeFileSync,rmSync,truncateSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main,parseArgs} from '../scripts/update.mjs';

function fixture(t){
 const top=realpathSync.native(mkdtempSync(path.join(os.homedir(),'.home-hub-diagnose-')));
 t.after(()=>rmSync(top,{recursive:true,force:true}));
 const home=path.join(top,'hub'),legacy=path.join(top,'legacy');
 for(const name of ['core','data/state','config','private','update'])mkdirSync(path.join(home,name),{recursive:true,mode:0o700});
 mkdirSync(legacy);
 writeFileSync(path.join(home,'core','package.json'),'{"name":"home-hub"}\n');
 writeFileSync(path.join(home,'instance.json'),JSON.stringify({schemaVersion:1,sources:{core:'core',plugins:[]}}));
 const media=path.join(home,'data','media'),exact=path.join(legacy,'only-this.bin'),unrelated=path.join(legacy,'other.bin');
 writeFileSync(media,'contents');linkSync(media,exact);writeFileSync(unrelated,'other');
 const policy=path.join(home,'update','backup-policy.json');
 const ctx={exec(){assert.fail('diagnostics invoked a command');},probe(){assert.fail('diagnostics probed the service');}};
 const run=async(args,expected)=>{
  let result;
  const code=await main([...args,'--home',home],{env:{},ctx,out:line=>{result=JSON.parse(line);}});
  assert.equal(code,expected,JSON.stringify(result));
  return result;
 };
 const snapshot=()=>{
  function walk(file){
   const s=lstatSync(file,{bigint:true}),common=[file,s.ino,s.nlink,s.mode,s.size,s.mtimeNs,s.ctimeNs];
   return s.isDirectory()?[common,...readdirSync(file).sort().flatMap(name=>walk(path.join(file,name)))]:[common];
  }
  return walk(top);
 };
 return {home,legacy,media,exact,unrelated,policy,run,snapshot};
}

test('diagnose discovers candidate aliases without enrolling names or writing anything',async t=>{
 const f=fixture(t),before=f.snapshot();
 const found=await f.run(['backup-diagnose','--search-root',f.legacy,'--examples','2','--candidate-cover-files'],1);
 assert.equal(found.links.groups,1);
 assert.equal(found.links.foundNames,1);
 assert.equal(found.links.missingNames,1);
 assert.equal(found.links.unfoundNames,0);
 assert.deepEqual(found.links.candidateCoverFiles,[f.exact]);
 assert.deepEqual(found.links.examples,[f.exact]);
 assert.deepEqual(found.links.parents,[{parent:f.legacy,names:1,bytes:8,extensions:{'.bin':1}}]);
 assert.deepEqual(f.snapshot(),before);
 const unresolved=await f.run(['preflight','--read-only'],1);
 assert.equal(unresolved.links.unfoundNames,1);
 assert.equal(unresolved.journal,null);
 assert.deepEqual(f.snapshot(),before);
 writeFileSync(f.policy,JSON.stringify({schemaVersion:1,coverFiles:[f.exact]}),{mode:0o600});
 const chosen=f.snapshot(),preflight=await f.run(['preflight','--read-only'],0);
 assert.equal(preflight.links.missingNames,0);
 assert.equal(preflight.rootStats.filter(r=>r.role==='exact-file').length,1);
 assert.deepEqual(f.snapshot(),chosen);
 assert.equal(readFileSync(f.unrelated,'utf8'),'other');
 assert.throws(()=>parseArgs(['apply','--search-root',f.legacy]),/only for backup-diagnose/);
});

test('diagnose reports independent budget and coverage blockers without opening payloads',async t=>{
 const f=fixture(t);
 truncateSync(f.media,70*1024**2);
 symlinkSync('missing',path.join(f.home,'private','missing-link'));
 const before=f.snapshot();
 const result=await f.run(['backup-diagnose','--search-root',f.legacy],1);
 assert.equal(result.counts.OVER_BUDGET_FILE,1);
 assert.equal(result.counts.HARDLINK_UNACCOUNTED,1);
 assert.equal(result.counts.DANGLING_LINK,1);
 assert.equal(result.links.candidateCoverFiles,undefined);
 assert.equal(result.links.examples,undefined);
 assert.equal(result.filesystems.reduce((n,row)=>n+row.restoreBytes,0)>70*1024**2,true);
 assert.deepEqual(f.snapshot(),before);
});

test('precise policy refuses unrelated files and alternate spellings of the same directory entry',async t=>{
 const f=fixture(t),other=path.join(f.legacy,'OTHER.bin'),uncovered=path.join(f.legacy,'uncovered.bin');
 linkSync(f.unrelated,other+'-alias');
 linkSync(f.media,uncovered);
 writeFileSync(f.policy,JSON.stringify({schemaVersion:1,coverFiles:[f.exact,f.exact.toUpperCase(),f.unrelated,other+'-alias']}),{mode:0o600});
 const found=await f.run(['backup-diagnose'],1);
 assert.equal(found.counts.INVALID_EXACT_FILE>=1,true);
 assert.equal(found.counts.HARDLINK_UNACCOUNTED,1);
});

test('space checks reserve the backup and one payload per inode on the destination filesystem',async t=>{
 const f=fixture(t),{scanBackup}=await import('../server/backup-scan.mjs');
 const {resolveInstance}=await import('../server/update-apply.mjs');
 writeFileSync(f.policy,JSON.stringify({schemaVersion:1,coverFiles:[f.exact],budget:{maxFileBytes:128*1024**2}}),{mode:0o600});
 truncateSync(f.media,70*1024**2);
 const result=scanBackup(resolveInstance({env:{HOME_HUB_HOME:f.home}}),{space:()=>({bavail:25000n,bsize:4096n})});
 assert.equal(result.counts.INSUFFICIENT_SPACE,1);
 assert.ok(result.filesystems[0].restoreBytes>70*1024**2);
 assert.ok(result.filesystems[0].restoreBytes<71*1024**2);
 assert.ok(result.filesystems[0].backupBytes>70*1024**2);
});
