'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function configPath() { return process.env.ASTER_CONNECTION || path.join(process.env.ASTER_DATA_DIR || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/Aster') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Aster')), 'automation.json'); }
function createClient(name, transport) {
  let config, agentId, heartbeat, connecting;
  function refreshConfig() {
    let next;
    try { next = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { throw new Error('Start Aster first. If using a custom profile, set ASTER_CONNECTION to its automation.json path.'); }
    const url = new URL(next.endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Aster’s connection endpoint must be loopback HTTP');
    if (config && (config.token !== next.token || config.endpoint !== next.endpoint)) { agentId = null; clearInterval(heartbeat); }
    config = next;
  }
  async function request(route, body, method = 'POST') {
    if (!config) refreshConfig();
    const response = await fetch(config.endpoint + route, { method, headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', ...(agentId ? { 'X-Aster-Agent': agentId } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}), signal: AbortSignal.timeout(60000) });
    const result = await response.json(); if (!response.ok) { const error = new Error(result.error || 'Aster request failed'); error.status = response.status; if (result.details) error.details = result.details; throw error; } return result;
  }
  return {
    async connect() { refreshConfig(); if (agentId) return agentId; if (!connecting) connecting = (async () => { const result = await request('/connect', { name, transport }); agentId = result.agentId; clearInterval(heartbeat); heartbeat = setInterval(() => request('/heartbeat').catch(() => { agentId = null; clearInterval(heartbeat); }), 20000); heartbeat.unref(); return agentId; })(); try { return await connecting; } finally { connecting = null; } },
    async command(action, params = {}) {
      refreshConfig(); if (!agentId) await this.connect();
      try { return (await request('/command', { action, params })).result; }
      catch (error) {
        // 401 is rejected before dispatch, so reconnecting cannot duplicate an
        // action. Never replay network failures: the action may have completed.
        if (error.status !== 401) throw error;
        agentId = null; await this.connect(); return (await request('/command', { action, params })).result;
      }
    },
    async disconnect() { clearInterval(heartbeat); if (agentId) { try { await request('/disconnect'); } catch {} agentId = null; } },
    get agentId() { return agentId; }
  };
}
module.exports = { createClient, configPath };
