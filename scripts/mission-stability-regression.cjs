'use strict';
// Headless normal-motion renderer check; no Electron or native app control.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const here=path.resolve(process.env.ASTER_TEST_WORK||path.join(__dirname,'../work/mission-stability'));fs.mkdirSync(here,{recursive:true});const observeBefore=process.argv.includes('--observe-before'),checks=[],errors=[];
const state={tabs:Array.from({length:8},(_,i)=>({id:'t'+i,title:'Article '+i,url:'https://example.test/'+i,workspace:i<6?'w0':'w1'})),activeTabId:'t0',activeWorkspace:'w0',workspaces:[{id:'w0',name:'Personal',color:'#a38ac6'},{id:'w1',name:'Work',color:'#709bb1'}],bookmarks:[],history:[],downloads:[],agents:[],activity:[],settings:{theme:'light',accent:'purple',transparency:false,sidebarCollapsed:false,autoTidy:true},shields:{enabled:true,status:'ready',blocked:0},automation:{},missionOpen:true};
async function run(){
 const browser=await chromium.launch({headless:true});let observation;
 try{
  const page=await browser.newPage({viewport:{width:1050,height:700},reducedMotion:'no-preference'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(initial=>{
   window.__state=initial;let listener;
   window.__pushState=()=>listener?.(JSON.parse(JSON.stringify(window.__state)));
   window.aster={onState:fn=>listener=fn,onCommand:()=>{},invoke:async(command,payload={})=>{
    if(command==='state:get')return JSON.parse(JSON.stringify(window.__state));
    if(command==='ui:mission'){window.__state.missionOpen=payload.open;window.__pushState();}
    if(command==='tab:activate'){window.__state.activeTabId=payload.id;window.__pushState();}
    if(command==='suggestions:query')return {items:[]};
    return null;
   }};
  },state);
  await page.goto(pathToFileURL(path.resolve(__dirname,'../src/renderer/index.html')).href);
  await page.waitForFunction(()=>[...document.querySelectorAll('.mission-card')].every(e=>Number(getComputedStyle(e).opacity)>.99)&&document.querySelectorAll('.mission-card').length===4);
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion:reduce)').matches),false);
  observation=await page.evaluate(async()=>{
   const first=document.querySelector('.mission-card'),last=document.querySelector('.mission-card:last-child');first.focus();const samples=[];
   for(let i=1;i<=12;i++){
    window.__state.shields.blocked=i;
    window.__state.vpn={status:'checking',checkedAt:i};
    window.__state.tabs[0].volume=i/12; // The Mission card does not display volume.
    window.__pushState();
    await new Promise(resolve=>setTimeout(resolve,60));
    const current=document.querySelector('.mission-card'),tail=document.querySelector('.mission-card:last-child');
    samples.push({sameFirst:current===first,sameLast:tail===last,firstOpacity:Number(getComputedStyle(current).opacity),lastOpacity:Number(getComputedStyle(tail).opacity),sameFocusedElement:document.activeElement===first});
   }
   return {intervalMs:60,samples};
  });
  await page.screenshot({path:path.join(here,observeBefore?'mission-stats-before.png':'mission-stats-stable.png')});
  if(observeBefore)return;
  async function check(name,fn){await fn();checks.push({name,passed:true});console.log('PASS',name);}
  await check('Twelve normal-motion stats pushes retain visible card DOM and exact keyboard focus',async()=>{
   assert.equal(observation.samples.length,12);
   for(const sample of observation.samples){assert.equal(sample.sameFirst,true);assert.equal(sample.sameLast,true);assert.equal(sample.sameFocusedElement,true);assert.ok(sample.firstOpacity>.99);assert.ok(sample.lastOpacity>.99);}
  });
  await check('Card title, thumbnail and active-tab updates render and retain a valid focus target',async()=>{
   await page.evaluate(()=>{window.__priorCard=document.querySelector('[data-mission-tab="t0"]');window.__state.tabs[0].title='Updated first article';window.__pushState();});
   assert.equal(await page.locator('[data-mission-tab="t0"]').getAttribute('aria-label'),'Open Updated first article');
   assert.equal(await page.evaluate(()=>document.querySelector('[data-mission-tab="t0"]')===window.__priorCard),false);
   assert.equal(await page.evaluate(()=>document.activeElement.dataset.missionTab),'t0');
   const thumbnail='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="teal"/></svg>').toString('base64');
   await page.evaluate(thumbnail=>{window.__state.tabs[0].thumbnail=thumbnail;window.__pushState();},thumbnail);
   assert.equal(await page.locator('[data-mission-tab="t0"] img').getAttribute('src'),thumbnail);
   await page.evaluate(()=>{window.__state.activeTabId='t1';window.__pushState();});
   assert.equal(await page.locator('[data-mission-tab="t1"]').evaluate(el=>el.classList.contains('active')),true);
  });
  await check('Workspace filters, query filtering and page changes still update cards',async()=>{
   await page.evaluate(()=>{window.__state.workspaces[0].name='Renamed personal';window.__state.workspaces[0].color='#112233';window.__pushState();});
   assert.equal(await page.locator('.mission-space[data-id="w0"]').textContent(),'Renamed personal');
   await page.locator('#mission-filter').fill('Updated first');assert.equal(await page.locator('.mission-card').count(),1);
   await page.locator('#mission-filter').fill('');assert.equal(await page.locator('.mission-card').count(),4);
   await page.locator('[data-action="mission-next"]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.mission-card').first().getAttribute('data-mission-tab'),'t4');
   await page.locator('[data-action="mission-page"][data-page="0"]').focus();await page.keyboard.press('Enter');
   await page.locator('.mission-space[data-id="w1"]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.mission-card').count(),2);assert.equal(await page.locator('.mission-card').first().getAttribute('data-mission-tab'),'t6');
   await page.locator('.mission-space[data-id="all"]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.mission-card').count(),4);
  });
  await check('Resize updates geometry and cached cards reopen correctly from hidden',async()=>{
   await page.setViewportSize({width:1450,height:900});
   await page.waitForFunction(()=>document.querySelector('.mission-grid').style.getPropertyValue('--mission-columns')==='4'&&document.querySelectorAll('.mission-card').length===8);
   await page.evaluate(()=>{window.__reopenCard=document.querySelector('.mission-card');window.__state.missionOpen=false;window.__pushState();});assert.equal(await page.locator('#mission').isHidden(),true);
   await page.evaluate(()=>{window.__state.missionOpen=true;window.__pushState();});assert.equal(await page.locator('#mission').isVisible(),true);
   assert.equal(await page.evaluate(()=>document.querySelector('.mission-card')===window.__reopenCard),true);
   await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.mission-card')).opacity)>.99);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'mission-filter');
  });
  assert.deepEqual(errors,[]);
 }finally{
  await browser.close();fs.writeFileSync(path.join(here,observeBefore?'mission-stability-before.json':'mission-stability-results.json'),JSON.stringify({scope:'Headless current renderer, mocked preload, normal motion',observation,checks,errors},null,2));
 }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
