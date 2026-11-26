'use strict';
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, protocol, net, dialog, shell, clipboard, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { normalizeURL, newTab, initialState, LeaseRegistry } = require('../shared/core.cjs');
const { startAutomation } = require('./automation.cjs');
protocol.registerSchemesAsPrivileged([
  { scheme: 'aster-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // This scheme serves only inert, engine-approved ad replacement resources.
  // Its CSP exemption lets a blocked script's replacement retain its behavior
  // without weakening the policy on any remote or local file resource.
  { scheme: 'aster-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
]);
if (process.env.ASTER_DATA_DIR) app.setPath('userData', path.resolve(process.env.ASTER_DATA_DIR));
app.setName('Aster');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
const root = path.join(__dirname, '../..');
const automationRoot = app.isPackaged ? path.join(process.resourcesPath, 'automation') : path.join(root, 'bin');
let win, state, automation, shields, saveTimer, stateTimer;
let overlay = false, shuttingDown = false, closingWindow = false, overlayRequest = 0;
let privatePartition = null;
let fullscreenTabId = null;
const views = new Map(), wcTabs = new Map(), queues = new Map(), closedTabs = [];
const leases = new LeaseRegistry();
const storePath = () => path.join(app.getPath('userData'), 'browser.json');
const isRemote = tab => tab && (/^https?:/.test(tab.url) || tab.url === 'about:blank');
const current = () => state.tabs.find(t => t.id === state.activeTabId);
function requireTab(id = state.activeTabId) { const tab = state.tabs.find(t => t.id === id); if (!tab) throw new Error('Tab not found'); return tab; }
function ui(command) { if (win && !win.isDestroyed()) win.webContents.send('aster:ui', command); }
function snapshot(thumbnails = false) {
  return { ...state, tabs: state.tabs.map(({ thumbnail, ...t }) => ({ ...t, ...(thumbnails ? { thumbnail } : {}), claim: leases.get(t.id) })), agents: state.agents.map(a => ({ ...a, tabs: state.tabs.filter(t => leases.get(t.id)?.agentId === a.id).map(t => t.id) })) };
}
function persist() {
  if (!state) return;
  try {
    const data = { tabs: state.tabs.filter(t => !t.private).map(({ thumbnail, ...t }) => t), activeTabId: state.activeTabId, workspaces: state.workspaces, bookmarks: state.bookmarks, history: state.history.slice(0, 3000), downloads: state.downloads.filter(d => !d.private).slice(0, 1000), settings: state.settings, shields: { enabled: state.shields.enabled, blocked: state.shields.blocked } };
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(storePath() + '.tmp', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(storePath() + '.tmp', storePath());
  } catch (error) { console.error('Could not save session:', error.message); }
}
function publish(save = true) {
  if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; if (win && !win.isDestroyed()) win.webContents.send('aster:state', snapshot(state.missionOpen || overlay)); }, 60);
  if (save) { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); }
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const x = state.settings.sidebarCollapsed ? 76 : 246;
  for (const [id, view] of views) {
    const visible = id === state.activeTabId && !overlay && !state.missionOpen && isRemote(current()) && !current()?.error;
    view.setBounds(id === fullscreenTabId && visible ? { x: 0, y: 0, width, height } : { x: x + 10, y: 86, width: Math.max(50, width - x - 20), height: Math.max(50, height - 116) });
    view.setVisible(visible);
  }
}
async function captureTab(tab) {
  const wc = views.get(tab.id)?.webContents;
  if (!wc || wc.isDestroyed() || !isRemote(tab)) return;
  try { const image = await wc.capturePage(undefined, { stayHidden: true }); if (!image.isEmpty()) tab.thumbnail = image.resize({ width: 480 }).toDataURL(); } catch {}
}
async function mission(open) {
  if (open && !state.missionOpen) await Promise.allSettled(state.tabs.map(captureTab));
  state.missionOpen = Boolean(open); overlayRequest++; overlay = false; layout(); publish(false);
  if (open) win.webContents.focus();
}
function setupSession(ses) {
  shields.attach(ses);
  const grants = new Set();
  const pendingGrants = new Map();
  const originOf = value => { try { return new URL(value).origin; } catch { return ''; } };
  ses.setPermissionCheckHandler((_wc, permission, origin) => grants.has(originOf(origin) + ':' + permission));
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (permission === 'fullscreen') return callback(true);
    const origin = originOf(details.requestingUrl || wc.getURL()), key = origin + ':' + permission;
    if (!origin || origin === 'null' || shuttingDown) return callback(false);
    if (grants.has(key)) return callback(true);
    if (!pendingGrants.has(key)) pendingGrants.set(key, dialog.showMessageBox(win, { type: 'question', title: 'Website permission', message: `${origin} wants to use ${permission}`, detail: 'Allow only if you trust this website. This choice lasts for this browser session.', buttons: ['Don’t allow', 'Allow'], defaultId: 0, cancelId: 0 }).then(({ response }) => { if (response === 1) grants.add(key); return response === 1; }).catch(() => false).finally(() => pendingGrants.delete(key)));
    callback(await pendingGrants.get(key));
  });
  ses.on('will-download', (_event, item, wc) => {
    const tab = state.tabs.find(t => t.id === wcTabs.get(wc.id));
    const entry = { id: randomUUID(), name: item.getFilename(), path: '', state: 'progressing', received: 0, total: item.getTotalBytes(), private: Boolean(tab?.private) };
    state.downloads.unshift(entry); publish();
    item.on('updated', (_event, status) => { Object.assign(entry, { state: status, received: item.getReceivedBytes(), total: item.getTotalBytes() }); publish(false); });
    item.once('done', (_event, status) => { Object.assign(entry, { state: status, path: item.getSavePath(), received: item.getReceivedBytes() }); publish(); });
  });
}
function wireShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    const mod = input.meta || input.control;
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (mod && ['l', 'k', 't', 'w', 'f', 'd', 'r'].includes(key)) {
      event.preventDefault();
      if (key === 'l') { win.webContents.focus(); ui('address'); }
      if (key === 'k') { overlay = true; layout(); ui('palette'); }
      if (key === 't') input.shift ? command('tab:restore') : command('tab:new');
      if (key === 'w') command('tab:close');
      if (key === 'f') { win.webContents.focus(); ui('find'); }
      if (key === 'd') command('bookmark:toggle');
      if (key === 'r') command('tab:reload');
    } else if (mod && input.shift && key === 'm') { event.preventDefault(); mission(!state.missionOpen); }
    else if (mod && key === ',') { event.preventDefault(); command('tab:new', { url: 'aster://settings' }); }
    else if (input.key === 'Escape' && state.missionOpen) { event.preventDefault(); mission(false); }
    else if (mod && input.key === 'Tab') { event.preventDefault(); const list = state.tabs.filter(t => t.workspace === state.activeWorkspace); const i = list.findIndex(t => t.id === state.activeTabId); if (list.length) activate(list[(i + (input.shift ? list.length - 1 : 1)) % list.length].id); }
  });
}
function ensureView(tab, popupOptions = null) {
  if (!isRemote(tab)) return null;
  if (views.has(tab.id)) return views.get(tab.id);
  if (tab.private && !privatePartition) { privatePartition = 'aster-private-' + randomUUID(); setupSession(session.fromPartition(privatePartition)); }
  // Electron has already created popupOptions.webContents to preserve opener,
  // target name, POST data and session identity. Adopt that exact instance.
  const view = new WebContentsView(popupOptions?.webContents ? { webContents: popupOptions.webContents } : { webPreferences: { session: session.fromPartition(tab.private ? privatePartition : 'persist:aster'), nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, preload: undefined, webviewTag: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false } });
  view.setBackgroundColor('#ffffff');
  if (view.setBorderRadius) view.setBorderRadius(12);
  const [initialWidth, initialHeight] = win.getContentSize();
  const initialX = state.settings.sidebarCollapsed ? 76 : 246;
  view.setBounds({ x: initialX + 10, y: 86, width: initialWidth - initialX - 20, height: initialHeight - 116 });
  views.set(tab.id, view); wcTabs.set(view.webContents.id, tab.id); win.contentView.addChildView(view);
  const wc = view.webContents;
  wc.setUserAgent(wc.getUserAgent().replace(/\sAster\/\S+|\sElectron\/\S+/g, ''));
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!/^https?:/.test(url) && url !== 'about:blank') return { action: 'deny' };
    return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }, createWindow: options => {
      const child = createTab({ url, workspace: tab.workspace, private: tab.private }, disposition !== 'background-tab', options);
      return views.get(child.id).webContents;
    } };
  });
  wc.on('will-navigate', (event, url) => { if (!/^https?:/.test(url) && url !== 'about:blank') event.preventDefault(); });
  wc.on('will-redirect', (event, url) => { if (!/^https?:/.test(url) && url !== 'about:blank') event.preventDefault(); });
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('page-title-updated', (_event, title) => { tab.title = title; publish(); });
  wc.on('did-start-loading', () => { tab.isLoading = true; tab.error = null; layout(); publish(false); });
  wc.on('did-stop-loading', () => { tab.isLoading = false; publish(false); });
  const navigated = (_event, url, _code, _status, isMainFrame = true) => {
    if (!isMainFrame || (!/^https?:/.test(url) && url !== 'about:blank')) return;
    tab.url = url; tab.canGoBack = wc.navigationHistory.canGoBack(); tab.canGoForward = wc.navigationHistory.canGoForward(); tab.error = null;
    if (!tab.private && /^https?:/.test(url)) { state.history = state.history.filter(h => h.url !== url); state.history.unshift({ id: randomUUID(), title: wc.getTitle() || url, url, visitedAt: Date.now() }); state.history.length = Math.min(state.history.length, 3000); }
    publish();
  };
  wc.on('did-navigate', (event, url) => navigated(event, url));
  wc.on('did-navigate-in-page', (event, url, mainFrame) => navigated(event, url, null, null, mainFrame));
  wc.on('did-finish-load', () => { tab.title = wc.getTitle() || tab.url; if (!tab.private && state.history[0]?.url === tab.url) state.history[0].title = tab.title; captureTab(tab).then(() => publish()); });
  wc.on('dom-ready', () => { if (tab.id === state.activeTabId) animatePage(wc); });
  wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { tab.error = description; tab.isLoading = false; layout(); publish(false); } });
  wc.on('render-process-gone', (_event, details) => { tab.error = 'Page stopped: ' + details.reason; tab.isLoading = false; layout(); publish(false); });
  wc.on('media-started-playing', () => { tab.audible = true; publish(false); });
  wc.on('media-paused', () => { tab.audible = false; publish(false); });
  wc.on('enter-html-full-screen', () => { fullscreenTabId = tab.id; layout(); });
  wc.on('leave-html-full-screen', () => { if (fullscreenTabId === tab.id) fullscreenTabId = null; layout(); });
  wc.on('context-menu', (_event, params) => {
    const items = [];
    if (/^https?:/.test(params.linkURL)) items.push({ label: 'Open Link in New Tab', click: () => createTab({ url: params.linkURL, workspace: tab.workspace, private: tab.private }) }, { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: 'Reload', click: () => wc.reload() }, { type: 'separator' }, { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  wc.on('destroyed', () => {
    if (closingWindow || shuttingDown || views.get(tab.id) !== view) return;
    wcTabs.delete(wc.id); views.delete(tab.id); win.contentView.removeChildView(view);
    if (state.tabs.some(t => t.id === tab.id)) closeTab(tab.id);
  });
  wireShortcuts(wc); wc.setAudioMuted(tab.muted); layout(); if (!popupOptions) wc.loadURL(tab.url).catch(() => {}); return view;
}
function activate(id) {
  const old = current(); if (old && old.id !== id) captureTab(old);
  const tab = requireTab(id); state.activeTabId = id; state.activeWorkspace = tab.workspace; state.missionOpen = false; overlayRequest++; overlay = false;
  const view = ensureView(tab); layout(); publish(); if (view) { view.webContents.focus(); if (!view.webContents.isLoading()) animatePage(view.webContents); } else win.webContents.focus(); return tab;
}
function animatePage(wc) { wc.executeJavaScript("if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.animate([{opacity:0.5},{opacity:1}],{duration:160,easing:'ease-out'})").catch(() => {}); }
function createTab(input = {}, focus = true, popupOptions = null) {
  if (state.tabs.length >= 500) throw new Error('Close a tab before opening more than 500');
  const workspace = state.workspaces.some(w => w.id === input.workspace) ? input.workspace : state.activeWorkspace;
  const tab = newTab({ url: normalizeURL(input.url, state.settings.searchEngine), workspace, private: Boolean(input.private), pinned: Boolean(input.pinned), muted: Boolean(input.muted) });
  if (isRemote(tab)) tab.title = new URL(tab.url).hostname || 'Blank tab';
  else tab.title = tab.url === 'aster://newtab' ? 'New tab' : tab.url.slice(8).replace(/^./, c => c.toUpperCase());
  state.tabs.push(tab); if (popupOptions) ensureView(tab, popupOptions); if (focus) activate(tab.id); else { ensureView(tab); publish(); } return tab;
}
function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  if (fullscreenTabId === id) fullscreenTabId = null;
  wcTabs.delete(view.webContents.id); views.delete(id); win.contentView.removeChildView(view); view.webContents.removeAllListeners(); view.webContents.close();
}
function closeTab(id = state.activeTabId) {
  const tab = requireTab(id), index = state.tabs.indexOf(tab);
  if (!tab.private) closedTabs.unshift({ ...tab, thumbnail: null }); closedTabs.length = Math.min(closedTabs.length, 20);
  destroyView(id);
  leases.leases.delete(id); state.tabs.splice(index, 1);
  if (tab.private && privatePartition && !state.tabs.some(t => t.private)) {
    const oldSession = session.fromPartition(privatePartition); privatePartition = null;
    Promise.allSettled([oldSession.clearStorageData(), oldSession.clearCache()]);
    state.downloads = state.downloads.filter(d => !d.private);
  }
  if (!state.tabs.length) return createTab();
  if (state.activeTabId === id) activate((state.tabs.filter(t => t.workspace === tab.workspace).at(-1) || state.tabs[Math.min(index, state.tabs.length - 1)]).id);
  publish(); return { closed: id };
}
async function command(name, p = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Command parameters must be an object');
  if (name === 'state:get') return snapshot(state.missionOpen || overlay);
  if (name === 'ui:focus-chrome') { win.webContents.focus(); return true; }
  if (name === 'ui:focus-page') { const wc = views.get(state.activeTabId)?.webContents; if (wc && !wc.isDestroyed() && !current()?.error) wc.focus(); return true; }
  if (name === 'tab:new') return createTab(p);
  if (name === 'tab:activate') return activate(p.id);
  if (name === 'tab:close') return closeTab(p.id);
  if (name === 'tab:restore') { const tab = closedTabs.shift(); return tab ? createTab(tab) : null; }
  if (name === 'tab:navigate') {
    const tab = requireTab(p.id), url = normalizeURL(p.url, state.settings.searchEngine); tab.url = url; tab.error = null; tab.blocked = 0;
    if (isRemote(tab)) { const existed = views.has(tab.id); const view = ensureView(tab); if (existed) view.webContents.loadURL(url).catch(() => {}); }
    else { destroyView(tab.id); tab.title = url.slice(8) === 'newtab' ? 'New tab' : url.slice(8); tab.canGoBack = false; tab.canGoForward = false; tab.isLoading = false; }
    if (tab.id === state.activeTabId) { overlayRequest++; overlay = false; if (isRemote(tab)) views.get(tab.id)?.webContents.focus(); }
    layout(); publish(); return tab;
  }
  if (['tab:back', 'tab:forward', 'tab:reload', 'tab:stop', 'tab:mute', 'tab:pin'].includes(name)) {
    const tab = requireTab(p.id), wc = views.get(tab.id)?.webContents;
    if (name === 'tab:back' && wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (name === 'tab:forward' && wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (name === 'tab:reload') { tab.error = null; if (!wc) ensureView(tab); else wc.reload(); }
    if (name === 'tab:stop') wc?.stop();
    if (name === 'tab:mute') { tab.muted = !tab.muted; wc?.setAudioMuted(tab.muted); }
    if (name === 'tab:pin') tab.pinned = !tab.pinned;
    layout(); publish(); return tab;
  }
  if (name === 'tab:move') { const tab = requireTab(p.id); if (!state.workspaces.some(w => w.id === p.workspace)) throw new Error('Workspace not found'); tab.workspace = p.workspace; if (tab.id === state.activeTabId) state.activeWorkspace = p.workspace; publish(); return tab; }
  if (name === 'tab:reorder') { if (!Array.isArray(p.ids)) throw new Error('ids must be an array'); const order = [...new Set(p.ids)]; state.tabs.sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : 9999) - (order.includes(b.id) ? order.indexOf(b.id) : 9999)); publish(); return true; }
  if (name === 'workspace:add') { const workspace = { id: randomUUID(), name: String(p.name || 'Untitled').trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#8c7ce8' }; state.workspaces.push(workspace); publish(); return workspace; }
  if (name === 'workspace:activate') { if (!state.workspaces.some(w => w.id === p.id)) throw new Error('Workspace not found'); const tab = state.tabs.find(t => t.workspace === p.id); return tab ? activate(tab.id) : createTab({ workspace: p.id }); }
  if (name === 'workspace:rename') { const w = state.workspaces.find(w => w.id === p.id); if (!w) throw new Error('Workspace not found'); w.name = String(p.name || 'Untitled').slice(0, 40); publish(); return w; }
  if (name === 'workspace:delete') { if (p.id === 'personal') throw new Error('The Personal workspace is permanent'); state.tabs.filter(t => t.workspace === p.id).forEach(t => { t.workspace = 'personal'; }); state.workspaces = state.workspaces.filter(w => w.id !== p.id); state.activeWorkspace = current().workspace; publish(); return true; }
  if (name === 'ui:overlay') { const generation = ++overlayRequest; if (p.open && isRemote(current())) await captureTab(current()); if (generation !== overlayRequest) return false; overlay = Boolean(p.open); layout(); if (overlay) win.webContents.focus(); else if (!state.missionOpen && isRemote(current()) && !current().error) views.get(state.activeTabId)?.webContents.focus(); publish(false); return true; }
  if (name === 'ui:mission') { await mission(p.open === undefined ? !state.missionOpen : p.open); return true; }
  if (name === 'bookmark:toggle') { const url = p.url || current().url; if (!/^https?:/.test(url)) return false; const found = state.bookmarks.findIndex(b => b.url === url); if (found >= 0) state.bookmarks.splice(found, 1); else state.bookmarks.push({ id: randomUUID(), url, title: String(p.title || current().title).slice(0, 200) }); publish(); return found < 0; }
  if (name === 'history:clear') { state.history = []; publish(); return true; }
  if (name === 'settings:update') {
    for (const key of ['sidebarCollapsed', 'autoTidy', 'restoreSession']) if (typeof p[key] === 'boolean') state.settings[key] = p[key];
    if (['system', 'light', 'dark'].includes(p.theme)) state.settings.theme = p.theme;
    if (['brave', 'duckduckgo', 'google'].includes(p.searchEngine)) state.settings.searchEngine = p.searchEngine;
    nativeTheme.themeSource = state.settings.theme; layout(); publish(); return state.settings;
  }
  if (name === 'shields:toggle') { state.shields.enabled = typeof p.enabled === 'boolean' ? p.enabled : !state.shields.enabled; for (const view of views.values()) view.webContents.reload(); publish(); return state.shields; }
  if (name === 'shields:refresh') { await shields.refresh(); return state.shields; }
  if (name === 'download:open' || name === 'download:reveal') { const entry = state.downloads.find(d => d.id === p.id); if (!entry?.path || entry.state !== 'completed') throw new Error('Download is not complete'); if (name === 'download:open') return shell.openPath(entry.path); shell.showItemInFolder(entry.path); return true; }
  if (name === 'clipboard:write') { clipboard.writeText(String(p.text).slice(0, 100000)); return true; }
  if (name === 'app:open-path') { const target = { token: app.getPath('userData'), source: app.isPackaged ? process.resourcesPath : root, mcp: automationRoot }[p.kind]; if (!target) throw new Error('Unknown path'); return shell.openPath(target); }
  if (name === 'page:find') { const wc = views.get(state.activeTabId)?.webContents; if (!wc) return false; if (!p.text) wc.stopFindInPage('clearSelection'); else wc.findInPage(String(p.text), { forward: !p.backwards, findNext: Boolean(p.next) }); return true; }
  if (name === 'page:zoom') {
    const wc = views.get(state.activeTabId)?.webContents;
    if (!wc) return 1;
    const factor = p.reset ? 1 : Math.max(0.25, Math.min(5, Math.round((wc.getZoomFactor() + Number(p.delta || 0)) * 100) / 100));
    wc.setZoomFactor(factor); return factor;
  }
  throw new Error('Unknown browser command: ' + name);
}
function record(agent, action, tabId) {
  const event = { id: randomUUID(), agentId: agent.id, agentName: agent.name, action, tabId, at: Date.now() };
  state.activity.unshift(event); state.activity.length = Math.min(state.activity.length, 150); automation?.publish(event); publish(false);
}
async function pageCommand(action, p, tab) {
  const wc = ensureView(tab)?.webContents; if (!wc) throw new Error('Navigate to a website before controlling the page');
  const evaluate = async source => { let timer; try { return await Promise.race([wc.executeJavaScript(source, true), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Page action exceeded 20 seconds')), 20000); timer.unref(); })]); } finally { clearTimeout(timer); } };
  const input = async operation => {
    const attached = wc.debugger.isAttached();
    if (!attached) wc.debugger.attach('1.3');
    try { return await operation((method, params) => wc.debugger.sendCommand(method, params)); }
    finally { if (!attached && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); }
  };
  if (action === 'page.evaluate') { if (typeof p.expression !== 'string' || p.expression.length > 100000) throw new Error('Provide an expression under 100 KB'); const result = await evaluate(p.expression); if (JSON.stringify(result)?.length > 1048576) throw new Error('Result exceeds 1 MiB; request less data'); return result; }
  if (action === 'page.snapshot') return evaluate(`(() => { const path = e => {if(e.id) return '#'+CSS.escape(e.id);let parts=[];for(let n=e;n&&n!==document.body;n=n.parentElement){let i=1;for(let s=n.previousElementSibling;s;s=s.previousElementSibling)if(s.tagName===n.tagName)i++;parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+i+')')}return 'body>'+parts.join('>')};return {title:document.title,url:location.href,text:document.body.innerText.slice(0,${Math.min(100000, Math.max(1000, Number(p.maxLength) || 16000))}),elements:[...document.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]')].filter(e=>e.getClientRects().length&&!e.hidden).slice(0,300).map(e=>({selector:path(e),role:e.getAttribute('role')||e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')||e.innerText||e.placeholder||e.title||'').slice(0,180),type:e.type,href:e.href}))}})()`);
  if (action === 'page.click' || action === 'page.type') {
    if (typeof p.selector !== 'string' || p.selector.length > 2000) throw new Error('Provide a CSS selector');
    const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(p.selector)});if(!e)throw Error('Element not found');e.scrollIntoView({block:'center',behavior:'instant'});e.focus();const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Element is not visible');return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    await input(async send => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      if (action === 'page.type') {
        if (typeof p.text !== 'string' || p.text.length > 100000) throw new Error('Provide text under 100 KB');
        if (p.clear !== false) { const modifiers = process.platform === 'darwin' ? 4 : 2; await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers, commands: ['selectAll'] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers }); }
        await send('Input.insertText', { text: p.text });
      }
    });
    await evaluate('true');
    return { ok: true };
  }
  if (action === 'page.key') {
    if (typeof p.key !== 'string' || p.key.length > 30) throw new Error('Invalid key');
    const modifiers = (Array.isArray(p.modifiers) ? p.modifiers : []).reduce((bits, key) => bits | ({ alt: 1, control: 2, meta: 4, shift: 8 }[key] || 0), 0);
    // Chromium exits HTML fullscreen through native Escape handling. CDP's
    // synthetic DOM key dispatch does not invoke that browser-level behavior.
    if (p.key === 'Escape' && !modifiers && fullscreenTabId === tab.id) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      return true;
    }
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32 };
    await input(async send => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: p.key === 'Space' ? ' ' : p.key, windowsVirtualKeyCode: codes[p.key] || (p.key.length === 1 ? p.key.toUpperCase().charCodeAt(0) : 0), modifiers, ...(p.key === 'Enter' ? { text: '\r' } : p.key.length === 1 && !modifiers ? { text: p.key } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: p.key, modifiers }); }); return true;
  }
  if (action === 'page.scroll') return evaluate(`window.scrollBy({top:${Math.max(-20000, Math.min(20000, Number(p.y) || 0))},left:${Math.max(-20000, Math.min(20000, Number(p.x) || 0))},behavior:'smooth'})`);
  if (action === 'page.screenshot') { const image = await wc.capturePage(undefined, { stayHidden: true }); return { mimeType: 'image/png', data: image.toPNG().toString('base64') }; }
  throw new Error('Unknown page action');
}
async function agentCommand(action, p, agent) {
  if (action === 'browser.state') return snapshot();
  if (action === 'tabs.list') return snapshot().tabs.map(({ thumbnail, ...t }) => t);
  if (action === 'events.list') return state.activity.slice(0, Math.min(150, Number(p.limit) || 50));
  if (action === 'tabs.create') { const tab = createTab(p, p.active !== false); record(agent, action, tab.id); return tab; }
  if (action === 'browser.mission') { await mission(p.open !== false); record(agent, action); return true; }
  const id = p.tabId || p.id;
  if (!id) throw new Error('An explicit tabId is required so agents do not interfere with the human’s active tab');
  const run = async () => {
    const tab = requireTab(id);
    if (action === 'tabs.claim') { const lease = leases.claim(id, agent.id, p.ttl); record(agent, action, id); return lease; }
    if (action === 'tabs.release') { leases.release(id, agent.id); record(agent, action, id); return true; }
    const mapping = { 'tabs.activate': 'tab:activate', 'tabs.close': 'tab:close', 'tabs.navigate': 'tab:navigate', 'tabs.reload': 'tab:reload', 'tabs.back': 'tab:back', 'tabs.forward': 'tab:forward', 'tabs.move': 'tab:move' };
    if (!mapping[action] && !['page.snapshot', 'page.screenshot', 'page.evaluate', 'page.click', 'page.type', 'page.key', 'page.scroll'].includes(action)) throw new Error('Unknown agent action: ' + action);
    const readOnly = ['page.snapshot', 'page.screenshot'].includes(action);
    if (!readOnly) leases.claim(id, agent.id);
    let result;
    if (action.startsWith('page.')) result = await pageCommand(action, p, tab);
    else result = await command(mapping[action], { ...p, id });
    record(agent, action, id); return result;
  };
  const pending = (queues.get(id) || Promise.resolve()).catch(() => {}).then(run); queues.set(id, pending);
  try { return await pending; } finally { if (queues.get(id) === pending) queues.delete(id); }
}
function buildMenu() {
  const openInternal = route => createTab({ url: 'aster://' + route });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Aster', submenu: [{ role: 'about' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openInternal('settings') }, { type: 'separator' }, { role: 'services' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() }, { label: 'New Private Tab', accelerator: 'CmdOrCtrl+Shift+N', click: () => createTab({ private: true }) }, { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => command('tab:restore') }, { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab() }, { type: 'separator' }, { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => views.get(state.activeTabId)?.webContents.print() }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => { win.webContents.focus(); ui('find'); } }] },
    { label: 'View', submenu: [{ label: 'Mission Control', accelerator: 'CmdOrCtrl+Shift+M', click: () => mission(!state.missionOpen) }, { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => { overlay = true; layout(); ui('palette'); } }, { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('settings:update', { sidebarCollapsed: !state.settings.sidebarCollapsed }) }, { type: 'separator' }, { role: 'togglefullscreen' }, { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => command('page:zoom', { reset: true }) }, { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => command('page:zoom', { delta: 0.1 }) }, { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => command('page:zoom', { delta: -0.1 }) }, { label: 'Page Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => views.get(state.activeTabId)?.webContents.openDevTools({ mode: 'detach' }) }] },
    { label: 'History', submenu: [{ label: 'History', click: () => openInternal('history') }, { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => command('tab:back') }, { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => command('tab:forward') }] },
    { label: 'Bookmarks', submenu: [{ label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => command('bookmark:toggle') }, { label: 'All Bookmarks', click: () => openInternal('bookmarks') }] },
    { role: 'windowMenu' }, { label: 'Help', submenu: [{ label: 'Connect an Agent', click: () => openInternal('agents') }, { label: 'Downloads', click: () => openInternal('downloads') }] }
  ]));
}
app.whenReady().then(async () => {
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(storePath())); } catch {}
  state = initialState(saved); nativeTheme.themeSource = state.settings.theme;
  protocol.handle('aster-ui', request => {
    const target = new URL(request.url); const name = target.pathname.replace(/^\//, '');
    if (target.hostname !== 'shell' || !['index.html', 'style.css', 'app.js'].includes(name)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(root, 'src/renderer', name)).href);
  });
  const { installShields } = require('./shields.cjs');
  shields = installShields(state, path.join(root, 'assets'), wcId => { state.shields.blocked++; const tab = state.tabs.find(t => t.id === wcTabs.get(wcId)); if (tab) tab.blocked++; publish(); }, wc => wcTabs.has(wc.id), app.getPath('userData'), () => publish(false));
  setupSession(session.fromPartition('persist:aster'));
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 1050, minHeight: 700, title: 'Aster', titleBarStyle: 'hidden', trafficLightPosition: { x: 20, y: 20 }, vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win.webContents.on('will-navigate', event => event.preventDefault()); win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let shellRecoveries = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    if (shuttingDown || win.isDestroyed()) return;
    overlayRequest++; overlay = true; state.missionOpen = false; layout();
    shellRecoveries = shellRecoveries.filter(at => Date.now() - at < 60000);
    if (shellRecoveries.length < 3) { shellRecoveries.push(Date.now()); win.loadURL('aster-ui://shell/index.html').then(() => { overlay = false; layout(); publish(false); }).catch(error => console.error('Browser interface recovery failed:', error.message)); }
    else dialog.showMessageBox(win, { type: 'error', title: 'Browser interface stopped', message: 'The browser interface stopped repeatedly. Restart Aster to recover your saved session.', detail: details.reason, buttons: ['Quit'] }).then(() => app.quit());
  });
  ipcMain.handle('aster:command', (event, name, p) => { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith('aster-ui://shell/')) throw new Error('Untrusted command sender'); return command(name, p); });
  wireShortcuts(win.webContents);
  automation = await startAutomation({ directory: app.getPath('userData'), command: agentCommand, connect: agent => { state.agents.push(agent); publish(false); }, disconnect: id => { state.agents = state.agents.filter(a => a.id !== id); leases.releaseAgent(id); publish(false); } });
  state.automation = { endpoint: automation.endpoint, tokenPath: automation.tokenPath, mcpPath: path.join(automationRoot, 'aster-mcp.cjs'), cliPath: path.join(automationRoot, 'aster.cjs') };
  win.on('resize', layout); win.on('enter-full-screen', layout); win.on('leave-full-screen', layout);
  win.on('close', () => { closingWindow = true; persist(); for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close(); views.clear(); });
  win.once('ready-to-show', () => { win.show(); activate(state.activeTabId); });
  buildMenu(); await win.loadURL('aster-ui://shell/index.html');
  if (process.env.ASTER_DISABLE_FILTER_UPDATES !== '1' && (!state.shields.lastUpdated || Date.now() - Date.parse(state.shields.lastUpdated) > 86400000)) shields.refresh().catch(error => console.error('Filter update deferred:', error.message));
  console.log('Aster ready. Local agent endpoint: ' + automation.endpoint);
}).catch(error => { console.error(error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (shuttingDown) return; shuttingDown = true; clearTimeout(saveTimer); clearTimeout(stateTimer); persist(); automation?.close(); });
