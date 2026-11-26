#!/usr/bin/env node
'use strict';
// Build the optional Node-API addon using only installed headers and Apple tools.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const required = process.argv.includes('--required');
function unavailable(reason) {
  console.log(JSON.stringify({ built: false, optional: !required, reason }));
  process.exit(required ? 1 : 0);
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: root, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
if (process.platform !== 'darwin') unavailable('Native gesture phases are available only on macOS.');
try {
  const sdk = run('xcrun', ['--show-sdk-path']);
  const electronVersion = require(path.join(root, 'node_modules/electron/package.json')).version;
  const explicit = process.env.ASTER_NODE_HEADERS;
  const headerCandidates = [
    explicit, explicit && path.join(explicit, 'include/node'),
    path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../include/node'),
    '/opt/homebrew/include/node', '/usr/local/include/node',
    path.join(os.homedir(), '.electron-gyp', electronVersion, 'include/node'),
    path.join(os.homedir(), 'Library/Caches/node-gyp', process.versions.node, 'include/node'),
    path.join(os.homedir(), '.cache/node-gyp', process.versions.node, 'include/node')
  ].filter(Boolean);
  const headers = headerCandidates.find(candidate => ['node_api.h', 'js_native_api.h'].every(file => fs.existsSync(path.join(candidate, file))));
  if (!headers) unavailable('No installed Node-API headers found. Set ASTER_NODE_HEADERS to an existing include/node directory.');
  const architecture = process.env.ASTER_GESTURES_ARCH || process.arch;
  if (!['arm64', 'x64'].includes(architecture)) unavailable(`Unsupported target architecture: ${architecture}`);
  const output = path.join(root, 'src/native/gesture-phases.node');
  const temporary = `${output}.${process.pid}.building`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try {
    run('xcrun', ['clang++', '-arch', architecture === 'x64' ? 'x86_64' : 'arm64', '-std=c++17', '-fobjc-arc', '-fblocks', '-O2', '-fvisibility=hidden', '-bundle', '-undefined', 'dynamic_lookup', '-isysroot', sdk, '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=aster_gesture_phases', '-I', headers, path.join(root, 'native/gesture-phases.mm'), '-framework', 'AppKit', '-framework', 'Foundation', '-o', temporary]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', temporary]);
    fs.renameSync(temporary, output);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  console.log(JSON.stringify({ built: true, output: path.relative(root, output), architecture, sdk, headers, nodeApi: 8, electron: electronVersion, signed: 'local-ad-hoc', runtimeMinimum: 'macOS13', scope: 'local own-window scroll phases; no event consumption' }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
