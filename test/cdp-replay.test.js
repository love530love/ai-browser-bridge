import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLAY_LIMITS, replayRequest, validateReplayRequest } from '../extension/cdp-replay.js';

const PAGE = 'https://example.test/page';
const TARGET = 'https://example.test/api/save';

// A fake CDP sender: records what was asked for and answers with a canned
// payload. No browser, no network, no chrome API.
function harness(respond) {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (typeof respond === 'function') return respond({ method, params, calls });
    return { result: { value: okValue() } };
  };
  return { calls, send };
}

function okValue(overrides = {}) {
  return {
    aborted: false, timedOut: false, error: null,
    response: {
      status: 200, statusText: 'OK', ok: true, redirected: false,
      url: TARGET, type: 'basic', headers: [['content-type', 'application/json']],
      headerCount: 1, headersTruncated: false, bodyReadable: true,
      bodyText: '{"ok":true}', bodyLength: 11, bodyTruncated: false, bodyReadError: null,
      ...overrides
    }
  };
}

// The expression is one Runtime.evaluate string, so the only way to inspect the
// page-side code is to read it back out of the recorded call.
function expressionOf(calls) {
  assert.equal(calls.length, 1, 'expected exactly one CDP call');
  assert.equal(calls[0].method, 'Runtime.evaluate');
  return calls[0].params.expression;
}

// The embedded request is a JSON literal (with '<' escaped as \u003c, which is
// still valid JSON), so it can be parsed back to prove it round-trips exactly.
function embeddedRequest(calls) {
  const expression = expressionOf(calls);
  const match = /const req = (.*?);\n {2}const controller/s.exec(expression);
  assert.ok(match, 'the expression should embed the request as one literal');
  return JSON.parse(match[1]);
}

test('non-http schemes are refused before a single CDP command is sent', async () => {
  const { calls, send } = harness();
  for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///C:/secret.txt', 'blob:https://example.test/abc', 'chrome-extension://abcdef/page.html']) {
    const result = await replayRequest({ send, method: 'GET', url });
    assert.equal(result.status, 'denied', url);
    assert.equal(result.reason, 'unsupported_scheme', url);
    assert.equal(result.dispatched, false, url);
    assert.equal(result.retryable, false, url);
  }
  assert.deepEqual(calls, [], 'validation must not reach CDP');
});

test('an unsupported or non-string method is refused', async () => {
  const { calls, send } = harness();
  for (const method of ['CONNECT', 'TRACE', 'GE T', 'FROBNICATE']) {
    const result = await replayRequest({ send, method, url: TARGET });
    assert.equal(result.status, 'denied', method);
    assert.equal(result.reason, 'unsupported_method', method);
  }
  const numeric = await replayRequest({ send, method: 42, url: TARGET });
  assert.equal(numeric.reason, 'unsupported_method');
  assert.deepEqual(calls, []);
});

test('setting Cookie by hand is refused and nothing is dispatched', async () => {
  const { calls, send } = harness();
  const result = await replayRequest({ send, method: 'GET', url: TARGET, headers: { Cookie: 'sid=1' } });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'forbidden_header');
  assert.equal(result.dispatched, false);
  // The message has to explain the replacement, or the caller will just retry.
  assert.match(result.message, /credentials:"include"/);
  assert.deepEqual(calls, []);
  // Case and array form must be caught too, not just the object form.
  for (const headers of [{ cookie: 'a=b' }, [['COOKIE', 'a=b']], { Host: 'evil.test' }, { 'content-length': '1' }, { connection: 'close' }, { 'transfer-encoding': 'chunked' }, { referer: 'https://x.test' }]) {
    const denied = await replayRequest({ send, method: 'POST', url: TARGET, headers });
    assert.equal(denied.reason, 'forbidden_header', JSON.stringify(headers));
  }
  assert.deepEqual(calls, []);
});

