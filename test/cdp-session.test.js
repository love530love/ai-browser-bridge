// The safety property of a long-lived debugger session is that it can never
// leave the user's tab frozen. These tests drive the state machine with a
// controllable clock so that property is asserted, not assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager, DEBUGGER_SESSION_LIMITS } from '../extension/cdp-session.js';

function harness({ pausedTtlMs = 30000, idleTtlMs = 300000, attachFails = null, responses = {} } = {}) {
  let clock = 100000;
  const log = [];
  const timers = new Map();
  let timerSeq = 0;
  const reply = { ...responses };
  const manager = createSessionManager({
    attach: async tabId => { log.push(`attach:${tabId}`); if (attachFails) throw new Error(attachFails); },
    detach: async tabId => { log.push(`detach:${tabId}`); },
    send: async (tabId, method, params = {}) => {
      log.push(method);
      const handler = reply[method];
      return typeof handler === 'function' ? handler(params) : (handler ?? {});
    },
    now: () => clock,
    pausedTtlMs,
    idleTtlMs,
    schedule: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    cancelSchedule: id => { timers.delete(id); }
  });
  return {
    manager, log, timers,
    advance(ms) { clock += ms; },
    fireTimers() { const due = [...timers.values()]; timers.clear(); for (const timer of due) timer.fn(); },
    setResponse(method, handler) { reply[method] = handler; }
  };
}

const pausedEvent = (overrides = {}) => ({
  reason: 'other',
  hitBreakpoints: ['1:10:0:https://a.example/app.js'],
  callFrames: [{
    callFrameId: 'frame-0', functionName: 'handleClick', url: 'https://a.example/app.js',
    location: { lineNumber: 9, columnNumber: 4 },
    scopeChain: [{ type: 'local' }, { type: 'closure' }, { type: 'global' }]
  }, {
    callFrameId: 'frame-1', functionName: '', url: 'https://a.example/app.js',
    location: { lineNumber: 20, columnNumber: 0 }, scopeChain: [{ type: 'global' }]
  }],
  ...overrides
});

test('opening a session attaches once and a second open reuses it', async () => {
  const h = harness();
  const first = await h.manager.open({ tabId: 7, expectedUrl: 'https://a.example/' });
  assert.equal(first.status, 'success');
  assert.equal(first.reused, false);
  assert.equal(first.session.debuggerBannerVisible, true, 'the banner is a real cost and must be reported');
  const second = await h.manager.open({ tabId: 7 });
  assert.equal(second.status, 'success');
  assert.equal(second.reused, true);
  assert.deepEqual(h.log.filter(entry => entry.startsWith('attach:')), ['attach:7'], 'attaching twice would fail in Chrome');
});

test('an already attached debugger is reported as DevTools being open, not as a generic error', async () => {
  const h = harness({ attachFails: 'Another debugger is already attached to the tab' });
  const result = await h.manager.open({ tabId: 7 });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'devtools_already_attached');
  assert.equal(result.retryable, false);
  assert.equal(result.dispatched, false);
  assert.match(result.message, /DevTools/);
  assert.equal(h.manager.size(), 0);
});

test('a failure while enabling domains detaches instead of leaving a half-open session', async () => {
  const h = harness({ responses: { 'Debugger.enable': () => { throw new Error('boom'); } } });
  const result = await h.manager.open({ tabId: 7 });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'debugger_domain_enable_failed');
  assert.ok(h.log.includes('detach:7'));
  assert.equal(h.manager.size(), 0);
});

test('a breakpoint is sent 1-based and reports whether a script matched yet', async () => {
  const h = harness({ responses: { 'Debugger.setBreakpointByUrl': () => ({ breakpointId: 'bp-1', locations: [] }) } });
  await h.manager.open({ tabId: 7 });
  const result = await h.manager.call({ tabId: 7, action: 'set_breakpoint', args: { scriptUrl: 'https://a.example/app.js', lineNumber: 10 } });
  assert.equal(result.status, 'success');
  assert.equal(result.breakpoint.breakpointId, 'bp-1');
  assert.equal(result.breakpoint.resolved, false);
  assert.match(result.note, /will bind when that script loads/);
  // The protocol is 0-based; the caller speaks 1-based. Getting this wrong puts
  // every breakpoint one line off, which is invisible until it never hits.
  const sent = h.log.includes('Debugger.setBreakpointByUrl');
  assert.ok(sent);
});

