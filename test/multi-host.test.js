// Multi-host regressions (0.36.0).
//
// The single-socket design could never be tested for these failures because it
// refused the second browser outright. Every test here starts at least two
// authenticated extension hosts and asserts that neither is displaced, blocked
// or given another agent's result.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';
import { validateCall, TOOLS } from '../src/tools.js';
import { createLeaseStore } from '../src/leases.js';
import {
  HostRegistry, CommandLedger, negotiateHandshake, pickDispatchable,
  scopeKey, parseScopeKey, compareVersions, featureFlagsFor, isValidHostId,
  recommendHost, SERVICE_PROTOCOL_VERSION
} from '../src/host-registry.js';
import { createAgentPolicy } from '../src/policy.js';

const config = { port: 0, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64) };
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, options = {}) {
  const b = createBridge(config, { leaseStateFile: null, ...options });
  const address = await b.listen();
  t.after(() => b.close());
  return { b, wsUrl: `ws://127.0.0.1:${address.port}/extension` };
}

async function connectHost(wsUrl, {
  hostId, version = '0.36.0', protocolVersion = 2, hostKind = 'stable',
  chromeVersion = '156.0.8078.49', legacy = false
} = {}) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  await once(ws, 'open');
  const ready = once(ws, 'message');
  const hello = legacy
    ? { type: 'hello', token: config.extensionToken }
    : { type: 'hello', token: config.extensionToken, hostId, version, protocolVersion, hostKind, chromeVersion, extensionId: 'a'.repeat(32) };
  ws.send(JSON.stringify(hello));
  return { ws, ready: JSON.parse((await ready)[0]) };
}

function collectCommands(ws) {
  const commands = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'command') commands.push(msg);
  });
  return commands;
}

const reply = (ws, msg, result = { status: 'success' }) => ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));

async function until(predicate, { attempts = 100, delayMs = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await sleep(delayMs);
  }
  return predicate();
}

// ── Pure protocol logic ───────────────────────────────────────────────────

test('an older extension is accepted on the baseline protocol, never closed', () => {
  const h = negotiateHandshake({ token: 'x', version: '0.33.0' }, { serviceVersion: '0.36.0', fallbackSeed: 'origin:1234' });
  assert.equal(h.accepted, true);
  assert.equal(h.protocolVersion, 1);
  assert.equal(h.baseline, true);
  assert.match(h.hostId, /^legacy-/);
  assert.ok(h.warnings.includes('host_id_missing_baseline'));
  // Version skew is advisory. Refusing an older host would recreate the very
  // exclusivity this release removes.
  assert.ok(h.warnings.includes('version_mismatch_advisory'));
  assert.equal(h.hostKind, 'generic');
});

test('a newer protocol is downgraded and capability hints follow the Chrome version', () => {
  const h = negotiateHandshake({
    hostId: 'canary-1', protocolVersion: 99, version: '0.40.0',
    hostKind: 'canary', chromeVersion: '159.0.8146.0'
  }, { serviceVersion: '0.36.0' });
  assert.equal(h.protocolVersion, SERVICE_PROTOCOL_VERSION);
  assert.ok(h.warnings.includes('protocol_downgraded'));
  assert.equal(h.features.webmcpOriginTrial, true);
  assert.equal(h.features.webmcpOutputSchema, true);
});

