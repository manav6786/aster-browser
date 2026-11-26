'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSuggestions } = require('../src/main/suggestions.cjs');

function fixture(options = {}) {
  const state = { activeTabId: 'active', activeWorkspace: 'personal', settings: { searchEngine: 'brave', searchSuggestions: false }, tabs: [
    { id: 'active', title: 'Current', url: 'aster://newtab', private: false },
    { id: 'github', title: 'GitHub project', url: 'https://github.com/aster', workspace: 'personal' },
    { id: 'secret', title: 'GitHub private', url: 'https://private.example/github', private: true }
  ], bookmarks: [
    { title: 'GitHub duplicate bookmark', url: 'https://github.com/aster#readme' },
    { title: 'GitHub Docs', url: 'https://docs.github.com/' }
  ], history: [{ title: 'GitHub old visit', url: 'https://github.com/old' }, { title: 'GitHub unsafe', url: 'https://name:password@github.com/' }] };
  const requests = [];
  const fetchImpl = options.fetchImpl || (async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(['git', ['github desktop', 'github actions']])); });
  const service = createSuggestions({ snapshot: () => state, current: () => state.tabs.find(tab => tab.id === state.activeTabId), fetchImpl, ...options });
  return { state, requests, service };
}

test('local suggestions are immediate, ranked, deduplicated and do not disclose private tabs', async t => {
  const { service, requests } = fixture(); t.after(() => service.dispose());
  const result = await service.query({ query: 'git', localOnly: true, requestId: 7 });
  assert.equal(result.query, 'git'); assert.equal(result.requestId, 7);
  assert.deepEqual(result.items.map(item => item.kind), ['tab', 'bookmark', 'history', 'search']);
  assert.equal(result.items[0].tabId, 'github');
  assert.equal(result.items.filter(item => item.url?.startsWith('https://github.com/aster')).length, 1);
  assert.ok(!JSON.stringify(result).includes('private.example'));
  assert.ok(!JSON.stringify(result).includes('name:password'));
  assert.equal(requests.length, 0);
  const recents = await service.query({ query: '' }); assert.ok(recents.items.length > 0); assert.ok(recents.items.every(item => item.kind !== 'search'));
});

test('remote suggestions require opt-in and never run or use remote cache in private mode', async t => {
  const { service, state, requests } = fixture(); t.after(() => service.dispose());
  await service.query({ query: 'git' }); assert.equal(requests.length, 0);
  state.settings.searchSuggestions = true;
  const publicResult = await service.query({ query: 'git' }); assert.ok(publicResult.items.some(item => item.text === 'github desktop')); assert.equal(requests.length, 1);
  state.activeTabId = 'secret';
  const privateResult = await service.query({ query: 'git' }); assert.equal(requests.length, 1);
  assert.ok(!privateResult.items.some(item => item.text === 'github desktop' || item.kind === 'history'));
  assert.ok(privateResult.items.some(item => item.kind === 'bookmark'));
});

test('URL, credential and filesystem input stays local and safe URLs navigate directly', async t => {
  const { service, state, requests } = fixture(); t.after(() => service.dispose()); state.settings.searchSuggestions = true;
  for (const query of ['https://example.com/a', 'github.com', 'localhost:3000', '127.0.0.1', '/Users/person/secret.txt', '~/Documents', 'C:\\Users\\secret', 'name@example.com', 'https://user:password@example.com', 'user:password', 'token=secret-value', 'Bearer eyJabcdef0123456789', 'javascript:alert(1)']) {
    const result = await service.query({ query }); assert.ok(!result.items.some(item => item.kind === 'search'), query);
  }
  assert.equal(requests.length, 0);
  assert.equal((await service.query({ query: 'localhost:3000/a' })).items[0].url, 'http://localhost:3000/a');
  assert.equal((await service.query({ query: 'https://example.com/' })).items[0].kind, 'url');
  assert.equal((await service.query({ query: 'aster://settings' })).items[0].url, 'aster://settings');
  const longURL = 'https://example.com/' + 'path'.repeat(100);
  assert.equal((await service.query({ query: longURL })).items[0].url, longURL, 'Long addresses must not be silently truncated');
  assert.deepEqual((await service.query({ query: 'x'.repeat(9000) })).items, []);
});

