import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/locator-resolver.js';

const button = (over = {}) => ({
  ref: 's:1', tag: 'button', role: 'button', text: '提交',
  clickability: 'semantic-control', covered: false, disabled: false,
  left: 10, top: 10, width: 80, height: 30,
  ...over
});

function fixture(overrides = {}) {
  const calls = [];
  const tools = {
    browser_frames: () => ({ frames: [{ frameId: 0, accessible: true }] }),
    browser_find_element: () => ({ found: false, candidates: [], partial: false }),
    browser_find_text: () => ({ found: false, matches: [], matchElements: [], partial: false }),
    browser_shadow_tree: () => ({ shadowRootCount: 0, roots: [], controls: [], partial: false }),
    browser_ax_snapshot: () => ({ status: 'success', nodes: [] }),
    ...overrides
  };
  const callTool = async (name, args) => {
    calls.push(name);
    const handler = tools[name];
    if (!handler) throw new Error(`unexpected tool ${name}`);
    return handler(args);
  };
  return { calls, callTool };
}

test('a single strong candidate is found without paying for the other routes', async () => {
  const { calls, callTool } = fixture({
    browser_find_element: () => ({ found: true, candidates: [button()], partial: false })
  });
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '提交', action: 'click' } });
  assert.equal(result.status, 'found');
  assert.equal(result.selection.ref, 's:1');
  assert.equal(result.ref, 's:1');
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(calls, ['browser_frames', 'browser_find_element']);
  assert.equal(result.nextStep, null);
});

test('an empty complete search on a simple page is not_found', async () => {
  const { callTool } = fixture();
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '不存在的按钮' } });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'no_match_in_complete_scope');
  assert.equal(result.selection, null);
  assert.equal(result.coverage.complete, true);
});

test('a truncated text scan keeps a semantic miss inconclusive', async () => {
  const { callTool } = fixture({
    browser_find_text: () => ({ found: false, matches: [], matchElements: [], partial: true })
  });
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '不存在的按钮' } });
  assert.equal(result.status, 'inconclusive');
  assert.notEqual(result.status, 'not_found');
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.reasons.includes('text_scan_truncated'));
});

test('a truncated scan is never reported as not_found', async () => {
  const { callTool } = fixture({
    browser_find_element: () => ({ found: false, candidates: [], partial: true }),
    browser_shadow_tree: () => ({ shadowRootCount: 2, roots: [], controls: [], partial: true })
  });
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '按钮' } });
  assert.equal(result.status, 'inconclusive');
  assert.notEqual(result.status, 'not_found');
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.reasons.includes('control_scan_truncated'));
  assert.ok(result.coverage.reasons.includes('shadow_scan_truncated'));
});

test('an unsearched frame keeps a miss inconclusive', async () => {
  const { callTool } = fixture({
    browser_frames: () => ({ frames: [{ frameId: 0, accessible: true }, { frameId: 2, accessible: true }] })
  });
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '按钮', frames: 'main' } });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.frames.searched, 'main');
  assert.ok(result.coverage.reasons.includes('frames_not_searched_by_choice'));
});

test('two viable matches are ambiguous, and no ref is presented as the answer', async () => {
  const { callTool } = fixture({
    browser_find_element: () => ({
      found: true, partial: false,
      candidates: [button({ ref: 's:1', left: 10 }), button({ ref: 's:2', left: 400 })]
    })
  });
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '提交', action: 'click' } });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.selection, null);
  assert.equal(result.ref, null);
  assert.equal(result.candidates.length, 2);
  assert.match(result.recommendedNextAction, /do not guess/i);
});

test('blocked injection is reported as blocked, not as a missing element', async () => {
  const blocked = { status: 'blocked', reason: 'page_not_scriptable' };
  const { callTool } = fixture({
    browser_frames: () => ({ ...blocked, frames: [] }),
    browser_find_element: () => blocked,
    browser_find_text: () => blocked,
    browser_shadow_tree: () => blocked
  });
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '按钮' } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'page_not_scriptable');
  assert.equal(result.selection, null);
});

test('accessibility is opt-in, add-only evidence without refs', async () => {
  const { calls, callTool } = fixture({
    browser_find_element: () => ({ found: false, candidates: [], partial: false }),
    browser_ax_snapshot: () => ({
      status: 'success',
      nodes: [{ uid: 'ax1', role: 'button', name: '提交', properties: {} }]
    })
  });
  const result = await resolveTarget({ callTool, args: { tabId: 1, query: '提交', includeAccessibility: true } });
  assert.ok(calls.includes('browser_ax_snapshot'));
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'accessibility_match_without_ref');
  assert.equal(result.accessibility.length, 1);
  assert.equal(result.accessibility[0].ref, null);
  assert.equal(result.selection, null);
});

test('the local ledger sees the run but cannot change the verdict', async () => {
  let recorded = null;
  const { callTool } = fixture({
    browser_find_element: () => ({ found: true, candidates: [button()], partial: false })
  });
  const store = {
    available: true,
    strategyHealth: () => [{ strategy: 'semantic-dom', action: 'click', runs: 3, matched: 2, errors: 0, averageMs: 12 }],
    recordLocateRun: entry => { recorded = entry; return true; }
  };
  const result = await resolveTarget({ callTool, store, args: { tabId: 1, query: '提交', action: 'click' } });
  assert.equal(result.status, 'found');
  assert.equal(result.strategyHealth.length, 1);
  assert.equal(recorded.status, 'found');
  assert.equal(recorded.action, 'click');
  assert.ok(recorded.strategies.length >= 1);
});
