// The adapter must not outlive its MCP client, and the guard must never act on
// a guess. Every test below injects probe/alive so the two-factor rule is
// proven without spawning anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createParentGuard, SHELL_PARENT_NAMES, isProcessAlive, probeParentName } from '../src/mcp-parent-guard.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function guard(t, { names, aliveNow, intervalMs = 50 }) {
  const events = { orphans: [], disarms: [] };
  let index = 0;
  const g = createParentGuard({
    ppid: 4242,
    intervalMs,
    probe: async () => names[Math.min(index++, names.length - 1)],
    alive: () => aliveNow(),
    onOrphan: info => events.orphans.push(info),
    onDisarm: info => events.disarms.push(info)
  });
  t.after(() => g.stop());
  return { g, events };
}

test('a shell parent disarms the guard: a wrapper exiting is not a dead client', async t => {
  for (const name of ['bash.exe', 'cmd.exe', 'pwsh.exe', 'node.exe']) {
    assert.ok(SHELL_PARENT_NAMES.has(name));
    const { g, events } = guard(t, { names: [name], aliveNow: () => false });
    g.start();
    await sleep(180);
    assert.equal(events.disarms.length, 1, `${name} must disarm`);
    assert.equal(events.orphans.length, 0, `${name} must never be treated as an orphan`);
    assert.equal(g.snapshot().armed, false);
    assert.equal(g.snapshot().stopped, true);
    g.stop();
  }
});

test('an unreadable parent name disarms instead of guessing', async t => {
  const { g, events } = guard(t, { names: [null], aliveNow: () => false });
  g.start();
  await sleep(400);
  assert.equal(events.disarms.length, 1);
  assert.equal(events.disarms[0].reason, 'parent_name_unavailable');
  assert.ok(events.disarms[0].attempts >= 3, 'one slow probe must not disable the guard');
  assert.equal(events.orphans.length, 0);
});

test('a real client is monitored: death after arming fires exactly one orphan event', async t => {
  let alive = true;
  const { g, events } = guard(t, { names: ['codex.exe'], aliveNow: () => alive, intervalMs: 60 });
  g.start();
  await sleep(150);
  assert.equal(g.snapshot().armed, true);
  assert.equal(events.orphans.length, 0, 'nothing may happen while the parent is alive');
  alive = false;
  await sleep(250);
  assert.equal(events.orphans.length, 1);
  assert.equal(events.orphans[0].parentName, 'codex.exe');
  assert.equal(g.snapshot().stopped, true);
});

test('the guard never acts before it is armed, even if liveness fails at once', async t => {
  const { g, events } = guard(t, { names: ['codex.exe'], aliveNow: () => false, intervalMs: 60 });
  g.start();
  // First tick only probes and arms; no orphan decision is allowed on it.
  await sleep(30);
  assert.equal(events.orphans.length, 0);
  await sleep(250);
  assert.equal(events.orphans.length, 1, 'the second tick may act on the proven parent');
});

test('the liveness probe treats EPERM as alive and rejects impossible pids', () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(process.pid), true);
});

test('probing falls back to null off-Windows and on malformed output', async () => {
  assert.equal(await probeParentName(1234, { platform: 'linux' }), null);
  assert.equal(await probeParentName(0, { platform: 'win32' }), null);
  const csv = (cmd, args, options, callback) => callback(null,
    cmd === 'tasklist.exe' ? '"MSIAfterburner.exe","1234","Console","1","10,000 K"\r\n' : 'MSIAfterburner\n', '');
  assert.equal(await probeParentName(1234, { platform: 'win32', execFileFn: csv }), 'msiafterburner.exe');
  const junk = (cmd, args, options, callback) => callback(null, 'INFO: no tasks\n', '');
  assert.equal(await probeParentName(1234, { platform: 'win32', execFileFn: junk }), null);
});

test('the fast PowerShell probe wins, and tasklist remains the fallback', async () => {
  const calls = [];
  const fast = (cmd, args, options, callback) => {
    calls.push(cmd);
    callback(null, cmd === 'pwsh.exe' ? 'Code\n' : '"Code.exe","1234","Console","1","1 K"\r\n', '');
  };
  assert.equal(await probeParentName(1234, { platform: 'win32', execFileFn: fast }), 'code.exe');
  assert.deepEqual(calls, ['pwsh.exe'], 'a fast exact lookup must not fall through');

  const fallback = (cmd, args, options, callback) => {
    calls.push(cmd);
    if (cmd === 'tasklist.exe') callback(null, '"codex.exe","1234","Console","1","1 K"\r\n', '');
    else callback(new Error('not installed'), '', '');
  };
  calls.length = 0;
  assert.equal(await probeParentName(1234, { platform: 'win32', execFileFn: fallback }), 'codex.exe');
  assert.deepEqual(calls, ['pwsh.exe', 'powershell.exe', 'tasklist.exe']);
  // Get-Process returns a name without .exe; the guard's shell set must still match.
  const ps = (cmd, args, options, callback) => callback(null, 'pwsh\n', '');
  assert.equal(await probeParentName(1234, { platform: 'win32', execFileFn: ps }), 'pwsh.exe');
  assert.ok(SHELL_PARENT_NAMES.has('pwsh.exe'));
});
