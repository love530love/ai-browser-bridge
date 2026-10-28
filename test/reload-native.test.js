// The extension can reload itself. That path must be provable, because it is the
// difference between "reload needs the foreground" and "reload works while the
// browser is in the background".
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';
import { VERSION } from '../src/version.js';

const config = { port: 0, agentToken: 'a'.repeat(64), extensionToken: 'b'.repeat(64) };
const CONFIRM = { confirmation: 'reload_extension_once' };

async function setup(t, options = {}) {
  const b = createBridge(config, { leaseStateFile: null, agentPolicyFile: null, audit: () => {}, ...options });
  const address = await b.listen();
  t.after(() => b.close());
  return { b, wsUrl: `ws://127.0.0.1:${address.port}/extension` };
}

function connect(wsUrl, { version = VERSION, onCommand } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin: `chrome-extension://${'a'.repeat(32)}` });
    ws.once('error', reject);
    ws.once('open', () => {
      const ready = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'hello', token: config.extensionToken, version }));
      ready.then(([raw]) => {
        if (JSON.parse(raw.toString()).type !== 'ready') return reject(new Error('expected ready'));
        if (onCommand) {
          ws.on('message', message => {
            const parsed = JSON.parse(message.toString());
            if (parsed.type === 'command') onCommand(parsed, ws);
          });
        }
        resolve(ws);
      }).catch(reject);
    });
  });
}

// A desktop adapter that fails loudly if it is used, so a test that expects the
// native path cannot pass by silently falling back to UI Automation.
function forbiddenAdapter() {
  return {
    available: true,
    implementedActions: ['reload_extension'],
    listChromeWindows: async () => { throw new Error('desktop path must not be used for a connected extension'); },
    reloadExtension: async () => { throw new Error('desktop path must not be used for a connected extension'); }
  };
}

test('a connected extension reloads itself, with no window and no keystroke', async t => {
  const { b, wsUrl } = await setup(t, { desktopAdapter: forbiddenAdapter() });
  const first = await connect(wsUrl, {
    onCommand: (command, ws) => {
      // The worker replies, then the extension is torn down and dials back in.
      ws.send(JSON.stringify({ type: 'result', id: command.id, result: { status: 'success', method: 'chrome.runtime.reload', dispatched: true, verified: false } }));
      setTimeout(() => ws.close(), 30);
    }
  });
  const previousSession = b.status().extensionSessionId;
  const reconnected = once(first, 'close').then(() => new Promise(resolve => setTimeout(() => connect(wsUrl).then(resolve), 60)));

  const result = await b.call('browser_reload_extension', CONFIRM);
  await reconnected;

  assert.equal(result.status, 'success');
  assert.equal(result.verified, true, 'a dispatch reply alone must not count as verified');
  assert.equal(result.method, 'chrome.runtime.reload');
  assert.equal(result.focusRequired, false);
  assert.equal(result.previousSessionId, previousSession);
  assert.notEqual(result.extensionSessionId, previousSession, 'verification must be a new session, not the old one');
});

test('an extension that cannot reload itself offers the desktop path instead of taking it', async t => {
  let desktopCalls = 0;
  const { b, wsUrl } = await setup(t, {
    desktopAdapter: {
      available: true,
      implementedActions: ['reload_extension'],
      listChromeWindows: async () => ({ status: 'success', windows: [{ processId: 11, windowHandle: 12, title: 'Chrome' }] }),
      reloadExtension: async () => { desktopCalls++; return { status: 'success', retryable: false, reason: 'extension_reload_verified', dispatched: true, verified: true }; }
    }
  });
  await connect(wsUrl, {
    // An older worker answers without the self-reload marker.
    onCommand: (command, ws) => ws.send(JSON.stringify({ type: 'result', id: command.id, result: { status: 'success', reloaded: true } }))
  });

  // The remaining path calls SetForegroundWindow, so it must not run on the
  // caller's behalf: refusing costs one more call, interrupting the user is
  // irreversible.
  const refused = await b.call('browser_reload_extension', CONFIRM);
  assert.equal(desktopCalls, 0, 'nothing may be dispatched without allowFocus');
  assert.equal(refused.reason, 'focus_required_for_ui_automation');
  assert.equal(refused.foregroundTaken, false);
  assert.equal(refused.focusRequired, true);
  assert.equal(refused.retryWith.arguments.allowFocus, true);

  const result = await b.call('browser_reload_extension', { ...CONFIRM, allowFocus: true });
  assert.equal(desktopCalls, 1, 'the fallback must actually run once it is allowed');
  assert.equal(result.method, 'windows_ui_automation');
  assert.equal(result.focusRequired, true, 'the fallback must admit it needs the foreground');
  assert.equal(result.foregroundTaken, true);
  assert.equal(result.fallbackReason, 'extension_did_not_self_reload');
});

