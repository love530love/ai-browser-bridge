// Lifecycle evidence: a restart must never be indistinguishable from a crash.
// Everything here runs in a temporary state directory; no service, process or
// signal is involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIFECYCLE_SCHEMA, lifecyclePath, recordLifecycle, readLifecycle,
  summarizeLifecycleBeforeStart
} from '../src/service-lifecycle.js';

const tempState = () => mkdtempSync(join(tmpdir(), 'aib-lifecycle-'));

function clock(startIso = '2026-11-15T10:00:00.000Z', stepMs = 1000) {
  let ms = Date.parse(startIso);
  return () => {
    const value = new Date(ms);
    ms += stepMs;
    return value;
  };
}

function seed(stateDir, events) {
  const now = clock();
  for (const event of events) recordLifecycle(stateDir, event, { now });
}

test('a fresh directory classifies as first_start, not as a crash', () => {
  const stateDir = tempState();
  assert.equal(summarizeLifecycleBeforeStart(stateDir).classification, 'first_start');
  assert.equal(readLifecycle(stateDir).lastExit.classification, 'first_start');
});

test('a heartbeat intent turns the previous exit into planned_restart', () => {
  const stateDir = tempState();
  seed(stateDir, [
    { event: 'service_started', pid: 100, buildId: 'old', version: '0.42.2' },
    { event: 'restart_intent', intentId: 'intent-1', requestedBy: 'heartbeat', pid: 100,
      reason: 'build_stale', runningBuildId: 'old', diskBuildId: 'new' },
    { event: 'shutdown_requested', pid: 100, signal: 'SIGTERM' },
    { event: 'service_exited', pid: 100, exitCode: 0, reason: 'signal:SIGTERM' }
  ]);
  const previous = summarizeLifecycleBeforeStart(stateDir);
  assert.equal(previous.classification, 'planned_restart');
  assert.equal(previous.intentId, 'intent-1');
  assert.equal(previous.evidence.requestedBy, 'heartbeat');
  assert.equal(previous.evidence.diskBuildId, 'new');
});

test('a non-zero exit without an intent is a crash', () => {
  const stateDir = tempState();
  seed(stateDir, [
    { event: 'service_started', pid: 101 },
    { event: 'service_exited', pid: 101, exitCode: 1, reason: 'uncaught_exception' }
  ]);
  const previous = summarizeLifecycleBeforeStart(stateDir);
  assert.equal(previous.classification, 'crash');
  assert.equal(previous.exitCode, 1);
});

test('a recorded fatal error is a crash even without a non-zero exit', () => {
  const stateDir = tempState();
  seed(stateDir, [
    { event: 'service_started', pid: 102 },
    { event: 'service_fatal', pid: 102, reason: 'uncaught_exception' },
    { event: 'service_exited', pid: 102, exitCode: 0 }
  ]);
  assert.equal(summarizeLifecycleBeforeStart(stateDir).classification, 'crash');
});

test('SIGTERM without a recorded intent is unattributed, not planned', () => {
  const stateDir = tempState();
  seed(stateDir, [
    { event: 'service_started', pid: 103 },
    { event: 'shutdown_requested', pid: 103, signal: 'SIGTERM' },
    { event: 'service_exited', pid: 103, exitCode: 0 }
  ]);
  const previous = summarizeLifecycleBeforeStart(stateDir);
  assert.equal(previous.classification, 'signal_shutdown_unattributed');
  assert.equal(previous.signal, 'SIGTERM');
});

test('a vanished run with no exit record is unrecorded_exit, not a crash', () => {
  const stateDir = tempState();
  seed(stateDir, [
    { event: 'service_started', pid: 104, buildId: 'old' }
  ]);
  const previous = summarizeLifecycleBeforeStart(stateDir);
  assert.equal(previous.classification, 'unrecorded_exit');
  assert.equal(previous.evidence.exitRecorded, false);
});

test('a cancelled intent is not credited with the later exit', () => {
  const stateDir = tempState();
  seed(stateDir, [
    { event: 'service_started', pid: 105 },
    { event: 'restart_intent', intentId: 'intent-2', pid: 105 },
    { event: 'restart_intent_cancelled', intentId: 'intent-2', reason: 'kill_failed' },
    { event: 'service_exited', pid: 105, exitCode: 0 }
  ]);
  assert.equal(summarizeLifecycleBeforeStart(stateDir).classification, 'clean_exit_unattributed');
});

test('reading a live ledger reports the last real exit, not the running process', () => {
  const stateDir = tempState();
  seed(stateDir, [
    { event: 'service_started', pid: 106 },
    { event: 'service_exited', pid: 106, exitCode: 0 },
    { event: 'service_started', pid: 107 }
  ]);
  const ledger = readLifecycle(stateDir);
  assert.equal(ledger.lastExit.classification, 'clean_exit_unattributed');
  assert.equal(ledger.lastExit.pid, 106);
  assert.equal(ledger.totalRecorded, 3);
});

test('a malformed line is skipped and never hides valid records', () => {
  const stateDir = tempState();
  seed(stateDir, [{ event: 'service_started', pid: 108 }]);
  appendFileSync(lifecyclePath(stateDir), '{not json}\n', 'utf8');
  const ledger = readLifecycle(stateDir);
  assert.equal(ledger.count, 1);
  assert.equal(ledger.lastExit.classification, 'running', 'the latest start has no successor yet');
  assert.equal(summarizeLifecycleBeforeStart(stateDir).classification, 'unrecorded_exit');
});

test('records carry the documented schema and a stable id', () => {
  const stateDir = tempState();
  const row = recordLifecycle(stateDir, { event: 'service_started', pid: 109 });
  assert.equal(row.schema, LIFECYCLE_SCHEMA);
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  const raw = readLifecycle(stateDir);
  assert.equal(raw.events[0].schema, LIFECYCLE_SCHEMA);
});
