'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createClient } = require('../bin/client.cjs');

const page = `<!doctype html>
<meta charset="utf-8"><title>Browser control benchmark</title>
<style>body{font:18px system-ui;padding:24px}input,button{font:inherit;margin:10px;padding:8px}</style>
<h1>Browser control benchmark</h1>
<button id="increment">Increment</button><output id="count">0</output>
<form id="form"><label>Value <input id="value" required></label><button id="submit">Submit</button></form>
<output id="result"></output>
<script>
const element = id => document.getElementById(id);
const events = [];
window.resetFixture = () => {
  element('count').textContent = '0';
  element('value').value = '';
  element('result').textContent = '';
  events.length = 0;
  document.activeElement.blur();
};
window.readFixture = () => ({
  count: Number(element('count').textContent),
  result: element('result').textContent,
  events: events.slice(),
  visibility: document.visibilityState
});
element('increment').onclick = e => {
  element('count').textContent = Number(element('count').textContent) + 1;
  events.push(['click', e.isTrusted]);
};
element('value').oninput = e => events.push(['type', e.isTrusted]);
element('submit').onclick = e => events.push(['submit', e.isTrusted]);
element('form').onsubmit = e => {
  e.preventDefault();
  element('result').textContent = element('value').value;
};
</script>`;

async function fixtureServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/fixture' };
}

async function until(read, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + description);
}

function ownProcess(executable, args, env, cleanup) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', error => console.error(error.message));
  child.stderr.resume();
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return child;
}

