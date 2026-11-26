'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVpnController, parseStatus, parseSettings } = require('../src/main/vpn.cjs');
const CLI = '/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli';

function fixture(options = {}) {
  let time = 1000, connection = options.status || 'Disconnected', transition = [];
  const calls = [], updates = [];
  const controller = createVpnController({ onState: state => updates.push(state) }, {
    platform: options.platform || 'darwin', now: () => time,
    wait: async ms => { time += ms; },
    fs: {
      lstat: async () => { if (options.missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => Boolean(options.symlink) }; },
      realpath: async () => options.resolved || CLI
    },
    run: async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === '/usr/bin/codesign') { if (options.badSignature) throw new Error('invalid signature'); return { stdout: '', stderr: '' }; }
      assert.equal(file, CLI, 'Only the canonical CLI can be run');
      const action = args.at(-1);
      assert.deepEqual(args.slice(0, 2), ['--no-ansi', '--no-paginate']);
      if (action === 'status') {
        if (options.daemonMissing) throw Object.assign(new Error('daemon unavailable'), { output: '{"code":"FailedToConnectToDaemon","error":"No such file or directory (os error 2)"}' });
        if (transition.length) connection = transition.shift();
        return { stdout: 'Status update: ' + connection, stderr: '' };
      }
      if (action === 'settings') return { stdout: '(default) Mode: ' + (options.mode || 'WarpWithDnsOverHttps') + '\n(network policy) Switch Locked: ' + Boolean(options.locked), stderr: '' };
      if (action === 'connect') { if (options.connectError) throw new Error(options.connectError); transition = options.neverConnects ? [] : ['Connecting', 'Connected']; return { stdout: 'Success', stderr: '' }; }
      if (action === 'disconnect') { if (options.disconnectError) throw new Error(options.disconnectError); transition = ['Disconnecting', 'Disconnected']; return { stdout: 'Success', stderr: '' }; }
      throw new Error('Unexpected provider command: ' + action);
    }
  });
  return { controller, calls, updates, mutationCalls: () => calls.filter(c => c.file === CLI && ['connect', 'disconnect'].includes(c.args.at(-1))) };
}

test('status parser distinguishes exact provider states and never guesses from a substring', () => {
  assert.equal(parseStatus('Status update: Connected').status, 'connected');
  assert.equal(parseStatus('Status update: Disconnected\nReason: User disabled').status, 'disconnected');
  assert.equal(parseStatus('\x1b[32mStatus update: Connecting\x1b[0m').status, 'connecting');
  assert.equal(parseStatus('Disconnected from daemon').status, 'unknown');
  assert.equal(parseStatus('Not Connected').status, 'unknown');
  assert.equal(parseStatus('Success').status, 'unknown');
  assert.equal(parseStatus('Status update: Unable to connect\nError reason: blocked').status, 'unable-to-connect');
});

test('settings parser separates real tunnel, DNS-only and local proxy modes', () => {
  assert.deepEqual(parseSettings('(user set) Mode: WarpWithDnsOverHttps\n(default) Switch Locked: false'), { mode: 'WarpWithDnsOverHttps', kind: 'tunnel', locked: false });
  assert.equal(parseSettings('Service mode: DnsOverHttps').kind, 'dns-only');
  assert.equal(parseSettings('Mode: WarpProxy on port 40000').kind, 'proxy-only');
  assert.equal(parseSettings('Mode: tunnel_only').kind, 'tunnel');
  assert.equal(parseSettings('Mode: UnknownNewMode').kind, 'unknown');
  assert.equal(parseSettings('Switch Locked: true').locked, true);
});

test('missing client is unavailable and no command runs', async t => {
  const f = fixture({ missing: true }); t.after(() => f.controller.dispose());
  const result = await f.controller.refresh(); assert.equal(result.status, 'unavailable'); assert.equal(result.connected, null); assert.equal(result.installed, false);
  await f.controller.connect(); assert.equal(f.calls.length, 0);
});

