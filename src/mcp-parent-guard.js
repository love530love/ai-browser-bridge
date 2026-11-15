import { execFile } from 'node:child_process';

// One stdio adapter process per MCP client is unavoidable: MCP runs over the
// client's own stdin/stdout. The risk is an adapter that outlives its client -
// the client is killed without closing the pipe, stdin never reaches EOF, and
// the adapter keeps a Node runtime (and the bridge client) alive indefinitely.
//
// A bare `process.ppid` check is not safe: when a shell or launcher starts the
// adapter and exits, the recorded parent is already gone while the real client
// is alive, so a naive guard would kill a perfectly good session. This guard
// therefore needs TWO independent facts before it acts:
//   1. the parent's process name is readable, and
//   2. that name is not a shell/launcher that is expected to exit.
// Only then does it monitor the recorded parent and exit on its death.
// Unknown names, probe failures, non-Windows platforms and shell parents all
// disable the guard; the registry still makes such an adapter visible.
export const SHELL_PARENT_NAMES = new Set([
  'bash.exe', 'sh.exe', 'dash.exe', 'zsh.exe', 'cmd.exe', 'conhost.exe',
  'powershell.exe', 'pwsh.exe', 'winpty.exe', 'node.exe', 'npx.cmd', 'npm.cmd', 'cmd',
  'wt.exe', 'windowsterminal.exe', 'bash', 'sh', 'dash', 'zsh', 'pwsh', 'powershell',
  'node', 'winpty', 'conhost'
]);

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function normalizeName(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim().split(/\r?\n/).find(Boolean);
  if (!text) return null;
  const name = text.replace(/^"|"$/g, '').trim().toLowerCase();
  if (!name || /^(info|error)[:\s]/i.test(name)) return null;
  return name.includes('.') ? name : `${name}.exe`;
}

function parseTasklistName(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).find(Boolean);
  return normalizeName(line?.match(/^"([^"]+)"/)?.[1] ?? null);
}

// `tasklist /FI` is measurably slower than a PowerShell Get-Process on some
// hosts (measured here: >8s vs ~0.75s, which made every probe time out and the
// guard disarm itself). Try the fast exact lookup first and keep tasklist as a
// last resort for machines without any PowerShell.
export function probeParentName(pid, { execFileFn = execFile, platform = process.platform, timeout = 4000 } = {}) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 1) return Promise.resolve(null);
  const lookup = `(Get-Process -Id ${pid} -ErrorAction Stop).ProcessName`;
  const attempts = [
    ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', lookup], normalizeName],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lookup], normalizeName],
    ['tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], parseTasklistName]
  ];
  const tryAt = index => {
    if (index >= attempts.length) return Promise.resolve(null);
    const [command, args, parse] = attempts[index];
    return new Promise(resolve => {
      execFileFn(command, args, { windowsHide: true, timeout }, (error, stdout) => {
        if (!error) {
          const name = parse(stdout);
          if (name) return resolve(name);
        }
        resolve(tryAt(index + 1));
      });
    });
  };
  return tryAt(0);
}

export function createParentGuard({
  ppid = process.ppid,
  intervalMs = 30000,
  probe = probeParentName,
  alive = isProcessAlive,
  onOrphan = () => {},
  onDisarm = () => {}
} = {}) {
  let timer = null;
  let armed = false;
  let stopped = false;
  let parentName = null;
  let checks = 0;
  let probeFailures = 0;
  const PROBE_ATTEMPTS = 3;

  const tick = async () => {
    if (stopped) return;
    checks += 1;
    if (!armed) {
      parentName = await probe(ppid);
      // A single unreadable probe is not a verdict. Disarm only after repeated
      // failures, so a transiently slow lookup cannot silently disable the guard
      // for the rest of the session.
      if (!parentName) {
        probeFailures += 1;
        if (probeFailures < PROBE_ATTEMPTS) return;
        stopped = true;
        clearInterval(timer); timer = null;
        onDisarm({ parentName, reason: 'parent_name_unavailable', attempts: probeFailures });
        return;
      }
      if (SHELL_PARENT_NAMES.has(parentName)) {
        stopped = true;
        clearInterval(timer); timer = null;
        onDisarm({ parentName, reason: 'shell_or_launcher_parent' });
        return;
      }
      armed = true;
      return;
    }
    if (!alive(ppid)) {
      stopped = true;
      clearInterval(timer); timer = null;
      onOrphan({ parentName, ppid, checks });
    }
  };

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => { void tick(); }, Math.max(50, intervalMs));
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Test/status surface. `armed:false` is not a failure; it means the guard
    // deliberately declined to make a liveness decision.
    snapshot() { return { armed, stopped, parentName, ppid, checks, probeFailures }; }
  };
}
