import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBuildIdentity } from '../src/build-identity.js';
import {
  buildDeploymentStatus, diskBuildIdentity, resetDeploymentCache
} from '../src/deployment-status.js';

function fixture({ manifestVersion = '1.0.0', config = {}, writeSource = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aib-deploy-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'extension'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(root, 'extension', 'manifest.json'), JSON.stringify({ version: manifestVersion }));
  if (writeSource) writeFileSync(join(root, 'src', 'app.js'), 'export const value = 1;\n');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  resetDeploymentCache();
  return { root, configPath };
}

test('deployment status reports current when disk and running identities match', () => {
  const { root, configPath } = fixture({ config: { browserTarget: null, uploadRoots: [], uploadMaxBytes: 1024 } });
  const buildId = computeBuildIdentity(root);
  const status = buildDeploymentStatus({
    root, configPath, runningBuildId: buildId, runningVersion: '1.0.0', extensionVersion: '1.0.0'
  });
  assert.equal(status.buildIdCheck, 'current');
  assert.equal(status.deploymentStale, false);
  assert.equal(status.extensionVersionSkew, false);
  assert.deepEqual(status.configMissingFields, []);
  assert.equal(status.upgradeRequired, false);
  assert.equal(status.runningBuildId, buildId);
  assert.equal(status.diskBuildId, buildId);
  assert.equal(status.diskVersion, '1.0.0');
  assert.equal(status.manifestVersion, '1.0.0');
  assert.deepEqual(status.actionRequired, []);
});

test('a source change after startup is visible as stale without claiming a restart happened', () => {
  const { root, configPath } = fixture({ config: { browserTarget: null, uploadRoots: [], uploadMaxBytes: 1024 } });
  const runningBuildId = computeBuildIdentity(root);
  writeFileSync(join(root, 'src', 'app.js'), 'export const value = 2;\n');
  resetDeploymentCache();
  const status = buildDeploymentStatus({ root, configPath, runningBuildId, runningVersion: '1.0.0', extensionVersion: '1.0.0' });
  assert.equal(status.deploymentStale, true);
  assert.equal(status.buildIdCheck, 'stale');
  assert.notEqual(status.diskBuildId, runningBuildId);
  assert.deepEqual(status.actionRequired, ['restart-service']);
  assert.equal(status.upgradeRequired, true);
});

test('extension skew and missing config fields are separate actionable facts', () => {
  const { root, configPath } = fixture({ manifestVersion: '2.0.0', config: { uploadRoots: [] } });
  const buildId = computeBuildIdentity(root);
  const status = buildDeploymentStatus({ root, configPath, runningBuildId: buildId, runningVersion: '1.0.0', extensionVersion: '1.0.0' });
  assert.equal(status.deploymentStale, false);
  assert.equal(status.extensionVersionSkew, true);
  assert.deepEqual(status.configMissingFields, ['browserTarget', 'uploadMaxBytes']);
  assert.deepEqual(status.actionRequired, ['reload-extension', 'write-config']);
});

test('an unreadable disk identity is unavailable, not falsely stale', () => {
  const { root, configPath } = fixture({ config: { browserTarget: null, uploadRoots: [], uploadMaxBytes: 1024 } });
  const status = buildDeploymentStatus({
    root, configPath, runningBuildId: 'a'.repeat(64), runningVersion: '1.0.0', extensionVersion: '1.0.0',
    compute: () => { throw new Error('hash failed'); }
  });
  assert.equal(status.diskBuildId, null);
  assert.equal(status.buildIdCheck, 'unavailable');
  assert.equal(status.deploymentStale, false);
  assert.equal(status.upgradeRequired, false);
  assert.match(status.errors.join(' '), /build_identity_unavailable/);
});

test('disk build identity is cached within its ttl', () => {
  const { root } = fixture();
  let calls = 0;
  const compute = () => { calls += 1; return 'f'.repeat(64); };
  resetDeploymentCache();
  diskBuildIdentity(root, { now: 1000, ttlMs: 10000, compute });
  diskBuildIdentity(root, { now: 5000, ttlMs: 10000, compute });
  diskBuildIdentity(root, { now: 12000, ttlMs: 10000, compute });
  assert.equal(calls, 2);
});
