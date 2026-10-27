// Reads Chrome's saved logins for one origin, on explicit request.
//
// Why this exists: the base cannot read stored passwords through any browser
// API - Chrome exposes none to extensions or CDP - and driving the autofill
// popup needs a foreground Windows UI Automation path. Reading the profile's own
// credential store is what a human engineer does with a password manager: take
// the value and type it. The user explicitly authorised this, on the condition
// that it is used to log in and not to leak.
//
// Boundaries that are enforced here, not just promised:
//   - one origin per call, exact scheme/host/port match, never a substring or a
//     "closest" guess, because a fuzzy match is how a phishing page gets fed;
//   - related origins (www. variant) are only *reported* as candidates, never
//     auto-selected;
//   - the decrypted value goes to the caller and nowhere else: no disk write, no
//     log line, no audit field. The audit entry records the tool and the origin
//     hash only;
//   - a v20 entry is refused with an explicit reason instead of a wrong value.
//
// Chrome 127+ stores new and migrated entries as v20 (App-Bound Encryption),
// whose key only the Chrome process can unwrap. Entries still in v10/v11 use the
// DPAPI-wrapped AES key, which a same-user process can unwrap, so the format is
// detected per row rather than assumed.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DPAPI_SCRIPT = fileURLToPath(new URL('../scripts/dpapi-unprotect.ps1', import.meta.url));
const DEFAULT_USER_DATA = () => join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data');
const MAX_ENTRIES_SCANNED = 5000;

// Only these are decryptable by a non-Chrome process; anything else is reported
// as blocked so a caller never mistakes "cannot read" for "no password".
const DECRYPTABLE_PREFIXES = new Set(['v10', 'v11']);

function originOf(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch { return null; }
}

function registrableHint(origin) {
  try {
    const { hostname } = new URL(origin);
    const bare = hostname.replace(/^www\./, '');
    return bare.split('.').slice(-2).join('.');
  } catch { return null; }
}

async function unwrapAesKey(userDataDir, { runPowerShell } = {}) {
  const localStatePath = join(userDataDir, 'Local State');
  if (!existsSync(localStatePath)) return { error: 'local_state_missing' };
  let parsed;
  try { parsed = JSON.parse(readFileSync(localStatePath, 'utf8')); }
  catch { return { error: 'local_state_unreadable' }; }
  const encoded = parsed?.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string' || !encoded) return { error: 'encrypted_key_missing' };
  const blob = Buffer.from(encoded, 'base64');
  // The 5-byte "DPAPI" tag is not part of the protected payload.
  if (blob.subarray(0, 5).toString('ascii') !== 'DPAPI') return { error: 'unexpected_key_format' };
  const payload = blob.subarray(5).toString('base64');
  const runner = runPowerShell ?? defaultRunPowerShell;
  const result = await runner(payload);
  if (!result?.ok) return { error: 'dpapi_unwrap_failed', detail: result?.detail ?? null };
  const key = Buffer.from(result.stdout.trim(), 'base64');
  if (key.length !== 32) return { error: 'unexpected_key_length', bytes: key.length };
  return { key };
}

function defaultRunPowerShell(payload) {
  return new Promise(resolve => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DPAPI_SCRIPT],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return resolve({ ok: false, detail: String(stderr || error.message).slice(0, 200) });
        resolve({ ok: true, stdout });
      }
    );
    child.stdin?.end(payload);
  });
}

