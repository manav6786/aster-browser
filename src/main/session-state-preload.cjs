'use strict';
const { ipcRenderer } = require('electron');

// This sandbox preload runs separately in every HTTP(S) frame. No contextBridge,
// page message listener, Node capability, or page-visible method is installed.
if (/^https?:/.test(location.href)) {
  const READY = 'aster:session:ready', CAPTURE = 'aster:session:capture', FINAL = 'aster:session:final', REQUEST = 'aster:session:request';
  let initial; try { initial = ipcRenderer.sendSync(READY, { url: location.href }); } catch {}
  if (initial?.enabled) {
    const MAX_VALUE = 16384, MAX_FIELDS = 80, MAX_CONTAINERS = 32;
    const sensitive = /password|passwd|passcode|passphrase|secret|credential|(?:access|refresh|auth|bearer|api|session)token|apikey|privatekey|onetime|verificationcode|securitycode|authcode|creditcard|debitcard|cardnumber|cardholder|cardexpiry|cardexpiration|socialsecurity|accountnumber|bankaccount|routingnumber|\b(?:pwd|otp|totp|pin|token|card|cc|cvv|cvc|ccv|ssn|iban)\b/i;
    const touched = new Set(), rejected = new WeakSet(), editableDefaults = new WeakMap(), scrollLast = new Map(), scrollBlocked = new Set();
    let savedURL = location.href, pendingFields = new Map((initial.document?.fields || []).map(field => [field.selector, field])), savedScroll = initial.document?.scroll;
    let timer, retry, observer, ended = false, scrollTouched = false, expires = Date.now() + 15000;
    function short(value, max = 256) { return typeof value === 'string' && value.length <= max && !value.includes('\0'); }
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function selectorFor(node) {
      if (!node?.tagName) return null;
      const parts = [];
      for (let n = node; n?.nodeType === 1 && parts.length < 12; n = n.parentElement) {
        if (n.id && short(n.id)) { const selector = '#' + CSS.escape(n.id); if (document.querySelectorAll(selector).length === 1) { parts.unshift(selector); break; } }
        let index = 1; for (let previous = n.previousElementSibling; previous; previous = previous.previousElementSibling) if (previous.tagName === n.tagName) index++;
        parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      }
      const selector = parts.join('>'); return selector.length <= 1024 && document.querySelectorAll(selector).length === 1 ? selector : null;
    }
    function metadata(node) {
      const rawTag = node.tagName?.toLowerCase(), tag = node.isContentEditable ? 'editable' : rawTag;
      if (!['input', 'textarea', 'select', 'editable'].includes(tag)) return null;
      const type = tag === 'input' ? String(node.type || 'text').toLowerCase() : tag;
      if (tag === 'input' && !['text', 'search', 'email', 'url', 'tel', 'number', 'checkbox', 'radio'].includes(type)) return null;
      // Plain-text contenteditables are safe to replay; rich editor markup is
      // deliberately left to the site's own storage and Chromium pageState.
      if (tag === 'editable' && node.children.length && node.getAttribute('contenteditable') !== 'plaintext-only') return null;
      const field = { tag, type, id: node.id || '', name: node.getAttribute('name') || '',
        label: node.getAttribute('aria-label') || '', autocomplete: node.getAttribute('autocomplete') || node.form?.getAttribute('autocomplete') || '', form: node.form?.id || node.form?.getAttribute('name') || '' };
      if (Object.values(field).some(v => !short(v))) return null;
      const labels = [field.id, field.name, field.label, field.autocomplete].join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z0-9]+/gi, ' ');
      if (sensitive.test(labels) || sensitive.test(labels.replace(/[^a-z0-9]/gi, '')) || field.autocomplete.toLowerCase().split(/\s+/).some(v => v === 'off' || v === 'one-time-code' || v.startsWith('cc-') || v.endsWith('password'))) return null;
      const selector = selectorFor(node); return selector ? { selector, ...field } : null;
    }
    function read(node, field) {
      if (field.tag === 'input' && ['checkbox', 'radio'].includes(field.type)) return { value: node.checked, base: node.defaultChecked };
      if (field.tag === 'select') {
        const defaults = [...node.options].filter(option => option.defaultSelected).map(option => option.value);
        return { value: [...node.selectedOptions].map(option => option.value), base: defaults.length || node.multiple ? defaults : node.options.length ? [node.options[0].value] : [] };
      }
      if (field.tag === 'editable') { if (!editableDefaults.has(node)) editableDefaults.set(node, node.textContent || ''); return { value: node.textContent || '', base: editableDefaults.get(node) }; }
      return { value: node.value, base: node.defaultValue };
    }
    function acceptable(values) { return [values.value, values.base].every(value => typeof value === 'boolean' || typeof value === 'string' && short(value, MAX_VALUE) || Array.isArray(value) && value.length <= 64 && value.every(v => short(v, 1024))); }
    function find(selector) { try { const matches = document.querySelectorAll(selector); return matches.length === 1 ? matches[0] : null; } catch { return null; } }
    function position(node) { return node === window ? { x: scrollX, y: scrollY } : { x: node.scrollLeft, y: node.scrollTop }; }
    function restorePosition(node, key, target) {
      if (!node || !target || scrollTouched || scrollBlocked.has(key)) return;
      const current = position(node), previous = scrollLast.get(key), matches = p => p && Math.abs(p.x - current.x) < 2 && Math.abs(p.y - current.y) < 2;
      if (matches(target)) return;
      if ((Math.abs(current.x) > 1 || current.y > 1) && !matches(previous)) { scrollBlocked.add(key); return; }
      node.scrollTo({ left: target.x, top: target.y, behavior: 'instant' }); scrollLast.set(key, position(node));
    }
    function restore() {
      if (ended || savedURL !== location.href || Date.now() > expires) return;
      for (const [selector, saved] of pendingFields) {
        if (touched.has(selector)) { pendingFields.delete(selector); continue; }
        const node = find(selector); if (!node || rejected.has(node)) continue;
        if (node.disabled || node.readOnly || node.closest?.('[inert]')) continue;
        const field = metadata(node);
        if (!field || !['tag', 'type', 'id', 'name', 'form'].every(key => field[key] === saved[key])) { rejected.add(node); pendingFields.delete(selector); continue; }
        const values = read(node, field);
        if (!equal(values.base, saved.base) || !equal(values.value, values.base) && !equal(values.value, saved.value)) { rejected.add(node); pendingFields.delete(selector); continue; }
        if (equal(values.value, saved.value)) continue;
        if (field.tag === 'select') {
          if (saved.value.some(value => ![...node.options].some(option => option.value === value))) continue;
          for (const option of node.options) option.selected = saved.value.includes(option.value);
        }
        else if (field.tag === 'input' && ['checkbox', 'radio'].includes(field.type)) node.checked = saved.value;
        else if (field.tag === 'editable') node.textContent = saved.value;
        else node.value = saved.value;
        // Property assignment only: no focus, submit, input, or change event.
      }
      restorePosition(window, 'page', savedScroll?.page);
      for (const item of savedScroll?.elements || []) restorePosition(find(item.selector), item.selector, item);
    }
    function snapshot() {
      restore(); const fields = [], used = new Set();
      const controls = [...touched].map(find).filter(Boolean);
      const remaining = document.querySelectorAll('input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]');
      for (let i = 0; i < remaining.length && i < 2000; i++) if (!controls.includes(remaining[i])) controls.push(remaining[i]);
      for (const node of controls) {
        if (node.disabled || node.readOnly || node.closest?.('[inert]')) continue;
        const field = metadata(node); if (!field) continue;
        const values = read(node, field); if (equal(values.value, values.base) || !acceptable(values)) continue;
        fields.push({ ...field, ...values }); used.add(field.selector); if (fields.length >= MAX_FIELDS) break;
      }
      // A quick quit during hydration must not erase drafts whose fields have
      // not appeared yet. Do not carry them across another SPA URL or user edit.
      if (savedURL === location.href && Date.now() <= expires) for (const [selector, field] of pendingFields) {
        if (fields.length >= MAX_FIELDS) break;
        if (!used.has(selector) && !touched.has(selector)) fields.push(field);
      }
      const elements = [];
      const identified = document.querySelectorAll('[id]');
      for (let i = 0; i < identified.length && i < 2000; i++) {
        const node = identified[i];
        if (elements.length >= MAX_CONTAINERS) break;
        if (node === document.scrollingElement || !node.scrollLeft && !node.scrollTop) continue;
        if (!/auto|scroll|overlay/.test(getComputedStyle(node).overflowX + getComputedStyle(node).overflowY)) continue;
        const selector = selectorFor(node); if (selector) elements.push({ selector, ...position(node) });
      }
      const page = position(window), activeRestore = savedURL === location.href && !scrollTouched && Date.now() <= expires;
      if (activeRestore) for (const item of savedScroll?.elements || []) {
        if (elements.length >= MAX_CONTAINERS) break;
        if (scrollBlocked.has(item.selector)) continue;
        const index = elements.findIndex(value => value.selector === item.selector);
        if (!find(item.selector) || scrollLast.has(item.selector)) { if (index >= 0) elements[index] = item; else elements.push(item); }
      }
      return { url: location.href, fields, scroll: { page: activeRestore && savedScroll?.page && !scrollBlocked.has('page') && scrollLast.has('page') ? savedScroll.page : page, elements } };
    }
    function capture(requestId, sync = false) { if (ended || !/^https?:/.test(location.href)) return; clearTimeout(timer); timer = null; try { const data = { ...snapshot(), ...(requestId ? { requestId } : {}) }; if (sync) ipcRenderer.sendSync(FINAL, data); else ipcRenderer.send(CAPTURE, data); } catch {} }
    function schedule() { if (!timer && !ended) timer = setTimeout(() => capture(), 100); }
    function edited(event) {
      const node = event.target?.closest?.('input,textarea,select,[contenteditable]'), selector = selectorFor(node); if (selector) { touched.add(selector); pendingFields.delete(selector); if (touched.size > 2000) touched.delete(touched.values().next().value); } schedule();
    }
    function beforeEdit(event) { const node = event.target?.closest?.('[contenteditable]'), field = node && metadata(node); if (field?.tag === 'editable') read(node, field); }
    function interact() { scrollTouched = true; }
    const requested = (_event, payload) => { if (payload?.url === location.href && typeof payload.requestId === 'string') capture(payload.requestId); };
    ipcRenderer.on(REQUEST, requested);
    addEventListener('beforeinput', beforeEdit, true); addEventListener('input', edited, true); addEventListener('change', edited, true); addEventListener('scroll', schedule, { passive: true, capture: true });
    addEventListener('wheel', interact, { passive: true, capture: true }); addEventListener('touchmove', interact, { passive: true, capture: true }); addEventListener('pointerdown', interact, { passive: true, capture: true });
    const key = event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interact(); };
    addEventListener('keydown', key, true);
    function start() {
      restore();
      // Establish editable baselines before an input event changes their text.
      for (const node of document.querySelectorAll('[contenteditable]')) { const field = metadata(node); if (field) read(node, field); }
      if (!pendingFields.size && !savedScroll?.page?.x && !savedScroll?.page?.y && !savedScroll?.elements?.length) return;
      observer = new MutationObserver(() => { restore(); schedule(); });
      if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'name', 'value', 'autocomplete', 'type', 'style', 'class'] });
      let attempts = 0;
      retry = setInterval(() => { restore(); if (++attempts >= 60 || Date.now() > expires || savedURL !== location.href) { clearInterval(retry); retry = null; observer?.disconnect(); } }, 250);
    }
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true }); else start();
    addEventListener('load', restore, { once: true });
    addEventListener('pagehide', () => capture(undefined, true));
    addEventListener('unload', () => { ended = true; clearTimeout(timer); clearInterval(retry); observer?.disconnect(); ipcRenderer.removeListener(REQUEST, requested); }, { once: true });
  }
}
