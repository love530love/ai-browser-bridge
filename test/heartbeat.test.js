// Heartbeat regressions (0.37.0). All probes and remediations are injected:
// these tests never touch a real service, never kill a process and never write
// outside a temporary state directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HEARTBEAT_DEFAULTS, parseHeartbeatArgs, collectSnapshot, readAuditWindows,
  evaluateSnapshot, safeToAct, planRemediation, executeRemediation,
  runHeartbeat, createHeartbeatRunner
} from '../src/heartbeat.js';

const T0 = Date.parse('2026-11-06T15:00:00.000Z');
const host = (over = {}) => ({
  hostId: 'h-a', protocolVersion: 2, extensionVersion: '0.37.0', baseline: false,
  connected: true, inFlight: false, commandsDispatched: 2, commandsCompleted: 2,
  warnings: [], activeCommand: null, remotePort: 1234, ...over
});
const statusOk = (over = {}) => ({
  service: 'ai-browser-bridge', version: '0.37.0', buildId: 'build-a',
  extensionVersion: '0.37.0', hostCount: 1, connected: true,
  hosts: [host()], activeCount: 0, activeByHost: [], queued: 0, queuedJobs: [],
  queueSummary: {}, tabLeases: [], taskLease: null, desktopOperation: null,
  maintenance: null, extensionOwner: { pid: 123, processName: 'chrome' }, ...over
});
const diskOk = (over = {}) => ({
  version: '0.37.0', manifestVersion: '0.37.0', diskBuildId: 'build-a', pid: 999,
  audit: { available: true, recent: 0, previous: 0, sampled: 10, malformed: 0, windowMs: 300000 },
  readAt: new Date(T0).toISOString(), ...over
});
const snap = (over = {}) => ({
  ts: new Date(T0).toISOString(), atMs: T0, durationMs: 12,
  status: statusOk(), error: null, disk: diskOk(), schemaOk: true, ...over
});
const tempState = () => mkdtempSync(join(tmpdir(), 'aib-heartbeat-'));

test('CLI flags are parsed with bounds and unknown flags are refused', () => {
  const parsed = parseHeartbeatArgs(['--watch', '--interval-ms', '5000', '--timeout-ms', '3000', '--max-cycles', '3', '--no-remediate']);
  assert.equal(parsed.watch, true);
  assert.equal(parsed.intervalMs, 5000);
  assert.equal(parsed.timeoutMs, 3000);
  assert.equal(parsed.maxCycles, 3);
  assert.equal(parsed.remediate, false);
  assert.equal(parseHeartbeatArgs([]).remediate, true, 'operators get remediation by default');
  assert.equal(parseHeartbeatArgs(['--interval-ms', '1']).intervalMs, HEARTBEAT_DEFAULTS.intervalMs, 'an out-of-range value falls back instead of spinning');
  assert.throws(() => parseHeartbeatArgs(['--explode']), /Unknown heartbeat option/);
});

test('collection distinguishes an unreadable service from an invalid status payload', async () => {
  const good = await collectSnapshot({ probe: async () => statusOk(), diskFacts: diskOk(), now: () => T0 });
  assert.equal(good.error, null);
  assert.equal(good.schemaOk, true);
  assert.equal(good.status.hostCount, 1);

  const down = await collectSnapshot({ probe: async () => { throw new Error('fetch failed'); }, diskFacts: diskOk(), now: () => T0 });
  assert.equal(down.status, null);
  assert.equal(down.error.kind, 'connection');

  const proxy = await collectSnapshot({ probe: async () => ({ error: 'Authentication required' }), diskFacts: diskOk(), now: () => T0 });
  assert.equal(proxy.status, null, 'an error page must not masquerade as a healthy bridge');
  assert.equal(proxy.error.kind, 'invalid_payload');
});

test('audit windows count only error metadata and tolerate malformed lines', () => {
  const dir = tempState();
  const file = join(dir, 'audit.jsonl');
  const t = T0;
  const row = (offset, outcome = 'error') => JSON.stringify({ time: new Date(t - offset).toISOString(), outcome, tool: 'browser_read' });
  writeFileSync(file, [row(1000), row(2000), row(400000), 'NOT JSON', row(5000, 'ok')].join('\n'));
  const result = readAuditWindows(file, t, 300000);
  assert.equal(result.recent, 2);
  assert.equal(result.previous, 1);
  assert.equal(result.malformed, 1);
  assert.equal(result.sampled, 5);
});

