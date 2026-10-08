import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

// Point the persisted lease file at a scratch dir before the service module
// computes stateDir, so tests never touch the real .local state.
process.env.AIB_STATE_DIR = mkdtempSync(join(tmpdir(), 'aib-lease-service-'));
const { createBridge } = await import('../src/server.js');

const config = { port: 0, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64) };

async function setup(t) {
  // Each bridge gets its own lease file so tests cannot observe each other.
  const b = createBridge(config, { leaseStateFile: join(mkdtempSync(join(tmpdir(), 'aib-bridge-')), 'tab-leases.json') });
  const address = await b.listen();
  t.after(() => b.close());
  return { b, wsUrl: `ws://127.0.0.1:${address.port}/extension` };
}

async function connectExtension(url) {
  const ws = new WebSocket(url, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', token: config.extensionToken }));
  assert.equal(JSON.parse((await ready)[0]).type, 'ready');
  return ws;
}

test('lease tools are answered by the service without dispatching to the extension', async t => {
  // No extension connected at all: lease bookkeeping must still work, which is
  // only possible if it is handled locally instead of queued for the browser.
  const { b } = await setup(t);
  const lease = await b.call('browser_claim_tab', { tabId: 21, agent: 'agentA', ttlMs: 5000 });
  assert.equal(lease.agent, 'agentA');
  assert.equal(lease.tabId, 21);
  assert.equal((await b.call('browser_tab_lease', { tabId: 21 })).lease.agent, 'agentA');
});

test('a conflicting claim is refused immediately and never reaches the browser', async t => {
  const { b, wsUrl } = await setup(t);
  const ws = await connectExtension(wsUrl);
  const dispatched = [];
  ws.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.type === 'command') dispatched.push(msg.name); });
  await b.call('browser_claim_tab', { tabId: 22, agent: 'agentA', ttlMs: 5000 });

  const started = Date.now();
  const conflict = await b.call('browser_claim_tab', { tabId: 22, agent: 'agentB' });
  assert.equal(conflict.status, 'waiting');
  assert.equal(conflict.reason, 'tab_write_lease_conflict');
  assert.equal(conflict.holder, 'agentA');
  assert.ok(Date.now() - started < 2000, `conflict must not block, took ${Date.now() - started}ms`);
  assert.deepEqual(dispatched, [], 'lease bookkeeping must not be dispatched to the extension');
});

test('governed writes are refused before dispatch while reads still pass', async t => {
  const { b, wsUrl } = await setup(t);
  const ws = await connectExtension(wsUrl);
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'command') ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: msg.name } }));
  });
  await b.call('browser_claim_tab', { tabId: 23, agent: 'agentA', ttlMs: 5000 });

  const blocked = await b.call('browser_fill', { tabId: 23, ref: 'r', text: 'x', agent: 'agentB' });
  assert.equal(blocked.reason, 'tab_write_lease_conflict');
  assert.equal(blocked.tool, 'browser_fill');
  // A read-only tool is not governed and still reaches the extension.
  assert.deepEqual(await b.call('browser_read', { tabId: 23 }), { ok: 'browser_read' });
});

test('a tab closed in Chrome releases its lease through the extension event', async t => {
  const { b, wsUrl } = await setup(t);
  const ws = await connectExtension(wsUrl);
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'command') ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { closed: true } }));
  });
  await b.call('browser_claim_tab', { tabId: 24, agent: 'agentA', ttlMs: 60_000 });
  assert.equal((await b.call('browser_tab_lease', { tabId: 24 })).lease.agent, 'agentA');

  ws.send(JSON.stringify({ type: 'tab-removed', tabId: 24 }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await b.call('browser_tab_lease', { tabId: 24 })).lease, null, 'closed tab must not stay reserved');
  assert.equal((await b.call('browser_claim_tab', { tabId: 24, agent: 'agentB' })).agent, 'agentB');
});

test('browser_close releases the lease it held', async t => {
  const { b, wsUrl } = await setup(t);
  const ws = await connectExtension(wsUrl);
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'command') ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { closed: true } }));
  });
  await b.call('browser_claim_tab', { tabId: 25, agent: 'agentA', ttlMs: 60_000 });
  assert.deepEqual(await b.call('browser_close', { tabId: 25, agent: 'agentA' }), { closed: true });
  assert.equal((await b.call('browser_tab_lease', { tabId: 25 })).lease, null);
});

test('leases are visible in queue status for every agent', async t => {
  const { b } = await setup(t);
  await b.call('browser_claim_tab', { tabId: 26, agent: 'agentA', ttlMs: 5000 });
  const status = b.status();
  assert.equal(status.tabLeases.length, 1);
  assert.equal(status.tabLeases[0].tabId, 26);
  assert.equal(status.tabLeases[0].agent, 'agentA');
  assert.ok(status.tabLeases[0].expiresInMs > 0);
});
