// chrome.webNavigation has no commands, so the capability is the record. What
// these tests pin is what the record is allowed to claim: a chain that names the
// hops it saw and no others, an in-flight navigation that is not confused with a
// failed one, a divergence that is reported rather than smoothed over, and
// bounds that hold so a scrolling single-page app cannot grow the buffer until
// the worker dies.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeEnv() {
  const listeners = new Map();
  const chrome = {
    tabs: { get: async id => ({ id, url: 'https://example.com/final', status: 'complete' }) },
    webNavigation: {}
  };
  for (const name of ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onDOMContentLoaded', 'onErrorOccurred', 'onBeforeRedirect', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onCreatedNavigationTarget']) {
    chrome.webNavigation[name] = {
      addListener: fn => listeners.set(name, fn)
    };
  }
  const emit = (name, payload) => listeners.get(name)?.(payload);
  return { chrome, emit, listeners };
}

async function load() {
  const env = fakeEnv();
  globalThis.chrome = env.chrome;
  const { createNavigationAudit } = await import(`../extension/navigation-audit.js?t=${Math.random()}`);
  let clock = 1000;
  const audit = createNavigationAudit({ now: () => (clock += 10) });
  const installed = audit.install();
  return { audit, env, installed };
}

test('installing registers every tracked event and refuses to register twice', async () => {
  const { audit, installed, env } = await load();
  assert.equal(installed.installed, true);
  assert.equal(installed.events, 9);
  assert.equal(env.listeners.size, 9);
  assert.equal(audit.install().reason, 'already_installed');
});

