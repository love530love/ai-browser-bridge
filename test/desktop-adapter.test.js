import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDesktopAdapter, BRIDGE_EXTENSION_ID, RELOAD_EXTENSION_CONFIRMATION } from '../src/desktop-adapter.js';

const successful = (stdout = '') => ({ spawned: true, timedOut: false, code: 0, stdout, stderr: '' });

test('reload script rejects non-Chrome process targets and binds fallback to exact details evidence', () => {
  const script = readFileSync(new URL('../scripts/reload-extension.ps1', import.meta.url), 'utf8');
  assert.match(script, /\$targetProcess\.ProcessName -ne 'chrome'/);
  assert.match(script, /GetFileName\(\$targetProcess\.Path\) -ine 'chrome\.exe'/);
  assert.match(script, /\$targetUrl = "chrome:\/\/extensions\/\?id=\$ExtensionId"/);
  assert.match(script, /\$visibleIds\.Count -eq 1/);
  assert.match(script, /AutomationId -eq 'dev-reload-button'/);
});

test('desktop adapter exposes fixed actions only on Windows', async () => {
  let runs = 0;
  const adapter = createDesktopAdapter({ platform: 'linux', runScript: async () => { runs++; return successful(); } });
  assert.equal(adapter.available, false);
  assert.deepEqual(await adapter.listChromeWindows(), { status: 'unavailable', retryable: false, reason: 'desktop_adapter_unavailable', dispatched: false });
  assert.deepEqual(await adapter.reloadExtension({ confirmation: RELOAD_EXTENSION_CONFIRMATION, windowHandle: 123 }), { status: 'unavailable', retryable: false, reason: 'desktop_adapter_unavailable', dispatched: false });
  assert.equal(runs, 0);
});

test('window listing parses bounded JSON and keeps only valid Chrome targets', async () => {
  const output = JSON.stringify([
    { ProcessId: 101, WindowHandle: 9001, Title: 'Bridge - Chrome' },
    { ProcessId: -1, WindowHandle: 9002, Title: 'invalid pid' },
    { ProcessId: 102, WindowHandle: 0, Title: 'invalid hwnd' },
  ]);
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async (_path, args, timeoutMs) => {
    assert.deepEqual(args, ['-ListWindows', '-AsJson']);
    assert.equal(timeoutMs, 15000);
    return successful(output);
  } });
  assert.deepEqual(await adapter.listChromeWindows(), {
    status: 'success', dispatched: false, retryable: false,
    windows: [{ processId: 101, windowHandle: 9001, title: 'Bridge - Chrome' }]
  });
});

test('reload requires exact single-action confirmation and a current numeric window handle', async () => {
  let runs = 0;
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async () => { runs++; return successful(); } });
  assert.equal((await adapter.reloadExtension({ windowHandle: 123 })).reason, 'explicit_confirmation_required');
  assert.equal((await adapter.reloadExtension({ confirmation: RELOAD_EXTENSION_CONFIRMATION, windowHandle: 0 })).reason, 'invalid_chrome_window_target');
  assert.equal((await adapter.reloadExtension({ confirmation: RELOAD_EXTENSION_CONFIRMATION, windowHandle: Number.MAX_SAFE_INTEGER + 1 })).reason, 'invalid_chrome_window_target');
  assert.equal((await adapter.reloadExtension({ confirmation: RELOAD_EXTENSION_CONFIRMATION, windowHandle: 123, processId: -1 })).reason, 'invalid_chrome_window_target');
  assert.equal(runs, 0);
});

test('reload uses fixed script arguments and maps verified, not-dispatched and uncertain outcomes', async () => {
  const cases = [
    { result: { spawned: true, code: 0, timedOut: false }, status: 'success', dispatched: true },
    { result: { spawned: true, code: 2, timedOut: false }, status: 'not_dispatched', dispatched: false },
    { result: { spawned: true, code: 3, timedOut: false }, status: 'uncertain', dispatched: null },
    { result: { spawned: true, code: 1, timedOut: false }, status: 'uncertain', dispatched: null },
    { result: { spawned: true, code: null, timedOut: true }, status: 'uncertain', dispatched: null },
    { result: { spawned: false, code: null, timedOut: false, error: 'spawn failure' }, status: 'unavailable', dispatched: false },
  ];
  for (const scenario of cases) {
    let actual;
    const adapter = createDesktopAdapter({ platform: 'win32', expectedVersion: '0.5.21', runScript: async (scriptPath, args, timeoutMs) => {
      actual = { scriptPath, args, timeoutMs };
      return scenario.result;
    } });
    const result = await adapter.reloadExtension({ confirmation: RELOAD_EXTENSION_CONFIRMATION, windowHandle: 12345, processId: 456 });
    assert.equal(result.status, scenario.status);
    assert.equal(result.dispatched, scenario.dispatched);
    assert.equal(actual.args[0], '-ExtensionId');
    assert.equal(actual.args[1], BRIDGE_EXTENSION_ID);
    assert.deepEqual(actual.args.slice(2), ['-ChromeWindowHandle', '12345', '-BestEffort', '-ChromeProcessId', '456']);
    assert.equal(actual.timeoutMs, 45000);
    assert.ok(actual.scriptPath.endsWith('scripts\\reload-extension.ps1'));
    if (scenario.status === 'success') assert.equal(result.expectedVersion, '0.5.21');
  }
});

test('malformed window-probe output fails closed', async () => {
  const adapter = createDesktopAdapter({ platform: 'win32', runScript: async () => successful('not-json') });
  const result = await adapter.listChromeWindows();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'desktop_window_probe_invalid_result');
  assert.equal(result.dispatched, false);
});
