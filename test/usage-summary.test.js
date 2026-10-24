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

test('missing and malformed evidence remains visible', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-usage-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  assert.equal(usageSummary(root).missingFiles, 2);
  writeFileSync(join(root, 'watchdog.jsonl'), 'invalid\n{"time":"bad"}');
  const summary = usageSummary(root);
  assert.equal(summary.malformedRows, 2); assert.equal(summary.missingFiles, 1);
});