test('a redirect chain names every hop it observed, in order', async () => {
  const { audit, env } = await load();
  env.emit('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'http://a.test/', transitionType: 'typed' });
  env.emit('onBeforeRedirect', { tabId: 5, frameId: 0, url: 'http://a.test/', redirectUrl: 'https://a.test/' });
  env.emit('onBeforeRedirect', { tabId: 5, frameId: 0, url: 'https://a.test/', redirectUrl: 'https://b.test/landing' });
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://b.test/landing', transitionType: 'server_redirect' });
  env.emit('onCompleted', { tabId: 5, frameId: 0, url: 'https://b.test/landing' });
  const result = await audit.run('browser_navigation', { action: 'chain', tabId: 5 });
  assert.equal(result.status, 'success');
  assert.equal(result.redirects, 2);
  assert.equal(result.finalUrl, 'https://b.test/landing');
  assert.deepEqual(result.chain.map(hop => hop.url), ['http://a.test/', 'https://a.test/', 'https://b.test/landing']);
  assert.equal(result.chain[1].via, 'redirect');
  assert.equal(result.completed, true);
});

test('a redirect Chrome reports only as a commit qualifier is still a redirect', async () => {
  const { audit, env } = await load();
  // Measured on Chrome 156: the http-to-https upgrade emitted no
  // onBeforeRedirect, only transitionQualifiers ["server_redirect"].
  env.emit('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'http://example.com/' });
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://example.com/', transitionType: 'link', transitionQualifiers: ['server_redirect'] });
  env.emit('onCompleted', { tabId: 5, frameId: 0, url: 'https://example.com/' });
  const result = await audit.run('browser_navigation', { action: 'chain', tabId: 5 });
  assert.equal(result.redirects, 0, 'no per-hop event was emitted');
  assert.deepEqual(result.redirectQualifiers, ['server_redirect']);
  assert.equal(result.redirected, true, 'a redirect that produced no hop event must not read as no redirect');
  assert.match(result.note, /redirectQualifiers/);
});

test('two navigations on one tab stay two, even when the second starts where the first ended', async () => {
  const { audit, env } = await load();
  env.emit('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  env.emit('onCompleted', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  env.emit('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  env.emit('onCompleted', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  const latest = await audit.run('browser_navigation', { action: 'chain', tabId: 5 });
  assert.equal(latest.navigations, 2);
  assert.equal(latest.index, 1);
  const first = await audit.run('browser_navigation', { action: 'chain', tabId: 5, index: 0 });
  assert.equal(first.index, 0);
});

test('a navigation that started and never finished is reported as in flight, not as an error', async () => {
  const { audit, env } = await load();
  env.emit('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'https://a.test/leave' });
  const status = await audit.run('browser_navigation', { action: 'status', tabId: 5 });
  assert.equal(status.inFlight, true);
  assert.equal(status.lastError, null);
  assert.equal(status.completed === undefined || status.completed === null, true);
  assert.match(status.note, /beforeunload/);
});

test('a failed navigation keeps the browser error verbatim', async () => {
  const { audit, env } = await load();
  env.emit('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'https://nope.test/' });
  env.emit('onErrorOccurred', { tabId: 5, frameId: 0, url: 'https://nope.test/', error: 'net::ERR_NAME_NOT_RESOLVED' });
  const status = await audit.run('browser_navigation', { action: 'status', tabId: 5 });
  assert.equal(status.lastError.error, 'net::ERR_NAME_NOT_RESOLVED');
  assert.equal(status.inFlight, false);
});

test('a single-page rewrite shows up as divergence rather than as the committed URL', async () => {
  const { audit, env } = await load();
  env.emit('onBeforeNavigate', { tabId: 5, frameId: 0, url: 'https://app.test/' });
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://app.test/' });
  env.emit('onCompleted', { tabId: 5, frameId: 0, url: 'https://app.test/' });
  env.emit('onHistoryStateUpdated', { tabId: 5, frameId: 0, url: 'https://app.test/inbox' });
  const status = await audit.run('browser_navigation', { action: 'status', tabId: 5 });
  assert.equal(status.lastCommittedUrl, 'https://app.test/');
  assert.deepEqual(status.divergence, { committed: 'https://app.test/', browser: 'https://example.com/final' });
  const chain = await audit.run('browser_navigation', { action: 'chain', tabId: 5 });
  assert.equal(chain.historyUpdates, 1);
  assert.match(chain.note, /single-page app/);
});

test('the timeline is bounded per tab and says how much it held back', async () => {
  const { audit, env } = await load();
  for (let index = 0; index < 400; index += 1) {
    env.emit('onHistoryStateUpdated', { tabId: 5, frameId: 0, url: `https://app.test/${index}` });
  }
  const result = await audit.run('browser_navigation', { action: 'timeline', tabId: 5, limit: 10 });
  assert.equal(result.returned, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.available <= 300, `per-tab buffer must stay bounded, held ${result.available}`);
  const last = result.entries[result.entries.length - 1];
  assert.equal(last.url, 'https://app.test/399', 'the newest events must survive the bound');
});

test('a tab that keeps navigating is not evicted by tabs that are merely open', async () => {
  const { audit, env } = await load();
  for (let tabId = 1; tabId <= 45; tabId += 1) {
    env.emit('onCommitted', { tabId, frameId: 0, url: `https://t${tabId}.test/` });
    // Tab 1 keeps working the whole time; the others are touched once.
    if (tabId < 45) env.emit('onCommitted', { tabId: 1, frameId: 0, url: `https://hot.test/${tabId}` });
  }
  const hot = await audit.run('browser_navigation', { action: 'timeline', tabId: 1, limit: 200 });
  assert.ok(hot.available > 1, 'the busy tab must still hold its record');
});

test('clear empties the record without stopping the listeners', async () => {
  const { audit, env } = await load();
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  const cleared = await audit.run('browser_navigation', { action: 'clear', tabId: 5 });
  assert.equal(cleared.removed, 1);
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://b.test/' });
  const after = await audit.run('browser_navigation', { action: 'timeline', tabId: 5 });
  assert.equal(after.returned, 1);
  assert.equal(after.entries[0].url, 'https://b.test/');
});

test('chain needs a tab and an unknown action is refused', async () => {
  const { audit } = await load();
  const noTab = await audit.run('browser_navigation', { action: 'chain' });
  assert.equal(noTab.reason, 'tab_id_required');
  const unknown = await audit.run('browser_navigation', { action: 'teleport' });
  assert.equal(unknown.reason, 'unknown_action');
});

test('an event listener that throws cannot break the audit', async () => {
  const { audit, env } = await load();
  env.emit('onCommitted', { tabId: 5, frameId: 0, url: 'https://a.test/' });
  // A tab id that is not an integer is the shape a malformed payload takes.
  assert.doesNotThrow(() => env.emit('onCommitted', { tabId: null, frameId: 0, url: 'https://bad.test/' }));
  const result = await audit.run('browser_navigation', { action: 'timeline', tabId: 5 });
  assert.equal(result.returned, 1);
});
