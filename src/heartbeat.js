// Heartbeat / continuous health inspection (0.37.0).
//
// The bridge used to be inspected only when somebody noticed something was
// wrong. This module makes observation continuous and, more importantly,
// makes *claims* about health evidence-based: a clean verdict requires a
// matching build identity and a fresh readable snapshot. Anything short of
// that is `uncertain`, never "clean".
//
// Two rules dominate the design, both learned the hard way in this project:
//  1. A single-sample state conclusion is not a fact. Every finding is
//     debounced against previous cycles and state deltas are compared by
//     hostId, never through the primary compatibility mirror.
//  2. Only two remediations are safe enough to automate - restarting a
//     service whose build identity is stale, and reloading an extension that
//     is behind. Everything else (lost hosts, stuck in-flight commands,
//     unreadable error lists) is reported with evidence and left to the agent,
//     because a guess could replay an unknown write or open a GUI window.
//  3. A cumulative counter is not an instantaneous state. Comparing the
//     dispatch/completion gap with the current in-flight count produced a
//     false `inflight_leak` on an idle fleet (0.40.0).

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, stateDir as defaultStateDir, loadConfig } from './config.js';
import { computeBuildIdentity } from './build-identity.js';
import { VERSION } from './version.js';
import { request as defaultRequest } from './client.js';
import { RELOAD_EXTENSION_CONFIRMATION } from './desktop-adapter.js';

export const HEARTBEAT_DEFAULTS = {
  intervalMs: 60000,
  timeoutMs: 8000,
  debounceCycles: 3,
  staleLockMs: 180000,
  queueSaturationRatio: 0.8,
  stuckAgeMs: 120000,
  auditWindowMs: 300000,
  auditSpikeMin: 5,
  auditSpikeRatio: 3,
  clockTolerance: 0.2,
  cooldownCycles: 3
};

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
};

export function parseHeartbeatArgs(argv = []) {
  const options = { watch: false, remediate: true, json: true, dryRun: false,
    intervalMs: HEARTBEAT_DEFAULTS.intervalMs, timeoutMs: HEARTBEAT_DEFAULTS.timeoutMs, maxCycles: 0 };
  const flags = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === '--watch') options.watch = true;
    else if (flag === '--no-remediate') options.remediate = false;
    else if (flag === '--remediate') options.remediate = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--interval-ms') { options.intervalMs = clampInt(flags[++i], 1000, 3600000, options.intervalMs); }
    else if (flag === '--timeout-ms') { options.timeoutMs = clampInt(flags[++i], 500, 60000, options.timeoutMs); }
    else if (flag === '--max-cycles') { options.maxCycles = clampInt(flags[++i], 1, 100000, 0); }
    else throw new Error(`Unknown heartbeat option: ${flag}. Supported: --watch --interval-ms N --timeout-ms N --max-cycles N --remediate --no-remediate --dry-run --json`);
  }
  return options;
}

// ── Observation ───────────────────────────────────────────────────────────

async function probeStatus(config, timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${config.port}/status`, {
    headers: { Authorization: `Bearer ${config.agentToken}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function readAuditWindows(path, nowMs = Date.now(), windowMs = HEARTBEAT_DEFAULTS.auditWindowMs) {
  if (!existsSync(path)) return { available: false, recent: 0, previous: 0, sampled: 0, malformed: 0, windowMs };
  let lines;
  try { lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500); }
  catch { return { available: false, recent: 0, previous: 0, sampled: 0, malformed: 0, windowMs }; }
  let recent = 0; let previous = 0; let malformed = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { malformed += 1; continue; }
    const at = Date.parse(row?.time ?? '');
    if (!Number.isFinite(at)) continue;
    if (row.outcome !== 'error' && row.tool !== 'extension-error') continue;
    if (nowMs - at <= windowMs) recent += 1;
    else if (nowMs - at <= windowMs * 2) previous += 1;
  }
  return { available: true, recent, previous, sampled: lines.length, malformed, windowMs };
}