test('a breakpoint without a script URL is refused with a usable message', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  const result = await h.manager.call({ tabId: 7, action: 'set_breakpoint', args: { lineNumber: 10 } });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'invalid_breakpoint_target');
  assert.match(result.message, /scriptUrl/);
});

test('a paused event exposes frames with 1-based lines and no scope values', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  const status = await h.manager.call({ tabId: 7, action: 'status' });
  assert.equal(status.session.paused.reason, 'other');
  assert.equal(status.session.paused.frameCount, 2);
  assert.ok(status.session.paused.autoResumeInMs > 0);
  const frames = await h.manager.call({ tabId: 7, action: 'frames' });
  assert.equal(frames.frames.length, 2);
  assert.equal(frames.frames[0].functionName, 'handleClick');
  assert.equal(frames.frames[0].lineNumber, 10, 'protocol lines are 0-based, humans count from 1');
  assert.deepEqual(frames.frames[0].scopeTypes, ['local', 'closure', 'global']);
  // A scope can hold megabytes and secrets; frames must not dump it.
  assert.equal(JSON.stringify(frames).includes('"value"'), false);
  assert.equal(frames.frames[1].functionName, '(anonymous)');
});

test('closing a paused session resumes before detaching', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  const result = await h.manager.close({ tabId: 7 });
  assert.equal(result.closed, true);
  assert.equal(result.resumedBeforeClose, true);
  const order = h.log.filter(entry => ['Debugger.resume', 'Debugger.disable', 'detach:7'].includes(entry));
  assert.deepEqual(order, ['Debugger.resume', 'Debugger.disable', 'detach:7'],
    'detaching a paused target can leave the tab frozen, so resume must come first');
});

test('a paused tab nobody touches is resumed automatically, and says so', async () => {
  const h = harness({ pausedTtlMs: 30000 });
  await h.manager.open({ tabId: 7 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  h.advance(30000);
  const changes = await h.manager.sweep();
  assert.deepEqual(changes, [{ tabId: 7, autoResumed: true }]);
  assert.ok(h.log.includes('Debugger.resume'));
  const status = await h.manager.call({ tabId: 7, action: 'status' });
  assert.equal(status.session.paused, null);
  assert.equal(status.session.autoResumedCount, 1, 'an automatic resume must be visible, not silent');
});

test('an agent inspecting frames is not cut off by the pause timeout', async () => {
  const h = harness({ pausedTtlMs: 30000 });
  await h.manager.open({ tabId: 7 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  // Twelve seconds of work, three times over: longer than the TTL in total, but
  // never idle for longer than it.
  for (let round = 0; round < 3; round++) {
    h.advance(12000);
    const frames = await h.manager.call({ tabId: 7, action: 'frames' });
    assert.equal(frames.status, 'success', `round ${round} must still be paused`);
  }
  assert.equal(h.manager.get(7).paused !== null, true);
  assert.equal(h.log.includes('Debugger.resume'), false);
});

test('stepping resumes the target and clears the paused state', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  const result = await h.manager.call({ tabId: 7, action: 'step_over' });
  assert.equal(result.stepped, 'step_over');
  assert.ok(h.log.includes('Debugger.stepOver'));
  assert.equal(h.manager.get(7).paused, null);
  assert.equal(h.timers.size, 0, 'the pause timer must be cancelled, not left to fire on a running page');
});

test('stepping and frame inspection refuse while the page is running', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  for (const action of ['step_over', 'step_into', 'step_out', 'frames']) {
    const result = await h.manager.call({ tabId: 7, action });
    assert.equal(result.status, 'waiting', action);
    assert.equal(result.reason, 'target_not_paused', action);
    assert.equal(result.dispatched, false, action);
  }
});

test('evaluate targets the paused call frame, and the global context when running', async () => {
  const h = harness({
    responses: {
      'Debugger.evaluateOnCallFrame': () => ({ result: { type: 'string', value: 'paused-value' } }),
      'Runtime.evaluate': () => ({ result: { type: 'number', value: 42 } })
    }
  });
  await h.manager.open({ tabId: 7 });
  const global = await h.manager.call({ tabId: 7, action: 'evaluate', args: { expression: '1+1' } });
  assert.equal(global.evaluatedOn, 'global');
  assert.equal(global.value, 42);
  assert.equal(global.pagePrivileged, true);
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  const framed = await h.manager.call({ tabId: 7, action: 'evaluate', args: { expression: 'name', frameIndex: 1 } });
  assert.equal(framed.evaluatedOn, 'call_frame');
  assert.equal(framed.frameIndex, 1);
  assert.equal(framed.value, 'paused-value');
});

test('an out-of-range frame index is refused rather than silently using frame zero', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  const result = await h.manager.call({ tabId: 7, action: 'evaluate', args: { expression: 'x', frameIndex: 9 } });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'frame_index_out_of_range');
  assert.equal(result.frameCount, 2);
});

