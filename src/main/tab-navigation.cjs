'use strict';
const { normalizeURL } = require('../shared/core.cjs');

// Chromium owns navigation inside one remote view. These bounded segments retain
// the internal pages between remote view lifetimes without duplicating the
// active Chromium PageState in both tab.navigation and routeHistory.
const LIMITS = Object.freeze({ segments: 32, entries: 500, bytes: 16 * 1024 * 1024, pageState: 4 * 1024 * 1024 });
const remoteURL = value => value === 'about:blank' || (typeof value === 'string' && /^https?:\/\//.test(value));
function safeURL(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try { const url = normalizeURL(value); return (remoteURL(url) || url.startsWith('aster://')) && url === value ? url : null; } catch { return null; }
}
function cleanNavigation(value, url) {
  if (!value || !Array.isArray(value.entries) || !value.entries.length || !Number.isInteger(value.index) || value.index < 0 || value.index >= value.entries.length) return null;
  const start = Math.max(0, Math.min(value.index - Math.floor(LIMITS.entries / 2), value.entries.length - LIMITS.entries));
  const raw = value.entries.slice(start, start + LIMITS.entries), index = value.index - start;
  if (url && raw[index]?.url !== url) return null;
  if (!raw.every(entry => entry && remoteURL(safeURL(entry.url)) && typeof entry.title === 'string')) return null;
  let bytes = 0;
  const entries = raw.map(entry => {
    const result = { url: entry.url, title: entry.title.slice(0, 4096) };
    bytes += Buffer.byteLength(JSON.stringify(result));
    return result;
  });
  // Prefer the selected document's native state, then nearby history. URL/title
  // history remains available when a large PageState exceeds the shared budget.
  const order = entries.map((_, i) => i).sort((a, b) => Math.abs(a - index) - Math.abs(b - index));
  for (const i of order) {
    const state = raw[i].pageState;
    if (typeof state !== 'string' || state.length >= LIMITS.pageState) continue;
    const size = Buffer.byteLength(JSON.stringify(state)) + 16;
    if (bytes + size <= LIMITS.bytes) { entries[i].pageState = state; bytes += size; }
  }
  return { entries, index };
}
function oneEntry(tab) { return { kind: remoteURL(tab.url) ? 'remote' : 'internal', url: tab.url, title: String(tab.title || '').slice(0, 4096) }; }
function cleanHistory(tab) {
  const raw = tab.routeHistory;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries) || !raw.entries.length || !Number.isInteger(raw.index) || raw.index < 0 || raw.index >= raw.entries.length || raw.entries.length > 1000) return { version: 1, entries: [oneEntry(tab)], index: 0 };
  const entries = [];
  for (const item of raw.entries) {
    const url = safeURL(item?.url), kind = remoteURL(url) ? 'remote' : 'internal';
    if (!url || item.kind !== kind) return { version: 1, entries: [oneEntry(tab)], index: 0 };
    const entry = { kind, url, title: String(item.title || '').slice(0, 4096) };
    if (kind === 'remote' && entries.length !== raw.index) {
      const navigation = cleanNavigation(item.navigation, url); if (navigation) entry.navigation = navigation;
    }
    entries.push(entry);
  }
  if (entries[raw.index].url !== tab.url) return { version: 1, entries: [oneEntry(tab)], index: 0 };
  return { version: 1, entries, index: raw.index };
}
function nativeState(wc, saved) {
  try {
    const history = wc && !wc.isDestroyed() ? wc.navigationHistory : null;
    const entries = history?.getAllEntries?.() || saved?.entries || [], index = history?.getActiveIndex?.() ?? saved?.index ?? 0;
    return { entries, index, canGoBack: history?.canGoBack ? history.canGoBack() : index > 0, canGoForward: history?.canGoForward ? history.canGoForward() : index < entries.length - 1 };
  } catch { return { entries: [], index: 0, canGoBack: false, canGoForward: false }; }
}
function createTabNavigation({ getWebContents, beforeLeave = async () => {}, openRoute, onChange = () => {}, isAlive = () => true }) {
  if (typeof getWebContents !== 'function' || typeof openRoute !== 'function') throw new TypeError('Tab navigation requires owned contents and route opening hooks');
  const initialized = new WeakSet(), nativePrevious = new WeakMap(), pending = new WeakMap();
  function initialize(tab) {
    if (!initialized.has(tab)) {
      tab.routeHistory = cleanHistory(tab); initialized.add(tab);
      if (!remoteURL(tab.url)) delete tab.navigation;
      else if (tab.navigation) tab.navigation = cleanNavigation(tab.navigation, tab.url) || undefined;
      bound(tab);
    }
    return tab.routeHistory;
  }
  function bound(tab) {
    const history = tab.routeHistory;
    const cost = () => history.entries.reduce((sum, entry, i) => sum + (entry.navigation ? Buffer.byteLength(JSON.stringify(entry.navigation)) : i === history.index && tab.navigation ? Buffer.byteLength(JSON.stringify(tab.navigation)) : 0), 0);
    const count = () => history.entries.reduce((sum, entry, i) => sum + (entry.navigation?.entries.length || (i === history.index ? tab.navigation?.entries.length : 0) || 0), 0);
    while (history.entries.length > 1 && (history.entries.length > LIMITS.segments || count() > LIMITS.entries || cost() > LIMITS.bytes)) {
      if (history.index > 0) { history.entries.shift(); history.index--; }
      else history.entries.pop();
    }
  }
  function availability(tab, wc = getWebContents(tab)) {
    const history = initialize(tab), entry = history.entries[history.index];
    const native = entry.kind === 'remote' ? nativeState(wc, tab.navigation) : { canGoBack: false, canGoForward: false };
    return { canGoBack: Boolean(native.canGoBack || history.index > 0), canGoForward: Boolean(native.canGoForward || history.index < history.entries.length - 1) };
  }
  function refresh(tab, wc = getWebContents(tab)) { const flags = availability(tab, wc); Object.assign(tab, flags); return flags; }
  function capture(tab, wc = getWebContents(tab)) {
    const history = initialize(tab), entry = history.entries[history.index];
    if (entry.kind !== 'remote' || !wc || wc.isDestroyed() || wc.isLoadingMainFrame?.()) return;
    const native = nativeState(wc), saved = cleanNavigation(native, tab.url);
    if (saved) tab.navigation = saved;
    entry.url = tab.url; entry.title = String(tab.title || '').slice(0, 4096); bound(tab);
  }
  function committed(tab, wc = getWebContents(tab)) {
    const history = initialize(tab), entry = history.entries[history.index];
    if (entry.kind !== 'remote') return refresh(tab, wc);
    const native = nativeState(wc), previous = nativePrevious.get(tab), urls = native.entries.map(item => item.url);
    // Native Back/Forward and replaceState keep the internal forward boundary.
    // A new link/pushState branch replaces or appends a native entry instead.
    if (previous?.entry === entry && native.index > previous.index && (native.index >= previous.urls.length || urls[native.index] !== previous.urls[native.index])) history.entries.splice(history.index + 1);
    entry.url = tab.url; entry.title = String(tab.title || '').slice(0, 4096);
    nativePrevious.set(tab, { entry, index: native.index, urls });
    return refresh(tab, wc);
  }
  function enqueue(tab, operation) {
    const job = (pending.get(tab) || Promise.resolve()).catch(() => {}).then(() => isAlive(tab) ? operation() : false);
    pending.set(tab, job);
    return job.finally(() => { if (pending.get(tab) === job) pending.delete(tab); });
  }
  async function leave(tab, history) {
    if (history.entries[history.index].kind !== 'remote') return isAlive(tab);
    await beforeLeave(tab);
    if (!isAlive(tab)) return false;
    capture(tab); const entry = history.entries[history.index];
    const navigation = cleanNavigation(tab.navigation, tab.url);
    if (navigation) entry.navigation = navigation; else delete entry.navigation;
    delete tab.navigation; nativePrevious.delete(tab); return true;
  }
  function changed(tab) { bound(tab); refresh(tab); onChange(tab); }
  function go(tab, url) {
    if (!safeURL(url)) return Promise.reject(new Error('Unsupported browser destination'));
    return enqueue(tab, async () => {
      const history = initialize(tab), entry = history.entries[history.index], kind = remoteURL(url) ? 'remote' : 'internal';
      if (entry.kind === 'remote' && kind === 'remote') {
        history.entries.splice(history.index + 1); entry.url = url;
        await openRoute(tab, url, { restore: false }); changed(tab); return true;
      }
      if (entry.kind === 'internal' && entry.url === url) { refresh(tab); return true; }
      if (!await leave(tab, history)) return false;
      history.entries.splice(history.index + 1);
      history.entries.push({ kind, url, title: '' }); history.index = history.entries.length - 1;
      delete tab.navigation;
      await openRoute(tab, url, { restore: false }); changed(tab); return true;
    });
  }
  function travel(tab, direction) {
    if (!['back', 'forward'].includes(direction)) return Promise.reject(new TypeError('Navigation direction must be back or forward'));
    return enqueue(tab, async () => {
      const history = initialize(tab), entry = history.entries[history.index], wc = getWebContents(tab), native = entry.kind === 'remote' ? nativeState(wc, tab.navigation) : {};
      if (wc && (direction === 'back' ? native.canGoBack : native.canGoForward)) {
        wc.navigationHistory[direction === 'back' ? 'goBack' : 'goForward'](); refresh(tab, wc); onChange(tab); return true;
      }
      const index = history.index + (direction === 'back' ? -1 : 1);
      if (index < 0 || index >= history.entries.length) return false;
      if (!await leave(tab, history)) return false;
      history.index = index;
      const target = history.entries[index];
      if (target.kind === 'remote') { tab.navigation = cleanNavigation(target.navigation, target.url) || undefined; delete target.navigation; }
      else delete tab.navigation;
      await openRoute(tab, target.url, { restore: true, title: target.title }); changed(tab); return true;
    });
  }
  return { initialize, availability, refresh, capture, committed, go, travel };
}
module.exports = { createTabNavigation, cleanNavigation, cleanHistory, remoteURL, LIMITS };
