// The native host is a separate process speaking a framed stdio protocol, so a
// unit test of an in-process function would not exercise the thing that actually
// runs. These tests spawn it the way Chrome does and speak the protocol.
//
// They exist because a real call found what no unit test could: shell.run
// reported status success with exitCode 0 and stdout "", because the collected
// output lived only in the promise closure and was never attached to the result.
// A host that silently discards a command's output is worse than one that fails,
// since the caller has no way to notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = fileURLToPath(new URL('../native-host/host.js', import.meta.url));

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// One request per process, which is enough to prove framing, dispatch and the
// reply shape without inventing a multiplexed harness Chrome never uses.
function ask(message, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let pending = Buffer.alloc(0);
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('host did not answer in time')), timeoutMs);
    child.stdout.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = pending.readUInt32LE(0);
      if (pending.length < 4 + length) return;
      try { done(null, JSON.parse(pending.subarray(4, 4 + length).toString('utf8'))); }
      catch (error) { done(error); }
    });
    child.on('error', error => done(error));
    child.stdin.write(frame(message));
  });
}

test('ping answers with the host version and pid', async () => {
  const reply = await ask({ op: 'ping' });
  assert.equal(reply.ok, true);
  assert.equal(reply.pong, true);
  assert.match(reply.hostVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isInteger(reply.pid));
});

test('an unknown op lists the ops that do exist', async () => {
  const reply = await ask({ op: 'teleport' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /unknown_op/);
  assert.ok(reply.availableOps.includes('ping'));
  assert.ok(reply.availableOps.includes('shell.run'));
});

test('system.info names the Chrome channels that actually exist on this machine', async () => {
  const reply = await ask({ op: 'system.info' });
  assert.equal(reply.ok, true);
  assert.equal(reply.platform, process.platform);
  assert.ok(Array.isArray(reply.chromeChannels));
  for (const channel of reply.chromeChannels) {
    assert.ok(channel.channel);
    assert.match(channel.userDataDir, /User Data$/);
  }
});

test('shell.run returns the output the command actually produced', async () => {
  const reply = await ask({ op: 'shell.run', args: { command: process.execPath, args: ['-e', 'process.stdout.write("HOST-OUTPUT-OK")'] } });
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 'success');
  assert.equal(reply.exitCode, 0);
  assert.equal(reply.stdout, 'HOST-OUTPUT-OK', 'a command that printed something must not report empty output');
  assert.equal(reply.stdoutTruncated, false);
  assert.equal(reply.audited, true);
});

test('a non-zero exit keeps stderr and is reported as failed', async () => {
  const reply = await ask({ op: 'shell.run', args: { command: process.execPath, args: ['-e', 'process.stderr.write("boom"); process.exit(3)'] } });
  assert.equal(reply.status, 'failed');
  assert.equal(reply.exitCode, 3);
  assert.equal(reply.stderr, 'boom');
});

test('a missing executable is an error, not an empty success', async () => {
  const reply = await ask({ op: 'shell.run', args: { command: 'definitely-not-a-real-binary-xyz' } });
  assert.equal(reply.status, 'failed');
  assert.equal(reply.exitCode, null);
  assert.ok(reply.error);
});

test('path.stat reports existence without inventing metadata', async () => {
  const here = await ask({ op: 'path.stat', args: { path: HOST } });
  assert.equal(here.ok, true);
  assert.equal(here.exists, true);
  assert.equal(here.directory, false);
  assert.ok(here.size > 0);
  const missing = await ask({ op: 'path.stat', args: { path: `${HOST}.nope` } });
  assert.equal(missing.exists, false);
});

test('a missing argument is refused with a reason rather than a crash', async () => {
  const reply = await ask({ op: 'shell.run', args: {} });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /command is required/);
});