async function connectCDP(url, cleanup) {
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, 'ws:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  const socket = new WebSocket(endpoint);
  cleanup.push(() => socket.close());
  const pending = new Map();
  let serial = 0;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    const finish = pending.get(reply.id);
    if (finish) finish(reply);
  });
  await ready;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 5000);
    pending.set(id, reply => {
      clearTimeout(timeout);
      pending.delete(id);
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function chromiumRoute(executable, profile, url, cleanup) {
  ownProcess(executable, [
    '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--window-size=1050,740', url,
  ], process.env, cleanup);
  const port = await until(async () => {
    const file = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    return Number(file.split('\n')[0]);
  }, 'the isolated browser debugging port');
  const base = 'http://127.0.0.1:' + port;
  const target = await until(async () => {
    const list = await fetch(base + '/json/list', { signal: AbortSignal.timeout(2000) }).then(res => res.json()).catch(() => []);
    return list.find(item => item.type === 'page' && item.url === url);
  }, 'the benchmark tab');
  const send = await connectCDP(target.webSocketDebuggerUrl, cleanup);
  const version = await fetch(base + '/json/version').then(res => res.json());
  await send('Page.bringToFront');
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  async function click(selector) {
    const point = await evaluate(`(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(selector)});
      if (nodes.length !== 1 || nodes[0].disabled) throw new Error('Expected one enabled control');
      const box = nodes[0].getBoundingClientRect();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      if (!box.width || !box.height || !nodes[0].contains(document.elementFromPoint(x, y))) throw new Error('Control is obscured');
      return {x, y};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  return {
    version: version.Browser,
    evaluate,
    click,
    async form(text) {
      await click('#value');
      await send('Input.insertText', { text });
      await click('#submit');
    },
  };
}

async function asterRoute(executable, profile, url, cleanup) {
  const file = path.join(profile, 'automation.json');
  const env = { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_AUTOMATION: '1', ASTER_DISABLE_FILTER_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = ownProcess(executable, [], env, cleanup);
  const config = await until(async () => {
    const json = await fs.readFile(file, 'utf8').catch(() => '');
    return json && JSON.parse(json);
  }, 'Aster local automation');
  assert.equal(config.pid, child.pid);
  process.env.ASTER_CONNECTION = file;
  const client = createClient('Browser control benchmark', 'HTTP');
  await client.connect();
  cleanup.push(() => client.disconnect());
  const caps = await client.command('browser.capabilities');
  const tab = await client.command('tabs.create', { url, active: true });
  const send = (action, params) => client.command(action, { tabId: tab.id, timeoutMs: 4000, ...params });
  return {
    version: caps.version,
    evaluate: expression => send('page.evaluate', { expression }),
    click: selector => send('page.click', { selector }),
    form: text => send('page.batch', { steps: [
      { action: 'type', selector: '#value', text, clear: false },
      { action: 'click', selector: '#submit' },
    ] }),
    async sharedSessionCheck() {
      const teammate = createClient('Second benchmark client', 'HTTP');
      await teammate.connect();
      cleanup.push(() => teammate.disconnect());
      await send('tabs.claim', {});
      await assert.rejects(teammate.command('page.click', { tabId: tab.id, selector: '#increment' }), /claimed by another/);
      const background = await teammate.command('tabs.create', { url, active: false });
      const other = (action, params) => teammate.command(action, { tabId: background.id, ...params });
      await until(async () => (await teammate.command('tabs.list')).some(item => item.id === background.id && item.title === 'Browser control benchmark' && !item.isLoading), 'the background tab');
      assert.equal(await other('page.evaluate', { expression: 'document.visibilityState' }), 'hidden');
      await other('page.click', { selector: '#increment' });
      const state = await other('page.evaluate', { expression: 'readFixture()' });
      assert.deepEqual(state, { count: 1, result: '', events: [['click', true]], visibility: 'hidden' });
      assert.equal((await client.command('browser.state')).activeTabId, tab.id);
      return { independentClients: true, conflictingWriteRejected: true, backgroundClickVerified: true, selectedTabPreserved: true };
    },
  };
}

async function safariRoute(executable, url, cleanup) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  ownProcess(executable, ['--port', String(port)], process.env, cleanup);
  const base = 'http://127.0.0.1:' + port;
  await until(async () => (await fetch(base + '/status', { signal: AbortSignal.timeout(800) }).catch(() => null))?.ok, 'Safari WebDriver');
  async function request(resource, body, method = 'POST') {
    const response = await fetch(base + resource, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const { value } = await response.json();
    if (!response.ok) throw new Error(value?.message || 'Safari WebDriver returned HTTP ' + response.status);
    return value;
  }
  const session = await request('/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  const endpoint = '/session/' + encodeURIComponent(session.sessionId);
  cleanup.push(() => request(endpoint, undefined, 'DELETE').catch(() => {}));
  const send = (resource, body) => request(endpoint + resource, body);
  await send('/url', { url });
  const find = async selector => {
    const element = await send('/element', { using: 'css selector', value: selector });
    return '/element/' + encodeURIComponent(element['element-6066-11e4-a52e-4f735466cecf']);
  };
  const click = async selector => send(await find(selector) + '/click', {});
  return {
    version: session.capabilities.browserVersion,
    evaluate: expression => send('/execute/sync', { script: 'return (' + expression + ');', args: [] }),
    click,
    async form(text) {
      await send(await find('#value') + '/value', { text });
      await click('#submit');
    },
  };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const left = sorted[Math.floor((sorted.length - 1) / 2)];
  const right = sorted[Math.ceil((sorted.length - 1) / 2)];
  return { p50: (left + right) / 2, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

async function run() {
  const [browser, executable, count = '60'] = process.argv.slice(2);
  const routes = { aster: asterRoute, chrome: chromiumRoute, brave: chromiumRoute };
  assert.ok(['aster', 'chrome', 'brave', 'safari', 'fixture'].includes(browser), 'Choose aster, chrome, brave, safari, or fixture');
  const rounds = Number(count);
  if (browser !== 'fixture') {
    assert.ok(typeof executable === 'string' && path.isAbsolute(executable), 'Provide the absolute path to the installed browser executable');
    assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 1000, 'Supply a sample count from 1 to 1000');
  }
  const { server, url } = await fixtureServer();
  if (browser === 'fixture') {
    console.log(url);
    return;
  }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-control-benchmark-'));
  const cleanup = [];
  try {
    const route = browser === 'safari'
      ? await safariRoute(executable, url, cleanup)
      : await routes[browser](executable, profile, url, cleanup);
    await until(async () => await route.evaluate('typeof resetFixture === "function" && document.visibilityState === "visible"').catch(() => false), 'the visible fixture');
    await delay(1200);
    const click = [], form = [];
    for (let round = -10; round < rounds; round++) {
      for (const kind of round % 2 ? ['form', 'click'] : ['click', 'form']) {
        await route.evaluate('resetFixture()');
        const token = 'value-' + round;
        const started = performance.now();
        if (kind === 'click') await route.click('#increment');
        else await route.form(token);
        const after = await route.evaluate('readFixture()');
        const elapsed = performance.now() - started;
        if (kind === 'click') {
          assert.deepEqual(after, { count: 1, result: '', events: [['click', true]], visibility: 'visible' });
        } else {
          assert.equal(after.result, token);
          assert.equal(after.count, 0);
          assert.equal(after.visibility, 'visible');
          assert.ok(after.events.some(([action]) => action === 'type'));
          assert.equal(after.events.filter(([action]) => action === 'submit').length, 1);
          assert.ok(after.events.every(([, trusted]) => trusted));
        }
        if (round >= 0) (kind === 'click' ? click : form).push(elapsed);
      }
    }
    const report = {
      browser, version: route.version, platform: os.platform(), release: os.release(),
      cpu: os.cpus()[0]?.model, rounds, warmupsPerTask: 10,
      click: { ...stats(click), samples: click },
      form: { ...stats(form), samples: form },
    };
    if (browser === 'aster') report.sharedSession = await route.sharedSessionCheck();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const close of cleanup.reverse()) await close();
    server.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
