// Shared by Review and the wiki. The vendored renderer is loaded only by a view opening a model.
let viewerModule;
export function loadModelViewer(){
 return viewerModule??=import('./vendor/model-viewer.min.js').catch(error=>{viewerModule=null;throw error;});
}

export function modelElement({src,alt,poster}){
 const node=document.createElement('model-viewer');
 for(const [key,value] of Object.entries({src,alt,'camera-controls':'','interaction-prompt':'none',
  'touch-action':'pan-y','shadow-intensity':'1','max-camera-orbit':'auto auto auto'}))node.setAttribute(key,value);
 if(poster)node.setAttribute('poster',poster);
 return node;
}
