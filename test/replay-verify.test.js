// The write loop is the part of this bridge that decides whether a change
// happened, so its logic is tested against an injected CDP sender rather than a
// browser: the decisions - poll, match, give up, refuse - are pure, and a real
// Chrome is not needed to prove them. What a live browser adds is checked
// separately in the release notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRequest, fetchRequest, verifyRequest, readVerifyValue } from '../extension/cdp-replay.js';

// Returns the queued responses in order, then repeats the last one. Every call
// is recorded so a refusal can be proved to have sent nothing.
function fakeSend(responses) {
  const calls = [];
  const queue = [...responses];
  const send = async (method, params) => {
    calls.push({ method, params });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { result: { value: next } };
  };
  send.calls = calls;
  return send;
}

function pagePayload(bodyText, extra = {}) {
  return {
    aborted: false, timedOut: false, error: null,
    response: {
      status: 200, statusText: 'OK', ok: true, redirected: false,
      url: 'https://app.test/api/x', type: 'basic',
      headers: [['content-type', 'application/json']], headerCount: 1, headersTruncated: false,
      bodyReadable: true, bodyText, bodyLength: bodyText.length, bodyTruncated: false, bodyReadError: null,
      ...extra
    }
  };
}

const SPEC = { url: 'https://app.test/api/instances', method: 'GET', jsonPointer: '/0/status', expect: 'stopped', pollMs: 1, maxWaitMs: 120 };

test('verification reports before, after and the number of reads it took', async () => {
  const send = fakeSend([
    { found: true, value: 'running', httpStatus: 200 },
    { found: true, value: 'stopped', httpStatus: 200 }
  ]);
  const result = await verifyRequest({ send, spec: SPEC, before: { found: true, value: 'running' } });
  assert.equal(result.status, 'verified');
  assert.equal(result.matched, true);
  assert.equal(result.before, 'running');
  assert.equal(result.after, 'stopped');
  assert.equal(result.attempts, 2);
  assert.equal(result.expect, 'stopped');
  assert.equal(result.jsonPointer, '/0/status');
});

test('a read-back that never shows the expected value is a verdict, not a timeout', async () => {
  const send = fakeSend([{ found: true, value: 'running', httpStatus: 200 }]);
  const result = await verifyRequest({ send, spec: { ...SPEC, maxWaitMs: 30 } });
  assert.equal(result.matched, false);
  assert.equal(result.status, 'not_matched');
  assert.equal(result.reason, 'verify_expect_not_observed');
  assert.equal(result.after, 'running', 'the last observed value has to come back, not just a flag');
  assert.equal(result.retryable, false, 'a failed read-back must never invite sending the write again');
  assert.match(result.message, /Do not send it again/);
});

test('a missing pointer and a non-JSON body are told apart', async () => {
  const missing = await verifyRequest({ send: fakeSend([{ found: false, value: null, failedAt: 'status', httpStatus: 200 }]), spec: { ...SPEC, maxWaitMs: 30 } });
  assert.equal(missing.reason, 'verify_pointer_not_found');
  assert.equal(missing.observed.failedAt, 'status');

  const notJson = await verifyRequest({ send: fakeSend([{ found: false, parseError: 'Unexpected token <', httpStatus: 200 }]), spec: { ...SPEC, maxWaitMs: 30 } });
  assert.equal(notJson.reason, 'verify_body_not_json');
  assert.match(notJson.observed.parseError, /Unexpected token/);

  const broken = await verifyRequest({ send: fakeSend([{ found: false, transportError: 'Failed to fetch', httpStatus: 0 }]), spec: { ...SPEC, maxWaitMs: 30 } });
  assert.equal(broken.reason, 'verify_read_failed');
});

test('a CDP failure while reading back is reported, never thrown', async () => {
  const send = async () => { throw new Error('Target closed'); };
  const value = await readVerifyValue(send, SPEC);
  assert.equal(value.found, false);
  assert.match(value.transportError, /Target closed/);
  const result = await verifyRequest({ send, spec: { ...SPEC, maxWaitMs: 10 } });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'verify_read_failed');
});

test('the pointer actually reaches the page-side expression', async () => {
  // A fake sender never runs what it is handed, so a key-name mismatch between
  // the spec and the generated source is invisible to every other test here.
  // That is exactly the bug a first real run found: the expression read
  // req.pointer while the spec carried jsonPointer, so the page threw
  // "Cannot read properties of undefined (reading 'split')" and the caller got
  // thirty seconds of polling against a request that could never succeed.
  const send = fakeSend([{ found: true, value: 'stopped', httpStatus: 200 }]);
  await readVerifyValue(send, SPEC);
  const expression = send.calls[0].params.expression;
  assert.match(expression, /"pointer":"\/0\/status"/, 'the pointer must be embedded, not left undefined');
  assert.match(expression, /credentials: 'include'/);
});

test('a broken verify expression fails once instead of burning the whole deadline', async () => {
  const send = async () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } });
  const result = await verifyRequest({ send, spec: { ...SPEC, maxWaitMs: 5000, pollMs: 1000 } });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'verify_read_failed');
  assert.equal(result.attempts, 1, 'a broken expression cannot be fixed by waiting');
  assert.ok(result.elapsedMs < 1000, `polled for ${result.elapsedMs}ms against a deterministic failure`);
  assert.match(result.message, /says nothing about whether the write took effect/);
});

