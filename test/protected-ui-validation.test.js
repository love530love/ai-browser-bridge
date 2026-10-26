import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCall } from '../src/tools.js';

test('internal UI URLs reach the planner without enabling ordinary navigation', () => {
  for (const url of ['chrome://extensions/', 'chrome://settings/', 'devtools://devtools/bundled/inspector.html', 'view-source:https://example.com/']) {
    assert.doesNotThrow(() => validateCall('browser_protected_ui_plan', { url }));
    assert.throws(() => validateCall('browser_navigate', { tabId: 1, url }), /Only HTTP/);
  }
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'view-source:javascript:alert(1)', 'https://user:password@example.com/']) {
    assert.throws(() => validateCall('browser_protected_ui_plan', { url }));
  }
});
