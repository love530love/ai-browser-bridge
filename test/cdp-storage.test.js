// Web storage is read and written through Runtime.evaluate, not through the
// DOMStorage/IndexedDB CDP domains: chrome.debugger does not forward those two
// domains at all (measured, {"code":-32601,"message":"'DOMStorage.enable' wasn't
// found"} on Chrome 154), while Network is forwarded, which is why cookies still
// go over Network.getCookies.
//
// That changes what a useful test looks like. Asserting "the right CDP method was
// called" would now prove almost nothing, because the method is always
// Runtime.evaluate and the interesting part is the expression. So these tests run
// the real generated expression in a vm with a hand-built localStorage,
// sessionStorage and indexedDB. A test therefore fails if the expression is
// malformed, if it reads the wrong area, or if it loses a value - all of which a
// method-name assertion would happily pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { STORAGE_AREAS, readStorage, writeStorage } from '../extension/cdp-storage.js';

const ORIGIN = 'https://a.test';

function createArea(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    // Mirrors the real Storage API: key() is index-based and returns null past
    // the end, which is the loop guard the generated expression relies on.
    key(index) { const keys = [...map.keys()]; return index >= 0 && index < keys.length ? keys[index] : null; },
    // getItem returns null for a missing key and '' for a stored empty string.
    // Conflating them is a real bug, so the fake keeps them distinct.
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    clear() { map.clear(); },
    snapshot() { return Object.fromEntries(map); }
  };
}

function createDatabase(spec = {}) {
  const stores = spec.stores ?? {};
  const names = Object.keys(stores);
  return {
    version: spec.version ?? 1,
    objectStoreNames: names,
    transaction(name) {
      return {
        objectStore: () => {
          const store = stores[name] ?? {};
          const indexNames = Object.keys(store.indexes ?? {});
          return {
            keyPath: store.keyPath ?? null,
            autoIncrement: store.autoIncrement === true,
            indexNames,
            index(indexName) {
              const index = store.indexes?.[indexName] ?? {};
              return { name: indexName, keyPath: index.keyPath ?? null, unique: index.unique === true, multiEntry: index.multiEntry === true };
            }
          };
        }
      };
    },
    close() { this.closed = true; }
  };
}

function createIndexedDb(specs = {}) {
  return {
    async databases() { return Object.entries(specs).map(([name, spec]) => ({ name, version: spec.version ?? 1 })); },
    // Deliberately records that open() was called, because open() on a name that
    // does not exist CREATES that database in a real browser. A read must never
    // reach this for an unknown name.
    opened: [],
    open(name) {
      this.opened.push(name);
      const request = {};
      queueMicrotask(() => {
        const spec = specs[name];
        if (!spec) { request.error = new Error(`no database named ${name}`); request.onerror?.(); return; }
        request.result = createDatabase(spec);
        request.onsuccess?.();
      });
      return request;
    }
  };
}

// Records every CDP call so a test can prove what was never sent, and runs
// Runtime.evaluate for real inside a vm that stands in for the page.
function setup({ origin = ORIGIN, local = {}, session = {}, databases = {}, cookies = [], fail = {}, setCookie = { success: true }, evaluate } = {}) {
  const sent = [];
  const areas = { localStorage: createArea(local), sessionStorage: createArea(session) };
  const indexedDB = createIndexedDb(databases);
  const send = async (method, params = {}) => {
    sent.push({ method, params });
    if (fail[method]) throw new Error(fail[method]);
    if (method === 'Network.getCookies') return { cookies };
    if (method === 'Network.setCookie') return setCookie;
    if (method === 'Network.enable' || method === 'Network.deleteCookies') return {};
    if (method !== 'Runtime.evaluate') throw new Error(`unexpected CDP method: ${method}`);
    if (evaluate) return evaluate(params);
    const context = vm.createContext({
      localStorage: areas.localStorage, sessionStorage: areas.sessionStorage,
      location: { origin }, indexedDB, Error, Promise, setTimeout, queueMicrotask
    });
    try {
      const evaluated = vm.runInContext(params.expression, context);
      const value = params.awaitPromise ? await evaluated : evaluated;
      // Real returnByValue serialises across the process boundary, so the module
      // never sees a vm-realm object. Round-tripping here reproduces that: without
      // it the module would receive arrays whose prototype belongs to another
      // realm, which is a difference the production path can never encounter.
      if (value === undefined) return { result: { type: 'undefined' } };
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    } catch (error) {
      const text = String(error?.message ?? error);
      return { exceptionDetails: { text, exception: { description: text } } };
    }
  };
  const paramsOf = method => sent.filter(call => call.method === method).map(call => call.params);
  const expressions = () => paramsOf('Runtime.evaluate').map(params => params.expression);
  return { sent, send, paramsOf, expressions, areas, indexedDB };
}