test('a clean verdict requires build identity evidence, not merely no findings', () => {
  const clean = evaluateSnapshot(snap(), null, { now: () => T0 });
  assert.equal(clean.verdict, 'clean');
  assert.equal(clean.provenClean, true);

  const noBuild = evaluateSnapshot(snap({ disk: diskOk({ diskBuildId: null }) }), null, { now: () => T0 });
  assert.equal(noBuild.verdict, 'uncertain', 'unknown build identity is not proof of health');

  const stale = evaluateSnapshot(snap({ disk: diskOk({ diskBuildId: 'build-b' }) }), null, { now: () => T0 });
  assert.equal(stale.verdict, 'critical');
  assert.ok(stale.findings.some(item => item.code === 'build_stale' && item.action.kind === 'build_restart'));

  const unreachable = evaluateSnapshot(snap({ status: null, error: { message: 'refused', kind: 'connection' } }), null, { now: () => T0 });
  assert.equal(unreachable.verdict, 'uncertain');
  assert.ok(unreachable.findings.some(item => item.code === 'service_unreachable' && item.action.kind === 'report_only'));
});

test('a single wobble never escalates; three consecutive cycles do', () => {
  let state = null;
  const skewed = snap({ disk: diskOk({ manifestVersion: '0.36.0' }) });
  const severities = [];
  for (let i = 0; i < 3; i += 1) {
    const at = T0 + i * 60000;
    const cycle = { ...skewed, ts: new Date(at).toISOString(), atMs: at };
    const result = evaluateSnapshot(cycle, state, { now: () => at, intervalMs: 60000 });
    severities.push(result.findings.find(item => item.code === 'version_skew')?.severity);
    state = result.nextState;
  }
  assert.deepEqual(severities, ['warn', 'warn', 'critical']);
  assert.equal(state.counters.version_skew.count, 3);
  const recovered = evaluateSnapshot({ ...snap(), ts: new Date(T0 + 180000).toISOString(), atMs: T0 + 180000 }, state,
    { now: () => T0 + 180000, intervalMs: 60000 });
  assert.equal(recovered.verdict, 'clean');
  assert.equal(recovered.nextState.counters.version_skew, undefined, 'a resolved finding resets its counter');
});

test('host changes are compared by hostId and need two cycles for a loss', () => {
  const first = evaluateSnapshot(snap(), null, { now: () => T0 });
  const lost = { ...snap({
    status: statusOk({ hostCount: 0, hosts: [], connected: false, extensionOwner: null })
  }), ts: new Date(T0 + 60000).toISOString(), atMs: T0 + 60000 };
  const second = evaluateSnapshot(lost, first.nextState, { now: () => T0 + 60000, intervalMs: 60000 });
  assert.equal(second.findings.some(item => item.code === 'host_lost'), false, 'one cycle of loss is not yet evidence');
  const third = evaluateSnapshot({ ...lost, ts: new Date(T0 + 120000).toISOString(), atMs: T0 + 120000 },
    second.nextState, { now: () => T0 + 120000, intervalMs: 60000 });
  const loss = third.findings.find(item => item.code === 'host_lost');
  assert.ok(loss);
  assert.deepEqual(loss.evidence.dropped, ['h-a']);
  assert.equal(loss.action.kind, 'report_only');
});

test('clock drift freezes critical escalation and is itself reported', () => {
  const first = evaluateSnapshot(snap(), null, { now: () => T0 });
  const skewed = { ...snap({ disk: diskOk({ manifestVersion: '0.36.0' }) }), ts: new Date(T0 + 9 * 60000).toISOString(), atMs: T0 + 9 * 60000 };
  const result = evaluateSnapshot(skewed, first.nextState,
    { now: () => T0 + 9 * 60000, intervalMs: 60000, intervalEnforced: true });
  assert.equal(result.frozen, true);
  assert.ok(result.findings.some(item => item.code === 'clock_drift'));
  assert.equal(result.findings.some(item => item.severity === 'critical'), false);

  // A single-shot cycle invoked by an hourly scheduler arrives much later than
  // the default 60s. It must record the real gap without freezing escalation.
  const scheduled = evaluateSnapshot(skewed, first.nextState,
    { now: () => T0 + 9 * 60000, intervalMs: 60000 });
  assert.equal(scheduled.frozen, false);
  assert.equal(scheduled.findings.some(item => item.code === 'clock_drift'), false);
  assert.equal(scheduled.nextState.observedIntervalMs, 9 * 60000);
});

