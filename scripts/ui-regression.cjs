'use strict';
// Real Electron renderer interactions against an isolated profile. No window.aster mock.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(process.env.ASTER_TEST_WORK || path.join(root, 'work', 'ui'));
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, 'ui-profile-'));
let app, server, window;
const results = [], errors = [];
const state = () => window.evaluate(() => window.aster.invoke('state:get'));
const active = async () => { const s = await state(); return s.tabs.find(t => t.id === s.activeTabId); };
const invoke = (command, payload = {}) => window.evaluate(({ command, payload }) => window.aster.invoke(command, payload), { command, payload });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await pause(70); }
  throw new Error('Timed out: ' + description);
}
async function check(name, fn) { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
// CDP keyboard dispatch bypasses Electron's before-input-event. Exercise native
// accelerators through the actual focused webContents instead of action IPC.
async function nativeKey(keyCode, modifiers = []) {
  await app.evaluate(({webContents}, {keyCode, modifiers})=>{
    const wc=webContents.getFocusedWebContents();
    if(!wc)throw new Error('No focused native webContents');
    wc.sendInputEvent({type:'keyDown',keyCode,modifiers});
    wc.sendInputEvent({type:'keyUp',keyCode,modifiers});
  },{keyCode,modifiers});
}
async function click(selector) {
  const locator = window.locator(selector).first();
  await until(async () => {
    try {
      await locator.waitFor({ state: 'visible', timeout: 1000 });
      await locator.scrollIntoViewIfNeeded({ timeout: 1000 });
      const box = await locator.boundingBox();
      if (!box || box.width < 8 || box.height < 8) return false;
      return await locator.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); });
    } catch { return false; }
  }, selector + ' visible bounds and hit-test');
  await locator.click();
}
async function route(name) { await click(`.sidebar-tools [data-route="${name}"]`); await until(async () => (await active())?.url === 'aster://' + name, name); }
async function navigate(url) { await window.locator('#address').fill(url); await window.locator('#address').press('Enter'); await until(async () => (await active())?.url === url, 'navigate ' + url); }
async function main() {
  server = http.createServer((req, res) => { res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>UI ${req.url}</title><style>body{font:20px system-ui;padding:35px;height:2500px}</style><h1>Browser UI fixture ${req.url}</h1><a id="next" href="/next">Next page</a><input id="fixture-input"><p>Find this phrase</p><button id="change" onclick="document.title='Changed title'">Update title</button>`); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const launchOptions = { ...(process.env.ASTER_EXECUTABLE ? {executablePath:path.resolve(process.env.ASTER_EXECUTABLE),args:[]} : {args:[root]}), env:{...process.env,ASTER_DATA_DIR:profile,ASTER_PORT:'0',ASTER_DISABLE_FILTER_UPDATES:'1'}, timeout:60000 };
  app = await _electron.launch(launchOptions);
  window = await app.firstWindow();
  window.on('pageerror',e=>errors.push(e.message));
  app.process().stderr.on('data',d=>fs.appendFileSync(path.join(artifacts,'ui-stderr.log'),d));
  await window.waitForFunction(()=>window.aster && document.querySelector('#home-search'));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,700));
  await check('Compact sidebar can always be reopened by a visible, hit-tested toolbar button', async()=>{
    for(let i=0;i<4;i++){await click('#sidebar-toggle');await until(async()=>(await state()).settings.sidebarCollapsed,'collapsed');await click('#sidebar-toggle');await until(async()=>!(await state()).settings.sidebarCollapsed,'expanded');}
  });
  await check('Address entry opens a real page; sidebar toggles over its native view',async()=>{
    await navigate(origin+'/one');
    await until(async()=>(await active())?.title==='UI /one','page title');
    await click('#sidebar-toggle');await until(async()=>(await state()).settings.sidebarCollapsed,'collapsed over website');
    await click('#sidebar-toggle');await until(async()=>!(await state()).settings.sidebarCollapsed,'expanded over website');
  });
  await check('Actual browser back and forward buttons traverse navigation history',async()=>{
    await navigate(origin+'/two');await click('#back');await until(async()=>(await active())?.url===origin+'/one','back');
    await click('#forward');await until(async()=>(await active())?.url===origin+'/two','forward');
  });
  await check('Menu and shield popovers open above a website and Escape restores it',async()=>{
    await click('.more-button');await window.locator('#floating').waitFor({state:'visible'});await window.keyboard.press('Escape');await window.locator('#floating').waitFor({state:'hidden'});
    await click('#shields-button');await window.locator('#floating .shield-popover').waitFor({state:'visible'});await window.keyboard.press('Escape');await window.locator('#floating').waitFor({state:'hidden'});
    const visible=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents && v.webContents.getURL().startsWith('http')).some(v=>v.getVisible()));assert.equal(visible,true);
  });
  await check('Command palette supports keyboard selection and disappears after navigation',async()=>{
    await window.keyboard.press('Meta+k');await window.locator('#palette').waitFor({state:'visible'});await window.locator('#palette-input').fill('Settings');await window.keyboard.press('ArrowDown');await window.keyboard.press('ArrowUp');await window.keyboard.press('Enter');
    await until(async()=>(await active())?.url==='aster://settings','palette settings');await window.locator('#palette').waitFor({state:'hidden'});
  });
  await check('Light/dark settings and sidebar setting remain usable at minimum window size',async()=>{
    await click('[data-action="theme"][data-value="dark"]');await window.waitForFunction(()=>document.documentElement.classList.contains('dark'));await pause(250);await window.screenshot({path:path.join(artifacts,'settings-dark.png')});
    await click('[data-action="theme"][data-value="light"]');await window.waitForFunction(()=>!document.documentElement.classList.contains('dark'));
    await click('[data-setting="sidebarCollapsed"]');await until(async()=>(await state()).settings.sidebarCollapsed,'setting collapsed');await click('#sidebar-toggle');await until(async()=>!(await state()).settings.sidebarCollapsed,'reopen settings');
    assert.equal(await window.locator('text=Trackpad Mission Control').count(),0);
  });
  await check('Create, rename, select and delete workspaces through their forms',async()=>{
    await click('.internal-page [data-action="workspace-new"]');await window.locator('#dialog-name').fill('QA Fourth');await window.locator('#dialog-form button[type=submit]').click();await window.locator('#dialog').waitFor({state:'hidden'});
    const s=await state(), workspace=s.workspaces.find(w=>w.name==='QA Fourth');assert.ok(workspace);
    await click(`[data-action="workspace-rename"][data-id="${workspace.id}"]`);await window.locator('#dialog-name').fill('QA Renamed');await window.locator('#dialog-form button[type=submit]').click();await window.locator('#dialog').waitFor({state:'hidden'});
    await click(`.workspace-name[data-id="${workspace.id}"]`);await until(async()=>(await state()).activeWorkspace===workspace.id,'select fourth workspace');await window.locator(`#spaces [data-id="${workspace.id}"]`).waitFor({state:'visible'});
    await route('settings');await click(`[data-action="workspace-delete"][data-id="${workspace.id}"]`);await window.locator('#dialog-form button[type=submit]').click();await until(async()=>!(await state()).workspaces.some(w=>w.id===workspace.id),'remove workspace');
  });
  await check('Add/remove favorites and preserve text entry through live state updates',async()=>{
    await click('.new-tab');await window.locator('.favorite-add').waitFor({state:'visible'});await click('.favorite-add');await window.locator('#dialog-title').fill('QA Favorite');await window.locator('#dialog-url').fill(origin+'/favorite');await window.locator('#dialog-form button[type=submit]').click();await window.locator('#dialog').waitFor({state:'hidden'});
    assert.ok((await state()).bookmarks.some(b=>b.title==='QA Favorite'));
    await window.locator('#home-search').fill('keep my unfinished search');await invoke('bookmark:toggle',{url:origin+'/force-newtab-update',title:'Another saved page'});await pause(100);assert.equal(await window.locator('#home-search').inputValue(),'keep my unfinished search');
    await route('bookmarks');await window.locator('#page-filter').fill('QA Favorite');assert.equal(await window.locator('.list-row').count(),1);await click('[data-action="bookmark-remove"]');await until(async()=>!(await state()).bookmarks.some(b=>b.title==='QA Favorite'),'bookmark removal');
  });
  await check('Native palette and Mission shortcuts replace an existing modal cleanly',async()=>{
    await click('.new-tab');await click('.favorite-add');await window.locator('#dialog').waitFor({state:'visible'});
    await nativeKey('K',['meta']);await window.locator('#palette').waitFor({state:'visible'});await window.locator('#dialog').waitFor({state:'hidden'});await window.waitForFunction(()=>document.activeElement.id==='palette-input');
    await nativeKey('M',['meta','shift']);await window.locator('#mission').waitFor({state:'visible'});await window.locator('#palette').waitFor({state:'hidden'});await window.locator('#dialog').waitFor({state:'hidden'});
    await nativeKey('Escape');await window.locator('#mission').waitFor({state:'hidden'});
    await navigate(origin+'/modal');await until(async()=>(await active())?.title==='UI /modal','modal fixture loaded');
    await nativeKey('M',['meta','shift']);await window.locator('#mission').waitFor({state:'visible'});await nativeKey('K',['meta']);await window.locator('#palette').waitFor({state:'visible'});await window.locator('#mission').waitFor({state:'hidden'});
    await until(async()=>await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents?.getURL().startsWith('http')).every(v=>!v.getVisible())),'palette hides native web view after Mission');
    await nativeKey('Escape');await window.locator('#palette').waitFor({state:'hidden'});
    const remote=(await state()).activeTabId;await window.locator(`.tab[data-tab-id="${remote}"]`).click({button:'right'});await nativeKey('T',['meta']);
    await until(async()=>(await state()).activeTabId!==remote,'new tab cancels pending context menu');await window.waitForFunction(()=>document.querySelector('#home-search'));
    await window.locator('#floating').waitFor({state:'hidden'});await pause(200);assert.equal(await window.locator('#floating').isVisible(),false);
  });
  await check('Native tab shortcuts open, close, restore, and cycle tabs',async()=>{
    await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});const win=BrowserWindow.getAllWindows()[0];win.show();win.focus();win.webContents.focus();});
    await window.waitForFunction(()=>document.hasFocus());
    const start=(await state()).tabs.length;
    await nativeKey('T',['meta']);await until(async()=>(await state()).tabs.length===start+1,'Cmd+T');await window.waitForFunction(()=>document.activeElement.id==='address');
    const fresh=(await state()).activeTabId;await nativeKey('W',['meta']);await until(async()=>!(await state()).tabs.some(t=>t.id===fresh),'Cmd+W');
    await nativeKey('T',['meta','shift']);await until(async()=>(await state()).tabs.length===start+1,'Cmd+Shift+T');
    const before=(await state()).activeTabId;await nativeKey('Tab',['control']);await until(async()=>(await state()).activeTabId!==before,'Ctrl+Tab');
    const next=(await state()).activeTabId;await nativeKey('Tab',['control','shift']);await until(async()=>(await state()).activeTabId!==next,'Ctrl+Shift+Tab');
  });
  await check('Close and restore tab through real sidebar/menu controls',async()=>{
    await click('.new-tab');await navigate(origin+'/restore');const id=(await state()).activeTabId;await window.locator(`.tab[data-tab-id="${id}"]`).hover();await click(`[data-action="close-tab"][data-id="${id}"]`);await until(async()=>!(await state()).tabs.some(t=>t.id===id),'closed');
    await click('.more-button');await click('#floating [data-action="restore"]');await until(async()=>(await state()).tabs.some(t=>t.url===origin+'/restore'),'restored');
    await click('.new-tab');const keyboardClose=(await state()).activeTabId;await window.locator(`[data-action="close-tab"][data-id="${keyboardClose}"]`).focus();await window.keyboard.press('Enter');await until(async()=>!(await state()).tabs.some(t=>t.id===keyboardClose),'keyboard close button');await window.locator(`.tab[data-tab-id="${keyboardClose}"]`).waitFor({state:'detached'});
  });
  await check('Pin and mute via tab context menu; context menu closes after action',async()=>{
    const id=(await state()).activeTabId;await window.locator(`.tab[data-tab-id="${id}"]`).click({button:'right'});await click('#floating [data-action="pin-tab"]');await until(async()=>(await state()).tabs.find(t=>t.id===id)?.pinned,'pinned');await window.locator('#floating').waitFor({state:'hidden'});
    await window.locator(`.tab[data-tab-id="${id}"]`).click({button:'right'});await click('#floating [data-action="mute"]');await until(async()=>(await state()).tabs.find(t=>t.id===id)?.muted,'muted');await window.locator('#floating').waitFor({state:'hidden'});
  });
  await check('Mission Control paginates, searches, reflows after close and changes workspace by drag',async()=>{
    for(let i=0;i<9;i++)await invoke('tab:new',{url:origin+'/mission-'+i});
    await click('.mission-button');await window.locator('#mission').waitFor({state:'visible'});const first=await window.locator('.mission-card').first().getAttribute('data-mission-tab');await click('#mission [data-action="mission-next"]');await until(async()=>(await window.locator('.mission-card').first().getAttribute('data-mission-tab'))!==first,'next mission page');
    await click('#mission .mission-close');await pause(100);assert.ok(await window.locator('.mission-card').count());
    const keyboardClose=await window.locator('.mission-card').first().getAttribute('data-mission-tab');await window.locator('#mission .mission-close').first().focus();await window.keyboard.press('Enter');await until(async()=>!(await state()).tabs.some(t=>t.id===keyboardClose),'Mission keyboard close button');await window.locator('#mission').waitFor({state:'visible'});
    await window.locator('#mission-filter').fill('mission-8');assert.equal(await window.locator('.mission-card').count(),1);await window.locator('#mission-filter').fill('');
    const card=window.locator('.mission-card').first(),id=await card.getAttribute('data-mission-tab');await card.dragTo(window.locator('#mission [data-drop-workspace="work"]'));await until(async()=>(await state()).tabs.find(t=>t.id===id)?.workspace==='work','mission drag to work');
    await window.screenshot({path:path.join(artifacts,'mission-min-window.png')});await window.keyboard.press('Escape');await window.locator('#mission').waitFor({state:'hidden'});
  });
  await check('Modal keyboard focus stays within its dialog and Escape restores page focus',async()=>{
    await window.keyboard.press('Meta+k');await window.locator('#palette').waitFor({state:'visible'});
    await window.locator('#palette-input').focus();await window.keyboard.press('Shift+Tab');assert.equal(await window.evaluate(()=>document.querySelector('#palette').contains(document.activeElement)),true);
    await window.keyboard.press('Escape');await window.locator('#palette').waitFor({state:'hidden'});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
    await until(async()=>String(await app.evaluate(({webContents})=>webContents.getFocusedWebContents()?.getURL())).startsWith(origin),'native page focus after Escape');
  });
  await check('Address shortcut from an open menu focuses the actual browser chrome',async()=>{
    await click('.more-button');await window.locator('#floating').waitFor({state:'visible'});await window.keyboard.press('Meta+l');
    await window.waitForFunction(()=>document.activeElement.id==='address');await window.locator('#floating').waitFor({state:'hidden'});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
    await until(async()=>String(await app.evaluate(({webContents})=>webContents.getFocusedWebContents()?.getURL())).startsWith('aster-ui://'),'native chrome focus after address shortcut');
    await window.keyboard.press('Escape');
  });
  await check('Native Find searches real page text and Escape returns focus to that page',async()=>{
    await navigate(origin+'/find');await until(async()=>(await active())?.title==='UI /find','find fixture loaded');
    await app.evaluate(({webContents},url)=>{global.__uiFindMatches=0;const wc=webContents.getAllWebContents().find(w=>w.getURL()===url);wc.on('found-in-page',(_e,result)=>{global.__uiFindMatches=result.matches;});},origin+'/find');
    await nativeKey('F',['meta']);await window.locator('#find-text').waitFor({state:'visible'});await window.locator('#find-text').fill('Find this phrase');
    await until(async()=>await app.evaluate(()=>global.__uiFindMatches>0),'real page find match');
    await click('#find-bar button[type="submit"]');await click('[data-action="find-prev"]');await window.locator('#find-text').focus();await nativeKey('Escape');await window.locator('#find-bar').waitFor({state:'hidden'});
    await until(async()=>String(await app.evaluate(({webContents})=>webContents.getFocusedWebContents()?.getURL()))===origin+'/find','page focus after Find');
  });
  await check('A crashed page exposes a usable reload control and the browser survives recovery',async()=>{
    await click('.new-tab');await navigate(origin+'/crash-recovery');await until(async()=>(await active())?.title==='UI /crash-recovery','crash fixture loaded');
    await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).forcefullyCrashRenderer(),origin+'/crash-recovery');
    await window.locator('.error-page').waitFor({state:'visible'});assert.ok((await active()).error);await window.screenshot({path:path.join(artifacts,'page-crash-recovery.png')});
    await click('.error-page [data-action="reload"]');await until(async()=>!(await active())?.error&&(await active())?.title==='UI /crash-recovery','renderer recovery');
    await window.locator('.error-page').waitFor({state:'hidden'});assert.equal(app.process().exitCode,null);
  });
  await check('History search/clear and agent setup routes are functional',async()=>{
    await route('history');await window.locator('#page-filter').fill('/mission-');assert.ok(await window.locator('.list-row').count());await click('[data-action="history-clear"]');await window.locator('#dialog-form button[type=submit]').click();await until(async()=>!(await state()).history.length,'history clear');
    await click('.team-card');await window.locator('.protocol-tags').waitFor({state:'visible'});assert.ok((await window.locator('.connection-code').first().textContent()).includes('aster-mcp.cjs'));await click('[data-action="copy-code"][data-code-id="mcp"]');
  });
  assert.deepEqual(errors,[]);
  await window.screenshot({path:path.join(artifacts,'agents-min-window.png')});
  await click('#sidebar-toggle');await until(async()=>(await state()).settings.sidebarCollapsed,'compact before restart');
  await app.close();app=null;
  app=await _electron.launch(launchOptions);window=await app.firstWindow();await window.waitForFunction(()=>window.aster);await until(async()=>(await state()).settings.theme==='light','settings persistence');assert.equal((await state()).settings.sidebarCollapsed,true);await click('#sidebar-toggle');await until(async()=>!(await state()).settings.sidebarCollapsed,'reopen restored compact sidebar');
  results.push({name:'Settings and sidebar state persist through app restart',passed:true});
}
main().catch(async error=>{errors.push(error.stack);console.error(error.stack);process.exitCode=1;try{await window?.screenshot({path:path.join(artifacts,'ui-failure.png')});}catch{}}).finally(async()=>{fs.writeFileSync(path.join(artifacts,'ui-results.json'),JSON.stringify({passed:!process.exitCode,results,errors,profile,checkedAt:new Date().toISOString()},null,2));await app?.close();server?.close();});
