import { execFile } from 'node:child_process';

// One stdio adapter process per MCP client is unavoidable: MCP runs over the
// client's own stdin/stdout. The risk is an adapter that outlives its client -
// the client is killed without closing the pipe, stdin never reaches EOF, and
// the adapter keeps a Node runtime (and the bridge client) alive indefinitely.
//
// A bare `process.ppid` check is not safe, and neither is "disarm when the
// parent is a shell". Wrapper shells are normal: a client may launch
// `cmd /c node adapter.js`, a terminal may sit between the client and the
// adapter, or an IDE may spawn through a helper. Disarming there left the
// adapter unguarded (the residual wrapper-shell boundary).
//
// This guard walks the ancestor chain once, skips launchers and session roots,
// and anchors on the first stable ancestor (pid + creation time). It then
// monitors that anchor. If no stable ancestor exists, or the chain cannot be
// read, the guard stays in `passive` mode and keeps the adapter visible in the
// registry instead of pretending it is protected.
export const SHELL_PARENT_NAMES = new Set([
  'bash.exe', 'sh.exe', 'dash.exe', 'zsh.exe', 'cmd.exe', 'conhost.exe',
  'powershell.exe', 'pwsh.exe', 'winpty.exe', 'node.exe', 'npx.cmd', 'npm.cmd', 'cmd',
  'wt.exe', 'windowsterminal.exe', 'openconsole.exe', 'wsl.exe', 'bash', 'sh', 'dash',
  'zsh', 'pwsh', 'powershell', 'node', 'winpty', 'conhost'
]);

