// A verified recovery graph. Multi-root replacement is journalled, never described as globally atomic.
import {existsSync,lstatSync,statSync,realpathSync,readFileSync,readlinkSync,readdirSync,mkdirSync,mkdtempSync,rmSync,cpSync,renameSync,openSync,readSync,closeSync,chmodSync,fsyncSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {writeArchive,extractArchive,ARCHIVE_LIMITS} from './release-archive.mjs';
import {sha256,strictJson,durableWrite,within,syncDirectory} from './release-trust.mjs';
import {writeUpdateJournal} from './update-journal.mjs';
export const BACKUP_SCHEMA=1;
const exists=p=>{try{lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export function canonical(p){p=path.resolve(p);if(exists(p))return realpathSync(p);return path.join(canonical(path.dirname(p)),path.basename(p));}
export function fileHash(file){const h=createHash('sha256'),fd=openSync(file,'r'),buffer=Buffer.alloc(65536);try{let n;while((n=readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));}finally{closeSync(fd);}return h.digest('hex');}
export function backupPlan(inst){
 const p=inst.paths,env=inst.env,required=[p.data,p.state,p.private,p.config,...(inst.home?[path.join(inst.home,'instance.json')]:[]),p.siteConfig,p.softwareWatch,p.authFile,
  env.HOME_HUB_SECRET_KEY_FILE||path.join(path.dirname(p.authFile),'secret.key'),env.INTEGRATION_SECRETS_FILE,env.GITHUB_TOKEN_FILE,env.TLS_KEY,env.TLS_CERT,...(inst.backupRoots??[])].filter(Boolean).map(p=>path.resolve(p));
 const candidates=[...new Set(required)].map(logical=>({logical,canonical:canonical(logical),existed:exists(logical),link:exists(logical)&&lstatSync(logical).isSymbolicLink()?readlinkSync(logical):null}));
 for(const e of candidates)if(e.canonical===path.parse(e.canonical).root)throw new Error('refusing filesystem-root backup');
 const roots=[];for(const e of candidates){const parent=candidates.find(o=>o!==e&&o.canonical!==e.canonical&&(o.existed?statSync(o.canonical).isDirectory():[p.data,p.state,p.private,p.config].map(p=>canonical(p)).includes(o.canonical))&&within(e.canonical,o.canonical));if(parent)continue;const same=roots.find(o=>o.canonical===e.canonical);if(same){same.aliases.push({logical:e.logical,link:e.link});continue;}roots.push({...e,aliases:[]});}
 for(const [i,e] of roots.entries()){
  e.id=`root-${String(i+1).padStart(4,'0')}`;e.name=path.basename(e.logical);e.parent=path.dirname(e.logical);
  for(const protectedPath of [inst.backups,inst.files.journal,inst.files.lock,inst.staging,inst.trustFile].filter(Boolean))if(within(canonical(protectedPath),e.canonical))throw new Error(`The backup/recovery path ${protectedPath} is inside ${e.logical}, which is archived. Choose external backup/staging/trust paths.`);
 }
 for(const c of candidates.filter(c=>c.link!==null)){const root=roots.find(r=>within(c.canonical,r.canonical));if(root&&root.logical!==c.logical&&!root.aliases.some(a=>a.logical===c.logical))root.aliases.push({logical:c.logical,link:c.link,canonical:c.canonical});}
 const covered=target=>roots.some(e=>e.existed&&(target===e.canonical||(statSync(e.canonical).isDirectory()&&within(target,e.canonical))));
 const inspect=dir=>{const st=lstatSync(dir);if(st.isSymbolicLink()){let real;try{real=realpathSync(dir);}catch{throw new Error(`dangling or looping backup link: ${dir}`);}if(!covered(real))throw new Error(`uncovered escaping backup link: ${dir} → ${real}; add --backup-root for the target`);return;}if(st.isDirectory())for(const name of readdirSync(dir))inspect(path.join(dir,name));else if(!st.isFile())throw new Error(`unsupported backup special file: ${dir}`);else if(st.nlink>1)throw new Error(`unsupported hard-linked backup file: ${dir}; use an independently verified backup procedure`);};
 for(const e of roots)if(e.existed)inspect(e.canonical);
 return {roots,prerequisites:[...(env.HOME_HUB_SECRET_KEY?['HOME_HUB_SECRET_KEY from the service secret store']:[]),...(env.HOME_HUB_SECRET_KEYCHAIN==='1'?['macOS login Keychain secret-key']:[])],exclusions:[],limitations:['Arbitrary plugin-managed external state requires explicit --backup-root coverage. All external writers must be stopped by the configured service adapter.']};
}
function inventory(roots){const files=[];let bytes=0;const walk=(source,name)=>{
 const st=lstatSync(source),mode=st.mode&0o777;if(st.mode&0o7000)throw new Error(`unsupported backup special mode: ${source}`);
 const type=st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':st.isFile()?'file':null;if(!type)throw new Error(`unsupported backup type: ${source}`);
 if(files.length>=ARCHIVE_LIMITS.entries||(type==='file'&&(st.size>ARCHIVE_LIMITS.file||(bytes+=st.size)>ARCHIVE_LIMITS.expanded)))throw new Error('backup exceeds local archive limits; relocate or use an independently verified backup procedure');
 const entry={path:name,type,mode,bytes:type==='file'?st.size:0,sha256:type==='file'?fileHash(source):null,...(type==='symlink'?{link:readlinkSync(source)}:{})};files.push({...entry,source});
 if(type==='directory')for(const child of readdirSync(source).sort())walk(path.join(source,child),name+'/'+child);
 };for(const e of roots)if(e.existed)walk(e.canonical,e.id);return files;
}
export async function createBackup(inst,ctx,name,{plan=backupPlan(inst)}={}){
 mkdirSync(inst.backups,{recursive:true,mode:0o700});const file=path.join(inst.backups,name+'.tgz');if(exists(file))throw new Error(`archive already exists: ${file}`);
 const temp=file+'.'+randomUUID()+'.tmp',scratch=mkdtempSync(path.join(inst.backups,'.verify-'));
 try{
  const files=inventory(plan.roots),manifest={schemaVersion:BACKUP_SCHEMA,roots:plan.roots,files:files.map(({source,...e})=>e),prerequisites:plan.prerequisites,exclusions:plan.exclusions,limitations:plan.limitations};
  await writeArchive(temp,files,{release:false});await extractArchive(temp,scratch,{release:false,expected:new Map(manifest.files.map(f=>[f.path,f]))});
  // Re-inventory extracted bytes, modes, symlinks and coverage, rather than accepting a tar name listing.
  const restored=inventory(plan.roots.filter(e=>e.existed).map(e=>({...e,canonical:path.join(scratch,e.id)}))).map(({source,...e})=>e);
  if(JSON.stringify(restored)!==JSON.stringify(manifest.files))throw new Error('staged backup restore does not match inventory');
  const bytes=Buffer.from(JSON.stringify(manifest,null,1)+'\n'),integrity={schemaVersion:1,archiveSha256:fileHash(temp),archiveBytes:lstatSync(temp).size,manifestSha256:sha256(bytes)};
  const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);} // built-in only; no switched code
  durableWrite(file+'.manifest.json',bytes);durableWrite(file+'.integrity.json',JSON.stringify(integrity)+'\n');renameSync(temp,file);syncDirectory(inst.backups);
  return {file,manifest:file+'.manifest.json',integrity:file+'.integrity.json',entries:plan.roots,bytes:integrity.archiveBytes,files:manifest.files.length,verified:true};
 }finally{rmSync(temp,{force:true});rmSync(scratch,{recursive:true,force:true});}
}
function validateRoots(inst,roots,progress=[]){
 for(const e of roots){if(!e||!/^root-\d{4}$/.test(e.id)||!path.isAbsolute(e.canonical)||e.canonical===path.parse(e.canonical).root||!path.isAbsolute(e.logical))throw new Error('invalid backup root roles');
  if(canonical(path.dirname(e.canonical))!==path.dirname(e.canonical)||(exists(e.canonical)&&lstatSync(e.canonical).isSymbolicLink()))throw new Error('restore destination topology changed');
  // The live target can be temporarily absent after a journalled rename. Resolve the
  // link text without following the dangling link only for that recorded transition.
  const pending=progress.find(p=>p.id===e.id&&p.live===e.canonical&&['moving-old','old-moved','installing'].includes(p.status)&&exists(p.aside)&&!exists(p.live));
  const linkMatches=(logical,link,target)=>{if(!exists(logical)||!lstatSync(logical).isSymbolicLink()||readlinkSync(logical)!==link)return false;try{return canonical(logical)===target;}catch(err){if(!pending||err.code!=='ENOENT')throw err;return canonical(path.resolve(path.dirname(logical),link))===target;}};
  for(const alias of e.aliases??[])if(alias.link!==null&&!linkMatches(alias.logical,alias.link,alias.canonical??e.canonical))throw new Error('restore alias topology changed');
  for(const protectedPath of [inst.backups,inst.files.journal,inst.files.lock,inst.trustFile,inst.driver].filter(Boolean))if(within(canonical(protectedPath),e.canonical))throw new Error('restore would replace recovery metadata or trust');
  if(e.link!==null&&e.link!==undefined&&!linkMatches(e.logical,e.link,e.canonical))throw new Error('top-level symlink topology changed; manual recovery required');
 }
 for(let i=0;i<roots.length;i++)for(let j=0;j<i;j++)if(within(roots[i].canonical,roots[j].canonical)||within(roots[j].canonical,roots[i].canonical))throw new Error('overlapping restore roots');
}
export async function restoreBackup(inst,ctx,backup,journal=null){
 if(!exists(backup.file))throw new Error(`the archive ${backup.file} is gone`);let manifest,legacy=false;
 if(backup.manifest&&backup.integrity){const bytes=readFileSync(backup.manifest),integrity=strictJson(readFileSync(backup.integrity));if(integrity.schemaVersion!==1||sha256(bytes)!==integrity.manifestSha256||lstatSync(backup.file).size!==integrity.archiveBytes||fileHash(backup.file)!==integrity.archiveSha256)throw new Error('backup integrity mismatch');manifest=strictJson(bytes);if(manifest.schemaVersion!==BACKUP_SCHEMA||!Array.isArray(manifest.files)||!Array.isArray(manifest.roots))throw new Error('unsupported backup manifest');}
 else{legacy=true;ctx.log('  LEGACY archive: no integrity provenance; strict staged inspection required');manifest={roots:backup.entries.map((e,i)=>({id:`root-${String(i+1).padStart(4,'0')}`,logical:path.join(e.parent,e.name),canonical:canonical(path.join(e.parent,e.name)),link:null,existed:true,legacyName:e.name})),files:null};}
 if(journal?.driver)inst={...inst,driver:journal.driver};
 if(journal?.restoreRoots){const ids=new Set();for(const p of journal.restoreRoots){const r=manifest.roots.find(r=>r.id===p.id);if(!r||ids.has(p.id)||p.live!==r.canonical||!p.aside.startsWith(p.live+'.failed-')||!path.basename(p.stageDir).startsWith('.hub-restore-')||p.staged!==path.join(p.stageDir,'root')||p.existed!==r.existed)throw new Error('restore progress does not match authenticated backup root roles');ids.add(p.id);}}
 validateRoots(inst,manifest.roots,journal?.restoreRoots);
 const scratch=mkdtempSync(path.join(inst.backups,'.restore-'));const save=()=>{if(journal)writeUpdateJournal(inst.files.journal,journal);};
 try{
  const entries=await extractArchive(backup.file,scratch,{release:false,legacy,expected:manifest.files?new Map(manifest.files.map(f=>[f.path,f])):null});
  if(legacy){const names=new Set(manifest.roots.map(r=>r.legacyName));if(entries.some(e=>!names.has(e.path.split('/')[0])))throw new Error('legacy archive has unplanned roots');}
  // Inspect link destinations as archive data, never by traversing a staged link into the live filesystem.
  for(const e of entries.filter(e=>e.type==='symlink')){const r=manifest.roots.find(r=>e.path===(r.legacyName??r.id)||e.path.startsWith((r.legacyName??r.id)+'/'));if(!r)throw new Error('unmapped backup symlink');const relative=path.relative(r.legacyName??r.id,e.path),target=path.resolve(path.dirname(path.join(r.canonical,relative)),e.link);if(!manifest.roots.some(o=>o.existed&&within(target,o.canonical)))throw new Error('uncovered restore link target');}
  const aside=journal?.failedState??path.join(inst.backups,`failed-${new Date(ctx.now()).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)}`);
  if(journal){journal.failedState=aside;journal.restoreRoots??=[];save();}
  const progress=journal?.restoreRoots??[];
  // Prepare every root on its destination filesystem before the first live rename.
  for(const r of manifest.roots){if(progress.some(p=>p.id===r.id))continue;const parent=path.dirname(r.canonical);mkdirSync(parent,{recursive:true,mode:0o700});const stageDir=mkdtempSync(path.join(parent,'.hub-restore-')),staged=path.join(stageDir,'root');
   if(r.existed){const from=path.join(scratch,r.legacyName??r.id);if(!exists(from))throw new Error(`missing archive root: ${r.id}`);cpSync(from,staged,{recursive:true,dereference:false,preserveTimestamps:true,verbatimSymlinks:true});}
   progress.push({id:r.id,live:r.canonical,staged,stageDir,aside:r.canonical+'.failed-'+randomUUID(),existed:r.existed,status:'prepared'});save();
  }
  if(manifest.files){for(const p of progress.filter(p=>p.status==='prepared'&&p.existed)){const staged=inventory([{id:p.id,existed:true,canonical:p.staged}]).map(({source,...e})=>e),expected=manifest.files.filter(f=>f.path===p.id||f.path.startsWith(p.id+'/'));if(JSON.stringify(staged)!==JSON.stringify(expected))throw new Error('destination staging validation failed');}}
  validateRoots(inst,manifest.roots,progress);
  for(const p of progress){if(p.status==='installed')continue;
   if(p.status==='installing'&&!exists(p.staged)&&exists(p.live)){p.status='installed';save();continue;}
   if(p.status==='prepared'||p.status==='moving-old'){p.status='moving-old';save();if(exists(p.live)){if(exists(p.aside))throw new Error('ambiguous partial restore: both live and failed root exist');renameSync(p.live,p.aside);ctx.checkpoint?.('restore-old-renamed');syncDirectory(path.dirname(p.live));}p.status='old-moved';save();}
   if(p.status==='old-moved'||p.status==='installing'){p.status='installing';save();if(p.existed){renameSync(p.staged,p.live);ctx.checkpoint?.('restore-new-renamed');}syncDirectory(path.dirname(p.live));p.status='installed';save();}
   ctx.log(`  restored ${p.live}; failed state preserved at ${p.aside}`);
  }
  // An index, not a second copy of failed secrets. Adjacent failed roots cannot require cross-device moves.
  mkdirSync(aside,{recursive:true,mode:0o700});durableWrite(path.join(aside,'roots.json'),JSON.stringify(progress.map(({live,aside})=>({live,aside})),null,1)+'\n');
  return aside;
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
