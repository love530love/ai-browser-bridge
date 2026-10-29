// Registration of the native messaging host.
//
// This lives on the service side, not in the extension, for one reason: Chrome
// only launches a host whose manifest names the exact extension origin that is
// allowed to call it, and no extension can write a registry key or a manifest
// file. So the install is a service operation, and the extension id it needs is
// the one the extension itself reports over the bridge handshake.
//
// Registration is not a capability of its own - it is the precondition for
// browser_native_messaging to stop returning native_host_not_registered. Keeping
// the two apart means a caller can see which of the two is missing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/native-host-register.ps1', import.meta.url));
const POWERSHELL_EXE = (process.env.PATH ?? '').split(delimiter)
  .map(directory => join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
  .find(candidate => existsSync(candidate)) ?? 'pwsh.exe';
const OUTPUT_LIMIT = 65536;
export const NATIVE_HOST_NAME = 'com.aibridge.host';

function defaultRunner(args, timeoutMs) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish({ code: null, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.on('error', error => finish({ code: null, error: error.message }));
    child.on('close', code => finish({ code }));
  });
}

function lastJsonLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try { return JSON.parse(lines[index]); } catch { /* keep looking upwards */ }
  }
  return null;
}

export async function runNativeHostTool(input = {}, deps = {}) {
  const action = String(input.action ?? 'status');
  if (!['status', 'install', 'uninstall'].includes(action)) {
    return { status: 'denied', retryable: false, action, reason: 'unknown_action', message: `Unknown action "${action}"; use status, install or uninstall.` };
  }
  if (process.platform !== 'win32') {
    return { status: 'unavailable', retryable: false, action, reason: 'windows_only', message: 'Native host registration writes HKCU on Windows. Other platforms use a different manifest location and this adapter has no implementation for them.' };
  }
  const hostName = typeof input.hostName === 'string' && /^[a-z0-9._]{1,120}$/i.test(input.hostName) ? input.hostName : NATIVE_HOST_NAME;
  const args = ['-Action', action, '-HostName', hostName];
  const extensionId = typeof input.extensionId === 'string' ? input.extensionId : '';
  if (action === 'install') {
    if (!/^[a-p]{32}$/.test(extensionId)) {
      return {
        status: 'denied', retryable: false, action, dispatched: false,
        reason: 'extension_id_required',
        message: 'Pass the 32-character extensionId of the connected extension. A native host manifest must name that exact origin and Chrome rejects a wildcard. The bridge reports it as extensionId in browser_health and browser_status.',
        knownExtensionId: deps.extensionId ?? null
      };
    }
    args.push('-ExtensionId', extensionId);
  } else if (extensionId) {
    args.push('-ExtensionId', extensionId);
  }
  const runner = deps.runner ?? defaultRunner;
  const run = await runner(args, 30000);
  if (run?.timedOut) {
    return { status: 'uncertain', retryable: true, action, reason: 'native_host_registration_timeout', hostName, message: 'The registration script did not finish in time. Check action:"status" before retrying.' };
  }
  const payload = lastJsonLine(run?.stdout);
  if (!payload) {
    return {
      status: 'failed', retryable: true, action, hostName,
      reason: 'native_host_registration_unreadable',
      message: 'The registration script produced no parseable result. It needs PowerShell 7 (pwsh) on PATH.',
      detail: String(run?.stderr ?? run?.error ?? '').slice(0, 400) || null
    };
  }
  return { ...payload, hostName };
}

// A tool call can supply the id, but the normal path is that the caller does not
// know it. This keeps the reported value in one place so the denial message can
// hand it back.
export function withKnownExtensionId(input, extensionId) {
  if (input && typeof input.extensionId === 'string' && input.extensionId) return input;
  return { ...(input ?? {}), extensionId: extensionId ?? '' };
}
