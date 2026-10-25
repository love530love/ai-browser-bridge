import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(dispatched, false);
  assert.deepEqual(events, []);
});
test('hover-induced target change cancels mouse press', async () => {
  const events = [];
  await pointer(async (method, args) => { events.push(args.type); }, { x: 10, y: 10, beforePress: async () => false });
  assert.deepEqual(events, ['mouseMoved']);
  await pointer(async (method, args) => { events.push(args.type); }, { x: 10, y: 10, beforePress: async () => true });
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
  assert.equal(dispatched, false);
  assert.equal(presses, 2);
  assert.deepEqual(events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});
