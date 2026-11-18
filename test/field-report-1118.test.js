// The 2026-11-18 field report (competition registration) exposed four ways a
// verified write could answer a question the caller did not ask: an expectation
// that only described one of several legitimate submit outcomes, a commandId
// that replayed an old answer after the arguments changed, a toast that counted
// as "already satisfied", and a DOM .click() outside the ledger. What can be
// checked without a browser is checked here; the page side is pinned to the
// line that has to exist, the same way test/login-readback.test.js does it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCall, TOOLS } from '../src/tools.js';
import { nextStepFor } from '../src/next-step.js';

const page = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const tools = new Map(TOOLS.map(tool => [tool.name, tool]));

test('P0: one expectation can describe a submit that may navigate, error inline, or only send a request', () => {
  const expect = {
    anyOf: [
      { urlContains: '/MyCompetitions' },
      { textAppears: '报名成功', stableForMs: 300 },
      { elementLabelAppears: '待审核' }
    ],
    anyChange: true
  };
  validateCall('browser_click_verified', { tabId: 1, ref: 'e1', expect });
  validateCall('browser_eval_verified', { tabId: 1, expression: 'el.click()', expect });
  // A branch has to say what it observes; stableForMs alone is a modifier.
  assert.throws(
    () => validateCall('browser_click_verified', { tabId: 1, ref: 'e1', expect: { anyOf: [{ stableForMs: 300 }] } }),
    /anyOf .*needs at least one observable condition|Invalid expect condition/
  );
  // Six alternatives is the ceiling; a submit does not have more outcomes than that.
  assert.throws(
    () => validateCall('browser_click_verified', {
      tabId: 1, ref: 'e1', expect: { anyOf: Array.from({ length: 7 }, () => ({ textAppears: 'x' })) }
    }),
    /anyOf must be a non-empty array/
  );
  // stableForMs alone would have nothing to hold for 300 ms.
  assert.throws(
    () => validateCall('browser_click_verified', { tabId: 1, ref: 'e1', expect: { stableForMs: 300 } }),
    /at least one observable condition/
  );
});

test('P0: the page reports where a condition matched, so a toast is not mistaken for the result', () => {
  assert.match(page, /const evaluateSimpleExpectation = /);
  assert.match(page, /matchedIn/);
  assert.match(page, /transient: true/);
  assert.match(page, /const classifyChange = /);
  assert.match(page, /validationState/);
  assert.match(page, /const expectationState = /);
  assert.match(page, /expect\.anyOf/);
  assert.match(page, /expect\.anyChange/);
  assert.match(page, /stableForMs/);
  // outcome is a verdict after the fact, not another condition.
  assert.match(worker, /outcome: 'navigated'/);
  assert.match(page, /validation_error/);
});

test('P1: select_verified and choose_verified are dispatchable, not just advertised', () => {
  // They had page implementations in 0.46.0 but were absent from the worker's
  // command allow-list, so every call returned "Unknown command".
  assert.match(worker, /'browser_select', 'browser_select_verified', 'browser_choose', 'browser_choose_verified', 'browser_pick'/);
  const writeSet = worker.slice(worker.indexOf('const pageWriteTools'), worker.indexOf('const pageWriteTools') + 700);
  assert.match(writeSet, /browser_select_verified/);
  assert.match(writeSet, /browser_choose_verified/);
  // Both now share the caller's expectation for the pre-dispatch check and
  // report an outcome (not just "verification succeeded").
  const selectBranch = page.slice(page.indexOf("if (name === 'browser_select_verified')"), page.indexOf("if (name === 'browser_choose_verified')"));
  assert.match(selectBranch, /expectationState\(expect, valueContext\)/);
  assert.match(selectBranch, /outcome/);
  const chooseBranch = page.slice(page.indexOf("if (name === 'browser_choose_verified')"), page.indexOf("throw new Error('Unsupported page operation')"));
  assert.match(chooseBranch, /expectationState\(expect, valueContext\)/);
  assert.match(chooseBranch, /outcome/);
});