test('a malformed pointer is a pointer problem, not a network failure', async () => {
  const send = fakeSend([{ found: false, value: null, pointerError: 'pointer is not a string' }]);
  const result = await verifyRequest({ send, spec: { ...SPEC, maxWaitMs: 3000, pollMs: 1000 } });
  assert.equal(result.reason, 'verify_pointer_invalid');
  assert.equal(result.attempts, 1);
  assert.match(result.observed.pointerError, /pointer is not a string/);
});

test('a null at the pointer is comparable as the text "null"', async () => {
  const send = fakeSend([{ found: true, value: null, valueType: 'null', httpStatus: 200 }]);
  const result = await verifyRequest({ send, spec: { ...SPEC, expect: 'null', maxWaitMs: 30 } });
  assert.equal(result.matched, true);
  assert.equal(result.after, 'null');
});

test('browser_fetch refuses a mutating method without sending anything', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const send = fakeSend([pagePayload('{}')]);
    const result = await fetchRequest({ send, method, url: 'https://app.test/api/x', pageUrl: 'https://app.test/page' });
    assert.equal(result.status, 'denied', `${method} must be refused`);
    assert.equal(result.reason, 'fetch_method_not_read_only');
    assert.equal(result.dispatched, false);
    assert.equal(send.calls.length, 0, `${method} must not reach CDP at all`);
  }
});

test('browser_fetch refuses a cross-origin URL and says where the request belonged', async () => {
  const send = fakeSend([pagePayload('{}')]);
  const result = await fetchRequest({ send, method: 'GET', url: 'https://other.test/api/x', pageUrl: 'https://app.test/page' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'fetch_cross_origin_denied');
  assert.equal(result.pageOrigin, 'https://app.test');
  assert.equal(result.targetOrigin, 'https://other.test');
  assert.equal(send.calls.length, 0);
});

test('browser_fetch returns a same-origin JSON body as JSON', async () => {
  const send = fakeSend([pagePayload('{"items":[{"id":1}]}')]);
  const result = await fetchRequest({ send, method: 'GET', url: 'https://app.test/api/x', pageUrl: 'https://app.test/page' });
  assert.equal(result.status, 'success');
  assert.equal(result.tool, 'browser_fetch');
  assert.equal(result.readOnly, true);
  assert.equal(result.destructive, false);
  assert.deepEqual(result.json, { items: [{ id: 1 }] });
  assert.equal(send.calls.length, 1);
});

test('a truncated body is not parsed, because half a document is not JSON', async () => {
  const send = fakeSend([pagePayload('{"items":[{"id":1}', { bodyTruncated: true })]);
  const result = await replayRequest({ send, method: 'GET', url: 'https://app.test/api/x', pageUrl: 'https://app.test/page' });
  assert.equal(result.json, undefined);
  assert.equal(result.response.bodyTruncated, true);
});

test('terse keeps every field that carries a verdict and drops the boilerplate', async () => {
  const send = fakeSend([pagePayload('{"ok":true}')]);
  const full = await replayRequest({ send, method: 'GET', url: 'https://app.test/api/x', pageUrl: 'https://app.test/page' });
  const terse = await replayRequest({ send, method: 'GET', url: 'https://app.test/api/x', pageUrl: 'https://app.test/page', verbosity: 'terse' });

  assert.ok(full.limitations.length >= 5);
  assert.equal(terse.limitations, undefined, 'the disclaimer is read once per session, not once per call');
  assert.equal(terse.response, undefined, 'terse is flat: the nested response object is what carried the header list');
  assert.equal(terse.bodyText, full.response.bodyText);
  for (const key of ['status', 'httpStatus', 'dispatched', 'destructive']) {
    assert.deepEqual(terse[key], full[key], `terse must keep ${key}`);
  }
  assert.ok(JSON.stringify(terse).length < 400, `terse must stay small, got ${JSON.stringify(terse).length} bytes`);
});

test('browser_fetch honours terse too, refusals included', async () => {
  const send = fakeSend([pagePayload('{"ok":true}')]);
  const full = await fetchRequest({ send, method: 'GET', url: 'https://app.test/api/x', pageUrl: 'https://app.test/page' });
  const terse = await fetchRequest({ send, method: 'GET', url: 'https://app.test/api/x', pageUrl: 'https://app.test/page', verbosity: 'terse' });
  assert.equal(terse.limitations, undefined);
  assert.equal(terse.httpStatus, full.httpStatus);
  assert.equal(terse.bodyText, full.response.bodyText);
  assert.ok(JSON.stringify(terse).length < JSON.stringify(full).length / 2,
    `terse must at least halve the payload: ${JSON.stringify(terse).length} vs ${JSON.stringify(full).length}`);

  // A refusal is where the fixed overhead used to be proportionally worst.
  const refused = await fetchRequest({ send, method: 'GET', url: 'https://other.test/x', pageUrl: 'https://app.test/page', verbosity: 'terse' });
  assert.equal(refused.reason, 'fetch_cross_origin_denied');
  assert.equal(refused.dispatched, false);
  assert.ok(JSON.stringify(refused).length < 500, `a terse refusal is still ${JSON.stringify(refused).length} bytes`);
});

test('a replay with a cross-origin body still says so, and still does not retry', async () => {
  const send = fakeSend([pagePayload('ok')]);
  const result = await replayRequest({ send, method: 'POST', url: 'https://other.test/api/x', body: '{}', pageUrl: 'https://app.test/page' });
  assert.equal(result.crossOrigin, true);
  assert.equal(result.destructive, true);
  assert.equal(result.retryable, false);
});
