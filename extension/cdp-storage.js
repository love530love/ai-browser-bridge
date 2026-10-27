// DevTools "Application" panel equivalent: inspect and edit a site's
// localStorage, sessionStorage, cookies and IndexedDB schema over one CDP
// attachment. No chrome.* API is touched here; every browser interaction goes
// through the injected send(method, params), which returns the CDP payload and
// throws on transport failure.
//
// Two transports, because the CDP domains are not equally reachable. Cookies go
// through Network.getCookies/setCookie/deleteCookies. Web storage and IndexedDB go
// through Runtime.evaluate in the page, because chrome.debugger does not forward
// the DOMStorage or IndexedDB domains at all - measured, not assumed, see the
// comment above areaExpression().
//
// Three rules shape the contract:
//
// 1. Nothing throws. Callers pick their next step from `status`, and a thrown
//    error would discard the area/origin context needed to explain a failure.
// 2. Reads are discovery-first. Listing an area returns key names and value
//    lengths only, so a routine "what is in here?" call cannot turn into a
//    credential dump. A value is returned only when the caller names the key.
// 3. Writes are unverified. A write reports that the command was accepted, not
//    that the page observed the new value; a running page can rewrite storage
//    immediately after. Every accepted write therefore returns verified:false
//    instead of claiming a state we never read back.

export const STORAGE_AREAS = ['localStorage', 'sessionStorage', 'cookies', 'indexedDB'];
export const STORAGE_ACTIONS = ['set', 'remove', 'clear'];

// A single stored value can hold megabytes; a bridge response must stay
// bounded, so long values are cut and the real length is reported separately.
const MAX_VALUE_CHARS = 20000;
const MAX_LIST_ENTRIES = 500;

// The CDP IndexedDB domain has no get-records command: it can describe a
// database but cannot read a row. Records only exist to page-context JS, so the
// read path hands the caller a ready expression instead of pretending to have
// data it cannot fetch.
const INDEXEDDB_LIMITATIONS = [
  'This path exposes schema only. Reading records needs a cursor inside a transaction, which is page-context JavaScript, so no record keys, cursors or values are returned here.',
  'Reading records requires page-context JavaScript (browser_debugger evaluate). recordReadTemplate is a working starting point, not a result.',
  'Only databases belonging to this exact origin are listed; other origins, other tabs and other storage partitions are separate.'
];

// Opening a missing database with indexedDB.open() creates it, which would turn
// a read into a write. The template checks indexedDB.databases() first for that
// reason, and stops with database_not_found instead of creating anything.
const RECORD_READ_TEMPLATE = `(async () => {
  const name = '__DB__', store = '__STORE__';
  const known = (await indexedDB.databases()).map(entry => entry.name);
  if (!known.includes(name)) return { error: 'database_not_found', knownDatabases: known };
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!db.objectStoreNames.contains(store)) return { error: 'object_store_not_found', knownStores: [...db.objectStoreNames] };
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll(null, 50);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return { database: name, store, returnedRows: rows.length, rowsAreCappedAt: 50, rows };
})()`;

const TRUST = 'untrusted webpage storage';

function bounded(value, max = 200) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function failure(reason, message, extra = {}) {
  return { status: 'failed', reason, message, contentTrust: TRUST, ...extra };
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// `*`, empty strings, file: and javascript: URLs are rejected outright: a
// wildcard would read another origin's storage while the response still claimed
// to describe the requested one. A path is accepted but reduced to its origin,
// and that reduction is reported rather than hidden.
export function normalizeOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return { origin: url.origin, normalized: url.origin !== raw.trim(), input: raw.trim() };
}

function originFields(raw) {
  const resolved = normalizeOrigin(raw);
  if (!resolved) return null;
  const fields = { securityOrigin: resolved.origin, originNormalized: resolved.normalized };
  // Say what was dropped so a caller can notice it passed the wrong URL.
  if (resolved.normalized) fields.originInput = bounded(resolved.input, 300);
  return fields;
}

function invalidOrigin(raw, area) {
  return failure('invalid_origin', 'securityOrigin must be an absolute http(s) origin such as https://example.test. Wildcards, empty strings and non-http schemes are rejected because they would silently address a different origin.', {
    area: bounded(area, 40), securityOrigin: null, providedOrigin: bounded(raw, 300),
    recommendedNextAction: 'Pass the origin of the tab under test (for example the origin of the tab URL), not a URL pattern.'
  });
}

