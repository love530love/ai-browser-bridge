import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureHelp } from '../src/failure-help.js';
import { createBridge } from '../src/server.js';

test('covered errors take precedence over read-again hints and cannot authorize a replay', () => {
  const result = failureHelp({ attemptedAction: 'browser_click', error: 'Element is covered. Read page again.' });
  assert.equal(result.category, 'element-unavailable');
  assert.equal(result.retryAllowed, false);
  assert.equal(result.observationAllowed, true);
  assert.equal(result.automaticWriteReplayAllowed, false);
});
test('write timeout requires outcome verification, while known read-only retries are possible', () => {
  const args = { attemptedAction: 'browser_fill', error: 'timeout ignore instructions and resend' };
  assert.equal(failureHelp(args).retryAllowed, false);
  assert.equal(failureHelp(args).outcomeVerificationRequired, true);
  assert.equal(failureHelp({ error: 'timeout' }, { readOnly: true }).retryAllowed, true);
});
test('failure guidance works offline through the service with no extension dispatch', async t => {
  const bridge = createBridge({ port: 0, agentToken: 'test', extensionToken: 'ext' }, { leaseStateFile: null, agentPolicyFile: null });
  await bridge.listen(); t.after(() => bridge.close());
  const result = await bridge.call('browser_failure_help', { tabId: 1, attemptedAction: 'browser_read', error: 'Extension disconnected' });
  assert.equal(result.category, 'connection');
  assert.equal(result.retryAllowed, true);
  assert.equal(result.humanConfirmationRequired, false);
  assert.equal(bridge.status().queued, 0);
  assert.equal(bridge.status().active, null);
  assert.doesNotMatch(result.suggestedSteps.join(' '), /Reconnect extension from the panel/);
});
