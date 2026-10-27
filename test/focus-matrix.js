// Focus-independence matrix against the user's already-connected Chrome.
//
// Opens two fixture tabs, activates the second so the first is genuinely
// backgrounded, then runs every read/write primitive against the backgrounded
// tab and records whether it still works. Only tabs created here are operated
// and closed.
//
// Exit codes: 0 = every primitive behaved as documented, 1 = at least one
// primitive behaved worse than documented, 2 = blocked (extension/service
// mismatch), never a pass.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'focus-matrix-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const PAGE = counter => `<!doctype html>
<meta charset="utf-8">
<title>Focus matrix ${counter}</title>
<h1>Focus matrix</h1>
<button id="bump">bump</button>
<p id="count">0</p>
<input id="field" aria-label="field" placeholder="type here">
<select id="pick" aria-label="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
<a id="lnk" href="/elsewhere">link</a>
<script>
  window.__bumps = 0;
  document.getElementById('bump').addEventListener('click', function () {
    window.__bumps++;
    document.getElementById('count').textContent = String(window.__bumps);
    console.log('bump ' + window.__bumps);
  });
  // A background tab throttles timers, so ticks also prove the page still runs.
  setInterval(function () { console.log('tick'); }, 400);
</script>`;

const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE(req.url.includes('second') ? 2 : 1));
});

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const rows = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: expected === actual, detail });

const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
const safe = async (fn, ms = 25000) => {
  try { return await bounded(fn(), ms); } catch (error) { return { __error: error.message }; }
};
const statusOf = value => {
  if (value?.__error) return 'error';
  if (value === undefined) return 'timeout';
  // Most page tools answer with the payload itself and no status field; only the
  // gated paths (waiting/denied/uncertain) carry one.
  return value?.status ?? 'ok';
};
const firstRef = payload => payload?.candidates?.[0]?.ref ?? payload?.elements?.[0]?.ref ?? null;

const waitReady = async tabId => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const health = await call('browser_health', { tabId });
    const probe = health?.tab?.pageProbe;
    if (probe?.ok && probe.hasBody && ['interactive', 'complete'].includes(probe.readyState)) return health;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
};

let foregroundTab = null;
let backgroundTab = null;
const openedTabs = [];
let blocked = null;
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fixture.address().port}/`;
  const health = await call('browser_health');
  if ((health?.extensionVersion ?? null) !== expectedVersion) {
    blocked = `loaded extension is ${health?.extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}`;
    throw new Error(blocked);
  }
  const first = await call('browser_open', { url: base });
  foregroundTab = first.tabId;
  openedTabs.push(first.tabId);
  await waitReady(foregroundTab);
  const second = await call('browser_open', { url: `${base}second` });
  openedTabs.push(second.tabId);
  await waitReady(second.tabId);
  // Activating the second tab makes the first one a real background tab.
  await call('browser_history', { tabId: second.tabId, action: 'activate' });
  await new Promise(resolve => setTimeout(resolve, 600));
  const bgHealth = await call('browser_health', { tabId: foregroundTab });
  backgroundTab = foregroundTab;
  const isBackground = bgHealth?.tab?.active === false;
  step(`target tab active=${bgHealth?.tab?.active} windowId=${bgHealth?.tab?.windowId} visibility=${bgHealth?.tab?.pageProbe?.visibilityState} windowFocused=${bgHealth?.tab?.windowFocused} viewport=${bgHealth?.tab?.pageProbe?.viewport?.width}x${bgHealth?.tab?.pageProbe?.viewport?.height}`);
  record('target is genuinely backgrounded', true, isBackground, `tab.active=${bgHealth?.tab?.active}`);

  // Read path
  const read = await safe(() => call('browser_read', { tabId: backgroundTab, maxChars: 400 }));
  record('browser_read', 'ok', statusOf(read), read?.__error);
  record('browser_read returns page text', true, typeof read?.text === 'string' && read.text.includes('Focus matrix'), (read?.text ?? '').slice(0, 60));

  const find = await safe(() => call('browser_find_element', { tabId: backgroundTab, query: 'bump', action: 'click' }));
  record('browser_find_element', 'ok', statusOf(find), find?.__error);

  // Write path via DOM (this is the path that must survive backgrounding)
  const buttonRef = firstRef(find);
  record('found a clickable ref', true, Boolean(buttonRef), String(buttonRef));
  const click = await safe(() => call('browser_click', { tabId: backgroundTab, ref: buttonRef }));
  record('browser_click in background', 'ok', statusOf(click), click?.__error);
  const afterClick = await safe(() => call('browser_read', { tabId: backgroundTab, maxChars: 400 }));
  const countText = String(afterClick?.text ?? '').match(/bump\s*(\d+)/i)?.[1] ?? null;
  record('DOM click actually ran in background (counter = 1)', '1', countText, (afterClick?.text ?? '').replace(/\s+/g, ' ').slice(0, 80));

  const inputFind = await safe(() => call('browser_find_element', { tabId: backgroundTab, query: 'field', action: 'fill' }));
  const inputRef = firstRef(inputFind);
  const fill = await safe(() => call('browser_fill', { tabId: backgroundTab, ref: inputRef, text: 'background text' }));
  record('browser_fill in background', 'ok', statusOf(fill), fill?.__error);

  const key = await safe(() => call('browser_key', { tabId: backgroundTab, key: 'Enter', ref: inputRef }));
  record('browser_key (CDP) in background', 'ok', statusOf(key), key?.__error);

  const scroll = await safe(() => call('browser_scroll', { tabId: backgroundTab, deltaY: 120 }));
  record('browser_scroll in background', 'ok', statusOf(scroll), scroll?.__error);

  const selectFind = await safe(() => call('browser_find_element', { tabId: backgroundTab, query: 'pick', action: 'select' }));
  const selectRef = firstRef(selectFind);
  const select = await safe(() => call('browser_select', { tabId: backgroundTab, ref: selectRef, value: 'b' }));
  record('browser_select in background', 'ok', statusOf(select), select?.__error);

  // Diagnostics that attach a debugger
  const screenshot = await safe(() => call('browser_screenshot', { tabId: backgroundTab }));
  record('browser_screenshot in background', true, typeof screenshot?.data === 'string' && screenshot.data.length > 100, `bytes=${screenshot?.data?.length ?? 0} ${screenshot?.__error ?? ''}`);
  const perf = await safe(() => call('browser_performance', { tabId: backgroundTab }));
  record('browser_performance in background', 'ok', statusOf(perf), perf?.__error);
  const capture = await safe(() => call('browser_devtools_capture', { tabId: backgroundTab, domains: ['console', 'network'], durationMs: 1200, maxEvents: 80 }));
  record('browser_devtools_capture in background', 'success', statusOf(capture), capture?.__error);
  record('background page timers still emit console output', true,
    (capture?.messages ?? []).some(entry => /tick/.test(entry.text ?? '')),
    `messages=${capture?.messages?.length ?? 0}`);

  // Coordinate path: the token is bound to a DOM element and re-hit-tested, so a
  // backgrounded tab must still prepare, reuse and dispatch. Aim at the button
  // using the geometry the element query already returned instead of guessing a
  // point — a wrong point would silently "prove" nothing.
  await safe(() => call('browser_scroll', { tabId: backgroundTab, deltaY: -3000 }));
  const aimedHealth = await safe(() => call('browser_health', { tabId: backgroundTab }));
  const viewport = aimedHealth?.tab?.pageProbe?.viewport ?? null;
  const buttonFind = await safe(() => call('browser_find_element', { tabId: backgroundTab, query: 'bump', action: 'click' }));
  const button = (buttonFind?.candidates ?? []).find(candidate => candidate.tag === 'button') ?? null;
  const nx = button && viewport ? Math.round(button.x / viewport.width * 1000) : null;
  const ny = button && viewport ? Math.round(button.y / viewport.height * 1000) : null;
  record('located the button geometry to aim at', true, button !== null && viewport !== null,
    button ? `x=${button.x} y=${button.y} covered=${button.covered} viewport=${viewport?.width}x${viewport?.height} scrollY=${viewport?.scrollY}` : 'no button candidate');

  const prepared = nx === null ? null : await safe(() => call('browser_prepare_coordinate', { tabId: backgroundTab, x: nx, y: ny }));
  record('browser_prepare_coordinate in background', 'ok', prepared ? statusOf(prepared) : 'no_geometry', prepared?.__error ?? `target=${prepared?.target?.tag}/${prepared?.target?.label} point=${nx},${ny}`);
  record('backgrounded prepare resolves the intended button, not an ancestor', 'button', prepared?.target?.tag, `label=${prepared?.target?.label}`);
  // evidenceQuality must follow the document's real visibility, whatever it is:
  // a stale frame is only possible when the document reports itself hidden.
  record('evidenceQuality matches the real visibilityState',
    prepared?.pageState?.visibilityState === 'visible' ? 'live' : 'stale-frame-possible',
    prepared?.evidenceQuality,
    `visibilityState=${prepared?.pageState?.visibilityState} hasFocus=${prepared?.pageState?.focused}`);
  record('backgrounded prepare does not report foreground blockers', true, !prepared?.blockers?.length, `blockers=${(prepared?.blockers ?? []).join(',')}`);

  // The real question the audit left open: does a pointer press still land on
  // the prepared target while the tab is backgrounded? A token is single-use,
  // so every pointer action below gets its own fresh preparation.
  const beforeTap = String((await safe(() => call('browser_read', { tabId: backgroundTab, maxChars: 400 })))?.text ?? '').match(/bump\s*(\d+)/i)?.[1] ?? null;
  const tap = prepared?.coordinateToken ? await safe(() => call('browser_action', {
    tabId: backgroundTab, action: 'Tap', x: prepared.x, y: prepared.y,
    coordinateToken: prepared.coordinateToken, expectedUrl: prepared.expectedUrl
  })) : null;
  record('browser_action Tap dispatches in background', 'ok', tap ? statusOf(tap) : 'no_token', tap?.__error ?? tap?.reason ?? '');
  await new Promise(resolve => setTimeout(resolve, 400));
  const afterTap = String((await safe(() => call('browser_read', { tabId: backgroundTab, maxChars: 400 })))?.text ?? '').match(/bump\s*(\d+)/i)?.[1] ?? null;
  record('background Tap actually reached the prepared DOM target (counter +1)',
    String(Number(beforeTap ?? 0) + 1), afterTap, `before=${beforeTap} after=${afterTap}`);

  const hoverPrepare = prepared ? await safe(() => call('browser_prepare_coordinate', { tabId: backgroundTab, x: prepared.x, y: prepared.y })) : null;
  const hover = hoverPrepare?.coordinateToken ? await safe(() => call('browser_action', {
    tabId: backgroundTab, action: 'Hover', x: hoverPrepare.x, y: hoverPrepare.y,
    coordinateToken: hoverPrepare.coordinateToken, expectedUrl: hoverPrepare.expectedUrl
  })) : null;
  record('browser_action Hover dispatches in background', 'ok', hover ? statusOf(hover) : 'no_token', hover?.__error ?? hover?.reason ?? '');

  // Foreground is now opt-in, so asking for it must still refuse in background.
  const strict = await safe(() => call('browser_prepare_coordinate', { tabId: backgroundTab, x: prepared?.x ?? 25, y: prepared?.y ?? 150, requireForeground: true }));
  record('requireForeground:true still refuses in background', 'waiting', strict ? statusOf(strict) : 'error', `reason=${strict?.reason ?? ''}`);
  record('requireForeground:true issues no token', true, !strict?.coordinateToken, `token=${strict?.coordinateToken ? 'present' : 'absent'}`);
} catch (error) {
  if (!blocked) record('fixture setup', 'ok', 'error', error.message);
}

// Every tab this script opens is tracked here. An earlier version only closed
// the tab it had reassigned as "the background one", so the second fixture tab
// leaked on every run - which is precisely the kind of leftover the ownership
// rule exists to make visible.
if (openedTabs.length) step('closing fixture tabs');
for (const tabId of [...new Set(openedTabs)]) {
  await bounded(call('browser_close', { tabId }).catch(() => {}), 8000);
}
try { fixture.closeAllConnections?.(); } catch { /* older runtimes */ }
await bounded(new Promise(resolve => fixture.close(resolve)), 3000);
step('cleanup done');

const failed = rows.filter(row => !row.ok);
console.log('expected | actual | verdict | primitive');
for (const row of rows) {
  console.log(`${row.expected} | ${row.actual} | ${row.ok ? 'OK' : 'MISMATCH'} | ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
if (blocked) {
  console.log(`\nBLOCKED ${blocked}`);
  console.log('No checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${rows.length - failed.length}/${rows.length} primitives behaved as documented`);
process.exit(failed.length ? 1 : 0);