test('capability boundaries are exact and unknown versions stay unknown', () => {
  assert.equal(featureFlagsFor({ chromeVersion: '148.0.0.0' }).webmcpOriginTrial, false);
  assert.equal(featureFlagsFor({ chromeVersion: '149.0.0.0' }).webmcpOriginTrial, true);
  assert.equal(featureFlagsFor({ chromeVersion: '156.0.8078.49' }).webmcpOutputSchema, false);
  assert.equal(featureFlagsFor({ chromeVersion: '159.0.8140.0' }).webmcpOutputSchema, true);
  assert.equal(featureFlagsFor({ chromeVersion: '159.0.8139.9' }).webmcpOutputSchema, false);
  assert.equal(featureFlagsFor({}).webmcpOutputSchema, null);
  assert.equal(featureFlagsFor({ hostKind: 'agent_embedded' }).uiAutomationLikely, false);
  assert.equal(compareVersions('159.0.8140.0', '159.0.8139.0'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});

test('scope keys separate identical tab ids and reject forged host ids', () => {
  assert.equal(scopeKey('h-a', 7), 'h-a:7');
  assert.notEqual(scopeKey('h-a', 7), scopeKey('h-b', 7));
  assert.deepEqual(parseScopeKey('h-b:7'), { hostId: 'h-b', tabId: 7 });
  assert.equal(parseScopeKey('7'), null);
  assert.equal(isValidHostId('canary_1'), true);
  for (const bad of ['h-a:7', 'a/b', '', 'x'.repeat(65), 7, null]) assert.equal(isValidHostId(bad), false);
});

test('the registry keeps hosts as peers and supersedes only a same-host reconnect', () => {
  const registry = new HostRegistry({ serviceVersion: '0.36.0' });
  const wsA = { readyState: 1, close(code) { this.closedWith = code; } };
  const wsB = { readyState: 1, close() {} };
  const wsA2 = { readyState: 1, close() {} };
  const handshake = id => negotiateHandshake({ hostId: id, protocolVersion: 2, version: '0.36.0' });
  registry.register(wsA, handshake('h-a'));
  registry.register(wsB, handshake('h-b'));
  assert.equal(registry.size(), 2);
  assert.equal(registry.primaryHostId, 'h-a');
  registry.register(wsA2, handshake('h-a'));
  assert.equal(wsA.closedWith, 4004);
  assert.equal(registry.size(), 2);
  assert.equal(registry.byWs(wsA), null);
  assert.equal(registry.byId('h-a').ws, wsA2);
  registry.remove(wsA2);
  assert.equal(registry.primaryHostId, 'h-b');
  registry.remove(wsB);
  assert.equal(registry.primaryHostId, null);
  assert.equal(registry.snapshot().length, 0);
});

test('dispatch skips busy hosts, ages starved work and rotates agents', () => {
  const job = (id, hostId, priority, created, agent = null) => ({ id, hostId, priority, created, args: { agent } });
  const now = 100000;
  const queue = [
    job('low-a', 'h-a', 80, now - 120000, 'agent-1'),
    job('high-b', 'h-b', 10, now, 'agent-2'),
    job('read-a', 'h-a', 10, now, 'agent-1')
  ];
  // h-b is busy: its high-priority read cannot hold h-a's work hostage.
  const busy = new Map([['h-b', job('busy', 'h-b', 10, now)]]);
  const pick = pickDispatchable(queue, busy, { now, availableHostIds: new Set(['h-a', 'h-b']) });
  assert.equal(pick.job.id, 'low-a', '30s of aging must outrank a fresh low-priority read');
  // With everyone free, priority wins; a different agent from the last one
  // gets a fairness bonus when scores are otherwise close.
  const fair = pickDispatchable([job('a', 'h-a', 20, now, 'agent-1'), job('b', 'h-b', 20, now, 'agent-2')],
    new Map(), { now, lastAgent: 'agent-1' });
  assert.equal(fair.job.id, 'b');
  assert.equal(pickDispatchable(queue, new Map([['h-a', {}] , ['h-b', {}]]), { now }), null);
});

test('the idempotency ledger is bounded and replays outcomes', () => {
  const ledger = new CommandLedger({ maxEntries: 2 });
  assert.equal(ledger.check('c1'), null);
  ledger.record('c1', { hostId: 'h-a', tool: 'browser_click', outcome: 'uncertain' });
  assert.equal(ledger.check('c1').outcome, 'uncertain');
  assert.ok(ledger.check('c1').recordedAt > 0);
  ledger.record('c2', { outcome: 'success' });
  ledger.record('c3', { outcome: 'success' });
  assert.equal(ledger.size(), 2);
  assert.equal(ledger.check('c1'), null);
});

test('default-target recommendation ranks embedded browsers last and flags ambiguity', () => {
  const embeddedFirst = [
    { hostId: 'h-embedded', hostKindObserved: 'agent_embedded', primary: true, connectedAt: 1 },
    { hostId: 'h-system', hostKindObserved: 'stable', primary: false, connectedAt: 2 }
  ];
  const rec = recommendHost(embeddedFirst, { primaryHostId: 'h-embedded' });
  assert.equal(rec.recommendedHostId, 'h-system');
  assert.equal(rec.defaultHostId, 'h-system');
  assert.equal(rec.selectionRequired, false);
  assert.equal(rec.confidence, 'high');
  assert.equal(rec.candidates.find(item => item.hostId === 'h-embedded').recommended, false);

  // Two system browsers: the primary is the deterministic tie-break, but the
  // agent must confirm the profile before a login-dependent write.
  const twoSystem = [
    { hostId: 'h-b', hostKindObserved: 'stable', primary: false, connectedAt: 2 },
    { hostId: 'h-a', hostKindObserved: 'stable', primary: true, connectedAt: 1 }
  ];
  const ambiguous = recommendHost(twoSystem, { primaryHostId: 'h-a' });
  assert.equal(ambiguous.defaultHostId, 'h-a');
  assert.equal(ambiguous.selectionRequired, true);
  assert.equal(ambiguous.confidence, 'low');

  // Only embedded browsers are connected: still routable, but never a
  // confident default.
  const onlyEmbedded = recommendHost([{ hostId: 'h-e', hostKindObserved: 'agent_embedded', primary: true }], {});
  assert.equal(onlyEmbedded.defaultHostId, 'h-e');
  assert.equal(onlyEmbedded.selectionRequired, true);
  assert.equal(onlyEmbedded.confidence, 'low');
  assert.equal(recommendHost([], {}).defaultHostId, null);
});

test('read-only work has its own lane: parallel within a host, never on a busy tab', () => {
  const job = (id, extra = {}) => ({ id, hostId: 'h-a', priority: 10, created: 1000, args: { tabId: 1 }, readOnly: true, ...extra });
  const now = 5000;
  const write = { id: 'w', hostId: 'h-a', priority: 10, created: now, args: { tabId: 9 }, readOnly: false };
  // A write on tab 9 must not hold a read on tab 2 hostage.
  const free = pickDispatchable([job('r2', { args: { tabId: 2 } })], new Map([['h-a', write]]), {
    now, availableHostIds: new Set(['h-a']), readCounts: new Map([['h-a', 0]]), maxReadsPerHost: 2
  });
  assert.equal(free.job.id, 'r2');
  // But the same tab is exclusive: a read cannot observe while a write is mid-flight there.
  const sameTab = pickDispatchable([job('r9', { args: { tabId: 9 } })], new Map([['h-a', write]]), {
    now, availableHostIds: new Set(['h-a']), busyTabKeys: new Set([scopeKey('h-a', 9)]), maxReadsPerHost: 2
  });
  assert.equal(sameTab, null);
  // Two reads are enough per host; a third waits instead of piling up.
  const capped = pickDispatchable([job('r3', { args: { tabId: 3 } })], new Map(), {
    now, availableHostIds: new Set(['h-a']), readCounts: new Map([['h-a', 2]]), maxReadsPerHost: 2
  });
  assert.equal(capped, null);
  // A write waits for in-flight reads on the same host, because they may be
  // reading the very tab it is about to change.
  const writeBlocked = pickDispatchable([write], new Map(), {
    now, availableHostIds: new Set(['h-a']), readCounts: new Map([['h-a', 1]])
  });
  assert.equal(writeBlocked, null);
  // The lane is per host: another host's reads never block this host's write.
  const otherHost = pickDispatchable([write], new Map(), {
    now, availableHostIds: new Set(['h-a']), readCounts: new Map([['h-b', 2]])
  });
  assert.equal(otherHost.job.id, 'w');
});

test('agent queue priority biases ordering without becoming a starvation tool', () => {
  const policy = createAgentPolicy({ file: null });
  policy.set('short-task', { queuePriority: -50 });
  policy.set('bulk-task', { queuePriority: 40 });
  policy.set('clamped', { queuePriority: -900 });
  assert.equal(policy.priorityOffset('short-task'), -50);
  assert.equal(policy.priorityOffset('bulk-task'), 40);
  assert.equal(policy.priorityOffset('clamped'), -100);
  assert.equal(policy.priorityOffset('unregistered'), 0);
  assert.equal(policy.priorityOffset(null), 0);
  assert.equal(policy.evaluate({ name: 'browser_click', agent: 'short-task' }).queuePriority, -50);
  // The bias is applied to the base priority by the server; here it only has to
  // outrank the bulk agent at equal age, and aging must still rescue the bulk
  // agent eventually.
  const now = 100000;
  const biased = [
    { id: 'bulk', hostId: 'h-a', priority: 10 + 40, created: now, args: { agent: 'bulk-task' } },
    { id: 'short', hostId: 'h-b', priority: 10 - 50, created: now, args: { agent: 'short-task' } }
  ];
  assert.equal(pickDispatchable(biased, new Map(), { now }).job.id, 'short');
  const aged = [
    { id: 'bulk', hostId: 'h-a', priority: 50, created: now - 120000, args: { agent: 'bulk-task' } },
    { id: 'short', hostId: 'h-b', priority: -40, created: now, args: { agent: 'short-task' } }
  ];
  assert.equal(pickDispatchable(aged, new Map(), { now }).job.id, 'bulk', 'aging must eventually serve the bulk agent');
});

// ── Lease scoping ─────────────────────────────────────────────────────────

test('the same tab id in two browsers holds two independent leases', () => {
  const leases = createLeaseStore();
  const a = leases.claim({ tabId: 7, hostId: 'h-a', agent: 'agent-1' });
  const b = leases.claim({ tabId: 7, hostId: 'h-b', agent: 'agent-2' });
  assert.equal(a.agent, 'agent-1');
  assert.equal(b.agent, 'agent-2');
  assert.equal(a.hostId, 'h-a');
  assert.equal(b.hostId, 'h-b');
  assert.equal(leases.size(), 2);
  assert.equal(leases.guard(7, 'agent-2', 'browser_click', 'h-a').reason, 'tab_write_lease_conflict');
  assert.equal(leases.guard(7, 'agent-2', 'browser_click', 'h-b'), null);
  // A pre-0.36 caller that supplies no hostId keeps the bare-number key.
  const legacy = leases.claim({ tabId: 7, agent: 'legacy' });
  assert.equal(legacy.agent, 'legacy');
  assert.equal(legacy.hostId, undefined);
  assert.equal(leases.size(), 3);
  assert.equal(leases.releaseTab(7, 'h-a'), true);
  assert.equal(leases.size(), 2);
});

test('all tools accept hostId and commandId, and a forged hostId is refused', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.inputSchema.properties.hostId, `${tool.name} must expose hostId`);
    assert.ok(tool.inputSchema.properties.commandId, `${tool.name} must expose commandId`);
    assert.ok(!tool.inputSchema.required.includes('hostId'), `${tool.name} must not require hostId`);
  }
  assert.doesNotThrow(() => validateCall('browser_read', { tabId: 1, hostId: 'h-a', commandId: 'c1' }));
  assert.throws(() => validateCall('browser_read', { tabId: 1, hostId: 'h-a:evil' }), /hostId/);
  assert.throws(() => validateCall('browser_read', { tabId: 1, hostId: '../escape' }), /hostId/);
});