test('idle precondition refuses remediation while anything is in flight', () => {
  assert.equal(safeToAct(statusOk()), true);
  assert.equal(safeToAct(statusOk({ activeCount: 1, hosts: [host({ inFlight: true })] })), false);
  assert.equal(safeToAct(statusOk({ queued: 1 })), false);
  assert.equal(safeToAct(statusOk({ taskLease: 'agent-1' })), false);
  assert.equal(safeToAct(statusOk({ desktopOperation: { tool: 'x' } })), false);
  assert.equal(safeToAct(statusOk({ tabLeases: [{ tabId: 1 }] })), false);
  assert.equal(safeToAct(null), false);
});

test('only build restart and extension reload may be planned, with a dry-run option', async () => {
  const stale = evaluateSnapshot(snap({ disk: diskOk({ diskBuildId: 'build-b' }) }), null, { now: () => T0 });
  const plan = await planRemediation(stale, snap({ disk: diskOk({ diskBuildId: 'build-b' }) }), stale.nextState,
    { remediate: true, dryRun: true, now: () => T0 });
  assert.deepEqual(plan.actions.map(action => action.kind), ['build_restart']);
  assert.equal(plan.actions[0].executed, false, 'a dry run never kills a process');

  const busy = await planRemediation(stale, snap({ status: statusOk({ activeCount: 1, hosts: [host({ inFlight: true })] }) }), stale.nextState,
    { remediate: true, now: () => T0 });
  assert.equal(busy.skipped, true);
  assert.equal(busy.reason, 'service_not_idle');

  const frozen = await planRemediation({ ...stale, frozen: true }, snap(), stale.nextState, { remediate: true, now: () => T0 });
  assert.equal(frozen.reason, 'clock_drift_freeze');

  const hostLost = evaluateSnapshot(snap({ status: statusOk({ hostCount: 0, hosts: [], connected: false, extensionOwner: null }) }), null, { now: () => T0 });
  const noAction = await planRemediation(hostLost, snap(), hostLost.nextState, { remediate: true, now: () => T0 });
  assert.equal(noAction.reason, 'no_allowlisted_action', 'a lost host is reported, never auto-started');
});

test('remediation is injected and never kills a real process in tests', async () => {
  const calls = [];
  const plan = { actions: [
    { kind: 'build_restart', pid: 999, executed: true },
    { kind: 'extension_reload', hostId: 'h-a', executed: true },
    { kind: 'extension_reload', hostId: 'h-b', executed: false, reason: 'cooldown_active' }
  ] };
  const result = await executeRemediation(plan, {
    restartFn: async ({ pid }) => { calls.push(['restart', pid]); return { ok: true, pid }; },
    reloadFn: async hostId => { calls.push(['reload', hostId]); return { ok: true, hostId }; }
  });
  assert.equal(result.acted, true);
  assert.deepEqual(calls, [['restart', 999], ['reload', 'h-a']]);
  assert.equal(result.results[2].outcome, 'skipped');
  assert.ok(result.results[0].actionId);
});

test('a full cycle persists state, evidence and an incident report', async () => {
  const dir = tempState();
  const result = await runHeartbeat({
    stateDir: dir, probe: async () => statusOk(), diskFacts: diskOk(),
    now: () => T0, remediate: false
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.verdict, 'clean');
  assert.equal(result.incidentPath, null, 'a clean cycle writes no incident');
  assert.ok(existsSync(join(dir, 'heartbeat', 'state.json')));
  assert.ok(existsSync(join(dir, 'heartbeat', 'evidence.jsonl')));
  assert.equal(readFileSync(join(dir, 'heartbeat', 'evidence.jsonl'), 'utf8').trim().split('\n').length, 2);

  const bad = await runHeartbeat({
    stateDir: dir, probe: async () => { throw new Error('ECONNREFUSED'); }, diskFacts: diskOk(),
    now: () => T0 + 60000, remediate: false
  });
  assert.equal(bad.verdict, 'uncertain');
  assert.ok(bad.incidentPath && existsSync(bad.incidentPath), 'an abnormal cycle must leave a readable report');
  assert.match(readFileSync(bad.incidentPath, 'utf8'), /never reported as clean/);
  assert.deepEqual(bad.remediation, [], 'no external remediation during a collection failure');
});

test('a stale or live lock prevents two heartbeat instances from double-acting', async () => {
  const dir = tempState();
  mkdirSync(join(dir, 'heartbeat'), { recursive: true });
  writeFileSync(join(dir, 'heartbeat', 'lock'), JSON.stringify({ pid: 4242, at: new Date(T0).toISOString() }));
  const result = await runHeartbeat({ stateDir: dir, probe: async () => statusOk(), diskFacts: diskOk(), now: () => T0 + 1000 });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'heartbeat_already_running');
  assert.equal(result.verdict, 'uncertain');
});

