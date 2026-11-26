'use strict';
// Headless Chromium only. The mocked preload cannot change native apps, profiles, or networking.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {PNG}=require('pngjs');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const here=path.resolve(process.env.ASTER_TEST_WORK||path.join(__dirname,'../work/renderer-accessibility')),checks=[],errors=[];fs.mkdirSync(here,{recursive:true});
const state={tabs:Array.from({length:16},(_,i)=>({id:'t'+i,title:i?'Article '+i:'New tab',url:i?'https://example.test/'+i:'aster://newtab',workspace:'w0'})),activeTabId:'t0',activeWorkspace:'w0',workspaces:Array.from({length:11},(_,i)=>({id:'w'+i,name:i?'Long Research Workspace '+i:'Personal',color:'#a38ac6'})),bookmarks:[],history:[],downloads:[],agents:[],activity:[],settings:{theme:'light',accent:'purple',transparency:false,sidebarCollapsed:false,autoTidy:true},shields:{enabled:true,status:'ready',blocked:0},automation:{},missionOpen:false};
async function run(){
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1050,height:700},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(initial=>{
   window.__state=initial;window.__calls=[];window.__nativeFocus='page';window.__overlayRequest=0;let listener;
   window.__pushState=()=>listener?.(JSON.parse(JSON.stringify(window.__state)));
   window.aster={onState:fn=>listener=fn,onCommand:()=>{},invoke:async(command,payload={})=>{
    window.__calls.push({command,payload});
    if(command==='state:get')return JSON.parse(JSON.stringify(window.__state));
    if(command==='ui:focus-chrome')window.__nativeFocus='chrome';
    if(command==='ui:focus-page')window.__nativeFocus='page';
    if(command==='ui:overlay'){
     const request=++window.__overlayRequest;
     if(!payload.open&&window.__holdOverlayClose){window.__holdOverlayClose=false;await new Promise(resolve=>window.__releaseOverlayClose=resolve);}
     if(request!==window.__overlayRequest)return false;
     const remote=window.__state.tabs.find(t=>t.id===window.__state.activeTabId)?.url.startsWith('http');
     window.__nativeFocus=payload.open?'chrome':remote?'page':window.__nativeFocus;
     window.__pushState();
    }
    if(command==='ui:mission'){window.__state.missionOpen=payload.open;window.__nativeFocus=payload.open?'chrome':'page';window.__pushState();}
    if(command==='settings:update'){Object.assign(window.__state.settings,payload);window.__pushState();}
    if(command==='tab:activate'){window.__state.activeTabId=payload.id;window.__pushState();}
    if(command==='workspace:add'){window.__state.workspaces.push({id:'added',name:payload.name,color:'#a38ac6'});window.__state.activeWorkspace='added';window.__pushState();}
    if(command==='shields:toggle'){window.__state.shields.enabled=!window.__state.shields.enabled;window.__pushState();}
    if(command==='suggestions:query')return {items:[]};
    return null;
   }};
  },state);
  await page.goto(pathToFileURL(path.resolve(__dirname,'../src/renderer/index.html')).href);
  await page.locator('#home-search').waitFor();
  async function check(name,fn){await fn();checks.push({name,passed:true});console.log('PASS',name);}
  await check('New-tab favorites and search placeholders have at least 4.5:1 contrast against rendered backgrounds',async()=>{
   const samples=await page.evaluate(()=>['.favorite-label','#home-search','#address'].map(selector=>{const e=document.querySelector(selector),field=e instanceof HTMLInputElement,r=(field?e.closest('form'):e).getBoundingClientRect();return {selector,color:getComputedStyle(e,field?'::placeholder':null).color,x:Math.max(0,Math.floor(r.left+(field?3:-2))),y:Math.floor(r.top+r.height/2)};}));
   const png=PNG.sync.read(await page.screenshot());
   const luminance=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
   for(const sample of samples){const foreground=sample.color.match(/[\d.]+/g).slice(0,3).map(Number),index=(sample.y*png.width+sample.x)*4,background=[...png.data.subarray(index,index+3)],a=luminance(foreground),b=luminance(background),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);assert.ok(ratio>=4.5,sample.selector+' contrast '+ratio.toFixed(2));}
  });
  await check('Long names occupy separate content-sized rows; all eleven spaces and Add scroll into view',async()=>{
   const dimensions=await page.locator('#spaces').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,labels:[...el.querySelectorAll('.space-chip')].map(e=>{const c=e.getBoundingClientRect(),l=e.querySelector('.space-label').getBoundingClientRect();return {text:e.textContent,top:l.top,bottom:l.bottom,chipTop:c.top,chipBottom:c.bottom};})}));
   assert.equal(dimensions.columns,3);assert.ok(dimensions.scrollWidth<=dimensions.clientWidth+1);assert.ok(dimensions.scrollHeight>dimensions.clientHeight);
   for(const l of dimensions.labels){assert.ok(l.top>=l.chipTop-1,l.text);assert.ok(l.bottom<=l.chipBottom+1,l.text);}
   await page.screenshot({path:path.join(here,'verified-workspace-rows.png')});
   for(const button of await page.locator('#spaces .space-chip').all()){await button.scrollIntoViewIfNeeded();assert.equal(await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);}
  });
  await check('Dialog Escape, Cancel and successful save restore a rebuilt trigger',async()=>{
   for(const method of ['escape','cancel','save']){
    await page.locator('#space-add').focus();await page.keyboard.press('Enter');await page.locator('#dialog').waitFor({state:'visible'});
    if(method==='escape')await page.keyboard.press('Escape');
    else if(method==='cancel')await page.locator('[data-action="dialog-close"]').click();
    else{await page.locator('#dialog-name').fill('Saved space');await page.locator('#dialog-form button[type="submit"]').click();}
    await page.locator('#dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement.id==='space-add');
   }
   await page.evaluate(()=>{window.__state.activeWorkspace='w0';window.__pushState();});
   await page.locator('[data-action="favorite-add"]').focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');
   await page.waitForFunction(()=>document.activeElement.dataset.action==='favorite-add');
  });
  await check('Browser menu supports entry, arrows, Tab containment, Escape and address shortcut',async()=>{
   await page.locator('.more-button').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement.dataset.action==='new');
   await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'private');
   await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.dataset.route),'settings');
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'new');
   await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement.matches('.more-button'));
   await page.keyboard.press('Enter');await page.keyboard.press('Meta+l');await page.waitForFunction(()=>document.activeElement.id==='address');assert.equal(await page.locator('#floating').isHidden(),true);
  });
  await check('Shields retain focused switch while state and content refresh',async()=>{
   await page.locator('#shields-button').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement.dataset.action==='shield-toggle');
   await page.keyboard.press('Space');await page.waitForFunction(()=>document.activeElement.dataset.action==='shield-toggle'&&document.activeElement.getAttribute('aria-checked')==='false');
   await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement.id==='shields-button');
  });
  await check('Mission cards retain keyboard focus across updates and activate with Space',async()=>{
   await page.evaluate(()=>{window.__state.missionOpen=true;window.__pushState();});
   assert.equal(await page.locator('[data-action="mission-page"]').count(),5);
   await page.locator('[data-mission-tab="t1"]').focus();await page.evaluate(()=>window.__pushState());
   assert.equal(await page.evaluate(()=>document.activeElement.dataset.missionTab),'t1');
   await page.keyboard.press('Space');await page.waitForFunction(()=>window.__state.activeTabId==='t1'&&!window.__state.missionOpen);
   await page.locator('#browser-tab-t2').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>window.__state.activeTabId==='t2');
  });
  await check('Palette cancellation preserves native page focus when no chrome trigger exists',async()=>{
   await page.evaluate(()=>{document.activeElement.blur();window.__nativeFocus='page';});
   await page.evaluate(()=>openPalette());await page.keyboard.press('Escape');await page.locator('#palette').waitFor({state:'hidden'});
   assert.equal(await page.evaluate(()=>window.__nativeFocus),'page');
  });
  await check('A delayed dialog close cannot steal focus from a newer palette',async()=>{
   await page.locator('#space-add').focus();await page.keyboard.press('Enter');await page.locator('#dialog').waitFor({state:'visible'});
   await page.evaluate(()=>window.__holdOverlayClose=true);await page.keyboard.press('Escape');await page.waitForFunction(()=>!!window.__releaseOverlayClose);
   await page.evaluate(()=>openPalette());await page.evaluate(()=>window.__releaseOverlayClose());
   await page.waitForFunction(()=>document.activeElement.id==='palette-input');assert.equal(await page.locator('#palette').isVisible(),true);assert.equal(await page.locator('#dialog').isHidden(),true);
   await page.keyboard.press('Escape');
  });
  await check('150 tabs use bounded keyboard-accessible pagination without footer wrapping or overlap',async()=>{
   await page.evaluate(()=>{window.__state.workspaces=window.__state.workspaces.slice(0,3);window.__state.tabs=Array.from({length:150},(_,i)=>({id:'t'+i,title:'Article '+i,url:'https://example.test/'+i,workspace:'w0'}));window.__state.activeWorkspace='w0';window.__state.missionOpen=true;window.__pushState();});
   assert.ok(await page.locator('[data-action="mission-page"]').count()<=7);assert.equal(await page.locator('.mission-page-gap[tabindex]').count(),0);
   await page.locator('[data-action="mission-page"][data-page="37"]').focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.querySelector('[data-page="37"]').getAttribute('aria-current')==='page');
   assert.equal(await page.locator('[data-mission-tab="t148"]').count(),1);
   await page.locator('[data-action="mission-page"][data-page="0"]').focus();await page.keyboard.press('Enter');
   for(let i=0;i<18;i++)await page.locator('[data-action="mission-next"]').click();
   const footer=await page.locator('.mission-footer').evaluate(el=>({clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,children:[...el.children].map(c=>{const r=c.getBoundingClientRect();return {x:r.x,right:r.right,height:r.height};}),counter:(()=>{const e=el.querySelector('.mission-page-control>span');return {text:e.textContent,height:e.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(e).fontSize)};})()}));
   assert.ok(footer.scrollWidth<=footer.clientWidth+1);assert.ok(footer.children[0].right<=footer.children[1].x+1);assert.ok(footer.children[1].right<=footer.children[2].x+1);assert.ok(footer.counter.height<2*footer.counter.fontSize);assert.equal(footer.counter.text,'19 / 38');
   assert.ok(await page.locator('[data-action="mission-page"]').count()<=7);await page.screenshot({path:path.join(here,'verified-mission-150-tabs.png')});
  });
  await check('Distant tab activation reveals the selected sidebar item',async()=>{
   await page.evaluate(()=>{window.__state.missionOpen=false;window.__state.activeTabId='t140';window.__pushState();});
   const bounds=await page.locator('.tab.active').evaluate(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return {top:r.top,bottom:r.bottom,parentTop:p.top,parentBottom:p.bottom};});
   assert.ok(bounds.top>=bounds.parentTop-1);assert.ok(bounds.bottom<=bounds.parentBottom+1);
  });
  await check('Compact workspaces remain one column and dark page bases remain absolute black',async()=>{
   await page.evaluate(()=>{window.__state.settings.sidebarCollapsed=true;window.__state.settings.theme='dark';window.__state.tabs[140].url='aster://newtab';window.__pushState();});
   assert.equal(await page.locator('#spaces').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1);
   assert.equal(await page.locator('.newtab-page').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)');
   assert.equal(await page.locator('button[data-action="sidebar"]').count(),1);assert.equal(await page.locator('.statusbar').count(),0);assert.equal(await page.locator('#interaction-motion-layer>*').count(),0);
  });
  assert.deepEqual(errors,[]);
 }finally{await browser.close();fs.writeFileSync(path.join(here,'renderer-focus-results.json'),JSON.stringify({scope:'Headless current renderer with isolated mocked preload; no native app/network/profile control',checks,errors},null,2));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
