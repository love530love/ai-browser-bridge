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
//
// The script resolves its own target window from the address bar. Passing a
// window in is optional and only used when the caller already knows the exact
// one; refusing to run whenever several Chrome windows exist turned an ordinary
// desktop layout into a permanent silent skip.
export async function clearExtensionErrors(target = {}, { platform = process.platform, timeoutMs = 45000 } = {}) {
  if (platform !== 'win32') return { status: 'unavailable', reason: 'platform_unsupported', cleared: 0, dispatched: false, retryable: false };
  const processId = target?.processId;
  const windowHandle = target?.windowHandle;
  const hasProcess = processId !== undefined;
  const hasHandle = windowHandle !== undefined;
  // An explicit target is a promise about which window will be clicked, so a
  // malformed one is refused rather than silently widened to "any window".
  if (hasProcess && !(Number.isSafeInteger(processId) && processId > 0)) throw new Error('Exact process required');
  if (hasHandle && !(Number.isSafeInteger(windowHandle) && windowHandle > 0)) throw new Error('Exact window required');
  const executable = (process.env.PATH ?? '').split(delimiter).map(p => join(p.replace(/^"|"$/g, ''), 'pwsh.exe')).find(existsSync);
  if (!executable) return { status: 'unavailable', reason: 'powershell7_unavailable', cleared: 0, dispatched: false, retryable: false };
  const script = fileURLToPath(new URL('../scripts/clear-extension-errors.ps1', import.meta.url));
  const args = ['-NoProfile', '-NonInteractive', '-File', script];
  if (hasProcess) args.push('-ChromeProcessId', String(processId));
  if (hasHandle) args.push('-ChromeWindowHandle', String(windowHandle));
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    let timer;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const failed = (reason, retryable) => ({ status: 'failed', reason, cleared: 0, dispatched: false, retryable });
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    timer = setTimeout(() => { child.kill(); done(failed('clear_extension_errors_timeout', true)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 200000) { child.kill(); done(failed('clear_extension_errors_output_limit', false)); }
    });
    child.on('error', () => done(failed('clear_extension_errors_spawn_failed', true)));
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw Error();
        const value = JSON.parse(output);
        if (typeof value?.status !== 'string') throw Error();
        // The script is the only thing that saw the page, so its retryability
        // verdict travels unchanged; anything it did not decide is not retried.
        done({ ...value, retryable: value.retryable === true });
      } catch { done(failed('clear_extension_errors_invalid_result', false)); }
    });
  });
}

// What the caller is told about the error list, decided in one place so that
// "the reload succeeded" and "the red list is gone" can never be confused. The
// only two statuses that count as clean are the ones backed by a page read:
// cleared (the button was clicked and left the tree) and nothing_to_clear (the
// page was read and had no button). Anything else keeps cleared:false and has
// to carry a reason.
const CLEAN_STATUSES = new Set(['cleared', 'nothing_to_clear']);

export function describeErrorList(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.status !== 'string') {
    return {
      errorListCleared: false,
      errorList: { status: 'unavailable', cleared: false, reason: 'no_result_from_clear_step' },
      errorListClearStep: {
        reason: 'no_result_from_clear_step',
        howToRetry: 'The clear step produced no verdict, so the error list state is unknown. Call browser_extension_errors and read the page before reporting the panel as clean.'
      }
    };
  }
  const status = entry.status;
  const cleared = CLEAN_STATUSES.has(status);
  const errorList = { status, cleared };
  for (const key of ['reason', 'reloaded', 'reloadMethod', 'documentVisible', 'errorEntries', 'errorEntriesBefore', 'errorEntriesAfter', 'controlGone', 'settleMs', 'scanned', 'waitedMs', 'targetResolution', 'restoredFromMinimized', 'attempts', 'nextStep']) {
    if (entry[key] !== undefined) errorList[key] = entry[key];
  }
  if (cleared) return { errorListCleared: true, errorList };
  return {
    errorListCleared: false,
    errorList,
    errorListClearStep: {
      reason: entry.reason ?? status,
      howToRetry: typeof entry.nextStep === 'string'
        ? entry.nextStep
        : 'The error list was not read to a verdict. Call browser_extension_errors to put the page in front, then read it before reporting the panel as clean.'
    }
  };
}
