import {randomBytes} from 'node:crypto';
import {htmlSource} from '../public/wiki-doc.js';

export const WIKI_FRAME_CSP="sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const tags=new Set(('a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em '+
 'figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark nav ol p pre q rp rt ruby s '+
 'samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr').split(' '));
const voidTags=new Set(['br','col','hr','img','wbr']);
const globalAttrs=new Set(['class','id','style','title','lang','dir','role']);
const tagAttrs={
 img:['src','alt','width','height'],td:['colspan','rowspan'],th:['colspan','rowspan','scope'],
 col:['span'],colgroup:['span'],details:['open'],ol:['start','reversed','type'],li:['value'],
 time:['datetime'],
};
const omitContents=new Set(['script','textarea','title','xmp','iframe','noembed','noframes','plaintext','noscript','template']);
const image=/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

function attributes(tag,source){
 const allowed=Object.hasOwn(tagAttrs,tag)?tagAttrs[tag]:[];
 const used=new Set(),out=[];
 for(const match of source.matchAll(/([^\s"'<>/=`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)){
  const name=match[1].toLowerCase(),value=match[2]??match[3]??match[4]??'';
  if(used.has(name)||!(globalAttrs.has(name)||allowed.includes(name)||/^aria-[a-z-]+$/.test(name)))continue;
  if(name==='src'&&!image.test(value))continue;
  used.add(name);
  out.push(` ${name}="${value.replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')}"`);
 }
 return out.join('');
}

// Emit only fixed HTML tag and attribute names. This also removes refresh, active links, nested frames
// and other document navigation that can otherwise take place within an opaque-origin sandbox.
export function staticWikiHtml(source){
 const tokens=/<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][a-z0-9-]*)(?=[\s/>])((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>|</gi;
 const result=['<!doctype html><html><head><meta charset="utf-8"></head><body>'];
 let end=0,token;
 while((token=tokens.exec(source))){
  result.push(source.slice(end,token.index));
  end=tokens.lastIndex;
  const [raw,closing,tagName,attrs]=token;
  if(!tagName){
   if(raw==='<')result.push('&lt;');
   continue;
  }
  const tag=tagName.toLowerCase();
  if(!closing&&(tag==='style'||omitContents.has(tag))){
   const close=new RegExp(`</${tag}[\\t\\n\\f\\r ]*>`,'ig');
   close.lastIndex=end;
   const next=tag==='plaintext'?null:close.exec(source);
   if(tag==='style')result.push('<style>',source.slice(end,next?.index??source.length).replaceAll('<','\\3C '),'</style>');
   end=tokens.lastIndex=next?close.lastIndex:source.length;
   continue;
  }
  if(tags.has(tag)&&!(closing&&voidTags.has(tag)))result.push(closing?`</${tag}>`:`<${tag}${attributes(tag,attrs)}>`);
 }
 result.push(source.slice(end),'</body></html>');
 return result.join('');
}

const TTL=10*60*1000,PER_OWNER=20,MAX_TOTAL=128;
const fail=code=>{throw new Error(code);};

export function createWikiPreviews(now=Date.now){
 const drafts=new Map();
 function prune(at){
  for(const [id,draft] of drafts)if(draft.until<=at)drafts.delete(id);
 }
 return {
  put(owner,input){
   const source=htmlSource(input),at=now();
   prune(at);
   if([...drafts.values()].filter(draft=>draft.owner===owner).length>=PER_OWNER||drafts.size>=MAX_TOTAL)fail('limit');
   const token=randomBytes(24).toString('base64url');
   drafts.set(token,{owner,source,until:at+TTL});
   return token;
  },
  get(owner,token){
   prune(now());
   const draft=drafts.get(token);
   if(draft?.owner!==owner||!draft)fail('not-found');
   return draft.source;
  },
 };
}
