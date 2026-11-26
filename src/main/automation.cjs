'use strict';
const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
async function startAutomation({ directory, command, connect, disconnect, onEvent }) {
  const token = randomBytes(32).toString('hex');
  const connections = new Map();
  const streams = new Set();
  function authorize(req) {
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return false;
    const expected = Buffer.from('Bearer ' + token);
    const actual = Buffer.from(String(req.headers.authorization || ''));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    if (!authorize(req)) return send(res, 401, { error: 'A local Aster token is required. Browser-origin requests are disabled.' });
    try {
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && route === '/health') return send(res, 200, { name: 'Aster', version: '0.4.4', protocol: 1 });
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1048576) { send(res, 413, { error: 'Request exceeds 1 MiB' }); req.destroy(); return; } }
        const input = JSON.parse(body || '{}');
        if (route === '/connect') {
          if (connections.size >= 64) throw new Error('Maximum 64 simultaneous agent connections');
          const agent = { id: randomUUID(), name: String(input.name || 'Local agent').slice(0, 80), transport: String(input.transport || 'HTTP').slice(0, 24), connectedAt: Date.now(), lastSeen: Date.now(), tabs: [] };
          connections.set(agent.id, agent); connect(agent); return send(res, 200, { agentId: agent.id, protocol: 1 });
        }
        const agent = connections.get(String(req.headers['x-aster-agent'] || ''));
        if (!agent) return send(res, 401, { error: 'Connect first with POST /connect' });
        agent.lastSeen = Date.now();
        if (route === '/disconnect') { connections.delete(agent.id); disconnect(agent.id); return send(res, 200, { disconnected: true }); }
        if (route === '/heartbeat') return send(res, 200, { ok: true });
        if (route === '/command') return send(res, 200, { result: await command(String(input.action || ''), input.params || {}, agent) });
      }
      if (req.method === 'GET' && route === '/events') {
        const agent = connections.get(String(req.headers['x-aster-agent'] || ''));
        if (!agent) return send(res, 401, { error: 'Connect first' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
      }
      send(res, 404, { error: 'Unknown endpoint' });
    } catch (error) { if (!res.headersSent) send(res, 400, { error: error.message, ...(error.details?{details:error.details}:{}) }); }
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.ASTER_PORT || 4318), '127.0.0.1', resolve);
  }).catch(async error => { if (error.code !== 'EADDRINUSE') throw error; await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); });
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const tokenPath = path.join(directory, 'automation.json');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tokenPath + '.tmp', JSON.stringify({ endpoint, token, pid: process.pid, protocol: 1 }), { mode: 0o600 });
  fs.renameSync(tokenPath + '.tmp', tokenPath);
  fs.chmodSync(tokenPath, 0o600);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, agent] of connections) if (now - agent.lastSeen > 90000) { connections.delete(id); disconnect(id); }
    for (const stream of streams) stream.write(': heartbeat\n\n');
  }, 15000); timer.unref();
  return { endpoint, tokenPath,
    publish(event) { for (const stream of streams) stream.write('data: ' + JSON.stringify(event) + '\n\n'); onEvent?.(event); },
    close() { clearInterval(timer); for (const stream of streams) stream.end(); server.close(); try { const config = JSON.parse(fs.readFileSync(tokenPath)); if (config.pid === process.pid) fs.unlinkSync(tokenPath); } catch {} }
  };
}
module.exports = { startAutomation };
