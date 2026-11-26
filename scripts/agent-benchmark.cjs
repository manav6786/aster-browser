'use strict';
// One browser/engine/fixture, two persistent transports, common effect verifier.
// The test-only CDP endpoint changes launch conditions. This is intentionally
// NOT a normal-launch correctness test or a browser-wide speed claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const work = path.resolve(process.env.ASTER_TEST_WORK || path.join(root, 'work', 'agent-benchmark'));
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'paired-'));
const warmups = Math.max(10, Math.floor(Number(process.env.ASTER_BENCH_WARMUPS) || 10));
const rounds = Math.max(50, Math.floor(Number(process.env.ASTER_BENCH_ROUNDS) || 50));
const timeoutMs = Math.max(1000, Number(process.env.ASTER_BENCH_TIMEOUT_MS) || 4000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cold = {}, cases = [], failures = [];
let fixture, app, config, agentId, raw, target, humanId, tabId, port, origin, heartbeat;
let stdout = '', stderr = '';

async function until(read, label, ms = 15000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const value = await read(); if (value) return value;
    if (app && (app.exitCode !== null || app.signalCode !== null)) throw new Error('Aster exited during ' + label);
    await sleep(25);
  }
  throw new Error('Timed out: ' + label);
}
async function timed(fn) { const start = performance.now(); const value = await fn(); return { value, ms: performance.now() - start }; }
async function api(route, body, method = 'POST') {
  const response = await fetch(config.endpoint + route, {
    method, headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', ...(agentId ? { 'X-Aster-Agent': agentId } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }), signal: AbortSignal.timeout(timeoutMs + 15000)
  });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error || `HTTP ${response.status}`); error.details = value.details; throw error; }
  return value;
}
const command = (action, params = {}) => api('/command', { action, params }).then(value => value.result);
const page = (action, params = {}) => command(action, { tabId, timeoutMs, ...params });

class Protocol {
  constructor(url) {
    this.socket = new WebSocket(url); this.pending = new Map(); this.nextId = 1;
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')), { once: true }); });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)), item = this.pending.get(message.id); if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    });
    this.socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP connection closed')); } this.pending.clear(); });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeoutMs + 5000); timer.unref();
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}
function valueOf(result) {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'CDP evaluation failed');
  return result.result?.value;
}
const evaluate = async expression => valueOf(await raw.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }));

// These functions execute in a separate isolated world. The fixture is simple,
// but the baseline still checks strict selection, visibility, enabled/editable
// state, occlusion, scrolls/focuses the target, and rejects moving animations.
function describe(editable) {
  const node = this;
  if (!node?.isConnected) return { state: 'detached' };
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = node.getBoundingClientRect(), style = getComputedStyle(node);
  if (!box.width || !box.height || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return { state: 'hidden' };
  if (node.disabled || node.matches(':disabled') || node.closest('[inert],[aria-disabled="true"]')) return { state: 'disabled' };
  if (editable && ((!node.isContentEditable && !['INPUT','TEXTAREA'].includes(node.tagName)) || node.readOnly)) throw new Error('Target is not editable');
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  if (!hit || !(hit === node || node.contains(hit))) return { state: 'covered' };
  for (let parent = node; parent; parent = parent.parentElement) if (parent.getAnimations?.().some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity && animation.effect?.getKeyframes().some(frame => ['transform','left','top','width','height'].some(key => key in frame)))) return { state: 'animating' };
  node.focus({ preventScroll: true }); return { state: 'ready' };
}
let isolatedContext;
async function readyNode(selector, editable = false) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const resolved = await raw.send('Runtime.evaluate', { expression: `(()=>{const nodes=document.querySelectorAll(${JSON.stringify(selector)});if(nodes.length>1)throw Error('Ambiguous selector');return nodes[0]||null})()`, contextId: isolatedContext, returnByValue: false, userGesture: true, objectGroup: 'aster-benchmark-action' });
    if (resolved.exceptionDetails) valueOf(resolved);
    const objectId = resolved.result?.objectId;
    if (objectId) {
      const description = valueOf(await raw.send('Runtime.callFunctionOn', { objectId, functionDeclaration: describe.toString(), arguments: [{ value: editable }], returnByValue: true, userGesture: true }));
      if (description.state === 'ready') {
        const { model } = await raw.send('DOM.getBoxModel', { objectId });
        const q = model.content;
        return { objectId, x: (q[0]+q[2]+q[4]+q[6])/4, y: (q[1]+q[3]+q[5]+q[7])/4 };
      }
    }
    await sleep(40);
  }
  throw new Error('CDP control did not become actionable: ' + selector);
}
async function pointer(point) {
  await raw.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await raw.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}
