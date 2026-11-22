// Stable source identities. Only these identifiers can generate an in-hub link.
const ids={
 machine:/^[a-z][a-z0-9_-]{1,31}$/, project:/^[a-z][a-z0-9-]{1,39}$/,
 ticket:/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$/, epic:/^[A-Z][A-Z0-9]{1,9}-E[1-9][0-9]{0,5}$/,
 wiki:/^[a-z][a-z0-9-]{1,39}\/w[a-z2-7]{11}$/,
 model:/^m[a-f0-9]{32}$/, custom:/^r[a-f0-9]{32}$/,
};
export const referenceKinds=Object.freeze(Object.keys(ids));
export const validReference=(kind,id)=>typeof kind==='string'&&Object.hasOwn(ids,kind)&&typeof id==='string'&&ids[kind].test(id);
export const referenceKey=({kind,id})=>kind+'/'+id;
export const validLabel=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200&&value.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(value);
export function referenceHref(kind,id){
 if(!validReference(kind,id))return null;
 if(kind==='machine')return '#host-'+id;
 const routes={wiki:'wiki',ticket:'items',epic:'epics',project:'projects'};
 return '#'+(routes[kind]??'references/'+kind)+'/'+id;
}
export function referenceToken({kind,id,label}){
 if(!validReference(kind,id)||!validLabel(label))throw new Error('invalid');
 return '@['+label.replace(/[\\\[\]]/g,'\\$&')+'](ref:'+kind+'/'+id+')';
}
