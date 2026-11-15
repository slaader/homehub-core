import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonAllowed,swipeEligible,clampComparison,videoClock} from '../public/review-media.js';
import {reviewPrompt} from '../public/review-guidance.js';
const item=(kind='image',mode='choose',aligned=true)=>({kind,mode,aligned,variants:['a','b'].map(id=>({id,media:[{sha256:id}]}))});
const size=(width=640,height=480,duration=2)=>({width,height,duration});
test('comparison mode matrix: approve is independent except explicit aligned before/after with a reference',()=>{
 for(const kind of ['html','image','video','audio','model'])for(const mode of ['choose','approve'])for(const aligned of [false,true]){
  const i=item(kind,mode,aligned);assert.equal(comparisonAllowed(i),mode==='choose');
  i.variants[0].reference=true;assert.equal(comparisonAllowed(i),mode==='choose'||aligned&&['image','video'].includes(kind));
  const expected=['image','video'].includes(kind)&&aligned;
  assert.equal(swipeEligible(i,'a','b',[size(),size()]),expected);
 }
 const i=item();assert.equal(swipeEligible(i,'a','b',[size(),size(1280,960)]),false,'same aspect is insufficient');
 for(const metadata of [[null,size()],[size(),null],[size(0),size(0)]])assert.equal(swipeEligible(i,'a','b',metadata),false);
 assert.equal(swipeEligible(i,'a','a',[size(),size()]),false);
 i.variants[1].media[0].sha256='a';assert.equal(swipeEligible(i,'a','b',[size(),size()]),false,'same blob is not comparison');
 const clip=item('video');assert.equal(swipeEligible(clip,'a','b',[size(),size(640,480,4)]),false);
 assert.equal(swipeEligible(clip,'a','b',[size(),size(640,480,Infinity)]),false);
 clip.variants[0].media.push({sha256:'c'});assert.equal(swipeEligible(clip,'a','b',[size(),size()]),false,'multi-media navigation must not silently compare only file one');
});
test('comparison state clamps removed and duplicate selections and independent mode',()=>{
 assert.deepEqual(clampComparison(item(),{one:'gone',left:'b',right:'b',mode:'swipe'}),{one:'a',left:'b',right:'a',mode:'swipe'});
 assert.equal(clampComparison(item('video','approve'),{one:'a',left:'a',right:'b',mode:'side'}).mode,'one');
});
class Clip extends EventTarget{
 constructor(id){super();this.dataset={variant:id};this.duration=5;this.currentTime=0;this.readyState=1;this.paused=true;this.visible=true;this.plays=0;}
 play(){this.plays++;if(this.reject)return Promise.reject(Error('blocked'));this.paused=false;return Promise.resolve();}
 pause(){this.paused=true;}
 removeAttribute(){}load(){this.unloaded=true;}
}
function session(options={}){const frames=new Map();let id=0;const c=videoClock({visible:c=>c.visible,schedule:fn=>{frames.set(++id,fn);return id;},cancel:id=>frames.delete(id),...options});return {c,frames};}
test('playback rejection is visible and never auto-retried; explicit retry works',async()=>{
 const {c,frames}=session(),a=c.add(new Clip('a'));a.reject=true;await c.play();
 assert.equal(c.playing(),false);assert.equal(c.state(),'error');assert.match(c.error(),/retry/);assert.equal(a.plays,1);assert.equal(frames.size,0);
 a.reject=false;await c.play();assert.equal(c.playing(),true);assert.equal(c.error(),'');c.stop();assert.equal(a.unloaded,true);assert.equal(a.muted,true);assert.equal(frames.size,0);
});
test('hidden audio pauses/mutes, audible selection follows visible deliverable and independent transports do not sync',async()=>{
 const {c}=session({sound:'a',independent:true}),a=c.add(new Clip('a')),b=c.add(new Clip('b'));
 c.select('a');await c.play();assert.equal(a.paused,false);assert.equal(b.paused,true);assert.equal(a.muted,false);assert.equal(b.muted,true);
 a.currentTime=3;a.visible=false;c.select('b');c.refresh();assert.equal(a.paused,true);assert.equal(a.muted,true);assert.equal(c.sound(),'b');assert.equal(c.time(),0);
 await c.play();assert.equal(b.paused,false);assert.equal(b.currentTime,0);c.seek(100);assert.equal(b.currentTime,5);
 c.setSound(null);assert.equal(b.muted,true);c.stop();
});
test('only one session plays; buffering, ended and decode errors update state',async()=>{
 const first=session().c,second=session().c,a=first.add(new Clip('a')),b=second.add(new Clip('b'));
 await first.play();await second.play();assert.equal(first.playing(),false);assert.equal(a.paused,true);
 b.dispatchEvent(new Event('waiting'));assert.equal(second.state(),'buffering');b.dispatchEvent(new Event('playing'));assert.equal(second.state(),'playing');
 b.dispatchEvent(new Event('ended'));assert.equal(second.playing(),false);
 b.dispatchEvent(new Event('error'));assert.equal(second.state(),'error');assert.match(second.error(),/decoded/);first.stop();second.stop();
});
test('late play resolution after disposal cannot restart a session',async()=>{
 const c=session().c,a=c.add(new Clip('a'));let resolve;a.play=()=>new Promise(r=>{resolve=()=>{a.paused=false;r();};});
 const pending=c.play();c.stop();resolve();await pending;assert.equal(a.paused,true);assert.equal(c.playing(),false);
});
test('publishing guidance is contextual, selected revision first, separate assets and honest audio QA',()=>{
 const prompt=reviewPrompt({project:'my-app',tickets:['APP-3'],set:{id:'R-2',rounds:[{n:3}]}});
 for(const text of ['APP-3','my-app','R-2','round 3','selected work','reference:true','individually inspectable','html, image, model, video, audio','intentional silence','stream presence remains unknown','addresses'])assert.ok(prompt.includes(text),text);
 assert.ok(!prompt.includes('Prepare 2–3'));
});

test('changing comparison view preserves the paused playback position',async()=>{
 const {c}=session({sound:'a'}),a=c.add(new Clip('a')),b=c.add(new Clip('b'));
 b.visible=false;await c.play();a.currentTime=3;c.pause();a.visible=false;b.visible=true;c.select('b');c.refresh();
 assert.equal(c.time(),3);assert.equal(b.currentTime,3);assert.equal(c.sound(),'b');c.stop();
});