export function readDiskFacts(root = ROOT, stateDir = defaultStateDir, nowMs = Date.now()) {
  let manifestVersion = null;
  try { manifestVersion = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')).version ?? null; }
  catch { /* a missing manifest is a finding, not a crash */ }
  let pid = null;
  try { pid = Number.parseInt(readFileSync(join(stateDir, 'server.pid'), 'utf8').trim(), 10); }
  catch { /* watchdog may not have written it yet */ }
  let diskBuildId = null;
  try { diskBuildId = computeBuildIdentity(root); }
  catch { /* unreadable source tree is reported as unknown */ }
  return {
    version: VERSION,
    manifestVersion,
    diskBuildId,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    audit: readAuditWindows(join(stateDir, 'logs', 'audit.jsonl'), nowMs),
    readAt: new Date(nowMs).toISOString()
  };
}

export async function collectSnapshot({
  config = null, probe = null, root = ROOT, stateDir = defaultStateDir,
  diskFacts = null, now = () => Date.now(), timeoutMs = HEARTBEAT_DEFAULTS.timeoutMs
} = {}) {
  const startedAt = now();
  let status = null; let error = null;
  try {
    status = probe ? await probe() : await probeStatus(config ?? loadConfig(), timeoutMs);
    // A payload without a version is not a status reply. Accepting it would let
    // a proxy or an error page masquerade as a healthy bridge.
    if (!status || typeof status !== 'object' || Array.isArray(status) || typeof status.version !== 'string') {
      throw new Error('status payload is missing a version');
    }
  } catch (caught) {
    const message = String(caught?.message ?? caught).slice(0, 300);
    error = { message, kind: /timeout|abort/i.test(message) ? 'timeout' : /refused|ECONNREFUSED|fetch failed/i.test(message) ? 'connection' : 'invalid_payload' };
    status = null;
  }
  return {
    ts: new Date(startedAt).toISOString(), atMs: startedAt, durationMs: now() - startedAt,
    status, error,
    disk: diskFacts ?? readDiskFacts(root, stateDir, startedAt),
    schemaOk: !!status && Array.isArray(status.hosts) && Number.isInteger(status.hostCount)
  };
}

// ── Evaluation ────────────────────────────────────────────────────────────

const hostsOf = status => Array.isArray(status?.hosts) ? status.hosts : [];
const dispatchGap = status => hostsOf(status).reduce((sum, host) =>
  sum + Math.max(0, (host.commandsDispatched ?? 0) - (host.commandsCompleted ?? 0)), 0);

function summarize(status, nowMs) {
  if (!status) return null;
  const hosts = hostsOf(status);
  return {
    ts: new Date(nowMs).toISOString(),
    buildId: status.buildId ?? null,
    version: status.version ?? null,
    extensionVersion: status.extensionVersion ?? null,
    hostIds: hosts.map(host => host.hostId).sort(),
    hostMeta: Object.fromEntries(hosts.map(host => [host.hostId, {
      protocolVersion: host.protocolVersion ?? null,
      extensionVersion: host.extensionVersion ?? null,
      baseline: host.baseline === true,
      connected: host.connected !== false,
      inFlight: !!host.inFlight,
      activeCommandAgeMs: host.activeCommand?.ageMs ?? null,
      dispatched: host.commandsDispatched ?? 0,
      completed: host.commandsCompleted ?? 0
    }])),
    activeCount: status.activeCount ?? 0,
    queued: status.queued ?? 0,
    maxQueuedAgeMs: (status.queuedJobs ?? []).reduce((max, job) => Math.max(max, job.ageMs ?? 0), 0),
    // Cumulative since the last host reconnect: read/write timeouts and
    // ws.close(4000) drop a job without incrementing commandsCompleted.
    // Observation only - never a leak signal (0.40.0).
    dispatchGap: dispatchGap(status),
    activeByHostIds: (Array.isArray(status.activeByHost) ? status.activeByHost : [])
      .map(entry => entry?.hostId).filter(Boolean).sort(),
    inFlightHostIds: hosts.filter(host => host.inFlight).map(host => host.hostId).filter(Boolean).sort(),
    extensionOwner: status.extensionOwner?.pid ?? null,
    hasTaskLease: !!status.taskLease,
    hasDesktopOperation: !!status.desktopOperation,
    hasMaintenance: !!status.maintenance,
    tabLeases: (status.tabLeases ?? []).length
  };
}

function finding(code, baseSeverity, evidence, message, action = null) {
  return { code, baseSeverity, evidence, message, action };
}

function buildRules(ctx) {
  const { snapshot, status, disk, prev, state, nowMs, cfg } = ctx;
  const rules = [];
  if (snapshot.error) {
    rules.push(finding('service_unreachable', 'critical',
      { error: snapshot.error, pid: disk.pid, durationMs: snapshot.durationMs,
        pidSource: '.local/server.pid is an identifier, not liveness proof',
        note: 'One bounded collection timeout is a collection-side observation, not proof the service is down. Verify with the LISTENING PID, a TCP probe and doctor before any action.' },
      'The status endpoint could not be read within the bounded timeout. A collection-side fault is indistinguishable from a hung service at this point, and restarting could truncate an in-flight write, so no remediation is attempted.',
      { kind: 'report_only', nextStep: 'Check the service PID and the watchdog, then re-run heartbeat once.' }));
    return rules;
  }
  const summary = summarize(status, nowMs);

  const versions = new Set([disk.version, disk.manifestVersion, status.version,
    ...hostsOf(status).map(host => host.extensionVersion)].filter(Boolean));
  if (versions.size > 1) rules.push(finding('version_skew', 'warn',
    { serviceSourceVersion: disk.version, manifestVersion: disk.manifestVersion,
      runningVersion: status.version, hostVersions: Object.fromEntries(hostsOf(status).map(h => [h.hostId, h.extensionVersion])) },
    'Source, manifest, service and extension versions disagree.',
    { kind: 'extension_reload', condition: 'build_identity_matches' }));

  if (disk.diskBuildId && status.buildId && status.buildId !== disk.diskBuildId) {
    rules.push(finding('build_stale', 'critical',
      { runningBuildId: status.buildId, diskBuildId: disk.diskBuildId, pid: disk.pid },
      'The running process was started from a different source tree. Restart it through the watchdog so the new code takes effect.',
      { kind: 'build_restart' }));
  }

  if (prev && prev.hostIds) {
    const nowIds = new Set(summary.hostIds);
    const beforeIds = new Set(prev.hostIds);
    // Remember hosts that vanished in earlier cycles. Otherwise the second
    // cycle records an empty host set and the loss can never accumulate the
    // two observations its debounce requires.
    const previouslyMissing = new Set(state?.missingHostIds ?? []);
    const knownBefore = new Set([...beforeIds, ...previouslyMissing]);
    const dropped = [...knownBefore].filter(id => !nowIds.has(id));
    const added = [...nowIds].filter(id => !beforeIds.has(id));
    if (dropped.length) rules.push(finding('host_lost', 'warn',
      { dropped, added, previousHostIds: prev.hostIds, currentHostIds: summary.hostIds, minCycles: 2 },
      'A previously connected browser host is gone. This is reported, never auto-started: the bridge does not launch GUI processes.',
      { kind: 'report_only', nextStep: 'Call browser_hosts to see the surviving hosts; do not silently move explicitly routed tasks.' }));
    if (added.length) rules.push(finding('host_added', 'info',
      { added, previousHostIds: prev.hostIds, currentHostIds: summary.hostIds },
      'A browser host appeared. Freeze any conclusion drawn from the primary compatibility mirror during this cycle.'));
  }

  const degraded = hostsOf(status).filter(host =>
    host.baseline === true || (host.protocolVersion ?? 0) < 2 ||
    (host.warnings ?? []).includes('protocol_downgraded'));
  if (degraded.length) rules.push(finding('host_degraded', 'warn',
    { hosts: degraded.map(host => ({ hostId: host.hostId, protocolVersion: host.protocolVersion, baseline: host.baseline, warnings: host.warnings })) },
    'One or more hosts are on the baseline protocol or reported a downgrade. This is a hint, never a reason to refuse the host.',
    { kind: 'extension_reload', condition: 'build_identity_matches' }));

  const stuck = hostsOf(status).filter(host => host.inFlight && (host.activeCommand?.ageMs ?? 0) > cfg.stuckAgeMs);
  if (stuck.length && prev && summary.dispatchGap === (prev.dispatchGap ?? summary.dispatchGap)) {
    rules.push(finding('host_inflight_stuck', 'warn',
      { hosts: stuck.map(host => ({ hostId: host.hostId, ageMs: host.activeCommand?.ageMs, tool: host.activeCommand?.tool })), dispatchGap: summary.dispatchGap },
      'A host has held a command beyond the stuck threshold with no dispatch/completion change. An unknown outcome must not be replayed.',
      { kind: 'report_only' }));
  }

  const queueLimit = Math.max(16, 16 * Math.max(1, status.hostCount ?? 1));
  if (summary.queued >= Math.floor(queueLimit * cfg.queueSaturationRatio) || summary.maxQueuedAgeMs > 60000) {
    rules.push(finding('queue_saturated', 'warn',
      { queued: summary.queued, queueLimit, maxQueuedAgeMs: summary.maxQueuedAgeMs, queueSummary: status.queueSummary },
      'The queue is at or beyond its saturation threshold. No concurrency change is attempted while writes may be in flight.',
      { kind: 'report_only' }));
  }

  // 0.40.0: `commandsDispatched - commandsCompleted` is a cumulative counter
  // since the last host reconnect. Read/write timeouts and ws.close(4000)
  // deliberately finish a job without incrementing commandsCompleted, so a
  // historical gap (measured in the field: 3 on a completely idle fleet) is
  // NOT evidence of a current leak. The service builds activeCount,
  // activeByHost and hosts[].inFlight from the same inFlight Map in one status
  // snapshot; only those instantaneous accounts can be compared. A mismatch
  // is a warn with no action; escalation still needs three consecutive cycles.
  const activeByHost = Array.isArray(status.activeByHost) ? status.activeByHost : null;
  const activeIds = new Set((activeByHost ?? []).map(entry => entry?.hostId).filter(Boolean));
  const inFlightIds = new Set(hostsOf(status).filter(host => host.inFlight).map(host => host.hostId).filter(Boolean));
  const sameIds = activeIds.size === inFlightIds.size && [...activeIds].every(id => inFlightIds.has(id));
  const accountingMismatch = activeByHost
    ? (status.activeCount ?? 0) !== activeByHost.length || activeByHost.length !== inFlightIds.size || !sameIds
    : (status.activeCount ?? 0) !== inFlightIds.size;
  if (accountingMismatch) {
    rules.push(finding('inflight_leak', 'warn',
      { activeCount: summary.activeCount, activeByHostIds: [...activeIds].sort(),
        inFlightHostIds: [...inFlightIds].sort(), inFlightHosts: inFlightIds.size,
        cumulativeDispatchGap: summary.dispatchGap,
        previousCumulativeDispatchGap: prev?.dispatchGap ?? null,
        note: 'cumulativeDispatchGap is historical and is NOT a trigger; timeouts/ws.close(4000) do not increment commandsCompleted' },
      'In-flight accounting disagrees within one status snapshot. The cumulative dispatch/completion gap is historical and must not be treated as a leak signal; this needs a code fix and a runtime regression test, not a restart.',
      { kind: 'report_only' }));
  }

  const staleLeases = (status.tabLeases ?? []).filter(record => (record.expiresInMs ?? 1) <= 0);
  if (staleLeases.length || (summary.hasTaskLease && !hostsOf(status).some(host => host.connected))) {
    rules.push(finding('tab_lease_stale', 'warn',
      { staleLeases: staleLeases.map(record => ({ tabId: record.tabId, hostId: record.hostId ?? null })), taskLease: status.taskLease },
      'A lease outlived its holder. Leases are never cleared automatically because one may still belong to an in-flight write.',
      { kind: 'report_only' }));
  }

  const audit = disk.audit ?? {};
  if (audit.available && audit.recent >= cfg.auditSpikeMin && audit.recent >= cfg.auditSpikeRatio * Math.max(1, audit.previous)) {
    rules.push(finding('extension_error_spike', 'warn',
      { recent: audit.recent, previous: audit.previous, windowMs: audit.windowMs, malformed: audit.malformed },
      'Recent audit errors spiked. Clearing the extension error list needs a reachable chrome://extensions window; without one the state is unknown, not clean.',
      { kind: 'report_only' }));
  }

  if ((status.hostCount ?? 0) > 0 && !status.extensionOwner) {
    rules.push(finding('owner_unknown', 'warn',
      { hostCount: status.hostCount, remotePorts: hostsOf(status).map(host => ({ hostId: host.hostId, remotePort: host.remotePort })), minCycles: 2 },
      'The socket owner could not be resolved. Never guess the host from window titles or process-name similarity.',
      { kind: 'report_only' }));
  }

  if (!snapshot.schemaOk) rules.push(finding('schema_incomplete', 'warn',
    { hasHosts: Array.isArray(status.hosts), hasHostCount: Number.isInteger(status.hostCount) },
    'The status payload is missing multi-host fields. Verify that a 0.36.0+ service is actually running rather than treating it as healthy.'));
  return rules;
}

export function evaluateSnapshot(snapshot, state = null, options = {}) {
  const cfg = { ...HEARTBEAT_DEFAULTS, ...(options.thresholds ?? {}) };
  const nowMs = options.now?.() ?? snapshot.atMs ?? Date.now();
  const prev = state?.lastSnapshot ?? null;
  const counters = { ...(state?.counters ?? {}) };
  const status = snapshot.status;
  let frozen = false;
  let clockDrift = null;
  if (prev?.ts) {
    const delta = nowMs - Date.parse(prev.ts);
    const expected = options.intervalMs ?? cfg.intervalMs;
    // Only a resident watch loop can promise a fixed cadence. A single-shot
    // cycle driven by an hourly scheduler legitimately arrives much later,
    // and flagging that as clock drift would freeze escalation every run.
    const intervalEnforced = options.intervalEnforced === true;
    if (delta < 0 || (intervalEnforced && expected > 0 && Math.abs(delta - expected) > cfg.clockTolerance * expected)) {
      clockDrift = { deltaMs: delta, expectedMs: expected, intervalEnforced };
      frozen = true;
    }
  }

  const ctx = { snapshot, status, disk: snapshot.disk ?? {}, prev, state, nowMs, cfg };
  const raw = buildRules(ctx);
  const findings = [];
  for (const item of raw) {
    const previous = counters[item.code] ?? { count: 0, firstSeenAt: snapshot.ts };
    const count = previous.count + 1;
    counters[item.code] = { count, firstSeenAt: previous.firstSeenAt ?? snapshot.ts, lastSeenAt: snapshot.ts };
    const minCycles = item.evidence?.minCycles ?? 1;
    if (count < minCycles) continue;
    let severity = item.baseSeverity;
    // A single wobble never becomes critical. Escalation needs repeated
    // evidence, and a clock anomaly freezes escalation entirely.
    if (severity === 'warn' && count >= cfg.debounceCycles && !frozen) severity = 'critical';
    findings.push({ ...item, severity, baseSeverity: item.baseSeverity, occurrences: count, firstSeenAt: counters[item.code].firstSeenAt, at: snapshot.ts });
  }
  // A failed collection observed nothing at all. Dropping counters here would
  // let one transient 8s timeout erase a finding that was two cycles away from
  // being confirmed, so keep the accumulated evidence intact.
  if (!snapshot.error) {
    for (const code of Object.keys(counters)) if (!raw.some(item => item.code === code)) delete counters[code];
  }

  const consecutiveFailures = snapshot.error ? (state?.consecutiveFailures ?? 0) + 1 : 0;
  const heartbeatFailure = consecutiveFailures >= cfg.debounceCycles;
  if (heartbeatFailure) findings.push({
    code: 'heartbeat_collection_failure', severity: 'critical', baseSeverity: 'critical',
    occurrences: consecutiveFailures, at: snapshot.ts,
    evidence: { consecutiveFailures, lastError: snapshot.error },
    message: 'Heartbeat collection failed repeatedly. All external remediation is frozen; the state is uncertain, never clean.',
    action: { kind: 'report_only' }
  });
  if (clockDrift) findings.push({
    code: 'clock_drift', severity: 'warn', baseSeverity: 'warn', occurrences: 1, at: snapshot.ts,
    evidence: clockDrift,
    message: 'Collection interval or clock jumped. Critical escalations are frozen for this cycle because debounce windows are unreliable.',
    action: { kind: 'report_only' }
  });

  // "Clean" is a claim that needs proof, not the absence of findings.
  const provenClean = !snapshot.error && !!status && snapshot.schemaOk &&
    !!snapshot.disk?.diskBuildId && status.buildId === snapshot.disk.diskBuildId &&
    status.version === snapshot.disk.version &&
    status.connected === true &&
    // `connected` is the primary-host compatibility mirror. In a fleet, also
    // require every registered host to be connected before claiming health.
    hostsOf(status).length > 0 && hostsOf(status).every(host => host.connected !== false) &&
    findings.length === 0;
  let verdict;
  if (snapshot.error || (!status && consecutiveFailures > 0)) verdict = 'uncertain';
  else if (findings.some(item => item.severity === 'critical')) verdict = 'critical';
  else if (findings.length) verdict = 'attention';
  else verdict = provenClean ? 'clean' : 'uncertain';

  const nextState = {
    version: 1,
    lastSuccessAt: status ? snapshot.ts : (state?.lastSuccessAt ?? null),
    lastSnapshot: status ? { ...summarize(status, nowMs), ts: snapshot.ts } : prev,
    counters,
    consecutiveFailures,
    cooldowns: { ...(state?.cooldowns ?? {}) },
    // Taken from the raw rules, not the debounced findings: a loss that is
    // still being confirmed must survive into the next cycle's comparison.
    missingHostIds: raw.find(item => item.code === 'host_lost')?.evidence?.dropped ?? [],
    observedIntervalMs: prev?.ts ? nowMs - Date.parse(prev.ts) : null,
    frozen
  };
  return { verdict, findings, nextState, frozen, clockDrift, provenClean,
    summary: summarize(status, nowMs) };
}

// ── Remediation (allow-list only) ─────────────────────────────────────────

export function safeToAct(status) {
  if (!status || typeof status !== 'object') return false;
  const hosts = hostsOf(status);
  return hosts.length > 0 && hosts.every(host => host.connected !== false) &&
    (status.activeCount ?? 0) === 0 && (status.queued ?? 0) === 0 &&
    hosts.every(host => !host.inFlight) && !status.taskLease &&
    !status.desktopOperation && !status.maintenance &&
    (status.tabLeases ?? []).length === 0 && status.connected === true;
}

function cooldownReady(state, action, nowMs, intervalMs, cfg) {
  const last = state.cooldowns?.[action];
  if (!last) return true;
  return nowMs - Date.parse(last.at) >= cfg.cooldownCycles * intervalMs;
}

async function defaultRestart({ pid }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, reason: 'pid_unavailable' };
  try {
    // The watchdog restarts the service with the current source within ~10s.
    // Deliberately not stop.ps1: that writes a paused marker.
    process.kill(pid, 'SIGTERM');
    return { ok: true, pid, method: 'SIGTERM', delegatedTo: 'watchdog' };
  } catch (error) {
    return { ok: false, reason: 'kill_failed', message: String(error?.message ?? error) };
  }
}

