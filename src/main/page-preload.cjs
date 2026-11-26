'use strict';
const { ipcRenderer, webFrame } = require('electron');

// This preload has no page-facing bridge. Code from remote pages cannot invoke
// its IPC methods or access Node. Scriptlets execute in the page's main world.
if (window === window.top && /^https?:/.test(location.href)) {
  const url = location.href;
  let initial;
  try { initial = ipcRenderer.sendSync('aster:shields:document-start', url); } catch {}
  if (initial?.active) {
    if (initial.styles) webFrame.insertCSS(initial.styles, { cssOrigin: 'user' });
    if (initial.scripts?.length) {
      // No eval or script DOM node: webFrame executes synchronously in this
      // exact document, before its first inline script, and bypasses page CSP.
      // Share Ghostery's safeSelf cache without leaking helpers onto window.
      const code = '(()=>{' + initial.scripts.map(script => 'try{\n' + script + '\n}catch{}').join('\n') + '\n})()';
      webFrame.executeJavaScript(code).catch(() => {});
    }
    const seen = { classes: new Set(), ids: new Set(), hrefs: new Set() };
    const roots = new Set();
    const ignored = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'BR']);
    let timer, observer;
    function scan() {
      clearTimeout(timer); timer = null;
      const currentURL = location.href;
      if (!/^https?:/.test(currentURL) || !document.documentElement) return;
      const update = { classes: [], ids: [], hrefs: [] };
      const add = (kind, value) => {
        if (!value || value.length > 8192 || seen[kind].has(value) || update[kind].length >= 10000) return;
        seen[kind].add(value); update[kind].push(value);
      };
      const elements = new Set();
      for (const root of roots) {
        if (!root.isConnected || root.nodeType !== 1) continue;
        elements.add(root);
        for (const element of root.querySelectorAll('[class],[id],[href]')) elements.add(element);
      }
      roots.clear();
      for (const element of elements) {
        if (ignored.has(element.tagName)) continue;
        add('ids', element.id); add('hrefs', element.getAttribute('href'));
        for (const value of element.classList) add('classes', value);
      }
      if (!Object.values(update).some(values => values.length)) return;
      ipcRenderer.invoke('@ghostery/adblocker/inject-cosmetic-filters', currentURL, update).then(styles => {
        if (styles && location.href === currentURL) webFrame.insertCSS(styles, { cssOrigin: 'user' });
      }).catch(() => {});
    }
    function start() {
      roots.add(document.documentElement); scan();
      ipcRenderer.invoke('@ghostery/adblocker/is-mutation-observer-enabled').then(enabled => {
        if (!enabled || !/^https?:/.test(location.href)) return;
        observer = new MutationObserver(records => {
          for (const record of records) {
            if (record.type === 'attributes') roots.add(record.target);
            else for (const node of record.addedNodes) if (node.nodeType === 1) roots.add(node);
          }
          if (roots.size > 512) scan();
          else if (roots.size && !timer) timer = setTimeout(scan, 25);
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'id', 'href'], childList: true, subtree: true });
        // Include nodes inserted while the enablement IPC was in flight.
        roots.add(document.documentElement); scan();
      }).catch(() => {});
    }
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    addEventListener('unload', () => { clearTimeout(timer); observer?.disconnect(); roots.clear(); }, { once: true });
  }
}
