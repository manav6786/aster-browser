'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { installMediaGain } = require('../src/main/media-gain.cjs');
const { createMediaController, CHANNELS } = require('../src/main/media.cjs');

function pageWorld({ playing = false, title = 'Test video', pip = true } = {}) {
  const context = vm.createContext({ WeakRef, console, setTimeout, clearTimeout });
  vm.runInContext(`
    const all = [], listeners = new Map();
    class Element {
      constructor(tagName = 'DIV') { this.tagName = tagName; this.nodeType = 1; this.isConnected = true; this.children = []; this.shadowRoot = null; }
      querySelectorAll(selector) { return selector === '*' ? this.children : this.children.filter(e => ['AUDIO','VIDEO'].includes(e.tagName)); }
      getAttribute() { return ''; }
      attachShadow(options) { const root = new Element('SHADOW'); if (options.mode === 'open') this.shadowRoot = root; return root; }
    }
    class HTMLMediaElement extends Element {
      constructor(tagName = 'AUDIO') { super(tagName); this._volume = 1; this.paused = true; this.ended = false; this.readyState = 4; this.title = ''; }
      get volume() { return this._volume; }
      set volume(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > 1) throw new RangeError('Invalid volume'); this._volume = n; }
      play() { this.paused = false; return Promise.resolve(); }
      load() { this.loaded = true; }
      set src(value) { this._src = value; } get src() { return this._src; }
      set srcObject(value) { this._srcObject = value; } get srcObject() { return this._srcObject; }
      set autoplay(value) { this._autoplay = value; } get autoplay() { return this._autoplay; }
    }
    class HTMLVideoElement extends HTMLMediaElement {
      constructor() { super('VIDEO'); this.videoWidth = 640; this.videoHeight = 360; this.disablePictureInPicture = false; }
      requestPictureInPicture() { document.pictureInPictureElement = this; return Promise.resolve({width:320,height:180}); }
    }
    class AudioNode {
      constructor(context) { this.context = context; this.connections = []; }
      connect(destination, ...args) { this.connections.push({destination,args}); return destination; }
      disconnect(...args) { this.disconnected = args; }
    }
    class BaseAudioContext {
      constructor() { this.destination = new AudioNode(this); this.currentTime = 2; this.gains = []; }
      createGain() { const gain = new AudioNode(this); gain.gain = {value:1,setTargetAtTime(value){this.value=value;}}; this.gains.push(gain); return gain; }
    }
    class AudioContext extends BaseAudioContext { createMediaElementSource(element) { return new MediaElementAudioSourceNode(this,{mediaElement:element}); } }
    class OfflineAudioContext extends BaseAudioContext {}
    class MediaElementAudioSourceNode extends AudioNode { constructor(context,options) { super(context); this.mediaElement = options.mediaElement; } }
    function Audio() { return new HTMLMediaElement('AUDIO'); }
    const document = { title: ${JSON.stringify(title)}, pictureInPictureEnabled: ${Boolean(pip)}, pictureInPictureElement: null, querySelectorAll(selector) { return selector === '*' ? all : all.filter(e => ['AUDIO','VIDEO'].includes(e.tagName)); }, exitPictureInPicture() { this.pictureInPictureElement = null; return Promise.resolve(); } };
    class MutationObserver { constructor(callback) { this.callback = callback; } observe(){} disconnect(){} }
    function addEventListener(name,callback) { listeners.set(name,callback); }
    Object.assign(globalThis,{Element,HTMLMediaElement,HTMLVideoElement,AudioNode,BaseAudioContext,AudioContext,OfflineAudioContext,MediaElementAudioSourceNode,Audio,document,MutationObserver,addEventListener});
    const video = new HTMLVideoElement(); video.paused = ${!playing}; all.push(video);
  `, context);
  return { context, eval: source => vm.runInContext(source, context) };
}

test('HTML media volume preserves page intent as a multiplier, including new and detached audio', () => {
  const world = pageWorld(); world.eval('(' + installMediaGain.toString() + ')("test-gain",.5)');
  assert.equal(world.eval('video.volume'), 1); assert.equal(world.eval('video._volume'), .5);
  world.eval('video.volume=.4'); assert.equal(world.eval('video.volume'), .4); assert.equal(world.eval('video._volume'), .2);
  world.eval('const detached=new Audio(); detached.volume=.6'); assert.equal(world.eval('detached._volume'), .3);
  world.eval('globalThis[Symbol.for("test-gain")].setVolume(.25)'); assert.equal(world.eval('video._volume'), .1); assert.equal(world.eval('detached._volume'), .15);
  world.eval('const later=new HTMLMediaElement();later.play()'); assert.equal(world.eval('later._volume'), .25);
  assert.throws(() => world.eval('video.volume=2'), /Invalid volume/);
  assert.equal(world.eval('globalThis.aster'), undefined);
});

