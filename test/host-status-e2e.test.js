// P1 端到端投影回归（0.37.1）。
//
// 0.29.0 事故：报告读 result.verdict 而调用从未构造它，页面恒显示
// **undefined**，但 640 条单测全绿——因为单测自己拼结果对象，从不走真实
// HTTP 边界。这里每一条断言都打真实 GET /status 与 POST /call，检查响应
// 文本/对象里的字段“值”，而不是内部 status()/call() 对象。
//
// hermetic：port:0 + leaseStateFile:null，不连 19387，不碰任何现有文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';

const config = { port: 0, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64) };
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const HOST_VERSION = '0.37.1';
const CHROME_VERSION = '156.0.8078.49';
const AUTH = { Authorization: `Bearer ${config.agentToken}` };

async function setup(t) {
  const b = createBridge(config, { leaseStateFile: null });
  const address = await b.listen();
  t.after(() => b.close());
  return { b, base: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/extension` };
}

// 与 test/multi-host.test.js 的 connectHost 同构：真实 WebSocket 握手。
async function connectHost(wsUrl, hostId, extra = {}) {
  const ws = new WebSocket(wsUrl, { origin: ORIGIN });
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({
    type: 'hello', token: config.extensionToken, hostId, version: HOST_VERSION,
    protocolVersion: 2, hostKind: 'stable', chromeVersion: CHROME_VERSION,
    extensionId: 'a'.repeat(32), ...extra
  }));
  const readyMsg = JSON.parse((await ready)[0].toString());
  assert.equal(readyMsg.type, 'ready');
  return { ws, ready: readyMsg };
}

// 真实 fetch，保留原始响应文本以便检查字段值。
async function httpGet(base, path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers: { ...AUTH, ...headers } });
  const text = await res.text();
  return { res, text, json: JSON.parse(text) };
}
async function httpPostCall(base, body) {
  const res = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { res, text, json: JSON.parse(text) };
}

function own(obj, key, label) {
  assert.ok(obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key), `${label}: 缺少字段 ${key}`);
  return obj[key];
}
// JSON 不会序列化 undefined，“漏字段”在响应里表现为 key 缺失。所以替代
// `:undefined` 字符串检查的正解是字段存在性 + 值检查。
function assertFieldsPresent(obj, fields, label) {
  for (const field of fields) {
    const value = own(obj, field, label);
    assert.notEqual(value, undefined, `${label}: 字段 ${field} 为 undefined`);
    assert.notEqual(value, 'undefined', `${label}: 字段 ${field} 为字符串 "undefined"`);
  }
}
function visitLeaves(value, fn, path) {
  if (Array.isArray(value)) { value.forEach((v, i) => visitLeaves(v, fn, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) visitLeaves(v, fn, `${path}.${k}`);
    return;
  }
  fn(value, path);
}
function assertNoUndefinedProjection(root, label) {
  const text = JSON.stringify(root);
  assert.ok(!text.includes(':undefined'), `${label}: 响应文本出现 ":undefined"`);
  visitLeaves(root, (value, path) => {
    assert.notEqual(value, undefined, `${label}: ${path} 是 undefined`);
    assert.notEqual(value, 'undefined', `${label}: ${path} 是字符串 "undefined"`);
  }, '$');
}

test('1. /status 投影：顶层字段、hosts[] 字段齐全且与握手逐字一致（裸 GET 为 401 鉴权）', async t => {
  const { base, wsUrl } = await setup(t);
  // 裸 GET 返回 401 是预期鉴权失败，不是服务不可达；带 Bearer 才是 200。
  const bare = await fetch(`${base}/status`);
  assert.equal(bare.status, 401);
  await bare.text();
  await connectHost(wsUrl, 'host-alpha');

  const { res, text, json } = await httpGet(base, '/status');
  assert.equal(res.status, 200);
  assertFieldsPresent(json, ['hostCount', 'hosts', 'activeCount', 'activeByHost'], '/status');
  assert.equal(json.hostCount, 1);
  assert.equal(json.activeCount, 0);
  assert.ok(Array.isArray(json.hosts) && json.hosts.length === 1);
  assert.ok(Array.isArray(json.activeByHost));

  const h = json.hosts[0];
  assertFieldsPresent(h, ['hostId', 'protocolVersion', 'extensionVersion', 'connected', 'inFlight', 'features'], '/status.hosts[0]');
  assert.equal(h.hostId, 'host-alpha');
  assert.equal(h.extensionVersion, HOST_VERSION);
  assert.equal(h.protocolVersion, 2);
  assert.equal(h.connected, true);
  assert.equal(h.inFlight, false);
  assert.equal(typeof h.features, 'object');
  // 响应文本里必须是真实字段值，而非 **undefined**。
  assert.ok(text.includes('"hostId":"host-alpha"'), '文本缺 hostId 值');
  assert.ok(text.includes(`"extensionVersion":"${HOST_VERSION}"`), '文本缺 extensionVersion 值');
  assert.ok(text.includes('"hostCount":1'), '文本缺 hostCount 值');
});

test('2. browser_hosts 经真实 /call 边界：policy.exclusivity/primaryHostId/hostCount/serviceVersion/hostKindObserved', async t => {
  const { base, wsUrl } = await setup(t);
  await connectHost(wsUrl, 'host-alpha');

  const { res, text, json } = await httpPostCall(base, { name: 'browser_hosts', arguments: {} });
  assert.equal(res.status, 200);
  const r = own(json, 'result', '/call');
  assertFieldsPresent(r, ['status', 'policy', 'primaryHostId', 'hostCount', 'serviceVersion', 'hosts'], 'browser_hosts.result');
  assert.equal(r.status, 'success');
  assert.equal(r.policy.exclusivity, 'none');
  assert.equal(r.primaryHostId, 'host-alpha');
  assert.equal(r.hostCount, 1);
  assert.equal(typeof r.serviceVersion, 'string');
  assert.ok(r.serviceVersion.length > 0);
  assert.ok(Array.isArray(r.hosts) && r.hosts.length === 1);
  const h = r.hosts[0];
  // hostKindObserved 由 socket owner 观察得出，非 chrome 宿主可得到别的字符串，
  // 但字段本身必须被投影出来（漏字段正是本回归要抓的）。
  assert.ok(Object.hasOwn(h, 'hostKindObserved'), 'hosts[] 缺 hostKindObserved');
  assert.equal(typeof h.hostKindObserved, 'string');
  assert.ok(text.includes('"exclusivity":"none"'), '文本缺 exclusivity 值');
  assert.ok(text.includes('"primaryHostId":"host-alpha"'), '文本缺 primaryHostId 值');
});

test('3. 两个不同 hostId 同时连接：/status 的 hostCount===2 且两个 hostId 都在 hosts[]', async t => {
  const { base, wsUrl } = await setup(t);
  await connectHost(wsUrl, 'host-alpha');
  await connectHost(wsUrl, 'host-beta');

  const { res, text, json } = await httpGet(base, '/status');
  assert.equal(res.status, 200);
  assert.equal(json.hostCount, 2, '第二个宿主必须被投影');
  const ids = json.hosts.map(h => h.hostId).sort();
  assert.deepEqual(ids, ['host-alpha', 'host-beta']);
  for (const id of ids) {
    const h = json.hosts.find(x => x.hostId === id);
    assertFieldsPresent(h, ['hostId', 'protocolVersion', 'extensionVersion', 'connected', 'inFlight', 'features'], `hosts.${id}`);
    assert.equal(h.extensionVersion, HOST_VERSION);
    assert.equal(h.connected, true);
  }
  assert.ok(text.includes('"hostCount":2'), '文本缺 hostCount 值');
});

test('4. 非法 hostId（含 : 或 /）经 /call 漏斗返回 400 且错误消息含 hostId', async t => {
  const { base, wsUrl } = await setup(t);
  await connectHost(wsUrl, 'host-alpha');
  for (const bad of ['bad:host', 'bad/host']) {
    const { res, text, json } = await httpPostCall(base, { name: 'browser_read', arguments: { tabId: 1, hostId: bad } });
    assert.equal(res.status, 400, `hostId=${bad} 应被漏斗拒绝`);
    assertFieldsPresent(json, ['error'], `400(hostId=${bad})`);
    assert.match(String(json.error), /hostId/, `hostId=${bad}: ${text}`);
  }
});

test('5. 未连接 hostId:ghost 返回 waiting/host_not_connected 并含 availableHostIds（不静默改派）', async t => {
  const { base, wsUrl } = await setup(t);
  await connectHost(wsUrl, 'host-alpha');

  const { res, text, json } = await httpPostCall(base, { name: 'browser_read', arguments: { tabId: 1, hostId: 'ghost' } });
  assert.equal(res.status, 200);
  const r = own(json, 'result', '/call');
  assert.equal(r.status, 'waiting');
  assert.equal(r.reason, 'host_not_connected');
  assertFieldsPresent(r, ['availableHostIds', 'requestedHostId', 'dispatched', 'hostCount'], 'ghost result');
  assert.deepEqual(r.availableHostIds, ['host-alpha']);
  assert.equal(r.requestedHostId, 'ghost');
  assert.equal(r.dispatched, false);
  assert.ok(text.includes('"reason":"host_not_connected"'), '文本缺 reason 值');
  assert.ok(text.includes('"availableHostIds":["host-alpha"]'), '文本缺 availableHostIds 值');
});

test('6. browser_read 经真实 /call 边界：result 包装与字段值完整', async t => {
  const { base, wsUrl } = await setup(t);
  const { ws } = await connectHost(wsUrl, 'host-alpha');
  const commands = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'command') return;
    commands.push(msg);
    ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { status: 'success', title: 'e2e-read' } }));
  });

  const { res, text, json } = await httpPostCall(base, { name: 'browser_read', arguments: { tabId: 1, hostId: 'host-alpha' } });
  assert.equal(res.status, 200);
  const r = own(json, 'result', '/call');
  assert.equal(r.status, 'success');
  assert.equal(r.title, 'e2e-read');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].hostId, 'host-alpha');
  assert.ok(text.includes('"title":"e2e-read"'), '文本缺 result.title 值');
});

test('7. 明确断言响应里不出现 undefined 字段值（字段存在性检查代替 :undefined 字符串）', async t => {
  const { base, wsUrl } = await setup(t);
  await connectHost(wsUrl, 'host-alpha');

  const statusResp = await httpGet(base, '/status');
  const hostsResp = await httpPostCall(base, { name: 'browser_hosts', arguments: {} });
  const ghostResp = await httpPostCall(base, { name: 'browser_read', arguments: { tabId: 1, hostId: 'ghost' } });

  for (const [label, root] of [['/status', statusResp.json], ['browser_hosts', hostsResp.json], ['ghost', ghostResp.json]]) {
    assertNoUndefinedProjection(root, label);
  }

  // 漏字段在 JSON 里表现为 key 缺失，逐项确认投影完整。
  const s = statusResp.json;
  assertFieldsPresent(s, ['hostCount', 'hosts', 'activeCount', 'activeByHost'], '/status');
  assertFieldsPresent(s.hosts[0], ['hostId', 'protocolVersion', 'extensionVersion', 'connected', 'inFlight', 'features'], '/status.hosts[0]');
  assert.equal(s.hosts[0].hostId, 'host-alpha');
  assert.equal(s.hosts[0].extensionVersion, HOST_VERSION);

  const r = hostsResp.json.result;
  assertFieldsPresent(r, ['status', 'serviceVersion', 'protocolVersion', 'primaryHostId', 'hostCount', 'hosts', 'policy'], 'browser_hosts');
  assertFieldsPresent(r.policy, ['exclusivity', 'refusal', 'capabilityFlags', 'hostId', 'tabIds'], 'browser_hosts.policy');
  assert.equal(r.policy.exclusivity, 'none');
  assertFieldsPresent(r.hosts[0], ['hostId', 'hostKindObserved', 'protocolVersion', 'extensionVersion', 'features', 'connected', 'inFlight'], 'browser_hosts.hosts[0]');

  const g = ghostResp.json.result;
  assertFieldsPresent(g, ['status', 'reason', 'availableHostIds', 'requestedHostId', 'dispatched', 'hostCount'], 'ghost');
  assert.equal(g.reason, 'host_not_connected');
});
