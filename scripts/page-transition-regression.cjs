'use strict';
// Headless pixel checks for the actual native-page entry script. This does not
// launch/focus Electron, change the user's profile or certify native clipping.
const {chromium}=require('playwright');
const {PNG}=require('pngjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PAGE_ENTER_SCRIPT}=require('../src/main/page-transition.cjs');
const folder=path.resolve(process.env.ASTER_TEST_WORK||path.join(__dirname,'../work/page-transition'));fs.mkdirSync(folder,{recursive:true});
const OLD="if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.animate([{opacity:0.5},{opacity:1}],{duration:160,easing:'ease-out'})";
const checks=[],errors=[];let page,browser;
const fixture='<!doctype html><html style="background:white"><head><style>body{margin:0;height:100vh;background:#20252a;color:white}button{position:absolute;left:45%;top:45%;padding:16px}</style></head><body><button onclick="this.dataset.clicked=\'yes\'">Continue</button></body></html>';
function pixel(buffer,x=8,y=8){const png=PNG.sync.read(buffer),i=(y*png.width+x)*4;return [...png.data.subarray(i,i+3)];}
async function frameSamples(code,prefix){await page.setContent(fixture);await page.evaluate(code);const samples=[];for(let i=0;i<6;i++){const buffer=await page.screenshot();if(!i)fs.writeFileSync(path.join(folder,prefix+'.png'),buffer);samples.push({rgb:pixel(buffer),...(await page.evaluate(()=>({opacity:getComputedStyle(document.documentElement).opacity,scale:getComputedStyle(document.documentElement).scale})))});}return samples;}
async function check(name,fn){await fn();checks.push({name,passed:true});console.log('PASS',name);}
(async()=>{browser=await chromium.launch({headless:true});try{page=await browser.newPage({viewport:{width:960,height:640},reducedMotion:'no-preference'});page.on('pageerror',e=>errors.push(e.message));
 const before=await frameSamples(OLD,'opacity-before');const beforePeak=Math.max(...before.flatMap(s=>s.rgb));
 await check('Old page-opacity entry reproduces a bright flash over a white document canvas',async()=>{assert.ok(beforePeak>100,'Reproduction must contain a brightened dark-page frame');});
 const after=await frameSamples(PAGE_ENTER_SCRIPT,'scale-after');
 await check('The actual replacement entry script keeps dark-page pixels dark through every sampled frame',async()=>{for(const frame of after)assert.ok(Math.max(...frame.rgb)<60,'No dark-page sample may flash white');assert.ok(after.every(f=>Number(f.opacity)===1),'page opacity stays fully opaque');});
 await check('Rapid entry requests retain one owned animation and preserve site transforms',async()=>{await page.evaluate(()=>document.documentElement.style.transform='translateZ(0)');await page.evaluate(PAGE_ENTER_SCRIPT);await page.evaluate(PAGE_ENTER_SCRIPT);const current=await page.evaluate(()=>({count:document.documentElement.getAnimations().filter(a=>a.id==='aster-page-enter').length,transform:document.documentElement.style.transform,composite:document.documentElement.getAnimations().find(a=>a.id==='aster-page-enter').effect.composite}));assert.equal(current.count,1);assert.equal(current.transform,'translateZ(0px)');assert.equal(current.composite,'add');});
 await check('Reduce Motion cancels owned motion and does not start a new animation',async()=>{await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.evaluate(PAGE_ENTER_SCRIPT),false);assert.equal(await page.evaluate(()=>document.documentElement.getAnimations().filter(a=>a.id==='aster-page-enter').length),0);});
 await check('Native-page content remains operable after the transition',async()=>{await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(PAGE_ENTER_SCRIPT);await page.locator('button').click();assert.equal(await page.locator('button').getAttribute('data-clicked'),'yes');});
 await check('Remote shell underlay is square and matches the dark canvas',async()=>{await page.setContent('<style>'+fs.readFileSync(path.join(__dirname,'../src/renderer/style.css'),'utf8')+'</style><div id="app"><main id="content" class="content remote"></main></div>');await page.evaluate(()=>document.documentElement.classList.add('dark'));const style=await page.locator('#content').evaluate(e=>({background:getComputedStyle(e).backgroundColor,radius:getComputedStyle(e).borderRadius}));assert.equal(style.background,'rgb(0, 0, 0)');assert.equal(style.radius,'0px');});
 fs.writeFileSync(path.join(folder,'results.json'),JSON.stringify({scope:'Current main-page transition script executed in headless Chromium; native clipping/window presentation remains a separate check',before:{samples:before,peak:beforePeak},after:{samples:after},checks,errors,passed:true},null,2));
 }finally{await browser.close();}})().catch(e=>{errors.push(e.stack);fs.writeFileSync(path.join(folder,'failure.json'),JSON.stringify({checks,errors,passed:false},null,2));console.error(e.stack);process.exitCode=1;});
