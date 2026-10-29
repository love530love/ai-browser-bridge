// The native messaging channel is the one place where three failures look
// identical from a distance and call for opposite actions: no host registered
// (nothing ran, install something), no reply (unknown outcome, do not repeat),
// and port closed (the host ran and exited). These tests pin that they stay
// distinguishable, and that a port is never left holding a process by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakePort({ reply = null, disconnectWith = null, onPost = null } = {}) {
  const messageListeners = [];
  const disconnectListeners = [];
  const state = { posted: [], disconnected: false };
  const port = {
    onMessage: { addListener: fn => messageListeners.push(fn) },
    onDisconnect: { addListener: fn => disconnectListeners.push(fn) },
    postMessage(message) {
      state.posted.push(message);
      if (onPost) onPost(message);
    },
    disconnect() { state.disconnected = true; }
  };
  const replyWith = value => { for (const fn of [...messageListeners]) fn(value); };
  const closeWith = lastError => {
    globalThis.chrome.runtime.lastError = lastError ? { message: lastError } : undefined;
    for (const fn of [...disconnectListeners]) fn();
    globalThis.chrome.runtime.lastError = undefined;
  };
  return { port, state, replyWith, closeWith, reply, disconnectWith };
}

async function load() {
  const created = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative(host) {
        created.push(host);
        if (host === 'missing.host') throw new Error('Specified native messaging host not found.');
        return fakePort().port;
      }
    }
  };
  globalThis.chrome = chrome;
  const { createNativeMessaging } = await import(`../extension/native-messaging.js?t=${Math.random()}`);
  return { tools: createNativeMessaging(), chrome, created };
}

// A port whose host answers is the only shape that can produce success, so the
// fake has to hand back the port before the tool can attach its listeners.
function withPort(tools, chrome, port, host = 'com.aibridge.host') {
  chrome.runtime.connectNative = () => port;
  // A short timeout on purpose: the no-reply path is a real promise race, and a
  // test that waited the 20s default would be testing patience, not behaviour.
  return tools.run('browser_native_messaging', { host, message: { op: 'ping' }, timeoutMs: 800 });
}

test('a host that answers produces the reply', async () => {
  const { tools, chrome } = await load();
  const fake = fakePort();
  const promise = withPort(tools, chrome, fake.port);
  fake.replyWith({ ok: true, pong: true });
  const result = await promise;
  assert.equal(result.status, 'success');
  assert.deepEqual(result.reply, { ok: true, pong: true });
  assert.deepEqual(fake.state.posted, [{ op: 'ping' }]);
  assert.equal(fake.state.disconnected, true, 'a port that is not kept open must be disconnected');
});

test('an unregistered host is refused, not retried', async () => {
  const { tools } = await load();
  const result = await tools.run('browser_native_messaging', { host: 'missing.host', message: { op: 'ping' } });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'native_host_not_registered');
  assert.match(result.message, /browser_native_host/);
});

test('a host that never answers is uncertain, and the reply says not to repeat it', async () => {
  const { tools, chrome } = await load();
  const fake = fakePort();
  const result = await withPort(tools, chrome, fake.port);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'native_host_no_reply');
  assert.match(result.message, /Do not send the same message again/);
});

test('a port that closes without a reply reports the host as closed', async () => {
  const { tools, chrome } = await load();
  const fake = fakePort();
  const promise = withPort(tools, chrome, fake.port);
  fake.closeWith('Native host has exited.');
  const result = await promise;
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'native_host_closed');
});

test('a port that closes because the host is missing says so even after the connect call succeeded', async () => {
  const { tools, chrome } = await load();
  const fake = fakePort();
  const promise = withPort(tools, chrome, fake.port);
  fake.closeWith('Specified native messaging host not found.');
  const result = await promise;
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'native_host_not_registered');
  assert.equal(result.detail, 'Specified native messaging host not found.');
});

test('keepOpen retains the port and list/close manage it', async () => {
  const { tools, chrome } = await load();
  const fake = fakePort();
  chrome.runtime.connectNative = () => fake.port;
  const promise = tools.run('browser_native_messaging', { host: 'com.aibridge.host', message: { op: 'ping' }, keepOpen: true });
  fake.replyWith({ ok: true });
  const result = await promise;
  assert.equal(result.portKeptOpen, true);
  assert.equal(result.portId, 'native-1');
  assert.equal(fake.state.disconnected, false);
  const listed = await tools.run('browser_native_ports', { action: 'list' });
  assert.equal(listed.count, 1);
  assert.equal(listed.openPorts[0].host, 'com.aibridge.host');
  const closed = await tools.run('browser_native_ports', { action: 'close', portId: 'native-1' });
  assert.equal(closed.closed, true);
  assert.equal(fake.state.disconnected, true);
  assert.equal((await tools.run('browser_native_ports', { action: 'list' })).count, 0);
});

test('closing a port that was never opened is refused rather than reported as success', async () => {
  const { tools } = await load();
  const result = await tools.run('browser_native_ports', { action: 'close', portId: 'native-404' });
  assert.equal(result.status, 'denied');
  assert.equal(result.closed, false);
});

test('an oversized message is refused before a host is launched', async () => {
  const { tools, created } = await load();
  const result = await tools.run('browser_native_messaging', { host: 'com.aibridge.host', message: { blob: 'x'.repeat(1024 * 1024 + 16) } });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'message_too_large');
  assert.equal(created.length, 0);
});

test('a missing message or host is refused with the reason that names what is missing', async () => {
  const { tools } = await load();
  assert.equal((await tools.run('browser_native_messaging', { message: {} })).reason, 'host_required');
  assert.equal((await tools.run('browser_native_messaging', { host: 'com.aibridge.host' })).reason, 'message_required');
  assert.equal((await tools.run('browser_native_messaging', { host: 'com.aibridge.host', message: [1, 2] })).reason, 'message_required');
});

test('an unknown action is refused and the module owns only its own tools', async () => {
  const { tools } = await load();
  assert.equal((await tools.run('browser_native_ports', { action: 'reboot' })).reason, 'unknown_action');
  // Sending is not reachable through the ports tool: it would otherwise be a way
  // around the confirmation that browser_native_messaging carries.
  assert.equal((await tools.run('browser_native_ports', { action: 'send', host: 'com.aibridge.host', message: {} })).reason, 'unknown_action');
  assert.equal(await tools.run('browser_read', {}), null);
});
