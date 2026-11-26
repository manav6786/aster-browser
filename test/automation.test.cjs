'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startAutomation } = require('../src/main/automation.cjs');
test('local API requires token, rejects browser origins, and isolates live connections', async () => {
  const work = process.env.ASTER_TEST_WORK || path.resolve(__dirname, '../work');
  fs.mkdirSync(work, { recursive: true });
  const directory = fs.mkdtempSync(path.join(work, 'api-test-'));
  const connected = new Set(); const prior = process.env.ASTER_PORT; process.env.ASTER_PORT = '0';
  const api = await startAutomation({ directory, command: (action, params, agent) => ({ action, params, agentId: agent.id }), connect: agent => connected.add(agent.id), disconnect: id => connected.delete(id) });
  try {
    const config = JSON.parse(fs.readFileSync(api.tokenPath)); assert.equal(fs.statSync(api.tokenPath).mode & 0o777, 0o600);
    assert.equal((await fetch(api.endpoint + '/health')).status, 401);
    const headers = { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(api.endpoint + '/health', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 401);
    const one = await (await fetch(api.endpoint + '/connect', { method: 'POST', headers, body: JSON.stringify({ name: 'One' }) })).json();
    const two = await (await fetch(api.endpoint + '/connect', { method: 'POST', headers, body: JSON.stringify({ name: 'Two' }) })).json();
    assert.notEqual(one.agentId, two.agentId); assert.equal(connected.size, 2);
    const result = await (await fetch(api.endpoint + '/command', { method: 'POST', headers: { ...headers, 'X-Aster-Agent': one.agentId }, body: JSON.stringify({ action: 'tabs.list', params: {} }) })).json();
    assert.equal(result.result.agentId, one.agentId);
    assert.equal((await fetch(api.endpoint + '/command', { method: 'POST', headers, body: '{}' })).status, 401);
    await fetch(api.endpoint + '/disconnect', { method: 'POST', headers: { ...headers, 'X-Aster-Agent': one.agentId }, body: '{}' }); assert.equal(connected.size, 1);
  } finally { api.close(); fs.rmSync(directory, { recursive: true, force: true }); if (prior === undefined) delete process.env.ASTER_PORT; else process.env.ASTER_PORT = prior; }
});
