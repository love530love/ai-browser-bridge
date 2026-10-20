import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('startup preserves separate generations of logs without altering originals', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-log-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = () => execFileSync('pwsh.exe', ['-NoProfile', '-File',
    fileURLToPath(new URL('../scripts/preserve-service-logs.ps1', import.meta.url)),
    '-StateDirectory', root]);
  run();
  assert.equal(existsSync(join(root, 'service-history')), false);
  writeFileSync(join(root, 'server-error.log'), 'first crash evidence');
  run();
  assert.equal(readFileSync(join(root, 'server-error.log'), 'utf8'), 'first crash evidence');
  writeFileSync(join(root, 'server-error.log'), 'second crash evidence');
  run();
  const history = join(root, 'service-history');
  const generations = readdirSync(history);
  assert.equal(generations.length, 2);
  assert.deepEqual(generations.map(dir => readFileSync(join(history, dir, 'server-error.log'), 'utf8')).sort(),
    ['first crash evidence', 'second crash evidence']);
  for (const dir of generations) {
    const metadata = JSON.parse(readFileSync(join(history, dir, 'metadata.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(metadata.exitCause, 'unknown');
  }
});
