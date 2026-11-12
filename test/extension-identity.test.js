// P0-1 / P1-6 contract: the unpacked extension id is derived from the absolute
// load path, so it must be resolved from evidence, never hard-coded in the UI
// chain. The PowerShell scripts cannot be run against a real Chrome window in
// a unit test, so their guards are asserted as shipped source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveBridgeExtensionId, BRIDGE_EXTENSION_ID } from '../src/chrome-profile.js';

const read = relative => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const chromeProfile = read('src/chrome-profile.js');
const desktopAdapter = read('src/desktop-adapter.js');
const server = read('src/server.js');
const extensionErrors = read('src/extension-errors.js');
const reloadScript = read('scripts/reload-extension.ps1');
const clearScript = read('scripts/clear-extension-errors.ps1');

const OLD_ID = 'mmopbppoabmhliflinadkgnedjpmbgig';

function fakeChrome(root, id, declaredPath) {
  const userData = join(root, 'user-data');
  const profile = join(userData, 'Default');
  const extension = join(root, 'extension');
  mkdirSync(profile, { recursive: true });
  mkdirSync(extension, { recursive: true });
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ name: '自主浏览器 · AI Browser Bridge' }));
  writeFileSync(join(profile, 'Secure Preferences'), JSON.stringify({
    extensions: { settings: { [id]: { path: declaredPath ?? extension, disable_reasons: [] } } }
  }));
  return { userData, extension };
}

test('resolveBridgeExtensionId binds the id through the extension directory path', () => {
  const root = mkdtempSync(join(tmpdir(), 'aib-identity-'));
  try {
    const realId = 'gklebbcjecmlmcdihciilbmjjbmjggip';
    const { userData } = fakeChrome(root, realId);
    const resolved = resolveBridgeExtensionId(root, userData);
    assert.equal(resolved.extensionId, realId, 'a second checkout must not get the maintainer id');
    assert.equal(resolved.source, 'chrome-profile-path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing profile falls back to the constant and says so', () => {
  const root = mkdtempSync(join(tmpdir(), 'aib-identity-empty-'));
  try {
    const resolved = resolveBridgeExtensionId(root, join(root, 'no-such-user-data'));
    assert.equal(resolved.extensionId, BRIDGE_EXTENSION_ID);
    assert.equal(resolved.source, 'fallback-constant');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no production file can still require the maintainer id, and both scripts demand a validated id', () => {
  assert.match(chromeProfile, /export function resolveBridgeExtensionId/);
  assert.doesNotMatch(server, /reloadExtension\(args\)/, 'server must pass the resolved identity');
  assert.match(server, /extensionIdSource: 'extension-handshake'/);
  assert.match(server, /resolveBridgeExtensionId\(\)/);
  assert.match(server, /extensionId: clearId/, 'clear-error path must use the same id');
  assert.match(extensionErrors, /args\.push\('-ExtensionId', extensionId\)/);
  assert.match(desktopAdapter, /mapReloadResult\(result, expectedVersion, resolvedId\)/);
  assert.doesNotMatch(desktopAdapter, /verified: true, extensionId: BRIDGE_EXTENSION_ID/, 'a successful reload must echo the real id');

  for (const [name, source] of Object.entries({ 'reload-extension.ps1': reloadScript, 'clear-extension-errors.ps1': clearScript })) {
    assert.doesNotMatch(source, /\[string\]\$ExtensionId = 'mmop/, `${name} still defaults to the hardcoded id`);
    assert.match(source, /\^\[a-p\]\{32\}\$/, `${name} must validate the id shape`);
  }
  assert.doesNotMatch(reloadScript, /\$fixedExtensionId/, 'the fixed-id guard must be gone');
  assert.match(reloadScript, /ExpectedExtensionPath/);
  assert.match(reloadScript, /AI Browser Bridge/, 'guard #2 must verify the manifest belongs to this project');
  assert.match(clearScript, /extension_id_not_bound/);
});

test('P1-6 foreground fallback keeps the final verification and reports evidence', () => {
  assert.match(reloadScript, /AttachThreadInput/);
  assert.match(reloadScript, /ForceForeground/);
  assert.match(reloadScript, /BringWindowToTop/);
  assert.match(reloadScript, /GetForegroundWindow\(\) -eq \$chromeWindow\.Handle/);
  assert.match(reloadScript, /foregroundVerified=False reason=foreground_not_acquired/);
  assert.match(reloadScript, /foregroundVerified=True/);
  assert.match(desktopAdapter, /reason: idNotBound \? 'extension_id_not_bound'/);
  assert.match(desktopAdapter, /foregroundNotAcquired \? 'foreground_not_acquired'/);

  // Rendered text: the message a caller actually sees when foreground fails
  // must say nothing was typed, not suggest retrying the reload.
  const rendered = desktopAdapter.match(/The Chrome window could not be brought to the foreground[^']*/);
  assert.ok(rendered, 'shipped failure message must exist');
  assert.match(rendered[0], /no keystroke was sent/);
  assert.doesNotMatch(rendered[0], /retry the reload/i);

  const guardText = reloadScript.match(/Extension id was not bound[^\r\n]*/);
  assert.ok(guardText, 'shipped guard message must exist');
  assert.match(guardText[0], /no UI action was taken/);
});
