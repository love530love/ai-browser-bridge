// Opening DevTools was refused for several versions because the only path was a
// synthesised F12 during a focus race. This pins the replacement: a menu walk
// bound to elements, one invoke, and a verdict taken from observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setDevToolsState } from '../src/devtools-menu.js';
import { TOOLS } from '../src/tools.js';

const target = { processId: 11, windowHandle: 12 };
const menuButton = { ref: 'r1', name: 'Customize and control Google Chrome', role: 'ControlType.Button',
  automationId: 'view_1007', state: { expandCollapse: 'Collapsed' } };
const moreTools = { ref: 'r2', name: 'More tools', role: 'ControlType.MenuItem' };
const devtoolsItem = { ref: 'r3', name: 'Developer tools Ctrl+Shift+I', role: 'ControlType.MenuItem' };

function harness({ initiallyOpen = false, invokeChangesState = true, invokeResult = null, partial = false, controls } = {}) {
  let open = initiallyOpen;
  const calls = [];
  const observe = async () => ({ status: 'success', evidence: { devtoolsOpen: open, devtoolsState: open ? 'open' : 'unknown',
    partial, devtoolsDocumentCount: open ? 1 : 0, nodesVisited: 175, panels: open ? ['Elements', 'Console'] : [] } });
  const snapshot = async () => ({ status: 'success', controls: controls ?? [menuButton, moreTools, devtoolsItem] });
  const act = async args => {
    calls.push({ action: args.action, ref: args.ref, expect: args.expect });
    if (args.action === 'invoke') {
      if (invokeResult) return invokeResult;
      // The real control is a toggle. Modelling that here is what makes the
      // "do not repeat" rule testable rather than aspirational.
      if (invokeChangesState) open = !open;
      return { status: 'success', dispatched: true, verified: true, controlGone: true, settleMs: 400 };
    }
    return { status: 'success', dispatched: true, verified: true, stateBefore: 'Collapsed', stateAfter: 'Expanded' };
  };
  return { calls, observe, snapshot, act, isOpen: () => open };
}

test('opening DevTools walks the browser menu and is confirmed by observation', async () => {
  const h = harness();
  const result = await setDevToolsState(target, { want: 'open', ...h });
  assert.equal(result.status, 'success');
  assert.equal(result.verified, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.method, 'chrome_menu_uia');
  assert.equal(result.focusRequired, false);
  // The verdict comes from the DevTools observation, not from the click.
  assert.equal(result.before.devtoolsOpen, false);
  assert.equal(result.after.devtoolsOpen, true);
  assert.deepEqual(result.steps.map(step => step.step), ['invoke_developer_tools']);
  // Exactly one dispatch, and it is the menu item - no keystroke anywhere.
  assert.deepEqual(h.calls.map(call => call.action), ['expand', 'expand', 'invoke']);
  assert.deepEqual(h.calls[2].expect, { name: 'Developer tools Ctrl+Shift+I', afterInvoke: 'control_gone' });
});

test('a request for the state that already holds dispatches nothing', async () => {
  const openHarness = harness({ initiallyOpen: true });
  const alreadyOpen = await setDevToolsState(target, { want: 'open', ...openHarness });
  assert.equal(alreadyOpen.status, 'success');
  assert.equal(alreadyOpen.dispatched, false);
  assert.equal(alreadyOpen.alreadyInState, true);
  assert.equal(openHarness.calls.length, 0);

  const closedHarness = harness({ initiallyOpen: false });
  const alreadyClosed = await setDevToolsState(target, { want: 'closed', ...closedHarness });
  assert.equal(alreadyClosed.status, 'success');
  assert.equal(alreadyClosed.dispatched, false);
  assert.equal(closedHarness.calls.length, 0);
});

test('closing is claimed only after a complete walk finds no DevTools', async () => {
  const clean = harness({ initiallyOpen: true });
  const closed = await setDevToolsState(target, { want: 'closed', ...clean });
  assert.equal(closed.status, 'success');
  assert.equal(closed.after.devtoolsOpen, false);
  assert.equal(closed.after.partial, false);

  // A walk that gave up early also finds nothing. That is not evidence of
  // closure, and the result must not pretend otherwise.
  const partial = harness({ initiallyOpen: true, partial: true });
  const unsure = await setDevToolsState(target, { want: 'closed', ...partial });
  assert.equal(unsure.status, 'uncertain');
  assert.equal(unsure.verified, false);
  assert.equal(unsure.reason, 'devtools_close_unverified_partial_walk');
  assert.equal(unsure.dispatched, true);
});

test('an invoke that is not confirmed stops the flow and forbids a repeat', async () => {
  const h = harness({ invokeResult: { status: 'not_dispatched', dispatched: false, reason: 'native_control_disabled' } });
  const result = await setDevToolsState(target, { want: 'open', ...h });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.dispatched, false);
  assert.equal(result.failedStep, 'invoke_developer_tools');
  assert.match(result.note, /toggle/i);
  assert.equal(h.calls.filter(call => call.action === 'invoke').length, 1);
});

test('a toggle that did not change anything is uncertain, never success', async () => {
  const h = harness({ initiallyOpen: true, invokeChangesState: false });
  const result = await setDevToolsState(target, { want: 'closed', ...h });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatched, true);
  assert.equal(result.reason, 'devtools_still_open');
  assert.match(result.note, /do not repeat/i);
});

test('an unidentified menu button is refused instead of opening a stranger menu', async () => {
  const stranger = { ref: 'x1', name: 'Some other toolbar button', role: 'ControlType.Button',
    automationId: 'view_9999', state: { expandCollapse: 'Collapsed' } };
  const h = harness({ controls: [stranger, moreTools, devtoolsItem] });
  const result = await setDevToolsState(target, { want: 'open', ...h });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason, 'chrome_menu_not_found');
  assert.equal(h.calls.length, 0);
});

test('a missing submenu item is reported as that, not as a DevTools failure', async () => {
  const h = harness({ controls: [menuButton, { ...moreTools, name: 'Something else' }] });
  const result = await setDevToolsState(target, { want: 'open', ...h });
  assert.equal(result.reason, 'more_tools_item_not_found');
  assert.equal(result.failedStep, 'find_more_tools');
});

test('the tool exposes open and close but never a toggle', () => {
  const tool = TOOLS.find(item => item.name === 'browser_devtools');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['observe', 'select_panel', 'open', 'close']);
  assert.match(tool.description, /toggle/i);
  // The F12 lesson stays visible in the description: a synthesised keystroke
  // races with focus, so the path is element-bound patterns.
  assert.match(tool.description, /focus race/);
  const source = readFileSync(new URL('../src/devtools-menu.js', import.meta.url), 'utf8');
  assert.equal(/SendKeys|SetForegroundWindow/.test(source), false);
});