test('watch mode stops after maxCycles without launching a detached process', async () => {
  const dir = tempState();
  const runner = await createHeartbeatRunner({
    stateDir: dir, probe: async () => statusOk(), diskFacts: diskOk(),
    remediate: false, maxCycles: 2, intervalMs: 5
  });
  const results = await runner.loop;
  assert.equal(results.length, 2);
  assert.ok(results.every(item => item.status === 'completed'));
  runner.stop();
});

// ── Audit regressions (0.37.1) ───────────────────────────────────────────
// These are the failures that 730 green tests did not catch: an incident
// report whose rendered text was wrong while every in-memory object was right.

test('the incident report renders the real verdict, never **undefined**', async () => {
  const dir = tempState();
  const result = await runHeartbeat({
    stateDir: dir, probe: async () => { throw new Error('ECONNREFUSED'); },
    diskFacts: diskOk(), now: () => T0, remediate: false
  });
  assert.ok(result.incidentPath);
  const text = readFileSync(result.incidentPath, 'utf8');
  assert.match(text, new RegExp(`- verdict: \\*\\*${result.verdict}\\*\\*`));
  assert.doesNotMatch(text, /\*\*undefined\*\*/, 'the CLI/jsonl/evidence copies were correct while the report was not');
  assert.match(text, /- provenClean: false/);
  assert.match(text, /service_unreachable/);
  assert.match(text, /- cycle: [0-9a-f-]{36}/);
  assert.match(text, /- buildId: unavailable \/ disk: build-a/);
});

test('a failed collection does not erase an almost-confirmed finding', () => {
  const skewed = snap({ disk: diskOk({ manifestVersion: '0.36.0' }) });
  let state = null;
  for (let i = 0; i < 2; i += 1) {
    const at = T0 + i * 60000;
    state = evaluateSnapshot({ ...skewed, ts: new Date(at).toISOString(), atMs: at },
      state, { now: () => at, intervalMs: 60000 }).nextState;
  }
  assert.equal(state.counters.version_skew.count, 2);
  const failedAt = T0 + 120000;
  const failed = evaluateSnapshot({ ...snap(), status: null, error: { message: 'timeout', kind: 'timeout' },
    ts: new Date(failedAt).toISOString(), atMs: failedAt }, state,
  { now: () => failedAt, intervalMs: 60000 });
  assert.equal(failed.nextState.counters.version_skew.count, 2, 'one timeout must not reset the debounce');
  const finalAt = T0 + 180000;
  const final = evaluateSnapshot({ ...skewed, ts: new Date(finalAt).toISOString(), atMs: finalAt },
    failed.nextState, { now: () => finalAt, intervalMs: 60000 });
  assert.equal(final.findings.find(item => item.code === 'version_skew').severity, 'critical');
});

test('an extension reload is never sent to the primary mirror when no host is behind', async () => {
  // Skew caused only by the manifest: every connected host already matches.
  const onlyManifest = snap({ disk: diskOk({ manifestVersion: '0.36.0' }) });
  const evaluation = evaluateSnapshot(onlyManifest, null, { now: () => T0 });
  assert.ok(evaluation.findings.some(item => item.code === 'version_skew'));
  const plan = await planRemediation(evaluation, onlyManifest, evaluation.nextState,
    { remediate: true, dryRun: true, now: () => T0 });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.reason, 'no_allowlisted_action');

  // A genuinely behind host is still reloaded, bound to its own hostId.
  const behind = snap({ status: statusOk({ hosts: [host({ extensionVersion: '0.36.0' })] }) });
  const ev2 = evaluateSnapshot(behind, null, { now: () => T0 });
  const plan2 = await planRemediation(ev2, behind, ev2.nextState,
    { remediate: true, dryRun: true, now: () => T0 });
  assert.deepEqual(plan2.actions.map(action => action.hostId), ['h-a']);
  assert.ok(plan2.actions.every(action => action.hostId));
});

