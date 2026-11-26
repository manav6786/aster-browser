'use strict';
// Real UI + main suggestion service. Only fixed provider fetches are redirected
// to a local HTTP fixture; window.aster and browser actions remain untouched.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const artifacts=path.resolve(process.env.ASTER_TEST_WORK||path.join(root,'work','search-motion'));
fs.mkdirSync(artifacts,{recursive:true});
const profile=fs.mkdtempSync(path.join(artifacts,'profile-'));
let app,page,server,origin;
const results=[],errors=[],requests=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.aster.invoke(command,payload),{command,payload});
const state=()=>invoke('state:get');
const active=async()=>{const s=await state();return s.tabs.find(t=>t.id===s.activeTabId);};
async function renderedActive(){const tab=await active();await page.waitForFunction(tab=>{const el=document.querySelector('.tab[aria-selected="true"]');return el?.dataset.tabId===tab.id&&el.title.endsWith('\n'+tab.url);},tab);}
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await pause(45);}throw new Error('Timed out: '+label);}
async function check(name,fn){await fn();results.push({name,passed:true});console.log('PASS',name);}
async function click(target){const locator=typeof target==='string'?page.locator(target).first():target;await locator.scrollIntoViewIfNeeded();await until(()=>locator.evaluate(el=>{const r=el.getBoundingClientRect();return r.width>=8&&r.height>=8&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'actual center hit-test after layout settles',5000);await locator.click();}
async function nativeKey(keyCode,modifiers=[]){await app.evaluate(({webContents},{keyCode,modifiers})=>{const wc=webContents.getFocusedWebContents();if(!wc)throw new Error('No native focused webContents');wc.sendInputEvent({type:'keyDown',keyCode,modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers});},{keyCode,modifiers});}
async function focusAddress(){await nativeKey('L',['meta']);await page.waitForFunction(()=>document.hasFocus()&&document.activeElement.id==='address');}
async function navigate(url){await page.locator('#address').fill(url);await page.locator('#address').press('Enter');await until(async()=>(await active())?.url===url,'navigation '+url);}
async function remoteVisible(){return app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents?.getURL().startsWith('http')).some(v=>v.getVisible()));}
async function listFor(input,query){await page.locator(input).fill(query);await page.locator('#search-suggestions').waitFor({state:'visible'});await until(async()=>(await page.locator(input).getAttribute('aria-expanded'))==='true','combobox expanded');}
async function fixtureFetches(){return app.evaluate(()=>globalThis.__searchFixtureRequests||[]);}
async function main(){
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/suggest'){
      const query=url.searchParams.get('q')||'';requests.push({query,at:Date.now()});
      const send=()=>{if(res.destroyed)return;res.setHeader('Content-Type','application/json');if(query==='offline galaxy'){res.statusCode=503;res.end('{}');}else res.end(JSON.stringify([query,[query+' bright stars',query+' deep sky']]));};
      setTimeout(send,query==='slow constellations'?650:35);return;
    }
    const title=url.pathname.includes('history')?'Starlight History':url.pathname.includes('bookmark')?'Starlight Bookmark':url.pathname.includes('tab')?'Starlight Tab':'Search fixture';
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>${title}</title><style>body{font:24px system-ui;padding:45px;background:#eef5ff;color:#293956}</style><h1>${title}</h1><p>Real native browser page.</p>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  const launch={...(process.env.ASTER_EXECUTABLE?{executablePath:path.resolve(process.env.ASTER_EXECUTABLE),args:[]}:{args:[root]}),env:{...process.env,ASTER_DATA_DIR:profile,ASTER_PORT:'0',ASTER_DISABLE_FILTER_UPDATES:'1'},timeout:60000};
  app=await _electron.launch(launch);page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  app.process().stderr.on('data',data=>fs.appendFileSync(path.join(artifacts,'stderr.log'),data));
  await page.waitForFunction(()=>window.aster&&document.querySelector('#home-search'));
  await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});const win=BrowserWindow.getAllWindows()[0];win.setSize(1050,700);win.show();win.focus();win.webContents.focus();});
  await app.evaluate((_,origin)=>{
    globalThis.__searchOriginalFetch=globalThis.fetch;globalThis.__searchFixtureRequests=[];
    globalThis.fetch=(input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url);
      if((url.hostname==='search.brave.com'&&url.pathname==='/api/suggest')||(url.hostname==='duckduckgo.com'&&url.pathname==='/ac/')||(['www.google.com','suggestqueries.google.com'].includes(url.hostname)&&url.pathname==='/complete/search')){
        globalThis.__searchFixtureRequests.push({url:url.href,query:url.searchParams.get('q')});
        return globalThis.__searchOriginalFetch(origin+'/suggest?q='+encodeURIComponent(url.searchParams.get('q')||''),options);
      }
      return globalThis.__searchOriginalFetch(input,options);
    };
  },origin);
  await check('One accessible sidebar button travels between real brand and toolbar targets',async()=>{
    assert.equal(await page.locator('button[data-action="sidebar"]').count(),1);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-controls'),'browser-sidebar');
    for(const collapsed of [true,false]){
      const before=await page.locator('#sidebar-toggle').boundingBox();await click('#sidebar-toggle');
      await until(async()=>(await state()).settings.sidebarCollapsed===collapsed,'sidebar state');await pause(100);
      assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),String(!collapsed));
      assert.ok(await page.locator('#sidebar-motion-layer .sidebar-spark').count());
      await page.screenshot({path:path.join(artifacts,collapsed?'collapse-flight.png':'expand-flight.png')});
      await until(async()=>!(await page.locator('#sidebar-toggle').getAttribute('class')).includes('in-flight'),'motion settled');
      const button=await page.locator('#sidebar-toggle').boundingBox(),slot=await page.locator(collapsed?'#sidebar-toolbar-slot':'#sidebar-brand-slot').boundingBox();
      assert.ok(Math.abs(button.x-slot.x)<2&&Math.abs(button.y-slot.y)<2,'button reaches its slot');assert.ok(button.y>=32&&button.y+button.height<=86,'target remains above native page');assert.ok(Math.abs(button.x-before.x)>50,'button visibly travels');
    }
  });
  await check('Repeated delivered clicks remain hit-testable and settle to the final requested sidebar state',async()=>{
    const initial=!!(await state()).settings.sidebarCollapsed,attempts=[];
    await page.evaluate(()=>{
      window.__sidebarStressClicks=0;
      window.__sidebarStressListener=event=>{if(event.target.closest('[data-action="sidebar"]'))window.__sidebarStressClicks++;};
      document.addEventListener('click',window.__sidebarStressListener,true);
    });
    try{
      let delivered=0;
      for(let attempt=0;attempt<16&&delivered<8;attempt++){
        // A moving button can leave an earlier boundingBox between protocol
        // calls. Sample its center and hit-test together; retry a missed
        // pointer delivery, while still requiring eight real trusted clicks.
        const probe=await page.locator('#sidebar-toggle').evaluate(el=>{const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:el.contains(document.elementFromPoint(x,y))};});
        assert.equal(probe.hit,true,'moving control remains hit-testable');
        await page.mouse.click(probe.x,probe.y);await pause(38);
        const count=await page.evaluate(()=>window.__sidebarStressClicks);
        assert.ok(count===delivered||count===delivered+1,'one pointer click cannot toggle twice');
        attempts.push({...probe,delivered:count>delivered});delivered=count;
      }
      fs.writeFileSync(path.join(artifacts,'motion-input.json'),JSON.stringify({initial,delivered,attempts},null,2));
      assert.equal(delivered,8,'eight actual sidebar clicks delivered within bounded attempts');
      await until(async()=>(await state()).settings.sidebarCollapsed===initial,'final rapid toggle state');await pause(650);
      assert.equal(await page.locator('button[data-action="sidebar"]').count(),1);assert.equal(await page.locator('#sidebar-motion-layer>*').count(),0);
    }finally{await page.evaluate(()=>{document.removeEventListener('click',window.__sidebarStressListener,true);delete window.__sidebarStressListener;delete window.__sidebarStressClicks;});}
  });
  await check('Reduced motion has no star particles or travel animations',async()=>{
    await page.emulateMedia({reducedMotion:'reduce'});await click('#sidebar-toggle');await pause(80);
    assert.equal(await page.locator('#sidebar-motion-layer>*').count(),0);assert.equal(await page.locator('#sidebar-toggle').evaluate(el=>el.getAnimations().filter(a=>a.playState==='running').length),0);
    await click('#sidebar-toggle');await page.emulateMedia({reducedMotion:'no-preference'});await pause(450);
  });
  await navigate(origin+'/starlight-history');await until(async()=>(await state()).history.some(h=>h.url===origin+'/starlight-history'&&h.title==='Starlight History'),'history fixture committed');const historyId=(await state()).activeTabId;await invoke('tab:close',{id:historyId});
  await invoke('bookmark:toggle',{url:origin+'/starlight-bookmark',title:'Starlight Bookmark'});
  const tab=await invoke('tab:new',{url:origin+'/starlight-tab'});await until(async()=>(await active())?.title==='Starlight Tab','tab fixture');await click('.new-tab');await renderedActive();await page.locator('#home-search').waitFor({state:'visible'});
  await check('Home autocomplete merges tabs, bookmarks and history without losing typed text',async()=>{
    assert.notEqual((await state()).settings.searchSuggestions,true);await listFor('#home-search','Starlight');
    for(const name of ['Starlight Tab','Starlight Bookmark','Starlight History'])await page.locator('.suggestion-option').filter({hasText:name}).waitFor({state:'visible'});
    await invoke('bookmark:toggle',{url:origin+'/unrelated',title:'Unrelated update'});await pause(150);assert.equal(await page.locator('#home-search').inputValue(),'Starlight');assert.equal(await page.evaluate(()=>document.activeElement.id),'home-search');
    assert.equal((await fixtureFetches()).length,0,'remote is opt-in');await page.screenshot({path:path.join(artifacts,'home-local-suggestions.png')});
    await click(page.locator('.suggestion-option').filter({hasText:'Starlight Bookmark'}));await until(async()=>(await active())?.url===origin+'/starlight-bookmark','pointer suggestion navigation');await page.locator('#search-suggestions').waitFor({state:'hidden'});
  });
  await check('Address dropdown covers native pages, supports arrows/Enter, and switches to existing tabs',async()=>{
    await focusAddress();await listFor('#address','Starlight');await until(async()=>!(await remoteVisible()),'native page hidden behind suggestions');
    const first=page.locator('.suggestion-option').first();await first.waitFor({state:'visible'});assert.ok((await first.textContent()).includes('Starlight Tab'));
    await page.locator('#address').press('ArrowDown');assert.equal(await page.locator('#address').getAttribute('aria-activedescendant'),await first.getAttribute('id'));
    await page.locator('#address').press('ArrowUp');await page.locator('#address').press('ArrowDown');await page.locator('#address').press('Enter');
    await until(async()=>(await state()).activeTabId===tab.id,'existing tab selected');await page.waitForFunction(id=>document.querySelector('.tab[aria-selected="true"]')?.dataset.tabId===id,tab.id);await page.locator('#search-suggestions').waitFor({state:'hidden'});await until(remoteVisible,'native page restored');
  });
  await check('Escape dismisses suggestions while preserving actual native address focus',async()=>{
    await focusAddress();await listFor('#address','Starlight');await page.locator('#address').press('Escape');await page.locator('#search-suggestions').waitFor({state:'hidden'});
    await until(async()=>String(await app.evaluate(({webContents})=>webContents.getFocusedWebContents()?.getURL())).startsWith('aster-ui://'),'chrome still focused');assert.equal(await page.evaluate(()=>document.activeElement.id),'address');assert.equal(await page.locator('#address').inputValue(),'Starlight');
    await page.locator('#address').press('Escape');await until(remoteVisible,'page visible after Escape');
  });
  await check('Selecting a direct URL suggestion navigates to that page',async()=>{
    await focusAddress();await listFor('#address',origin+'/direct-url');await page.locator('.suggestion-kind').filter({hasText:'Go to address'}).waitFor({state:'visible'});
    await page.locator('#address').press('ArrowDown');await page.locator('#address').press('Enter');await until(async()=>(await active())?.url===origin+'/direct-url','direct URL suggestion');await page.locator('#search-suggestions').waitFor({state:'hidden'});
  });
  await check('Remote suggestions are an explicit settings opt-in and use the selected provider',async()=>{
    await click('.sidebar-tools [data-route="settings"]');await page.locator('[data-setting="searchSuggestions"]').waitFor({state:'visible'});await page.locator('#search-engine').selectOption('brave');await until(async()=>(await state()).settings.searchEngine==='brave','explicit Brave fixture');await click('[data-setting="searchSuggestions"]');await until(async()=>(await state()).settings.searchSuggestions===true,'remote enabled');
    await listFor('#address','orbit garden');await page.locator('.suggestion-option').filter({hasText:'orbit garden bright stars'}).waitFor({state:'visible'});
    assert.ok((await fixtureFetches()).some(r=>r.query==='orbit garden'&&r.url.startsWith('https://search.brave.com/api/suggest')));assert.equal(await page.locator('#address').inputValue(),'orbit garden');await page.screenshot({path:path.join(artifacts,'address-remote-suggestions.png')});await page.locator('#address').press('Escape');
    await page.locator('#search-engine').selectOption('google');await until(async()=>(await state()).settings.searchEngine==='google','Google selected');await listFor('#address','lunar cat');await page.locator('.suggestion-option').filter({hasText:'lunar cat bright stars'}).waitFor({state:'visible'});assert.ok((await fixtureFetches()).some(r=>r.query==='lunar cat'&&r.url.startsWith('https://www.google.com/complete/search')));await page.locator('#address').press('Escape');await page.locator('#search-engine').selectOption('brave');await until(async()=>(await state()).settings.searchEngine==='brave','Brave restored');
    await click('[data-action="theme"][data-value="dark"]');await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));await listFor('#address','Starlight');await page.locator('.suggestion-option').filter({hasText:'Starlight Bookmark'}).waitFor({state:'visible'});await pause(150);await page.screenshot({path:path.join(artifacts,'address-dark-suggestions.png')});await page.locator('#address').press('Escape');await click('[data-action="theme"][data-value="light"]');await page.waitForFunction(()=>!document.documentElement.classList.contains('dark'));
  });
  await check('Late remote results cannot replace a newer query or reopen a superseding palette',async()=>{
    await listFor('#address','slow constellations');await until(async()=>(await fixtureFetches()).some(r=>r.query==='slow constellations'),'slow query started');await listFor('#address','fast orbit');await page.locator('.suggestion-option').filter({hasText:'fast orbit bright stars'}).waitFor({state:'visible'});await pause(750);
    assert.equal(await page.locator('.suggestion-option').filter({hasText:'slow constellations'}).count(),0);assert.equal(await page.locator('#address').inputValue(),'fast orbit');
    await listFor('#address','slow constellations second');await nativeKey('K',['meta']);await page.locator('#palette').waitFor({state:'visible'});await pause(750);await page.locator('#search-suggestions').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>document.activeElement.id),'palette-input');await page.locator('#palette-input').press('Escape');
  });
  await check('Private tabs and disabled remote setting keep local results with no provider requests',async()=>{
    await click('.more-button');await click('#floating [data-action="private"]');await until(async()=>(await active())?.private,'private tab');const privateId=(await state()).activeTabId,before=(await fixtureFetches()).length;
    await listFor('#home-search','private orbit');await pause(320);assert.equal((await fixtureFetches()).length,before);assert.ok((await page.locator('.suggestions-footer').textContent()).includes('Private tab'));await nativeKey('W',['meta']);await until(async()=>!(await state()).tabs.some(t=>t.id===privateId),'close private tab');
    await click('.sidebar-tools [data-route="settings"]');await click('[data-setting="searchSuggestions"]');await until(async()=>(await state()).settings.searchSuggestions===false,'remote disabled');const count=(await fixtureFetches()).length;await listFor('#address','quiet local');await pause(320);assert.equal((await fixtureFetches()).length,count);await page.locator('#address').press('Escape');
  });
  await check('Provider failure keeps an editable local fallback and does not crash the shell',async()=>{
    await click('[data-setting="searchSuggestions"]');await until(async()=>(await state()).settings.searchSuggestions===true,'remote enabled again');await listFor('#address','offline galaxy');await until(async()=>(await fixtureFetches()).some(r=>r.query==='offline galaxy'),'failing provider requested');await pause(180);
    assert.equal(await page.locator('#address').inputValue(),'offline galaxy');assert.ok(await page.locator('.suggestion-option').count());assert.equal(await page.evaluate(()=>document.activeElement.id),'address');assert.equal(app.process().exitCode,null);await page.locator('#address').press('Escape');
  });
  assert.deepEqual(errors,[]);
}
main().catch(async error=>{errors.push(error.stack);console.error(error.stack);process.exitCode=1;try{await page?.screenshot({path:path.join(artifacts,'failure.png')});}catch{}}).finally(async()=>{
  fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify({passed:!process.exitCode,results,errors,requests,profile,checkedAt:new Date().toISOString()},null,2));
  if(app){try{await app.evaluate(()=>{if(globalThis.__searchOriginalFetch)globalThis.fetch=globalThis.__searchOriginalFetch;});}catch{}await app.close();}server?.close();
});
