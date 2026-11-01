// Pure logic for action receipts and duplicate suppression, kept out of the
// worker so it can be tested without a browser. The worker owns the injections
// and the timing; everything here is a function of two fingerprints and a call.
//
// A receipt answers the question every caller actually has after an action -
// "did anything happen?" - without making it read the whole page again and
// compare by eye. A small model cannot hold two page dumps and diff them, so
// without a receipt it does the only other thing it knows: clicks again.
//
// Suppression is the same idea one step further. Two identical actions against
// an unchanged page are almost never two intentions; they are one intention and
// one lost acknowledgement. The key includes the fingerprint taken BEFORE the
// action, so a legitimate repeat is never blocked: clicking "next page" twice
// changes the page between clicks, which changes the digest, which makes the
// second click a different action.
export const RECEIPT_TOOLS = new Set([
  'browser_click', 'browser_click_verified', 'browser_action', 'browser_fill', 'browser_fill_verified',
  'browser_key', 'browser_select', 'browser_choose', 'browser_pick', 'browser_hover', 'browser_drag',
  'browser_scroll', 'browser_scroll_element', 'browser_upload', 'browser_upload_verified',
  'browser_dismiss_overlay', 'browser_navigate'
]);

// Only the actions where a silent repeat creates a second real-world effect.
// Navigating twice, scrolling twice or hovering twice are not in this set, and
// plain browser_fill is not either: re-typing the same text into the same field
// is how a field gets filled after a re-render.
export const DEDUPE_TOOLS = new Set([
  'browser_click', 'browser_click_verified', 'browser_action', 'browser_fill_verified',
  'browser_key', 'browser_select', 'browser_choose', 'browser_pick',
  'browser_upload', 'browser_upload_verified'
]);

// Long enough to catch a retry loop, short enough that a deliberate second
// action a minute later is not mistaken for one.
export const DUPLICATE_WINDOW_MS = 8000;

export function hashString(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// A ref is "<snapshot uuid>:<index>", and a fresh snapshot uuid is minted on
// every read. Comparing raw refs therefore makes every action a different
// action the moment the caller re-reads between attempts - which is exactly what
// a caller is told to do, so the raw form made suppression unreachable in
// practice (measured on the real browser: three identical clicks, three
// dispatches, because browser_at handed out a new snapshot each time).
//
// The key already requires an identical page fingerprint, so within an unchanged
// page the index is the element identity that matters. Dropping the snapshot is
// what lets "the same click" compare equal across a re-read. This can only ever
// suppress when the fingerprint matched, and allowRepeat:true overrides it, so
// the failure mode stays "one refused call you can see" rather than "a silent
// double submit".
const SNAPSHOT_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i;

function canonical(value) {
  if (typeof value === 'string') return SNAPSHOT_REF.test(value) ? value.slice(value.indexOf(':') + 1) : value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = canonical(item);
    return out;
  }
  return value;
}

export function duplicateKey(name, tabId, args, digest) {
  const payload = { ...args };
  // These do not change what the action does, so they must not change its identity.
  delete payload.allowRepeat;
  delete payload.agent;
  return `${name}|${tabId}|${digest}|${hashString(JSON.stringify(canonical(payload)))}`;
}

// The comparison is intentionally shallow. A deep diff would be expensive, and a
// deep diff that says "changed: false" because it looked at the wrong thing is
// worse than a cheap one that says "no change observed, keep watching".
export function describeChange(before, after) {
  if (!before || !after) {
    return { measured: false, changed: null,
      note: 'A fingerprint could not be taken on one side of the action, so there is no receipt for it. That is a gap in the evidence, not evidence that nothing changed.' };
  }
  const changed = before.digest !== after.digest;
  return {
    measured: true,
    changed,
    urlChanged: before.url !== after.url,
    titleChanged: before.title !== after.title,
    textDelta: after.textLength - before.textLength,
    interactiveDelta: after.interactive - before.interactive,
    focus: before.focus === after.focus ? null : { from: before.focus, to: after.focus },
    dialogOpened: !before.dialog && after.dialog ? after.dialog : null,
    dialogClosed: before.dialog && !after.dialog ? before.dialog : null,
    scrolled: before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y,
    digestBefore: before.digest,
    digestAfter: after.digest,
    note: changed
      ? 'The page differed immediately after the action. A difference is evidence that something happened, not proof that it was the intended thing.'
      : 'No change was observed immediately after the action. An asynchronous update may not have rendered yet, so this is not evidence that the action failed: use browser_wait or read the page before concluding anything.'
  };
}

// The refusal is a first-class result, not an error: nothing was dispatched, and
// the caller is told which earlier action it duplicates.
export function suppressionResult({ name, before, prior, now }) {
  const ageMs = now - prior.at;
  return {
    status: 'duplicate_suppressed', retryable: false, dispatched: false,
    reason: 'duplicate_suppressed',
    duplicateOf: { tool: name, at: new Date(prior.at).toISOString(), ageMs, status: prior.status },
    duplicateWindowMs: DUPLICATE_WINDOW_MS,
    receipt: { before, after: before, measured: true, changed: false, suppressed: true },
    message: `Nothing was dispatched: the same ${name} already ran against this exact page state ${ageMs}ms ago. An identical action on an unchanged page is almost always one intention and one lost acknowledgement, so repeating it would create a second real-world effect.`,
    recommendedNextAction: 'Read the page to see what the first action did (browser_read, mode "cheap"). If the task genuinely needs the same action again on an unchanged page - a counter that has not re-rendered yet, for example - repeat it with allowRepeat:true and the reason will be recorded.'
  };
}
