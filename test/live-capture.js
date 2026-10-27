// Opt-in integration test for browser_devtools_capture against the user's
// already-connected Chrome. Only the tab created here is operated and closed;
// no user tab, download or setting is touched. Never launches a new browser.
//
// The fixture repeats its probe burst on an interval so a bounded observation
// window is guaranteed to overlap at least one burst. Assertions only check
// presence and shape, never counts, because window overlap is inherently racy.
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;

const agent = 'cdp-capture-live-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const FIXTURE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Bridge capture fixture</title>
<h1>CDP capture fixture</h1>
<p>Local only. No accounts, no external effects.</p>
<script>
  window.__bridgeProbe = function () {
    console.log('fixture-console-log');
    console.warn('fixture-console-warn');
    console.error(new Error('fixture-console-error'));
    fetch('/api/ok').catch(() => {});
    fetch('http://127.0.0.1:1/refused').catch(() => {});
  };
  window.__bridgeProbe();
  setInterval(window.__bridgeProbe, 400);
  setTimeout(function () { throw new Error('fixture-uncaught'); }, 60);
</script>`;

const fixture = http.createServer((req, res) => {
  if (req.url.startsWith('/api/ok')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(FIXTURE_HTML);
});

const results = [];
const startedAt = Date.now();
// Progress goes to stderr so a hang is diagnosable instead of silent. Nothing is
// printed on stdout until the verdict, which keeps the pass/fail block parseable.
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, detail: error.message }); }
};

const waitTabReady = async tabId => {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    last = await call('browser_health', { tabId });
    const probe = last?.tab?.pageProbe;
    if (probe?.ok && probe.hasBody && ['interactive', 'complete'].includes(probe.readyState)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture tab did not become readable: ${JSON.stringify(last)}`);
};

let tabId;
let blocked = null;
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  step('fixture listening');
  const health = await call('browser_health');
  const extensionVersion = health?.extensionVersion ?? null;
  step(`browser_health ok, extension ${extensionVersion ?? 'unknown'}`);
  if (extensionVersion !== expectedVersion) {
    blocked = `loaded extension is ${extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}; browser_devtools_capture lives in the extension, so reload it before running this test. No tab was opened.`;
    throw new Error(blocked);
  }
  const opened = await call('browser_open', { url });
  assert.ok(opened.tabId, 'browser_open must return a tabId');
  tabId = opened.tabId;
  step(`opened tab ${tabId}`);
  await waitTabReady(tabId);
  step('fixture tab ready');

  const capture = await call('browser_devtools_capture', {
    tabId, domains: ['console', 'network', 'scripts', 'metrics'], durationMs: 1500, maxEvents: 200
  });
  step(`capture returned status=${capture?.status} messages=${capture?.messages?.length} network=${capture?.network?.length} scripts=${capture?.scripts?.length}`);
  if (capture?.status === 'failed' && /unknown command/i.test(String(capture.reason ?? capture.error ?? ''))) {
    blocked = 'the loaded extension does not implement browser_devtools_capture; reload the 0.5.24 extension first';
  }

  check('capture returns success and does not report a navigation', () => {
    assert.equal(capture.status, 'success');
    assert.equal(capture.targetChanged, false);
  });
  check('console text and levels are captured', () => {
    const text = capture.messages.map(entry => entry.text ?? '').join(' | ');
    assert.match(text, /fixture-console-log/);
    assert.match(text, /fixture-console-warn/);
    assert.ok(capture.messages.some(entry => entry.level === 'warning'), 'expected a warning level entry');
  });
  check('an uncaught page error is reported as an exception', () => {
    assert.ok(capture.messages.some(entry => entry.kind === 'exception' && entry.level === 'error'),
      `no exception entry in ${JSON.stringify(capture.messages.map(entry => entry.kind))}`);
  });
  check('the successful fixture request is a completed 200 row', () => {
    const row = capture.network.find(entry => entry.url.endsWith('/api/ok'));
    assert.ok(row, 'no /api/ok row');
    assert.equal(row.status, 200);
    assert.equal(row.state, 'completed');
  });
  check('the refused request is retained as failed, not dropped', () => {
    assert.ok(capture.network.some(entry => entry.state === 'failed'), 'no failed network row');
  });
  check('scripts are listed with an inline marker', () => {
    assert.ok(capture.scripts.length > 0, 'no scripts parsed');
    assert.ok(capture.scripts.some(entry => entry.url === '[inline script]'), 'inline script not marked');
  });
  check('no header, cookie or credential material leaks into the result', () => {
    const serialised = JSON.stringify(capture).toLowerCase();
    for (const forbidden of ['set-cookie', 'cookie:', 'authorization', 'postdata', 'sec-fetch']) {
      assert.equal(serialised.includes(forbidden), false, `result leaked ${forbidden}`);
    }
  });
  check('negative evidence is present so empty data cannot be misread', () => {
    assert.ok(Array.isArray(capture.negativeEvidence) && capture.negativeEvidence.length >= 3);
    assert.match(capture.negativeEvidence.join(' '), /not proof/);
  });
  check('buffer accounting is reported', () => {
    assert.equal(typeof capture.dropped, 'number');
    assert.equal(typeof capture.truncated, 'boolean');
    assert.equal(typeof capture.bytes, 'number');
  });
} catch (error) {
  if (!blocked && /unknown command/i.test(error.message)) {
    blocked = 'the loaded extension does not implement browser_devtools_capture; reload the current extension first.';
  } else if (!blocked) {
    results.push({ name: 'fixture setup', ok: false, detail: error.message });
  }
}

// Cleanup is bounded on purpose. The fixture page keeps polling, so a plain
// server.close() waits for those keep-alive sockets and used to hang the whole
// run after every check had already been decided.
const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
if (tabId) {
  step('closing the fixture tab');
  await bounded(call('browser_close', { tabId }).catch(() => {}), 8000);
}
try { fixture.closeAllConnections?.(); } catch { /* older runtimes */ }
await bounded(new Promise(resolve => fixture.close(resolve)), 3000);
step('cleanup done');

const failed = results.filter(entry => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.ok ? '' : ` — ${entry.detail}`}`);
if (blocked) {
  console.log(`BLOCKED ${blocked}`);
  console.log('\nNo checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
