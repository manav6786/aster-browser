'use strict';
// Deterministically hold the native state notification while editing renderer chrome.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const here=path.resolve(process.env.ASTER_TEST_WORK||path.join(__dirname,'../work/address-transition'));fs.mkdirSync(here,{recursive:true});const observeBefore=process.argv.includes('--observe-before'),checks=[],errors=[],observations=[];
const previousURL='https://example.test/previous',destination='https://example.test/crash-recovery';
const initial={tabs:[{id:'old',title:'Previous page',url:previousURL,workspace:'w0'}],activeTabId:'old',activeWorkspace:'w0',workspaces:[{id:'w0',name:'Personal',color:'#a38ac6'}],bookmarks:[],history:[],downloads:[],agents:[],activity:[],settings:{theme:'light',accent:'purple',transparency:false,sidebarCollapsed:false,autoTidy:true},shields:{enabled:true,status:'ready',blocked:0},automation:{},missionOpen:false};
async function run(){
 const browser=await chromium.launch({headless:true});
 try{
  async function fresh(){
   const page=await browser.newPage({viewport:{width:1050,height:700},reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(state=>{
    window.__state=state;window.__calls=[];let listener;
    window.__pushState=()=>listener?.(JSON.parse(JSON.stringify(window.__state)));
    window.aster={onState:fn=>listener=fn,onCommand:()=>{},invoke:async(command,payload={})=>{
     window.__calls.push({command,payload,activeTabId:window.__state.activeTabId});
     if(command==='state:get')return JSON.parse(JSON.stringify(window.__state));
     if(command==='tab:new'){
      const tab={id:'new',title:'New tab',url:'aster://newtab',workspace:'w0'};window.__state.tabs.push(tab);window.__state.activeTabId=tab.id;window.__pendingNewTab=true;
      // Native state changed, but the renderer has not received its batched notification.
      return tab;
     }
     if(command==='tab:navigate'){const tab=window.__state.tabs.find(tab=>tab.id===window.__state.activeTabId);tab.url=payload.url;window.__pushState();return tab;}
     if(command==='suggestions:query')return {items:[]};
     return null;
    }};
   },initial);
   await page.goto(pathToFileURL(path.resolve(__dirname,'../src/renderer/index.html')).href);
   await page.waitForFunction(()=>document.querySelector('.tab.active')?.dataset.tabId==='old');
   return page;
  }
  async function check(name,fn){await fn();checks.push({name,...(observeBefore?{observed:true}:{passed:true})});console.log(observeBefore?'OBSERVED':'PASS',name);}
  await check('Address typing survives a delayed new-tab state and Enter navigates the actual new tab',async()=>{
   const page=await fresh();
   try{
    await page.locator('.new-tab').click();await page.waitForFunction(()=>window.__pendingNewTab);
    assert.equal(await page.locator('.tab.active').getAttribute('data-tab-id'),'old');
    await page.locator('#address').fill(destination);await page.evaluate(()=>window.__pushState());
    const valueAfterState=await page.locator('#address').inputValue(),focused=await page.evaluate(()=>document.activeElement.id==='address');
    await page.keyboard.press('Enter');
    const navigations=await page.evaluate(()=>window.__calls.filter(call=>call.command==='tab:navigate'));
    observations.push({case:'typed during pending state',valueAfterState,focused,navigations});
    if(!observeBefore){assert.equal(valueAfterState,destination);assert.equal(focused,true);assert.equal(navigations.length,1);assert.equal(navigations[0].payload.url,destination);assert.equal(navigations[0].activeTabId,'new');}
   }finally{await page.close();}
  });
  if(observeBefore)return;
  await check('An untouched prior URL clears and fresh tabs retain address autofocus',async()=>{
   const page=await fresh();
   try{
    assert.equal(await page.locator('#address').inputValue(),previousURL);
    await page.locator('.new-tab').click();await page.waitForFunction(()=>window.__pendingNewTab);
    // Focus without an input event must not mark the previous URL as a new edit.
    await page.locator('#address').focus();await page.evaluate(()=>window.__pushState());
    assert.equal(await page.locator('#address').inputValue(),'');assert.equal(await page.evaluate(()=>document.activeElement.id),'address');
   }finally{await page.close();}
  });
  await check('A blurred old draft does not leak into a fresh tab',async()=>{
   const page=await fresh();
   try{
    await page.locator('#address').fill('An abandoned draft');await page.locator('.more-button').focus();
    await page.locator('.new-tab').click();await page.waitForFunction(()=>window.__pendingNewTab);await page.locator('#address').focus();await page.evaluate(()=>window.__pushState());
    assert.equal(await page.locator('#address').inputValue(),'');assert.equal(await page.evaluate(()=>document.activeElement.id),'address');
   }finally{await page.close();}
  });
  await check('Submitted input is retired before another fresh tab is shown',async()=>{
   const page=await fresh();
   try{
    await page.locator('#address').fill(destination);await page.keyboard.press('Enter');await page.waitForFunction(()=>window.__calls.some(call=>call.command==='tab:navigate'));
    await page.locator('.new-tab').click();await page.waitForFunction(()=>window.__pendingNewTab);await page.locator('#address').focus();await page.evaluate(()=>window.__pushState());
    assert.equal(await page.locator('#address').inputValue(),'');assert.equal(await page.evaluate(()=>document.activeElement.id),'address');
   }finally{await page.close();}
  });
  await check('Selecting an address suggestion retires the edit before a native new-tab notification',async()=>{
   const page=await fresh();
   try{
    await page.locator('#address').fill(destination);await page.locator('#search-suggestions').waitFor({state:'visible'});await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>window.__calls.some(call=>call.command==='tab:navigate'));
    // A native shortcut can create a tab without blurring the renderer's retained address field.
    await page.evaluate(()=>window.aster.invoke('tab:new',{}));await page.locator('#address').focus();await page.evaluate(()=>window.__pushState());
    assert.equal(await page.locator('#address').inputValue(),'');assert.equal(await page.evaluate(()=>document.activeElement.id),'address');
   }finally{await page.close();}
  });
  assert.deepEqual(errors,[]);
 }finally{await browser.close();fs.writeFileSync(path.join(here,observeBefore?'address-transition-before.json':'address-transition-results.json'),JSON.stringify({scope:'Headless renderer with held state notification; no native app launch',checks,observations,errors},null,2));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
