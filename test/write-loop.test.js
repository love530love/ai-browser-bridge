// The write loop, as the service sees it: what is refused before a request is
// ever queued, and what a caller gets back when it asks for a narrowed tab list.
//
// These run with no extension connected on purpose. A refusal that only works
// once the browser is up is not a refusal, it is a race.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridge } from '../src/server.js';
import { filterTabs } from '../src/tab-filter.js';
import { validateCall } from '../src/tools.js';

function offlineBridge(t) {
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' },
    { leaseStateFile: null, agentPolicyFile: null, audit: () => {} });
  return bridge;
}

test('the risk planner answers with the browser closed', async t => {
  const bridge = offlineBridge(t);
  await bridge.listen(); t.after(() => bridge.close());

  const safe = await bridge.call('browser_prepare_request', { method: 'GET', url: 'https://app.test/api/instances' });
  assert.equal(safe.status, 'success');
  assert.equal(safe.riskLevel, 'safe');
  assert.equal(safe.requiresConfirmation, false);
  assert.equal(safe.dispatched, false, 'a planner that dispatched would not be a planner');
  assert.equal(safe.confirmation, null);

  const write = await bridge.call('browser_prepare_request', {
    method: 'POST', url: 'https://app.test/api/instances/42/shutdown', body: '{}'
  });
  assert.equal(write.riskLevel, 'destructive');
  assert.equal(write.reversible, false);
  assert.equal(write.requiresConfirmation, true);
  assert.equal(write.confirmation, 'replay_request_once');
  assert.equal(write.confirmationTool, 'browser_replay_request');
});

test('a malformed verify is refused before anything is queued', async t => {
  const bridge = offlineBridge(t);
  await bridge.listen(); t.after(() => bridge.close());

  const base = { tabId: 1, method: 'POST', url: 'https://app.test/api/x', confirmation: 'replay_request_once' };
  // A mutating verify method would re-send the change on every poll.
  const mutating = await bridge.call('browser_replay_request', { ...base, verify: { url: 'https://app.test/api/x', method: 'POST', jsonPointer: '/a', expect: 'b' } });
  assert.equal(mutating.status, 'denied');
  assert.equal(mutating.reason, 'verify_method_not_read_only');
  assert.equal(mutating.dispatched, false);

  const noPointer = await bridge.call('browser_replay_request', { ...base, verify: { url: 'https://app.test/api/x', expect: 'b' } });
  assert.equal(noPointer.status, 'denied');
  assert.equal(noPointer.reason, 'verify_pointer_missing');

  const noExpect = await bridge.call('browser_replay_request', { ...base, verify: { url: 'https://app.test/api/x', jsonPointer: '/a' } });
  assert.equal(noExpect.status, 'denied');
  assert.equal(noExpect.reason, 'verify_expect_missing');
});

test('the confirmation gate still runs before the verify check', async t => {
  // Two mistakes are present at once on purpose: no confirmation, and a verify
  // block whose method could change state. A caller must be told about the
  // confirmation, because that is the one thing that would otherwise let a
  // request through - a bad verify is only a bad hint.
  const call = {
    tabId: 1, method: 'POST', url: 'https://app.test/api/x',
    verify: { url: 'https://app.test/api/x', method: 'DELETE', jsonPointer: '/a', expect: 'b' }
  };
  assert.throws(() => validateCall('browser_replay_request', { ...call }), err => {
    assert.match(err.message, /Missing argument: confirmation/);
    assert.ok(!/verify_/.test(err.message), `a reason code from the verify check leaked: ${err.message}`);
    return true;
  });

  // With the confirmation supplied the verify problem becomes the reported one,
  // and still nothing is dispatched. That pair is the ordering evidence: the
  // gate is in front of the check, not merely louder than it.
  const bridge = offlineBridge(t);
  await bridge.listen(); t.after(() => bridge.close());
  const result = await bridge.call('browser_replay_request', { ...call, confirmation: 'replay_request_once' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'verify_method_not_read_only');
  assert.equal(result.dispatched, false);
});

test('browser_fetch cannot be handed a mutating method at all', async t => {
  // The refusal has to happen in the schema, not only in the service: a method
  // that fails validation never reaches the queue, so there is no window where
  // a write could slip through a tool that needs no confirmation.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(
      () => validateCall('browser_fetch', { tabId: 1, url: 'https://app.test/api/x', method }),
      /allowed: GET \| HEAD \| OPTIONS/,
      `${method} must not even validate`
    );
  }
  // The service-side gate is kept anyway, because the schema is the caller's
  // copy of the rule and the server must not depend on it: any future path that
  // bypasses validation (an older client, a raw job) still meets the same wall.
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /reason: 'fetch_method_not_read_only'/, 'the service-side read-only gate was removed');

  const bridge = offlineBridge(t);
  await bridge.listen(); t.after(() => bridge.close());
  // A safe method gets past this gate, which is the point: it then fails only
  // because no extension is connected, never because of the method.
  const read = await bridge.call('browser_fetch', { tabId: 1, url: 'https://app.test/api/x', method: 'GET' });
  assert.notEqual(read.reason, 'fetch_method_not_read_only');
});

