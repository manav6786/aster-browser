'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTabNavigation,cleanNavigation,LIMITS}=require('../src/main/tab-navigation.cjs');
const {newTab}=require('../src/shared/core.cjs');
const {mainFixture}=require('./helpers/main-fixture.cjs');
const A='https://fixture.test/a',B='https://fixture.test/b',C='https://fixture.test/c';
function setup(input={}) {
  const tab=newTab(input),opened=[],flushes=[];let wc=null,alive=true,controller;
  function contents(navigation) {
    const object={dead:false,isDestroyed(){return this.dead;},isLoadingMainFrame:()=>false};
    object.navigationHistory={entries:structuredClone(navigation?.entries||[]),index:navigation?.index||0,
      getAllEntries(){return this.entries;},getActiveIndex(){return this.index;},canGoBack(){return this.index>0;},canGoForward(){return this.index<this.entries.length-1;},
      goBack(){this.index--;tab.url=this.entries[this.index].url;controller.committed(tab,object);},goForward(){this.index++;tab.url=this.entries[this.index].url;controller.committed(tab,object);}};
    return object;
  }
  controller=createTabNavigation({getWebContents:()=>wc,isAlive:()=>alive,beforeLeave:async()=>flushes.push(tab.url),openRoute:async(t,url,options)=>{
    opened.push({url,...options});t.url=url;t.title=options.title||url;
    if(url.startsWith('aster://')){if(wc)wc.dead=true;wc=null;}
    else if(options.restore||!wc){if(wc)wc.dead=true;wc=contents(t.navigation);if(!wc.navigationHistory.entries.length){wc.navigationHistory.entries=[{url,title:url}];wc.navigationHistory.index=0;}controller.committed(tab,wc);}
    else {const h=wc.navigationHistory;h.entries.splice(h.index+1);h.entries.push({url,title:url});h.index=h.entries.length-1;controller.committed(tab,wc);}
  }});
  controller.initialize(tab);if(!tab.url.startsWith('aster://')){wc=contents(tab.navigation||{entries:[{url:tab.url,title:tab.title}],index:0});controller.committed(tab,wc);}
  return {tab,controller,opened,flushes,get wc(){return wc;},setAlive:value=>alive=value};
}

test('Back returns the first website to New Tab; Forward restores its owned Chromium view',async()=>{
  const f=setup();assert.deepEqual(f.controller.refresh(f.tab),{canGoBack:false,canGoForward:false});
  await f.controller.go(f.tab,A);const remote=f.wc;
  assert.deepEqual(f.controller.refresh(f.tab),{canGoBack:true,canGoForward:false});
  await f.controller.travel(f.tab,'back');assert.equal(f.tab.url,'aster://newtab');assert.equal(remote.dead,true);assert.equal(f.wc,null);
  assert.deepEqual(f.controller.refresh(f.tab),{canGoBack:false,canGoForward:true});
  await f.controller.travel(f.tab,'forward');assert.equal(f.tab.url,A);assert.notEqual(f.wc,remote);assert.equal(f.wc.navigationHistory.entries[0].url,A);
  assert.equal(f.flushes.length,1);
});

test('Chromium A→B history and internal settings boundaries form one ordered Back/Forward path',async()=>{
  const f=setup();await f.controller.go(f.tab,A);await f.controller.go(f.tab,B);await f.controller.go(f.tab,'aster://settings');
  for(const target of [B,A,'aster://newtab']){assert.equal(await f.controller.travel(f.tab,'back'),true);assert.equal(f.tab.url,target);}
  assert.equal(await f.controller.travel(f.tab,'back'),false);
  for(const target of [A,B,'aster://settings']){assert.equal(await f.controller.travel(f.tab,'forward'),true);assert.equal(f.tab.url,target);}
  assert.equal(await f.controller.travel(f.tab,'forward'),false);
});

test('a new destination drops logical forward routes but native Back/Forward keeps them',async()=>{
  const f=setup();await f.controller.go(f.tab,A);await f.controller.go(f.tab,B);await f.controller.go(f.tab,'aster://settings');
  await f.controller.travel(f.tab,'back');await f.controller.travel(f.tab,'back');
  assert.equal(f.tab.url,A);assert.equal(f.tab.routeHistory.entries.at(-1).url,'aster://settings');
  await f.controller.go(f.tab,C);assert.equal(f.tab.routeHistory.entries.some(e=>e.url==='aster://settings'),false);
  assert.equal(f.controller.refresh(f.tab).canGoForward,false);
  await f.controller.travel(f.tab,'back');assert.equal(f.tab.url,A);
});

test('page link and pushState branches discard the old internal forward boundary; replaceState does not',async()=>{
  const f=setup();await f.controller.go(f.tab,A);await f.controller.go(f.tab,B);await f.controller.go(f.tab,'aster://settings');await f.controller.travel(f.tab,'back');
  await f.controller.travel(f.tab,'back');const h=f.wc.navigationHistory;
  h.entries[0].url=A+'#replace';f.tab.url=A+'#replace';f.controller.committed(f.tab,f.wc);assert.equal(f.tab.routeHistory.entries.at(-1).url,'aster://settings');
  h.entries.splice(1);h.entries.push({url:C,title:'C'});h.index=1;f.tab.url=C;f.controller.committed(f.tab,f.wc);
  assert.equal(f.tab.routeHistory.entries.some(e=>e.url==='aster://settings'),false);
});

