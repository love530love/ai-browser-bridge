import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

// Clearing an extension's error list is the one maintenance job that no extension
// API can do: the list lives only inside chrome://extensions, developerPrivate
// exists only in that page, and chrome.debugger refuses a chrome:// target with
// "Cannot access a chrome:// URL".
//
// The whole job therefore runs inside one PowerShell process, on purpose. Chrome
// enables its accessibility engine per document and only while an
// assistive-technology client is attached, so a reload in one process and a read
// in another never see the page's own controls - measured before this was one
// process: 86 controls and zero Document nodes, every time.
export async function clearExtensionErrors(target, { platform = process.platform, timeoutMs = 20000 } = {}) {
  if (platform !== 'win32') return { status: 'unavailable', reason: 'platform_unsupported', cleared: 0, dispatched: false };
  if (![target.processId, target.windowHandle].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Exact process and window required');
  const executable = (process.env.PATH ?? '').split(delimiter).map(p => join(p.replace(/^"|"$/g, ''), 'pwsh.exe')).find(existsSync);
  if (!executable) return { status: 'unavailable', reason: 'powershell7_unavailable', cleared: 0, dispatched: false };
  const script = fileURLToPath(new URL('../scripts/clear-extension-errors.ps1', import.meta.url));
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    let timer;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const failed = reason => ({ status: 'failed', reason, cleared: 0, dispatched: false, retryable: true });
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', script,
      '-ChromeProcessId', String(target.processId), '-ChromeWindowHandle', String(target.windowHandle)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    timer = setTimeout(() => { child.kill(); done(failed('clear_extension_errors_timeout')); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 200000) { child.kill(); done(failed('clear_extension_errors_output_limit')); }
    });
    child.on('error', () => done(failed('clear_extension_errors_spawn_failed')));
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw Error();
        const value = JSON.parse(output);
        if (typeof value?.status !== 'string') throw Error();
        done(value);
      } catch { done(failed('clear_extension_errors_invalid_result')); }
    });
  });
}