test('realtime Web Audio output gains preserve connect/disconnect semantics and avoid double attenuation', () => {
  const world = pageWorld(); world.eval('(' + installMediaGain.toString() + ')("test-gain",.5)');
  world.eval('const ctx=new AudioContext(), source=new AudioNode(ctx); const target=source.connect(ctx.destination)');
  assert.equal(world.eval('target===ctx.destination'), true); assert.equal(world.eval('ctx.gains.length'), 1); assert.equal(world.eval('ctx.gains[0].gain.value'), .5);
  assert.equal(world.eval('source.connections[0].destination===ctx.gains[0]'), true);
  world.eval('source.disconnect(ctx.destination)'); assert.equal(world.eval('source.disconnected[0]===ctx.gains[0]'), true);
  world.eval('video.volume=.6; const mediaSource=ctx.createMediaElementSource(video); mediaSource.connect(ctx.destination)');
  assert.equal(world.eval('video._volume'), .6, 'media source uses output gain exactly once');
  world.eval('const other=new HTMLMediaElement();other.volume=.8;const constructed=new globalThis.MediaElementAudioSourceNode(ctx,{mediaElement:other});constructed.connect(ctx.destination)'); assert.equal(world.eval('other._volume'), .8);
  world.eval('globalThis[Symbol.for("test-gain")].setVolume(.25)'); assert.equal(world.eval('ctx.gains[0].gain.value'), .25); assert.equal(world.eval('video._volume'), .6);
  world.eval('const offline=new OfflineAudioContext(), offlineSource=new AudioNode(offline);offlineSource.connect(offline.destination)'); assert.equal(world.eval('offline.gains.length'), 0, 'tab volume must not alter offline audio exports');
});

test('future closed shadow roots are included in video enumeration and genuine PiP API dispatch', async () => {
  const world = pageWorld(); world.eval('(' + installMediaGain.toString() + ')("test-gain",.5)');
  world.eval('const host=new Element(); const closed=host.attachShadow({mode:"closed"});const inner=new HTMLVideoElement();inner.title="Shadow video";closed.children.push(inner)');
  const result = world.eval('globalThis[Symbol.for("test-gain")].inspect()'); assert.equal(result.videos.length, 2); assert.equal(result.videos[1].title, 'Shadow video');
  await world.eval('globalThis[Symbol.for("test-gain")].togglePip("v2")'); assert.equal(world.eval('document.pictureInPictureElement===inner'), true);
  await world.eval('globalThis[Symbol.for("test-gain")].togglePip("v2")'); assert.equal(world.eval('document.pictureInPictureElement'), null);
});

class Frame {
  constructor(id, url, options = {}) { this.frameTreeNodeId = id; this.url = url; this.detached = false; this.world = pageWorld(options); this.gestures = []; this.messages = []; }
  isDestroyed() { return false; }
  executeJavaScript(source, gesture = false) { this.gestures.push(gesture); return Promise.resolve(this.world.eval(source)); }
  send(channel, message) { this.messages.push({ channel, message }); }
}
class Contents extends EventEmitter {
  constructor(frames) { super(); this.mainFrame = frames[0]; this.mainFrame.framesInSubtree = frames; this.muted = false; this.audible = true; }
  isDestroyed() { return false; }
  isAudioMuted() { return this.muted; }
  isCurrentlyAudible() { return this.audible; }
}
function controllerFixture() {
  const ipcMain = new EventEmitter(), updates = [];
  const main = new Frame(1, 'https://main.test/', { title: 'Main' }), child = new Frame(2, 'https://cross-origin.test/', { playing: true, title: 'Embedded video' });
  const wc = new Contents([main, child]), tab = { id: 'owned-tab', volume: .7, muted: false };
  const service = createMediaController({ ipcMain, onChange: (...args) => updates.push(args) }); service.attachWebContents(wc, tab);
  return { ipcMain, updates, main, child, wc, tab, service };
}

test('controller enumerates cross-origin WebFrameMain documents and uses user gesture for native PiP', async t => {
  const f = controllerFixture(); t.after(() => f.service.dispose());
  let state = await f.service.get(f.wc); assert.equal(state.videoCount, 2); assert.equal(state.videos[1].frameId, '2'); assert.equal(state.volume, .7);
  state = await f.service.togglePip(f.wc); assert.equal(state.pipActive, true); assert.equal(state.videos.find(v => v.pipActive).title, 'Embedded video');
  assert.ok(f.child.gestures.includes(true)); assert.ok(f.main.gestures.every(value => !value));
  state = await f.service.togglePip(f.wc); assert.equal(state.pipActive, false);
});

