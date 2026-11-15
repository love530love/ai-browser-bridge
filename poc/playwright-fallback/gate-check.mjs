#!/usr/bin/env node
// Gate 0 for the Playwright fallback. The default mode only evaluates the gate.
// --launch can only reach a temporary profile and a local fixture: there is no
// flag for the user's profile, a real site, or a debug port, so this cannot
// become the improvisation AGENTS.md forbids.

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, stateDir } from '../../src/config.js';

export const EVIDENCE_SCHEMA = 'ai-browser-bridge-unavailable-evidence-v1';
export const POC_SCHEMA = 'ai-browser-bridge-playwright-poc-v1';
export const CONFIRMATION = 'playwright-temporary-profile-local-fixture';

const FORBIDDEN_SCOPE = /default\s*profile|chrome\s*profile|cookies?|login\s*data|local\s*state/i;

export function evaluateGates({ live, evidence, evidenceError = null, authorizationScope = '', confirmation = '' } = {}) {
  const deny = reason => ({ allowed: false, gate0: 'not_met', reason, defaultProfileTouched: false, playwrightStarted: false });
  if (live?.reachable === true) {
    return { ...deny('bridge_reachable'), live, message: 'The bridge answered /status. A fallback PoC is not authorized while the authoritative channel works.' };
  }
  if (live?.reachable !== false) return { ...deny('bridge_state_unknown'), live };
  if (evidenceError) return { ...deny('bridge_unavailable_evidence_unreadable'), live, evidenceError };
  if (!evidence) return { ...deny('missing_bridge_unavailable_evidence'), live };
  if (evidence.schema !== EVIDENCE_SCHEMA) return { ...deny('bridge_unavailable_evidence_schema_mismatch'), live, expected: EVIDENCE_SCHEMA };
  if (evidence.service?.reachable !== false) {
    return { ...deny('evidence_does_not_show_bridge_unavailable'), live };
  }
  const attempts = Array.isArray(evidence.attempts) ? evidence.attempts.filter(item => item && typeof item.tool === 'string') : [];
  if (attempts.length === 0) return { ...deny('evidence_has_no_failed_attempts'), live };
  const scope = String(authorizationScope ?? '').trim();
  if (!scope) return { ...deny('missing_authorization_scope'), live };
  if (FORBIDDEN_SCOPE.test(scope)) {
    return { ...deny('unsupported_scope'), live,
      message: 'This harness only supports a temporary profile plus a local fixture. A scope that names the default profile, cookies, login state or a CDP gateway belongs to a different decision.' };
  }
  if (confirmation !== CONFIRMATION) {
    return { ...deny('confirmation_mismatch'), live, expectedConfirmation: CONFIRMATION,
      message: 'The confirmation string is a caller attestation, not independent human authentication.' };
  }
  return {
    allowed: true,
    gate0: 'met',
    live,
    evidence: { schema: evidence.schema, capturedAt: evidence.capturedAt ?? null, attempts: attempts.length },
    authorizationScope: scope,
    confirmationAttestation: true,
    launchScope: 'temporary_profile_local_fixture_only',
    defaultProfileTouched: false
  };
}

export async function probeLiveBridge({ fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return { reachable: false, state: 'config_unavailable', error: String(error?.message ?? error).slice(0, 300) };
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${config.port}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, httpStatus: response.status };
  } catch (error) {
    return { reachable: false, state: 'service_down', error: String(error?.message ?? error).slice(0, 300) };
  }
}

export async function runGateCheck({
  evidencePath = null,
  authorizationScope = '',
  confirmation = '',
  probeLive = probeLiveBridge
} = {}) {
  const live = await probeLive();
  let evidence = null;
  let evidenceError = null;
  if (evidencePath) {
    try {
      evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
    } catch (error) {
      evidenceError = String(error?.message ?? error).slice(0, 300);
    }
  }
  return evaluateGates({ live, evidence, evidenceError, authorizationScope, confirmation });
}

function fixtureHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bridge PoC Fixture</title></head>
<body>
<button id="count">count</button><output id="value">0</output>
<script>
  let n = 0;
  document.getElementById('count').addEventListener('click', () => {
    n += 1;
    document.getElementById('value').textContent = String(n);
  });
</script>
</body></html>`;
}

async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(fixtureHtml());
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function launchLocalFixture({ gate, evidencePath }) {
  const profileDir = await mkdtemp(join(tmpdir(), 'bridge-pw-poc-'));
  const { server, url } = await startFixture();
  let context = null;
  try {
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check']
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const title = await page.title();
    await page.click('#count');
    await page.waitForFunction(() => document.querySelector('#value')?.textContent === '1');
    const value = await page.locator('#value').textContent();
    const evidence = {
      schema: POC_SCHEMA,
      createdAt: new Date().toISOString(),
      gate0: gate.gate0,
      authorizationScope: gate.authorizationScope,
      confirmationAttestation: gate.confirmationAttestation,
      profile: { kind: 'temporary', dir: profileDir, defaultProfileTouched: false },
      fixture: { url },
      observations: { title, value },
      proves: ['Playwright can drive a temporary browser against a local fixture'],
      doesNotProve: [
        'any logged-in state of the default profile',
        'a browser-level CDP endpoint or connect_over_cdp',
        'any capability of the AI Browser Bridge'
      ]
    };
    const file = evidencePath ?? join(stateDir, `playwright-poc-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    return { status: 'success', ...evidence, evidenceFile: file };
  } finally {
    await context?.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolveClose => server.close(() => resolveClose()));
    if (existsSync(profileDir)) await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

function parseArgs(argv) {
  const options = { launch: false, template: false, evidencePath: null, authorizationScope: '', confirmation: '', out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--launch') options.launch = true;
    else if (arg === '--print-evidence-template') options.template = true;
    else if (arg === '--bridge-unavailable-evidence') options.evidencePath = argv[++index] ?? null;
    else if (arg === '--authorization-scope') options.authorizationScope = argv[++index] ?? '';
    else if (arg === '--confirm-scope') options.confirmation = argv[++index] ?? '';
    else if (arg === '--out') options.out = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function evidenceTemplate() {
  return {
    schema: EVIDENCE_SCHEMA,
    capturedAt: new Date().toISOString(),
    service: { reachable: false, state: 'service_down', error: '<exact observed error>' },
    extension: { connected: false },
    attempts: [
      { tool: 'browser_health', reason: '<exact observed failure>' },
      { tool: 'browser_tabs', reason: '<exact observed failure>' }
    ],
    notDone: ['no Playwright', 'no second browser', 'no profile access']
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.template) {
    console.log(JSON.stringify(evidenceTemplate(), null, 2));
    return;
  }
  const gate = await runGateCheck({
    evidencePath: options.evidencePath,
    authorizationScope: options.authorizationScope,
    confirmation: options.confirmation
  });
  if (!gate.allowed || !options.launch) {
    console.log(JSON.stringify(gate, null, 2));
    if (!gate.allowed) process.exitCode = 1;
    return;
  }
  const result = await launchLocalFixture({ gate, evidencePath: options.out });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
}
