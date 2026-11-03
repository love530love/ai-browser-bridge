// A weak caller's failure mode is not "the tool is missing". It is "the tool
// said no and I do not know what else to try", followed by either the same call
// again or an invented one. These tests pin the contract that makes the next
// move mechanical: one executable step, or silence - never a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStepFor, withNextStep, isFailure } from '../src/next-step.js';

const TAB = 7;

test('a success never carries a next step', () => {
  assert.equal(nextStepFor('browser_read', { tabId: TAB }, { status: 'success', text: 'hi' }), null);
  assert.equal(nextStepFor('browser_replay_request', { tabId: TAB }, { status: 'verified', matched: true }), null);
  assert.equal(withNextStep('browser_read', { tabId: TAB }, { status: 'success' }).nextStep, undefined);
});

test('an uncertain write is sent to a read, never to a retry', () => {
  const step = nextStepFor('browser_click', { tabId: TAB, ref: 'e1' }, { status: 'uncertain', dispatched: true });
  assert.equal(step.kind, 'diagnose');
  assert.equal(step.tool, 'browser_read');
  assert.deepEqual(step.arguments, { tabId: TAB, mode: 'cheap' });
  assert.match(step.why, /repeating a write that may have already happened/);
});

test('a picker-card handoff clicks only one exact candidate and reads on ambiguity or prior dispatch', () => {
  const candidate = { ref: 'snapshot:1', match: 'exact', clickability: 'cursor-pointer' };
  const unique = nextStepFor('browser_pick', { tabId: TAB, chooseText: '1 x P800', agent: 'workbuddy' }, {
    status: 'not_found', reason: 'picker_card_candidates', dispatched: false, candidates: [candidate]
  });
  assert.equal(unique.tool, 'browser_click');
  assert.deepEqual(unique.arguments, { tabId: TAB, ref: 'snapshot:1', agent: 'workbuddy' });

  const semantic = nextStepFor('browser_pick', { tabId: TAB, chooseText: '1 x P800' }, {
    status: 'not_found', reason: 'picker_card_candidates', dispatched: false,
    candidates: [{ ...candidate, clickability: 'semantic-control' }]
  });
  assert.equal(semantic.tool, 'browser_read', 'a matching button is not a card-selection proof');

  const ambiguous = nextStepFor('browser_pick', { tabId: TAB, chooseText: '1 x P800' }, {
    status: 'not_found', reason: 'picker_card_candidates', dispatched: false,
    candidates: [candidate, { ...candidate, ref: 'snapshot:2' }]
  });
  assert.equal(ambiguous.tool, 'browser_read');

  const opened = nextStepFor('browser_pick', { tabId: TAB, chooseText: '1 x P800', agent: 'workbuddy' }, {
    status: 'not_found', reason: 'picker_card_candidates', dispatched: true, candidates: [candidate]
  });
  assert.equal(opened.tool, 'browser_read', 'a prior dispatch requires fresh observation even with one exact result');
  assert.deepEqual(opened.arguments, { tabId: TAB, mode: 'cheap', agent: 'workbuddy' });

  const partial = nextStepFor('browser_pick', { tabId: TAB, chooseText: '1 x P800' }, {
    status: 'not_found', reason: 'picker_card_candidates', dispatched: false, candidates: [candidate],
    candidateScan: { partial: true, stoppedBy: 'result_limit' }
  });
  assert.equal(partial.tool, 'browser_read', 'an incomplete scan cannot prove uniqueness');
});

test('download wait timeout and failures never suggest starting or opening another file', () => {
  const timeout = nextStepFor('browser_download_wait', { downloadId: 17, agent: 'workbuddy' }, {
    status: 'in_progress', reason: 'download_wait_timeout', downloadId: 17, retryable: true
  });
  assert.equal(timeout.tool, 'browser_downloads');
  assert.deepEqual(timeout.arguments, { downloadId: 17, limit: 1, agent: 'workbuddy' });

  const missing = nextStepFor('browser_download_wait', { downloadId: 99 }, {
    status: 'not_found', reason: 'download_not_found', downloadId: 99
  });
  assert.equal(missing.kind, 'stop');
  assert.equal(missing.tool, null);

  const interrupted = nextStepFor('browser_download_wait', { downloadId: 21 }, {
    status: 'failed', reason: 'download_interrupted', downloadId: 21
  });
  assert.equal(interrupted.kind, 'stop');
  assert.equal(interrupted.tool, null);
});

test('a covered click points at the overlay scan, not at a second click', () => {
  const step = nextStepFor('browser_click', { tabId: TAB, ref: 'e1' }, { status: 'covered', reason: 'element_covered', dispatched: false });
  assert.equal(step.tool, 'browser_scan_overlays');
  assert.deepEqual(step.arguments, { tabId: TAB });
  assert.match(step.why, /every ref held from before a dismissal is stale/);
});

test('a confirmation refusal hands back the exact string the gate wanted', () => {
  const step = nextStepFor('browser_replay_request',
    { tabId: TAB, method: 'POST', url: 'https://app.test/api/x', agent: 'a1' },
    { status: 'denied', reason: 'explicit_confirmation_required', confirmation: 'replay_request_once', dispatched: false });
  assert.equal(step.kind, 'retry_with_changes');
  assert.equal(step.tool, 'browser_replay_request');
  assert.equal(step.arguments.confirmation, 'replay_request_once');
  assert.equal(step.arguments.url, 'https://app.test/api/x');
  assert.equal(step.arguments.agent, 'a1', 'the caller identity must survive the retry');
  assert.equal(step.arguments.__tool, undefined, 'the internal marker must not be sent to a tool');
});

