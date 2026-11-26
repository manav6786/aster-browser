'use strict';
const { ipcRenderer } = require('electron');

// No page-facing bridge. A remote page cannot manufacture trusted wheel input
// or invoke this preload's IPC. Page scrolling remains Chromium-owned.
const browserShell = location.href === 'aster-ui://shell/index.html';
if (window === window.top && (/^https?:/.test(location.href) || browserShell)) {
  const READY = 'aster:gestures:ready', WHEEL = 'aster:gestures:wheel', STATE = 'aster:gestures:state';
  let navigation = { enabled: false, canGoBack: false, canGoForward: false };
  let ended=false;
  function receive(value) { if (value?.url === location.href || value?.enabled === false) navigation = value || { enabled: false }; }
  const stateListener = (_event, value) => receive(value);
  ipcRenderer.on(STATE, stateListener);
  function ready() { ipcRenderer.invoke(READY, location.href).then(receive).catch(() => {}); }
  ready();
  addEventListener('DOMContentLoaded', ready, { once: true });
  addEventListener('popstate', ready);
  function consumesHorizontalScroll(nodes, dx) {
    if (window.visualViewport?.scale > 1.01) return true;
    const elements = nodes.filter(node => node?.nodeType === 1);
    const root = document.scrollingElement;
    if (root && !elements.includes(root)) elements.push(root);
    for (const element of elements) {
      if (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return true;
      const range = element.scrollWidth - element.clientWidth;
      const style = getComputedStyle(element);
      if ((element === root || element === document.body || /auto|scroll|hidden|overlay/.test(style.overflowX)) && /^(none|contain)$/.test(style.overscrollBehaviorX)) return true;
      if (range <= 1 || (element !== root && !/^(auto|scroll|overlay)$/.test(style.overflowX))) continue;
      // Chromium uses negative scrollLeft for RTL: physical left=-range,
      // physical right=0. Preserve horizontal carousels in either direction.
      const min = style.direction === 'rtl' ? -range : 0, max = style.direction === 'rtl' ? 0 : range;
      if (dx < 0 && element.scrollLeft > min + 1) return true;
      if (dx > 0 && element.scrollLeft < max - 1) return true;
    }
    return false;
  }
  function wheel(event) {
    if (!event.isTrusted || !navigation.enabled || (!navigation.canGoBack && !navigation.canGoForward)) return;
    if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return;
    const nodes = event.composedPath();
    // The shell shares a WebContents across internal tabs. Its address field,
    // sidebar and browser controls are not website scroll targets.
    if (browserShell && !nodes.includes(document.getElementById('content'))) return;
    const url = location.href, contextId = navigation.contextId;
    const blocked = event.deltaMode !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || consumesHorizontalScroll(nodes, event.deltaX);
    // Native event dispatch can checkpoint microtasks between listeners. A
    // later task observes bubble-phase cancellation after the whole dispatch.
    setTimeout(() => {
      if (ended || location.href !== url) return;
      ipcRenderer.send(WHEEL, { url, contextId, eventTime:typeof performance!=='undefined'&&Number.isFinite(performance.timeOrigin)&&Number.isFinite(event.timeStamp)?performance.timeOrigin+event.timeStamp:undefined, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
        blocked: Boolean(blocked || event.defaultPrevented), control: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey });
    },0);
  }
  addEventListener('wheel', wheel, { passive: true, capture: true });
  addEventListener('unload', () => { ended=true;ipcRenderer.removeListener(STATE, stateListener); removeEventListener('wheel', wheel, true); removeEventListener('popstate', ready); }, { once: true });
}
