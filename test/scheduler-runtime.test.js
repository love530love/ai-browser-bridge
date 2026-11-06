import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These tests exercise the paths a queue-status smoke test never reaches:
// conflict detection, preemption, decomposition and cross-instance HTTP calls.
// Everything is hermetic: a temp state dir holds the config and instance
// registry, and fetch is stubbed at the HTTP boundary so the URL, headers and
// body the balancer actually sends are checked rather than a hand-built object.
const stateDir = mkdtempSync(join(tmpdir(), 'aib-scheduler-'));
mkdirSync(join(stateDir, 'pids'), { recursive: true });
const agentToken = 'a'.repeat(64);
writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
  port: 19387,
  agentToken,
  extensionToken: 'b'.repeat(64),
  uploadRoots: [],
  autoLaunchBrowser: false
}));
writeFileSync(join(stateDir, 'instances.json'), JSON.stringify({
  version: 1,
  instances: [
    { id: 'default', name: 'default', port: 19387, profileDirectory: 'Default', enabled: true },
    { id: 'profile1', name: 'profile1', port: 19388, profileDirectory: 'Default', enabled: true },
    { id: 'unknownCustom', name: 'custom', port: 19450, profileDirectory: 'Profile 1', enabled: true }
  ]
}));
process.env.AIB_STATE_DIR = stateDir;

const { createScheduler } = await import('../src/scheduler-integration.js');
const { PriorityQueue, decomposeTask } = await import('../src/priority-engine.js');
const { LoadBalancer, checkInstanceHealth, getInstanceLoad } = await import('../src/load-balancer.js');

const task = (id, name, args = {}, extra = {}) => ({ id, name, args, ...extra });

test('scheduler.detectConflicts reaches the detector instead of throwing TypeError', () => {
  const scheduler = createScheduler();
  const result = scheduler.detectConflicts(
    task('a', 'browser_storage_write', { elementId: 'field-1' }),
    task('b', 'browser_storage_write', { elementId: 'field-1' })
  );
  assert.ok(Array.isArray(result.conflicts));
  assert.ok(result.conflicts.some(c => c.type === 'same_element'));
  assert.ok(result.conflicts.some(c => c.type === 'storage_conflict'));

  const warning = scheduler.detectConflicts(
    task('nav', 'browser_navigate', { url: 'https://example.com' }),
    task('click', 'browser_click', { ref: 'r1' })
  );
  assert.ok(warning.warnings.some(w => w.type === 'navigate_interact'));
});

test('simple reads are dequeued before writes and navigation', async () => {
  const scheduler = createScheduler({ taskDecompositionEnabled: false });
  await scheduler.enqueue(task('nav', 'browser_navigate', { url: 'https://example.com' }));
  await scheduler.enqueue(task('click', 'browser_click', { ref: 'r1' }));
  await scheduler.enqueue(task('read', 'browser_read'));
  assert.deepEqual([scheduler.dequeue().id, scheduler.dequeue().id, scheduler.dequeue().id],
    ['read', 'click', 'nav']);
});

test('preemption keeps queue order and does NOT drop the task that caused it', async () => {
  const scheduler = createScheduler({ maxQueueSize: 3, taskDecompositionEnabled: false });
  for (let i = 0; i < 3; i += 1) {
    await scheduler.enqueue(task(`nav${i}`, 'browser_navigate', { url: 'https://example.com' }));
  }
  assert.equal(scheduler.priorityQueue.queue.length, 3);

  const result = await scheduler.enqueue(task('read', 'browser_read'));
  assert.equal(result.status, 'preempted');
  assert.ok(result.preemptedTask, 'the displaced task must be reported');
  assert.equal(scheduler.priorityQueue.queue.length, 3);
  assert.ok(scheduler.priorityQueue.queue.some(t => t.id === 'read'),
    'the high-priority task must actually be enqueued');
  assert.equal(scheduler.priorityQueue.queue.filter(t => t.id.startsWith('nav')).length, 2);
  const scores = scheduler.priorityQueue.queue.map(t => t.priority);
  assert.deepEqual(scores, [...scores].sort((a, b) => a - b), 'reverse() must not scramble the queue');
  assert.equal(scheduler.dequeue().id, 'read');
});