// Processes that own a session rather than a client. Anchoring on them would
// make every adapter live until logoff, which is the opposite of the guard.
export const SESSION_ROOT_NAMES = new Set([
  'explorer.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'lsass.exe',
  'csrss.exe', 'smss.exe', 'svchost.exe', 'system', 'registry', 'init',
  'systemd', 'launchd', 'loginwindow', 'kernel_task', 'pid 0'
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

// Two lookup strategies, both bounded:
//  - PowerShell 7's Process object exposes `.Parent`, and walking it measured
//    ~1s on this host. Get-CimInstance measured >10s here and timed out, so
//    CIM is only the fallback for Windows PowerShell 5.1, which lacks Parent.
// $pid is a read-only automatic variable in PowerShell, hence $procId.
const PARENT_WALK_LOOKUP = pid => [
  '$chain=@();',
  `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
  'for($i=0; $i -lt 10 -and $null -ne $p; $i++){',
  '  $created=$null; try{$created=$p.StartTime.ToUniversalTime().ToString("o")}catch{};',
  '  $chain += [pscustomobject]@{pid=[int]$p.Id;name=[string]$p.ProcessName;created=$created};',
  '  $parent=$null; try{$parent=$p.Parent}catch{};',
  '  if($null -eq $parent){break};',
  '  $p=$parent',
  '};',
  'if($chain.Count -eq 0){exit 2};',
  '$chain | ConvertTo-Json -Compress'
].join(' ');

const CIM_LOOKUP = pid => [
  '$chain=@();',
  `$procId=${pid};`,
  'for($i=0; $i -lt 10 -and $procId -gt 0; $i++){',
  '  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue;',
  '  if($null -eq $p){break};',
  '  $created=$null; try{$created=$p.CreationDate.ToUniversalTime().ToString("o")}catch{};',
  '  $chain += [pscustomobject]@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;name=[string]$p.Name;created=$created};',
  '  if([int]$p.ParentProcessId -eq 0 -or [int]$p.ParentProcessId -eq $procId){break};',
  '  $procId=[int]$p.ParentProcessId',
  '};',
  'if($chain.Count -eq 0){exit 2};',
  '$chain | ConvertTo-Json -Compress'
].join(' ');

export function parseProcessChain(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const chain = [];
  for (const row of rows) {
    const pid = Number(row?.pid);
    const ppid = Number(row?.ppid);
    const name = normalizeName(row?.name);
    if (!Number.isInteger(pid) || pid <= 1 || !name) continue;
    chain.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : null,
      name,
      created: typeof row?.created === 'string' && row.created ? row.created : null
    });
  }
  return chain.length ? chain : null;
}

export function probeProcessChain(pid, { execFileFn = execFile, platform = process.platform, timeout = 6000 } = {}) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 1) return Promise.resolve(null);
  const attempts = [
    ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', PARENT_WALK_LOOKUP(pid)], timeout],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CIM_LOOKUP(pid)], Math.min(timeout, 4000)]
  ];
  const tryAt = index => {
    if (index >= attempts.length) return Promise.resolve(null);
    const [exe, args, attemptTimeout] = attempts[index];
    return new Promise(resolve => {
      execFileFn(exe, args, { windowsHide: true, timeout: attemptTimeout }, (error, stdout) => {
        if (!error) {
          const chain = parseProcessChain(stdout);
          if (chain) return resolve(chain);
        }
        resolve(tryAt(index + 1));
      });
    });
  };
  return tryAt(0);
}

// The first ancestor that is neither a launcher nor a session root. The chain
// passed here must start at the immediate parent.
export function selectAncestorAnchor(chain = []) {
  for (const entry of (Array.isArray(chain) ? chain : [])) {
    const name = normalizeName(entry?.name);
    if (!name || !Number.isInteger(entry?.pid) || entry.pid <= 1) continue;
    if (SHELL_PARENT_NAMES.has(name) || SESSION_ROOT_NAMES.has(name)) continue;
    return {
      pid: entry.pid,
      name,
      created: typeof entry.created === 'string' ? entry.created : null,
      ppid: Number.isInteger(entry.ppid) && entry.ppid > 0 ? entry.ppid : null
    };
  }
  return null;
}

export function createParentGuard({
  ppid = process.ppid,
  intervalMs = 30000,
  identityEveryMs = 300000,
  passiveRetryMs = 60000,
  chain = probeProcessChain,
  alive = isProcessAlive,
  onOrphan = () => {},
  onArm = () => {},
  onPassive = () => {}
} = {}) {
  let timer = null;
  let stopped = false;
  let ticking = false;
  let mode = 'pending';
  let anchor = null;
  let lastChain = null;
  let checks = 0;
  let ticks = 0;
  let probeFailures = 0;
  let identityFailures = 0;
  let lastPassiveAt = 0;
  let passiveReason = null;
  const identityEveryTicks = Math.max(1, Math.ceil(identityEveryMs / Math.max(50, intervalMs)));

  const becomePassive = reason => {
    if (mode !== 'passive') {
      mode = 'passive';
      passiveReason = reason;
      onPassive({ reason, parentPid: ppid, chain: lastChain });
    }
    mode = 'passive';
    passiveReason = reason;
  };

  const arm = (nextAnchor, chainSnapshot) => {
    mode = 'active';
    anchor = nextAnchor;
    passiveReason = null;
    identityFailures = 0;
    onArm({ anchor: nextAnchor, parentPid: ppid, chain: chainSnapshot });
  };

  const fireOrphan = reason => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    onOrphan({ reason, anchor, parentPid: ppid, checks });
  };

  const resolveAnchor = async () => {
    const snapshot = await chain(ppid);
    checks += 1;
    if (!Array.isArray(snapshot) || !snapshot.length) {
      probeFailures += 1;
      // A transient probe failure retries on the next normal tick; only a
      // sustained failure falls back to the slow passive cadence.
      lastPassiveAt = probeFailures < 3
        ? Date.now() - passiveRetryMs + intervalMs
        : Date.now();
      becomePassive('process_chain_unavailable');
      return;
    }
    probeFailures = 0;
    lastChain = snapshot;
    const next = selectAncestorAnchor(snapshot);
    if (!next) {
      lastPassiveAt = Date.now();
      becomePassive('no_stable_ancestor');
      return;
    }
    arm(next, snapshot);
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    ticks += 1;
    try {
      if (mode !== 'active') {
        // First resolution runs immediately; a passive guard retries on a much
        // longer cadence instead of spawning PowerShell every interval.
        if (mode === 'pending' || Date.now() - lastPassiveAt >= passiveRetryMs) await resolveAnchor();
        return;
      }
      if (!alive(anchor.pid)) {
        fireOrphan('anchor_process_gone');
        return;
      }
      if (ticks % identityEveryTicks === 0) {
        const snapshot = await chain(anchor.pid);
        if (Array.isArray(snapshot) && snapshot.length) {
          const current = snapshot[0];
          if (anchor.created && current.created && current.created !== anchor.created) {
            fireOrphan('anchor_identity_replaced');
            return;
          }
          identityFailures = 0;
        } else {
          identityFailures += 1;
          // An unreadable creation time is not evidence of a dead client.
          if (identityFailures >= 3) becomePassive('anchor_identity_unverifiable');
        }
      }
    } finally {
      ticking = false;
    }
  };

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => { void tick(); }, Math.max(50, intervalMs));
      timer.unref?.();
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Test/status surface. `mode:passive` is not a failure and not protection:
    // it means no stable ancestor could be verified, so no orphan decision is
    // made. `armed` is true only in active mode.
    snapshot() {
      return {
        mode,
        armed: mode === 'active',
        stopped,
        parentPid: ppid,
        anchor,
        chain: (lastChain ?? []).map(entry => ({ pid: entry.pid, name: entry.name, created: entry.created ?? null })),
        passiveReason,
        checks,
        ticks,
        probeFailures,
        identityFailures
      };
    }
  };
}
