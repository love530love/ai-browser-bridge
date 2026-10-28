import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateNativeActionResult, nativeUiAction } from '../src/native-ui-action.js';
import { createBridge } from '../src/server.js';
import { TOOLS, validateCall } from '../src/tools.js';
import { requiredScope } from '../src/policy.js';

const target = { processId: 11, windowHandle: 12 };
const verified = () => ({ ...target, action: 'expand', status: 'success', dispatched: true, verified: true,
  alreadyInState: false, stateBefore: 'Collapsed', stateAfter: 'Expanded' });

test('a verified action result must carry the state it read back', () => {
  assert.deepEqual(validateNativeActionResult(verified(), target), verified());
  // PartiallyExpanded is a real Expand result: the control expanded but its
  // children are not all shown yet. Treating it as failure would make a caller
  // retry an action that already took effect.
  assert.doesNotThrow(() => validateNativeActionResult({ ...verified(), stateAfter: 'PartiallyExpanded' }, target));
  assert.throws(() => validateNativeActionResult({ ...verified(), windowHandle: 99 }, target));
});

test('success cannot be claimed without a dispatch or without a reached state', () => {
  const cases = [
    { verified: undefined },
    { verified: false },
    { stateAfter: undefined },
    { stateAfter: 'open' },
    { alreadyInState: undefined },
    // "already there" and "I dispatched it" are mutually exclusive claims.
    { alreadyInState: true },
    { alreadyInState: true, dispatched: false },
    { alreadyInState: true, dispatched: false, stateBefore: 'Expanded', stateAfter: 'Collapsed' },
    { dispatched: false }
  ];
  for (const patch of cases) assert.throws(() => validateNativeActionResult({ ...verified(), ...patch }, target), JSON.stringify(patch));
  assert.doesNotThrow(() => validateNativeActionResult({ ...verified(), alreadyInState: true, dispatched: false,
    stateBefore: 'Expanded', stateAfter: 'Expanded' }, target));
});

test('a non-success result can never claim verification or a reached state', () => {
  for (const patch of [{ status: 'uncertain', dispatched: null, verified: true },
    { status: 'not_dispatched', dispatched: true },
    { status: 'failed', dispatched: true, stateAfter: 'Expanded' }]) {
    assert.throws(() => validateNativeActionResult({ ...verified(), ...patch }, target), JSON.stringify(patch));
  }
  assert.doesNotThrow(() => validateNativeActionResult({ ...target, action: 'collapse', status: 'not_dispatched',
    dispatched: false, reason: 'native_control_not_found', retryable: true }, target));
  assert.doesNotThrow(() => validateNativeActionResult({ ...target, action: 'expand', status: 'uncertain',
    dispatched: null, verified: false, reason: 'native_action_dispatch_threw', stateBefore: 'Collapsed' }, target));
  assert.doesNotThrow(() => validateNativeActionResult({ ...target, action: 'expand', status: 'failed',
    dispatched: true, verified: false, reason: 'native_state_not_reached', stateBefore: 'Collapsed', stateAfter: 'Collapsed' }, target));
});

test('toggle is not an accepted action anywhere', () => {
  assert.throws(() => validateNativeActionResult({ ...verified(), action: 'toggle' }, target));
  const tool = TOOLS.find(item => item.name === 'browser_native_action');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['expand', 'collapse', 'invoke']);
  // The reason Toggle is absent is not squeamishness: repeating it inverts the
  // effect, so an uncertain result could not be retried at all.
  assert.match(tool.description, /Toggle is deliberately not implemented/);
});

const invoked = () => ({ ...target, action: 'invoke', status: 'success', dispatched: true, verified: true,
  controlGone: true, postCondition: 'control_gone', settleMs: 420 });

