import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Tab write leases used to live in the MV3 service worker's memory
// (extension/worker.js `tabLeases`). Chrome recycles service workers, which made
// leases vanish mid-task and let a second agent silently take over a tab. The
// service process is the durable owner: it owns the queue, it outlives worker
// restarts, and it can persist to disk. The extension only executes page
// operations now.
export const DEFAULT_LEASE_TTL_MS = 120000;
// Explicit `wait:true` is honoured by the caller's intent, but it must stay
// bounded: an unbounded wait turns a lease conflict into a hung job.
export const MAX_LEASE_WAIT_MS = 15000;
export const LEASE_TOOLS = new Set(['browser_claim_tab', 'browser_renew_tab', 'browser_release_tab', 'browser_tab_lease']);
// Tools a write lease governs. Reads stay available so other agents can keep
// observing a leased tab; only these are blocked for non-holders.
export const WRITE_TOOLS = new Set([
  'browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_navigate', 'browser_close',
  'browser_key', 'browser_hover', 'browser_select', 'browser_choose', 'browser_action', 'browser_scroll_element',
  'browser_dismiss_overlay', 'browser_click_verified', 'browser_fill_verified', 'browser_upload_verified',
  'browser_pick', 'browser_history'
]);

const clampTtl = value => {
  const ttl = Number(value);
  if (!Number.isFinite(ttl)) return DEFAULT_LEASE_TTL_MS;
  return Math.min(600000, Math.max(1000, Math.trunc(ttl)));
};