// ── Live bridge ───────────────────────────────────────────────────────────

test('three browsers connect at once; none is closed or displaced', async t => {
  const { b, wsUrl } = await setup(t);
  const a = await connectHost(wsUrl, { hostId: 'h-a', hostKind: 'stable', chromeVersion: '156.0.8078.49' });
  const c = await connectHost(wsUrl, { hostId: 'h-canary', hostKind: 'canary', chromeVersion: '159.0.8146.0' });
  const e = await connectHost(wsUrl, { hostId: 'h-embedded', hostKind: 'agent_embedded', chromeVersion: '159.0.8146.0' });
  for (const host of [a, c, e]) assert.equal(host.ready.type, 'ready');
  assert.equal(e.ready.hostCount, 3);
  const status = await b.call('browser_hosts', {});
  assert.equal(status.status, 'success');
  assert.equal(status.hostCount, 3);
  assert.equal(status.policy.exclusivity, 'none');
  assert.deepEqual(status.hosts.map(h => h.hostId).sort(), ['h-a', 'h-canary', 'h-embedded']);
  assert.equal(status.hosts.find(h => h.hostId === 'h-canary').features.webmcpOutputSchema, true);
  assert.equal(status.hosts.find(h => h.hostId === 'h-a').features.webmcpOutputSchema, false);
  assert.equal(status.hosts.find(h => h.hostId === 'h-embedded').features.uiAutomationLikely, false);
  assert.equal(b.status().hostCount, 3);
  a.ws.close(); c.ws.close(); e.ws.close();
});

