'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mainFixture } = require('./helpers/main-fixture.cjs');

const first = 'https://fixture.test/first', second = 'https://fixture.test/second';
const navigation = () => ({ entries: [{ url: first, title: 'First' }, { url: second, title: 'Second' }], index: 1 });
const documents = value => [{ url: second, rootURL: second, framePath: 'root', fields: [{ selector: '#draft', tag: 'textarea', type: 'textarea', id: 'draft', name: '', label: '', autocomplete: '', form: '', base: '', value }], scroll: { page: { x: 0, y: 600 }, elements: [] }, updatedAt: 1 }];
const fixture = t => { const f = mainFixture({ tabs: [{ id: 'normal', url: second, title: 'Saved title', pinned: true, muted: true, volume: .2, navigation: navigation(), documents: documents('Cached draft') }], activeTabId: 'normal' }); t.after(() => f.dispose()); return f; };

test('automatic mutation leases preserve longer explicit claims and still renew ordinary claims', async t => {
  const f = fixture(t), owner = { id: 'owner', name: 'Owner' }; let now = 1000; f.leases.now = () => now;
  f.setAgentEngine({ execute: async () => ({ ok: true }) });
  await f.agentCommand('tabs.claim', { tabId: 'normal', ttl: 120000 }, owner);
  now = 2000; await f.agentCommand('page.click', { tabId: 'normal', selector: '#continue' }, owner);
  assert.equal(f.leases.get('normal').expiresAt, 121000, 'A mutation must not truncate a longer explicit claim');
  now = 33000; assert.throws(() => f.leases.claim('normal', 'rival'), /claimed/);
  await f.agentCommand('tabs.release', { tabId: 'normal' }, owner);
  await f.agentCommand('page.click', { tabId: 'normal', selector: '#continue' }, owner);
  assert.equal(f.leases.get('normal').expiresAt, 63000);
  now = 40000; await f.agentCommand('page.click', { tabId: 'normal', selector: '#continue' }, owner);
  assert.equal(f.leases.get('normal').expiresAt, 70000, 'Ordinary automatic claims still renew from the mutation time');
});

test('a later Mission Control close or tab activation supersedes an unfinished thumbnail capture', async t => {
  const f = fixture(t); await f.command('tab:activate', { id: 'normal' });
  const wc = f.views.get('normal').webContents, captures = [];
  wc.capturePage = () => new Promise(resolve => { captures.push(() => resolve({ isEmpty: () => true })); });
  const finish = () => { while (captures.length) captures.shift()(); };
  const opening = f.mission(true); await f.mission(false); finish();
  assert.equal(await opening, false); assert.equal(f.state.missionOpen, false);
  const nextOpening = f.mission(true); await f.command('tab:new'); finish();
  assert.equal(await nextOpening, false); assert.equal(f.state.missionOpen, false);
});

test('reopening a closed tab restores final live history, captured drafts/scroll and fractional volume', async t => {
  const f = fixture(t); await f.command('tab:activate', { id: 'normal' });
  const wc = f.views.get('normal').webContents;
  wc.navigationHistory.entries = [{ url: first, title: 'Fresh first' }, { url: second, title: 'Fresh second' }];
  wc.navigationHistory.index = 1;
  const calls = [];
  f.setSessionState({ attachWebContents() {}, flush: async options => { calls.push(options); f.state.tabs.find(tab => tab.id === 'normal').documents = documents('Final live draft'); } });
  await f.command('tab:close', { id: 'normal' });
  assert.equal(calls.length, 1); assert.equal(calls[0].tabId, 'normal'); assert.equal(wc.closeCount, 1);
  const reopened = await f.command('tab:restore'), restoredWc = f.views.get(reopened.id).webContents;
  assert.equal(reopened.volume, .2); assert.equal(reopened.muted, true); assert.equal(reopened.pinned, true); assert.equal(reopened.title, 'Saved title');
  assert.equal(reopened.documents[0].fields[0].value, 'Final live draft'); assert.equal(reopened.documents[0].scroll.page.y, 600);
  assert.equal(reopened.navigation.entries[0].title, 'Fresh first'); assert.equal(restoredWc.restored.length, 1); assert.equal(restoredWc.loaded.length, 0);
});

test('overlapping closes capture and remove one tab once, and an immediate restore waits for capture', async t => {
  const f = fixture(t); await f.command('tab:activate', { id: 'normal' });
  const wc = f.views.get('normal').webContents; let finish, captures = 0;
  f.setSessionState({ attachWebContents() {}, flush: () => { captures++; return new Promise(resolve => { finish = resolve; }); } });
  const firstClose = f.command('tab:close', { id: 'normal' });
  const duplicateClose = f.command('tab:close', { id: 'normal' });
  const restore = f.command('tab:restore');
  await Promise.resolve();
  assert.equal(captures, 1); assert.equal(wc.closeCount, 0); assert.equal(f.state.tabs[0].id, 'normal');
  finish(); await Promise.all([firstClose, duplicateClose]); const reopened = await restore;
  assert.equal(wc.closeCount, 1); assert.equal(f.closedTabs.length, 0); assert.equal(reopened.volume, .2);
  assert.equal(f.state.tabs.filter(tab => tab.url === second).length, 1);
});

test('shutdown waits for pending tab closes before saving, with cached data surviving failed capture', async t => {
  const f = fixture(t); await f.command('tab:activate', { id: 'normal' }); let finish, captures = 0;
  f.setSessionState({ flush: () => { captures++; return captures === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(); } });
  const closing = f.command('tab:close', { id: 'normal' }), preparing = f.prepareSessionClose();
  await Promise.resolve();
  assert.equal(captures, 1); finish(); await closing; await preparing;
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'browser.json'), 'utf8'));
  assert.equal(saved.tabs.some(tab => tab.id === 'normal'), false); assert.equal(captures, 2);
  const other = fixture(t); await other.command('tab:activate', { id: 'normal' });
  other.setSessionState({ attachWebContents() {}, flush: async () => { throw Error('Unresponsive frame'); } });
  await other.command('tab:close', { id: 'normal' }); const reopened = await other.command('tab:restore');
  assert.equal(reopened.documents[0].fields[0].value, 'Cached draft'); assert.equal(other.errors.length, 1);
});
