import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl, summarizeTargets, runCdpProbe } from '../extension/cdp-probe.js';

const targets = [
  { type: 'page', url: 'https://secret.example/a?token=abc', title: 'Secret Page', attached: true },
  { type: 'browser', url: '', title: '', attached: false },
  { type: 'service_worker', url: 'chrome-extension://abcdef/worker.js', title: 'Worker', attached: false }
];

function fakeSend(overrides = {}) {
  const replies = {
    'Target.getTargets': { targetInfos: targets },
    'Schema.getDomains': { domains: ['Schema', 'Target', 'Page', 'Runtime', 'Input', 'Network'].map(name => ({ name })) },
    'Page.getFrameTree': { frameTree: { frame: { url: 'https://secret.example/path?q=1' }, childFrames: [{ frame: { url: 'https://secret.example/frame?x=2' } }] } },
    'Runtime.evaluate': { result: { type: 'number', value: 2 } },
    'Input.setIgnoreInputEvents': {},
    'Network.getCookies': { cookies: [{ name: 'session', value: 'SECRET-COOKIE' }] },
    'Page.getInstallabilityErrors': { installabilityErrors: [{ errorId: 'not-in-main-frame', errorArguments: [{ name: 'x', value: 'secret' }] }] },
    'Page.getAppManifest': { url: 'https://secret.example/manifest.json?token=abc', data: '{"name":"Secret App"}', errors: [] },
    ...overrides
  };
  return async (method) => {
    const reply = replies[method];
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error(`unexpected method ${method}`);
    return reply;
  };
}

test('redactUrl keeps only scheme and host', () => {
  assert.equal(redactUrl('https://example.com/a/b?token=secret#frag'), 'https://example.com/');
  assert.equal(redactUrl('http://127.0.0.1:8080/path'), 'http://127.0.0.1:8080/');
  assert.equal(redactUrl('chrome://extensions/?errors=abcdef'), 'chrome://');
  assert.equal(redactUrl('data:text/html,secret'), 'data://');
  assert.equal(redactUrl('not a url'), '<unparseable>');
});

test('summarizeTargets counts types and never exposes urls or titles', () => {
  const summary = summarizeTargets(targets);
  assert.equal(summary.count, 3);
  assert.equal(summary.pageCount, 1);
  assert.equal(summary.browserCount, 1);
  assert.equal(summary.attachedCount, 1);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('Secret Page'), false);
});

test('probe reports every accepted command and redacts page data', async () => {
  const result = await runCdpProbe({
    tab: { id: 7, url: 'https://secret.example/a?token=abc', active: false },
    send: fakeSend(),
    getTargets: async () => targets,
    channel: 'one_off_attach',
    userAgent: 'TestChrome/1.0',
    now: () => Date.parse('2026-11-15T00:00:00Z')
  });
  assert.equal(result.status, 'success');
  assert.equal(result.readOnly, true);
  assert.equal(result.verdict.gate1, 'target_domain_available');
  assert.deepEqual(result.verdict.gate2.accepted, [
    'Target.getTargets', 'Schema.getDomains', 'Page.getFrameTree',
    'Runtime.evaluate', 'Input.setIgnoreInputEvents', 'Network.getCookies',
    'Page.getInstallabilityErrors', 'Page.getAppManifest'
  ]);
  assert.deepEqual(result.verdict.gate2.unsupported, []);
  assert.deepEqual(result.verdict.gate2.refused, []);
  assert.equal(result.verdict.browserLevelEndpoint, false);
  assert.equal(result.tab.url, 'https://secret.example/');
  assert.equal(result.extensionApi.ok, true);
  assert.equal(result.extensionApi.summary.count, 3);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('SECRET-COOKIE'), false);
  assert.equal(serialized.includes('token=abc'), false);
  assert.equal(serialized.includes('?q=1'), false);
  assert.equal(serialized.includes('Secret Page'), false);
  assert.match(serialized, /https:\/\/secret\.example\//);
});

test('an unsupported Target domain is recorded, not hidden', async () => {
  const result = await runCdpProbe({
    tab: { id: 7, url: 'https://example.com/', active: true },
    send: fakeSend({ 'Target.getTargets': new Error('"Target.getTargets" wasn\'t found') }),
    getTargets: async () => [],
    channel: 'one_off_attach'
  });
  assert.equal(result.status, 'success');
  assert.equal(result.verdict.gate1, 'target_domain_unavailable');
  assert.deepEqual(result.verdict.gate2.unsupported, ['Target.getTargets']);
  const command = result.commands.find(item => item.method === 'Target.getTargets');
  assert.equal(command.code, -32601);
  assert.equal(command.classification, 'unsupported');
});

test('a missing chrome.debugger.getTargets API does not stop the command probes', async () => {
  const result = await runCdpProbe({
    tab: { id: 7, url: 'https://example.com/', active: true },
    send: fakeSend(),
    getTargets: async () => { throw new Error('getTargets is not available'); },
    channel: 'reused_session'
  });
  assert.equal(result.extensionApi.ok, false);
  assert.equal(result.extensionApi.classification, 'refused');
  assert.equal(result.commands.filter(command => command.ok).length, 8);
  assert.equal(result.channel, 'reused_session');
});
