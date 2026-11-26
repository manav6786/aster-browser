import assert from 'node:assert/strict';
import test from 'node:test';
import { closeTab, MAX_TABS, newTab, resolveAddress, restoreSession, saveSession } from './session.ts';

test('address entry separates web navigation from search and rejects unsafe destinations', () => {
  assert.equal(resolveAddress(' example.com/path '), 'https://example.com/path');
  assert.equal(resolveAddress('orbit glass'), 'https://www.google.com/search?q=orbit%20glass');
  for (const input of ['http://example.com', 'file:///tmp/page.html', 'javascript:alert(1)', 'https://one:two@example.com']) {
    assert.equal(resolveAddress(input), null);
  }
});

test('restored tabs keep order and selection while native state starts fresh', () => {
  const first = { ...newTab('https://example.com/', 'Sample', 'a'), canGoBack: true, revision: 2 };
  const second = newTab(null, 'New tab', 'b');
  const result = restoreSession(saveSession({ tabs: [first, second], activeId: 'b' }));
  assert.deepEqual(result.tabs.map(tab => tab.id), ['a', 'b']);
  assert.equal(result.activeId, 'b');
  assert.equal(result.tabs[0].url, 'https://example.com/');
  assert.equal(result.tabs[0].canGoBack, false);
  assert.equal(result.tabs[0].revision, 0);
});

test('bad session data cannot create unsafe webviews or exceed the tab limit', () => {
  const raw = JSON.stringify({ activeId: 'missing', tabs: Array.from({ length: 20 }, (_, i) => ({ id: String(i), url: 'file:///tmp/page.html' })) });
  const result = restoreSession(raw);
  assert.equal(result.tabs.length, MAX_TABS);
  assert.equal(result.activeId, '0');
  assert.ok(result.tabs.every(tab => tab.source === null));
  assert.equal(restoreSession('{broken').tabs.length, 1);
});

test('closing the active tab selects its neighbor and keeps one home tab open', () => {
  const session = { tabs: [newTab(null, undefined, 'a'), newTab(null, undefined, 'b')], activeId: 'a' };
  const next = closeTab(session, 'a');
  assert.equal(next.activeId, 'b');
  const last = closeTab(next, 'b');
  assert.equal(last.tabs.length, 1);
  assert.equal(last.tabs[0].url, null);
});
