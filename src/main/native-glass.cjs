'use strict';
// Original Aster integration of public AppKit APIs. MIT; no Zen code copied.
const path = require('node:path');

function createNativeGlass({ win } = {}) {
  let binding = null, token = null, disposed = false;
  let current = { enabled: true, dark: false, accent: '#79a9ff', opacity: 1 };
  let status = { available: false, enabled: false, api: 'NSGlassEffectView', reason: 'not-initialized', viewCount: 0 };
  const listeners = [];
  const setStatus = value => { status = Object.freeze({ ...value }); return status; };
  const fail = reason => setStatus({ available: false, enabled: false, api: 'NSGlassEffectView', reason, viewCount: 0 });

  function validRect(rect) {
    if (!rect || typeof rect !== 'object') return null;
    const result = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(rect[key])]));
    return Object.values(result).every(Number.isFinite) && result.width >= 0 && result.height >= 0 ? result : null;
  }

  function dispose() {
    if (disposed) return status;
    disposed = true;
    for (const [event, listener] of listeners) win?.removeListener?.(event, listener);
    listeners.length = 0;
    if (binding && token) { try { binding.dispose(token); } catch {} }
    token = null; binding = null;
    return fail('disposed');
  }

  function update(options = {}) {
    if (disposed) return status;
    if (!win || win.isDestroyed?.()) return dispose();
    if (typeof options.enabled === 'boolean') current.enabled = options.enabled;
    if (typeof options.dark === 'boolean') current.dark = options.dark;
    if (typeof options.accent === 'string' && /^#[0-9a-f]{6}$/i.test(options.accent)) current.accent = options.accent;
    for (const key of ['opacity', 'cornerRadius']) if (typeof options[key] === 'number' && Number.isFinite(options[key])) current[key] = key === 'opacity' ? Math.max(0, Math.min(1, options[key])) : Math.max(0, Math.min(40, options[key]));
    if (Object.hasOwn(options, 'regions')) {
      if (!Array.isArray(options.regions) || options.regions.length > 8 || options.regions.some(rect => !validRect(rect))) return { ...status, reason: 'invalid-regions' };
      current.regions = options.regions.map(validRect);
    }
    if (Object.hasOwn(options, 'contentBounds')) {
      if (options.contentBounds === null) delete current.contentBounds;
      else {
        const rect = validRect(options.contentBounds);
        if (!rect) return { ...status, reason: 'invalid-content-bounds' };
        current.contentBounds = rect;
      }
    }
    if (!binding || !token) return status;
    try {
      const result = binding.update(token, current);
      if (!result.available) { const reason = result.reason; dispose(); return fail(reason); }
      return setStatus(result);
    } catch (error) {
      dispose(); return fail(`native-update-failed: ${String(error.message || error)}`);
    }
  }

  const api = { get available() { return status.available; }, get status() { return status; }, update, dispose };
  if (process.platform !== 'darwin') { fail('requires-macos'); return api; }
  if (!process.versions.electron || process.type !== 'browser') { fail('requires-electron-main-process'); return api; }
  if (!win || win.isDestroyed?.() || typeof win.getNativeWindowHandle !== 'function') { fail('requires-live-browser-window'); return api; }
  try {
    binding = require(path.join(__dirname, '../native/glass.node'));
    const capability = binding.capabilities();
    if (!capability.available) { fail(capability.reason); binding = null; return api; }
    // Electron v45 returns one pointer-sized Buffer holding its NSView*.
    // Obtain it freshly once; subsequent operations use only the owned token.
    token = binding.create(win.getNativeWindowHandle());
    for (const event of ['resize', 'enter-full-screen', 'leave-full-screen']) {
      const listener = () => update(); listeners.push([event, listener]); win.on(event, listener);
    }
    const onClosed = () => dispose(); listeners.push(['closed', onClosed]); win.once('closed', onClosed);
    update();
  } catch (error) {
    const reason = `native-unavailable: ${String(error.message || error)}`;
    if (token) { try { binding?.dispose(token); } catch {} }
    token = null; binding = null;
    for (const [event, listener] of listeners) win.removeListener?.(event, listener);
    listeners.length = 0;
    fail(reason);
  }
  return api;
}

module.exports = { createNativeGlass };
