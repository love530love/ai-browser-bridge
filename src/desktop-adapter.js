import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { VERSION } from './version.js';
import { nativeUiSnapshot } from './native-ui-snapshot.js';
import { nativeUiAction } from './native-ui-action.js';

export const RELOAD_EXTENSION_CONFIRMATION = 'reload_extension_once';
export const BRIDGE_EXTENSION_ID = 'mmopbppoabmhliflinadkgnedjpmbgig';
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/reload-extension.ps1', import.meta.url));
const DEVTOOLS_SCRIPT = fileURLToPath(new URL('../scripts/devtools-ui.ps1', import.meta.url));
const LAUNCH_SCRIPT = fileURLToPath(new URL('../scripts/launch-chrome.ps1', import.meta.url));
const POWERSHELL_EXE = (process.env.PATH ?? '').split(delimiter)
  .map(directory => join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
  .find(candidate => existsSync(candidate)) ?? 'pwsh.exe';
const OUTPUT_LIMIT = 32768;

function appendBounded(current, chunk) {
  const next = current + chunk.toString('utf8');
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

function runPowerShell(scriptPath, args, timeoutMs) {
  return new Promise(resolve => {
    let spawned = false;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let timeout = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ spawned, timedOut, stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish({ code: null, error: error.message });
      return;
    }
    child.once('spawn', () => { spawned = true; });
    child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    child.once('error', error => finish({ code: null, error: error.message }));
    child.once('close', (code, signal) => finish({ code, signal }));
    timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* Outcome remains unknown; close/error settles it. */ }
    }, timeoutMs);
    timeout.unref?.();
  });
}

function unavailable(reason = 'desktop_adapter_unavailable') {
  return { status: 'unavailable', retryable: false, reason, dispatched: false };
}

function mapReloadResult(result, expectedVersion) {
  if (!result.spawned && result.error) return {
    status: 'unavailable', retryable: false, reason: 'desktop_process_unavailable', dispatched: false,
    message: 'The fixed PowerShell UI adapter could not be started; no Chrome action was dispatched.'
  };
  if (result.timedOut) return {
    status: 'uncertain', retryable: false, reason: 'desktop_action_timeout', dispatched: null,
    message: 'The UI adapter timed out. Inspect the extension connection and version before any further action.'
  };
  if (result.code === 0) return {
    status: 'success', retryable: false, reason: 'extension_reload_verified', dispatched: true,
    verified: true, extensionId: BRIDGE_EXTENSION_ID, expectedVersion,
    // The UI Automation path opens a temporary chrome://extensions tab so the
    // user's own tab is never navigated away. Whether it managed to close that
    // tab again is real information for the caller, and it is only knowable from
    // the script's own output.
    temporaryTabClosed: /Closed the temporary chrome:\/\/extensions tab/.test(result.stdout ?? '')
  };
  if (result.code === 2) return {
    status: 'not_dispatched', retryable: false, reason: 'desktop_target_not_unique_or_unavailable', dispatched: false,
    message: 'No unique target window and Reload control were verified; no Reload was invoked.'
  };
  return {
    status: 'uncertain', retryable: false, reason: result.code === 3 ? 'extension_reload_unverified' : 'desktop_process_result_unknown',
    dispatched: null,
    message: 'The Reload may have been invoked, but a new extension connection with the expected version was not verified. Inspect extension session/version before deciding whether to act again.'
  };
}