test('untrusted signature or redirected executable never executes the CLI', async t => {
  for (const options of [{ badSignature: true }, { symlink: true }, { resolved: '/tmp/warp-cli' }]) {
    const f = fixture(options); t.after(() => f.controller.dispose());
    const result = await f.controller.refresh(); assert.equal(result.status, 'untrusted'); assert.equal(result.connected, null);
    assert.equal(f.calls.filter(call => call.file === CLI).length, 0);
  }
});

test('refresh is read-only even when WARP is already connected', async t => {
  const f = fixture({ status: 'Connected' }); t.after(() => f.controller.dispose());
  const result = await f.controller.refresh(); assert.equal(result.status, 'connected'); assert.equal(result.connected, true); assert.equal(result.deviceWide, true);
  assert.equal(f.mutationCalls().length, 0);
  const check = f.calls.find(c => c.file === '/usr/bin/codesign'); assert.ok(check.args.includes('--strict')); assert.ok(check.args.some(arg => arg.includes('68WVV388M8')));
});

test('connect confirms provider state after the request, rather than treating Success as connected', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  const result = await f.controller.connect(); assert.equal(result.status, 'connected'); assert.equal(result.connected, true);
  assert.equal(f.mutationCalls().length, 1); assert.ok(f.updates.some(state => state.status === 'connecting' && state.connected === null));
  assert.equal(f.updates.filter(state => state.connected === true).length, 1);
});

test('provider accepting connect without ever connecting does not produce a connected indicator', async t => {
  const f = fixture({ neverConnects: true }); t.after(() => f.controller.dispose());
  const result = await f.controller.connect(); assert.equal(result.status, 'disconnected'); assert.equal(result.connected, false); assert.equal(result.error.code, 'transition-timeout');
  assert.ok(f.updates.every(state => state.connected !== true));
});

test('DNS-only, proxy-only and unknown modes cannot be presented or enabled as full VPN', async t => {
  for (const mode of ['DnsOverHttps', 'WarpProxy', 'FutureMode']) {
    const f = fixture({ status: 'Connected', mode }); t.after(() => f.controller.dispose());
    const observed = await f.controller.refresh(); assert.notEqual(observed.connected, true);
    const result = await f.controller.connect(); assert.equal(result.error.code, 'mode-required'); assert.equal(f.mutationCalls().length, 0);
  }
});

test('daemon/registration setup problems stay explicit and do not trigger first-run enrollment', async t => {
  const f = fixture({ daemonMissing: true }); t.after(() => f.controller.dispose());
  const result = await f.controller.refresh(); assert.equal(result.status, 'setup-required'); assert.equal(result.error.code, 'daemon-unavailable');
  await f.controller.connect(); assert.equal(f.mutationCalls().length, 0);
});

test('device policy lock is respected without invoking an override command', async t => {
  const f = fixture({ locked: true }); t.after(() => f.controller.dispose());
  const result = await f.controller.connect(); assert.equal(result.error.code, 'provider-policy'); assert.equal(f.mutationCalls().length, 0);
});

test('disconnect must be confirmed and a denied request preserves actual connected state', async t => {
  const f = fixture({ status: 'Connected' }); t.after(() => f.controller.dispose());
  assert.equal((await f.controller.disconnect()).status, 'disconnected');
  const denied = fixture({ status: 'Connected', disconnectError: 'Permission denied by policy' }); t.after(() => denied.controller.dispose());
  const result = await denied.controller.disconnect(); assert.equal(result.status, 'connected'); assert.equal(result.connected, true); assert.equal(result.error.code, 'provider-policy');
});

test('requests serialize, reject invalid toggle inputs and do not run after disposal', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  const connecting = f.controller.connect(), disconnecting = f.controller.disconnect();
  assert.equal((await connecting).status, 'connected'); assert.equal((await disconnecting).status, 'disconnected');
  assert.deepEqual(f.mutationCalls().map(c => c.args.at(-1)), ['connect', 'disconnect']);
  await assert.rejects(f.controller.setEnabled('yes'), /boolean/);
  f.controller.dispose(); await assert.rejects(f.controller.refresh(), /closed/);
});
