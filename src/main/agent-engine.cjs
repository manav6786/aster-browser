'use strict';
const { randomBytes } = require('node:crypto');

// These functions run in an isolated Chromium world. No Node or Aster bridge is
// installed in a website. DOM handles remain private to the authenticated host.
function queryElements(input) {
  const parts = String(input.selector || '').split(/\s*>>>\s*/);
  let roots = [document], matches = [];
  for (let i = 0; i < parts.length; i++) {
    matches = roots.flatMap(root => [...root.querySelectorAll(parts[i])]);
    if (i < parts.length - 1) roots = matches.map(node => node.shadowRoot).filter(Boolean);
  }
  if (Number.isInteger(input.nth)) return matches[input.nth] ? [matches[input.nth]] : [];
  return matches;
}

function describeElement(input) {
  const node = this;
  if (!node?.isConnected) return { status: 'detached' };
  if (input.scroll) node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = node.getBoundingClientRect(), css = getComputedStyle(node);
  const visible = r.width > 0 && r.height > 0 && css.visibility !== 'hidden' && css.visibility !== 'collapse' && css.display !== 'none';
  const info = { visible, tag: node.tagName?.toLowerCase(), type: node.type, checked: node.checked, value: node.value,
    text: (node.innerText || node.textContent || '').slice(0, 1000), viewport: [innerWidth, innerHeight],
    point: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  if (!visible) return { ...info, status: 'hidden' };
  if (input.actionable && (node.disabled || node.matches(':disabled') || node.closest('[inert],[aria-disabled="true"]'))) return { ...info, status: 'disabled' };
  if (input.editable && !node.isContentEditable && !['INPUT', 'TEXTAREA'].includes(node.tagName)) return { ...info, status: 'not-editable' };
  if (input.editable && (node.readOnly || ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(node.type))) return { ...info, status: 'not-editable' };
  if (input.actionable) {
    let root = node.getRootNode(), hit = root.elementFromPoint?.(info.point.x, info.point.y) || document.elementFromPoint(info.point.x, info.point.y);
    while (hit?.shadowRoot) { const deeper = hit.shadowRoot.elementFromPoint(info.point.x, info.point.y); if (!deeper || deeper === hit) break; hit = deeper; }
    let inside = hit && (hit === node || node.contains(hit));
    for (let n = node; !inside && n?.getRootNode?.().host; n = n.getRootNode().host) inside = hit === n.getRootNode().host;
    if (!inside) return { ...info, status: 'covered' };
    for (let n = node; n; n = n.parentElement) {
      if (n.getAnimations?.().some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity &&
        a.effect?.getKeyframes().some(k => ['transform','left','top','width','height'].some(p => p in k)))) return { ...info, status: 'animating' };
    }
  }
  if (input.focus) node.focus({ preventScroll: true });
  return { ...info, status: 'ready' };
}

function snapshotDocument(options) {
  const selector = node => {
    const root = node.getRootNode();
    const within = e => {
      if (e.id && root.querySelectorAll('#' + CSS.escape(e.id)).length === 1) return '#' + CSS.escape(e.id);
      const parts = [];
      for (let n = e; n?.nodeType === 1 && n !== document.body; n = n.parentElement) {
        let index = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) index++;
        parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      }
      return (root === document ? 'body>' : '') + parts.join('>');
    };
    return root.host ? selector(root.host) + ' >>> ' + within(node) : within(node);
  };
  const roots = [document], elements = [];
  for (let i = 0; i < roots.length && i < 100 && elements.length < options.maxElements; i++) {
    const root = roots[i];
    for (const e of root.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]')) {
      if (!e.getClientRects().length || e.hidden || getComputedStyle(e).visibility === 'hidden') continue;
      elements.push({ selector: selector(e), role: e.getAttribute('role') || e.tagName.toLowerCase(),
        name: (e.getAttribute('aria-label') || e.innerText || e.placeholder || e.title || '').slice(0, 180), type: e.type, href: e.href });
      if (elements.length >= options.maxElements) break;
    }
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
  }
  return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, options.maxLength), elements };
}

