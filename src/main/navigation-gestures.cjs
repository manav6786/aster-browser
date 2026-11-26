'use strict';
const path = require('node:path');
const { createNativeGesturePhases } = require('./native-gesture-phases.cjs');

const CHANNELS = Object.freeze({ ready: 'aster:gestures:ready', wheel: 'aster:gestures:wheel', state: 'aster:gestures:state' });

// An AppKit finger gesture gets one navigation, independent of the momentum
// events that follow it. The conservative DOM-only path remains available for
// platforms/input sources without physical phase metadata.
class WheelNavigation {
  constructor({ now = Date.now, idleMs = 300, refractoryMs = 900, distance = 150, samples = 3 } = {}) {
    Object.assign(this, { now, idleMs, refractoryMs, distance, samples });
    this.lastNavigation = -Infinity; this.nativeGesture = null; this.reset();
  }
  reset() { this.last = null; this.started = null; this.x = 0; this.absX = 0; this.absY = 0; this.count = 0; this.blocked = false; this.fired = false; this.velocity = 0; }
  suppress() { this.blocked = true; this.last = this.now(); }
  markNavigation() { this.lastNavigation = this.now(); this.fired = true; this.last = this.now(); }
  consume(input) {
    const time = this.now(), native = input.nativePhase;
    const phased = !!(native?.precise && Number.isSafeInteger(native.gestureId) && native.gestureId >= 0);
    if (phased) {
      if (native.momentum || (native.phase & 16)) { this.fired = true; this.last = time; return null; }
      if (this.nativeGesture !== native.gestureId) { this.reset(); this.started = time; this.nativeGesture = native.gestureId; }
    } else if (this.last === null || time - this.last > this.idleMs) {
      this.reset(); this.started = time; this.nativeGesture = null;
      if (time - this.lastNavigation < this.refractoryMs) this.blocked = true;
    }
    const previousTime = this.last; this.last = time;
    const { deltaX, deltaY } = input;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 2000 || Math.abs(deltaY) > 2000 || input.deltaMode !== 0) { this.blocked = true; return null; }
    this.count++; this.x += deltaX; this.absX += Math.abs(deltaX); this.absY += Math.abs(deltaY);
    if (previousTime !== null && time > previousTime) this.velocity = deltaX / Math.max(8, Math.min(50, time - previousTime));
    if (input.blocked || input.control || input.meta || input.alt || input.shift) this.blocked = true;
    if (this.absY >= 24 && this.absY > this.absX * 1.25) this.blocked = true;
    const minimumSamples = phased ? 2 : this.samples, minimumTime = phased ? 12 : 20;
    if (this.blocked || this.fired || this.count < minimumSamples || time - this.started < minimumTime) return null;
    if (Math.abs(this.x) < this.absY * 2 || Math.abs(this.x) < this.absX * .75) return null;
    // Mozilla's documented history model uses a quarter of550px plus a50ms
    // velocity contribution. This independent implementation requires some
    // actual travel and a coherent direction; a single tick cannot navigate.
    const threshold = phased ? 137.5 : this.distance;
    const velocity = Math.sign(this.velocity) === Math.sign(this.x) ? Math.abs(this.velocity) : 0;
    const intent = Math.abs(this.x) + (phased ? Math.min(100, velocity * 50) : 0);
    if (intent < threshold || (phased && Math.abs(this.x) < 40)) return null;
    this.fired = true; this.lastNavigation = time;
    const direction = this.x < 0 ? 'back' : 'forward';
    return input[direction === 'back' ? 'canGoBack' : 'canGoForward'] ? direction : null;
  }
}

