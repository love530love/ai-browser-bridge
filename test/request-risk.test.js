// The risk verdict is the one thing a caller reads before a write, so it has to
// be decidable, stable and honest about what it cannot know. Everything here is
// a pure function: no browser, no network, no CDP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest, validateVerifySpec, readPointer } from '../src/request-risk.js';

test('a read-only request on an ordinary path is safe and needs no confirmation', () => {
  const result = analyzeRequest({ method: 'GET', url: 'https://example.test/api/instances' });
  assert.equal(result.riskLevel, 'safe');
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.dispatched, false);
  assert.equal(result.sent, false);
  assert.equal(result.wouldSendCookies, true);
  assert.equal(result.reversible, null, 'reversibility is unknown for a safe request, not true');
});

test('DELETE is destructive and explicitly not reversible', () => {
  const result = analyzeRequest({ method: 'DELETE', url: 'https://example.test/api/instances/42' });
  assert.equal(result.riskLevel, 'destructive');
  assert.equal(result.reversible, false);
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.reasons.some(reason => /method DELETE/.test(reason)));
});

test('a POST is mutating, and a destructive path segment escalates it', () => {
  const plain = analyzeRequest({ method: 'POST', url: 'https://example.test/api/instances/42/notes', body: '{"text":"hi"}' });
  assert.equal(plain.riskLevel, 'mutating');
  assert.equal(plain.requiresConfirmation, true);

  for (const [path, id] of [
    ['/api/instances/42/shutdown', 'shutdown-or-reset'],
    ['/api/instances/42/terminate', 'delete'],
    ['/api/keys/7/revoke', 'revoke-or-detach'],
    ['/api/jobs/9/purge', 'delete']
  ]) {
    const escalated = analyzeRequest({ method: 'POST', url: `https://example.test${path}`, body: '{}' });
    assert.equal(escalated.riskLevel, 'destructive', `${path} must be destructive`);
    assert.ok(escalated.destructivePatterns.includes(id), `${path} must report ${id}, got ${escalated.destructivePatterns}`);
  }
});

test('a safe method on a destructive path is still escalated, because the pattern is the risk', () => {
  const result = analyzeRequest({ method: 'GET', url: 'https://example.test/api/instances/42/delete' });
  assert.equal(result.riskLevel, 'destructive');
  assert.equal(result.requiresConfirmation, true);
});

test('a query or body switch escalates to destructive', () => {
  const query = analyzeRequest({ method: 'POST', url: 'https://example.test/api/items?force=true', body: '{}' });
  assert.equal(query.riskLevel, 'destructive');
  const body = analyzeRequest({ method: 'POST', url: 'https://example.test/api/items', body: '{"cascade": true}' });
  assert.equal(body.riskLevel, 'destructive');
  assert.deepEqual(body.bodySignals, ['force-true']);
});

test('a path segment only matches as a whole segment', () => {
  // "reset" inside a resource name is not a reset endpoint. Matching substrings
  // is how every request ends up looking dangerous, which trains a caller to
  // ignore the warning.
  const result = analyzeRequest({ method: 'POST', url: 'https://example.test/api/reset-tokens-report', body: '{}' });
  assert.equal(result.riskLevel, 'mutating');
  assert.deepEqual(result.destructivePatterns, []);
});

test('sameOrigin is measured only when a page URL is supplied', () => {
  const unknown = analyzeRequest({ method: 'GET', url: 'https://a.test/x' });
  assert.equal(unknown.sameOrigin, null, 'null means unmeasured, not same-origin');
  assert.equal(analyzeRequest({ method: 'GET', url: 'https://a.test/x', pageUrl: 'https://a.test/page' }).sameOrigin, true);
  assert.equal(analyzeRequest({ method: 'GET', url: 'https://b.test/x', pageUrl: 'https://a.test/page' }).sameOrigin, false);
  assert.equal(analyzeRequest({ method: 'GET', url: 'https://a.test:8443/x', pageUrl: 'https://a.test/page' }).sameOrigin, false,
    'a different port is a different origin');
});

test('a non-http URL is refused as unknown rather than guessed at', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/x', 'not a url', '']) {
    const result = analyzeRequest({ method: 'GET', url });
    assert.equal(result.riskLevel, 'unknown', `${url} must be unknown`);
    assert.equal(result.requiresConfirmation, true, `${url} must not be waved through`);
  }
});

test('a verify block is rejected before the write when it could change state', () => {
  const base = { url: 'https://example.test/api/instances', jsonPointer: '/0/status', expect: 'stopped' };
  assert.equal(validateVerifySpec(undefined).ok, true);
  const ok = validateVerifySpec(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.spec.method, 'GET');
  assert.equal(ok.spec.expect, 'stopped');
  assert.equal(ok.spec.pollMs, 1000);
  assert.equal(ok.spec.maxWaitMs, 30000);

  // The load-bearing refusal: verification polls, so a mutating method here
  // would re-send the change on every attempt.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const bad = validateVerifySpec({ ...base, method });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'verify_method_not_read_only');
  }
  assert.equal(validateVerifySpec({ ...base, jsonPointer: 'status' }).reason, 'verify_pointer_invalid');
  assert.equal(validateVerifySpec({ ...base, jsonPointer: '' }).reason, 'verify_pointer_missing',
    'comparing a whole document to one scalar is never what a caller means');
  assert.equal(validateVerifySpec({ ...base, expect: undefined }).reason, 'verify_expect_missing');
  assert.equal(validateVerifySpec({ ...base, expect: { a: 1 } }).reason, 'verify_expect_not_scalar');
  assert.equal(validateVerifySpec({ ...base, pollMs: 50 }).reason, 'verify_poll_invalid');
  assert.equal(validateVerifySpec({ ...base, maxWaitMs: 10 }).reason, 'verify_wait_invalid');
  assert.equal(validateVerifySpec({ ...base, url: 'ftp://example.test/x' }).reason, 'verify_url_invalid');
});

test('the pointer walk matches RFC 6901, including escapes and arrays', () => {
  const doc = { a: { 'b/c': 1, 'd~e': 2 }, list: [{ status: 'running' }, { status: 'stopped' }], n: null };
  assert.deepEqual(readPointer(doc, '/list/0/status'), { found: true, value: 'running' });
  assert.deepEqual(readPointer(doc, '/list/1/status'), { found: true, value: 'stopped' });
  assert.deepEqual(readPointer(doc, '/a/b~1c'), { found: true, value: 1 });
  assert.deepEqual(readPointer(doc, '/a/d~0e'), { found: true, value: 2 });
  assert.deepEqual(readPointer(doc, '/n'), { found: true, value: null });
  assert.equal(readPointer(doc, '/list/9/status').found, false);
  assert.equal(readPointer(doc, '/missing').found, false);
  assert.deepEqual(readPointer(doc, ''), { found: true, value: doc });
});
