'use strict';
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn}=require('node:child_process');
const assert = require('node:assert/strict');
const {createClient}=require('../bin/client.cjs');
const root = path.resolve(__dirname, '..');
const work = process.env.ASTER_TEST_WORK || path.join(root, 'work', 'backend');
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'backend-'));
const results = [];
const skipNativeFullscreen = process.argv.includes('--skip-native-fullscreen');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 10000) { const start = Date.now(); while (Date.now() - start < ms) { if (await fn()) return; await sleep(80); } throw new Error('Timed out: ' + label); }
let app, window, fixture, config, persistentClient, counter = 0;
async function launch() {
  app = await _electron.launch({ ...(process.env.ASTER_EXECUTABLE ? { executablePath: process.env.ASTER_EXECUTABLE, args: [] } : { args: [root] }), env: { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' }, timeout: 60000 });
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(work, 'backend-stderr.log'), data));
  window = await app.firstWindow(); await window.waitForFunction(() => window.aster);
  config = JSON.parse(fs.readFileSync(path.join(profile, 'automation.json')));
}
const invoke = (command, params = {}) => window.evaluate(({ command, params }) => window.aster.invoke(command, params), { command, params });
const state = () => invoke('state:get');
async function tabBy(id) { return (await state()).tabs.find(t => t.id === id); }
async function waitTab(id, predicate) { await until(async () => predicate(await tabBy(id)), 'tab ' + id); }
async function check(name, fn) {
  if (skipNativeFullscreen && name === 'HTML fullscreen fills the window and restores page framing on exit') {
    results.push({ name, passed: null, pending: true, reason: 'Native fullscreen omitted by explicit diagnostic flag; requires an unlocked desktop' });
    console.log('PENDING', name); return;
  }
  try { const detail = await fn(); results.push({ name, passed: true, detail }); console.log('PASS', name, detail || ''); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message); }
}
async function pageEval(id, expression) {
  return app.evaluate(({ webContents }, { url, expression }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    if (!wc) throw new Error('Missing fixture page ' + url); return wc.executeJavaScript(expression, true);
  }, { url: (await tabBy(id)).url, expression });
}
async function request(route, body, agentId) {
  const response = await fetch(config.endpoint + route, { method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', ...(agentId ? { 'X-Aster-Agent': agentId } : {}) }, body: JSON.stringify(body || {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
async function main() {
  fixture = http.createServer((req, res) => {
    if(req.url.startsWith('/post-target')){let body='';req.on('data',d=>{body+=d});req.on('end',()=>{res.setHeader('Content-Type','text/html');res.end('<title>Popup POST</title><h1 id=post-data>'+body+'</h1>')});return;}
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/b' }); return res.end(); }
    if (req.url.startsWith('/download')) { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="aster-fixture.txt"' }); return res.end('Aster download fixture'); }
    res.setHeader('Content-Type', 'text/html');
    const title = req.url.startsWith('/b') ? 'Page B' : req.url.startsWith('/a') ? 'Page A' : 'Fixture ' + (++counter);
    res.write(`<title>${title}</title><h1>${title}</h1><a id="next" href="/b">Next</a><button id="popup" onclick="window.open('/b')">Popup</button><a id="download" href="/download">Download</a><input id="input"><p id="output">Ready</p><button id="submit" onclick="output.textContent=input.value">Submit</button><button id="full" onclick="document.body.requestFullscreen()">Fullscreen</button><div style="height:4000px"></div>`);
    if (req.url.startsWith('/slow')) { res.flushHeaders(); setTimeout(() => res.end('<p>Finished</p>'), 5000).unref(); } else res.end();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + fixture.address().port;
  await launch();
  process.env.ASTER_CONNECTION=path.join(profile,'automation.json');
  persistentClient=createClient('Persistent audit harness','CLI');await persistentClient.connect();
  const a = await invoke('tab:new', { url: origin + '/a' }); await waitTab(a.id, t => t?.title === 'Page A' && !t.isLoading);
  await check('navigation back, forward, redirect and reload preserve tab state', async () => {
    await invoke('tab:navigate', { id: a.id, url: origin + '/redirect' }); await waitTab(a.id, t => t?.title === 'Page B' && !t.isLoading);
    assert.equal((await tabBy(a.id)).canGoBack, true);
    await invoke('tab:back', { id: a.id }); await waitTab(a.id, t => t?.title === 'Page A');
    assert.equal((await tabBy(a.id)).canGoForward, true);
    await invoke('tab:forward', { id: a.id }); await waitTab(a.id, t => t?.title === 'Page B');
    await invoke('tab:reload', { id: a.id }); await waitTab(a.id, t => t?.title === 'Page B' && !t.isLoading);
  });
  await check('stop-loading terminates a streaming navigation', async () => {
    await invoke('tab:navigate', { id: a.id, url: origin + '/slow' }); await waitTab(a.id, t => t?.isLoading);
    await invoke('tab:stop', { id: a.id }); await waitTab(a.id, t => !t?.isLoading);
  });
  await invoke('tab:navigate', { id: a.id, url: origin + '/a' }); await waitTab(a.id, t => t?.title === 'Page A' && !t.isLoading);
  await check('popup opens a new normal browser tab', async () => {
    const count = (await state()).tabs.length;
    await pageEval(a.id, "document.querySelector('#popup').click();true");
    await until(async () => (await state()).tabs.length === count + 1, 'popup tab');
  });
  await check('script-opened tabs retain opener messaging and window.close removes only their tab',async()=>{
    const handle=await pageEval(a.id,"window.auditPopup=window.open('/b?opener');Boolean(window.auditPopup)");assert.equal(handle,true,'window.open returned null despite creating a tab');
    await until(()=>app.evaluate(async({webContents},url)=>{const wc=webContents.getAllWebContents().find(w=>w.getURL()===url);return wc?await wc.executeJavaScript('Boolean(window.opener)'):false},origin+'/b?opener'),'popup opener present');
    const child=(await state()).tabs.find(t=>t.url===origin+'/b?opener');assert.ok(child);
    await pageEval(a.id,"window.auditMessage=null;window.addEventListener('message',e=>window.auditMessage=e.data);true");
    await pageEval(child.id,"window.opener.postMessage('popup-roundtrip',location.origin);true");await until(async()=>await pageEval(a.id,'window.auditMessage')==='popup-roundtrip','opener postMessage');
    await pageEval(child.id,'window.close();undefined').catch(()=>{});await until(async()=>!(await state()).tabs.some(t=>t.id===child.id),'popup tab close');assert.ok((await state()).tabs.some(t=>t.id===a.id));
  });
  await check('about:blank popup bootstrap navigates with an opener',async()=>{
    assert.equal(await pageEval(a.id,"(()=>{const child=window.open('about:blank');if(!child)return false;child.location.href='/b?bootstrap';return true})()"),true);
    await until(async()=>(await state()).tabs.some(t=>t.url===origin+'/b?bootstrap'&&t.title==='Page B'),'blank popup navigated');
    const child=(await state()).tabs.find(t=>t.url===origin+'/b?bootstrap');assert.equal(await pageEval(child.id,'Boolean(window.opener)'),true);await invoke('tab:close',{id:child.id});
  });
  await check('popup feature strings cannot weaken sandbox or enable Node',async()=>{
    assert.equal(await pageEval(a.id,"Boolean(window.open('/b?unsafe-popup','','nodeIntegration=yes,nodeIntegrationInWorker=yes,contextIsolation=no,sandbox=no,webSecurity=no,webviewTag=yes'))"),true);
    await until(async()=>(await state()).tabs.some(t=>t.url===origin+'/b?unsafe-popup'&&t.title==='Page B'),'security popup loaded');const child=(await state()).tabs.find(t=>t.url===origin+'/b?unsafe-popup');const preferences=await app.evaluate(({webContents},url)=>{const p=webContents.getAllWebContents().find(w=>w.getURL()===url).getLastWebPreferences();return {nodeIntegration:p.nodeIntegration,nodeIntegrationInWorker:p.nodeIntegrationInWorker,contextIsolation:p.contextIsolation,sandbox:p.sandbox,webSecurity:p.webSecurity,webviewTag:p.webviewTag}},origin+'/b?unsafe-popup');assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.nodeIntegrationInWorker,false);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.sandbox,true);assert.equal(preferences.webSecurity,true);assert.equal(preferences.webviewTag,false);assert.equal(await pageEval(child.id,'typeof require+\":\"+typeof process+\":\"+typeof window.aster'),'undefined:undefined:undefined');await invoke('tab:close',{id:child.id});return preferences;
  });
  await check('POST form popup carries submitted body into the new tab',async()=>{
    await pageEval(a.id,"(()=>{const f=document.createElement('form');f.method='POST';f.action='/post-target';f.target='audit-post';const i=document.createElement('input');i.name='answer';i.value='forty-two';f.append(i);document.body.append(f);f.submit();return true})()");
    await until(async()=>(await state()).tabs.some(t=>t.title==='Popup POST'),'POST popup load');const child=(await state()).tabs.find(t=>t.title==='Popup POST');assert.equal(await pageEval(child.id,"document.querySelector('#post-data').textContent"),'answer=forty-two');await invoke('tab:close',{id:child.id});
  });
  await check('private popups share their private opener session without leaking to normal tabs',async()=>{
    const privateTab=await invoke('tab:new',{url:origin+'/a?private-parent',private:true});await waitTab(privateTab.id,t=>t?.title==='Page A'&&!t.isLoading);
    assert.equal(await pageEval(privateTab.id,"document.cookie='private-popup=secret;path=/';Boolean(window.open('/b?private-popup'))"),true);
    await until(async()=>(await state()).tabs.some(t=>t.url===origin+'/b?private-popup'&&t.title==='Page B'),'private popup load');const child=(await state()).tabs.find(t=>t.url===origin+'/b?private-popup');assert.equal(child.private,true);assert.ok((await pageEval(child.id,'document.cookie')).includes('private-popup=secret'));assert.ok(!(await pageEval(a.id,'document.cookie')).includes('private-popup'));await invoke('tab:close',{id:child.id});await invoke('tab:close',{id:privateTab.id});
  });
  await check('download completes with correct path, byte count and file content', async () => {
    const destination = path.join(profile, 'aster-fixture.txt');
    await app.evaluate(({ session }, destination) => session.fromPartition('persist:aster').once('will-download', (_event, item) => item.setSavePath(destination)), destination);
    await pageEval(a.id, "document.querySelector('#download').click();true");
    await until(async () => (await state()).downloads.some(d => d.state === 'completed'), 'download completed');
    const item = (await state()).downloads.find(d => d.state === 'completed');
    assert.equal(item.path, destination); assert.equal(fs.readFileSync(destination, 'utf8'), 'Aster download fixture'); assert.equal(item.received, 22);
  });
  await check('Blob downloads work without blocked native navigation',async()=>{
    const destination=path.join(profile,'aster-blob.txt');await app.evaluate(({session},destination)=>session.fromPartition('persist:aster').once('will-download',(_event,item)=>item.setSavePath(destination)),destination);
    await pageEval(a.id,"(()=>{let a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Blob fixture'],{type:'text/plain'}));a.download='aster-blob.txt';a.click();return true})()");await until(()=>fs.existsSync(destination),'blob download');assert.equal(fs.readFileSync(destination,'utf8'),'Blob fixture');
  });
  await check('crashed page offers visible recovery and reload restores the page', async () => {
    await invoke('tab:activate', { id: a.id });
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(w => w.getURL() === url).forcefullyCrashRenderer(), origin + '/a');
    await waitTab(a.id, t => Boolean(t?.error));
    const viewVisible = await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents?.getURL()===url).some(v=>v.getVisible()), origin + '/a');
    assert.equal(viewVisible,false,'Crashed native page still covers the shell error/recovery UI');
    await window.waitForSelector('.error-page',{state:'visible'});
    const text = await window.locator('body').innerText();
    assert.match(text, /Page stopped|crash|reload|Reload|stopped unexpectedly|Something went wrong/i);
    await window.locator('.error-page button').click(); await waitTab(a.id, t => t?.title === 'Page A' && !t.error && !t.isLoading);
  });
  await check('recovering a failed navigation clears error after a valid URL', async () => {
    await invoke('tab:navigate', { id: a.id, url: 'http://127.0.0.1:1/' }); await waitTab(a.id, t => Boolean(t?.error));
    await invoke('tab:navigate', { id: a.id, url: origin + '/a' }); await waitTab(a.id, t => t?.title === 'Page A' && !t.error && !t.isLoading);
  });
  await check('removing an active workspace moves its tabs into Personal', async () => {
    const ws = await invoke('workspace:add', { name: 'Temporary' }); const t = await invoke('tab:new', { workspace: ws.id, url: origin + '/b' });
    await invoke('workspace:delete', { id: ws.id }); const current = await state(); assert.equal(current.activeWorkspace, 'personal'); assert.equal(current.tabs.find(x => x.id === t.id).workspace, 'personal');
  });
  await check('page zoom changes web content while chrome stays at actual size',async()=>{
    await invoke('tab:activate',{id:a.id});assert.equal(await invoke('page:zoom',{delta:0.2}),1.2);
    const zoom=await app.evaluate(({BrowserWindow,webContents},url)=>({page:webContents.getAllWebContents().find(w=>w.getURL()===url).getZoomFactor(),chrome:BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()}),origin+'/a');
    assert.equal(Math.round(zoom.page*10)/10,1.2);assert.equal(zoom.chrome,1);assert.equal(await invoke('page:zoom',{reset:true}),1);
  });
  await check('HTML fullscreen fills the window and restores page framing on exit',async()=>{
    await invoke('tab:activate',{id:a.id});
    await app.evaluate(({app,BrowserWindow,webContents},url)=>{app.focus({steal:true});const win=BrowserWindow.getAllWindows()[0];win.show();win.focus();webContents.getAllWebContents().find(w=>w.getURL()===url).focus();},origin+'/a');
    await until(()=>app.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getFocusedWindow())),'native fullscreen requires an unlocked, focused Mac window');
    // Exercise the real user/agent input path. Awaiting requestFullscreen's
    // promise through the Node Inspector can stall its native transition.
    try{await persistentClient.command('page.click',{tabId:a.id,selector:'#full'});
    await until(()=>pageEval(a.id,'Boolean(document.fullscreenElement)'),'HTML fullscreen entry');
    await until(()=>app.evaluate(({BrowserWindow},url)=>{const win=BrowserWindow.getAllWindows()[0],view=win.contentView.children.find(v=>v.webContents?.getURL()===url);const b=view.getBounds(),[width,height]=win.getContentSize();return win.isFullScreen()&&b.x===0&&b.y===0&&Math.abs(b.width-width)<=1&&Math.abs(b.height-height)<=1},origin+'/a'),'fullscreen native window and view bounds');
    await persistentClient.command('page.key',{tabId:a.id,key:'Escape'});await until(()=>app.evaluate(({BrowserWindow},url)=>{const view=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.getURL()===url);return view.getBounds().y===86},origin+'/a'),'agent Escape restored page framing');
    }finally{await persistentClient.command('tabs.release',{tabId:a.id}).catch(()=>{});await pageEval(a.id,'if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});true').catch(()=>{});}
  });
  await check('rapid background navigation cannot dismiss the human foreground menu',async()=>{
    await invoke('tab:activate',{id:a.id});
    const bg=await invoke('tab:new',{url:origin+'/b'});await invoke('tab:activate',{id:a.id});
    await window.locator('.more-button').click();await window.waitForSelector('#floating:not(.hidden)');
    await Promise.all(Array.from({length:20},(_,i)=>invoke('tab:navigate',{id:bg.id,url:origin+'/a?background='+i})));
    const visible=await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents?.getURL()===url).some(v=>v.getVisible()),origin+'/a');assert.equal(visible,false,'Background tab navigation unhid the active page over the menu');assert.equal(await window.locator('#floating').isVisible(),true);await window.keyboard.press('Escape');await window.waitForSelector('#floating',{state:'hidden'});
  });
  const one = (await request('/connect', { name: 'Audit One' })).agentId; const two = (await request('/connect', { name: 'Audit Two' })).agentId;
  const run = async (action, params = {}, agentId = one) => (await request('/command', { action, params }, agentId)).result;
  await check('concurrent agents reject conflicts then release ownership on disconnect', async () => {
    await run('tabs.claim', { tabId: a.id }); await assert.rejects(run('tabs.navigate', { tabId: a.id, url: origin + '/b' }, two), /claimed/);
    await request('/disconnect', {}, one); await run('tabs.claim', { tabId: a.id }, two); await run('tabs.release', { tabId: a.id }, two);
  });
  await check('bad agent actions cannot acquire a tab claim', async () => {
    await assert.rejects(run('tabs.invalid-action', { tabId: a.id }, two), /Unknown/);
    const t = (await run('tabs.list', {}, two)).find(t => t.id === a.id); assert.equal(t.claim, null);
  });
  await check('permission grants are remembered within the browser session',async()=>{
    await invoke('tab:activate',{id:a.id});await invoke('tab:navigate',{id:a.id,url:origin+'/a'});await waitTab(a.id,t=>t?.title==='Page A'&&!t.isLoading);
    await app.evaluate(({dialog})=>{globalThis.auditOriginalDialog=dialog.showMessageBox;globalThis.auditPermissionDialogs=0;dialog.showMessageBox=async()=>{globalThis.auditPermissionDialogs++;return {response:1}}});
    try{const first=await pageEval(a.id,"Notification.requestPermission()");const query=await pageEval(a.id,"navigator.permissions.query({name:'notifications'}).then(p=>p.state)");const second=await pageEval(a.id,"Notification.requestPermission()");const dialogs=await app.evaluate(()=>globalThis.auditPermissionDialogs);console.log('Permission details',{first,query,second,dialogs});assert.equal(first,'granted','Initial grant failed');assert.equal(query,'granted','Granted permission query reports denied');assert.equal(second,'granted','Second request failed');assert.equal(dialogs,1,'Permission was prompted repeatedly');return {first,query,dialogs};}finally{await app.evaluate(({dialog})=>{dialog.showMessageBox=globalThis.auditOriginalDialog;delete globalThis.auditOriginalDialog;});}
  });
  await check('MCP EOF drains pending calls and disconnects its agent',async()=>{
    const mcp=spawn(process.execPath,[path.join(root,'bin/aster-mcp.cjs')],{env:{...process.env,ASTER_CONNECTION:path.join(profile,'automation.json'),ASTER_AGENT_NAME:'EOF regression'},stdio:['pipe','pipe','pipe']});let output='';mcp.stdout.on('data',d=>{output+=d});mcp.stdin.end(JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'EOF regression',version:'1'}}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser_tabs',arguments:{}}})+'\n');await Promise.race([new Promise(resolve=>mcp.once('exit',resolve)),sleep(10000).then(()=>{mcp.kill();throw Error('MCP failed to exit after EOF')})]);assert.ok(output.includes('\"id\":1'),'Pending MCP call was lost');assert.ok(!(await state()).agents.some(a=>a.name==='EOF regression'),'MCP left a ghost agent after EOF');
  });
  await check('reopening a closed pinned and muted tab restores its properties',async()=>{
    const t=await invoke('tab:new',{url:origin+'/b?restore'});await invoke('tab:pin',{id:t.id});await invoke('tab:mute',{id:t.id});await invoke('tab:close',{id:t.id});const restored=await invoke('tab:restore');assert.equal(restored.pinned,true,'Reopened tab lost pinned state');assert.equal(restored.muted,true,'Reopened tab lost mute state');
  });
  await check('main chrome renderer reload preserves browser and control connections', async () => {
    await window.reload(); await window.waitForFunction(() => window.aster); assert.ok((await state()).tabs.some(t => t.id === a.id));
  });
  await check('completed downloads persist across app relaunch', async () => {
    await app.close(); app = null; await launch(); assert.ok((await state()).downloads.some(d => d.state === 'completed' && d.name === 'aster-fixture.txt'));
  });
  await check('persistent harness reconnects after browser restart and token rotation',async()=>{assert.ok(Array.isArray(await persistentClient.command('tabs.list')));});
  await check('restoreSession=false starts clean without losing bookmarks', async () => {
    await invoke('bookmark:toggle', { title: 'Fixture', url: origin + '/a' }); await invoke('settings:update', { restoreSession: false });
    await app.close(); app = null; await launch(); const s = await state(); assert.equal(s.tabs.length, 1); assert.equal(s.tabs[0].url, 'aster://newtab'); assert.ok(s.bookmarks.some(b => b.url === origin + '/a'));
  });
  await check('chrome renderer crash automatically restores browser controls',async()=>{
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();});
    await until(()=>app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].webContents.isCrashed()),'chrome renderer recovered',5000);
    await until(()=>app.evaluate(async({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0].webContents;try{return await wc.executeJavaScript('Boolean(window.aster && document.querySelector(\"#address\"))')}catch{return false}}),'chrome controls reloaded');
    const recovered=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.aster.invoke(\"state:get\")'));assert.ok(recovered.tabs.length>0);
  });
  const record = { checkedAt: new Date().toISOString(), profile, passed: results.every(r => r.passed === true), nonNativePassed: results.filter(r => !r.pending).every(r => r.passed === true), results };
  fs.writeFileSync(path.join(work, 'backend-results.json'), JSON.stringify(record, null, 2));
  if (!record.passed) process.exitCode = record.nonNativePassed ? 2 : 1;
}
main().catch(error => { console.error(error.stack); fs.writeFileSync(path.join(work, 'backend-results.json'), JSON.stringify({ passed: false, error: error.stack, results }, null, 2)); process.exitCode = 1; }).finally(async () => { await persistentClient?.disconnect(); await app?.close(); fixture?.close(); });
