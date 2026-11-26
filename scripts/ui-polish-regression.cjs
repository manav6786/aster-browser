'use strict';
// Live renderer/main integration with an isolated profile and local media.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const artifacts=path.resolve(process.env.ASTER_TEST_WORK||path.join(root,'work','ui-polish'));
fs.mkdirSync(artifacts,{recursive:true});
const profile=fs.mkdtempSync(path.join(artifacts,'profile-'));
const results=[],errors=[],notes=[];let app,page,server,origin,launch;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.aster.invoke(command,payload),{command,payload});
const state=()=>invoke('state:get');
const active=async()=>{const s=await state();return s.tabs.find(t=>t.id===s.activeTabId);};
async function until(fn,label,timeout=16000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await pause(50);}throw new Error('Timed out: '+label);}
async function check(name,fn){await fn();results.push({name,passed:true});console.log('PASS',name);}
async function click(target){const el=typeof target==='string'?page.locator(target).first():target;await until(async()=>{try{await el.waitFor({state:'visible',timeout:700});await el.scrollIntoViewIfNeeded({timeout:700});return await el.evaluate(el=>{const r=el.getBoundingClientRect();return r.width>8&&r.height>8&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});}catch{return false;}},'visible hit-tested control');await el.click();}
async function nativeKey(keyCode,modifiers=[]){await app.evaluate(({webContents},{keyCode,modifiers})=>{const wc=webContents.getFocusedWebContents();if(!wc)throw new Error('No native focused webContents');wc.sendInputEvent({type:'keyDown',keyCode,modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers});},{keyCode,modifiers});}
async function rendered(){const tab=await active();await page.waitForFunction(tab=>{const el=document.querySelector('.tab[aria-selected="true"]');return el?.dataset.tabId===tab.id&&el.title.endsWith('\n'+tab.url);},tab);}
async function route(name){await click(`.sidebar-tools [data-route="${name}"]`);await until(async()=>(await active())?.url==='aster://'+name,name);await rendered();}
async function navigate(url){await page.locator('#address').fill(url);await page.locator('#address').press('Enter');await until(async()=>(await active())?.url===url,'navigate');await rendered();}
async function screenshot(name){await pause(180);await page.screenshot({path:path.join(artifacts,name+'.png')});}
async function main(){
  server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Live media studio</title><style>body{font:18px system-ui;padding:35px;background:#eef4ff}button{padding:16px 26px}video{width:260px;height:150px;background:#123;margin:8px}canvas{display:none}</style><h1>Live media studio</h1><button id="play">Play two videos</button><div><video id="first" title="Color orbit" muted playsinline></video><video id="second" title="Soft waves" muted playsinline></video></div><canvas id="art" width="320" height="180"></canvas><script>const c=document.querySelector('canvas'),g=c.getContext('2d');let n=0;function draw(){g.fillStyle='#182b55';g.fillRect(0,0,320,180);g.fillStyle='#87ddc3';g.beginPath();g.arc(160+Math.sin(n++/20)*70,90,35,0,Math.PI*2);g.fill();requestAnimationFrame(draw)}draw();document.querySelector('#play').onclick=async()=>{for(const v of document.querySelectorAll('video')){v.srcObject=c.captureStream(15);await v.play();}};</script>`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  launch={...(process.env.ASTER_EXECUTABLE?{executablePath:path.resolve(process.env.ASTER_EXECUTABLE),args:[]}:{args:[root]}),env:{...process.env,ASTER_DATA_DIR:profile,ASTER_PORT:'0',ASTER_DISABLE_FILTER_UPDATES:'1'},timeout:60000};
  app=await _electron.launch(launch);page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));app.process().stderr.on('data',data=>fs.appendFileSync(path.join(artifacts,'stderr.log'),data));
  await page.waitForFunction(()=>window.aster&&document.querySelector('#home-search'));
  await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});const w=BrowserWindow.getAllWindows()[0];w.setSize(1050,700);w.show();w.focus();w.webContents.focus();});
  await check('Footer removed; normal and compact native pages share the flush DOM viewport',async()=>{
    assert.equal(await page.locator('.statusbar').count(),0);assert.equal((await state()).settings.searchEngine,'google');await navigate(origin+'/media');
    for(const collapsed of [false,true,false]){
      if(!!(await state()).settings.sidebarCollapsed!==collapsed)await click('#sidebar-toggle');await until(async()=>!!(await state()).settings.sidebarCollapsed===collapsed,'sidebar mode');await pause(650);
      const rect=await page.locator('#content').boundingBox(),native=await app.evaluate(({BrowserWindow},url)=>{const w=BrowserWindow.getAllWindows()[0],v=w.contentView.children.find(v=>v.webContents?.getURL()===url);return v?.getBounds();},origin+'/media');
      assert.equal(Math.round(rect.x),collapsed?76:246);assert.equal(Math.round(rect.y),86);assert.equal(Math.round(rect.y+rect.height),700);assert.equal(Math.round(rect.x+rect.width),1050);assert.deepEqual(native,{x:Math.round(rect.x),y:86,width:Math.round(rect.width),height:Math.round(rect.height)});
    }
  });
  await check('Every workspace wraps within three columns; long labels and Add remain accessible',async()=>{
    const names=['Long Research Workspace Alpha','Reading and Notes','Design Playground','Quiet Studio','Future Ideas','Long Engineering Workspace Beta','Saved Reading and Articles','Deep Research Library','Media and Sound Studies','Quiet Personal Archive'];
    for(const name of names){await click('#space-add');await page.locator('#dialog-name').fill(name);await click('#dialog-form button[type="submit"]');await page.locator('#dialog').waitFor({state:'hidden'});await until(async()=>(await state()).workspaces.some(w=>w.name===name),'space saved');}
    await until(async()=>(await page.locator('#spaces [data-action="workspace"]').count())===(await state()).workspaces.length,'all workspaces in selector');
    const geometry=await page.locator('#spaces').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,labels:[...el.querySelectorAll('.space-label')].map(n=>({text:n.textContent,scroll:n.scrollWidth,width:n.clientWidth}))}));assert.equal(geometry.columns,3);assert.ok(geometry.scrollWidth<=geometry.clientWidth+1);for(const label of geometry.labels)assert.ok(label.scroll<=label.width+1,label.text+' does not clip');const rowBounds=await page.locator('#spaces .space-chip').evaluateAll(cells=>cells.flatMap(cell=>{const label=cell.querySelector('.space-label');if(!label)return[];const c=cell.getBoundingClientRect(),l=label.getBoundingClientRect();return[{name:label.textContent,inside:l.top>=c.top-1&&l.bottom<=c.bottom+1}]}));for(const row of rowBounds)assert.ok(row.inside,row.name+' stays inside its grid row');
    const spaces=(await state()).workspaces;for(const space of spaces){await click(`#spaces [data-id="${space.id}"]`);await until(async()=>(await state()).activeWorkspace===space.id,'select '+space.name);await rendered();}
    await screenshot('workspaces-expanded');await click('#sidebar-toggle');await until(async()=>(await state()).settings.sidebarCollapsed,'compact');await pause(650);assert.equal(await page.locator('#spaces').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1);await click('#space-add');await page.locator('#dialog').waitFor({state:'visible'});await click('[data-action="dialog-close"]');await page.locator('#dialog').waitFor({state:'hidden'});await screenshot('workspaces-compact');await click('#sidebar-toggle');await until(async()=>!(await state()).settings.sidebarCollapsed,'expanded');
  });
  await check('Absolute black theme, six persisted accents, accessible color keyboard navigation',async()=>{
    await route('settings');await click('[data-action="theme"][data-value="dark"]');await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));
    for(const color of ['purple','blue','teal','green','amber','rose']){await click(`[data-action="accent"][data-value="${color}"]`);await until(async()=>(await state()).settings.accent===color,'accent '+color);await page.waitForFunction(color=>document.documentElement.dataset.accent===color,color);}
    await page.locator('#accent-rose').focus();await page.keyboard.press('ArrowRight');await until(async()=>(await state()).settings.accent==='purple','radio keyboard wraps');await click('#accent-teal');await until(async()=>(await state()).settings.accent==='teal','teal');
    for(const selector of ['#app','#content','.internal-page'])assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)',selector+' has a #000 base');
    assert.ok(await page.locator('.internal-page').evaluate(el=>el.scrollHeight>el.clientHeight));assert.ok(await page.locator('.internal-page').evaluate(el=>el.scrollWidth<=el.clientWidth));await screenshot('true-black-settings');
  });
  await check('Transparency toggles real native glass while page surfaces stay black',async()=>{
    const before=(await state()).nativeGlass;assert.equal(before.enabled,false);await click('[data-setting="transparency"]');await until(async()=>(await state()).settings.transparency===true,'transparency on');
    const reduced=await app.evaluate(({nativeTheme})=>nativeTheme.prefersReducedTransparency);await until(async()=>{const s=await state();return !s.nativeGlass.available||reduced||s.nativeGlass.enabled;},'native glass update');const on=(await state()).nativeGlass;notes.push({nativeGlassBefore:before,nativeGlassOn:on,reducedTransparency:reduced});if(on.available&&!reduced){assert.equal(on.enabled,true);assert.ok(on.viewCount>0);}assert.equal(await page.locator('.internal-page').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)');await screenshot('native-glass-settings');
    await click('[data-setting="transparency"]');await until(async()=>(await state()).settings.transparency===false&&(await state()).nativeGlass.enabled===false,'native glass off');
  });
  await check('VPN panel reports the real provider state and refreshes without altering the network',async()=>{
    await click('[data-command="vpn:refresh"]');await until(async()=>(await state()).vpn?.status&&!(await state()).vpn.status.startsWith('checking'),'provider status');const vpn=(await state()).vpn;notes.push({vpnStatus:vpn.status,connected:vpn.connected,modeKind:vpn.modeKind});assert.equal(await page.locator('.vpn-card').getAttribute('data-vpn-status'),vpn.status);if(vpn.connected===true){assert.equal(vpn.status,'connected');assert.equal(vpn.modeKind,'tunnel');}else assert.equal(await page.locator('.vpn-badge.connected').count(),0);if(!vpn.installed)assert.ok(await page.locator('[data-command="vpn:install"]').isVisible());await screenshot('vpn-provider-state');
  });
  await check('Mission stays usable with 150 extra internal tabs and bounded keyboard pagination',async()=>{
    const ids=[];for(let i=0;i<150;i++)ids.push((await invoke('tab:new')).id);
    await invoke('ui:mission',{open:true});await page.locator('#mission').waitFor({state:'visible'});
    assert.ok(await page.locator('.mission-page-dots button').count()<=7);
    const footer=await page.locator('.mission-footer').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(footer.scroll<=footer.width+1);
    assert.equal(await page.locator('#mission').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)');
    await page.locator('.mission-page-dots button').last().click();await page.locator('.mission-card').first().waitFor({state:'visible'});
    await until(async()=>await page.locator('.mission-card').evaluateAll(cards=>cards.every(c=>Number(getComputedStyle(c).opacity)>.98)),'settled mission card entry');await screenshot('mission-scale');
    await page.locator('.mission-card').first().focus();await page.keyboard.press('Space');await page.locator('#mission').waitFor({state:'hidden'});
    for(const id of ids)await invoke('tab:close',{id});
  });
  await check('Per-tab audio controls change real tab volume/mute and expose each video for native PiP',async()=>{
    await navigate(origin+'/media');await until(async()=>(await active())?.title==='Live media studio','fixture loaded');
    await app.evaluate(async({webContents},url)=>{const wc=webContents.getAllWebContents().find(w=>w.getURL()===url),r=await wc.executeJavaScript(`(()=>{const el=document.querySelector('#play'),r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);if(!r.hit)throw new Error('Fixture play not hit-testable');wc.focus();wc.sendInputEvent({type:'mouseDown',x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1});},origin+'/media');
    const id=(await state()).activeTabId;await until(async()=>(await invoke('media:get',{id})).videoCount===2,'two live videos');await click(`#tab-audio-${id}`);await page.locator('#media-volume').waitFor({state:'visible'});await until(async()=>(await page.locator('#media-video-select option').count())===2,'video picker populated');
    const slider=page.locator('#media-volume'),box=await slider.boundingBox();await page.mouse.click(box.x+box.width*.32,box.y+box.height/2);await until(async()=>Math.abs((await invoke('media:get',{id})).volume-.32)<.06,'volume command applied');await click('#media-mute');await until(async()=>(await invoke('media:get',{id})).muted,'muted');await click('#media-mute');await until(async()=>!(await invoke('media:get',{id})).muted,'unmuted');
    await page.locator('#media-video-select').selectOption({index:1});await until(async()=>!(await page.locator('#media-pip').isDisabled()),'PiP enabled');await click('#media-pip');await until(async()=>(await invoke('media:get',{id})).pipActive,'real PiP entered');await until(async()=>(await page.locator('#media-pip span').textContent()).includes('Return'),'PiP return label');await screenshot('audio-and-pip');await click('#media-pip');await until(async()=>!(await invoke('media:get',{id})).pipActive,'PiP exited');await page.locator('#media-volume').focus();await nativeKey('Escape');await page.locator('.audio-popover').waitFor({state:'hidden'});await until(async()=>await page.evaluate(id=>document.activeElement.id==='tab-audio-'+id,id),'audio trigger focus restored');
  });
  await check('Native private shortcut and reduced-motion interactions keep the single control usable',async()=>{
    await nativeKey('N',['meta','shift']);await until(async()=>(await active())?.private,'native private tab');await rendered();await page.locator('.private-badge').waitFor({state:'visible'});await page.emulateMedia({reducedMotion:'reduce'});await click('.more-button');await page.locator('#floating').waitFor({state:'visible'});await page.keyboard.press('Escape');await page.locator('#floating').waitFor({state:'hidden'});await click('.new-tab');await rendered();assert.equal(await page.locator('#interaction-motion-layer>*').count(),0);assert.equal(await page.locator('button[data-action="sidebar"]').count(),1);await page.emulateMedia({reducedMotion:'no-preference'});
  });
  await check('Appearance and workspace controls survive a complete app restart',async()=>{
    const saved=await state();await app.close();app=null;app=await _electron.launch(launch);page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.aster);await until(async()=>(await state()).settings.accent===saved.settings.accent,'accent restored');const restored=await state();assert.equal(restored.settings.theme,saved.settings.theme);assert.equal(restored.settings.transparency,saved.settings.transparency);assert.equal(restored.workspaces.length,saved.workspaces.length);assert.equal(await page.locator('.statusbar').count(),0);assert.equal(await page.locator('button[data-action="sidebar"]').count(),1);
  });
  assert.deepEqual(errors,[]);
}
main().catch(async error=>{errors.push(error.stack);console.error(error.stack);process.exitCode=1;try{await page?.screenshot({path:path.join(artifacts,'failure.png')});}catch{}}).finally(async()=>{fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify({passed:!process.exitCode,results,errors,notes,profile,checkedAt:new Date().toISOString()},null,2));await app?.close();server?.close();});