test('concurrent PiP requests share one in-flight toggle instead of immediately closing it', async t => {
  const f = controllerFixture(); t.after(() => f.service.dispose());
  const states = await Promise.all([f.service.togglePip(f.wc), f.service.togglePip(f.wc)]);
  assert.ok(states.every(state => state.pipActive));
  assert.equal((await f.service.get(f.wc)).pipActive, true);
});

test('volume reaches all existing frames and remains on tab for future documents', async t => {
  const f = controllerFixture(); t.after(() => f.service.dispose());
  const state = await f.service.setVolume(f.wc, .3); assert.equal(f.tab.volume, .3); assert.equal(state.volume, .3);
  for (const frame of [f.main, f.child]) { assert.equal(frame.world.eval('video._volume'), .3); assert.equal(frame.messages[0].channel, CHANNELS.volume); }
  await assert.rejects(f.service.setVolume(f.wc, 1.1), /between 0 and 1/); await assert.rejects(f.service.setVolume(f.wc, '.3'), /number/);
});

test('SPA URL changes retain one document runtime and never square its gain', async t => {
  const f = controllerFixture(); t.after(() => f.service.dispose());
  await f.service.get(f.wc); const before = f.main.world.eval('video._volume'); assert.equal(before, .7);
  f.main.url = 'https://main.test/next-route';
  await f.service.get(f.wc); assert.equal(f.main.world.eval('video._volume'), .7);
  await f.service.setVolume(f.wc, .3); assert.equal(f.main.world.eval('video._volume'), .3);
  assert.equal(f.main.world.eval('video.volume'), 1);
});

test('a replacement frame wrapper reuses its document gain instead of attenuating twice', async t => {
  const f = controllerFixture(); t.after(() => f.service.dispose());
  await f.service.get(f.wc);
  f.child.world.eval('const ctx=new AudioContext(), source=new AudioNode(ctx); source.connect(ctx.destination)');
  const replacement = new Frame(2, f.child.url); replacement.world=f.child.world;
  f.wc.mainFrame.framesInSubtree[1]=replacement;
  await f.service.get(f.wc);
  assert.equal(replacement.world.eval('video._volume'),.7);
  assert.equal(replacement.world.eval('video.volume'),1);
  assert.equal(replacement.world.eval('ctx.gains.length'),1);
  await f.service.setVolume(f.wc,.3);
  assert.equal(replacement.world.eval('video._volume'),.3);
  assert.equal(replacement.world.eval('ctx.gains[0].gain.value'),.3);
});

test('preload handshake validates exact owned frame, URL and registration while allowing background frames', t => {
  const f = controllerFixture(); t.after(() => f.service.dispose());
  function ready(sender, senderFrame, url = senderFrame.url) { let writes=0,reply;const event={sender,senderFrame};Object.defineProperty(event,'returnValue',{set(value){writes++;if(writes===1)reply=value;}});f.ipcMain.emit(CHANNELS.ready,event,{url,nonce:'nonce'});assert.equal(writes,1,'Electron sends the first synchronous returnValue assignment');return reply; }
  assert.equal(ready(new Contents([new Frame(99, f.main.url)]), f.main), null);
  assert.equal(ready(f.wc, new Frame(1, f.main.url)), null);
  assert.equal(ready(f.wc, f.child, 'https://wrong.test/'), null);
  assert.equal(ready(f.wc, f.child).volume, .7, 'background cross-origin child is a valid owned frame');
  f.child.detached = true; assert.equal(ready(f.wc, f.child), null);
});

test('session and webContents attachment is idempotent and disposal removes all owned listeners/preloads', async () => {
  const f = controllerFixture(); let installed = 0, removed = 0;
  const ses = { registerPreloadScript(script) { installed++; assert.equal(script.type, 'frame'); return 'media-id'; }, unregisterPreloadScript(id) { removed++; assert.equal(id, 'media-id'); } };
  f.service.attachSession(ses); f.service.attachSession(ses); f.service.attachWebContents(f.wc, f.tab);
  assert.equal(installed, 1); assert.equal(f.wc.listenerCount('dom-ready'), 1);
  f.service.dispose(); assert.equal(removed, 1); assert.equal(f.wc.listenerCount('dom-ready'), 0); assert.equal(f.ipcMain.listenerCount(CHANNELS.ready), 0);
  await assert.rejects(f.service.get(f.wc), /no longer available/);
});

test('generated sandbox preload stays current and exposes no page-callable IPC bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/media-preload.cjs'), 'utf8');
  assert.ok(source.includes(installMediaGain.toString())); assert.ok(source.includes('webFrame.executeJavaScript'));
  assert.equal(source.includes('exposeInMainWorld'), false); assert.equal(source.includes('window.postMessage'), false); assert.equal(source.includes('eval('), false);
});
