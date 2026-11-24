import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createErrorJournal } from '../extension/error-journal.js';
import { pointer } from '../extension/cdp.js';

test('offline errors survive worker recreation and are removed only after acknowledgement', async () => {
  let saved = {}; const sent = [];
  const storage = { get: async defaults => structuredClone({ ...defaults, ...saved }), set: async value => { saved = structuredClone(value); } };
  const first = createErrorJournal(storage, () => false, { id: () => 'one' });
  await first.record('websocket', 'WEBSOCKET_ERROR'); await first.flush();
  const second = createErrorJournal(storage, event => { sent.push(event); return true; });
  await second.flush(); await second.flush();
  assert.equal(sent.length, 2); assert.equal(sent[0].eventId, sent[1].eventId);
  await second.acknowledge('unrelated'); await second.flush(); assert.equal(sent.length, 3);
  await second.acknowledge('one'); await second.flush(); assert.equal(sent.length, 3);
});
test('outbox bounds storage and records loss instead of growing forever', async () => {
  let saved = {}, i = 0;
  const storage = { get: async defaults => structuredClone({ ...defaults, ...saved }), set: async value => { saved = structuredClone(value); } };
  const journal = createErrorJournal(storage, () => false, { limit: 2, id: () => String(++i) });
  await Promise.all([journal.record('worker', 'UNCAUGHT_ERROR'), journal.record('worker', 'UNCAUGHT_ERROR'), journal.record('worker', 'UNCAUGHT_ERROR')]);
  assert.equal(saved.errorOutboxV1.records.length, 2); assert.equal(saved.errorOutboxV1.dropped, 1);
});
test('foreground preflight can cancel before mouse movement', async () => {
  const events = [];
  const dispatched = await pointer(async (method, args) => { events.push(args.type); }, { x: 10, y: 10, beforeMove: async () => false });
  assert.equal(dispatched.completed, false);
  assert.deepEqual(events, []);
});
test('hover-induced target change cancels mouse press', async () => {
  const events = [];
  const cancelled = await pointer(async (method, args) => { events.push(args.type); }, { x: 10, y: 10, beforePress: async () => false });
  assert.equal(cancelled.completed, false);
  assert.deepEqual(events, ['mouseMoved']);
  const completed = await pointer(async (method, args) => { events.push(args.type); }, { x: 10, y: 10, beforePress: async () => true });
  assert.equal(completed.completed, true);
  assert.deepEqual(events.slice(1), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});
test('a pause or disconnect after first double-click release cancels the second press', async () => {
  const events = [];
  let presses = 0, bridgeConnected = true;
  const dispatched = await pointer(async (method, args) => {
    events.push(args.type);
    if (args.type === 'mouseReleased') bridgeConnected = false;
  }, {
    x: 10, y: 10, action: 'double', beforePress: async () => { presses++; return bridgeConnected; }
  });
  assert.equal(dispatched.completed, false);
  assert.equal(presses, 2);
  assert.deepEqual(events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});
test('a failed CDP release falls back to page events and the result says so', async () => {
  const result = await pointer(async (method, args) => {
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') throw new Error('input dispatch timed out');
    return {};
  }, { x: 10, y: 10 });
  assert.equal(result.completed, false);
  // The release happens before the failure is returned, so the caller learns
  // that the button was actually lifted and by which method.
  assert.equal(result.released, true);
  assert.equal(result.release.method, 'page');
  assert.equal(result.release.reason, 'gesture_failed');
  assert.deepEqual({ x: result.release.x, y: result.release.y }, { x: 10, y: 10 });
  assert.match(result.error, /timed out/);
});
test('a drag releases on its last coordinate, not where it started', async () => {
  const result = await pointer(async () => ({}), { x: 0, y: 0, endX: 60, endY: 30, action: 'drag', steps: 3 });
  assert.equal(result.completed, true);
  assert.equal(result.release.reason, 'gesture_end');
  assert.deepEqual({ x: result.release.x, y: result.release.y }, { x: 60, y: 30 });
});
test('a hung press is guarded by a watchdog on the last known coordinate', async () => {
  // The measured failure was a backgrounded tab left pressed after the CDP call
  // never returned, so this is a source contract: the watchdog must exist and
  // release at the last coordinate rather than the start.
  const source = readFileSync(new URL('../extension/cdp.js', import.meta.url), 'utf8');
  assert.match(source, /release\('watchdog'\)/);
  assert.match(source, /x: lastX, y: lastY/);
});
