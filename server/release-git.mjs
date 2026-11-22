// Git release-source adapter: hardened/legacy tag verification, scratch worktree staging, switch and rollback.
// Static imports only: the updater may run from the checkout it switches.
import {existsSync,readFileSync,writeFileSync,mkdirSync,rmSync,cpSync,mkdtempSync,realpathSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {authorizedKeys} from './release-trust.mjs';
import {parse,compare} from './semver.mjs';
import {UpdateError} from './update-errors.mjs';
import {recordMutation} from './update-journal.mjs';

const TAG=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const short=commit=>commit?commit.slice(0,7):'?';
const oneLine=(text,max=300)=>String(text??'').replace(/\s+/g,' ').trim().slice(0,max);
const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const readJsonText=text=>{try{return JSON.parse(text);}catch{return null;}};
function packageFacts(p){
 if(!plain(p)||!parse(p.version))return null;
 const epoch=p.homeHub?.dataEpoch;
 return {version:parse(p.version).text,dataEpoch:Number.isSafeInteger(epoch)&&epoch>=1?epoch:1,node:typeof p.engines?.node==='string'?p.engines.node:null};
}

const safeGitEnv=()=>({...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_COUNT:'0'});
const safeGitArgs=dir=>['-C',dir,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','submodule.recurse=false'];
export const git=(ctx,dir,...args)=>{const r=ctx.exec('git',[...safeGitArgs(dir),...args],{env:safeGitEnv()});return r.status===0?r.stdout.trim():null;};
function gitDo(ctx,dir,...args){
 const r=ctx.exec('git',[...safeGitArgs(dir),...args],{env:safeGitEnv()});
 if(r.status!==0)throw new Error(`git ${args.join(' ')} failed in ${dir}: ${oneLine(r.stderr||r.stdout)||`exit ${r.status}`}`);
 return r.stdout.trim();
}

export function inspectSource(ctx,source){
 const top=git(ctx,source.dir,'rev-parse','--show-toplevel');
 let isGit=false;try{isGit=Boolean(top)&&statSync(top).ino===statSync(source.dir).ino;}catch{}
 if(!isGit)return {...source,git:false,commit:null,branch:null,dirty:[],tag:null};
 const commit=git(ctx,source.dir,'rev-parse','HEAD'),branch=git(ctx,source.dir,'symbolic-ref','--short','-q','HEAD')||null;
 const dirty=(git(ctx,source.dir,'status','--porcelain','--untracked-files=no')||'').split('\n').filter(Boolean);
 const tag=(git(ctx,source.dir,'tag','--points-at','HEAD')||'').split('\n').filter(Boolean)[0]||null;
 return {...source,git:true,commit,branch,dirty,tag};
}
export const tagCommit=(ctx,dir,tag)=>git(ctx,dir,'rev-parse','-q','--verify',`refs/tags/${tag}^{commit}`);
export function newestTag(ctx,dir){
 const tags=(git(ctx,dir,'tag','--list','v*')||'').split('\n').map(t=>t.trim()).filter(t=>{const v=parse(t.slice(1));return t.startsWith('v')&&v&&!v.prerelease.length;});
 return tags.sort((a,b)=>compare(a.slice(1),b.slice(1))).at(-1)||null;
}
// Files that are not tracked here but are tracked in the target: git would refuse the checkout over them.
function collisions(ctx,dir,commit){
 const untracked=(git(ctx,dir,'ls-files','--others','--exclude-standard')||'').split('\n').filter(Boolean);if(!untracked.length)return [];
 const there=new Set((git(ctx,dir,'ls-tree','-r','--name-only',commit)||'').split('\n'));
 return untracked.filter(f=>there.has(f));
}
function switchTo(ctx,change,commit,{force=false,branch=null}={}){
 // Back onto the branch it was on when that branch still names the same commit; otherwise detached at the commit.
 if(branch&&git(ctx,change.dir,'rev-parse','-q','--verify',`refs/heads/${branch}^{commit}`)===commit)return gitDo(ctx,change.dir,'checkout','--quiet','--no-overwrite-ignore',...(force?['--force']:[]),branch);
 return gitDo(ctx,change.dir,'checkout','--quiet','--no-overwrite-ignore','--detach',...(force?['--force']:[]),commit);
}

function verifyGitChange(ctx,c,trust,{repository,allowUnsigned,lines}){
 const hit=collisions(ctx,c.dir,c.to);
 if(hit.length)throw new UpdateError(`${c.dir} has untracked file(s) that ${c.tag} also contains; git would refuse the switch:\n${hit.slice(0,10).join('\n')}`);
 c.tagObject=git(ctx,c.dir,'rev-parse',`refs/tags/${c.tag}`);
 if(trust){
  const raw=readJson(path.join(c.dir,'package.json')),repo=c.id==='core'?repository:raw?.homeHub?.publisher;
  if(!repo)throw new UpdateError(`${c.id}: no publisher repository identity configured`);
  if(git(ctx,c.dir,'config','--get-regexp','^filter\\.')||git(ctx,c.dir,'config','--get','core.attributesFile'))throw new UpdateError('Hardened Git refuses configured checkout filters and external attributes');
  const info=git(ctx,c.dir,'rev-parse','--git-path','info/attributes'),grafts=git(ctx,c.dir,'rev-parse','--git-path','info/grafts');
  for(const file of [info,grafts].filter(Boolean)){const resolved=path.resolve(c.dir,file);if(existsSync(resolved)&&readFileSync(resolved,'utf8').trim())throw new UpdateError('Hardened Git refuses local attributes and grafts');}
  if(git(ctx,c.dir,'cat-file','-t',c.tagObject)!=='tag')throw new UpdateError('Hardened Git updates require an annotated signed tag');
  const keys=authorizedKeys(trust,repo,'git',c.tag.slice(1));
  if(!keys.length)throw new UpdateError(`${c.id}: no authorized Git signers for ${repo}`);
  const signerDir=mkdtempSync(path.join(os.tmpdir(),'hub-signers-')),signerFile=path.join(signerDir,'allowed');
  try{
   writeFileSync(signerFile,keys.map(k=>`release namespaces="git" ${k.publicKey.trim()}`).join('\n')+'\n',{mode:0o600});
   const r=ctx.exec('git',[...safeGitArgs(c.dir),'-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen','-c',`gpg.ssh.allowedSignersFile=${signerFile}`,'verify-tag',c.tagObject],{env:safeGitEnv()});
   if(r.status!==0)throw new UpdateError(`${c.id}: configured trust verification FAILED: ${oneLine(r.stderr)}. Legacy fallback is forbidden.`);
  }finally{rmSync(signerDir,{recursive:true,force:true});}
  const tree=gitDo(ctx,c.dir,'ls-tree','-r',c.to).split('\n');
  if(tree.some(l=>!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(l)))throw new UpdateError('Hardened Git refuses symlinks, submodules and special tree entries');
  const attrs=tree.filter(l=>l.endsWith('.gitattributes')).map(l=>l.split('\t')[1]);
  if(attrs.some(f=>/filter\s*=/.test(gitDo(ctx,c.dir,'show',`${c.to}:${f}`))))throw new UpdateError('Hardened Git refuses filter/LFS-dependent payloads');
  lines.push(`${c.id}: verified exact tag ${c.tagObject} → ${c.to} with operator trust`);
  c.verification='verified';
  return;
 }
 lines.push(`${c.id}: LEGACY Git verification policy (deprecated); use --trust for independently configured trust`);
 // Retained legacy policy; never reached after a configured trust failure.
 const signers=path.join(c.dir,'config','release-signers');
 if(existsSync(signers)&&readFileSync(signers,'utf8').trim()){
  const r=ctx.exec('git',['-C',c.dir,'-c','gpg.format=ssh','-c',`gpg.ssh.allowedSignersFile=${signers}`,'verify-tag',c.tag]);
  if(r.status===0)lines.push(`${c.id}: the signature of ${c.tag} is good (config/release-signers)`);
  else if(allowUnsigned)lines.push(`${c.id}: WARNING: ${c.tag} has no good signature; accepted because of --allow-unsigned`);
  else throw new UpdateError(`${c.id}: ${c.tag} has no good signature by a key in ${signers}: ${oneLine(r.stderr)||'verify-tag failed'}\n--allow-unsigned accepts it anyway.`);
 }else lines.push(`${c.id}: ${c.tag} is legacy-unverified: not checked for a signature (no config/release-signers in the installed checkout)`);
}

export const gitReleaseSource=Object.freeze({
 kind:'git',

 async stageTarget(inst,request,ctx,trust,{installed,live,repository,checkBackup}={}){
  const say=line=>ctx.log(line);
  const core=live[0];
  if(!core.git)throw new UpdateError(`${core.dir} is not a git checkout: there is nothing to switch. (A container image is rebuilt instead: docs/docker.md.)`);
  const coverage=checkBackup?.({})??null;
  // 1. what is asked for
  const wanted=new Map();
  for(const [name,tag] of Object.entries(request.plugins||{})){
   const targets=name==='*'?live.filter(s=>s.kind==='plugins'):live.filter(s=>s.kind==='plugins'&&s.id===name);
   if(name==='*'&&targets.length!==1)throw new UpdateError(targets.length?`There are ${targets.length} plugin sources (${targets.map(s=>s.id).join(', ')}): say which, as --plugins <source>=<tag>.`:'--plugins: this instance has no plugin source outside the core checkout.');
   if(!targets.length)throw new UpdateError(`--plugins ${name}=…: there is no plugin source "${name}" (there ${live.length>1?'is '+live.slice(1).map(s=>s.id).join(', '):'are none'}).`);
   if(!TAG.test(tag))throw new UpdateError(`"${tag}" is not a tag name.`);
   wanted.set(targets[0].id,tag);
  }
  const coreAsked=request.core??null;
  if(coreAsked!==null&&!(coreAsked.startsWith('v')&&parse(coreAsked.slice(1))))throw new UpdateError(`"${coreAsked}" is not a release tag. Releases are tagged v<version>, such as v${installed.version}.`);
  for(const s of live)if((s.id==='core'||wanted.has(s.id))&&s.git&&s.dirty.length)throw new UpdateError(`${s.dir} has uncommitted changes to tracked files; an update would have to discard them:\n${s.dirty.slice(0,10).join('\n')}`);
  // 2. the tags
  for(const s of live){
   if(!s.git||!(s.id==='core'?coreAsked!==null||!wanted.size:wanted.has(s.id)))continue;
   if(request.fetch===false){say(`  ${s.id}: not fetching (--no-fetch); using the tags that are here`);continue;}
   const remotes=(git(ctx,s.dir,'remote')||'').split('\n').filter(Boolean),remote=remotes.includes('origin')?'origin':remotes[0];
   if(!remote){say(`  ${s.id}: no remote; using the tags that are here`);continue;}
   const r=ctx.exec('git',[...safeGitArgs(s.dir),'fetch','--tags','--quiet',remote],{env:safeGitEnv(),timeoutMs:120000});
   if(r.status!==0)throw new UpdateError(`git fetch --tags ${remote} failed in ${s.dir}: ${oneLine(r.stderr)||`exit ${r.status}`}\nWith --no-fetch the tags already here are used.`);
   say(`  ${s.id}: fetched tags from ${remote}`);
  }
  // 3. the targets
  const changes=[],lines=[];
  const coreTag=coreAsked??(wanted.size?null:newestTag(ctx,core.dir));
  let target=installed,targetCommit=core.commit;
  if(coreTag){
   const commit=tagCommit(ctx,core.dir,coreTag);
   if(!commit)throw new UpdateError(`There is no tag ${coreTag} in ${core.dir}${request.fetch===false?' (nothing was fetched)':''}.`);
   const there=packageFacts(readJsonText(git(ctx,core.dir,'show',`${commit}:package.json`)));
   if(!there)throw new UpdateError(`${coreTag} has no package.json with a version.`);
   if(there.version!==parse(coreTag.slice(1)).text)throw new UpdateError(`${coreTag} is not what it says: its package.json reads ${there.version}.`);
   if(commit!==core.commit){target=there;targetCommit=commit;changes.push({id:'core',dir:core.dir,from:core.commit,to:commit,tag:coreTag,branch:core.branch});}
   else if(coreAsked===null&&!wanted.size)throw new UpdateError(`Nothing to do: ${installed.version} (${coreTag}) is the newest release tag in ${core.dir}.`);
   else if(!wanted.size)throw new UpdateError(`Nothing to do: ${core.dir} is already on ${coreTag}.`);
  }else if(!wanted.size)throw new UpdateError(`Nothing to do: ${core.dir} has no release tag. Name one: apply v<version>.`);
  for(const [id,tag] of wanted){
   const s=live.find(x=>x.id===id);
   if(!s.git)throw new UpdateError(`The plugin source ${s.dir} is not a git checkout; it cannot be switched to ${tag}.`);
   const commit=tagCommit(ctx,s.dir,tag);
   if(!commit)throw new UpdateError(`There is no tag ${tag} in ${s.dir}.`);
   const now=parse(readJson(path.join(s.dir,'package.json'))?.version),then=parse(readJsonText(git(ctx,s.dir,'show',`${commit}:package.json`))?.version);
   if(now&&then&&compare(then,now)<0)throw new UpdateError(`${s.id} ${tag} is ${then.text}, lower than what is installed (${now.text}).`);
   if(commit!==s.commit||s.added)changes.push({id,dir:s.dir,from:s.commit,to:commit,tag,branch:s.branch,...(s.added?{added:true}:{})});
  }
  if(!changes.length)throw new UpdateError('Nothing to do: every source is already on what was asked for.');
  for(const c of changes)verifyGitChange(ctx,c,trust,{repository,allowUnsigned:Boolean(request.allowUnsigned),lines});
  // 4. the target, staged in scratch worktrees
  mkdirSync(inst.staging,{recursive:true});
  // The real path: the server compares its own file with argv[1], and a temp directory is often behind a link.
  const staging=realpathSync(mkdtempSync(path.join(inst.staging,'home-hub-update-'))),place=s=>path.join(staging,s.id),added=[];
  const cleanup=()=>{
   for(const s of added)ctx.exec('git',['-C',s.dir,'worktree','remove','--force',place(s)]);
   rmSync(staging,{recursive:true,force:true});
   for(const s of added)ctx.exec('git',['-C',s.dir,'worktree','prune']);
  };
  try{
   for(const s of live){
    const to=changes.find(c=>c.id===s.id)?.to??s.commit;
    if(s.git){gitDo(ctx,s.dir,'worktree','add','--detach','--quiet',place(s),to);added.push(s);}
    else cpSync(s.dir,place(s),{recursive:true,filter:from=>!['.git','node_modules'].includes(path.basename(from))});
   }
   const stagedCore=place(core);
   // Plugins that live in the checkout without being tracked there (a site's own local/plugins) are copied in.
   let copied=false;
   for(const rel of core.plugins)if(!existsSync(path.join(stagedCore,rel))){cpSync(path.join(core.dir,rel),path.join(stagedCore,rel),{recursive:true,filter:from=>path.basename(from)!=='node_modules'});copied=true;}
   const modern=existsSync(path.join(stagedCore,'server','runtime-identity.mjs'));
   return {
    kind:'git',
    target,
    targetCommit,
    targetTag:coreTag??core.tag,
    stagedDir:stagedCore,
    stagingRoot:staging,
    place,
    stagedPluginDirs:live.flatMap(s=>s.plugins.map(rel=>({source:s,rel,dir:path.join(place(s),rel)}))),
    copiedLocalPlugins:copied,
    changes,
    hasChange:changes.length>0,
    coverage,
    quarantineKeys:changes.some(c=>c.id==='core')?['git-'+targetCommit]:[],
    strictPlugins:false,
    requireCheck:false,
    modern,
    packageDigest:null,
    lines,
    journalFields:{},
    keepStageOnSuccess:false,
    describe:()=>`${target.version} @ ${short(targetCommit)}`,
    finalizeStage:()=>{
     if(modern){
      for(const source of live.filter(s=>s.kind==='plugins'&&changes.some(c=>c.id===s.id))){
       const extra=(git(ctx,source.dir,'ls-files','--others')??'').split('\n').filter(p=>p&&!p.startsWith('node_modules/'));
       if(extra.length)throw new UpdateError(`Modern plugin-source identity requires a reproducible tracked tree: ${source.dir} has untracked/ignored content. Move external resources outside the source before updating it.`);
      }
      return [];
     }
     return ['readiness: reduced assurance for legacy target; sustained version/process/plugin checks for 10 seconds'];
    },
    cleanupWorkspace:cleanup,
    cleanup,
   };
  }catch(e){
   cleanup();
   throw e;
  }
 },

 verifyPreSwitch(inst,plan,ctx){
  for(const c of plan.changes){
   if(git(ctx,c.dir,'rev-parse','HEAD')!==c.from||tagCommit(ctx,c.dir,c.tag)!==c.to||git(ctx,c.dir,'rev-parse',`refs/tags/${c.tag}`)!==c.tagObject||inspectSource(ctx,c).dirty.length)
    throw new UpdateError('Source or target changed since preflight; refusing before stop');
  }
 },

 applySwitch(inst,journal,plan,ctx){
  for(const c of plan.changes){
   ctx.log(`  ${c.id}: ${short(c.from)} → ${c.tag} (${short(c.to)}), detached`);
   recordMutation(inst,journal,'source-switch',{source:c.id,from:c.from,to:c.to},()=>switchTo(ctx,c,c.to));
  }
 },

 verifyRollbackPreStop(){},

 hasMoved(inst,journal,ctx){
  return journal.changes.some(c=>git(ctx,c.dir,'rev-parse','HEAD')!==c.from);
 },

 verifyRollbackTarget(inst,journal,ctx){
  const moved=journal.changes.filter(c=>git(ctx,c.dir,'rev-parse','HEAD')!==c.to);
  if(moved.length)throw new UpdateError(`${moved.map(c=>c.dir).join(', ')} is no longer on what the last update installed (${journal.to.label}); "rollback" only undoes that update.`);
 },

 rollbackSwitch(inst,journal,ctx){
  for(const c of journal.changes){
   const current=git(ctx,c.dir,'rev-parse','HEAD');
   if(current!==c.from||c.branch){
    ctx.log(`  ${c.id}: back to ${short(c.from)}${c.branch?` (${c.branch})`:''}`);
    if(inspectSource(ctx,c).dirty.length)throw new Error(`Unrelated tracked edits in ${c.dir}; refusing forced rollback`);
    if(current!==c.from&&current!==c.to)throw new Error(`Unexpected source identity in ${c.dir}; manual recovery required`);
    recordMutation(inst,journal,'source-restore',{source:c.id,from:current,to:c.from},()=>switchTo(ctx,c,c.from,{branch:c.branch}));
   }
  }
 },

 quarantineKeys(journal){
  return journal.changes.some(c=>c.id==='core')?['git-'+journal.to.core.commit]:[];
 },

 failedPath(){return null;},
});
