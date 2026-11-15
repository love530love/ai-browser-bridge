import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir as defaultStateDir } from './config.js';

export const ADAPTER_REGISTRY_SCHEMA = 'ai-browser-bridge-mcp-adapter-v1';
export const DEFAULT_HEARTBEAT_MS = 15000;
export const DEFAULT_STALE_MS = 45000;
const DEFAULT_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

export function adaptersDir(stateDir = defaultStateDir) {
  return join(stateDir, 'mcp-adapters');
}

function recordPath(dir, pid) {
  return join(dir, `${pid}.json`);
}

// rename keeps readers from seeing a half-written heartbeat record.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function readRecord(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const heartbeatMs = Date.parse(value.heartbeatAt ?? value.startedAt ?? '');
  return { value, heartbeatMs: Number.isFinite(heartbeatMs) ? heartbeatMs : null };
}

export function createAdapterRegistry({
  stateDir = defaultStateDir,
  heartbeatMs = Number(process.env.AIB_ADAPTER_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS,
  now = Date.now,
  pid = process.pid,
  ppid = process.ppid,
  argv = process.argv.slice(1),
  execPath = process.execPath,
  cwd = process.cwd()
} = {}) {
  const dir = adaptersDir(stateDir);
  const file = recordPath(dir, pid);
  const startedAt = new Date(now()).toISOString();
  let timer = null;
  let stopped = false;

  const snapshot = () => ({
    schema: ADAPTER_REGISTRY_SCHEMA,
    pid,
    ppid,
    execPath,
    argv,
    cwd,
    startedAt,
    heartbeatAt: new Date(now()).toISOString()
  });

  function write() {
    writeJsonAtomic(file, snapshot());
  }

  function start() {
    mkdirSync(dir, { recursive: true });
    // A pid reused after a crash still has the old file; this process overwrites it.
    write();
    timer = setInterval(() => {
      if (stopped) return;
      try { write(); } catch {}
    }, Math.max(50, heartbeatMs));
    timer.unref?.();
    return { file, pid, startedAt };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    try { rmSync(file, { force: true }); } catch {}
  }

  return { start, stop, file, dir, pid, startedAt };
}

// Heartbeat freshness is not process liveness. A stale record means "nobody
// refreshed this file", not "this pid is dead", so nothing here signals or kills.
export function listAdapters({
  stateDir = defaultStateDir,
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS
} = {}) {
  const dir = adaptersDir(stateDir);
  let names;
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { schema: ADAPTER_REGISTRY_SCHEMA, dir, staleMs, count: 0, fresh: 0, stale: 0, unreadable: [], liveness: 'not_checked', records: [] };
    }
    throw error;
  }
  const records = [];
  const unreadable = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const { value, heartbeatMs } = readRecord(file);
      const ageMs = heartbeatMs === null ? null : Math.max(0, now - heartbeatMs);
      records.push({
        file,
        pid: Number.isInteger(value.pid) ? value.pid : null,
        ppid: Number.isInteger(value.ppid) ? value.ppid : null,
        execPath: typeof value.execPath === 'string' ? value.execPath : null,
        argv: Array.isArray(value.argv) ? value.argv : [],
        cwd: typeof value.cwd === 'string' ? value.cwd : null,
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
        heartbeatAt: typeof value.heartbeatAt === 'string' ? value.heartbeatAt : null,
        ageMs,
        stale: ageMs === null ? true : ageMs > staleMs
      });
    } catch (error) {
      unreadable.push({ file, error: error.message });
    }
  }
  records.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const stale = records.filter(record => record.stale).length;
  return {
    schema: ADAPTER_REGISTRY_SCHEMA,
    dir,
    staleMs,
    count: records.length,
    fresh: records.length - stale,
    stale,
    unreadable,
    liveness: 'not_checked',
    livenessNote: 'fresh/stale describe this registry only; no process was probed, signalled or killed.',
    records
  };
}

// File removal only, and only past an explicit age. A stale heartbeat can still
// belong to a live adapter whose event loop is blocked, so the default is a day.
export function pruneStaleAdapters({
  stateDir = defaultStateDir,
  now = Date.now(),
  olderThanMs = DEFAULT_PRUNE_AGE_MS,
  dryRun = false
} = {}) {
  const inventory = listAdapters({ stateDir, now, staleMs: olderThanMs });
  const removed = [];
  const kept = [];
  const failed = [];
  for (const record of inventory.records) {
    if (record.ageMs !== null && record.ageMs > olderThanMs) {
      if (!dryRun) {
        try { rmSync(record.file, { force: true }); } catch (error) { failed.push({ file: record.file, error: error.message }); continue; }
      }
      removed.push(record.file);
    } else {
      kept.push(record.file);
    }
  }
  return { schema: ADAPTER_REGISTRY_SCHEMA, dryRun, olderThanMs, removed, kept, failed, unreadable: inventory.unreadable };
}
