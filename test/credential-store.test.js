// The credential store is tested against a synthetic profile built here, never
// the user's real one: a fixture SQLite file, a fixture AES key, and a stubbed
// DPAPI call. That keeps the assertions exact without ever touching a real
// password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lookupCredential, credentialOriginHash, CREDENTIAL_LOOKUP_CONFIRMATION } from '../src/credential-store.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

function seal(password, { prefix = 'v10', tamper = false, key = KEY } = {}) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tamper) tag[0] ^= 0xff;
  return Buffer.concat([Buffer.from(prefix, 'ascii'), nonce, body, tag]);
}

// Builds a throwaway profile directory with a Local State and a Login Data file.
function profile({ rows = [], keyOk = true, cookies = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-cred-test-'));
  const dir = join(root, 'Default');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('payload')]).toString('base64') }
  }));
  const db = new DatabaseSync(join(dir, 'Login Data'));
  db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB)');
  const insert = db.prepare('INSERT INTO logins (origin_url, username_value, password_value) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.origin, row.username, row.password);
  db.close();
  // A cookie jar is optional: it only exists in the fixtures that test the key
  // diagnostic, because that is the only thing it is used for.
  if (cookies) {
    mkdirSync(join(dir, 'Network'), { recursive: true });
    const jar = new DatabaseSync(join(dir, 'Network', 'Cookies'));
    jar.exec('CREATE TABLE cookies (host_key TEXT, encrypted_value BLOB)');
    const put = jar.prepare('INSERT INTO cookies (host_key, encrypted_value) VALUES (?, ?)');
    for (const cookie of cookies) put.run(cookie.host, cookie.value);
    jar.close();
  }
  const runPowerShell = async () => keyOk
    ? { ok: true, stdout: KEY.toString('base64') }
    : { ok: false, detail: 'DPAPI unavailable in this fixture' };
  return { root, runPowerShell, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a v10 entry decrypts to the exact stored password', async () => {
  const fixture = profile({ rows: [
    { origin: 'https://example.test/login', username: 'alice@example.test', password: seal('correct horse battery staple') }
  ] });
  try {
    const result = await lookupCredential({ url: 'https://example.test/signin', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'success');
    assert.equal(result.found, true);
    assert.equal(result.origin, 'https://example.test');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].username, 'alice@example.test');
    assert.equal(result.matches[0].password, 'correct horse battery staple');
    assert.equal(result.matches[0].encryption, 'v10');
    assert.equal(result.entriesScanned, 1);
  } finally { fixture.cleanup(); }
});

