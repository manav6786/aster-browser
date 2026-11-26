'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const app = spawn(require('electron'), [root], {
  cwd: root,
  env: { ...process.env, ASTER_AUTOMATION: '1' },
  stdio: 'inherit',
});
app.on('error', error => { console.error(error.message); process.exitCode = 1; });
app.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
