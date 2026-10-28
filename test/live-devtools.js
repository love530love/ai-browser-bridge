// Opt-in integration test against the user's already-connected Chrome.
// Only the tab created here is operated and closed. Never launch a new browser.
//
// DevTools is driven through the browser's own menu (More tools -> Developer
// tools) rather than a synthesised F12, so there is no focus race. The menu item
// is a toggle, which is why every scenario below asks for a state instead of
// flipping: open, open again (must dispatch nothing), then close. A repeat of
// the same request is the only retry shape that is safe here, and this test
// proves it against the real browser instead of trusting the unit harness.
import http from 'node:http';
import assert from 'node:assert/strict';
import { request } from '../src/client.js';
import { acceptanceReport } from '../src/acceptance-report.js';

const baseRequired = ['observe', 'ensure-closed', 'open', 'open-idempotent', 'close'];
const panelRequired = [];
const results = [];

const agent = 'devtools-live-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Bridge DevTools fixture</title><h1>Native DevTools test</h1><p>No accounts or external effects.</p>');
});
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
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  await call('browser_health');
  const tabs = await call('browser_tabs');
  // Warm the extension on a tab this agent may actually read. browser_tabs now
  // reports restricted tabs too, so the active tab can legitimately be one that
  // observe would refuse; that refusal is not a failure of this test.
  const readable = tabs.find(tab => tab.active && tab.restricted !== true) ?? tabs.find(tab => tab.restricted !== true);
  if (readable) await call('browser_observe', { tabId: readable.id, maxChars: 300 });
  const opened = await call('browser_open', { url });
  assert.ok(opened.tabId); tabId = opened.tabId;
  await waitTabReady(tabId);
  const observation = await call('browser_observe', { tabId, maxChars: 500 });
  assert.equal(observation.read?.title, 'Bridge DevTools fixture');
  // The desktop channel binds a window by its title, and a Chrome window's
  // title is the title of its active tab. The tab under test therefore has to
  // be that window's active tab - otherwise the window is listed under some
  // other page's name and there is nothing to bind to.
  await call('browser_history', { tabId, action: 'activate' });
  let matches = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const windows = await call('browser_desktop_windows');
    matches = windows.windows.filter(w => w.title.startsWith('Bridge DevTools fixture'));
    if (matches.length === 1) break;
    await sleep(100);
  }
  assert.equal(matches.length, 1, 'exactly one fixture window required');
  const { processId } = matches[0];
  const base = { processId, windowHandle: matches[0].windowHandle };

  // A native action is bound to a window that was recently observed, so every
  // step below re-reads the window list first. This also catches the window
  // disappearing mid-run instead of failing later with a stale handle.
  const target = async () => {
    const list = await call('browser_desktop_windows');
    const found = list.windows.find(w => w.processId === processId && w.title.startsWith('Bridge DevTools fixture'));
    assert.ok(found, 'the fixture window must still be listed');
    return { ...base, windowHandle: found.windowHandle };
  };
  const devtools = async args => call('browser_devtools', { ...(await target()), ...args });

  const before = await devtools({ action: 'observe' });
  assert.equal(before.status, 'success', JSON.stringify(before));
  const display = before.evidence?.url;
  assert.ok([url, url.slice(7), url.slice(7, -1)].includes(display), 'fixture address must be observed');
  base.expectedUrl = display;
  results.push({ id: 'observe', status: 'passed' });

  // Normalise first. The bridge cannot prove "opening works" from a state that
  // was already open, and a close of an already-closed window is the idempotent
  // case rather than a dispatch.
  const closedFirst = await devtools({ action: 'close' });
  assert.equal(closedFirst.status, 'success', JSON.stringify(closedFirst));
  assert.equal(closedFirst.after.devtoolsOpen, false);
  assert.equal(closedFirst.after.partial, false, 'closing requires a complete walk, not a missing positive');
  results.push({ id: 'ensure-closed', status: 'passed',
    reason: closedFirst.alreadyInState === true ? 'devtools was already closed' : 'closed a pre-existing DevTools window' });
  console.log(`ensure-closed: dispatched=${closedFirst.dispatched} alreadyInState=${closedFirst.alreadyInState === true}`);

  const openedTools = await devtools({ action: 'open' });
  assert.equal(openedTools.status, 'success', JSON.stringify(openedTools));
  assert.equal(openedTools.verified, true);
  assert.equal(openedTools.dispatched, true, 'a fresh open must actually dispatch');
  assert.equal(openedTools.before.devtoolsOpen, false, 'the open is only proven against a closed state');
  assert.equal(openedTools.after.devtoolsOpen, true, 'DevTools must be observed open afterwards');
  assert.ok(openedTools.after.devtoolsDocumentCount >= 1, 'a devtools:// document must exist');
  assert.equal(openedTools.focusRequired, false);
  results.push({ id: 'open', status: 'passed' });
  console.log(`open: dispatched=${openedTools.dispatched} after.devtoolsDocumentCount=${openedTools.after.devtoolsDocumentCount}`);

  // The safety property behind "retry is allowed here": asking again for a
  // state that already holds dispatches nothing at all.
  const again = await devtools({ action: 'open' });
  assert.equal(again.status, 'success', JSON.stringify(again));
  assert.equal(again.dispatched, false, 'an already-open request must not dispatch');
  assert.equal(again.alreadyInState, true);
  assert.equal(again.after.devtoolsOpen, true);
  results.push({ id: 'open-idempotent', status: 'passed' });
  console.log('open again: dispatched=false alreadyInState=true');

  // Panels appear as the DevTools UI finishes rendering, and the list also
  // includes the selected panel's own tabs (Computed, Layout, Event Listeners),
  // so it grows in stages rather than all at once. Waiting for a fixed size
  // would read a half-rendered strip, so this waits for the count to stop
  // changing instead. The set is a property of the installed Chrome build and of
  // how wide the dock is; the test exercises whichever stable panels appear and
  // asserts Console, because every DevTools build has one.
  let panels = openedTools.after.panels ?? [];
  let previousSize = -1;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (panels.length >= 4 && panels.length === previousSize) break;
    previousSize = panels.length;
    await sleep(150);
    const observed = await devtools({ action: 'observe' });
    panels = observed.evidence?.panels ?? [];
  }
  const consolePanel = ['Console', '控制台'].find(name => panels.includes(name));
  assert.ok(consolePanel, `the Console panel must be exposed by this build: ${JSON.stringify(panels)}`);
  const chosen = [['Console', '控制台'], ['Network', '网络'], ['Elements', '元素']]
    .map(choices => choices.find(name => panels.includes(name)))
    .filter(Boolean);
  console.log(`panels: present=${JSON.stringify(panels)} exercising=${JSON.stringify(chosen)}`);

  for (const panel of chosen) {
    const selected = await devtools({ action: 'select_panel', panel });
    assert.equal(selected.status, 'success', JSON.stringify(selected));
    assert.ok(selected.evidence.selectedPanels.includes(panel));
    panelRequired.push(`select:${panel}`);
    results.push({ id: `select:${panel}`, status: 'passed' });
    const noOp = await devtools({ action: 'select_panel', panel });
    assert.equal(noOp.status, 'success', JSON.stringify(noOp));
    assert.equal(noOp.dispatched, false, 'reselecting the current panel must not dispatch');
    panelRequired.push(`reselect:${panel}`);
    results.push({ id: `reselect:${panel}`, status: 'passed' });
    console.log(`PASS select and reselect ${panel}`);
  }

  const closed = await devtools({ action: 'close' });
  assert.equal(closed.status, 'success', JSON.stringify(closed));
  assert.equal(closed.verified, true);
  assert.equal(closed.dispatched, true, 'a close from an open state must dispatch');
  assert.equal(closed.before.devtoolsOpen, true, 'the close is only proven against an open state');
  assert.equal(closed.after.devtoolsOpen, false);
  assert.equal(closed.after.partial, false, 'closing needs a complete walk, not just a missing positive');
  assert.equal(closed.after.devtoolsDocumentCount, 0);
  results.push({ id: 'close', status: 'passed' });
  console.log(`close: dispatched=${closed.dispatched} after.devtoolsDocumentCount=${closed.after.devtoolsDocumentCount}`);

  const report = acceptanceReport([...baseRequired, ...panelRequired], results);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
} finally {
  try { if (tabId) await call('browser_close', { tabId }); }
  finally {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
}
