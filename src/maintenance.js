import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Synchronous persistence makes admission closure durable before acquisition
// is acknowledged. A corrupt file fails startup instead of silently unlocking.
export function createMaintenanceStore({ file = null, now = Date.now } = {}) {
  let held = null;
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version !== 1 || (saved.lock !== null &&
        (!saved.lock || typeof saved.lock.token !== 'string' || saved.lock.token.length < 32 || !Number.isSafeInteger(saved.lock.expiresAt)))) throw new Error('Invalid maintenance state');
      held = saved.lock;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function persist(next) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, lock: next }), { mode: 0o600 });
      renameSync(temp, file);
    }
    held = next;
  }
  function status() {
    if (held && held.expiresAt <= now()) persist(null);
    return held ? { expiresAt: held.expiresAt } : null;
  }
  return {
    status,
    acquire(ttlMs) {
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600000) throw new Error('ttlMs must be 1000..600000');
      if (status()) return null;
      const next = { token: randomUUID(), expiresAt: now() + ttlMs };
      persist(next);
      return { ...next };
    },
    release(token) {
      if (!status() || typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(held.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(held.token))) return false;
      persist(null);
      return true;
    }
  };
}