test('with no extension connected the desktop path is offered, not taken', async t => {
  let desktopCalls = 0;
  const { b } = await setup(t, {
    desktopAdapter: {
      available: true,
      implementedActions: ['reload_extension'],
      listChromeWindows: async () => ({ status: 'success', windows: [{ processId: 11, windowHandle: 12, title: 'Chrome' }] }),
      reloadExtension: async () => { desktopCalls++; return { status: 'success', retryable: false, reason: 'extension_reload_verified', dispatched: true, verified: true }; }
    }
  });
  const refused = await b.call('browser_reload_extension', CONFIRM);
  assert.equal(desktopCalls, 0);
  assert.equal(refused.status, 'waiting');
  assert.equal(refused.reason, 'focus_required_for_ui_automation');
  assert.equal(refused.dispatched, false);
  assert.match(refused.howToResume, /chrome:\/\/extensions/);

  const result = await b.call('browser_reload_extension', { ...CONFIRM, allowFocus: true });
  assert.equal(desktopCalls, 1);
  assert.equal(result.method, 'windows_ui_automation');
  assert.equal(result.focusRequired, true);
  assert.equal(result.verified, true);
});

test('reloading during an in-flight command waits instead of killing its reply', async t => {
  const { b, wsUrl } = await setup(t, { desktopAdapter: forbiddenAdapter() });
  // This extension accepts the command and never answers, so the service keeps
  // it as the active job - exactly the state a reload must not interrupt.
  await connect(wsUrl, { onCommand: () => {} });
  const pending = b.call('browser_read', { tabId: 1 }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 120));
  const result = await b.call('browser_reload_extension', CONFIRM);
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'service_busy');
  assert.equal(result.dispatched, false);
  await pending;
});

test('a reload that is never observed is uncertain, not success', async t => {
  const { b, wsUrl } = await setup(t, { desktopAdapter: forbiddenAdapter(), reloadVerifyTimeoutMs: 700 });
  await connect(wsUrl, {
    // Replies as if it reloaded, but never comes back with a new session.
    onCommand: (command, ws) => ws.send(JSON.stringify({ type: 'result', id: command.id, result: { status: 'success', method: 'chrome.runtime.reload', dispatched: true } }))
  });
  const result = await b.call('browser_reload_extension', CONFIRM);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'extension_reload_not_observed');
  assert.equal(result.verified, false);
  assert.equal(result.dispatched, true, 'it was dispatched; that is exactly why it cannot be called success');
});

test('window enumeration never offers a titleless popup as a Chrome window', () => {
  // An open Chrome menu can be its own top-level window owned by chrome.exe and
  // carrying no title. Listing it as "a Chrome window" is how a caller binds a
  // ref inside a popup that disappears the moment the menu closes. Measured
  // live: with the app menu open, enumeration returned the real window plus a
  // second titleless handle.
  const source = readFileSync(new URL('../scripts/reload-extension.ps1', import.meta.url), 'utf8');
  assert.match(source, /IsWindowVisible\(hWnd\) && WindowTitle\(hWnd\)\.Length > 0/);
});
