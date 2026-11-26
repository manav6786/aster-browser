'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mainFixture}=require('./helpers/main-fixture.cjs');
const {PAGE_ENTER_SCRIPT}=require('../src/main/page-transition.cjs');
function fixture(t){const f=mainFixture({tabs:[{id:'first',url:'https://fixture.test/first'},{id:'second',url:'https://fixture.test/second'}],activeTabId:'first',settings:{theme:'dark'}});t.after(()=>f.dispose());return f;}

test('native page canvas and square corners do not expose a white rounded gutter in dark mode',async t=>{
 const f=fixture(t);await f.command('tab:activate',{id:'first'});const v=f.views.get('first');
 assert.equal(v.backgroundColor,'#000000');assert.equal(v.borderRadius,0);
 const toolbarHeight = process.platform === 'darwin' ? 86 : 60;
 assert.deepEqual({...v.getBounds()},{x:246,y:toolbarHeight,width:1194,height:940-toolbarHeight});
});

test('existing native canvases follow explicit and system theme changes without changing page bounds',async t=>{
 const f=fixture(t);await f.command('tab:activate',{id:'first'});await f.command('tab:activate',{id:'second'});
 await f.command('settings:update',{theme:'light'});for(const v of f.views.values())assert.equal(v.backgroundColor,'#fbfaff');
 await f.command('settings:update',{theme:'system'});f.nativeTheme.shouldUseDarkColors=true;f.layout();for(const v of f.views.values())assert.equal(v.backgroundColor,'#000000');
 f.nativeTheme.shouldUseDarkColors=false;f.layout();for(const v of f.views.values())assert.equal(v.backgroundColor,'#fbfaff');
});

test('real page entry motion runs on changed tabs, not repeated selection of the current tab',async t=>{
 const f=fixture(t);await f.command('tab:activate',{id:'first'});await f.command('tab:activate',{id:'second'});
 assert.equal(f.views.get('second').webContents.executed.filter(s=>s===PAGE_ENTER_SCRIPT).length,1);
 await f.command('tab:activate',{id:'first'});const wc=f.views.get('first').webContents,count=wc.executed.length;
 await f.command('tab:activate',{id:'first'});assert.equal(wc.executed.length,count);
});

test('HTML fullscreen never receives a tab-entry page transform',async t=>{
 const f=fixture(t);await f.command('tab:activate',{id:'first'});const wc=f.views.get('first').webContents;
 wc.emit('enter-html-full-screen');const count=wc.executed.length;await f.animatePage(wc);assert.equal(wc.executed.length,count);
});
