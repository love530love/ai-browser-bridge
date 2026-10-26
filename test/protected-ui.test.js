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
  assert.equal(protectedUiRisk('install_extension', 'extension abc'), 'high');
  const plan = protectedUiPlan({ url: 'chrome://extensions', action: 'install_extension', target: 'extension abc' });
  assert.equal(plan.status, 'requires_user');
  assert.equal(plan.confirmation.required, true);
  assert.equal(plan.confirmation.singleUse, true);
  assert.match(plan.authorization, /explicit user approval/);
  assert.match(plan.guarantees.join(' '), /not bypassed/);
});

test('ordinary extension maintenance respects task authorization but never claims execution', () => {
  const plan = protectedUiPlan({ url: 'chrome://extensions/', action: 'reload_extension', target: 'extensions: exact-id' });
  assert.equal(plan.status, 'desktop_adapter_required');
  assert.equal(plan.confirmation, null);
  assert.equal(plan.workflow.surface, 'extension_manager');
  assert.equal(plan.execution.dispatched, false);
  assert.equal(plan.execution.adapterAvailability, 'unavailable');
  assert.match(plan.authorization, /existing user-authorized/);
});

test('DevTools and source viewer have explicit routes rather than ordinary DOM claims', () => {
  const devtools = protectedUiPlan({ url: 'devtools://devtools/bundled/inspector.html', action: 'inspect' });
  assert.equal(devtools.workflow.surface, 'devtools');
  assert.match(devtools.workflow.steps.join(' '), /F12 is a toggle/);
  assert.equal(protectedUiPlan({ url: 'view-source:https://example.test/' }).workflow.surface, 'source_viewer');
  assert.equal(protectedUiPlan({ url: 'chrome://downloads/' }).workflow.surface, 'download_manager');
  assert.equal(protectedUiPlan({ url: 'chrome://settings/security', action: 'observe', target: 'security' }).confirmation, null);
  assert.equal(protectedUiPlan({ url: 'chrome://settings/security', action: 'change_security_setting' }).confirmation.required, true);
});

test('low risk protected UI still requires a desktop adapter', () => {
  const plan = protectedUiPlan({ url: 'chrome://settings', action: 'observe' });
  assert.equal(plan.status, 'desktop_adapter_required');
  assert.equal(plan.confirmation, null);
  assert.deepEqual(plan.adapterOrder, ['windows_uia', 'manual_user_action']);
});

test('protected UI plan advertises only the implemented fixed extension reload action', () => {
  const supported = protectedUiPlan({ url: 'chrome://extensions', action: 'reload_extension', desktopAdapterAvailable: true });
  assert.equal(supported.status, 'desktop_adapter_available');
  assert.equal(supported.execution.implementedHere, true);
  assert.equal(supported.execution.adapterAvailability, 'available');
  assert.equal(supported.execution.dispatched, false);
  assert.equal(supported.execution.tool, 'browser_reload_extension');
  assert.match(supported.authorization, /direct user approval/);
  assert.match(supported.authorization, /caller attestation/);

  const settings = protectedUiPlan({ url: 'chrome://settings', action: 'change_setting', desktopAdapterAvailable: true });
  assert.equal(settings.execution.implementedHere, false);
  assert.equal(settings.execution.adapterAvailability, 'not_implemented_for_action');
  assert.equal(settings.execution.dispatched, false);
});

