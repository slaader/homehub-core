// Ephemeral public/publisher material, used only in disposable test directories.
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdirSync,writeFileSync,lstatSync} from 'node:fs';import path from 'node:path';
import {writeArchive} from '../server/release-archive.mjs';
import {sha256,MANIFEST_DOMAIN,publicKey} from '../server/release-trust.mjs';
import {fileHash} from '../server/update-backup.mjs';
export async function packageFixture(dir,{version='1.1.0',epoch=1,files={},repository='example/core',fullCommit='a'.repeat(40)}={}){
 mkdirSync(dir,{recursive:true,mode:0o700});const pair=generateKeyPairSync('ed25519'),pem=pair.publicKey.export({type:'spki',format:'pem'}),id=publicKey(pem).id;
 const trust={schemaVersion:1,publishers:{[repository]:{gitSigners:[],packageKeys:[{id,publicKey:pem,fingerprint:id,role:'package',status:'active'}]}}},trustFile=path.join(dir,'trust.json');writeFileSync(trustFile,JSON.stringify(trust),{mode:0o600});
 const content={'package.json':JSON.stringify({name:'home-hub',version,type:'module',engines:{node:'>=22'},homeHub:{dataEpoch:epoch,updates:{repo:repository}}}),...files},entries=[];
 for(const [name,bytes] of Object.entries(content)){const file=path.join(dir,'source',name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,bytes);entries.push({path:name,source:file,bytes:Buffer.byteLength(bytes),sha256:sha256(Buffer.from(bytes)),mode:0o644,type:'file'});}
 const tag='v'+version,base=path.join(dir,`home-hub-${tag}`),file=base+'-node-source.tar.gz';await writeArchive(file,entries);
 const manifest={schemaVersion:1,product:'home-hub',repository,version,tag,fullCommit,dataEpoch:epoch,nodeRange:'>=22',minimumUpdaterVersion:'1.0.0',platforms:['darwin','linux'],architectures:['arm64','x64'],readinessProtocol:1,artifact:{name:path.basename(file),bytes:lstatSync(file).size,sha256:fileHash(file),uncompressedBytes:1024+entries.reduce((n,e)=>n+512+Math.ceil(e.bytes/512)*512,0)},files:entries.map(({source,type,...f})=>f)};
 const save=()=>{const bytes=Buffer.from(JSON.stringify(manifest)+'\n');writeFileSync(base+'.manifest.json',bytes);writeFileSync(base+'.manifest.sig.json',JSON.stringify({schemaVersion:1,algorithm:'ed25519',keyId:id,signature:sign(null,Buffer.concat([MANIFEST_DOMAIN,bytes]),pair.privateKey).toString('base64')}));return sha256(bytes);};const manifestSha256=save();return {file,manifest,manifestSha256,base,trust,trustFile,save,pair};
}
