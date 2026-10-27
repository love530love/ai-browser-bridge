import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceReport } from '../src/acceptance-report.js';
test('a successful observation never certifies skipped GUI actions', () => {
  const r = acceptanceReport(['observe', 'select', 'reselect'], [{ id: 'observe', status: 'passed' }]);
  assert.equal(r.status, 'partial'); assert.equal(r.exitCode, 2); assert.equal(r.skipped, 2);
});
test('complete and failed acceptance are distinguishable', () => {
  assert.equal(acceptanceReport(['x'], [{ id: 'x', status: 'passed' }]).exitCode, 0);
  assert.equal(acceptanceReport(['x', 'y'], [{ id: 'x', status: 'failed' }]).exitCode, 1);
});
test('duplicate or unrelated passing results cannot inflate coverage', () => {
  assert.throws(() => acceptanceReport(['x'], [{ id: 'x', status: 'passed' }, { id: 'x', status: 'passed' }]));
  assert.throws(() => acceptanceReport(['x'], [{ id: 'other', status: 'passed' }]));
  assert.throws(() => acceptanceReport(['x', 'x'], []));
});
