// The clipboard has two routes and the reply has to say which one answered,
// because "the clipboard is empty" and "this route may not read" look identical
// from the outside and call for opposite actions. These tests pin that, plus the
// two properties that make the tool safe to expose: a read is marked secret, and
// a write reports verified only when the text was read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeEnv() {
  const state = {
    hasDoc: false,
    created: 0,
    visibility: 'visible',
    hasFocus: true,
    offscreenRead: { ok: true, method: 'offscreen_clipboard_api', text: 'hunter2-copied' },
    offscreenWrite: { ok: true, method: 'offscreen_exec_command', copied: true, verified: true },
    messages: []
  };
  const chrome = {
    runtime: {
      sendMessage: async message => {
        state.messages.push(message);
        if (message.op === 'read') return state.offscreenRead;
        if (message.op === 'write') return state.offscreenWrite;
        return { ok: false, error: 'unexpected' };
      }
    },
    offscreen: {
      hasDocument: async () => state.hasDoc,
      createDocument: async () => { state.created += 1; state.hasDoc = true; }
    },
    windows: {
      update: async (windowId, details) => {
        state.windowUpdate = { windowId, details };
        // A restore that actually works is what makes the retry meaningful; the
        // test drives that through this flag rather than pretending.
        if (state.restoreMakesVisible) state.visibility = 'visible';
        return { id: windowId };
      }
    },
    tabs: {
      get: async id => ({ id, windowId: 9, url: 'https://example.com/' }),
      query: async () => [{ id: 5, windowId: 9, url: 'https://example.com/' }]
    }
  };
  return { chrome, state };
}

async function load({ withCdp = true, native = null } = {}) {
  const env = fakeEnv();
  globalThis.chrome = env.chrome;
  const { createClipboard } = await import(`../extension/clipboard.js?t=${Math.random()}`);
  const calls = [];
  const open = new Set();
  const sessions = {
    _open: open,
    activeSend(tabId) {
      if (!open.has(tabId)) return null;
      return async (method, params = {}) => {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expression = String(params.expression ?? '');
          // The visibility probe is answered first and separately: a hidden
          // document is what makes both clipboard APIs refuse, so it has to be
          // drivable from the test rather than inferred from an empty result.
          if (expression.includes('visibilityState')) {
            return { result: { value: JSON.stringify({ visibility: env.state.visibility, hasFocus: env.state.hasFocus }) } };
          }
          if (expression.includes('host.value')) return { result: { value: { text: 'pasted-from-system', length: 19 } } };
          if (expression.includes('__aibridgeClipProbe')) return { result: { value: { focused: true, tag: 'TEXTAREA' } } };
          if (expression.includes('execCommand')) return { result: { value: { copied: true } } };
          return { result: { value: {} } };
        }
        return {};
      };
    },
    async open({ tabId }) { open.add(tabId); return { status: 'success', reused: false }; }
  };
  const clipboard = createClipboard({
    sessions: withCdp ? sessions : { activeSend: () => null, open: async () => ({ status: 'failed', reason: 'no_debugger' }) },
    native
  });
  return { clipboard, env, calls, sessions };
}

// A stand-in for the native host route. It answers the two fixed PowerShell
// commands the clipboard module sends, in the same base64 shape the real host
// returns, so the encoding path is exercised rather than skipped.
function fakeNative({ clipboard = '', fail = null } = {}) {
  const calls = [];
  const state = { clipboard };
  const native = async (message, timeoutMs) => {
    calls.push({ message, timeoutMs });
    if (fail) return { ok: false, result: { status: 'unavailable', reason: fail, message: fail } };
    const script = String(message?.args?.args?.at(-1) ?? '');
    if (script.includes('Set-Clipboard')) {
      const match = script.match(/FromBase64String\('([^']*)'\)/);
      state.clipboard = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
      return { ok: true, result: { status: 'success', reply: { ok: true, status: 'success', stdout: '' } } };
    }
    const encoded = Buffer.from(state.clipboard, 'utf8').toString('base64');
    return { ok: true, result: { status: 'success', reply: { ok: true, status: 'success', stdout: `${encoded}\r\n` } } };
  };
  return { native, calls, state };
}

