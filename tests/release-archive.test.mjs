import {ARCHIVE_LIMITS} from '../server/release-archive.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,existsSync,readFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {gzipSync} from 'node:zlib';
import {extractArchive} from '../server/release-archive.mjs';
function tarEntry(name,{type='0',data=Buffer.from('x'),mode=0o644,link='',prefix=''}={}){const b=Buffer.alloc(512);b.write(name,0,100);b.write(mode.toString(8).padStart(7,'0')+'\0',100,8);b.write((type==='0'?data.length:0).toString(8).padStart(11,'0')+'\0',124,12);b.fill(32,148,156);b.write(type,156);b.write(link,157,100);b.write('ustar\0',257);b.write('00',263);b.write(prefix,345,155);b.write(b.reduce((n,v)=>n+v,0).toString(8).padStart(6,'0')+'\0 ',148,8);return Buffer.concat([b,...(type==='0'?[data,Buffer.alloc((512-data.length%512)%512)]:[])]);}
test('archive: hostile signed content is constrained to staging with a restricted USTAR grammar',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'hub-tar-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'payload.gz');
 const cases=[tarEntry('../escape'),tarEntry('/escape'),tarEntry('a\\b'),tarEntry('C:/drive'),tarEntry('safe',{prefix:'../'}),tarEntry('link',{type:'2',link:'/tmp'}),tarEntry('pax',{type:'x'}),tarEntry('gnu',{type:'L'}),tarEntry('device',{type:'3'}),tarEntry('sticky',{mode:0o1644}),Buffer.concat([tarEntry('dup'),tarEntry('dup')]),Buffer.concat([tarEntry('A'),tarEntry('a')]),Buffer.concat([tarEntry('parent'),tarEntry('parent/child')]),Buffer.concat([tarEntry('parent/child'),tarEntry('parent')])];
 for(const [i,bytes] of cases.entries()){const root=path.join(dir,'stage-'+i);mkdirSync(root);writeFileSync(file,gzipSync(Buffer.concat([bytes,Buffer.alloc(1024)])));await assert.rejects(extractArchive(file,root));assert.ok(!existsSync(path.join(dir,'escape')));}
 const bad=tarEntry('checksum');bad[0]^=1;const root=path.join(dir,'checksum');mkdirSync(root);writeFileSync(file,gzipSync(Buffer.concat([bad,Buffer.alloc(1024)])));await assert.rejects(extractArchive(file,root),/checksum/);
});
test('archive: truncation, unsupported trailing bytes and incomplete manifests fail',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'hub-tar-complete-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));for(const [i,bytes] of [tarEntry('one').subarray(0,600),Buffer.concat([tarEntry('one'),Buffer.alloc(1024),Buffer.from('malicious')])].entries()){const root=path.join(dir,'stage'+i);mkdirSync(root);const file=path.join(dir,'p'+i);writeFileSync(file,gzipSync(bytes));await assert.rejects(extractArchive(file,root));}
});


test('release package limits remain separate and unchanged',()=>{
 assert.deepEqual(ARCHIVE_LIMITS,{entries:20000,compressed:256*1024**2,expanded:1024**3,file:64*1024**2});
});