function listLimit(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return MAX_LIST_ENTRIES;
  return Math.min(MAX_LIST_ENTRIES, Math.max(1, Math.round(number)));
}

// Storage values are returned as a faithful prefix: no ellipsis is appended, so
// a caller that copies the string never carries a marker that was not stored.
// truncated:true plus valueLength is the only signal that bytes are missing.
function boundedValue(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  return text.length > MAX_VALUE_CHARS
    ? { value: text.slice(0, MAX_VALUE_CHARS), valueLength: text.length, truncated: true }
    : { value: text, valueLength: text.length, truncated: false };
}

// The CDP DOMStorage and IndexedDB domains are NOT reachable through
// chrome.debugger.sendCommand. Measured on Chrome 154, both answer
// {"code":-32601,"message":"'DOMStorage.enable' wasn't found"} and
// {"code":-32601,"message":"'IndexedDB.enable' wasn't found"}. The extension
// debugger API only forwards a subset of CDP domains, and Network is in that
// subset while these two are not - which is why cookie reads through
// Network.getCookies work and every storage read failed.
//
// Web storage is therefore read and written through Runtime.evaluate inside the
// page. That is not a workaround with a worse boundary; it is a tighter one: the
// page's own localStorage IS the storage of the document under test, so there is
// no storageId to get wrong and no way to name a different origin. Every
// expression also returns location.origin so the caller can see the read landed
// on the origin it asked for.
function areaExpression(area) {
  // Derived in one place: isLocalStorage was the single easiest field to invert,
  // and this is its equivalent.
  return area === 'localStorage' ? 'localStorage' : 'sessionStorage';
}

// Runtime.evaluate answers in three distinguishable ways, and collapsing them
// into one failure is what makes a real problem take another round trip to
// diagnose: the command can be rejected (attachment gone), the page can throw,
// or the value can be missing.
async function evaluateInPage(send, expression, { awaitPromise = false } = {}) {
  const payload = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (payload?.exceptionDetails) {
    const details = payload.exceptionDetails;
    return { ok: false, reason: 'page_exception', text: bounded(details.exception?.description ?? details.text ?? 'unknown exception', 300) };
  }
  if (!payload?.result || !Object.hasOwn(payload.result, 'value')) {
    return { ok: false, reason: 'result_missing', text: 'Runtime.evaluate returned no value object; absence is not an empty result.' };
  }
  return { ok: true, value: payload.result.value };
}

function originMismatchFailure(seen, wanted, base) {
  return failure('origin_mismatch', `The page is on ${bounded(seen, 200) ?? 'an unreadable origin'} but ${bounded(wanted, 200) ?? 'another origin'} was requested, so nothing was returned. Storage is read from the live document, and reading it from a different document would answer a question nobody asked.`, {
    ...base,
    pageOrigin: bounded(seen, 200),
    recommendedNextAction: 'The tab probably navigated during the call. Read again.'
  });
}

function keyPathLabel(keyPath) {
  if (typeof keyPath === 'string') return { keyPath: keyPath || null, keyPathKind: keyPath ? 'string' : 'none' };
  // Page context hands back a real array for a compound key path, while the CDP
  // IndexedDB domain wrapped it as { array: [...] }. Both shapes reach here, and
  // stringifying the object instead of unwrapping it would print "[object
  // Object]" as if that were the key path.
  if (Array.isArray(keyPath)) return { keyPath: keyPath.map(String).join(', '), keyPathKind: 'compound' };
  if (Array.isArray(keyPath?.array)) return { keyPath: keyPath.array.map(String).join(', '), keyPathKind: 'compound' };
  if (keyPath === null || keyPath === undefined) return { keyPath: null, keyPathKind: 'none' };
  return { keyPath: null, keyPathKind: 'unknown' };
}

function indexSummary(index) {
  return {
    name: bounded(index?.name, 120),
    ...keyPathLabel(index?.keyPath),
    unique: index?.unique === true,
    multiEntry: index?.multiEntry === true
  };
}

function objectStoreSummary(store) {
  const indexes = Array.isArray(store?.indexes) ? store.indexes : [];
  return {
    name: bounded(store?.name, 120),
    ...keyPathLabel(store?.keyPath),
    autoIncrement: store?.autoIncrement === true,
    indexCount: indexes.length,
    indexes: indexes.map(indexSummary)
  };
}

