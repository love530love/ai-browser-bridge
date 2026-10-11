import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = rel => JSON.parse(readFileSync(join(root, rel), 'utf8'));

// Every bump used to miss at least one of the four hardcoded copies, so /status
// and the MCP handshake would report a version the extension did not have.
test('package.json, the extension manifest and src/version.js agree', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('extension/manifest.json');
  assert.equal(manifest.version, pkg.version, 'extension/manifest.json must match package.json');
  assert.equal(VERSION, pkg.version, 'src/version.js must report the package.json version');
});

test('the version is a plain semver triplet', () => {
  assert.match(readJson('package.json').version, /^\d+\.\d+\.\d+$/);
});
