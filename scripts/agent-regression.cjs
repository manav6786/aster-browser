'use strict';
// Launches the real executable. Deliberately does not import Playwright, attach
// an Inspector, enable automation flags, or touch the user's browser profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const work = path.resolve(process.env.ASTER_TEST_WORK || path.join(root, 'work', 'agents'));
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'normal-agent-'));
const results = [];
const signals = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, fixture, config, origin, crossOrigin, one, two, humanId, capabilities, heartbeat;
let stdout = '', stderr = '';
const createdTabs = new Set();

async function until(read, label, timeoutMs = 10000) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeoutMs) {
    last = await read();
    if (last) return last;
    if (app && (app.exitCode !== null || app.signalCode !== null)) throw new Error(`Aster exited before ${label}: ${stderr.slice(-2000)}`);
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function request(route, body, agentId, options = {}) {
  const response = await fetch(config.endpoint + route, {
    method: options.method || 'POST',
    headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', ...(agentId ? { 'X-Aster-Agent': agentId } : {}), ...options.headers },
    ...(options.method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status; error.details = data.details; throw error;
  }
  return data;
}
function client(id) { return (action, params = {}) => request('/command', { action, params }, id).then(value => value.result); }
const state = () => one('browser.state');
const evaluate = (id, expression, extra = {}) => one('page.evaluate', { tabId: id, expression, ...extra });
async function create(run, suffix = '/controls', extra = {}) {
  const tab = await run('tabs.create', { url: origin + suffix, active: false, ...extra });
  createdTabs.add(tab.id);
  await until(async () => {
    const item = (await one('tabs.list')).find(t => t.id === tab.id);
    return item && !item.isLoading && item.url.startsWith(origin + suffix.split('?')[0]) && !item.error;
  }, 'tab load ' + suffix);
  await until(async () => (await run('page.evaluate', { tabId: tab.id, expression: 'document.readyState' })) === 'complete', 'document complete');
  return tab;
}
async function activeUnchanged() { assert.equal((await state()).activeTabId, humanId, 'Agent work switched the human-selected tab'); }
async function check(name, fn) {
  const start = performance.now();
  try { const detail = await fn(); await activeUnchanged(); results.push({ name, passed: true, durationMs: Math.round(performance.now() - start), ...(detail ? { detail } : {}) }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, durationMs: Math.round(performance.now() - start), error: error.message, ...(error.details ? { details: error.details } : {}) }); console.error('FAIL', name, error.message); }
}

function html(suffix, query) {
  if (suffix === '/human') return '<!doctype html><title>Human workspace</title><h1>Human workspace</h1><input id="human-draft" value="Human draft stays here">';
  if (suffix.startsWith('/old/')) return `<!doctype html><title>Legacy ${suffix.endsWith('/b') ? 'B' : 'A'}</title><h1>Legacy navigation</h1><a id="next" href="/old/b">Next</a>`;
  if (suffix === '/frame') {
    const kind = query.get('kind') || 'same';
    return `<!doctype html><title>${kind} frame</title><style>body{padding:20px;font:16px system-ui}button,input{font:inherit;margin:5px;padding:6px}</style><h2>${kind} frame</h2><label>Frame input<input id="frame-input"></label><button id="frame-go">Run ${kind} frame</button><output id="frame-count">0</output><script>let count=0;document.querySelector('#frame-go').addEventListener('click',e=>{count++;document.querySelector('#frame-count').textContent=String(count);parent.postMessage({regressionFrame:true,kind:${JSON.stringify(kind)},count,value:document.querySelector('#frame-input').value,trusted:e.isTrusted},'*');});</script>`;
  }
  return `<!doctype html><meta charset="utf-8"><title>Agent controls</title>
  <style>body{font:16px system-ui;margin:0;padding:32px;min-height:2600px}button,input,select{font:inherit;padding:8px;margin:7px}button{min-height:38px}section{margin:12px 0}#blocker{position:fixed;inset:0;z-index:999;background:rgba(80,80,100,.2);display:none}iframe{width:430px;height:240px;border:7px solid #b8aec9;margin:10px 0 24px 73px;display:block}.frames-wrap{margin-top:420px;transform:translate(19px,11px)}</style>
  <h1>Real background agent controls</h1><button id="increment">Cold increment</button><output id="count">0</output>
  <section><label>Text input<input id="text" aria-label="Text input"></label><label><input type="checkbox" id="check">Allow fixture</label><select id="choice" aria-label="Fixture option"><option value="one">One</option><option value="two">Two</option></select></section>
  <section><button id="disabled" disabled>Delayed enable</button><button id="covered">Covered button</button><button class="ambiguous">Ambiguous one</button><button class="ambiguous">Ambiguous two</button><button id="replace-me">Replaceable control</button></section>
  <div id="open-host"></div><div id="closed-host"></div><div id="batch-gate" hidden>Gate ready</div><div id="blocker"></div>
  <div class="frames-wrap"><iframe name="same" title="Same-origin frame" src="${origin}/frame?kind=same"></iframe><iframe name="cross" title="Cross-site frame" src="${crossOrigin}/frame?kind=cross"></iframe></div>
  <script>
  const r=window.regression={count:0,events:[],disabledClicks:0,coveredClicks:0,replacedClicks:0,openClicks:0,closedClicks:0,closedValue:'',frames:{},queue:[]};
  const event=e=>({id:e.target.id,type:e.type,trusted:e.isTrusted,at:Date.now(),visibility:document.visibilityState,focused:document.hasFocus()});
  document.querySelector('#increment').addEventListener('click',e=>{r.count++;r.events.push(event(e));document.querySelector('#count').textContent=String(r.count);});
  for(const id of ['text','check','choice'])document.querySelector('#'+id).addEventListener('input',e=>r.events.push(event(e)));
  document.querySelector('#disabled').addEventListener('click',e=>{r.disabledClicks++;r.disabledEvent=event(e);});
  document.querySelector('#covered').addEventListener('click',e=>{r.coveredClicks++;r.coveredEvent=event(e);});
  document.querySelector('#replace-me').addEventListener('click',()=>r.replacedClicks++);
  window.armDisabled=ms=>{document.querySelector('#disabled').disabled=true;r.disabledEnabledAt=null;setTimeout(()=>{r.disabledEnabledAt=Date.now();document.querySelector('#disabled').disabled=false},ms);return true;};
  window.armOverlay=ms=>{document.querySelector('#blocker').style.display='block';r.overlayRemovedAt=null;setTimeout(()=>{r.overlayRemovedAt=Date.now();document.querySelector('#blocker').style.display='none'},ms);return true;};
  window.armBatch=ms=>{document.querySelector('#batch-gate').hidden=true;r.queue=[];setTimeout(()=>document.querySelector('#batch-gate').hidden=false,ms);return true;};
  const open=document.querySelector('#open-host').attachShadow({mode:'open'});open.innerHTML='<label>Open shadow text<input id="open-input" aria-label="Open shadow text"></label><button id="open-go">Open shadow run</button>';
  open.querySelector('button').addEventListener('click',e=>{r.openClicks++;r.openValue=open.querySelector('input').value;r.openTrusted=e.isTrusted;});
  const closed=document.querySelector('#closed-host').attachShadow({mode:'closed'});closed.innerHTML='<label>Closed shadow text<input aria-label="Closed shadow text"></label><button>Closed shadow run</button>';
  closed.querySelector('input').addEventListener('input',e=>r.closedValue=e.target.value);closed.querySelector('button').addEventListener('click',e=>{r.closedClicks++;r.closedTrusted=e.isTrusted;});
  window.addEventListener('message',e=>{if(e.data&&e.data.regressionFrame)r.frames[e.data.kind]=e.data;});
  </script>`;
}

async function launch() {
  fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/signal') { signals.add(url.searchParams.get('key')); res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.end(html(url.pathname, url.searchParams));
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + fixture.address().port;
  crossOrigin = 'http://localhost:' + fixture.address().port;
  let executable = process.env.ASTER_EXECUTABLE || require('electron');
  if (executable.endsWith('.app')) executable = path.join(executable, 'Contents', 'MacOS', 'Aster');
  const args = process.env.ASTER_EXECUTABLE ? [] : [root];
  const env = { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.once('error', error => { stderr += '\n' + error.message; });
  app.stdout.on('data', data => { stdout += data; }); app.stderr.on('data', data => { stderr += data; });
  await until(() => fs.existsSync(path.join(profile, 'automation.json')), 'normal-launch automation endpoint', 45000);
  config = JSON.parse(fs.readFileSync(path.join(profile, 'automation.json'), 'utf8'));
  assert.equal(config.pid, app.pid, 'Connection file must belong to this isolated executable');
  assert.equal(new URL(config.endpoint).hostname, '127.0.0.1');
  const first = (await request('/connect', { name: 'Regression Researcher', transport: 'normal regression' })).agentId;
  const second = (await request('/connect', { name: 'Regression Builder', transport: 'normal regression' })).agentId;
  one = client(first); two = client(second); one.id = first; two.id = second;
  heartbeat = setInterval(() => { request('/heartbeat', {}, first).catch(() => {}); request('/heartbeat', {}, second).catch(() => {}); }, 20000);
  heartbeat.unref();
  humanId=(await state()).activeTabId;
  await check('fresh browser accepts trusted hidden-tab input before any foreground website exists', async () => {
    const activeId=(await state()).activeTabId;
    const startup=await create(one,'/controls?case=startup');
    const before=await evaluate(startup.id,'({visibility:document.visibilityState,focused:document.hasFocus()})');
    await one('page.type',{tabId:startup.id,selector:'#text',text:'Fresh background input'});
    await one('page.click',{tabId:startup.id,selector:'#increment'});
    const after=await evaluate(startup.id,'({count:regression.count,events:regression.events,value:document.querySelector("#text").value})');
    assert.equal(after.value,'Fresh background input');assert.equal(after.count,1);assert.equal(after.events.filter(e=>e.type==='click').length,1);assert.ok(after.events.every(e=>e.trusted));
    assert.equal((await state()).activeTabId,activeId);
    await one('tabs.close',{tabId:startup.id});createdTabs.delete(startup.id);
    return {before,after,selectedTabPreserved:true};
  });
  const human = await create(one, '/human', { active: true }); humanId = human.id;
  capabilities = await one('browser.capabilities');
  return { executable, args, pid: app.pid, health: await request('/health', null, first, { method: 'GET' }) };
}

async function main() {
  const launchInfo = await launch();
  let cold, parallel;
  await check('cold hidden input has a trusted effect, resets visibility and preserves human focus', async () => {
    cold = await create(one, '/controls?case=cold');
    const before = await evaluate(cold.id, '({visibility:document.visibilityState,focused:document.hasFocus(),count:regression.count,webdriver:navigator.webdriver})');
    assert.equal(before.visibility, 'hidden', 'Fixture must be genuinely hidden before its first pointer action');
    assert.equal(before.count, 0); assert.equal(before.webdriver, false);
    const humanFocusedBefore=await evaluate(humanId,'document.hasFocus()');
    await one('page.click', { tabId: cold.id, selector: '#increment' });
    const after = await until(async () => {
      const value = await evaluate(cold.id, '({count:regression.count,events:regression.events,visibility:document.visibilityState,focused:document.hasFocus()})');
      assert.ok(value.count <= 1, 'A single cold click must not be replayed');
      // A newly loaded hidden document can initially report focused=true even
      // while its owner window is unfocused. It may become unfocused on cleanup;
      // it must never acquire focus, remain visible, or change the human page.
      return value.count === 1 && value.visibility === before.visibility && (before.focused || !value.focused) && value;
    }, 'renderer lifecycle restoration');
    assert.equal(after.count, 1); assert.equal(after.events.length, 1); assert.equal(after.events[0].trusted, true); assert.equal(after.events[0].id, 'increment');
    const humanFocusedAfter=await evaluate(humanId,'document.hasFocus()');assert.equal(humanFocusedAfter,humanFocusedBefore);
    return { before, after, humanFocusedBefore,humanFocusedAfter };
  });
  if (!cold) throw new Error('Background fixture was not created');
  await check('two connected agents work in independent tabs concurrently without selecting them', async () => {
    parallel = await create(two, '/controls?case=parallel');
    async function sequence(run, tab, prefix) {
      for (let i = 0; i < 5; i++) { await run('page.type', { tabId: tab.id, selector: '#text', text: prefix + i }); await run('page.click', { tabId: tab.id, selector: '#increment' }); }
      return run('page.evaluate', { tabId: tab.id, expression: '({value:document.querySelector("#text").value,count:regression.count,clicks:regression.events.filter(e=>e.id==="increment")})' });
    }
    const [a,b] = await Promise.all([sequence(one,cold,'Researcher '),sequence(two,parallel,'Builder ')]);
    assert.equal(a.value,'Researcher 4');assert.equal(b.value,'Builder 4');assert.equal(a.count,6);assert.equal(b.count,5);assert.ok([...a.clicks,...b.clicks].every(e=>e.trusted));
    assert.equal(await evaluate(humanId, 'document.querySelector("#human-draft").value'), 'Human draft stays here');
    return {firstCount:a.count,secondCount:b.count};
  });
  await check('exclusive claims reject another agent without duplicating a click', async () => {
    await assert.rejects(two('page.click',{tabId:cold.id,selector:'#increment'}),/claimed|owner|lease/i);
    assert.equal(await evaluate(cold.id,'regression.count'),6);
  });
  await check('click waits for disabled controls and a real overlay to clear', async () => {
    await evaluate(cold.id,'armDisabled(240)');
    await one('page.click',{tabId:cold.id,selector:'#disabled',timeoutMs:5000});
    const enabled=await evaluate(cold.id,'({count:regression.disabledClicks,event:regression.disabledEvent,enabledAt:regression.disabledEnabledAt})');
    assert.equal(enabled.count,1);assert.equal(enabled.event.trusted,true);assert.ok(enabled.event.at>=enabled.enabledAt);
    await evaluate(cold.id,'armOverlay(300)');
    await one('page.click',{tabId:cold.id,selector:'#covered',timeoutMs:5000});
    const uncovered=await evaluate(cold.id,'({count:regression.coveredClicks,event:regression.coveredEvent,removedAt:regression.overlayRemovedAt})');
    assert.equal(uncovered.count,1);assert.equal(uncovered.event.trusted,true);assert.ok(uncovered.event.at>=uncovered.removedAt);
    return {enabled,uncovered};
  });
  await check('ambiguous selectors reject instead of silently choosing the first match', async () => {
    await assert.rejects(one('page.click',{tabId:cold.id,selector:'.ambiguous',timeoutMs:500}),/ambiguous|strict|multiple|matched\s+2|2\s+elements/i);
  });
  await check('role and name locators wait for insertion and recognize later removal',async()=>{
    await evaluate(cold.id,`setTimeout(()=>{const b=document.createElement('button');b.id='late-role';b.textContent='Late semantic control';b.onclick=()=>b.remove();document.body.prepend(b)},180);true`);
    await one('page.click',{tabId:cold.id,role:'button',name:'Late semantic control',timeoutMs:4000});
    await one('page.waitFor',{tabId:cold.id,role:'button',name:'Late semantic control',state:'detached',timeoutMs:3000});
  });
  await check('typing, checkbox state and select values have verified page effects', async () => {
    await one('page.type',{tabId:cold.id,selector:'#text',text:'Seed value'});
    await one('page.type',{tabId:cold.id,selector:'#text',text:'Aster Ω'});
    await one('page.waitFor',{tabId:cold.id,selector:'#text',value:'Aster Ω',timeoutMs:3000});
    await one('page.check',{tabId:cold.id,selector:'#check',checked:true});
    await one('page.select',{tabId:cold.id,selector:'#choice',values:['two']});
    let value=await evaluate(cold.id,'({text:document.querySelector("#text").value,checked:document.querySelector("#check").checked,choice:document.querySelector("#choice").value,checkEvents:regression.events.filter(e=>e.id==="check")})');
    assert.equal(value.text,'Aster Ω');assert.equal(value.checked,true);assert.equal(value.choice,'two');assert.equal(value.checkEvents.at(-1).trusted,true);
    await one('page.check',{tabId:cold.id,selector:'#check',checked:false});
    assert.equal(await evaluate(cold.id,'document.querySelector("#check").checked'),false);
    return value;
  });
  await check('frame IDs target same-origin and cross-site iframe controls at their true coordinates', async () => {
    const frames=await one('page.frames',{tabId:cold.id});assert.ok(Array.isArray(frames));
    const main=frames.find(f=>f.main),same=frames.find(f=>f.name==='same'),cross=frames.find(f=>f.name==='cross');
    assert.ok(main&&same&&cross,'Frame inventory must include both authored children');assert.equal(same.parentId,main.id);assert.equal(cross.parentId,main.id);
    assert.notEqual(new URL(cross.url).origin,new URL(main.url).origin);
    for(const frame of [same,cross]){
      await one('page.type',{tabId:cold.id,frameId:frame.id,selector:'#frame-input',text:'Frame '+frame.name});
      await one('page.click',{tabId:cold.id,frameId:frame.id,selector:'#frame-go'});
      await one('page.waitFor',{tabId:cold.id,frameId:frame.id,selector:'#frame-count',text:'1',timeoutMs:5000});
      const report=await until(()=>evaluate(cold.id,`regression.frames[${JSON.stringify(frame.name)}]`),'child postMessage effect');
      assert.equal(report.count,1);assert.equal(report.value,'Frame '+frame.name);assert.equal(report.trusted,true);
    }
    const inspected=await one('page.inspect',{tabId:cold.id});const target=inspected.elements.find(e=>e.role==='button'&&e.name==='Run cross frame');
    assert.ok(target?.ref);assert.equal(target.frameId,cross.id);
    await one('page.click',{tabId:cold.id,ref:target.ref});
    await until(async()=>await evaluate(cold.id,'regression.frames.cross?.count')===2,'cross-site AX-reference click');
    assert.equal(await evaluate(cold.id,'regression.frames.cross.trusted'),true);
    return {frames,note:'Cross-site origin boundary verified; process IDs are not exposed by this public frame inventory.'};
  });
  await check('open shadow selectors and closed shadow AX references operate real controls', async () => {
    await one('page.type',{tabId:cold.id,selector:'#open-host >>> #open-input',text:'Open shadow value'});
    await one('page.click',{tabId:cold.id,selector:'#open-host >>> #open-go'});
    assert.equal(await evaluate(cold.id,'regression.openValue'),'Open shadow value');assert.equal(await evaluate(cold.id,'regression.openTrusted'),true);
    assert.equal(await evaluate(cold.id,'document.querySelector("#closed-host").shadowRoot'),null);
    const view=await one('page.inspect',{tabId:cold.id});const button=view.elements.find(e=>e.role==='button'&&e.name==='Closed shadow run');const input=view.elements.find(e=>e.role==='textbox'&&e.name==='Closed shadow text');
    assert.ok(button?.ref&&input?.ref,'Closed shadow controls must have usable AX references');
    await one('page.type',{tabId:cold.id,ref:input.ref,text:'Closed shadow value'});await one('page.click',{tabId:cold.id,ref:button.ref});
    const closed=await evaluate(cold.id,'({count:regression.closedClicks,value:regression.closedValue,trusted:regression.closedTrusted})');assert.deepEqual(closed,{count:1,value:'Closed shadow value',trusted:true});return closed;
  });
  await check('iframe targets wait for parent overlays and never click through a persistent cover',async()=>{
    const frames=await one('page.frames',{tabId:cold.id});
    for(const frame of frames.filter(f=>['same','cross'].includes(f.name))){
      const before=Number(await evaluate(cold.id,'document.querySelector("#frame-count").textContent',{frameId:frame.id}));
      await evaluate(cold.id,'armOverlay(220)');
      await one('page.click',{tabId:cold.id,frameId:frame.id,selector:'#frame-go',timeoutMs:4000});
      await one('page.waitFor',{tabId:cold.id,frameId:frame.id,selector:'#frame-count',text:String(before+1),timeoutMs:3000});
      await evaluate(cold.id,'armOverlay(3000)');
      await assert.rejects(one('page.click',{tabId:cold.id,frameId:frame.id,selector:'#frame-go',timeoutMs:180}),/timed out|covered|actionable/i);
      assert.equal(Number(await evaluate(cold.id,'document.querySelector("#frame-count").textContent',{frameId:frame.id})),before+1);
      await evaluate(cold.id,'document.querySelector("#blocker").style.display="none";true');
    }
  });
  await check('node replacement and navigation invalidate earlier AX references', async () => {
    const inspected=await one('page.inspect',{tabId:cold.id});const target=inspected.elements.find(e=>e.role==='button'&&e.name==='Replaceable control');assert.ok(target?.ref);
    await evaluate(cold.id,'(()=>{const node=document.querySelector("#replace-me");node.replaceWith(node.cloneNode(true));return true})()');
    await assert.rejects(one('page.click',{tabId:cold.id,ref:target.ref,timeoutMs:500}),/stale|detached|reference|not found|node/i);
    assert.equal(await evaluate(cold.id,'regression.replacedClicks'),0);
    const tab=await create(one,'/controls?case=stale-navigation');const old=(await one('page.inspect',{tabId:tab.id})).elements.find(e=>e.role==='button'&&e.name==='Cold increment');assert.ok(old?.ref);
    await one('tabs.navigate',{tabId:tab.id,url:origin+'/controls?case=new-document'});
    await until(async()=>{const item=(await one('tabs.list')).find(t=>t.id===tab.id);return item?.url===origin+'/controls?case=new-document'&&!item.isLoading;},'new document committed before stale-reference assertion');
    await one('page.waitFor',{tabId:tab.id,selector:'#increment',state:'visible',timeoutMs:5000});
    await assert.rejects(one('page.click',{tabId:tab.id,ref:old.ref,timeoutMs:500}),/stale|detached|reference|not found|node/i);
    assert.equal(await evaluate(tab.id,'regression.count'),0);
  });
  await check('batches hold the per-tab queue and report partial failure without replay', async () => {
    await evaluate(cold.id,'armBatch(700)');
    const signal='batch-'+Date.now();
    const batch=one('page.batch',{tabId:cold.id,timeoutMs:5000,steps:[{action:'evaluate',expression:`regression.queue.push('batch-start');fetch('/signal?key=${signal}');true`},{action:'waitFor',selector:'#batch-gate',state:'visible',timeoutMs:4000},{action:'evaluate',expression:"regression.queue.push('batch-end');true"}]});
    await until(()=>signals.has(signal),'batch start fixture signal');
    const queued=one('page.evaluate',{tabId:cold.id,expression:"regression.queue.push('queued-after');true"});
    const completed=await batch;await queued;assert.equal(completed.ok,true);assert.equal(completed.results.length,3);
    assert.deepEqual(await evaluate(cold.id,'regression.queue'),['batch-start','batch-end','queued-after']);
    await evaluate(cold.id,'regression.queue=[];true');
    let partialError;
    try{await one('page.batch',{tabId:cold.id,timeoutMs:3000,steps:[{action:'evaluate',expression:"regression.queue.push('first-once');true"},{action:'click',selector:'#does-not-exist',timeoutMs:200},{action:'evaluate',expression:"regression.queue.push('must-not-run');true"}]});assert.fail('Expected the missing batch control to fail');}catch(error){partialError=error;}
    assert.match(partialError.message,/Batch step 1 failed/i);assert.equal(partialError.details?.failedStep,1);assert.equal(partialError.details?.completedSteps,1);
    assert.deepEqual(await evaluate(cold.id,'regression.queue'),['first-once']);
    return {completedSteps:completed.results.length,partial:partialError.details};
  });
  await check('normal launch keeps webdriver false and web content isolated from native APIs', async () => {
    const isolation=await evaluate(cold.id,'({webdriver:navigator.webdriver,aster:typeof window.aster,require:typeof require,process:typeof process})');
    assert.deepEqual(isolation,{webdriver:false,aster:'undefined',require:'undefined',process:'undefined'});
    const response=await fetch(config.endpoint+'/command',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+config.token,'X-Aster-Agent':one.id},body:JSON.stringify({action:'tabs.list'})});assert.equal(response.status,401);
    return isolation;
  });
  await check('legacy snapshots, screenshots, navigation, and private session rotation still work', async () => {
    const snap=await one('page.snapshot',{tabId:cold.id});assert.ok(Array.isArray(snap.elements));assert.ok(snap.text.includes('Real background agent controls'));
    const image=await one('page.screenshot',{tabId:cold.id});const png=Buffer.from(image.data,'base64');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.readUInt32BE(16)>100&&png.readUInt32BE(20)>100);
    const nav=await create(one,'/old/a');await one('page.click',{tabId:nav.id,selector:'#next'});await until(async()=>(await one('tabs.list')).find(t=>t.id===nav.id)?.title==='Legacy B','legacy link navigation');await one('tabs.back',{tabId:nav.id});await until(async()=>(await one('tabs.list')).find(t=>t.id===nav.id)?.title==='Legacy A','legacy back');await one('tabs.forward',{tabId:nav.id});await until(async()=>(await one('tabs.list')).find(t=>t.id===nav.id)?.title==='Legacy B','legacy forward');
    const secretPath='/controls?private-regression='+Date.now();const privateOne=await create(two,secretPath,{private:true});await two('page.evaluate',{tabId:privateOne.id,expression:"localStorage.setItem('regression-private','secret');document.cookie='regression-private=secret;path=/';true"});await two('tabs.close',{tabId:privateOne.id});createdTabs.delete(privateOne.id);
    const privateTwo=await create(two,secretPath,{private:true});const storage=await two('page.evaluate',{tabId:privateTwo.id,expression:"({value:localStorage.getItem('regression-private'),cookie:document.cookie})"});assert.equal(storage.value,null);assert.ok(!storage.cookie.includes('regression-private'));await two('tabs.close',{tabId:privateTwo.id});createdTabs.delete(privateTwo.id);assert.ok(!(await state()).history.some(h=>h.url.includes('private-regression=')));
    return {screenshotBytes:png.length,screenshotDimensions:[png.readUInt32BE(16),png.readUInt32BE(20)]};
  });
  const final=await state();assert.equal(final.activeTabId,humanId);
  const report={checkedAt:new Date().toISOString(),passed:results.every(r=>r.passed),launch:{...launchInfo,profile,playwrightUsed:false,externalInspectorUsed:false,debugOrAutomationFlags:[]},capabilities,results,limitations:['No physical trackpad gesture exercised.','Cross-site frame behavior is verified through the public API; process identity is not exposed.','Native frontmost-application identity is not exposed; selected tab and document lifecycle states are verified.','This regression suite reports correctness, not a CDP performance comparison.']};
  fs.writeFileSync(path.join(work,'agent-regression-results.json'),JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
}

async function cleanup() {
  clearInterval(heartbeat);
  for(const run of [one,two])if(run?.id)await request('/disconnect',{},run.id).catch(()=>{});
  if(app&&app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');await Promise.race([new Promise(resolve=>app.once('exit',resolve)),sleep(6000)]);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');}
  await new Promise(resolve=>fixture?fixture.close(resolve):resolve());
  fs.writeFileSync(path.join(work,'agent-regression-stdout.log'),stdout);fs.writeFileSync(path.join(work,'agent-regression-stderr.log'),stderr);
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;fs.writeFileSync(path.join(work,'agent-regression-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),passed:false,fatal:error.message,results},null,2));}).finally(cleanup);
