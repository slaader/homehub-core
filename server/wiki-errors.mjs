const messages={
 invalid:[400,'Neplatný požadavek na wiki.','Invalid wiki request. Check the fields and document format.'],
 'not-found':[404,'Stránka nebo wiki neexistuje.','The page, wiki or attachment does not exist.'],
 conflict:[409,'Stránka se mezitím změnila.','The page changed while you were editing. Read the current revision and reapply your changes.'],
 'request-conflict':[409,'ID požadavku už bylo použito s jinými údaji.','That request ID was used with different arguments. Use a new request ID for a different change.'],
 limit:[409,'Obsah překročil limit wiki.','Reduce the document to 256 KiB and 1,000 blocks. Tables allow 100 rows, 20 columns and 2,000 characters per cell. Groups allow 50 attachments.'],
 'page-limit':[409,'Wiki má maximální počet stránek.','This wiki already has the maximum of 500 pages.'],
 'asset-limit':[409,'Projekt má maximální počet příloh.','This project already has the maximum of 5,000 assets.'],
 'invalid-parent':[400,'Neplatné umístění stránky.','Choose an existing parent in the same project. Home is fixed and a page cannot contain itself.'],
 'invalid-target':[400,'Cíl neexistuje nebo neodpovídá požadavku.','The attachment group, inventory cell or source target is invalid. Read the target and check its IDs.'],
 'selection-too-large':[413,'Vybraný řádek je příliš velký.','Select fewer columns to keep the inventory result within 48 KiB, or use the full page mode.'],
 'invalid-asset':[400,'Příloha není pro tuto stránku dostupná.','Use an asset uploaded or published in this project. Only its owner may attach a private draft asset.'],
 'invalid-media':[400,'Soubor neodpovídá podporovanému formátu náhledu.','The file does not match its preview format. GLB models must embed their resources.'],
 'digest-mismatch':[400,'Otisk souboru neodpovídá zadané hodnotě.','The bytes do not match the declared SHA-256 digest. Start a new upload with the correct file.'],
 'too-large':[413,'Soubor nebo část nahrávky překročily limit.','Use a file of at most 256 MiB (128 MiB for GLB, 256 KiB for a staged document). Send chunks of at most 32 KiB in MCP or 8 MiB over raw HTTP.'],
 'upload-offset':[409,'Část souboru nenavazuje na nahraná data.','Continue at nextOffset. To retry an earlier chunk, resend the same bytes at its original offset.'],
 'upload-expired':[410,'Nahrávání vypršelo. Začni znovu.','The upload session expired or is unavailable. Start a new upload.'],
 'upload-limit':[409,'Příliš mnoho rozpracovaných nahrávek.','Finish pending asset uploads or wait for retained uploads to expire before starting another.'],
 'disk-limit':[409,'Úložiště wiki dosáhlo nastaveného limitu.','The wiki disk budget cannot reserve this file. Free space in the wiki store or ask an administrator to adjust WIKI_MAX_BYTES.'],
 denied:[403,'Přístup ke zdroji nebo nahrávce nebyl povolen.','This principal does not have access to the source or upload session.'],
 'source-busy':[503,'Probíhá příliš mnoho operací s Git LFS.','Too many Git LFS operations are running. Try again when an operation finishes.'],
 'source-not-granted':[403,'Zdroj není pro tento projekt povolený.','This source has not been granted to the destination project.'],
 'source-unavailable':[503,'Zdroj teď není dostupný.','The source is unavailable. Check that the Git integration and source connection are working.'],
 'source-missing':[404,'Soubor nebyl ve zdroji nalezen.','The source object could not be found.'],
 'source-invalid':[502,'Zdroj vrátil neočekávanou odpověď.','The source returned metadata that does not match the selected object.'],
 'unsafe-source':[403,'Hostitel souboru není schválený.','The source download origin is unapproved. Ask an administrator to check this repository grant.'],
 unavailable:[503,'Wiki teď nejde načíst ani uložit.','The wiki is unavailable right now. Read the target before retrying a write.'],
};

export function wikiProblem(error,{english=true,legacy=false}={}){
 const reason=Object.hasOwn(messages,error.message)?error.message:'unavailable';
 const [status,cs,en]=messages[reason],code='WIKI_'+reason.toUpperCase().replaceAll('-','_');
 return {status,body:{error:{code:legacy?'WIKI_FAILED':code,reason,message:english?en:cs},
  ...(error.current?{current:error.current}:{}),...(Number.isSafeInteger(error.nextOffset)?{nextOffset:error.nextOffset}:{})}};
}