// One round trip answers both questions: the key list (with lengths only) and,
// when a key was named, that key's value. Splitting it into two evaluates would
// let the area change in between and report a key that is no longer there.
function readAreaExpression(area, key, limit) {
  const wanted = typeof key === 'string' && key ? JSON.stringify(key) : 'null';
  return `(() => {
  const area = ${areaExpression(area)};
  const wanted = ${wanted};
  const entries = [];
  let found = false, value = null, valueLength = 0;
  for (let index = 0; index < area.length; index += 1) {
    const name = area.key(index);
    if (name === null) continue;
    const current = area.getItem(name);
    const length = current === null ? 0 : current.length;
    if (entries.length < ${limit}) entries.push([name, length]);
    if (wanted !== null && name === wanted) {
      found = true;
      valueLength = length;
      value = current === null ? null : current.slice(0, ${MAX_VALUE_CHARS + 1});
    }
  }
  return { origin: location.origin, total: area.length, entries, found, value, valueLength };
})()`;
}

async function readDomStorage({ send, area, securityOrigin, key, limit, base }) {
  const outcome = await evaluateInPage(send, readAreaExpression(area, key, limit));
  if (!outcome.ok) {
    return failure(outcome.reason === 'page_exception' ? 'storage_read_page_exception' : 'unexpected_payload',
      `Reading ${area} in the page failed: ${outcome.text}`, {
        ...base, recommendedNextAction: 'Check that the tab is still attached and on the expected page, then read again.'
      });
  }
  const observed = outcome.value;
  if (!observed || typeof observed !== 'object' || !Array.isArray(observed.entries)) {
    return failure('unexpected_payload', `Reading ${area} returned no entries array; absence is not an empty area.`, base);
  }
  // The page reports its own origin, so a navigation between the caller's
  // decision and this read cannot silently answer for a different site.
  if (typeof observed.origin === 'string' && observed.origin !== securityOrigin) {
    return originMismatchFailure(observed.origin, securityOrigin, base);
  }
  const entries = observed.entries
    .filter(entry => Array.isArray(entry) && entry.length >= 2)
    .map(entry => ({ key: String(entry[0]), valueLength: Number(entry[1]) || 0 }));
  const total = count(observed.total) ?? entries.length;

  if (typeof key === 'string' && key) {
    if (observed.found !== true) {
      // An absent key is a successful lookup with no result. Reporting it as a
      // failure would push callers into retry loops over a correct answer.
      return {
        status: 'success', ...base, key, found: false,
        availableKeys: entries.map(entry => entry.key),
        availableKeyCount: total,
        emptyMeaning: 'The key is not present in this area for this origin right now; it may have been removed or written by another tab since the page loaded.',
        contentTrust: TRUST
      };
    }
    const text = typeof observed.value === 'string' ? observed.value : '';
    const realLength = count(observed.valueLength) ?? text.length;
    return {
      status: 'success', ...base, key, found: true, sensitive: true,
      value: text.slice(0, MAX_VALUE_CHARS),
      valueLength: realLength,
      truncated: realLength > MAX_VALUE_CHARS,
      contentTrust: TRUST
    };
  }

  return {
    status: 'success', ...base, count: total,
    keys: entries.slice(0, limit), keysTruncated: total > entries.slice(0, limit).length, limit,
    valuesOmitted: true,
    emptyMeaning: total ? null : 'No keys are currently stored in this area for this origin; this is an empty area, not a failed read.',
    limitations: ['Listing returns key names and value lengths only. Read a value by passing its key explicitly.'],
    contentTrust: TRUST
  };
}

function cookieSummary(cookie) {
  const expires = count(cookie?.expires);
  return {
    name: bounded(cookie?.name, 200),
    domain: bounded(cookie?.domain, 200),
    path: bounded(cookie?.path, 300),
    secure: cookie?.secure === true,
    httpOnly: cookie?.httpOnly === true,
    sameSite: bounded(cookie?.sameSite, 20),
    session: expires === null ? null : expires <= 0,
    expires,
    size: count(cookie?.size),
    valueLength: String(cookie?.value ?? '').length
  };
}