const roles = new Set(['button','link','textbox','searchbox','combobox','checkbox','radio','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','slider','spinbutton','treeitem']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const limits = (value, fallback, max) => Math.max(0, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
const signed = value => Math.max(-20000, Math.min(20000, Number(value) || 0));
const js = value => JSON.stringify(value);
const querySource = queryElements.toString();
const describeSource = describeElement.toString();
function protocolValue(result) {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page JavaScript failed');
  return result.result?.value;
}

function createAgentEngine({ ensureView, isHtmlFullscreen = () => false, captureFocus = () => null, restoreFocus = () => {} }) {
  const states = new Map();
  function stateFor(wc) {
    if (states.has(wc.id)) return states.get(wc.id);
    const state = { wc, refs: new Map(), reverseRefs: new Map(), nonce: randomBytes(4).toString('hex'), serial: 0, session: null };
    const invalidate = () => { state.refs.clear(); state.reverseRefs.clear(); if (state.session) { state.session.frames = null; state.session.contexts.clear(); } };
    wc.on('did-frame-navigate', invalidate); wc.on('render-process-gone', invalidate);
    wc.once('destroyed', () => { clearTimeout(state.session?.idle); states.delete(wc.id); });
    states.set(wc.id, state); return state;
  }
  function check(ctx) { if (ctx.aborted || Date.now() > ctx.deadline) throw new Error('Agent action timed out; inspect the page before retrying a mutation'); }
  async function bounded(ctx, promise) {
    check(ctx); let timer;
    try { return await Promise.race([promise, new Promise((_r, reject) => { timer = setTimeout(() => { ctx.aborted = true; reject(new Error('Agent action timed out; inspect the page before retrying a mutation')); }, Math.max(1, ctx.deadline - Date.now())); timer.unref(); })]); }
    finally { clearTimeout(timer); }
  }
  async function attach(state, ctx) {
    check(ctx);
    const wc = state.wc;
    if (state.session && wc.debugger.isAttached()) { clearTimeout(state.session.idle); return state.session; }
    const owned = !wc.debugger.isAttached(); if (owned) wc.debugger.attach('1.3');
    const session = { owned, users: 0, inputUsers: 0, emulated: false, idle: null, frames: null, contexts: new Map(), defaultContexts: new Map(), children: new Map(), setups: new Set() };
    const send = (method, params = {}, sessionId) => { check(ctx); return wc.debugger.sendCommand(method, params, sessionId || undefined); };
    session.onMessage = (_event, method, params, sessionId) => {
      if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault && params.context.auxData.frameId) session.defaultContexts.set(params.context.auxData.frameId, { id: params.context.id, sessionId: sessionId || '' });
      if (method === 'Runtime.executionContextDestroyed') for (const [id, context] of session.defaultContexts) if (context.id === params.executionContextId && context.sessionId === (sessionId || '')) session.defaultContexts.delete(id);
      if (method === 'Runtime.executionContextsCleared') for (const [id, context] of session.defaultContexts) if (context.sessionId === (sessionId || '')) session.defaultContexts.delete(id);
      if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
        session.children.set(params.sessionId, { id: params.sessionId, parentSession: sessionId || '', targetId: params.targetInfo.targetId }); session.frames = null;
        const setup = Promise.all(['Page.enable','DOM.enable','Runtime.enable'].map(method => wc.debugger.sendCommand(method, {}, params.sessionId))).then(() => wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId)).catch(() => {});
        session.setups.add(setup); setup.finally(() => session.setups.delete(setup));
      }
      if (method === 'Target.detachedFromTarget') { session.children.delete(params.sessionId); session.frames = null; session.contexts.clear(); }
      if (['Page.frameAttached','Page.frameDetached','Page.frameNavigated','Runtime.executionContextsCleared'].includes(method)) { session.frames = null; session.contexts.clear(); }
    };
    session.onDetach = () => { clearTimeout(session.idle); wc.debugger.removeListener('message', session.onMessage); state.session = null; state.refs.clear(); state.reverseRefs.clear(); };
    wc.debugger.on('message', session.onMessage); wc.debugger.once('detach', session.onDetach); state.session = session;
    try { await bounded(ctx, Promise.all(['Page.enable','DOM.enable','Runtime.enable'].map(method => send(method)))); await bounded(ctx, send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })); }
    catch (error) { if (owned && wc.debugger.isAttached()) wc.debugger.detach(); throw error; }
    return session;
  }
  async function withProtocol(state, ctx, interactive, fn) {
    const session = await attach(state, ctx), wc = state.wc;
    session.users++; clearTimeout(session.idle);
    let focus;
    try {
      if (interactive) {
        focus = captureFocus(wc); session.inputUsers++;
        if (!session.emulated) {
          // A new hidden WebContentsView can still report a visible DOM until
          // Chromium processes its first native visibility transition.
          const hidden = ctx.background || await bounded(ctx, wc.executeJavaScript('document.visibilityState === "hidden"'));
          if (hidden) { await bounded(ctx, wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })); session.emulated = true; }
        }
      }
      return await bounded(ctx, fn(session));
    } finally {
      if (interactive) {
        session.inputUsers--;
        if (!session.inputUsers && session.emulated) { if (!wc.isDestroyed() && wc.debugger.isAttached()) await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); session.emulated = false; }
        restoreFocus(focus,wc);
      }
      session.users--;
      if (!session.users && state.session === session) {
        session.idle = setTimeout(() => {
          if (session.users || wc.isDestroyed() || state.session !== session) return;
          wc.debugger.removeListener('message', session.onMessage); wc.debugger.removeListener('detach', session.onDetach);
          if (session.owned && wc.debugger.isAttached()) wc.debugger.detach(); state.session = null;
        }, 800); session.idle.unref();
      }
    }
  }
  function send(state, ctx, method, params = {}, sessionId = '') { check(ctx); return bounded(ctx, state.wc.debugger.sendCommand(method, params, sessionId || undefined)); }
  async function frames(state, ctx, session) {
    if (session.frames) return session.frames;
    await Promise.all([...session.setups]);
    const map = new Map(), roots = new Map();
    const walk = (tree, sessionId, parentId = null) => {
      const f = tree.frame;
      map.set(f.id, { id: f.id, parentId: f.parentId || parentId || map.get(f.id)?.parentId || null, url: f.url, name: f.name || '', loaderId: f.loaderId, sessionId });
      for (const child of tree.childFrames || []) walk(child, sessionId, f.id);
    };
    for (const id of ['', ...session.children.keys()]) {
      try { const tree = await send(state, ctx, 'Page.getFrameTree', {}, id); walk(tree.frameTree, id); roots.set(id, tree.frameTree.frame.id); }
      catch (error) { if (!id) throw error; }
    }
    // A child target's own root is authoritative over its parent's placeholder.
    for (const [id, root] of roots) if (id && map.has(root)) map.get(root).sessionId = id;
    session.roots = roots; session.frames = map; return map;
  }
  async function frameFor(state, ctx, session, id) {
    const map = await frames(state, ctx, session), frame = id ? map.get(id) : map.get(session.roots.get(''));
    if (!frame) throw new Error('Frame not found; refresh browser_frames or browser_inspect'); return frame;
  }
  async function contextFor(state, ctx, session, frame) {
    const key = frame.id + ':' + frame.loaderId;
    if (!session.contexts.has(key)) { const result = await send(state, ctx, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: 'aster-agent-v1' }, frame.sessionId); session.contexts.set(key, result.executionContextId); }
    return session.contexts.get(key);
  }
  async function evaluateFrame(state, ctx, session, frame, expression, byValue = true) {
    const contextId = await contextFor(state, ctx, session, frame);
    const result = await send(state, ctx, 'Runtime.evaluate', { expression, contextId, returnByValue: byValue, awaitPromise: true, userGesture: true, objectGroup: 'aster-agent-ops' }, frame.sessionId);
    if (result.exceptionDetails) protocolValue(result); return byValue ? protocolValue(result) : result.result;
  }
  async function inspect(state, ctx, session, p = {}) {
    const map = await frames(state, ctx, session), root = map.get(session.roots.get(''));
    const selected = p.frameId ? [await frameFor(state, ctx, session, p.frameId)] : p.includeFrames === false ? [root] : [...map.values()];
    const elements = [], max = limits(p.maxNodes, 200, 1000);
    for (const frame of selected) {
      await send(state, ctx, 'Accessibility.enable', {}, frame.sessionId);
      const tree = await send(state, ctx, 'Accessibility.getFullAXTree', { frameId: frame.id }, frame.sessionId);
      for (const node of tree.nodes) {
        const role = node.role?.value;
        if (node.ignored || !roles.has(role) || !node.backendDOMNodeId) continue;
        const key = frame.id + ':' + frame.loaderId + ':' + node.backendDOMNodeId;
        let ref = state.reverseRefs.get(key);
        if (!ref) { ref = 'e' + state.nonce + '-' + (++state.serial); state.reverseRefs.set(key, ref); state.refs.set(ref, { frameId: frame.id, loaderId: frame.loaderId, backendNodeId: node.backendDOMNodeId }); }
        const properties = Object.fromEntries((node.properties || []).filter(v => ['disabled','checked','expanded','selected'].includes(v.name)).map(v => [v.name, v.value?.value]));
        elements.push({ ref, role, name: String(node.name?.value || '').slice(0, 200), frameId: frame.id, ...properties });
        if (elements.length >= max) break;
      }
      if (elements.length >= max) break;
    }
    while (state.refs.size > 3000) { const oldest = state.refs.keys().next().value; state.refs.delete(oldest); for (const [key, ref] of state.reverseRefs) if (ref === oldest) { state.reverseRefs.delete(key); break; } }
    return { url: root.url, title: state.wc.getTitle(), frames: [...map.values()].map(({ loaderId, sessionId, ...f }) => ({ ...f, main: f.id === root.id })), elements, truncated: elements.length >= max };
  }
  async function nodeFor(state, ctx, session, p) {
    if (p.ref) {
      const ref = state.refs.get(p.ref); if (!ref) throw new Error('Element reference is stale or unknown; inspect the page again');
      const frame = await frameFor(state, ctx, session, ref.frameId);
      if (frame.loaderId !== ref.loaderId) throw new Error('Element reference belongs to a previous document; inspect again');
      const result = await send(state, ctx, 'DOM.resolveNode', { backendNodeId: ref.backendNodeId, executionContextId: await contextFor(state, ctx, session, frame), objectGroup: 'aster-agent-ops' }, frame.sessionId);
      if (!result.object?.objectId) throw new Error('Element reference is stale; inspect the page again'); return { frame, objectId: result.object.objectId };
    }
    if (p.role) {
      const tree = await inspect(state, ctx, session, { frameId: p.frameId, includeFrames: Boolean(p.frameId), maxNodes: 1000 });
      const candidates = tree.elements.filter(e => e.role.toLowerCase() === String(p.role).toLowerCase() && (p.name === undefined || (p.exact === false ? e.name.toLowerCase().includes(String(p.name).toLowerCase()) : e.name.toLowerCase() === String(p.name).toLowerCase())));
      if (!candidates.length) return {frame:await frameFor(state,ctx,session,p.frameId),objectId:null};
      if (candidates.length !== 1) throw new Error('Ambiguous role/name; use an element reference'); return nodeFor(state, ctx, session, { ref: candidates[0].ref });
    }
    if (typeof p.selector !== 'string' || !p.selector || p.selector.length > 2000) throw new Error('Provide a selector, element ref, or role/name');
    const frame = await frameFor(state, ctx, session, p.frameId);
    const object = await evaluateFrame(state, ctx, session, frame, `(()=>{const nodes=(${querySource})(${js({ selector: p.selector, nth: p.nth })});if(nodes.length>1)throw Error('Ambiguous selector: '+nodes.length+' matches; use nth or a reference');return nodes[0]||null})()`, false);
    return { frame, objectId: object.objectId || null };
  }
  async function describe(state, ctx, session, node, options) {
    if (!node.objectId) return { status: 'missing', visible: false };
    return protocolValue(await send(state, ctx, 'Runtime.callFunctionOn', { objectId: node.objectId, functionDeclaration: describeSource, arguments: [{ value: options }], returnByValue: true, userGesture: true, awaitPromise: true }, node.frame.sessionId));
  }
  async function readyNode(state, ctx, session, p, editable = false) {
    let last;
    do {
      check(ctx); const node = await nodeFor(state, ctx, session, p);
      const info = await describe(state, ctx, session, node, { actionable: true, editable, scroll: true }); last = info.status;
      if (last === 'ready') return { ...node, info };
      if (last === 'detached' && p.ref) throw new Error('Element reference is stale; inspect again');
      if (last === 'not-editable') throw new Error('Target is not an editable text field');
      await wait(Math.min(40, Math.max(1, ctx.deadline - Date.now())));
    } while (Date.now() < ctx.deadline);
    throw new Error('Element did not become actionable: ' + last);
  }
  async function rootPoint(state, ctx, session, node) {
    const { model } = await send(state, ctx, 'DOM.getBoxModel', { objectId: node.objectId }, node.frame.sessionId);
    const q = model.content;
    const point = { x: (q[0]+q[2]+q[4]+q[6])/4, y: (q[1]+q[3]+q[5]+q[7])/4 };
    node.localPoint={...point};
    // Check the entire embedding chain before injecting into a child widget.
    // A clear target inside an iframe can still sit behind its parent's modal.
    const map=await frames(state,ctx,session);
    let frame=node.frame,local=node.info.point,viewport=node.info.viewport;
    while(frame.parentId){
      const parent=map.get(frame.parentId);
      if (!parent) throw new Error('Frame owner disappeared; refresh the page snapshot');
      const owner=await send(state,ctx,'DOM.getFrameOwner',{frameId:frame.id},parent.sessionId);
      const u=local.x/viewport[0],v=local.y/viewport[1];
      const resolved=await send(state,ctx,'DOM.resolveNode',{backendNodeId:owner.backendNodeId,executionContextId:await contextFor(state,ctx,session,parent),objectGroup:'aster-agent-ops'},parent.sessionId);
      const assessed=protocolValue(await send(state,ctx,'Runtime.callFunctionOn',{objectId:resolved.object.objectId,functionDeclaration:`function(u,v){const r=this.getBoundingClientRect(),s=getComputedStyle(this);if(!r.width||!r.height||s.visibility==='hidden'||s.display==='none'||s.pointerEvents==='none'||this.closest('[inert]'))return {receives:false};const x=r.x+r.width*(this.clientLeft+u*this.clientWidth)/this.offsetWidth,y=r.y+r.height*(this.clientTop+v*this.clientHeight)/this.offsetHeight;const root=this.getRootNode(),hit=root.elementFromPoint?.(x,y)||document.elementFromPoint(x,y);return {receives:hit===this||this.contains(hit),point:{x,y},viewport:[innerWidth,innerHeight]}}`,arguments:[{value:u},{value:v}],returnByValue:true},parent.sessionId));
      if(!assessed.receives){const error=new Error('The frame is covered or outside the visible viewport');error.code='FRAME_NOT_ACTIONABLE';throw error;}
      local=assessed.point;viewport=assessed.viewport;frame=parent;
    }
    return point;
  }
  async function key(state, ctx, session, p) {
    if (typeof p.key !== 'string' || p.key.length > 30) throw new Error('Invalid key');
    if (p.key === 'Escape' && !(p.modifiers || []).length && isHtmlFullscreen(state.wc)) { state.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); state.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); return true; }
    const modifiers = (p.modifiers || []).reduce((bits, key) => bits | ({ alt:1,control:2,meta:4,shift:8 }[key] || 0), 0);
    const codes = { Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Space:32,Home:36,End:35,PageUp:33,PageDown:34 };
    const value = p.key === 'Space' ? ' ' : p.key, code = p.key.length === 1 ? 'Key' + p.key.toUpperCase() : p.key;
    const params = { type:'keyDown', key:value, code, modifiers, windowsVirtualKeyCode:codes[p.key] || (p.key.length === 1 ? p.key.toUpperCase().charCodeAt(0) : 0), ...(p.key === 'Enter' ? { text:'\r' } : p.key.length === 1 && !modifiers ? { text:p.key } : {}) };
    await send(state, ctx, 'Input.dispatchKeyEvent', params); await send(state, ctx, 'Input.dispatchKeyEvent', { type:'keyUp',key:value,code,modifiers }); return true;
  }
  async function waitFor(state, ctx, session, p) {
    do {
      check(ctx);
      if (p.url) { const frame = await frameFor(state, ctx, session, p.frameId); if (frame.url.includes(p.url)) return { matched: true, url: frame.url }; }
      else {
        const node = await nodeFor(state, ctx, session, p), info = await describe(state, ctx, session, node, {}), mode = p.state || 'visible';
        const attached = !['missing','detached'].includes(info.status);
        const matched = mode === 'attached' ? attached : mode === 'detached' ? !attached : mode === 'hidden' ? !attached || !info.visible : attached && info.visible;
        if (matched && (p.text === undefined || info.text?.includes(String(p.text))) && (p.value === undefined || info.value === String(p.value))) return { matched: true, state: mode };
      }
      await wait(Math.min(40,Math.max(1,ctx.deadline-Date.now()))); if (session.frames) session.frames = null;
    } while (Date.now() < ctx.deadline);
    throw new Error('Wait condition was not met');
  }
  async function dispatch(state, ctx, session, action, p) {
    check(ctx);
    if (action === 'page.frames') { const map = await frames(state, ctx, session); return [...map.values()].map(({loaderId,sessionId,...f})=>({...f,main:f.id===session.roots.get('')})); }
    if (action === 'page.inspect') return inspect(state,ctx,session,p);
    if (action === 'page.waitFor') return waitFor(state,ctx,session,p);
    if (action === 'page.snapshot') { const frame = await frameFor(state,ctx,session,p.frameId); return evaluateFrame(state,ctx,session,frame,`(${snapshotDocument.toString()})(${js({maxLength:limits(p.maxLength,16000,100000),maxElements:limits(p.maxElements,300,1000)})})`); }
    if (action === 'page.evaluate') {
      if (typeof p.expression !== 'string' || p.expression.length > 100000) throw new Error('Provide an expression under 100 KB');
      // Page evaluation intentionally uses the page's own world for compatibility.
      if (!p.frameId) return bounded(ctx,state.wc.executeJavaScript(p.expression,true));
      const frame=await frameFor(state,ctx,session,p.frameId),context=session.defaultContexts.get(frame.id);
      if(!context)throw new Error('Frame execution context is not ready; refresh browser_frames');
      return protocolValue(await send(state,ctx,'Runtime.evaluate',{expression:p.expression,contextId:context.id,returnByValue:true,awaitPromise:true,userGesture:true},context.sessionId));
    }
    if (action === 'page.scroll') { const frame=await frameFor(state,ctx,session,p.frameId);return evaluateFrame(state,ctx,session,frame,`window.scrollBy({top:${signed(p.y)},left:${signed(p.x)},behavior:${js(p.behavior==='instant'?'instant':'smooth')}});true`); }
    if (action === 'page.key') return key(state,ctx,session,p);
    if (action === 'page.click' || action === 'page.type' || action === 'page.check' || action === 'page.select') {
      if(action==='page.type'&&(typeof p.text!=='string'||p.text.length>100000))throw new Error('Provide text under 100 KB');
      let node,rawPoint;
      for(;;){node=await readyNode(state,ctx,session,p,action==='page.type');try{rawPoint=await rootPoint(state,ctx,session,node);break;}catch(error){if(error.code!=='FRAME_NOT_ACTIONABLE')throw error;check(ctx);await wait(40);}}
      if (action==='page.select') {
        const values=Array.isArray(p.values)?p.values:[p.value];if(values.some(v=>typeof v!=='string')||values.length>100)throw new Error('Provide option values as strings');
        return protocolValue(await send(state,ctx,'Runtime.callFunctionOn',{objectId:node.objectId,functionDeclaration:`function(values){if(this.tagName!=='SELECT')throw Error('Target is not a select');const all=[...this.options];if(values.some(v=>!all.some(o=>o.value===v)))throw Error('Option not found');if(!this.multiple&&values.length>1)throw Error('Select accepts one option');this.focus({preventScroll:true});for(const o of all)o.selected=values.includes(o.value);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return [...this.selectedOptions].map(o=>o.value)}`,arguments:[{value:values}],returnByValue:true},node.frame.sessionId));
      }
      if(action==='page.check'&&typeof node.info.checked!=='boolean')throw new Error('Target is not a checkbox or radio');
      if(action==='page.check'&&node.info.checked===(p.checked!==false))return {ok:true,checked:node.info.checked};
      const point={x:Math.round(rawPoint.x),y:Math.round(rawPoint.y)};check(ctx);
      if(node.frame.sessionId){
        // A hidden out-of-process frame has no root-window compositor hit
        // target. Inject through its own session in local widget coordinates.
        let pressed=false;
        try{await send(state,ctx,'Input.dispatchMouseEvent',{type:'mousePressed',...node.localPoint,button:'left',clickCount:1},node.frame.sessionId);pressed=true;await send(state,ctx,'Input.dispatchMouseEvent',{type:'mouseReleased',...node.localPoint,button:'left',clickCount:1},node.frame.sessionId);pressed=false;}
        finally{if(pressed&&!state.wc.isDestroyed()&&state.wc.debugger.isAttached())await state.wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...node.localPoint,button:'left',clickCount:1},node.frame.sessionId).catch(()=>{});}
      }else{
        state.wc.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
        state.wc.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
      }
      await describe(state,ctx,session,node,{});
      if(action==='page.type'){
        if(typeof p.text!=='string'||p.text.length>100000)throw new Error('Provide text under 100 KB');
        if(p.clear!==false){await send(state,ctx,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:process.platform==='darwin'?4:2,commands:['selectAll']});await send(state,ctx,'Input.dispatchKeyEvent',{type:'keyUp',key:'a',modifiers:process.platform==='darwin'?4:2});}
        await send(state,ctx,'Input.insertText',{text:p.text});
      }
      if(action==='page.check'){const after=await describe(state,ctx,session,node,{});if(after.checked!==(p.checked!==false))throw new Error('Checkbox did not reach the requested state');return {ok:true,checked:after.checked};}
      if(p.waitFor)await waitFor(state,ctx,session,p.waitFor);
      return {ok:true};
    }
    throw new Error('Unknown page action: '+action);
  }
  async function execute(tab,action,p={}) {
    const view=ensureView(tab),wc=view?.webContents;if(!wc||wc.isDestroyed())throw new Error('Navigate to a website before controlling the page');
    const state=stateFor(wc),timeout=limits(p.timeoutMs,action==='page.batch'?30000:action==='page.evaluate'?20000:10000,120000),ctx={deadline:Date.now()+timeout,aborted:false,background:!view.getVisible()};
    if(action==='page.screenshot'){
      // Chromium can retire a hidden tab's compositor surface between the
      // capture request and GPU readback. Retrying this read-only operation
      // preserves the selected tab and never grants focus or activation.
      for(let attempt=0;;attempt++){
        try{const image=await bounded(ctx,wc.capturePage(undefined,{stayHidden:true}));if(image.isEmpty())throw Error('Current display surface not available for capture');return {mimeType:'image/png',data:image.toPNG().toString('base64')};}
        catch(error){if(wc.isDestroyed()||attempt>=9||!/(UnknownVizError|Frame Gone|EmbeddingTokenChanged|VizSentEmptyBitmap|display surface not available)/.test(error.message))throw error;await bounded(ctx,wait(100));}
      }
    }
    if(action==='page.evaluate'&&!p.frameId){if(typeof p.expression!=='string'||p.expression.length>100000)throw new Error('Provide an expression under 100 KB');const result=await bounded(ctx,wc.executeJavaScript(p.expression,true));if(JSON.stringify(result)?.length>1048576)throw new Error('Result exceeds 1 MiB; request less data');return result;}
    if(action==='page.snapshot'&&!p.frameId)return bounded(ctx,wc.executeJavaScriptInIsolatedWorld(1011,[{code:`(${snapshotDocument.toString()})(${js({maxLength:limits(p.maxLength,16000,100000),maxElements:limits(p.maxElements,300,1000)})})`}],true));
    const interactive=['page.click','page.type','page.key','page.check','page.select','page.batch'].includes(action);
    return withProtocol(state,ctx,interactive,async session=>{
      try{
        if(action!=='page.batch'){const result=await dispatch(state,ctx,session,action,p);if(JSON.stringify(result)?.length>1048576)throw new Error('Result exceeds 1 MiB; request less data');return result;}
        if(!Array.isArray(p.steps)||!p.steps.length||p.steps.length>32)throw new Error('Provide 1–32 batch steps');
        const allowed=new Set(['click','type','key','scroll','waitFor','evaluate','inspect','snapshot','select','check']);const results=[],start=Date.now();
        for(let i=0;i<p.steps.length;i++){
          const step=p.steps[i];if(!step||!allowed.has(step.action)||step.tabId||step.id)throw new Error('Batch steps use supported page actions in one tab');
          try{check(ctx);const stepCtx={deadline:Math.min(ctx.deadline,Date.now()+limits(step.timeoutMs,ctx.deadline-Date.now(),120000)),aborted:false};const result=await dispatch(state,stepCtx,session,'page.'+step.action,step);if(JSON.stringify(result)?.length>1048576)throw new Error('Result exceeds 1 MiB; request less data');results.push(result);}
          catch(error){const failure=new Error('Batch step '+i+' failed: '+error.message);failure.details={failedStep:i,completedSteps:results.length};throw failure;}
        }
        return {ok:true,results,durationMs:Date.now()-start};
      }finally{if(wc.debugger.isAttached())for(const id of ['',...session.children.keys()])await wc.debugger.sendCommand('Runtime.releaseObjectGroup',{objectGroup:'aster-agent-ops'},id||undefined).catch(()=>{});}
    });
  }
  function dispose(){for(const state of states.values()){const s=state.session;clearTimeout(s?.idle);if(s&&state.wc.debugger.isAttached()){state.wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});if(s.owned)state.wc.debugger.detach();}}states.clear();}
  return {execute,dispose};
}
module.exports={createAgentEngine};
