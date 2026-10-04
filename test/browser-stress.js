import { chromium } from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBridge } from '../src/server.js';
import { ROOT } from '../src/config.js';

const out = join(ROOT, 'output', 'stress');
mkdirSync(out, { recursive: true });
const checks = [];
const mark = name => { checks.push(name); console.log(`PASS ${name}`); };

function heavyPage(name) {
  const rows = [];
  for (let i = 0; i < 2600; i++) {
    const task = i === 114 ? 'Task 114 card_b 评测失败 下一步：上传代码' : `Task ${i} background row`;
    rows.push(`<section class="row"><h2>${task}</h2><p>重网页段落 ${name} ${i} ${'状态更新 '.repeat(5)}</p><button>打开 ${name} ${i}</button><a href="/heavy-${name}?row=${i}">详情 ${i}</a></section>`);
  }
  const controls = [];
  for (let i = 0; i < 160; i++) controls.push(`<label>批量输入 ${i}<input value="value-${i}"></label>`);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Heavy ${name}</title>
  <style>body{font:14px system-ui;margin:24px}.row{padding:8px;border-bottom:1px solid #ddd}#hidden{display:none}input,button{font:inherit;margin:3px;padding:4px}</style>
  <h1>重网页 ${name}</h1><label>用户备注<input id="note"></label><button id="save">保存备注</button><p id="status">等待操作</p>
  <input type="password" value="PASSWORD_STRESS_SECRET"><p id="hidden">HIDDEN_STRESS_SECRET</p><p data-ai-private>PRIVATE_STRESS_SECRET</p>
  ${controls.join('')}${rows.join('')}
  <script>document.querySelector('#save').onclick=()=>{document.querySelector('#status').textContent='已保存：'+document.querySelector('#note').value};</script></html>`;
}

const config = { port: 0, agentToken: randomBytes(32).toString('hex'), extensionToken: randomBytes(32).toString('hex') };
const bridge = createBridge(config, { timeoutMs: 10000 });
const address = await bridge.listen();
config.port = address.port;

const fixture = http.createServer((req, res) => {
  const key = new URL(req.url, 'http://127.0.0.1').pathname.replace('/heavy-', '') || 'a';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(heavyPage(key));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'aib-stress-profile-'));
const state = mkdtempSync(join(tmpdir(), 'aib-stress-state-'));
writeFileSync(join(state, 'config.json'), JSON.stringify(config));
const bundled = join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
const executablePath = process.env.AIB_TEST_CHROMIUM || (existsSync(bundled) ? bundled : undefined);
let context;

async function rawCall(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${config.port}/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.result;
}

async function call(name, args = {}) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await rawCall(name, args);
    if (result?.status !== 'waiting' || !result.retryable) return result;
    if (result.nextPollTool) await rawCall(result.nextPollTool, result.nextPollArgs || { timeoutMs: result.suggestedDelayMs ?? 1000 });
    else await new Promise(resolve => setTimeout(resolve, result.suggestedDelayMs ?? 250));
  }
  throw new Error(`Still waiting after retries for ${name}`);
}

async function waitExtensionConnected(panel) {
  let last;
  for (let i = 0; i < 100; i++) {
    last = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
    const state = bridge.status();
    if (last.connectionState === '已连接' && state.connected && !state.active && state.queued === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Extension did not connect: ${JSON.stringify({ extension: last, bridge: bridge.status() })}`);
}

