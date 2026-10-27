import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDevtools, createRecorder, createTabSubscription, safeResourceUrl } from '../extension/cdp-capture.js';
import { validateCall } from '../src/tools.js';

const TAB = 1;
const URL_A = 'https://example.test/a';

function setup({ fail = {}, metrics = [] } = {}) {
  const listeners = new Set();
  const calls = [];
  const api = { onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } };
  const send = async method => {
    calls.push(method);
    if (fail[method]) throw new Error(fail[method]);
    if (method === 'Performance.getMetrics') return { metrics };
    return {};
  };
  const emit = (source, method, params = {}) => { for (const fn of [...listeners]) fn(source, method, params); };
  return { api, calls, send, emit, listeners };
}

function run(harness, { requested = ['console'], events = [], durationMs = 5, maxEvents = 100, afterUrl = URL_A, readUrl } = {}) {
  return captureDevtools({
    tabId: TAB, expectedUrl: URL_A, requested, durationMs, maxEvents,
    send: harness.send,
    subscribe: createTabSubscription(harness.api, TAB),
    readUrl: readUrl ?? (async () => afterUrl),
    sleep: async () => { for (const [method, params] of events) harness.emit({ tabId: TAB }, method, params); }
  });
}

test('console, exception and log entries keep page text but never serialise object arguments', async () => {
  const harness = setup();
  const result = await run(harness, { events: [
    ['Runtime.consoleAPICalled', { type: 'warning', args: [
      { type: 'string', value: 'retrying request' },
      { type: 'object', subtype: 'object', description: 'Object' },
      { type: 'number', value: 42 }
    ] }],
    ['Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' }, url: `${URL_A}#frag`, lineNumber: 7 } }],
    ['Log.entryAdded', { entry: { level: 'error', source: 'network', text: 'Failed to load resource', url: 'https://user:pw@example.test/s?t=1#x', lineNumber: 0 } }]
  ] });
  assert.equal(result.status, 'success');
  assert.equal(result.partial, false);
  assert.deepEqual(result.domains, { console: 'enabled' });
  const [consoleEntry, exception, log] = result.messages;
  assert.equal(consoleEntry.kind, 'console');
  assert.equal(consoleEntry.level, 'warning');
  assert.match(consoleEntry.text, /retrying request/);
  assert.match(consoleEntry.text, /\[object\]/);
  assert.match(consoleEntry.text, /42/);
  assert.doesNotMatch(JSON.stringify(consoleEntry), /description|Object"/);
  assert.equal(exception.level, 'error');
  assert.equal(exception.url, URL_A);
  assert.equal(exception.line, 7);
  assert.equal(log.kind, 'log');
  assert.equal(log.level, 'error');
  // Credentials, query and fragment never reach the caller.
  assert.equal(log.url, 'https://example.test/s');
  assert.doesNotMatch(JSON.stringify(result), /user:pw|\?t=1|#x/);
  assert.match(result.negativeEvidence.join(' '), /not proof/);
});