export function createLeaseStore({ stateFile = null, ttlMs = DEFAULT_LEASE_TTL_MS, now = () => Date.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const leases = new Map();
  let pendingPersist = null;

  function persist() {
    if (!stateFile) return;
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), leases: [...leases.values()] }, null, 2), { mode: 0o600 });
      renameSync(tmp, stateFile);
    } catch {
      // Leases are coordination state, not security state. A read-only or full
      // disk must never break the bridge; in-memory leases still work.
    }
  }

  // Heartbeat writes (owner renews on every write) would otherwise hit the disk
  // once per browser action. Coalesce them; explicit acquire/release/missing
  // transitions still persist immediately via persist().
  function schedulePersist() {
    if (!stateFile || pendingPersist) return;
    pendingPersist = setTimeout(() => { pendingPersist = null; persist(); }, 250);
    pendingPersist.unref?.();
  }

  function load() {
    if (!stateFile) return;
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
      for (const record of raw?.leases ?? []) {
        if (!record || !Number.isInteger(record.tabId) || typeof record.agent !== 'string' || typeof record.leaseId !== 'string') continue;
        if (!(record.expiresAt > now())) continue;
        leases.set(String(record.tabId), { ...record, ttlMs: clampTtl(record.ttlMs) });
      }
    } catch {
      // Missing or corrupt file simply starts empty.
    }
  }

  const normalize = record => record ? {
    tabId: record.tabId,
    agent: record.agent,
    leaseId: record.leaseId,
    acquiredAt: record.acquiredAt,
    lastActiveAt: record.lastActiveAt,
    lastTool: record.lastTool ?? null,
    renewCount: record.renewCount ?? 0,
    ttlMs: record.ttlMs,
    expiresAt: record.expiresAt,
    expiresInMs: Math.max(0, record.expiresAt - now())
  } : null;

  function live(tabId) {
    const key = String(tabId);
    const record = leases.get(key);
    if (!record) return null;
    if (record.expiresAt <= now()) { leases.delete(key); schedulePersist(); return null; }
    return record;
  }

  function sweep() {
    let removed = 0;
    for (const [key, record] of leases) if (record.expiresAt <= now()) { leases.delete(key); removed++; }
    if (removed) schedulePersist();
    return removed;
  }

  function conflict(record, { tabId, agent, tool } = {}) {
    const remaining = Math.max(0, record.expiresAt - now());
    return {
      status: 'waiting',
      retryable: true,
      reason: 'tab_write_lease_conflict',
      ...(tool ? { tool } : {}),
      tabId,
      requestedAgent: agent ?? null,
      holder: record.agent,
      holderLeaseId: record.leaseId,
      expiresAt: record.expiresAt,
      suggestedDelayMs: Math.min(10000, Math.max(1000, remaining)),
      // Poll the cheap read-only lease view instead of re-issuing the blocking
      // operation: retrying claim/renew here is what previously spun the
      // auto-recovery loop into a 20s job timeout and a disconnected extension.
      nextPollTool: 'browser_tab_lease',
      nextPollArgs: { tabId },
      recommendedNextAction: 'Keep the task alive. Poll browser_tab_lease until the holder releases or the lease expires, then retry with the same agent.',
      lease: normalize(record)
    };
  }

  function missing(tabId, agent, tool) {
    return {
      status: 'waiting',
      retryable: true,
      reason: 'tab_write_lease_missing',
      ...(tool ? { tool } : {}),
      tabId,
      requestedAgent: agent ?? null,
      suggestedDelayMs: 1000,
      nextPollTool: 'browser_claim_tab',
      nextPollArgs: { tabId, agent, wait: false },
      recommendedNextAction: 'Acquire the tab lease with browser_claim_tab before continuing writes.'
    };
  }

  async function waitForRelease(tabId, agent, budgetMs) {
    const started = now();
    while (now() - started < budgetMs) {
      const held = live(tabId);
      if (!held || held.agent === agent) return held;
      await delay(Math.min(500, Math.max(50, Math.min(held.expiresAt - now(), budgetMs - (now() - started)))));
    }
    return live(tabId);
  }

  function claim({ tabId, agent, ttlMs: requested, wait = false } = {}) {
    const ttl = clampTtl(requested ?? ttlMs);
    if (wait) return claimWaiting({ tabId, agent, ttl });
    const existing = live(tabId);
    if (existing && existing.agent !== agent) return conflict(existing, { tabId, agent });
    return acquire(tabId, agent, ttl, existing);
  }

  async function claimWaiting({ tabId, agent, ttl }) {
    const budget = Math.min(ttl, MAX_LEASE_WAIT_MS);
    const existing = await waitForRelease(tabId, agent, budget);
    if (existing && existing.agent !== agent) return conflict(existing, { tabId, agent });
    return acquire(tabId, agent, ttl, existing);
  }

  function acquire(tabId, agent, ttl, existing) {
    const stamp = now();
    if (existing && existing.agent === agent) {
      const renewed = { ...existing, ttlMs: ttl, lastActiveAt: stamp, lastTool: 'browser_claim_tab', renewCount: (existing.renewCount ?? 0) + 1, expiresAt: stamp + ttl };
      leases.set(String(tabId), renewed);
      persist();
      return normalize(renewed);
    }
    const record = { tabId, agent, leaseId: randomUUID(), acquiredAt: stamp, lastActiveAt: stamp, lastTool: 'browser_claim_tab', renewCount: 0, ttlMs: ttl, expiresAt: stamp + ttl };
    leases.set(String(tabId), record);
    persist();
    return normalize(record);
  }

  function renew({ tabId, agent, ttlMs: requested } = {}) {
    const existing = live(tabId);
    if (!existing) return missing(tabId, agent, 'browser_renew_tab');
    if (existing.agent !== agent) return conflict(existing, { tabId, agent, tool: 'browser_renew_tab' });
    const ttl = clampTtl(requested ?? existing.ttlMs);
    const stamp = now();
    const renewed = { ...existing, ttlMs: ttl, lastActiveAt: stamp, lastTool: 'browser_renew_tab', renewCount: (existing.renewCount ?? 0) + 1, expiresAt: stamp + ttl };
    leases.set(String(tabId), renewed);
    persist();
    return normalize(renewed);
  }

  function release({ tabId, agent } = {}) {
    const existing = live(tabId);
    if (existing && existing.agent !== agent) throw new Error(`Tab is leased by ${existing.agent}`);
    leases.delete(String(tabId));
    persist();
    return { released: true, tabId, previousHolder: existing?.agent ?? null, previousLeaseId: existing?.leaseId ?? null };
  }

  // Internal cleanup: a closed tab can never be written again, so holding a
  // lease on it would only block the next agent.
  function releaseTab(tabId) {
    const key = String(tabId);
    if (!leases.delete(key)) return false;
    persist();
    return true;
  }

  // Called before a governed write is dispatched. Returns null when the write
  // may proceed, otherwise a waiting payload. Owning writes renew the lease so a
  // long task is not evicted by its own heartbeat gap.
  function guard(tabId, agent, tool) {
    // Enforced here as well as at the call site so the invariant "reads are
    // never blocked by a lease" cannot be broken by a new call site.
    if (!WRITE_TOOLS.has(tool)) return null;
    const existing = live(tabId);
    if (!existing) return null;
    if (agent && existing.agent === agent) {
      const stamp = now();
      const renewed = { ...existing, lastActiveAt: stamp, lastTool: tool, renewCount: (existing.renewCount ?? 0) + 1, expiresAt: stamp + (existing.ttlMs ?? ttlMs) };
      leases.set(String(tabId), renewed);
      schedulePersist();
      return null;
    }
    return conflict(existing, { tabId, agent, tool });
  }

  load();
  sweep();

  return {
    get: tabId => normalize(live(tabId)),
    list: () => { sweep(); return [...leases.values()].sort((a, b) => a.tabId - b.tabId).map(normalize); },
    claim,
    renew,
    release,
    releaseTab,
    guard,
    sweep,
    flush: () => { if (pendingPersist) { clearTimeout(pendingPersist); pendingPersist = null; } persist(); },
    size: () => leases.size
  };
}
