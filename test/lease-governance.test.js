import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools.js';
import { createLeaseStore, WRITE_TOOLS, LEASE_TOOLS } from '../src/leases.js';

const byName = new Map(TOOLS.map(tool => [tool.name, tool]));
const requires = (name, key) => (byName.get(name)?.inputSchema?.required ?? []).includes(key);
const isReadOnly = name => !!byName.get(name)?.annotations?.readOnlyHint;

// WRITE_TOOLS is a hand-maintained list. The failure mode is silent: a new
// write tool that is never added to the list bypasses lease enforcement
// entirely, so two agents can mutate the same tab with no conflict at all.
// These tests turn that silent hole into a red build.

test('every governed write tool exists in the tool registry', () => {
  for (const name of WRITE_TOOLS) assert.ok(byName.has(name), `${name} is governed but not registered as a tool`);
});

test('every governed write tool requires tabId, otherwise the guard can never fire', () => {
  for (const name of WRITE_TOOLS) assert.ok(requires(name, 'tabId'), `${name} is governed but tabId is not required`);
});

test('no read-only tool is governed by a write lease', () => {
  for (const name of WRITE_TOOLS) assert.ok(!isReadOnly(name), `${name} is annotated read-only but is lease-governed`);
});

test('lease bookkeeping tools are not themselves write-governed', () => {
  for (const name of LEASE_TOOLS) {
    assert.ok(byName.has(name), `${name} is a lease tool but not registered as a tool`);
    assert.ok(requires(name, 'tabId'), `${name} must require tabId`);
    assert.ok(!WRITE_TOOLS.has(name), `${name} must not be write-governed`);
  }
});

test('a leased tab never blocks reads and never blocks the holder', () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 11, agent: 'agentA', ttlMs: 5000 });

  // The guard is the only enforcement point; it must stay a no-op for anything
  // that is not a governed write, including read-only tools.
  for (const name of TOOLS.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name)) {
    assert.equal(leases.guard(11, 'agentB', name), null, `${name} must not be blocked by a lease`);
  }
  assert.equal(leases.guard(11, 'agentA', 'browser_click'), null, 'the holder must never be blocked');
});

test('a non-holder write is blocked with the waiting contract', () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 12, agent: 'agentA', ttlMs: 5000 });
  const blocked = leases.guard(12, 'agentB', 'browser_click');
  assert.equal(blocked.status, 'waiting');
  assert.equal(blocked.retryable, true);
  assert.equal(blocked.reason, 'tab_write_lease_conflict');
  assert.equal(blocked.holder, 'agentA');
  assert.equal(blocked.nextPollTool, 'browser_tab_lease');
  // Polling must never point back at a blocking wait: re-issuing wait:true from
  // here is what previously spun auto-recovery into a job timeout that dropped
  // the extension and broke every other agent on the bridge.
  assert.notEqual(blocked.nextPollArgs?.wait, true);
});

test('an unclaimed tab stays writable so single-agent users see no new gate', () => {
  const leases = createLeaseStore();
  assert.equal(leases.guard(13, null, 'browser_click'), null);
  assert.equal(leases.guard(13, 'agentA', 'browser_click'), null);
});

test('the holder keeps the lease alive by writing, so long tasks are not evicted', () => {
  const leases = createLeaseStore({ ttlMs: 1000 });
  const first = leases.claim({ tabId: 14, agent: 'agentA', ttlMs: 1000 });
  assert.equal(leases.guard(14, 'agentA', 'browser_click'), null);
  const after = leases.get(14);
  assert.ok(after.expiresAt >= first.expiresAt, 'an owning write must not shorten the lease');
  assert.equal(after.lastTool, 'browser_click');
  assert.equal(after.renewCount, first.renewCount + 1);
});
