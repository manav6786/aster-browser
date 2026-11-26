'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { parse } = require('tldts-experimental');
// Keep the shell's Electron diagnostics enabled: the upstream adapter changes this.
delete process.env.ELECTRON_DISABLE_SECURITY_WARNINGS;
function installShields(state, assetRoot, onBlock, isPage, directory, onChange) {
  let engine;
  let updating;
  const attached = new WeakSet();
  try {
    engine = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(path.join(assetRoot, 'blocker.bin'))));
    const metadata = JSON.parse(fs.readFileSync(path.join(assetRoot, 'blocker.json')));
    Object.assign(state.shields, { status: 'ready', filterCount: metadata.network + metadata.cosmetic, lastUpdated: metadata.generatedAt });
  } catch (error) { Object.assign(state.shields, { status: 'degraded', error: error.message }); }
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'filters.json')));
    if (metadata.version === '2.20.1' && Date.parse(metadata.generatedAt) > Date.parse(state.shields.lastUpdated || '1970-01-01')) {
      engine = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(path.join(directory, 'filters.bin'))));
      Object.assign(state.shields, { status: 'ready', filterCount: metadata.filterCount, lastUpdated: metadata.generatedAt });
    }
  } catch {}
  function cosmetics(event, url, message) {
    if (!engine || !state.shields.enabled || !isPage(event.sender) || typeof url !== 'string' || event.senderFrame?.url !== url || !/^https?:/.test(url)) return;
    if (message && ['classes', 'ids', 'hrefs'].some(key => message[key] && (!Array.isArray(message[key]) || message[key].length > 10000 || message[key].some(value => typeof value !== 'string' || value.length > 8192)))) return;
    const parsed = parse(url), firstRun = message === undefined;
    return engine.getCosmeticsFilters({
      domain: parsed.domain || '', hostname: parsed.hostname || '', url,
      classes: message?.classes, ids: message?.ids, hrefs: message?.hrefs,
      getBaseRules: firstRun, getInjectionRules: firstRun, getExtendedRules: false,
      getRulesFromHostname: firstRun, getRulesFromDOM: !firstRun,
      callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: message?.lifecycle }
    });
  }
  // A synchronous, narrowly scoped preload request is required here: an async
  // main-process executeJavaScript call either races the parser or waits until
  // load has finished, too late to patch an inline bootstrap script.
  ipcMain.on('aster:shields:document-start', (event, url) => {
    try { event.returnValue = cosmetics(event, url) || null; }
    catch { event.returnValue = null; }
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', event => Boolean(engine?.config.enableMutationObserver && state.shields.enabled && isPage(event.sender)));
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, message) => {
    // First-run scripts are installed once by the document-start preload.
    if (!message) return;
    return cosmetics(event, url, message)?.styles;
  });
  function replacementURL(dataURL, resources) {
    const key = createHash('sha256').update(dataURL).digest('hex');
    if (!resources.has(key)) {
      const match = /^data:([^,]*),(.*)$/s.exec(dataURL);
      if (!match) throw new Error('Invalid blocker replacement resource');
      const base64 = /;base64$/i.test(match[1]);
      const contentType = match[1].replace(/;base64$/i, '') || 'text/plain;charset=US-ASCII';
      let body;
      if (base64) body = Buffer.from(match[2], 'base64');
      else {
        // Decode percent escapes as bytes, preserving non-UTF-8 resources.
        const input = Buffer.from(match[2]), output = [];
        for (let i = 0; i < input.length; i++) {
          const hex = input.subarray(i + 1, i + 3).toString('ascii');
          if (input[i] === 37 && /^[0-9a-f]{2}$/i.test(hex)) { output.push(parseInt(hex, 16)); i += 2; }
          else output.push(input[i]);
        }
        body = Buffer.from(output);
      }
      resources.set(key, { body, contentType });
    }
    return 'aster-resource://surrogate/' + key;
  }
  return {
    async refresh() {
      if (updating) return updating;
      updating = (async () => {
        state.shields.updating = true; onChange();
        try {
          const signal = AbortSignal.timeout(45000);
          const refreshed = await ElectronBlocker.fromPrebuiltAdsAndTracking((url, init) => fetch(url, { ...init, signal }));
          const filters = refreshed.getFilters();
          const metadata = { version: '2.20.1', generatedAt: new Date().toISOString(), filterCount: filters.networkFilters.length + filters.cosmeticFilters.length };
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, 'filters.bin.tmp'), refreshed.serialize(), { mode: 0o600 });
          fs.renameSync(path.join(directory, 'filters.bin.tmp'), path.join(directory, 'filters.bin'));
          fs.writeFileSync(path.join(directory, 'filters.json'), JSON.stringify(metadata), { mode: 0o600 });
          engine = refreshed;
          Object.assign(state.shields, { status: 'ready', filterCount: metadata.filterCount, lastUpdated: metadata.generatedAt, updateError: null });
        } catch (error) { state.shields.updateError = error.message; throw error; }
        finally { state.shields.updating = false; updating = null; onChange(); }
      })();
      return updating;
    },
    attach(ses) {
      if (attached.has(ses)) return;
      attached.add(ses);
      // Resource existence must not reveal another session's browsing activity.
      const resources = new Map();
      ses.protocol.handle('aster-resource', request => {
        const url = new URL(request.url);
        const resource = url.hostname === 'surrogate' && !url.search && !url.hash && resources.get(url.pathname.slice(1));
        const origin = request.headers.get('Origin');
        const headers = { 'Access-Control-Allow-Origin': origin || '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' };
        if (origin) { headers['Access-Control-Allow-Credentials'] = 'true'; headers.Vary = 'Origin'; }
        if (!resource || !['GET', 'HEAD', 'POST', 'OPTIONS'].includes(request.method)) return new Response('Not found', { status: 404, headers });
        headers['Content-Type'] = resource.contentType;
        if (request.method === 'OPTIONS') {
          headers['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, OPTIONS';
          headers['Access-Control-Allow-Headers'] = request.headers.get('Access-Control-Request-Headers') || '*';
          return new Response(null, { status: 204, headers });
        }
        return new Response(request.method === 'HEAD' ? null : resource.body, { status: 200, headers });
      });
      ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'page-preload.cjs') });
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        if (state.shields.enabled && engine && /^https?:/.test(details.url)) engine.onBeforeRequest(details, result => {
          if (result.cancel || result.redirectURL) onBlock(details.webContentsId);
          if (result.redirectURL?.startsWith('data:')) {
            if (details.method === 'OPTIONS') return callback({ cancel: true });
            try { return callback({ redirectURL: replacementURL(result.redirectURL, resources) }); }
            catch { return callback({ cancel: true }); }
          }
          callback(result);
        });
        else callback({});
      });
      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        if (state.shields.enabled && engine) engine.onHeadersReceived(details, callback); else callback({});
      });
    }
  };
}
module.exports = { installShields };
