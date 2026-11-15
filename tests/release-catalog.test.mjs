import test from 'node:test';import assert from 'node:assert/strict';
import {publishedCatalog,selectPublished,fetchAsset,downloadPackage} from '../server/release-catalog.mjs';
const release=(tag,extra={})=>({tag_name:tag,html_url:`https://github.com/example/core/releases/tag/${tag}`,draft:false,prerelease:false,assets:[],...extra});
test('catalog: UI and CLI share stable/prerelease selection and fixed asset repository',()=>{
 const entries=[release('v1.1.0'),release('v2.0.0',{draft:true}),release('v1.2.0-rc.1',{prerelease:true}),release('v1.0.0')];assert.equal(selectPublished(entries).tag,'v1.1.0');assert.equal(selectPublished(entries,{channel:'prerelease'}).tag,'v1.2.0-rc.1');
 const cat=publishedCatalog(entries,{repository:'example/core'});assert.deepEqual(cat.map(r=>r.tag),['v1.1.0','v1.0.0']);assert.ok(cat.every(r=>r.signature==='not-checked'&&r.compatibility==='unknown'));
});
test('catalog: asset redirects are bounded and never forward authentication, disabled download makes zero requests',async()=>{
 let calls=0;await assert.rejects(downloadPackage({enabled:false,fetchImpl:async()=>{calls++;}}),/disabled/);assert.equal(calls,0);
 const options={repository:'example/core',tag:'v1.1.0',asset:'manifest.json',limit:100};
 await assert.rejects(fetchAsset('https://evil.example/manifest.json',options),/configured repository/);
 let seen=[];const bytes=await fetchAsset('https://github.com/example/core/releases/download/v1.1.0/manifest.json',{...options,fetchImpl:async(url,o)=>{seen.push([url,o.headers]);return seen.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file'}}):new Response('signed metadata');}});assert.equal(bytes.toString(),'signed metadata');assert.ok(seen.every(([,headers])=>!headers.Authorization));
 await assert.rejects(fetchAsset('https://github.com/example/core/releases/download/v1.1.0/manifest.json',{...options,fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://evil.example/file'}})}),/unsafe/);
 await assert.rejects(fetchAsset('https://github.com/example/core/releases/download/v1.1.0/manifest.json',{...options,limit:2,fetchImpl:async()=>new Response('too large')}),/local limit/);
});
