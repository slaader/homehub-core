import {el} from './views.js';
import {t,tp,locale} from './i18n.js';
import {icon} from './icons.js';
import {loadModelViewer,modelElement} from './model-viewer.js';

const button=(label,onclick,attrs={})=>el('button',{type:'button',class:'acc-btn small',onclick,...attrs},label);
const nameOf=({ref,asset})=>ref.label||asset?.name||t('Nedostupná příloha');
const download=(asset,label=t('Stáhnout'))=>el('a',{class:'acc-btn small',href:asset.url+'?download=1',download:asset.name},label);
const failed=()=>t('Náhled není dostupný.');

export function wikiFileSize(size){
 const format=new Intl.NumberFormat(locale(),{maximumFractionDigits:1});
 if(size<1024)return format.format(size)+' B';
 if(size<1024**2)return format.format(size/1024)+' KiB';
 return format.format(size/1024**2)+' MiB';
}

function stopPlayer(player){
 player.pause();
 player.removeAttribute('src');
 player.load();
}

function videoPlayer({asset,ref,displayAsset}){
 const originals=[displayAsset,asset].filter(Boolean);
 const sources=[...originals.map(({url})=>({url})),
  ...originals.filter(({type})=>type==='video/mp4').map(({url})=>({url:url+'?preview=webm',generated:true}))];
 const note=el('p',{role:'status',hidden:''});
 let index=0,active=false,played=false;
 const player=el('video',{controls:'',playsinline:'',preload:'metadata','aria-label':nameOf({asset,ref})});
 function advance(){
  if(!active)return;
  const next=sources[index++];
  if(!next){
   note.textContent=t('Video se nepodařilo přehrát. Stáhni originál.');
   note.hidden=false;
   return;
  }
  if(next.generated){
   note.textContent=t('Připravuji video pro tento prohlížeč…');
   note.hidden=false;
  }
  player.src=next.url;
  if(played)player.play().catch(()=>{});
 }
 player.addEventListener('play',()=>{played=true;});
 player.addEventListener('loadedmetadata',()=>{note.hidden=true;});
 player.addEventListener('error',advance);
 return {player,note,start({autoplay=false}={}){active=true;played=autoplay;advance();},stop(){active=false;stopPlayer(player);}};
}

