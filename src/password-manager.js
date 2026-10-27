// Reads one saved password out of Chrome's own password manager, through the
// real UI.
//
// Why this exists even though the profile's credential store is already read
// directly: on Chrome 127+ the saved password is not encrypted with the key that
// sits in Local State, so offline decryption yields nothing (measured, see
// docs/CHROME-CAPABILITY-MATRIX.md). There is also no API route - an extension
// cannot attach a debugger to a chrome:// page, cannot inject a content script
// there, and chrome.passwordsPrivate is restricted to component extensions. What
// remains is the route a person uses: open the password manager, search, open the
// entry, press Show password. That is what this adapter drives, through Windows
// UI Automation.
//
// Boundaries enforced here, not merely promised:
//   - one site per call, and the entry name must match a candidate spelling
//     exactly, never as a substring;
//   - the details pane must also show the origin the caller asked for, so two
//     independent bindings have to agree before a value is returned;
//   - an operating-system consent prompt is reported as waiting_for_user_auth,
//     never worked around;
//   - the value goes to the caller only: no disk write, no log line, and the
//     audit entry records the tool and a site hash only.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PASSWORD_MANAGER_CONFIRMATION = 'reveal_password_once';
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/password-manager-ui.ps1', import.meta.url));
const POWERSHELL_EXE = (process.env.PATH ?? '').split(delimiter)
  .map(directory => join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
  .find(candidate => existsSync(candidate)) ?? 'pwsh.exe';
const OUTPUT_LIMIT = 65536;
const MAX_SITE_LENGTH = 253;

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
    child.stdout?.on('data', chunk => {
      stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
    });
    child.on('error', error => finish({ code: null, error: error.message }));
    child.on('close', code => finish({ code }));
  });
}

export function passwordManagerSiteHash(site) {
  return createHash('sha256').update(String(site ?? '').toLowerCase()).digest('hex').slice(0, 16);
}

// Public suffixes that take three labels rather than two. A full public suffix
// list is not embedded here on purpose: the point of these candidates is only to
// guess how Chrome spelled the entry name, and a wrong guess is caught by the
// origin binding in the details pane rather than trusted.
const MULTI_LABEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'co.nz', 'com.br', 'com.tw', 'com.hk', 'com.sg', 'co.kr', 'co.in', 'com.mx'
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// Chrome names an entry after the *site* it was saved for, which is not always
// the host: a login on account.example.com is listed as "example.com", and an
// IP-based login is listed with its scheme. So one request expands into the
// spellings that could legitimately name it, most specific first. Every one of
// them still has to match an entry name exactly.
export function siteCandidates(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.length > MAX_SITE_LENGTH) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  const candidates = [];
  let expectedOrigin = null;
  let parsed = null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  try { parsed = new URL(hasScheme ? raw : `https://${raw}`); } catch { parsed = null; }
  if (parsed && /^https?:$/.test(parsed.protocol) && parsed.hostname) {
    candidates.push(parsed.host);
    if (!IPV4.test(parsed.hostname)) {
      const labels = parsed.hostname.replace(/^www\./, '').split('.').filter(Boolean);
      for (const take of [3, 2]) {
        if (labels.length <= take) continue;
        const slice = labels.slice(-take).join('.');
        if (MULTI_LABEL_SUFFIXES.has(slice)) continue;
        candidates.push(slice);
      }
    }
    if (hasScheme) {
      expectedOrigin = parsed.origin;
      candidates.push(parsed.origin);
    }
  } else {
    candidates.push(raw.replace(/\/+$/, ''));
  }
  const unique = [...new Set(candidates.filter(Boolean))];
  if (!unique.length) return null;
  return { site: unique[0], altSites: unique.slice(1), expectedOrigin };
}

function mapResult(payload, meta) {
  const base = {
    status: payload?.status ?? 'uncertain',
    retryable: payload?.retryable === true,
    dispatched: payload?.dispatched === true,
    site: payload?.site ?? meta.site,
    method: 'windows_ui_automation',
    focusRequired: true,
    contentTrust: 'value read from the browser\'s own password manager UI',
    handling: 'The password is returned to the caller only. It is not written to disk, not logged, and not included in the audit entry (which records the tool and a site hash only). Do not echo it into a report or a shared transcript.'
  };
  for (const key of ['reason', 'note', 'origin', 'username', 'password', 'requiresUserAuth', 'evidence', 'visibleEntries', 'triedSites', 'shownSite', 'candidates', 'tabClosed', 'tabCloseSkipped', 'foregroundOwnerProcessId']) {
    if (payload?.[key] !== undefined) base[key] = payload[key];
  }
  return base;
}

export async function revealSavedPassword(input = {}, deps = {}) {
  if (input.confirmation !== PASSWORD_MANAGER_CONFIRMATION) {
    throw new Error(`Invalid confirmation: ${JSON.stringify(input.confirmation)}. allowed: ${PASSWORD_MANAGER_CONFIRMATION}; expected string`);
  }
  const action = input.action === 'read' ? 'read' : 'reveal';
  const requested = input.site ?? input.url ?? input.origin ?? '';
  const expansion = siteCandidates(requested);
  if (!expansion) {
    return {
      status: 'denied',
      retryable: false,
      dispatched: false,
      reason: 'invalid_site',
      message: 'Pass a site, host or http(s) URL. The lookup never runs without an exact target, and never accepts whitespace or control characters.'
    };
  }
  if (process.platform !== 'win32') {
    return { status: 'unavailable', retryable: false, dispatched: false, reason: 'windows_only', site: expansion.site };
  }

  const args = ['-Action', action, '-Site', expansion.site];
  if (expansion.altSites.length) args.push('-AltSites', expansion.altSites.join(','));
  if (expansion.expectedOrigin) args.push('-ExpectedOrigin', expansion.expectedOrigin);
  if (Number.isInteger(input.windowHandle) && input.windowHandle > 0) args.push('-ChromeWindowHandle', String(input.windowHandle));
  if (Number.isInteger(input.processId) && input.processId > 0) args.push('-ChromeProcessId', String(input.processId));
  if (action === 'reveal' && input.closeTab !== false) args.push('-CloseTab');

  const runner = deps.runner ?? defaultRunner;
  const timeoutMs = deps.timeoutMs ?? 45000;
  const run = await runner(args, timeoutMs);
  if (run?.timedOut) {
    return {
      status: 'uncertain',
      retryable: false,
      dispatched: true,
      reason: 'ui_automation_timeout',
      site: expansion.site,
      note: 'The UI automation run did not finish in time, so the outcome is unknown. Inspect the browser before acting again; do not retry blindly.'
    };
  }
  const text = String(run?.stdout ?? '').trim();
  if (!text) {
    return {
      status: 'unavailable',
      retryable: true,
      dispatched: false,
      reason: 'ui_automation_unavailable',
      site: expansion.site,
      detail: String(run?.stderr ?? run?.error ?? '').slice(0, 240) || null
    };
  }
  let payload;
  try { payload = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop()); }
  catch {
    return {
      status: 'uncertain',
      retryable: false,
      dispatched: false,
      reason: 'unreadable_ui_automation_output',
      site: expansion.site,
      detail: text.slice(0, 240)
    };
  }
  return mapResult(payload, { site: expansion.site });
}
