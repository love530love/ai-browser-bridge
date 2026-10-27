import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/server.js';

const row = (processId, windowHandle, title = 'Chrome') => ({ processId, windowHandle, title });
const CONFIRM = { confirmation: 'reload_extension_once' };

function fixture(t, { windows, reload }) {
  const reloadCalls = [];
  let enumerations = 0;
  const adapter = {
    available: true,
    implementedActions: ['reload_extension'],
    listChromeWindows: async () => { enumerations++; return { status: 'success', windows: typeof windows === 'function' ? windows() : windows }; },
    reloadExtension: async args => {
      reloadCalls.push(args);
      return reload ? reload(args) : { status: 'success', retryable: false, reason: 'extension_reload_verified', dispatched: true, verified: true, extensionId: 'fixture' };
    }
  };
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    desktopAdapter: adapter, leaseStateFile: null, agentPolicyFile: null, audit: () => {}
  });
  return { bridge, reloadCalls, enumerations: () => enumerations };
}

test('reload resolves a single visible Chrome window instead of requiring a prior enumeration', async t => {
  const f = fixture(t, { windows: [row(11, 12)] });
  await f.bridge.listen(); t.after(() => f.bridge.close());
  const result = await f.bridge.call('browser_reload_extension', { ...CONFIRM });
  assert.equal(result.status, 'success');
  assert.equal(result.verified, true);
  assert.equal(result.targetResolution, 'single-visible-chrome-window');
  assert.equal(f.reloadCalls.length, 1);
  assert.equal(f.reloadCalls[0].processId, 11);
  assert.equal(f.reloadCalls[0].windowHandle, 12);
});

test('ambiguous targets fail closed with candidates instead of guessing a window', async t => {
  const f = fixture(t, { windows: [row(11, 12, 'Work'), row(21, 22, 'Personal')] });
  await f.bridge.listen(); t.after(() => f.bridge.close());
  const result = await f.bridge.call('browser_reload_extension', { ...CONFIRM });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'chrome_target_ambiguous');
  assert.equal(result.dispatched, false);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map(entry => entry.title), ['Work', 'Personal']);
  assert.equal(f.reloadCalls.length, 0);
});

test('no visible window is reported as not dispatched, not as a failure to retry blindly', async t => {
  const f = fixture(t, { windows: [] });
  await f.bridge.listen(); t.after(() => f.bridge.close());
  const result = await f.bridge.call('browser_reload_extension', { ...CONFIRM });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason, 'no_visible_chrome_window');
  assert.equal(result.dispatched, false);
  assert.equal(f.reloadCalls.length, 0);
});

test('a processId narrows the target when several Chrome windows exist', async t => {
  const f = fixture(t, { windows: [row(11, 12), row(21, 22)] });
  await f.bridge.listen(); t.after(() => f.bridge.close());
  const result = await f.bridge.call('browser_reload_extension', { ...CONFIRM, processId: 21 });
  assert.equal(result.status, 'success');
  assert.equal(result.targetResolution, 'single-visible-chrome-window');
  assert.equal(f.reloadCalls[0].windowHandle, 22);
});

test('a missing or wrong attestation never reaches enumeration or dispatch', async t => {
  const f = fixture(t, { windows: [row(11, 12)] });
  await f.bridge.listen(); t.after(() => f.bridge.close());
  // Both cases are rejected by schema validation before the service looks at any
  // window: the enum only accepts the fixed attestation, so the service-side
  // explicit_confirmation_required branch is a second line of defence.
  // validateCall is synchronous, so these throw before a promise is created.
  assert.throws(() => f.bridge.call('browser_reload_extension', {}), /Missing argument: confirmation/);
  assert.throws(() => f.bridge.call('browser_reload_extension', { confirmation: 'yes' }), /Invalid confirmation/);
  assert.equal(f.enumerations(), 0);
  assert.equal(f.reloadCalls.length, 0);
});

test('an explicitly supplied target still requires a recent enumeration', async t => {
  const f = fixture(t, { windows: [row(11, 12)] });
  await f.bridge.listen(); t.after(() => f.bridge.close());
  const stale = await f.bridge.call('browser_reload_extension', { ...CONFIRM, processId: 11, windowHandle: 12 });
  assert.equal(stale.status, 'denied');
  assert.equal(stale.reason, 'chrome_target_not_recently_observed');
  assert.equal(f.reloadCalls.length, 0);
  await f.bridge.call('browser_desktop_windows', {});
  const fresh = await f.bridge.call('browser_reload_extension', { ...CONFIRM, processId: 11, windowHandle: 12 });
  assert.equal(fresh.status, 'success');
  assert.equal(f.reloadCalls.length, 1);
});
