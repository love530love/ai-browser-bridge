// Session reuse and tab ownership are decisions about someone else's browser.
// Both are pure functions so the rules can be pinned without a running Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseKey, samePage, visibleTab, createTabOwnership, describeTab, internalUrlLabel, isInternalPage } from '../extension/tab-identity.js';

test('a fragment and a trailing slash do not make a different page', () => {
  assert.equal(reuseKey('https://a.example/x'), reuseKey('https://a.example/x/'));
  assert.equal(reuseKey('https://a.example/x'), reuseKey('https://a.example/x#section'));
  assert.equal(reuseKey('https://a.example/x?a=1'), reuseKey('https://a.example/x?a=1#top'));
  assert.equal(reuseKey('https://a.example'), reuseKey('https://a.example/'));
  assert.ok(samePage('https://a.example/list/', 'https://a.example/list#row-3'));
});

test('a different query string is a different page, because it can be different content', () => {
  assert.notEqual(reuseKey('https://a.example/item?id=1'), reuseKey('https://a.example/item?id=2'));
  assert.notEqual(reuseKey('https://a.example/search?q=a'), reuseKey('https://a.example/search?q=b'));
  // Reordered parameters are conservatively treated as different: reusing the
  // wrong tab is worse than opening one more.
  assert.notEqual(reuseKey('https://a.example/s?a=1&b=2'), reuseKey('https://a.example/s?b=2&a=1'));
});

test('different paths, hosts and schemes never collapse', () => {
  assert.notEqual(reuseKey('https://a.example/x'), reuseKey('https://a.example/y'));
  assert.notEqual(reuseKey('https://a.example/x'), reuseKey('https://b.example/x'));
  assert.notEqual(reuseKey('https://a.example/x'), reuseKey('http://a.example/x'));
});

test('non-HTTP(S), credentialed and malformed URLs are never reusable', () => {
  for (const raw of ['chrome://settings', 'file:///C:/x.txt', 'devtools://x/y', 'about:blank', '', null, undefined, 'not a url', 'https://user:pw@a.example/x']) {
    assert.equal(reuseKey(raw), null, `expected null for ${String(raw)}`);
    assert.equal(samePage(raw, 'https://a.example/x'), false);
  }
});

test('incognito tabs stay out of the default view', () => {
  assert.equal(visibleTab({ id: 1, incognito: false }), true);
  assert.equal(visibleTab({ id: 2, incognito: true }), false);
  assert.equal(visibleTab({ id: 2, incognito: true }, { includeIncognito: true }), true);
  assert.equal(visibleTab(null), false);
});

test('ownership survives a storage round trip and forgets closed tabs', async () => {
  const store = new Map();
  const storage = {
    async get(key) { return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, value); }
  };
  const owned = createTabOwnership(storage);
  await owned.mark(7);
  await owned.mark(9);
  assert.deepEqual([...(await owned.ids())].sort((a, b) => a - b), [7, 9]);
  assert.equal(await owned.owns(7), true);
  assert.equal(await owned.owns(8), false);
  await owned.forget(7);
  assert.equal(await owned.owns(7), false);
  assert.deepEqual(store.get('bridgeCreatedTabs'), [9]);
});

test('a second worker instance sees the same ownership after suspension', async () => {
  const store = new Map();
  const storage = {
    async get(key) { return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, value); }
  };
  await createTabOwnership(storage).mark(42);
  // A suspended service worker loses memory but not storage. Losing ownership
  // here would mean refusing to close a tab the bridge itself opened.
  assert.equal(await createTabOwnership(storage).owns(42), true);
});

test('a broken storage backend still tracks ownership in memory instead of throwing', async () => {
  const owned = createTabOwnership({ async get() { throw new Error('storage unavailable'); }, async set() { throw new Error('storage unavailable'); } });
  await owned.mark(5);
  assert.equal(await owned.owns(5), true);
  await owned.forget(5);
  assert.equal(await owned.owns(5), false);
  // No storage at all is a supported shape, not a crash.
  const bare = createTabOwnership(undefined);
  await bare.mark(6);
  assert.equal(await bare.owns(6), true);
});

test('invalid tab ids are ignored rather than stored', async () => {
  const owned = createTabOwnership(undefined);
  await owned.mark(Number.NaN);
  await owned.mark('7');
  await owned.mark(-1);
  assert.equal((await owned.ids()).size, 0);
});

test('a tab the bridge cannot read is described, not hidden', () => {
  const internal = { id: 5, url: 'chrome://newtab/', title: '新标签页', active: true, windowId: 1, incognito: false };
  const row = describeTab(internal, { owned: false, allowed: false, restrictedReason: 'non_http' });
  // It exists, so it is listed; its content is not this agent's business.
  assert.equal(row.id, 5);
  assert.equal(row.restricted, true);
  assert.equal(row.restrictedReason, 'non_http');
  assert.equal(row.title, null);
  assert.equal(row.url, 'chrome://newtab/');
  assert.equal(row.active, true);
  // A disallowed web origin is different: its URL *is* the content.
  const foreign = describeTab({ id: 6, url: 'https://bank.example/accounts?q=x', title: 'Bank' }, { allowed: false, restrictedReason: 'origin_not_allowed' });
  assert.equal(foreign.url, null);
  assert.equal(foreign.title, null);
  assert.equal(foreign.restricted, true);
  // An allowed tab keeps the fields every existing caller reads.
  const allowed = describeTab({ id: 7, url: 'https://a.example/x', title: 'A', active: false, windowId: 2 }, { owned: true });
  assert.deepEqual(allowed, { id: 7, active: false, windowId: 2, incognito: false, bridgeCreated: true,
    title: 'A', url: 'https://a.example/x', restricted: false });
});

test('an internal page label keeps the scheme and path but not the query', () => {
  assert.equal(internalUrlLabel('chrome://newtab/'), 'chrome://newtab/');
  assert.equal(internalUrlLabel('chrome://settings'), 'chrome://settings/');
  // The query on an internal page can be the same kind of information as its
  // content, and it is not needed to recognise the tab.
  assert.equal(internalUrlLabel('chrome://history/?q=bank'), 'chrome://history/');
  assert.equal(internalUrlLabel('chrome-extension://abc/page.html?a=1#x'), 'chrome-extension://abc/page.html');
  assert.equal(internalUrlLabel('not a url'), null);
  assert.equal(isInternalPage('chrome://newtab/'), true);
  assert.equal(isInternalPage('file:///C:/x.txt'), true);
  assert.equal(isInternalPage('https://a.example/'), false);
  assert.equal(isInternalPage(null), false);
});
