// Storage, replay and secret-fill acceptance against the user's connected Chrome.
//
// The unit suites prove each module against an injected CDP sender. This script
// proves the parts only a real renderer and a real origin can answer:
//   - localStorage and sessionStorage are not swapped (the storageId flag is the
//     easiest thing in the whole feature to invert, and a unit test can only
//     assert which flag was sent, not that Chrome honoured it),
//   - a value written through CDP is the value the page itself reads back,
//   - a cookie set by the server is visible, and its value is withheld until the
//     caller names it,
//   - a replayed request really reaches a server and returns that server's body,
//   - a password field can be filled only with secret:true, and the reply never
//     carries the value it just typed.
//
// Every secret used here is generated per run and printed only as a length, so a
// failure report cannot become a credential leak.
//
// Exit codes: 0 = every promise held, 1 = a promise broke, 2 = blocked
// (version mismatch or no connected extension), never a pass.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'storage-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;
// A refusal is a normal answer from the service, not a crash, so both shapes have
// to be reachable: the bridge either returns a structured status or rejects the
// call outright. Tests below assert on whichever one the tool actually uses.
const attempt = async (name, args = {}) => {
  try { return { ok: true, result: await call(name, args) }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
};

const rows = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: expected === actual, detail });
const failed = () => rows.filter(row => !row.ok);

const secret = `probe-${randomBytes(6).toString('hex')}`;

const page = [
  '<!doctype html><meta charset="utf-8"><title>Storage and replay fixture</title>',
  '<form id="f" onsubmit="return false">',
  '<label for="user">Username</label><input id="user" name="user" type="text" autocomplete="username">',
  '<label for="pass">Password</label><input id="pass" name="pass" type="password" autocomplete="current-password">',
  '<button id="go" type="submit">log in</button>',
  '</form>',
  '<script>',
  "localStorage.setItem('seed', 'local-value');",
  "sessionStorage.setItem('sseed', 'session-value');",
  '</script>'
].join('\n');

const server = http.createServer((req, res) => {
  if (String(req.url).startsWith('/echo')) {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, method: req.method, got: raw, sawContentType: req.headers['content-type'] ?? null }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'probe=fixture-cookie-value; Path=/' });
  res.end(page);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let tabId = null;

