// Virtual authenticators, PWA installation and unpacked extension loading are
// the three CDP surfaces that change what the existing browser will accept.
// The replies must say exactly which part was observed: Chrome accepting a
// command is not proof that the authenticator, install or extension exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeEnv() {
  const sent = [];
  const handlers = {};
  const chrome = {
    runtime: { id: 'bridge', getManifest: () => ({ version: '0.0.0' }) },
    debugger: {
      onEvent: { addListener() {}, removeListener() {} },
      sendCommand: async (target, method, params = {}) => {
        sent.push({ tabId: target.tabId, method, params });
        return handlers[method]?.(params) ?? {};
      }
    }
  };
  return { chrome, sent, handlers };
}

async function load() {
  const env = fakeEnv();
  globalThis.chrome = env.chrome;
  delete globalThis.__bridgeFetchListenerInstalled;
  delete globalThis.__bridgeDialogListenerInstalled;
  const { createCdpAdvanced } = await import(`../extension/cdp-advanced.js?t=${Math.random()}`);
  const opened = [];
  const sessions = {
    _open: new Set(),
    activeSend(tabId) {
      if (!sessions._open.has(tabId)) return null;
      return (method, params = {}) => env.chrome.debugger.sendCommand({ tabId }, method, params);
    },
    async open({ tabId }) { opened.push(tabId); sessions._open.add(tabId); return { status: 'success', reused: false }; },
    async close({ tabId }) { sessions._open.delete(tabId); return { status: 'success' }; }
  };
  const advanced = createCdpAdvanced({ sessions });
  return { advanced, env, sessions, opened };
}

const tab = { id: 5, url: 'https://app.example.com/checkout' };
const ctx = (extra = {}) => ({ tab, page: async () => ({ x: 10, y: 20 }), guarded: fn => fn(async () => {}), ...extra });

test('WebAuthn add is tracked, and private keys are omitted unless requested', async () => {
  const { advanced, env, opened } = await load();
  env.handlers['WebAuthn.addVirtualAuthenticator'] = () => ({ authenticatorId: 'auth-1' });
  env.handlers['WebAuthn.getCredentials'] = () => ({
    credentials: [{
      credentialId: 'cred-1', rpId: 'app.example.com', privateKey: 'BASE64-PRIVATE',
      isResidentCredential: true, signCount: 3
    }]
  });

  const add = await advanced.run('browser_webauthn', { action: 'add', protocol: 'ctap2', transport: 'internal' }, ctx());
  assert.equal(add.status, 'success');
  assert.equal(add.authenticator.authenticatorId, 'auth-1');
  assert.equal(add.authenticator.transport, 'internal');
  assert.equal(add.sessionReused, false);
  assert.deepEqual(opened, [5]);

  const list = await advanced.run('browser_webauthn', { action: 'list' }, ctx());
  assert.equal(list.authenticators.length, 1);
  assert.equal(list.trackedOnly, true);

  const credentials = await advanced.run('browser_webauthn', { action: 'credentials', authenticatorId: 'auth-1' }, ctx());
  assert.equal(credentials.status, 'success');
  assert.equal(credentials.credentials[0].credentialId, 'cred-1');
  assert.equal(credentials.credentials[0].signCount, 3);
  assert.equal(Object.hasOwn(credentials.credentials[0], 'privateKey'), false, 'the default must not export key material');
  assert.equal(credentials.secrets, false);

  const withKey = await advanced.run('browser_webauthn', {
    action: 'credentials', authenticatorId: 'auth-1', includePrivateKey: true
  }, ctx());
  assert.equal(withKey.secrets, true);
  assert.equal(withKey.credentials[0].privateKey, 'BASE64-PRIVATE');
  assert.match(withKey.note, /do not write/);
});

test('an unavailable WebAuthn domain is unsupported, not an empty authenticator list', async () => {
  const { advanced, env } = await load();
  env.handlers['WebAuthn.enable'] = () => { throw new Error("'WebAuthn.enable' wasn't found"); };
  const result = await advanced.run('browser_webauthn', { action: 'enable' }, ctx());
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'webauthn_domain_unavailable');
  assert.equal(result.dispatched, false);
  assert.match(result.message, /Nothing was changed/);
});

