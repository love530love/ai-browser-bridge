import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

test('hung or ambiguous stop queries fail without disabling recovery', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../stop.ps1', import.meta.url), join(root, 'stop.ps1'));
  for (const probe of ['Start-Sleep -Seconds 30', "'{\"matches\":[]}'", 'exit 7']) {
    writeFileSync(join(root, 'scripts/probe-service-process.ps1'), probe);
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', join(root, 'stop.ps1'), '-ProbeTimeoutSec', probe.startsWith('Start-Sleep') ? '1' : '8'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 1, `probe=${probe}; error=${result.error?.message ?? ''}; signal=${result.signal ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(join(root, '.local/service-paused')), false);
    if (probe.startsWith('Start-Sleep')) assert.match(result.stderr, /timed out/);
  }
});

test('stop verifies creation time and only terminates its identified fixture process', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-stop-positive-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { child.kill(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../stop.ps1', import.meta.url), join(root, 'stop.ps1'));
  const run = () => spawnSync('pwsh.exe', ['-NoProfile', '-File', join(root, 'stop.ps1')], { encoding: 'utf8', timeout: 60000 });
  writeFileSync(join(root, 'scripts/probe-service-process.ps1'), `@{matches=@(@{id=${child.pid};startedTicks='1'})}|ConvertTo-Json -Depth 3 -Compress`);
  assert.equal(run().status, 1);
  assert.equal(existsSync(join(root, '.local/service-paused')), false);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  writeFileSync(join(root, 'scripts/probe-service-process.ps1'), `$p=Get-Process -Id ${child.pid}; @{matches=@(@{id=$p.Id;startedTicks=[string]$p.StartTime.ToUniversalTime().Ticks})}|ConvertTo-Json -Depth 3 -Compress`);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, '.local/service-paused')), true);
});

test('service identity probe reads command lines without WMI', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-service-probe-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  copyFileSync(new URL('../scripts/probe-service-process.ps1', import.meta.url), join(root, 'scripts/probe-service-process.ps1'));
  writeFileSync(join(root, 'src/server.js'), 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [join(root, 'src/server.js')], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { child.kill(); rmSync(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', join(root, 'scripts/probe-service-process.ps1')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  const matches = payload.matches.filter(match => match.id === child.pid);
  assert.equal(matches.length, 1, result.stdout + result.stderr);
  assert.match(matches[0].startedTicks, /^\d+$/);
});
