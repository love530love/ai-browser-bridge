// The advisor is the answer to "may I call this now". Its failure mode is not
// crashing - it is confidently saying proceed while a lane, lease or an
// unobserved write makes that unsafe. Every test below pins one of those
// safety boundaries, plus the wait estimates a weak caller relies on instead of
// polling blindly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentAdvice, mergeModelAdvice } from '../src/agent-advice.js';

const host = (overrides = {}) => ({ hostId: 'h1', connected: true, ...overrides });
const queueBase = (overrides = {}) => ({
  connected: true,
  hosts: [host()],
  hostsConnected: 1,
  hostCount: 1,
  activeByHost: [],
  queuedJobs: [],
  tabLeases: [],
  queueLimit: 16,
  ...overrides
});
const advise = ({ queue = {}, ...args } = {}) => buildAgentAdvice({ queue: queueBase(queue), ...args });
const blockerCodes = result => result.blockers.map(item => item.code);

test('an idle queue yields proceed with a ready-to-call step', () => {
  const result = advise({ toolName: 'browser_read', tabId: 4, agent: 'weak' });
  assert.equal(result.status, 'success');
  assert.equal(result.decision, 'proceed');
  assert.equal(result.advisory, true);
  assert.equal(result.authority, 'advisory_only');
  assert.equal(result.nextStep.tool, 'browser_read');
  assert.deepEqual(result.nextStep.arguments, { tabId: 4, agent: 'weak' });
  assert.equal(result.toolTrail[0], 'browser_read');
  assert.equal(result.queue.activeLane, null);
});

test('a busy write lane waits with a measured estimate instead of proceeding', () => {
  const result = advise({
    toolName: 'browser_fill_verified',
    tabId: 9,
    queue: {
      activeByHost: [{ hostId: 'h1', lane: 'write', tool: 'browser_click_verified', tabId: 5, ageMs: 1000 }]
    },
    durations: { browser_click_verified: 4000 }
  });
  assert.equal(result.decision, 'wait');
  assert.equal(result.waitEstimateMs, 3000);
  assert.equal(result.confidence, 'medium');
  assert.deepEqual(blockerCodes(result), ['write_lane_busy']);
  assert.equal(result.nextStep.tool, 'browser_wait_until_ready');
  assert.equal(result.nextStep.arguments.idle, true);
});

test('a write waits for the read lane to drain on the same host', () => {
  const result = advise({
    toolName: 'browser_fill_verified',
    tabId: 9,
    queue: {
      activeByHost: [{ hostId: 'h1', lane: 'read', tool: 'browser_read', tabId: 7, ageMs: 200 }]
    },
    durations: { browser_read: 1200 }
  });
  assert.equal(result.decision, 'wait');
  assert.equal(result.waitEstimateMs, 1000);
  assert.deepEqual(blockerCodes(result), ['read_lane_draining_for_write']);
});

test('a read may run while a write is active on a different tab', () => {
  const result = advise({
    toolName: 'browser_read',
    tabId: 9,
    queue: {
      activeByHost: [{ hostId: 'h1', lane: 'write', tool: 'browser_click_verified', tabId: 5, ageMs: 100 }]
    }
  });
  assert.equal(result.decision, 'proceed');
  assert.equal(result.nextStep.tool, 'browser_read');
});

test('a tab is exclusive even for reads, and the estimate names that tab', () => {
  const result = advise({
    toolName: 'browser_read',
    tabId: 5,
    queue: {
      activeByHost: [{ hostId: 'h1', lane: 'read', tool: 'browser_read', tabId: 5, ageMs: 300 }]
    },
    durations: { browser_read: 1200 }
  });
  assert.equal(result.decision, 'wait');
  assert.equal(result.waitEstimateMs, 900);
  assert.deepEqual(blockerCodes(result), ['same_tab_busy']);
  assert.match(result.why, /tab 5/i);
});

test('a full read fast lane waits for the soonest read to finish', () => {
  const result = advise({
    toolName: 'browser_read',
    tabId: 99,
    queue: {
      activeByHost: [
        { hostId: 'h1', lane: 'read', tool: 'browser_read', tabId: 7, ageMs: 200 },
        { hostId: 'h1', lane: 'read', tool: 'browser_read', tabId: 8, ageMs: 400 }
      ]
    },
    durations: { browser_read: 1200 }
  });
  assert.equal(result.decision, 'wait');
  assert.equal(result.waitEstimateMs, 800);
  assert.deepEqual(blockerCodes(result), ['read_lane_full']);
});

test('another agent holding the tab lease blocks only the write', () => {
  const write = advise({
    toolName: 'browser_fill_verified',
    tabId: 5,
    agent: 'weak',
    queue: { tabLeases: [{ tabId: 5, agent: 'strong', hostId: 'h1' }] }
  });
  assert.equal(write.decision, 'wait');
  assert.deepEqual(blockerCodes(write), ['tab_lease']);
  assert.equal(write.nextStep.tool, 'browser_tab_lease');
  assert.equal(write.nextStep.arguments.tabId, 5);
  assert.equal(write.nextStep.arguments.agent, 'weak');

  const read = advise({
    toolName: 'browser_read',
    tabId: 5,
    agent: 'weak',
    queue: { tabLeases: [{ tabId: 5, agent: 'strong', hostId: 'h1' }] }
  });
  assert.equal(read.decision, 'proceed');
});