async function readCookies({ send, securityOrigin, key, limit, base }) {
  try {
    await send('Network.enable');
  } catch (error) {
    // The usual cause is another debugger already attached to the tab. The
    // caller can still read DOM storage, so this is a scoped failure.
    return failure('cookies_unavailable', `Network domain could not be enabled: ${bounded(error?.message ?? error, 200) ?? 'unknown error'}`, {
      ...base, recommendedNextAction: 'Another debugger may own this tab. Detach it or read cookies from the page context instead.'
    });
  }
  let payload;
  try {
    payload = await send('Network.getCookies', { urls: [securityOrigin] });
  } catch (error) {
    return failure('cookies_read_failed', `Network.getCookies failed: ${bounded(error?.message ?? error, 200) ?? 'unknown error'}`, base);
  }
  if (!Array.isArray(payload?.cookies)) {
    return failure('unexpected_payload', 'Network.getCookies returned no cookies array; absence is not an empty cookie jar.', base);
  }
  const cookies = payload.cookies;

  if (typeof key === 'string' && key) {
    const matches = cookies.filter(cookie => cookie?.name === key);
    if (!matches.length) {
      return {
        status: 'success', ...base, key, found: false,
        availableNames: cookies.slice(0, limit).map(cookie => bounded(cookie?.name, 200)),
        availableCookieCount: cookies.length,
        emptyMeaning: 'No cookie with this name is visible to this origin and URL right now; httpOnly cookies are still included here, so absence means absent from the jar, not hidden.',
        contentTrust: TRUST
      };
    }
    const chosen = matches[0];
    return {
      status: 'success', ...base, key, found: true, sensitive: true,
      matchedCount: matches.length,
      ...cookieSummary(chosen),
      ...boundedValue(chosen.value ?? ''),
      contentTrust: TRUST
    };
  }

  const listed = cookies.slice(0, limit).map(cookieSummary);
  return {
    status: 'success', ...base, count: cookies.length,
    cookies: listed, cookiesTruncated: cookies.length > listed.length, limit,
    valuesOmitted: true,
    emptyMeaning: cookies.length ? null : 'No cookie is visible to this origin and URL; this is an empty jar for this origin, not a failed read.',
    limitations: [
      'Cookie values are withheld while listing; pass the cookie name to read one value.',
      'Only cookies matching this origin are returned. Other subdomains, other ports of the same host and partitioned (CHIPS) cookies appear as the browser reports them.'
    ],
    contentTrust: TRUST
  };
}

// indexedDB.databases() is async, so these need awaitPromise. The single-database
// expression checks the name list BEFORE opening: indexedDB.open() on a name that
// does not exist CREATES that database, so a read would silently become a write.
// The list is not a convenience here, it is what keeps this read-only.
function listDatabasesExpression() {
  return `(async () => {
  if (typeof indexedDB.databases !== 'function') return { supported: false, origin: location.origin, databases: [] };
  const list = await indexedDB.databases();
  return { supported: true, origin: location.origin, databases: list.map(entry => ({ name: entry.name === undefined ? null : entry.name, version: typeof entry.version === 'number' ? entry.version : null })) };
})()`;
}

function readDatabaseExpression(databaseName) {
  return `(async () => {
  const name = ${JSON.stringify(databaseName)};
  const list = await indexedDB.databases();
  const known = list.map(entry => entry.name);
  if (!known.includes(name)) return { origin: location.origin, found: false, databases: known };
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('open failed'));
    request.onblocked = () => reject(new Error('open blocked by another connection'));
  });
  const objectStores = [];
  for (const storeName of [...db.objectStoreNames]) {
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    const indexes = [];
    for (const indexName of [...store.indexNames]) {
      const index = store.index(indexName);
      indexes.push({ name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry });
    }
    objectStores.push({ name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes });
  }
  const version = db.version;
  db.close();
  return { origin: location.origin, found: true, name, version, objectStores };
})()`;
}

