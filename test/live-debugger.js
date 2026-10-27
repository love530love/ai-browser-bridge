// Debugger-session acceptance against the user's already-connected Chrome.
//
// The unit suite proves the session state machine with an injected clock. This
// script proves the parts only a real renderer can answer:
//   - a breakpoint set by URL + line actually stops the page,
//   - a paused tab really is frozen, and the bridge says so instead of stalling,
//   - browser_health still answers while paused (it is the "something is stuck"
//     tool, so it must not be the thing that hangs),
//   - stepping and frame evaluation reach the paused call frame,
//   - closing the session leaves the page running, not frozen.
//
// Deliberately does NOT wait out the 30s auto-resume window: that path is
// covered by test/cdp-session.test.js with an injected clock, and sleeping 30s
// here would only make the suite slow without proving anything new.
//
// Exit codes: 0 = every promise held, 1 = a promise broke, 2 = blocked
// (extension/service version mismatch), never a pass.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/client.js';

const expectedVersion = JSON.parse(readFileSync(join(fileURLToPath(new URL('../', import.meta.url)), 'package.json'), 'utf8')).version;
const agent = 'debugger-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

// The breakpoint line is found by marker, never hardcoded: the fixture is edited
// far more often than this script, and a stale line number would silently point
// the breakpoint at a blank line and look like a working test.
const marker = 'window.calls = n;';
const lines = [
  '<!doctype html><meta charset="utf-8"><title>Debugger fixture</title>',
  '<button id="go">go</button>',
  '<script>',
  'window.calls = -1;',
  'function tick(n) {',
  '  window.calls = n;',
  '  return n * 2;',
  '}',
  'window.tick = tick;',
  'window.loop = function () { for (var i = 0; i < 5; i++) tick(i); return "done"; };',
  '</script>'
];
const breakLine = lines.findIndex(line => line.includes(marker)) + 1;
if (breakLine < 1) throw new Error(`fixture marker not found: ${marker}`);
const html = lines.join('\n');

const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

const startedAt = Date.now();
const step = message => console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const rows = [];
const record = (name, expected, actual, detail) => rows.push({ name, expected, actual, ok: expected === actual, detail });
const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let created = [];
let sessionOpen = false;
let blocked = null;

async function status(tabId) {
  const result = await call('browser_debugger', { tabId, action: 'status' });
  return result?.session ?? null;
}

// Polls until predicate holds, so the script never asserts on a fixed sleep.
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last?.done) return last;
    await sleep(150);
  }
  return last ?? { done: false, label };
}

