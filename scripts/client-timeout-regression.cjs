'use strict';
// Uses only the real loopback HTTP automation server/client. No Electron launch,
// page connection, user profile access, or native focus operations.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { startAutomation } = require(path.join(root, 'src/main/automation.cjs'));
const { createClient } = require(path.join(root, 'bin/client.cjs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const directory = fs.mkdtempSync(path.join(__dirname, 'http-timeout-'));
  const savedConnection = process.env.ASTER_CONNECTION, savedPort = process.env.ASTER_PORT;
  process.env.ASTER_PORT = '0';
  let completed = false, completedMs, commandStarted;
  const api = await startAutomation({ directory, connect() {}, disconnect() {}, command: async () => {
    commandStarted = Date.now();
    await delay(61000);
    completed = true; completedMs = Date.now() - commandStarted;
    return { matched: true };
  } });
  process.env.ASTER_CONNECTION = api.tokenPath;
  const client = createClient('Long timeout audit', 'HTTP fixture');
  let observation;
  try {
    await client.connect(); const began = Date.now();
    const result = await client.command('page.waitFor', { tabId: 'fixture', selector: '#delayed', timeoutMs: 90000 });
    const duration = Date.now() - began;
    assert.equal(result.matched,true);assert.equal(completed,true);assert.ok(duration>=60000&&duration<90000);
    observation = { requestedActionTimeoutMs:90000, clientSucceededAfterMs:duration, matched:result.matched, completedAtReply:completed };
    await delay(1400);
    assert.equal(completed, true);
    console.log(JSON.stringify({ ...observation, handlerEventuallyCompleted: completed, handlerDurationMs: completedMs }, null, 2));
  } finally {
    await client.disconnect(); api.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (savedConnection === undefined) delete process.env.ASTER_CONNECTION; else process.env.ASTER_CONNECTION = savedConnection;
    if (savedPort === undefined) delete process.env.ASTER_PORT; else process.env.ASTER_PORT = savedPort;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