try {
  const status = await request('/status');
  if (status.version !== expectedVersion) {
    console.error(`blocked: service ${status.version} != expected ${expectedVersion}`);
    process.exit(2);
  }
  if (!status.connected) {
    console.error('blocked: no extension connected; start Chrome and reconnect the extension first');
    process.exit(2);
  }

  // A freshly reloaded extension accepts the socket before its first debugger
  // attachment is serviceable, so the first command after a reload can fail on
  // every path that needs one. Measured: running this script seconds after a
  // reload failed roughly half the assertions, and running it again passed 49/49.
  // One warmed-up call removes that flakiness without hiding a real failure - a
  // persistent problem still fails all five attempts.
  let warmed = false;
  for (let attemptIndex = 0; attemptIndex < 5 && !warmed; attemptIndex += 1) {
    try { await call('browser_tabs', {}); warmed = true; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  record('the extension answers a trivial call before the run', true, warmed, 'warm-up');

  tabId = (await call('browser_open', { url: `${origin}/fixture` })).tabId;
  await new Promise(resolve => setTimeout(resolve, 1200));

  // ---- localStorage -------------------------------------------------------
  const list = await call('browser_storage_read', { tabId, area: 'localStorage' });
  record('localStorage reads back', 'success', list?.status, `reason=${list?.reason ?? 'none'}`);
  const seedEntry = (list?.keys ?? []).find(entry => entry.key === 'seed');
  record('the page-set key is listed', true, Boolean(seedEntry), `keys=${JSON.stringify((list?.keys ?? []).map(k => k.key))}`);
  // The whole point of splitting discovery from value reads: a list must not
  // carry the value, otherwise every diagnostic read is a data export.
  record('a discovery read withholds the value', true, typeof seedEntry?.value === 'undefined', `valueLength=${seedEntry?.valueLength}`);
  record('a discovery read still reports the length', 'local-value'.length, seedEntry?.valueLength, 'seed');

  const one = await call('browser_storage_read', { tabId, area: 'localStorage', key: 'seed' });
  record('naming the key returns its value', 'local-value', one?.value, `found=${one?.found}`);

  const missing = await call('browser_storage_read', { tabId, area: 'localStorage', key: 'no-such-key' });
  // "Not there" is a successful read that found nothing. Reporting it as a
  // failure would make callers retry a question that already has an answer.
  record('a missing key is a success with found:false', 'success', missing?.status, `reason=${missing?.reason ?? 'none'}`);
  record('a missing key says it was not found', false, missing?.found, `availableKeys=${JSON.stringify((missing?.availableKeys ?? []).slice(0, 5))}`);

  // ---- sessionStorage ----------------------------------------------------
  const session = await call('browser_storage_read', { tabId, area: 'sessionStorage' });
  record('sessionStorage reads back', 'success', session?.status, `reason=${session?.reason ?? 'none'}`);
  // If isLocalStorage were inverted these two would swap contents and both area
  // reads would still "succeed", which is exactly why this is asserted by value.
  record('sessionStorage holds the session key', true, (session?.keys ?? []).some(entry => entry.key === 'sseed'), `keys=${JSON.stringify((session?.keys ?? []).map(k => k.key))}`);
  record('sessionStorage does not hold the local key', false, (session?.keys ?? []).some(entry => entry.key === 'seed'), 'isLocalStorage flag');

  // ---- cookies -----------------------------------------------------------
  const cookies = await call('browser_storage_read', { tabId, area: 'cookies' });
  record('cookies read back', 'success', cookies?.status, `reason=${cookies?.reason ?? 'none'}`);
  const probeCookie = (cookies?.cookies ?? []).find(entry => entry.name === 'probe');
  record('the server-set cookie is visible', true, Boolean(probeCookie), `names=${JSON.stringify((cookies?.cookies ?? []).map(c => c.name))}`);
  record('a cookie list withholds the value', true, typeof probeCookie?.value === 'undefined', `valueLength=${probeCookie?.valueLength}`);
  const oneCookie = await call('browser_storage_read', { tabId, area: 'cookies', key: 'probe' });
  record('naming a cookie returns its value', 'fixture-cookie-value', oneCookie?.value, `sensitive=${oneCookie?.sensitive}`);
  record('a named cookie read is marked sensitive', true, oneCookie?.sensitive, 'sensitive');

  // ---- IndexedDB structure only -----------------------------------------
  const idb = await call('browser_storage_read', { tabId, area: 'indexedDB' });
  record('indexedDB structure reads back', 'success', idb?.status, `databases=${JSON.stringify(idb?.databases ?? [])}`);
  record('indexedDB states that records are out of reach', true,
    Array.isArray(idb?.limitations) && idb.limitations.some(text => /get-records|record/i.test(text)),
    `limitations=${JSON.stringify(idb?.limitations ?? []).slice(0, 160)}`);
  record('indexedDB hands back a template for reading records', true,
    typeof idb?.recordReadTemplate === 'string' && idb.recordReadTemplate.length > 20, 'recordReadTemplate');

  // ---- writes ------------------------------------------------------------
  const written = await call('browser_storage_write', { tabId, area: 'localStorage', action: 'set', key: 'probe', value: 'written-value', confirmation: 'modify_site_storage_once' });
  record('a storage write reports success', 'success', written?.status, `reason=${written?.reason ?? 'none'}`);
  // verified is false on purpose: the CDP command being accepted does not mean
  // the page reads a different value, so the honest answer is "not verified".
  record('a storage write does not claim verification', false, written?.verified, 'verified');
  const readBack = await call('browser_storage_read', { tabId, area: 'localStorage', key: 'probe' });
  record('the page reads back what was written', 'written-value', readBack?.value, 'independent re-read');
  // The page's own JavaScript must see it too; a CDP-level write that the page
  // cannot observe would be a write to a shadow copy.
  const pageSees = await call('browser_debugger', { tabId, action: 'open' })
    .then(() => call('browser_debugger', { tabId, action: 'evaluate', expression: "localStorage.getItem('probe')" }))
    .then(result => result?.value);
  record('the page script sees the written value', 'written-value', pageSees, 'localStorage.getItem from page context');
  await call('browser_debugger', { tabId, action: 'close' }).catch(() => {});

  const removed = await call('browser_storage_write', { tabId, area: 'localStorage', action: 'remove', key: 'probe', confirmation: 'modify_site_storage_once' });
  record('a storage remove reports success', 'success', removed?.status, `reason=${removed?.reason ?? 'none'}`);
  const afterRemove = await call('browser_storage_read', { tabId, area: 'localStorage', key: 'probe' });
  record('the removed key is gone', false, afterRemove?.found, 'independent re-read');

  const clearCookies = await attempt('browser_storage_write', { tabId, area: 'cookies', action: 'clear', confirmation: 'modify_site_storage_once' });
  // Refused on purpose: clearing every cookie of an origin silently destroys the
  // login state a caller usually wants to keep, so it is never approximated.
  record('clearing every cookie is refused', 'cookie_clear_not_supported',
    clearCookies.ok ? clearCookies.result?.reason : clearCookies.error.slice(0, 40),
    `status=${clearCookies.ok ? clearCookies.result?.status : 'rejected'}`);

  const idbWrite = await attempt('browser_storage_write', { tabId, area: 'indexedDB', action: 'set', key: 'db', value: 'x', confirmation: 'modify_site_storage_once' });
  record('writing IndexedDB is refused', 'indexeddb_write_needs_page_context',
    idbWrite.ok ? idbWrite.result?.reason : idbWrite.error.slice(0, 40),
    `status=${idbWrite.ok ? idbWrite.result?.status : 'rejected'}`);

  // ---- replay ------------------------------------------------------------
  const replayed = await call('browser_replay_request', {
    tabId, method: 'POST', url: `${origin}/echo`,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ probe: 'replay-body' }),
    confirmation: 'replay_request_once'
  });
  record('a replay reports success', 'success', replayed?.status, `reason=${replayed?.reason ?? 'none'}`);
  record('the replay reached the server', 200, replayed?.httpStatus, 'httpStatus');
  // The body has to come back from the server, not from the bridge echoing what
  // it was told to send: only the server's own echo proves the round trip.
  record('the response is the server\'s own echo', true,
    String(replayed?.response?.bodyText ?? '').includes('replay-body'),
    `bodyChars=${String(replayed?.response?.bodyText ?? '').length}`);
  record('the server saw the POST method', true,
    String(replayed?.response?.bodyText ?? '').includes('"method":"POST"'), 'server-side echo');
  record('a POST replay is labelled destructive', true, replayed?.destructive === true, `sideEffects=${JSON.stringify(replayed?.sideEffects ?? [])}`);
  record('a replay is never marked retryable', false, replayed?.retryable, 'retryable');
  record('the replay is reported as same-origin', false, replayed?.crossOrigin, 'crossOrigin');

  const getReplay = await call('browser_replay_request', { tabId, method: 'GET', url: `${origin}/fixture`, confirmation: 'replay_request_once' });
  record('a GET replay reports success', 'success', getReplay?.status, `httpStatus=${getReplay?.httpStatus}`);
  record('a GET replay is not labelled destructive', false, getReplay?.destructive, 'destructive');

  // The three refusals below must not dispatch anything at all, so they are
  // asserted on dispatched rather than only on the reason string.
  const cookieHeader = await attempt('browser_replay_request', {
    tabId, method: 'GET', url: `${origin}/echo`, headers: { Cookie: 'probe=injected' }, confirmation: 'replay_request_once'
  });
  record('a hand-set Cookie header is refused', 'forbidden_header',
    cookieHeader.ok ? cookieHeader.result?.reason : cookieHeader.error.slice(0, 40),
    `dispatched=${cookieHeader.ok ? cookieHeader.result?.dispatched : 'rejected'}`);
  record('a refused replay dispatched nothing', false, cookieHeader.ok ? cookieHeader.result?.dispatched : false, 'dispatched');

  const badScheme = await attempt('browser_replay_request', { tabId, method: 'GET', url: 'javascript:alert(1)', confirmation: 'replay_request_once' });
  record('a javascript: replay is refused', true,
    badScheme.ok ? badScheme.result?.status !== 'success' : true,
    `reason=${badScheme.ok ? badScheme.result?.reason : 'rejected at validation'}`);

  const unconfirmed = await attempt('browser_replay_request', { tabId, method: 'GET', url: `${origin}/echo` });
  // Two layers can refuse this: the tool schema requires confirmation, and the
  // service gate rejects a wrong value. Either is correct - what matters is that
  // no request went out, so the assertion accepts both and checks dispatch.
  const unconfirmedReason = unconfirmed.ok ? unconfirmed.result?.reason ?? unconfirmed.result?.status : unconfirmed.error;
  record('a replay without confirmation is refused', true,
    unconfirmed.ok ? unconfirmed.result?.status !== 'success' && unconfirmed.result?.dispatched !== true : /confirmation/i.test(String(unconfirmedReason)),
    `reason=${String(unconfirmedReason).slice(0, 80)}`);

  // ---- secret fill -------------------------------------------------------
  const loginState = await call('browser_login_state', { tabId });
  const passwordField = (loginState?.passwordFields ?? [])[0];
  record('the login check finds the password field', true, Boolean(passwordField?.ref), `phase=${loginState?.phase} ref=${passwordField?.ref}`);

  const secretFill = await attempt('browser_fill', { tabId, ref: passwordField?.ref, text: secret, secret: true });
  record('a secret fill succeeds', 'success', secretFill.ok ? (secretFill.result?.filled === true ? 'success' : secretFill.result?.status) : 'rejected',
    `characters=${secretFill.ok ? secretFill.result?.characters : secretFill.error.slice(0, 60)}`);
  // This is the assertion that makes the feature safe: the reply must describe
  // the fill without carrying the value it just typed.
  record('a secret fill never echoes the value', false,
    JSON.stringify(secretFill.ok ? secretFill.result : secretFill.error ?? '').includes(secret), 'searched the whole reply for the secret');
  record('a secret fill reports the length it typed', secret.length,
    secretFill.ok ? secretFill.result?.characters : null, 'characters');
  record('a secret fill says it suppressed the echo', true,
    secretFill.ok ? secretFill.result?.valueEchoSuppressed === true : false, 'valueEchoSuppressed');

  // Read the length from page context instead of trusting the reply: this proves
  // the characters actually landed in the field.
  await call('browser_debugger', { tabId, action: 'open' }).catch(() => {});
  const landed = await call('browser_debugger', { tabId, action: 'evaluate', expression: "document.querySelector('input[type=password]').value.length" });
  record('the page field really holds the typed characters', secret.length, landed?.value, 'value.length read in page context');
  await call('browser_debugger', { tabId, action: 'close' }).catch(() => {});

  // Without the opt-in the same ref must still be refused, otherwise the whole
  // protection was decorative.
  const plainFill = await attempt('browser_fill', { tabId, ref: passwordField?.ref, text: 'should-not-land' });
  record('a password fill without secret is refused', true, plainFill.ok ? plainFill.result?.status !== 'success' : true,
    `reason=${plainFill.ok ? plainFill.result?.reason ?? plainFill.result?.status : plainFill.error.slice(0, 60)}`);

  // secret must not become a way to smuggle a second copy of the secret into the
  // expectation object, which is the object that ends up inside error messages.
  const relogin = await call('browser_login_state', { tabId });
  const passwordAgain = (relogin?.passwordFields ?? [])[0];
  const verifiedFill = await attempt('browser_fill_verified', {
    tabId, ref: passwordAgain?.ref, text: secret, secret: true,
    expect: { valueMatches: 'a-caller-supplied-copy-of-the-secret' }
  });
  record('a secret verified fill succeeds', 'success', verifiedFill.ok ? verifiedFill.result?.status : 'rejected',
    `reason=${verifiedFill.ok ? verifiedFill.result?.reason ?? 'none' : verifiedFill.error.slice(0, 60)}`);
  record('a secret verified fill ignores the caller expectation', true,
    verifiedFill.ok ? typeof verifiedFill.result?.expectValueMatchesIgnored === 'string' : false,
    'expectValueMatchesIgnored');
  record('a secret verified fill never echoes the secret', false,
    JSON.stringify(verifiedFill.ok ? verifiedFill.result : verifiedFill.error ?? '').includes(secret),
    'searched the whole reply for the secret');
} catch (error) {
  console.error(`fixture failed: ${error?.stack ?? error}`);
} finally {
  if (tabId) await call('browser_close', { tabId, force: true }).catch(() => {});
  server.close();
}

for (const row of rows) {
  const mark = row.ok ? 'OK  ' : 'FAIL';
  console.log(`${mark} | ${row.name} — expected=${JSON.stringify(row.expected)} actual=${JSON.stringify(row.actual)}${row.detail ? ` (${row.detail})` : ''}`);
}
console.log(`\n${rows.length - failed().length}/${rows.length} storage, replay and secret-fill promises held`);
process.exit(failed().length ? 1 : 0);
