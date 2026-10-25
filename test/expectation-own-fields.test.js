import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCall } from '../src/tools.js';

test('verified expectations reject inherited Object properties before dispatch', () => {
  for (const tool of ['browser_click_verified', 'browser_fill_verified', 'browser_upload_verified']) {
    const base = { tabId: 1, ref: 'fixture' };
    if (tool === 'browser_fill_verified') base.text = 'hello';
    if (tool === 'browser_upload_verified') Object.assign(base, { filePath: 'C:/fixture.txt', sha256: 'a'.repeat(64) });
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const expect = JSON.parse(JSON.stringify({ [key]: 'done' }));
      assert.throws(() => validateCall(tool, { ...base, expect }), /Invalid expect condition/);
    }
  }
});