async function readIndexedDb({ send, securityOrigin, key, limit, base }) {
  const outcome = await evaluateInPage(send, listDatabasesExpression(), { awaitPromise: true });
  if (!outcome.ok) {
    return failure('indexeddb_unavailable', `IndexedDB could not be listed in the page: ${outcome.text}`, {
      ...base, limitations: INDEXEDDB_LIMITATIONS, recordReadTemplate: RECORD_READ_TEMPLATE
    });
  }
  const listed = outcome.value;
  if (!listed || typeof listed !== 'object' || !Array.isArray(listed.databases)) {
    return failure('unexpected_payload', 'indexedDB.databases() returned no array; absence is not an empty origin.', {
      ...base, limitations: INDEXEDDB_LIMITATIONS, recordReadTemplate: RECORD_READ_TEMPLATE
    });
  }
  if (typeof listed.origin === 'string' && listed.origin !== securityOrigin) {
    return originMismatchFailure(listed.origin, securityOrigin, base);
  }
  // Without databases() there is no way to learn a name without opening it, and
  // opening creates. Refusing is the only answer that cannot destroy data.
  if (listed.supported === false) {
    return failure('indexeddb_unavailable', 'indexedDB.databases() is not available in this browser, so databases cannot be listed without risking the creation of one that does not exist.', {
      ...base, limitations: INDEXEDDB_LIMITATIONS, recordReadTemplate: RECORD_READ_TEMPLATE
    });
  }
  const databases = listed.databases.map(entry => bounded(entry?.name, 200)).filter(Boolean);

  if (!(typeof key === 'string' && key)) {
    return {
      status: 'success', ...base, count: databases.length,
      databases: databases.slice(0, limit), databasesTruncated: databases.length > limit, limit,
      emptyMeaning: databases.length ? null : 'No IndexedDB database is registered for this origin; this is an empty origin, not a failed read.',
      limitations: INDEXEDDB_LIMITATIONS,
      recordReadTemplate: RECORD_READ_TEMPLATE,
      contentTrust: TRUST
    };
  }

  // The name list is authoritative, so a typo answers "not found" without asking
  // CDP to open a database that may not exist.
  if (!databases.includes(key)) {
    return {
      status: 'success', ...base, key, found: false,
      availableDatabases: databases.slice(0, limit),
      emptyMeaning: 'No database with this name exists for this origin right now.',
      limitations: INDEXEDDB_LIMITATIONS,
      recordReadTemplate: RECORD_READ_TEMPLATE,
      contentTrust: TRUST
    };
  }

  const detail = await evaluateInPage(send, readDatabaseExpression(key), { awaitPromise: true });
  if (!detail.ok) {
    return failure('indexeddb_database_unreadable', `Opening ${key} in the page failed: ${detail.text}`, {
      ...base, key, limitations: INDEXEDDB_LIMITATIONS, recordReadTemplate: RECORD_READ_TEMPLATE
    });
  }
  const database = detail.value;
  if (!database || typeof database !== 'object') {
    return failure('unexpected_payload', 'Reading the database returned no object; absence is not an empty database.', {
      ...base, key, limitations: INDEXEDDB_LIMITATIONS, recordReadTemplate: RECORD_READ_TEMPLATE
    });
  }
  if (typeof database.origin === 'string' && database.origin !== securityOrigin) {
    return originMismatchFailure(database.origin, securityOrigin, base);
  }
  if (database.found !== true) {
    return {
      status: 'success', ...base, key, found: false,
      availableDatabases: databases.slice(0, limit),
      emptyMeaning: 'No database with this name exists for this origin right now. It was not created, because opening a missing database would create it.',
      limitations: INDEXEDDB_LIMITATIONS,
      recordReadTemplate: RECORD_READ_TEMPLATE,
      contentTrust: TRUST
    };
  }
  const objectStores = (Array.isArray(database.objectStores) ? database.objectStores : []).map(objectStoreSummary);
  return {
    status: 'success', ...base, key, found: true,
    database: {
      name: bounded(database.name, 200),
      version: count(database.version),
      objectStoreCount: objectStores.length,
      objectStores
    },
    limitations: INDEXEDDB_LIMITATIONS,
    recordReadTemplate: RECORD_READ_TEMPLATE,
    contentTrust: TRUST
  };
}

