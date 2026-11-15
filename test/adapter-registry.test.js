import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptersDir, createAdapterRegistry, listAdapters, pruneStaleAdapters, ADAPTER_REGISTRY_SCHEMA } from '../src/adapter-registry.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function tempState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-adapter-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRecord(dir, pid, heartbeatAt, extra = {}) {
  mkdirSync(adaptersDir(dir), { recursive: true });
  writeFileSync(join(adaptersDir(dir), `${pid}.json`), JSON.stringify({
    schema: ADAPTER_REGISTRY_SCHEMA,
    pid,
    ppid: 1,
    execPath: 'node',
    argv: ['src/mcp.js'],
    cwd: dir,
    startedAt: new Date(Date.parse(heartbeatAt) - 1000).toISOString(),
    heartbeatAt,
    ...extra
  }));
}

test('registry writes a record, refreshes its heartbeat, and withdraws it on stop', async t => {
  const dir = tempState(t);
  const registry = createAdapterRegistry({
    stateDir: dir,
    pid: 424242,
    ppid: 1,
    argv: ['src/mcp.js', '--test'],
    execPath: 'node-test',
    cwd: dir,
    heartbeatMs: 60
  });
  registry.start();
  t.after(() => registry.stop());

  assert.equal(existsSync(registry.file), true);
  const first = JSON.parse(readFileSync(registry.file, 'utf8'));
  assert.equal(first.schema, ADAPTER_REGISTRY_SCHEMA);
  assert.equal(first.pid, 424242);
  assert.equal(first.ppid, 1);
  assert.deepEqual(first.argv, ['src/mcp.js', '--test']);
  assert.equal(first.execPath, 'node-test');
  assert.match(first.startedAt, /^\d{4}-\d{2}-\d{2}T/);

  const refreshed = await waitFor(() => {
    const value = JSON.parse(readFileSync(registry.file, 'utf8'));
    return value.heartbeatAt > first.heartbeatAt ? value : null;
  });
  assert.ok(refreshed, 'heartbeat did not advance');

  registry.stop();
  assert.equal(existsSync(registry.file), false);
});

test('inventory reports heartbeat freshness and never claims process liveness', t => {
  const dir = tempState(t);
  const now = Date.now();
  writeRecord(dir, 111, new Date(now - 5000).toISOString());
  writeRecord(dir, 222, new Date(now - 120000).toISOString());

  const inventory = listAdapters({ stateDir: dir, now, staleMs: 45000 });
  assert.equal(inventory.schema, ADAPTER_REGISTRY_SCHEMA);
  assert.equal(inventory.count, 2);
  assert.equal(inventory.fresh, 1);
  assert.equal(inventory.stale, 1);
  assert.equal(inventory.liveness, 'not_checked');
  assert.equal(inventory.records.find(record => record.pid === 111).stale, false);
  assert.equal(inventory.records.find(record => record.pid === 222).stale, true);
  assert.equal(existsSync(join(adaptersDir(dir), '111.json')), true);
  assert.equal(existsSync(join(adaptersDir(dir), '222.json')), true);
});

test('missing registry directory is an empty inventory, not an error', t => {
  const dir = tempState(t);
  const inventory = listAdapters({ stateDir: dir });
  assert.equal(inventory.count, 0);
  assert.equal(inventory.fresh, 0);
  assert.equal(inventory.stale, 0);
});

test('prune removes only records older than the explicit age', t => {
  const dir = tempState(t);
  const now = Date.now();
  writeRecord(dir, 333, new Date(now - 2 * 86400000).toISOString());
  writeRecord(dir, 444, new Date(now - 3600000).toISOString());

  const dry = pruneStaleAdapters({ stateDir: dir, now, olderThanMs: 86400000, dryRun: true });
  assert.equal(dry.removed.length, 1);
  assert.equal(existsSync(join(adaptersDir(dir), '333.json')), true);

  const result = pruneStaleAdapters({ stateDir: dir, now, olderThanMs: 86400000 });
  assert.equal(result.removed.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(existsSync(join(adaptersDir(dir), '333.json')), false);
  assert.equal(existsSync(join(adaptersDir(dir), '444.json')), true);
});

test('a real MCP adapter registers itself, heartbeats, and removes its record on EOF', { timeout: 15000 }, async t => {
  const dir = tempState(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], {
    env: { ...process.env, AIB_STATE_DIR: dir, AIB_ADAPTER_HEARTBEAT_MS: '100' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdout.resume();
  child.stderr.resume();

  const file = join(adaptersDir(dir), `${child.pid}.json`);
  const registered = await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')));
  assert.ok(registered, 'adapter did not register');
  assert.equal(registered.pid, child.pid);
  assert.equal(registered.ppid, process.pid);
  assert.ok(registered.argv.some(value => value.endsWith('mcp.js')));

  const firstHeartbeat = registered.heartbeatAt;
  const refreshed = await waitFor(() => {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value.heartbeatAt > firstHeartbeat ? value : null;
  });
  assert.ok(refreshed, 'adapter heartbeat did not refresh');

  const exited = once(child, 'exit');
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(existsSync(file), false);
});
