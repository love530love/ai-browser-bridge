import test from 'node:test';
import assert from 'node:assert/strict';
import { key } from '../extension/cdp.js';

test('F1 through F12 produce balanced keyboard events without inserting text', async () => {
  for (let n = 1; n <= 12; n++) {
    const events = [];
    await key(async (method, args) => events.push({ method, ...args }), `F${n}`);
    assert.deepEqual(events.map(e => e.type), ['keyDown', 'keyUp']);
    assert.equal(events[0].windowsVirtualKeyCode, 111 + n);
    assert.equal(events[0].code, `F${n}`);
    assert.equal(events[0].text, undefined);
  }
});
test('function-key chords preserve modifiers and invalid keys emit no events', async () => {
  const events = [];
  await key(async (method, args) => events.push(args), 'Ctrl+Shift+F12');
  assert.equal(events[0].modifiers, 10);
  assert.equal(events[1].modifiers, 10);
  for (const chord of ['F0', 'F13', 'F12;anything', 'Unknown+F12']) {
    await assert.rejects(key(async () => { throw new Error('Unexpected dispatch'); }, chord), /Unsupported/);
  }
});
