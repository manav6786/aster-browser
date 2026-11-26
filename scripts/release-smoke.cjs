'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { version } = require('../package.json');

const executablePath = process.env.ASTER_EXECUTABLE;
if (!executablePath) throw new Error('Set ASTER_EXECUTABLE to the installed Aster executable.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-release-'));
const clip = fs.readFileSync(path.resolve(__dirname, '../docs/media/aster-tour.mp4'));
let app, chrome;

const server = http.createServer((request, response) => {
  if (request.url === '/tour.mp4') {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': clip.length });
    return response.end(clip);
  }
  const second = request.url === '/second';
  const title = second ? 'Release playback' : 'Release navigation';
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>${second ? '<video src="/tour.mp4" muted autoplay loop controls></video>' : '<a href="/second">Playback</a>'}`);
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}

async function launch() {
  app = await _electron.launch({
    executablePath: path.resolve(executablePath),
    env: { ...process.env, ASTER_DATA_DIR: profile, ASTER_AUTOMATION: '0', ASTER_DISABLE_FILTER_UPDATES: '1' },
    timeout: 45000,
  });
  chrome = await app.firstWindow({ timeout: 45000 });
  await chrome.waitForFunction(() => Boolean(window.aster && document.querySelector('.tab.active')));
}

const invoke = (command, payload = {}) => chrome.evaluate(({ command, payload }) => window.aster.invoke(command, payload), { command, payload });
const current = async () => {
  const browser = await invoke('state:get');
  return browser.tabs.find(tab => tab.id === browser.activeTabId);
};

async function visit(url, title) {
  const field = chrome.locator('#address');
  await field.fill(url);
  await field.press('Enter');
  await until(async () => {
    const tab = await current();
    return tab?.url === url && tab.title === title && !tab.isLoading && !tab.error;
  }, 'loading ' + title);
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await launch();
  const identity = await app.evaluate(({ app }) => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged }));
  assert.deepEqual(identity, { version, platform: process.platform, arch: process.arch, packaged: true });
  assert.equal(fs.existsSync(path.join(profile, 'automation.json')), false);
  assert.equal((await invoke('state:get')).shields.status, 'ready');
  await chrome.locator('.orb-image').evaluate(async image => { await image.decode(); if (!image.naturalWidth) throw new Error('Artwork failed to load'); });
  const metrics = await chrome.evaluate(() => ({ frame: document.documentElement.dataset.windowFrame, y: document.querySelector('#content').getBoundingClientRect().y, key: document.querySelector('#address-shortcut').textContent }));
  const macOS = process.platform === 'darwin';
  assert.equal(metrics.frame, macOS ? 'custom' : 'system');
  assert.equal(metrics.y, macOS ? 86 : 60);
  assert.match(metrics.key, macOS ? /⌘/ : /Ctrl/);
  console.log('PASS packaged home, shortcuts, protection, and default local-control state');

  await visit(origin + '/first', 'Release navigation');
  await visit(origin + '/second', 'Release playback');
  const page = await app.evaluate(async ({ BrowserWindow }, { origin, y }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const active = win.contentView.children.find(view => view.webContents?.getURL() === origin + '/second');
    if (!active || !active.getVisible() || active.getBounds().y !== y) throw new Error('The native page must line up below the toolbar');
    return active.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const video = document.querySelector('video');
        if (video?.currentTime > 0.2 && video.videoWidth > 0) {
          clearInterval(timer);
          resolve({ decoded: true, node: typeof process, bridge: typeof window.aster });
        } else if (Date.now() - started > 10000) {
          clearInterval(timer);
          reject(new Error('Media did not start'));
        }
      }, 100);
    })`);
  }, { origin, y: metrics.y });
  assert.deepEqual(page, { decoded: true, node: 'undefined', bridge: 'undefined' });
  await chrome.locator('#back').click();
  await until(async () => (await current()).url === origin + '/first', 'Back navigation');
  await chrome.locator('#forward').click();
  await until(async () => (await current()).url === origin + '/second', 'Forward navigation');
  console.log('PASS real browser view, sandbox, video playback, and Back/Forward');

  await chrome.locator('.mission-button').click();
  await chrome.locator('#mission .mission-card').first().waitFor({ state: 'visible' });
  await chrome.locator('#mission [data-action=mission-close]').click();
  await chrome.locator('.more-button').click();
  await chrome.locator('#floating [data-action=private]').click();
  await until(async () => (await current()).private, 'private tab');
  await app.close();
  app = null;
  await launch();
  await until(async () => (await current()).url === origin + '/second', 'restored tab');
  assert.ok((await invoke('state:get')).tabs.every(tab => !tab.private));
  console.log(`PASS Mission Control and normal session restore (${identity.platform}/${identity.arch}, ${identity.version})`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
});
