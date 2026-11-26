'use strict';
const { normalizeURL } = require('../shared/core.cjs');

// Public browser suggestion endpoints, without API keys or account cookies.
// Brave: https://github.com/brave/brave-ios/issues/3745
// DDG: https://duckduckgo.com/duckduckgo-help-pages/get-duckduckgo/deploy-duckduckgo
// Google: https://github.com/mozilla-firefox/firefox/blob/main/services/settings/dumps/main/search-config-v2.json
const PROVIDERS = Object.freeze({
  brave: { label: 'Brave Search', search: 'https://search.brave.com/search?q=', suggest: 'https://search.brave.com/api/suggest?rich=false&q=' },
  duckduckgo: { label: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=', suggest: 'https://duckduckgo.com/ac/?type=list&q=' },
  google: { label: 'Google', search: 'https://www.google.com/search?q=', suggest: 'https://www.google.com/complete/search?client=firefox&q=' }
});
const MAX_ITEMS = 10, MAX_QUERY = 200, MAX_RESPONSE = 65536;
const fold = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) : '';

function isNavigationalOrSensitive(query) {
  // Navigational input and credentials must not be disclosed to a provider.
  // This intentionally favours local-only matches for ambiguous input.
  return /[\x00-\x1f\x7f@\\/:=]/.test(query) || /^[~.]/.test(query)
    || /(?:^|\s)(?:localhost|www\.|\[[\da-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}|[\p{L}\d_-]+\.[\p{L}\d_-]+)(?:\b|$)/iu.test(query)
    || /\b(?:bearer\s+\S+|(?:password|passwd|pwd|token|secret|api[-_ ]?key|authorization)\s*[:=])|\beyJ[\w-]{15,}\.[\w-]+|\d{9,}/i.test(query)
    || query.split(/\s+/).some(word => word.length >= 32 && /^[\w-]+$/.test(word) && /\d/.test(word) && /[a-z]/i.test(word));
}
function canRequestRemote(query) { return query.length >= 2 && query.length <= 120 && query.split(/\s+/).length <= 20 && !isNavigationalOrSensitive(query); }

function safeURL(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  if (/^aster:\/\/(?:newtab|settings|history|bookmarks|downloads|agents)$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function navigationURL(query) {
  if (/^(https?:\/\/|aster:\/\/)/i.test(query)) return safeURL(query);
  if (!/\s/.test(query) && /^(localhost|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(query)) {
    try { return safeURL(normalizeURL(query)); } catch {}
  }
  return null;
}

function localSuggestions(query, state, current, limit = MAX_ITEMS) {
  const q = fold(query), words = q.split(/\s+/).filter(Boolean), privateMode = Boolean(current?.private);
  const candidates = [];
  function add(kind, entry, index) {
    if (!entry || (kind !== 'tab' && entry.private) || (kind === 'tab' && (Boolean(entry.private) !== privateMode || entry.id === current?.id))) return;
    const url = safeURL(entry.url); if (!url) return;
    const title = clean(entry.title) || url, titleKey = fold(title), urlKey = fold(url);
    let hostname = ''; try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    const haystack = titleKey + ' ' + urlKey;
    if (words.some(word => !haystack.includes(word))) return;
    let score = kind === 'tab' ? 300 : kind === 'bookmark' ? 200 : 100;
    if (q) {
      if (titleKey === q || fold(hostname) === q) score += 180;
      else if (titleKey.startsWith(q)) score += 110;
      else if (fold(hostname).startsWith(q) || urlKey.replace(/^https?:\/\/(?:www\.)?/, '').startsWith(q)) score += 90;
      else score += 20;
    }
    if (kind === 'tab' && entry.workspace === state.activeWorkspace) score += 15;
    if (kind === 'tab' && entry.pinned) score += 5;
    // History is already stored in recency order; cap its tie-breaking weight.
    score += Math.max(0, 10 - index / 20);
    const item = { kind, text: title, detail: kind === 'tab' ? 'Open tab · ' + hostname : kind === 'bookmark' ? 'Bookmark · ' + hostname : hostname, url };
    if (kind === 'tab') item.tabId = entry.id;
    let key = url; try { const parsed = new URL(url); parsed.hash = ''; key = parsed.href; } catch {}
    candidates.push({ item, key, score, index });
  }
  (state.tabs || []).slice(0, 500).forEach((entry, index) => add('tab', entry, index));
  (state.bookmarks || []).slice(0, 3000).forEach((entry, index) => add('bookmark', entry, index));
  if (!privateMode) (state.history || []).slice(0, 3000).forEach((entry, index) => add('history', entry, index));
  candidates.sort((a, b) => b.score - a.score || a.index - b.index || a.item.text.localeCompare(b.item.text));
  const used = new Set(), items = [];
  for (const candidate of candidates) {
    if (used.has(candidate.key)) continue;
    used.add(candidate.key); items.push(candidate.item);
    if (items.length >= limit) break;
  }
  return items;
}

async function readJSON(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE) throw new Error('Suggestion response too large');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error('Suggestion request cancelled');
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) throw new Error('Suggestion response too large');
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => {}); }
  } else { text = await response.text(); if (Buffer.byteLength(text) > MAX_RESPONSE) throw new Error('Suggestion response too large'); }
  // Some Google clients return an XSSI prefix before the OpenSearch array.
  return JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, ''));
}