export function wikiMedia({dialog}){
 let audio=null,active=null;
 function stopAudio(restore){
  if(!audio)return;
  const player=audio,src=player.getAttribute('src');
  audio=null;
  stopPlayer(player);
  if(restore&&src)player.src=src;
 }
 function stop(restoreAudio=false){
  stopAudio(restoreAudio);
  active?.dispose();
  active?.dialog.close();
 }
 function open(title,body,cleanup,{opener,className=''}={}){
  stop(true);
  const d=dialog(title,[body],{opener,className:'wiki-media-dialog '+className});
  let disposed=false;
  function dispose(){
   if(disposed)return;
   disposed=true;
   cleanup?.();
  }
  active={dialog:d,dispose};
  d.addEventListener('close',()=>{
   dispose();
   if(active?.dialog===d)active=null;
  },{once:true});
  return d;
 }

 function thumbnail({asset},width,height){
  const img=el('img',{class:'wiki-thumbnail',src:asset.url+'?thumbnail=1',alt:'',loading:'lazy',decoding:'async',width,height,
   onerror:()=>{img.hidden=true;}});
  return img;
 }

 function gallery(pictures,start,{filmstrip=false,opener}={}){
  let index=start;
  const imageArea=el('div',{class:'wiki-gallery-image'});
  const count=el('span',{'aria-live':'polite'});
  const caption=el('p',{class:'sec-dim'});
  const links=el('div',{class:'wiki-actions'});
  const prev=button('←',()=>step(-1),{'aria-label':t('Předchozí obrázek')});
  const next=button('→',()=>step(1),{'aria-label':t('Další obrázek')});
  prev.disabled=next.disabled=pictures.length<2;
  const frames=filmstrip&&pictures.length>1?pictures.map((entry,i)=>
   el('button',{type:'button',class:'wiki-film-frame',title:nameOf(entry),
    'aria-label':t('{index} z {total}',{index:i+1,total:pictures.length})+' · '+nameOf(entry),
    onclick:()=>select(i)},el('span',{'aria-hidden':'true'},i+1),thumbnail(entry,68,48))):[];
  const strip=frames.length?el('div',{class:'wiki-filmstrip',role:'group','aria-label':t('Náhledy obrázků')},frames):null;
  const stage=filmstrip?el('div',{class:'wiki-gallery-stage'},prev,imageArea,next):imageArea;
  const controls=el('div',{class:'wiki-actions'},filmstrip?null:prev,count,filmstrip?null:next,filmstrip?links:null);
  const d=open(nameOf(pictures[index]),el('div',{class:'wiki-media-body'},stage,caption,controls,filmstrip?strip:links),
   ()=>imageArea.replaceChildren(),{opener,className:filmstrip?'wiki-inventory-gallery':''});
  function draw(){
   const entry=pictures[index],label=nameOf(entry);
   const heading=d.querySelector('h2');
   if(heading)heading.textContent=label;
   const image=el('img',{alt:label,onerror:()=>{
    if(image.parentNode===imageArea)image.replaceWith(el('p',{role:'status'},failed()));
   }});
   imageArea.replaceChildren(image);
   image.src=entry.asset.url;
   count.textContent=t('{index} z {total}',{index:index+1,total:pictures.length});
   caption.textContent=entry.ref.caption;
   caption.hidden=!entry.ref.caption;
   links.replaceChildren(download(entry.asset));
   frames.forEach((frame,i)=>{
    if(i===index)frame.setAttribute('aria-current','true');
    else frame.removeAttribute('aria-current');
   });
   if(strip){
    const frame=frames[index].getBoundingClientRect(),bounds=strip.getBoundingClientRect();
    if(frame.left<bounds.left)strip.scrollLeft+=frame.left-bounds.left;
    else if(frame.right>bounds.right)strip.scrollLeft+=frame.right-bounds.right;
   }
  }
  function select(nextIndex){
   if(index===nextIndex)return;
   index=nextIndex;
   draw();
  }
  function step(delta){select((index+delta+pictures.length)%pictures.length);}
  d.addEventListener('keydown',event=>{
   if(event.key==='ArrowLeft')step(-1);
   else if(event.key==='ArrowRight')step(1);
   else if(filmstrip&&event.key==='Home')select(0);
   else if(filmstrip&&event.key==='End')select(pictures.length-1);
   else return;
   event.preventDefault();
  });
  draw();
 }

 function video(entry,opener){
  const {asset,ref}=entry,{player,note,start,stop}=videoPlayer(entry);
  open(nameOf(entry),el('div',{class:'wiki-media-body'},player,note,ref.caption?el('p',{},ref.caption):null,
   download(asset,t('Stáhnout originál'))),stop,{opener});
  start();
 }

 function model(entry,opener){
  const {asset,ref,displayAsset}=entry,label=nameOf(entry),controller=new AbortController();
  const stage=el('div',{class:'wiki-model'});
  const note=el('p',{role:'status'},t('Načítám 3D prohlížeč…'));
  const controls=el('div',{class:'wiki-actions'});
  let viewer=null,source=null;
  function releaseSource(){
   if(source)URL.revokeObjectURL(source);
   source=null;
  }
  const d=open(label,el('div',{class:'wiki-media-body'},stage,note,controls,ref.caption?el('p',{},ref.caption):null,
   download(asset,t('Stáhnout originál'))),()=>{
   controller.abort();
   viewer?.pause();
   viewer?.removeAttribute('src');
   stage.replaceChildren();
   releaseSource();
   viewer=null;
  },{opener});
  function report(){
   if(!d.open)return;
   controller.abort();
   releaseSource();
   note.textContent=t('3D náhled se nepodařilo načíst. Stáhni originál.');
   note.hidden=false;
  }
  const modelBytes=fetch((displayAsset??asset).url,{signal:controller.signal}).then(response=>{
   if(!response.ok)throw new Error('model');
   return response.blob();
  });
  Promise.all([loadModelViewer(),modelBytes]).then(([,blob])=>{
   if(!d.open)return;
   source=URL.createObjectURL(blob);
   viewer=modelElement({src:source,alt:label});
   viewer.addEventListener('error',report);
   viewer.addEventListener('load',()=>{
    if(!d.open)return;
    releaseSource();
    note.hidden=true;
    const camera=(angle,zoom)=>{
     const {theta,phi,radius}=viewer.getCameraOrbit();
     viewer.cameraOrbit=`${theta+angle}rad ${phi}rad ${radius*zoom}m`;
    };
    controls.replaceChildren(
     button('←',()=>camera(-Math.PI/6,1),{'aria-label':t('Otočit doleva')}),
     button('→',()=>camera(Math.PI/6,1),{'aria-label':t('Otočit doprava')}),
     button('+',()=>camera(0,0.8),{'aria-label':t('Přiblížit')}),
     button('−',()=>camera(0,1.25),{'aria-label':t('Oddálit')}));
    const animations=viewer.availableAnimations;
    if(!animations?.length)return;
    const play=button(t('Přehrát animaci'),()=>{
     if(viewer.paused)viewer.play();
     else viewer.pause();
     toggle();
    });
    function toggle(){play.textContent=t(viewer.paused?'Přehrát animaci':'Pozastavit animaci');}
    const picker=el('select',{'aria-label':t('Animace'),onchange:()=>{
     viewer.pause();
     viewer.animationName=picker.value;
     toggle();
    }},animations.map(n=>el('option',{value:n},n)));
    viewer.animationName=animations.find(name=>name===ref.initialClip)??
     animations.find(name=>/(?:^|[^a-z])idle(?:$|[^a-z])/i.test(name))??animations[0];
    picker.value=viewer.animationName;
    controls.append(picker,play);
   },{once:true});
   stage.append(viewer);
  }).catch(report);
 }

 function audioNode(asset,label){
  const player=el('audio',{controls:'',preload:'none','aria-label':label,src:asset.url});
  const status=el('span',{class:'sec-dim',role:'status'});
  player.addEventListener('play',()=>{
   if(audio!==player){stopAudio(true);audio=player;}
  });
  player.addEventListener('error',()=>{status.textContent=failed();});
  return [player,status];
 }

 function playlist(entries,kind,title,opener){
  const stage=el('div',{class:'wiki-playlist-stage'},el('p',{class:'sec-dim'},t('Vyber soubor k přehrání.')));
  let selected=-1,stopCurrent=null;
  const choices=entries.map((entry,index)=>button(nameOf(entry),()=>play(index),
   {class:'acc-btn small wiki-playlist-choice','aria-pressed':'false'}));
  const list=el('ul',{class:'wiki-playlist-list','aria-label':title},choices.map(choice=>el('li',{},choice)));
  open(title,el('div',{class:'wiki-playlist'},list,stage),()=>{stopCurrent?.();stage.replaceChildren();},{opener});
  function play(index){
   if(index===selected)return;
   stopCurrent?.();
   choices[selected]?.setAttribute('aria-pressed','false');
   selected=index;
   choices[index].setAttribute('aria-pressed','true');
   const entry=entries[index],{asset,ref}=entry,label=nameOf(entry);
   const {player,note,start,stop}=kind==='video'?videoPlayer(entry):playlistAudio(asset,label);
   stopCurrent=stop;
   stage.replaceChildren(el('div',{class:'wiki-media-body'},el('strong',{},label),player,note,
    ref.caption?el('p',{class:'wiki-caption'},ref.caption):null,kind==='video'?download(asset,t('Stáhnout originál')):download(asset)));
   start({autoplay:true});
  }
 }

 function playlistAudio(asset,label){
  const note=el('p',{role:'status',hidden:''});
  const player=el('audio',{controls:'',preload:'none','aria-label':label,onerror:()=>{
   note.textContent=failed();
   note.hidden=false;
  }});
  return {player,note,start(){player.src=asset.url;player.play().catch(()=>{});},stop:()=>stopPlayer(player)};
 }

 function inventoryImages(pictures){
  const openPictures=event=>gallery(pictures,0,{filmstrip:true,opener:event.currentTarget});
  if(pictures.length===1){
   const label=nameOf(pictures[0]),name=t('Otevřít obrázek {name}',{name:label});
   return el('button',{type:'button',class:'acc-btn small wiki-portrait',title:label,'aria-label':name,
    onclick:openPictures},icon('eye'),thumbnail(pictures[0],56,64));
  }
  return el('button',{type:'button',class:'acc-btn small wiki-image-folder',onclick:openPictures},
   el('span',{class:'wiki-folder-previews','aria-hidden':'true'},icon('folder'),
    pictures.slice(0,3).map(entry=>thumbnail(entry,28,28))),
   tp(pictures.length,'{n} obrázek|{n} obrázky|{n} obrázků'));
 }

 function inventory(refs,assets){
  if(!refs.length)return null;
  const entries=refs.map(ref=>({ref,asset:assets.get(ref.assetId),displayAsset:assets.get(ref.displayAssetId)}));
  const pictures=[],audioTracks=[],videos=[],other=[];
  for(const entry of entries){
   const type=entry.asset?.type??'';
   if(type.startsWith('image/'))pictures.push(entry);
   else if(type.startsWith('audio/'))audioTracks.push(entry);
   else if(type.startsWith('video/'))videos.push(entry);
   else other.push(entry);
  }
  const series=(entries,kind,template,mark)=>{
   if(!entries.length)return null;
   const title=t(template,{count:entries.length});
   return el('li',{},el('button',{type:'button',class:'acc-btn small wiki-media-tile',
    onclick:event=>playlist(entries,kind,title,event.currentTarget)},icon(mark),title));
  };
  return el('ul',{class:'wiki-inventory-media'},pictures.length?el('li',{},inventoryImages(pictures)):null,
   series(audioTracks,'audio','Zvukové stopy ({count})','pulse'),series(videos,'video','Videa ({count})','monitor'),
   other.map(entry=>{
    const {asset,ref}=entry,label=nameOf(entry);
    if(!asset)return el('li',{},el('span',{class:'sec-dim'},label));
    const action=asset.type==='model/gltf-binary'
     ?button(t('Otevřít 3D model {name}',{name:label}),event=>model(entry,event.currentTarget))
     :download(asset,label);
    return el('li',{},action,ref.caption?el('span',{class:'wiki-caption'},ref.caption):null);
   }));
 }

 function group(refs,assets){
  const entries=refs.map(ref=>({ref,asset:assets.get(ref.assetId),displayAsset:assets.get(ref.displayAssetId)}));
  const pictures=entries.filter(({asset})=>asset?.type.startsWith('image/'));
  if(!entries.length)return null;
  return el('ul',{class:'wiki-attachments'},entries.map(entry=>{
   const {asset,ref}=entry,label=nameOf(entry);
   if(!asset)return el('li',{},el('span',{class:'sec-dim'},label));
   let node;
   if(asset.type.startsWith('image/')){
    node=el('button',{class:'acc-btn wiki-image-button',type:'button',
     onclick:event=>gallery(pictures,pictures.indexOf(entry),{opener:event.currentTarget})},thumbnail(entry,144,96),label);
   }else if(asset.type.startsWith('audio/'))node=[el('strong',{},label),audioNode(asset,label),download(asset)];
   else if(asset.type.startsWith('video/'))node=button(t('Přehrát video {name}',{name:label}),event=>video(entry,event.currentTarget));
   else if(asset.type==='model/gltf-binary')node=button(t('Otevřít 3D model {name}',{name:label}),event=>model(entry,event.currentTarget));
   else node=[el('strong',{},label),label!==asset.name?el('span',{},asset.name):null,el('span',{class:'sec-dim'},wikiFileSize(asset.size)),download(asset)];
   return el('li',{},node,ref.caption?el('span',{class:'wiki-caption'},ref.caption):null);
  }));
 }
 return {group,inventory,stop};
}
