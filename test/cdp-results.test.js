import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatedValue, resourceSummary } from '../extension/cdp-results.js';

test('direct CDP payload yields actual resources instead of a false empty array', () => {
  const result = resourceSummary({ result: { type: 'object', value: { readyState: 'complete', timeOrigin: 10, entries: [
    { name: 'https://user:secret@example.test/category?token=private#hidden', initiatorType: 'fetch', duration: 5 },
    { name: 'data:text/plain,private', initiatorType: 'img' }
  ] } } });
  assert.equal(result.count, 2);
  assert.equal(result.entries[0].name, 'https://example.test/category');
  assert.equal(result.entries[1].name, '[non-http resource]');
  assert.doesNotMatch(JSON.stringify(result), /secret|private|hidden/);
});
test('evaluation errors and missing values never masquerade as empty data', () => {
  for (const payload of [{}, { result: { type: 'undefined' } }, { exceptionDetails: {}, result: { value: [] } }]) {
    assert.throws(() => evaluatedValue(payload));
  }
  assert.throws(() => resourceSummary({ result: { value: [] } }));
  const empty = resourceSummary({ result: { value: { entries: [], readyState: 'loading' } } });
  assert.equal(empty.count, 0);
  assert.match(empty.emptyMeaning, /not proof/);
  assert.equal(evaluatedValue({ result: { value: { readyState: 'complete' } } }).readyState, 'complete');
});
