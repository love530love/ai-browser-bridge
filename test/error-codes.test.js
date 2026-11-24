// The failure vocabulary: every failure result carries a stable code, and a
// command that runs out its budget is classified by the party that observed
// the tab, not left as a bare timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ERROR_CODES, ERROR_CODE_GUIDE, codeForReason, applyErrorCode } from '../src/error-codes.js';
import { failureHelp } from '../src/failure-help.js';

const workerSource = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const asyncDecl = `async function ${name}(`;
  const decl = source.includes(asyncDecl) ? asyncDecl : `function ${name}(`;
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `must declare ${decl}`);
  const paramsOpen = source.indexOf('(', start);
  let paren = 0;
  let closeParen = -1;
  for (let i = paramsOpen; i < source.length; i++) {
    if (source[i] === '(') paren++;
    else if (source[i] === ')' && --paren === 0) { closeParen = i; break; }
  }
  assert.ok(closeParen > 0, `${name} parameter list must close`);
  const open = source.indexOf('{', closeParen);
  assert.ok(open > 0, `${name} must have a body`);
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

// The paint-dependent and timer-dependent sets live next to the classifier, so
// the test extracts the real declarations instead of restating them.
const paintSetSource = workerSource.match(/const PAINT_DEPENDENT_TOOLS = new Set\(\[[^\]]*\]\);/)?.[0];
assert.ok(paintSetSource, 'worker must declare PAINT_DEPENDENT_TOOLS');
const timerSetSource = workerSource.match(/const TIMER_OR_PAINT_DEPENDENT_EVAL = new Set\(\[[^\]]*\]\);/)?.[0];
assert.ok(timerSetSource, 'worker must declare TIMER_OR_PAINT_DEPENDENT_EVAL');
const classifySource = extractFunction(workerSource, 'classifyCommandTimeout');
const context = {};
vm.createContext(context);
vm.runInContext(`${paintSetSource}\n${timerSetSource}\n${classifySource}\nthis.classifyCommandTimeout = classifyCommandTimeout;`, context);
const classify = context.classifyCommandTimeout;

const visibleProbe = { available: true, tabActive: true, tabStatus: 'complete', discarded: false, pendingUrl: null, windowId: 1, windowFocused: true, windowState: 'normal', windowError: null };
const hiddenProbe = { available: true, tabActive: false, tabStatus: 'complete', discarded: false, pendingUrl: null, windowId: 1, windowFocused: false, windowState: 'normal', windowError: null };

test('reason mapping covers every documented family', () => {
  assert.equal(codeForReason('extension_disconnected'), ERROR_CODES.HOST_FLAPPED);
  assert.equal(codeForReason('tab_paused_by_debugger'), ERROR_CODES.DEBUGGER_STUCK);
  assert.equal(codeForReason('devtools_already_attached'), ERROR_CODES.DEBUGGER_STUCK);
  assert.equal(codeForReason('eval_blocked_by_page_csp'), ERROR_CODES.CSP_BLOCKED);
  assert.equal(codeForReason('No tab with id: 7'), ERROR_CODES.TARGET_GONE);
  assert.equal(codeForReason('page_not_foreground'), ERROR_CODES.TAB_OCCLUDED);
  assert.equal(codeForReason('clipboard_needs_visible_document'), ERROR_CODES.TAB_OCCLUDED);
  assert.equal(codeForReason('read_timeout'), ERROR_CODES.TIMEOUT_UNKNOWN);
  assert.equal(codeForReason('command_timeout'), ERROR_CODES.TIMEOUT_UNKNOWN);
});

test('scheduling waits and non-failures never earn an error code', () => {
  assert.equal(codeForReason('service_busy'), null);
  assert.equal(codeForReason('queue_wait_timeout'), null);
  assert.equal(codeForReason('user_aborted'), null);
  assert.equal(codeForReason(''), null);
  assert.equal(codeForReason(null), null);
});

test('applyErrorCode fills only the gap and never overwrites a producer code', () => {
  assert.equal(applyErrorCode({ status: 'waiting', reason: 'extension_disconnected' }).code, ERROR_CODES.HOST_FLAPPED);
  assert.equal(applyErrorCode({ status: 'uncertain' }, { error: 'Connection lost; outcome may be unknown.' }).code, ERROR_CODES.HOST_FLAPPED);
  assert.equal(applyErrorCode({ status: 'failed', reason: 'command_timeout', code: ERROR_CODES.TAB_OCCLUDED }).code, ERROR_CODES.TAB_OCCLUDED);
  assert.equal(applyErrorCode({ status: 'waiting', reason: 'service_busy' }).code, undefined);
  assert.equal(applyErrorCode([{ reason: 'read_timeout' }]) instanceof Array, true);
  assert.equal(applyErrorCode(null), null);
  assert.equal(applyErrorCode({ status: 'waiting', reason: 'service_busy' }, { error: 'read_timeout' }).code, ERROR_CODES.TIMEOUT_UNKNOWN);
});

test('every code has one guidance entry with retry semantics', () => {
  for (const code of Object.values(ERROR_CODES)) {
    const guide = ERROR_CODE_GUIDE[code];
    assert.ok(guide, `${code} must have guidance`);
    assert.ok(guide.family && guide.meaning && guide.nextAction, `${code} guidance must be actionable`);
    assert.ok(['read_only', 'never'].includes(guide.retryPolicy), `${code} retryPolicy must be explicit`);
  }
});