test('a full queue is a wait, but a local tool never queues at all', () => {
  const full = queueBase({ queueLimit: 1, queuedJobs: [{ hostId: 'h1', tool: 'browser_read', tabId: 3, readOnly: true }] });
  const queued = buildAgentAdvice({ queue: full, toolName: 'browser_read', tabId: 4 });
  assert.equal(queued.decision, 'wait');
  assert.equal(queued.waitEstimateMs, 3000);
  assert.deepEqual(blockerCodes(queued), ['queue_full']);

  const local = buildAgentAdvice({ queue: { ...full, queued: 2, taskLease: 'strong' }, toolName: 'browser_tool_index', agent: 'weak' });
  assert.equal(local.decision, 'proceed');
  assert.equal(local.nextStep.tool, 'browser_tool_index');
  assert.deepEqual(local.nextStep.arguments, { agent: 'weak' });
});

test('maintenance blocks browser work but not tools answered before the gate', () => {
  const blocked = advise({ toolName: 'browser_read', tabId: 3, queue: { maintenance: true } });
  assert.equal(blocked.decision, 'wait');
  assert.deepEqual(blockerCodes(blocked), ['maintenance']);

  const local = advise({ toolName: 'browser_ocr', tabId: 3, queue: { maintenance: true } });
  assert.equal(local.decision, 'proceed');
});

test('a desktop operation and a global task lease are waits with a human-readable reason', () => {
  const desktop = advise({ toolName: 'browser_read', tabId: 3, queue: { desktopOperation: true } });
  assert.equal(desktop.decision, 'wait');
  assert.deepEqual(blockerCodes(desktop), ['desktop_operation']);

  const leased = advise({ toolName: 'browser_read', tabId: 3, agent: 'weak', queue: { taskLease: 'strong' } });
  assert.equal(leased.decision, 'wait');
  assert.deepEqual(blockerCodes(leased), ['global_task_lease']);
  assert.match(leased.why, /strong/);
});

test('a paused extension and a missing browser ask for different actions', () => {
  const paused = advise({ toolName: 'browser_read', tabId: 3, queue: { connected: false, extensionPaused: true, hosts: [], hostsConnected: 0 } });
  assert.equal(paused.decision, 'escalate');
  assert.deepEqual(blockerCodes(paused), ['extension_paused']);
  assert.match(paused.requiredHumanAction, /重新连接/);
  assert.equal(paused.nextStep, null);

  const missing = advise({ toolName: 'browser_read', tabId: 3, queue: { connected: false, hosts: [], hostsConnected: 0 } });
  assert.equal(missing.decision, 'start_browser');
  assert.equal(missing.nextStep.tool, 'browser_launch');
  assert.deepEqual(blockerCodes(missing), ['no_host_connected']);

  const local = advise({ toolName: 'browser_tool_index', queue: { connected: false, hosts: [], hostsConnected: 0 } });
  assert.equal(local.decision, 'proceed', 'a local tool must not be blocked by a missing browser');
});

test('work is never moved to another browser silently', () => {
  const absent = advise({
    toolName: 'browser_read',
    hostId: 'h2',
    queue: { hosts: [host()] }
  });
  assert.equal(absent.decision, 'wait');
  assert.deepEqual(blockerCodes(absent), ['host_not_connected']);
  assert.equal(absent.nextStep.tool, 'browser_hosts');
  assert.equal(absent.suggestedHostId, undefined);

  const switched = advise({
    toolName: 'browser_read',
    hostId: 'h2',
    allowSwitchHost: true,
    queue: { hosts: [host()] }
  });
  assert.equal(switched.decision, 'switch_host');
  assert.equal(switched.suggestedHostId, 'h1');
  assert.deepEqual(blockerCodes(switched), ['host_not_connected']);

  const closed = advise({
    toolName: 'browser_read',
    tabId: 4,
    hostId: 'h1',
    allowSwitchHost: true,
    queue: { hosts: [{ hostId: 'h1', connected: false }, { hostId: 'h2', connected: true }], hostsConnected: 1 }
  });
  assert.equal(closed.decision, 'wait', 'a known tab must not be moved to a host where its id means another tab');
});

test('an unknown tool name routes to the index instead of a guessed call', () => {
  const result = advise({ toolName: 'browser_typo', goal: 'read the page' });
  assert.equal(result.decision, 'diagnose');
  assert.equal(result.nextStep.tool, 'browser_tool_index');
  assert.match(result.why, /browser_typo/);
});

test('no tool means plan from the goal, or diagnose from the tab list', () => {
  const planned = advise({ goal: '把当前网页保存为 PDF' });
  assert.equal(planned.decision, 'plan');
  assert.equal(planned.nextStep.tool, 'browser_capability_guide');
  assert.ok(planned.toolTrail.includes('browser_pdf_save'));

  const diagnosed = advise({});
  assert.equal(diagnosed.decision, 'diagnose');
  assert.equal(diagnosed.nextStep.tool, 'browser_tabs');
});

