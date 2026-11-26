'use strict';
// Native access is reached only from a real BrowserWindow. Unit/VM fixtures must
// inject a reader; they never manufacture or dereference a native handle.
function createNativeGesturePhases(win, { platform = process.platform, native } = {}) {
  let addon, token, disposed = false;
  if (platform !== 'darwin' || typeof win?.getNativeWindowHandle !== 'function') return { available: false, sample: () => null, dispose() {} };
  try {
    addon = native || require('../native/gesture-phases.node');
    token = addon.attach(win.getNativeWindowHandle());
  } catch { return { available: false, sample: () => null, dispose() {} }; }
  return {
    available: true,
    sample(at) { if (disposed || !Number.isFinite(at)) return null; try { return addon.sample(token, at) || null; } catch { return null; } },
    dispose() { if (disposed) return; disposed = true; try { addon.dispose(token); } catch {} token = null; }
  };
}
module.exports = { createNativeGesturePhases };
