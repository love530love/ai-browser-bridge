// Opt-in integration test against the user's already-connected Chrome.
// Only the tab created here is operated and closed. Never launch a new browser.
import http from 'node:http';
import assert from 'node:assert/strict';
import { request } from '../src/client.js';
import { acceptanceReport } from '../src/acceptance-report.js';

const required = ['observe', 'select:Console', 'reselect:Console', 'select:Network', 'reselect:Network', 'select:Elements', 'reselect:Elements'];
const results = [];

const agent = 'devtools-live-fixture';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;
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
  const activeTab = tabs.find(tab => tab.active);
  if (activeTab) await call('browser_observe', { tabId: activeTab.id, maxChars: 300 });
  const opened = await call('browser_open', { url });
  assert.ok(opened.tabId); tabId = opened.tabId;
  await waitTabReady(tabId);
  const observation = await call('browser_observe', { tabId, maxChars: 500 });
  assert.equal(observation.read?.title, 'Bridge DevTools fixture');
  const windows = await call('browser_desktop_windows');
  const matches = windows.windows.filter(w => w.title.startsWith('Bridge DevTools fixture'));
  assert.equal(matches.length, 1, 'exactly one fixture window required');
  const { processId, windowHandle } = matches[0];
  const base = { processId, windowHandle };
  const before = await call('browser_devtools', { ...base, action: 'observe' });
  const display = before.evidence?.url;
  assert.ok([url, url.slice(7), url.slice(7, -1)].includes(display), 'fixture address must be observed');
  base.expectedUrl = display;
  assert.equal(before.status, 'success', JSON.stringify(before));
  results.push({ id: 'observe', status: 'passed' });
  // Opening is deliberately not automated in this candidate: the F12 global
  // shortcut has a focus race. If a human has already opened docked DevTools
  // for this fixture tab, verify panel selection; otherwise perform observation
  // only and leave the user's DevTools state untouched.
  if (before.evidence?.devtoolsOpen === true) {
    const run = async args => {
      await call('browser_desktop_windows');
      const result = await call('browser_devtools', { ...base, ...args });
      assert.equal(result.status, 'success', JSON.stringify(result));
      return result;
    };
    const panels = before.evidence.panels;
    for (const choices of [['Console', '控制台'], ['Network', '网络'], ['Elements', '元素']]) {
      const panel = choices.find(name => panels.includes(name));
      if (!panel) continue;
      const selected = await run({ action: 'select_panel', panel });
      assert.ok(selected.evidence.selectedPanels.includes(panel));
      results.push({ id: `select:${choices[0]}`, status: 'passed' });
      const noOp = await run({ action: 'select_panel', panel });
      assert.equal(noOp.dispatched, false);
      results.push({ id: `reselect:${choices[0]}`, status: 'passed' });
      console.log(`PASS select and reselect ${panel}`);
    }
    console.log('Completed available DevTools panel scenarios. See structured coverage below.');
  } else {
    console.log('PARTIAL: observed Chrome; panel selection was not exercised because DevTools was not already open.');
  }
  const report = acceptanceReport(required, results);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
} finally {
  try { if (tabId) await call('browser_close', { tabId }); }
  finally {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
}
