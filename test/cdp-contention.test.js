import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDebugger } from '../extension/cdp.js';

test('busy debugger does not execute or detach another owner; later acquisition executes once', async () => {
  let busy = true, executions = 0, detached = 0;
  globalThis.chrome = { debugger: {
    attach: async () => { if (busy) throw new Error('Another debugger is already attached to the tab'); },
    detach: async () => { detached++; }, sendCommand: async () => ({})
  } };
  try {
    await assert.rejects(withDebugger(1, async () => { executions++; }), { code: 'DEBUGGER_BUSY_BEFORE_DISPATCH' });
    assert.equal(executions, 0); assert.equal(detached, 0);
    busy = false;
    await withDebugger(1, async () => { executions++; });
    assert.equal(executions, 1); assert.equal(detached, 1);
  } finally { delete globalThis.chrome; }
});

test('post-attach errors are never classified as safe attachment retries', async () => {
  let detached = 0;
  globalThis.chrome = { debugger: { attach: async () => {}, detach: async () => { detached++; } } };
  try {
    await assert.rejects(withDebugger(1, async () => { throw new Error('Another debugger is already attached'); }), e => e.code === undefined);
    assert.equal(detached, 1);
  } finally { delete globalThis.chrome; }
});