async function rawClick(selector) { await pointer(await readyNode(selector)); }
async function rawType(selector, text) {
  await pointer(await readyNode(selector, true));
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await raw.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers, commands: ['selectAll'] });
  await raw.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers });
  await raw.send('Input.insertText', { text });
}
async function rawWaitText(selector, text) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return false;const style=getComputedStyle(node),box=node.getBoundingClientRect();return !!box.width&&!!box.height&&style.visibility!=='hidden'&&style.display!=='none'&&(node.innerText||node.textContent||'').includes(${JSON.stringify(text)})})()`)) return;
    await sleep(40);
  }
  throw new Error('CDP wait condition failed');
}
async function scopedRaw(action) {
  const hidden = await evaluate('document.visibilityState === "hidden"');
  if (hidden) await raw.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  try { await action(); return { ok: true }; }
  finally { await raw.send('Runtime.releaseObjectGroup', { objectGroup: 'aster-benchmark-action' }).catch(() => {}); if (hidden) await raw.send('Emulation.setFocusEmulationEnabled', { enabled: false }); }
}

const read = () => evaluate('({count:bench.count,submissions:bench.submissions,value:document.querySelector("#value").value,result:document.querySelector("#result").textContent,events:bench.events,visibility:document.visibilityState,focused:document.hasFocus(),webdriver:navigator.webdriver,url:location.href})');
async function reset(token) {
  // Match a real widget-focus baseline for both transports. Newly created
  // hidden pages can report a transient default focus; CDP pointer input also
  // acquires widget focus independently of its emulation override. A harmless
  // move on the fixture's blank corner establishes the same actual state for
  // every route outside the measured interval, without selecting the tab.
  await scopedRaw(()=>raw.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1}));
  await evaluate(`bench.reset(${JSON.stringify(token)});true`);
  const before = await read();
  assert.equal(before.count, 0); assert.equal(before.submissions, 0); assert.equal(before.events.length, 0);
  assert.equal(before.visibility, 'hidden', 'Benchmark target must be hidden before each action');
  return before;
}
function effect(kind, final, token) {
  if (kind === 'click') {
    if (final.count > 1) throw new Error('Click was duplicated');
    return final.count === 1 && final.events.length === 1 && final.events[0].kind === 'increment' && final.events[0].trusted === true;
  }
  if (final.submissions > 1) throw new Error('Submission was duplicated');
  return final.submissions === 1 && final.value === token && final.result === token && final.events.some(e => e.kind === 'input') && final.events.filter(e => e.kind === 'submit').length === 1 && final.events.every(e => e.trusted);
}
async function sample(kind, route, token, warmup, round) {
  const row = { kind, route: route.name, token, warmup, round, ok: false, ackMs: null, effectMs: null, polls: 0 };
  try { row.before = await reset(token); }
  catch (error) { row.error = 'Fixture reset: ' + error.message; return row; }
  const start = performance.now();
  try {
    row.ack = await route.act(token); row.ackMs = performance.now() - start;
    while (performance.now() - start < timeoutMs) {
      row.final = await read(); row.polls++;
      if (effect(kind, row.final, token) && row.final.visibility === row.before.visibility && row.final.focused === row.before.focused) { row.ok = true; row.effectMs = performance.now() - start; break; }
      await sleep(2);
    }
    if (!row.ok) row.error = 'Verified effect or lifecycle restoration timed out';
  } catch (error) { row.error = error.message; if (error.details) row.details = error.details; }
  row.elapsedMs = performance.now() - start;
  return row;
}
function summary(rows) {
  const sorted = rows.filter(row => row.ok).map(row => row.effectMs).sort((a,b) => a-b);
  const acks = rows.filter(row => row.ackMs !== null).map(row => row.ackMs).sort((a,b) => a-b);
  const median = values => values.length ? (values[Math.floor((values.length-1)/2)] + values[Math.floor(values.length/2)]) / 2 : null;
  return { attempts: rows.length, verifiedSuccesses: sorted.length, failures: rows.filter(row => !row.ok).length, medianVerifiedMs: median(sorted), p95VerifiedMs: sorted.length ? sorted[Math.ceil(sorted.length * .95)-1] : null, medianAcknowledgmentMs: median(acks) };
}
async function compare(kind, routes) {
  const samples = [];
  for (let round = -warmups; round < rounds; round++) {
    const order = round % 2 === 0 ? routes : [...routes].reverse();
    for (const route of order) {
      const row = await sample(kind, route, `${kind}-${round}`, round < 0, round); samples.push(row);
      if (!row.ok) failures.push({ kind, route: route.name, round, warmup: row.warmup, error: row.error });
    }
  }
  return { kind, warmupsPerRoute: warmups, measuredPerRoute: rounds, order: 'alternating route order each round', timeoutMs, summary: Object.fromEntries(routes.map(route => [route.name, summary(samples.filter(row => !row.warmup && row.route === route.name))])), samples };
}

async function main() {
  fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/human') return res.end('<!doctype html><title>Benchmark human tab</title><h1>Human tab stays selected</h1>');
    res.end(`<!doctype html><meta charset="utf-8"><title>Paired input benchmark</title><style>body{font:16px system-ui;padding:35px}button,input{font:inherit;padding:10px;margin:10px}output{display:inline-block;min-width:100px;min-height:20px}</style><h1>Same-engine paired benchmark</h1><button id="increment">Increment</button><output id="count">0</output><label>Value<input id="value"></label><button id="submit">Submit</button><output id="result">Ready</output><script>window.bench={count:0,submissions:0,events:[],reset(token){this.count=0;this.submissions=0;this.events=[];this.token=token;document.querySelector('#count').textContent='0';document.querySelector('#value').value='';document.querySelector('#result').textContent='Ready';window.scrollTo(0,0);document.activeElement.blur();}};document.querySelector('#increment').addEventListener('click',e=>{bench.count++;document.querySelector('#count').textContent=String(bench.count);bench.events.push({kind:'increment',trusted:e.isTrusted});});document.querySelector('#value').addEventListener('input',e=>bench.events.push({kind:'input',trusted:e.isTrusted}));document.querySelector('#submit').addEventListener('click',e=>{bench.submissions++;document.querySelector('#result').textContent=document.querySelector('#value').value;bench.events.push({kind:'submit',trusted:e.isTrusted});});</script>`);
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + fixture.address().port;
  let executable = process.env.ASTER_EXECUTABLE || require('electron');
  if (executable.endsWith('.app')) executable = path.join(executable, 'Contents', 'MacOS', 'Aster');
  const flags = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile];
  const args = [...(process.env.ASTER_EXECUTABLE ? [] : [root]), ...flags];
  const env = { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const launchStart = performance.now();
  app = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.once('error', error => { stderr += error.message; }); app.stdout.on('data', data => { stdout += data; }); app.stderr.on('data', data => { stderr += data; });
  await until(() => fs.existsSync(path.join(profile, 'automation.json')), 'API startup', 60000);
  config = JSON.parse(fs.readFileSync(path.join(profile, 'automation.json'))); assert.equal(config.pid, app.pid);
  cold.browserLaunchAndApiReadyMs = performance.now() - launchStart;
  const connect = await timed(() => api('/connect', { name: 'Paired benchmark', transport: 'benchmark HTTP' })); agentId = connect.value.agentId; cold.apiConnectMs = connect.ms;
  heartbeat = setInterval(() => api('/heartbeat').catch(() => {}), 20000); heartbeat.unref();
  const human = await command('tabs.create', { url: origin + '/human', active: true }); humanId = human.id;
  const fixtureUrl = origin + '/fixture?paired-benchmark';
  const setup = await timed(async () => { const tab = await command('tabs.create', { url: fixtureUrl, active: false }); tabId = tab.id; await until(async () => { const item = (await command('tabs.list')).find(item => item.id === tabId); return item?.title === 'Paired input benchmark' && !item.isLoading; }, 'fixture load'); }); cold.fixtureCreateAndLoadMs = setup.ms;
  await until(() => {
    const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    else port = Number(stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    return port > 0;
  }, 'test-only CDP endpoint');
  const discovery = await timed(async () => until(async () => { const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }); const list = await response.json(); return list.find(item => item.type === 'page' && item.url === fixtureUrl); }, 'exact fixture CDP target')); target = discovery.value; cold.cdpTargetDiscoveryMs = discovery.ms;
  assert.equal(new URL(target.webSocketDebuggerUrl).hostname, '127.0.0.1');
  const connection = await timed(async () => { raw = new Protocol(target.webSocketDebuggerUrl); await raw.ready; }); cold.cdpWebSocketConnectMs = connection.ms;
  const initialization = await timed(async () => {
    await Promise.all(['Page.enable','DOM.enable','Runtime.enable'].map(method => raw.send(method)));
    const tree = await raw.send('Page.getFrameTree'); isolatedContext = (await raw.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'aster-benchmark-v1' })).executionContextId;
    // Normalize Chromium's transient initial focus in newly created hidden
    // pages before either route. Both cases start with the same explicit state.
    await raw.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  }); cold.cdpDomainAndIsolatedWorldSetupMs = initialization.ms;
  const engine = await raw.send('Browser.getVersion');
  const actualWebdriver = await evaluate('navigator.webdriver');
  const routes = [{ name: 'aster-persistent-api', act: () => page('page.click', { selector: '#increment' }) }, { name: 'raw-persistent-cdp', act: () => scopedRaw(() => rawClick('#increment')) }];
  cold.apiFirstAction = await sample('click', routes[0], 'cold-api', false, 0);
  cold.cdpFirstActionAfterDomainSetup = await sample('click', routes[1], 'cold-cdp', false, 0);
  if (!cold.apiFirstAction.ok || !cold.cdpFirstActionAfterDomainSetup.ok) throw new Error('Cold action/lifecycle verification failed; warm numbers would be misleading');
  await command('tabs.claim', { tabId });
  cases.push(await compare('click', routes));
  cases.push(await compare('workflow', [
    { name: 'aster-persistent-api', act: token => page('page.batch', { steps: [{ action: 'type', selector: '#value', text: token }, { action: 'click', selector: '#submit' }, { action: 'waitFor', selector: '#result', state: 'visible', text: token }] }) },
    { name: 'raw-persistent-cdp', act: token => scopedRaw(async () => { await rawType('#value', token); await rawClick('#submit'); await rawWaitText('#result', token); }) }
  ]));
  const browserState = await command('browser.state'); assert.equal(browserState.activeTabId, humanId, 'A benchmark route changed the human-selected tab');
  const report = {
    checkedAt: new Date().toISOString(), passed: failures.length === 0,
    scope: 'Same-engine local microbenchmark under a test-only remote-debugging-enabled launch; normal-launch regression is the correctness authority.',
    launch: { executable, args, flags, profile, pid: app.pid, normalLaunch: false, playwrightUsed: false, remoteEndpointLoopback: true, webdriver: actualWebdriver },
    engine, health: await api('/health', null, 'GET'), cold, cases, failures,
    protocol: { sameExecutableAndTarget: true, sameFixture: true, sameCommonVerifier: true, beforeEachResetOutsideTiming: true, baseline:'Hidden view, emulation off, renderer widget already focused by the same harmless CDP mouse move before every route; native tab selection unchanged', verifiedEffectAndRestoredLifecycleInsideTiming: true, focusEmulation: 'Scoped on for hidden input, off before verification, both routes', apiCoordinationIncluded: true, rawCdpHasApiClaimsAndActivity: false, rawAdapter: 'Strict selector/actionability with CSS geometry, native CDP trusted pointer/text input, matching replacement semantics; root document only', externalDebuggerPresentDuringBothRoutes: true },
    limitations: ['The test-only remote-debugging launch can affect page state, including navigator.webdriver; its actual value is recorded.','Direct CDP does not provide Aster claims, activity logging, tab queues, or batch error reporting.','Fixture is local, static and in the root frame; this does not measure general browsing, remote networks, AX discovery or iframe input.','Acknowledgment latency is diagnostic; verified effect latency includes the same external verifier and renderer lifecycle restoration.','These numbers do not establish that Aster is universally faster or slower than Chrome, CDP, or other harnesses.']
  };
  fs.writeFileSync(path.join(work, 'agent-benchmark-results.json'), JSON.stringify(report, null, 2));
  for (const item of cases) console.log(item.kind, JSON.stringify(item.summary));
  if (!report.passed) process.exitCode = 1;
}
async function cleanup() {
  clearInterval(heartbeat);
  if (raw) { await raw.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); raw.close(); }
  if (config && agentId) await api('/disconnect').catch(() => {});
  if (app && app.exitCode === null && app.signalCode === null) { app.kill('SIGTERM'); await Promise.race([new Promise(resolve => app.once('exit', resolve)), sleep(6000)]); if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL'); }
  await new Promise(resolve => fixture ? fixture.close(resolve) : resolve());
  fs.writeFileSync(path.join(work, 'agent-benchmark-stdout.log'), stdout); fs.writeFileSync(path.join(work, 'agent-benchmark-stderr.log'), stderr);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; fs.writeFileSync(path.join(work, 'agent-benchmark-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), passed: false, scope: 'Test-only CDP-enabled launch; benchmark failed before full comparison', fatal: error.message, cold, cases, failures }, null, 2)); }).finally(cleanup);