test('list with no session reports that it is tracking only this bridge', async () => {
  const { advanced } = await load();
  const result = await advanced.run('browser_webauthn', { action: 'list' }, ctx());
  assert.equal(result.status, 'success');
  assert.deepEqual(result.authenticators, []);
  assert.equal(result.trackedOnly, true);
  assert.match(result.note, /cannot enumerate/);
});

test('PWA list reads management without opening a debugger session', async () => {
  const { advanced, env, opened } = await load();
  env.chrome.management = {
    getAll: async () => [{ id: 'app-1', name: 'Demo', type: 'hosted_app', enabled: true, installType: 'normal', appLaunchUrl: 'https://app.example.com/' }]
  };
  const result = await advanced.run('browser_pwa', { action: 'list' }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.count, 1);
  assert.equal(result.apps[0].id, 'app-1');
  assert.deepEqual(opened, [], 'listing installed apps must not put a debugging banner on a tab');
});

test('PWA uninstall is verified against management', async () => {
  const { advanced, env } = await load();
  let apps = [{ id: 'app-1', name: 'Demo', type: 'hosted_app', enabled: true, installType: 'normal', mayDisable: true }];
  env.chrome.management = {
    getAll: async () => apps,
    uninstall: async id => { apps = apps.filter(item => item.id !== id); }
  };
  const result = await advanced.run('browser_pwa', { action: 'uninstall', appId: 'app-1' }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.verified, true);
  assert.equal(result.stillInstalled, false);
});

test('PWA install reports the real prompt outcome and never claims the install finished', async () => {
  const { advanced, env } = await load();
  env.handlers['Page.addScriptToEvaluateOnNewDocument'] = () => ({ identifier: 'prompt-script-1' });
  env.handlers['Page.reload'] = () => ({});
  env.handlers['Runtime.evaluate'] = params => {
    if (String(params.expression).startsWith('Boolean')) return { result: { value: true } };
    return { result: { value: { available: true, outcome: 'accepted', platform: 'web' } } };
  };
  const result = await advanced.run('browser_pwa', { action: 'install', timeoutMs: 1000 }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.dispatched, true);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.verified, false, 'prompt acceptance is not an observed installation');
  assert.match(result.message, /action:"list" to confirm/);
  assert.ok(env.sent.some(item => item.method === 'Page.reload'));
});

test('PWA install without a captured prompt fails honestly and does not claim an install', async () => {
  const { advanced, env } = await load();
  env.handlers['Page.addScriptToEvaluateOnNewDocument'] = () => ({ identifier: 'prompt-script-1' });
  env.handlers['Page.reload'] = () => ({});
  env.handlers['Runtime.evaluate'] = () => ({ result: { value: false } });
  const result = await advanced.run('browser_pwa', { action: 'install', timeoutMs: 1000 }, ctx());
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'beforeinstallprompt_not_observed');
  assert.equal(result.promptSeen, false);
  assert.match(result.message, /Nothing was installed/);
});

test('extension install verifies the new id in chrome.management', async () => {
  const { advanced, env } = await load();
  let loaded = false;
  env.handlers['Extensions.loadUnpacked'] = () => { loaded = true; return { id: 'new-extension-id' }; };
  env.chrome.management = {
    getAll: async () => loaded
      ? [{ id: 'new-extension-id', name: 'Test', version: '1.0.0', type: 'extension', enabled: true }]
      : []
  };
  const result = await advanced.run('browser_extension_install', { path: 'C:\\extensions\\test' }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.extensionId, 'new-extension-id');
  assert.equal(result.verified, true);
  assert.equal(result.added.length, 1);
});

test('extension install does not claim success when management never shows the extension', async () => {
  const { advanced, env } = await load();
  env.handlers['Extensions.loadUnpacked'] = () => ({ id: 'new-extension-id' });
  env.chrome.management = { getAll: async () => [] };
  const result = await advanced.run('browser_extension_install', { path: 'C:\\extensions\\test' }, ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.verified, false);
  assert.match(result.note, /Do not repeat/);
});

test('an unavailable Extensions domain is unsupported and installs nothing', async () => {
  const { advanced, env } = await load();
  env.handlers['Extensions.loadUnpacked'] = () => { throw new Error("'Extensions.loadUnpacked' wasn't found"); };
  env.chrome.management = { getAll: async () => [] };
  const result = await advanced.run('browser_extension_install', { path: 'C:\\extensions\\test' }, ctx());
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'extensions_domain_unavailable');
  assert.match(result.message, /Nothing was installed/);
});