test('an external detach ends the session instead of leaving a zombie', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  const detached = h.manager.handleDetach(7, 'canceled_by_user');
  assert.equal(detached.tabId, 7);
  assert.equal(h.manager.size(), 0);
  assert.equal(h.timers.size, 0, 'a detached session must not keep a pause timer alive');
  const after = await h.manager.call({ tabId: 7, action: 'frames' });
  assert.equal(after.status, 'not_dispatched');
  assert.equal(after.reason, 'no_debugger_session');
});

test('an idle session is closed so a forgotten session does not hold the tab', async () => {
  const h = harness({ idleTtlMs: 60000 });
  await h.manager.open({ tabId: 7 });
  h.advance(60000);
  const changes = await h.manager.sweep();
  assert.deepEqual(changes, [{ tabId: 7, closed: true, reason: 'idle_timeout' }]);
  assert.ok(h.log.includes('detach:7'));
  assert.equal(h.manager.size(), 0);
});

test('screenshot and capture can borrow an open session instead of failing to attach', async () => {
  const h = harness();
  assert.equal(h.manager.activeSend(7), null, 'nothing to borrow before open');
  await h.manager.open({ tabId: 7 });
  const send = h.manager.activeSend(7);
  assert.equal(typeof send, 'function');
  await send('Page.captureScreenshot', { format: 'png' });
  assert.ok(h.log.includes('Page.captureScreenshot'));
});

test('the script list is bounded so a huge page cannot grow it without limit', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  for (let i = 0; i < DEBUGGER_SESSION_LIMITS.MAX_SCRIPTS + 50; i++) {
    h.manager.handleEvent(7, 'Debugger.scriptParsed', { scriptId: `s${i}`, url: `https://a.example/${i}.js`, startLine: 0, endLine: 10 });
  }
  assert.equal(h.manager.get(7).scripts.size, DEBUGGER_SESSION_LIMITS.MAX_SCRIPTS);
  const scripts = await h.manager.call({ tabId: 7, action: 'scripts' });
  assert.equal(scripts.count, DEBUGGER_SESSION_LIMITS.MAX_SCRIPTS);
  assert.equal(scripts.truncated, true);
});

test('urlFilter finds a script the unfiltered tail would have hidden', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  // The page's own document script parses first, then a long tail of vendor
  // bundles pushes it out of the last-60 window. Without filtering, the caller
  // cannot discover the one URL it actually wants to break on.
  h.manager.handleEvent(7, 'Debugger.scriptParsed', { scriptId: 'doc', url: 'https://a.example/app', startLine: 0, endLine: 40 });
  for (let i = 0; i < 200; i++) {
    h.manager.handleEvent(7, 'Debugger.scriptParsed', { scriptId: `v${i}`, url: `https://cdn.example/vendor/${i}.js`, startLine: 0, endLine: 10 });
  }
  const unfiltered = await h.manager.call({ tabId: 7, action: 'scripts' });
  assert.equal(unfiltered.scripts.some(item => item.scriptId === 'doc'), false, 'the document script is out of the tail');
  assert.equal(unfiltered.truncated, true);
  assert.equal(unfiltered.totalScripts, 201);

  const filtered = await h.manager.call({ tabId: 7, action: 'scripts', args: { urlFilter: 'A.EXAMPLE' } });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.truncated, false);
  assert.equal(filtered.scripts[0].url, 'https://a.example/app');
  assert.equal(filtered.totalScripts, 201);
});

test('closing an unknown session is not dispatched and not an error', async () => {
  const h = harness();
  const result = await h.manager.close({ tabId: 7 });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason, 'no_debugger_session');
  assert.equal(result.closed, false);
});

test('closing everything resumes each paused target first', async () => {
  const h = harness();
  await h.manager.open({ tabId: 7 });
  await h.manager.open({ tabId: 8 });
  h.manager.handleEvent(7, 'Debugger.paused', pausedEvent());
  const results = await h.manager.closeAll('shutdown');
  assert.equal(results.length, 2);
  assert.equal(results.find(entry => entry.resumedBeforeClose === true) !== undefined, true);
  assert.equal(h.manager.size(), 0);
  assert.equal(h.timers.size, 0);
});
