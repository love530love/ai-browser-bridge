import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDesktopAdapter } from '../src/desktop-adapter.js';
import { createBridge } from '../src/server.js';

const target = { processId: 17, windowHandle: 801, expectedUrl: 'https://example.test/' };

test('DevTools open/F12 toggle is not exposed while target-window action binding is unresolved', async () => {
  const script = readFileSync(new URL('../scripts/devtools-ui.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /SendKeys\('\{F12\}'\)/);
  assert.doesNotMatch(script, /SetForegroundWindow\(/);
  assert.match(script, /HasDetachedTools\(\$ChromeProcessId\)/);
  assert.match(script, /id != \(uint\)targetProcessId/);
  let calls = 0;
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async () => { calls++; return {}; } });
  for (const action of ['open', 'toggle']) {
    const result = await adapter.devtools({ ...target, action });
    assert.equal(result.status, 'not_dispatched');
    assert.equal(result.dispatched, false);
  }
  assert.equal(calls, 0);
});

test('panel selection requires a visible label and selected-state evidence, not just an open DevTools', async () => {
  let calls = 0;
  let selectedPanels = ['Elements'];
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async () => {
    calls++;
    return { spawned: true, code: 0, stdout: JSON.stringify({ status: 'success', dispatched: true, verified: true,
      evidence: { devtoolsOpen: true, url: target.expectedUrl, selectedPanels } }) };
  } });
  assert.equal((await adapter.devtools({ ...target, action: 'select_panel' })).status, 'not_dispatched');
  assert.equal(calls, 0);
  assert.equal((await adapter.devtools({ ...target, action: 'select_panel', panel: 'Console' })).status, 'uncertain');
  selectedPanels = ['Console'];
  assert.equal((await adapter.devtools({ ...target, action: 'select_panel', panel: 'Console' })).status, 'success');
  assert.equal(calls, 2);
});
test('DevTools rejects unsupported open/toggle and requires expected URL for panel selection', async () => {
  let calls = 0;
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async () => { calls++; return {}; } });
  assert.equal((await adapter.devtools({ ...target, action: 'observe' })).status, 'failed');
  assert.equal((await adapter.devtools({ ...target, action: 'select_panel', expectedUrl: '', panel: 'Console' })).dispatched, false);
  assert.equal((await adapter.devtools({ ...target, action: 'open' })).dispatched, false);
  assert.equal((await adapter.devtools({ ...target, action: 'toggle' })).dispatched, false);
  assert.equal(calls, 1);
});
test('DevTools accepts observed evidence but never infers a panel selection from exit code alone', async () => {
  for (const stdout of ['', '{}']) {
    const adapter = createDesktopAdapter({ platform: 'win32', runScript: async () => ({ spawned: true, code: 0, stdout }) });
    assert.equal((await adapter.devtools({ ...target, action: 'observe' })).status, 'failed');
  }
  let args;
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async (_, a) => {
    args = a;
    return { spawned: true, code: 0, stdout: JSON.stringify({ status: 'success', verified: true, dispatched: false,
      evidence: { devtoolsOpen: true, url: target.expectedUrl, selectedPanels: ['Console'] } }) };
  } });
  assert.equal((await adapter.devtools({ ...target, action: 'select_panel', panel: 'Console' })).status, 'success');
  assert.deepEqual(args.slice(-2), ['-Panel', 'Console']);
});
test('DevTools panel selection timeout is not replayed', async () => {
  let count = 0;
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async () => { count++; throw Error('timeout'); } });
  const result = await adapter.devtools({ ...target, action: 'select_panel', panel: 'Console' });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.retryable, false);
  assert.equal(count, 1);
});
test('DevTools is routed locally under the shared desktop concurrency gate', async t => {
  let release;
  const adapter = { available: true,
    listChromeWindows: async () => ({ status: 'success', windows: [target] }),
    devtools: () => new Promise(resolve => { release = resolve; }) };
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    desktopAdapter: adapter, leaseStateFile: null, agentPolicyFile: null
  });
  await bridge.listen(); t.after(() => bridge.close());
  assert.equal((await bridge.call('browser_devtools', { ...target, action: 'select_panel', panel: 'Console' })).reason, 'chrome_target_not_recently_observed');
  await bridge.call('browser_desktop_windows', {});
  const pending = bridge.call('browser_devtools', { ...target, action: 'select_panel', panel: 'Console' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await bridge.call('browser_click', { tabId: 1, ref: 'x' })).reason, 'desktop_action_in_progress');
  release({ status: 'success', dispatched: false, verified: true });
  assert.equal((await pending).status, 'success');
  assert.equal(bridge.status().desktopOperation, null);
});
