import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeBuildIdentity, BUILD_ID } from '../src/build-identity.js';
import { createBridge } from '../src/server.js';

test('source drift changes identity without version bump; local secrets and docs do not', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'src', 'server.js'), 'export const value = 1;');
  const first = computeBuildIdentity(root);
  assert.equal(first, computeBuildIdentity(root));
  mkdirSync(join(root, '.local'));
  writeFileSync(join(root, '.local', 'config.json'), 'secret');
  writeFileSync(join(root, 'README.md'), 'documentation');
  assert.equal(first, computeBuildIdentity(root));
  writeFileSync(join(root, 'src', 'server.js'), 'export const value = 2;');
  assert.notEqual(first, computeBuildIdentity(root));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('bridge reports its startup source identity', async t => {
  const bridge = createBridge({ port: 0, agentToken: 'test', extensionToken: 'ext' }, { leaseStateFile: null, agentPolicyFile: null });
  await bridge.listen(); t.after(() => bridge.close());
  assert.equal(bridge.status().buildId, BUILD_ID);
});
