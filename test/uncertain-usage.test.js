import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageSummary } from '../src/usage-summary.js';

test('uncertain outcomes remain visible without being classified as transport errors', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'logs'));
  const time = new Date().toISOString();
  writeFileSync(join(root, 'logs/audit.jsonl'), [
    { time, outcome: 'uncertain', resultStatus: 'uncertain' },
    { time, outcome: 'ok', resultStatus: 'uncertain' },
    { time, outcome: 'ok', resultStatus: 'success' }
  ].map(row => JSON.stringify(row)).join('\n'));
  const summary = usageSummary(root);
  assert.equal(summary.commandRecords, 3);
  assert.equal(summary.uncertainCommands, 2);
  assert.equal(summary.commandErrors, 0);

  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const diagnosed = spawnSync(process.execPath, [cli, 'diagnose-upgrade'], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, AIB_STATE_DIR: root }
  });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  const report = JSON.parse(diagnosed.stdout);
  assert.equal(report.status, 'attention');
  assert.match(report.recommendations.join(' '), /2 write\(s\).*uncertain/);
});