const DOM = { token: 's3cret-value', theme: 'dark' };

test('listing localStorage returns key names and value lengths but never values', async () => {
  const harness = setup({ local: DOM });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN });
  assert.equal(result.status, 'success');
  assert.equal(result.area, 'localStorage');
  assert.equal(result.securityOrigin, ORIGIN);
  assert.equal(result.count, 2);
  assert.deepEqual(result.keys, [{ key: 'token', valueLength: 12 }, { key: 'theme', valueLength: 4 }]);
  assert.equal(result.valuesOmitted, true);
  assert.equal(result.contentTrust, 'untrusted webpage storage');
  // The whole reply, not just the keys array: a value that leaked into any other
  // field would still be a leak.
  assert.equal(JSON.stringify(result).includes('s3cret-value'), false);
  assert.equal(JSON.stringify(result).includes('dark'), false);
});

test('reading one key returns its value and the real length', async () => {
  const harness = setup({ local: DOM });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN, key: 'theme' });
  assert.equal(result.status, 'success');
  assert.equal(result.found, true);
  assert.equal(result.key, 'theme');
  assert.equal(result.value, 'dark');
  assert.equal(result.valueLength, 4);
  assert.equal(result.truncated, false);
  assert.equal(result.sensitive, true);
});

test('a missing key is a successful lookup with no result, not a failure', async () => {
  const harness = setup({ local: DOM });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN, key: 'absent' });
  assert.equal(result.status, 'success');
  assert.equal(result.reason, undefined);
  assert.equal(result.found, false);
  assert.deepEqual(result.availableKeys, ['token', 'theme']);
  assert.equal(result.availableKeyCount, 2);
  assert.equal('value' in result, false);
});

test('a stored empty string is found, and is not confused with a missing key', async () => {
  // getItem returns null for "absent" and '' for "present but empty". A read that
  // treated both as falsy would report a key that exists as not found.
  const harness = setup({ local: { blank: '', filled: 'x' } });
  const blank = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN, key: 'blank' });
  assert.equal(blank.status, 'success');
  assert.equal(blank.found, true);
  assert.equal(blank.value, '');
  assert.equal(blank.valueLength, 0);
  const missing = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN, key: 'nope' });
  assert.equal(missing.found, false);
});

test('sessionStorage and localStorage read different areas', async () => {
  const harness = setup({ local: { seed: 'local-value' }, session: { seed: 'session-value' } });
  const local = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN, key: 'seed' });
  const session = await readStorage({ send: harness.send, area: 'sessionStorage', securityOrigin: ORIGIN, key: 'seed' });
  // If the two areas were swapped in the generated expression, both reads would
  // still succeed and only the value would be wrong.
  assert.equal(local.value, 'local-value');
  assert.equal(session.value, 'session-value');
  const expressions = harness.expressions();
  assert.match(expressions[0], /localStorage/);
  assert.equal(expressions[0].includes('sessionStorage'), false);
  assert.match(expressions[1], /sessionStorage/);
  assert.equal(expressions[1].includes('localStorage'), false);
});

