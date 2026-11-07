import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// hermetic：临时 state 目录（config + instance 注册表）+ stub fetch。
// 全部在 HTTP 边界拦截，不连真实服务、不杀真实进程。
const stateDir = mkdtempSync(join(tmpdir(), 'aib-bridge-'));
mkdirSync(join(stateDir, 'pids'), { recursive: true });
const agentToken = 'c'.repeat(64);
writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
  port: 19387,
  agentToken,
  extensionToken: 'd'.repeat(64),
  uploadRoots: [],
  autoLaunchBrowser: false
}));
writeFileSync(join(stateDir, 'instances.json'), JSON.stringify({
  version: 1,
  instances: [
    { id: 'default', name: 'default', port: 19387, profileDirectory: 'Default', enabled: true },
    { id: 'profile1', name: 'profile1', port: 19388, profileDirectory: 'Default', enabled: true },
    { id: 'custom', name: 'custom', port: 19450, profileDirectory: 'Profile 1', enabled: true }
  ]
}));
process.env.AIB_STATE_DIR = stateDir;

const { createScheduler } = await import('../src/scheduler-integration.js');
const { LoadBalancer } = await import('../src/load-balancer.js');
const { createSchedulerBridge } = await import('../src/scheduler-bridge.js');

const job = (id, name, args = {}, extra = {}) => ({ id, name, args, ...extra });

// /status 返回健康（供 selectBestInstance 探测），/call 可配置成功或抛错模拟超时。
function makeStub({ callThrows = false } = {}) {
  const calls = [];
  const stub = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/status')) {
      return { ok: true, status: 200, json: async () => ({ queued: 0, connected: true }) };
    }
    if (url.endsWith('/call')) {
      if (callThrows) throw new Error('simulated /call timeout');
      return { ok: true, status: 200, json: async () => ({ result: { status: 'success' } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, stub, callCalls: () => calls.filter(c => c.url.endsWith('/call')) };
}

test('单实例模式不发起任何 fetch', async () => {
  const { calls, stub } = makeStub();
  const scheduler = createScheduler({ instanceMode: false });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: false, fetchFn: stub });
  const r = await bridge.routeExplicitly({ name: 'browser_click', arguments: { ref: 'x' } });
  assert.equal(r.status, 'waiting');
  assert.equal(r.retryable, true);
  assert.equal(r.reason, 'single_instance_mode');
  assert.equal(r.dispatched, false);
  assert.equal(calls.length, 0, '绝不能发起任何 fetch');
});

test('browser_route_task / 空名 / 非字符串名 一律拒绝，且不 fetch', async () => {
  const { calls, stub } = makeStub();
  const scheduler = createScheduler({ instanceMode: true });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: true, fetchFn: stub });
  for (const bad of [
    { name: 'browser_route_task', arguments: {} },
    { name: '', arguments: {} },
    { name: 123, arguments: {} },
    {}
  ]) {
    const r = await bridge.routeExplicitly(bad);
    assert.equal(r.status, 'denied');
    assert.equal(r.retryable, false);
    assert.equal(r.reason, 'routing_recursion_blocked');
    assert.equal(r.dispatched, false);
  }
  assert.equal(calls.length, 0);
});

test('正常转发：真实 POST /call，method/headers/body 符合服务契约', async () => {
  const { callCalls, stub } = makeStub();
  const scheduler = createScheduler({ instanceMode: true });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: true, fetchFn: stub });
  const r = await bridge.routeExplicitly({ name: 'browser_read', arguments: { selector: '#q' }, agent: 'A' });
  assert.equal(r.status, 'success');
  assert.equal(r.routed, true);
  assert.equal(r.dispatched, true);
  assert.equal(r.advisory, false);
  assert.ok(r.targetInstance);
  assert.deepEqual(r.result, { result: { status: 'success' } });

  const posts = callCalls();
  assert.equal(posts.length, 1);
  const call = posts[0];
  assert.ok(call.url.endsWith('/call'));
  assert.ok(!call.url.includes('undefined'));
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, `Bearer ${agentToken}`);
  const body = JSON.parse(call.init.body);
  assert.equal(body.name, 'browser_read');
  assert.deepEqual(body.arguments, { selector: '#q' });
});

test('转发超时返回 uncertain 且 /call 只发一次（绝不重放）', async () => {
  const { callCalls, stub } = makeStub({ callThrows: true });
  const scheduler = createScheduler({ instanceMode: true });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: true, fetchFn: stub });
  const r = await bridge.routeExplicitly({ name: 'browser_storage_write', arguments: { key: 'k' } });
  assert.equal(r.status, 'uncertain');
  assert.equal(r.retryable, false);
  assert.equal(r.dispatched, null);
  assert.equal(r.reason, 'routing_outcome_unknown');
  assert.equal(r.message, '对方实例可能已执行，绝不自动重放；重新观察后再决定');
  assert.equal(callCalls().length, 1, '/call POST 只尝试一次，不重放');
});

