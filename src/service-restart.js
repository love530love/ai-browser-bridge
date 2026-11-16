// Official idle-gated service restart.
//
// `git pull` changes disk source while the running process keeps its startup
// BUILD_ID. The watchdog deliberately never restarts anything by itself, and a
// blind Stop-Process is unsafe because `.local/server.pid` is a claim, not
// identity. This module is the one place allowed to ask the service to exit:
// it proves the listener and watchdog identities, proves the queue is idle,
// records a restart intent, then asks the service to close itself. The watchdog
// starts the new source. A signal is never sent to an unverified PID.
//
// The command is a dry run unless `apply:true` is passed.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeBuildIdentity } from './build-identity.js';
import { recordLifecycle } from './service-lifecycle.js';

export const RESTART_CONFIRMATION = 'restart_service_when_idle_once';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_POLL_MS = 1000;

const normalizePath = value => String(value ?? '').replace(/\\/g, '/').toLowerCase();

export function parseNetstatListener(stdout, port) {
  const suffix = `:${port}`;
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue;
    if (!columns[1].endsWith(suffix) || columns[3].toUpperCase() !== 'LISTENING') continue;
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

export function probeProcessIdentity(pid, { execFileFn = execFileSync, timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return { checked: false, pid, error: 'invalid_pid' };
  if (process.platform !== 'win32') return { checked: false, pid, error: 'unsupported_platform' };
  const lookup = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; $p | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const attempts = [
    ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', lookup]],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lookup]]
  ];
  for (const [command, args] of attempts) {
    try {
      const stdout = execFileFn(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
      const parsed = JSON.parse(String(stdout).trim());
      const record = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!record || Number(record.ProcessId) !== pid) continue;
      return {
        checked: true,
        pid,
        executablePath: record.ExecutablePath ?? null,
        commandLine: record.CommandLine ?? null,
        error: null
      };
    } catch { /* try the next PowerShell entry point */ }
  }
  return { checked: true, pid, executablePath: null, commandLine: null, error: 'identity_unreadable' };
}

export function probeListener(port, { execFileFn = execFileSync, processIdentity = probeProcessIdentity } = {}) {
  if (process.platform !== 'win32') return { checked: false, pid: null, error: 'unsupported_platform' };
  let stdout;
  try {
    stdout = execFileFn('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  } catch {
    return { checked: false, pid: null, error: 'netstat_failed' };
  }
  const pid = parseNetstatListener(stdout, port);
  if (!pid) return { checked: true, pid: null, error: 'no_listener' };
  return { checked: true, pid, identity: processIdentity(pid), error: null };
}

export function probeWatchdog({ root, stateDir, processIdentity = probeProcessIdentity } = {}) {
  let pid = null;
  try {
    pid = Number(readFileSync(join(stateDir, 'watchdog.pid'), 'utf8').trim());
  } catch {
    return { checked: true, pid: null, error: 'watchdog_pid_missing' };
  }
  if (!Number.isInteger(pid) || pid <= 1) return { checked: true, pid: null, error: 'watchdog_pid_invalid' };
  return { checked: true, pid, identity: processIdentity(pid), root, error: null };
}

function isNodeExecutable(identity) {
  const exe = basename(normalizePath(identity?.executablePath));
  if (exe === 'node.exe' || exe === 'node') return true;
  return /\bnode(?:\.exe)?\b/.test(normalizePath(identity?.commandLine));
}

export function listenerIdentityVerified(listener, root) {
  const identity = listener?.identity;
  if (!listener?.checked || !listener.pid || !identity?.checked) return false;
  if (!identity.commandLine) return false;
  if (!isNodeExecutable(identity)) return false;
  const command = normalizePath(identity.commandLine);
  // The pid was already matched against the authenticated /status reply, so a
  // relative `node src/server.js` is accepted. An absolute entry path that is
  // not under this project root is not this project's service.
  if (!command.includes('src/server.js')) return false;
  const expected = normalizePath(root);
  if (expected && command.includes(expected)) return true;
  return !/(?:^|[\s"'])[a-z]:\/[^"'\s]*src\/server\.js/.test(command);
}

export function watchdogIdentityVerified(watchdog, root) {
  const identity = watchdog?.identity;
  if (!watchdog?.checked || !watchdog.pid || !identity?.checked) return false;
  if (!identity.commandLine) return false;
  const command = normalizePath(identity.commandLine);
  const expected = normalizePath(root);
  const shell = basename(normalizePath(identity.executablePath));
  if (!['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell'].includes(shell)) return false;
  return command.includes('watch-service.ps1') && (!expected || command.includes(expected));
}

function reason(code, message) {
  return { code, message };
}

export function evaluateRestartPreflight({
  status = null,
  diskBuildId = null,
  expectedRunningBuildId = null,
  listener = null,
  watchdog = null,
  root = ''
} = {}) {
  const reasons = [];
  if (!status || status.service !== 'ai-browser-bridge') {
    return { status: 'refused', ok: false, reasons: [reason('service_unreachable', '/status did not answer as the bridge service.')] };
  }
  const runningBuildId = status.buildId ?? null;
  if (expectedRunningBuildId && runningBuildId !== expectedRunningBuildId) {
    return { status: 'refused', ok: false, reasons: [reason('preflight_stale', 'The running build changed after the preflight read; re-observe /status before deciding.')] };
  }
  if (!diskBuildId) {
    return { status: 'refused', ok: false, reasons: [reason('disk_identity_unavailable', 'The disk source identity could not be computed; refusing to restart on unknown state.')] };
  }
  if (runningBuildId === diskBuildId) {
    return { status: 'not_needed', ok: true, reasons: [], runningBuildId, diskBuildId, pid: status.pid ?? null };
  }
  if (!Number.isInteger(status.pid) || status.pid <= 1) reasons.push(reason('status_pid_missing', '/status does not report a service pid; listener identity cannot be compared.'));

  const busy = [];
  if (status.active) busy.push('active');
  if (Number(status.activeCount ?? 0) > 0) busy.push('activeCount');
  if (Number(status.queued ?? 0) > 0) busy.push('queued');
  if (status.taskLease) busy.push('taskLease');
  if (status.desktopOperation) busy.push('desktopOperation');
  if (Array.isArray(status.tabLeases) && status.tabLeases.length > 0) busy.push('tabLeases');
  if (status.maintenance) busy.push('maintenance');
  if (busy.length > 0) {
    return {
      status: 'waiting', ok: false, retryable: true,
      reasons: [reason('service_busy', `Service is not idle: ${busy.join(', ')}. Preserve running tasks and retry later.`)],
      busy, runningBuildId, diskBuildId, pid: status.pid ?? null
    };
  }

  if (!listener?.checked) reasons.push(reason('listener_unverified', `Listener identity could not be checked (${listener?.error ?? 'unknown'}).`));
  else if (!listener.pid) reasons.push(reason('listener_missing', `No LISTENING socket was found for the configured port (${listener.error ?? 'unknown'}).`));
  else if (listener.pid !== status.pid) reasons.push(reason('listener_pid_mismatch', `The LISTENING pid (${listener.pid}) is not the pid reported by /status (${status.pid ?? 'missing'}).`));
  else if (!listenerIdentityVerified(listener, root)) reasons.push(reason('listener_identity_unverified', 'The LISTENING pid is not proven to run this project\'s src/server.js.'));

  if (!watchdog?.checked) reasons.push(reason('watchdog_unverified', `Watchdog identity could not be checked (${watchdog?.error ?? 'unknown'}).`));
  else if (!watchdog.pid) reasons.push(reason('watchdog_missing', `No watchdog pid is recorded (${watchdog.error ?? 'unknown'}). Nothing would start the new code.`));
  else if (!watchdogIdentityVerified(watchdog, root)) reasons.push(reason('watchdog_identity_unverified', 'The recorded watchdog pid is not proven to run scripts/watch-service.ps1 for this project.'));

  return {
    status: reasons.length === 0 ? 'ready' : 'refused',
    ok: reasons.length === 0,
    reasons,
    runningBuildId, diskBuildId,
    pid: status.pid ?? null,
    listenerPid: listener?.pid ?? null,
    watchdogPid: watchdog?.pid ?? null,
    idle: true
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function restartServiceWhenIdle({
  request,
  root,
  stateDir,
  port,
  apply = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  compute = computeBuildIdentity,
  probes = {},
  writeLifecycle = event => recordLifecycle(stateDir, event),
  wait = sleep
} = {}) {
  let diskBuildId = null;
  try { diskBuildId = compute(root); }
  catch (error) { return { status: 'refused', ok: false, reasons: [reason('disk_identity_unavailable', String(error?.message ?? error))] }; }

  let status;
  try { status = await request('/status'); }
  catch (error) {
    return { status: 'refused', ok: false, reasons: [reason('service_unreachable', String(error?.message ?? error))], diskBuildId };
  }

  const listener = (probes.listener ?? probeListener)(port);
  const watchdog = (probes.watchdog ?? probeWatchdog)({ root, stateDir });
  const preflight = evaluateRestartPreflight({
    status, diskBuildId, expectedRunningBuildId: status.buildId ?? null, listener, watchdog, root
  });

  if (preflight.status === 'not_needed' || preflight.status === 'waiting' || preflight.status === 'refused') {
    return {
      ...preflight,
      command: 'node src/cli.js restart-service-when-idle --apply',
      dryRun: !apply,
      listener: { checked: !!listener?.checked, pid: listener?.pid ?? null, error: listener?.error ?? null, identityVerified: listenerIdentityVerified(listener, root) },
      watchdog: { checked: !!watchdog?.checked, pid: watchdog?.pid ?? null, error: watchdog?.error ?? null, identityVerified: watchdogIdentityVerified(watchdog, root) }
    };
  }

  const common = {
    ok: true,
    runningBuildId: preflight.runningBuildId,
    diskBuildId,
    pid: preflight.pid,
    command: 'node src/cli.js restart-service-when-idle --apply',
    listener: { checked: true, pid: listener.pid, identityVerified: true },
    watchdog: { checked: true, pid: watchdog.pid, identityVerified: true }
  };
  if (!apply) {
    return {
      ...common,
      status: 'dry_run',
      dryRun: true,
      wouldRestart: true,
      next: 'Re-run with --apply. The same idle, listener, watchdog and build-identity gates are checked again before anything exits.'
    };
  }

  const intentId = randomUUID();
  const intent = writeLifecycle({
    event: 'restart_intent', intentId, requestedBy: 'cli', reason: 'idle_restart',
    pid: status.pid, runningBuildId: status.buildId, diskBuildId,
    listenerPid: listener.pid, watchdogPid: watchdog.pid
  });
  if (!intent) {
    return { ...common, ok: false, status: 'refused', reasons: [reason('intent_not_recorded', 'The restart intent could not be appended to the lifecycle ledger; refusing an unattributable restart.')] };
  }

  const cancel = reasonText => writeLifecycle({ event: 'restart_intent_cancelled', intentId, reason: reasonText });
  let response;
  try {
    response = await request('/restart-when-idle', {
      confirmation: RESTART_CONFIRMATION,
      expectedBuildId: status.buildId,
      diskBuildId,
      ttlMs: 30000
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/not found|http 404/i.test(message)) {
      cancel('restart_endpoint_unavailable');
      return {
        ...common, ok: false, status: 'refused', intentId,
        reasons: [reason('restart_endpoint_unavailable', 'The running service predates /restart-when-idle. No signal was sent. Do the one-time manual migration documented by upgrade-check, then this command becomes available.')],
        evidence: { message }
      };
    }
    return {
      ...common, ok: false, status: 'uncertain', intentId, retryable: false,
      reasons: [reason('dispatch_unconfirmed', 'The restart request may have reached the service, but its response was not observed. Do not resend; observe /status and service-history first.')],
      evidence: { message }
    };
  }

  if (response?.status === 'not_needed') {
    cancel('not_needed_after_preflight');
    return { ...common, status: 'not_needed', intentId, observed: response };
  }
  if (response?.status === 'waiting') {
    cancel(`service_waiting:${response.reason ?? 'busy'}`);
    return {
      ...common, ok: false, status: 'waiting', retryable: true, intentId,
      reasons: [reason(response.reason ?? 'service_busy', 'The service refused to exit because it was not idle. Preserve running tasks and retry later.')],
      observed: response
    };
  }
  if (response?.status !== 'restarting' && response?.status !== 'accepted') {
    cancel(`unexpected_response:${response?.status ?? 'none'}`);
    return { ...common, ok: false, status: 'refused', intentId, reasons: [reason('unexpected_response', 'The service did not confirm the restart request.')], observed: response };
  }

  const deadline = Date.now() + timeoutMs;
  let lastBuildId = null;
  let observedUnavailable = false;
  let lastError = null;
  while (Date.now() < deadline) {
    await wait(pollMs);
    try {
      const next = await request('/status');
      lastBuildId = next.buildId ?? null;
      observedUnavailable = false;
      if (lastBuildId === diskBuildId) {
        return {
          ...common, status: 'verified', intentId,
          newPid: next.pid ?? null,
          serviceVersion: next.version ?? null,
          extensionVersion: next.extensionVersion ?? null,
          deploymentStale: next.deploymentStale ?? null
        };
      }
    } catch (error) {
      observedUnavailable = true;
      lastError = String(error?.message ?? error);
    }
  }
  return {
    ...common, ok: false, status: 'uncertain', retryable: false, intentId,
    reasons: [reason('verified_build_not_observed', `The new build ${diskBuildId.slice(0, 12)} was not observed before the timeout. Do not resend the restart; inspect /status, the watchdog log and service-history.`)],
    evidence: { lastBuildId, observedUnavailable, lastError }
  };
}
