'use strict';
// Observe the provider while the browser is in use. This module has no tunnel
// mutation capability: only refresh() is accepted from the VPN controller.
function watchVpnStatus(win, { refresh }, { intervalMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let disposed = false, timer = null, pending = null;
  const active = () => !disposed && !win.isDestroyed() && win.isFocused();
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function schedule() { cancelTimer(); if (active()) { timer = setTimer(poll, intervalMs); timer?.unref?.(); } }
  function poll() {
    cancelTimer();
    if (!active() || pending) return;
    pending = Promise.resolve().then(refresh).catch(() => {}).finally(() => { pending = null; schedule(); });
  }
  function dispose() { if (disposed) return; disposed = true; cancelTimer(); win.removeListener('focus',poll); win.removeListener('blur',cancelTimer); win.removeListener('closed',dispose); }
  win.on('focus',poll); win.on('blur',cancelTimer); win.on('closed',dispose);
  if (active()) poll();
  return { dispose };
}
module.exports = { watchVpnStatus };
