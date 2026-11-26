'use strict';
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const work=path.resolve(process.env.ASTER_TEST_WORK||path.join(root,'work','session'));
fs.mkdirSync(work,{recursive:true});
const profile=fs.mkdtempSync(path.join(work,'profile-'));
let app,shell,server,origin,config,agentId;
const results=[],errors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=15000){const start=Date.now();let last;while(Date.now()-start<timeout){last=await fn();if(last)return last;await pause(50);}throw Error('Timed out: '+label);}
const invoke=(name,p={})=>shell.evaluate(({name,p})=>window.aster.invoke(name,p),{name,p});
const state=()=>invoke('state:get');
async function api(route,body){const r=await fetch(config.endpoint+route,{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json',...(agentId?{'X-Aster-Agent':agentId}:{})},body:JSON.stringify(body||{}),signal:AbortSignal.timeout(20000)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
const run=(action,params)=>api('/command',{action,params}).then(d=>d.result);
const page=(id,expression,extra={})=>run('page.evaluate',{tabId:id,expression,...extra});
async function launch(){app=await _electron.launch({...(process.env.ASTER_EXECUTABLE?{executablePath:path.resolve(process.env.ASTER_EXECUTABLE),args:[]}:{args:[root]}),env:{...process.env,ASTER_DATA_DIR:profile,ASTER_PORT:'0',ASTER_DISABLE_FILTER_UPDATES:'1'},timeout:60000});shell=await app.firstWindow();shell.on('pageerror',error=>errors.push(error.message));await shell.waitForFunction(()=>window.aster&&document.querySelector('#app'));config=JSON.parse(fs.readFileSync(path.join(profile,'automation.json')));agentId=null;agentId=(await api('/connect',{name:'Session regression',transport:'HTTP fixture'})).agentId;}
async function loaded(id,title){return until(async()=>{const tab=(await state()).tabs.find(t=>t.id===id);return tab&&!tab.isLoading&&!tab.error&&tab.title===title&&tab;},'loaded '+title);}
async function quit(){if(!app)return;await api('/disconnect').catch(()=>{});agentId=null;await app.close();app=null;shell=null;}
async function check(name,fn){const detail=await fn();results.push({name,passed:true,...(detail?{detail}:{})});console.log('PASS',name);}
async function fixtureFrames(id){
 return until(async()=>{const frames=await run('page.frames',{tabId:id}),main=frames.find(f=>f.main),same=frames.find(f=>f.name==='session-same'),cross=frames.find(f=>f.name==='session-cross');return main&&same&&cross&&{main,same,cross};},'root, same-origin and cross-origin fixture frames');
}
function assertNoSavedSecrets(markers){
 const checked=[];
 for(const filename of ['browser.json','browser.json.backup']){
  const savedPath=path.join(profile,filename);if(!fs.existsSync(savedPath))continue;
  const raw=fs.readFileSync(savedPath,'utf8'),saved=JSON.parse(raw);
  for(const marker of markers)assert.ok(!raw.includes(marker),`${filename} must exclude fake secret values`);
  // Chromium pageState is opaque base64. Check its common UTF-8/UTF-16 string
  // encodings as well as JSON so an encoded secret cannot evade this gate.
  for(const tab of saved.tabs||[])for(const entry of tab.navigation?.entries||[]){
   if(typeof entry.pageState!=='string')continue;const data=Buffer.from(entry.pageState,'base64');
   for(const marker of markers)for(const encoding of ['utf8','utf16le'])assert.ok(!data.includes(Buffer.from(marker,encoding)),`${filename} Chromium pageState must exclude fake ${encoding} secret values`);
  }
  checked.push(filename);
 }
 return checked;
}
async function main(){
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://fixture'),frameFixture=['/frames','/frame-same','/frame-cross'].includes(u.pathname);
  const secrets=frameFixture?'<label>Fake password<input id="password" type="password" autocomplete="current-password"></label><label>Fake one-time code<input id="otp" autocomplete="one-time-code"></label>':'';
  // Only the dedicated root embeds frames: the shared child endpoint never
  // recursively embeds itself. localhost is a real cross-site origin boundary.
  const frames=u.pathname==='/frames'?`<iframe name="session-same" title="Same-origin saved draft" src="${origin}/frame-same"></iframe><iframe name="session-cross" title="Cross-origin saved draft" src="${origin.replace('127.0.0.1','localhost')}/frame-cross"></iframe>`:'';
  res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');res.end(`<!doctype html><title>Session ${u.pathname.slice(1)}</title><style>body{font:18px system-ui;min-height:4000px;padding:35px}input{font:inherit;padding:8px}iframe{display:block;width:740px;height:240px;border:3px solid #b8aec9;margin:18px 0}</style><h1>Session ${u.pathname.slice(1)}</h1><input id="draft" aria-label="Saved draft">${secrets}<a id="next" href="/b">Next</a>${frames}`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 await launch();
 await check('Google and complete session restore are the fresh-profile defaults',async()=>{const s=await state();assert.equal(s.settings.searchEngine,'google');assert.equal(s.settings.restoreSession,true);});
 const a=await invoke('tab:new',{url:origin+'/a'});await loaded(a.id,'Session a');
 await run('page.type',{tabId:a.id,selector:'#draft',text:'A real retained draft'});
 await run('page.scroll',{tabId:a.id,y:720,behavior:'instant'});await until(async()=>await page(a.id,'scrollY')>=700,'scroll fixture');
 await invoke('tab:navigate',{id:a.id,url:origin+'/b'});await loaded(a.id,'Session b');await invoke('tab:back',{id:a.id});await loaded(a.id,'Session a');
 await until(async()=>await page(a.id,'document.querySelector("#draft").value')==='A real retained draft','committed form state');
 const space=await invoke('workspace:add',{name:'An extra workspace with a long full name',color:'#32b9b2'});
 const c=await invoke('tab:new',{url:origin+'/c',workspace:space.id});await loaded(c.id,'Session c');await invoke('tab:volume',{id:c.id,volume:.35});await invoke('tab:mute',{id:c.id});await invoke('tab:pin',{id:c.id});
 const d=await invoke('tab:new',{url:origin+'/d',workspace:space.id});await loaded(d.id,'Session d');
 await invoke('workspace:activate',{id:'personal'});await invoke('tab:activate',{id:a.id});await invoke('workspace:activate',{id:space.id});assert.equal((await state()).activeTabId,d.id);
 await invoke('settings:update',{accent:'teal',transparency:true,theme:'dark',restoreSession:true});
 await invoke('tab:reorder',{ids:[d.id,c.id,a.id]});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1120,760));
 const expected=(await state()).tabs.filter(t=>!t.private).map(t=>t.id);
 const secret=await invoke('tab:new',{url:origin+'/private-secret-marker',private:true});await loaded(secret.id,'Session private-secret-marker');
 await quit();
 await check('Quit stores all normal tabs, settings and navigation while excluding private content',async()=>{const raw=fs.readFileSync(path.join(profile,'browser.json'),'utf8'),saved=JSON.parse(raw);assert.deepEqual(saved.tabs.map(t=>t.id),expected);assert.ok(!raw.includes('private-secret-marker'));assert.equal(saved.activeTabId,d.id);assert.equal(saved.settings.accent,'teal');assert.equal(saved.settings.transparency,true);assert.equal(fs.statSync(path.join(profile,'browser.json')).mode&0o777,0o600);const history=saved.tabs.find(t=>t.id===a.id).navigation;assert.equal(history.index,0);assert.ok(history.entries.some(e=>e.url===origin+'/b'));assert.ok(history.entries[0].pageState);return{normalTabs:saved.tabs.length,navigationEntries:history.entries.length,privateOmitted:true};});
 await launch();
 await check('Reopen preserves order, last normal selection, workspace choice, volume, mute, pins and size',async()=>{const s=await state();assert.deepEqual(s.tabs.map(t=>t.id),expected);assert.equal(s.activeTabId,d.id);assert.equal(s.activeWorkspace,space.id);const t=s.tabs.find(t=>t.id===c.id);assert.equal(t.volume,.35);assert.equal(t.muted,true);assert.equal(t.pinned,true);assert.ok(s.workspaces.some(w=>w.id===space.id));const size=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getSize());assert.deepEqual(size,[1120,760]);});
 await check('Restored Chromium history recovers the form and scroll position, then goes forward',async()=>{await invoke('tab:activate',{id:a.id});await loaded(a.id,'Session a');await until(async()=>await page(a.id,'document.querySelector("#draft").value')==='A real retained draft','restored form');const y=await until(async()=>{const y=await page(a.id,'scrollY');return y>=700&&y;},'restored scroll');assert.equal((await state()).tabs.find(t=>t.id===a.id).canGoForward,true);await invoke('tab:forward',{id:a.id});await loaded(a.id,'Session b');return{restoredScrollY:y};});
 await check('Workspace switch returns to its most recently selected normal tab',async()=>{await invoke('workspace:activate',{id:space.id});assert.equal((await state()).activeTabId,d.id);});
 await quit();
 const backup=JSON.parse(fs.readFileSync(path.join(profile,'browser.json.backup'),'utf8'));assert.ok(backup.tabs.length>=expected.length);
 fs.writeFileSync(path.join(profile,'browser.json'),'{broken test-only session',{mode:0o600});await launch();
 await check('A damaged current save recovers a valid prior session backup',async()=>{const s=await state();assert.equal(s.tabs.length,expected.length);assert.deepEqual(new Set(s.tabs.map(t=>t.id)),new Set(expected));assert.ok(!s.tabs.some(t=>t.private));});
 await check('Immediate quit restores root and both-origin iframe drafts while fake password and OTP values stay off disk',async()=>{
  const tab=await invoke('tab:new',{url:origin+'/frames'});await loaded(tab.id,'Session frames');
  const frames=await fixtureFrames(tab.id),sameOrigin=new URL(frames.same.url).origin,crossOrigin=new URL(frames.cross.url).origin;
  assert.equal(new URL(frames.main.url).origin,sameOrigin);assert.notEqual(sameOrigin,crossOrigin);assert.equal(frames.same.parentId,frames.main.id);assert.equal(frames.cross.parentId,frames.main.id);
  const values={main:'Immediate root nameless draft',same:'Immediate same-origin frame draft',cross:'Immediate cross-origin frame draft'};
  const markers=[];
  for(const [kind,frame]of Object.entries(frames)){
   await run('page.waitFor',{tabId:tab.id,frameId:frame.id,selector:'#draft',state:'visible',timeoutMs:5000});
   const password='ASTER_FAKE_PASSWORD_'+kind+'_ONLY',otp='ASTER_FAKE_OTP_'+kind+'_ONLY';markers.push(password,otp);
   await run('page.type',{tabId:tab.id,frameId:frame.id,selector:'#password',text:password});
   await run('page.type',{tabId:tab.id,frameId:frame.id,selector:'#otp',text:otp});
   assert.deepEqual(await page(tab.id,'({password:document.querySelector("#password").value,otp:document.querySelector("#otp").value})',{frameId:frame.id}),{password,otp},'Fake secret controls must actually contain their test values before quit');
  }
  for(const [kind,frame]of Object.entries(frames))await run('page.type',{tabId:tab.id,frameId:frame.id,selector:'#draft',text:values[kind]});
  // No page polling or delay after the final cross-origin input. This exercises
  // the real async quit flush rather than relying on the periodic capture timer.
  await quit();
  const saved=JSON.parse(fs.readFileSync(path.join(profile,'browser.json'),'utf8')),stored=saved.tabs.find(t=>t.id===tab.id);assert.ok(stored);
  const paths={main:'root',same:'root/n:session-same',cross:'root/n:session-cross'};
  for(const [kind,frame]of Object.entries(frames)){
   const record=stored.documents?.find(d=>d.url===frame.url&&d.rootURL===origin+'/frames'&&d.framePath===paths[kind]);assert.ok(record,'Saved document record for '+kind);
   assert.equal(record.fields.find(f=>f.id==='draft')?.value,values[kind]);assert.ok(!record.fields.some(f=>['password','otp'].includes(f.id)),'Sensitive field records must be omitted for '+kind);
  }
  const filesChecked=assertNoSavedSecrets(markers);
  await launch();await invoke('tab:activate',{id:tab.id});await loaded(tab.id,'Session frames');const reopened=await fixtureFrames(tab.id);
  for(const [kind,frame]of Object.entries(reopened)){
   await run('page.waitFor',{tabId:tab.id,frameId:frame.id,selector:'#draft',state:'visible',timeoutMs:5000});
   await until(async()=>await page(tab.id,'document.querySelector("#draft").value',{frameId:frame.id})===values[kind],'reopened '+kind+' draft');
   assert.deepEqual(await page(tab.id,'({password:document.querySelector("#password").value,otp:document.querySelector("#otp").value})',{frameId:frame.id}),{password:'',otp:''});
  }
  return{draftsRestored:Object.keys(values),sameOrigin,crossOrigin,noPostInputWait:true,savedFramePaths:paths,secretSessionFilesChecked:filesChecked};
 });
 assert.deepEqual(errors,[]);
}
main().catch(error=>{console.error(error.stack);errors.push(error.stack);process.exitCode=1;}).finally(async()=>{await quit().catch(()=>{});server?.close();fs.writeFileSync(path.join(work,'session-results.json'),JSON.stringify({passed:!process.exitCode,checkedAt:new Date().toISOString(),results,errors,profile},null,2));});