test('a half-written lock cannot disable monitoring forever', async () => {
  const dir = tempState();
  mkdirSync(join(dir, 'heartbeat'), { recursive: true });
  writeFileSync(join(dir, 'heartbeat', 'lock'), JSON.stringify({ pid: 4242 })); // no `at`
  const result = await runHeartbeat({ stateDir: dir, probe: async () => statusOk(),
    diskFacts: diskOk(), now: () => T0, remediate: false });
  assert.equal(result.status, 'completed');
  assert.notEqual(result.reason, 'heartbeat_already_running');
});

test('watch mode enforces cadence only from its second cycle', async () => {
  const dir = tempState();
  const base = { stateDir: dir, probe: async () => statusOk(), diskFacts: diskOk(), remediate: false };
  await runHeartbeat({ ...base, now: () => T0 });
  // The first watch cycle inherits state from an hourly single-shot run.
  const first = await runHeartbeat({ ...base, now: () => T0 + 3600000,
    watch: true, cycleIndex: 1, intervalMs: 10000 });
  assert.equal(first.frozen, false);
  assert.equal(first.findings.some(item => item.code === 'clock_drift'), false);
  // From cycle 2 the predecessor belongs to this same watch loop.
  const second = await runHeartbeat({ ...base, now: () => T0 + 3660000,
    watch: true, cycleIndex: 2, intervalMs: 10000 });
  assert.equal(second.frozen, true);
  assert.ok(second.findings.some(item => item.code === 'clock_drift'));
});

test('the real status probe uses the Bearer token and a bounded timeout', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => statusOk() };
  };
  try {
    const result = await collectSnapshot({
      config: { port: 19387, agentToken: 'a'.repeat(64) },
      diskFacts: diskOk(), now: () => T0, timeoutMs: 5000
    });
    assert.equal(result.error, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:19387/status');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
    assert.ok(calls[0].init.signal, 'an unbounded probe would hang the scheduler');
  } finally { globalThis.fetch = original; }
});

test('the default reload action sends the exact /call contract', async () => {
  const calls = [];
  const plan = { actions: [{ kind: 'extension_reload', hostId: 'h-a', executed: true }] };
  const result = await executeRemediation(plan, {
    requestFn: async (path, data) => {
      calls.push({ path, data });
      return { result: { status: 'success', verified: true } };
    }
  });
  assert.equal(result.acted, true);
  assert.equal(calls[0].path, '/call');
  assert.equal(calls[0].data.name, 'browser_reload_extension');
  assert.equal(calls[0].data.arguments.hostId, 'h-a');
  assert.ok(calls[0].data.arguments.confirmation);
});

test('remediation and dry-run switches have opposite, observable behaviour', async () => {
  const stale = snap({ disk: diskOk({ diskBuildId: 'build-b' }) });
  const evaluation = evaluateSnapshot(stale, null, { now: () => T0 });
  const enabled = await planRemediation(evaluation, stale, evaluation.nextState, { remediate: true, now: () => T0 });
  const disabled = await planRemediation(evaluation, stale, evaluation.nextState, { remediate: false, now: () => T0 });
  assert.equal(enabled.actions[0].executed, true);
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.reason, 'remediation_disabled');
  let killed = 0;
  const restartFn = async () => { killed += 1; return { ok: true }; };
  await executeRemediation(enabled, { restartFn });
  assert.equal(killed, 1);
  const dry = await planRemediation(evaluation, stale, evaluation.nextState, { remediate: true, dryRun: true, now: () => T0 });
  await executeRemediation(dry, { restartFn });
  assert.equal(killed, 1, 'a dry run must not touch the service');
});

test('health claims require every registered host to be connected', () => {
  assert.equal(safeToAct(statusOk({ hostCount: 0, hosts: [], connected: false })), false);
  assert.equal(safeToAct(statusOk({ hosts: [host({ connected: false })] })), false);
  const broken = evaluateSnapshot(snap({ status: statusOk({ hosts: [host({ connected: false })] }) }),
    null, { now: () => T0 });
  assert.equal(broken.provenClean, false);
  assert.equal(broken.verdict, 'uncertain', 'a disconnected host must not be reported as healthy');
});
