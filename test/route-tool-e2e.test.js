// P1 wiring regression (0.37.2): the scheduler bridge must be reachable from
// the real /call path, must not bypass agent governance, and must never
// implicitly forward. Every assertion here goes through real HTTP, not a
// hand-built result object.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';
import { createAgentPolicy } from '../src/policy.js';

const config = { port: 0, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64) };
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const AUTH = { Authorization: `Bearer ${config.agentToken}` };

async function setup(t, options = {}) {
  const b = createBridge(config, { leaseStateFile: null, ...options });
  const address = await b.listen();
  t.after(() => b.close());
  return { b, base: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/extension` };
}

async function connectHost(wsUrl, hostId) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({
    type: 'hello', token: config.extensionToken, hostId, version: '0.37.2',
    protocolVersion: 2, hostKind: 'stable', chromeVersion: '156.0.8078.49',
    extensionId: 'a'.repeat(32)
  }));
  assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
  return ws;
}

async function getStatus(base) {
  const res = await fetch(`${base}/status`, { headers: AUTH });
  return res.json();
}

async function postCall(base, name, args = {}) {
  const res = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args })
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

test('the scheduler bridge is wired and reported through real HTTP', async t => {
  const { base, wsUrl } = await setup(t);
  const ws = await connectHost(wsUrl, 'wired-host');
  const status = await getStatus(base);
  assert.equal(status.scheduler.wired, true);
  assert.equal(status.scheduler.routeTool, 'browser_route_task');
  assert.deepEqual(status.scheduler.capabilities, ['conflict_evidence', 'explicit_instance_routing']);
  assert.match(JSON.stringify(status), /"scheduler":\{/);
  const reply = await postCall(base, 'browser_scheduler_status', {});
  assert.equal(reply.json.result.status, 'success');
  assert.equal(reply.json.result.wired, true);
  ws.close();
});

test('/status derives host connectivity from the registry, not the primary mirror', async t => {
  const { base, wsUrl } = await setup(t);
  const a = await connectHost(wsUrl, 'host-a');
  const c = await connectHost(wsUrl, 'host-b');
  const status = await getStatus(base);
  assert.equal(status.hostCount, 2);
  assert.equal(status.hostsConnected, 2);
  assert.equal(status.hostsDegraded, 0, 'both hosts are protocol 2');
  assert.equal(status.connected, true, 'legacy primary mirror stays for compatibility');
  a.close(); c.close();
});

test('single-instance mode never forwards and recursion is refused', async t => {
  const { base, wsUrl } = await setup(t);
  const ws = await connectHost(wsUrl, 'solo');
  const routed = await postCall(base, 'browser_route_task', { name: 'browser_read', arguments: { tabId: 1 } });
  assert.equal(routed.json.result.status, 'waiting');
  assert.equal(routed.json.result.reason, 'single_instance_mode');
  assert.equal(routed.json.result.dispatched, false);
  assert.match(routed.text, /"dispatched":false/);
  const recursive = await postCall(base, 'browser_route_task', { name: 'browser_route_task', arguments: {} });
  assert.equal(recursive.json.result.status, 'denied');
  assert.equal(recursive.json.result.reason, 'routing_recursion_blocked');
  ws.close();
});

test('agent governance is not bypassed by the routing tool', async t => {
  const file = join(mkdtempSync(join(tmpdir(), 'aib-route-policy-')), 'agents.json');
  createAgentPolicy({ file }).set('limited', {
    scopes: ['read', 'write', 'lease'], tools: { deny: ['browser_route_task'] }
  });
  const { base, wsUrl } = await setup(t, { agentPolicyFile: file });
  const ws = await connectHost(wsUrl, 'governed');
  const reply = await postCall(base, 'browser_route_task', {
    name: 'browser_read', arguments: { tabId: 1 }, agent: 'limited'
  });
  assert.equal(reply.json.result.status, 'denied');
  assert.match(reply.json.result.reason, /denied/);
  assert.equal(reply.json.result.dispatched, undefined, 'nothing was forwarded');
  ws.close();
});

test('a malformed arguments payload degrades safely instead of throwing', async t => {
  const { base, wsUrl } = await setup(t);
  const ws = await connectHost(wsUrl, 'safe');
  const reply = await postCall(base, 'browser_route_task', { name: 'browser_read', arguments: 'not-an-object' });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.result.status, 'waiting');
  assert.equal(reply.json.result.dispatched, false);
  ws.close();
});

test('conflict evidence is advisory and visible on queued jobs', async t => {
  // Short read timeouts let both promises resolve without any extension
  // result, so the observation stays side-effect free and fast.
  const { b, wsUrl } = await setup(t, { timeoutMs: 80 });
  const ws = await connectHost(wsUrl, 'conflicts');
  const first = b.call('browser_read', { tabId: 1 });
  const second = b.call('browser_read', { tabId: 2 });
  const snapshot = b.status();
  assert.equal(snapshot.queued, 1);
  assert.ok(Object.hasOwn(snapshot.queuedJobs[0], 'conflictEvidence'), 'projection must not drop the new field');
  assert.equal(typeof snapshot.queuedJobs[0].conflictEvidence, 'boolean');
  assert.equal(snapshot.scheduler.wired, true);
  await Promise.all([first, second]);
  ws.close();
});