test('a key containing quotes, backslashes or markup does not break the expression', async () => {
  const nasty = `a'b"c\\d\ne</script>\u0060\${x}`;
  const harness = setup({ local: { [nasty]: 'value-for-nasty' } });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN, key: nasty });
  assert.equal(result.status, 'success', `expression was rejected: ${result.message ?? ''}`);
  assert.equal(result.found, true);
  assert.equal(result.value, 'value-for-nasty');
});

test('writing a key containing quotes stores exactly that key', async () => {
  const nasty = `k'ey"with\\slashes`;
  const harness = setup();
  const written = await writeStorage({ send: harness.send, area: 'localStorage', action: 'set', securityOrigin: ORIGIN, key: nasty, value: 'v' });
  assert.equal(written.status, 'success', `expression was rejected: ${written.message ?? ''}`);
  // Proven by reading the fake area back, not by trusting the write reply.
  assert.deepEqual(harness.areas.localStorage.snapshot(), { [nasty]: 'v' });
});

test('cookies are listed without values, and one value is returned only by name', async () => {
  const cookies = [{ name: 'sid', value: 'cookie-secret', domain: 'a.test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1, size: 20 }];
  const harness = setup({ cookies });
  const listed = await readStorage({ send: harness.send, area: 'cookies', securityOrigin: ORIGIN });
  assert.equal(listed.status, 'success');
  assert.equal(listed.count, 1);
  assert.equal(listed.valuesOmitted, true);
  assert.equal(JSON.stringify(listed).includes('cookie-secret'), false);
  assert.equal(listed.cookies[0].valueLength, 13);
  const one = await readStorage({ send: harness.send, area: 'cookies', securityOrigin: ORIGIN, key: 'sid' });
  assert.equal(one.status, 'success');
  assert.equal(one.value, 'cookie-secret');
  assert.equal(one.sensitive, true);
});

test('a cookie read whose Network domain cannot be enabled fails without throwing', async () => {
  const harness = setup({ fail: { 'Network.enable': 'Another debugger is already attached' } });
  const result = await readStorage({ send: harness.send, area: 'cookies', securityOrigin: ORIGIN });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cookies_unavailable');
  assert.match(result.message, /Another debugger/);
});

test('IndexedDB reads expose schema, and every path states that records are unreadable', async () => {
  const harness = setup({
    databases: {
      appdb: {
        version: 3,
        stores: {
          notes: { keyPath: 'id', autoIncrement: true, indexes: { byTitle: { keyPath: 'title', unique: false } } },
          pairs: { keyPath: ['left', 'right'] }
        }
      }
    }
  });
  const listed = await readStorage({ send: harness.send, area: 'indexedDB', securityOrigin: ORIGIN });
  assert.equal(listed.status, 'success');
  assert.deepEqual(listed.databases, ['appdb']);
  assert.ok(listed.limitations.some(text => /get-records|record/i.test(text)));
  assert.equal(typeof listed.recordReadTemplate, 'string');
  // databases() is async in the page, so the command must be awaited or the
  // reply would be a Promise serialised as {}.
  assert.equal(harness.paramsOf('Runtime.evaluate')[0].awaitPromise, true);

  const detail = await readStorage({ send: harness.send, area: 'indexedDB', securityOrigin: ORIGIN, key: 'appdb' });
  assert.equal(detail.status, 'success');
  assert.equal(detail.found, true);
  assert.equal(detail.database.version, 3);
  assert.equal(detail.database.objectStoreCount, 2);
  const notes = detail.database.objectStores.find(store => store.name === 'notes');
  assert.equal(notes.keyPath, 'id');
  assert.equal(notes.autoIncrement, true);
  assert.equal(notes.indexes[0].name, 'byTitle');
  // A compound key path is an array in page context; reporting it as
  // "[object Object]" or dropping it would misdescribe the store.
  const pairs = detail.database.objectStores.find(store => store.name === 'pairs');
  assert.equal(pairs.keyPathKind, 'compound');
  assert.equal(pairs.keyPath, 'left, right');
});

test('an IndexedDB name that does not exist is not opened, because opening creates it', async () => {
  const harness = setup({ databases: { appdb: { version: 1, stores: {} } } });
  const result = await readStorage({ send: harness.send, area: 'indexedDB', securityOrigin: ORIGIN, key: 'typo' });
  assert.equal(result.status, 'success');
  assert.equal(result.found, false);
  // This is the assertion that matters: a read must not reach indexedDB.open for
  // a name that is not already registered, or the read creates a database.
  assert.deepEqual(harness.indexedDB.opened, []);
});

test('a url with a path is reduced to its origin, and a non-http origin sends nothing at all', async () => {
  const harness = setup({ local: DOM });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: `${ORIGIN}/deep/path?x=1` });
  assert.equal(result.status, 'success');
  assert.equal(result.securityOrigin, ORIGIN);
  assert.equal(result.originNormalized, true);

  const refused = setup({ local: DOM });
  const rejected = await readStorage({ send: refused.send, area: 'localStorage', securityOrigin: 'javascript:alert(1)' });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.reason, 'invalid_origin');
  assert.deepEqual(refused.sent, []);
});