async function defaultReload(hostId, requestFn) {
  const args = { confirmation: RELOAD_EXTENSION_CONFIRMATION };
  if (hostId) args.hostId = hostId;
  const response = await requestFn('/call', { name: 'browser_reload_extension', arguments: args });
  const result = response?.result ?? response;
  return { ok: result?.verified === true || result?.status === 'success',
    hostId: hostId ?? 'primary', status: result?.status ?? null,
    verified: result?.verified ?? null, errorListCleared: result?.errorListCleared ?? null };
}

export async function planRemediation(evaluation, snapshot, state, options = {}) {
  const cfg = { ...HEARTBEAT_DEFAULTS, ...(options.thresholds ?? {}) };
  const nowMs = options.now?.() ?? snapshot.atMs ?? Date.now();
  const intervalMs = options.intervalMs ?? cfg.intervalMs;
  const actions = [];
  if (!options.remediate || evaluation.frozen || snapshot.error || !safeToAct(snapshot.status)) {
    return { actions, skipped: true, reason: snapshot.error ? 'collection_uncertain'
      : evaluation.frozen ? 'clock_drift_freeze' : !options.remediate ? 'remediation_disabled' : 'service_not_idle' };
  }
  const add = (kind, payload) => {
    if (!cooldownReady(state, kind, nowMs, intervalMs, cfg)) {
      actions.push({ kind, executed: false, reason: 'cooldown_active' });
      return;
    }
    actions.push({ kind, ...payload, executed: !options.dryRun,
      ...(options.dryRun ? { reason: 'dry_run' } : {}) });
  };
  const has = code => evaluation.findings.some(item => item.code === code);
  const buildMatches = snapshot.status.buildId === snapshot.disk.diskBuildId;
  if (has('build_stale') && snapshot.disk.pid) {
    add('build_restart', { pid: snapshot.disk.pid, runningBuildId: snapshot.status.buildId, diskBuildId: snapshot.disk.diskBuildId });
  } else if (!has('build_stale') && buildMatches && (has('version_skew') || has('host_degraded'))) {
    // Never fall back to `hostId: null` (the primary compatibility mirror).
    // A skew caused only by the manifest, or a downgrade warning on a host
    // whose version matches, must not reload an unrelated browser.
    const skew = evaluation.findings.find(item => item.code === 'version_skew');
    const degraded = evaluation.findings.find(item => item.code === 'host_degraded');
    const behind = new Set();
    for (const [hostId, version] of Object.entries(skew?.evidence?.hostVersions ?? {})) {
      if (version !== snapshot.disk.version) behind.add(hostId);
    }
    for (const entry of degraded?.evidence?.hosts ?? []) if (entry.hostId) behind.add(entry.hostId);
    const known = new Set(hostsOf(snapshot.status).map(host => host.hostId));
    for (const hostId of behind) if (known.has(hostId)) add('extension_reload', { hostId });
  }
  return { actions, skipped: actions.length === 0, reason: actions.length ? null : 'no_allowlisted_action' };
}

