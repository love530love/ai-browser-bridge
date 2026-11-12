// Suggest a browserTarget from the Chrome process that actually owns a visible
// window. This module is read-only: it never writes config.json and never reads
// the registry (so it can never "pick chrome.exe by registry order"). The CLI
// decides whether to persist the suggestion, and only when --write is given.
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Windows PowerShell 5.1 (powershell.exe) is always present and carries the
// CimCmdlets module; Get-CimInstance Win32_Process gives ExecutablePath and the
// full CommandLine, while Get-Process supplies the MainWindowHandle that tells
// us which chrome.exe actually owns a visible window. Renderer/GPU/utility
// processes have MainWindowHandle 0 and are deliberately ignored.
function defaultRun() {
  // Headless / CI override: supply the Win32_Process array as JSON so the read
  // path (and the CLI's --write gate) can be exercised without spawning
  // PowerShell. Pure callers inject `run` instead and never reach this branch.
  const injected = process.env.AIB_CHROME_PROCESSES_JSON;
  if (injected) return JSON.parse(injected);
  const ps = [
    "$rows = @(",
    "  Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | ForEach-Object {",
    "    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue",
    "    [PSCustomObject]@{",
    "      ProcessId = $_.ProcessId",
    "      ExecutablePath = $_.ExecutablePath",
    "      CommandLine = $_.CommandLine",
    "      MainWindowHandle = $(if ($p) { [int64]$p.MainWindowHandle } else { 0 })",
    "      MainWindowTitle = $(if ($p) { $p.MainWindowTitle } else { '' })",
    "    }",
    "  }",
    ")",
    "ConvertTo-Json -InputObject $rows -Compress -Depth 3"
  ].join(' ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
  if (!out || !out.trim()) return [];
  const parsed = JSON.parse(out);
  if (parsed === null || parsed === undefined) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function channelFromExe(exePath) {
  const lower = String(exePath).replace(/\//g, '\\').toLowerCase();
  if (lower.includes('chrome sxs')) return 'canary';
  if (lower.includes('chrome beta')) return 'beta';
  if (lower.includes('chrome dev')) return 'dev';
  return 'stable';
}

function defaultUserDataDir(channel, env) {
  const folder = channel === 'canary' ? 'Chrome SxS'
    : channel === 'beta' ? 'Chrome Beta'
      : channel === 'dev' ? 'Chrome Dev' : 'Chrome';
  const localAppData = env.LOCALAPPDATA ?? '';
  return localAppData
    ? join(localAppData, 'Google', folder, 'User Data')
    : join('Google', folder, 'User Data');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Chrome writes these flags either as --flag=value, --flag="value",
// --flag value or --flag "value". The quoted forms are tried first so a path
// containing spaces (e.g. "...\User Data") is captured whole.
function extractFlag(commandLine, flag) {
  const f = escapeRegExp(flag);
  let m = new RegExp(`${f}="([^"]*)"`).exec(commandLine);
  if (m) return m[1];
  m = new RegExp(`${f}=([^\\s"]+)`).exec(commandLine);
  if (m) return m[1];
  m = new RegExp(`${f}\\s+"([^"]*)"`).exec(commandLine);
  if (m) return m[1];
  m = new RegExp(`${f}\\s+([^\\s"]+)`).exec(commandLine);
  if (m) return m[1];
  return null;
}

function deriveTarget(process, env) {
  const exePath = process.ExecutablePath ? String(process.ExecutablePath) : '';
  const commandLine = process.CommandLine ? String(process.CommandLine) : '';
  const userDataDirFlag = extractFlag(commandLine, '--user-data-dir');
  const profileDirectoryFlag = extractFlag(commandLine, '--profile-directory');
  const channel = channelFromExe(exePath);
  const target = {
    exePath,
    userDataDir: userDataDirFlag ?? defaultUserDataDir(channel, env),
    profileDirectory: profileDirectoryFlag ?? 'Default',
    channel
  };
  const flags = {
    userDataDirFrom: userDataDirFlag ? 'command-line --user-data-dir' : 'chrome-default-for-channel',
    profileDirectoryFrom: profileDirectoryFlag ? 'command-line --profile-directory' : 'default'
  };
  return { target, flags };
}

function isFile(path) {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}
function isDirectory(path) {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}

export function inferBrowserTarget({ platform = process.platform, run = defaultRun, env = process.env } = {}) {
  if (platform !== 'win32') {
    return { ok: false, reason: 'unsupported_platform', detail: 'inferBrowserTarget uses Get-CimInstance / Get-Process and is Windows-only.' };
  }

  let processes;
  try {
    processes = run();
  } catch (error) {
    return { ok: false, reason: 'query_failed', detail: String(error?.message ?? error).slice(0, 300) };
  }
  if (!Array.isArray(processes)) {
    return { ok: false, reason: 'query_failed', detail: 'Process query did not return an array.' };
  }

  // Only the browser process that owns a visible main window is evidence.
  // Never fall back to registry App Paths or to the first chrome.exe by name.
  const visible = processes.filter(p => p && Number(p.MainWindowHandle) > 0 && p.ExecutablePath);
  if (visible.length === 0) {
    return { ok: false, reason: 'no_visible_window', detail: 'No chrome.exe process owns a visible main window.' };
  }

  const derived = visible.map(p => deriveTarget(p, env));
  const distinct = new Map();
  for (const d of derived) {
    const key = [d.target.exePath, d.target.userDataDir, d.target.profileDirectory]
      .map(value => String(value).toLowerCase()).join('|');
    if (!distinct.has(key)) distinct.set(key, d);
  }
  if (distinct.size > 1) {
    return { ok: false, reason: 'ambiguous_visible_window', detail: `${distinct.size} different Chrome targets own visible windows; refusing to guess.` };
  }

  const chosen = [...distinct.values()][0];
  const { target, flags } = chosen;
  if (!isFile(target.exePath)) {
    return { ok: false, reason: 'exe_path_not_found', target, detail: `ExecutablePath does not exist or is not a file: ${target.exePath}` };
  }
  if (!isDirectory(target.userDataDir)) {
    return { ok: false, reason: 'user_data_dir_not_found', target, detail: `userDataDir does not exist or is not a directory: ${target.userDataDir}` };
  }
  if (!/^(Default|Profile \d+)$/.test(target.profileDirectory)) {
    return { ok: false, reason: 'invalid_profile_directory', target, detail: `profileDirectory is not Default or "Profile N": ${target.profileDirectory}` };
  }

  return {
    ok: true,
    target,
    evidence: {
      visibleWindowCount: visible.length,
      matchedProcessIds: visible.map(p => p.ProcessId),
      exePathFrom: 'Win32_Process.ExecutablePath',
      userDataDirFrom: flags.userDataDirFrom,
      profileDirectoryFrom: flags.profileDirectoryFrom,
      channel: target.channel,
      registryUsed: false
    }
  };
}
