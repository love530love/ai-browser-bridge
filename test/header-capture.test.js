// Request headers are the one capture that is supposed to contain secrets, so
// the promises worth pinning are the boundaries: same origin by default, query
// dropped by default, no request bodies, bounded output, and no persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureRequestHeaders } from '../extension/header-capture.js';

function harness({ pageUrl = 'https://app.example.com/checkout?step=2' } = {}) {
  let listener = null;
  const sent = [];
  const send = async (method, params = {}) => { sent.push({ method, params }); return {}; };
  const subscribe = fn => { listener = fn; return () => { listener = null; }; };
  const emit = (method, params) => {
    if (method && typeof method === 'object') return listener?.(method.method, method.params);
    return listener?.(method, params);
  };
  const readUrl = async () => pageUrl;
  return { send, subscribe, emit, readUrl, sent };
}

const request = (requestId, url, headers = {}, extra = {}) => ({
  method: 'Network.requestWillBeSent',
  params: { requestId, type: extra.type ?? 'Fetch', request: { url, method: extra.method ?? 'POST', headers } }
});

test('the default scope keeps the tab origin, drops the query and merges extra info', async () => {
  const { send, subscribe, emit, readUrl } = harness();
  const pending = captureRequestHeaders({ pageUrl: 'https://app.example.com/checkout?step=2', durationMs: 0, send, subscribe, readUrl });
  emit(request('1', 'https://app.example.com/api/pay?token=abc', { 'Content-Type': 'application/json' }));
  emit({ method: 'Network.requestWillBeSentExtraInfo', params: { requestId: '1', headers: { Cookie: 'sid=secret', Authorization: 'Bearer live-token' } } });
  emit(request('2', 'https://analytics.example.net/collect', { 'X-Track': '1' }));
  const result = await pending;

  assert.equal(result.status, 'success');
  assert.equal(result.secrets, true);
  assert.equal(result.noPersistence, true);
  assert.equal(result.scope, 'tab_origin');
  assert.equal(result.requestCount, 1);
  assert.equal(result.requests[0].url, 'https://app.example.com/api/pay');
  assert.equal(result.requests[0].method, 'POST');
  const headers = Object.fromEntries(result.requests[0].headers.map(item => [item.name.toLowerCase(), item.value]));
  assert.equal(headers.cookie, 'sid=secret');
  assert.equal(headers.authorization, 'Bearer live-token');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(result.requests[0].response, undefined);
  assert.match(result.contentTrust, /live credentials/);
});

test('scope:"all" includes cross-site requests and includeQuery keeps the query', async () => {
  const { send, subscribe, emit, readUrl } = harness();
  const pending = captureRequestHeaders({ pageUrl: 'https://app.example.com/', durationMs: 0, scope: 'all', includeQuery: true, send, subscribe, readUrl });
  emit(request('1', 'https://cdn.example.net/a.js?x=1', { Accept: '*/*' }));
  emit(request('2', 'https://app.example.com/api?y=2', {}));
  const result = await pending;
  assert.equal(result.requestCount, 2);
  assert.equal(result.requests[0].url, 'https://cdn.example.net/a.js?x=1');
  assert.equal(result.requests[1].url, 'https://app.example.com/api?y=2');
});

test('scope:"current_page" keeps only the same path', async () => {
  const { send, subscribe, emit, readUrl } = harness();
  const pending = captureRequestHeaders({
    pageUrl: 'https://app.example.com/checkout?step=2', durationMs: 0, scope: 'current_page', send, subscribe, readUrl
  });
  emit(request('1', 'https://app.example.com/checkout?a=1'));
  emit(request('2', 'https://app.example.com/other'));
  const result = await pending;
  assert.equal(result.requestCount, 1);
  assert.equal(result.requests[0].url, 'https://app.example.com/checkout');
});

test('response headers are absent unless asked for, and present when they are', async () => {
  const off = harness({ pageUrl: 'https://app.example.com/' });
  const first = captureRequestHeaders({ pageUrl: 'https://app.example.com/', durationMs: 0, send: off.send, subscribe: off.subscribe, readUrl: off.readUrl });
  off.emit(request('1', 'https://app.example.com/api'));
  off.emit({ method: 'Network.responseReceived', params: { requestId: '1', response: { status: 200, mimeType: 'application/json', headers: { 'Set-Cookie': 'a=b' } } } });
  const without = await first;
  assert.equal(without.requests[0].response, undefined);

  const on = harness({ pageUrl: 'https://app.example.com/' });
  const second = captureRequestHeaders({ pageUrl: 'https://app.example.com/', durationMs: 0, includeResponseHeaders: true, send: on.send, subscribe: on.subscribe, readUrl: on.readUrl });
  on.emit(request('1', 'https://app.example.com/api'));
  on.emit({ method: 'Network.responseReceived', params: { requestId: '1', response: { status: 401, mimeType: 'text/plain', headers: { 'WWW-Authenticate': 'Bearer' } } } });
  const withHeaders = await second;
  assert.equal(withHeaders.requests[0].response.status, 401);
  assert.equal(withHeaders.requests[0].response.mimeType, 'text/plain');
  assert.equal(withHeaders.requests[0].response.headers[0].value, 'Bearer');
});

test('a non-http tab cannot use the default scope, but scope:"all" is explicit', async () => {
  const { send, subscribe, readUrl } = harness();
  const denied = await captureRequestHeaders({ pageUrl: 'chrome://settings/', durationMs: 0, send, subscribe, readUrl });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'tab_origin_unavailable');
  assert.equal(denied.dispatched, false);

  const all = await captureRequestHeaders({ pageUrl: 'chrome://settings/', durationMs: 0, scope: 'all', send, subscribe, readUrl });
  assert.equal(all.status, 'success');
});

test('the request cap is reported as a partial reason instead of silently dropping', async () => {
  const { send, subscribe, emit, readUrl } = harness({ pageUrl: 'https://app.example.com/' });
  const pending = captureRequestHeaders({ pageUrl: 'https://app.example.com/', durationMs: 0, maxRequests: 1, send, subscribe, readUrl });
  emit(request('1', 'https://app.example.com/a'));
  emit(request('2', 'https://app.example.com/b'));
  const result = await pending;
  assert.equal(result.requestCount, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.partial, true);
  assert.deepEqual(result.partialReasons, ['request_or_byte_limit_reached']);
  assert.equal(result.limits.maxRequests, 1);
});
