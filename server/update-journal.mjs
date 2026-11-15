// Schema 1 is read explicitly. Corrupt and future journals are evidence, never absence.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {strictJson,durableWrite} from './release-trust.mjs';
import {parseService,parseHealth} from './update-config.mjs';
import {UpdateError} from './update-errors.mjs';
export const JOURNAL_SCHEMA=2;
export const TERMINAL_STEPS=Object.freeze(['done','rolled-back','aborted']);
const STEPS=[...TERMINAL_STEPS,'stopping','backup','backup-verified','switching','switched','starting','target-may-have-written','rolling-back','rollback-failed'];
const absolute=p=>typeof p==='string'&&path.isAbsolute(p)&&!p.includes('\0')&&path.resolve(p)!==path.parse(p).root;
const hash=v=>typeof v==='string'&&/^[0-9a-f]{40}$/.test(v);
export function validateJournal(j){
 if(!j||typeof j!=='object'||![1,JOURNAL_SCHEMA].includes(j.schemaVersion))throw new Error('unsupported/newer journal schema');
 const keys=['schemaVersion','id','startedAt','finishedAt','by','from','to','changes','epochRose','settings','step','started','backup','failure','stopRefused','quarantine','undoFrom','restored','failedState','rollbackError','site','instance','operations','targetMayHaveWritten','restoreRoots','package','driver','kind','previous'];if(Object.keys(j).some(k=>!keys.includes(k)))throw new Error('unknown journal field');
 if(j.undoFrom!==undefined&&!STEPS.includes(j.undoFrom))throw new Error('invalid rollback origin');
 if(j.operations!==undefined&&(!Array.isArray(j.operations)||j.operations.length>100000||j.operations.some(o=>!/^op-\d+$/.test(o.id)||!['source-switch','source-restore'].includes(o.kind)||!['intent','complete'].includes(o.status))))throw new Error('invalid journal operations');
 if(j.restoreRoots!==undefined&&(!Array.isArray(j.restoreRoots)||j.restoreRoots.length>20000||j.restoreRoots.some(r=>![r.live,r.aside,r.staged,r.stageDir].every(absolute)||path.dirname(r.live)!==path.dirname(r.aside)||path.dirname(r.stageDir)!==path.dirname(r.live)||path.dirname(r.staged)!==r.stageDir||!['prepared','moving-old','old-moved','installing','installed'].includes(r.status))))throw new Error('invalid restore path roles or state');
 if(!STEPS.includes(j.step)||typeof j.id!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(j.id)||!Number.isFinite(Date.parse(j.startedAt)))throw new Error('invalid journal state or operation ID');
 for(const side of ['from','to'])if(!j[side]||typeof j[side].label!=='string'||typeof j[side].core?.version!=='string'||typeof j[side].expect?.version!=='string')throw new Error(`invalid journal ${side}`);
 if(!Array.isArray(j.changes)||j.changes.length>32||typeof j.epochRose!=='boolean')throw new Error('invalid source changes');
 for(const c of j.changes)if(!absolute(c.dir)||typeof c.id!=='string'||!hash(c.from)||!hash(c.to))throw new Error('invalid source switch path/identity');
 if(!j.settings||!absolute(j.settings.root)||!absolute(j.settings.state))throw new Error('invalid journal path roles');
 parseService(j.settings.service);parseHealth(j.settings.health);
 for(const name of ['site','instance'])if(j[name]){const s=j[name];if(!absolute(s.file)||!(s.backup===null||absolute(s.backup))||!['prepared','applying','applied','restored'].includes(s.status)||!(s.baseHash===null||/^[0-9a-f]{64}$/.test(s.baseHash)))throw new Error(`invalid ${name} recovery plan`);}
 if(j.backup&&(!absolute(j.backup.file)||!Array.isArray(j.backup.entries)))throw new Error('invalid archive recovery plan');
 if(j.package){const p=j.package;if(!['prepared','moving-old','old-moved','installing','installed','moving-failed','restoring','restored'].includes(p.status))throw new Error('invalid package state');if(![p.live,p.old,p.staged].every(absolute)||p.live!==j.settings.root||new Set([p.live,p.old,p.staged]).size!==3||[p.old,p.staged].some(v=>path.dirname(v)!==path.dirname(p.live)))throw new Error('invalid package replacement roles');}
 return j;
}
export function readUpdateJournal(file){
 let bytes;try{bytes=readFileSync(file);}catch(e){if(e.code==='ENOENT')return null;throw new UpdateError(`Cannot read update journal ${file}: ${e.message}`);}
 try{return validateJournal(strictJson(bytes,{limit:16*1024*1024}));}catch(e){throw new UpdateError(`Update journal ${file} is corrupt or newer: ${e.message}. Preserve it and recover manually; mutation refused.`);}
}
export const writeUpdateJournal=(file,journal)=>{if(journal.schemaVersion===1)journal.schemaVersion=JOURNAL_SCHEMA;validateJournal(journal);durableWrite(file,JSON.stringify(journal,null,1)+'\n');};
export const unfinished=journal=>Boolean(journal)&&!TERMINAL_STEPS.includes(journal.step);
export function recordMutation(inst,journal,kind,detail,mutate){
 journal.operations??=[];const op={id:`op-${journal.operations.length+1}`,kind,...detail,status:'intent'};journal.operations.push(op);writeUpdateJournal(inst.files.journal,journal);
 const result=mutate(op);op.status='complete';writeUpdateJournal(inst.files.journal,journal);return result;
}
