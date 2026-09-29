import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCategory } from '../src/diagnostics.js';
import { recoverRead } from '../src/read-recovery.js';
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
test('diagnostics classify without exposing dynamic error content', () => {
  assert.equal(errorCategory('Navigation in progress https://private.example/secret'), 'PAGE_TRANSITION');
  assert.equal(errorCategory('Stale element reference'), 'STALE_REFERENCE');
  assert.equal(errorCategory('arbitrary secret text'), 'EXECUTION_ERROR');
  assert.equal(errorCategory(null), null);
});
