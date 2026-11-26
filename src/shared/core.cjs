'use strict';
const { randomUUID } = require('node:crypto');
const INTERNAL = new Set(['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'agents']);
const SEARCH = { brave: 'https://search.brave.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=', google: 'https://www.google.com/search?q=' };
function normalizeURL(value, engine = 'google') {
  const input = String(value || '').trim();
  if (!input) return 'aster://newtab';
  if (input === 'about:blank') return input;
  if (input.startsWith('aster://')) {
    if (!INTERNAL.has(input.slice(8))) throw new Error('Unknown Aster page');
    return input;
  }
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.username || url.password) throw new Error('Use the website’s sign-in form instead of credentials in the URL');
    return url.href;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[\w.-]+:\d+(\/|$)/.test(input)) throw new Error('Only HTTP and HTTPS pages are supported');
  if (!/\s/.test(input) && /^(localhost|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(input)) {
    return new URL((/^(localhost|127\.|\[::1\])/.test(input) ? 'http://' : 'https://') + input).href;
  }
  return (SEARCH[engine] || SEARCH.google) + encodeURIComponent(input);
}
function newTab(input = {}) {
  return { id: randomUUID(), title: 'New tab', url: 'aster://newtab', workspace: 'personal', pinned: false, private: false, isLoading: false, canGoBack: false, canGoForward: false, muted: false, volume: 1, audible: false, blocked: 0, error: null, ...input };
}
function initialState(saved = {}) {
  const workspaces = [{ id: 'personal', name: 'Personal', color: '#8c7ce8' }, { id: 'work', name: 'Work', color: '#568dce' }, { id: 'research', name: 'Research', color: '#5eae96' }];
  const state = {
    tabs: [], activeTabId: null, activeWorkspace: 'personal', workspaces,
    bookmarks: [{ id: 'google', title: 'Google', url: 'https://www.google.com/' }, { id: 'github', title: 'GitHub', url: 'https://github.com/' }, { id: 'apple', title: 'Apple', url: 'https://www.apple.com/' }, { id: 'wikipedia', title: 'Wikipedia', url: 'https://www.wikipedia.org/' }],
    history: [], downloads: [], agents: [], activity: [], missionOpen: false, window: saved.window,
    settings: { theme: 'system', accent: 'purple', transparency: false, sidebarCollapsed: false, autoTidy: true, restoreSession: true, searchEngine: 'google',searchSuggestions:false,defaultsVersion:1 },
    shields: { enabled: true, status: 'loading', blocked: 0, filterCount: 0, lastUpdated: null }, automation: {}
  };
  for (const key of ['bookmarks', 'history', 'workspaces']) if (Array.isArray(saved[key]) && saved[key].length < 10001) state[key] = saved[key];
  if (!state.workspaces.some(w => w.id === 'personal')) state.workspaces.unshift(workspaces[0]);
  state.settings = { ...state.settings, ...saved.settings };
  if (!saved.settings?.defaultsVersion) {
    if (!saved.settings?.searchEngine || saved.settings.searchEngine === 'brave') state.settings.searchEngine = 'google';
    state.settings.restoreSession = true;
    state.settings.defaultsVersion = 1;
  }
  delete state.settings.gestureEnabled;
  if (Array.isArray(saved.downloads)) state.downloads = saved.downloads.filter(d => d && !d.private && typeof d.name === 'string' && typeof d.path === 'string').slice(0, 1000).map(d => ({ ...d, state: d.state === 'progressing' ? 'interrupted' : d.state }));
  if (saved.shields) state.shields = { ...state.shields, enabled: saved.shields.enabled !== false, blocked: Number(saved.shields.blocked) || 0 };
  if (state.settings.restoreSession && Array.isArray(saved.tabs)) {
    state.tabs = saved.tabs.filter(t => !t.private && typeof t.url === 'string').slice(0, 500).flatMap(t => {
      try { return [newTab({ ...t, volume: Number.isFinite(t.volume) ? Math.max(0,Math.min(1,t.volume)) : 1, url: normalizeURL(t.url), workspace: state.workspaces.some(w => w.id === t.workspace) ? t.workspace : 'personal', isLoading: false, error: null, thumbnail: null, audible:false,pipActive:false,videoCount:0,canGoBack: false, canGoForward: false })]; } catch { return []; }
    });
  }
  if (!state.tabs.length) state.tabs.push(newTab());
  state.activeTabId = state.tabs.some(t => t.id === saved.activeTabId) ? saved.activeTabId : state.tabs[0].id;
  state.activeWorkspace = state.tabs.find(t => t.id === state.activeTabId).workspace;
  state.lastNormalTabId = state.activeTabId;
  return state;
}
class LeaseRegistry {
  constructor(now = Date.now) { this.now = now; this.leases = new Map(); }
  get(id) { const lease = this.leases.get(id); if (lease && lease.expiresAt <= this.now()) { this.leases.delete(id); return null; } return lease || null; }
  claim(id, agentId, ttl = 30000) {
    const existing = this.get(id);
    if (existing && existing.agentId !== agentId) throw new Error('Tab is claimed by another agent; use a separate tab or wait for its claim to expire');
    const lease = { agentId, expiresAt: this.now() + Math.min(120000, Math.max(1000, Number(ttl) || 30000)) };
    this.leases.set(id, lease); return lease;
  }
  release(id, agentId) { const lease = this.get(id); if (lease && lease.agentId !== agentId) throw new Error('Only the owner can release this tab'); this.leases.delete(id); }
  releaseAgent(agentId) { for (const [id, lease] of this.leases) if (lease.agentId === agentId) this.leases.delete(id); }
}
module.exports = { normalizeURL, newTab, initialState, LeaseRegistry };
