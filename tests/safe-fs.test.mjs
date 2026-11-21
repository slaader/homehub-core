import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync,realpathSync,lstatSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sha256,fileHash,withinPath,cleanAbsolute,canonicalPath,boundedRegularFile,syncDirectory,durableWrite,strictJson,fields} from '../server/safe-fs.mjs';

function tempDir(t,prefix='hub-safe-fs-'){
 const dir=realpathSync.native(mkdtempSync(path.join(os.tmpdir(),prefix)));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return dir;
}

test('safe-fs: withinPath handles root, trailing separators, sibling prefixes and parent traversals',()=>{
 assert.equal(withinPath('/foo','/'),true);
 assert.equal(withinPath('/','/foo'),false);
 assert.equal(withinPath('/','/'),true);
 assert.equal(withinPath('/app','/app'),true);
 assert.equal(withinPath('/app/','/app'),true);
 assert.equal(withinPath('/app','/app/'),true);
 assert.equal(withinPath('/app/sub/file','/app/'),true);
 assert.equal(withinPath('/app2','/app'),false);
 assert.equal(withinPath('/app2','/app/'),false);
 assert.equal(withinPath('/app/../other','/app'),false);
 assert.equal(withinPath('/app/sub/../ok','/app'),true);
 assert.equal(withinPath('','/app'),false);
 assert.equal(withinPath('/app',''),false);
 assert.equal(withinPath(null,'/app'),false);
});

test('safe-fs: cleanAbsolute validates normalized non-root absolute paths without control characters',()=>{
 assert.equal(cleanAbsolute('/srv/example-hub/data'),true);
 assert.equal(cleanAbsolute('/'),false);
 assert.equal(cleanAbsolute('relative/path'),false);
 assert.equal(cleanAbsolute('/srv/example-hub/'),false);
 assert.equal(cleanAbsolute('/srv/example-hub/../other'),false);
 assert.equal(cleanAbsolute('/srv/example\0hub'),false);
 assert.equal(cleanAbsolute('/srv/example\nhub'),false);
 assert.equal(cleanAbsolute('/'+'a'.repeat(4097)),false);
 assert.equal(cleanAbsolute(123),false);
});

test('safe-fs: canonicalPath resolves symlinked parents with missing multi-level leaves and refuses dangling symlinks',t=>{
 const dir=tempDir(t);
 const real=path.join(dir,'real'),link=path.join(dir,'link');
 mkdirSync(real);
 symlinkSync(real,link);
 assert.equal(canonicalPath(link),real);
 assert.equal(canonicalPath(path.join(link,'missing-a','missing-b','leaf.json')),path.join(real,'missing-a','missing-b','leaf.json'));
 const dangling=path.join(dir,'dangling');
 symlinkSync(path.join(dir,'does-not-exist'),dangling);
 assert.throws(()=>canonicalPath(dangling),{code:'ENOENT'});
 assert.throws(()=>canonicalPath(path.join(dangling,'child')),{code:'ENOENT'});
});

test('safe-fs: fileHash streams with O_NOFOLLOW and enforces expectedBytes',t=>{
 const dir=tempDir(t);
 const file=path.join(dir,'data.bin'),link=path.join(dir,'data.link');
 const content=Buffer.from('home-hub safe-fs payload\n');
 writeFileSync(file,content);
 symlinkSync(file,link);
 assert.equal(fileHash(file),sha256(content));
 assert.equal(fileHash(file,content.length),sha256(content));
 assert.throws(()=>fileHash(file,content.length-1),/exceeds its expected size/);
 assert.throws(()=>fileHash(file,content.length+1),/does not match its expected size/);
 assert.throws(()=>fileHash(link),{code:'ELOOP'});
});

test('safe-fs: boundedRegularFile refuses symlinks, directories, oversized files and surfaces ENOENT',t=>{
 const dir=tempDir(t);
 const file=path.join(dir,'meta.json'),link=path.join(dir,'meta.link'),sub=path.join(dir,'sub');
 mkdirSync(sub);
 writeFileSync(file,'{"ok":true}');
 symlinkSync(file,link);
 assert.deepEqual(boundedRegularFile(file,11,'metadata'),Buffer.from('{"ok":true}'));
 assert.throws(()=>boundedRegularFile(file,10,'metadata'),/metadata must be a bounded regular file/);
 assert.throws(()=>boundedRegularFile(link,1024,'metadata'),/metadata must be a bounded regular file/);
 assert.throws(()=>boundedRegularFile(sub,1024,'metadata'),/metadata must be a bounded regular file/);
 assert.throws(()=>boundedRegularFile(path.join(dir,'missing.json'),1024,'metadata'),{code:'ENOENT'});
});

test('safe-fs: durableWrite writes atomically with permissions and cleans up temp files on beforeRename failure',t=>{
 const dir=tempDir(t);
 const target=path.join(dir,'nested','state.json');
 durableWrite(target,'{"v":1}\n',0o600);
 assert.equal(readFileSync(target,'utf8'),'{"v":1}\n');
 assert.equal(lstatSync(target).mode&0o777,0o600);
 syncDirectory(path.dirname(target));
 assert.throws(()=>durableWrite(target,'{"v":2}\n',0o600,()=>{throw new Error('abort rename');}),/abort rename/);
 assert.equal(readFileSync(target,'utf8'),'{"v":1}\n');
 assert.deepEqual(readdirSync(path.dirname(target)),['state.json']);
});

test('safe-fs: strictJson rejects duplicate keys, invalid UTF-8, trailing data and oversized payloads',()=>{
 assert.deepEqual(strictJson(Buffer.from('{"a":1,"b":[true,false,null,-2.5e1,"ok"]}')),{a:1,b:[true,false,null,-25,'ok']});
 assert.throws(()=>strictJson(Buffer.from('{"a":1,"a":2}')),/duplicate JSON key: a/);
 assert.throws(()=>strictJson(Buffer.from('{"a":1,"\\u0061":2}')),/duplicate JSON key: a/);
 assert.throws(()=>strictJson(Buffer.from('{"nested":{"k":1,"k":2}}')),/duplicate JSON key: k/);
 assert.throws(()=>strictJson(Buffer.from('{} trailing')),/trailing JSON content/);
 assert.throws(()=>strictJson(Buffer.from([0xff,0xfe])));
 assert.throws(()=>strictJson(Buffer.from('{"a":"12345"}'),{limit:8}),/exceeds local byte limit/);
});

test('safe-fs: fields rejects non-objects, arrays and unexpected properties',()=>{
 assert.doesNotThrow(()=>fields({a:1,b:2},['a','b','c'],'sample'));
 assert.throws(()=>fields({a:1,extra:true},['a','b'],'sample'),/invalid sample fields/);
 assert.throws(()=>fields([],['a'],'sample'),/invalid sample fields/);
 assert.throws(()=>fields(null,['a'],'sample'),/invalid sample fields/);
});
