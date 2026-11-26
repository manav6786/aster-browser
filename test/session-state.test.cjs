'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSessionState, CHANNELS, LIMITS, cleanDocuments, cleanField, identity } = require('../src/main/session-state.cjs');

const url = 'https://fixture.test/draft';
const field = (extra = {}) => ({ selector: '#draft', tag: 'input', type: 'text', id: 'draft', name: '', label: '', autocomplete: '', form: '', base: '', value: 'A real retained draft', ...extra });
const documentState = (extra = {}) => ({ url, rootURL: url, framePath: 'root', fields: [field()], scroll: { page: { x: 0, y: 720 }, elements: [] }, updatedAt: 10, ...extra });
class Frame {
  constructor(address = url, parent = null, name = '') { this.url = address; this.parent = parent; this.name = name; this.frames = []; if (parent) parent.frames.push(this); }
  get framesInSubtree() { return [this, ...this.frames.flatMap(frame => frame.framesInSubtree)]; }
  isDestroyed() { return false; }
  send(channel, payload) { this.onSend?.(channel, payload); }
}
class Contents extends EventEmitter { constructor(frame = new Frame()) { super(); this.mainFrame = frame; } isDestroyed() { return false; } }
function event(wc, frame = wc.mainFrame) {
  const value = { sender: wc, senderFrame: frame, assignments: 0 }; let reply;
  Object.defineProperty(value, 'returnValue', { set(v) { assert.equal(value.assignments++, 0, 'Sync IPC must set its actual reply exactly once'); reply = v; }, get() { return reply; } }); return value;
}
function serviceFixture() {
  const ipcMain = new EventEmitter(), changes = [], service = createSessionState({ ipcMain, onChange: tab => changes.push(tab.id) });
  return { ipcMain, service, changes, emit(channel, wc, payload, frame) { const e = event(wc, frame); ipcMain.emit(channel, e, payload); return e; } };
}

