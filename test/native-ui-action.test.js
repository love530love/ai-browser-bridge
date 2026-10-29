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

test('toggle is accepted only as a request for a state, never as a bare flip', () => {
  const tool = TOOLS.find(item => item.name === 'browser_native_action');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['expand', 'collapse', 'invoke', 'toggle', 'select', 'value']);
  assert.deepEqual(tool.inputSchema.properties.desiredState.enum, ['on', 'off']);
  // Toggle was excluded in the first version because repeating a flip undoes
  // the first one. Taking a requested state is what removes that objection:
  // asking for the state the control is already in dispatches nothing, exactly
  // like expand and collapse, so an uncertain result can be retried.
  const base = { processId: 11, windowHandle: 12, ref: '42.1', action: 'toggle', expect: { name: 'Ask where to save' } };
  assert.throws(() => validateCall('browser_native_action', { ...base }), /requires desiredState/);
  assert.throws(() => validateCall('browser_native_action', { ...base, desiredState: 'maybe' }), /desiredState/);
  assert.doesNotThrow(() => validateCall('browser_native_action', { ...base, desiredState: 'on' }));
  // A desired state attached to an action that has no use for it would be
  // silently ignored, which is the same as a gate that does nothing.
  assert.throws(() => validateCall('browser_native_action', { ...base, action: 'expand', desiredState: 'on' }),
    /only applies to action:"toggle"/);
  assert.throws(() => validateCall('browser_native_action', { ...base, action: 'select', desiredState: 'on', itemName: 'x' }),
    /only applies to action:"toggle"/);
  // And the result must name the state it was asked for, so it can be judged.
  assert.throws(() => validateNativeActionResult({ ...target, action: 'toggle', status: 'success', dispatched: true,
    verified: true, alreadyInState: false, toggleStateBefore: 'Off', toggleStateAfter: 'On' }, target), /must name the state/);
});

const toggled = () => ({ ...target, action: 'toggle', desiredState: 'on', status: 'success', dispatched: true,
  verified: true, alreadyInState: false, toggleStateBefore: 'Off', toggleStateAfter: 'On' });

test('a toggle result is judged against the state the caller asked for', () => {
  assert.deepEqual(validateNativeActionResult(toggled(), target), toggled());
  assert.doesNotThrow(() => validateNativeActionResult({ ...toggled(), desiredState: 'off',
    toggleStateBefore: 'On', toggleStateAfter: 'Off' }, target));
  assert.doesNotThrow(() => validateNativeActionResult({ ...toggled(), alreadyInState: true, dispatched: false,
    toggleStateBefore: 'On', toggleStateAfter: 'On' }, target));
  for (const patch of [
    // Asked for on, reached off: the pattern returned, the state did not follow.
    { toggleStateAfter: 'Off' },
    { toggleStateAfter: 'Indeterminate' },
    { toggleStateAfter: 'on' },
    { verified: false },
    { alreadyInState: undefined },
    // "Already there" and "I dispatched it" are mutually exclusive claims.
    { alreadyInState: true },
    { dispatched: false },
    // A refusal cannot borrow the success signal.
    { status: 'uncertain', dispatched: null, verified: false, reason: 'native_action_dispatch_threw', toggleStateAfter: 'On' },
    { status: 'not_dispatched', dispatched: true },
    { status: 'not_dispatched', dispatched: false, stateAfter: 'On' }
  ]) {
    assert.throws(() => validateNativeActionResult({ ...toggled(), ...patch }, target), JSON.stringify(patch));
  }
  // Indeterminate is a real state and a refusal that reports it is honest.
  assert.doesNotThrow(() => validateNativeActionResult({ ...target, action: 'toggle', desiredState: 'on',
    status: 'not_dispatched', dispatched: false, reason: 'native_toggle_indeterminate',
    toggleStateBefore: 'Indeterminate' }, target));
});

const selected = () => ({ ...target, action: 'select', itemName: 'Ask where to save',
  status: 'success', dispatched: true, verified: true, alreadyInState: false,
  selectionBefore: ['Downloads'], selectionAfter: ['Ask where to save'] });

