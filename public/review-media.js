// Browser-observed geometry is necessary but never proof of semantic alignment.
export const comparisonAllowed=item=>item.mode!=='approve'||item.aligned===true&&['image','video'].includes(item.kind)&&item.variants.some(v=>v.reference)&&item.variants.filter(v=>!v.reference).length===1;
export function swipeEligible(item,left,right,metadata){
 if(!comparisonAllowed(item)||item.aligned!==true||!['image','video'].includes(item.kind)||left===right)return false;
 const variants=[left,right].map(id=>item.variants.find(v=>v.id===id));
 if(variants.some(v=>!v||v.media.length!==1)||variants[0].media[0].sha256===variants[1].media[0].sha256)return false;
 const [a,b]=metadata;
 return Boolean(a&&b&&a.width>0&&a.height>0&&a.width===b.width&&a.height===b.height&&
  (item.kind!=='video'||Number.isFinite(a.duration)&&a.duration>0&&Number.isFinite(b.duration)&&Math.abs(a.duration-b.duration)<=1/30));
}
export function clampComparison(item,cmp){
 const ids=item.variants.map(v=>v.id);
 if(!ids.includes(cmp.one))cmp.one=ids[0];
 if(!ids.includes(cmp.left))cmp.left=ids[0];
 if(!ids.includes(cmp.right)||cmp.right===cmp.left)cmp.right=ids.find(id=>id!==cmp.left)||ids[0];
 if(!comparisonAllowed(item))cmp.mode='one';
 return cmp;
}
const clocks=new Set();
// One active page session. Approval clocks restrict playback to one deliverable at a time.
export function videoClock({sound:initial=null,independent=false,visible=c=>{const h=c.host||c;return h.isConnected&&h.offsetParent!==null;},schedule=fn=>requestAnimationFrame(fn),cancel=id=>cancelAnimationFrame(id)}={}){
 const clips=new Set(),listeners=new Set(),cleanups=[];let playing=false,volume=1,rate=1,sound=initial,at=0,raf=0,disposed=false,request=0,error='',state='paused',active=null;
 const shown=c=>visible(c)&&(!independent||!active||c.dataset.variant===active);
 const ready=c=>shown(c)&&c.readyState>0;
 const lead=()=>[...clips].find(ready)||null;
 const len=c=>Number.isFinite(c.duration)?c.duration:0;
 const emit=()=>{if(!disposed)for(const f of listeners)f();};
 const apply=c=>{c.muted=!shown(c)||!sound||c.dataset.variant!==sound;c.playbackRate=rate;c.volume=volume;};
 const place=(c,t)=>{if(c.readyState>0)try{c.currentTime=Math.max(0,len(c)?Math.min(t,len(c)):t);}catch{}};
 function tick(){raf=0;if(disposed||!playing)return;
  const l=lead();if(!l){clock.pause();return;}at=l.currentTime;
  for(const c of clips){if(!shown(c)){c.pause();c.muted=true;}else if(c!==l&&Math.abs(c.currentTime-at)>0.1)place(c,at);}
  emit();raf=schedule(tick);
 }
 const clock={
  add(c){clips.add(c);apply(c);
   const on=(name,fn)=>{c.addEventListener(name,fn);cleanups.push(()=>c.removeEventListener(name,fn));};
   on('loadedmetadata',()=>{if(disposed)return;place(c,at);apply(c);emit();});
   on('waiting',()=>{if(playing&&shown(c)){state='buffering';emit();}});
   on('playing',()=>{if(playing&&shown(c)){state='playing';emit();}});
   on('ended',()=>{if(shown(c))clock.pause();});
   on('error',()=>{if(shown(c)){clock.pause();error='Media could not be decoded. Check the file and retry.';state='error';emit();}});
   return c;},
  update:apply,playing:()=>playing,time:()=>at,rate:()=>rate,sound:()=>sound,error:()=>error,state:()=>state,volume:()=>volume,available:id=>[...clips].some(c=>visible(c)&&c.dataset.variant===id),
  duration:()=>Math.max(0,...[...clips].filter(ready).map(len)),
  async play(){
   if(disposed)return;for(const other of clocks)if(other!==clock)other.pause();
   if(independent&&!active)active=[...clips].find(visible)?.dataset.variant||null;
   const targets=[...clips].filter(shown);if(!targets.length)return;
   const token=++request;error='';state='loading';playing=true;emit();
   try{await Promise.all(targets.map(c=>{place(c,at);apply(c);return c.play();}));
    if(disposed||token!==request){for(const c of targets)if(!playing)c.pause();return;}
    state='playing';if(!raf)raf=schedule(tick);emit();
   }catch{if(disposed||token!==request)return;clock.pause();error='Playback failed. Press Play to retry; check browser permissions or the file.';state='error';emit();}
  },
  pause(){request++;playing=false;if(raf){cancel(raf);raf=0;}const l=lead();if(l)at=l.currentTime;for(const c of clips)c.pause();state='paused';emit();},
  toggle(){return playing?clock.pause():clock.play();},
  seek(t){at=Math.max(0,Math.min(Number.isFinite(t)?t:0,clock.duration()||Infinity));for(const c of clips)if(shown(c))place(c,at);emit();},
  step(d){clock.pause();clock.seek(at+d/30);},
  setRate(r){rate=r;for(const c of clips)apply(c);emit();},
  setVolume(v){volume=Math.max(0,Math.min(1,v));for(const c of clips)apply(c);emit();},
  setSound(id){if(id&&!clock.available(id)){emit();return;}sound=id||null;if(independent&&id)clock.select(id);for(const c of clips)apply(c);emit();},
  select(id){if(independent&&active!==id){clock.pause();active=id;at=0;}if(sound&&id)sound=id;for(const c of clips)apply(c);emit();},
  refresh(){if(playing)clock.pause();for(const c of clips){apply(c);if(shown(c))place(c,at);}emit();},
  stop(){clock.pause();disposed=true;for(const c of clips){c.muted=true;c.removeAttribute?.('src');c.load?.();}for(const f of cleanups)f();listeners.clear();clips.clear();clocks.delete(clock);},
  on(f){listeners.add(f);return ()=>listeners.delete(f);}
 };
 clocks.add(clock);return clock;
}
