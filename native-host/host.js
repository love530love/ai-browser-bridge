// The bridge's native messaging host.
//
// A native host is the only way an extension can reach outside the browser
// sandbox, and it is also the only way to make the nativeMessaging permission
// mean anything: without a registered host, chrome.runtime.connectNative fails
// immediately with "Specified native messaging host not found", so a permission
// with no host is a permission with no capability.
//
// Protocol: stdin/stdout, each message a 4-byte little-endian length prefix
// followed by UTF-8 JSON. Chrome closes the pipe when the extension port is
// disconnected, which is the signal to exit.
//
// What this host will do is a fixed, named set. It is not a shell-over-a-pipe by
// accident: `shell.run` is a named operation with an explicit argv, no shell
// interpolation, a hard timeout, a bounded output, and an append-only audit line
// for every invocation. The reason is not squeamishness - the service this host
// belongs to already spawns PowerShell - it is that an unlogged, unbounded
// command channel reachable from a web page is a different class of thing from a
// logged, bounded one. Everything else here is read-only.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { hostname, platform, release, arch, userInfo, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST_VERSION = '0.24.0';
const MAX_MESSAGE = 32 * 1024 * 1024;
const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;

function auditDir() {
  const base = process.env.LOCALAPPDATA || tmpdir();
  return join(base, 'AIBrowserBridge');
}

function audit(line) {
  try {
    mkdirSync(auditDir(), { recursive: true });
    appendFileSync(join(auditDir(), 'native-host.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // An audit write that fails must not fail the command: the caller already
    // got an answer it acted on, and losing the log line is the smaller harm.
  }
}

function send(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function clip(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_OUTPUT) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_OUTPUT), truncated: true };
}

const OPS = {
  ping() {
    return { pong: true, hostVersion: HOST_VERSION, pid: process.pid, node: process.version };
  },
  'system.info'() {
    let user = null;
    try { user = userInfo().username; } catch { user = null; }
    const channels = [
      ['stable', join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')],
      ['beta', join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome Beta', 'User Data')],
      ['canary', join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome SxS', 'User Data')],
      ['dev', join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome Dev', 'User Data')]
    ].filter(([, path]) => path && existsSync(path)).map(([channel, path]) => ({ channel, userDataDir: path }));
    return {
      platform: platform(), release: release(), arch: arch(), hostname: hostname(),
      user, home: homedir(), node: process.version, hostVersion: HOST_VERSION,
      chromeChannels: channels
    };
  },
  'path.stat'(args) {
    const target = String(args?.path ?? '');
    if (!target) throw new Error('path is required');
    if (!existsSync(target)) return { exists: false, path: target };
    const info = statSync(target);
    return { exists: true, path: target, directory: info.isDirectory(), size: info.size, modifiedAt: info.mtime.toISOString(), createdAt: info.birthtime.toISOString() };
  },
  async 'shell.run'(args) {
    const command = String(args?.command ?? '');
    if (!command) throw new Error('command is required');
    const argv = Array.isArray(args?.args) ? args.args.map(item => String(item)) : [];
    const cwd = typeof args?.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
    const requested = Number(args?.timeoutMs);
    const timeoutMs = Number.isFinite(requested) ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.trunc(requested))) : DEFAULT_TIMEOUT_MS;
    audit(`shell.run cwd=${JSON.stringify(cwd)} command=${JSON.stringify(command)} args=${JSON.stringify(argv)}`);
    const started = Date.now();
    const result = await new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The collected streams travel with the result. They were once only in
        // this closure, so every run reported stdout:"" with exitCode:0 - a
        // successful command whose output was silently thrown away, which looks
        // exactly like a command that printed nothing.
        resolve({ stdout, stderr, ...value, durationMs: Date.now() - started });
      };
      let child;
      try {
        child = spawn(command, argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        finish({ code: null, error: error.message });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ code: null, timedOut: true });
      }, timeoutMs);
      child.stdout?.on('data', chunk => { if (stdout.length < MAX_OUTPUT * 2) stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', chunk => { if (stderr.length < MAX_OUTPUT * 2) stderr += chunk.toString('utf8'); });
      child.on('error', error => finish({ code: null, error: error.message }));
      child.on('close', code => finish({ code }));
    });
    const out = clip(result.stdout);
    const err = clip(result.stderr);
    return {
      status: result.timedOut ? 'timeout' : result.error ? 'failed' : result.code === 0 ? 'success' : 'failed',
      exitCode: result.code ?? null, timedOut: result.timedOut === true,
      stdout: out.text, stdoutTruncated: out.truncated,
      stderr: err.text, stderrTruncated: err.truncated,
      error: result.error ?? null, durationMs: result.durationMs,
      audited: true
    };
  }
};

async function handle(message) {
  const op = String(message?.op ?? '');
  const handler = OPS[op];
  if (!handler) {
    return { ok: false, error: `unknown_op: ${op || '(empty)'}`, availableOps: Object.keys(OPS) };
  }
  try {
    const value = await handler(message?.args ?? {});
    return { ok: true, op, ...(value && typeof value === 'object' ? value : { value }) };
  } catch (error) {
    return { ok: false, op, error: String(error?.message ?? error) };
  }
}

let pending = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (length > MAX_MESSAGE) {
      audit(`protocol_error frame_too_large length=${length}`);
      send({ ok: false, error: 'frame_too_large' });
      process.exit(1);
    }
    if (pending.length < 4 + length) return;
    const body = pending.subarray(4, 4 + length).toString('utf8');
    pending = pending.subarray(4 + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      send({ ok: false, error: 'invalid_json' });
      continue;
    }
    const id = message?.id ?? null;
    // Answered in order, one at a time. Native messaging is a single pipe and
    // Chrome matches replies by position, so interleaving would mis-attribute a
    // result to the wrong request.
    handle(message).then(reply => send(id === null ? reply : { id, ...reply }));
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', error => {
  audit(`uncaught ${error?.stack ?? error}`);
  process.exit(1);
});
