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

test('network timing detail survives only as bounded, typed fields', () => {
  const result = resourceSummary({ result: { value: { entries: [{
    name: 'https://example.test/app.js?token=private',
    timing: {
      dns: 4, connect: 8, tls: 3, request: 12, response: 20,
      worker: null, redirect: '',
      nextHopProtocol: 'h2', responseStatus: 200,
      serverTiming: [{ name: 'db', duration: 7, description: 'query' }]
    }
  }] } } });
  assert.equal(result.entries[0].name, 'https://example.test/app.js');
  assert.equal(result.entries[0].timing.dns, 4);
  assert.equal(result.entries[0].timing.nextHopProtocol, 'h2');
  assert.equal(result.entries[0].timing.serverTiming[0].name, 'db');
  assert.doesNotMatch(JSON.stringify(result), /private/);
  // Absent is not zero: Number(null) and Number('') are both 0, and reporting a
  // measured 0ms phase changes the diagnosis of a slow resource.
  assert.equal(result.entries[0].timing.worker, null);
  assert.equal(result.entries[0].timing.redirect, null);

  const without = resourceSummary({ result: { value: { entries: [{ name: 'https://example.test/a' }] } } });
  assert.equal(without.entries[0].timing, undefined);
});