test('a select result is judged by reading the selection back', () => {
  assert.deepEqual(validateNativeActionResult(selected(), target), selected());
  assert.doesNotThrow(() => validateNativeActionResult({ ...selected(), alreadyInState: true, dispatched: false,
    selectionBefore: ['Ask where to save'], selectionAfter: ['Ask where to save'] }, target));
  for (const patch of [
    { selectionAfter: ['Downloads'] },
    { selectionAfter: [] },
    { selectionAfter: undefined },
    { itemName: '' },
    { itemName: 'x'.repeat(121) },
    { selectionAfter: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
    { selectionAfter: [7] },
    { verified: false },
    { dispatched: false },
    { alreadyInState: true },
    // A refusal that already reports the item as selected is a contradiction.
    { status: 'uncertain', dispatched: true, verified: false, reason: 'native_selection_not_reached' },
    { status: 'not_dispatched', dispatched: false, selectionAfter: ['Ask where to save'] }
  ]) {
    assert.throws(() => validateNativeActionResult({ ...selected(), ...patch }, target), JSON.stringify(patch));
  }
});

const valued = () => ({ ...target, action: 'value', status: 'success', dispatched: true, verified: true,
  alreadyInState: false, valueBefore: 'old', valueAfter: 'new', valueLength: 3, valueMatches: true });

test('a value result is judged by valueMatches, not by the clipped echo', () => {
  assert.deepEqual(validateNativeActionResult(valued(), target), valued());
  assert.doesNotThrow(() => validateNativeActionResult({ ...valued(), alreadyInState: true, dispatched: false,
    valueBefore: 'new', valueAfter: 'new' }, target));
  for (const patch of [
    // The echoed text is clipped at 200 characters, so equality of the echo can
    // never be the success criterion - the adapter compares the full strings.
    { valueMatches: false },
    { valueMatches: undefined },
    { valueLength: undefined },
    { valueLength: -1 },
    { valueLength: 1.5 },
    { valueAfter: 'x'.repeat(201) },
    { verified: false },
    { dispatched: false },
    { alreadyInState: true },
    { status: 'failed', dispatched: true, verified: false, reason: 'native_value_not_reached' },
    { status: 'not_dispatched', dispatched: false, valueMatches: true }
  ]) {
    assert.throws(() => validateNativeActionResult({ ...valued(), ...patch }, target), JSON.stringify(patch));
  }
});

test('the three state actions refuse to run without the state they were asked for', async () => {
  const base = { processId: 11, windowHandle: 12, ref: '42.1', platform: 'win32', expect: { name: 'Chrome' } };
  await assert.rejects(() => nativeUiAction(target, { ...base, action: 'toggle' }), /desiredState/);
  await assert.rejects(() => nativeUiAction(target, { ...base, action: 'select' }), /itemName/);
  await assert.rejects(() => nativeUiAction(target, { ...base, action: 'select', itemName: 'x'.repeat(121) }), /itemName/);
  await assert.rejects(() => nativeUiAction(target, { ...base, action: 'value' }), /text/);
  // The tool schema refuses them even earlier, before any desktop mutex.
  assert.throws(() => validateCall('browser_native_action', { processId: 11, windowHandle: 12, ref: '1', action: 'value', expect: { name: 'x' } }), /requires text/);
  assert.throws(() => validateCall('browser_native_action', { processId: 11, windowHandle: 12, ref: '1', action: 'select', expect: { name: 'x' } }), /requires itemName/);
  assert.throws(() => validateCall('browser_native_action', { processId: 11, windowHandle: 12, ref: '1', action: 'expand', expect: { name: 'x' }, text: 'y' }), /only applies to action:"value"/);
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
  assert.throws(() => validateCall('browser_native_action', { ...base, action: 'toggle', expect: { name: 'Chrome' } }), /requires desiredState/);
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
  await assert.rejects(() => nativeUiAction(target, { ref: '1', action: 'toggle', platform: 'win32' }), /desiredState/);
});

test('every result echoes the request it was judged against', () => {
  const source = readFileSync(new URL('../scripts/native-ui-action.ps1', import.meta.url), 'utf8');
  // A refusal that cannot name the state it refused reads as an invalid result
  // rather than as a refusal. Measured on a real Chrome window: toggle on the
  // omnibox came back as native_action_invalid_result because that branch never
  // carried the desired state. The validator requires the echo on every result,
  // so the adapter has to emit it on every result - including the refusals.
  // Unit tests build the result object themselves, so they cannot catch this;
  // only the source can be checked for it.
  const blocks = {
    toggle: { start: "if ($Action -eq 'toggle')", end: "if ($Action -eq 'value')", field: 'desiredState' },
    value: { start: "if ($Action -eq 'value')", end: "if ($Action -eq 'select')", field: 'valueLength' },
    select: { start: "if ($Action -eq 'select')", end: '# --- expand / collapse', field: 'itemName' }
  };
  for (const [action, { start, end, field }] of Object.entries(blocks)) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + 1);
    assert.ok(from > 0 && to > from, `could not isolate the ${action} block`);
    const fragments = source.slice(from, to).split('Emit @{').slice(1);
    assert.ok(fragments.length >= 3, `the ${action} block should report several outcomes, found ${fragments.length}`);
    for (const fragment of fragments) {
      assert.match(fragment, new RegExp(field), `a ${action} result does not echo ${field}`);
    }
  }
});

test('the adapter script drives a pattern, never a global keystroke', () => {
  const source = readFileSync(new URL('../scripts/native-ui-action.ps1', import.meta.url), 'utf8');
  assert.match(source, /ExpandCollapsePattern/);
  assert.match(source, /InvokePattern/);
  assert.match(source, /TogglePattern/);
  assert.match(source, /SelectionItemPattern/);
  assert.match(source, /SelectionPattern/);
  assert.match(source, /ValuePattern/);
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
  // Each of the three state actions reads before it writes, which is what makes
  // "already in the requested state" reportable as a non-dispatch.
  assert.match(source, /native_toggle_indeterminate/);
  assert.match(source, /native_control_read_only/);
  assert.match(source, /native_item_not_found/);
  // The missing-request refusals live in the adapter, before spawn, because a
  // refusal that cannot echo the request could not be validated.
  assert.equal(/native_desired_state_required|native_item_name_required/.test(source), false);
  // A text field can hold a document, so the echo is clipped - and the decision
  // is taken over the full strings, never over the clipped echo.
  assert.match(source, /valueMatches = \$true/);
  assert.match(source, /valueMatches = \$false/);
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
