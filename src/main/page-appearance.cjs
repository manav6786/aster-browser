'use strict';
const path=require('node:path');
const READY='aster:appearance:ready',UPDATE='aster:appearance:update';
const accents={purple:'#9b7cf6',blue:'#548df4',teal:'#32b9b2',green:'#62b579',amber:'#e7a744',rose:'#e474aa'};
function scrollbarCSS(settings={}){
 const color=accents[settings.accent]||accents.purple;
 return `:root{scrollbar-color:${color} transparent!important;scrollbar-width:thin!important}*{scrollbar-color:${color} transparent!important;scrollbar-width:thin!important}::-webkit-scrollbar{width:8px!important;height:8px!important}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent!important}::-webkit-scrollbar-thumb{background-color:${color}99!important;border:2px solid transparent!important;background-clip:padding-box!important;border-radius:99px!important}::-webkit-scrollbar-thumb:hover{background-color:${color}!important}`;
}
function createPageAppearance({ipcMain,getSettings}){
 const contents=new Map(),sessions=new WeakMap(),sessionRefs=new Set();let disposed=false;
 const validFrame=(wc,frame)=>{try{return contents.has(wc)&&!wc.isDestroyed()&&frame&&!frame.isDestroyed()&&!frame.detached&&wc.mainFrame.framesInSubtree.includes(frame)&&/^https?:/.test(frame.url);}catch{return false;}};
 ipcMain.handle(READY,(event,url)=>!disposed&&validFrame(event.sender,event.senderFrame)&&event.senderFrame.url===url?{url,css:scrollbarCSS(getSettings())}:null);
 function updateAll(){if(disposed)return;const css=scrollbarCSS(getSettings());for(const wc of contents.keys()){try{for(const frame of wc.mainFrame.framesInSubtree)if(validFrame(wc,frame))frame.send(UPDATE,{url:frame.url,css});}catch{}}}
 function attachWebContents(wc){if(disposed||!wc||wc.isDestroyed()||contents.has(wc))return;const destroyed=()=>{wc.removeListener('destroyed',destroyed);contents.delete(wc);};contents.set(wc,destroyed);wc.once('destroyed',destroyed);}
 function attachSession(ses){if(disposed||sessions.has(ses))return;const id=ses.registerPreloadScript({type:'frame',filePath:path.join(__dirname,'page-appearance-preload.cjs')});sessions.set(ses,id);sessionRefs.add({session:new WeakRef(ses),id});}
 return{attachSession,attachWebContents,updateAll,dispose(){if(disposed)return;disposed=true;ipcMain.removeHandler(READY);for(const [wc,destroyed]of contents)wc.removeListener('destroyed',destroyed);contents.clear();for(const {session,id}of sessionRefs){try{session.deref()?.unregisterPreloadScript(id);}catch{}}sessionRefs.clear();}};
}
module.exports={createPageAppearance,scrollbarCSS};
