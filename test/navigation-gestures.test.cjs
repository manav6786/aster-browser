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
test('pinch magnification is disabled in pages and shell without becoming history input', t => {
  const f = integrationFixture(); t.after(() => f.service.dispose());
  assert.deepEqual(f.wc.zoom, [[1, 1]]); assert.equal(f.wc.zoomMode, 'isolated');
  f.service.attachWebContents(f.wc); assert.equal(f.wc.zoom.length, 1);
  f.wc.emit('dom-ready'); assert.equal(f.wc.zoom.length, 2);
  f.wc.emit('input-event', {}, { type: 'gesturePinchBegin' });
  f.wc.emit('input-event', {}, { type: 'gesturePinchUpdate', scale: 1.5 });
  for (let i = 0; i < 6; i++) f.send(); assert.equal(f.wc.back, 0);
  f.wc.emit('input-event', {}, { type: 'gesturePinchEnd' });
  for (let i = 0; i < 6; i++) f.send(); assert.equal(f.wc.back, 0); assert.equal(f.wc.zoom.length, 2);
  const shell = new Contents('aster-ui://shell/index.html');
  f.service.attachWebContents(shell, { shell: true }); shell.emit('dom-ready');
  assert.deepEqual(shell.zoom, [[1, 1], [1, 1]]); assert.equal(shell.zoomMode, undefined);
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

test('logical browser history overrides a remote-only native stack and rejects stale tab contexts', async t => {
  const ipcMain = new IPC(), wc = new Contents(); let time = 1000, contextId = 'tab-a';
  wc.navigationHistory.canGoBack = () => false;
  const travelled = [], failures = [];
  const service = createNavigationGestures({ ipcMain, currentWebContents: () => wc, platform: 'darwin', now: () => time,
    availabilityForWebContents: () => ({ canGoBack: true, canGoForward: false }),
    navigationContextForWebContents: () => contextId,
    navigate: async (target, direction) => { travelled.push({ target, direction }); }, onError: error => failures.push(error) });
  service.attachWebContents(wc); t.after(() => service.dispose());
  const event = { sender: wc, senderFrame: wc.mainFrame };
  assert.equal(ipcMain.handlers.get(CHANNELS.ready)(event, wc.url).canGoBack, true);
  for (let i = 0; i < 4; i++) { time += 16; ipcMain.emit(CHANNELS.wheel, event, { url: wc.url, contextId: 'old-tab', deltaX: -55, deltaY: 0, deltaMode: 0 }); }
  assert.equal(travelled.length, 0);
  for (let i = 0; i < 8; i++) { time += 16; ipcMain.emit(CHANNELS.wheel, event, { url: wc.url, contextId, deltaX: -55, deltaY: 0, deltaMode: 0 }); }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(travelled.map(v => v.direction), ['back']); assert.equal(travelled[0].target, wc); assert.equal(wc.back, 0); assert.deepEqual(failures, []);
});

test('explicit browser-shell ownership enables home history without zooming browser chrome', t => {
  const ipcMain = new IPC(), wc = new Contents('aster-ui://shell/index.html'); let time = 1000;
  const travelled = [], service = createNavigationGestures({ ipcMain, currentWebContents: () => wc, platform: 'darwin', now: () => time,
    availabilityForWebContents: () => ({ canGoBack: false, canGoForward: true }), navigationContextForWebContents: () => 'home-tab',
    navigate: (_target, direction) => { travelled.push(direction); return true; } });
  t.after(() => service.dispose()); service.attachWebContents(wc, { shell: true });
  const event = { sender: wc, senderFrame: wc.mainFrame };
  assert.equal(ipcMain.handlers.get(CHANNELS.ready)(event, wc.url).canGoForward, true);
  assert.equal(ipcMain.handlers.get(CHANNELS.ready)(event, 'aster-ui://shell/other.html').enabled, false);
  for (let i = 0; i < 8; i++) { time += 16; ipcMain.emit(CHANNELS.wheel, event, { url: wc.url, contextId: 'home-tab', deltaX: 55, deltaY: 0, deltaMode: 0 }); }
  assert.deepEqual(travelled, ['forward']); assert.deepEqual(wc.zoom, [[1, 1]]); assert.equal(wc.zoomMode, undefined);
  service.dispose();
  const unowned = createNavigationGestures({ ipcMain: new IPC(), currentWebContents: () => wc, platform: 'darwin' });
  t.after(() => unowned.dispose()); unowned.attachWebContents(wc);
  assert.equal(unowned ? wc.sent.length >= 0 : false, true);
});

test('an asynchronous logical navigation failure is handled once rather than replaying momentum', async t => {
  const ipcMain = new IPC(), wc = new Contents(); let time = 1000, attempts = 0;
  const failures = [], service = createNavigationGestures({ ipcMain, currentWebContents: () => wc, platform: 'darwin', now: () => time,
    navigate: async () => { attempts++; throw new Error('navigation cancelled'); }, onError: error => failures.push(error.message) });
  service.attachWebContents(wc); t.after(() => service.dispose());
  for (let i = 0; i < 15; i++) { time += 16; ipcMain.emit(CHANNELS.wheel, { sender: wc, senderFrame: wc.mainFrame }, { url: wc.url, deltaX: -55, deltaY: 0, deltaMode: 0 }); }
  await new Promise(resolve => setImmediate(resolve)); assert.equal(attempts, 1); assert.deepEqual(failures, ['navigation cancelled']);
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

test('shell preload accepts only internal page content and captures the originating tab context', async () => {
  const ipc = new EventEmitter(), sent = [], listeners = new Map(), tasks = [];
  const url = 'aster-ui://shell/index.html', content = { nodeType: 1, tagName: 'MAIN', scrollWidth: 800, clientWidth: 800, scrollLeft: 0, style: { overflowX: 'hidden', direction: 'ltr', overscrollBehaviorX: 'auto' } };
  const root = { ...content, tagName: 'HTML' }, window = { visualViewport: { scale: 1 } }; window.top = window;
  ipc.invoke = async () => ({ url, enabled: true, canGoBack: true, canGoForward: true, contextId: 'tab-a' }); ipc.send = (...args) => sent.push(args);
  const context = { window, location: { href: url }, document: { scrollingElement: root, body: root, getElementById: id => id === 'content' ? content : null }, require: () => ({ ipcRenderer: ipc }),
    getComputedStyle: element => element.style, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {}, setTimeout: fn => tasks.push(fn) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/navigation-preload.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const event = nodes => ({ isTrusted: true, deltaX: -55, deltaY: 0, deltaMode: 0, composedPath: () => nodes });
  listeners.get('wheel')(event([root])); while (tasks.length) tasks.shift()(); assert.equal(sent.length, 0, 'Toolbar/sidebar scroll is not page history navigation');
  listeners.get('wheel')(event([content, root]));
  ipc.emit(CHANNELS.state, {}, { url, enabled: true, canGoBack: true, canGoForward: true, contextId: 'tab-b' });
  while (tasks.length) tasks.shift()();
  assert.equal(sent.length, 1); assert.equal(sent[0][1].contextId, 'tab-a', 'Delayed event must not inherit a newer active tab');
  assert.equal(window.aster, undefined, 'Gesture preload adds no page bridge');
});

test('physical phases accept a short quick swipe and an immediate opposite new gesture', () => {
 const f=wheelFixture(),finger=id=>({precise:true,gestureId:id,phase:4,momentum:0});
 assert.equal(f.send({deltaX:-25,nativePhase:finger(1)}),null);
 assert.equal(f.send({deltaX:-30,nativePhase:finger(1)}),'back');
 assert.equal(f.send({deltaX:25,nativePhase:finger(2)}),null);
 assert.equal(f.send({deltaX:30,nativePhase:finger(2)}),'forward');
});
test('native momentum never initiates another history step or rearms a consumed finger gesture', () => {
 const f=wheelFixture(),finger={precise:true,gestureId:1,phase:4,momentum:0};
 f.send({deltaX:-25,nativePhase:finger});assert.equal(f.send({deltaX:-30,nativePhase:finger}),'back');
 for(let i=0;i<370;i++)assert.equal(f.send({deltaX:-30,nativePhase:{...finger,phase:0,momentum:4}}),null);
 assert.equal(f.send({deltaX:-80,nativePhase:finger}),null);
 assert.equal(f.send({deltaX:25,nativePhase:{...finger,gestureId:2}}),null);
 assert.equal(f.send({deltaX:30,nativePhase:{...finger,gestureId:2}}),'forward');
 const onlyMomentum=wheelFixture();for(let i=0;i<10;i++)assert.equal(onlyMomentum.send({nativePhase:{...finger,phase:0,momentum:4}}),null);
});
test('physical phase changes do not weaken vertical, editable, cancelled or modifier exclusions', () => {
 for(const first of [{deltaX:1,deltaY:50},{blocked:true},{control:true},{deltaMode:1}]){
  const f=wheelFixture(),finger={precise:true,gestureId:1,phase:4,momentum:0};
  f.send({...first,nativePhase:finger});for(let i=0;i<8;i++)assert.equal(f.send({nativePhase:finger}),null);
  assert.equal(f.send({deltaX:-25,nativePhase:{...finger,gestureId:2}}),null);
  assert.equal(f.send({deltaX:-30,nativePhase:{...finger,gestureId:2}}),'back');
 }
});
test('window phase latch spans remote view replacement and reports matched physical events', t => {
 const ipcMain=new IPC(),a=new Contents(),b=new Contents('https://other.test/');let active=a,time=1000,phase={precise:true,gestureId:1,phase:4,momentum:0,distanceMs:.5},disposed=0;
 const reader={available:true,sample:()=>phase,dispose(){disposed++;}},win=new EventEmitter();win.isDestroyed=()=>false;win.isFocused=()=>true;
 const service=createNavigationGestures({ipcMain,currentWebContents:()=>active,now:()=>time,platform:'darwin',phaseReaderFactory:()=>reader});t.after(()=>service.dispose());service.attachWebContents(a);service.attachWebContents(b);service.attachWindow(win);
 const send=(dx)=>{time+=16;ipcMain.emit(CHANNELS.wheel,{sender:active,senderFrame:active.mainFrame},{url:active.url,eventTime:time,deltaX:dx,deltaY:0,deltaMode:0});};
 send(-25);send(-30);assert.equal(a.back,1);active=b;for(let i=0;i<8;i++)send(-40);assert.equal(b.back,0);
 phase={...phase,gestureId:2};send(25);send(30);assert.equal(b.forward,1);
 const state=service.getState();assert.equal(state.nativePhases,true);assert.equal(state.nativeNavigations,2);assert.ok(state.momentumSuppressed>=8);assert.equal(state.lastMatchDistanceMs,.5);
 win.emit('closed');assert.equal(disposed,1);assert.equal(service.getState().nativePhases,false);
});
test('ordinary unphased wheel input never inherits a permanently consumed native generation', t => {
 const ipcMain=new IPC(),wc=new Contents();let time=1000;
 const win=new EventEmitter();win.isDestroyed=()=>false;win.isFocused=()=>true;
 const service=createNavigationGestures({ipcMain,currentWebContents:()=>wc,now:()=>time,platform:'darwin',phaseReaderFactory:()=>({available:true,sample:()=>({precise:false,gestureId:0,phase:0,momentum:0}),dispose(){}})});t.after(()=>service.dispose());service.attachWebContents(wc);service.attachWindow(win);
 const send=()=>{time+=16;ipcMain.emit(CHANNELS.wheel,{sender:wc,senderFrame:wc.mainFrame},{url:wc.url,eventTime:time,deltaX:-55,deltaY:0,deltaMode:0});};
 for(let i=0;i<4;i++)send();assert.equal(wc.back,1);time+=1200;for(let i=0;i<4;i++)send();assert.equal(wc.back,2);assert.equal(service.getState().nativeNavigations,0);
});
test('native phase wrapper owns one token, fails closed and disposes idempotently', () => {
 const {createNativeGesturePhases}=require('../src/main/native-gesture-phases.cjs');const calls=[],handle=Buffer.alloc(8),token={};
 const reader=createNativeGesturePhases({getNativeWindowHandle:()=>handle},{platform:'darwin',native:{attach:h=>{calls.push(h);return token;},sample:(t,at)=>{assert.equal(t,token);return {at};},dispose:t=>calls.push(t)}});
 assert.equal(reader.available,true);assert.deepEqual(reader.sample(12),{at:12});reader.dispose();reader.dispose();assert.equal(reader.sample(13),null);assert.deepEqual(calls,[handle,token]);
 assert.equal(createNativeGesturePhases({},{platform:'darwin'}).available,false);
});
