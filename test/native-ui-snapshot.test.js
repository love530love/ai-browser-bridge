import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeSnapshot, nativeUiSnapshot } from '../src/native-ui-snapshot.js';
import { createBridge } from '../src/server.js';
const target = { processId: 11, windowHandle: 12 };
const evidence = () => ({ ...target, status: 'success', dispatched: false, partial: false,
  controls: [{ ref: '1', parent: null, name: 'Chrome', role: 'ControlType.Window', patterns: [] },
    { ref: '2', parent: '1', name: 'Menu', role: 'ControlType.Button', patterns: ['InvokePatternIdentifiers.Pattern'] }] });
test('native evidence is target bound and preserves controls without inventing actions', () => {
  assert.deepEqual(validateNativeSnapshot(evidence(), target), evidence());
  assert.throws(() => validateNativeSnapshot(evidence(), { ...target, windowHandle: 99 }));
});
test('native tree rejects page documents, duplicates, and unresolved parents', () => {
  for (const patch of [{ role: 'ControlType.Document' }, { ref: '1' }, { parent: 'missing' }]) {
    const data = evidence(); Object.assign(data.controls[1], patch);
    assert.throws(() => validateNativeSnapshot(data, target));
  }
});
test('unsupported host does not claim native capability', async () => {
  assert.equal((await nativeUiSnapshot(target, { platform: 'linux' })).status, 'unavailable');
});

test('native state distinguishes observed state, unknown, and unsupported patterns', () => {
  const data = evidence();
  const node = data.controls[1];
  node.patterns = ['ExpandCollapsePatternIdentifiers.Pattern', 'TogglePatternIdentifiers.Pattern', 'SelectionItemPatternIdentifiers.Pattern'];
  node.state = { expandCollapse: 'Collapsed', toggle: 'Indeterminate', selected: false };
  assert.equal(validateNativeSnapshot(data, target).controls[1].state.selected, false);
  node.state = { expandCollapse: 'unknown', selected: 'unknown' };
  assert.doesNotThrow(() => validateNativeSnapshot(data, target));
  for (const state of [{ expandCollapse: 'closed' }, { selected: 'false' }, { value: 'secret' }, [], null,
    JSON.parse('{"__proto__":"unknown"}')]) {
    node.state = state;
    assert.throws(() => validateNativeSnapshot(data, target));
  }
  node.state = { toggle: 'On' }; node.patterns = [];
  assert.throws(() => validateNativeSnapshot(data, target));
});
test('native snapshot shares recent-window validation and excludes UI data from audit', async t => {
  const audit = [];
  let calls = 0;
  const adapter = { available: true, listChromeWindows: async () => ({ status: 'success', windows: [target] }),
    nativeSnapshot: async () => { calls++; return evidence(); } };
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    desktopAdapter: adapter, leaseStateFile: null, agentPolicyFile: null, audit: row => audit.push(row)
  });
  await bridge.listen(); t.after(() => bridge.close());
  assert.equal((await bridge.call('browser_native_snapshot', target)).reason, 'chrome_target_not_recently_observed');
  assert.equal(calls, 0);
  await bridge.call('browser_desktop_windows', {});
  assert.equal((await bridge.call('browser_native_snapshot', target)).status, 'success');
  assert.equal(calls, 1);
  assert.equal(bridge.status().desktopOperation, null);
  assert.ok(!JSON.stringify(audit).includes('InvokePatternIdentifiers'));
});
