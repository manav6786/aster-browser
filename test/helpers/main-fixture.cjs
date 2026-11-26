'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const main = path.resolve(__dirname, '../../src/main/index.cjs');
const realRequire = createRequire(main);
const { initialState } = realRequire('../shared/core.cjs');

// Execute the actual main-process functions while keeping app readiness pending.
// No Electron process, native window, OS input, or user profile is involved.
function mainFixture(saved = {}) {
  let serial = 0;
  class Contents extends EventEmitter {
    constructor() {
      super(); this.id = ++serial; this.destroyed = false; this.loaded = []; this.restored = []; this.closeCount = 0; this.executed = [];
      this.navigationHistory = { entries: [], index: 0, restore: async navigation => { this.restored.push(navigation); this.navigationHistory.entries = navigation.entries; this.navigationHistory.index = navigation.index; }, getAllEntries: () => this.navigationHistory.entries, getActiveIndex: () => this.navigationHistory.index };
    }
    isDestroyed() { return this.destroyed; }
    isLoadingMainFrame() { return false; }
    getUserAgent() { return 'Chrome/150'; }
    setUserAgent() {}
    setWindowOpenHandler() {}
    setAudioMuted() {}
    focus() {}
    isLoading() { return false; }
    executeJavaScript(code) { this.executed.push(code); return Promise.resolve(); }
    loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
    capturePage() { return Promise.resolve({ isEmpty: () => true }); }
    close() { if (!this.destroyed) { this.closeCount++; this.destroyed = true; this.emit('destroyed'); } }
  }
  class View {
    constructor() { this.webContents = new Contents(); this.bounds = {}; this.visible = false; }
    setBackgroundColor(value) { this.backgroundColor = value; }
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible; }
    setBorderRadius(value) { this.borderRadius = value; }
    setBounds(value) { this.bounds = value; }
    getBounds() { return this.bounds; }
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-main-test-'));
  const errors = [];
  const electron = {
    app: { setName() {}, requestSingleInstanceLock: () => true, on() {}, getPath: () => directory, whenReady: () => new Promise(() => {}) },
    protocol: { registerSchemesAsPrivileged() {} }, WebContentsView: View,
    nativeTheme: {}, session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) }
  };
  const context = {
    console: { ...console, error: (...args) => errors.push(args.join(' ')) }, process, Buffer, URL, Response,
    __dirname: path.dirname(main), setTimeout: () => ({ unref() {} }), clearTimeout() {},
    require: name => name === 'electron' ? electron : realRequire(name),
    __initialState: initialState(saved),
    __window: { isDestroyed: () => false, getContentSize: () => [1440, 940], getNormalBounds: () => ({ x: 0, y: 0, width: 1440, height: 940 }), isMaximized: () => false,
      webContents: { focus() {}, send() {} }, contentView: { addChildView() {}, removeChildView() {} } }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(main, 'utf8') + `
state=__initialState;win=__window;
globalThis.__fixture={command,agentCommand,mission,prepareSessionClose,layout,animatePage,state,leases,views,closedTabs,
setAgentEngine(value){agentEngine=value;},setSessionState(value){sessionState=value;}};
`, context, { filename: main });
  return { ...context.__fixture, nativeTheme: electron.nativeTheme, directory, errors, dispose() { fs.rmSync(directory, { recursive: true, force: true }); } };
}
module.exports = { mainFixture };
