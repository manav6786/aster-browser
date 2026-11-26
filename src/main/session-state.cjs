'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CHANNELS = Object.freeze({ ready: 'aster:session:ready', capture: 'aster:session:capture', final: 'aster:session:final', request: 'aster:session:request' });
const LIMITS = Object.freeze({ documents: 24, fields: 80, containers: 32, value: 16384, documentBytes: 65536, tabBytes: 262144 });
const sensitive = /password|passwd|passcode|passphrase|secret|credential|(?:access|refresh|auth|bearer|api|session)token|apikey|privatekey|onetime|verificationcode|securitycode|authcode|creditcard|debitcard|cardnumber|cardholder|cardexpiry|cardexpiration|socialsecurity|accountnumber|bankaccount|routingnumber|\b(?:pwd|otp|totp|pin|token|card|cc|cvv|cvc|ccv|ssn|iban)\b/i;
function secretField(field) {
  const labels = [field.id, field.name, field.label, field.autocomplete].filter(v => typeof v === 'string').join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z0-9]+/gi, ' ');
  const autocomplete = String(field.autocomplete || '').toLowerCase().split(/\s+/);
  return sensitive.test(labels) || sensitive.test(labels.replace(/[^a-z0-9]/gi, '')) || autocomplete.some(v => v === 'off' || v === 'one-time-code' || v.startsWith('cc-') || v.endsWith('password'));
}
function httpURL(value) { try { return typeof value === 'string' && value.length <= 8192 && /^https?:$/.test(new URL(value).protocol); } catch { return false; } }
function string(value, max = 256) { return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : null; }
function point(value) { return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) <= 10000000 && value.y >= 0 && value.y <= 10000000 ? { x: value.x, y: value.y } : null; }
function cleanField(value) {
  if (!value || typeof value !== 'object' || secretField(value)) return null;
  const selector = string(value.selector, 1024), tag = String(value.tag || '').toLowerCase(), type = String(value.type || '').toLowerCase();
  if (!selector || !['input', 'textarea', 'select', 'editable'].includes(tag)) return null;
  if (tag === 'input' && !['text', 'search', 'email', 'url', 'tel', 'number', 'checkbox', 'radio'].includes(type)) return null;
  const output = { selector, tag, type };
  for (const key of ['id', 'name', 'label', 'autocomplete', 'form']) { const v = string(value[key] ?? ''); if (v === null) return null; output[key] = v; }
  if (tag === 'input' && ['checkbox', 'radio'].includes(type)) {
    if (typeof value.value !== 'boolean' || typeof value.base !== 'boolean') return null;
  } else if (tag === 'select') {
    if (![value.value, value.base].every(v => Array.isArray(v) && v.length <= 64 && v.every(s => string(s, 1024) !== null))) return null;
  } else if (string(value.value, LIMITS.value) === null || string(value.base, LIMITS.value) === null) return null;
  output.value = Array.isArray(value.value) ? [...value.value] : value.value;
  output.base = Array.isArray(value.base) ? [...value.base] : value.base;
  return output;
}
function cleanDocument(value) {
  if (!value || !httpURL(value.url) || !httpURL(value.rootURL) || !/^root(?:\/(?:i:\d+|n:[^/]{1,512}))*$/.test(value.framePath || '') || value.framePath.length > 2048) return null;
  const output = { url: value.url, rootURL: value.rootURL, framePath: value.framePath, fields: [], scroll: { page: point(value.scroll?.page) || { x: 0, y: 0 }, elements: [] }, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now() };
  const seen = new Set(); let bytes = Buffer.byteLength(JSON.stringify(output));
  for (const raw of Array.isArray(value.fields) ? value.fields.slice(0, LIMITS.fields) : []) {
    const field = cleanField(raw); if (!field || seen.has(field.selector)) continue;
    const size = Buffer.byteLength(JSON.stringify(field)); if (bytes + size > LIMITS.documentBytes) continue;
    seen.add(field.selector); output.fields.push(field); bytes += size;
  }
  for (const raw of Array.isArray(value.scroll?.elements) ? value.scroll.elements.slice(0, LIMITS.containers) : []) {
    const selector = string(raw?.selector, 1024), p = point(raw); if (selector && p && bytes + selector.length + 100 <= LIMITS.documentBytes) { output.scroll.elements.push({ selector, ...p }); bytes += selector.length + 100; }
  }
  return output;
}
function cleanDocuments(values) {
  const result = []; let bytes = 0;
  for (const raw of (Array.isArray(values) ? values.slice(0, LIMITS.documents * 2) : []).sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0))) {
    const item = cleanDocument(raw); if (!item) continue;
    const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > LIMITS.tabBytes || result.length >= LIMITS.documents) continue;
    if (result.some(v => v.url === item.url && v.rootURL === item.rootURL && v.framePath === item.framePath)) continue;
    result.push(item); bytes += size;
  }
  return result;
}
// Frame IDs change on restart. A unique frame name survives sibling insertion;
// otherwise use its position in the browser-owned parent frame tree.
function identity(wc, frame, url) {
  try {
    const top = wc.mainFrame;
    if (!frame || frame.isDestroyed() || frame.detached || wc.isDestroyed() || !top.framesInSubtree.includes(frame) || frame.url !== url || !httpURL(url) || !httpURL(top.url)) return null;
    const parts = []; let node = frame;
    while (node !== top) {
      const parent = node.parent, siblings = parent?.frames; if (!siblings || parts.length >= 24) return null;
      const index = siblings.indexOf(node); if (index < 0) return null;
      const name = typeof node.name === 'string' && node.name.length <= 128 ? node.name : '';
      parts.unshift(name && siblings.filter(f => f.name === name).length === 1 ? 'n:' + encodeURIComponent(name) : 'i:' + index); node = parent;
    }
    return { url, rootURL: top.url, framePath: 'root' + (parts.length ? '/' + parts.join('/') : '') };
  } catch { return null; }
}
function createSessionState({ ipcMain, onChange = () => {} }) {
  const contents = new Map(), sessions = new WeakMap(), sessionRefs = new Set(), pending = new Map(); let disposed = false;
  function valid(event, url) {
    const record = contents.get(event.sender); if (disposed || !record || record.tab.private) return null;
    const id = identity(event.sender, event.senderFrame, url); return id ? { ...id, record } : null;
  }
  function initial(event, payload) {
    const match = valid(event, payload?.url); if (!match) return { enabled: false };
    const document = match.record.tab.documents.find(d => d.url === match.url && d.rootURL === match.rootURL && d.framePath === match.framePath);
    return { enabled: true, url: match.url, document: document || null };
  }
  const ready = (event, payload) => { event.returnValue = initial(event, payload); };
  function capture(event, payload) {
    const match = valid(event, payload?.url); if (!match) return false;
    const document = cleanDocument({ ...payload, ...match, updatedAt: Date.now() }); if (!document) return false;
    const tab = match.record.tab, previous = tab.documents;
    tab.documents = cleanDocuments([document, ...previous.filter(d => d.url !== document.url || d.rootURL !== document.rootURL || d.framePath !== document.framePath)]);
    try { onChange(tab); } catch {}
    const request = pending.get(payload.requestId);
    if (request?.frames.get(event.senderFrame) === event.sender) { request.frames.delete(event.senderFrame); request.captured++; if (!request.frames.size) request.finish(); }
    return true;
  }
  const final = (event, payload) => { event.returnValue = capture(event, payload); };
  ipcMain.on(CHANNELS.ready, ready); ipcMain.on(CHANNELS.capture, capture); ipcMain.on(CHANNELS.final, final);
  function attachSession(ses) {
    if (disposed || sessions.has(ses)) return;
    const id = ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'session-state-preload.cjs') }); sessions.set(ses, id);
    for (const ref of sessionRefs) if (!ref.session.deref()) sessionRefs.delete(ref);
    sessionRefs.add({ session: new WeakRef(ses), id });
  }
  function attachWebContents(wc, tab) {
    if (disposed || !wc || wc.isDestroyed() || contents.has(wc)) return;
    if (tab.private) { delete tab.documents; return; }
    tab.documents = cleanDocuments(tab.documents);
    const destroyed = () => {
      wc.removeListener('destroyed', destroyed); contents.delete(wc);
      for (const request of pending.values()) { for (const [frame, owner] of request.frames) if (owner === wc) request.frames.delete(frame); if (!request.frames.size) request.finish(); }
    };
    contents.set(wc, { tab, destroyed }); wc.once('destroyed', destroyed);
  }
  async function flush({ timeoutMs = 1000, tabId } = {}) {
    if (disposed) return { requested: 0, captured: 0, timedOut: 0 };
    const frames = new Map();
    for (const [wc, record] of contents) { if (record.tab.private || wc.isDestroyed() || (tabId !== undefined && record.tab.id !== tabId)) continue; try { for (const frame of wc.mainFrame.framesInSubtree) if (identity(wc, frame, frame.url)) frames.set(frame, wc); } catch {} }
    if (!frames.size) return { requested: 0, captured: 0, timedOut: 0 };
    const id = randomUUID(), requested = frames.size;
    return new Promise(resolve => {
      let timer;
      const request = { frames, captured: 0, finish() { if (!pending.has(id)) return; pending.delete(id); clearTimeout(timer); resolve({ requested, captured: request.captured, timedOut: frames.size }); } };
      pending.set(id, request);
      timer = setTimeout(request.finish, Math.max(0, Math.min(5000, Number.isFinite(timeoutMs) ? timeoutMs : 1000)));
      for (const frame of frames.keys()) { try { frame.send(CHANNELS.request, { requestId: id, url: frame.url }); } catch { /* Keep cached state and finish at the global deadline. */ } }
    });
  }
  return { attachSession, attachWebContents, flush, dispose() {
    if (disposed) return; disposed = true;
    ipcMain.removeListener(CHANNELS.ready, ready); ipcMain.removeListener(CHANNELS.capture, capture); ipcMain.removeListener(CHANNELS.final, final);
    for (const request of pending.values()) request.finish();
    for (const [wc, record] of contents) wc.removeListener('destroyed', record.destroyed); contents.clear();
    for (const { session, id } of sessionRefs) { try { session.deref()?.unregisterPreloadScript(id); } catch {} } sessionRefs.clear();
  } };
}
module.exports = { createSessionState, CHANNELS, LIMITS, cleanDocuments, cleanField, identity };