export async function readStorage({ send, area, securityOrigin, key, limit } = {}) {
  if (typeof send !== 'function') {
    return failure('send_unavailable', 'readStorage requires an injected send(method, params) function.', { area: bounded(area, 40), securityOrigin: null });
  }
  if (!STORAGE_AREAS.includes(area)) {
    return failure('unsupported_area', `Unsupported storage area: ${bounded(area, 40) ?? '(missing)'}.`, {
      area: bounded(area, 40), supportedAreas: STORAGE_AREAS
    });
  }
  const origin = originFields(securityOrigin);
  if (!origin) return invalidOrigin(securityOrigin, area);
  const base = { area, ...origin };
  const cap = listLimit(limit);
  const name = typeof key === 'string' && key ? key : undefined;

  try {
    if (area === 'cookies') return await readCookies({ send, securityOrigin: origin.securityOrigin, key: name, limit: cap, base });
    if (area === 'indexedDB') return await readIndexedDb({ send, securityOrigin: origin.securityOrigin, key: name, limit: cap, base });
    return await readDomStorage({ send, area, securityOrigin: origin.securityOrigin, key: name, limit: cap, base });
  } catch (error) {
    return failure('storage_read_failed', `Reading ${area} failed: ${bounded(error?.message ?? error, 200) ?? 'unknown error'}`, {
      ...base, recommendedNextAction: 'Check that the tab is still attached to the debugger, then read again.'
    });
  }
}

function writeAccepted(fields) {
  return { status: 'success', ...fields, verified: false };
}

// Every argument is embedded with JSON.stringify, never concatenated. A key is
// caller-controlled text that routinely contains quotes, and a concatenated
// expression would either throw a syntax error or, worse, evaluate as a different
// program than the one intended. Each write also re-checks location.origin before
// touching anything, so a navigation between the caller's decision and this write
// cannot land the value on a different site.
async function writeDomStorage({ send, area, action, securityOrigin, key, value, base }) {
  const target = areaExpression(area);
  const originGuard = `if (location.origin !== ${JSON.stringify(securityOrigin)}) return { origin: location.origin, applied: false };`;
  if (action === 'clear') {
    const outcome = await evaluateInPage(send, `(() => { ${originGuard} ${target}.clear(); return { origin: location.origin, applied: true }; })()`);
    if (!outcome.ok) return failure('storage_write_failed', `Clearing ${area} in the page failed: ${outcome.text}`, { ...base, action });
    if (outcome.value?.applied !== true) return originMismatchFailure(outcome.value?.origin, securityOrigin, { ...base, action });
    // clearedArea is echoed because a caller that asked for "clear" on the wrong
    // area has no other way to notice from the response alone.
    return writeAccepted({ ...base, action, clearedArea: area, destructive: true, contentTrust: TRUST });
  }
  if (typeof key !== 'string' || !key) {
    return failure('key_required', `action "${action}" requires a non-empty key.`, { ...base, action });
  }
  if (action === 'remove') {
    const outcome = await evaluateInPage(send, `(() => { ${originGuard} ${target}.removeItem(${JSON.stringify(key)}); return { origin: location.origin, applied: true }; })()`);
    if (!outcome.ok) return failure('storage_write_failed', `Removing ${key} from ${area} in the page failed: ${outcome.text}`, { ...base, action, key });
    if (outcome.value?.applied !== true) return originMismatchFailure(outcome.value?.origin, securityOrigin, { ...base, action, key });
    return writeAccepted({ ...base, action, key, destructive: true, contentTrust: TRUST });
  }
  if (typeof value !== 'string') {
    return failure('value_must_be_string', 'value must be a string. Non-strings are rejected instead of being coerced, because a coerced value is silently not what the caller sent.', {
      ...base, action, key, receivedType: value === null ? 'null' : typeof value
    });
  }
  const outcome = await evaluateInPage(send, `(() => { ${originGuard} ${target}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return { origin: location.origin, applied: true }; })()`);
  if (!outcome.ok) return failure('storage_write_failed', `Writing ${key} to ${area} in the page failed: ${outcome.text}`, { ...base, action, key });
  if (outcome.value?.applied !== true) return originMismatchFailure(outcome.value?.origin, securityOrigin, { ...base, action, key });
  return writeAccepted({ ...base, action, key, valueLength: value.length, destructive: false, contentTrust: TRUST });
}

