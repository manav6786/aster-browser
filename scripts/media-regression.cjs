'use strict';
// A normal executable launch avoids Playwright's port-zero debugger, which
// changes navigator.webdriver and YouTube's playback/advertising behavior.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { PNG } = require('pngjs');
const { createClient } = require('../bin/client.cjs');
const root = path.resolve(__dirname, '..');
const work = process.env.ASTER_TEST_WORK || path.join(root, 'work', 'media');
fs.mkdirSync(work, { recursive: true });
const profile = fs.mkdtempSync(path.join(work, 'media-'));
fs.writeFileSync(path.join(profile, 'browser.json'), JSON.stringify({ settings: { sidebarCollapsed: true } }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const reports = [];
let child, client, stderr = '';
async function until(fn, label, timeout = 45000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) throw Error('Browser exited during ' + label);
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; if (error.mediaFailure) throw error; }
    await pause(250);
  }
  throw Error('Timed out: ' + label + (last ? ' (' + last.message + ')' : ''));
}
async function sample(tabId) {
  const s = await client.command('page.evaluate', { tabId, expression: `(()=>{const v=document.querySelector('video'),p=document.querySelector('#movie_player'),q=v?.getVideoPlaybackQuality(),r=v?.getBoundingClientRect();return {url:location.href,title:document.title,webdriver:navigator.webdriver,viewport:[innerWidth,innerHeight],ad:!!p?.classList.contains('ad-showing'),playability:p?.getPlayerResponse?.()?.playabilityStatus?.status,debugError:p?.getVideoStats?.()?.debug_error,fullscreen:!!document.fullscreenElement,video:v?{ready:v.readyState,paused:v.paused,muted:v.muted,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,frames:q?.totalVideoFrames,dropped:q?.droppedVideoFrames,error:v.error?{code:v.error.code,message:v.error.message}:null,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null}})()` });
  const message = s.ad ? 'An advertisement reached the video player' : s.debugError ? s.debugError : s.video?.error ? JSON.stringify(s.video.error) : null;
  if (message) { const error = Error(message); error.mediaFailure = true; error.sample = s; throw error; }
  assert.equal(s.webdriver, false, 'Live playback must use the normal browser launch');
  return s;
}
async function capture(tabId, name) {
  const s = await sample(tabId), result = await client.command('page.screenshot', { tabId });
  const bytes = Buffer.from(result.data, 'base64');
  fs.writeFileSync(path.join(work, name + '.png'), bytes);
  const png = PNG.sync.read(bytes), rect = s.video.rect;
  const sx = png.width / s.viewport[0], sy = png.height / s.viewport[1];
  const x0 = Math.max(0, Math.floor((rect.x + rect.width * .1) * sx)), x1 = Math.min(png.width, Math.ceil((rect.x + rect.width * .9) * sx));
  const y0 = Math.max(0, Math.floor((rect.y + rect.height * .1) * sy)), y1 = Math.min(png.height, Math.ceil((rect.y + rect.height * .9) * sy));
  let count = 0, bright = 0;
  for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) { const i = (y * png.width + x) * 4; count++; if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > 35) bright++; }
  const nonBlackRatio = bright / count;
  assert.ok(count > 100 && nonBlackRatio > .12, 'Video surface is black: ' + nonBlackRatio);
  return nonBlackRatio;
}
async function main() {
  const executable = process.env.ASTER_EXECUTABLE || require('electron');
  const env = { ...process.env, ASTER_DATA_DIR: profile, ASTER_PORT: '0', ASTER_DISABLE_FILTER_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, process.env.ASTER_EXECUTABLE ? [] : [root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { stderr += error.message; });
  child.stderr.on('data', data => { stderr += data; fs.appendFileSync(path.join(work, 'media-stderr.log'), data); });
  child.stdout.on('data', data => fs.appendFileSync(path.join(work, 'media-stdout.log'), data));
  const connection = path.join(profile, 'automation.json');
  await until(() => fs.existsSync(connection), 'automation startup', 20000);
  process.env.ASTER_CONNECTION = connection;
  client = createClient('Native playback QA', 'CLI'); await client.connect();
  const shields = (await client.command('browser.state')).shields;
  assert.equal(shields.enabled, true); assert.equal(shields.status, 'ready');
  for (const [name, url] of [['reported-video', 'https://www.youtube.com/watch?v=ThFEPB24gl8&list=RDThFEPB24gl8&start_radio=1'], ['second-video', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ']]) {
    const report = { name, url, passed: false, checks: [], observations: [] }; reports.push(report);
    const tab = await client.command('tabs.create', { url });
    const run = (action, params = {}) => client.command(action, { tabId: tab.id, ...params });
    const first = await until(async () => { const s = await sample(tab.id); return s.video?.ready >= 3 && s.video.width ? s : null; }, name + ' decoded video');
    if (first.video.paused) await run('page.click', { selector: '.ytp-play-button' });
    await until(async () => { const s = await sample(tab.id); return !s.video.paused && s.video.time > first.video.time + 2 && s.video.frames > 20; }, 'playing content');
    report.first = await sample(tab.id); report.nonBlackRatio = await capture(tab.id, name + '-playing'); report.checks.push('Visible decoded content without pre-roll ads');
    console.log('PASS', name, 'visible content', { time: report.first.video.time, frames: report.first.video.frames, nonBlackRatio: report.nonBlackRatio });
    await run('page.click', { selector: '.ytp-play-button' }); await until(async () => (await sample(tab.id)).video.paused, 'pause');
    const paused = await sample(tab.id); await pause(1200); assert.ok((await sample(tab.id)).video.time - paused.video.time < .5);
    await run('page.click', { selector: '.ytp-play-button' }); await until(async () => !(await sample(tab.id)).video.paused, 'resume'); report.checks.push('Pause and resume through trusted input');
    const preSeek = await sample(tab.id); await run('page.key', { key: 'l' }); await until(async () => (await sample(tab.id)).video.time > preSeek.video.time + 8, 'seek'); report.checks.push('Seek forward');
    await client.command('browser.mission', { open: true }); assert.equal((await client.command('browser.state')).missionOpen, true);
    await client.command('browser.mission', { open: false }); await client.command('tabs.activate', { tabId: tab.id });
    const fresh = await client.command('tabs.create', {}); await pause(1000); await client.command('tabs.activate', { tabId: tab.id });
    await capture(tab.id, name + '-after-tab-switch'); report.checks.push('Mission Control and tab switching retain visible playback');
    await run('page.click', { selector: '.ytp-fullscreen-button' }); await until(async () => (await sample(tab.id)).fullscreen, 'fullscreen');
    await capture(tab.id, name + '-fullscreen'); await run('page.key', { key: 'Escape' }); await until(async () => !(await sample(tab.id)).fullscreen, 'native Escape exit'); report.checks.push('Fullscreen and agent Escape');
    const muted = (await sample(tab.id)).video.muted;
    await run('page.key', { key: 'm' }); await until(async () => (await sample(tab.id)).video.muted !== muted, 'mute');
    await run('page.key', { key: 'm' }); await until(async () => (await sample(tab.id)).video.muted === muted, 'unmute'); report.checks.push('Player mute and unmute');
    const start = await sample(tab.id);
    for (let i = 0; i < 24; i++) { await pause(2500); const s = await sample(tab.id); assert.equal(s.video.paused, false, 'Playback paused during soak'); assert.ok(s.video.width > 0); report.observations.push({ time: s.video.time, frames: s.video.frames, dropped: s.video.dropped, ad: s.ad }); }
    const end = await sample(tab.id); assert.ok(end.video.time > start.video.time + 45); assert.ok(end.video.frames > start.video.frames + 100);
    report.finalNonBlackRatio = await capture(tab.id, name + '-after-soak'); report.checks.push('60-second uninterrupted content soak with no ad-showing samples'); report.passed = true;
    console.log('PASS', name, 'all native playback checks', { time: end.video.time, frames: end.video.frames });
    await client.command('tabs.close', { tabId: tab.id }); await client.command('tabs.close', { tabId: fresh.id });
  }
  assert.ok(!/UnhandledPromiseRejection|MaxListenersExceeded|Uncaught Exception/.test(stderr), 'Unhandled browser error');
  fs.writeFileSync(path.join(work, 'media-results.json'), JSON.stringify({ passed: true, packaged: !!process.env.ASTER_EXECUTABLE, launch: 'normal executable, no debugger flags', profile, checkedAt: new Date().toISOString(), reports }, null, 2));
}
main().catch(async error => {
  console.error(error.stack);
  try { const state = await client.command('browser.state'); fs.writeFileSync(path.join(work, 'media-diagnostics.json'), JSON.stringify(state, null, 2)); } catch {}
  fs.writeFileSync(path.join(work, 'media-results.json'), JSON.stringify({ passed: false, error: error.message, lastSample: error.sample, reports }, null, 2)); process.exitCode = 1;
}).finally(async () => { await client?.disconnect().catch(() => {}); if (child?.exitCode === null) child.kill('SIGTERM'); });
