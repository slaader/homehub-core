import {el} from './views.js';
import {t,locale} from './i18n.js';
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

export function wikiMedia({dialog}){
 let audio=null,active=null;
 function stopAudio(){
  if(!audio)return;
  audio.pause();
  audio.currentTime=0;
  audio=null;
 }
 function stop(){
  stopAudio();
  active?.close();
 }
 function open(title,body,cleanup){
  stop();
  const d=dialog(title,[body],{className:'wiki-media-dialog'});
  active=d;
  d.addEventListener('close',()=>{
   cleanup?.();
   if(active===d)active=null;
  },{once:true});
  return d;
 }

 function gallery(pictures,start){
  let index=start;
  const imageArea=el('div',{class:'wiki-gallery-image'});
  const count=el('span',{'aria-live':'polite'});
  const caption=el('p',{class:'sec-dim'});
  const links=el('div',{class:'wiki-actions'});
  const prev=button('←',()=>step(-1),{'aria-label':t('Předchozí obrázek')});
  const next=button('→',()=>step(1),{'aria-label':t('Další obrázek')});
  const controls=el('div',{class:'wiki-actions'},prev,count,next);
  const d=open(nameOf(pictures[index]),el('div',{class:'wiki-media-body'},imageArea,caption,controls,links),()=>imageArea.replaceChildren());
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
   prev.disabled=next.disabled=pictures.length<2;
   caption.textContent=entry.ref.caption;
   caption.hidden=!entry.ref.caption;
   links.replaceChildren(download(entry.asset));
  }
  function step(delta){
   index=(index+delta+pictures.length)%pictures.length;
   draw();
  }
  d.addEventListener('keydown',event=>{
   if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
   event.preventDefault();
   step(event.key==='ArrowLeft'?-1:1);
  });
  draw();
 }

 function video(entry){
  const {asset,ref}=entry,label=nameOf(entry),note=el('p',{role:'status',hidden:''});
  const player=el('video',{controls:'',playsinline:'',preload:'metadata','aria-label':label,onerror:()=>{
   note.textContent=failed();
   note.hidden=false;
  }});
  open(label,el('div',{class:'wiki-media-body'},player,note,ref.caption?el('p',{},ref.caption):null,download(asset)),()=>stopPlayer(player));
  player.src=asset.url;
 }

 function model(entry){
  const {asset,ref}=entry,label=nameOf(entry);
  const stage=el('div',{class:'wiki-model'});
  const note=el('p',{role:'status'},t('Načítám 3D prohlížeč…'));
  const controls=el('div',{class:'wiki-actions'});
  let viewer=null;
  const d=open(label,el('div',{class:'wiki-media-body'},stage,note,controls,ref.caption?el('p',{},ref.caption):null,download(asset)),()=>{
   viewer?.pause();
   viewer?.removeAttribute('src');
   stage.replaceChildren();
   viewer=null;
  });
  function report(){
   note.textContent=failed();
   note.hidden=false;
  }
  loadModelViewer().then(()=>{
   if(!d.open)return;
   viewer=modelElement({src:asset.url,alt:label});
   viewer.addEventListener('error',report);
   viewer.addEventListener('load',()=>{
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
    viewer.animationName=animations[0];
    controls.append(picker,play);
   },{once:true});
   stage.append(viewer);
  },report);
 }

 function audioNode(asset,label){
  const player=el('audio',{controls:'',preload:'none','aria-label':label,src:asset.url});
  const status=el('span',{class:'sec-dim',role:'status'});
  player.addEventListener('play',()=>{
   if(audio!==player){stopAudio();audio=player;}
  });
  player.addEventListener('error',()=>{status.textContent=failed();});
  return [player,status];
 }

 function group(refs,assets){
  const entries=refs.map(ref=>({ref,asset:assets.get(ref.assetId)}));
  const pictures=entries.filter(({asset})=>asset?.type.startsWith('image/'));
  if(!entries.length)return null;
  return el('ul',{class:'wiki-attachments'},entries.map(entry=>{
   const {asset,ref}=entry,label=nameOf(entry);
   if(!asset)return el('li',{},el('span',{class:'sec-dim'},label));
   let node;
   if(asset.type.startsWith('image/')){
    const img=el('img',{class:'wiki-thumbnail',src:asset.url+'?thumbnail=1',alt:'',loading:'lazy',decoding:'async',width:144,height:96,
     onerror:()=>{img.hidden=true;}});
    node=el('button',{class:'acc-btn wiki-image-button',type:'button',onclick:()=>gallery(pictures,pictures.indexOf(entry))},img,label);
   }else if(asset.type.startsWith('audio/'))node=[el('strong',{},label),audioNode(asset,label),download(asset)];
   else if(asset.type.startsWith('video/'))node=button(t('Přehrát video {name}',{name:label}),()=>video(entry));
   else if(asset.type==='model/gltf-binary')node=button(t('Otevřít 3D model {name}',{name:label}),()=>model(entry));
   else node=[el('strong',{},label),label!==asset.name?el('span',{},asset.name):null,el('span',{class:'sec-dim'},wikiFileSize(asset.size)),download(asset)];
   return el('li',{},node,ref.caption?el('span',{class:'wiki-caption'},ref.caption):null);
  }));
 }
 return {group,stop};
}
