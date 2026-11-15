// Durable lifecycle evidence for the service process.
//
// Before this ledger existed, a restart was indistinguishable from a crash
// after the fact: the watchdog only recorded that it started the service, and
// the heartbeat incident file was easy to miss. An operator asking "why did
// the old process exit during the regression window?" could only answer with
// a time window and a guess.
//
// Every record is append-only JSONL. The service writes `service_started` and
// `service_exited` (including exit code), the heartbeat writes `restart_intent`
// before it sends SIGTERM, and the next service start classifies what happened
// to the previous process. Classification is evidence-based:
//   planned_restart              a restart_intent for that pid covers the end
//   crash                        non-zero exit code or a recorded fatal error
//   signal_shutdown_unattributed SIGINT/SIGTERM with no recorded intent
//   clean_exit_unattributed      exit code 0 with no recorded intent
//   unrecorded_exit              a run ended with no exit record at all
//   first_start                  no prior run
// `unrecorded_exit` is NOT proof of a crash; it is proof that the exit left no
// record. The distinction is deliberate and is carried in the evidence.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDir as defaultStateDir } from './config.js';

export const LIFECYCLE_SCHEMA = 'ai-browser-bridge-lifecycle-v1';
export const LIFECYCLE_FILE = 'service-lifecycle.jsonl';
export const LIFECYCLE_PREVIOUS_FILE = 'service-lifecycle.previous.jsonl';
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 200;

export function lifecyclePath(stateDir = defaultStateDir) {
  return join(stateDir, LIFECYCLE_FILE);
}

function previousPath(stateDir = defaultStateDir) {
  return join(stateDir, LIFECYCLE_PREVIOUS_FILE);
}

export function recordLifecycle(stateDir = defaultStateDir, event = {}, { now = () => new Date() } = {}) {
  const row = {
    schema: LIFECYCLE_SCHEMA,
    id: randomUUID(),
    time: now().toISOString(),
    ...event
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = lifecyclePath(stateDir);
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        renameSync(file, previousPath(stateDir));
      }
    } catch { /* rotation is best effort; appending is what matters */ }
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  } catch {
    return null; // ENOSPC / read-only: lifecycle evidence degrades, service does not crash
  }
}

export function readLifecycle(stateDir = defaultStateDir, { limit = DEFAULT_LIMIT } = {}) {
  const files = [previousPath(stateDir), lifecyclePath(stateDir)];
  const events = [];
  const unreadable = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let lines;
    try { lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); }
    catch { unreadable.push(file); continue; }
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row?.schema === LIFECYCLE_SCHEMA) events.push(row);
      } catch { /* a half-written line is skipped, not fatal */ }
    }
  }
  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const trimmed = events.slice(-Math.max(1, limit));
  return {
    schema: LIFECYCLE_SCHEMA,
    file: lifecyclePath(stateDir),
    events: trimmed,
    count: trimmed.length,
    totalRecorded: events.length,
    lastExit: classifyLastRun(trimmed),
    unreadable
  };
}

function lastOf(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (predicate(events[i])) return events[i];
  return null;
}

function classifyRun(runEvents, start, { endedBySuccessor = false } = {}) {
  const exit = lastOf(runEvents, event => event.event === 'service_exited');
  const intent = lastOf(runEvents, event => event.event === 'restart_intent');
  const cancelled = lastOf(runEvents, event => event.event === 'restart_intent_cancelled');
  const shutdown = lastOf(runEvents, event => event.event === 'shutdown_requested');
  const fatal = lastOf(runEvents, event => event.event === 'service_fatal');
  const base = {
    at: exit?.time ?? fatal?.time ?? shutdown?.time ?? start?.time ?? null,
    pid: start?.pid ?? exit?.pid ?? null,
    exitCode: exit?.exitCode ?? null,
    signal: shutdown?.signal ?? exit?.signal ?? null,
    reason: exit?.reason ?? shutdown?.reason ?? null,
    intentId: null,
    evidence: {
      startId: start?.id ?? null,
      exitId: exit?.id ?? null,
      shutdownId: shutdown?.id ?? null,
      intentId: intent?.intentId ?? intent?.id ?? null,
      fatalId: fatal?.id ?? null,
      exitRecorded: !!exit
    }
  };

  if (!start) return { classification: 'first_start', at: null, pid: null, evidence: { exitRecorded: !!exit } };

  // A recorded intent is only credible for the process it named.
  const intentCancelled = cancelled && (!intent || String(cancelled.time) > String(intent.time));
  const intentForPid = intent && !intentCancelled &&
    (!intent.pid || !base.pid || intent.pid === base.pid) &&
    (!exit || String(intent.time) <= String(exit.time));
  if (intentForPid && (!fatal || String(fatal.time) < String(intent.time))) {
    return {
      ...base,
      classification: 'planned_restart',
      intentId: intent.intentId ?? intent.id,
      evidence: { ...base.evidence, requestedBy: intent.requestedBy ?? null,
        intentReason: intent.reason ?? null, method: intent.method ?? null,
        runningBuildId: intent.runningBuildId ?? null, diskBuildId: intent.diskBuildId ?? null }
    };
  }

  if (fatal) return { ...base, classification: 'crash', evidence: { ...base.evidence, fatalReason: fatal.reason ?? null } };
  if (exit) {
    if (Number.isInteger(exit.exitCode) && exit.exitCode !== 0) {
      return { ...base, classification: 'crash', evidence: { ...base.evidence, fatalReason: null } };
    }
    if (shutdown?.signal === 'SIGINT' || shutdown?.signal === 'SIGTERM') {
      return { ...base, classification: 'signal_shutdown_unattributed' };
    }
    return { ...base, classification: 'clean_exit_unattributed' };
  }
  if (!endedBySuccessor) {
    // The latest recorded run has not ended; a healthy service is simply running.
    return { ...base, classification: 'running' };
  }
  // A newer run exists but the older one left no exit record: it vanished
  // (hard kill, power loss, or an unwritable exit handler). Absence of
  // evidence, not proof of a crash.
  return { ...base, classification: 'unrecorded_exit' };
}

// Classifies the most recent run that has actually ended. When the newest
// `service_started` has no exit yet, the run before it is the last known exit.
export function classifyLastRun(events = []) {
  const starts = events.filter(event => event.event === 'service_started');
  if (!starts.length) return { classification: 'first_start', at: null, pid: null, evidence: {} };
  const latest = starts[starts.length - 1];
  const latestEnded = events.some(event =>
    String(event.time) > String(latest.time) &&
    (event.event === 'service_exited' || event.event === 'service_fatal'));
  const target = latestEnded || starts.length === 1 ? latest : starts[starts.length - 2];
  const next = starts.find(start => String(start.time) > String(target.time)) ?? null;
  const runEvents = events.filter(event =>
    String(event.time) > String(target.time) && (!next || String(event.time) < String(next.time)));
  return classifyRun(runEvents, target, { endedBySuccessor: !!next });
}

// Called by a starting service BEFORE it writes its own `service_started`
// record. The previous process is treated as ended even if no exit record
// exists, because a replacement is being started right now.
export function summarizeLifecycleBeforeStart(stateDir = defaultStateDir) {
  const { events } = readLifecycle(stateDir);
  const starts = events.filter(event => event.event === 'service_started');
  if (!starts.length) return { classification: 'first_start', at: null, pid: null, evidence: {} };
  const target = starts[starts.length - 1];
  const runEvents = events.filter(event => String(event.time) > String(target.time));
  return classifyRun(runEvents, target, { endedBySuccessor: true });
}
