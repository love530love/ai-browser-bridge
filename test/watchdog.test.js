import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('watchdog recovers absent service, respects pause and never restarts occupied ports', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-watch-test-'));
  const state = join(root, '.local'); mkdirSync(state);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => { res.writeHead(503); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());
  writeFileSync(join(state, 'config.json'), JSON.stringify({ port, agentToken: 'fixture' }));
  writeFileSync(join(root, 'start.ps1'), "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'started') -Value 'yes'");
  const run = async () => {
    await promisify(execFile)('pwsh.exe', ['-NoProfile', '-File', fileURLToPath(new URL('../scripts/watch-service.ps1', import.meta.url)), '-Once', '-ProjectRoot', root], { timeout: 30000 });
    return JSON.parse(readFileSync(join(state, 'watchdog-status.json'), 'utf8').replace(/^\uFEFF/, '')).state;
  };
  assert.equal(await run(), 'port-occupied-or-service-unresponsive');
  assert.equal(existsSync(join(root, 'started')), false);
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(state, 'service-paused'), 'pause');
  assert.equal(await run(), 'paused');
  assert.equal(existsSync(join(root, 'started')), false);
  rmSync(join(state, 'service-paused'));
  assert.equal(await run(), 'startup-completed');
  assert.equal(existsSync(join(root, 'started')), true);
  writeFileSync(join(state, 'watchdog-disabled'), 'disabled');
  assert.equal(await run(), 'disabled');
});
