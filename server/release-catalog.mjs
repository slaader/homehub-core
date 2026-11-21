// Discovery is evidence only. Shared UI/CLI selection, never an installation authorization.
import {pickRelease,createFetchJson,resolveUpstream} from './systems-upstream.mjs';
import {validRepo} from './version.mjs';
import {parse,compare} from './semver.mjs';
import {mkdirSync,createWriteStream,rmSync,renameSync,readFileSync} from 'node:fs';
import path from 'node:path';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {authenticatePackageMetadata,verifyPackage} from './release-package.mjs';
import {durableWrite} from './safe-fs.mjs';
export function selectPublished(releases,{channel='stable'}={}){return pickRelease(releases,{allowPrerelease:channel==='prerelease'});}
export function publishedCatalog(releases,{repository,channel='stable'}={}){
 if(!validRepo(repository))throw new Error('invalid fixed release repository');const unique=new Map();
 for(const r of releases??[]){const tag=r.tag_name??r.tag,version=typeof tag==='string'&&tag.startsWith('v')?parse(tag.slice(1)):null;if(!version||r.draft||(channel!=='prerelease'&&(r.prerelease||version.prerelease.length)))continue;
 const names=[`home-hub-${tag}-node-source.tar.gz`,`home-hub-${tag}.manifest.json`,`home-hub-${tag}.manifest.sig.json`],assets=[];
 for(const name of names){const a=r.assets?.find(a=>a.name===name);if(!a)continue;const url=`https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;if((a.browser_download_url??a.url)!==url)continue;assets.push({name,url,bytes:Number.isSafeInteger(a.size??a.bytes)?(a.size??a.bytes):null,digest:typeof a.digest==='string'&&/^sha256:[0-9a-f]{64}$/.test(a.digest)?a.digest.slice(7):typeof a.digest==='string'&&/^[0-9a-f]{64}$/.test(a.digest)?a.digest:null});}
 unique.set(tag,{tag,tag_name:tag,version:version.text,prerelease:Boolean(r.prerelease),draft:false,url:`https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,publishedAt:r.published_at??r.publishedAt??null,assets,manifestDigest:assets.find(a=>a.name.endsWith('.manifest.json'))?.digest??null,signature:'not-checked',compatibility:'unknown',verifiedAt:null});
 }return [...unique.values()].sort((a,b)=>compare(b.version,a.version)).slice(0,40);
}
export async function discoverReleases({repository,channel='stable',fetchJson=createFetchJson({}),previous=null}={}){
 const observed=[];const capture=async(url,options)=>{const r=await fetchJson(url,options);if(r.status!==304)observed.push(...(Array.isArray(r.json)?r.json:[r.json]));return r;};
 const found=await resolveUpstream({type:'github',repo:repository,allowPrerelease:channel==='prerelease',notes:true},{fetchJson:capture,previous});
 return {found,releases:publishedCatalog(observed,{repository,channel})};
}
function allowedAssetUrl(raw,{repository,tag,asset,redirect=false}){
 const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('unsafe asset transport');
 if(!redirect){if(url.href!==`https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${asset}`)throw new Error('asset URL is not in the configured repository');}
 else if(!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname))throw new Error('unapproved asset redirect host');return url;
}
export async function fetchAsset(url,{repository,tag,asset,limit,fetchImpl=fetch,destination}={}){
 let current=allowedAssetUrl(url,{repository,tag,asset});const signal=AbortSignal.timeout(60000);
 for(let count=0;count<4;count++){
  const r=await fetchImpl(current.href,{redirect:'manual',signal,headers:{'user-agent':'home-hub-package-download'}}); // no API token, including redirects
  if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();current=allowedAssetUrl(new URL(r.headers.get('location'),current).href,{repository,tag,asset,redirect:true});continue;}
  if(r.status!==200||!r.body)throw new Error(`asset HTTP ${r.status}`);let bytes=0;const chunks=[];
  async function* bounded(){for await(const chunk of r.body){bytes+=chunk.length;if(bytes>limit)throw new Error('asset exceeds local limit');yield chunk;}}
  if(destination)await pipeline(Readable.from(bounded()),createWriteStream(destination,{flags:'wx',mode:0o600}));else for await(const chunk of bounded())chunks.push(Buffer.from(chunk));return destination??Buffer.concat(chunks,bytes);
 }throw new Error('too many asset redirects');
}
export async function downloadPackage({tag,repository,trustFile,manifestDigest,output,fetchJson,fetchImpl,enabled=true}={}){
 if(!enabled)throw new Error('Update discovery is disabled; zero update network requests made');if(!validRepo(repository)||!/^v[0-9A-Za-z.+-]+$/.test(tag))throw new Error('invalid package release selection');
 const {releases}=await discoverReleases({repository,channel:'prerelease',fetchJson});const release=releases.find(r=>r.tag===tag);if(!release||release.assets.length!==3)throw new Error('published release has no complete package asset set');
 mkdirSync(output,{recursive:true,mode:0o700});const payload=release.assets.find(a=>a.name.endsWith('.tar.gz')),file=path.join(output,payload.name);
 // Download sidecars, then authenticate them before requesting the executable payload.
 for(const asset of release.assets.filter(a=>!a.name.endsWith('.tar.gz'))){const bytes=await fetchAsset(asset.url,{repository,tag,asset:asset.name,limit:asset.name.endsWith('.sig.json')?16384:8*1024*1024,fetchImpl});durableWrite(path.join(output,asset.name),bytes);}
 const verified=authenticatePackageMetadata(file,{trustFile,repository,tag,manifestDigest});const temp=file+'.download-'+process.pid;
 try{await fetchAsset(payload.url,{repository,tag,asset:payload.name,limit:verified.manifest.artifact.bytes,fetchImpl,destination:temp});renameSync(temp,file);await verifyPackage(file,{trustFile,repository,manifestDigest:verified.manifestSha256});return {...verified,file};}finally{rmSync(temp,{force:true});}
}
