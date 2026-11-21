#!/usr/bin/env node
// Local-only packaging of an exact, independently authorized signed tag. Never creates keys or publishes.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync,lstatSync,chmodSync} from 'node:fs';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {loadTrust,authorizedKeys,publicKey,MANIFEST_DOMAIN} from '../server/release-trust.mjs';
import {sha256,fileHash,durableWrite,withinPath} from '../server/safe-fs.mjs';
import {archivePath,writeArchive} from '../server/release-archive.mjs';
import {verifyPackage,UPDATER_VERSION} from '../server/release-package.mjs';
import {scanLeaks} from './leak-scan.mjs';
const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_COUNT:'0'};
const git=(root,...args)=>execFileSync('git',['-C',root,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env,maxBuffer:256*1024*1024});
export async function packageRelease({root,tag,keyFile,trustFile,output,tests=true}){
 root=path.resolve(root);output=path.resolve(output);if(withinPath(path.resolve(keyFile),root))throw new Error('publisher private key must be outside the repository');
 const object=git(root,'rev-parse',`refs/tags/${tag}`).toString().trim();if(git(root,'cat-file','-t',object).toString().trim()!=='tag')throw new Error('an annotated signed release tag is required');
 const fullCommit=git(root,'rev-parse',`${object}^{commit}`).toString().trim(),pkg=JSON.parse(git(root,'show',`${fullCommit}:package.json`));if(tag!=='v'+pkg.version)throw new Error('tag/version mismatch');
 const trust=loadTrust(trustFile,{forbidden:[root]}),repository=pkg.homeHub.updates.repo,signerDir=mkdtempSync(path.join(os.tmpdir(),'hub-package-signers-'));
 try{const signers=path.join(signerDir,'allowed'),keys=authorizedKeys(trust,repository,'git',pkg.version);if(!keys.length)throw new Error('no authorized Git publisher signer');writeFileSync(signers,keys.map(k=>`release namespaces="git" ${k.publicKey.trim()}`).join('\n')+'\n',{mode:0o600});git(root,'-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen','-c',`gpg.ssh.allowedSignersFile=${signers}`,'verify-tag',object);}finally{rmSync(signerDir,{recursive:true,force:true});}
 const st=lstatSync(keyFile);if(!st.isFile()||st.isSymbolicLink()||st.mode&0o077||st.uid!==(process.getuid?.()??st.uid))throw new Error('private key must be an owner-only regular file');
 const privateKey=createPrivateKey(readFileSync(keyFile)),pub=publicKey(createPublicKey(privateKey).export({format:'pem',type:'spki'}));if(!authorizedKeys(trust,repository,'package',pkg.version).some(k=>k.id===pub.id))throw new Error('package signer is not authorized');
 mkdirSync(output,{recursive:true,mode:0o700});const source=mkdtempSync(path.join(output,'.payload-')),artifact={name:`home-hub-${tag}-node-source.tar.gz`},file=path.join(output,artifact.name);
 try{
  const records=git(root,'ls-tree','-rz','--full-tree',fullCommit).toString('utf8').split('\0').filter(Boolean),files=[];
  for(const record of records){const m=/^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);if(!m)throw new Error('release contains unsupported special tree entry');const name=archivePath(m[3]);if(/^(?:local|data|state|private|node_modules)(?:\/|$)/.test(name))throw new Error('release contains household or mutable state');const bytes=git(root,'cat-file','blob',m[2]),dest=path.join(source,name),mode=m[1]==='100755'?0o755:0o644;mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,bytes,{mode});files.push({path:name,bytes:bytes.length,sha256:sha256(bytes),mode,source:dest,type:'file'});}
  // Trusted driver scanner; payload code has not run. The exact tracked file list was materialized with plumbing.
  const leaks=scanLeaks(source);if(leaks.length)throw new Error(`release leak scan refused ${leaks.length} finding(s)`);
  await writeArchive(file,files);artifact.bytes=lstatSync(file).size;artifact.sha256=fileHash(file);artifact.uncompressedBytes=1024+files.reduce((n,f)=>n+512+Math.ceil(f.bytes/512)*512,0);
  const manifest={schemaVersion:1,product:'home-hub',repository,version:pkg.version,tag,fullCommit,dataEpoch:pkg.homeHub.dataEpoch,nodeRange:pkg.engines.node,minimumUpdaterVersion:UPDATER_VERSION,platforms:['darwin','linux'],architectures:['arm64','x64'],readinessProtocol:1,artifact,files:files.map(({type,source,...f})=>f)},bytes=Buffer.from(JSON.stringify(manifest,null,1)+'\n');
  const prefix=path.join(output,`home-hub-${tag}`);durableWrite(prefix+'.manifest.json',bytes);durableWrite(prefix+'.manifest.sig.json',JSON.stringify({schemaVersion:1,algorithm:'ed25519',keyId:pub.id,signature:sign(null,Buffer.concat([MANIFEST_DOMAIN,bytes]),privateKey).toString('base64')})+'\n');
  const verified=await verifyPackage(file,{trust,repository,keepStage:true,stagingParent:output});try{if(tests)execFileSync(process.execPath,[path.join(verified.stage,'scripts','run-tests.mjs')],{cwd:verified.stage,env:Object.fromEntries(Object.entries(env).filter(([k])=>['PATH','HOME','TMPDIR','LANG','TZ'].includes(k))),stdio:'inherit',timeout:1800000});}finally{rmSync(verified.stage,{recursive:true,force:true});}
  return {file,manifestSha256:verified.manifestSha256,fullCommit};
 }finally{rmSync(source,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),values={};for(let i=0;i<args.length;i+=2){if(!['--root','--tag','--key','--trust','--output'].includes(args[i])||!args[i+1])throw new Error('Usage: package-release.mjs --tag vX.Y.Z --key FILE --trust FILE --output DIR [--root DIR]');values[args[i].slice(2)]=args[i+1];}
 try{console.log(await packageRelease({root:values.root??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),tag:values.tag,keyFile:values.key,trustFile:values.trust,output:values.output}));}catch(e){console.error(e.message);process.exitCode=1;}
}
