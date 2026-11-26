'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const { FiltersEngine } = require('@ghostery/adblocker');

const root = path.resolve(__dirname, '..');
const work = process.env.ASTER_TEST_WORK || path.resolve(root, '../../work/qa-v2/shields');
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'profile-'));
const engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(path.join(root, 'assets/blocker.bin'))));
const pattern = '(function asterFixtureServerContract(';
const replacement = 'window.asterFixturePatched=true;' + pattern;
engine.updateFromDiff({ added: [
  'aster.test##+js(set, asterFixtureReady, true)',
  `aster.test##+js(trusted-rpnt, script, ${encodeURIComponent(pattern)}, ${encodeURIComponent(replacement)}, sedCount, 1)`,
  '##.aster-fixture-generic-ad',
  '##.aster-fixture-spa-ad',
  '|https://aster-fixture.invalid/private.js|$script,xhr,other,redirect=noop.js'
] });
fs.writeFileSync(path.join(profile, 'filters.bin'), engine.serialize());
fs.writeFileSync(path.join(profile, 'filters.json'), JSON.stringify({ version: '2.20.1', generatedAt: new Date(Date.now() + 1000).toISOString(), filterCount: engine.getFilters().networkFilters.length + engine.getFilters().cosmeticFilters.length }));

const report = { checkedAt: new Date().toISOString(), profile, passed: false, checks: [], networkErrors: [] };
const fixture = http.createServer((_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "default-src 'none'; script-src 'nonce-aster-test' https://static.doubleclick.net; connect-src https://static.doubleclick.net https://googleads.g.doubleclick.net"
  });
  res.end(`<!doctype html><title>Shields fixture</title>
<script nonce="aster-test">(function asterFixtureServerContract(){window.fixtureBootstrap={ready:window.asterFixtureReady===true,patched:window.asterFixturePatched===true,node:typeof require,process:typeof process,bridge:typeof window.aster};})();</script>
<script src="https://static.doubleclick.net/instream/ad_status.js"></script>
<script nonce="aster-test">
window.fixtureScript={status:window.google_ad_status};
window.fixtureScriptBytes=fetch('https://static.doubleclick.net/instream/ad_status.js').then(r=>r.text());
window.fixtureXHR=new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET','https://googleads.g.doubleclick.net/pagead/id');x.withCredentials=true;x.timeout=10000;x.onload=()=>resolve({status:x.status,text:x.responseText,mime:x.getResponseHeader('Content-Type'),url:x.responseURL});x.onerror=()=>resolve({error:'xhr error'});x.ontimeout=()=>resolve({error:'xhr timeout'});x.send()});
addEventListener('DOMContentLoaded',()=>{const d=document.createElement('div');d.className='aster-fixture-generic-ad';d.textContent='Fixture ad';document.body.append(d)});
</script><body>Shields fixture</body>`);
});
let app;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await test(); if (value) return value; await sleep(75); }
  throw new Error('Timed out: ' + description);
}
async function check(name, run) {
  try { const detail = await run(); report.checks.push({ name, passed: true, detail }); console.log('PASS', name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); console.error('FAIL', name, error.message); }
}
(async () => {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  // The bundled lists intentionally exempt loopback hostnames from generic
  // hiding. Resolve a reserved test hostname locally to exercise real cosmetics.
  const origin = 'http://aster.test:' + fixture.address().port;
  const executablePath = process.env.ASTER_EXECUTABLE;
  const hostRule = '--host-resolver-rules=MAP aster.test 127.0.0.1';
  app = await _electron.launch({ ...(executablePath ? { executablePath, args: [hostRule] } : { args: [hostRule, root] }), env: { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' }, timeout: 60000 });
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(work, 'shields-stderr.log'), data));
  const shell = await app.firstWindow(); await shell.waitForFunction(() => window.aster);
  await app.evaluate(({ app }) => {
    globalThis.shieldsFixtureErrors = [];
    app.on('web-contents-created', (_event, wc) => wc.session.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, details => globalThis.shieldsFixtureErrors.push({ url: details.url, error: details.error })));
  });
  const invoke = (action, params = {}) => shell.evaluate(({ action, params }) => window.aster.invoke(action, params), { action, params });
  const read = (url, code) => app.evaluate(async ({ webContents }, { url, code }) => {
    const wc = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL() === url);
    if (!wc) return null;
    return wc.executeJavaScript(code);
  }, { url, code });
  for (const privateMode of [false, true]) {
    const label = privateMode ? 'private' : 'normal', url = origin + '/?mode=' + label;
    const tab = await invoke('tab:new', { url, private: privateMode });
    await until(() => read(url, 'document.readyState === "complete" && Boolean(window.fixtureBootstrap)'), label + ' fixture bootstrap');
    await check(label + ' scriptlets run before the first inline bootstrap without exposing Node', async () => {
      const actual = await read(url, 'window.fixtureBootstrap');
      assert.deepEqual(actual, { ready: true, patched: true, node: 'undefined', process: 'undefined', bridge: 'undefined' });
      const prefs = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(w => w.getURL() === url).getLastWebPreferences(), url);
      assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true);
      return actual;
    });
    await check(label + ' exact ad_status script replacement executes under strict CSP', async () => {
      assert.deepEqual(await read(url, 'window.fixtureScript'), { status: 1 });
      const expected = engine.resources.getResource('doubleclick_instream_ad_status.js').body;
      assert.equal(expected, 'window.google_ad_status=1;');
      assert.equal(await read(url, 'window.fixtureScriptBytes'), expected);
      return { expected, google_ad_status: 1 };
    });
    await check(label + ' empty text replacement succeeds in credentialed cross-origin XHR', async () => {
      const actual = await read(url, 'window.fixtureXHR');
      assert.equal(actual.status, 200, JSON.stringify(actual)); assert.equal(actual.text, ''); assert.equal(actual.mime, 'text/plain');
      assert.ok(actual.url.startsWith('aster-resource://surrogate/')); return actual;
    });
    await check(label + ' generic cosmetic filters still hide newly inserted DOM', async () => {
      assert.equal(await until(() => read(url, 'getComputedStyle(document.querySelector(".aster-fixture-generic-ad")).display === "none"'), label + ' cosmetic CSS'), true);
    });
    await check(label + ' cosmetic updates survive an in-page navigation', async () => {
      const nextURL = url + '&spa=1';
      await read(url, 'history.pushState({},"",location.href+"&spa=1");const d=document.createElement("div");d.className="aster-fixture-spa-ad";document.body.append(d);true');
      assert.equal(await until(() => read(nextURL, 'getComputedStyle(document.querySelector(".aster-fixture-spa-ad")).display === "none"'), label + ' SPA cosmetic CSS'), true);
      // Restore the fixture URL so the remaining checks address this view.
      await read(nextURL, 'history.replaceState({},"",location.href.replace("&spa=1",""));true');
    });
    await check(label + ' resource handler exposes no path or general proxy', async () => {
      const status = await app.evaluate(async ({ webContents }, url) => {
        const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
        return (await wc.session.fetch('aster-resource://surrogate/etc/passwd')).status;
      }, url);
      assert.equal(status, 404);
    });
    if (privateMode) await check('private resource existence is isolated from the normal session', async () => {
      const resourceURL = 'aster-resource://surrogate/' + createHash('sha256').update(engine.resources.getResource('noop.js').dataUrl).digest('hex');
      const actual = await app.evaluate(async ({ webContents, session }, { url, resourceURL }) => {
        const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
        await wc.session.fetch('https://aster-fixture.invalid/private.js');
        const privateResponse = await wc.session.fetch(resourceURL);
        const normalResponse = await session.fromPartition('persist:aster').fetch(resourceURL);
        return { privateStatus: privateResponse.status, normalStatus: normalResponse.status };
      }, { url, resourceURL });
      assert.equal(actual.privateStatus, 200); assert.equal(actual.normalStatus, 404); return actual;
    });
    await invoke('tab:close', { id: tab.id });
  }
  report.networkErrors = await app.evaluate(() => globalThis.shieldsFixtureErrors);
  await check('replacement requests have no unsafe redirects, CORS failures or blocked protocol loads', async () => {
    // Electron closes the original loader when switching to our resource
    // handler; ERR_ABORTED on that original URL is normal redirect bookkeeping.
    assert.deepEqual(report.networkErrors.filter(item => item.error !== 'net::ERR_ABORTED'), []);
  });
  report.passed = report.checks.every(check => check.passed);
  if (!report.passed) process.exitCode = 1;
})().catch(error => { report.error = error.stack; process.exitCode = 1; console.error(error); }).finally(async () => {
  await app?.close().catch(() => {}); fixture.close();
  fs.writeFileSync(path.join(work, 'shields-results.json'), JSON.stringify(report, null, 2));
});