test('a verify failure sends the caller to read the endpoint instead of resending', () => {
  const step = nextStepFor('browser_replay_request',
    { tabId: TAB, verify: { url: 'https://app.test/api/counter' } },
    { status: 'not_matched', reason: 'verify_expect_not_observed', matched: false, dispatched: true });
  assert.equal(step.tool, 'browser_fetch');
  assert.equal(step.arguments.url, 'https://app.test/api/counter');
  assert.match(step.why, /Do not resend the write/);
});

test('a cross-origin fetch names the tool that is allowed to do it', () => {
  const step = nextStepFor('browser_fetch', { tabId: TAB, url: 'https://other.test/x' },
    { status: 'denied', reason: 'fetch_cross_origin_denied', dispatched: false });
  assert.equal(step.tool, 'browser_replay_request');
  assert.equal(step.arguments.confirmation, 'replay_request_once');
  assert.equal(step.arguments.method, 'GET');
});

test('an ambiguous match goes to the planner rather than picking one', () => {
  const step = nextStepFor('browser_find_element', { tabId: TAB, query: 'Order 40' }, { found: false, ambiguous: true, candidates: [{}, {}] });
  assert.equal(step.tool, 'browser_prepare_action');
  assert.equal(step.arguments.query, 'Order 40');
});

test('an unrendered miss sends the caller to the containers, not to a second search', () => {
  const step = nextStepFor('browser_find_text', { tabId: TAB, query: 'row-39' },
    { found: false, notRendered: { reason: 'not_rendered_possible', containers: [] } });
  assert.equal(step.tool, 'browser_scan_overlays');
  assert.match(step.why, /before concluding the target does not exist/);
});

test('a suppression is a stop, not a failure to work around', () => {
  const step = nextStepFor('browser_click', { tabId: TAB, ref: 'e1' },
    { status: 'duplicate_suppressed', reason: 'duplicate_suppressed', dispatched: false });
  assert.equal(step.kind, 'stop');
  assert.equal(step.tool, null);
  assert.match(step.why, /do not repeat it/);
});

test('transport trouble waits instead of dispatching again', () => {
  for (const reason of ['extension_disconnected', 'queue_full', 'global_agent_task_lease', 'bridge_command_cancelled_or_disconnected']) {
    const step = nextStepFor('browser_click', { tabId: TAB, ref: 'e1' }, { status: 'waiting', reason, dispatched: false });
    assert.equal(step?.tool, 'browser_wait_until_ready', reason);
    assert.equal(step.kind, 'wait');
  }
});

test('taking the foreground is escalated, never decided by the caller', () => {
  const step = nextStepFor('browser_reload_extension', { confirmation: 'reload_extension_once' },
    { status: 'waiting', reason: 'focus_required_for_ui_automation', focusRequired: true, dispatched: false });
  assert.equal(step.kind, 'escalate');
  assert.equal(step.tool, null);
  assert.match(step.why, /their decision/);
});

test('a step that cannot name its arguments is not emitted at all', () => {
  // No tabId anywhere in the call or the result: every useful step needs one,
  // so the honest answer is silence rather than a call that would be refused.
  assert.equal(nextStepFor('browser_click', {}, { status: 'covered', reason: 'element_covered' }), null);
});

test('a failure with no rule stays silent instead of inventing advice', () => {
  assert.equal(nextStepFor('browser_bookmarks', { action: 'list' }, { status: 'failed', reason: 'bookmark_store_unreadable' }), null);
});

test('isFailure does not treat a legitimate empty answer as a failure', () => {
  assert.equal(isFailure({ status: 'success', found: false, matches: [] }), false, 'a finder that found nothing succeeded');
  assert.equal(isFailure({ status: 'success', rows: [] }), false);
  assert.equal(isFailure({ status: 'denied' }), true);
  assert.equal(isFailure({ found: false }), true, 'a bare found:false has no status to say otherwise');
  assert.equal(isFailure(null), false);
});

test('an existing nextStep is never overwritten', () => {
  const kept = { tool: 'custom', arguments: { a: 1 }, why: 'from the tool itself' };
  const result = withNextStep('browser_click', { tabId: TAB }, { status: 'covered', reason: 'element_covered', nextStep: kept });
  assert.deepEqual(result.nextStep, kept);
});

// A thrown failure used to be the path with no guidance at all. Measured on the
// real browser: clicking a stale ref threw "Stale element reference. Read page
// again." over HTTP, the caller got a bare sentence, and the stale_reference
// rule above could never fire because a throw never becomes a result.
test('a thrown failure gets the same single step as a returned one', async () => {
  const { nextStepForError } = await import('../src/next-step.js');
  const stale = nextStepForError('browser_click', { tabId: TAB, ref: 'e1' }, 'Stale element reference. Read page again.');
  assert.equal(stale.rule, 'stale_reference');
  assert.equal(stale.tool, 'browser_read');
  assert.equal(stale.arguments.tabId, TAB, 'the step carries the tab the call was for');

  assert.equal(nextStepForError('browser_click', { tabId: TAB }, 'This operation timed out').kind, 'wait');
  assert.equal(nextStepForError('browser_read', { tabId: TAB }, 'Extension disconnected').kind, 'wait');
  // No matching rule is silence, not a guess.
  assert.equal(nextStepForError('browser_click', { tabId: TAB }, 'Something nobody has seen before'), null);
});

test('the thrown path is wired end to end, not just implemented', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  const mcp = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  assert.match(server, /nextStepForError\(name, args \?\? \{\}, error\?\.message/, 'the service must derive a step for a throw');
  assert.match(server, /json\(res, 400, \{ error: e\.message, .*nextStep/, 'the 400 body must carry it');
  assert.match(client, /error\.nextStep = result\.nextStep/, 'the client must not drop it');
  assert.match(mcp, /nextStep: e\.nextStep/, 'the MCP error text must carry it');
});