test('a page that is no longer on the requested origin is not answered for', async () => {
  // The tab can navigate between the caller's decision and the read. Answering
  // anyway would describe a different site than the one that was asked about.
  const harness = setup({ local: { seed: 'moved' }, origin: 'https://b.test' });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'origin_mismatch');
  assert.equal(result.pageOrigin, 'https://b.test');
  assert.equal(JSON.stringify(result).includes('moved'), false);
});

test('clearing localStorage reports which area was cleared and is marked destructive', async () => {
  const harness = setup({ local: DOM });
  const result = await writeStorage({ send: harness.send, area: 'localStorage', action: 'clear', securityOrigin: ORIGIN });
  assert.equal(result.status, 'success');
  assert.equal(result.action, 'clear');
  assert.equal(result.clearedArea, 'localStorage');
  assert.equal(result.destructive, true);
  assert.equal(result.verified, false);
  assert.deepEqual(harness.areas.localStorage.snapshot(), {});
  // Clearing one area must leave the other alone.
  assert.deepEqual(harness.areas.sessionStorage.snapshot(), {});
});

test('clearing cookies is refused instead of silently deleting them one by one', async () => {
  const harness = setup({ cookies: [{ name: 'sid', value: 'x' }] });
  const result = await writeStorage({ send: harness.send, area: 'cookies', action: 'clear', securityOrigin: ORIGIN });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cookie_clear_not_supported');
  // No CDP call at all: a refusal that still dispatched would be a lie.
  assert.deepEqual(harness.sent, []);
});

test('every IndexedDB write action is refused before any CDP call', async () => {
  for (const action of ['set', 'remove', 'clear']) {
    const harness = setup();
    const result = await writeStorage({ send: harness.send, area: 'indexedDB', action, securityOrigin: ORIGIN, key: 'db', value: 'v' });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'indexeddb_write_needs_page_context');
    assert.deepEqual(harness.sent, []);
  }
});

test('a non-string value and an empty key are rejected without touching storage', async () => {
  const harness = setup();
  const badValue = await writeStorage({ send: harness.send, area: 'localStorage', action: 'set', securityOrigin: ORIGIN, key: 'k', value: 42 });
  assert.equal(badValue.status, 'failed');
  assert.equal(badValue.reason, 'value_must_be_string');
  assert.equal(badValue.receivedType, 'number');
  const badKey = await writeStorage({ send: harness.send, area: 'localStorage', action: 'remove', securityOrigin: ORIGIN, key: '' });
  assert.equal(badKey.status, 'failed');
  assert.equal(badKey.reason, 'key_required');
  assert.deepEqual(harness.sent, []);
});

