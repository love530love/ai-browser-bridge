// Local durability for facts too small to belong in a JSON file.
//
// This is deliberately narrow: it records which perception strategy was tried,
// whether it matched, how long it took and nothing else. No page text, URL,
// origin, query, label, ref, cookie, credential or screenshot is written here.
// That boundary is what makes an always-on local database acceptable next to a
// browser session; it is a health ledger, not a browsing archive.
//
// A missing or broken SQLite must never break the bridge. node:sqlite is not
// available on every supported Node build, and a locked database is a normal
// condition, so every method degrades to `available:false` and silence.

import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

let DatabaseSync = null;
let importError = null;
try {
  const sqlite = await import('node:sqlite');
  DatabaseSync = sqlite.DatabaseSync ?? null;
} catch (error) {
  importError = error?.message ?? String(error);
}

export const LOCAL_STORE_EXCLUDED = [
  'page text or HTML',
  'URLs and origins',
  'search queries',
  'element labels or refs',
  'cookies and credentials',
  'screenshots'
];
const EXCLUDED_DATA = LOCAL_STORE_EXCLUDED;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS locator_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    strategy_count INTEGER NOT NULL,
    candidate_count INTEGER NOT NULL,
    top_confidence TEXT,
    coverage_complete INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS locator_strategy_health (
    strategy TEXT NOT NULL,
    action TEXT NOT NULL,
    runs INTEGER NOT NULL DEFAULT 0,
    matched INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    total_ms INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (strategy, action)
  );
`;

function safeString(value, max = 120) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export function createLocalStore({ file = null, retention = 500 } = {}) {
  let db = null;
  let reason = null;
  if (!file) reason = 'disabled';
  else if (!DatabaseSync) reason = importError ? `node_sqlite_unavailable: ${importError}` : 'node_sqlite_unavailable';
  else {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout = 1500;');
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec(SCHEMA);
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', '1');
    } catch (error) {
      reason = `sqlite_open_failed: ${error?.message ?? String(error)}`.slice(0, 300);
      try { db?.close(); } catch { /* already unusable */ }
      db = null;
    }
  }

  let runsSinceRetention = 0;

  const write = (fn, fallback) => {
    if (!db) return fallback;
    try { return fn(); } catch (error) {
      reason = `sqlite_write_failed: ${error?.message ?? String(error)}`.slice(0, 300);
      return fallback;
    }
  };

  const read = (fn, fallback) => {
    if (!db) return fallback;
    try { return fn(); } catch { return fallback; }
  };

  return {
    available: !!db,
    file: file ? basename(file) : null,
    reason,
    excluded: EXCLUDED_DATA,

    recordLocateRun(entry = {}) {
      if (!db) return false;
      const ts = new Date().toISOString();
      const action = safeString(entry.action, 20) ?? 'any';
      const status = safeString(entry.status, 20) ?? 'unknown';
      const strategies = Array.isArray(entry.strategies) ? entry.strategies : [];
      const durationMs = Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0;
      const candidateCount = Number.isFinite(entry.candidateCount) ? Math.max(0, Math.round(entry.candidateCount)) : 0;
      const topConfidence = ['high', 'medium', 'low'].includes(entry.confidenceLevel) ? entry.confidenceLevel : null;
      return write(() => {
        db.prepare('INSERT INTO locator_runs (ts, action, status, strategy_count, candidate_count, top_confidence, coverage_complete, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ts, action, status, strategies.length, candidateCount, topConfidence, entry.coverageComplete === true ? 1 : 0, durationMs);
        const upsert = db.prepare(`INSERT INTO locator_strategy_health (strategy, action, runs, matched, errors, total_ms, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?)
          ON CONFLICT(strategy, action) DO UPDATE SET
            runs = runs + 1,
            matched = matched + excluded.matched,
            errors = errors + excluded.errors,
            total_ms = total_ms + excluded.total_ms,
            updated_at = excluded.updated_at`);
        for (const strategy of strategies) {
          const id = safeString(strategy?.id, 40);
          if (!id) continue;
          const matched = Number(strategy?.matched) > 0 ? 1 : 0;
          const errors = strategy?.status === 'error' ? 1 : 0;
          const elapsed = Number.isFinite(strategy?.durationMs) ? Math.max(0, Math.round(strategy.durationMs)) : 0;
          upsert.run(id, action, matched, errors, elapsed, ts);
        }
        if (++runsSinceRetention >= 50) {
          runsSinceRetention = 0;
          db.prepare('DELETE FROM locator_runs WHERE id NOT IN (SELECT id FROM locator_runs ORDER BY id DESC LIMIT ?)').run(Math.max(1, retention));
        }
        return true;
      }, false);
    },

    strategyHealth({ action = null, limit = 20 } = {}) {
      return read(() => {
        const capped = Math.max(1, Math.min(100, limit));
        const rows = action
          ? db.prepare('SELECT strategy, action, runs, matched, errors, total_ms, updated_at FROM locator_strategy_health WHERE action = ? ORDER BY runs DESC LIMIT ?').all(action, capped)
          : db.prepare('SELECT strategy, action, runs, matched, errors, total_ms, updated_at FROM locator_strategy_health ORDER BY runs DESC LIMIT ?').all(capped);
        return rows.map(row => ({
          strategy: row.strategy,
          action: row.action,
          runs: row.runs,
          matched: row.matched,
          errors: row.errors,
          averageMs: row.runs > 0 ? Math.round(row.total_ms / row.runs) : null,
          updatedAt: row.updated_at
        }));
      }, []);
    },

    summary() {
      return read(() => {
        const runs = db.prepare('SELECT COUNT(*) AS count FROM locator_runs').get()?.count ?? 0;
        const strategies = db.prepare('SELECT COUNT(*) AS count FROM locator_strategy_health').get()?.count ?? 0;
        const latest = db.prepare('SELECT MAX(ts) AS latest FROM locator_runs').get()?.latest ?? null;
        return { available: true, file: file ? basename(file) : null, runs, strategyRows: strategies, latestRunAt: latest, excluded: EXCLUDED_DATA };
      }, { available: false, file: file ? basename(file) : null, runs: 0, strategyRows: 0, latestRunAt: null, excluded: EXCLUDED_DATA });
    },

    close() {
      if (!db) return;
      try { db.close(); } catch { /* closing twice is harmless */ }
      db = null;
    }
  };
}