test('session state captures nameless-ID controls, validates real frame identity and assigns sync replies once', t => {
  const f = serviceFixture(); t.after(() => f.service.dispose()); const wc = new Contents(), tab = { id: 'normal' }; f.service.attachWebContents(wc, tab);
  f.emit(CHANNELS.final, wc, { url, fields: [field()], scroll: { page: { x: 0, y: 720 }, elements: [] } });
  assert.equal(tab.documents[0].fields[0].name, ''); assert.equal(tab.documents[0].fields[0].value, 'A real retained draft');
  const ready = f.emit(CHANNELS.ready, wc, { url }); assert.equal(ready.assignments, 1); assert.equal(ready.returnValue.enabled, true); assert.equal(ready.returnValue.document.fields[0].id, 'draft');
  assert.equal(f.emit(CHANNELS.ready, wc, { url }, new Frame()).returnValue.enabled, false);
  assert.equal(f.emit(CHANNELS.ready, wc, { url: url + '?other' }).returnValue.enabled, false);
  assert.equal(f.emit(CHANNELS.ready, new Contents(), { url }).returnValue.enabled, false);
});
test('normal embedded drafts are isolated by exact top URL and stable browser-owned frame path; private has no state', t => {
  const f = serviceFixture(); t.after(() => f.service.dispose()); const root = new Frame(), wc = new Contents(root), child = new Frame('https://other.test/embed', root, 'editor'), tab = { id: 'normal' };
  f.service.attachWebContents(wc, tab); f.emit(CHANNELS.capture, wc, { url: child.url, fields: [field()], scroll: { page: { x: 0, y: 0 } } }, child);
  assert.equal(tab.documents[0].framePath, 'root/n:editor'); root.frames.unshift(new Frame('https://third.test/advertisement'));
  assert.equal(identity(wc, child, child.url).framePath, 'root/n:editor', 'A uniquely named child survives sibling insertion');
  assert.ok(f.emit(CHANNELS.ready, wc, { url: child.url }, child).returnValue.document);
  root.url = 'https://fixture.test/unrelated'; assert.equal(f.emit(CHANNELS.ready, wc, { url: child.url }, child).returnValue.document, null);
  const privateWC = new Contents(), privateTab = { id: 'private', private: true, documents: [documentState()] }; f.service.attachWebContents(privateWC, privateTab);
  assert.equal(privateTab.documents, undefined); assert.equal(f.emit(CHANNELS.ready, privateWC, { url }).returnValue.enabled, false);
  f.emit(CHANNELS.capture, privateWC, { url, fields: [field()] }); assert.equal(privateTab.documents, undefined);
});
test('main sanitization excludes secrets and oversized values without truncating drafts and bounds persisted data', () => {
  for (const metadata of [{ type: 'password' }, { type: 'file' }, { type: 'hidden' }, { id: 'otp' }, { name: 'auth_otp' }, { name: 'creditCardNumber' }, { name: 'cc_number' }, { name: 'card_num' }, { name: 'api-key' }, { name: 'authToken' }, { id: 'pin' }, { autocomplete: 'section-pay billing cc-number' }, { autocomplete: 'one-time-code' }, { autocomplete: 'new-password' }, { name: 'verification_code' }]) assert.equal(cleanField(field(metadata)), null, JSON.stringify(metadata));
  assert.ok(cleanField(field({ id: 'shipping-note' }))); assert.equal(cleanField(field({ value: 'x'.repeat(LIMITS.value + 1) })), null);
  const saved = cleanDocuments(Array.from({ length: 100 }, (_, i) => documentState({ url: url + '?i=' + i, fields: Array.from({ length: 100 }, (_, n) => field({ selector: '#f' + n, value: 'Ω'.repeat(12000) })), updatedAt: i })));
  assert.ok(saved.length <= LIMITS.documents); assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= LIMITS.tabBytes + 100);
  for (const item of saved) assert.ok(Buffer.byteLength(JSON.stringify(item)) < LIMITS.documentBytes + 100);
});
test('flush requests all normal root/child frames, uses one bounded deadline and retains cached unresponsive data', async t => {
  const f = serviceFixture(); t.after(() => f.service.dispose()); const wc = new Contents(), child = new Frame('https://other.test/frame', wc.mainFrame), tab = { id: 'normal', documents: [documentState()] };
  f.service.attachWebContents(wc, tab);
  wc.mainFrame.onSend = (channel, payload) => { assert.equal(channel, CHANNELS.request); queueMicrotask(() => f.emit(CHANNELS.capture, wc, { ...payload, fields: [field({ value: 'Fresh final capture' })], scroll: { page: { x: 0, y: 900 } } })); };
  child.onSend = channel => assert.equal(channel, CHANNELS.request);
  const start = Date.now(), result = await f.service.flush({ timeoutMs: 30 });
  assert.deepEqual(result, { requested: 2, captured: 1, timedOut: 1 }); assert.ok(Date.now() - start < 400);
  assert.equal(tab.documents[0].fields[0].value, 'Fresh final capture'); assert.equal(tab.documents[0].scroll.page.y, 900);
  child.onSend = (_channel, payload) => queueMicrotask(() => f.emit(CHANNELS.capture, wc, { ...payload, fields: [field({ value: 'Child draft' })] }, child));
  assert.deepEqual(await f.service.flush({ timeoutMs: 200 }), { requested: 2, captured: 2, timedOut: 0 }); assert.equal(tab.documents.length, 2);
});
test('session preload registration is idempotent and disposal releases listeners and pending flush', async () => {
  const f = serviceFixture(); let registered = 0, removed = 0; const ses = { registerPreloadScript(options) { registered++; assert.equal(options.type, 'frame'); return 'preload'; }, unregisterPreloadScript(id) { assert.equal(id, 'preload'); removed++; } };
  f.service.attachSession(ses); f.service.attachSession(ses); assert.equal(registered, 1);
  const wc = new Contents(); f.service.attachWebContents(wc, { id: 'normal' }); const pending = f.service.flush({ timeoutMs: 1000 }); f.service.dispose();
  assert.equal((await pending).timedOut, 1); assert.equal(removed, 1); assert.equal(wc.listenerCount('destroyed'), 0); assert.equal(f.ipcMain.listenerCount(CHANNELS.ready), 0);
});

