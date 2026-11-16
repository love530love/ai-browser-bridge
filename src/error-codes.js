// One vocabulary for the failure shapes that used to arrive as bare sentences
// or bare timeouts.
//
// A code is attached by the party that actually has evidence: the extension
// classifies its own command deadline after probing tab/window state without
// injecting the page, the service classifies host loss and its own transport
// deadline, and no code is inferred from page content. Codes describe what was
// observed, not why it happened: TAB_OCCLUDED says the document was hidden
// when the capture path timed out, not that occlusion is the proven cause.
//
// Existing reason strings stay untouched. They are the precise detail; a code
// is the stable family a caller can branch on without parsing prose.
export const ERROR_CODES = Object.freeze({
  HOST_FLAPPED: 'HOST_FLAPPED',
  TAB_OCCLUDED: 'TAB_OCCLUDED',
  CSP_BLOCKED: 'CSP_BLOCKED',
  DEBUGGER_STUCK: 'DEBUGGER_STUCK',
  TARGET_GONE: 'TARGET_GONE',
  TIMEOUT_UNKNOWN: 'TIMEOUT_UNKNOWN'
});

// Order matters: the first family whose evidence matches wins. A debugger
// pause and a timeout can appear in the same sentence, and the pause is the
// actionable fact.
const RULES = [
  { code: ERROR_CODES.CSP_BLOCKED, patterns: [
    /eval_blocked_by_page_csp/, /content security policy/i, /refused to evaluate/i,
    /csp.*(?:block|refus)/i, /trusted types/i
  ] },
  { code: ERROR_CODES.DEBUGGER_STUCK, patterns: [
    /tab_paused_by_debugger/, /debugger_busy/, /devtools_already_attached/,
    /debugger_channel_failed/, /another debugger/i, /debugger.*(?:stuck|attach)/i,
    /paused (?:by|in) (?:the )?debugger/i
  ] },
  { code: ERROR_CODES.TARGET_GONE, patterns: [
    /no tab with id/i, /tab (?:was |is )?closed/i, /target.*(?:closed|gone|crashed)/i,
    /inspected target navigated or closed/i, /frame.*was removed/i, /could not find (?:a |the )?tab/i
  ] },
  { code: ERROR_CODES.HOST_FLAPPED, patterns: [
    /extension_disconnected/, /host_not_connected/, /connection (?:lost|closed)/i,
    /extension (?:is )?not connected/i, /did not reconnect/i, /websocket.*(?:closed|error)/i
  ] },
  { code: ERROR_CODES.TAB_OCCLUDED, patterns: [
    /tab_occluded/, /page_not_foreground/, /document_hidden/, /tab_inactive/,
    /window_not_focused/, /clipboard_needs_visible_document/, /hidden document/i,
    /dialog_suppressed_in_background/
  ] },
  { code: ERROR_CODES.TIMEOUT_UNKNOWN, patterns: [
    /read_timeout/, /command_timeout/, /page_timeout/, /timed? ?out/i,
    /timeout/i, /did not (?:answer|respond)/i, /main thread.*busy/i
  ] }
];

// Context that legitimately carries a timeout word but is not a timeout.
const NOT_A_FAILURE_REASON = /^(service_busy|queue_wait_timeout|service_idle_timeout|user_aborted)$/;

export function codeForReason(reason) {
  const text = typeof reason === 'string' ? reason : '';
  if (!text || NOT_A_FAILURE_REASON.test(text.trim())) return null;
  for (const rule of RULES) {
    if (rule.patterns.some(pattern => pattern.test(text))) return rule.code;
  }
  return null;
}

// Attaches a code to a structured result without overwriting one that the
// producing side already set. Arrays, null and primitive results pass through:
// an empty tab list is not a failure.
export function applyErrorCode(result, { error = null } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (typeof result.code === 'string' && ERROR_CODES[result.code]) return result;
  const code = codeForReason(result.reason)
    || codeForReason(typeof result.error === 'string' ? result.error : null)
    || codeForReason(typeof error === 'string' ? error : null);
  return code ? { ...result, code } : result;
}

// Guidance keyed by code, for callers that branch on the code instead of the
// prose. retryPolicy "read_only" means a replay is safe because the operation
// cannot write; it says nothing about whether it will succeed this time.
export const ERROR_CODE_GUIDE = Object.freeze({
  HOST_FLAPPED: {
    family: 'transport', retryPolicy: 'read_only',
    meaning: 'The browser host or its extension connection was lost while the call was outstanding.',
    nextAction: 'Keep the task alive, wait for the host to reconnect, then repeat only reads. A write from this family is uncertain and must be verified on the page, never replayed.'
  },
  TAB_OCCLUDED: {
    family: 'visibility', retryPolicy: 'read_only',
    meaning: 'The document was hidden (inactive tab or minimized window) when a path that needs painted frames, a visible clipboard document or a browser-shown dialog could not proceed.',
    nextAction: 'Retry the read once; DOM and CDP reads normally work in a background tab. Do not activate windows or tabs to make automation succeed. If the path still cannot produce frames, a hidden-tab JavaScript dialog has to be shown, or the clipboard needs a visible document, ask the human to bring the tab forward once, then retry.'
  },
  CSP_BLOCKED: {
    family: 'policy', retryPolicy: 'never',
    meaning: 'The page Content Security Policy refused direct evaluation.',
    nextAction: 'Do not repeat the same injection. Use ref-based tools, browser_read/browser_observe, or the documented CDP fallback result channel the tool already reports.'
  },
  DEBUGGER_STUCK: {
    family: 'debugger', retryPolicy: 'never',
    meaning: 'A debugger attachment is held elsewhere, is paused, or the channel failed.',
    nextAction: 'Inspect browser_debugger action:"list" for this tab. Resume or close own sessions; a session held by DevTools can only be released by the human. Do not detach another debugger and do not replay the write.'
  },
  TARGET_GONE: {
    family: 'target', retryPolicy: 'never',
    meaning: 'The tab, frame or document the call was bound to no longer exists.',
    nextAction: 'Discard every ref from that tab, list tabs again, and rebuild the action from a fresh observation. Never reuse the old coordinate or ref.'
  },
  TIMEOUT_UNKNOWN: {
    family: 'timeout', retryPolicy: 'read_only',
    meaning: 'The command outlived its budget and no outcome was observed. Occlusion, main-thread work or host slowness can each produce it.',
    nextAction: 'For a read, poll browser_wait_until_ready and retry with smaller budgets. For a write, re-observe the page and verify whether it took effect; an unobserved write is never replayed.'
  }
});
