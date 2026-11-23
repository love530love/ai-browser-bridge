import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CORE_TOOL_PROFILE } from '../src/tool-surface.js';

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
  assert.match(client.getInstructions(), /requested result is already visible/);
  assert.match(client.getInstructions(), /TOOL DISCOVERY IS COMPLETE/);
  const resources = await client.listResources();
  assert.ok(resources.resources.some(r => r.uri === 'bridge://skills/ai-browser-bridge'));
  assert.ok(resources.resources.some(r => r.uri === 'bridge://capabilities'));
  const skill = await client.readResource({ uri: 'bridge://skills/ai-browser-bridge' });
  assert.match(skill.contents[0].text, /Unknown write outcomes require observation/);
  const manifest = await client.readResource({ uri: 'bridge://capabilities' });
  const parsed = JSON.parse(manifest.contents[0].text);
  assert.equal(parsed.service, 'ai-browser-bridge');
  assert.ok(parsed.groups.length >= 13);
  assert.equal(parsed.discovery.allToolsReachable, true);
  await assert.rejects(client.readResource({ uri: 'bridge://skills/nonexistent' }), /Unknown contract resource/);

  // The first names a weak caller sees must include the tools that make the
  // rest reachable, and the full catalogue must still be present.
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.slice(0, CORE_TOOL_PROFILE.length).map(tool => tool.name), CORE_TOOL_PROFILE);
  assert.ok(listed.tools.length > CORE_TOOL_PROFILE.length);
  assert.ok(listed.tools.some(tool => tool.name === 'browser_upload_verified'));

  const searched = await client.callTool({ name: 'browser_tool_search', arguments: { query: '上传附件', limit: 10 } });
  const searchResult = JSON.parse(searched.content[0].text);
  assert.equal(searchResult.status, 'success');
  assert.ok(searchResult.results.some(entry => entry.name === 'browser_upload_verified'));
  const schema = await client.callTool({ name: 'browser_tool_schema', arguments: { name: 'browser_upload_verified' } });
  assert.equal(JSON.parse(schema.content[0].text).status, 'success');
  const unknown = await client.callTool({ name: 'browser_upload_file', arguments: {} });
  const unknownResult = JSON.parse(unknown.content[0].text);
  assert.equal(unknownResult.code, 'UNKNOWN_TOOL');
  assert.ok(unknownResult.suggestedTools.includes('browser_upload_verified'));
  assert.equal(unknownResult.nextStep.tool, 'browser_tool_search');
  assert.equal(calls, 0, 'discovery answers never reach the browser');

  const response = await client.callTool({ name: 'browser_screenshot', arguments: { tabId: 1 } }, undefined, { timeout: 5000 });
  assert.equal(response.isError, undefined);
  assert.equal(response.content[0].type, 'text');
  assert.equal(JSON.parse(response.content[0].text).reason, 'maintenance');
  assert.equal(calls, 1);
});
