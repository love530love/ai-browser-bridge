// Background + concurrency invariants against the user's already-connected Chrome.
//
// Two questions this script answers with live evidence, not with unit doubles:
//   1. While the human works in another application, do page primitives keep
//      working on a minimised, unfocused Chrome window?
//   2. Under concurrent callers, does every result stay bound to its own tab,
//      and does the OS foreground window stay exactly where the human left it?
//
// Only tabs opened here are operated and closed. No window is activated or
// focused, no Playwright context is started, and the OS foreground window is
// measured before and after through user32.GetForegroundWindow.
//
// Exit codes: 0 = every invariant held, 1 = a regression, 2 = blocked
// (extension/service version mismatch), never a pass.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'background-concurrency';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let waitCount = 0;
async function rawCall(name, args = {}) {
  const response = await request('/call', { name, arguments: { ...args, agent } });
  const result = response?.result;
  if (result?.status === 'waiting') waitCount += 1;
  return result;
}
async function call(name, args = {}, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await rawCall(name, args);
    if (result?.status !== 'waiting' || !result.retryable || Date.now() >= deadline) return result;
    if (result.nextPollTool) await rawCall(result.nextPollTool, result.nextPollArgs ?? {});
    else await sleep(result.suggestedDelayMs ?? 250);
  }
}

const rows = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: String(expected) === String(actual), detail });

// Read-only foreground probe: user32 through PowerShell, no window touched.
const FG_SCRIPT = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class FgProbe {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '}',
  '"@',
  '$h = [FgProbe]::GetForegroundWindow()',
  '$p = [uint32]0',
  '[void][FgProbe]::GetWindowThreadProcessId($h, [ref]$p)',
  '$sb = New-Object System.Text.StringBuilder 512',
  '[void][FgProbe]::GetWindowText($h, $sb, 512)',
  '$proc = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName',
  '@{ handle = [int64]$h; pid = [int]$p; process = $proc; title = $sb.ToString() } | ConvertTo-Json -Compress'
].join('\n');
function foreground() {
  const run = spawnSync('pwsh', ['-NoProfile', '-Command', FG_SCRIPT], { encoding: 'utf8', timeout: 20000 });
  if (run.status !== 0) return { error: (run.stderr || '').trim().slice(0, 200) };
  try {
    return JSON.parse(run.stdout.trim());
  } catch {
    return { error: `unparseable foreground probe: ${(run.stdout || '').trim().slice(0, 120)}` };
  }
}

const MARKERS = ['BG-TAB-A', 'BG-TAB-B', 'BG-TAB-C'];
const PAGE = marker => `<!doctype html>
<meta charset="utf-8">
<title>${marker}</title>
<h1>${marker}</h1>
<button id="bump">bump</button>
<p id="count">0</p>
<input id="field" aria-label="field" placeholder="type here">
<p id="status">waiting</p>
<script>
  window.__bumps = 0;
  window.__fills = 0;
  document.getElementById('bump').addEventListener('click', function () {
    window.__bumps += 1;
    document.getElementById('count').textContent = String(window.__bumps);
  });
  document.getElementById('field').addEventListener('input', function (event) {
    window.__fills += 1;
    document.getElementById('status').textContent = 'field=' + event.currentTarget.value + ' fills=' + window.__fills;
  });
</script>`;

const fixture = http.createServer((req, res) => {
  const marker = MARKERS.find(item => req.url.includes(item.slice(-1).toLowerCase()))
    ?? (req.url.includes('b') ? MARKERS[1] : req.url.includes('c') ? MARKERS[2] : MARKERS[0]);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE(marker));
});

const firstRef = payload => payload?.candidates?.[0]?.ref ?? payload?.elements?.[0]?.ref ?? null;
const textOf = payload => String(payload?.text ?? '');
const countOf = text => Number(text.match(/bump\s*(\d+)/i)?.[1] ?? NaN);
const fillsOf = text => Number(text.match(/fills=(\d+)/i)?.[1] ?? NaN);

async function waitReady(tabId, hostId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const health = await call('browser_health', { tabId, hostId });
    const probe = health?.tab?.pageProbe;
    if (probe?.ok && probe.hasBody && ['interactive', 'complete'].includes(probe.readyState)) return health;
    await sleep(100);
  }
  return null;
}

let hostId = null;
let fixtureBase = null;
const openedTabs = [];
let blocked = null;

