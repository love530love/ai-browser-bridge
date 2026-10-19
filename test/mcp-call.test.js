import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpToolCall } from '../src/mcp-call.js';

test('MCP returns resumable waiting without polling or replaying a write', async () => {
  let calls = 0;
  const result = await mcpToolCall('browser_click', { tabId: 1, ref: 'snapshot:1' }, async () => {
    calls++;
    return { result: { status: 'waiting', reason: 'maintenance', retryable: true, dispatched: false,
      nextPollTool: 'browser_wait_until_ready', nextPollArgs: { timeoutMs: 30000 } } };
  });
  assert.equal(calls, 1);
  assert.equal(result.isError, undefined);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, 'waiting');
  assert.equal(body.dispatched, false);
  assert.equal(body.nextPollTool, 'browser_wait_until_ready');
});

test('screenshot waiting is text; only completed image data is an image', async () => {
  for (const status of ['waiting', 'denied']) {
    const result = await mcpToolCall('browser_screenshot', {}, async () => ({ result: { status, retryable: status === 'waiting' } }));
    assert.equal(result.content[0].type, 'text');
    assert.equal(JSON.parse(result.content[0].text).status, status);
  }
  const result = await mcpToolCall('browser_screenshot', {}, async () => ({ result: { data: 'aGVsbG8=' } }));
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].data, 'aGVsbG8=');
});

test('explicit MCP readiness wait is capped without changing caller arguments', async () => {
  const args = { timeoutMs: 60000, idle: false };
  let sent;
  await mcpToolCall('browser_wait_until_ready', args, async (name, value) => { sent = value; return { result: { status: 'waiting', retryable: true } }; });
  assert.equal(sent.timeoutMs, 20000);
  assert.equal(sent.idle, false);
  assert.equal(args.timeoutMs, 60000);
});
