'use strict';
// This is a focused, visible-app fixture. It sends trusted Chromium CDP wheel
// input, never the private gesture IPC or WheelEvent.dispatchEvent as a stand-in
// for real input. It does not prove physical macOS finger/phase routing.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const work = path.resolve(process.env.ASTER_TEST_WORK || path.join(root, 'work', 'gestures'));
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'gesture-profile-'));
const results = [], errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, shell, server, origin;
const ownedContents = new Set();
const boundary = {
  input: 'Input.dispatchMouseEvent mouseWheel; effects and DOM isTrusted are asserted',
  focus: 'Native window/webContents are focused; Playwright focus emulation is explicitly disabled before every scenario',
  pinch: 'Input.synthesizePinchGesture through Chromium, if supported; visual viewport scale is asserted independently from layout zoom',
  physicalTrackpad: 'Not exercised. DOM wheel lacks native finger count, NSEvent phases and momentum metadata. Synthetic success is not physical-trackpad evidence.',
  legacySwipe: 'Not synthesized: emitting BrowserWindow swipe would test only an EventEmitter, not a macOS gesture.'
};

async function until(read, label, timeoutMs = 12000) {
  const start = Date.now(); let value;
  while (Date.now() - start < timeoutMs) {
    value = await read(); if (value) return value;
    await sleep(50);
  }
  throw new Error('Timed out: ' + label);
}
async function check(name, fn) {
  const start = Date.now();
  try { const detail = await fn(); results.push({ name, passed: true, durationMs: Date.now() - start, ...(detail ? { detail } : {}) }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, durationMs: Date.now() - start, error: error.stack || error.message }); console.error('FAIL', name, error.message); }
}
const invoke = (command, payload = {}) => shell.evaluate(({ command, payload }) => window.aster.invoke(command, payload), { command, payload });
const state = () => invoke('state:get');
function fixtureHTML(url) {
  return `<!doctype html><meta charset="utf-8"><title>Gesture ${url.pathname}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
  <style>
    html{overscroll-behavior-x:auto;scroll-behavior:auto}body{margin:0;min-height:3200px;font:18px system-ui;background:linear-gradient(#f6f0ff,#d7e9ff)}
    #edge{position:fixed;left:24px;top:22px;width:370px;height:100px;background:#e4d8fb;border-radius:18px;padding:12px;box-sizing:border-box}
    #carousel{position:fixed;left:24px;top:150px;width:370px;height:85px;overflow-x:auto;overflow-y:hidden;background:#cfe5e2;white-space:nowrap}
    #carousel-content{width:2200px;height:65px;background:repeating-linear-gradient(90deg,#cfe5e2 0 130px,#8fbcb6 130px 260px)}
    #editable{position:fixed;left:24px;top:264px;width:350px;height:42px;font:18px system-ui}
    #contenteditable{position:fixed;left:24px;top:332px;width:350px;min-height:40px;background:white;border:1px solid #aaa;padding:8px;box-sizing:border-box}
    #hint{position:fixed;left:430px;top:24px;max-width:240px}h1{font-size:24px;margin:0}
  </style>
  <div id="edge"><h1>Native browser gesture fixture</h1><span>${url.pathname}</span></div>
  <div id="carousel"><div id="carousel-content">Horizontal carousel must keep its scrolling</div></div>
  <input id="editable" value="A long editable value must not trigger browser history or change while horizontally scrolling">
  <div id="contenteditable" contenteditable="true">Editable document text stays here</div>
  <aside id="hint">Trusted wheel dispatch exercises the actual registered session preload and history model.</aside>
  <script>
    window.fixture={wheel:[],cancel:false,pinch:[]};
    // Deliberately in the bubble phase, after the preload's capture listener.
    document.addEventListener('wheel',event=>{
      if(fixture.cancel)event.preventDefault();
      const item={trusted:event.isTrusted,dx:event.deltaX,dy:event.deltaY,mode:event.deltaMode,target:event.target.id,prevented:event.defaultPrevented};
      fixture.wheel.push(item);if(fixture.wheel.length>120)fixture.wheel.shift();
    },{passive:false});
  </script>`;
}
async function evaluate(tab, expression) {
  return app.evaluate(async ({ webContents }, { id, expression }) => {
    const wc = webContents.fromId(id); if (!wc || wc.isDestroyed()) throw new Error('Fixture webContents disappeared');
    return wc.executeJavaScript(expression, true);
  }, { id: tab.wc, expression });
}
async function cdp(tab, method, params = {}) {
  return app.evaluate(async ({ webContents }, { id, method, params }) => {
    const wc = webContents.fromId(id); if (!wc || wc.isDestroyed()) throw new Error('Fixture webContents disappeared');
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    return wc.debugger.sendCommand(method, params);
  }, { id: tab.wc, method, params });
}
async function nativeStatus(tab) {
  return app.evaluate(({ webContents, BrowserWindow }, id) => {
    const wc = webContents.fromId(id), win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('aster-ui://'));
    return { url: wc.getURL(), index: wc.navigationHistory.getActiveIndex(), entries: wc.navigationHistory.getAllEntries().map(e => e.url),
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
      pageFocused: wc.isFocused(), windowFocused: win?.isFocused(), zoomFactor: wc.getZoomFactor() };
  }, tab.wc);
}
async function focus(tab) {
  await invoke('tab:activate', { id: tab.id });
  await invoke('ui:overlay', { open: false });
  await invoke('ui:mission', { open: false });
  await cdp(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false });
  await app.evaluate(({ app, BrowserWindow, webContents }, id) => {
    const wc = webContents.fromId(id), win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('aster-ui://'));
    app.focus({ steal: true }); win.show(); win.focus(); wc.focus();
  }, tab.wc);
  await until(async () => { const s = await nativeStatus(tab); return s.windowFocused && s.pageFocused; }, 'native fixture focus');
}
async function loaded(tab, url) {
  await until(async () => {
    const current = (await state()).tabs.find(t => t.id === tab.id);
    return current?.url === url && !current.isLoading && !current.error;
  }, 'committed fixture ' + url);
  await until(async () => (await evaluate(tab, 'document.readyState === "complete" && Boolean(window.fixture)')), 'fixture document complete');
}
async function navigate(tab, suffix) {
  const url = origin + suffix;
  await invoke('tab:navigate', { id: tab.id, url }); await loaded(tab, url);
}
async function create(name, isPrivate = false) {
  const suffix = '/' + name + '/a';
  const model = await invoke('tab:new', { url: origin + suffix, private: isPrivate });
  const wc = await until(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(w => w.getURL() === url)?.id, origin + suffix), 'fixture webContents');
  const tab = { id: model.id, wc, name, private: isPrivate }; ownedContents.add(wc);
  await loaded(tab, origin + suffix); await navigate(tab, '/' + name + '/b'); await navigate(tab, '/' + name + '/c'); await focus(tab);
  await sleep(1100); // Do not count the preceding navigation as a new gesture.
  return tab;
}
async function prepare(tab) {
  await focus(tab);
  if ((await nativeStatus(tab)).url !== origin + '/' + tab.name + '/c') await navigate(tab, '/' + tab.name + '/c');
  await evaluate(tab, `(()=>{fixture.cancel=false;fixture.wheel=[];document.documentElement.style.overscrollBehaviorX='auto';document.querySelector('#carousel').style.direction='ltr';document.querySelector('#carousel').style.overscrollBehaviorX='auto';document.querySelector('#carousel').scrollLeft=100;window.scrollTo(0,0);document.activeElement?.blur();return true})()`);
  await sleep(1100);
}
async function point(tab, selector) {
  return evaluate(tab, `(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),p={x:r.x+r.width/2,y:r.y+r.height/2};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw Error('Fixture target is covered');return p})()`);
}
async function burst(tab, selector, deltaX, deltaY = 0, count = 6, extra = {}) {
  const p = await point(tab, selector);
  await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'none' });
  for (let i = 0; i < count; i++) {
    await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX, deltaY, ...extra });
    await sleep(42);
  }
  await sleep(230);
}
async function assertStayed(tab, before, label) {
  const after = await nativeStatus(tab); assert.equal(after.url, before.url, label); assert.equal(after.index, before.index, label + ' changed history index');
  return after;
}
async function trustedWheels(tab, minimum = 3) {
  const wheel = await evaluate(tab, 'fixture.wheel');
  assert.ok(wheel.length >= minimum, 'CDP acknowledgement alone is insufficient: fixture must receive at least ' + minimum + ' real wheel events');
  assert.ok(wheel.every(e => e.trusted && e.mode === 0), 'Chromium must produce trusted pixel wheel events');
  return wheel;
}
async function pinch(tab) {
  await prepare(tab);
  const before = await evaluate(tab, '({scale:visualViewport.scale,width:innerWidth,scrollX,scrollY})');
  const layout = (await nativeStatus(tab)).zoomFactor, p = await point(tab, '#edge');
  try {
    await cdp(tab, 'Input.synthesizePinchGesture', { ...p, scaleFactor: 1.5, relativeSpeed: 800, gestureSourceType: 'touch' });
  } catch (error) {
    if (/not supported|not implemented|method.*not found|unknown method|unsupported/i.test(error.message)) {
      return { skipped: true, reason: error.message, before, note: 'Native physical pinch remains unverified; no alternative scale setter counts as a pass.' };
    }
    throw error;
  }
  const after = await until(async () => { const s = await evaluate(tab, '({scale:visualViewport.scale,width:innerWidth,scrollX,scrollY})'); return s.scale > before.scale + .2 && s; }, 'Chromium synthesized pinch changes visual scale', 6000);
  assert.equal((await nativeStatus(tab)).zoomFactor, layout, 'Pinch must not apply a second layout/page zoom');
  assert.equal(after.width, before.width, 'Native visual pinch must preserve CSS layout width');
  assert.ok(after.scale < 2.1, 'Pinch must not be double-applied');
  const status = await nativeStatus(tab); await burst(tab, '#edge', -60, 0, 6); await assertStayed(tab, status, 'A zoomed page must pan instead of navigating history');
  await cdp(tab, 'Emulation.setPageScaleFactor', { pageScaleFactor: 1 }); // Cleanup only, never evidence for pinch support.
  return { before, after, layoutZoomFactor: layout, route: 'Chromium synthesized touch pinch; physical Mac trackpad unverified' };
}
async function main() {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(fixtureHTML(new URL(req.url, 'http://fixture'))); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  let executable = process.env.ASTER_EXECUTABLE;
  if (executable?.endsWith('.app')) executable = path.join(executable, 'Contents', 'MacOS', 'Aster');
  const options = { ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: [root] }),
    env: { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' }, timeout: 60000 };
  delete options.env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch(options); shell = await app.firstWindow(); shell.on('pageerror', error => errors.push(error.message));
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(work, 'gestures-stderr.log'), data));
  await shell.waitForFunction(() => window.aster && document.querySelector('#home-search'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  if (process.platform !== 'darwin') throw new Error('This integrated fixture requires macOS; gesture navigation is intentionally disabled on other platforms.');
  const normal = await create('regular');
  await check('trusted horizontal input at a page edge navigates once through its momentum tail', async () => {
    const before = await nativeStatus(normal); assert.ok(before.canGoBack); await burst(normal, '#edge', -60, 0, 12);
    await loaded(normal, origin + '/regular/b'); const after = await nativeStatus(normal);
    assert.equal(after.index, before.index - 1, 'One wheel sequence must make exactly one history step');
    return { before, after, eventTail: await trustedWheels(normal, 1) };
  });
  await check('a separate deliberate opposite gesture traverses forward history once', async () => {
    await focus(normal); await sleep(1100); const before = await nativeStatus(normal); assert.ok(before.canGoForward);
    await burst(normal, '#edge', 60, 0, 8); await loaded(normal, origin + '/regular/c'); const after = await nativeStatus(normal); assert.equal(after.index, before.index + 1);
    return { before, after, eventTail: await trustedWheels(normal, 1) };
  });
  await check('ordinary vertical scrolling moves the document without traversing history', async () => {
    await prepare(normal); const before = await nativeStatus(normal); await burst(normal, '#edge', 0, 95);
    await assertStayed(normal, before, 'Vertical scrolling'); const scrollY = await evaluate(normal, 'scrollY'); assert.ok(scrollY > 100, 'Real default page scrolling must remain functional');
    return { scrollY, wheel: await trustedWheels(normal) };
  });
  await check('a horizontal carousel consumes wheel input and keeps page history', async () => {
    await prepare(normal); const before = await nativeStatus(normal), left = await evaluate(normal, 'document.querySelector("#carousel").scrollLeft');
    await burst(normal, '#carousel', 60); await assertStayed(normal, before, 'Carousel scrolling');
    const after = await evaluate(normal, 'document.querySelector("#carousel").scrollLeft'); assert.ok(after > left + 50, 'The actual carousel scroll offset must change');
    return { beforeScrollLeft: left, afterScrollLeft: after, wheel: await trustedWheels(normal) };
  });
  await check('an RTL carousel retains its negative horizontal scrolling semantics', async () => {
    await prepare(normal); await evaluate(normal, 'document.querySelector("#carousel").style.direction="rtl";document.querySelector("#carousel").scrollLeft=-350;true');
    const before = await nativeStatus(normal), left = await evaluate(normal, 'document.querySelector("#carousel").scrollLeft'); assert.ok(left < 0);
    await burst(normal, '#carousel', 35); await assertStayed(normal, before, 'RTL carousel scrolling');
    const after = await evaluate(normal, 'document.querySelector("#carousel").scrollLeft'); assert.ok(after > left, 'RTL scrolling must move toward zero'); return { beforeScrollLeft: left, afterScrollLeft: after, wheel: await trustedWheels(normal) };
  });
  await check('editable text fields and contenteditable regions cannot trigger history', async () => {
    for (const selector of ['#editable', '#contenteditable']) {
      await prepare(normal); const before = await nativeStatus(normal), text = await evaluate(normal, `document.querySelector(${JSON.stringify(selector)}).textContent || document.querySelector(${JSON.stringify(selector)}).value`);
      await burst(normal, selector, -60); await assertStayed(normal, before, 'Editing region ' + selector); await trustedWheels(normal);
      assert.equal(await evaluate(normal, `document.querySelector(${JSON.stringify(selector)}).textContent || document.querySelector(${JSON.stringify(selector)}).value`), text);
    }
  });
  await check('root overscroll-behavior contain suppresses horizontal history gestures', async () => {
    await prepare(normal); await evaluate(normal, 'document.documentElement.style.overscrollBehaviorX="contain";true'); const before = await nativeStatus(normal);
    await burst(normal, '#edge', -60); await assertStayed(normal, before, 'Root overscroll containment'); return { wheel: await trustedWheels(normal) };
  });
  await check('a bubble-phase preventDefault on trusted wheel wins over capture-phase observation', async () => {
    await prepare(normal); await evaluate(normal, 'fixture.cancel=true'); const before = await nativeStatus(normal);
    await burst(normal, '#edge', -60); await assertStayed(normal, before, 'Page-cancelled wheel');
    const wheel = await trustedWheels(normal); assert.ok(wheel.every(e => e.prevented), 'Page bubble listener must really cancel the trusted events'); return { wheel };
  });
  await check('untrusted page-created WheelEvents cannot manufacture browser history input', async () => {
    await prepare(normal); const before = await nativeStatus(normal);
    await evaluate(normal, '(()=>{for(let i=0;i<12;i++)document.querySelector("#edge").dispatchEvent(new WheelEvent("wheel",{deltaX:-60,bubbles:true,cancelable:true}));return true})()');
    await sleep(350); await assertStayed(normal, before, 'Untrusted page input'); const wheel = await evaluate(normal, 'fixture.wheel'); assert.equal(wheel.length, 12); assert.ok(wheel.every(e => !e.trusted));
    return { untrustedEvents: wheel.length };
  });
  await check('private session receives its own gesture preload and real history navigation', async () => {
    const tab = await create('private', true), before = await nativeStatus(tab); await burst(tab, '#edge', -60, 0, 8); await loaded(tab, origin + '/private/b');
    const after = await nativeStatus(tab); assert.equal(after.index, before.index - 1); assert.equal((await state()).tabs.find(t => t.id === tab.id).private, true);
    assert.equal((await nativeStatus(normal)).url, origin + '/regular/c', 'Private gestures must affect only the selected private tab'); return { before, after, eventTail: await trustedWheels(tab, 1) };
  });
  await check('Chromium pinch changes visual scale once while layout zoom stays isolated', async () => pinch(normal));
  assert.equal(errors.length, 0, 'Browser shell page errors: ' + errors.join('; '));
}
main().catch(error => { errors.push(error.stack || error.message); console.error(error.stack || error.message); }).finally(async () => {
  if (app) {
    try { await app.evaluate(({ webContents }, ids) => { for (const id of ids) { const wc = webContents.fromId(id); if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } }, [...ownedContents]); } catch {}
    try { await app.close(); } catch { const process = app.process(); if (process.exitCode === null) process.kill('SIGKILL'); }
  }
  if (server) await new Promise(resolve => server.close(resolve));
  const report = { mode: process.env.ASTER_EXECUTABLE ? 'packaged' : 'source', profile, platform: process.platform, inputBoundary: boundary,
    passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results, errors };
  fs.writeFileSync(path.join(work, 'gestures-regression.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, errors: errors.length, report: path.join(work, 'gestures-regression.json') }));
  if (report.failed || errors.length) process.exitCode = 1;
});
