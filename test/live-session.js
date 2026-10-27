// Session-reuse acceptance against the user's already-connected Chrome.
//
// Proves three things the product promises, using only evidence this script can
// observe: the bridge reuses a tab for the same page, it does not move the
// window to the front, and it does not create extra windows.
//
// Deliberately does NOT test the "refuse to close a tab the bridge did not open"
// branch here: proving that branch by pointing it at one of the user's real tabs
// would destroy that tab if the guard were broken. That branch is covered by
// unit tests plus the disposable-browser e2e run.
//
// Exit codes: 0 = every promise held, 1 = a promise broke, 2 = blocked
// (extension/service version mismatch), never a pass.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'session-reuse-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Session reuse</title><p>${req.url}</p>`);
});

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const rows = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: expected === actual, detail });
const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

let created = [];
let blocked = null;
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fixture.address().port}/page`;

  const health = await call('browser_health');
  if ((health?.extensionVersion ?? null) !== expectedVersion) {
    blocked = `loaded extension is ${health?.extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}`;
    throw new Error(blocked);
  }

  const before = await call('browser_tabs');
  const windowsBefore = new Set((before ?? []).map(tab => tab.windowId));
  step(`before: ${(before ?? []).length} allowed tabs across ${windowsBefore.size} window(s)`);
  // A tab the bridge did not open must be marked as such. This is the read-side
  // half of the ownership rule and it is observable without closing anything.
  record('pre-existing tabs are not marked bridgeCreated', true,
    (before ?? []).every(tab => tab.bridgeCreated === false), `tabs=${(before ?? []).length}`);
  record('incognito tabs are hidden by default', true,
    (before ?? []).every(tab => tab.incognito === false), `tabs=${(before ?? []).length}`);

  // 1. First open creates one tab and does not steal focus.
  const first = await call('browser_open', { url: base });
  created.push(first.tabId);
  record('first open creates a tab', false, first.reused, `tabId=${first.tabId}`);
  record('open does not activate by default', false, first.activated, `activated=${first.activated}`);
  const firstHealth = await call('browser_health', { tabId: first.tabId });
  record('the new tab is not the active tab, so no focus was stolen', false, firstHealth?.tab?.active, `tab.active=${firstHealth?.tab?.active}`);

  // 2. Same page again reuses the same tab.
  const second = await call('browser_open', { url: base });
  record('same URL reuses the tab', true, second.reused, `tabId=${second.tabId}`);
  record('reuse returns the same tab id', first.tabId, second.tabId, `${first.tabId} vs ${second.tabId}`);

  // 3. A fragment is the same document, not a new tab.
  const withHash = await call('browser_open', { url: `${base}#row-2` });
  record('a #fragment reuses the tab', true, withHash.reused, `tabId=${withHash.tabId}`);
  record('fragment reuse lands on the same tab', first.tabId, withHash.tabId, `${first.tabId} vs ${withHash.tabId}`);

  // 4. A different query is a different page and must not reuse.
  const withQuery = await call('browser_open', { url: `${base}?v=2` });
  created.push(withQuery.tabId);
  record('a different query string does not reuse', false, withQuery.reused, `tabId=${withQuery.tabId}`);
  record('a different query lands on a different tab', true, withQuery.tabId !== first.tabId, `${first.tabId} vs ${withQuery.tabId}`);
  record('the second tab is also not activated', false, withQuery.activated, `activated=${withQuery.activated}`);

  // 5. No extra window was created.
  const after = await call('browser_tabs');
  const windowsAfter = new Set((after ?? []).map(tab => tab.windowId));
  record('no extra window was created', windowsBefore.size, windowsAfter.size, `${windowsBefore.size} -> ${windowsAfter.size}`);
  const mine = (after ?? []).filter(tab => created.includes(tab.id));
  record('tabs opened by the bridge are marked bridgeCreated', created.length, mine.filter(tab => tab.bridgeCreated).length,
    `created=${created.join(',')} marked=${mine.map(tab => tab.id).join(',')}`);

  // 6. The bridge can close what it opened.
  for (const tabId of [...new Set(created)]) {
    const closed = await bounded(call('browser_close', { tabId }), 8000);
    record(`closes bridge-owned tab ${tabId}`, true, closed?.closed === true, `closed=${closed?.closed} status=${closed?.status ?? 'ok'}`);
  }
  const remaining = await call('browser_tabs');
  record('closed tabs are gone from the list', 0, (remaining ?? []).filter(tab => created.includes(tab.id)).length,
    `remaining=${(remaining ?? []).filter(tab => created.includes(tab.id)).map(tab => tab.id).join(',') || 'none'}`);
} catch (error) {
  if (!blocked) record('fixture setup', 'ok', 'error', error.message);
}

for (const tabId of [...new Set(created)]) await bounded(call('browser_close', { tabId }).catch(() => {}), 8000);
try { fixture.closeAllConnections?.(); } catch { /* older runtimes */ }
await bounded(new Promise(resolve => fixture.close(resolve)), 3000);
step('cleanup done');

const failed = rows.filter(row => !row.ok);
console.log('expected | actual | verdict | promise');
for (const row of rows) {
  console.log(`${row.expected} | ${row.actual} | ${row.ok ? 'OK' : 'MISMATCH'} | ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
if (blocked) {
  console.log(`\nBLOCKED ${blocked}`);
  console.log('No checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${rows.length - failed.length}/${rows.length} session-reuse promises held`);
process.exit(failed.length ? 1 : 0);
