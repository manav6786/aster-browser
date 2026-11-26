'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { installMediaGain, mediaAction } = require('./media-gain.cjs');
const CHANNELS = Object.freeze({ ready: 'aster:media:document-start', changed: 'aster:media:changed', volume: 'aster:media:volume' });
const allowedURL = url => typeof url === 'string' && /^(?:https?:\/\/|about:blank$|about:srcdoc$)/.test(url);
const frameId = frame => String(frame.frameTreeNodeId ?? (frame.processId + ':' + frame.routingId));

function createMediaController({ ipcMain, onChange = () => {} } = {}) {
  if (!ipcMain) throw new TypeError('Media controller requires ipcMain');
  const records = new Map(), sessions = new WeakMap(), sessionRefs = new Set();
  let disposed = false;
  const within = (promise, ms = 2500) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Media frame did not respond')), ms); timer.unref?.();
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  function frames(wc) {
    try { return wc.mainFrame.framesInSubtree.filter(frame => !frame.isDestroyed() && !frame.detached && allowedURL(frame.url)); }
    catch { return []; }
  }
  function validSender(event, message) {
    try {
      return !disposed && message && allowedURL(message.url) && records.has(event.sender) && !event.sender.isDestroyed()
        && event.senderFrame && !event.senderFrame.isDestroyed() && !event.senderFrame.detached
        && event.senderFrame.url === message.url && frames(event.sender).includes(event.senderFrame);
    } catch { return false; }
  }
  function contextFor(record, frame, nonce) {
    const id = frameId(frame), existing = record.frames.get(id);
    // pushState/replaceState changes URL without replacing the document. Keep
    // its gain runtime/key; installing another wrapper would attenuate twice.
    if (existing?.frame === frame && (!nonce || !existing.nonce || existing.nonce === nonce)) { existing.url = frame.url; if (nonce) existing.nonce = nonce; return existing; }
    const context = { id, frame, url: frame.url, nonce: nonce || null, key: 'aster-media-' + randomUUID() };
    record.frames.set(id, context); return context;
  }
  const ready = (event, message) => {
    // Electron sends a synchronous reply on the first assignment. Do not
    // initialize returnValue before validating and constructing that one reply.
    if (!validSender(event, message) || typeof message.nonce !== 'string' || message.nonce.length > 80) {event.returnValue=null;return;}
    const record = records.get(event.sender), context = contextFor(record, event.senderFrame, message.nonce);
    event.returnValue = { key: context.key, volume: record.tab.volume };
  };
  const changed = (event, message) => {
    if (!validSender(event, message)) return;
    const record = records.get(event.sender), context = record.frames.get(frameId(event.senderFrame));
    if (context?.key !== message.key || context.frame !== event.senderFrame) return;
    context.url = message.url;
    schedule(event.sender);
  };
  ipcMain.on(CHANNELS.ready, ready); ipcMain.on(CHANNELS.changed, changed);
  const installed=(event,message)=>{if(!validSender(event,message))return;const context=records.get(event.sender).frames.get(frameId(event.senderFrame));if(context?.key===message.key){context.preloadInstalled=true;context.preloadError=null;}};
  const failed=(event,message)=>{if(!validSender(event,message))return;const context=records.get(event.sender).frames.get(frameId(event.senderFrame));if(context?.key===message.key){context.preloadInstalled=false;context.preloadError=String(message.error||'Media initialization failed').slice(0,1000);if(process.env.ASTER_MEDIA_DIAGNOSTICS)console.error('MEDIA-PRELOAD-ERROR',context.preloadError);}};
  ipcMain.on('aster:media:preload-installed',installed);ipcMain.on('aster:media:preload-failure',failed);
  function requireRecord(wc) {
    const record = records.get(wc); if (disposed || !record || wc.isDestroyed()) throw new Error('This tab is no longer available'); return record;
  }
  async function execute(frame, context, action, value, userGesture = false) {
    if (frame.isDestroyed() || frame.detached || frame.url !== context.url) throw new Error('The media frame has navigated');
    const args = [context.key, action, value].map(value => JSON.stringify(value) ?? 'undefined').join(',');
    const source = '(' + mediaAction.toString() + ')(' + args + ')';
    return within(frame.executeJavaScript(source, userGesture));
  }
  async function inspectFrame(wc, record, frame) {
    const context = contextFor(record, frame);
    let result = await execute(frame, context, 'inspect');
    if (!result) {
      // Normally the session preload installs before page scripts. This fallback
      // supports an already-loaded tab and frames created before registration.
      await within(frame.executeJavaScript('(' + installMediaGain.toString() + ')(' + JSON.stringify(context.key) + ',' + record.tab.volume + ')'));
      result = await execute(frame, context, 'inspect');
    }
    if (!result || !Array.isArray(result.videos)) throw new Error('Media state is unavailable');
    return {
      playing: Boolean(result.playing), capabilities: {...result.capabilities,documentStart:context.preloadInstalled===true},
      videos: result.videos.slice(0, 256).filter(video => video && typeof video.id === 'string').map(video => ({
        id: context.id + '|' + context.key + '|' + video.id, frameId: context.id,
        title: String(video.title || 'Video').slice(0, 240), playing: Boolean(video.playing),
        width: Math.max(0, Math.min(32768, Number(video.width) || 0)), height: Math.max(0, Math.min(32768, Number(video.height) || 0)),
        pipAvailable: Boolean(video.pipAvailable), pipActive: Boolean(video.pipActive)
      }))
    };
  }
  async function get(wc) {
    const record = requireRecord(wc), allFrames = frames(wc), selected = allFrames.slice(0, 128);
    const outcomes = new Array(selected.length); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, selected.length) }, async () => {
      for (;;) { const index = cursor++; if (index >= selected.length) break; try { outcomes[index] = { value: await inspectFrame(wc, record, selected[index]) }; } catch (error) { outcomes[index] = { error: error.message }; } }
    }));
    const alive = new Set(allFrames.map(frameId)); for (const id of record.frames.keys()) if (!alive.has(id)) record.frames.delete(id);
    const videos = outcomes.flatMap(outcome => outcome.value?.videos || []);
    let muted = Boolean(record.tab.muted), audible = false;
    try { muted = wc.isAudioMuted(); audible = wc.isCurrentlyAudible(); } catch {}
    return {
      tabId: record.tab.id, volume: record.tab.volume, muted, audible,
      playing: outcomes.some(outcome => outcome.value?.playing) || audible,
      videoCount: videos.length, pipAvailable: videos.some(video => video.pipAvailable), pipActive: videos.some(video => video.pipActive), videos,
      frameCount: allFrames.length, unavailableFrames: outcomes.filter(outcome => outcome.error).length + Math.max(0, allFrames.length - selected.length),
      volumeSupport: { htmlMedia: outcomes.length > 0 && outcomes.every(outcome => outcome.value?.capabilities?.htmlVolume === true), webAudio: outcomes.length > 0 && outcomes.every(outcome => outcome.value?.capabilities?.webAudio === true),documentStart:outcomes.length>0&&outcomes.every(outcome=>outcome.value?.capabilities?.documentStart===true) }
    };
  }
  function schedule(wc) {
    const record = records.get(wc); if (disposed || !record || record.timer) return;
    record.timer = setTimeout(async () => {
      record.timer = null; if (disposed || !records.has(wc) || wc.isDestroyed()) return;
      try { onChange(wc, await get(wc)); } catch {}
    }, 100); record.timer.unref?.();
  }
  function attachWebContents(wc, tab) {
    if (disposed || !wc || wc.isDestroyed() || records.has(wc)) return;
    if (!tab || typeof tab.id !== 'string') throw new TypeError('Attach media to an owned browser tab');
    tab.volume = typeof tab.volume === 'number' && Number.isFinite(tab.volume) ? Math.max(0, Math.min(1, tab.volume)) : 1;
    const record = { tab, frames: new Map(), listeners: [], timer: null, pipPending: null }; records.set(wc, record);
    for (const name of ['dom-ready', 'did-frame-finish-load', 'media-started-playing', 'media-paused', 'audio-state-changed']) {
      const listener = () => schedule(wc); wc.on(name, listener); record.listeners.push([name, listener]);
    }
    const destroyed = () => detach(wc); wc.once('destroyed', destroyed); record.listeners.push(['destroyed', destroyed]);
  }
  function detach(wc) {
    const record = records.get(wc); if (!record) return;
    clearTimeout(record.timer); for (const [name, listener] of record.listeners) wc.removeListener(name, listener); records.delete(wc);
  }
  function attachSession(ses) {
    if (disposed || sessions.has(ses)) return;
    const id = ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'media-preload.cjs') });
    sessions.set(ses, id); sessionRefs.add({ session: new WeakRef(ses), id });
  }
  async function setVolume(wc, value) {
    const record = requireRecord(wc);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Tab volume must be a number between 0 and 1');
    record.tab.volume = value;
    await Promise.allSettled(frames(wc).map(async frame => {
      const context = contextFor(record, frame);
      frame.send(CHANNELS.volume, { key: context.key, url: context.url, volume: value });
      await inspectFrame(wc, record, frame); await execute(frame, context, 'volume', value);
    }));
    const result = await get(wc); onChange(wc, result); return result;
  }
  async function runPipToggle(wc, videoId) {
    const record = requireRecord(wc), before = await get(wc);
    let selected;
    if (videoId !== undefined) {
      if (typeof videoId !== 'string' || videoId.length > 240) throw new Error('Invalid video identifier');
      selected = before.videos.find(video => video.id === videoId);
    } else selected = before.videos.find(video => video.pipActive) || before.videos.filter(video => video.pipAvailable).sort((a, b) => Number(b.playing) - Number(a.playing) || b.width * b.height - a.width * a.height)[0];
    if (!selected) throw new Error(videoId ? 'This video is no longer available. Refresh the media list.' : 'No loaded video supports Picture in Picture in this tab');
    const context = record.frames.get(selected.frameId);
    if (!context || !selected.id.startsWith(context.id + '|' + context.key + '|')) throw new Error('The media frame has navigated. Refresh the media list.');
    const localId = selected.id.slice((context.id + '|' + context.key + '|').length);
    const changed = await execute(context.frame, context, 'pip', localId, true);
    if (!changed || typeof changed.pipActive !== 'boolean') throw new Error('The video document changed before Picture in Picture could be toggled');
    const result = await get(wc); onChange(wc, result); return result;
  }
  function togglePip(wc, videoId) {
    const record = requireRecord(wc);
    if (record.pipPending) return record.pipPending;
    const operation = runPipToggle(wc, videoId);
    record.pipPending = operation.finally(() => { record.pipPending = null; });
    return record.pipPending;
  }
  return {
    attachSession, attachWebContents, get, setVolume, togglePip,
    dispose() {
      if (disposed) return; disposed = true;
      ipcMain.removeListener(CHANNELS.ready, ready); ipcMain.removeListener(CHANNELS.changed, changed);ipcMain.removeListener('aster:media:preload-installed',installed);ipcMain.removeListener('aster:media:preload-failure',failed);
      for (const wc of records.keys()) detach(wc);
      for (const { session, id } of sessionRefs) { try { session.deref()?.unregisterPreloadScript(id); } catch {} }
      sessionRefs.clear();
    }
  };
}

module.exports = { createMediaController, CHANNELS };
