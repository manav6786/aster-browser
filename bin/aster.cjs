#!/usr/bin/env node
'use strict';
const { createClient } = require('./client.cjs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const agentIndex = args.indexOf('--agent');
let name = process.env.ASTER_AGENT_NAME || 'CLI';
if (agentIndex >= 0) { name = args[agentIndex + 1] || name; args.splice(agentIndex, 2); }
if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
  console.log(`Aster CLI — control the running shared browser\n\n  node bin/aster.cjs tabs.list\n  node bin/aster.cjs tabs.create '{"url":"https://example.com"}'\n  node bin/aster.cjs page.snapshot '{"tabId":"…"}'\n  node bin/aster.cjs page.click '{"tabId":"…","selector":"button"}'\n  node bin/aster.cjs --agent Researcher session\n\nSession mode reads one JSON object per line: {"action":"tabs.list","params":{}}.\nKeep a session open to retain claims and appear in the Team panel.\nAll tab commands require explicit tabId. Use ASTER_CONNECTION for a custom profile.`);
  process.exit(0);
}
const client = createClient(name, 'CLI');
async function main() {
  if (args[0] === 'session') {
    await client.connect();
    const lines = readline.createInterface({ input: process.stdin });
    for await (const line of lines) {
      try { const input = JSON.parse(line); console.log(JSON.stringify({ result: await client.command(input.action, input.params || {}) })); }
      catch (error) { console.log(JSON.stringify({ error: error.message })); }
    }
  } else console.log(JSON.stringify(await client.command(args[0], args[1] ? JSON.parse(args[1]) : {}), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => client.disconnect());
process.once('SIGINT', () => client.disconnect().finally(() => process.exit(0)));
process.once('SIGTERM', () => client.disconnect().finally(() => process.exit(0)));
