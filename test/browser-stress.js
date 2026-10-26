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

const externalActions = [];
const stressRows = Array.from({ length: 1000 }, (_, i) => {
  const id = String(i).padStart(4, '0');
  return `<div role="row" data-record="record-${id}"><span id="order-${id}">Order ${id}</span><button aria-label="Export report">Export report</button><span class="row-status">pending</span></div>`;
}).join('');
const virtualRows = `<div id="vwindow" style="position:absolute;inset:0 auto auto 0;width:100%"></div><div style="height:40000px"></div>`;
const chaosPage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Bridge adversarial fixture</title>
<style>body{font:14px sans-serif}#vscroll{height:240px;overflow:auto;position:relative;border:1px solid #444}#vwindow [role=listitem]{height:32px}.records{height:220px;overflow:auto}.records [role=row]{display:flex;gap:12px;padding:4px}#cover{position:fixed;inset:0;background:rgba(255,255,255,.01);z-index:99999}</style>
<h1>Adversarial local fixture</h1><button id="unconfirmed-export">Export with no page confirmation</button><a id="unlinked-export">Export billing report</a><input id="verified-input" value=""><span id="value-state">empty</span><test-widget></test-widget><div id="deep"></div><p style="visibility:hidden">FIND_HIDDEN_VISIBILITY</p><p style="opacity:0">FIND_HIDDEN_OPACITY</p><div hidden>FIND_HIDDEN_ATTRIBUTE</div><span style="display:contents">FIND_DISPLAY_CONTENTS</span><p>FIND_SPLIT_<b>TARGET</b></p><p>FIND_SPACE <b>TARGET</b></p><div inert>FIND_INERT_TEXT</div><button style="visibility:hidden">FIND_HIDDEN_BUTTON</button><button style="opacity:0">FIND_TRANSPARENT_BUTTON</button><section class="records">${stressRows}</section><div id="vscroll">${virtualRows}</div>
<iframe title="same-origin-frame" src="/frame"></iframe><div id="cover" hidden></div>
<script>
const deep=document.querySelector('#deep');let parent=deep;for(let i=0;i<400;i++){const next=document.createElement('div');next.dataset.depth=i;parent.append(next);parent=next}parent.textContent='DEEP_SENTINEL_6f02d5';const splitWhitespace=document.createElement('p');splitWhitespace.append(document.createTextNode('FIND_NODE'),document.createTextNode(' '),document.createTextNode('TARGET'));document.body.append(splitWhitespace);const largeText=document.createElement('div');largeText.textContent='FIND_BUDGET_START'+'x'.repeat(600000)+'FIND_BUDGET_END';document.body.append(largeText);
const vwindow=document.querySelector('#vwindow');function render(){const start=Math.floor(document.querySelector('#vscroll').scrollTop/32);vwindow.style.transform='translateY('+start*32+'px)';vwindow.innerHTML=Array.from({length:30},(_,i)=>{const n=start+i;return '<div role="listitem">Virtual row '+n+(n===940?' VIRTUAL_TARGET_940':'')+'</div>'}).join('')}document.querySelector('#vscroll').addEventListener('scroll',render);render();
class TestWidget extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:'open'});root.innerHTML='<button aria-label="Shadow sentinel action">Shadow sentinel action</button>'}}customElements.define('test-widget',TestWidget);
document.querySelectorAll('[role=row] button').forEach(button=>button.addEventListener('click',async()=>{const row=button.closest('[role=row]');const record=row.dataset.record;row.querySelector('.row-status').textContent='Exported '+record;await fetch('/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record,action:'export'})})}));document.querySelector('#unconfirmed-export').addEventListener('click',()=>{fetch('/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record:'unconfirmed-record',action:'unconfirmed-export'})})});document.querySelector('#unlinked-export').addEventListener('click',event=>{event.currentTarget.setAttribute('aria-label','Report export queued');fetch('/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record:'unlinked-record',action:'unlinked-export'})})});document.querySelector('#verified-input').addEventListener('input',event=>{const target=event.currentTarget;if(target.value==='transient'){setTimeout(()=>{target.value='';document.querySelector('#value-state').textContent='reverted'},40)}else document.querySelector('#value-state').textContent='committed'});
</script></html>`;
const framePage = '<!doctype html><html><body><main>FRAME_SENTINEL_48ac31</main></body></html>';
const fixture = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/audit') {
    let body = ''; for await (const chunk of req) body += chunk;
    externalActions.push(JSON.parse(body));
    res.writeHead(204); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (url.pathname === '/frame') { res.end(framePage); return; }
  if (url.pathname === '/chaos') { res.end(chaosPage); return; }
  const key = url.pathname.replace('/heavy-', '') || 'a';
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

  const adversarialPersona = async () => {
    const opened = await call('browser_open', { url: `${origin}/chaos` });
    const tabId = opened.tabId;
    await waitTabReady(tabId);
    const page = context.pages().find(candidate => candidate.url().includes('/chaos'));
    assert.ok(page, 'isolated Chromium fixture page must be attached');

    const deep = await call('browser_find_text', { tabId, query: 'DEEP_SENTINEL_6f02d5', maxMatches: 2, contextChars: 40, budgetMs: 3000 });
    assert.equal(deep.found, true);
    assert.equal(deep.matches[0].match, 'DEEP_SENTINEL_6f02d5');
    for (const mode of ['cheap', 'normal']) {
      for (const hiddenText of ['FIND_HIDDEN_VISIBILITY', 'FIND_HIDDEN_OPACITY', 'FIND_HIDDEN_ATTRIBUTE', 'FIND_INERT_TEXT']) {
        const hiddenMatch = await call('browser_find_text', { tabId, query: hiddenText, mode, maxMatches: 1, budgetMs: 2000 });
        assert.equal(hiddenMatch.found, false, `${mode} finder must not report non-rendered text ${hiddenText}`);
      }
      const displayContents = await call('browser_find_text', { tabId, query: 'FIND_DISPLAY_CONTENTS', mode, maxMatches: 1, budgetMs: 2000 });
      assert.equal(displayContents.found, true, `${mode} finder must retain rendered text under display:contents`);
      const splitText = await call('browser_find_text', { tabId, query: 'FIND_SPLIT_TARGET', mode, maxMatches: 5, budgetMs: 2000 });
      assert.equal(splitText.found, true, `${mode} finder must match rendered text split across inline nodes`);
      assert.equal(splitText.matchCount, 1, `${mode} finder must not duplicate direct/fallback matches`);
      const spacedText = await call('browser_find_text', { tabId, query: 'FIND_SPACE TARGET', mode, maxMatches: 1, budgetMs: 2500 });
      assert.equal(spacedText.found, true, `${mode} finder must preserve whitespace between inline text nodes`);
      const mergedWithoutSpace = await call('browser_find_text', { tabId, query: 'FIND_SPACETARGET', mode, maxMatches: 1, budgetMs: 2500 });
      assert.equal(mergedWithoutSpace.found, false, `${mode} finder must not erase a whitespace-only sibling node`);
      const explicitSpace = await call('browser_find_text', { tabId, query: 'FIND_NODE TARGET', mode, maxMatches: 1, budgetMs: 2500 });
      assert.equal(explicitSpace.found, true, `${mode} finder must preserve whitespace-only adjacent text nodes`);
      const explicitMerge = await call('browser_find_text', { tabId, query: 'FIND_NODETARGET', mode, maxMatches: 1, budgetMs: 2500 });
      assert.equal(explicitMerge.found, false, `${mode} finder must not concatenate around a whitespace-only text node`);
      const hiddenControl = await call('browser_find_text', { tabId, query: 'FIND_HIDDEN_BUTTON', mode, includeElements: true, maxMatches: 1, budgetMs: 2000 });
      assert.equal(hiddenControl.nearbyElements.some(item => item.label.includes('FIND_HIDDEN_BUTTON')), false, `${mode} finder must not return hidden nearby controls`);
    }
    const overTextBudget = await call('browser_find_text', { tabId, query: 'FIND_BUDGET_END', maxMatches: 1, budgetMs: 3000 });
    assert.equal(overTextBudget.found, false, 'finder must not search beyond its bounded text window');
    assert.equal(overTextBudget.truncated, true, 'finder must disclose a single-node text-length cutoff');
    assert.equal(overTextBudget.diagnostics.textLengthBudgetHit, true);

    const frameRead = await call('browser_read', { tabId, frame: 'all', maxChars: 2000, maxElements: 40, maxTextNodes: 500, budgetMs: 3000 });
    assert.ok(frameRead.frameResults.some(item => item.result?.text?.includes('FRAME_SENTINEL_48ac31')));
    const mainFrameFind = await call('browser_find_text', { tabId, query: 'FRAME_SENTINEL_48ac31', maxMatches: 3, budgetMs: 3000 });
    assert.equal(mainFrameFind.found, false, 'default finder scope must remain the main frame');
    const frameFind = await call('browser_find_text', { tabId, query: 'FRAME_SENTINEL_48ac31', frame: 'all', maxMatches: 3, budgetMs: 3000 });
    assert.equal(frameFind.found, true, 'frame=all finder must search accessible child frames');
    assert.ok(frameFind.matches.some(item => item.match === 'FRAME_SENTINEL_48ac31' && item.frameId !== 0));
    assert.equal(frameFind.scope, 'allFrames injection results returned by Chrome; hidden text excluded');
    const shadow = await call('browser_shadow_tree', { tabId, maxRoots: 20, maxControls: 30 });
    assert.ok(shadow.controls.some(item => item.label === 'Shadow sentinel action'));

    const virtualBefore = await call('browser_find_text', { tabId, query: 'VIRTUAL_TARGET_940', maxMatches: 1, contextChars: 30, budgetMs: 2000 });
    assert.equal(virtualBefore.found, false, 'unmounted virtual row is outside current DOM observation');
    const scan = await call('browser_scan_overlays', { tabId });
    const virtualPane = scan.scrollContainers.find(item => item.selector.includes('#vscroll'));
    assert.ok(virtualPane?.ref);
    let remainingScroll = 30080;
    let scrollRef = virtualPane.ref;
    let scrolled;
    let staleScrollRefChecked = false;
    while (remainingScroll > 0) {
      const deltaY = Math.min(5000, remainingScroll);
      scrolled = await call('browser_scroll_element', { tabId, ref: scrollRef, deltaY });
      assert.equal(scrolled.changed, true);
      remainingScroll -= deltaY;
      if (remainingScroll > 0) {
        if (!staleScrollRefChecked) {
          await assert.rejects(rawCall('browser_scroll_element', { tabId, ref: scrollRef, deltaY: 1 }), /Stale element reference/);
          staleScrollRefChecked = true;
        }
        const refreshedScan = await call('browser_scan_overlays', { tabId });
        const refreshedPane = refreshedScan.scrollContainers.find(item => item.selector.includes('#vscroll'));
        assert.ok(refreshedPane?.ref);
        scrollRef = refreshedPane.ref;
      }
    }
    const virtualAfter = await call('browser_find_text', { tabId, query: 'VIRTUAL_TARGET_940', maxMatches: 1, contextChars: 30, budgetMs: 2000 });
    assert.equal(virtualAfter.found, true);
    assert.equal(virtualAfter.matches[0].match, 'VIRTUAL_TARGET_940');

    await page.locator('[data-record="record-0719"]').scrollIntoViewIfNeeded();
    const overlayCandidate = await call('browser_find_element', { tabId, query: 'Export report', rowText: 'Order 0719', action: 'click', maxResults: 3 });
    assert.equal(overlayCandidate.found, true);
    assert.equal(overlayCandidate.candidates.length, 1);
    assert.match(overlayCandidate.candidates[0].rowText, /Order 0719/);
    assert.equal(overlayCandidate.candidates[0].covered, false);

    await page.locator('#cover').evaluate(el => { el.hidden = false; });
    const covered = await call('browser_find_element', { tabId, query: 'Export report', rowText: 'Order 0719', action: 'click', includeCovered: true, maxResults: 3 });
    assert.equal(covered.candidates.length, 1);
    assert.equal(covered.candidates[0].covered, true);
    await assert.rejects(rawCall('browser_click', { tabId, ref: covered.candidates[0].ref }), /Element is covered/);
    await page.locator('#cover').evaluate(el => { el.hidden = true; });

    const fresh = await call('browser_find_element', { tabId, query: 'Export report', rowText: 'Order 0719', action: 'click', maxResults: 3 });
    assert.equal(fresh.candidates.length, 1);
    assert.equal(fresh.candidates[0].rowText.includes('Order 0719'), true);
    const clicked = await call('browser_click_verified', { tabId, ref: fresh.candidates[0].ref, expect: { textAppears: 'Exported record-0719' }, timeoutMs: 3000 });
    assert.equal(clicked.status, 'success');
    for (let i = 0; i < 40 && !externalActions.some(item => item.record === 'record-0719'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(externalActions.filter(item => item.action === 'export'), [{ record: 'record-0719', action: 'export' }]);

    const noConfirmationTarget = await call('browser_find_element', { tabId, query: 'Export with no page confirmation', action: 'click', maxResults: 2 });
    assert.equal(noConfirmationTarget.candidates.length, 1);
    const alreadySatisfied = await call('browser_click_verified', { tabId, ref: noConfirmationTarget.candidates[0].ref, expect: { textAppears: 'Adversarial local fixture' }, timeoutMs: 150 });
    assert.equal(alreadySatisfied.status, 'not_dispatched');
    assert.equal(alreadySatisfied.dispatched, false);
    assert.equal(externalActions.some(item => item.action === 'unconfirmed-export'), false);

    const unconfirmed = await call('browser_click_verified', { tabId, ref: noConfirmationTarget.candidates[0].ref, expect: { textAppears: 'EXPECTATION_NEVER_VISIBLE_6f02d5' }, timeoutMs: 150 });
    assert.equal(unconfirmed.status, 'uncertain');
    assert.equal(unconfirmed.dispatched, true);
    assert.equal(unconfirmed.retryable, false);
    for (let i = 0; i < 40 && !externalActions.some(item => item.action === 'unconfirmed-export'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(externalActions.filter(item => item.action === 'unconfirmed-export'), [{ record: 'unconfirmed-record', action: 'unconfirmed-export' }]);

    const unlinkedTarget = await call('browser_find_element', { tabId, query: 'Export billing report', action: 'click', maxResults: 2 });
    assert.equal(unlinkedTarget.candidates.length, 1);
    assert.equal(unlinkedTarget.candidates[0].tag, 'a');
    assert.equal(unlinkedTarget.candidates[0].clickability, 'unverified');
    const unlinkedResult = await call('browser_click_verified', { tabId, ref: unlinkedTarget.candidates[0].ref, expect: { elementLabelAppears: 'Report export queued' }, timeoutMs: 500 });
    assert.equal(unlinkedResult.status, 'success');
    for (let i = 0; i < 40 && !externalActions.some(item => item.action === 'unlinked-export'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(externalActions.filter(item => item.action === 'unlinked-export'), [{ record: 'unlinked-record', action: 'unlinked-export' }]);

    const inputTarget = await call('browser_find_element', { tabId, query: 'verified-input', action: 'fill', maxResults: 2 });
    assert.equal(inputTarget.candidates.length, 1);
    const revertedFill = await call('browser_fill_verified', { tabId, ref: inputTarget.candidates[0].ref, text: 'transient', expect: { valueMatches: 'transient' }, timeoutMs: 300 });
    assert.equal(revertedFill.status, 'uncertain');
    assert.equal(revertedFill.dispatched, true);
    assert.equal(revertedFill.retryable, false);
    assert.equal(revertedFill.verification.status, 'not_observed');
    assert.equal(revertedFill.verification.checks.valueMatches, false);
    assert.equal(revertedFill.verification.checks.textAppears, undefined);

    const staleTarget = await call('browser_find_element', { tabId, query: 'Export report', rowText: 'Order 0720', action: 'click', maxResults: 3 });
    assert.equal(staleTarget.candidates.length, 1);
    await page.locator('#order-0720').evaluate(el => { el.textContent = 'Order 9999'; });
    await assert.rejects(rawCall('browser_click', { tabId, ref: staleTarget.candidates[0].ref }), /Stale row reference/);
    assert.deepEqual(externalActions.filter(item => item.action === 'export'), [{ record: 'record-0719', action: 'export' }]);
    mark('adversarial fixture verified deep DOM, iframe, Shadow DOM, virtual rows, unlinked-anchor label changes, live fill rollback detection, verified-click preconditions, uncertain no-replay outcome, independent audit, and stale-row rejection');
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

  await adversarialPersona();
  await Promise.all([findPersona(), readerPersona(), diagnosticsPersona(), crowdPersona()]);
  mark('read-only personas completed under concurrent heavy-page pressure');
  await writerPersona();

  const slow = call('browser_wait', { tabId: tabIds[0], text: 'TEXT_THAT_WILL_NOT_APPEAR', timeoutMs: 3000 }).catch(error => ({ error: error.message }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const overload = await Promise.all(Array.from({ length: 24 }, (_, i) => rawCall('browser_find_text', { tabId: tabIds[i % tabIds.length], query: 'Task 114', mode: 'cheap', maxMatches: 1, contextChars: 40 })));
  const full = overload.filter(result => result.status === 'waiting' && result.reason === 'queue_full');
  const completed = overload.filter(result => result.status !== 'waiting' && !result.error);
  const found = completed.filter(result => result.found === true);
  assert.ok(full.length >= 1, `expected queue_full, got ${JSON.stringify(overload.map(result => result.reason || result.found).slice(0, 30))}`);
  assert.ok(found.length >= 1);
  await slow;
  mark('overload persona observed queue_full backpressure while queued reads still completed');

  writeFileSync(join(out, 'stress-report.json'), JSON.stringify({
    date: new Date().toISOString(),
    checks,
    tabs: tabIds.length,
    queueFullResponses: full.length,
    completedOverloadReads: completed.length,
    overloadReadsFindingTarget: found.length,
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
