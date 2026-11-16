import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentHint } from '../extension/panel-status.js';

test('panel hint is hidden when disconnected or converged', () => {
  assert.equal(deploymentHint(null), null);
  assert.equal(deploymentHint({ upgradeRequired: false }, { connected: true }), null);
  assert.equal(deploymentHint({ upgradeRequired: true, deploymentStale: true }, { connected: false }), null);
});

test('stale service hint names both build ids and the gated command', () => {
  const hint = deploymentHint({
    upgradeRequired: true, deploymentStale: true,
    runningBuildId: '0123456789abcdef', diskBuildId: 'fedcba9876543210'
  });
  assert.match(hint, /0123456789ab/);
  assert.match(hint, /fedcba987654/);
  assert.match(hint, /restart-service-when-idle --apply/);
  assert.match(hint, /旧源码/);
});

test('extension skew and config gaps are reported together without exposing values', () => {
  const hint = deploymentHint({
    upgradeRequired: true, extensionVersionSkew: true,
    extensionVersion: '0.44.0', manifestVersion: '0.45.0',
    configMissingFields: ['uploadMaxBytes']
  });
  assert.match(hint, /0\.44\.0/);
  assert.match(hint, /0\.45\.0/);
  assert.match(hint, /uploadMaxBytes/);
  assert.match(hint, /upgrade-check/);
});