test('an invoke is only accepted with a post-condition it can be judged against', () => {
  assert.deepEqual(validateNativeActionResult(invoked(), target), invoked());
  const cases = [
    // A pattern call that returned is not evidence a command ran, so success
    // without the declared post-condition is not a success at all.
    { postCondition: undefined },
    { controlGone: false },
    { settleMs: undefined },
    { settleMs: -1 },
    { verified: false },
    { dispatched: false },
    // "The item is still there" is an absence of evidence, not evidence that
    // the command did not run, so invoke may never report failed.
    { status: 'failed', verified: false, controlGone: false },
    // A non-success cannot borrow the success signal.
    { status: 'uncertain', verified: false, controlGone: true },
    { status: 'not_dispatched', dispatched: true, verified: false, controlGone: false },
    // An uncertain invoke that claims it never dispatched is a contradiction:
    // the whole point is that the command may already be running.
    { status: 'uncertain', dispatched: false, verified: false, controlGone: false }
  ];
  for (const patch of cases) assert.throws(() => validateNativeActionResult({ ...invoked(), ...patch }, target), JSON.stringify(patch));
  // Refusals that are still honest outcomes.
  assert.doesNotThrow(() => validateNativeActionResult({ ...target, action: 'invoke', status: 'not_dispatched',
    dispatched: false, reason: 'native_pattern_not_supported', postCondition: 'control_gone' }, target));
  assert.doesNotThrow(() => validateNativeActionResult({ ...target, action: 'invoke', status: 'uncertain',
    dispatched: null, verified: false, reason: 'native_invoke_dispatch_threw', controlGone: false, postCondition: 'control_gone' }, target));
  assert.doesNotThrow(() => validateNativeActionResult({ ...target, action: 'invoke', status: 'uncertain',
    dispatched: true, verified: false, reason: 'native_invoke_effect_unobserved', controlGone: false, postCondition: 'control_gone' }, target));
  // Expand/collapse results have no post-condition, and an invoke result is not
  // allowed to carry expand/collapse state.
  assert.throws(() => validateNativeActionResult({ ...verified(), postCondition: 'control_gone' }, target));
});

test('an invoke without a declared post-condition is refused before anything is spawned', async () => {
  const base = { processId: 11, windowHandle: 12, ref: '42.1', action: 'invoke', expect: { name: 'Developer tools' } };
  assert.throws(() => validateCall('browser_native_action', { ...base }), /afterInvoke/);
  assert.throws(() => validateCall('browser_native_action', { ...base, expect: { ...base.expect, afterInvoke: 'menu_closed' } }),
    /Invalid expect identity: afterInvoke/);
  assert.doesNotThrow(() => validateCall('browser_native_action', { ...base, expect: { ...base.expect, afterInvoke: 'control_gone' } }));
  // A post-condition on an idempotent state action would be a claim nobody
  // checks, so it is rejected rather than silently ignored.
  assert.throws(() => validateCall('browser_native_action', { ...base, action: 'expand', expect: { name: 'Chrome', afterInvoke: 'control_gone' } }),
    /only applies to action:"invoke"/);
  await assert.rejects(() => nativeUiAction(target, { ref: '42.1', action: 'invoke', platform: 'win32', expect: { name: 'x' } }), /afterInvoke/);
});

test('a ref alone is not an identity, and the refusal happens before any dispatch', () => {
  const base = { processId: 11, windowHandle: 12, ref: '42.1', action: 'expand' };
  assert.throws(() => validateCall('browser_native_action', { ...base }), /Missing argument: expect/);
  assert.throws(() => validateCall('browser_native_action', { ...base, expect: {} }), /non-empty identity object/);
  assert.throws(() => validateCall('browser_native_action', { ...base, expect: { role: 'ControlType.Button' } }),
    /must repeat name or automationId/);
  assert.throws(() => validateCall('browser_native_action', { ...base, expect: { label: 'Chrome' } }), /Invalid expect identity: label/);
  assert.throws(() => validateCall('browser_native_action', { ...base, expect: { name: '' } }), /Invalid expect identity: name/);
  assert.throws(() => validateCall('browser_native_action', { ...base, action: 'toggle', expect: { name: 'Chrome' } }), /Invalid action/);
  assert.doesNotThrow(() => validateCall('browser_native_action', { ...base, expect: { name: 'Chrome' } }));
  assert.doesNotThrow(() => validateCall('browser_native_action', { ...base, expect: { automationId: 'view_1007' } }));
});

