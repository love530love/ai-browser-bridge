// CNIPA M1 (P0-1/P0-2/P0-3) real-boundary tests: a real bridge listens, a real
// extension websocket answers, and a real config file is edited on disk. Pure
// unit tests cannot prove that a running service picks up a new upload root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';

const config = { port: 0, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64) };
const shaOf = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function writeConfig(file, roots, maxBytes) {
  writeFileSync(file, JSON.stringify({
    port: 19387, agentToken: config.agentToken, extensionToken: config.extensionToken,
    uploadRoots: roots, uploadMaxBytes: maxBytes
  }));
}

async function fixture(t, uploadConfigPath) {
  const bridge = createBridge({ ...config, uploadRoots: [] }, { uploadConfigPath });
  const address = await bridge.listen();
  t.after(() => bridge.close());
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/extension`,
    { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', token: config.extensionToken }));
  assert.equal(JSON.parse((await ready)[0]).type, 'ready');
  const sent = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'command') return;
    sent.push(msg.args);
    ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { selected: true } }));
  });
  t.after(() => ws.close());
  return { bridge, sent };
}

test('P0-1 a PDF resolves to application/pdf, explicit mimeType wins, both are echoed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aib-cnipa-mime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = join(dir, '01_事实与理由.pdf');
  writeFileSync(pdf, Buffer.from('fixture pdf bytes'));
  const sha256 = shaOf(pdf);
  const file = join(dir, 'config.json');
  writeConfig(file, [dir], 16 * 1024 * 1024);
  const { bridge, sent } = await fixture(t, file);

  await bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath: pdf, sha256 });
  assert.equal(sent[0].mimeType, 'application/pdf', 'PDF must not be octet-stream');
  assert.equal(sent[0].mimeSource, 'extension');
  assert.equal(sent[0].configSource, 'config.json (live)');
  assert.equal(sent[0].fileName, '01_事实与理由.pdf');

  await bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath: pdf, sha256, mimeType: 'application/x-custom' });
  assert.equal(sent[1].mimeType, 'application/x-custom');
  assert.equal(sent[1].mimeSource, 'explicit');
  assert.throws(() => bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath: pdf, sha256, mimeType: 'not-a-mime' }), /Invalid mimeType/);
});

test('P0-2 hidden input targets are forwarded, and ambiguous targets are refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aib-cnipa-target-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = join(dir, 'identity.pdf');
  writeFileSync(pdf, Buffer.from('id'));
  const sha256 = shaOf(pdf);
  const file = join(dir, 'config.json');
  writeConfig(file, [dir], 16 * 1024 * 1024);
  const { bridge, sent } = await fixture(t, file);

  await bridge.call('browser_upload', { tabId: 1, selector: '#form_item_idetCertCnAttJson', filePath: pdf, sha256 });
  assert.equal(sent[0].selector, '#form_item_idetCertCnAttJson');
  assert.equal(sent[0].ref, undefined);

  await bridge.call('browser_upload', { tabId: 1, inputIndex: 2, filePath: pdf, sha256 });
  assert.equal(sent[1].inputIndex, 2);

  assert.throws(() => bridge.call('browser_upload', { tabId: 1, filePath: pdf, sha256 }), /Upload target required/);
  assert.throws(() => bridge.call('browser_upload', { tabId: 1, ref: 'r', selector: '#x', filePath: pdf, sha256 }), /exactly one upload target/);
});

test('P0-3 a changed upload root and ceiling take effect without restarting the service', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aib-cnipa-hot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rootA = join(dir, 'a');
  const rootB = join(dir, 'b');
  mkdirSync(rootA); mkdirSync(rootB);
  const big = join(rootB, 'evidence.pdf');
  writeFileSync(big, Buffer.alloc(2048));
  const sha256 = shaOf(big);
  const file = join(dir, 'config.json');
  writeConfig(file, [rootA], 1024);
  const { bridge, sent } = await fixture(t, file);

  assert.throws(() => bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath: big, sha256 }), /outside configured upload roots/);

  // Edit the SAME config file the running service reads; force a new mtime so
  // the cache cannot be fooled by a same-millisecond write.
  writeConfig(file, [rootA, rootB], 4096);
  const later = new Date(Date.now() + 2000);
  utimesSync(file, later, later);

  await bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath: big, sha256 });
  const last = sent[sent.length - 1];
  assert.equal(last.uploadMaxBytes, 4096);
  assert.equal(last.configSource, 'config.json (live)');
  assert.equal(last.data, Buffer.alloc(2048).toString('base64'));

  writeConfig(file, [rootA, rootB], 512);
  const newest = new Date(Date.now() + 4000);
  utimesSync(file, newest, newest);
  assert.throws(() => bridge.call('browser_upload', { tabId: 1, ref: 'r', filePath: big, sha256 }),
    /1 byte\.\.512 bytes \(source: config\.json \(live\)\)/, 'rejection must report the live ceiling and its source');
});
