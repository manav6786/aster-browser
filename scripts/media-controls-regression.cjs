'use strict';
// Focus-sensitive actual Electron regression. Run only while owning the team's
// native-app focus slot. No remote video, mocked media state, screenshot PiP,
// OS audio capture, microphone permission, or system VPN change is involved.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const work = path.resolve(process.env.ASTER_TEST_WORK || path.join(root, 'work', 'media-controls'));
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'profile-'));
const results = [], diagnostics = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, shell, server, origin, crossOrigin;
async function until(read, label, ms = 20000) {
  const start = Date.now(); let last;
  while (Date.now() - start < ms) { try { const value = await read(); if (value) return value; } catch (error) { last = error; } await sleep(90); }
  throw new Error('Timed out: ' + label + (last ? ' (' + last.message + ')' : ''));
}
async function check(name, action) {
  const start = Date.now();
  try { const detail = await action(); results.push({ name, passed: true, durationMs: Date.now() - start, detail }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, durationMs: Date.now() - start, error: error.stack }); console.error('FAIL', name, error.message); }
}
const invoke = (command, params = {}) => shell.evaluate(({ command, params }) => window.aster.invoke(command, params), { command, params });
const browserState = () => invoke('state:get');
async function launch() {
  app = await _electron.launch({ ...(process.env.ASTER_EXECUTABLE ? { executablePath: process.env.ASTER_EXECUTABLE, args: [] } : { args: [root] }), env: { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' }, timeout: 60000 });
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(work, 'stderr.log'), data));
  shell = await app.firstWindow(); await shell.waitForFunction(() => Boolean(window.aster));
}
async function wcId(tabId) {
  const tab = (await browserState()).tabs.find(tab => tab.id === tabId); if (!tab) throw new Error('Fixture tab disappeared');
  return until(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(w => w.getURL() === url)?.id, tab.url), 'owned fixture contents');
}
async function frameEval(contentsId, url, source, gesture = false) {
  return app.evaluate(async ({ webContents }, { contentsId, url, source, gesture }) => {
    const wc = webContents.fromId(contentsId); if (!wc || wc.isDestroyed()) throw new Error('Fixture page disappeared');
    const frame = wc.mainFrame.framesInSubtree.find(frame => frame.url === url && !frame.detached && !frame.isDestroyed());
    if (!frame) throw new Error('Fixture frame disappeared: ' + url);
    return frame.executeJavaScript(source, gesture);
  }, { contentsId, url, source, gesture });
}
function fixtureHTML(url) {
  const child = url.pathname.includes('frame');
  const role = url.pathname.includes('cross') ? 'cross' : url.pathname.includes('same') ? 'same' : 'root';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Aster media ${role}</title>
  <style>body{margin:12px;background:#eff1fa;font:14px system-ui}video{width:300px;height:170px;background:#171c36;border-radius:12px}iframe{width:330px;height:210px;border:1px solid #c6cae1;border-radius:10px}#shadow-host{display:inline-block}h1{font-size:18px}</style>
  <script nonce="aster-media-fixture">
  window.fixture={role:${JSON.stringify(role)},early:null,videos:[],pipEvents:[],prepared:false};
  function runtime(){const key=Object.getOwnPropertySymbols(globalThis).find(s=>String(s).startsWith('Symbol(aster-media-'));return key?globalThis[key]:null}
  // This graph is connected by the page's FIRST inline script, before any
  // controller get(). A late main-process patch cannot manufacture early data.
  fixture.audioContext=new AudioContext();fixture.oscillator=fixture.audioContext.createOscillator();fixture.pageGain=fixture.audioContext.createGain();fixture.pageGain.gain.value=0;
  fixture.oscillator.connect(fixture.pageGain);fixture.pageGain.connect(fixture.audioContext.destination);fixture.oscillator.start();
  fixture.early={runtimePresent:!!runtime(),audioContexts:runtime()?.inspect().audioContexts||[],require:typeof require,process:typeof process,aster:typeof window.aster,ipc:typeof ipcRenderer};
  function addVideo(video,name){video.id=name;video.title=name;video.volume=.6;video.loop=true;video.playsInline=true;video.playbackRate=.25;video.addEventListener('enterpictureinpicture',event=>fixture.pipEvents.push({name,kind:'enter',width:event.pictureInPictureWindow.width,height:event.pictureInPictureWindow.height,at:performance.now()}));video.addEventListener('leavepictureinpicture',()=>fixture.pipEvents.push({name,kind:'leave',at:performance.now()}));fixture.videos.push(video);return video}
  fixture.prepare=async()=>{
    if(fixture.prepared)return true;
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');let tick=0;
    const draw=()=>{ctx.fillStyle='hsl('+((tick++*8)%360)+' 72% 48%)';ctx.fillRect(0,0,320,180);ctx.fillStyle='white';ctx.font='24px system-ui';ctx.fillText('Aster decoded video',20,65);ctx.fillText(fixture.role+' / '+tick,20,110)};draw();
    const stream=canvas.captureStream(20),mime=['video/webm;codecs=vp8','video/webm'].find(m=>MediaRecorder.isTypeSupported(m));if(!mime)throw Error('No WebM fixture encoder');
    const chunks=[],recorder=new MediaRecorder(stream,{mimeType:mime});recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const complete=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=reject});const timer=setInterval(draw,45);recorder.start();await new Promise(r=>setTimeout(r,3000));recorder.stop();await complete;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
    const source=URL.createObjectURL(new Blob(chunks,{type:mime}));await Promise.all(fixture.videos.map(v=>new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(Error('Fixture video failed decoding'));v.src=source;v.load()})));fixture.prepared=true;return true;
  };
  fixture.play=async()=>{await fixture.audioContext.resume();await Promise.all(fixture.videos.map(v=>v.play()));return true};
  fixture.sample=()=>({role:fixture.role,early:fixture.early,actualRuntime:runtime()?.inspect(),pipEvents:fixture.pipEvents,focused:document.hasFocus(),visibility:document.visibilityState,videos:fixture.videos.map(v=>({id:v.id,title:v.title,volume:v.volume,time:v.currentTime,ready:v.readyState,paused:v.paused,width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,pip:document.pictureInPictureElement===v||v.getRootNode().pictureInPictureElement===v,error:v.error?.message}))});
  </script></head><body><h1>${role} native media fixture</h1><video id="video"></video>${child ? '' : '<div id="shadow-host"></div>'}
  <script nonce="aster-media-fixture">addVideo(document.querySelector('video'),fixture.role+'-video');${child ? '' : "const shadow=document.querySelector('#shadow-host').attachShadow({mode:'closed'});const closedVideo=addVideo(document.createElement('video'),'closed-shadow-video');shadow.append(closedVideo);"}</script>
  ${child ? '' : `<iframe src="${origin}/same-frame" allow="autoplay; picture-in-picture" title="Same-origin video"></iframe><iframe src="${crossOrigin}/cross-frame" allow="autoplay; picture-in-picture" title="Cross-origin video"></iframe>`}
  </body></html>`;
}
async function createFixture(name, isPrivate = false, volume = .4) {
  const tab = await invoke('tab:new', { private: isPrivate }); await invoke('tab:volume', { id: tab.id, volume });
  const url = origin + '/' + name; await invoke('tab:navigate', { id: tab.id, url });
  await until(async () => { const current = (await browserState()).tabs.find(t => t.id === tab.id); return current?.url === url && !current.isLoading && !current.error; }, 'fixture navigation');
  const contentsId = await wcId(tab.id), urls = [url, origin + '/same-frame', crossOrigin + '/cross-frame'];
  for (const frameURL of urls) await until(() => frameEval(contentsId, frameURL, 'document.readyState === "complete" && Boolean(window.fixture)'), 'fixture frame ready');
  return { ...tab, url, urls, contentsId };
}
async function samples(tab) { return Promise.all(tab.urls.map(url => frameEval(tab.contentsId, url, 'fixture.sample()'))); }
function assertNear(value, expected, message) { assert.ok(Math.abs(value - expected) < .0001, message + ': ' + value + ' vs ' + expected); }

// Native HTMLMediaElement getters in fresh isolated worlds independently read
// Chromium's actual element volume, including closed shadows and OOPIFs.
async function nativeVolumeSamples(contentsId) {
  return app.evaluate(async ({ webContents }, contentsId) => {
    const wc = webContents.fromId(contentsId); if (!wc || wc.isDestroyed()) throw new Error('Fixture contents disappeared');
    if (wc.debugger.isAttached()) throw new Error('Another owner has the fixture debugger; serialize this regression');
    wc.debugger.attach('1.3');
    const childSessions = new Set(), setups = new Set(), contexts = new Map(), frameSessions = new Map();
    const send = (method, params = {}, sessionId = '') => wc.debugger.sendCommand(method, params, sessionId || undefined);
    const listener = (_event, method, params) => {
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
        childSessions.add(params.sessionId);
        const setup = Promise.all(['Page.enable','DOM.enable','Runtime.enable'].map(name => send(name, {}, params.sessionId))).then(() => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId)).catch(() => {});
        setups.add(setup); setup.finally(() => setups.delete(setup));
      }
    };
    wc.debugger.on('message', listener);
    try {
      await Promise.all(['Page.enable','DOM.enable','Runtime.enable'].map(name => send(name)));
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await new Promise(resolve => setTimeout(resolve, 150)); await Promise.all([...setups]);
      const sessionTrees = [];
      function treeFrames(tree, sessionId) { frameSessions.set(tree.frame.id, sessionId); for (const child of tree.childFrames || []) treeFrames(child, sessionId); }
      for (const sessionId of ['', ...childSessions]) { const tree = (await send('Page.getFrameTree', {}, sessionId)).frameTree; sessionTrees.push({ sessionId, frameId: tree.frame.id }); treeFrames(tree, sessionId); }
      // A child target's own root owns its execution context, not its parent's placeholder.
      for (const item of sessionTrees) frameSessions.set(item.frameId, item.sessionId);
      const rows = [], seen = new Set();
      for (const { sessionId, frameId: rootFrame } of sessionTrees) {
        const { root: documentNode } = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
        const nodes = [];
        function walk(node, frame) {
          const activeFrame = node.nodeType === 9 && node.frameId ? node.frameId : frame;
          if (node.localName === 'video') nodes.push({ backendNodeId: node.backendNodeId, frameId: activeFrame });
          for (const child of node.children || []) walk(child, activeFrame);
          for (const shadow of node.shadowRoots || []) walk(shadow, activeFrame);
          if (node.contentDocument) walk(node.contentDocument, node.frameId || activeFrame);
        }
        walk(documentNode, rootFrame);
        for (const node of nodes) {
          if (seen.has(node.backendNodeId)) continue;
          const owner = frameSessions.get(node.frameId); if (owner !== sessionId) continue;
          seen.add(node.backendNodeId);
          const key = owner + ':' + node.frameId;
          if (!contexts.has(key)) contexts.set(key, (await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: 'aster-native-media-qa' }, owner)).executionContextId);
          const { object } = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: contexts.get(key), objectGroup: 'aster-native-media-qa' }, owner);
          const result = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){const get=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"volume").get;return {id:this.id,title:this.title,volume:get.call(this),getterNative:String(get).includes("[native code]")}}', returnByValue: true }, owner);
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); rows.push({ frameId: node.frameId, ...result.result.value });
        }
      }
      return rows;
    } finally { wc.debugger.removeListener('message', listener); if (wc.debugger.isAttached()) wc.debugger.detach(); }
  }, contentsId);
}
async function verifyIsolation(tab) {
  return app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id), prefs = wc.getLastWebPreferences();
    const frames = await Promise.all(wc.mainFrame.framesInSubtree.filter(f => /^https?:/.test(f.url)).map(f => f.executeJavaScript('({url:location.href,require:typeof require,process:typeof process,aster:typeof window.aster,ipc:typeof ipcRenderer,electron:typeof window.electron})')));
    return { preferences: { sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames, contextIsolation: prefs.contextIsolation }, frames };
  }, tab.contentsId);
}

async function main() {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, origin || 'http://127.0.0.1');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-aster-media-fixture'; style-src 'unsafe-inline'; media-src blob:; frame-src ${origin} ${crossOrigin}; connect-src 'none'` });
    response.end(fixtureHTML(url));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port; crossOrigin = 'http://localhost:' + server.address().port;
  await launch();
  const tab = await createFixture('normal-root');
  await check('document-start gain precedes early inline Web Audio in root, same-origin and cross-origin frames', async () => {
    const observed = await samples(tab);
    for (const frame of observed) {
      assert.equal(frame.early.runtimePresent, true, frame.role + ' missed the document-start preload');
      assert.equal(frame.early.audioContexts.length, 1, frame.role + ' early output graph was not captured');
      assertNear(frame.early.audioContexts[0].outputGain, .4, frame.role + ' early native output GainNode');
      assert.ok(frame.videos.every(video => video.volume === .6), 'Page-owned volume must remain .6');
    }
    const native = await nativeVolumeSamples(tab.contentsId); assert.equal(native.length, 4, 'Native traversal must include root, closed shadow, same and cross videos');
    for (const video of native) { assert.equal(video.getterNative, true); assertNear(video.volume, .24, video.title + ' native volume'); }
    return { early: observed.map(frame => ({ role: frame.role, early: frame.early })), native };
  });
  await check('normal and cross-origin page worlds retain Node and IPC isolation', async () => {
    const result = await verifyIsolation(tab); assert.equal(result.preferences.nodeIntegrationInSubFrames, true); assert.equal(result.preferences.nodeIntegration, false); assert.equal(result.preferences.contextIsolation, true); assert.equal(result.preferences.sandbox, true);
    assert.equal(result.frames.length, 3); for (const frame of result.frames) for (const key of ['require','process','aster','ipc','electron']) assert.equal(frame[key], 'undefined', frame.url + ' exposed ' + key);
    return result;
  });
  await check('fractional volume updates HTML media and real Web Audio output gains across every frame', async () => {
    await Promise.all(tab.urls.map(url => frameEval(tab.contentsId, url, 'fixture.audioContext.resume();true', true)));
    const media = await invoke('tab:volume', { id: tab.id, volume: .25 }); assert.equal(media.volume, .25);
    await until(async () => (await samples(tab)).every(frame => frame.actualRuntime.audioContexts.every(ctx => Math.abs(ctx.outputGain - .25) < .001)), 'smoothed native Web Audio gain');
    const native = await nativeVolumeSamples(tab.contentsId); for (const video of native) assertNear(video.volume, .15, video.title + ' native multiplied volume');
    const observed = await samples(tab); for (const frame of observed) assert.ok(frame.videos.every(video => video.volume === .6));
    await invoke('tab:volume', { id: tab.id, volume: .4 }); return { native, outputGains: observed.map(frame => ({ role: frame.role, contexts: frame.actualRuntime.audioContexts })) };
  });
  await check('SPA navigation preserves one gain layer and unchanged page-owned volume', async () => {
    const previous = tab.urls[0], next = origin + '/normal-root?spa-route=next';
    await frameEval(tab.contentsId, previous, 'history.pushState({},"",' + JSON.stringify(next) + ');true'); tab.urls[0] = next; tab.url = next;
    await invoke('media:get', { id: tab.id }); await invoke('tab:volume', { id: tab.id, volume: .4 });
    const native = await nativeVolumeSamples(tab.contentsId); for (const video of native) assertNear(video.volume, .24, 'SPA native volume must not be multiplied twice');
    const observed = await samples(tab); for (const frame of observed) assert.ok(frame.videos.every(video => video.volume === .6)); return { native };
  });
  await check('native PiP opens a decoded iframe video, continues while another tab is selected, and closes', async () => {
    await Promise.all(tab.urls.map(url => frameEval(tab.contentsId, url, 'fixture.prepare()', true)));
    await Promise.all(tab.urls.map(url => frameEval(tab.contentsId, url, 'fixture.play()', true)));
    await until(async () => (await samples(tab)).every(frame => frame.videos.every(video => video.ready >= 3 && video.width > 0 && video.frames > 0)), 'real decoded video frames', 20000);
    const before = await invoke('media:get', { id: tab.id }); assert.equal(before.videoCount, 4);
    const candidate = before.videos.find(video => video.title === 'cross-video'); assert.ok(candidate?.pipAvailable, 'Cross-origin video must expose real PiP eligibility');
    await frameEval(tab.contentsId, crossOrigin + '/cross-frame', 'fixture.videos[0].currentTime=0;true', true);
    const together = await Promise.all([invoke('tab:pip', { id: tab.id, videoId: candidate.id }), invoke('tab:pip', { id: tab.id, videoId: candidate.id })]);
    assert.ok(together.every(result => result.pipActive), 'A concurrent double click must not enter then immediately exit PiP');
    const opened = await frameEval(tab.contentsId, crossOrigin + '/cross-frame', 'fixture.sample()');
    const event = opened.pipEvents.find(event => event.kind === 'enter'); assert.ok(event && event.width > 0 && event.height > 0, 'Actual PictureInPictureWindow event/dimensions required'); assert.equal(opened.videos[0].pip, true);
    const alternate = await invoke('tab:new');
    assert.equal((await browserState()).activeTabId, alternate.id);
    const start = await frameEval(tab.contentsId, crossOrigin + '/cross-frame', 'fixture.sample()'); await sleep(2600);
    const end = await frameEval(tab.contentsId, crossOrigin + '/cross-frame', 'fixture.sample()');
    assert.equal(end.videos[0].paused, false); assert.equal(end.videos[0].pip, true); assert.ok(end.videos[0].time > start.videos[0].time + .3, 'PiP video clock must advance while another tab is selected'); assert.ok(end.videos[0].frames > start.videos[0].frames + 4, 'Real decoded frames must continue in native PiP');
    if(process.env.ASTER_MEDIA_NATIVE_CAPTURE==='1'){
      fs.writeFileSync(path.join(work,'native-pip-ready.json'),JSON.stringify({pid:app.process().pid,window:event,video:candidate.title},null,2));console.log('NATIVE_PIP_READY');
      await until(()=>fs.existsSync(path.join(work,'native-pip-capture.done')),'native PiP desktop review',55000);
      const desktop=await frameEval(tab.contentsId,crossOrigin+'/cross-frame','fixture.sample()');assert.equal(desktop.videos[0].pip,true);assert.ok(desktop.videos[0].frames>end.videos[0].frames,'PiP decoding continues during native desktop review');
    }
    assert.equal((await invoke('tab:pip', { id: tab.id, videoId: candidate.id })).pipActive, false);
    const closed = await frameEval(tab.contentsId, crossOrigin + '/cross-frame', 'fixture.sample()'); assert.ok(closed.pipEvents.some(event => event.kind === 'leave')); assert.equal(closed.videos[0].pip, false);
    await invoke('tab:close', { id: alternate.id }); await invoke('tab:activate', { id: tab.id });
    return { nativeWindow: event, before: start.videos[0], after: end.videos[0], closed: true };
  });
  await check('private subframes preserve isolation, apply early gain, and never persist a private tab', async () => {
    const privateTab = await createFixture('private-root', true, .4);
    try {
      const isolation = await verifyIsolation(privateTab); for (const frame of isolation.frames) for (const key of ['require','process','aster','ipc','electron']) assert.equal(frame[key], 'undefined');
      const observed = await samples(privateTab); for (const frame of observed) { assert.equal(frame.early.runtimePresent, true); assertNear(frame.early.audioContexts[0].outputGain, .4, 'private early output'); }
      const native = await nativeVolumeSamples(privateTab.contentsId); assert.equal(native.length, 4); for (const video of native) assertNear(video.volume, .24, 'private native media volume');
      await invoke('tab:volume', { id: privateTab.id, volume: .13 }); await sleep(400);
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'browser.json'))); assert.ok(!saved.tabs.some(tab => tab.id === privateTab.id));
      return { isolation, native };
    } finally { await invoke('tab:close', { id: privateTab.id }); }
  });
  await check('fractional per-tab volume survives saved state and an actual browser restart', async () => {
    await invoke('tab:volume', { id: tab.id, volume: .375 }); await invoke('tab:activate', { id: tab.id });
    await until(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'browser.json'))).tabs.find(item => item.id === tab.id)?.volume === .375; } catch { return false; } }, 'saved fractional volume');
    await app.close(); app = null; shell = null; await launch(); await invoke('tab:activate', { id: tab.id }); tab.contentsId = await wcId(tab.id);
    for (const url of tab.urls) await until(() => frameEval(tab.contentsId, url, 'document.readyState === "complete" && Boolean(fixture)'), 'restored media frame');
    assert.equal((await invoke('media:get', { id: tab.id })).volume, .375);
    const observed = await samples(tab); for (const frame of observed) assertNear(frame.early.audioContexts[0].outputGain, .375, 'restored early Web Audio output');
    const native = await nativeVolumeSamples(tab.contentsId); for (const video of native) assertNear(video.volume, .225, 'restored native element volume'); return { volume: .375, native };
  });
  const passed = results.every(result => result.passed);
  fs.writeFileSync(path.join(work, 'media-controls-results.json'), JSON.stringify({ passed, profile, packaged: Boolean(process.env.ASTER_EXECUTABLE), checkedAt: new Date().toISOString(), boundary: 'Real Electron/native media APIs and decoded local WebM; oscillator output deliberately silent; no acoustic loopback/DRM/live external-site assertion', results, diagnostics }, null, 2));
  if (!passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; fs.writeFileSync(path.join(work, 'media-controls-results.json'), JSON.stringify({ passed: false, error: error.stack, results, diagnostics }, null, 2)); })
  .finally(async () => { await app?.close().catch(() => {}); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
