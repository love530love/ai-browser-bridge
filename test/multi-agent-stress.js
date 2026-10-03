import { chromium } from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBridge } from '../src/server.js';
import pkg from '../package.json' with { type: 'json' };
import { ROOT } from '../src/config.js';
import { TOOLS } from '../src/tools.js';

const marks = [];
const mark = (name, data = {}) => { marks.push({ name, ...data }); console.log(`PASS ${name}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`); };
const uploadRoot = mkdtempSync(join(tmpdir(), 'aib-stress-upload-'));
const stateDir = mkdtempSync(join(tmpdir(), 'aib-stress-state-'));
const config = { port: 0, agentToken: randomBytes(32).toString('hex'), extensionToken: randomBytes(32).toString('hex'), uploadRoots: [uploadRoot] };
writeFileSync(join(stateDir, 'config.json'), JSON.stringify(config));
const bridge = createBridge(config, { timeoutMs: 20000 });
const address = await bridge.listen(); config.port = address.port;

function heavyHtml(pageId) {
  const cards = Array.from({ length: 900 }, (_, i) => `<section class="card"><h3>Task ${100 + i % 40} ${i === 414 ? 'fill_bonus_tokens 目标锚点' : 'operator_' + i}</h3><p>第${pageId}号重页面段落 ${i} 包含竞赛、提交、排行榜、card_b、评测结果等信息。</p><button data-i="${i}">按钮 ${i} 提交作品</button><input aria-label="搜索赛题 ${i}" value=""></section>`).join('');
  const options = Array.from({ length: 200 }, (_, i) => `<li role="option">Task ${100 + i} option_${i}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>重页面 ${pageId}</title><style>body{font:14px sans-serif}.card{padding:4px;border-bottom:1px solid #ddd}.hidden{display:none}</style><h1>重网页压力测试 ${pageId}</h1><button id="submit">提交作品</button><button id="records">提交记录</button><input role="combobox" aria-label="搜索赛题编号"><ul>${options}</ul><main>${cards}</main><p class="hidden">PASSWORD_SECRET</p></html>`;
}
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const id = new URL(req.url, 'http://local').searchParams.get('id') || '0';
  res.end(heavyHtml(id));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'aib-stress-profile-'));
const bundled = join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
const executablePath = process.env.AIB_TEST_CHROMIUM || (existsSync(bundled) ? bundled : undefined);
let context;
try {
  const extensionPath = join(ROOT, 'extension');
  context = await chromium.launchPersistentContext(profile, { executablePath, channel: 'chromium', headless: true, viewport: { width: 1400, height: 1000 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.locator('#token').fill(config.extensionToken);
  await panel.locator('#port').fill(String(config.port));
  await panel.locator('#all-sites').uncheck();
  await panel.locator('#origins').fill(origin);
  await panel.locator('#save').click();
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'status' })).connectionState === '已连接');
  for (let i = 0; i < 100 && (!bridge.status().connected || bridge.status().extensionVersion !== pkg.version); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(TOOLS.some(t => t.name === 'browser_find_text'), true);
  mark('0.4.11 extension connected in isolated stress browser');

  async function rawCall(name, args = {}) {
    const res = await fetch(`http://127.0.0.1:${config.port}/call`, { method: 'POST', headers: { Authorization: `Bearer ${config.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || JSON.stringify(body));
    return body.result;
  }
  async function call(name, args = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await rawCall(name, args);
      if (result?.status !== 'waiting' || !result.retryable) return result;
      await rawCall(result.nextPollTool || 'browser_wait_until_ready', result.nextPollArgs || { timeoutMs: result.suggestedDelayMs ?? 1000 });
    }
    throw new Error(`Still waiting after retries for ${name}`);
  }

  const tabs = [];
  for (let i = 0; i < 4; i++) tabs.push(await call('browser_open', { url: `${origin}/heavy?id=${i}` }));
  await new Promise(resolve => setTimeout(resolve, 1200));
  mark('opened four heavy pages', { tabs: tabs.map(t => t.tabId) });

  const started = Date.now();
  const jobs = [];
  for (const [i, tab] of tabs.entries()) {
    for (let j = 0; j < 5; j++) jobs.push(call('browser_find_text', { tabId: tab.tabId, query: j % 2 ? '提交作品' : 'fill_bonus_tokens', mode: 'cheap', maxMatches: 5, contextChars: 120, budgetMs: 1500 }).then(r => ({ kind: 'find', i, found: r.found, elapsed: r.diagnostics.elapsedMs })));
    for (let j = 0; j < 3; j++) jobs.push(call('browser_read', { tabId: tab.tabId, mode: 'cheap', maxChars: 2500, maxElements: 80, maxTextNodes: 1000, budgetMs: 1500 }).then(r => ({ kind: 'cheap', i, text: r.text.length, elements: r.elements.length, elapsed: r.diagnostics.timings.totalMs })));
    jobs.push(call('browser_read', { tabId: tab.tabId, maxChars: 2000, maxElements: 40, maxTextNodes: 500, budgetMs: 1200 }).then(r => ({ kind: 'normal', i, partial: r.partial, elapsed: r.diagnostics.timings.totalMs })));
  }
  const results = await Promise.all(jobs);
  const durationMs = Date.now() - started;
  assert.equal(results.length, 36);
  assert.ok(results.filter(r => r.kind === 'cheap' && r.text > 0 && r.elements > 0).length >= 10);
  assert.equal(bridge.status().queued, 0);
  assert.equal(bridge.status().active, null);
  mark('36 concurrent read/find jobs across four heavy pages completed', { durationMs, maxJobElapsed: Math.max(...results.map(r => r.elapsed ?? 0)) });

  const elementSearch = await call('browser_find_text', { tabId: tabs[0].tabId, query: '提交作品', mode: 'cheap', maxMatches: 3, contextChars: 80, includeElements: true, maxElements: 80, budgetMs: 1500 });
  assert.ok(Array.isArray(elementSearch.nearbyElements));
  mark('targeted find_text can include nearby elements when explicitly requested', { nearby: elementSearch.nearbyElements.length, elapsedMs: elementSearch.diagnostics.elapsedMs });

  const target = tabs[0].tabId;
  const lease = await call('browser_claim_tab', { tabId: target, agent: 'stress-owner', ttlMs: 3000 });
  assert.equal(lease.agent, 'stress-owner');
  const conflict = await rawCall('browser_scroll', { tabId: target, deltaY: 10, agent: 'stress-other' });
  assert.equal(conflict.status, 'waiting');
  assert.equal(conflict.reason, 'tab_write_lease_conflict');
  const renewed = await call('browser_renew_tab', { tabId: target, agent: 'stress-owner', ttlMs: 3000 });
  assert.ok(renewed.renewCount >= lease.renewCount + 1);
  await call('browser_release_tab', { tabId: target, agent: 'stress-owner' });
  const waited = await call('browser_claim_tab', { tabId: target, agent: 'stress-other', ttlMs: 3000, wait: true });
  assert.equal(waited.agent, 'stress-other');
  await call('browser_release_tab', { tabId: target, agent: 'stress-other' });
  mark('lease conflict returns waiting and wait:true recovers without task failure');

  const ready = await call('browser_wait_until_ready', { timeoutMs: 1000 });
  assert.equal(ready.status, 'ready');
  mark('bridge ready after stress queue drains', { connected: ready.connected, idle: ready.idle });
} finally {
  await context?.close();
  await bridge.close();
  await new Promise(resolve => fixture.close(resolve));
}
console.log(JSON.stringify({ passed: marks.length, marks }, null, 2));
