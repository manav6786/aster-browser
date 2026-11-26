'use strict';
// Run serially on an unlocked desktop. The authoring/audit step does not launch
// this script; the coordinating agent controls the native focus test window.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const work = path.resolve(process.env.ASTER_TEST_WORK || path.join(root, 'work', 'lifecycle'));
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'profile-'));
let app, window, server, origin, config, agentId;
const results = [], errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeoutMs = 15000) {
  const start = Date.now(); let lastError;
  while (Date.now() - start < timeoutMs) {
    try { const value = await read(); if (value) return value; } catch (error) { lastError = error; }
    await pause(50);
  }
  throw Error('Timed out: ' + label + (lastError ? ' (' + lastError.message + ')' : ''));
}
const invoke = (name, params = {}) => window.evaluate(({ name, params }) => window.aster.invoke(name, params), { name, params });
async function request(route, body) {
  const response = await fetch(config.endpoint + route, { method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', ...(agentId ? { 'X-Aster-Agent': agentId } : {}) }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000) });
  const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
}
const run = (action, params = {}) => request('/command', { action, params }).then(value => value.result);
const evaluate = (tabId, expression, frameId) => run('page.evaluate', { tabId, expression, ...(frameId ? { frameId } : {}) });
const loaded = (id, title) => until(async () => {
  const tab = (await invoke('state:get')).tabs.find(value => value.id === id);
  return tab && !tab.isLoading && !tab.error && await evaluate(id, 'document.title') === title && tab;
}, title);
async function frames(tabId) {
  return until(async () => {
    const all = await run('page.frames', { tabId }), main = all.find(value => value.main), same = all.find(value => value.name === 'same'), cross = all.find(value => value.name === 'cross');
    return main && same && cross && { main, same, cross };
  }, 'all draft frames');
}
async function check(name, fn) { const detail = await fn(); results.push({ name, passed: true, detail }); console.log('PASS', name); }

async function main() {
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://fixture').pathname;
    const children = route === '/second' ? `<iframe name="same" src="${origin}/same"></iframe><iframe name="cross" src="${origin.replace('127.0.0.1', 'localhost')}/cross"></iframe>` : '';
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><title>Lifecycle ${route}</title><style>body{font:18px system-ui;min-height:3500px;padding:24px}textarea{display:block;width:400px;height:100px}iframe{display:block;width:720px;height:240px;margin-top:20px}</style><h1>Lifecycle ${route}</h1><textarea id="draft" aria-label="Saved draft"></textarea>${children}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  app = await _electron.launch({ ...(process.env.ASTER_EXECUTABLE ? { executablePath: path.resolve(process.env.ASTER_EXECUTABLE), args: [] } : { args: [root] }), env: { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' }, timeout: 60000 });
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(work, 'lifecycle-stderr.log'), data));
  window = await app.firstWindow(); window.on('pageerror', error => errors.push(error.message));
  await window.waitForFunction(() => window.aster && document.querySelector('#app'));
  config = JSON.parse(fs.readFileSync(path.join(profile, 'automation.json'), 'utf8'));
  agentId = (await request('/connect', { name: 'Lifecycle regression', transport: 'HTTP fixture' })).agentId;

  const tab = await invoke('tab:new', { url: origin + '/first' }); await loaded(tab.id, 'Lifecycle /first');
  await invoke('tab:navigate', { id: tab.id, url: origin + '/second' }); await loaded(tab.id, 'Lifecycle /second');
  const originalFrames = await frames(tab.id);
  await invoke('tab:pin', { id: tab.id }); await invoke('tab:mute', { id: tab.id }); await invoke('tab:volume', { id: tab.id, volume: .23 });
  await run('tabs.claim', { tabId: tab.id, ttl: 120000 });
  const expiry = (await run('tabs.list')).find(value => value.id === tab.id).claim.expiresAt;
  await evaluate(tab.id, 'true');
  await check('a page mutation preserves the longer explicit lease', async () => {
    const claim = (await run('tabs.list')).find(value => value.id === tab.id).claim;
    assert.ok(claim.expiresAt >= expiry); return { explicitExpiresAt: expiry, afterMutationExpiresAt: claim.expiresAt };
  });
  const values = { main: 'Final root draft', same: 'Final same-origin draft', cross: 'Final cross-origin draft' };
  for (const [kind, frame] of Object.entries(originalFrames)) {
    await run('page.waitFor', { tabId: tab.id, frameId: frame.id, selector: '#draft', timeoutMs: 5000 });
    // Property assignment generates no input/change event. Closing immediately
    // must actively capture these values instead of relying on the 100ms timer.
    await evaluate(tab.id, `document.querySelector('#draft').value=${JSON.stringify(values[kind])};true`, frame.id);
  }
  await evaluate(tab.id, 'scrollTo(0,800);true');
  await invoke('tab:close', { id: tab.id });
  const reopened = await invoke('tab:restore'); await loaded(reopened.id, 'Lifecycle /second');
  await check('reopening preserves fractional volume, mute, pin and current title', async () => {
    const current = (await invoke('state:get')).tabs.find(value => value.id === reopened.id);
    assert.equal(current.volume, .23); assert.equal(current.muted, true); assert.equal(current.pinned, true); assert.equal(current.title, 'Lifecycle /second');
    return { volume: current.volume, muted: current.muted, pinned: current.pinned, title: current.title };
  });
  await check('immediate close restores root and both-origin frame drafts plus page scroll', async () => {
    const restoredFrames = await frames(reopened.id);
    for (const [kind, frame] of Object.entries(restoredFrames)) await until(async () => await evaluate(reopened.id, 'document.querySelector("#draft")?.value', frame.id) === values[kind], 'restored ' + kind + ' draft');
    const scrollY = await until(async () => { const value = await evaluate(reopened.id, 'scrollY'); return value >= 780 && value; }, 'restored root scroll');
    return { drafts: Object.keys(values), scrollY };
  });
  await check('a reopened tab retains usable Chromium back and forward entries', async () => {
    assert.equal((await invoke('state:get')).tabs.find(value => value.id === reopened.id).canGoBack, true);
    await invoke('tab:back', { id: reopened.id }); await loaded(reopened.id, 'Lifecycle /first');
    assert.equal((await invoke('state:get')).tabs.find(value => value.id === reopened.id).canGoForward, true);
    await invoke('tab:forward', { id: reopened.id }); await loaded(reopened.id, 'Lifecycle /second');
    return { back: origin + '/first', forward: origin + '/second' };
  });
  await check('a later Mission Control close supersedes an in-flight screenshot', async () => {
    await app.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(value => value.getURL() === url);
      const original = wc.capturePage; globalThis.lifecycleCapture = { wc, original, release: null };
      wc.capturePage = () => new Promise((resolve, reject) => { globalThis.lifecycleCapture.release = () => original.call(wc, undefined, { stayHidden: true }).then(resolve, reject); });
    }, origin + '/second');
    try {
      const opening = invoke('ui:mission', { open: true });
      await until(() => app.evaluate(() => Boolean(globalThis.lifecycleCapture.release)), 'pending thumbnail capture');
      assert.equal(await invoke('ui:mission', { open: false }), true);
      await app.evaluate(() => { globalThis.lifecycleCapture.release(); });
      assert.equal(await opening, false); assert.equal((await invoke('state:get')).missionOpen, false);
      return { finalMissionOpen: false };
    } finally { await app.evaluate(() => { const held = globalThis.lifecycleCapture; held.wc.capturePage = held.original; delete globalThis.lifecycleCapture; }); }
  });
  assert.deepEqual(errors, []);
}

main().catch(error => { console.error(error.stack); errors.push(error.stack); process.exitCode = 1; }).finally(async () => {
  if (agentId) await request('/disconnect').catch(() => {});
  if (app) await app.close().catch(() => {});
  server?.close();
  fs.writeFileSync(path.join(work, 'lifecycle-results.json'), JSON.stringify({ passed: !process.exitCode, checkedAt: new Date().toISOString(), results, errors, profile }, null, 2));
});
