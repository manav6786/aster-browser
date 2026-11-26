'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WheelNavigation, createNavigationGestures, CHANNELS } = require('../src/main/navigation-gestures.cjs');

function wheelFixture() {
  let time = 1000; const reducer = new WheelNavigation({ now: () => time });
  return { reducer, advance(ms) { time += ms; }, send(values = {}) { time += 16; return reducer.consume({ deltaX: -55, deltaY: 1, deltaMode: 0, canGoBack: true, canGoForward: true, ...values }); } };
}
test('one deliberate horizontal edge gesture navigates once through its momentum tail', () => {
  const f = wheelFixture(); assert.equal(f.send(), null); assert.equal(f.send(), null); assert.equal(f.send(), 'back');
  for (let i = 0; i < 30; i++) assert.equal(f.send(), null);
  f.advance(1200); assert.equal(f.send({ deltaX: 60 }), null); assert.equal(f.send({ deltaX: 60 }), null); assert.equal(f.send({ deltaX: 60 }), 'forward');
});
test('vertical movement, scrollable ancestors, modifiers and line wheels cannot become navigation mid-gesture', () => {
  for (const first of [{ deltaX: 1, deltaY: 50 }, { blocked: true }, { control: true }, { deltaMode: 1 }, { deltaX: NaN }]) {
    const f = wheelFixture(); assert.equal(f.send(first), null);
    for (let i = 0; i < 12; i++) assert.equal(f.send(), null, JSON.stringify(first));
  }
  const f = wheelFixture(); assert.equal(f.send({ deltaX: -500 }), null, 'A single mouse tick must not navigate');
});
test('direction reversals, unavailable history and burst tails do not cause duplicate navigation', () => {
  const f = wheelFixture(); f.send({ deltaX: -70 }); f.send({ deltaX: 70 }); assert.equal(f.send({ deltaX: -70 }), null);
  f.advance(1200); f.send({ canGoBack: false }); f.send({ canGoBack: false }); assert.equal(f.send({ canGoBack: false }), null);
  assert.equal(f.send({ canGoBack: true }), null, 'Availability changes during momentum must not trigger a delayed action');
  f.advance(400); for (let i = 0; i < 5; i++) assert.equal(f.send(), null, 'A momentum burst inside the refractory period remains suppressed');
});

class IPC extends EventEmitter { constructor() { super(); this.handlers = new Map(); } handle(name, callback) { this.handlers.set(name, callback); } removeHandler(name) { this.handlers.delete(name); } }
class Contents extends EventEmitter {
  constructor(url = 'https://example.test/') {
    super(); this.url = url; this.mainFrame = { url }; this.sent = []; this.zoom = []; this.back = 0; this.forward = 0; this.destroyed = false;
    this.navigationHistory = { canGoBack: () => true, canGoForward: () => true, goBack: () => this.back++, goForward: () => this.forward++ };
  }
  isDestroyed() { return this.destroyed; } getURL() { return this.url; }
  send(name, value) { this.sent.push({ name, value }); } setZoomMode(mode) { this.zoomMode = mode; }
  setVisualZoomLevelLimits(...args) { this.zoom.push(args); return Promise.resolve(); }
}
function integrationFixture() {
  let time = 1000, active, enabled = true;
  const ipcMain = new IPC(), wc = new Contents(); active = wc;
  const service = createNavigationGestures({ ipcMain, currentWebContents: () => active, canHandle: () => enabled, platform: 'darwin', now: () => time }); service.attachWebContents(wc);
  return { ipcMain, wc, service, advance(ms) { time += ms; }, active(value) { active = value; }, enabled(value) { enabled = value; }, send(message = {}, event = { sender: wc, senderFrame: wc.mainFrame }) { time += 16; ipcMain.emit(CHANNELS.wheel, event, { url: wc.url, deltaX: -55, deltaY: 0, deltaMode: 0, ...message }); } };
}
test('main integration validates active sender, main frame, URL and overlay permission', t => {
  const f = integrationFixture(); t.after(() => f.service.dispose());
  const alien = new Contents();
  for (let i = 0; i < 4; i++) f.send({}, { sender: alien, senderFrame: alien.mainFrame });
  for (let i = 0; i < 4; i++) f.send({}, { sender: f.wc, senderFrame: { url: f.wc.url } });
  for (let i = 0; i < 4; i++) f.send({ url: 'https://other.test/' });
  f.enabled(false); for (let i = 0; i < 4; i++) f.send(); f.enabled(true);
  f.active(alien); for (let i = 0; i < 4; i++) f.send(); f.active(f.wc);
  assert.equal(f.wc.back, 0); for (let i = 0; i < 4; i++) f.send(); assert.equal(f.wc.back, 1);
});
test('pinch is native visual zoom and is never manually applied a second time', t => {
  const f = integrationFixture(); t.after(() => f.service.dispose());
  assert.deepEqual(f.wc.zoom, [[1, 5]]); assert.equal(f.wc.zoomMode, 'isolated');
  f.service.attachWebContents(f.wc); assert.equal(f.wc.zoom.length, 1);
  f.wc.emit('dom-ready'); assert.equal(f.wc.zoom.length, 2);
  f.wc.emit('input-event', {}, { type: 'gesturePinchBegin' });
  f.wc.emit('input-event', {}, { type: 'gesturePinchUpdate', scale: 1.5 });
  for (let i = 0; i < 6; i++) f.send(); assert.equal(f.wc.back, 0);
  f.wc.emit('input-event', {}, { type: 'gesturePinchEnd' });
  for (let i = 0; i < 6; i++) f.send(); assert.equal(f.wc.back, 0); assert.equal(f.wc.zoom.length, 2);
});
test('legacy swipe and wheel fallback share a duplicate-navigation latch and dispose cleanly', t => {
  const f = integrationFixture(); t.after(() => f.service.dispose());
  const win = new EventEmitter(); win.isDestroyed = () => false; win.isFocused = () => true; f.service.attachWindow(win); f.service.attachWindow(win);
  for (let i = 0; i < 4; i++) f.send(); win.emit('swipe', {}, 'right'); assert.equal(f.wc.back, 1);
  f.advance(1200); win.emit('swipe', {}, 'up'); assert.equal(f.wc.forward, 0); win.emit('swipe', {}, 'left'); assert.equal(f.wc.forward, 1);
  let registered = 0, removed = 0; const ses = { registerPreloadScript() { registered++; return 'id'; }, unregisterPreloadScript(id) { assert.equal(id, 'id'); removed++; } };
  f.service.attachSession(ses); f.service.attachSession(ses); assert.equal(registered, 1);
  f.service.dispose(); assert.equal(removed, 1); assert.equal(win.listenerCount('swipe'), 0); assert.equal(f.ipcMain.handlers.size, 0); assert.equal(f.wc.listenerCount('input-event'), 0);
});

