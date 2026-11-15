// The adapter must not outlive its MCP client, and the guard must never act on
// a guess. A wrapper shell is normal, so the guard walks ancestors to a stable
// client instead of disarming. Every test injects chain/alive: nothing here
// spawns a process, signals anything, or touches a real client.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createParentGuard, parseProcessChain, probeProcessChain, selectAncestorAnchor,
  SHELL_PARENT_NAMES, SESSION_ROOT_NAMES
} from '../src/mcp-parent-guard.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const entry = (pid, name, created = null, ppid = 0) => ({ pid, ppid, name, created });

function guard(t, { chainFor, aliveNow, intervalMs = 50, identityEveryMs = 300000, passiveRetryMs = 60 }) {
  const events = { orphans: [], arms: [], passives: [] };
  const g = createParentGuard({
    ppid: 4242,
    intervalMs,
    identityEveryMs,
    passiveRetryMs,
    chain: async pid => chainFor(pid),
    alive: () => aliveNow(),
    onOrphan: info => events.orphans.push(info),
    onArm: info => events.arms.push(info),
    onPassive: info => events.passives.push(info)
  });
  t.after(() => g.stop());
  return { g, events };
}

const wrapperChain = () => [
  entry(4242, 'cmd.exe', '2026-11-15T00:00:00.000Z', 900),
  entry(900, 'qoder.exe', '2026-11-15T00:00:00.000Z', 500),
  entry(500, 'explorer.exe', '2026-11-15T00:00:00.000Z', 0)
];

test('shell and session names are classified, and the first stable ancestor wins', () => {
  for (const name of ['bash.exe', 'cmd.exe', 'pwsh.exe', 'node.exe', 'wsl.exe']) {
    assert.ok(SHELL_PARENT_NAMES.has(name), `${name} must be treated as a launcher`);
  }
  for (const name of ['explorer.exe', 'services.exe', 'systemd']) {
    assert.ok(SESSION_ROOT_NAMES.has(name), `${name} must be treated as a session root`);
  }
  const anchor = selectAncestorAnchor([
    entry(4242, 'cmd.exe'), entry(900, 'qoder.exe', 't1'), entry(500, 'explorer.exe')
  ]);
  assert.deepEqual(anchor, { pid: 900, name: 'qoder.exe', created: 't1', ppid: null });
  assert.equal(selectAncestorAnchor([entry(4242, 'cmd.exe'), entry(500, 'explorer.exe')]), null,
    'a chain ending in a session root has no client to anchor on');
  assert.equal(selectAncestorAnchor([]), null);
});

test('a wrapper-shell parent arms the guard on the client behind it', async t => {
  let alive = true;
  const { g, events } = guard(t, {
    chainFor: pid => pid === 4242 ? wrapperChain() : [entry(900, 'qoder.exe', '2026-11-15T00:00:00.000Z')],
    aliveNow: () => alive,
    intervalMs: 40
  });
  g.start();
  await sleep(140);
  assert.equal(g.snapshot().mode, 'active');
  assert.equal(g.snapshot().anchor?.pid, 900);
  assert.equal(events.arms.length, 1);
  assert.equal(events.orphans.length, 0);
  alive = false;
  await sleep(180);
  assert.equal(events.orphans.length, 1);
  assert.equal(events.orphans[0].reason, 'anchor_process_gone');
  assert.equal(events.orphans[0].anchor.pid, 900);
});

test('an unreadable chain goes passive instead of guessing, and never fires', async t => {
  let alive = true;
  const { g, events } = guard(t, { chainFor: () => null, aliveNow: () => alive, intervalMs: 30, passiveRetryMs: 30 });
  g.start();
  await sleep(120);
  assert.equal(g.snapshot().mode, 'passive');
  assert.equal(g.snapshot().armed, false);
  assert.ok(events.passives.length >= 1);
  alive = false;
  await sleep(150);
  assert.equal(events.orphans.length, 0, 'passive mode has no evidence for an orphan decision');
});

test('a terminal-only chain has no stable ancestor and stays passive', async t => {
  const { g, events } = guard(t, {
    chainFor: () => [entry(4242, 'bash.exe'), entry(500, 'windowsterminal.exe'), entry(400, 'explorer.exe')],
    aliveNow: () => false,
    intervalMs: 30
  });
  g.start();
  await sleep(100);
  assert.equal(g.snapshot().mode, 'passive');
  assert.equal(events.passives[0].reason, 'no_stable_ancestor');
  assert.equal(events.orphans.length, 0);
});

test('a recycled anchor pid is detected by creation time', async t => {
  let created = '2026-11-15T00:00:00.000Z';
  const { g, events } = guard(t, {
    chainFor: pid => pid === 4242
      ? [entry(4242, 'cmd.exe'), entry(900, 'qoder.exe', created)]
      : [entry(900, 'qoder.exe', created)],
    aliveNow: () => true,
    intervalMs: 30,
    identityEveryMs: 30
  });
  g.start();
  await sleep(100);
  assert.equal(g.snapshot().mode, 'active');
  created = '2026-11-15T09:00:00.000Z';
  await sleep(160);
  assert.equal(events.orphans.length, 1);
  assert.equal(events.orphans[0].reason, 'anchor_identity_replaced');
});

test('a transient identity probe failure does not kill a live session', async t => {
  let identityReads = 0;
  const { g, events } = guard(t, {
    chainFor: pid => {
      if (pid !== 4242) {
        identityReads += 1;
        return identityReads <= 3 ? null : [entry(900, 'qoder.exe', 't1')];
      }
      return [entry(4242, 'cmd.exe'), entry(900, 'qoder.exe', 't1')];
    },
    aliveNow: () => true,
    intervalMs: 25,
    identityEveryMs: 25
  });
  g.start();
  await sleep(260);
  assert.equal(events.orphans.length, 0);
  // Three unreadable identity checks may downgrade to passive (and re-arm when
  // the chain is readable again), but must never produce an orphan claim.
  assert.ok(events.passives.length >= 1);
});

test('parseProcessChain accepts one object or an array and refuses junk', () => {
  assert.deepEqual(parseProcessChain(JSON.stringify({ pid: 10, ppid: 5, name: 'Cmd.exe', created: 't' })),
    [{ pid: 10, ppid: 5, name: 'cmd.exe', created: 't' }]);
  assert.deepEqual(parseProcessChain(JSON.stringify([{ pid: 10, ppid: 5, name: 'claude', created: null }])),
    [{ pid: 10, ppid: 5, name: 'claude.exe', created: null }]);
  assert.equal(parseProcessChain('not json'), null);
  assert.equal(parseProcessChain(''), null);
  assert.equal(parseProcessChain(JSON.stringify([{ pid: 0, name: '' }])), null);
});

test('the real chain probe is Windows-only and bounded', async () => {
  assert.equal(await probeProcessChain(1234, { platform: 'linux' }), null);
  assert.equal(await probeProcessChain(0, { platform: 'win32' }), null);
  const fake = (command, args, options, callback) => callback(null, JSON.stringify([
    { pid: 1234, ppid: 111, name: 'cmd.exe', created: 'a' },
    { pid: 111, ppid: 1, name: 'qoder.exe', created: 'b' }
  ]));
  const chain = await probeProcessChain(1234, { platform: 'win32', execFileFn: fake });
  assert.equal(chain.length, 2);
  assert.equal(chain[1].name, 'qoder.exe');
});
