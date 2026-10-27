import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityGuide } from '../src/capability-guide.js';
import { createBridge } from '../src/server.js';

test('a backgrounded tab is not treated as a blocker for DOM work', () => {
  const guide = capabilityGuide({ goal: '点击提交按钮并填写表单' });
  assert.equal(guide.focusRequired, false);
  assert.equal(guide.primary.intent, 'write-or-submit');
  assert.equal(guide.primary.backgroundSafe, true);
  assert.ok(guide.focusPolicy.backgroundSafeTools.includes('browser_click'));
  assert.ok(guide.focusPolicy.backgroundSafeTools.includes('browser_fill'));
  assert.match(guide.focusPolicy.guidance, /not as a gate/);
});

test('only the coordinate path and Windows UI Automation are marked foreground-only', () => {
  for (const goal of ['用坐标点一下画布', '打开 chrome://settings 改代理']) {
    const guide = capabilityGuide({ goal });
    assert.equal(guide.focusRequired, true, goal);
    assert.equal(guide.primary.backgroundSafe, false, goal);
    assert.ok(guide.primary.why.length > 20);
  }
  for (const tool of ['browser_prepare_coordinate', 'browser_action', 'browser_native_snapshot', 'browser_devtools']) {
    assert.ok(capabilityGuide({ goal: '' }).focusPolicy.foregroundRequiredTools.includes(tool), tool);
  }
});

test('an unknown goal still returns a usable chain instead of nothing', () => {
  const guide = capabilityGuide({ goal: '做一些别的事情' });
  assert.deepEqual(guide.matchedIntents, []);
  assert.equal(guide.primary, null);
  assert.ok(guide.chain.includes('browser_read'));
  assert.ok(guide.chain.includes('browser_click'));
  assert.ok(guide.fallbacks.length > 0);
  assert.match(guide.whenAToolIsMissing, /Do not conclude the task is impossible/);
});

test('capability gaps are stated instead of being hidden behind a refusal', () => {
  const guide = capabilityGuide({ goal: '登录' });
  const gaps = Object.fromEntries(guide.notImplemented.map(entry => [entry.capability, entry]));
  assert.equal(gaps['read values stored in the Chrome password manager'].status, 'impossible_by_design');
  assert.equal(gaps['launch a browser when none is running'].status, 'not_implemented');
  assert.equal(gaps['breakpoints, stepping and script editing in Sources'].status, 'not_implemented');
  assert.match(guide.primary.prefer, /autofill/);
});

test('reload guidance points at the capability itself, not at a manual step', () => {
  const guide = capabilityGuide({ goal: '扩展版本不匹配，需要 reload' });
  assert.equal(guide.primary.intent, 'extension-reload-or-deploy');
  // 扩展 also matches the chrome:// intent, which does need the foreground; the
  // primary path must not inherit that requirement.
  assert.equal(guide.focusRequired, false);
  assert.ok(guide.alsoMatches.some(entry => entry.intent === 'chrome-internal' && entry.focusRequired === true));
  assert.match(guide.primary.prefer, /confirmation only/);
});

test('the guide is answered locally, so it survives a disconnected extension', async t => {
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    leaseStateFile: null, agentPolicyFile: null, audit: () => {}
  });
  await bridge.listen(); t.after(() => bridge.close());
  const result = await bridge.call('browser_capability_guide', { goal: '读取页面内容' });
  assert.equal(result.status, 'ok');
  assert.equal(result.primary.intent, 'read-or-locate');
  assert.equal(result.focusRequired, false);
});
