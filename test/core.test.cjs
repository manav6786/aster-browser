'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeURL, initialState, LeaseRegistry } = require('../src/shared/core.cjs');
test('address input supports destinations, searches, localhost and rejects native code schemes', () => {
  assert.equal(normalizeURL('example.com'), 'https://example.com/');
  assert.equal(normalizeURL('localhost:8000/path'), 'http://localhost:8000/path');
  assert.equal(normalizeURL('127.0.0.1:8000'), 'http://127.0.0.1:8000/');
  assert.equal(normalizeURL('a beautiful browser'), 'https://www.google.com/search?q=a%20beautiful%20browser');
  assert.equal(normalizeURL('aster://agents'), 'aster://agents');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:password@example.com', 'aster://invalid']) assert.throws(() => normalizeURL(url));
});
test('restoring a session omits private tabs and resets unavailable renderer state', () => {
  const state = initialState({ tabs: [{ id: 'private', private: true, url: 'https://private.example' }, { id: 'public', url: 'https://example.com', workspace: 'deleted', isLoading: true, canGoBack: true }], activeTabId: 'private' });
  assert.equal(state.tabs.length, 1); assert.equal(state.activeTabId, 'public'); assert.equal(state.tabs[0].workspace, 'personal'); assert.equal(state.tabs[0].isLoading, false); assert.equal(state.tabs[0].canGoBack, false);
});
test('Google defaults and complete normal-tab restoration migrate without losing explicit newer choices',()=>{
  assert.equal(initialState().settings.searchEngine,'google');
  assert.equal(initialState({settings:{searchEngine:'brave'}}).settings.searchEngine,'google');
  assert.equal(initialState({settings:{defaultsVersion:1,searchEngine:'brave'}}).settings.searchEngine,'brave');
  const tabs=Array.from({length:135},(_,i)=>({id:'saved-'+i,url:'https://example.com/'+i,volume:.35,pinned:i===134}));
  const state=initialState({tabs,activeTabId:'saved-134'});assert.equal(state.tabs.length,135);assert.equal(state.activeTabId,'saved-134');assert.equal(state.tabs[134].volume,.35);assert.equal(state.tabs[134].pinned,true);
});
test('tab claims exclude other agents, renew, expire, and release after disconnect', () => {
  let now = 1000; const leases = new LeaseRegistry(() => now);
  leases.claim('tab', 'one', 2000); assert.throws(() => leases.claim('tab', 'two'));
  leases.claim('tab', 'one', 5000); now += 2500; assert.throws(() => leases.release('tab', 'two'));
  now += 3000; assert.equal(leases.get('tab'), null); leases.claim('tab', 'two'); leases.releaseAgent('two'); assert.equal(leases.get('tab'), null);
});