test('a full queue of higher-priority tasks rejects instead of throwing', async () => {
  const scheduler = createScheduler({ maxQueueSize: 2, taskDecompositionEnabled: false });
  await scheduler.enqueue(task('r1', 'browser_read'));
  await scheduler.enqueue(task('r2', 'browser_read'));
  const result = await scheduler.enqueue(task('nav', 'browser_navigate', { url: 'https://example.com' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'queue_full');
  assert.equal(scheduler.priorityQueue.queue.length, 2);
});

test('decomposition is advisory: no synthetic commands enter the executable queue', async () => {
  const scheduler = createScheduler({ taskDecompositionEnabled: true });
  const result = await scheduler.enqueue(task('nav', 'browser_navigate', { url: 'https://example.com' }));
  assert.equal(scheduler.priorityQueue.queue.length, 1, 'only the submitted task is queued');
  assert.equal(scheduler.priorityQueue.queue[0].id, 'nav');
  assert.equal(result.subTasks.length, 2);
  assert.ok(result.subTaskSuggestions.every(s => s.name !== 'browser_navigate'),
    'the original write must never be listed as its own sub-task');

  const decomposed = decomposeTask(task('click', 'browser_click', { elementId: 'e1' }));
  assert.equal(decomposed.subTasks.length, 2);
  assert.ok(decomposed.subTasks.every(t => t.parentTaskId === 'click'));
  assert.ok(decomposed.subTasks.every(t => t.name !== 'browser_click'));
});

test('cleanupTimeouts removes expired waits and keeps fresh ones', () => {
  const queue = new PriorityQueue(8);
  queue.waitTimeoutMs = 10;
  queue.enqueue(task('old', 'browser_read'));
  queue.queue[0].enqueuedAt = Date.now() - 1000;
  queue.enqueue(task('fresh', 'browser_read'));
  assert.deepEqual(queue.cleanupTimeouts().map(t => t.id), ['old']);
  assert.deepEqual(queue.queue.map(t => t.id), ['fresh']);
});

test('batch recommendations order simple tasks first and flag multi-agent conflicts', () => {
  const scheduler = createScheduler();
  const batch = [
    task('a1', 'browser_storage_write', { elementId: 'x' }, { metadata: { agentId: 'A' } }),
    task('b1', 'browser_storage_write', { elementId: 'x' }, { metadata: { agentId: 'B' } }),
    task('r1', 'browser_read', {}, { metadata: { agentId: 'A' } }),
    task('r2', 'browser_read', {}, { metadata: { agentId: 'B' } })
  ];
  const rec = scheduler.getBatchRecommendations(batch);
  assert.equal(rec.conflicts.hasConflict, true);
  assert.equal(rec.parallelization.parallelizable, true);
  assert.equal(rec.recommendedOrder[0].name, 'browser_read');
});

test('single-instance mode never routes a task away', async () => {
  const scheduler = createScheduler({ instanceMode: false });
  assert.deepEqual(await scheduler.routeTask(task('t', 'browser_read')),
    { routed: false, reason: 'single_instance_mode' });
});

test('load balancer resolves registry ports and authenticates every probe', async () => {
  const balancer = new LoadBalancer();
  assert.equal(balancer.getInstancePort('default'), 19387);
  assert.equal(balancer.getInstancePort('profile1'), 19388);
  assert.equal(balancer.getInstancePort('unknownCustom'), 19450);
  assert.equal(balancer.getInstancePort('missing'), 19387);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ queued: 0, connected: true }) };
  };
  try {
    assert.equal((await checkInstanceHealth('profile1')).healthy, true);
    assert.equal((await getInstanceLoad('unknownCustom')).load, 0);
    assert.ok((await balancer.selectBestInstance(task('t', 'browser_read'))).instanceId);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.ok(!call.url.includes('undefined'), 'URL must never contain :undefined');
    assert.ok(call.url.includes('/status'), 'GET /status is the real queue snapshot route');
    assert.equal(call.init.headers.Authorization, `Bearer ${agentToken}`);
  }
  assert.ok(calls.some(c => c.url.includes(':19450')), 'custom instance port must be used');
});

test('a 401 means the port is listening, not that the instance is dead', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    assert.equal((await checkInstanceHealth('default')).healthy, true);
    assert.equal((await getInstanceLoad('default')).reason, 'unauthorized');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('routeTask posts to the authenticated /call endpoint with the service contract', async () => {
  const balancer = new LoadBalancer();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/call')) {
      return { ok: true, status: 200, json: async () => ({ result: { status: 'success' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ queued: 0 }) };
  };
  try {
    const routed = await balancer.routeTask(
      task('t', 'browser_read', {}, { metadata: { agentId: 'A' } }));
    assert.equal(routed.routed, true);
    assert.ok(routed.targetInstance);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const call = calls.find(c => c.url.endsWith('/call'));
  assert.ok(call);
  assert.ok(!call.url.includes('undefined'));
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, `Bearer ${agentToken}`);
  assert.deepEqual(JSON.parse(call.init.body), { name: 'browser_read', arguments: {} });
});