test('each host has its own in-flight slot: a stalled browser cannot block its peers', async t => {
  const { b, wsUrl } = await setup(t);
  const hosts = {
    'h-a': await connectHost(wsUrl, { hostId: 'h-a' }),
    'h-b': await connectHost(wsUrl, { hostId: 'h-b' }),
    'h-c': await connectHost(wsUrl, { hostId: 'h-c' })
  };
  const commands = {};
  for (const id of Object.keys(hosts)) commands[id] = collectCommands(hosts[id].ws);
  // None of the three replies is sent until all three commands have arrived.
  // Under the old single `current` slot only the first could ever be dispatched.
  const calls = Object.keys(hosts).map(hostId => b.call('browser_read', { tabId: 1, hostId }));
  assert.ok(await until(() => Object.values(commands).every(list => list.length === 1)), 'all three hosts must be dispatched concurrently');
  assert.equal(b.status().activeCount, 3);
  assert.equal(b.status().activeByHost.length, 3);
  for (const id of Object.keys(hosts)) {
    assert.equal(commands[id][0].hostId, id);
    assert.equal(commands[id][0].args.hostId, undefined, 'routing args must not leak into page arguments');
    reply(hosts[id].ws, commands[id][0]);
  }
  await Promise.all(calls);
  for (const id of Object.keys(hosts)) hosts[id].ws.close();
});

