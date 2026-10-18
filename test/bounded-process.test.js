import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('installer wrapper propagates failures and bounds a hung process', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../scripts/bounded-process.ps1', import.meta.url)).replaceAll("'", "''");
  for (const [command, expected] of [['exit 0', 0], ['exit 7', 1], ['Start-Sleep -Seconds 30', 1]]) {
    const script = `$ErrorActionPreference='Stop'; . '${helper}'; try { Invoke-BoundedProcess -FilePath (Get-Command pwsh.exe).Source -ArgumentList @('-NoProfile','-Command','${command}') -WorkingDirectory (Get-Location).Path -TimeoutSec ${command.startsWith('Start-Sleep') ? 1 : 10}; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }`;
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (command.startsWith('Start-Sleep')) assert.match(result.stdout, /timed out/);
    if (command === 'exit 7') assert.match(result.stdout, /exit code 7/);
  }
});

