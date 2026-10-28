import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBridgeExtension, describeExtensionState } from '../src/chrome-profile.js';

const extensionDir = 'K:\\PythonProjects5\\AI-Browser-Bridge\\extension';

function userData(profiles) {
  const root = mkdtempSync(join(tmpdir(), 'chrome-profiles-'));
  for (const [name, settings] of Object.entries(profiles)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'Secure Preferences'), JSON.stringify({ extensions: { settings } }));
  }
  return root;
}

const entry = (overrides = {}) => ({ path: extensionDir, location: 4, from_webstore: false, ...overrides });

test('the profile that has the extension is found even when another profile comes first', () => {
  const root = userData({
    Default: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { path: 'C:\\other\\extension' } },
    'Profile 1': { bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: entry() }
  });
  const found = findBridgeExtension({ userDataDir: root, extensionDir });
  assert.equal(found.found, true);
  assert.equal(found.profileDirectory, 'Profile 1');
  assert.equal(found.enabled, true);
  assert.deepEqual(found.disableReasons, []);
});

test('a disabled copy does not hide an enabled one', () => {
  const root = userData({
    Default: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: entry({ disable_reasons: [16777216] }) },
    'Profile 1': { bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: entry() }
  });
  const found = findBridgeExtension({ userDataDir: root, extensionDir });
  assert.equal(found.profileDirectory, 'Profile 1');
  assert.equal(found.enabled, true);
  assert.equal(found.candidates, 2);
});

test('a disabled extension is reported with the reason bits, not as missing', () => {
  const root = userData({ Default: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: entry({ disable_reasons: [16777216] }) } });
  const found = findBridgeExtension({ userDataDir: root, extensionDir });
  assert.equal(found.found, true);
  assert.equal(found.enabled, false);
  assert.deepEqual(found.disableReasons, [16777216]);
  // The two states must not share a sentence: one means "load it", the other
  // means "switch it back on".
  assert.match(describeExtensionState(found), /disabled/);
  assert.match(describeExtensionState(found), /chrome:\/\/extensions/);
});

test('path comparison ignores slash direction, case and a trailing separator', () => {
  const root = userData({ Default: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: entry({ path: 'k:/pythonprojects5/ai-browser-bridge/extension/' }) } });
  const found = findBridgeExtension({ userDataDir: root, extensionDir });
  assert.equal(found.found, true);
  assert.equal(found.profileDirectory, 'Default');
});

test('a profile without the extension is not a false positive', () => {
  const root = userData({ Default: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { path: 'C:\\somewhere\\else' } } });
  const found = findBridgeExtension({ userDataDir: root, extensionDir });
  assert.equal(found.found, false);
  assert.equal(found.reason, 'not_installed');
  assert.match(describeExtensionState(found), /not installed/);
});
