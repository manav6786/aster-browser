'use strict';
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

// These paths and arguments are deliberately fixed. No renderer/harness input is
// ever interpreted as an executable, a shell command, a VPN endpoint, or a token.
const CLI_PATH = '/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli';
const SIGNATURE_REQUIREMENT = '=anchor apple generic and certificate leaf[subject.OU] = "68WVV388M8" and identifier = "warp-cli"';
const INSTALL_URL = 'https://developers.cloudflare.com/warp-client/get-started/macos/';
const DOWNLOAD_URL = 'https://downloads.cloudflareclient.com/v1/download/macos/ga';
const COMMON_ARGS = ['--no-ansi', '--no-paginate'];
const COMMAND_TIMEOUT = 8000, TRANSITION_TIMEOUT = 30000;

function plainText(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').trim().slice(0, 65536);
}

function parseStatus(output) {
  const text = plainText(output);
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^(?:Status(?: update)?:\s*)?(Connected|Disconnected|Connecting|Disconnecting|Unable(?: to connect)?)(?:\s*\([^\n]*\))?\s*$/i.exec(lines[i].trim());
    if (match) return { status: match[1].toLowerCase().replace(/\s+/g, '-'), detail: text.slice(0, 1000) };
  }
  return { status: 'unknown', detail: text.slice(0, 1000) };
}

function parseSettings(output) {
  const text = plainText(output);
  const prefix = '^\\s*(?:\\([^\\n)]{1,100}\\)\\s*)?';
  const mode = new RegExp(prefix + '(?:Service\\s+)?Mode:\\s*([A-Za-z0-9_+.-]+)(?:\\s|$)', 'mi').exec(text)?.[1] || null;
  const lockedText = new RegExp(prefix + 'Switch Locked:\\s*(true|false)\\s*$', 'mi').exec(text)?.[1];
  const normalized = mode?.toLowerCase().replace(/[_-]/g, '');
  const fullModes = new Set(['warp', 'warp+doh', 'warp+dot', 'warpwithdns', 'warpwithdnsoverudp', 'warpwithdnsoverhttps', 'warpwithdnsovertls', 'tunnelonly']);
  const dnsModes = new Set(['doh', 'dot', 'dnsoverhttps', 'dnsovertls']);
  const proxyModes = new Set(['proxy', 'warpproxy']);
  return { mode, kind: fullModes.has(normalized) ? 'tunnel' : dnsModes.has(normalized) ? 'dns-only' : proxyModes.has(normalized) ? 'proxy-only' : 'unknown', locked: lockedText === undefined ? null : lockedText.toLowerCase() === 'true' };
}

function runExecutable(executable, args, timeout = COMMAND_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      timeout, killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TERM: 'dumb', NO_COLOR: '1' }
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout: plainText(stdout), stderr: plainText(stderr) });
      const failure = new Error(error.killed ? 'The WARP command timed out' : plainText(stderr || stdout || error.message).slice(0, 600));
      failure.code = error.killed ? 'command-timeout' : error.code;
      failure.output = plainText(stdout + '\n' + stderr);
      reject(failure);
    });
  });
}

function errorDetails(error) {
  const text = plainText(error.output || error.message);
  if (/FailedToConnectToDaemon|unable to connect to (?:the )?daemon|failed to connect to (?:the )?daemon|warp service is not running|No such file or directory \(os error 2\)/i.test(text)) {
    return { status: 'setup-required', code: 'daemon-unavailable', message: 'Open Cloudflare WARP and complete its setup. Its background service is not available.' };
  }
  if (/MissingRegistration|RegistrationMissing|registration (?:is )?missing|not registered|no registration|registration new|terms of service|accept-tos/i.test(text)) {
    return { status: 'setup-required', code: 'setup-required', message: 'Complete Cloudflare WARP’s first-run setup and review its terms in the WARP app.' };
  }
  if (/permission denied|access denied|administrator|locked|managed|policy/i.test(text)) {
    return { status: 'error', code: 'provider-policy', message: 'Cloudflare WARP denied this action. Check its app and any device management policy.' };
  }
  if (error.code === 'command-timeout') return { status: 'error', code: 'command-timeout', message: 'Cloudflare WARP did not respond within 8 seconds. The tunnel state is unknown; check the WARP app.' };
  return { status: 'error', code: 'provider-error', message: 'Cloudflare WARP could not complete the request. ' + text.slice(0, 300) };
}

