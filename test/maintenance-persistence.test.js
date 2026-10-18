import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMaintenanceStore } from '../src/maintenance.js';

test('maintenance survives restart with ownership and expiry intact', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'maintenance.json');
  let clock = 1000;
  const open = () => createMaintenanceStore({ file, now: () => clock });
  const lock = open().acquire(5000);
  let restarted = open();
  assert.deepEqual(restarted.status(), { expiresAt: 6000 });
  assert.equal(restarted.acquire(5000), null);
  assert.equal(restarted.release('wrong'), false);
  assert.equal(restarted.release(lock.token), true);
  assert.equal(open().status(), null);
  restarted.acquire(1000);
  clock = 2000;
  assert.equal(open().status(), null);
  assert.equal(open().status(), null);
});

test('corrupt or unwritable maintenance state cannot acknowledge an unlocked service', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'state');
  writeFileSync(file, '{bad');
  assert.throws(() => createMaintenanceStore({ file }));
  const missingParent = join(root, 'parent');
  const store = createMaintenanceStore({ file: join(missingParent, 'child.json') });
  writeFileSync(missingParent, 'blocks directory creation');
  assert.throws(() => store.acquire(1000));
  assert.equal(store.status(), null);
});
