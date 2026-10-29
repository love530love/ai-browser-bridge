// The clipboard document. Nothing here decides whether a read or write is
// allowed - the service already refused the call unless the caller echoed the
// confirmation string for the write tool, and a read is never gated. This file
// only performs the primitive and reports exactly which primitive answered,
// because the two directions behave differently and a caller has to be able to
// tell "the clipboard is empty" from "this route cannot read".
//
// Measured on Chrome 156, not assumed:
//   * document.execCommand('copy') works here with clipboardWrite, so a write
//     is dispatched without touching any page;
//   * navigator.clipboard.readText() THROWS "Document is not focused" here,
//     because that API is gated on document focus and an offscreen document
//     never has focus. The attempt is kept because a future Chrome could lift
//     that restriction, and because reporting the real error is more useful
//     than not trying - but clipboard.js routes every read through a real tab.
// The consequence is that a write made here cannot be read back from the same
// document either, so verified is false and the caller is told to confirm with
// a route that can actually see the clipboard.

const sink = () => document.getElementById('sink');

async function writeText(text) {
  const value = String(text ?? '');
  const area = sink();
  area.value = value;
  area.focus();
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  // Read back through the same document. A write that cannot be read back is
  // reported as uncertain rather than success: execCommand returns true for a
  // copy it did not actually perform when no selection survived.
  let observed = null;
  try { observed = await navigator.clipboard.readText(); } catch { observed = null; }
  return { ok: copied || observed === value, method: 'offscreen_exec_command', copied, verified: observed === value, observedLength: typeof observed === 'string' ? observed.length : null };
}

async function readText() {
  try {
    const text = await navigator.clipboard.readText();
    return { ok: true, method: 'offscreen_clipboard_api', text: typeof text === 'string' ? text : '' };
  } catch (error) {
    return { ok: false, method: 'offscreen_clipboard_api', error: String(error?.message ?? error), name: String(error?.name ?? '') };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen') return;
  (async () => {
    if (message.op === 'read') return await readText();
    if (message.op === 'write') return await writeText(message.text);
    throw new Error(`Unknown offscreen op: ${String(message.op)}`);
  })().then(respond, error => respond({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
