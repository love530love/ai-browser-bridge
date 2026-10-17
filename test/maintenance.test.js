import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../src/server.js';

test('maintenance atomically gates admission, validates ownership and expires', async t => {
  const bridge = createBridge({ port: 0, agentToken: 'test-secret', extensionToken: 'ext' }, { leaseStateFile: null, agentPolicyFile: null });
  const { port } = await bridge.listen();
  t.after(() => bridge.close());
  const post = (data, token = 'test-secret') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/maintenance', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ code: res.statusCode, ...JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(data));
  });
  assert.equal((await post({ action: 'acquire' }, 'wrong')).code, 401);
  assert.equal((await post({ action: 'acquire', ttlMs: 0 })).code, 400);
  const results = await Promise.all([post({ action: 'acquire' }), post({ action: 'acquire' })]);
  assert.deepEqual(results.map(x => x.status).sort(), ['acquired', 'waiting']);
  const held = results.find(x => x.status === 'acquired');
  assert.equal(bridge.status().maintenance.token, undefined);
  const waiting = await bridge.call('browser_tabs', {});
  assert.equal(waiting.reason, 'maintenance'); assert.equal(waiting.dispatched, false);
  assert.equal((await bridge.call('browser_claim_tab', { tabId: 1, agent: 'other' })).reason, 'maintenance');
  assert.equal((await bridge.call('browser_wait_until_ready', { timeoutMs: 100, idle: false })).ready, false);
  assert.equal((await post({ action: 'release', token: 'wrong' })).code, 409);
  assert.equal((await post({ action: 'release', token: held.token })).status, 'released');
  assert.equal((await bridge.call('browser_tabs', {})).reason, 'extension_disconnected');
  await bridge.call('browser_claim_tab', { tabId: 1, agent: 'owner' });
  assert.equal((await post({ action: 'acquire' })).status, 'waiting');
  await bridge.call('browser_release_tab', { tabId: 1, agent: 'owner' });
  assert.equal((await post({ action: 'acquire', ttlMs: 1000 })).status, 'acquired');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(bridge.status().maintenance, null);
});