test('network records merge request and completion, exclude secrets, and keep failures', async () => {
  const harness = setup();
  const result = await run(harness, { requested: ['network'], events: [
    ['Network.requestWillBeSent', { requestId: 'r1', type: 'XHR', timestamp: 1000,
      request: { method: 'POST', url: 'https://user:pw@example.test/api/save?token=abc#x', postData: 'secret=1', headers: { Cookie: 'sid=1' } } }],
    ['Network.responseReceived', { requestId: 'r1', response: { status: 201, mimeType: 'application/json', headers: { 'Set-Cookie': 'a=b' } } }],
    ['Network.loadingFinished', { requestId: 'r1', timestamp: 1000.25, encodedDataLength: 512 }],
    ['Network.requestWillBeSent', { requestId: 'r2', type: 'Image', timestamp: 1001, request: { method: 'GET', url: 'https://cdn.test/p.png' } }],
    ['Network.loadingFailed', { requestId: 'r2', timestamp: 1001.5, errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector', canceled: true }]
  ] });
  assert.equal(result.network.length, 2);
  const [first, second] = result.network;
  assert.equal(first.state, 'completed');
  assert.equal(first.method, 'POST');
  assert.equal(first.status, 201);
  assert.equal(first.url, 'https://example.test/api/save');
  assert.equal(first.encodedDataLength, 512);
  assert.equal(first.durationMs, 250);
  assert.equal(second.state, 'failed');
  assert.equal(second.canceled, true);
  assert.equal(second.failureText, 'net::ERR_BLOCKED_BY_CLIENT');
  assert.equal(second.blockedReason, 'inspector');
  assert.equal(result.pendingAtWindowEnd, 0);
  const serialised = JSON.stringify(result.network);
  for (const forbidden of ['postData', 'secret=1', 'Cookie', 'sid=1', 'Set-Cookie', 'token=abc', 'user:pw']) {
    assert.equal(serialised.includes(forbidden), false, `network record leaked ${forbidden}`);
  }
});

test('a request still in flight is reported as pending, not as a completed request', async () => {
  const harness = setup();
  const result = await run(harness, { requested: ['network'], events: [
    ['Network.requestWillBeSent', { requestId: 'slow', type: 'Fetch', timestamp: 5, request: { method: 'GET', url: 'https://example.test/slow' } }]
  ] });
  assert.equal(result.network.length, 1);
  assert.equal(result.network[0].state, 'pending');
  assert.equal(result.network[0].durationMs, null);
  assert.equal(result.pendingAtWindowEnd, 1);
});

test('buffer overflow is counted instead of silently discarding entries', async () => {
  const harness = setup();
  const events = Array.from({ length: 5 }, (_, index) => ['Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: `line ${index}` }] }]);
  const result = await run(harness, { maxEvents: 2, events });
  assert.equal(result.messages.length, 2);
  assert.equal(result.dropped, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.counts.console, 5);
  assert.equal(result.overflow.messages, 3);
  assert.ok(result.partialReasons.includes('buffer_limit_reached'));
  assert.equal(result.partial, true);
});

test('script parsing is deduplicated and marks inline scripts and source maps', async () => {
  const harness = setup();
  const result = await run(harness, { requested: ['scripts'], events: [
    ['Debugger.scriptParsed', { scriptId: '1', url: 'https://example.test/app.js?cache=1', length: 900, sourceMapURL: 'https://example.test/app.js.map' }],
    ['Debugger.scriptParsed', { scriptId: '1', url: 'https://example.test/app.js?cache=1', length: 900 }],
    ['Debugger.scriptParsed', { scriptId: '2', url: '', length: 12 }]
  ] });
  assert.equal(result.scripts.length, 2);
  assert.equal(result.counts.script, 3);
  assert.equal(result.scripts[0].url, 'https://example.test/app.js');
  assert.equal(result.scripts[0].hasSourceMap, true);
  assert.equal(result.scripts[1].url, '[inline script]');
  assert.equal(result.scripts[1].hasSourceMap, false);
});

test('a domain that cannot be enabled is reported as failed rather than as empty data', async () => {
  const harness = setup({ fail: { 'Performance.enable': 'Not supported' } });
  const result = await run(harness, { requested: ['console', 'metrics'], events: [
    ['Log.entryAdded', { entry: { level: 'info', text: 'still captured' } }]
  ] });
  assert.equal(result.status, 'success');
  assert.equal(result.domains.console, 'enabled');
  assert.equal(result.domains.metrics, 'failed: Not supported');
  assert.equal(result.partial, true);
  assert.equal(result.partialReasons.some(reason => reason.startsWith('domains_not_enabled')), true);
  assert.equal(result.metrics, null);
  assert.equal(result.messages.length, 1);
});

test('when no domain can be enabled the call fails without fabricating observations', async () => {
  const harness = setup({ fail: { 'Runtime.enable': 'Debugger already attached', 'Network.enable': 'Debugger already attached' } });
  const result = await run(harness, { requested: ['console', 'network'], events: [] });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'no_capture_domain_enabled');
  assert.equal(result.retryable, true);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.network, []);
  assert.match(result.recommendedNextAction, /browser_health/);
});

test('a navigation during the window is reported instead of being merged into one page view', async () => {
  const harness = setup();
  const result = await run(harness, { requested: ['console'], afterUrl: 'pending:https://example.test/b' });
  assert.equal(result.targetChanged, true);
  assert.ok(result.partialReasons.includes('target_url_changed_during_window'));
  assert.equal(result.partial, true);
});

test('an unreadable target url is explicit and the listener is still released', async () => {
  const harness = setup();
  const result = await run(harness, { requested: ['console'], readUrl: async () => { throw new Error('tab closed'); } });
  assert.equal(result.targetChanged, false);
  assert.ok(result.partialReasons.includes('target_url_unreadable'));
  assert.equal(harness.listeners.size, 0);
});

test('debugger events from another tab are never attributed to the observed tab', async () => {
  const harness = setup();
  const seen = [];
  const off = createTabSubscription(harness.api, TAB)(method => seen.push(method));
  harness.emit({ tabId: TAB + 1 }, 'Runtime.consoleAPICalled');
  harness.emit({ tabId: TAB }, 'Log.entryAdded');
  harness.emit(undefined, 'Log.entryAdded');
  assert.deepEqual(seen, ['Log.entryAdded']);
  off();
  assert.equal(harness.listeners.size, 0);
  harness.emit({ tabId: TAB }, 'Log.entryAdded');
  assert.equal(seen.length, 1);
});

test('an unsupported domain is rejected before any subscription or CDP call', async () => {
  let subscribed = 0;
  await assert.rejects(captureDevtools({
    tabId: TAB, expectedUrl: URL_A, requested: ['cookies'],
    send: async () => { throw new Error('must not send'); },
    subscribe: () => { subscribed++; return () => {}; },
    readUrl: async () => URL_A
  }), /Unsupported capture domain: cookies/);
  assert.equal(subscribed, 0);
});

test('duration and event budgets are clamped to the documented maxima', async () => {
  const harness = setup();
  const result = await run(harness, { requested: ['console'], durationMs: 999999, maxEvents: 9999 });
  assert.equal(result.window.requestedMs, 5000);
  assert.equal(result.limits.maxEvents, 200);
});

test('resource urls are reduced to origin and path without secrets', () => {
  assert.equal(safeResourceUrl('https://user:pw@example.test/a/b?x=1#y'), 'https://example.test/a/b');
  assert.equal(safeResourceUrl('data:text/plain,secret'), '[inline resource]');
  assert.equal(safeResourceUrl('blob:https://example.test/uuid'), '[inline resource]');
  assert.equal(safeResourceUrl('chrome-extension://abcdef/page.html'), 'chrome-extension://abcdef/page.html');
  assert.equal(safeResourceUrl('about:blank'), '[other scheme]');
  assert.equal(safeResourceUrl('not a url'), '[unparsed url]');
});

test('recorder keeps arrival order for messages and does not invent metrics', () => {
  const recorder = createRecorder({ maxEvents: 10 });
  recorder.handle('Log.entryAdded', { entry: { level: 'info', text: 'first' } });
  recorder.handle('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'second' }] });
  recorder.setMetrics(null);
  const snapshot = recorder.flush();
  assert.deepEqual(snapshot.messages.map(entry => entry.kind), ['log', 'console']);
  assert.equal(snapshot.metrics, null);
  assert.equal(snapshot.truncated, false);
});

test('array schema fields are validated instead of being forwarded unchecked', () => {
  assert.throws(() => validateCall('browser_devtools_capture', { tabId: 1, domains: 'console' }), /Invalid domains/);
  assert.throws(() => validateCall('browser_devtools_capture', { tabId: 1, domains: ['cookies'] }), /Invalid domains/);
  assert.throws(() => validateCall('browser_devtools_capture', { tabId: 1, domains: [] }), /Invalid domains/);
  assert.throws(() => validateCall('browser_devtools_capture', { tabId: 1, domains: ['console', 'network', 'scripts', 'metrics', 'console'] }), /Invalid domains/);
  assert.equal(validateCall('browser_devtools_capture', { tabId: 1, domains: ['console'] }).name, 'browser_devtools_capture');
  assert.equal(validateCall('browser_devtools_capture', { tabId: 1 }).name, 'browser_devtools_capture');
});