function createVpnController({ onState } = {}, dependencies = {}) {
  // Dependency overrides are solely for isolated tests; they are not IPC inputs.
  const fileSystem = dependencies.fs || fs, run = dependencies.run || runExecutable;
  const platform = dependencies.platform || process.platform, now = dependencies.now || Date.now;
  const wait = dependencies.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let disposed = false, pending = Promise.resolve();
  let state = {
    provider: 'cloudflare-warp', name: 'Cloudflare WARP', free: true,
    deviceWide: true, status: 'checking', installed: false, trusted: false,
    connected: null, providerStatus: 'unknown', mode: null, modeKind: 'unknown', locked: null,
    checkedAt: null, requestedAt: null, error: null,
    message: 'Checking for the Cloudflare WARP client.',
    installUrl: INSTALL_URL, downloadUrl: DOWNLOAD_URL
  };
  const getState = () => ({ ...state, error: state.error ? { ...state.error } : null });
  function emit(next) {
    state = { ...state, ...next };
    const result = getState();
    if (!disposed && typeof onState === 'function') { try { onState(result); } catch {} }
    return result;
  }
  function serial(operation) {
    const result = pending.catch(() => {}).then(() => {
      if (disposed) throw new Error('VPN controller is closed');
      return operation();
    });
    pending = result; return result;
  }
  async function verifyInstallation() {
    if (platform !== 'darwin') return emit({ status: 'unavailable', installed: false, trusted: false, connected: null, providerStatus: 'unknown', checkedAt: now(), error: null, message: 'This WARP integration supports macOS.' });
    try {
      const entry = await fileSystem.lstat(CLI_PATH);
      const resolved = await fileSystem.realpath(CLI_PATH);
      if (!entry.isFile() || entry.isSymbolicLink() || resolved !== CLI_PATH) throw Object.assign(new Error('The WARP executable is not at its canonical installed path'), { code: 'untrusted-installation' });
      await run('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', SIGNATURE_REQUIREMENT, CLI_PATH]);
      return { installed: true, trusted: true };
    } catch (error) {
      if (error.code === 'ENOENT') return emit({ status: 'unavailable', installed: false, trusted: false, connected: null, providerStatus: 'unknown', mode: null, modeKind: 'unknown', checkedAt: now(), error: null, message: 'Install Cloudflare WARP to enable this free encrypted tunnel.' });
      return emit({ status: 'untrusted', installed: true, trusted: false, connected: null, providerStatus: 'unknown', checkedAt: now(), error: { code: 'untrusted-installation', message: 'The installed WARP CLI could not be verified as signed by Cloudflare.' }, message: 'Reinstall Cloudflare WARP from its official download. Aster will not run an unverified VPN client.' });
    }
  }
  async function cli(command) {
    // Revalidate the signature for every invocation, including transition polls.
    const verified = await verifyInstallation();
    if (!verified.trusted) throw Object.assign(new Error(verified.message), { code: verified.status });
    if (disposed) throw Object.assign(new Error('VPN controller is closed'), { code: 'controller-closed' });
    return run(CLI_PATH, [...COMMON_ARGS, command]);
  }
  async function readStatus() {
    const verified = await verifyInstallation();
    if (!verified.trusted) return getState();
    try {
      const statusResult = await cli('status');
      const parsed = parseStatus(statusResult.stdout);
      let settings = { mode: null, kind: 'unknown', locked: null };
      if (parsed.status !== 'disconnected') settings = parseSettings((await cli('settings')).stdout);
      // Also retrieve settings while disconnected so the UI can explain a DNS-only
      // mode before the user requests a connection. A read failure cannot turn a
      // confirmed disconnected state into a connected one.
      else { try { settings = parseSettings((await cli('settings')).stdout); } catch {} }
      const base = { installed: true, trusted: true, providerStatus: parsed.status, mode: settings.mode, modeKind: settings.kind, locked: settings.locked, checkedAt: now(), error: null };
      if (parsed.status === 'connected') {
        if (settings.kind === 'tunnel') return { ...base, status: 'connected', connected: true, message: 'Cloudflare WARP reports an active device tunnel. This affects all applications using this Mac’s network.' };
        if (settings.kind === 'dns-only') return { ...base, status: 'dns-only', connected: false, message: 'WARP is encrypting DNS only. Select Traffic and DNS in the WARP app to tunnel browsing traffic.' };
        if (settings.kind === 'proxy-only') return { ...base, status: 'proxy-only', connected: false, message: 'WARP is in local proxy mode. Aster has not routed its traffic through that proxy.' };
        return { ...base, status: 'unknown', connected: null, message: 'WARP reports a connection, but its traffic mode is unrecognized. Check the WARP app.' };
      }
      if (parsed.status === 'disconnected') return { ...base, status: 'disconnected', connected: false, message: 'Cloudflare WARP is disconnected.' };
      if (parsed.status === 'connecting' || parsed.status === 'disconnecting') return { ...base, status: parsed.status, connected: null, message: parsed.status === 'connecting' ? 'Cloudflare WARP is establishing its tunnel.' : 'Cloudflare WARP is disconnecting.' };
      if (parsed.status === 'unable' || parsed.status === 'unable-to-connect') {
        // Current WARP exits successfully for first-run registration failures;
        // their setup reason must be handled even without a subprocess error.
        const detail = errorDetails({ output: parsed.detail });
        if (detail.status === 'setup-required') return { ...base, status: detail.status, connected: false, error: { code: detail.code, message: detail.message }, message: detail.message };
        return { ...base, status: 'error', connected: false, error: { code: 'connection-failed', message: parsed.detail.slice(0, 500) }, message: 'Cloudflare WARP reports that it cannot connect. Check its app for the reason.' };
      }
      return { ...base, status: 'unknown', connected: null, message: 'Cloudflare WARP returned an unrecognized status. Check the WARP app.' };
    } catch (error) {
      if (['unavailable', 'untrusted'].includes(error.code)) return getState();
      const detail = errorDetails(error);
      return { installed: true, trusted: true, status: detail.status, providerStatus: 'unknown', connected: null, checkedAt: now(), error: { code: detail.code, message: detail.message }, message: detail.message };
    }
  }
  async function refresh() { return serial(async () => emit(await readStatus())); }
  async function changeConnection(enabled) {
    let observed = await readStatus(); emit(observed);
    if (disposed) return getState();
    if (!observed.trusted || !observed.installed || observed.status === 'setup-required') return getState();
    if (observed.locked === true) return emit({ error: { code: 'provider-policy', message: 'The WARP switch is locked by device policy. Aster will not override it.' } });
    if (enabled && observed.connected === true) return getState();
    if (!enabled && observed.providerStatus === 'disconnected') return getState();
    if (enabled && observed.modeKind !== 'tunnel') return emit({ error: { code: 'mode-required', message: 'Select Traffic and DNS in the WARP app before connecting from Aster. Aster will not silently change another app’s VPN configuration.' } });
    const phase = enabled ? 'connecting' : 'disconnecting';
    emit({ status: phase, connected: null, requestedAt: now(), error: null, message: enabled ? 'Requesting a Cloudflare WARP connection…' : 'Requesting Cloudflare WARP disconnection…' });
    try { await cli(enabled ? 'connect' : 'disconnect'); }
    catch (error) {
      const detail = errorDetails(error); observed = await readStatus();
      return emit({ ...observed, error: { code: detail.code, message: detail.message } });
    }
    const deadline = now() + TRANSITION_TIMEOUT;
    do {
      observed = await readStatus();
      if ((enabled && observed.connected === true) || (!enabled && observed.providerStatus === 'disconnected')) return emit(observed);
      if (!observed.trusted || observed.status === 'setup-required' || observed.status === 'error' || (enabled && ['dns-only', 'proxy-only'].includes(observed.status))) return emit(observed);
      emit({ ...observed, status: phase, connected: null, message: enabled ? 'Waiting for Cloudflare WARP to confirm its tunnel…' : 'Waiting for Cloudflare WARP to confirm disconnection…' });
      await wait(1000);
    } while (now() < deadline && !disposed);
    if (disposed) return getState();
    return emit({ ...observed, error: { code: 'transition-timeout', message: 'WARP has not confirmed the requested state within 30 seconds. Check its app; Aster has not assumed success.' } });
  }
  return {
    getState, refresh,
    connect: () => serial(() => changeConnection(true)),
    disconnect: () => serial(() => changeConnection(false)),
    setEnabled: enabled => { if (typeof enabled !== 'boolean') return Promise.reject(new Error('enabled must be a boolean')); return serial(() => changeConnection(enabled)); },
    dispose() { disposed = true; }
  };
}

module.exports = { createVpnController, parseStatus, parseSettings, INSTALL_URL, DOWNLOAD_URL };