test('a body on GET or HEAD is refused instead of silently dropped', async () => {
  const { calls, send } = harness();
  const get = await replayRequest({ send, method: 'GET', url: TARGET, body: '{"a":1}' });
  assert.equal(get.reason, 'body_not_allowed');
  const head = await replayRequest({ send, method: 'head', url: TARGET, body: 'x' });
  assert.equal(head.reason, 'body_not_allowed');
  assert.deepEqual(calls, []);
});

test('an over-long body is refused, never truncated', async () => {
  const { calls, send } = harness();
  const body = 'x'.repeat(REPLAY_LIMITS.MAX_BODY_CHARS + 1);
  const result = await replayRequest({ send, method: 'POST', url: TARGET, body });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'body_too_large');
  assert.match(result.message, /refused rather than truncated/);
  assert.deepEqual(calls, []);
});

test('validateReplayRequest normalises method, url and headers without sending anything', () => {
  const ok = validateReplayRequest({
    method: ' post ', url: 'https://example.test/api/save?x=1',
    headers: { 'Content-Type': 'application/json', 'X-Trace': 7 }, body: '{"a":1}'
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.method, 'POST');
  assert.equal(ok.url, 'https://example.test/api/save?x=1');
  assert.deepEqual(ok.headers, [['Content-Type', 'application/json'], ['X-Trace', '7']]);
  assert.equal(ok.body, '{"a":1}');

  const arrayForm = validateReplayRequest({ method: 'PUT', url: TARGET, headers: [['X-A', 'b']] });
  assert.deepEqual(arrayForm.headers, [['X-A', 'b']]);

  assert.equal(validateReplayRequest({ method: 'GET' }).reason, 'invalid_url');
  assert.equal(validateReplayRequest({ method: 'GET', url: 'not a url' }).reason, 'invalid_url');
  assert.equal(validateReplayRequest({ method: 'GET', url: TARGET, body: { a: 1 } }).reason, 'body_must_be_string');
  assert.equal(validateReplayRequest({ method: 'GET', url: TARGET, headers: [['X-A']] }).reason, 'invalid_headers');
  assert.equal(validateReplayRequest({ method: 'GET', url: TARGET, headers: [['Bad Header', 'v']] }).reason, 'invalid_header_name');
  const many = Object.fromEntries(Array.from({ length: REPLAY_LIMITS.MAX_HEADER_COUNT + 1 }, (_, index) => [`x-${index}`, 'v']));
  assert.equal(validateReplayRequest({ method: 'GET', url: TARGET, headers: many }).reason, 'too_many_headers');
  const longValue = { 'x-long': 'v'.repeat(REPLAY_LIMITS.MAX_HEADER_VALUE_CHARS + 1) };
  assert.equal(validateReplayRequest({ method: 'GET', url: TARGET, headers: longValue }).reason, 'header_value_too_long');
});

test('a normal POST sends one Runtime.evaluate whose expression carries method, url and body', async () => {
  const { calls, send } = harness();
  const result = await replayRequest({
    send, method: 'POST', url: TARGET, body: '{"email":"a@b.test"}',
    headers: { 'content-type': 'application/json' }, pageUrl: PAGE
  });
  assert.equal(result.status, 'success');
  assert.equal(result.dispatched, true);
  const params = calls[0].params;
  assert.equal(calls[0].method, 'Runtime.evaluate');
  assert.equal(params.awaitPromise, true);
  assert.equal(params.returnByValue, true);
  assert.match(params.expression, /"method":"POST"/);
  assert.match(params.expression, /https:\/\/example\.test\/api\/save/);
  assert.match(params.expression, /a@b\.test/);
  // The request must go through the page's own fetch, with the documented flags.
  assert.match(params.expression, /fetch\(/);
  assert.match(params.expression, /credentials: 'include'/);
  assert.match(params.expression, /redirect: 'follow'/);
  assert.match(params.expression, /cache: 'no-store'/);
  assert.match(params.expression, /AbortController/);
  const embedded = embeddedRequest(calls);
  assert.equal(embedded.method, 'POST');
  assert.equal(embedded.body, '{"email":"a@b.test"}');
  assert.deepEqual(embedded.headers, [['content-type', 'application/json']]);
});

test('hostile body text stays data: quotes, backslashes, newlines and a script tag do not break the expression', async () => {
  const { calls, send } = harness();
  const body = `it's "quoted" back\\slash\nnewline\r\ttab </script><script>alert(1)</script> \u2028 ${'z'.repeat(10)}`;
  const result = await replayRequest({ send, method: 'POST', url: TARGET, body, headers: { 'x-note': "a'b\\c" } });
  assert.equal(result.status, 'success');
  const expression = expressionOf(calls);
  // Parsing without calling proves the code is syntactically intact.
  assert.doesNotThrow(() => new Function(`return ${expression}`));
  assert.equal(expression.includes('</script>'), false, 'a raw closing tag must not survive into the expression');
  assert.match(expression, /\\u003c\/script>/);
  const embedded = embeddedRequest(calls);
  assert.equal(embedded.body, body, 'the body must survive the round trip byte for byte');
  assert.deepEqual(embedded.headers, [['x-note', "a'b\\c"]]);
});

test('an exception inside the page is reported as a failure that was dispatched', async () => {
  const { calls, send } = harness(() => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: nope' } } }));
  const result = await replayRequest({ send, method: 'POST', url: TARGET, body: 'x' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'replay_evaluate_failed');
  assert.equal(result.dispatched, true);
  assert.equal(result.retryable, false);
  assert.match(result.exceptionText, /TypeError: nope/);
  assert.equal(calls.length, 1);
});

test('a timed-out fetch is uncertain, not failed, because the request may have landed', async () => {
  const { send } = harness(() => ({
    result: { value: { aborted: true, timedOut: true, error: 'The user aborted a request.', response: null } }
  }));
  const result = await replayRequest({ send, method: 'POST', url: TARGET, body: 'charge=1', timeoutMs: 2000 });
  assert.equal(result.reason, 'replay_timeout');
  assert.equal(result.status, 'uncertain');
  assert.notEqual(result.status, 'failed', 'a timeout must never be reported as failed');
  assert.equal(result.dispatched, true);
  assert.equal(result.retryable, false);
  assert.equal(result.timedOut, true);
  assert.match(result.message, /may have reached the server/);
});

test('a CDP transport error after dispatch is uncertain and is not retried', async () => {
  const send = async () => { throw new Error('Debugger is not attached to the tab'); };
  const result = await replayRequest({ send, method: 'POST', url: TARGET, body: 'x' });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'replay_cdp_failed');
  assert.equal(result.dispatched, true);
  assert.equal(result.retryable, false);
});

test('a successful replay is never marked retryable', async () => {
  const { send } = harness();
  const result = await replayRequest({ send, method: 'POST', url: TARGET, body: '{}' });
  assert.equal(result.status, 'success');
  assert.equal(result.retryable, false, 'a retry cannot distinguish "never sent" from "already applied"');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.response.bodyText, '{"ok":true}');
  assert.equal(result.response.bodyLength, 11);
  assert.equal(result.response.bodyTruncated, false);
});

test('a non-safe method is destructive and lists its side effect; GET lists none', async () => {
  const { send } = harness();
  const post = await replayRequest({ send, method: 'DELETE', url: TARGET });
  assert.equal(post.destructive, true);
  assert.deepEqual(post.sideEffects, ['a_real_request_was_sent_and_the_server_may_have_acted_on_it']);

  const get = await replayRequest({ send, method: 'GET', url: TARGET });
  assert.equal(get.destructive, false);
  assert.deepEqual(get.sideEffects, []);

  const head = await replayRequest({ send, method: 'HEAD', url: TARGET });
  assert.equal(head.destructive, false);
  assert.deepEqual(head.sideEffects, []);
});

test('cross-origin replay is flagged; same-origin is not', async () => {
  const { send } = harness();
  const cross = await replayRequest({ send, method: 'POST', url: 'https://api.other.test/collect', body: 'x', pageUrl: PAGE });
  assert.equal(cross.crossOrigin, true);
  assert.match(cross.crossOriginNote, /third-party origin/);

  const same = await replayRequest({ send, method: 'POST', url: TARGET, body: 'x', pageUrl: PAGE });
  assert.equal(same.crossOrigin, false);
  assert.equal(same.crossOriginNote, undefined);

  // A different port is a different origin.
  const port = await replayRequest({ send, method: 'GET', url: 'https://example.test:8443/a', pageUrl: PAGE });
  assert.equal(port.crossOrigin, true);

  // Without a page URL the answer is unknown, which is reported as unknown.
  const unknown = await replayRequest({ send, method: 'GET', url: TARGET });
  assert.equal(unknown.crossOrigin, null);
});

test('a response body over the preview limit is truncated with the real length kept', async () => {
  const long = 'a'.repeat(500);
  const { send } = harness(() => ({ result: { value: okValue({ bodyText: long, bodyLength: 500, bodyTruncated: false }) } }));
  const result = await replayRequest({ send, method: 'GET', url: TARGET, maxResponseChars: 20 });
  assert.equal(result.response.bodyText, 'a'.repeat(20));
  assert.equal(result.response.bodyTruncated, true);
  assert.equal(result.response.bodyLength, 500, 'the real length must survive truncation');
});

test('timeoutMs is clamped into the documented range before it reaches the page', async () => {
  const { calls, send } = harness();
  const high = await replayRequest({ send, method: 'GET', url: TARGET, timeoutMs: 9999999 });
  assert.equal(high.timeoutMs, REPLAY_LIMITS.MAX_TIMEOUT_MS);
  assert.match(expressionOf(calls), new RegExp(`"timeoutMs":${REPLAY_LIMITS.MAX_TIMEOUT_MS}\\b`));

  const { calls: lowCalls, send: lowSend } = harness();
  const low = await replayRequest({ send: lowSend, method: 'GET', url: TARGET, timeoutMs: 1 });
  assert.equal(low.timeoutMs, REPLAY_LIMITS.MIN_TIMEOUT_MS);
  assert.match(expressionOf(lowCalls), new RegExp(`"timeoutMs":${REPLAY_LIMITS.MIN_TIMEOUT_MS}\\b`));

  const { send: defaultSend } = harness();
  const fallback = await replayRequest({ send: defaultSend, method: 'GET', url: TARGET, timeoutMs: 'soon' });
  assert.equal(fallback.timeoutMs, 15000);
});

test('an unreadable opaque response reports no body rather than an empty one', async () => {
  const { send } = harness(() => ({
    result: { value: okValue({
      status: 0, statusText: '', ok: false, url: '', type: 'opaque',
      headers: [], headerCount: 0, bodyReadable: false, bodyText: '', bodyLength: null, bodyTruncated: false
    }) }
  }));
  const result = await replayRequest({ send, method: 'GET', url: 'https://cdn.other.test/x', pageUrl: PAGE });
  assert.equal(result.status, 'success');
  assert.equal(result.response.type, 'opaque');
  assert.equal(result.response.bodyReadable, false);
  assert.equal(result.response.bodyLength, null, 'unknown length, not zero');
  assert.equal(result.response.bodyTruncated, false);
  assert.match(result.limitations.join(' '), /opaque/);
});

test('every result explains what it is not', async () => {
  const { send } = harness();
  const result = await replayRequest({ send, method: 'POST', url: TARGET, body: '{}', pageUrl: PAGE });
  const text = result.limitations.join(' ');
  for (const topic of [/not a copy of a Network-panel entry/, /Cookie header/, /CSRF/, /opaque/, /CORS/, /redirect/]) {
    assert.match(text, topic);
  }
  const denied = await replayRequest({ send, method: 'GET', url: 'javascript:1' });
  assert.ok(Array.isArray(denied.limitations) && denied.limitations.length > 0, 'a refusal still explains the tool');
});
