import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';
import { validateCall } from '../src/tools.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config = { port: 0, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64) };
async function setup(t, options) {
  const b = createBridge(config, options); const address = await b.listen();
  t.after(() => b.close());
  return { b, base: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/extension` };
}
async function extension(url, token = config.extensionToken) {
  const ws = new WebSocket(url, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', token }));
  assert.equal(JSON.parse((await ready)[0]).type, 'ready');
  return ws;
}
test('HTTP requires token and rejects browser origins and DNS rebinding hosts', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(`${base}/status`)).status, 401);
  const headers = { Authorization: `Bearer ${config.agentToken}` };
  assert.equal((await fetch(`${base}/status`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/status`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  // fetch rewrites Host; use a raw HTTP client to exercise the actual check.
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/status`, { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
});
test('websocket denies website origin and wrong pairing key', async t => {
  const { wsUrl } = await setup(t);
  const bad = new WebSocket(wsUrl, { origin: 'https://evil.example' });
  const [error] = await once(bad, 'error'); assert.match(error.message, /403/);
  const ws = new WebSocket(wsUrl, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open'); const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
  assert.equal((await closed)[0], 4001);
});
test('strict validation denies unsupported actions and unsafe URL schemes', () => {
  assert.throws(() => validateCall('eval', {}));
  assert.throws(() => validateCall('browser_read', { tabId: -1 }));
  assert.throws(() => validateCall('browser_fill', { tabId: 1, ref: 'a', text: 'ok', execute: true }));
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'https://user:pass@example.com']) assert.throws(() => validateCall('browser_open', { url }));
  validateCall('browser_fill', { tabId: 1, ref: 'a', text: '' });
  validateCall('browser_scroll', { tabId: 1, deltaY: 10, agent: 'lease-owner' });
  assert.throws(() => validateCall('browser_scroll', { tabId: 1, deltaY: 10, agent: '' }));
  assert.throws(() => validateCall('browser_upload', { tabId: 1, ref: 'a', filePath: 'C:/a.zip', sha256: 'bad' }));
});

test('upload is root-confined, hash-bound, and sends bytes without the local path', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aib-upload-'));
  const filePath = join(root, 'candidate.zip');
  const bytes = Buffer.from('safe fixture');
  writeFileSync(filePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const bridge = createBridge({ ...config, uploadRoots: [root] });
  await bridge.listen();
  t.after(() => bridge.close());
  const url = `ws://127.0.0.1:${bridge.server.address().port}/extension`;
  const ws = await extension(url);
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'command') return;
    assert.equal(msg.name, 'browser_upload');
    assert.equal(msg.args.fileName, 'candidate.zip');
    assert.equal(msg.args.data, bytes.toString('base64'));
    assert.equal(msg.args.filePath, undefined);
    ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { selected: true, sha256 } }));
  });
  assert.deepEqual(await bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath, sha256 }), { selected: true, sha256 });
  assert.throws(() => bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath, sha256: '0'.repeat(64) }), /mismatch/);
  assert.throws(() => bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath: import.meta.filename, sha256 }), /outside/);
});
test('two clients serialize; response ids match and audit omits typed content', async t => {
  const audit = []; const { b, wsUrl } = await setup(t, { audit: row => audit.push(row) });
  const ws = await extension(wsUrl); const received = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw); if (msg.type !== 'command') return;
    received.push(msg);
    setTimeout(() => ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { value: msg.args.text } })), 30);
  });
  const first = b.call('browser_fill', { tabId: 1, ref: 'first', text: 'SECRET_1' });
  const second = b.call('browser_fill', { tabId: 1, ref: 'second', text: 'SECRET_2' });
  assert.equal(b.status().queued, 1);
  assert.deepEqual(await Promise.all([first, second]), [{ value: 'SECRET_1' }, { value: 'SECRET_2' }]);
  assert.equal(received.length, 2); assert.notEqual(received[0].id, received[1].id);
  assert.equal(audit.length, 2); assert.ok(!JSON.stringify(audit).includes('SECRET'));
});
test('disconnect fails active and queued requests without replay', async t => {
  const { b, wsUrl } = await setup(t); const ws = await extension(wsUrl);
  const first = assert.rejects(b.call('browser_click', { tabId: 1, ref: 'one' }), /unknown/);
  const second = assert.rejects(b.call('browser_click', { tabId: 1, ref: 'two' }), /Not executed/);
  ws.close(); await Promise.all([first, second]); assert.equal(b.status().queued, 0);
});
test('timeout stops queue and reports uncertain outcome instead of retrying a write', async t => {
  const { b, wsUrl } = await setup(t, { timeoutMs: 60 }); await extension(wsUrl);
  const first = assert.rejects(b.call('browser_click', { tabId: 1, ref: 'one' }), /unknown/);
  const second = assert.rejects(b.call('browser_click', { tabId: 1, ref: 'two' }), /Not executed/);
  await Promise.all([first, second]); assert.equal(b.status().connected, false);
});

test('read-only timeout fails only that request and keeps the bridge connected', async t => {
  const { b, wsUrl } = await setup(t, { timeoutMs: 60 });
  const ws = await extension(wsUrl);
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'command') return;
    if (msg.name === 'browser_read') return;
    if (msg.name === 'browser_tabs') ws.send(JSON.stringify({ type: 'result', id: msg.id, result: [{ id: 1, title: 'still alive' }] }));
  });
  const first = assert.rejects(b.call('browser_read', { tabId: 1 }), /bridge remains connected/);
  const second = b.call('browser_tabs', {});
  assert.deepEqual(await second, [{ id: 1, title: 'still alive' }]);
  await first;
  assert.equal(b.status().connected, true);
  assert.equal(b.status().queued, 0);
});