test('2 秒内重复调用被抑制，窗口过后可再次派发', async () => {
  let clock = 100000;
  const { callCalls, stub } = makeStub();
  const scheduler = createScheduler({ instanceMode: true });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: true, now: () => clock, fetchFn: stub });
  const req = { name: 'browser_click', arguments: { ref: 'r1' } };
  const first = await bridge.routeExplicitly(req);
  assert.equal(first.status, 'success');
  const second = await bridge.routeExplicitly(req);
  assert.equal(second.status, 'duplicate_suppressed');
  assert.equal(second.dispatched, false);
  assert.equal(second.replayed, true);
  assert.equal(callCalls().length, 1, '第二次被抑制，不再 POST');

  clock += 2001;
  const third = await bridge.routeExplicitly(req);
  assert.notEqual(third.status, 'duplicate_suppressed');
  assert.equal(callCalls().length, 2);
});

test('conflictEvidenceFor 提供只读冲突证据，不抛异常、不改队列', () => {
  const scheduler = createScheduler({ instanceMode: false });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: false });
  const a = job('a', 'browser_storage_write', { elementId: 'f1' });
  const b = job('b', 'browser_storage_write', { elementId: 'f1' });
  const c = job('c', 'browser_navigate', { url: 'https://example.com' });
  const queue = [a, b, c];
  const snapshot = JSON.stringify(queue);

  const evidence = bridge.conflictEvidenceFor(a, queue);
  assert.equal(evidence.code, 'scheduler_conflict_evidence');
  assert.equal(evidence.jobId, 'a');
  assert.equal(evidence.advisory, true);
  assert.equal(evidence.dispatched, false);
  assert.ok(Array.isArray(evidence.conflicts));
  assert.ok(evidence.conflicts.some(e => e.otherId === 'b' && e.tool === 'browser_storage_write'));
  assert.ok(evidence.conflicts.some(e =>
    e.verdict.hasConflict && e.verdict.conflicts.some(c => c.type === 'same_element')));
  assert.equal(JSON.stringify(queue), snapshot, '队列必须原样不变');

  assert.equal(bridge.conflictEvidenceFor(job('x', 'browser_read'), [job('y', 'browser_read')]), null);
  assert.doesNotThrow(() => bridge.conflictEvidenceFor(null, null));
  assert.equal(bridge.conflictEvidenceFor(null, null), null);
});

test('conflictEvidenceFor 在 detector 抛错时仍只读、返回 null', () => {
  const badScheduler = {
    detectConflicts() { throw new Error('boom'); },
    updateInstanceConfig() {}
  };
  const bridge = createSchedulerBridge({ scheduler: badScheduler, instanceMode: false });
  assert.doesNotThrow(() => bridge.conflictEvidenceFor(job('a', 'x'), [job('b', 'y')]));
  assert.equal(bridge.conflictEvidenceFor(job('a', 'x'), [job('b', 'y')]), null);
});

test('describe() 报告接线已生效，字段完整，随 setInstanceMode 更新', () => {
  const scheduler = createScheduler({ instanceMode: false });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: false, currentInstanceId: 'default' });
  const d = bridge.describe();
  assert.equal(d.wired, true);
  assert.equal(d.instanceMode, false);
  assert.equal(d.currentInstanceId, 'default');
  assert.equal(d.routeTool, 'browser_route_task');
  assert.deepEqual(d.capabilities, ['conflict_evidence', 'explicit_instance_routing']);

  bridge.setInstanceMode(true, 'profile1');
  const d2 = bridge.describe();
  assert.equal(d2.instanceMode, true);
  assert.equal(d2.currentInstanceId, 'profile1');
});

test('setInstanceMode 同步 scheduler 并启用真实转发', async () => {
  const { callCalls, stub } = makeStub();
  const scheduler = createScheduler({ instanceMode: false });
  const bridge = createSchedulerBridge({ scheduler, instanceMode: false, fetchFn: stub });
  assert.equal((await bridge.routeExplicitly({ name: 'browser_read' })).status, 'waiting');
  assert.equal(callCalls().length, 0);
  bridge.setInstanceMode(true, 'profile1');
  const r = await bridge.routeExplicitly({ name: 'browser_read' });
  assert.equal(r.status, 'success', 'setInstanceMode 后 scheduler 必须真的转发');
  assert.equal(callCalls().length, 1);
});

test('routeTaskToInstance 打到 instanceId 指定的端口，且 POST 契约一致', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ result: { ok: true } }) };
  };
  try {
    const balancer = new LoadBalancer();
    const r = await balancer.routeTaskToInstance('profile1', { name: 'browser_read', args: { q: 1 } });
    assert.equal(r.routed, true);
    assert.equal(r.targetInstance, 'profile1');
    assert.deepEqual(r.result, { result: { ok: true } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1, '不经过 selectBestInstance，只有一次 /call');
  const call = calls[0];
  assert.ok(call.url.includes(':19388/call'), '必须使用 profile1 的端口 19388');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, `Bearer ${agentToken}`);
  assert.deepEqual(JSON.parse(call.init.body), { name: 'browser_read', arguments: { q: 1 } });
});
