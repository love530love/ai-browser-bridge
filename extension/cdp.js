// Browser implementation; action vocabulary is compatible with a subset of
// Open-AutoGLM's published phone actions. No ADB or vendor service is used.
export async function withDebugger(tabId, fn) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (error) {
    if (/another debugger is already attached|already attached to the tab/i.test(error.message || '')) {
      error.code = 'DEBUGGER_BUSY_BEFORE_DISPATCH';
    }
    throw error;
  }
  try { return await fn((method, params = {}) => chrome.debugger.sendCommand(target, method, params)); }
  finally { await chrome.debugger.detach(target).catch(() => {}); }
}
const pageReleaseExpression = (x, y) => `(() => {
  const target = document.elementFromPoint(${Number(x)}, ${Number(y)}) || document.body || document.documentElement;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: ${Number(x)}, clientY: ${Number(y)}, button: 0, buttons: 0, view: window };
  target.dispatchEvent(new MouseEvent('mouseup', init));
  try { target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch {}
  try { target.dispatchEvent(new PointerEvent('pointercancel', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch {}
  return { tag: target.tagName || null };
})()`;

export async function pointer(send, { x, y, action = 'click', endX, endY, beforeMove, beforePress, steps, releaseWatchdogMs = 6000 }) {
  const button = action === 'right' ? 'right' : 'left';
  if (beforeMove && !(await beforeMove())) return { completed: false, released: false, release: null };
  const totalSteps = action === 'drag' ? Math.min(24, Math.max(2, Math.trunc(Number(steps)) || 8)) : 1;
  let pressed = false, cancelled = false, aborted = false;
  let lastX = x, lastY = y, releaseInfo = null, watchdog = null;
  const release = async reason => {
    if (!pressed) return releaseInfo;
    pressed = false;
    cancelled = true;
    let method = 'cdp';
    let error = null;
    try {
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lastX, y: lastY, button, buttons: 0, clickCount: 1 });
    } catch (cdpError) {
      method = 'page';
      try {
        await send('Runtime.evaluate', { expression: pageReleaseExpression(lastX, lastY), returnByValue: true });
      } catch (pageError) {
        method = null;
        error = pageError?.message ?? cdpError?.message ?? 'release_failed';
      }
    }
    releaseInfo = { reason, method, released: method !== null, x: lastX, y: lastY, ...(error ? { error: String(error).slice(0, 200) } : {}) };
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    return releaseInfo;
  };
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (action === 'hover') return { completed: true, released: false, release: null };
    const count = action === 'double' ? 2 : 1;
    for (let i = 1; i <= count; i++) {
      if (cancelled) break;
      if (beforePress && !(await beforePress(i))) { aborted = true; break; }
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: i });
      pressed = true;
      // A hung Input.dispatchMouseEvent never reaches the finally block, which is
      // exactly how a backgrounded tab was left pressed. This watchdog releases
      // on the last known coordinate from an independent CDP call.
      watchdog = setTimeout(() => { void release('watchdog'); }, Math.max(1000, Number(releaseWatchdogMs) || 6000));
      if (action === 'long') await new Promise(resolve => setTimeout(resolve, 600));
      if (action === 'drag') for (let step = 1; step <= totalSteps; step++) {
        if (cancelled) break;
        lastX = x + (endX - x) * step / totalSteps;
        lastY = y + (endY - y) * step / totalSteps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lastX, y: lastY, button, buttons: 1 });
      }
      if (!cancelled) {
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: action === 'drag' ? lastX : x, y: action === 'drag' ? lastY : y, button, buttons: 0, clickCount: i });
        pressed = false;
        if (!releaseInfo) releaseInfo = { reason: 'gesture_end', method: 'cdp', released: true, x: action === 'drag' ? lastX : x, y: action === 'drag' ? lastY : y };
      }
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (cancelled) break;
    }
    return { completed: !cancelled && !aborted, released: Boolean(releaseInfo?.released), release: releaseInfo };
  } catch (error) {
    // Release before returning so the caller sees whether the button was lifted
    // and by which method. The finally block below cannot help here: a value
    // returned from catch is built before finally runs.
    if (pressed) await release('gesture_failed').catch(() => {});
    return { completed: false, released: Boolean(releaseInfo?.released), release: releaseInfo, error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    if (pressed) await release('gesture_failed').catch(() => {});
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
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
  const functionKey = /^F([1-9]|1[0-2])$/.exec(name);
  const def = named[name] || (functionKey ? [name, 111 + Number(functionKey[1])] : null) || (/^[a-zA-Z0-9]$/.test(name) ? [/^[0-9]$/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0), name] : null);
  if (!def) throw new Error('Unsupported key');
  const args = { key: name === 'Space' ? ' ' : name, code: def[0], windowsVirtualKeyCode: def[1], modifiers };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...args, ...(def[2] && !(modifiers & 7) ? { text: def[2] } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...args });
}
