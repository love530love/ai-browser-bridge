import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNetstatListener,
  probeProcessIdentity,
  listenerIdentityVerified,
  watchdogIdentityVerified,
  evaluateRestartPreflight,
  restartServiceWhenIdle
} from '../src/service-restart.js';

const ROOT = 'K:\\PythonProjects5\\AI-Browser-Bridge';

const idleStatus = overrides => ({
  service: 'ai-browser-bridge', version: '0.44.0',
  buildId: 'running-build-1', pid: 4242,
  active: null, activeCount: 0, queued: 0, taskLease: null,
  desktopOperation: null, tabLeases: [], maintenance: null,
  ...overrides
});

const nodeListener = (pid = 4242, commandLine = 'node src/server.js') => ({
  checked: true, pid, error: null,
  identity: { checked: true, pid, executablePath: 'C:\\Program Files\\nodejs\\node.exe', commandLine, error: null }
});

const watchdog = (pid = 7777, commandLine = `pwsh.exe -File "${ROOT}\\scripts\\watch-service.ps1"`) => ({
  checked: true, pid, error: null,
  identity: { checked: true, pid, executablePath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', commandLine, error: null }
});

const ready = () => ({ status: idleStatus(), diskBuildId: 'disk-build-2', listener: nodeListener(), watchdog: watchdog(), root: ROOT });

test('probeProcessIdentity answers through the fast NtQuery script before touching CIM', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const execFileFn = (command, args) => {
    calls.push({ command, args });
    return JSON.stringify({ processId: 4242, commandLine: `node "${ROOT}\\src\\server.js"`, executablePath: 'C:\\Program Files\\nodejs\\node.exe' });
  };
  const identity = probeProcessIdentity(4242, { execFileFn });
  assert.equal(identity.checked, true);
  assert.equal(identity.commandLine, `node "${ROOT}\\src\\server.js"`);
  assert.equal(calls.length, 1, 'the fast path must win on the first attempt');
  assert.match(calls[0].args.join(' '), /probe-process-identity\.ps1/);
});

