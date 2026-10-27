// Launching is the one capability that creates a browser process, so its
// refusals matter more than its successes: a second instance means a second
// profile, and a second profile means the user's logins are gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopAdapter } from '../src/desktop-adapter.js';

const json = value => ({ spawned: true, code: 0, timedOut: false, stdout: JSON.stringify(value), stderr: '' });

function adapter(scriptResult, { platform = 'win32' } = {}) {
  const calls = [];
  const instance = createDesktopAdapter({
    platform,
    launchScriptPath: '/fixture/launch-chrome.ps1',
    runScript: async (scriptPath, args, timeoutMs) => { calls.push({ scriptPath, args, timeoutMs }); return typeof scriptResult === 'function' ? scriptResult() : scriptResult; }
  });
  return { instance, calls };
}

test('an already running Chrome is reported as not dispatched, with the window count', async () => {
  const { instance } = adapter(json({
    status: 'not_dispatched', reason: 'chrome_already_running', dispatched: false,
    processCount: 7, visibleWindowCount: 2, windows: [{ ProcessId: 11, WindowHandle: 12 }]
  }));
  const result = await instance.launchChrome({ url: 'https://example.test/' });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason, 'chrome_already_running');
  assert.equal(result.dispatched, false);
  assert.equal(result.processCount, 7);
  // Not a hard failure: the caller should reuse what is already there.
  assert.equal(result.retryable, true);
});

test('a successful launch reports the process, the window and the fact that no profile flags were used', async () => {
  const { instance, calls } = adapter(json({
    status: 'success', reason: 'chrome_launched', dispatched: true, verified: true,
    processId: 4242, windowHandle: 5150, chromePath: 'C:\\Chrome\\chrome.exe',
    argumentList: ['https://example.test/'], profileFlags: 'none'
  }));
  const result = await instance.launchChrome({ url: 'https://example.test/' });
  assert.equal(result.status, 'success');
  assert.equal(result.verified, true);
  assert.equal(result.processId, 4242);
  assert.equal(result.windowHandle, 5150);
  assert.equal(result.profileFlags, 'none');
  // The script is asked for JSON and given only the URL: no profile flags can be
  // smuggled in from the Node side either.
  assert.deepEqual(calls[0].args, ['-AsJson', '-Url', 'https://example.test/']);
});

test('a non-http url never reaches the launcher', async () => {
  const { instance, calls } = adapter(json({ status: 'success', dispatched: true }));
  for (const url of ['file:///C:/secret.txt', 'chrome://settings', 'javascript:alert(1)', 'ftp://x/']) {
    const result = await instance.launchChrome({ url });
    assert.equal(result.status, 'denied', url);
    assert.equal(result.reason, 'unsupported_url_scheme', url);
    assert.equal(result.dispatched, false, url);
  }
  assert.equal(calls.length, 0, 'nothing should have been spawned');
});

test('a launch that produced no visible window is uncertain, never success', async () => {
  const { instance } = adapter(json({
    status: 'uncertain', reason: 'chrome_launched_without_visible_window', dispatched: true,
    verified: false, processId: 99, profileFlags: 'none'
  }));
  const result = await instance.launchChrome({});
  assert.equal(result.status, 'uncertain');
  assert.equal(result.verified, false);
  assert.equal(result.dispatched, true);
});

test('a timeout is uncertain because a process may already exist', async () => {
  const { instance } = adapter({ spawned: true, code: null, timedOut: true, stdout: '', stderr: '' });
  const result = await instance.launchChrome({});
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'desktop_action_timeout');
  assert.equal(result.dispatched, null, 'a timed-out launch has an unknown outcome, not a false one');
});

test('unparseable output is a failure rather than a guess', async () => {
  const { instance } = adapter({ spawned: true, code: 0, timedOut: false, stdout: 'not json', stderr: '' });
  const result = await instance.launchChrome({});
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'chrome_launch_result_invalid');
  assert.equal(result.dispatched, false);
});

test('an unrecognised status shape is not treated as success', async () => {
  const { instance } = adapter(json({ status: 'ok', dispatched: true }));
  const result = await instance.launchChrome({});
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'chrome_launch_result_invalid');
});

test('the launcher is Windows-only and says so on other platforms', async () => {
  const { instance, calls } = adapter(json({ status: 'success', dispatched: true }), { platform: 'linux' });
  const result = await instance.launchChrome({});
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'desktop_adapter_unavailable');
  assert.equal(calls.length, 0);
});
