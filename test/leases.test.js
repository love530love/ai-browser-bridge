import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaseStore, WRITE_TOOLS, LEASE_TOOLS } from '../src/leases.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aib-leases-'));
const clock = start => { let t = start; return { now: () => t, advance: ms => { t += ms; } }; };

test('lease set matches the tools the service governs', () => {
  for (const name of ['browser_click', 'browser_fill', 'browser_key', 'browser_navigate', 'browser_close', 'browser_history']) assert.ok(WRITE_TOOLS.has(name));
  for (const name of ['browser_read', 'browser_observe', 'browser_claim_tab', 'browser_tab_lease']) assert.ok(!WRITE_TOOLS.has(name));
  for (const name of ['browser_claim_tab', 'browser_renew_tab', 'browser_release_tab', 'browser_tab_lease']) assert.ok(LEASE_TOOLS.has(name));
});

test('claim, renew and release round-trip with a stable leaseId per acquisition', () => {
  const leases = createLeaseStore();
  const first = leases.claim({ tabId: 7, agent: 'agentA', ttlMs: 5000 });
  assert.equal(first.tabId, 7);
  assert.equal(first.agent, 'agentA');
  assert.equal(first.ttlMs, 5000);
  assert.equal(first.renewCount, 0);
  assert.equal(leases.get(7).leaseId, first.leaseId);

  const renewed = leases.renew({ tabId: 7, agent: 'agentA', ttlMs: 9000 });
  assert.equal(renewed.leaseId, first.leaseId, 'renew must not mint a new lease');
  assert.equal(renewed.renewCount, 1);
  assert.equal(renewed.ttlMs, 9000);

  const released = leases.release({ tabId: 7, agent: 'agentA' });
  assert.equal(released.released, true);
  assert.equal(released.previousHolder, 'agentA');
  assert.equal(leases.get(7), null);
  assert.equal(leases.size(), 0);
});

test('ttl is clamped to the documented 1s..600s range', () => {
  const leases = createLeaseStore();
  assert.equal(leases.claim({ tabId: 1, agent: 'a', ttlMs: 5 }).ttlMs, 1000);
  assert.equal(leases.claim({ tabId: 2, agent: 'a', ttlMs: 99999999 }).ttlMs, 600000);
});

test('a second agent is refused while the first holds the tab', () => {
  const leases = createLeaseStore();
  const held = leases.claim({ tabId: 3, agent: 'agentA', ttlMs: 5000 });
  const blocked = leases.claim({ tabId: 3, agent: 'agentB' });
  assert.equal(blocked.status, 'waiting');
  assert.equal(blocked.retryable, true);
  assert.equal(blocked.reason, 'tab_write_lease_conflict');
  assert.equal(blocked.holder, 'agentA');
  assert.equal(blocked.holderLeaseId, held.leaseId);
  // Recovery must poll the cheap read-only view, never re-issue a blocking wait.
  assert.equal(blocked.nextPollTool, 'browser_tab_lease');
  assert.deepEqual(blocked.nextPollArgs, { tabId: 3 });
  assert.equal(leases.get(3).agent, 'agentA', 'refused claim must not steal the lease');
});

test('re-claiming as the holder extends instead of minting a new lease', () => {
  const leases = createLeaseStore();
  const first = leases.claim({ tabId: 4, agent: 'agentA', ttlMs: 5000 });
  const again = leases.claim({ tabId: 4, agent: 'agentA' });
  assert.equal(again.leaseId, first.leaseId);
  assert.equal(again.renewCount, 1);
});

test('governed writes are blocked for others and auto-renew for the holder', () => {
  const time = clock(1_000_000);
  const leases = createLeaseStore({ now: time.now });
  leases.claim({ tabId: 5, agent: 'agentA', ttlMs: 10_000 });

  const blocked = leases.guard(5, 'agentB', 'browser_click');
  assert.equal(blocked.reason, 'tab_write_lease_conflict');
  assert.equal(blocked.tool, 'browser_click');
  assert.equal(blocked.holder, 'agentA');

  assert.equal(leases.guard(5, 'agentA', 'browser_fill'), null, 'holder writes pass');
  const after = leases.get(5);
  assert.equal(after.lastTool, 'browser_fill');
  assert.equal(after.renewCount, 1, 'owner writes renew as a heartbeat');
  assert.ok(after.expiresAt > 1_000_000 + 9000);
});

test('reads are never blocked by a lease', () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 6, agent: 'agentA' });
  assert.equal(leases.guard(6, 'agentB', 'browser_read'), null);
});

test('release by a non-holder is refused so agents cannot evict each other', () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 8, agent: 'agentA' });
  assert.throws(() => leases.release({ tabId: 8, agent: 'agentB' }), /Tab is leased by agentA/);
  assert.equal(leases.get(8).agent, 'agentA');
});