function createNavigationGestures({ ipcMain, currentWebContents, canHandle = () => true, availabilityForWebContents, navigate: navigateBrowser, navigationContextForWebContents, platform = process.platform, now = Date.now, onError = () => {}, phaseReaderFactory = createNativeGesturePhases } = {}) {
  if (!ipcMain || typeof currentWebContents !== 'function') throw new TypeError('Navigation gestures require IPC and currentWebContents');
  const contents = new Map(), sessions = new WeakMap(), sessionRefs = new Set(), windows = new Map();
  let disposed = false;
  const diagnostics={phaseSamples:0,unmatchedSamples:0,momentumSuppressed:0,nativeNavigations:0,navigations:0,lastMatchDistanceMs:null};
  function activeWindow(){for(const [win,record] of windows)if(!win.isDestroyed()&&win.isFocused())return record;return null;}
  function available(wc) {
    try {
      const enabled = !disposed && platform === 'darwin' && wc && !wc.isDestroyed();
      const history = enabled && wc.navigationHistory, browser = enabled && availabilityForWebContents?.(wc);
      return { url: enabled ? wc.getURL() : '', enabled: Boolean(enabled), canGoBack: browser ? Boolean(browser.canGoBack) : Boolean(history?.canGoBack()), canGoForward: browser ? Boolean(browser.canGoForward) : Boolean(history?.canGoForward()), contextId: enabled ? navigationContextForWebContents?.(wc) : undefined };
    } catch { return { enabled: false, canGoBack: false, canGoForward: false }; }
  }
  function validSender(event, url, active = true) {
    const wc = event.sender;
    try {
      return !disposed && platform === 'darwin' && contents.has(wc) && !wc.isDestroyed() && (!active || (wc === currentWebContents() && canHandle(wc)))
        && event.senderFrame === wc.mainFrame && (contents.get(wc).shell ? url === 'aster-ui://shell/index.html' : /^https?:/.test(url)) && event.senderFrame.url === url && wc.getURL() === url;
    } catch { return false; }
  }
  function update(wc) {
    if (!contents.has(wc) || wc.isDestroyed()) return;
    try { wc.send(CHANNELS.state, available(wc)); } catch {}
  }
  function navigate(wc, direction) {
    if (!wc || wc.isDestroyed() || wc !== currentWebContents() || !canHandle(wc)) return false;
    const history = wc.navigationHistory, backwards = direction === 'back', state = available(wc);
    if (!(backwards ? state.canGoBack : state.canGoForward)) return false;
    try {
      contents.get(wc)?.wheel.markNavigation();
      // Logical browser history can include New Tab and other internal routes,
      // which do not exist in a remote WebContents' Chromium history. Keep its
      // navigation policy in the browser rather than duplicating it here.
      const result = navigateBrowser ? navigateBrowser(wc, direction) : (backwards ? history.goBack() : history.goForward());
      if (result && typeof result.then === 'function') result.catch(onError);
      if (result === false) return false;
      return true;
    } catch (error) { onError(error); return false; }
  }
  ipcMain.handle(CHANNELS.ready, (event, url) => validSender(event, url, false) ? available(event.sender) : { enabled: false, canGoBack: false, canGoForward: false });
  const wheelListener = (event, message) => {
    if (!message || typeof message.url !== 'string' || !validSender(event, message.url)) return;
    const wc = event.sender, record = contents.get(wc), state = available(wc);
    if (message.contextId !== state.contextId) return;
    if (record.pinch) { record.wheel.suppress(); return; }
    const owner=activeWindow();
    const sample=owner?.reader.available?owner.reader.sample(message.eventTime):null;
    const nativePhase=sample?.precise&&(sample.phase||sample.momentum)?sample:null;
    if(nativePhase){diagnostics.phaseSamples++;diagnostics.lastMatchDistanceMs=nativePhase.distanceMs;
      if(nativePhase.momentum||owner.consumedGesture===nativePhase.gestureId){diagnostics.momentumSuppressed++;return;}
    }else if(owner?.reader.available)diagnostics.unmatchedSamples++;
    const action = record.wheel.consume({ ...message, ...state, nativePhase });
    if (action) {
      if(nativePhase){owner.consumedGesture=nativePhase.gestureId;diagnostics.nativeNavigations++;}
      diagnostics.navigations++;navigate(wc, action);
    }
  };
  ipcMain.on(CHANNELS.wheel, wheelListener);
  function attachWebContents(wc, { shell = false } = {}) {
    if (disposed || !wc || wc.isDestroyed() || contents.has(wc)) return;
    const record = { wheel: new WheelNavigation({ now }), pinch: false, shell, listeners: [] }; contents.set(wc, record);
    const listen = (event, callback) => { wc.on(event, callback); record.listeners.push([event, callback]); };
    function pinchLimits() {
      if (wc.isDestroyed() || platform !== 'darwin' || shell) return;
      // Chromium handles pinch scale/anchor/scroll itself. input-event contains
      // no scale delta in Electron 45, so never translate it into layout zoom.
      try { Promise.resolve(wc.setVisualZoomLevelLimits(1, 5)).catch(onError); } catch (error) { onError(error); }
    }
    if (!shell) try { wc.setZoomMode?.('isolated'); } catch (error) { onError(error); }
    listen('dom-ready', () => { record.wheel.reset(); record.pinch = false; pinchLimits(); update(wc); });
    listen('did-navigate', () => { record.wheel.markNavigation(); update(wc); });
    listen('did-navigate-in-page', () => { record.wheel.markNavigation(); update(wc); });
    listen('blur', () => { record.wheel.suppress(); record.pinch = false; });
    listen('input-event', (_event, input) => {
      if (input?.type === 'gesturePinchBegin') { record.pinch = true; record.wheel.suppress(); }
      else if (input?.type === 'gesturePinchEnd') { record.pinch = false; record.wheel.suppress(); }
    });
    listen('destroyed', () => detachWebContents(wc));
    pinchLimits(); update(wc);
  }
  function detachWebContents(wc) {
    const record = contents.get(wc); if (!record) return;
    for (const [event, callback] of record.listeners) wc.removeListener(event, callback);
    contents.delete(wc);
  }
  function attachSession(ses) {
    if (disposed || sessions.has(ses)) return;
    const id = ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'navigation-preload.cjs') });
    sessions.set(ses, id);
    for (const reference of sessionRefs) if (!reference.session.deref()) sessionRefs.delete(reference);
    // Do not retain a private session after its last tab has been destroyed.
    sessionRefs.add({ session: new WeakRef(ses), id });
  }
  function attachWindow(win) {
    if (disposed || windows.has(win) || platform !== 'darwin') return;
    // Electron's legacy swipe event is useful only with the macOS "two or
    // three fingers" setting. Standard two-finger scrolling uses the preload.
    const swipe = (_event, direction) => {
      if (win.isDestroyed() || !win.isFocused()) return;
      const wc = currentWebContents(), record = contents.get(wc);
      if (!record || record.pinch || now() - record.wheel.lastNavigation < 900) return;
      if (direction === 'right') navigate(wc, 'back');
      else if (direction === 'left') navigate(wc, 'forward');
    };
    const reader=phaseReaderFactory(win,{platform});
    const closed = () => { reader.dispose();win.removeListener('swipe', swipe); windows.delete(win); };
    win.on('swipe', swipe); win.once('closed', closed); windows.set(win, { swipe, closed, reader, consumedGesture:null });
  }
  return {
    attachSession, attachWebContents, attachWindow, update,
    getState(){return {nativePhases:[...windows.values()].some(r=>r.reader.available),...diagnostics};},
    dispose() {
      if (disposed) return; disposed = true;
      ipcMain.removeHandler(CHANNELS.ready); ipcMain.removeListener(CHANNELS.wheel, wheelListener);
      for (const wc of contents.keys()) detachWebContents(wc);
      for (const [win, { swipe, closed, reader }] of windows) { reader.dispose();win.removeListener('swipe', swipe); win.removeListener('closed', closed); }
      windows.clear();
      for (const { session, id } of sessionRefs) { try { session.deref()?.unregisterPreloadScript(id); } catch {} }
      sessionRefs.clear();
    }
  };
}

module.exports = { createNavigationGestures, WheelNavigation, CHANNELS };