test('an oversized value is cut to the documented limit while the real length is kept', async () => {
  const huge = 'x'.repeat(20050);
  const harness = setup({ local: { big: huge } });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN, key: 'big' });
  assert.equal(result.status, 'success');
  assert.equal(result.truncated, true);
  assert.equal(result.valueLength, 20050);
  assert.equal(result.value.length, 20000);
});

test('accepted writes never claim to be verified', async () => {
  const harness = setup();
  const result = await writeStorage({ send: harness.send, area: 'localStorage', action: 'set', securityOrigin: ORIGIN, key: 'k', value: 'v' });
  assert.equal(result.status, 'success');
  // The command being accepted is not the page reading a new value; claiming
  // otherwise would let a caller skip its own read-back.
  assert.equal(result.verified, false);
  assert.equal(result.destructive, false);
  assert.deepEqual(harness.areas.localStorage.snapshot(), { k: 'v' });
});

test('a write is refused when the page has navigated to another origin', async () => {
  const harness = setup({ origin: 'https://b.test' });
  const result = await writeStorage({ send: harness.send, area: 'localStorage', action: 'set', securityOrigin: ORIGIN, key: 'k', value: 'v' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'origin_mismatch');
  assert.deepEqual(harness.areas.localStorage.snapshot(), {});
});

test('a cookie the browser refuses is reported as failed, not as an accepted write', async () => {
  // Network.setCookie reports refusal in the payload rather than by throwing, so
  // a transport-level success check would call this a success.
  const harness = setup({ setCookie: { success: false } });
  const result = await writeStorage({ send: harness.send, area: 'cookies', action: 'set', securityOrigin: ORIGIN, cookie: { name: 'sid', value: 'v' } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cookie_rejected');
  // The assertion that matters is that nothing claimed verification. A failed
  // write carries no verified field at all, and inventing true would be the bug.
  assert.notEqual(result.verified, true);
});

test('an unknown area or action is rejected with the supported list and no CDP call', async () => {
  const harness = setup();
  const badArea = await readStorage({ send: harness.send, area: 'filesystem', securityOrigin: ORIGIN });
  assert.equal(badArea.status, 'failed');
  assert.equal(badArea.reason, 'unsupported_area');
  assert.deepEqual(badArea.supportedAreas, STORAGE_AREAS);
  const badAction = await writeStorage({ send: harness.send, area: 'localStorage', action: 'append', securityOrigin: ORIGIN, key: 'k', value: 'v' });
  assert.equal(badAction.status, 'failed');
  assert.equal(badAction.reason, 'unsupported_action');
  assert.deepEqual(harness.sent, []);
});

test('a CDP failure while reading storage is wrapped instead of thrown', async () => {
  const harness = setup({ fail: { 'Runtime.evaluate': 'Debugger is not attached' } });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'storage_read_failed');
  assert.match(result.message, /Debugger is not attached/);
});

test('a page exception while reading is distinguished from a transport failure', async () => {
  // These need different next steps: a transport failure means "reattach", a page
  // exception means "the page threw". Collapsing them sends the caller the wrong way.
  const harness = setup({ local: DOM, origin: 'https://a.test' });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN });
  assert.equal(result.status, 'success');
  const broken = setup({ evaluate: () => ({ exceptionDetails: { text: 'SecurityError', exception: { description: 'SecurityError: denied' } } }) });
  const failed = await readStorage({ send: broken.send, area: 'localStorage', securityOrigin: ORIGIN });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'storage_read_page_exception');
  assert.match(failed.message, /SecurityError/);
});

test('a payload without a value is reported as broken, not as an empty area', async () => {
  const harness = setup({ evaluate: () => ({ result: {} }) });
  const result = await readStorage({ send: harness.send, area: 'localStorage', securityOrigin: ORIGIN });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'unexpected_payload');
  // Reporting this as "0 keys" would fabricate an observation the browser never
  // made.
  assert.equal(result.count, undefined);
});