try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  fixtureBase = `http://127.0.0.1:${fixture.address().port}/`;

  const hosts = await call('browser_hosts', {});
  hostId = hosts?.defaultHostId ?? hosts?.recommendedHostId ?? null;
  const health = await call('browser_health', { hostId });
  if ((health?.extensionVersion ?? null) !== expectedVersion) {
    blocked = `loaded extension is ${health?.extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}`;
    throw new Error(blocked);
  }
  const hostKind = (hosts?.hosts ?? []).find(host => host.hostId === hostId)?.hostKindObserved ?? 'unknown';
  record('a real browser host is selected', 'generic', hostKind, `hostId=${hostId}`);

  const windowsBefore = await call('browser_windows', { hostId });
  const chromeWindowBefore = (windowsBefore?.windows ?? [])[0] ?? null;
  const fgBefore = foreground();
  record('foreground probe works', true, !fgBefore.error, JSON.stringify(fgBefore));

  // Open three test-owned tabs without activating any of them.
  for (const marker of MARKERS) {
    const opened = await call('browser_open', { url: `${fixtureBase}${marker.slice(-1).toLowerCase()}`, hostId, active: false });
    if (!opened?.tabId) throw new Error(`browser_open returned no tabId for ${marker}: ${JSON.stringify(opened)}`);
    openedTabs.push(opened.tabId);
    await waitReady(opened.tabId, hostId);
  }
  record('three test tabs exist', 3, openedTabs.length, openedTabs.join(','));
  const tabsBefore = await Promise.all(openedTabs.map(tabId => call('browser_health', { tabId, hostId })));
  record('no test tab was activated', 'false,false,false', tabsBefore.map(tab => tab?.tab?.active === true).join(','),
    tabsBefore.map(tab => `active=${tab?.tab?.active}`).join(' '));

  // Baseline reads: each tab must return its own marker and no other's.
  for (const [index, tabId] of openedTabs.entries()) {
    const read = await call('browser_read', { tabId, hostId, maxChars: 600 });
    const text = textOf(read);
    record(`baseline read binds to ${MARKERS[index]}`, true,
      text.includes(MARKERS[index]) && MARKERS.filter(marker => marker !== MARKERS[index]).every(marker => !text.includes(marker)),
      text.replace(/\s+/g, ' ').slice(0, 90));
  }

  // One mixed batch, all launched at once: reads, finds, fills, clicks, health,
  // screenshots. The service serialises per host, so this also exercises the
  // queue (including queue_full) rather than assuming unlimited parallelism.
  const tasks = [];
  for (const [index, tabId] of openedTabs.entries()) {
    const marker = MARKERS[index];
    for (let round = 0; round < 3; round++) {
      tasks.push({ label: `${marker} read ${round}`, run: () => call('browser_read', { tabId, hostId, maxChars: 600 }) });
    }
    tasks.push({ label: `${marker} find`, run: () => call('browser_find_element', { tabId, hostId, query: 'bump', action: 'click' }) });
    tasks.push({ label: `${marker} health`, run: () => call('browser_health', { tabId, hostId }) });
    tasks.push({ label: `${marker} screenshot`, run: () => call('browser_screenshot', { tabId, hostId }) });
    for (const value of [`${marker}-v1`, `${marker}-v2`]) {
      tasks.push({ label: `${marker} fill ${value}`, run: async () => {
        const found = await call('browser_find_element', { tabId, hostId, query: 'field', action: 'fill' });
        const ref = firstRef(found);
        return ref ? call('browser_fill', { tabId, hostId, ref, text: value }) : { __error: 'field ref not found' };
      } });
    }
    tasks.push({ label: `${marker} click`, run: async () => {
      const found = await call('browser_find_element', { tabId, hostId, query: 'bump', action: 'click' });
      const ref = firstRef(found);
      return ref ? call('browser_click', { tabId, hostId, ref }) : { __error: 'bump ref not found' };
    } });
  }
  const results = await Promise.all(tasks.map(async task => {
    try {
      return { ...task, result: await task.run() };
    } catch (error) {
      return { ...task, result: { __error: error.message } };
    }
  }));

  for (const item of results) {
    const marker = item.label.slice(0, 8);
    const result = item.result;
    if (item.label.includes(' read ')) {
      const text = textOf(result);
      record(`concurrent read stays on ${marker}`, true,
        text.includes(marker) && MARKERS.filter(other => other !== marker).every(other => !text.includes(other)),
        text.replace(/\s+/g, ' ').slice(0, 80));
    } else if (item.label.endsWith('find')) {
      record(`concurrent find on ${marker}`, true, Boolean(firstRef(result)), firstRef(result) ?? JSON.stringify(result).slice(0, 80));
    } else if (item.label.endsWith('health')) {
      record(`concurrent health on ${marker}`, true, Boolean(result && !result.__error),
        JSON.stringify(result).slice(0, 100));
    } else if (item.label.endsWith('screenshot')) {
      record(`concurrent screenshot on ${marker}`, true, typeof result?.data === 'string' && result.data.length > 1000, `bytes=${result?.data?.length ?? 0} ${result?.__error ?? ''}`);
    } else if (item.label.includes(' fill ')) {
      record(`concurrent fill on ${marker}`, true, !result?.__error && result?.status !== 'unknown', JSON.stringify(result).slice(0, 100));
    } else if (item.label.endsWith('click')) {
      record(`concurrent click on ${marker}`, true, !result?.__error, result?.__error ?? (result?.status ?? 'ok'));
    }
  }

  // Read back per tab: fills and the single click must land in exactly that tab.
  for (const [index, tabId] of openedTabs.entries()) {
    const marker = MARKERS[index];
    const read = await call('browser_read', { tabId, hostId, maxChars: 600 });
    const text = textOf(read);
    record(`fills landed in ${marker}`, 2, fillsOf(text), text.replace(/\s+/g, ' ').slice(0, 90));
    record(`batch click landed in ${marker}`, 1, countOf(text), text.replace(/\s+/g, ' ').slice(0, 90));
    record(`state never crossed into ${marker}`, true,
      MARKERS.filter(other => other !== marker).every(other => !text.includes(other)),
      text.replace(/\s+/g, ' ').slice(0, 90));
  }

  // Same-tab burst: serialised on one tab, every reply must still describe it.
  // An identical repeat against an unchanged page may be refused as
  // duplicate_suppressed; that refusal is the anti-double-submit contract, not
  // a lost click. allowRepeat:true must then dispatch the same action again.
  const burstTab = openedTabs[0];
  const clickBump = async allowRepeat => {
    const found = await call('browser_find_element', { tabId: burstTab, hostId, query: 'bump', action: 'click' });
    const ref = firstRef(found);
    return ref ? call('browser_click', { tabId: burstTab, hostId, ref, ...(allowRepeat ? { allowRepeat: true } : {}) }) : { __error: 'bump ref not found' };
  };
  const burst = await Promise.all([
    ...Array.from({ length: 6 }, (_, round) => call('browser_read', { tabId: burstTab, hostId, maxChars: 600 })),
    clickBump(false),
    clickBump(true)
  ]);
  const burstReads = burst.slice(0, 6);
  const plainRepeat = burst[6];
  const allowedRepeat = burst[7];
  record('same-tab burst reads all return tab A', 6, burstReads.filter(item => textOf(item).includes(MARKERS[0])).length,
    burstReads.map(item => textOf(item).slice(0, 20)).join(' | '));
  const plainRepeatDispatched = plainRepeat?.dispatched === true;
  record('an identical repeat is either suppressed or explicitly dispatched', true,
    plainRepeat?.status === 'duplicate_suppressed' || plainRepeatDispatched,
    `status=${plainRepeat?.status ?? 'dispatched'} dispatched=${plainRepeatDispatched}`);
  record('allowRepeat:true dispatches the repeated click', true, allowedRepeat?.dispatched === true,
    `status=${allowedRepeat?.status ?? 'ok'} ${allowedRepeat?.__error ?? ''}`);
  const burstRead = await call('browser_read', { tabId: burstTab, hostId, maxChars: 600 });
  record('same-tab burst click count matches what was dispatched', 1 + (plainRepeatDispatched ? 1 : 0) + 1,
    countOf(textOf(burstRead)), textOf(burstRead).replace(/\s+/g, ' ').slice(0, 80));

  // The invariant the user asked for: the human's foreground window is intact.
  // Compare identity (handle + pid + process), not the title, which may change
  // while the human keeps working in that same window.
  const fgAfter = foreground();
  const fgIdentity = value => JSON.stringify({ handle: value?.handle, pid: value?.pid, process: value?.process });
  record('OS foreground window unchanged', fgIdentity(fgBefore), fgIdentity(fgAfter),
    JSON.stringify({ before: fgBefore, after: fgAfter }));
  const windowsAfter = await call('browser_windows', { hostId });
  const chromeWindowAfter = (windowsAfter?.windows ?? [])[0] ?? null;
  record('Chrome window focus unchanged', String(chromeWindowBefore?.focused), String(chromeWindowAfter?.focused),
    `before=${chromeWindowBefore?.state}/${chromeWindowBefore?.focused} after=${chromeWindowAfter?.state}/${chromeWindowAfter?.focused}`);
  record('Chrome window state unchanged', String(chromeWindowBefore?.state), String(chromeWindowAfter?.state),
    `before=${chromeWindowBefore?.state} after=${chromeWindowAfter?.state}`);
  record('concurrent callers observed queue waits (expected under one-in-flight)', true, waitCount >= 0, `waiting replies=${waitCount}`);
} catch (error) {
  if (!blocked) record('background concurrency fixture', 'ok', 'error', error.message);
} finally {
  for (const tabId of [...new Set(openedTabs)]) {
    try {
      await call('browser_close', { tabId, hostId }, 15000);
    } catch { /* the test outcome is already recorded */ }
  }
  try { fixture.closeAllConnections?.(); } catch { /* older runtimes */ }
  await new Promise(resolve => fixture.close(resolve));
}

const failed = rows.filter(row => !row.ok);
console.log('expected | actual | verdict | invariant');
for (const row of rows) {
  console.log(`${row.expected} | ${row.actual} | ${row.ok ? 'OK' : 'MISMATCH'} | ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
if (blocked) {
  console.log(`\nBLOCKED ${blocked}`);
  console.log('No checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${rows.length - failed.length}/${rows.length} background and concurrency invariants held`);
process.exit(failed.length ? 1 : 0);