function decryptV10(blob, key) {
  const data = Buffer.from(blob);
  if (data.length < 3 + 12 + 16) return { error: 'ciphertext_too_short' };
  const prefix = data.subarray(0, 3).toString('ascii');
  if (!DECRYPTABLE_PREFIXES.has(prefix)) return { error: 'unsupported_prefix', prefix };
  const nonce = data.subarray(3, 15);
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(15, data.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return { value: Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8') };
  } catch {
    // A wrong key and a corrupt row are indistinguishable here; both mean the
    // value must not be guessed at.
    return { error: 'decrypt_failed' };
  }
}

function snapshotDatabase(source) {
  const scratch = mkdtempSync(join(tmpdir(), 'bridge-cred-'));
  const copy = join(scratch, 'Login Data');
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${source}${suffix}`;
    if (existsSync(from)) copyFileSync(from, `${copy}${suffix}`);
  }
  return { copy, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

// Proves whether the unwrapped key is really this profile's key, by opening a
// cookie from the same profile. Cookies and passwords both go through Chrome's
// OSCrypt layer, so a cookie that decrypts proves the key; a password that then
// fails to decrypt is a different fact entirely - Chrome keeps the password key
// out of reach - and the caller deserves to see which of the two happened.
// Only counts are reported: no cookie value ever leaves this function.
async function validateKeyWithCookies(profileDir, key, sqliteModule) {
  const candidates = [join(profileDir, 'Network', 'Cookies'), join(profileDir, 'Cookies')];
  const source = candidates.find(existsSync);
  if (!source) return { validated: null, skipped: 'cookies_missing' };
  let rows;
  try {
    const { copy, cleanup } = snapshotDatabase(source);
    try {
      const { DatabaseSync } = sqliteModule;
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        rows = db.prepare(
          "SELECT encrypted_value FROM cookies WHERE encrypted_value IS NOT NULL AND length(encrypted_value) > 31 LIMIT 12"
        ).all();
      } finally { db.close(); }
    } finally { cleanup(); }
  } catch (error) {
    // Chrome holds the cookie jar open for the whole session, so an unreadable
    // copy is normal and must not be reported as a failed validation.
    return { validated: null, skipped: 'cookies_locked', detail: String(error?.message ?? error).slice(0, 120) };
  }
  const sample = rows.filter(row => Buffer.from(row.encrypted_value).subarray(0, 3).toString('ascii') === 'v10');
  if (!sample.length) return { validated: null, skipped: 'no_v10_cookies' };
  const decrypted = sample.filter(row => decryptV10(row.encrypted_value, key).value !== undefined).length;
  return { validated: decrypted > 0, sampled: sample.length, decrypted, method: 'v10 cookie from the same profile' };
}

async function readRows(profileDir, sqliteModule) {
  const source = join(profileDir, 'Login Data');
  if (!existsSync(source)) return { error: 'login_data_missing' };
  const { copy, cleanup } = snapshotDatabase(source);
  try {
    const { DatabaseSync } = sqliteModule;
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare(
        'SELECT origin_url, username_value, password_value FROM logins LIMIT ?'
      ).all(MAX_ENTRIES_SCANNED);
      return { rows: rows.map(row => ({
        origin: originOf(row.origin_url),
        rawOrigin: row.origin_url,
        username: typeof row.username_value === 'string' ? row.username_value : '',
        password: row.password_value
      })) };
    } finally { db.close(); }
  } catch (error) {
    return { error: 'login_data_unreadable', detail: String(error?.message ?? error).slice(0, 200) };
  } finally { cleanup(); }
}

export const CREDENTIAL_LOOKUP_CONFIRMATION = 'read_credential_once';

export function credentialOriginHash(origin) {
  return createHash('sha256').update(String(origin ?? '')).digest('hex').slice(0, 16);
}

export async function lookupCredential(input = {}, deps = {}) {
  const requestedOrigin = originOf(input.url ?? input.origin ?? '');
  if (!requestedOrigin) {
    return { status: 'denied', retryable: false, reason: 'invalid_origin', dispatched: false,
      message: 'Pass an http(s) url or origin. Credential lookup never runs without an exact target.' };
  }
  if (process.platform !== 'win32') {
    return { status: 'unavailable', retryable: false, reason: 'windows_only', origin: requestedOrigin };
  }
  const userDataDir = input.userDataDir || DEFAULT_USER_DATA();
  const profile = typeof input.profile === 'string' && /^[A-Za-z0-9 ._-]{1,64}$/.test(input.profile) ? input.profile : 'Default';
  const profileDir = join(userDataDir, profile);
  if (!existsSync(profileDir)) {
    return { status: 'unavailable', retryable: false, reason: 'profile_missing', profile };
  }

  const sqliteModule = deps.sqliteModule ?? await import('node:sqlite').catch(() => null);
  if (!sqliteModule?.DatabaseSync) {
    return { status: 'unavailable', retryable: false, reason: 'sqlite_unavailable',
      note: 'node:sqlite is not available in this runtime, so the credential store cannot be read.' };
  }

  const read = await readRows(profileDir, sqliteModule);
  if (read.error) return { status: 'unavailable', retryable: false, reason: read.error, detail: read.detail ?? null };

  const exact = read.rows.filter(row => row.origin === requestedOrigin);
  const related = [...new Set(read.rows
    .filter(row => row.origin && row.origin !== requestedOrigin)
    .filter(row => registrableHint(row.origin) && registrableHint(row.origin) === registrableHint(requestedOrigin))
    .map(row => row.origin))];

  if (!exact.length) {
    return { status: 'not_found', retryable: false, found: false, origin: requestedOrigin,
      relatedOrigins: related.slice(0, 5),
      entriesScanned: read.rows.length,
      nextStep: related.length
        ? 'No entry for this exact origin. relatedOrigins exist for the same site; retry with one of them only if the user confirms that host is the same login.'
        : 'No saved credential for this origin. Do not guess a password; ask the user or use the browser autofill path.',
      note: 'Only origins are reported, never usernames or passwords of other sites.' };
  }

  const wanted = typeof input.username === 'string' && input.username ? input.username.toLowerCase() : null;
  const selected = wanted ? exact.filter(row => row.username.toLowerCase() === wanted) : exact;
  const pool = selected.length ? selected : exact;

  const keyResult = await unwrapAesKey(userDataDir, deps);
  const matches = [];
  for (const row of pool.slice(0, 5)) {
    const blob = row.password;
    if (!blob || typeof blob.length !== 'number' || blob.length < 31) {
      matches.push({ origin: row.origin, username: row.username, password: null, reason: 'empty_or_short_value' });
      continue;
    }
    const prefix = Buffer.from(blob).subarray(0, 3).toString('ascii');
    if (!DECRYPTABLE_PREFIXES.has(prefix)) {
      matches.push({ origin: row.origin, username: row.username, password: null,
        reason: prefix === 'v20' ? 'app_bound_encryption' : 'unknown_prefix' });
      continue;
    }
    if (!keyResult.key) {
      matches.push({ origin: row.origin, username: row.username, password: null,
        reason: keyResult.error ?? 'key_unavailable' });
      continue;
    }
    const decrypted = decryptV10(blob, keyResult.key);
    matches.push({ origin: row.origin, username: row.username,
      password: decrypted.value ?? null,
      reason: decrypted.error ?? null,
      encryption: prefix });
  }

  const withPassword = matches.filter(item => typeof item.password === 'string');
  const blockedCount = matches.filter(item => item.reason === 'app_bound_encryption').length;
  const authFailed = matches.some(item => item.reason === 'decrypt_failed');
  const status = withPassword.length ? 'success' : blockedCount === matches.length ? 'blocked' : 'unavailable';

  // Only pay for the diagnostic when something actually failed to open.
  const keyValidation = (!withPassword.length && keyResult.key && authFailed)
    ? await validateKeyWithCookies(profileDir, keyResult.key, sqliteModule)
    : undefined;

  // Two very different worlds hide behind "it would not decrypt": the key is
  // wrong (nothing in this profile can be read), or the key is right and Chrome
  // simply keeps the password key to itself. Saying which one it is decides
  // whether the caller should retry elsewhere or stop.
  const failureReason = blockedCount === matches.length ? 'app_bound_encryption'
    : authFailed && keyValidation?.validated === true ? 'password_key_not_available'
    : authFailed && keyValidation?.validated === false ? 'legacy_key_mismatch'
    : (keyResult.error ?? 'value_unavailable');

  const failureNote = blockedCount === matches.length
    ? 'These entries are stored with App-Bound Encryption (v20), whose key only the Chrome process can unwrap. Use the browser autofill path or ask the user; do not attempt a downgrade.'
    : failureReason === 'password_key_not_available'
      ? 'The entry is there and the profile key is correct - it decrypts this profile\'s own cookies - but Chrome does not use that key for saved passwords, so the password cannot be read from outside the browser on this Chrome version. Reveal it in chrome://password-manager/passwords (the OS asks the user first) or ask the user; do not attempt to derive or downgrade the key.'
    : failureReason === 'legacy_key_mismatch'
      ? 'The unwrapped profile key does not open this profile\'s own cookies either, so the key on disk no longer matches the stored data. Nothing in this profile can be decrypted; ask the user.'
      : 'The entry exists but its value could not be unwrapped in this environment.';

  return {
    status,
    retryable: false,
    origin: requestedOrigin,
    profile,
    found: true,
    matchCount: matches.length,
    entriesScanned: read.rows.length,
    matches,
    ...(keyValidation ? { keyValidation } : {}),
    ...(status === 'success' ? {} : { reason: failureReason, note: failureNote }),
    handling: 'The password is returned to the caller only. It is not written to disk, not logged, and not included in the audit entry (which records the tool and an origin hash only). Do not echo it into a report or a shared transcript.',
    contentTrust: 'local browser profile, decrypted on request'
  };
}
