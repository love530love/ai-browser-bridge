import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Windows upgrade preserves active work and records waiting even in best-effort mode', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-upgrade-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    copyFileSync(new URL('../scripts/upgrade.ps1', import.meta.url), join(root, 'scripts', 'upgrade.ps1'));
    copyFileSync(new URL('../scripts/bounded-process.ps1', import.meta.url), join(root, 'scripts', 'bounded-process.ps1'));
    for (const status of [{ active: { id: 'inflight' } }, { queued: 1 }, { taskLease: 'agent-a' }, { tabLeases: [{ owner: 'agent-a' }] }]) {
      writeFileSync(join(root, 'src', 'cli.js'), `console.log(${JSON.stringify(JSON.stringify({ ok: true, status }))});`);
      const run = spawnSync('pwsh.exe', ['-NoProfile', '-File', join(root, 'scripts', 'upgrade.ps1'), '-BestEffort', '-SkipReload'], { encoding: 'utf8', timeout: 20000 });
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