test('a long write does not hold short reads hostage, but the same tab stays exclusive', async t => {
  const { b, wsUrl } = await setup(t);
  const host = await connectHost(wsUrl, { hostId: 'h-a' });
  const commands = collectCommands(host.ws);
  const write = b.call('browser_click', { tabId: 1, ref: 'e1' });
  assert.ok(await until(() => commands.length === 1));
  assert.equal(commands[0].name, 'browser_click');
  // A caller with a 10s budget must be able to read another tab while a slow
  // write is still in flight, otherwise its own timeout aborts the task.
  const readOther = b.call('browser_read', { tabId: 2 });
  assert.ok(await until(() => commands.length === 2), 'the read lane must dispatch on a different tab');
  assert.equal(commands[1].name, 'browser_read');
  // Reading the tab a write is currently mutating would produce a torn snapshot.
  const readSame = b.call('browser_read', { tabId: 1 });
  await sleep(40);
  assert.equal(commands.length, 2, 'a read on the busy write tab must wait');
  const status = b.status();
  assert.equal(status.activeCount, 2);
  assert.deepEqual(status.activeByHost.map(job => job.lane).sort(), ['read', 'write']);
  reply(host.ws, commands[0]);
  await write;
  assert.ok(await until(() => commands.length === 3), 'the waiting read dispatches once the tab frees');
  reply(host.ws, commands[1]);
  reply(host.ws, commands[2]);
  await Promise.all([readOther, readSame]);
  host.ws.close();
});