export function createDesktopAdapter({
  platform = process.platform,
  scriptPath = SCRIPT_PATH,
  expectedVersion = VERSION,
  timeoutMs = 45000,
  runScript = runPowerShell,
  launchScriptPath = LAUNCH_SCRIPT
} = {}) {
  const available = platform === 'win32';
  const run = (args, limit = timeoutMs) => runScript(scriptPath, args, limit);

  // Launching is only for the case where no browser exists. The script refuses
  // when any chrome process is alive, so this can never create a competing
  // instance or a second profile. It also passes no profile flags, and picks the
  // binary whose user-data directory actually holds a used profile, which is
  // what keeps the user's cookies and logins intact.
  //
  // activate defaults to false: the new window is created with
  // SW_SHOWNOACTIVATE so a background task cannot pull the screen out from under
  // someone who is working in another window. dryRun answers "which browser and
  // which profile would this use" without starting anything.
  async function launchChrome({ url, activate = false, dryRun = false, loadExtension = null,
    exePath = null, userDataDir = null, profileDirectory = null } = {}) {
    if (!available) return unavailable();
    if (url !== undefined && url !== '' && !/^https?:\/\//i.test(String(url))) {
      return { status: 'denied', retryable: false, reason: 'unsupported_url_scheme', dispatched: false,
        message: 'Only http(s) URLs can be opened at launch; nothing was launched.' };
    }
    const args = ['-AsJson'];
    if (url) args.push('-Url', String(url));
    if (activate) args.push('-Activate');
    if (dryRun) args.push('-DryRun');
    // Only ever this project's own extension directory; the caller cannot name a
    // path of its own.
    if (loadExtension) args.push('-LoadExtension', String(loadExtension));
    // A recorded target is used verbatim. Nothing here decides which browser the
    // user means; that decision was made once, by the person who knows.
    if (exePath) args.push('-ExePath', String(exePath));
    if (userDataDir) args.push('-UserDataDir', String(userDataDir));
    if (profileDirectory) args.push('-ProfileDirectory', String(profileDirectory));
    let result;
    try { result = await runScript(launchScriptPath, args, 45000); }
    catch { return { status: 'uncertain', retryable: false, reason: 'desktop_process_result_unknown', dispatched: null,
      message: 'The launcher failed after spawn may have started. Inspect whether Chrome is running before calling again.' }; }
    if (!result.spawned && result.error) return unavailable('desktop_process_unavailable');
    if (result.timedOut) {
      return { status: 'uncertain', retryable: false, reason: 'desktop_action_timeout', dispatched: null,
        message: 'The launcher timed out. Check whether Chrome started before calling again; a second launch opens another window.' };
    }
    try {
      const value = JSON.parse(result.stdout.trim());
      // Never infer success from process exit alone: the script's own verdict is
      // the only thing that counts, and an unrecognised shape is a failure.
      if (value && ['success', 'not_dispatched', 'uncertain', 'denied', 'failed'].includes(value.status) &&
          typeof value.dispatched === 'boolean') {
        return { retryable: value.status === 'not_dispatched' ? true : false, ...value };
      }
    } catch { /* fall through */ }
    // The launcher's own words are the only way to tell "the script refused" from
    // "the script crashed", and swallowing them made a runtime error look like an
    // invalid result.
    const stderrTail = String(result.stderr ?? '').trim().slice(-400);
    return { status: 'failed', retryable: true, reason: 'chrome_launch_result_invalid', dispatched: false,
      ...(stderrTail ? { stderr: stderrTail } : {}), stdout: String(result.stdout ?? '').trim().slice(-300) };
  }

  async function listChromeWindows() {
    if (!available) return unavailable();
    let result;
    try { result = await run(['-ListWindows', '-AsJson'], 15000); }
    catch { return { status: 'failed', retryable: true, reason: 'desktop_window_probe_failed', dispatched: false }; }
    if (!result.spawned && result.error) return unavailable('desktop_process_unavailable');
    if (result.timedOut) return { status: 'failed', retryable: true, reason: 'desktop_window_probe_timeout', dispatched: false };
    if (result.code !== 0) return { status: 'failed', retryable: true, reason: 'desktop_window_probe_failed', dispatched: false };
    try {
      const value = JSON.parse(result.stdout.trim() || '[]');
      const rows = Array.isArray(value) ? value : [value];
      const windows = rows.filter(item => item && Number.isSafeInteger(item.ProcessId) && item.ProcessId > 0 &&
        Number.isSafeInteger(item.WindowHandle) && item.WindowHandle > 0)
        .slice(0, 32)
        .map(item => ({ processId: item.ProcessId, windowHandle: item.WindowHandle, title: String(item.Title ?? '').slice(0, 300) }));
      return { status: 'success', windows, dispatched: false, retryable: false };
    } catch {
      return { status: 'failed', retryable: true, reason: 'desktop_window_probe_invalid_result', dispatched: false };
    }
  }

  async function reloadExtension({ confirmation, windowHandle, processId } = {}) {
    if (!available) return unavailable();
    if (confirmation !== RELOAD_EXTENSION_CONFIRMATION) {
      return { status: 'denied', retryable: false, reason: 'explicit_confirmation_required', dispatched: false };
    }
    if (!Number.isSafeInteger(windowHandle) || windowHandle <= 0 ||
        (processId !== undefined && (!Number.isSafeInteger(processId) || processId <= 0))) {
      return { status: 'denied', retryable: false, reason: 'invalid_chrome_window_target', dispatched: false };
    }
    const args = ['-ExtensionId', BRIDGE_EXTENSION_ID, '-ChromeWindowHandle', String(windowHandle), '-BestEffort'];
    if (processId !== undefined) args.push('-ChromeProcessId', String(processId));
    let result;
    try { result = await run(args); }
    catch {
      return { status: 'uncertain', retryable: false, reason: 'desktop_process_result_unknown', dispatched: null,
        message: 'The UI adapter failed after launch may have started. Inspect extension state before any retry.' };
    }
    return mapReloadResult(result, expectedVersion);
  }

  async function devtools({ action = 'observe', windowHandle, processId, expectedUrl, panel } = {}) {
    if (!available) return unavailable();
    if (!['observe', 'select_panel'].includes(action) || !Number.isSafeInteger(windowHandle) || windowHandle <= 0 ||
        !Number.isSafeInteger(processId) || processId <= 0 || (action === 'select_panel' && !expectedUrl) ||
        (action === 'select_panel' && (typeof panel !== 'string' || !panel.trim() || panel.length > 200))) {
      return { status: 'not_dispatched', reason: 'invalid_devtools_target', dispatched: false, retryable: false };
    }
    const args = ['-ChromeProcessId', String(processId), '-ChromeWindowHandle', String(windowHandle), '-Action', action];
    if (expectedUrl) args.push('-ExpectedUrl', expectedUrl);
    if (panel) args.push('-Panel', panel);
    let result;
    try { result = await runScript(DEVTOOLS_SCRIPT, args, 30000); }
    catch { result = { spawned: true, code: null }; }
    if (result.code === 0 && !result.timedOut) {
      try {
        const value = JSON.parse(result.stdout);
        if (['success', 'not_dispatched', 'uncertain'].includes(value.status) && typeof value.dispatched === 'boolean' &&
            (value.status !== 'success' || (value.verified === true && value.evidence &&
              (action === 'observe' || (value.evidence.devtoolsOpen === true && value.evidence.url === expectedUrl &&
                (action !== 'select_panel' || value.evidence.selectedPanels?.includes(panel))))))) return value;
      } catch { /* Never infer success from process exit alone. */ }
    }
    return { status: action !== 'observe' && result.spawned ? 'uncertain' : 'failed',
      reason: 'devtools_result_unverified', dispatched: action !== 'observe' && result.spawned ? null : false, retryable: false };
  }
  const implementedActions = available
    ? ['reload_extension', 'launch_chrome', 'observe_devtools', 'select_devtools_panel',
      'expand_native_control', 'collapse_native_control']
    : [];
  return { available, implementedActions, listChromeWindows, reloadExtension, launchChrome, devtools,
    nativeSnapshot: target => nativeUiSnapshot(target, { platform }),
    // The service passes one flat argument object, so the target fields and the
    // action fields arrive together; split them here rather than making every
    // caller reshape the same object.
    nativeAction: args => nativeUiAction(args, { ref: args.ref, action: args.action, expect: args.expect, platform }) };
}
