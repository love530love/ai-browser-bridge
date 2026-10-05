import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCategory } from '../src/diagnostics.js';
import { recoverRead } from '../src/read-recovery.js';
import { callWithWaitingRecovery } from '../src/auto-recovery.js';

test('read recovery is bounded and never replays writes or unknown errors', async () => {
  let calls = 0;
  const operation = async () => { calls++; if(calls < 3) throw new Error('Navigation in progress'); return 'ready'; };
  assert.equal(await recoverRead('browser_read', operation, async () => {}), 'ready');
  calls = 0;
  await assert.rejects(recoverRead('browser_fill', operation, async () => {}));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(recoverRead('browser_read', async () => { calls++; throw new Error('Page changed'); }, async () => {}));
  assert.equal(calls, 7);
  calls = 0;
  await assert.rejects(recoverRead('browser_read', async () => { calls++; throw new Error('Site not allowed'); }, async () => {}));
  assert.equal(calls, 1);
});

test('waiting recovery polls and retries without throwing', async () => {
  const calls = [];
  const rawCall = async (name, args) => {
    calls.push({ name, args });
    if (name === 'browser_wait_until_ready') return { result: { status: 'ready', connected: true, idle: true } };
    if (calls.filter(call => call.name === 'browser_tabs').length === 1) return { result: { status: 'waiting', retryable: true, reason: 'queue_full', nextPollTool: 'browser_wait_until_ready', nextPollArgs: { timeoutMs: 100, idle: true } } };
    return { result: [{ id: 1, title: 'ok' }] };
  };
  const result = await callWithWaitingRecovery({ name: 'browser_tabs', args: {}, rawCall, pause: async () => {}, maxWaitMs: 1000 });
  assert.equal(result.result[0].title, 'ok');
  assert.equal(result.result.autoRecovery.attempts, 1);
  assert.deepEqual(calls.map(call => call.name), ['browser_tabs', 'browser_wait_until_ready', 'browser_tabs']);
});

test('waiting recovery downgrades read timeout to cheap read', async () => {
  const seen = [];
  const rawCall = async (name, args) => {
    seen.push({ name, args });
    if (seen.length === 1) return { result: { status: 'waiting', retryable: true, reason: 'read_timeout', nextPollTool: 'browser_wait_until_ready', nextPollArgs: { timeoutMs: 100, idle: true } } };
    if (name === 'browser_wait_until_ready') return { result: { status: 'ready', connected: true, idle: true } };
    return { result: { text: 'cheap summary', elements: [], partial: true } };
  };
  const result = await callWithWaitingRecovery({ name: 'browser_read', args: { tabId: 1 }, rawCall, pause: async () => {}, maxWaitMs: 1000 });
  assert.equal(result.result.text, 'cheap summary');
  assert.equal(seen.at(-1).args.mode, 'cheap');
});

test('waiting recovery returns exhausted waiting result after budget', async () => {
  const rawCall = async () => ({ result: { status: 'waiting', retryable: true, reason: 'extension_disconnected', suggestedDelayMs: 1 } });
  const result = await callWithWaitingRecovery({ name: 'browser_tabs', args: {}, rawCall, pause: async () => {}, maxWaitMs: 0 });
  assert.equal(result.result.status, 'waiting');
  assert.equal(result.result.autoRecovery.exhausted, true);
});

test('diagnostics classify without exposing dynamic error content', () => {
  assert.equal(errorCategory('Navigation in progress https://private.example/secret'), 'PAGE_TRANSITION');
  assert.equal(errorCategory('Stale element reference'), 'STALE_REFERENCE');
  assert.equal(errorCategory('arbitrary secret text'), 'EXECUTION_ERROR');
  assert.equal(errorCategory(null), null);
});