test('a write waits for in-flight reads on its host, but only on its host', async t => {
  const { b, wsUrl } = await setup(t);
  const host = await connectHost(wsUrl, { hostId: 'h-a' });
  const commands = collectCommands(host.ws);
  const firstRead = b.call('browser_read', { tabId: 2 });
  const secondRead = b.call('browser_read', { tabId: 3 });
  assert.ok(await until(() => commands.length === 2));
  // Reads may not be overtaken by a write: they are the caller's evidence.
  const write = b.call('browser_click', { tabId: 4, ref: 'e1' });
  const capped = b.call('browser_read', { tabId: 5 });
  await sleep(40);
  assert.equal(commands.length, 2, 'the write and the third read must both wait');
  assert.equal(b.status().queued, 2);
  reply(host.ws, commands[0]);
  await firstRead;
  assert.ok(await until(() => commands.length === 3));
  // The cap freed one read slot, so the third read goes before the write.
  assert.equal(commands[2].name, 'browser_read');
  reply(host.ws, commands[1]);
  reply(host.ws, commands[2]);
  await Promise.all([secondRead, capped]);
  assert.ok(await until(() => commands.length === 4), 'the write dispatches after the reads drain');
  assert.equal(commands[3].name, 'browser_click');
  reply(host.ws, commands[3]);
  await write;
  host.ws.close();
});

test('a result from the wrong host cannot finish another host\'s job', async t => {
  const { b, wsUrl } = await setup(t);
  const a = await connectHost(wsUrl, { hostId: 'h-a' });
  const c = await connectHost(wsUrl, { hostId: 'h-b' });
  const aCommands = collectCommands(a.ws);
  const bCommands = collectCommands(c.ws);
  const first = b.call('browser_read', { tabId: 1, hostId: 'h-a' });
  const second = b.call('browser_read', { tabId: 1, hostId: 'h-b' });
  assert.ok(await until(() => aCommands.length === 1 && bCommands.length === 1));
  // Forge h-b's command id over h-a's socket. It must be ignored.
  a.ws.send(JSON.stringify({ type: 'result', id: bCommands[0].id, result: { status: 'success', forged: true } }));
  await sleep(30);
  assert.equal(b.status().activeCount, 2);
  reply(a.ws, aCommands[0]);
  reply(c.ws, bCommands[0]);
  await Promise.all([first, second]);
  a.ws.close(); c.ws.close();
});

test('disconnecting one host leaves the others connected and working', async t => {
  const { b, wsUrl } = await setup(t);
  const a = await connectHost(wsUrl, { hostId: 'h-a' });
  const c = await connectHost(wsUrl, { hostId: 'h-b' });
  const bCommands = collectCommands(c.ws);
  const before = b.call('browser_read', { tabId: 1, hostId: 'h-b' });
  assert.ok(await until(() => bCommands.length === 1));
  reply(c.ws, bCommands[0]);
  await before;
  const closed = once(a.ws, 'close');
  a.ws.close();
  await closed;
  assert.ok(await until(() => b.status().hostCount === 1));
  assert.equal(b.status().hosts[0].hostId, 'h-b');
  assert.equal(b.status().connected, true);
  const after = b.call('browser_read', { tabId: 1, hostId: 'h-b' });
  assert.ok(await until(() => bCommands.length === 2));
  reply(c.ws, bCommands[1]);
  await after;
  c.ws.close();
});

test('an embedded browser that connected first does not capture hostId-less commands', async t => {
  const { b, wsUrl } = await setup(t);
  const embedded = await connectHost(wsUrl, { hostId: 'h-embedded', hostKind: 'agent_embedded' });
  const system = await connectHost(wsUrl, { hostId: 'h-system', hostKind: 'stable' });
  const embeddedCommands = collectCommands(embedded.ws);
  const systemCommands = collectCommands(system.ws);
  const status = await b.call('browser_hosts', {});
  assert.equal(status.primaryHostId, 'h-embedded', 'primary still follows connection order');
  assert.equal(status.defaultHostId, 'h-system');
  assert.equal(status.recommendedHostId, 'h-system');
  assert.equal(status.selectionRequired, false);
  assert.equal(status.recommendation.candidates.find(item => item.hostId === 'h-embedded').recommended, false);

  const pending = b.call('browser_read', { tabId: 1 });
  assert.ok(await until(() => systemCommands.length === 1), 'the system browser must receive the default call');
  assert.equal(embeddedCommands.length, 0);
  reply(system.ws, systemCommands[0]);
  await pending;

  // An explicit hostId still reaches the embedded browser: the preference is
  // a default, never a refusal.
  const explicit = b.call('browser_read', { tabId: 1, hostId: 'h-embedded' });
  assert.ok(await until(() => embeddedCommands.length === 1));
  reply(embedded.ws, embeddedCommands[0]);
  await explicit;
  embedded.ws.close(); system.ws.close();
});