async function writeCookies({ send, action, securityOrigin, key, cookie, base }) {
  if (action === 'clear') {
    // Deleting every cookie for an origin logs the user out of the site, and
    // there is no CDP call that scopes it to "only the ones you meant". Refusing
    // is safer than guessing, and the message names the supported alternative.
    return failure('cookie_clear_not_supported', 'Clearing every cookie of this origin destroys its login state; use action:"remove" per cookie, or say explicitly which cookies to delete.', {
      ...base, action,
      recommendedNextAction: 'Read the cookies, then remove the specific names you mean.'
    });
  }
  if (action === 'remove') {
    if (typeof key !== 'string' || !key) {
      return failure('key_required', 'action "remove" requires the cookie name as key.', { ...base, action });
    }
    await send('Network.enable');
    await send('Network.deleteCookies', { name: key, url: securityOrigin });
    return writeAccepted({ ...base, action, key, destructive: true, contentTrust: TRUST });
  }

  if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
    return failure('cookie_required', 'action "set" on cookies requires a cookie object with at least name and value.', { ...base, action });
  }
  if (typeof cookie.name !== 'string' || !cookie.name) {
    return failure('cookie_name_required', 'cookie.name must be a non-empty string.', { ...base, action });
  }
  if (typeof cookie.value !== 'string') {
    return failure('value_must_be_string', 'cookie.value must be a string.', { ...base, action, key: cookie.name, receivedType: cookie.value === null ? 'null' : typeof cookie.value });
  }
  const params = { name: cookie.name, value: cookie.value };
  for (const field of ['domain', 'path', 'url']) {
    if (typeof cookie[field] === 'string' && cookie[field]) params[field] = cookie[field];
  }
  if (typeof cookie.secure === 'boolean') params.secure = cookie.secure;
  if (typeof cookie.httpOnly === 'boolean') params.httpOnly = cookie.httpOnly;
  if (typeof cookie.sameSite === 'string' && cookie.sameSite) params.sameSite = cookie.sameSite;
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires)) params.expires = expires;
  // CDP needs either url or domain+path; without a hint it targets the origin
  // that was actually requested rather than an arbitrary default.
  if (!params.url && !params.domain) params.url = securityOrigin;

  await send('Network.enable');
  const payload = await send('Network.setCookie', params);
  // Network.setCookie reports rejection in the payload instead of throwing, and
  // ignoring it would turn "the browser refused" into a success.
  if (payload && payload.success === false) {
    return failure('cookie_rejected', 'The browser refused this cookie, typically because domain, path or SameSite attributes do not match the origin.', {
      ...base, action, key: cookie.name
    });
  }
  return writeAccepted({ ...base, action, key: cookie.name, destructive: false, sensitive: true, contentTrust: TRUST });
}

export async function writeStorage({ send, area, action, securityOrigin, key, value, cookie } = {}) {
  if (typeof send !== 'function') {
    return failure('send_unavailable', 'writeStorage requires an injected send(method, params) function.', { area: bounded(area, 40), securityOrigin: null });
  }
  if (!STORAGE_AREAS.includes(area)) {
    return failure('unsupported_area', `Unsupported storage area: ${bounded(area, 40) ?? '(missing)'}.`, {
      area: bounded(area, 40), supportedAreas: STORAGE_AREAS
    });
  }
  if (!STORAGE_ACTIONS.includes(action)) {
    return failure('unsupported_action', `Unsupported action: ${bounded(action, 40) ?? '(missing)'}.`, {
      area, action: bounded(action, 40), supportedActions: STORAGE_ACTIONS
    });
  }
  const origin = originFields(securityOrigin);
  if (!origin) return invalidOrigin(securityOrigin, area);
  const base = { area, action, ...origin };

  if (area === 'indexedDB') {
    // No write command exists in the CDP IndexedDB domain; inventing one here
    // would produce a "success" that never touched the database.
    return failure('indexeddb_write_needs_page_context', 'The CDP IndexedDB domain has no write command. Writing records must run page-context JavaScript (browser_debugger evaluate).', {
      ...base, destructive: action !== 'set',
      recommendedNextAction: 'Use browser_debugger evaluate with an indexedDB transaction in the page.'
    });
  }

  try {
    if (area === 'cookies') return await writeCookies({ send, action, securityOrigin: origin.securityOrigin, key, cookie, base });
    return await writeDomStorage({ send, area, action, securityOrigin: origin.securityOrigin, key, value, base });
  } catch (error) {
    return failure('storage_write_failed', `Writing ${area} failed: ${bounded(error?.message ?? error, 200) ?? 'unknown error'}`, {
      ...base, destructive: action !== 'set',
      recommendedNextAction: 'The command was not confirmed. Read the area again before assuming the write landed.'
    });
  }
}
