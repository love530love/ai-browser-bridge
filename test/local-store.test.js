import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStore, LOCAL_STORE_EXCLUDED } from '../src/local-store.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'aib-store-'));
}

test('the ledger records strategy health without any page data', t => {
  const dir = tempDir();
  const store = createLocalStore({ file: join(dir, 'bridge.db') });
  t.after(() => {
    try { store.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  if (!store.available) {
    t.skip(`node:sqlite unavailable: ${store.reason}`);
    return;
  }
  const ok = store.recordLocateRun({
    action: 'click',
    status: 'found',
    candidateCount: 2,
    confidenceLevel: 'high',
    coverageComplete: true,
    durationMs: 12,
    strategies: [
      { id: 'semantic-dom', status: 'ok', matched: 2, durationMs: 10 },
      { id: 'text-match', status: 'skipped', matched: 0, durationMs: 0 }
    ]
  });
  assert.equal(ok, true);
  const health = store.strategyHealth({ action: 'click' });
  const semantic = health.find(row => row.strategy === 'semantic-dom');
  assert.equal(semantic.runs, 1);
  assert.equal(semantic.matched, 1);
  assert.equal(semantic.errors, 0);
  assert.equal(semantic.averageMs, 10);
  const summary = store.summary();
  assert.equal(summary.runs, 1);
  assert.equal(summary.strategyRows, 2);
  assert.equal(summary.file, 'bridge.db');
  assert.deepEqual(summary.excluded, LOCAL_STORE_EXCLUDED);
  assert.doesNotMatch(JSON.stringify(summary), /secret|https?:|query/i);
});

test('a disabled or broken store degrades to silence, never to an exception', t => {
  const disabled = createLocalStore({ file: null });
  assert.equal(disabled.available, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(disabled.recordLocateRun({ status: 'found' }), false);
  assert.deepEqual(disabled.strategyHealth(), []);
  assert.equal(disabled.summary().runs, 0);
  disabled.close();

  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bridge.db'));
  const broken = createLocalStore({ file: join(dir, 'bridge.db') });
  assert.equal(broken.available, false);
  assert.match(broken.reason, /sqlite_open_failed/);
  assert.equal(broken.recordLocateRun({ status: 'found' }), false);
  broken.close();
});

test('the schema has no column that could hold a query, URL or label', t => {
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bridge.db');
  const store = createLocalStore({ file });
  assert.equal(store.available, true);
  store.recordLocateRun({
    action: 'click', status: 'found', candidateCount: 1, confidenceLevel: 'high',
    coverageComplete: true, durationMs: 5,
    // Extras are deliberately ignored by the writer; this is the assertion that
    // they can never become columns later.
    query: 'secret-query', url: 'https://secret.example/', label: 'secret-label',
    strategies: [{ id: 'semantic-dom', status: 'ok', matched: 1, durationMs: 4 }]
  });
  store.close();

  const db = new DatabaseSync(file);
  try {
    const runColumns = db.prepare('PRAGMA table_info(locator_runs)').all().map(row => row.name);
    const healthColumns = db.prepare('PRAGMA table_info(locator_strategy_health)').all().map(row => row.name);
    assert.deepEqual(runColumns.sort(), ['action', 'candidate_count', 'coverage_complete', 'duration_ms', 'id', 'status', 'strategy_count', 'top_confidence', 'ts'].sort());
    assert.deepEqual(healthColumns.sort(), ['action', 'errors', 'matched', 'runs', 'strategy', 'total_ms', 'updated_at'].sort());
    const raw = JSON.stringify(db.prepare('SELECT * FROM locator_runs').all())
      + JSON.stringify(db.prepare('SELECT * FROM locator_strategy_health').all());
    assert.doesNotMatch(raw, /secret-query|secret-label|secret\.example/);
  } finally {
    db.close();
  }
});

test('retention bounds the run table instead of growing forever', t => {
  const dir = tempDir();
  const store = createLocalStore({ file: join(dir, 'bridge.db'), retention: 10 });
  t.after(() => {
    try { store.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  if (!store.available) {
    t.skip(`node:sqlite unavailable: ${store.reason}`);
    return;
  }
  for (let i = 0; i < 51; i++) {
    store.recordLocateRun({
      action: 'click', status: 'found', candidateCount: 1, confidenceLevel: 'high',
      coverageComplete: true, durationMs: 1,
      strategies: [{ id: 'semantic-dom', status: 'ok', matched: 1, durationMs: 1 }]
    });
  }
  const summary = store.summary();
  assert.equal(summary.runs, 11);
  assert.equal(summary.strategyRows, 1);
  const health = store.strategyHealth();
  assert.equal(health[0].runs, 51);
});
