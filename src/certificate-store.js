// Certificate management, through the operating system store that Chrome reads.
//
// The starting point is a hard platform fact: there is no certificate API for
// extensions. chrome.certificateProvider exists, but it is restricted to vendor
// and enterprise component extensions, so an ordinary extension cannot list,
// import or remove anything. Chrome also keeps no store of its own on Windows -
// it uses the machine's stores. That is why the route here is not a browser API
// but the same thing a human engineer does: read and write the Windows
// certificate store.
//
// Reads (stores, list, inspect) change nothing and are not gated. Writes (import,
// remove) carry their own confirmation string, and both are verified by reading
// the store back afterwards: "the call returned" is never reported as success.
//
// One honest limitation, stated here rather than discovered later: adding a
// certificate to Root or TrustedPublisher makes Windows raise its own consent
// dialog. That dialog is the security boundary and is never worked around. A run
// that hits it and does not finish within the timeout comes back as
// waiting_for_user_auth, which means "ask the user to answer it and call again",
// not "it failed".
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CERTIFICATE_WRITE_CONFIRMATION } from './confirmations.js';

export { CERTIFICATE_WRITE_CONFIRMATION };
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/certificate-store.ps1', import.meta.url));
const POWERSHELL_EXE = (process.env.PATH ?? '').split(delimiter)
  .map(directory => join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
  .find(candidate => existsSync(candidate)) ?? 'pwsh.exe';
const OUTPUT_LIMIT = 262144;
const STORE_NAMES = ['Root', 'CA', 'My', 'TrustedPeople', 'TrustedPublisher', 'Disallowed', 'AuthRoot'];
const READ_TIMEOUT_MS = 30000;
// A store write that reaches Windows' consent dialog blocks until the user
// answers, so the write timeout is generous on purpose.
const WRITE_TIMEOUT_MS = 120000;

function defaultRunner(args, timeoutMs) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish({ code: null, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.on('error', error => finish({ code: null, error: error.message }));
    child.on('close', code => finish({ code }));
  });
}

function lastJsonLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try { return JSON.parse(lines[index]); } catch { /* keep looking upwards */ }
  }
  return null;
}

export async function runCertificateStore(input = {}, deps = {}) {
  const action = String(input.action ?? 'list');
  if (!['stores', 'list', 'inspect', 'import', 'remove'].includes(action)) {
    return { status: 'denied', retryable: false, action, reason: 'unknown_action', message: `Unknown action "${action}"; use stores, list, inspect, import or remove.` };
  }
  const write = action === 'import' || action === 'remove';
  if (write && input.confirmation !== CERTIFICATE_WRITE_CONFIRMATION) {
    return {
      status: 'denied', retryable: false, action, dispatched: false,
      reason: 'confirmation_required',
      message: `Changing the certificate store needs confirmation:"${CERTIFICATE_WRITE_CONFIRMATION}". Nothing was changed.`
    };
  }
  if (process.platform !== 'win32') {
    return {
      status: 'unavailable', retryable: false, action, dispatched: false, reason: 'windows_only',
      message: 'This reads the Windows certificate store, which is what Chrome uses on Windows. On another platform the store is elsewhere and this adapter has no implementation for it.'
    };
  }
  const store = String(input.store ?? 'Root');
  if (!STORE_NAMES.includes(store)) {
    return { status: 'denied', retryable: false, action, reason: 'unknown_store', message: `store must be one of ${STORE_NAMES.join(', ')}.` };
  }
  const scope = input.scope === 'machine' || input.scope === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser';
  const args = ['-Action', action, '-Store', store, '-Scope', scope];
  if (action === 'list') {
    if (typeof input.filter === 'string' && input.filter) args.push('-Filter', input.filter.slice(0, 200));
    const limit = Number.isFinite(Number(input.limit)) ? Math.min(500, Math.max(1, Math.trunc(Number(input.limit)))) : 100;
    args.push('-Limit', String(limit));
    if (input.validOnly === true) args.push('-TrustedOnly');
  }
  if (action === 'inspect' || action === 'remove') {
    const thumbprint = String(input.thumbprint ?? '');
    // Colons and spaces are accepted because that is how Windows displays a
    // thumbprint, and a caller copying one out of certmgr.msc should not have to
    // strip it first. A subject substring is still refused: two certificates can
    // share a subject and only one of them is the one meant.
    if (!/^[0-9A-Fa-f\s:]{8,180}$/.test(thumbprint)) {
      return { status: 'denied', retryable: false, action, reason: 'thumbprint_required', message: 'Pass the certificate thumbprint (hex, colons and spaces allowed). A name or a subject substring is deliberately not accepted: two certificates can share a subject and only one of them is the one you mean.' };
    }
    // Normalised here as well as in the script so the value that reaches the
    // audit trail is the same one a caller would see in certmgr.msc.
    args.push('-Thumbprint', thumbprint.replace(/[^0-9A-Fa-f]/g, '').toUpperCase());
  }
  if (action === 'import') {
    const path = String(input.path ?? '');
    if (!path) return { status: 'denied', retryable: false, action, reason: 'path_required', message: 'Pass the absolute path of a .cer, .crt, .p7b or .pfx file.' };
    args.push('-Path', path);
    if (typeof input.password === 'string' && input.password) args.push('-Password', input.password);
  }

  const runner = deps.runner ?? defaultRunner;
  const run = await runner(args, write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
  const base = {
    action,
    method: 'windows_certificate_store',
    store,
    scope,
    source: 'windows_certificate_store',
    appliesTo: 'every application on this machine that uses the Windows store, not only Chrome'
  };
  if (run?.timedOut) {
    return {
      ...base,
      status: write ? 'waiting_for_user_auth' : 'uncertain',
      retryable: true,
      dispatched: write,
      reason: write ? 'windows_consent_dialog_open' : 'certificate_read_timeout',
      message: write
        ? 'The store write did not finish. Windows raises its own consent dialog when a certificate is added to Root or TrustedPublisher, and that dialog blocks the write until it is answered. Ask the user to answer it, then call action:"list" to see whether the certificate is there - do not repeat the import blindly.'
        : 'Reading the store did not finish in time. Retry once; if it repeats, the store may be locked by another process.',
      timeoutMs: write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS
    };
  }
  const payload = lastJsonLine(run?.stdout);
  if (!payload) {
    return {
      ...base,
      status: 'failed', retryable: true, dispatched: false,
      reason: 'certificate_store_unreadable',
      message: 'The certificate store script produced no parseable result. It needs PowerShell 7 (pwsh) on PATH.',
      detail: String(run?.stderr ?? run?.error ?? '').slice(0, 400) || null
    };
  }
  const result = { ...base, ...payload, dispatched: write ? payload.status !== 'denied' : undefined };
  if (result.dispatched === undefined) delete result.dispatched;
  return result;
}

export const CERTIFICATE_STORES = STORE_NAMES;