test('the intent index is answered locally and stays small', async t => {
  const bridge = offlineBridge(t);
  await bridge.listen(); t.after(() => bridge.close());
  const result = await bridge.call('browser_tool_index', {});
  assert.equal(result.status, 'success');
  assert.ok(Buffer.byteLength(result.index, 'utf8') < 3500);
  const one = await bridge.call('browser_tool_index', { group: 'network' });
  assert.deepEqual(one.groups, ['network']);
});

test('tab filtering narrows, counts, and leaves an unfiltered list untouched', () => {
  const rows = [
    { id: 1, title: '实例管理', url: 'https://ai.example.test/dashboard/compute/instances', windowId: 3, restricted: false },
    { id: 2, title: 'Order 40', url: 'https://shop.example.test/order?id=40', windowId: 3, restricted: false },
    { id: 3, title: 'Other', url: 'https://shop.example.test/order?id=41', windowId: 4, restricted: false },
    { id: 4, title: null, url: null, windowId: 4, restricted: true }
  ];
  // No filter keeps the original array shape: existing callers see no change.
  assert.deepEqual(filterTabs(rows, {}), rows);

  const byOrigin = filterTabs(rows, { origin: 'https://shop.example.test' });
  assert.equal(byOrigin.total, 2);
  assert.equal(byOrigin.browserTotal, 4);
  assert.deepEqual(byOrigin.tabs.map(row => row.id), [2, 3]);

  const byUrl = filterTabs(rows, { urlContains: 'COMPUTE' });
  assert.deepEqual(byUrl.tabs.map(row => row.id), [1], 'contains is case-insensitive');

  const byTitle = filterTabs(rows, { titleContains: '实例' });
  assert.deepEqual(byTitle.tabs.map(row => row.id), [1]);

  const projected = filterTabs(rows, { fields: 'id,title', limit: 2 });
  assert.equal(projected.returned, 2);
  assert.deepEqual(projected.tabs[0], { id: 1, title: '实例管理' });
  assert.ok(!Object.hasOwn(projected.tabs[0], 'url'), 'fields must project, not just reorder');

  // A restricted tab has no URL, so an origin filter cannot match it. Dropping
  // it is honest; inventing an origin from a title would not be.
  const withRestricted = filterTabs(rows, { origin: 'https://shop.example.test' });
  assert.ok(!withRestricted.tabs.some(row => row.restricted === true));
});

test('the alias table renames a guess instead of rejecting the call', () => {
  const fill = { tabId: 1, ref: 'e1', value: 'hello' };
  validateCall('browser_fill', fill);
  assert.equal(fill.text, 'hello');
  assert.equal(fill.value, undefined);

  const read = { tabId: 1, mode: 'text' };
  validateCall('browser_read', read);
  assert.equal(read.mode, 'normal');

  // A real argument is never overwritten by an alias - and the losing guess is
  // not quietly dropped either. Silently ignoring `value` would leave the caller
  // believing it typed one thing while the page received another, so a
  // conflicting pair is refused by name instead.
  const both = { tabId: 1, ref: 'e1', text: 'kept', value: 'ignored' };
  assert.throws(() => validateCall('browser_fill', both), err => {
    assert.match(err.message, /Conflicting arguments: value and text/);
    assert.match(err.message, /another name for text/);
    assert.ok(!/Unknown argument/.test(err.message), 'value is understood here; calling it unknown is wrong');
    return true;
  });
  assert.equal(both.text, 'kept', 'the alias must not have replaced a real argument before throwing');

  // The same name twice with the same value is just a redundant spelling, and
  // collapsing it is safe because both copies say the same thing.
  const dup = { tabId: 1, tab_id: 1, ref: 'e1', text: 'hello' };
  validateCall('browser_fill', dup);
  assert.equal(dup.tab_id, undefined);

  // An alias that would collide with a real parameter name is not applied.
  const unknown = { tabId: 1, ref: 'e1' };
  assert.throws(() => validateCall('browser_fill', unknown), /Missing argument: text/);
});