test('paint-dependent capture that times out hidden reports TAB_OCCLUDED as observation, not causation', () => {
  const out = classify({ name: 'browser_screenshot', readOnly: true, probe: hiddenProbe, debuggerPaused: null, budgetMs: 20000, elapsedMs: 18400 });
  assert.equal(out.code, ERROR_CODES.TAB_OCCLUDED);
  assert.equal(out.status, 'waiting');
  assert.equal(out.retryable, true);
  assert.equal(out.dispatched, null);
  assert.equal(out.evidence.stage, 'extension_command_timeout');
  assert.equal(out.evidence.occlusion.hidden, true);
  assert.equal(out.evidence.occlusion.cause, 'unconfirmed');
  assert.match(out.recommendedNextAction, /Do not activate the window or tab/);
});

test('a background-safe read that times out hidden stays TIMEOUT_UNKNOWN, with the same evidence', () => {
  const out = classify({ name: 'browser_read', readOnly: true, probe: hiddenProbe, debuggerPaused: null, budgetMs: 20000, elapsedMs: 18400 });
  assert.equal(out.code, ERROR_CODES.TIMEOUT_UNKNOWN);
  assert.equal(out.evidence.occlusion.hidden, true);
  assert.match(out.recommendedNextAction, /smaller budgets/);
});

test('a hidden-tab eval timeout names timer throttling instead of guessing the page failed', () => {
  const readOut = classify({ name: 'browser_eval', readOnly: true, probe: hiddenProbe, debuggerPaused: null, budgetMs: 20000, elapsedMs: 18400 });
  assert.equal(readOut.status, 'waiting');
  assert.equal(readOut.evidence.timerThrottling.visibilityState, 'hidden');
  assert.match(readOut.recommendedNextAction, /one synchronous expression/);
  const writeOut = classify({ name: 'browser_eval_verified', readOnly: false, probe: hiddenProbe, debuggerPaused: null, budgetMs: 20000, elapsedMs: 18400 });
  assert.equal(writeOut.status, 'uncertain');
  assert.equal(writeOut.retryable, false);
  assert.equal(writeOut.evidence.timerThrottling.visibilityState, 'hidden');
  assert.match(writeOut.recommendedNextAction, /never replay it automatically/);
});

test('a missing tab is TARGET_GONE; an unavailable probe never invents tab state', () => {
  const gone = classify({ name: 'browser_read', readOnly: true, probe: { available: false, reason: 'tab_missing', detail: 'No tab with id: 9' }, debuggerPaused: null, budgetMs: 20000, elapsedMs: 19000 });
  assert.equal(gone.code, ERROR_CODES.TARGET_GONE);
  assert.equal(gone.evidence.tab, null);
  assert.equal(gone.evidence.probe.reason, 'tab_missing');
  const unknown = classify({ name: 'browser_read', readOnly: true, probe: { available: false, reason: 'probe_timeout' }, debuggerPaused: null, budgetMs: 20000, elapsedMs: 19000 });
  assert.equal(unknown.code, ERROR_CODES.TIMEOUT_UNKNOWN);
  assert.equal(unknown.evidence.occlusion, null);
  assert.equal(unknown.evidence.tab, null);
});

test('a paused debugger session outranks a merely visible tab', () => {
  const out = classify({ name: 'browser_click_verified', readOnly: false, probe: visibleProbe, debuggerPaused: { reason: 'other', autoResumeInMs: 9000 }, budgetMs: 20000, elapsedMs: 18400 });
  assert.equal(out.code, ERROR_CODES.DEBUGGER_STUCK);
  assert.equal(out.status, 'uncertain');
  assert.equal(out.retryable, false);
  assert.equal(out.requiresObservation, true);
  assert.equal(out.evidence.debuggerPaused.autoResumeInMs, 9000);
});

test('a write that times out is uncertain, never dispatched and never replayable', () => {
  const out = classify({ name: 'browser_click_verified', readOnly: false, probe: hiddenProbe, debuggerPaused: null, budgetMs: 20000, elapsedMs: 18400 });
  assert.equal(out.status, 'uncertain');
  assert.equal(out.retryable, false);
  assert.equal(out.requiresObservation, true);
  assert.equal(out.dispatched, null);
  assert.match(out.recommendedNextAction, /Do not replay/);
});

test('the extension watchdog answers inside the service budget and the service marks its own silence', () => {
  // Wiring, not intent: the same budget travels to the extension, the deadline
  // leaves a margin, and the service timer result is explicitly classified.
  assert.match(workerSource, /readOnly: message\.readOnly === true/);
  assert.match(workerSource, /budgetMs: Number\.isFinite\(message\.budgetMs\) \? message\.budgetMs : null/);
  assert.match(workerSource, /const deadlineMs = Math\.max\(500, budgetMs - marginMs\)/);
  assert.match(workerSource, /running\.catch\(\(\) => \{\}\);/);
  assert.match(serverSource, /hostId: job\.hostId, budgetMs, readOnly \}\)\)/);
  assert.match(serverSource, /result = applyErrorCode\(result, \{ error \}\);/);
  assert.match(serverSource, /stage: 'service_read_timeout_after_extension_silence'/);
});

test('failure help keeps its category contract and exposes the code', () => {
  const occluded = failureHelp({ error: 'tab_occluded: document was hidden', attemptedAction: 'browser_screenshot' }, { readOnly: true });
  assert.equal(occluded.category, 'occlusion');
  assert.equal(occluded.code, ERROR_CODES.TAB_OCCLUDED);
  assert.equal(occluded.retryAllowed, true);
  assert.ok(occluded.codeGuide.nextAction.includes('Do not activate'));

  const write = failureHelp({ error: 'browser_click_verified timed out after 20000ms', attemptedAction: 'browser_click_verified' }, { readOnly: false });
  assert.equal(write.category, 'timeout-uncertain');
  assert.equal(write.code, ERROR_CODES.TIMEOUT_UNKNOWN);
  assert.equal(write.retryAllowed, false);
  assert.equal(write.automaticWriteReplayAllowed, false);
});