function preloadFixture({ saved = documentState(), enabled = true, fields = [], scrollY = 0 } = {}) {
  const listeners = new Map(), timers = new Map(), intervals = new Map(), nodes = [], captures = [], mutations = []; let serial = 0, y = scrollY, x = 0;
  const html = { nodeType: 1, tagName: 'HTML', id: '', parentElement: null, children: [], scrollLeft: 0, scrollTop: 0 };
  function node(options = {}) {
    const n = { nodeType: 1, tagName: 'INPUT', id: 'draft', type: 'text', value: '', defaultValue: '', disabled: false, readOnly: false, children: [], parentElement: html, previousElementSibling: null,
      attrs: {}, isContentEditable: false, scrollLeft: 0, scrollTop: 0, style: { overflowX: 'auto', overflowY: 'auto' },
      getAttribute(name) { return this.attrs[name] ?? (name === 'id' ? this.id : null); },
      closest(query) { if (query === '[inert]') return null; if (query === '[contenteditable]') return this.isContentEditable ? this : null; return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) || this.isContentEditable ? this : null; },
      scrollTo(p) { this.scrollLeft = p.left; this.scrollTop = p.top; }, ...options };
    nodes.push(n); return n;
  }
  fields.forEach(node);
  const document = { readyState: 'complete', documentElement: html, scrollingElement: html,
    querySelectorAll(selector) {
      if (selector.startsWith('#')) return nodes.filter(n => n.id === selector.slice(1));
      if (selector === '[id]') return nodes.filter(n => n.id);
      if (selector === '[contenteditable]') return nodes.filter(n => n.isContentEditable);
      if (selector.startsWith('input,textarea,select')) return nodes.filter(n => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName) || n.isContentEditable);
      return [];
    }
  };
  const ipc = new EventEmitter(); ipc.sendSync = (channel, payload) => channel === CHANNELS.ready ? { enabled, url, document: saved } : captures.push({ channel, payload }); ipc.send = (channel, payload) => captures.push({ channel, payload });
  const context = { location: { href: url }, document, CSS: { escape: s => s }, require(name) { assert.equal(name, 'electron'); return { ipcRenderer: ipc }; },
    getComputedStyle: n => n.style, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    setTimeout(fn) { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval(fn) { const id = ++serial; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    MutationObserver: class { constructor(callback) { this.callback = callback; mutations.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    Date, scrollTo(p) { x = p.left; y = p.top; }
  };
  Object.defineProperties(context, { scrollX: { get: () => x }, scrollY: { get: () => y } }); context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/session-state-preload.cjs'), 'utf8'), context);
  return { context, nodes, node, captures, ipc, intervals, mutations,
    emit(name, target = nodes[0], extra = {}) { for (const fn of listeners.get(name) || []) fn({ target, ...extra }); },
    capture() { ipc.emit(CHANNELS.request, {}, { url: context.location.href, requestId: 'fixture-final' }); return captures.at(-1)?.payload; },
    mutate() { for (const observer of mutations) if (!observer.disconnected) observer.callback([]); },
    retry() { for (const fn of intervals.values()) fn(); },
    scroll(value) { y = value; }
  };
}
test('sandbox preload restores a nameless-ID draft and scroll by property assignment without any synthetic event or bridge', () => {
  const f = preloadFixture({ fields: [{}] }); assert.equal(f.nodes[0].value, 'A real retained draft'); assert.equal(f.context.scrollY, 720);
  assert.equal(f.context.aster, undefined); assert.equal(f.context.contextBridge, undefined);
  const final = f.capture(); assert.equal(final.fields[0].value, 'A real retained draft'); assert.equal(final.fields[0].name, ''); assert.equal(final.scroll.page.y, 720);
  f.emit('pagehide'); assert.equal(f.captures.at(-1).channel, CHANNELS.final);
});
test('late hydration gets its draft, while a newer human edit or nondefault site value wins permanently', () => {
  const late = preloadFixture(); assert.equal(late.capture().fields[0].value, 'A real retained draft', 'Closing before hydration must preserve the pending draft');
  const node = late.node(); late.mutate(); assert.equal(node.value, 'A real retained draft'); node.value = ''; late.retry(); assert.equal(node.value, 'A real retained draft', 'A hydration reset to the default can be restored');
  node.value = 'Newer human draft'; late.emit('input', node); late.retry(); assert.equal(node.value, 'Newer human draft'); node.value = ''; late.retry(); assert.equal(node.value, '', 'Do not refill a human-cleared field'); assert.equal(late.capture().fields.length, 0);
  const site = preloadFixture({ fields: [{ value: 'New server value' }] }); assert.equal(site.nodes[0].value, 'New server value'); site.nodes[0].value = ''; site.retry(); assert.equal(site.nodes[0].value, '');
});
test('restore waits for disabled controls and asynchronously populated select options without erasing pending drafts', () => {
  const disabled = preloadFixture({ fields: [{ disabled: true }] }); assert.equal(disabled.nodes[0].value, ''); assert.equal(disabled.capture().fields[0].value, 'A real retained draft'); disabled.nodes[0].disabled = false; disabled.retry(); assert.equal(disabled.nodes[0].value, 'A real retained draft');
  const option = { value: 'one', defaultSelected: true, selected: true };
  const saved = documentState({ fields: [field({ tag: 'select', type: 'select', base: ['one'], value: ['two'] })] });
  const select = preloadFixture({ saved, fields: [{ tagName: 'SELECT', type: 'select-one', options: [option], get selectedOptions() { return this.options.filter(o => o.selected); } }] });
  assert.equal(option.selected, true, 'Missing saved option must not deselect the currently valid default'); assert.equal(select.capture().fields[0].value[0], 'two');
  select.nodes[0].options.push({ value: 'two', defaultSelected: false, selected: false }); select.mutate(); assert.equal(select.nodes[0].options[1].selected, true); assert.equal(option.selected, false);
});
test('preload rechecks secret metadata, does not capture private pages, and respects new scroll/SPA locations', () => {
  const privatePage = preloadFixture({ enabled: false, fields: [{ value: 'Private draft' }] }); assert.equal(privatePage.capture(), undefined); assert.equal(privatePage.captures.length, 0);
  const secret = preloadFixture({ fields: [{ type: 'password' }] }); assert.equal(secret.nodes[0].value, ''); secret.nodes[0].value = 'Secret password'; assert.equal(secret.capture().fields.length, 0);
  const autocomplete = preloadFixture({ saved: null, fields: [{ attrs: { autocomplete: 'one-time-code' }, value: '123456' }] }); assert.equal(autocomplete.capture().fields.length, 0);
  const page = preloadFixture({ fields: [{}] }); page.emit('wheel'); page.scroll(1000); page.retry(); assert.equal(page.context.scrollY, 1000); assert.equal(page.capture().scroll.page.y, 1000);
  page.context.location.href = url + '?other'; page.nodes[0].value = ''; page.retry(); assert.equal(page.nodes[0].value, ''); assert.equal(page.capture().fields.length, 0);
});
test('identified scroll containers restore independently and pending hydration preserves their positions', () => {
  const saved = documentState({ fields: [], scroll: { page: { x: 0, y: 0 }, elements: [{ selector: '#messages', x: 0, y: 430 }] } });
  const late = preloadFixture({ saved }); assert.equal(late.capture().scroll.elements[0].y, 430);
  const node = late.node({ tagName: 'DIV', id: 'messages', type: '', value: undefined, defaultValue: undefined }); late.mutate(); assert.equal(node.scrollTop, 430);
  node.scrollTop = 600; late.retry(); assert.equal(node.scrollTop, 600, 'Current site/container scrolling must not be overwritten'); assert.equal(late.capture().scroll.elements[0].y, 600);
});
