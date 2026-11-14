// The two SSH line formats the security probe prints (scripts/security/ssh-probe.sh): an authorized_keys line and
// the line `ssh-keygen -l` prints for a key file. A leaf module (only node: imports), shared by the hub's SSH key
// inventory (server/security-data.mjs, which re-exports these) and the push agent's report check
// (server/agent-report.mjs, docs/agent.md → Leaf modules).
import {createHash} from 'node:crypto';

// The key types an authorized_keys line may name: typed, never free text (a FIDO type trips the "sk-" secret pattern).
export const KEY_TYPE=/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)(-cert-v01@openssh\.com)?$/;
const clean=(v,n=400)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';

export function fingerprintOf(b64){
 const blob=Buffer.from(b64,'base64');
 if(!blob.length)return null;
 return 'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,'');
}

// Split on a separator outside double quotes (authorized_keys options and tokens).
export function splitOutside(text,sep){
 const out=[];let cur='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];
  if(c==='\\'&&quoted&&i+1<text.length){cur+=c+text[++i];continue;}
  if(c==='"')quoted=!quoted;
  if(!quoted&&(sep===' '?/\s/.test(c):c===sep)){if(cur)out.push(cur);cur='';continue;}
  cur+=c;}
 if(cur)out.push(cur);return out;
}

// An authorized_keys line in its parts: the option tokens before the key type, the type, the base64 blob and the
// comment after it. null when no known key type with a blob after it is found.
export function splitAuthorizedLine(line){
 const tokens=splitOutside(clean(line,8000),' ');
 const at=tokens.findIndex(t=>KEY_TYPE.test(t));
 if(at<0||!tokens[at+1])return null;
 return {options:tokens.slice(0,at),type:tokens[at],blob:tokens[at+1],comment:tokens.slice(at+2).join(' ')};
}

export function parseAuthorizedLine(line){
 const parts=splitAuthorizedLine(line);if(!parts)return null;
 const {type,blob:b64,comment}=parts;
 const fingerprint=fingerprintOf(b64);if(!fingerprint)return null;
 const options={from:[],command:null,restrict:false,permitOpen:[],flags:[]};
 for(const opt of parts.options.flatMap(t=>splitOutside(t,','))){
  const m=/^([A-Za-z0-9-]+)(?:="(.*)")?$/s.exec(opt);if(!m)continue;
  const name=m[1].toLowerCase(),value=m[2]?.replace(/\\"/g,'"')??null;
  if(name==='from'&&value)options.from.push(...value.split(',').map(s=>s.trim()).filter(Boolean));
  else if(name==='command')options.command=value;
  else if(name==='restrict')options.restrict=true;
  else if(name==='permitopen'&&value)options.permitOpen.push(value);
  else options.flags.push(value==null?name:`${name}=${value}`);
 }
 return {type,fingerprint,comment:clean(comment,200),options};
}

// "256 SHA256:abc comment words (ED25519)" from ssh-keygen -l.
export function parseKeygenLine(line){
 const m=/^(\d+)\s+(SHA256:[A-Za-z0-9+/]+)\s*(.*?)\s*\(([A-Z0-9-]+)\)\s*$/.exec(clean(line,600));
 if(!m)return null;
 const comment=m[3]==='no comment'?'':m[3];
 return {bits:Number(m[1]),fingerprint:m[2],comment,type:m[4]};
}
