import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedUiUrl, protectedUiPlan, protectedUiRisk } from '../src/protected-ui.js';

test('protected UI classifier covers Chrome-owned and DevTools pages', () => {
  for (const url of ['chrome://extensions', 'chrome://settings/privacy', 'chrome-extension://abc/panel.html', 'devtools://devtools/bundled/inspector.html', 'view-source:chrome://version']) {
    assert.equal(isProtectedUiUrl(url), true, url);
    assert.equal(protectedUiPlan({ url }).protectedPage, true);
  }
  assert.equal(isProtectedUiUrl('https://example.com/chrome://settings'), false);
  assert.equal(protectedUiPlan({ url: 'https://example.com' }).status, 'ordinary_page');
});

test('high risk protected UI requires fresh explicit approval', () => {
  assert.equal(protectedUiRisk('reload_extension', 'extension abc'), 'high');
  const plan = protectedUiPlan({ url: 'chrome://extensions', action: 'reload_extension', target: 'extension abc' });
  assert.equal(plan.status, 'requires_user');
  assert.equal(plan.confirmation.required, true);
  assert.equal(plan.confirmation.singleUse, true);
  assert.match(plan.authorization, /explicit user approval/);
  assert.match(plan.guarantees.join(' '), /not bypassed/);
});

test('low risk protected UI still requires a desktop adapter', () => {
  const plan = protectedUiPlan({ url: 'chrome://settings', action: 'observe' });
  assert.equal(plan.status, 'desktop_adapter_required');
  assert.equal(plan.confirmation, null);
  assert.deepEqual(plan.adapterOrder, ['windows_uia', 'computer_use_screenshot', 'manual_user_action']);
});