export async function executeRemediation(plan, options = {}) {
  const restart = options.restartFn ?? defaultRestart;
  const reload = options.reloadFn ?? ((hostId) => defaultReload(hostId, options.requestFn ?? defaultRequest));
  const results = [];
  let acted = false;
  for (const action of plan.actions) {
    if (!action.executed) { results.push({ ...action, outcome: 'skipped' }); continue; }
    const actionId = randomUUID();
    try {
      const outcome = action.kind === 'build_restart'
        ? await restart({ pid: action.pid })
        : await reload(action.hostId ?? null);
      acted = acted || outcome?.ok === true;
      results.push({ ...action, actionId, outcome: outcome?.ok ? 'dispatched' : 'failed', detail: outcome });
    } catch (error) {
      results.push({ ...action, actionId, outcome: 'failed', detail: { message: String(error?.message ?? error) } });
    }
  }
  return { results, acted };
}

// ── Persistence ───────────────────────────────────────────────────────────

function appendJsonl(path, row) {
  try { appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8'); return true; }
  catch { return false; } // ENOSPC / read-only: degrade to memory, never crash the probe
}

function writeState(dir, state) {
  const target = join(dir, 'state.json');
  const tmp = `${target}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8'); renameSync(tmp, target); return true; }
  catch { try { unlinkSync(tmp); } catch { /* best effort */ } return false; }
}

function readState(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); }
  catch { return null; }
}

function acquireLock(dir, nowMs, staleMs) {
  try { mkdirSync(dir, { recursive: true }); } catch { return { acquired: false, reason: 'state_dir_unwritable' }; }
  const path = join(dir, 'lock');
  const claim = () => {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(nowMs).toISOString(), instanceId: randomUUID() }), 'utf8');
      closeSync(fd);
      return { acquired: true, path };
    } catch (error) { return { acquired: false, error }; }
  };
  const first = claim();
  if (first.acquired) return first;
  if (first.error?.code !== 'EEXIST') return { acquired: false, reason: 'lock_unreadable' };
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    const age = nowMs - Date.parse(owner.at ?? '');
    // An unparseable timestamp means the writer died between openSync('wx')
    // and the write. Treat that lock as untrusted and reclaim it; otherwise a
    // single half-written file disables monitoring forever.
    const untrusted = !Number.isFinite(age);
    if (untrusted || age > staleMs) {
      unlinkSync(path);
      const retry = claim();
      return retry.acquired
        ? { ...retry, reclaimedFrom: owner, reclaimedReason: untrusted ? 'invalid_timestamp' : 'stale' }
        : { acquired: false, owner };
    }
    return { acquired: false, owner, ageMs: age };
  } catch {
    try { unlinkSync(path); } catch { /* another instance may have removed it */ }
    const retry = claim();
    return retry.acquired ? { ...retry, reclaimedReason: 'corrupt_lock' } : { acquired: false, reason: 'lock_corrupt' };
  }
}

function releaseLock(lock) {
  if (!lock?.acquired) return;
  try { unlinkSync(lock.path); } catch { /* already gone */ }
}

function incidentReport(result) {
  const lines = [
    `# Heartbeat incident ${result.ts}`,
    '',
    // Read from the evaluation, not from a separate `verdict` argument. The
    // 0.35.1 incident report shipped with `**undefined**` for exactly this
    // reason: the caller forgot the extra field while CLI/jsonl/evidence all
    // carried the correct value. One source of truth, and a rendered-text test.
    `- verdict: **${result.evaluation.verdict}**`,
    `- cycle: ${result.cycleId}`,
    `- provenClean: ${result.evaluation.provenClean}`,
    `- frozen (clock drift): ${result.evaluation.frozen}`,
    `- buildId: ${result.snapshot.status?.buildId ?? 'unavailable'} / disk: ${result.snapshot.disk?.diskBuildId ?? 'unknown'}`,
    `- hosts: ${result.snapshot.status?.hostCount ?? 'unknown'}`,
    '',
    '## Findings',
    ''
  ];
  if (!result.evaluation.findings.length) lines.push('No findings recorded in this cycle.', '');
  for (const item of result.evaluation.findings) {
    lines.push(`### ${item.code} (${item.severity}, seen ${item.occurrences}x)`);
    lines.push('', item.message, '', '```json', JSON.stringify(item.evidence, null, 2), '```', '');
    if (item.action) lines.push(`Suggested action: \`${JSON.stringify(item.action)}\``, '');
  }
  lines.push('## Remediation', '', '```json', JSON.stringify(result.remediation, null, 2), '```', '');
  if (result.recheck) lines.push('## Re-check', '', '```json', JSON.stringify(result.recheck, null, 2), '```', '');
  lines.push('', '> An uncertain or failed outcome is never reported as clean. Re-observe before citing this report.');
  return `${lines.join('\n')}\n`;
}

