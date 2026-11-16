import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('默认（无 -Legacy）升级脚本只读：运行 upgrade-check，不写 .local，按 ok 决定退出码', { skip: process.platform !== 'win32' }, () => {
  for (const scenario of [{ ok: true, expected: 0 }, { ok: false, expected: 2 }]) {
    const root = mkdtempSync(join(tmpdir(), 'bridge-upgrade-default-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'src'));
      copyFileSync(new URL('../scripts/upgrade.ps1', import.meta.url), join(root, 'scripts', 'upgrade.ps1'));
      writeFileSync(join(root, 'src', 'cli.js'), `console.log(${JSON.stringify(JSON.stringify(scenario))});`);
      const run = spawnSync('pwsh.exe', ['-NoProfile', '-File', join(root, 'scripts', 'upgrade.ps1')], { encoding: 'utf8', timeout: 20000 });
      assert.equal(run.status, scenario.expected, `${run.stderr}\n${run.stdout}`);
      assert.match(run.stdout, new RegExp(`"ok":${scenario.ok}`), '应输出 upgrade-check 报告原文');
      assert.match(`${run.stdout}\n${run.stderr}`, /scripts\/upgrade\.ps1[\s\S]*upgrade-check[\s\S]*-Legacy/,
        '应打印弃用警示并给出官方命令与 -Legacy 出口');
      assert.ok(!existsSync(join(root, '.local')), '默认模式不得写任何 .local 状态');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('Windows upgrade -Legacy preserves active work and records waiting even in best-effort mode', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-upgrade-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    copyFileSync(new URL('../scripts/upgrade.ps1', import.meta.url), join(root, 'scripts', 'upgrade.ps1'));
    copyFileSync(new URL('../scripts/bounded-process.ps1', import.meta.url), join(root, 'scripts', 'bounded-process.ps1'));
    for (const status of [{ active: { id: 'inflight' } }, { queued: 1 }, { taskLease: 'agent-a' }, { tabLeases: [{ owner: 'agent-a' }] }]) {
      writeFileSync(join(root, 'src', 'cli.js'), `console.log(${JSON.stringify(JSON.stringify({ ok: true, status }))});`);
      const run = spawnSync('pwsh.exe', ['-NoProfile', '-File', join(root, 'scripts', 'upgrade.ps1'), '-Legacy', '-BestEffort', '-SkipReload'], { encoding: 'utf8', timeout: 20000 });
      assert.equal(run.status, 1, run.stderr);
      const report = JSON.parse(readFileSync(join(root, '.local', 'upgrade', 'last-result.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(report.status, 'waiting');
      assert.equal(report.actionRequired, 'wait-for-idle');
      assert.equal(report.reloadAttempts, 0);
      assert.equal(report.appliedGitUpdate, false);
      assert.equal(report.ok, false);
      assert.ok(report.finishedAt);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows upgrade -Legacy never replays an uncertain extension reload', { skip: process.platform !== 'win32' }, () => {
  for (const scenario of [
    { exitCode: 0, outcome: 'verified', dispatched: true, chromeProcessId: 8412, chromeWindowHandle: 10854 },
    { exitCode: 1, outcome: 'uncertain', dispatched: null, chromeProcessId: 8412, chromeWindowHandle: 10854 },
    { exitCode: 2, outcome: 'not-dispatched', dispatched: false, chromeProcessId: 8412, chromeWindowHandle: 10854 },
    { exitCode: 3, outcome: 'uncertain', dispatched: null, chromeProcessId: 8412, chromeWindowHandle: 10854, finalDoctorHealthy: false },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'bridge-reload-policy-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'bin'));
      copyFileSync(new URL('../scripts/upgrade.ps1', import.meta.url), join(root, 'scripts', 'upgrade.ps1'));
      copyFileSync(new URL('../scripts/bounded-process.ps1', import.meta.url), join(root, 'scripts', 'bounded-process.ps1'));
      const healthyDoctor = {
        ok: true,
        checks: [
          { name: 'deployment-current', ok: true, expectedVersion: '0.5.21', serviceVersion: '0.5.21' },
          { name: 'service-build-current', ok: true },
        ],
      };
      const unhealthyDoctor = {
        ok: false,
        checks: [{ name: 'deployment-current', extensionVersion: '0.5.20', manifestVersion: '0.5.21' }],
      };
      const doctorSource = `const { existsSync, readFileSync, writeFileSync } = require('node:fs');\nconst p = process.env.BRIDGE_DOCTOR_COUNTER;\nconst n = existsSync(p) ? Number(readFileSync(p, 'utf8')) + 1 : 1;\nwriteFileSync(p, String(n));\nconst report = n < 3 ? ${JSON.stringify(healthyDoctor)} : ${JSON.stringify(scenario.finalDoctorHealthy === false ? unhealthyDoctor : healthyDoctor)};\nconsole.log(JSON.stringify(report));\n`;
      writeFileSync(join(root, 'src', 'cli.js'), doctorSource);
      writeFileSync(join(root, 'start.ps1'), 'exit 0\r\n');
      writeFileSync(join(root, 'bin', 'npm.cmd'), '@exit /b 0\r\n');
      writeFileSync(join(root, 'scripts', 'reload-extension.ps1'), "param([int]$ChromeProcessId, [long]$ChromeWindowHandle, [switch]$BestEffort)\r\nAdd-Content -LiteralPath $env:BRIDGE_RELOAD_MARKER -Value \"$ChromeProcessId/$ChromeWindowHandle\" -Encoding ascii\r\nexit ([int]$env:BRIDGE_RELOAD_EXIT_CODE)\r\n");
      const marker = join(root, 'reload-calls.txt');
      const env = {
        ...process.env,
        PATH: `${join(root, 'bin')};${process.env.PATH}`,
        BRIDGE_RELOAD_MARKER: marker,
        BRIDGE_RELOAD_EXIT_CODE: String(scenario.exitCode),
        BRIDGE_DOCTOR_COUNTER: join(root, 'doctor-counter.txt'),
      };
      const run = spawnSync('pwsh.exe', ['-NoProfile', '-File', join(root, 'scripts', 'upgrade.ps1'), '-Legacy', '-BestEffort', '-ChromeProcessId', String(scenario.chromeProcessId), '-ChromeWindowHandle', String(scenario.chromeWindowHandle), '-HealthTimeoutSec', '1'], { encoding: 'utf8', timeout: 30000, env });
      assert.equal(run.status, scenario.finalDoctorHealthy === false ? 1 : 0, `${run.stderr}\n${run.stdout}`);
      const report = JSON.parse(readFileSync(join(root, '.local', 'upgrade', 'last-result.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(report.reloadAttempts, 1);
      assert.equal(report.reloadExitCode, scenario.exitCode);
      assert.equal(report.reload, scenario.outcome);
      assert.equal(report.reloadDispatched, scenario.dispatched);
      assert.equal(readFileSync(marker, 'utf8').trim(), `${scenario.chromeProcessId}/${scenario.chromeWindowHandle}`);
      assert.equal(report.ok, scenario.finalDoctorHealthy !== false);
      if (scenario.finalDoctorHealthy === false) assert.equal(report.actionRequired, 'inspect-extension-state-before-retry');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
