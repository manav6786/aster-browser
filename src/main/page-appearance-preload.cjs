'use strict';
const {ipcRenderer,webFrame}=require('electron');
if(/^https?:/.test(location.href)){
 let currentKey=null,generation=0,closed=false;
 const apply=async value=>{
  if(closed||value?.url!==location.href||typeof value.css!=='string'||value.css.length>16384)return;
  const request=++generation;
  try{
   const next=await webFrame.insertCSS(value.css,{cssOrigin:'user'});
   if(closed||request!==generation){await webFrame.removeInsertedCSS(next).catch(()=>{});return;}
   const previous=currentKey;currentKey=next;if(previous)await webFrame.removeInsertedCSS(previous).catch(()=>{});
  }catch{}
 };
 const changed=(_event,value)=>{void apply(value);};ipcRenderer.on('aster:appearance:update',changed);
 ipcRenderer.invoke('aster:appearance:ready',location.href).then(apply).catch(()=>{});
 addEventListener('unload',()=>{closed=true;generation++;ipcRenderer.removeListener('aster:appearance:update',changed);},{once:true});
}
