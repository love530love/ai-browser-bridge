import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real MCP transport returns screenshot waiting without image schema errors or internal polling', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-mcp-wait-'));
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* consume request */ }
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { status: 'waiting', retryable: true, reason: 'maintenance', dispatched: false,
      nextPollTool: 'browser_wait_until_ready', nextPollArgs: { timeoutMs: 30000 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: server.address().port, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64), uploadRoots: [] }));
  const client = new Client({ name: 'waiting-regression', version: '1' });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], env: { ...process.env, AIB_STATE_DIR: dir } }));
  const response = await client.callTool({ name: 'browser_screenshot', arguments: { tabId: 1 } }, undefined, { timeout: 5000 });
  assert.equal(response.isError, undefined);
  assert.equal(response.content[0].type, 'text');
  assert.equal(JSON.parse(response.content[0].text).reason, 'maintenance');
  assert.equal(calls, 1);
});
