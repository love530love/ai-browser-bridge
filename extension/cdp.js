// Browser implementation; action vocabulary is compatible with a subset of
// Open-AutoGLM's published phone actions. No ADB or vendor service is used.
export async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try { return await fn((method, params = {}) => chrome.debugger.sendCommand(target, method, params)); }
  finally { await chrome.debugger.detach(target).catch(() => {}); }
}
export async function pointer(send, { x, y, action = 'click', endX, endY }) {
  const button = action === 'right' ? 'right' : 'left';
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  if (action === 'hover') return;
  const count = action === 'double' ? 2 : 1;
  let pressed = false;
  try {
    for (let i = 1; i <= count; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: i });
      pressed = true;
      if (action === 'long') await new Promise(resolve => setTimeout(resolve, 600));
      if (action === 'drag') for (let step = 1; step <= 8; step++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (endX - x) * step / 8, y: y + (endY - y) * step / 8, button, buttons: 1 });
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: action === 'drag' ? endX : x, y: action === 'drag' ? endY : y, button, buttons: 0, clickCount: i });
      pressed = false;
    }
  } finally {
    if (pressed) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0 }).catch(() => {});
  }
}
export async function key(send, chord) {
  const parts = chord.split('+'); const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const bit = { Ctrl: 2, Control: 2, Alt: 1, Shift: 8, Meta: 4 }[part];
    if (!bit) throw new Error('Unsupported key modifier'); modifiers |= bit;
  }
  const named = { Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32, ' '] };
  const def = named[name] || (/^[a-zA-Z0-9]$/.test(name) ? [/^[0-9]$/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0), name] : null);
  if (!def) throw new Error('Unsupported key');
  const args = { key: name === 'Space' ? ' ' : name, code: def[0], windowsVirtualKeyCode: def[1], modifiers };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...args, ...(def[2] && !(modifiers & 7) ? { text: def[2] } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...args });
}