test('a read over the offscreen route is marked secret and names its route', async () => {
  const { clipboard, env } = await load();
  const result = await clipboard.run('browser_clipboard', {});
  assert.equal(result.status, 'success');
  assert.equal(result.method, 'offscreen');
  assert.equal(result.text, 'hunter2-copied');
  assert.equal(result.secrets, true, 'clipboard text is whatever the user last copied');
  assert.equal(result.contentTrust, 'untrusted system clipboard content');
  assert.equal(env.state.created, 1, 'the offscreen document must be created before it is messaged');
  assert.ok(result.warnings.some(line => /password/.test(line)));
  // The native route is tried first, so its refusal is recorded rather than hidden.
  assert.equal(result.attempts[0].method, 'native');
  assert.equal(result.attempts[0].ok, false);
});

test('the native route answers first because it is the only one that works in the background', async () => {
  const { native, calls } = fakeNative({ clipboard: 'from-the-os' });
  const { clipboard } = await load({ native });
  const result = await clipboard.run('browser_clipboard', {});
  assert.equal(result.status, 'success');
  assert.equal(result.method, 'native');
  assert.equal(result.text, 'from-the-os');
  assert.equal(result.secrets, true);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].message.args.args.at(-1)), /Get-Clipboard/);
});

test('a native write is verified by reading the operating system clipboard back', async () => {
  const { native, state } = fakeNative();
  const { clipboard } = await load({ native });
  const result = await clipboard.run('browser_clipboard_write', { text: 'quoted "text"\nand a newline' });
  assert.equal(result.status, 'success');
  assert.equal(result.method, 'native');
  assert.equal(result.verified, true, 'the read-back must agree, not just the write call');
  assert.equal(state.clipboard, 'quoted "text"\nand a newline', 'quoting and newlines must survive the trip');
  assert.match(result.note, /No page was touched/);
});

test('a native write whose read-back disagrees is not reported as verified', async () => {
  const native = async message => {
    const script = String(message?.args?.args?.at(-1) ?? '');
    if (script.includes('Set-Clipboard')) return { ok: true, result: { status: 'success', reply: { ok: true, status: 'success', stdout: '' } } };
    return { ok: true, result: { status: 'success', reply: { ok: true, status: 'success', stdout: Buffer.from('something else', 'utf8').toString('base64') } } };
  };
  const { clipboard } = await load({ native });
  const result = await clipboard.run('browser_clipboard_write', { text: 'what-i-wanted' });
  assert.equal(result.status, 'success');
  assert.equal(result.verified, false);
});

test('strategy:"native" reports the host as unavailable instead of falling back silently', async () => {
  const { native } = fakeNative({ fail: 'native_host_not_registered' });
  const { clipboard, calls } = await load({ native });
  const result = await clipboard.run('browser_clipboard', { strategy: 'native' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'native_clipboard_unavailable');
  assert.match(result.message, /browser_native_host_install/);
  assert.equal(calls.length, 0, 'a refused native route must not borrow a tab');
});

test('an empty clipboard is a reading, not a failure', async () => {
  const { clipboard, env } = await load();
  env.state.offscreenRead = { ok: true, method: 'offscreen_clipboard_api', text: '' };
  const result = await clipboard.run('browser_clipboard', {});
  assert.equal(result.status, 'success');
  assert.equal(result.empty, true);
  assert.ok(result.warnings.some(line => /empty/.test(line)));
});

test('a refused offscreen read falls through to the tab route instead of reporting an empty clipboard', async () => {
  const { clipboard, env } = await load();
  // Measured behaviour on Chrome 156: an offscreen document can never read,
  // because readText() is gated on document focus.
  env.state.offscreenRead = { ok: false, method: 'offscreen_clipboard_api', error: 'Failed to execute \'readText\' on \'Clipboard\': Document is not focused.', name: 'NotAllowedError' };
  const result = await clipboard.run('browser_clipboard', {});
  assert.equal(result.status, 'success');
  assert.equal(result.method, 'cdp');
  assert.equal(result.text, 'pasted-from-system');
  assert.ok(result.warnings.some(line => /paste handlers/.test(line)), 'the CDP route must admit the page saw the content');
  assert.equal(result.attempts.at(-1).method, 'cdp');
});

test('a hidden document is refused rather than reported as an empty clipboard', async () => {
  const { clipboard, env } = await load();
  env.state.offscreenRead = { ok: false, method: 'offscreen_clipboard_api', error: 'Document is not focused.' };
  env.state.visibility = 'hidden';
  const result = await clipboard.run('browser_clipboard', {});
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'clipboard_needs_visible_document');
  assert.equal(result.dispatched, false);
  // Not retryable: the service retries a waiting result automatically, and an
  // identical retry cannot succeed until the caller changes something.
  assert.equal(result.retryable, false);
  assert.deepEqual(result.retryWith, { allowFocus: true });
  assert.equal(result.visibility, 'hidden');
  assert.equal(result.hasFocus, true, 'a covered window still reports focus, which is why visibility is the signal');
  assert.equal(result.empty, undefined, 'an unreadable clipboard must not be reported as empty');
});