test('a native UI write is a write for policy, without borrowing a tab lease', () => {
  const tool = TOOLS.find(item => item.name === 'browser_native_action');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(requiredScope('browser_native_action', tool), 'write');
});

test('unsupported host does not claim the action', async () => {
  assert.equal((await nativeUiAction(target, { ref: '1', action: 'expand', platform: 'linux' })).status, 'unavailable');
  await assert.rejects(() => nativeUiAction(target, { ref: '', action: 'expand', platform: 'win32' }), /snapshot ref/);
  await assert.rejects(() => nativeUiAction(target, { ref: '1', action: 'toggle', platform: 'win32' }), /snapshot ref/);
});

test('the adapter script drives a pattern, never a global keystroke', () => {
  const source = readFileSync(new URL('../scripts/native-ui-action.ps1', import.meta.url), 'utf8');
  assert.match(source, /ExpandCollapsePattern/);
  assert.match(source, /InvokePattern/);
  // The F12 lesson: a global SendKeys races with whatever window gains focus
  // between the check and the keystroke. A pattern call is bound to the element.
  assert.equal(/SendKeys|SetForegroundWindow|WScript\.Shell/.test(source), false);
  // LeafNode cannot be expanded, so it must be refused before dispatch rather
  // than dispatched and reported as an unchanged state.
  assert.match(source, /native_control_is_leaf_node/);
  // A menu re-renders while it closes, and a re-render hands out new runtime ids.
  // Requiring the identity to be absent from two consecutive walks is what stops
  // "the ids changed" from being reported as "the item was chosen".
  assert.match(source, /\$absentStreak -ge 2/);
  assert.match(source, /native_invoke_effect_unobserved/);
});

test('a revalidated desktop target renews the observation window', async t => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const adapter = { available: true, listChromeWindows: async () => ({ status: 'success', windows: [target] }),
    nativeSnapshot: async () => ({ ...target, status: 'success', dispatched: false, partial: false, controls: [] }) };
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    desktopAdapter: adapter, leaseStateFile: null, agentPolicyFile: null, audit: () => {}, desktopTargetTtlMs: 200
  });
  await bridge.listen(); t.after(() => bridge.close());
  // Negative control: without a call in between, the window really does expire.
  await bridge.call('browser_desktop_windows', {});
  await sleep(260);
  assert.equal((await bridge.call('browser_native_snapshot', target)).reason, 'chrome_target_not_recently_observed');
  // Each revalidation re-lists the windows and matches this exact pair, so it
  // may renew. Without that, three consecutive 10s UI Automation calls outlive
  // the 30s window on their own latency and the third is refused.
  await bridge.call('browser_desktop_windows', {});
  assert.equal((await bridge.call('browser_native_snapshot', target)).status, 'success');
  await sleep(120);
  assert.equal((await bridge.call('browser_native_snapshot', target)).status, 'success');
  await sleep(120);
  assert.equal((await bridge.call('browser_native_snapshot', target)).status, 'success');
});

test('native action shares recent-window validation, single flight, and audit redaction', async t => {
  const audit = [];
  let calls = 0;
  const adapter = { available: true, listChromeWindows: async () => ({ status: 'success', windows: [target] }),
    nativeAction: async () => { calls++; return verified(); } };
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    desktopAdapter: adapter, leaseStateFile: null, agentPolicyFile: null, audit: row => audit.push(row)
  });
  await bridge.listen(); t.after(() => bridge.close());
  const args = { ...target, ref: '42.1', action: 'expand', expect: { name: 'Chrome' } };
  assert.equal((await bridge.call('browser_native_action', args)).reason, 'chrome_target_not_recently_observed');
  assert.equal(calls, 0);
  await bridge.call('browser_desktop_windows', {});
  assert.equal((await bridge.call('browser_native_action', args)).status, 'success');
  assert.equal(calls, 1);
  assert.equal(bridge.status().desktopOperation, null);
  const row = audit.find(item => item.tool === 'browser_native_action' && item.resultStatus === 'success');
  assert.equal(row.dispatched, true);
  // Control names are page-adjacent data; the audit records the verdict, not
  // what the control was called.
  assert.equal(JSON.stringify(audit).includes('Chrome'), false);
});
