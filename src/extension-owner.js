/**
 * Extension Owner Resolver
 *
 * The service accepts exactly one extension WebSocket. When several browsers
 * have the extension installed (system Chrome, Codex/ChatGPT built-in browser,
 * Canary, ...), the one that dialled in owns the whole bridge, and every other
 * browser is silently unusable. Nothing in /status used to say which one it was,
 * so an operator could not tell why "my Chrome does nothing".
 *
 * The extension's WebSocket arrives on an ephemeral local port. netstat maps
 * that (client port, service port) pair to the owning PID, and tasklist maps the
 * PID to a process name. This is read-only, Windows-only, cached briefly, and
 * fails closed: if it cannot be resolved the caller gets null and must not
 * guess which browser is connected.
 */
import { execFileSync } from 'node:child_process';

const CACHE_TTL_MS = 5000;
let cache = { at: 0, value: null };

function processNameFor(pid) {
  // tasklist.exe is unusable on this machine (measured: 15s hard timeout on a
  // single-PID query). Get-Process answers in well under a second. Both paths
  // fail closed: an unresolved name is null, never a guess.
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const name = String(out || '').trim().split(/\r?\n/)[0]?.trim();
    return name && !/^null$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function resolveExtensionOwner(remotePort, localPort) {
  if (!Number.isInteger(remotePort) || !Number.isInteger(localPort)) return null;
  const now = Date.now();
  if (cache.value && cache.value.localPort === localPort && cache.value.remotePort === remotePort && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.value, cached: true };
  }
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    let pid = null;
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+:(\d+)\s+ESTABLISHED\s+(\d+)\s*$/i);
      if (!match) continue;
      const [, clientPort, serverPort, ownerPid] = match;
      if (Number(clientPort) === remotePort && Number(serverPort) === localPort) {
        pid = Number(ownerPid);
        break;
      }
    }
    if (!pid) return null;
    const value = {
      pid,
      processName: processNameFor(pid),
      localPort,
      remotePort,
      observedAt: new Date().toISOString()
    };
    cache = { at: now, value };
    return value;
  } catch {
    return null;
  }
}

/**
 * true  = proven to be a non-chrome.exe host
 * false = proven to be chrome.exe
 * null  = process name unresolved, so the host is UNKNOWN
 *
 * Unknown must never collapse into false: that would let the caller assume a
 * chrome.exe desktop window belongs to the connected extension when it may
 * belong to a completely different browser.
 */
export function isNonChromeHost(owner) {
  if (!owner?.processName) return null;
  return !/^chrome(\.exe)?$/i.test(owner.processName);
}
