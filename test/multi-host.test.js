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
  SERVICE_PROTOCOL_VERSION
} from '../src/host-registry.js';

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
  assert.match(source, /clearExtensionErrorsViaUia\(result\.hostId \?\? args\.hostId \?\? null\)/);
  assert.match(source, /const reloadedHost = hostId \? hosts\.byId\(hostId\) : null/);
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