test('each selected engine uses its own keyless endpoint without credentials or cross-provider fallback', async t => {
  const { service, state, requests } = fixture(); t.after(() => service.dispose()); state.settings.searchSuggestions = true;
  const origins = { brave: 'https://search.brave.com', duckduckgo: 'https://duckduckgo.com', google: 'https://www.google.com' };
  for (const engine of Object.keys(origins)) {
    state.settings.searchEngine = engine; const result = await service.query({ query: 'glass browser' });
    const request = requests.at(-1); assert.equal(new URL(request.url).origin, origins[engine]);
    assert.equal(new URL(request.url).searchParams.get('q'), 'glass browser');
    assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.redirect, 'error'); assert.equal(request.init.referrerPolicy, 'no-referrer');
    assert.ok(result.items.some(item => item.text === 'github desktop'));
  }
  assert.equal(requests.length, 3);
});

test('cache entries expire and the LRU remains bounded', async t => {
  let time = 1000; const { service, state, requests } = fixture({ now: () => time, cacheTTL: 100, cacheSize: 2 });
  t.after(() => service.dispose()); state.settings.searchSuggestions = true;
  await service.query({ query: 'alpha' }); await service.query({ query: 'alpha' }); assert.equal(requests.length, 1);
  await service.query({ query: 'beta' }); await service.query({ query: 'alpha' }); await service.query({ query: 'gamma' });
  await service.query({ query: 'beta' }); assert.equal(requests.length, 4, 'Least recently used query should have been evicted');
  time += 101; await service.query({ query: 'beta' }); assert.equal(requests.length, 5);
});

test('new input aborts older requests and late provider replies cannot overwrite or populate cache', async t => {
  const calls = [];
  const { service, state } = fixture({ fetchImpl: (url, init) => new Promise(resolve => calls.push({ url, init, resolve })) });
  t.after(() => service.dispose()); state.settings.searchSuggestions = true;
  const old = service.query({ query: 'older', requestId: 1 });
  const newer = service.query({ query: 'newer', requestId: 2 });
  assert.equal(calls[0].init.signal.aborted, true);
  calls[1].resolve(new Response(JSON.stringify(['newer', ['newer completion']])));
  assert.ok((await newer).items.some(item => item.text === 'newer completion'));
  assert.deepEqual((await old).items, []);
  calls[0].resolve(new Response(JSON.stringify(['older', ['late older completion']])));
  await new Promise(resolve => setImmediate(resolve));
  const again = service.query({ query: 'older' }); assert.equal(calls.length, 3);
  service.cancel(); assert.deepEqual((await again).items, []);
});

test('tab/privacy changes invalidate an outstanding remote result without a subsequent UI request', async t => {
  let complete;
  const { service, state } = fixture({ fetchImpl: () => new Promise(resolve => { complete = resolve; }) });
  t.after(() => service.dispose()); state.settings.searchSuggestions = true;
  const request = service.query({ query: 'weather' }); state.activeTabId = 'secret';
  complete(new Response(JSON.stringify(['weather', ['weather tomorrow']])));
  assert.deepEqual((await request).items, []);
});

test('hanging, oversized and malformed providers fall back locally; rate limits stop repeated calls', async t => {
  const hanging = fixture({ fetchImpl: () => new Promise(() => {}), timeoutMs: 100 }); t.after(() => hanging.service.dispose()); hanging.state.settings.searchSuggestions = true;
  assert.ok((await hanging.service.query({ query: 'git' })).items.some(item => item.kind === 'tab'));
  for (const body of ['bad JSON', JSON.stringify(['git', ['x'.repeat(70000)]])]) {
    const { service, state } = fixture({ fetchImpl: async () => new Response(body) }); t.after(() => service.dispose()); state.settings.searchSuggestions = true;
    const result = await service.query({ query: 'git' }); assert.equal(result.items.filter(item => item.kind === 'search').length, 1);
  }
  let calls = 0, time = 100;
  const limited = fixture({ now: () => time, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); } });
  t.after(() => limited.service.dispose()); limited.state.settings.searchSuggestions = true;
  await limited.service.query({ query: 'first' }); await limited.service.query({ query: 'second' }); assert.equal(calls, 1);
  time += 60001; await limited.service.query({ query: 'third' }); assert.equal(calls, 2);
});

test('untrusted provider output is bounded, deduplicated, and used only as text in provider search URLs', async t => {
  const { service, state } = fixture({ fetchImpl: async () => new Response(JSON.stringify(['glass', ['glass', 'glass', ...Array.from({ length: 40 }, (_, i) => 'glass ' + i), null, {}]])) });
  t.after(() => service.dispose()); state.settings.searchSuggestions = true;
  const result = await service.query({ query: 'glass' }); assert.ok(result.items.length <= 10);
  assert.equal(new Set(result.items.filter(item => item.kind === 'search').map(item => item.text)).size, result.items.length);
  assert.ok(result.items.every(item => item.url.startsWith('https://search.brave.com/search?q=')));
});