try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fixture.address().port}/debug`;

  const health = await call('browser_health');
  if ((health?.extensionVersion ?? null) !== expectedVersion) {
    blocked = `loaded extension is ${health?.extensionVersion ?? 'unknown'} but this source tree is ${expectedVersion}`;
    throw new Error(blocked);
  }

  // 1. Open a disposable tab and wait for it to finish loading.
  const opened = await call('browser_open', { url: base });
  created.push(opened.tabId);
  const tabId = opened.tabId;
  step(`opened tab ${tabId}`);
  await until(async () => {
    const probe = (await call('browser_health', { tabId }))?.tab?.pageProbe;
    return { done: probe?.readyState === 'complete' };
  }, 8000, 'ready');
  record('fixture page reached readyState complete', 'complete',
    (await call('browser_health', { tabId }))?.tab?.pageProbe?.readyState, `tabId=${tabId}`);

  // 2. Open the debugger session.
  const session = await call('browser_debugger', { tabId, action: 'open' });
  sessionOpen = session?.status === 'success';
  record('debugger session opens', 'success', session?.status, `reason=${session?.reason ?? 'ok'}`);
  record('a fresh session is not paused', null, session?.session?.paused ?? null, 'paused');
  record('the banner cost is stated up front', true, session?.session?.debuggerBannerVisible, 'debuggerBannerVisible');

  // 3. Other CDP primitives must borrow this session, not try to attach again.
  //    A second attach fails with "Another debugger is already attached".
  const shot = await bounded(call('browser_screenshot', { tabId }), 25000);
  record('screenshot works while a session is open', true, typeof shot?.data === 'string' && shot.data.length > 0,
    `bytes=${shot?.data?.length ?? 0} status=${shot?.status ?? 'ok'} reason=${shot?.reason ?? 'none'}`);
  // The tab is hidden here, and a hidden tab produces no animation frames, so a
  // cold capture used to wait 20s for a frame that never came. The screencast
  // warm-up is the fix; asserting it ran proves the fix is live, not incidental.
  record('the hidden-tab frame warm-up ran', true, shot?.warmup?.warmed === true,
    `warmup=${JSON.stringify(shot?.warmup ?? null)} sideEffects=${JSON.stringify(shot?.sideEffects ?? null)}`);
  const perf = await bounded(call('browser_performance', { tabId }), 15000);
  record('performance enables its domain before reading metrics', true, perf?.metricsDomainEnabled === true,
    `metricsDomainEnabled=${perf?.metricsDomainEnabled} status=${perf?.status ?? 'ok'}`);
  record('performance returns real metric values', true,
    Array.isArray(perf?.metrics) && perf.metrics.length > 0,
    `metricCount=${Array.isArray(perf?.metrics) ? perf.metrics.length : 'none'}`);

  // 4. Locate the inline script and set a 1-based breakpoint on the marker line.
  const scripts = await call('browser_debugger', { tabId, action: 'scripts', urlFilter: base });
  const target = (scripts?.scripts ?? []).find(item => typeof item.url === 'string' && item.url.startsWith(base));
  record('urlFilter finds the inline page script', true, Boolean(target),
    `matched=${scripts?.count ?? 0} of ${scripts?.totalScripts ?? 0} loaded scripts, url=${target?.url ?? 'none'}`);
  const unfiltered = await call('browser_debugger', { tabId, action: 'scripts' });
  record('the unfiltered list reports its own truncation honestly', true,
    typeof unfiltered?.truncated === 'boolean' && typeof unfiltered?.totalScripts === 'number',
    `count=${unfiltered?.count ?? 0} total=${unfiltered?.totalScripts ?? 0} truncated=${unfiltered?.truncated}`);
  const breakpoint = await call('browser_debugger', {
    tabId, action: 'set_breakpoint', scriptUrl: target?.url ?? base, lineNumber: breakLine
  });
  record('the breakpoint resolves to a loaded script', true, breakpoint?.breakpoint?.resolved,
    `id=${breakpoint?.breakpoint?.breakpointId ?? 'none'} line=${breakLine} locations=${JSON.stringify(breakpoint?.breakpoint?.locations ?? [])}`);
  record('the reported line is the 1-based line we asked for', breakLine, breakpoint?.breakpoint?.lineNumber, 'lineNumber');

  // 5. Trigger from a timer, not from the injected script: a synchronous call
  //    would pause the renderer inside the very executeScript that made it,
  //    and that promise would never settle.
  const scheduled = await call('browser_debugger', {
    tabId, action: 'evaluate', expression: 'setTimeout(window.loop, 60); "scheduled"'
  });
  record('the trigger is scheduled without pausing the caller', 'scheduled', scheduled?.value, `type=${scheduled?.type}`);

  // 6. The page must actually stop.
  const hit = await until(async () => {
    const state = await status(tabId);
    return { done: Boolean(state?.paused), state };
  }, 8000, 'paused');
  record('the breakpoint stops the page', true, Boolean(hit.state?.paused),
    `reason=${hit.state?.paused?.reason ?? 'none'} hits=${JSON.stringify(hit.state?.paused?.hitBreakpoints ?? [])}`);
  record('the pause names our breakpoint', true,
    (hit.state?.paused?.hitBreakpoints ?? []).includes(breakpoint?.breakpoint?.breakpointId),
    `hitBreakpoints=${JSON.stringify(hit.state?.paused?.hitBreakpoints ?? [])}`);
  record('the pause reports a bounded auto-resume window', true,
    Number.isFinite(hit.state?.paused?.autoResumeInMs) && hit.state.paused.autoResumeInMs > 0,
    `autoResumeInMs=${hit.state?.paused?.autoResumeInMs}`);

  // 7. Frame inspection: top frame is the function we broke in, at our line.
  const frames = await call('browser_debugger', { tabId, action: 'frames' });
  const top = frames?.frames?.[0];
  record('the top frame is the broken function', 'tick', top?.functionName, `frameCount=${frames?.frames?.length ?? 0}`);
  record('the top frame sits on the breakpoint line', breakLine, top?.lineNumber, `column=${top?.columnNumber}`);
  record('frames do not leak scope values', false,
    Object.prototype.hasOwnProperty.call(top ?? {}, 'scopeChain') || Object.prototype.hasOwnProperty.call(top ?? {}, 'locals'),
    `keys=${Object.keys(top ?? {}).join(',')}`);

  // 8. Evaluate on the paused call frame, not on the page's global scope.
  const frameValue = await call('browser_debugger', { tabId, action: 'evaluate', expression: 'n', frameIndex: 0 });
  record('call-frame evaluation reads the local variable', 0, frameValue?.value, `evaluatedOn=${frameValue?.evaluatedOn} type=${frameValue?.type}`);

  // 9. A paused renderer must be refused, not waited on. This is the whole point
  //    of the guard: without it every one of these calls ends as read_timeout.
  const frozenRead = await bounded(call('browser_read', { tabId }), 6000);
  record('DOM reads are refused while paused', 'waiting', frozenRead?.status, `reason=${frozenRead?.reason ?? 'none'}`);
  record('the refusal names the cause', 'tab_paused_by_debugger', frozenRead?.reason, 'reason');
  record('the refusal tells the caller how to poll', 'browser_debugger', frozenRead?.nextPollTool, 'nextPollTool');
  const frozenShot = await bounded(call('browser_screenshot', { tabId }), 6000);
  record('screenshots are refused while paused', 'waiting', frozenShot?.status, `reason=${frozenShot?.reason ?? 'none'}`);
  const frozenKey = await bounded(call('browser_key', { tabId, key: 'Tab' }), 6000);
  record('CDP keyboard input is refused while paused', 'waiting', frozenKey?.status, `reason=${frozenKey?.reason ?? 'none'}`);

  // 10. browser_health must still answer, and must surface the pause.
  const pausedHealth = await bounded(call('browser_health', { tabId }), 6000);
  record('health answers while the tab is paused', true, pausedHealth?.tab?.pageProbe?.skipped === true,
    `pageProbe=${JSON.stringify(pausedHealth?.tab?.pageProbe ?? null).slice(0, 160)}`);
  record('health names the pause as the reason the probe was skipped', 'tab_paused_by_debugger',
    pausedHealth?.tab?.pageProbe?.reason, 'pageProbe.reason');

  // 11. Stepping resumes into the next statement and pauses again.
  const stepped = await call('browser_debugger', { tabId, action: 'step_over' });
  record('step_over is accepted', 'success', stepped?.status, `stepped=${stepped?.stepped ?? 'none'}`);
  const afterStep = await until(async () => {
    const state = await status(tabId);
    return { done: Boolean(state?.paused), state };
  }, 8000, 'stepped');
  record('the page pauses again after stepping', true, Boolean(afterStep.state?.paused), 'paused');
  const steppedFrames = await call('browser_debugger', { tabId, action: 'frames' });
  record('stepping moved off the breakpoint line', true,
    steppedFrames?.frames?.[0]?.lineNumber !== breakLine,
    `line=${steppedFrames?.frames?.[0]?.lineNumber} (breakpoint was ${breakLine})`);

  // 12. Remove the breakpoint before resuming, otherwise the loop stops again on
  //    the next iteration and "did the page finish" becomes unanswerable.
  const removed = await call('browser_debugger', { tabId, action: 'remove_breakpoint', breakpointId: breakpoint?.breakpoint?.breakpointId });
  record('the breakpoint can be removed mid-session', 'success', removed?.status, `remaining=${removed?.remaining}`);
  const resumed = await call('browser_debugger', { tabId, action: 'resume' });
  record('resume is accepted', 'success', resumed?.status, `resumed=${resumed?.resumed}`);
  const afterResume = await until(async () => {
    const state = await status(tabId);
    return { done: state !== null && !state.paused, state };
  }, 8000, 'resumed');
  record('the session reports not paused after resume', true, afterResume.state ? !afterResume.state.paused : false,
    `paused=${JSON.stringify(afterResume.state?.paused ?? null)}`);

  // 13. The page must be running again: the loop ran to completion.
  const finished = await until(async () => {
    const result = await call('browser_debugger', { tabId, action: 'evaluate', expression: 'window.calls' });
    return { done: result?.value === 4, value: result?.value };
  }, 8000, 'finished');
  record('the page ran to completion after resume', 4, finished.value, 'window.calls (loop ends at 4)');
  const liveRead = await bounded(call('browser_read', { tabId }), 8000);
  // browser_read answers with the page snapshot itself, so the proof that it ran
  // is a populated snapshot, not a status field.
  record('DOM reads work again once resumed', true,
    typeof liveRead?.url === 'string' && Array.isArray(liveRead?.elements),
    `url=${liveRead?.url ?? 'none'} elements=${liveRead?.elements?.length ?? 'none'} status=${liveRead?.status ?? 'absent'}`);

  // 14. Closing must leave the page running, and the session must be gone.
  const closed = await call('browser_debugger', { tabId, action: 'close' });
  sessionOpen = false;
  record('the session closes', 'success', closed?.status, `reason=${closed?.closeReason ?? 'none'} resumedBeforeClose=${closed?.resumedBeforeClose}`);
  const listed = await call('browser_debugger', { tabId, action: 'list' });
  record('the closed session is gone from the list', 0,
    (listed?.sessions ?? []).filter(item => item.tabId === tabId).length, `sessions=${(listed?.sessions ?? []).length}`);
  const stillLive = await bounded(call('browser_read', { tabId }), 8000);
  record('the page still answers after the session closed', true,
    typeof stillLive?.url === 'string' && Array.isArray(stillLive?.elements),
    `url=${stillLive?.url ?? 'none'} elements=${stillLive?.elements?.length ?? 'none'} status=${stillLive?.status ?? 'absent'}`);
} catch (error) {
  if (!blocked) record('fixture setup', 'ok', 'error', error.message);
}

// A broken run must never leave a frozen tab behind: resume and close whatever
// this script opened, in that order, before reporting.
for (const tabId of [...new Set(created)]) {
  if (sessionOpen) await bounded(call('browser_debugger', { tabId, action: 'close' }).catch(() => {}), 8000);
  await bounded(call('browser_close', { tabId, force: true }).catch(() => {}), 8000);
}
try { fixture.closeAllConnections?.(); } catch { /* older runtimes */ }
await bounded(new Promise(resolve => fixture.close(resolve)), 3000);
step('cleanup done');

const failed = rows.filter(row => !row.ok);
console.log('expected | actual | verdict | promise');
for (const row of rows) {
  console.log(`${JSON.stringify(row.expected)} | ${JSON.stringify(row.actual)} | ${row.ok ? 'OK' : 'MISMATCH'} | ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
if (blocked) {
  console.log(`\nBLOCKED ${blocked}`);
  console.log('No checks ran. This is a blocked environment, not a pass and not a code verdict.');
  process.exit(2);
}
console.log(`\n${rows.length - failed.length}/${rows.length} debugger-session promises held`);
process.exit(failed.length ? 1 : 0);