test('serialized internal and remote selections retain history with one copy of active native PageState',async()=>{
  const f=setup();await f.controller.go(f.tab,A);f.wc.navigationHistory.entries[0].pageState='FORM_STATE_SENTINEL';f.controller.capture(f.tab);
  assert.equal(JSON.stringify(f.tab).split('FORM_STATE_SENTINEL').length-1,1);
  await f.controller.go(f.tab,'aster://settings');assert.equal(f.tab.navigation,undefined);assert.equal(JSON.stringify(f.tab).split('FORM_STATE_SENTINEL').length-1,1);
  const restored=setup(JSON.parse(JSON.stringify(f.tab)));assert.equal(restored.controller.refresh(restored.tab).canGoBack,true);
  await restored.controller.travel(restored.tab,'back');assert.equal(restored.tab.url,A);assert.equal(restored.wc.navigationHistory.entries[0].pageState,'FORM_STATE_SENTINEL');
  assert.equal(restored.tab.routeHistory.entries[restored.tab.routeHistory.index].navigation,undefined);
  assert.equal(JSON.stringify(restored.tab).split('FORM_STATE_SENTINEL').length-1,1);
});

test('legacy saves migrate without fabricated internal history; invalid destinations and saved segments are rejected',async()=>{
  const f=setup({url:B,navigation:{entries:[{url:A,title:'A'},{url:B,title:'B'}],index:1},routeHistory:{version:1,index:500,entries:[]}});
  assert.equal(f.tab.routeHistory.entries.length,1);assert.equal(f.controller.refresh(f.tab).canGoBack,true);
  await f.controller.travel(f.tab,'back');assert.equal(f.tab.url,A);assert.equal(f.controller.refresh(f.tab).canGoBack,false);
  for(const url of ['javascript:alert(1)','file:///etc/passwd','aster://invalid','https://u:p@fixture.test/'])await assert.rejects(f.controller.go(f.tab,url),/Unsupported/);
  assert.equal(cleanNavigation({entries:[{url:'file:///secret',title:'Bad'}],index:0}),null);
});

test('route and native history are bounded without losing the selected destination',async()=>{
  const f=setup();for(let i=0;i<60;i++)await f.controller.go(f.tab,i%2?A+'?n='+i:'aster://settings');
  assert.ok(f.tab.routeHistory.entries.length<=LIMITS.segments);assert.equal(f.tab.url,A+'?n=59');
  const entries=Array.from({length:650},(_,i)=>({url:A+'?i='+i,title:String(i),pageState:'x'.repeat(40000)}));
  const clean=cleanNavigation({entries,index:500});assert.equal(clean.entries.length,LIMITS.entries);assert.equal(clean.entries[clean.index].url,A+'?i=500');assert.ok(Buffer.byteLength(JSON.stringify(clean))<=LIMITS.bytes+100000);
});

test('an awaited capture cannot navigate a tab that closed during the boundary transition',async()=>{
  const tab=newTab({url:A});let alive=true,finish,opens=0;
  const wc={isDestroyed:()=>false,isLoadingMainFrame:()=>false,navigationHistory:{getAllEntries:()=>[{url:A,title:'A'}],getActiveIndex:()=>0}};
  const model=createTabNavigation({getWebContents:()=>wc,isAlive:()=>alive,beforeLeave:()=>new Promise(resolve=>finish=resolve),openRoute:()=>{opens++;}});
  const pending=model.go(tab,'aster://settings');await Promise.resolve();await Promise.resolve();alive=false;finish();assert.equal(await pending,false);assert.equal(opens,0);assert.equal(tab.url,A);
});

test('actual main routes preserve New Tab history, destroy remote contents at internal boundaries and omit saved history from public snapshots',async t=>{
  const f=mainFixture();t.after(()=>f.dispose());const tab=f.state.tabs[0];
  await f.command('tab:navigate',{id:tab.id,url:A});const wc=f.views.get(tab.id).webContents;
  wc.navigationHistory.entries=[{url:A,title:'A',pageState:'native-state'}];wc.navigationHistory.index=0;wc.getTitle=()=> 'A';wc.emit('did-navigate',{},A);
  assert.equal(tab.canGoBack,true);await f.command('tab:back',{id:tab.id});assert.equal(tab.url,'aster://newtab');assert.equal(wc.closeCount,1);assert.equal(f.views.has(tab.id),false);assert.equal(tab.canGoForward,true);
  const snapshot=await f.command('state:get');assert.equal(snapshot.tabs[0].routeHistory,undefined);assert.equal(snapshot.tabs[0].navigation,undefined);
  await f.command('tab:forward',{id:tab.id});const fresh=f.views.get(tab.id).webContents;assert.equal(fresh.restored.length,1);assert.equal(fresh.loaded.length,0);assert.equal(tab.url,A);
  await f.command('tab:navigate',{id:tab.id,url:'aster://settings'});assert.equal(fresh.closeCount,1);assert.equal(f.views.has(tab.id),false);assert.equal(tab.canGoBack,true);
});