function parseSuggestions(data) {
  let entries = Array.isArray(data?.[1]) ? data[1] : Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(entries)) return [];
  const used = new Set(), result = [];
  for (const value of entries.slice(0, 30)) {
    const text = clean(typeof value === 'string' ? value : value?.phrase || value?.query);
    if (!text || used.has(fold(text))) continue;
    used.add(fold(text)); result.push(text);
    if (result.length === 8) break;
  }
  return result;
}

function createSuggestions({ snapshot, current, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, timeoutMs = 1800, cacheSize = 128, cacheTTL = 300000 } = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('Suggestions require a state snapshot callback');
  const cache = new Map(), cooldown = new Map();
  let pending = null, epoch = 0, latestKey = '', disposed = false;
  function context() {
    const state = snapshot() || {}, tab = typeof current === 'function' ? current() : (state.tabs || []).find(tab => tab.id === state.activeTabId);
    const engine = Object.hasOwn(PROVIDERS, state.settings?.searchEngine) ? state.settings.searchEngine : 'brave';
    // No active tab is treated as private while the browser is starting/closing.
    return { state, tab, engine, key: [tab?.id || '', tab ? Boolean(tab.private) : true, engine, state.settings?.searchSuggestions === true].join('|'), remote: Boolean(tab && !tab.private && state.settings?.searchSuggestions === true) };
  }
  function cancel() { epoch++; latestKey = ''; pending?.controller.abort(); pending = null; }
  function merged(query, ctx, remote = []) {
    const items = localSuggestions(query, ctx.state, ctx.tab, query ? 5 : 8), used = new Set();
    const destination = navigationURL(query);
    if (destination) items.unshift({ kind: 'url', text: query, detail: 'Go to address', url: destination });
    else if (query && !isNavigationalOrSensitive(query)) for (const text of [query, ...remote]) {
      if (!text || used.has(fold(text))) continue;
      used.add(fold(text));
      items.push({ kind: 'search', text, detail: 'Search with ' + PROVIDERS[ctx.engine].label, url: PROVIDERS[ctx.engine].search + encodeURIComponent(text) });
      if (items.length >= MAX_ITEMS) break;
    }
    return items.slice(0, MAX_ITEMS);
  }
  function cacheSet(key, suggestions, ttl = cacheTTL) {
    cache.delete(key); cache.set(key, { suggestions, expires: now() + ttl });
    while (cache.size > Math.max(1, Math.min(256, cacheSize))) cache.delete(cache.keys().next().value);
  }
  async function fetchRemote(ctx, query, key, cacheKey) {
    const controller = new AbortController(), request = { key, controller, epoch }; pending = request;
    let timer, onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Suggestion request cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(5000, timeoutMs)));
    const work = (async () => {
      const response = await fetchImpl(PROVIDERS[ctx.engine].suggest + encodeURIComponent(query), {
        signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        if ([429, 503].includes(response.status)) {
          const retry = response.headers?.get('retry-after'), seconds = Number(retry);
          const delay = Number.isFinite(seconds) && retry !== null ? seconds * 1000 : Date.parse(retry) - now();
          cooldown.set(ctx.engine, now() + Math.min(300000, Math.max(30000, delay || 60000)));
        }
        throw new Error('Suggestion provider unavailable');
      }
      return parseSuggestions(await readJSON(response, controller.signal));
    })();
    try {
      const suggestions = await Promise.race([work, aborted]);
      if (pending === request && !controller.signal.aborted && context().key === ctx.key) cacheSet(cacheKey, suggestions);
      return suggestions;
    } catch { return []; }
    finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
      if (pending === request) pending = null;
    }
  }
  async function query(input = {}) {
    const raw = typeof input.query === 'string' ? input.query : '', query = raw.trim().slice(0, 8192), ctx = context();
    const result = { query, items: merged(query, ctx) };
    if ((typeof input.requestId === 'string' && input.requestId.length <= 128) || (typeof input.requestId === 'number' && Number.isFinite(input.requestId))) result.requestId = input.requestId;
    if (disposed) return { ...result, items: [] };
    // Never turn a truncated address/search into a different navigation.
    if (raw.length > 8192) { cancel(); return { ...result, items: [] }; }
    const key = ctx.key + '|' + fold(query);
    if (latestKey !== key) { cancel(); latestKey = key; }
    if (input.localOnly || !ctx.remote || raw.length > MAX_QUERY || !canRequestRemote(raw.trim())) return result;
    const cacheKey = ctx.engine + '|' + fold(query), cached = cache.get(cacheKey);
    if (cached && cached.expires > now()) {
      cache.delete(cacheKey); cache.set(cacheKey, cached);
      return { ...result, items: merged(query, ctx, cached.suggestions) };
    }
    if (cached) cache.delete(cacheKey);
    if (cooldown.get(ctx.engine) > now()) return result;
    const id = epoch;
    if (!pending || pending.key !== key) {
      const promise = fetchRemote(ctx, query, key, cacheKey);
      if (pending?.key === key) pending.promise = promise;
    }
    const remote = await (pending?.key === key ? pending.promise : Promise.resolve([]));
    if (epoch !== id || latestKey !== key || context().key !== ctx.key) return { ...result, items: [] };
    return { ...result, items: merged(query, ctx, remote) };
  }
  return { query, cancel, dispose() { disposed = true; cancel(); cache.clear(); cooldown.clear(); } };
}

module.exports = { createSuggestions, localSuggestions, canRequestRemote, PROVIDERS };