// ── One cycle / runner ────────────────────────────────────────────────────

export async function runHeartbeat(options = {}) {
  const stateDir = options.stateDir ?? defaultStateDir;
  const dir = join(stateDir, 'heartbeat');
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const cfg = { ...HEARTBEAT_DEFAULTS, ...(options.thresholds ?? {}) };
  const lock = acquireLock(dir, nowMs, cfg.staleLockMs);
  if (!lock.acquired) {
    return { status: 'skipped', verdict: 'uncertain', reason: 'heartbeat_already_running',
      lock: lock.owner ?? { reason: lock.reason }, ts: new Date(nowMs).toISOString() };
  }
  const cycleId = randomUUID();
  let degraded = false;
  try {
    const snapshot = await collectSnapshot({ ...options, now });
    const state = readState(dir) ?? {};
    const evaluation = evaluateSnapshot(snapshot, state.version ? state : null,
      { now, intervalMs: options.intervalMs ?? cfg.intervalMs,
        // A watch loop's first cycle has no comparable predecessor: state may
        // come from an hourly single-shot run hours earlier. Enforcing a short
        // cadence against that gap would report clock_drift and freeze every
        // escalation on cycle 1 (measured in the field on 2026-11-07).
        intervalEnforced: options.watch === true && (options.cycleIndex ?? 1) > 1,
        thresholds: options.thresholds });
    const plan = await planRemediation(evaluation, snapshot, evaluation.nextState,
      { ...options, now, intervalMs: options.intervalMs ?? cfg.intervalMs, thresholds: options.thresholds });
    const remediation = await executeRemediation(plan, options);
    const cooldowns = { ...(evaluation.nextState.cooldowns ?? {}) };
    for (const item of remediation.results) if (item.executed) cooldowns[item.kind] = { at: new Date(now()).toISOString(), actionId: item.actionId ?? null };
    evaluation.nextState.cooldowns = cooldowns;

    // A remediation is never trusted on its own say-so. Re-observe once.
    let recheck = null;
    if (remediation.acted) {
      const after = await collectSnapshot({ ...options, now });
      recheck = {
        ts: after.ts,
        statusReadable: !after.error,
        buildIdMatches: after.status?.buildId === after.disk?.diskBuildId,
        hostCount: after.status?.hostCount ?? null,
        verdict: after.error ? 'uncertain' : 'observed',
        note: 'A restart is asynchronous (the watchdog needs up to ~10s). This reading is evidence, not a success claim; the next cycle confirms it.'
      };
    }

    const hash = createHash('sha256').update(JSON.stringify({ status: snapshot.status, disk: snapshot.disk })).digest('hex').slice(0, 16);
    const record = { cycleId, ts: snapshot.ts, verdict: evaluation.verdict, provenClean: evaluation.provenClean,
      snapshotHash: hash, durationMs: snapshot.durationMs,
      hostCount: snapshot.status?.hostCount ?? null, activeCount: snapshot.status?.activeCount ?? null,
      queued: snapshot.status?.queued ?? null,
      findings: evaluation.findings.map(item => ({ code: item.code, severity: item.severity, occurrences: item.occurrences })) };
    const day = new Date(nowMs).toISOString().slice(0, 10);
    degraded = !appendJsonl(join(dir, `${day}.jsonl`), record) || !writeState(dir, evaluation.nextState);
    appendJsonl(join(dir, 'evidence.jsonl'), { cycleId, ts: snapshot.ts, step: 'observe', snapshotHash: hash,
      expression: 'GET /status + disk build identity', input: null, output: record });
    appendJsonl(join(dir, 'evidence.jsonl'), { cycleId, ts: snapshot.ts, step: 'classify', snapshotHash: hash,
      output: evaluation.findings.map(item => ({ code: item.code, severity: item.severity, evidence: item.evidence })) });
    if (remediation.results.length) appendJsonl(join(dir, 'evidence.jsonl'),
      { cycleId, ts: snapshot.ts, step: 'act', snapshotHash: hash, output: remediation.results });
    if (recheck) appendJsonl(join(dir, 'evidence.jsonl'),
      { cycleId, ts: snapshot.ts, step: 'recheck', snapshotHash: hash, output: recheck });

    let incidentPath = null;
    if (evaluation.verdict !== 'clean') {
      const incidents = join(dir, 'incidents');
      try {
        mkdirSync(incidents, { recursive: true });
        incidentPath = join(incidents, `${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${cycleId.slice(0, 8)}.md`);
        writeFileSync(incidentPath, incidentReport({ ts: snapshot.ts, cycleId, snapshot, evaluation, remediation: remediation.results, recheck }), 'utf8');
      } catch { incidentPath = null; degraded = true; }
    }

    return {
      status: 'completed', ...record, cycleId,
      serviceVersion: snapshot.status?.version ?? null,
      diskVersion: snapshot.disk?.version ?? null,
      manifestVersion: snapshot.disk?.manifestVersion ?? null,
      runningBuildId: snapshot.status?.buildId ?? null,
      diskBuildId: snapshot.disk?.diskBuildId ?? null,
      frozen: evaluation.frozen,
      findings: evaluation.findings,
      remediation: remediation.results,
      skippedReason: plan.skipped ? plan.reason : null,
      recheck, incidentPath, degraded,
      ...(degraded ? { degradedReason: 'heartbeat state could not be persisted; in-memory result only' } : {}),
      nextStep: evaluation.verdict === 'clean'
        ? 'No action. Re-observe next cycle before citing this as a lasting state.'
        : `Inspect ${incidentPath ?? 'the findings'}; only allow-listed remediations were attempted, and none were reported as clean without a re-check.`
    };
  } finally { releaseLock(lock); }
}

export async function createHeartbeatRunner(options = {}) {
  const intervalMs = options.intervalMs ?? HEARTBEAT_DEFAULTS.intervalMs;
  const maxCycles = options.maxCycles ?? 0;
  let stopped = false; let cycles = 0; let wake = null; let timer = null;
  const results = [];
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); if (wake) wake(); };
  const loop = (async () => {
    while (!stopped) {
      cycles += 1;
      const result = await runHeartbeat({ ...options, watch: true, cycleIndex: cycles });
      results.push(result);
      options.onCycle?.(result, cycles);
      if (stopped || (maxCycles > 0 && cycles >= maxCycles)) break;
      await new Promise(resolve => {
        wake = resolve;
        // Kept referenced on purpose: a watch process has to stay alive
        // between cycles. Unref'ing this timer lets the event loop drain and
        // the daemon exit silently after the first observation.
        timer = setTimeout(() => { wake = null; timer = null; resolve(); }, intervalMs);
      });
    }
    return results;
  })();
  return { stop, loop, results };
}
