import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { regressionSummary } from '../src/regression-summary.js';

test('regression summary separates injected failures and never returns captured content', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-reports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const add = (name, report) => { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'report.json'), JSON.stringify(report)); };
  add('1', { completed: false, error: 'Element covered secret-page-value', failureDiagnostics: { text: 'private' } });
  add('2', { completed: false, error: 'covered', faultInjection: 'transparent-overlay-on-local-fixture' });
  add('3', { completed: true });
  add('4', { incomplete: true });
  const result = regressionSummary(dir);
  assert.equal(result.unexpectedFailures, 1);
  assert.equal(result.injectedRuns, 1);
  assert.equal(result.passed, 1);
  assert.equal(result.unreadable, 1);
  assert.equal(result.errorCategories.ELEMENT_COVERED, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret-page-value|private/);
  assert.equal(regressionSummary(join(dir, 'missing')).sampled, 0);
});
