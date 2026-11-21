import {validReference,validLabel} from './reference-format.js';
// A file of the ticket, by name. Not a Markdown image: "![alt](url)" is left alone.
export const FILE_TOKEN=/!\[([^\[\]\n]{1,120})\](?!\()/;

const BULLET=/^\s*[-*•]\s+(.*)$/,NUMBER=/^\s*(\d{1,3})[.)]\s+(.*)$/,HEADING=/^(#{1,4})\s+(.*)$/,FENCE=/^\s*```/,QUOTE=/^\s*>\s?(.*)$/;
const isList=line=>BULLET.test(line)||NUMBER.test(line);

// The renderer and the where-used reader use the same block and inline walk.
// Offsets let an editor offer a replacement only for literal, editable text.
export function parseMarkdown(text,{keys=[],cls='tk-md',files=null,mention=null,plain=null,el}={}){
 const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n'),offsets=[],out=[];
 let position=0;
 for(const line of lines){offsets.push(position);position+=line.length+1;}
 const ids=keys.length?new RegExp(`\\b(?:${keys.map(k=>k.replace(/[^A-Z0-9]/g,'')).filter(Boolean).join('|')})-[1-9][0-9]{0,5}\\b`):null;
 const span=(i,part=lines[i],column=0)=>inline(part,{ids,files,mention,plain,el,source:lines[i],column,offset:offsets[i]+column});
 const lineBreaks=parts=>parts.flatMap((nodes,i)=>i?[el('br',{}),...nodes]:nodes);
 const suffix=(i,text)=>span(i,text,lines[i].length-text.length);
 for(let i=0;i<lines.length;){
  const line=lines[i];
  if(!line.trim()){i++;continue;}
  if(FENCE.test(line)){
   const code=[];i++;
   while(i<lines.length&&!FENCE.test(lines[i]))code.push(lines[i++]);
   i++;out.push(el('pre',{class:'tk-md-pre'},el('code',{},code.join('\n'))));continue;
  }
  const h=line.match(HEADING);
  if(h){out.push(el('h4',{class:'tk-md-h'},suffix(i++,h[2])));continue;}
  if(QUOTE.test(line)){
   const q=[];while(i<lines.length&&QUOTE.test(lines[i])){const value=lines[i].match(QUOTE)[1];q.push(suffix(i++,value));}
   out.push(el('blockquote',{class:'tk-md-quote'},lineBreaks(q)));continue;
  }
  if(isList(line)){
   const ordered=NUMBER.test(line),items=[],start=ordered?Number(line.match(NUMBER)[1]):null;
   while(i<lines.length&&(ordered?NUMBER:BULLET).test(lines[i])){
    const m=lines[i].match(ordered?NUMBER:BULLET),item=[suffix(i++,ordered?m[2]:m[1])];
    while(i<lines.length&&/^\s{2,}\S/.test(lines[i])&&!isList(lines[i])){
     const value=lines[i].trim();item.push(span(i,value,lines[i].indexOf(value)));i++;
    }
    items.push(el('li',{},lineBreaks(item)));
   }
   const list=el(ordered?'ol':'ul',{class:'tk-md-list'},items);
   if(ordered&&start>1)list.setAttribute('start',String(start));
   out.push(list);continue;
  }
  const para=[];
  while(i<lines.length&&lines[i].trim()&&!isList(lines[i])&&!FENCE.test(lines[i])&&!HEADING.test(lines[i])&&!QUOTE.test(lines[i]))para.push(i++);
  const last=para.at(-1),label=lines[last].trim();
  if(i<lines.length&&isList(lines[i])&&label.endsWith(':')&&lines[last].length<=80){
   para.pop();if(para.length)out.push(el('p',{},lineBreaks(para.map(n=>span(n)))));
   out.push(el('p',{class:'tk-md-label'},span(last,label.slice(0,-1),lines[last].indexOf(label))));
  }else out.push(el('p',{},lineBreaks(para.map(n=>span(n)))));
 }
 return el('div',{class:cls},out);
}

// Inline: one left-to-right scan; the earliest match wins, bold before italic.
const RULES=[
 ['code',/`([^`\n]+)`/],
 ['bold',/\*\*([^*\n]+?)\*\*/],
 ['italic',/(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/],
 ['link',/https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/],
 ['const',/(?<![\w$])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:\/[A-Z0-9_]+)*(?:_\*)?(?![\w$])/],
 ['path',/(?<![\w/~.])(?:~\/|\/(?:tmp|Users|opt|etc|var|Library|private|Volumes)\/)[^\s,;:'"`()<>]*[^\s,;:'"`()<>.]/],
];
const TOKEN=/(@\[((?:\\[\\\[\]]|[^\[\]\\\n]){1,400})\]\(ref:([a-z]+)\/([a-zA-Z0-9_/-]+)\))/;
const ESCAPE=new RegExp('\\\\'+TOKEN.source);
function inline(text,context){
 const {ids,files,mention,el,source}=context;
 const literal=(from,size)=>context.plain?.(context.offset+from,context.offset+from+size);
 const out=[],rules=[['slashes',/\\\\/],['escape',ESCAPE],['reference',TOKEN],...RULES,...(files?[['file',FILE_TOKEN]]:[]),...(ids?[['ticket',ids]]:[])];let rest=String(text);
 while(rest){
  let best=null;
  for(const [kind,re] of rules){const m=rest.match(re);if(m&&(!best||m.index<best.m.index))best={kind,m};}
  const from=text.length-rest.length;
  if(!best){literal(from,rest.length);out.push(rest);break;}
  const {kind,m}=best;if(m.index){literal(from,m.index);out.push(rest.slice(0,m.index));}
  const column=context.column+from+m.index;
  if(kind==='escape')out.push(m[1]);
  else if(kind==='slashes')out.push(m[0]);
  else if(kind==='reference'){
   const label=m[2].replace(/\\([\\\[\]])/g,'$1'),ref={kind:m[3],id:m[4],label};
   out.push(mention&&validReference(ref.kind,ref.id)&&validLabel(label)?mention(ref,source,m[0],false,column):m[0]);
  }
  else if(kind==='code'||kind==='path'||kind==='const')out.push(el('code',{class:'tk-md-code'},kind==='code'?m[1]:m[0]));
  else if(kind==='bold'||kind==='italic'){
   const inner=from+m.index+(kind==='bold'?2:1);
   out.push(el(kind==='bold'?'strong':'em',{},inline(m[1],{...context,column:context.column+inner,offset:context.offset+inner})));
  }
  else if(kind==='file'){
   // Not a file of this ticket: only the "![" is passed over, so what stands in the brackets is read as before.
   const node=files(m[1]);if(!node){out.push('![');rest=rest.slice(m.index+2);continue;}
   out.push(node);
  }
  else if(kind==='link')out.push(el('a',{href:m[0],target:'_blank',rel:'noopener noreferrer',class:'sys-link'},m[0]));
  else {
   if(source[column-1]==='@')literal(from+m.index-1,m[0].length+1);
   mention?.({kind:'ticket',id:m[0],label:m[0]},source,m[0],true,column);
   out.push(el('a',{href:'#items/'+m[0],class:'tk-md-ticket'},m[0]));
  }
  rest=rest.slice(m.index+m[0].length);
 }
 return out;
}

export function markdownReferences(text,{keys=[],attachmentNames=[]}={}){
 if(!text)return [];
 const found=[],files=new Set(attachmentNames);
 parseMarkdown(text,{keys,files:name=>files.has(name),el:()=>({setAttribute(){}}),mention:(ref,line,token,legacy,index)=>{
  const start=Math.max(0,index-60);
  found.push({...ref,legacy:Boolean(legacy),excerpt:(line.slice(start,index)+ref.label+line.slice(index+token.length)).slice(0,150)});
 }});
 return found;
}

export function editableMarkdownRange(text,start,end,{keys,files}){
 let editable=false;
 parseMarkdown(text,{keys,files,el:()=>({setAttribute(){}}),plain:(from,to)=>{
  if(from<=start&&end<=to)editable=true;
 }});
 return editable;
}
