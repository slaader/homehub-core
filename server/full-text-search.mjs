// Preserve the global search response and ranking, adding attachment-content hits with citations.
export async function fullTextSearch({db,tickets,ticketSearch},input){
 const {mode='text',...query}=input;
 if(!['text','semantic','hybrid'].includes(mode)||mode!=='text'&&input.kind==='review')throw new Error('invalid');
 let available=ticketSearch.status().enabled===true;
 const revision=tickets.searchRevision(),base=db.search(query),limit=Number(input.limit??20);
 if(input.kind==='review'||!/[\p{L}\p{N}_]/u.test(input.q))return {...base,mode,semanticAvailable:available};
 const found=await ticketSearch.search({query:input.q,...(input.project?{project:input.project}:{}),mode,limit:100});
 available=ticketSearch.status().enabled===true;
 if(mode!=='text')base.results=[];
 const results=[...base.results],seen=new Set(results.filter(r=>r.kind==='ticket').map(r=>r.id));
 for(const source of found.results){
  if(seen.has(source.ticket))continue;seen.add(source.ticket);
  const ticket=await tickets.get(source.ticket).catch(()=>null);if(!ticket||source.attachment&&!ticket.attachments.some(a=>a.id===source.attachment))continue;
  results.push({kind:'ticket',id:ticket.id,project:ticket.project,updatedAt:ticket.updatedAt,title:ticket.id+' '+ticket.title,snippet:source.snippet,score:source.score,
   source:source.source,...(source.attachment?{attachment:source.attachment,name:source.name}:{}),meta:{status:ticket.status,type:ticket.type,priority:ticket.priority,assignee:ticket.assignee,release:ticket.release}});
 }
 if(revision!==tickets.searchRevision())return {...(mode==='text'?db.search(query):{q:query.q,total:0,results:[]}),mode,semanticAvailable:available,attachmentSearch:{state:'indexing'}};
 return {...base,total:results.length,results:results.slice(0,limit),mode:found.mode,semanticAvailable:available,attachmentSearch:{state:found.state,extraction:found.extraction??found.coverage?.extraction}};
}
