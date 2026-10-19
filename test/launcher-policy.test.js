import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
test('distributed Windows launchers respect host execution policy and use explicit script files', () => {
  const files = readdirSync(root).filter(name => name.endsWith('.bat'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(source, /-ExecutionPolicy\b|-EncodedCommand\b|powershell\.exe/i, file);
    assert.doesNotMatch(source, /-Command\b/i, `${file}: use -File to avoid script-string interpolation`);
    assert.match(source, /pwsh\.exe\s+-NoProfile\s+-File\s+"%~dp0[^"\r\n]+\.ps1"/i, file);
  }
});

test('interactive startup installers retain failure exit status after pause', () => {
  for (const file of ['install-autostart.bat', 'uninstall-autostart.bat']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.match(source, /set "BRIDGE_EXIT=%ERRORLEVEL%"[\s\S]*pause[\s\S]*exit \/b %BRIDGE_EXIT%/i);
  }
});