test('probeProcessIdentity falls back to CIM only after both fast entry points fail', { skip: process.platform !== 'win32' }, () => {
  let attempt = 0;
  const execFileFn = () => {
    attempt += 1;
    if (attempt <= 2) throw new Error('spawn EPERM');
    return JSON.stringify({ ProcessId: 4242, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node src/server.js' });
  };
  const identity = probeProcessIdentity(4242, { execFileFn, timeoutMs: 100, cimTimeoutMs: 100 });
  assert.equal(identity.commandLine, 'node src/server.js');
  assert.equal(attempt, 3, 'pwsh + powershell fast attempts, then CIM');
});

test('parseNetstatListener returns only the LISTENING pid for the requested port', () => {
  const stdout = [
    '  TCP    127.0.0.1:19387        0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:19387        127.0.0.1:51512        ESTABLISHED     4242',
    '  TCP    127.0.0.1:19388        0.0.0.0:0              LISTENING       1000'
  ].join('\r\n');
  assert.equal(parseNetstatListener(stdout, 19387), 4242);
  assert.equal(parseNetstatListener(stdout, 19999), null);
  assert.equal(parseNetstatListener('', 19387), null);
});

test('listener identity accepts a relative src/server.js but rejects another project', () => {
  assert.equal(listenerIdentityVerified(nodeListener(), ROOT), true);
  assert.equal(listenerIdentityVerified(nodeListener(4242, `node "${ROOT}\\src\\server.js"`), ROOT), true);
  assert.equal(listenerIdentityVerified(nodeListener(4242, 'node K:\\other\\src\\server.js'), ROOT), false);
  assert.equal(listenerIdentityVerified({ checked: true, pid: 4242, identity: { checked: true, commandLine: 'python server.py' } }, ROOT), false);
});

test('watchdog identity requires watch-service.ps1 and the project root', () => {
  assert.equal(watchdogIdentityVerified(watchdog(), ROOT), true);
  assert.equal(watchdogIdentityVerified(watchdog(7777, 'pwsh.exe -File "K:\\other\\scripts\\watch-service.ps1"'), ROOT), false);
  assert.equal(watchdogIdentityVerified({
    checked: true, pid: 7777,
    identity: { checked: true, executablePath: 'C:\\Program Files\\nodejs\\node.exe', commandLine: `node "${ROOT}\\scripts\\watch-service.ps1"` }
  }, ROOT), false);
});

test('preflight: running build already current -> not_needed', () => {
  const result = evaluateRestartPreflight({ ...ready(), status: idleStatus({ buildId: 'disk-build-2' }) });
  assert.equal(result.status, 'not_needed');
  assert.equal(result.ok, true);
});

test('preflight: busy service waits and preserves the running tasks', () => {
  for (const field of [{ active: { id: 'x' } }, { activeCount: 1 }, { queued: 2 }, { taskLease: 't' }, { desktopOperation: { tool: 'browser_x' } }, { tabLeases: [{ tabId: 1 }] }, { maintenance: { held: true } }]) {
    const result = evaluateRestartPreflight({ ...ready(), status: idleStatus(field) });
    assert.equal(result.status, 'waiting', `expected waiting for ${JSON.stringify(field)}`);
    assert.equal(result.retryable, true);
    assert.ok(result.reasons.some(r => r.code === 'service_busy'));
  }
});

test('preflight: unproven listener or watchdog refuses without any signal', () => {
  const mismatch = evaluateRestartPreflight({ ...ready(), listener: nodeListener(9999) });
  assert.equal(mismatch.status, 'refused');
  assert.ok(mismatch.reasons.some(r => r.code === 'listener_pid_mismatch'));

  const missingWatchdog = evaluateRestartPreflight({ ...ready(), watchdog: { checked: true, pid: null, error: 'watchdog_pid_missing' } });
  assert.equal(missingWatchdog.status, 'refused');
  assert.ok(missingWatchdog.reasons.some(r => r.code === 'watchdog_missing'));

  const foreign = evaluateRestartPreflight({ ...ready(), watchdog: watchdog(7777, 'pwsh.exe -File "K:\\other\\scripts\\watch-service.ps1"') });
  assert.equal(foreign.status, 'refused');
  assert.ok(foreign.reasons.some(r => r.code === 'watchdog_identity_unverified'));

  const noDisk = evaluateRestartPreflight({ ...ready(), diskBuildId: null });
  assert.equal(noDisk.status, 'refused');
  assert.ok(noDisk.reasons.some(r => r.code === 'disk_identity_unavailable'));
});

test('restartServiceWhenIdle: dry run by default, never writes an intent', async () => {
  const written = [];
  let posts = 0;
  const result = await restartServiceWhenIdle({
    request: async (path) => { if (path === '/status') return idleStatus(); posts += 1; return {}; },
    root: ROOT, stateDir: 'state', port: 19387,
    compute: () => 'disk-build-2',
    probes: { listener: () => nodeListener(), watchdog: () => watchdog() },
    writeLifecycle: event => { written.push(event); return event; }
  });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.wouldRestart, true);
  assert.equal(posts, 0);
  assert.equal(written.length, 0);
});

test('restartServiceWhenIdle: apply records the intent and verifies the new build', async () => {
  const written = [];
  let current = idleStatus();
  let posted = null;
  const result = await restartServiceWhenIdle({
    request: async (path, data) => {
      if (path === '/status') return current;
      posted = { path, data };
      current = idleStatus({ buildId: 'disk-build-2', pid: 5252 });
      return { status: 'restarting', restartId: 'r-1' };
    },
    root: ROOT, stateDir: 'state', port: 19387, apply: true,
    compute: () => 'disk-build-2',
    probes: { listener: () => nodeListener(), watchdog: () => watchdog() },
    writeLifecycle: event => { written.push(event); return event; },
    wait: async () => {}
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.newPid, 5252);
  assert.equal(posted.path, '/restart-when-idle');
  assert.equal(posted.data.confirmation, 'restart_service_when_idle_once');
  assert.equal(posted.data.expectedBuildId, 'running-build-1');
  assert.deepEqual(written.map(e => e.event), ['restart_intent']);
  assert.equal(written[0].pid, 4242);
});

test('restartServiceWhenIdle: old service without the endpoint cancels the intent and never signals', async () => {
  const written = [];
  const result = await restartServiceWhenIdle({
    request: async (path) => {
      if (path === '/status') return idleStatus();
      throw new Error('Not found');
    },
    root: ROOT, stateDir: 'state', port: 19387, apply: true,
    compute: () => 'disk-build-2',
    probes: { listener: () => nodeListener(), watchdog: () => watchdog() },
    writeLifecycle: event => { written.push(event); return event; }
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.ok, false);
  assert.equal(result.reasons[0].code, 'restart_endpoint_unavailable');
  assert.deepEqual(written.map(e => e.event), ['restart_intent', 'restart_intent_cancelled']);
});

test('restartServiceWhenIdle: an unverified endpoint response is uncertain and never replayed', async () => {
  let posts = 0;
  const written = [];
  const result = await restartServiceWhenIdle({
    request: async (path) => {
      if (path === '/status') return idleStatus();
      posts += 1;
      throw new Error('socket hang up');
    },
    root: ROOT, stateDir: 'state', port: 19387, apply: true,
    compute: () => 'disk-build-2',
    probes: { listener: () => nodeListener(), watchdog: () => watchdog() },
    writeLifecycle: event => { written.push(event); return event; }
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.retryable, false);
  assert.equal(posts, 1);
  assert.deepEqual(written.map(e => e.event), ['restart_intent']);
});

test('restartServiceWhenIdle: timeout after acceptance is uncertain, no second dispatch', async () => {
  let posts = 0;
  const result = await restartServiceWhenIdle({
    request: async (path) => {
      if (path === '/status') return idleStatus();
      posts += 1;
      return { status: 'restarting' };
    },
    root: ROOT, stateDir: 'state', port: 19387, apply: true,
    timeoutMs: 5, pollMs: 1,
    compute: () => 'disk-build-2',
    probes: { listener: () => nodeListener(), watchdog: () => watchdog() },
    writeLifecycle: event => event,
    wait: async () => {}
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.retryable, false);
  assert.equal(posts, 1);
});