test('P0: browser_action_verified runs on the shared expectation engine', () => {
  const start = worker.indexOf("if (name === 'browser_action_verified')");
  const end = worker.indexOf("if (name === 'browser_close')");
  assert.ok(start > 0 && end > start, 'the action_verified branch must be locatable');
  const branch = worker.slice(start, end);
  assert.match(branch, /page\('browser_expect', \{ expect: args\.expect, wantBaseline: true \}\)/);
  assert.match(branch, /page\('browser_expect_verify'/);
  assert.match(branch, /matchedIn: pre\.matchedIn/);
  assert.match(branch, /outcome = verification\.change\?\.changed/);
  // The legacy executeScript baseline could not see anyOf/anyChange and
  // declared those expectations already satisfied without dispatching.
  assert.doesNotMatch(branch, /chrome\.tabs\.executeScript/);
  assert.doesNotMatch(branch, /baselineSatisfied/);
});

test('P0: a reused commandId with different arguments is refused with a fresh one', () => {
  assert.match(server, /reason: 'command_id_params_mismatch'/);
  assert.match(server, /suggestedCommandId/);
  assert.match(server, /changedArgs/);
  // Only digests travel: the ledger must not keep the argument text.
  assert.match(server, /createHash\('sha256'\)\.update\(stableStringify\(args\[key\]\)\)/);
  assert.match(server, /paramDigests/);
  const step = nextStepFor(
    'browser_click_verified',
    { tabId: 3, ref: 'e1', expect: { textAppears: '报名成功' }, commandId: 'wudang-submit-1' },
    {
      status: 'denied',
      reason: 'command_id_params_mismatch',
      suggestedCommandId: 'fresh-id',
      changedArgs: ['expect']
    }
  );
  assert.equal(step.rule, 'command_id_params_mismatch');
  assert.equal(step.kind, 'retry_with_changes');
  assert.equal(step.arguments.commandId, 'fresh-id');
  assert.ok(!JSON.stringify(step).includes('wudang-submit-1'), 'the stale id must not be sent again');
});

test('P1: a JS-driven click is an audited write, and void links are not an origin escape', () => {
  const tool = tools.get('browser_eval_verified');
  assert.ok(tool, 'browser_eval_verified must exist');
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.deepEqual(tool.inputSchema.required, ['tabId', 'expression', 'expect']);
  validateCall('browser_eval_verified', {
    tabId: 1,
    expression: 'document.querySelector(".el-radio__original").click()',
    expect: { anyChange: true }
  });
  assert.throws(
    () => validateCall('browser_eval_verified', { tabId: 1, expression: 'x()' }),
    /Missing argument: expect/
  );
  // The read-only probe stays read-only; only the _verified branch records a write.
  assert.match(worker, /browser_eval_verified/);
  assert.match(worker, /mechanism: 'js_eval'|mechanism:"js_eval"/);
  // A javascript:void(0) anchor is an inert inline handler, not another origin.
  assert.match(page, /javascript:void\(0\)/);
  assert.match(page, /inlineNavigation/);
});

test('P2: an element can be captured enlarged without injecting an overlay', () => {
  const tool = tools.get('browser_capture_element');
  assert.ok(tool, 'browser_capture_element must exist');
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required, ['tabId', 'ref']);
  assert.equal(tool.inputSchema.properties.scale.maximum, 8);
  assert.match(worker, /browser_capture_element/);
  assert.match(worker, /browser_element_box/);
  // The zoom is a clip on the page, never a DOM node the page can see.
  assert.match(page, /browser_element_box/);
  assert.ok(!page.includes('__capzoom'), 'the overlay workaround must not be baked into the bridge');
});

test('P2: hidden toasts are evidence, not live notices, and never satisfy an expectation', () => {
  assert.match(page, /notices: noticeScan\.live/);
  assert.match(page, /staleNotices: noticeScan\.stale/);
  assert.match(page, /const NOTICE_SELECTOR = /);
  // The same computed-visibility gate has to be used by the matcher, or a
  // hidden toast could still answer textAppears.
  assert.match(page, /const findTextMatch = /);
  assert.match(page, /aria-hidden/);
  assert.match(page, /getComputedStyle/);
});