test('launching a second browser while one is connected is refused with a diagnosis', () => {
  const result = advise({ toolName: 'browser_launch' });
  assert.equal(result.decision, 'diagnose');
  assert.deepEqual(blockerCodes(result), ['browser_already_connected']);
  assert.equal(result.nextStep.tool, 'browser_hosts');
});

test('an unobserved write becomes a read, never a retry', () => {
  const result = advise({
    toolName: 'browser_fill_verified',
    tabId: 5,
    lastResult: { status: 'uncertain', dispatched: true, reason: 'timeout', tabId: 5 }
  });
  assert.equal(result.decision, 'diagnose');
  assert.equal(result.neverRetry, true);
  assert.equal(result.nextStep.tool, 'browser_read');
  assert.equal(result.nextStep.arguments.tabId, 5);
  assert.ok(blockerCodes(result).includes('uncertain_write'));
});

test('duplicate suppression is a stop even when no tab id is known', () => {
  const specific = advise({
    toolName: 'browser_click_verified',
    tabId: 5,
    lastResult: { status: 'duplicate_suppressed', reason: 'duplicate_suppressed', dispatched: false }
  });
  assert.equal(specific.decision, 'stop');
  assert.equal(specific.neverRetry, true);

  const generic = advise({
    lastResult: { status: 'duplicate_suppressed', reason: 'duplicate_suppressed', dispatched: false }
  });
  assert.equal(generic.decision, 'stop');
  assert.equal(generic.neverRetry, true);
});

test('an unobserved write with no tool or tab is still not a proceed', () => {
  const result = advise({ lastResult: { status: 'uncertain', dispatched: true } });
  assert.equal(result.decision, 'diagnose');
  assert.equal(result.neverRetry, true);
  assert.ok(blockerCodes(result).includes('uncertain_write'));
});

test('the chrome triage call is queue metadata only and cannot execute', () => {
  const result = advise({ toolName: 'browser_read', tabId: 3, goal: '读取列表' });
  assert.equal(result.chromeTriage.provider, 'chrome-built-in-ai');
  assert.equal(result.chromeTriage.arguments.mode, 'triage');
  assert.equal(result.chromeTriage.arguments.observation, 'queue-only triage; no page text supplied');
  assert.equal(result.chromeTriage.arguments.queue.activeCount, 0);
  assert.ok(!JSON.stringify(result.chromeTriage.arguments).includes('BEGIN PAGE CONTENT'));
  assert.match(result.contentTrust, /no page text/i);
  assert.equal(result.modelContext.requestedTool, 'browser_read');
});

test('a model opinion can add caution but cannot turn a wait into a proceed', () => {
  const waiting = advise({
    toolName: 'browser_fill_verified',
    tabId: 9,
    queue: { activeByHost: [{ hostId: 'h1', lane: 'write', tool: 'browser_click_verified', tabId: 5, ageMs: 100 }] }
  });
  const mergedWait = mergeModelAdvice(waiting, {
    status: 'success',
    advice: { decision: 'proceed', waitMs: 0, nextTool: 'browser_fill_verified', why: 'queue looks short', confidence: 'high' }
  });
  assert.equal(mergedWait.decision, 'wait');
  assert.equal(mergedWait.modelCaution, undefined);

  const proceeding = advise({ toolName: 'browser_read', tabId: 4, goal: '点击按钮' });
  const mergedProceed = mergeModelAdvice(proceeding, {
    status: 'success',
    advice: { decision: 'wait', waitMs: 750, nextTool: 'browser_click_verified', why: 'page may be mid-render', confidence: 'medium' }
  });
  assert.equal(mergedProceed.decision, 'proceed');
  assert.match(mergedProceed.modelCaution, /750 ms/);
  assert.equal(mergedProceed.modelSuggestedTool, 'browser_click_verified');
  assert.ok(mergedProceed.modelSuggestedStep);
});

test('a model cannot introduce a tool that was not a candidate', () => {
  const result = advise({ toolName: 'browser_read', tabId: 4, goal: '点击按钮' });
  const merged = mergeModelAdvice(result, {
    status: 'success',
    advice: { decision: 'proceed', waitMs: null, nextTool: 'browser_shell', why: 'run a command', confidence: 'high' }
  });
  assert.equal(merged.modelSuggestedTool, undefined);
  assert.equal(merged.modelSuggestedStep, undefined);
  assert.equal(merged.decision, 'proceed');
});

test('a failed model call leaves the deterministic advice untouched', () => {
  const result = advise({ toolName: 'browser_read', tabId: 4 });
  for (const model of [null, { status: 'unavailable', reason: 'local_model_timeout' }]) {
    const merged = mergeModelAdvice(result, model);
    assert.equal(merged.decision, 'proceed');
    assert.equal(merged.modelCaution, undefined);
    assert.equal(merged.modelSuggestedStep, undefined);
  }
});
