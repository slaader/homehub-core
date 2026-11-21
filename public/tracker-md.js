import {el} from './views.js';
import {parseMarkdown} from './tracker-markdown-format.js';
import {referenceChip} from './reference-chip.js';
export {FILE_TOKEN} from './tracker-markdown-format.js';

export function markdown(text,options={}){
 return parseMarkdown(text,{...options,el,mention:options.references?(ref,_line,_token,legacy)=>legacy?null:referenceChip(ref):null});
}
