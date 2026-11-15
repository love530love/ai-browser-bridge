import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { usageSummary } from '../src/usage-summary.js';

test('usage separates mirrored errors and detects recovery churn within its window', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'logs'));
  const now = Date.parse('2026-10-24T12:00:00Z'), time = new Date(now - 1000).toISOString();
  writeFileSync(join(root, 'logs/audit.jsonl'), [
    {time, tool:'browser_click', outcome:'error', errorCategory:'ELEMENT_COVERED'},
    {time, tool:'extension-error', outcome:'error', detail:'PRIVATE'},
    {time:'2026-01-01', tool:'browser_read', outcome:'error'},
    {time:'2030-01-01', tool:'browser_read', outcome:'error'}
  ].map(JSON.stringify).join('\n'));
  writeFileSync(join(root, 'watchdog.jsonl'), Array(3).fill(JSON.stringify({time,state:'starting-service'})).join('\n'));
  const summary = usageSummary(root, now);
  assert.equal(summary.commandErrors, 1); assert.equal(summary.commandRecords, 1);
  assert.equal(summary.extensionErrorRecords, 1); assert.equal(summary.frequentRestarts, true);
  assert.equal(summary.exitCause, 'unknown'); assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
});

test('usage attributes commands to tools and hosts and reports latency percentiles', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-usage-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  mkdirSync(join(root, 'logs'));
  const now = Date.parse('2026-11-15T12:00:00Z');
  const at = offset => new Date(now - offset).toISOString();
  const rows = [
    { time: at(5000), tool: 'browser_read', hostId: 'h-a', outcome: 'ok', durationMs: 10 },
    { time: at(4000), tool: 'browser_read', hostId: 'h-a', outcome: 'ok', durationMs: 20 },
    { time: at(3000), tool: 'browser_read', hostId: 'h-a', outcome: 'ok', durationMs: 30 },
    { time: at(2000), tool: 'browser_read', hostId: 'h-a', outcome: 'ok', durationMs: 40 },
    { time: at(1000), tool: 'browser_click', hostId: 'h-b', outcome: 'error', errorCategory: 'ELEMENT_COVERED', durationMs: 100 },
    { time: at(500), tool: 'browser_click', outcome: 'ok' }
  ];
  writeFileSync(join(root, 'logs/audit.jsonl'), rows.map(JSON.stringify).join('\n'));
  const summary = usageSummary(root, now);
  assert.equal(summary.commandRecords, 6);
  assert.equal(summary.byTool.browser_read.records, 4);
  assert.equal(summary.byTool.browser_read.p50Ms, 20);
  assert.equal(summary.byTool.browser_read.p95Ms, 40);
  assert.equal(summary.byTool.browser_click.errors, 1);
  assert.equal(summary.byHost['h-a'].records, 4);
  assert.equal(summary.byHost['h-b'].errors, 1);
  assert.equal(summary.byHost.unrecorded.records, 1, 'rows without hostId must stay visibly unrecorded');
  assert.match(summary.hostTelemetryNote, /host attribution is unknown/);
  assert.equal(summary.slowestTools[0].tool, 'browser_click');
  assert.equal(usageSummary(root, now, { windowHours: 12 }).windowHours, 12);
});

test('missing and malformed evidence remains visible', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-usage-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  assert.equal(usageSummary(root).missingFiles, 2);
  writeFileSync(join(root, 'watchdog.jsonl'), 'invalid\n{"time":"bad"}');
  const summary = usageSummary(root);
  assert.equal(summary.malformedRows, 2); assert.equal(summary.missingFiles, 1);
});