test('sandbox preload preserves scroll chains, RTL edges, page cancellation and trusted-input boundary', async () => {
  const ipc = new EventEmitter(), sent = [], listeners = new Map(), microtasks = [];
  const url = 'https://fixture.test/', root = { nodeType: 1, tagName: 'HTML', scrollWidth: 800, clientWidth: 800, scrollLeft: 0, style: { overflowX: 'auto', direction: 'ltr', overscrollBehaviorX: 'auto' } };
  const window = { visualViewport: { scale: 1 } }; window.top = window;
  ipc.invoke = async () => ({ url, enabled: true, canGoBack: true, canGoForward: true }); ipc.send = (...args) => sent.push(args);
  const context = { window, location: { href: url }, document: { scrollingElement: root, body: root }, require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc }; },
    getComputedStyle: element => element.style, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {}, setTimeout: callback => microtasks.push(callback),queueMicrotask: callback => callback() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/navigation-preload.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  function dispatch(element = root, extra = {}) {
    const event = { isTrusted: true, deltaX: -55, deltaY: 0, deltaMode: 0, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, composedPath: () => [element, root], ...extra };
    const before = sent.length; listeners.get('wheel')(event); while (microtasks.length) microtasks.shift()(); return sent.length > before ? sent.at(-1)[1] : null;
  }
  const carousel = { nodeType: 1, tagName: 'DIV', scrollWidth: 600, clientWidth: 200, scrollLeft: 100, style: { overflowX: 'auto', direction: 'ltr', overscrollBehaviorX: 'auto' } };
  assert.equal(dispatch(carousel).blocked, true); carousel.scrollLeft = 0; assert.equal(dispatch(carousel).blocked, false);
  carousel.style.overscrollBehaviorX = 'contain'; assert.equal(dispatch(carousel).blocked, true); carousel.style.overscrollBehaviorX = 'auto';
  carousel.style.direction = 'rtl'; carousel.scrollLeft = -100; assert.equal(dispatch(carousel, { deltaX: 55 }).blocked, true);
  carousel.scrollLeft = 0; assert.equal(dispatch(carousel, { deltaX: 55 }).blocked, false);
  assert.equal(dispatch(root, { ctrlKey: true }).blocked, true); assert.equal(dispatch(root, { deltaMode: 1 }).blocked, true);
  assert.equal(dispatch(root, { isTrusted: false }), null);
  window.visualViewport.scale = 2; assert.equal(dispatch().blocked, true); window.visualViewport.scale = 1;
  const input = { ...carousel, tagName: 'INPUT' }; assert.equal(dispatch(input).blocked, true);
  const event = { isTrusted: true, deltaX: -55, deltaY: 0, deltaMode: 0, composedPath: () => [root] };
  listeners.get('wheel')(event); event.defaultPrevented = true; while (microtasks.length) microtasks.shift()(); assert.equal(sent.at(-1)[1].blocked, true);
  assert.equal(window.aster, undefined, 'Preload must not expose a page bridge');
});