test('allowFocus restores the window and reports that it did', async () => {
  const { clipboard, env } = await load();
  env.state.offscreenRead = { ok: false, method: 'offscreen_clipboard_api', error: 'Document is not focused.' };
  env.state.visibility = 'hidden';
  env.state.restoreMakesVisible = true;
  const result = await clipboard.run('browser_clipboard', { allowFocus: true });
  assert.equal(result.status, 'success');
  assert.equal(result.foregroundTaken, true);
  assert.deepEqual(env.state.windowUpdate, { windowId: 9, details: { focused: true, state: 'normal' } });
});

test('allowFocus that does not make the document visible still refuses', async () => {
  const { clipboard, env } = await load();
  env.state.offscreenRead = { ok: false, method: 'offscreen_clipboard_api', error: 'Document is not focused.' };
  env.state.visibility = 'hidden';
  env.state.restoreMakesVisible = false;
  const result = await clipboard.run('browser_clipboard', { allowFocus: true });
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'clipboard_needs_visible_document');
  // The distinction the whole tool turns on: asked is not got.
  assert.equal(result.foregroundRequested, true);
  assert.equal(result.foregroundTaken, false);
  assert.match(result.message, /raise did not take/);
  assert.equal(result.retryWith, undefined, 'a raise that already failed must not invite the same retry');
});

test('a hidden document blocks the cdp write too, and the offscreen write still succeeds', async () => {
  const { clipboard, env } = await load();
  env.state.visibility = 'hidden';
  const offscreen = await clipboard.run('browser_clipboard_write', { text: 'x' });
  assert.equal(offscreen.status, 'success');
  assert.equal(offscreen.method, 'offscreen');
  const cdp = await clipboard.run('browser_clipboard_write', { text: 'x', strategy: 'cdp' });
  assert.equal(cdp.status, 'waiting');
  assert.equal(cdp.reason, 'clipboard_needs_visible_document');
});

test('strategy:"offscreen" refuses rather than silently switching routes', async () => {
  const { clipboard, env, calls } = await load();
  env.state.offscreenRead = { ok: false, method: 'offscreen_clipboard_api', error: 'not allowed' };
  const result = await clipboard.run('browser_clipboard', { strategy: 'offscreen' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'clipboard_read_route_refused');
  assert.equal(calls.length, 0, 'a refused strategy must not touch a tab');
});

test('a read that no route can serve says so and lists what was tried', async () => {
  const { clipboard, env } = await load({ withCdp: false });
  env.state.offscreenRead = { ok: false, method: 'offscreen_clipboard_api', error: 'not allowed' };
  const result = await clipboard.run('browser_clipboard', {});
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'clipboard_read_unavailable');
  assert.equal(result.attempts.length, 3);
});

test('a write reports verified only when the text was read back', async () => {
  const { clipboard } = await load();
  const result = await clipboard.run('browser_clipboard_write', { text: 'replace-me' });
  assert.equal(result.status, 'success');
  assert.equal(result.method, 'offscreen');
  assert.equal(result.verified, true);
  assert.match(result.note, /provably/);
});

test('a write that could not be read back is reported as dispatched, not proven', async () => {
  const { clipboard, env } = await load();
  env.state.offscreenWrite = { ok: true, method: 'offscreen_exec_command', copied: true, verified: false };
  const result = await clipboard.run('browser_clipboard_write', { text: 'replace-me' });
  assert.equal(result.status, 'success');
  assert.equal(result.verified, false);
  assert.match(result.note, /unproven/);
  assert.match(result.note, /covered browser window/, 'the measurement behind the warning must be named');
});

test('an oversized write is refused before anything is dispatched', async () => {
  const { clipboard, env } = await load();
  const result = await clipboard.run('browser_clipboard_write', { text: 'x'.repeat(1000001) });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'text_too_long');
  assert.equal(env.state.messages.length, 0);
});

test('the module only owns the two clipboard tools', async () => {
  const { clipboard } = await load();
  assert.deepEqual([...clipboard.names].sort(), ['browser_clipboard', 'browser_clipboard_write']);
  assert.equal(await clipboard.run('browser_read', {}), null);
});