test('expired leases stop blocking and are swept away', () => {
  const time = clock(2_000_000);
  const leases = createLeaseStore({ now: time.now });
  leases.claim({ tabId: 9, agent: 'agentA', ttlMs: 1000 });
  assert.equal(leases.guard(9, 'agentB', 'browser_click').reason, 'tab_write_lease_conflict');
  time.advance(1001);
  assert.equal(leases.guard(9, 'agentB', 'browser_click'), null, 'expiry frees the tab');
  assert.equal(leases.get(9), null);
  assert.equal(leases.size(), 0, 'first expired read drops the record');

  // A lease that is never read again still has to be reclaimed by sweep().
  const swept = createLeaseStore({ now: time.now });
  swept.claim({ tabId: 10, agent: 'agentA', ttlMs: 1000 });
  assert.equal(swept.size(), 1);
  time.advance(1001);
  assert.equal(swept.sweep(), 1);
  assert.equal(swept.size(), 0);
  assert.equal(swept.claim({ tabId: 10, agent: 'agentB' }).agent, 'agentB');
});

test('renew without a lease reports missing rather than granting one', () => {
  const leases = createLeaseStore();
  const result = leases.renew({ tabId: 11, agent: 'agentA' });
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'tab_write_lease_missing');
  assert.equal(result.nextPollTool, 'browser_claim_tab');
  assert.equal(leases.get(11), null, 'a missing renew must not silently acquire');
});

test('tab keys stay isolated so one tab never leaks into another', () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 0, agent: 'agentA' });
  leases.claim({ tabId: 1, agent: 'agentB' });
  assert.equal(leases.get(0).agent, 'agentA');
  assert.equal(leases.get(1).agent, 'agentB');
  assert.equal(leases.guard(1, 'agentA', 'browser_click').reason, 'tab_write_lease_conflict');
  assert.equal(leases.size(), 2);
});

test('leases survive a service restart via the persisted state file', () => {
  const file = join(tmp(), 'tab-leases.json');
  const first = createLeaseStore({ stateFile: file });
  const claimed = first.claim({ tabId: 42, agent: 'agentA', ttlMs: 60_000 });
  first.flush();
  assert.ok(existsSync(file), 'state file written');

  const restarted = createLeaseStore({ stateFile: file });
  const restored = restarted.get(42);
  assert.equal(restored.agent, 'agentA');
  assert.equal(restored.leaseId, claimed.leaseId, 'lease identity must survive a restart');
  assert.equal(restarted.guard(42, 'agentB', 'browser_click').reason, 'tab_write_lease_conflict');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.leases.length, 1);
});

test('expired records are discarded on load', () => {
  const file = join(tmp(), 'tab-leases.json');
  const store = createLeaseStore({ stateFile: file });
  store.claim({ tabId: 13, agent: 'agentA', ttlMs: 1000 });
  store.flush();
  // Rewind the restored clock past the stored expiry.
  const later = createLeaseStore({ stateFile: file, now: () => Date.now() + 5_000 });
  assert.equal(later.get(13), null);
  assert.equal(later.size(), 0);
});

test('a corrupt state file degrades to empty instead of breaking the bridge', () => {
  const file = join(tmp(), 'tab-leases.json');
  writeFileSync(file, '{not json at all');
  const leases = createLeaseStore({ stateFile: file });
  assert.equal(leases.size(), 0);
  assert.equal(leases.claim({ tabId: 14, agent: 'agentA' }).agent, 'agentA');
});

test('closing a tab releases its lease so the next agent is not blocked', () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 15, agent: 'agentA' });
  assert.equal(leases.releaseTab(15), true);
  assert.equal(leases.get(15), null);
  assert.equal(leases.claim({ tabId: 15, agent: 'agentB' }).agent, 'agentB');
  assert.equal(leases.releaseTab(999), false, 'unknown tab is a no-op');
});

test('wait:true honours an explicit wait and acquires once the holder releases', async () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 16, agent: 'agentA', ttlMs: 60_000 });
  setTimeout(() => leases.release({ tabId: 16, agent: 'agentA' }), 150);
  const started = Date.now();
  const acquired = await leases.claim({ tabId: 16, agent: 'agentB', ttlMs: 1000, wait: true });
  assert.equal(acquired.agent, 'agentB');
  assert.ok(Date.now() - started < 5000, 'wait must stay bounded and drain promptly');
});

test('wait:true stays bounded and reports conflict when the holder never releases', async () => {
  const leases = createLeaseStore();
  leases.claim({ tabId: 17, agent: 'agentA', ttlMs: 60_000 });
  const started = Date.now();
  const blocked = await leases.claim({ tabId: 17, agent: 'agentB', ttlMs: 1000, wait: true });
  const elapsed = Date.now() - started;
  assert.equal(blocked.status, 'waiting');
  assert.equal(blocked.reason, 'tab_write_lease_conflict');
  assert.ok(elapsed < 5000, `bounded wait, took ${elapsed}ms`);
  assert.equal(leases.get(17).agent, 'agentA');
});