async function waitTabReady(tabId) {
  let last;
  for (let i = 0; i < 80; i++) {
    last = await call('browser_health', { tabId });
    const probe = last?.tab?.pageProbe;
    if (probe?.ok && probe.hasBody && (probe.readyState === 'interactive' || probe.readyState === 'complete')) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Tab ${tabId} did not become script-readable: ${JSON.stringify(last)}`);
}

try {
  const extensionPath = join(ROOT, 'extension');
  context = await chromium.launchPersistentContext(profile, { executablePath, channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.locator('#token').fill(config.extensionToken);
  await panel.locator('#port').fill(String(config.port));
  await panel.locator('#all-sites').check();
  await panel.locator('#save').click();
  await waitExtensionConnected(panel);
  mark('stress harness connected real extension to local bridge');

  const opened = [];
  for (const key of ['a', 'b', 'c']) opened.push(await call('browser_open', { url: `${origin}/heavy-${key}` }));
  const tabIds = opened.map(tab => tab.tabId);
  await Promise.all(tabIds.map(waitTabReady));
  mark('opened three independent heavy local pages');

  const secretNeedles = ['PASSWORD_STRESS_SECRET', 'HIDDEN_STRESS_SECRET', 'PRIVATE_STRESS_SECRET'];
  async function findWithRetry(tabId, query, args = {}, expected = true) {
    let result;
    for (let i = 0; i < 12; i++) {
      result = await call('browser_find_text', { tabId, query, maxMatches: 3, contextChars: 120, budgetMs: 3000, ...args });
      if (!!result.found === expected) return result;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return result;
  }

  const findPersona = async () => {
    await Promise.all(tabIds.map(async tabId => {
      assert.equal((await findWithRetry(tabId, 'Task 114', { mode: 'cheap' })).found, true);
      assert.equal((await findWithRetry(tabId, '评测失败', { mode: 'normal' })).found, true);
      for (const secret of secretNeedles) assert.equal((await findWithRetry(tabId, secret, { mode: 'cheap', maxMatches: 1 }, false)).found, false);
    }));
    mark('finder persona found target task text without leaking hidden or private text');
  };

  const readerPersona = async () => {
    const normal = await call('browser_read', { tabId: tabIds[0], maxChars: 3000, maxElements: 40, maxTextNodes: 500, budgetMs: 250 });
    assert.equal(normal.status, undefined);
    assert.ok(typeof normal.text === 'string');
    assert.ok(normal.partial || normal.truncated || normal.diagnostics.elementsBudgetHit || normal.diagnostics.textBudgetHit);
    const cheap = await call('browser_read', { tabId: tabIds[1], mode: 'cheap', maxChars: 3000, maxElements: 40, maxTextNodes: 500, budgetMs: 250 });
    assert.ok(cheap.partial);
    for (const secret of secretNeedles) assert.ok(!JSON.stringify(cheap).includes(secret));
    mark('reader persona received bounded partial reads on heavy pages');
  };

  const diagnosticsPersona = async () => {
    const [health, debug, observe] = await Promise.all([
      call('browser_health', { tabId: tabIds[0] }),
      call('browser_debug', { tabId: tabIds[1] }),
      call('browser_observe', { tabId: tabIds[2], maxChars: 2000 })
    ]);
    assert.equal(health.connected, true);
    assert.ok(debug.roleCounts.button >= 100);
    assert.ok(observe.read.text.includes('重网页'));
    mark('diagnostics persona inspected health debug and observe during load');
  };

  const writerPersona = async () => {
    let input;
    for (let i = 0; i < 20 && !input?.ref; i++) {
      if (i > 0) await call('browser_wait_until_ready', { timeoutMs: 2000, idle: true });
      const read = await call('browser_read', { tabId: tabIds[0], maxElements: 500, maxTextNodes: 1200, budgetMs: 8000 });
      input = read.elements?.find(el => el.ref && el.label === '用户备注');
      if (!input?.ref) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(input?.ref);
    await call('browser_claim_tab', { tabId: tabIds[0], agent: 'writer-owner', ttlMs: 5000 });
    const conflict = await rawCall('browser_fill', { tabId: tabIds[0], ref: input.ref, text: 'should-not-write', agent: 'writer-rival' });
    assert.equal(conflict.status, 'waiting');
    assert.equal(conflict.reason, 'tab_write_lease_conflict');
    const filled = await call('browser_fill_verified', { tabId: tabIds[0], ref: input.ref, text: 'owner-write-ok', expect: { valueMatches: 'owner-write-ok' }, agent: 'writer-owner' });
    assert.equal(filled.status, 'success');
    await call('browser_release_tab', { tabId: tabIds[0], agent: 'writer-owner' });
    mark('writer persona enforced tab lease under concurrent access');
  };

  const crowdPersona = async () => {
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      const tabId = tabIds[i % tabIds.length];
      jobs.push(i % 2 === 0
        ? call('browser_find_text', { tabId, query: 'card_b', mode: 'cheap', maxMatches: 5, contextChars: 80 })
        : call('browser_read', { tabId, mode: 'cheap', maxChars: 1200, maxElements: 20, maxTextNodes: 300, budgetMs: 200 }));
    }
    const results = await Promise.all(jobs);
    assert.equal(results.length, 12);
    assert.ok(results.some(result => result.found === true));
    assert.ok(results.every(result => result.status !== 'waiting'));
    mark('crowd persona completed twelve simultaneous bounded read-only requests');
  };

  await Promise.all([findPersona(), readerPersona(), diagnosticsPersona(), crowdPersona()]);
  mark('read-only personas completed under concurrent heavy-page pressure');
  await writerPersona();

  const slow = call('browser_wait', { tabId: tabIds[0], text: 'TEXT_THAT_WILL_NOT_APPEAR', timeoutMs: 3000 }).catch(error => ({ error: error.message }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const overload = await Promise.all(Array.from({ length: 24 }, (_, i) => rawCall('browser_find_text', { tabId: tabIds[i % tabIds.length], query: 'Task 114', mode: 'cheap', maxMatches: 1, contextChars: 40 })));
  const full = overload.filter(result => result.status === 'waiting' && result.reason === 'queue_full');
  const found = overload.filter(result => result.found === true);
  assert.ok(full.length >= 1, `expected queue_full, got ${JSON.stringify(overload.map(result => result.reason || result.found).slice(0, 30))}`);
  assert.ok(found.length >= 1);
  await slow;
  mark('overload persona observed queue_full backpressure while queued reads still completed');

  writeFileSync(join(out, 'stress-report.json'), JSON.stringify({
    date: new Date().toISOString(),
    checks,
    tabs: tabIds.length,
    queueFullResponses: full.length,
    completedOverloadReads: found.length,
    status: 'passed'
  }, null, 2));
  console.log(`All ${checks.length} stress checks passed. Artifacts: output/stress/`);
} catch (error) {
  writeFileSync(join(out, 'stress-failure.json'), JSON.stringify({ date: new Date().toISOString(), checks, error: error.stack }, null, 2));
  throw error;
} finally {
  await context?.close();
  await bridge.close();
  await new Promise(resolve => fixture.close(resolve));
}