test('matching is by exact origin, so a lookalike host gets nothing', async () => {
  const fixture = profile({ rows: [
    { origin: 'https://example.test/', username: 'alice', password: seal('secret') }
  ] });
  try {
    // Same registrable domain, different host: this is exactly the shape of a
    // phishing page, so it must never return the credential.
    const result = await lookupCredential({ url: 'https://example.test.evil.test/login', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'not_found');
    assert.equal(result.found, false);
    assert.equal(result.matches, undefined);
    assert.equal(result.entriesScanned, 1);
  } finally { fixture.cleanup(); }
});

test('a same-site variant is reported as a candidate but never auto-selected', async () => {
  const fixture = profile({ rows: [
    { origin: 'https://www.example.test/', username: 'alice', password: seal('secret') }
  ] });
  try {
    const result = await lookupCredential({ url: 'https://example.test/login', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'not_found');
    assert.deepEqual(result.relatedOrigins, ['https://www.example.test']);
    // Reported, not used: no password anywhere in the payload.
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { fixture.cleanup(); }
});

test('several accounts on one origin are all returned, and username narrows it', async () => {
  const fixture = profile({ rows: [
    { origin: 'https://example.test/', username: 'alice', password: seal('alice-pw') },
    { origin: 'https://example.test/', username: 'bob', password: seal('bob-pw') }
  ] });
  try {
    const all = await lookupCredential({ url: 'https://example.test/', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(all.status, 'success');
    assert.equal(all.matches.length, 2);
    assert.deepEqual(all.matches.map(item => item.password).sort(), ['alice-pw', 'bob-pw']);

    const one = await lookupCredential({ url: 'https://example.test/', username: 'bob', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(one.matches.length, 1);
    assert.equal(one.matches[0].password, 'bob-pw');
  } finally { fixture.cleanup(); }
});

test('a v20 entry is refused with a reason instead of a wrong value', async () => {
  const fixture = profile({ rows: [
    { origin: 'https://example.test/', username: 'alice', password: seal('app-bound-secret', { prefix: 'v20' }) }
  ] });
  try {
    const result = await lookupCredential({ url: 'https://example.test/', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'app_bound_encryption');
    assert.equal(result.found, true);
    assert.equal(result.matches[0].password, null);
    assert.equal(result.matches[0].reason, 'app_bound_encryption');
    assert.equal(JSON.stringify(result).includes('app-bound-secret'), false);
  } finally { fixture.cleanup(); }
});

test('a failed DPAPI unwrap reports no value and does not guess', async () => {
  const fixture = profile({
    rows: [{ origin: 'https://example.test/', username: 'alice', password: seal('secret') }],
    keyOk: false
  });
  try {
    const result = await lookupCredential({ url: 'https://example.test/', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.matches[0].password, null);
    assert.equal(result.matches[0].reason, 'dpapi_unwrap_failed');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { fixture.cleanup(); }
});

test('a tampered ciphertext fails authentication instead of returning garbage', async () => {
  const fixture = profile({ rows: [
    { origin: 'https://example.test/', username: 'alice', password: seal('secret', { tamper: true }) }
  ] });
  try {
    const result = await lookupCredential({ url: 'https://example.test/', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.matches[0].password, null);
    assert.equal(result.matches[0].reason, 'decrypt_failed');
  } finally { fixture.cleanup(); }
});

// The two failures look identical from the outside but call for opposite
// actions, so each gets its own assertion.
test('when the key opens cookies but not passwords, the reply says so', async () => {
  const fixture = profile({
    rows: [{ origin: 'https://example.test/', username: 'alice', password: seal('secret', { key: OTHER_KEY }) }],
    cookies: [{ host: 'example.test', value: seal('cookie-payload') }]
  });
  try {
    const result = await lookupCredential({ url: 'https://example.test/', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'password_key_not_available');
    assert.equal(result.keyValidation.validated, true);
    assert.equal(result.keyValidation.decrypted, 1);
    assert.match(result.note, /chrome:\/\/password-manager/);
    // The cookie value must not leak into the reply either.
    assert.equal(JSON.stringify(result).includes('cookie-payload'), false);
  } finally { fixture.cleanup(); }
});

test('when the key opens nothing, the reply blames the key instead', async () => {
  const fixture = profile({
    rows: [{ origin: 'https://example.test/', username: 'alice', password: seal('secret', { key: OTHER_KEY }) }],
    cookies: [{ host: 'example.test', value: seal('cookie-payload', { key: OTHER_KEY }) }]
  });
  try {
    const result = await lookupCredential({ url: 'https://example.test/', userDataDir: fixture.root }, { runPowerShell: fixture.runPowerShell });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'legacy_key_mismatch');
    assert.equal(result.keyValidation.validated, false);
    assert.equal(JSON.stringify(result).includes('cookie-payload'), false);
  } finally { fixture.cleanup(); }
});

test('a non-http target is refused before anything is read', async () => {
  const result = await lookupCredential({ url: 'chrome://settings' }, { runPowerShell: async () => ({ ok: false }) });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'invalid_origin');
  assert.equal(result.dispatched, false);
});

test('the audit hash is stable and reveals nothing about the origin', async () => {
  const a = credentialOriginHash('https://example.test');
  const b = credentialOriginHash('https://example.test');
  const c = credentialOriginHash('https://other.test');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
  assert.equal(a.includes('example'), false);
  assert.equal(CREDENTIAL_LOOKUP_CONFIRMATION, 'read_credential_once');
});