test('an unknown hostId waits with evidence instead of being silently rerouted', async t => {
  const { b, wsUrl } = await setup(t);
  const a = await connectHost(wsUrl, { hostId: 'h-a' });
  const result = await b.call('browser_read', { tabId: 1, hostId: 'ghost' });
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'host_not_connected');
  assert.equal(result.dispatched, false);
  assert.deepEqual(result.availableHostIds, ['h-a']);
  assert.equal(result.nextPollTool, 'browser_hosts');
  a.ws.close();
});

test('a repeated commandId is never dispatched a second time', async t => {
  const { b, wsUrl } = await setup(t);
  const a = await connectHost(wsUrl, { hostId: 'h-a' });
  const commands = collectCommands(a.ws);
  a.ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'command') reply(a.ws, msg, { status: 'success', value: 1 });
  });
  const first = await b.call('browser_read', { tabId: 1, commandId: 'cmd-once' });
  assert.equal(first.value, 1);
  const second = await b.call('browser_read', { tabId: 1, commandId: 'cmd-once' });
  assert.equal(second.status, 'duplicate_suppressed');
  assert.equal(second.replayed, true);
  assert.equal(second.dispatched, false);
  assert.equal(commands.length, 1);
  a.ws.close();
});

test('the same hostId reconnecting supersedes its stale socket with 4004', async t => {
  const { b, wsUrl } = await setup(t);
  const a = await connectHost(wsUrl, { hostId: 'h-a' });
  const closed = once(a.ws, 'close');
  const a2 = await connectHost(wsUrl, { hostId: 'h-a' });
  assert.equal((await closed)[0], 4004);
  assert.equal(a2.ready.hostCount, 1);
  assert.equal(b.status().hostCount, 1);
  assert.equal(b.status().hosts[0].hostId, 'h-a');
  a2.ws.close();
});

test('extension reload verification is host-scoped, not a primary-mirror comparison', () => {
  // Measured on a real fleet: reloading the ChatGPT-embedded host dropped its
  // socket, the system Chrome was promoted to primary, and the global
  // extensionSessionId mirror then pointed at that *other* browser's old
  // session. The old check reported extension_reload_not_observed even though
  // the reloaded worker had come back with the new version.
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /function waitForReload\(\{ previousSession, previousSessions/);
  assert.match(source, /!before\.has\(host\.sessionId\)/);
  assert.match(source, /hosts\.list\(\)\.find\(host =>/);
  assert.match(source, /staleHosts/);
  assert.doesNotMatch(source, /extension && extensionVersion === VERSION && extensionSessionId && extensionSessionId !== previousSession/);
  // The UIA error-list walk must bind to the reloaded host, not the primary.
  const reloaded = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(reloaded, /const reloadedHostId = result\.hostId \?\? args\.hostId \?\? null/);
  assert.match(reloaded, /clearExtensionErrorsViaUia\(reloadedHostId\)/);
  assert.match(reloaded, /const reloadedHost = hostId \? hosts\.byId\(hostId\) : null/);
});

test('a legacy extension without hostId still works and is not refused', async t => {
  const { b, wsUrl } = await setup(t);
  const modern = await connectHost(wsUrl, { hostId: 'h-modern' });
  const legacy = await connectHost(wsUrl, { legacy: true });
  assert.equal(legacy.ready.type, 'ready');
  assert.equal(legacy.ready.protocolVersion, 1);
  assert.ok(legacy.ready.hostId.startsWith('legacy-'));
  assert.equal(legacy.ready.hostCount, 2);
  assert.ok(legacy.ready.warnings.includes('host_id_missing_baseline'));
  assert.equal(b.status().hostCount, 2);
  modern.ws.close(); legacy.ws.close();
});
