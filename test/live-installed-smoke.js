// Opt-in smoke test of the user's connected extension, not an isolated browser.
// Only opens and operates one newly-created tab. Does not enumerate existing tabs.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../src/config.js';
import { request } from '../src/client.js';
import { TOOLS } from '../src/tools.js';

const output = join(ROOT, 'output', 'live-installed');
mkdirSync(output, { recursive: true });
const report = { time: new Date().toISOString(), environment: 'currently connected user Chrome extension', checks: [], completed: false };
const mark = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>自主浏览器 · 实际安装验收</title><style>body{margin:60px;font:20px 'Microsoft YaHei',sans-serif;background:#11221e;color:#d9f5e8}h1{color:#9fe3c5}input,button{padding:14px;font:inherit}#upload{display:none}#reply{margin-top:24px;padding:20px;background:#254137;border-radius:10px}</style><h1>自主浏览器 · 实际安装验收</h1><p>本页仅用于本机测试，不发送消息到外部服务。</p><label for="draft">测试消息</label><input id="draft"><button id="send">本地回显</button><label for="upload">测试文件</label><input id="upload" type="file" accept=".zip"><p id="reply">等待测试</p><div style="height:1200px"></div><script>document.getElementById('send').onclick=()=>{document.getElementById('reply').textContent='测试成功：'+document.getElementById('draft').value};document.getElementById('upload').onchange=e=>{const f=e.target.files[0];document.getElementById('reply').textContent='文件选择成功：'+f.name+':'+f.size}</script></html>`;
const fixture = () => http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); });
const first = fixture(), second = fixture();
for (const server of [first, second]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const firstUrl = `http://127.0.0.1:${first.address().port}/live-check`;
const secondUrl = `http://127.0.0.1:${second.address().port}/cross-origin`;
let client, tabId;
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content[0].text);
  const content = response.content[0];
  return content.type === 'image' ? content : JSON.parse(content.text);
}
async function readReady(url, expectedText) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const result = await call('browser_read', { tabId, maxChars: 3000 });
      if (result.url.startsWith(url) && result.text.includes(expectedText)) return result;
      lastError = new Error('Expected page content not ready');
    } catch (e) { lastError = e; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError;
}
try {
  const status = await request('/status');
  assert.equal(status.connected, true); mark('installed extension connected to local bridge');
  client = new Client({ name: 'installed-extension-smoke', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src', 'mcp.js')] }));
  assert.equal((await client.listTools()).tools.length, TOOLS.length); mark('live MCP client initialized and discovered current tool set');
  ({ tabId } = await call('browser_open', { url: firstUrl }));
  const page = await readReady(firstUrl, '等待测试'); mark('opened and read new test tab on an unlisted random origin');
  const uploadPath = process.env.AIB_TEST_UPLOAD_PATH;
  if (uploadPath) {
    const bytes = readFileSync(uploadPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const input = page.elements.find(element => element.upload === true);
    assert.ok(input, 'file input ref not exposed');
    const selected = await call('browser_upload', { tabId, ref: input.ref, filePath: uploadPath, sha256 });
    assert.equal(selected.selected, true);
    await readReady(firstUrl, `文件选择成功：${selected.fileName}:${bytes.length}`);
    report.upload = { fileName: selected.fileName, size: selected.size, sha256: selected.sha256, destination: 'localhost fixture only', submitted: false };
    mark('selected an allowlisted SHA-bound file on localhost without an OS dialog or submit');
  }
  const currentPage = await call('browser_read', { tabId, maxChars: 3000 });
  await call('browser_fill', { tabId, ref: currentPage.elements.find(e => e.label === '测试消息').ref, text: 'Chrome 已连接，读取、输入和点击均正常。' });
  await call('browser_click', { tabId, ref: currentPage.elements.find(e => e.label === '本地回显').ref });
  await readReady(firstUrl, '测试成功：Chrome 已连接，读取、输入和点击均正常。'); mark('filled text, clicked local button and verified response');
  assert.ok((await call('browser_scroll', { tabId, deltaY: 300 })).scrollY > 0);
  await call('browser_scroll', { tabId, deltaY: -300 }); mark('scroll down and back verified');
  const screenshot = await call('browser_screenshot', { tabId });
  assert.equal(screenshot.mimeType, 'image/png');
  const png = Buffer.from(screenshot.data, 'base64'); assert.equal(png.subarray(1, 4).toString(), 'PNG');
  writeFileSync(join(output, 'installed-chrome-result.png'), png); mark('screenshot returned from actual installed extension');
  await call('browser_navigate', { tabId, url: secondUrl });
  await readReady(secondUrl, '等待测试'); mark('cross-origin navigation and read work without adding a whitelist entry');
  if (process.env.AIB_TEST_PUBLIC_URL) {
    await call('browser_navigate', { tabId, url: process.env.AIB_TEST_PUBLIC_URL });
    const publicPage = await readReady(process.env.AIB_TEST_PUBLIC_URL, process.env.AIB_TEST_PUBLIC_TEXT || '');
    report.publicPage = { url: publicPage.url, title: publicPage.title };
    mark('optional public HTTPS website navigation and content read verified');
  } else {
    report.publicPage = { skipped: true, reason: 'external network is not required for installed-extension acceptance' };
  }
  report.completed = true;
} catch (error) {
  report.error = error.message; console.error(`FAIL ${error.message}`); process.exitCode = 1;
} finally {
  if (tabId && client) {
    try { await call('browser_close', { tabId }); mark('closed only the tab created for this test'); }
    catch (error) { report.cleanupError = error.message; report.completed = false; process.exitCode = 1; }
  }
  await client?.close();
  for (const server of [first, second]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report saved: output/live-installed/report.json; completed=${report.completed}`);
}
