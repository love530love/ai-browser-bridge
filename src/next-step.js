// Every refusal used to end the same way for a weak caller: a status, a reason
// code and a paragraph of prose. A model that cannot hold the paragraph has no
// move left, so it either retries the same call or invents a different one - and
// both of those are how a correct tool set produces an incorrect task.
//
// This module turns a result into exactly one executable next step, or into
// nothing. Three rules keep it from becoming another source of wrong advice:
//
// 1. It only speaks when the arguments are fully known. A step with a guessed
//    ref or a guessed tab id is worse than silence, because a caller that is
//    told exactly what to do will do it.
// 2. It never turns an uncertain write into a retry. The generic rule for
//    "dispatched but the outcome is unknown" is to read, not to repeat.
// 3. It says which kind of move it is, so a caller can branch without parsing
//    English: wait, diagnose, retry_with_changes, escalate, stop.
//
// The step is advisory. It is derived from the result alone and cannot grant
// authority, so a step that needs a confirmation string still carries the
// confirmation the gate asked for - never a fabricated one.
import { TOOLS } from './tools.js';

const SUCCESS_STATUSES = new Set(['success', 'verified', 'nothing_to_clear', 'cleared', 'already_in_state', 'available']);
const WAIT_STEP = () => ({
  kind: 'wait',
  tool: 'browser_wait_until_ready',
  arguments: { timeoutMs: 30000, idle: true },
  why: 'The bridge is momentarily unavailable or busy. Waiting keeps the task alive without touching the page; retrying a write now would be a second dispatch.'
});

const READ_STEP = (tabId, why) => ({
  kind: 'diagnose',
  tool: 'browser_read',
  arguments: Number.isInteger(tabId) ? { tabId, mode: 'cheap' } : {},
  why
});

const DESKTOP_STEP = why => ({
  kind: 'diagnose',
  tool: 'browser_desktop_windows',
  arguments: {},
  why
});

function reasonOf(result) {
  return typeof result?.reason === 'string' ? result.reason : '';
}

// A result counts as a failure when it says so, when it reports that the target
// was not found, or when it admits the outcome is unknown. Everything else is
// treated as an answer: a finder that legitimately matched nothing is not a
// failure, but it still gets a step (see the not-rendered rule).
export function isFailure(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (typeof result.status === 'string') return !SUCCESS_STATUSES.has(result.status);
  if (result.ok === false || result.error) return true;
  if (result.found === false) return true;
  if (result.ambiguous === true) return true;
  if (result.notRendered) return true;
  // A dialog that read as empty is not a completed read: the answer about the
  // thing the caller asked for is still missing, and waiting once is the fix.
  if (result.overlaySettling) return true;
  return false;
}

// Ordered: the first rule that can name its arguments wins. Order matters more
// than coverage here, because two plausible steps for one failure is the same
// problem as none.
const RULES = [
  // Already done. The only correct move is to stop, and saying so explicitly is
  // what stops a caller from treating a suppression as a failure to retry.
  {
    id: 'duplicate_suppressed',
    match: r => r.reason === 'duplicate_suppressed',
    step: () => ({
      kind: 'stop',
      tool: null,
      arguments: {},
      why: 'An identical action already ran against an unchanged page moments ago. The first one is the one that counted; do not repeat it. Read the page to see its effect.'
    })
  },
  // The generic and most important rule: a write that may have landed is never
  // retried on the strength of a failed call.
  {
    id: 'uncertain_write',
    match: r => r.dispatched === true && (r.status === 'uncertain' || r.status === 'timeout' || r.status === 'unknown'),
    step: (r, a) => READ_STEP(a.tabId,
      'The action was dispatched and the outcome was not observed. Reading is the only safe next move: repeating a write that may have already happened is how a second order, a second message or a second deletion is created.')
  },
  {
    id: 'explicit_confirmation_required',
    match: r => r.reason === 'explicit_confirmation_required' && typeof r.confirmation === 'string',
    step: (r, a) => ({
      kind: 'retry_with_changes',
      tool: a.__tool,
      arguments: { ...stripInternal(a), confirmation: r.confirmation },
      why: `This tool refuses to act without the confirmation string "${r.confirmation}". The gate is the tool's, not a suggestion: pass it only when the user has approved this exact action.`
    })
  },
  {
    id: 'password_needs_secret_fill',
    match: r => r.reason === 'password_needs_secret_fill' || /password field/i.test(typeof r.message === 'string' ? r.message : ''),
    // Deliberately carries no tool and no arguments: the missing piece is a flag on
    // the call the caller already made, and the value must not be copied into a
    // step object that may be logged. Saying which flag to add is enough.
    step: () => ({
      kind: 'retry_with_changes',
      tool: null,
      arguments: {},
      why: 'This is a password field and a plain fill is refused by design. Repeat the same call on the same ref with the same text plus secret:true (browser_fill or browser_fill_verified). The reply then reports the character count and a boolean match and never the value. Never paste a password through the clipboard instead: that path reports success without being able to show whether the text landed.'
    })
  },
  {
    id: 'picker_card_candidates',
    match: r => r.reason === 'picker_card_candidates' && Array.isArray(r.candidates),
    step: (r, a) => {
      // Opening a custom picker is itself a dispatched interaction. Its open
      // state may change which candidate ref is correct, so read before acting.
      if (r.dispatched === true || r.candidateScan?.partial === true) return {
        kind: 'diagnose',
        tool: 'browser_read',
        arguments: { tabId: a.tabId, mode: 'cheap', ...(a.agent ? { agent: a.agent } : {}) },
        why: r.dispatched === true
          ? 'The picker was opened but no option was selected. Its popup may still be changing the page; re-read before using any candidate ref, and do not repeat the pick blindly.'
          : 'Candidate discovery hit its time, node or result limit. The returned list may be incomplete, so uniqueness is not established; re-read with context or run a broader deliberate scan before clicking.'
      };
      // Picker fallback is specifically for non-picker card/tile groups. A
      // button that happens to have the same label may be a destructive action,
      // so semantic controls are reported for inspection but never promoted to
      // an automatic click suggestion from this recovery path.
      const exact = r.candidates.filter(candidate => candidate.match === 'exact' && candidate.clickability === 'cursor-pointer');
      if (exact.length === 1) return {
        kind: 'retry_with_changes',
        tool: 'browser_click',
        arguments: { tabId: a.tabId, ref: exact[0].ref, ...(a.agent ? { agent: a.agent } : {}) },
        why: 'No picker exists, but exactly one visible, topmost clickable target matches the requested text. This step uses its fresh ref directly; it does not click automatically. After the click, read the page and verify the selected state before any further action.'
      };
      return {
        kind: 'diagnose',
        tool: 'browser_read',
        arguments: { tabId: a.tabId, scope: 'auto', mode: 'cheap', ...(a.agent ? { agent: a.agent } : {}) },
        why: exact.length > 1
          ? 'Several visible click targets match exactly; choosing one would be a guess. Read the overlay/page context and resolve the ambiguity before clicking.'
          : 'The visible candidates only contain the requested text or do not have one unique exact match. Read their surrounding context and choose by evidence; do not upgrade a substring match into a click.'
      };
    }
  },
  {
    id: 'element_covered',
    match: r => r.reason === 'element_covered' || r.status === 'covered',
    // When the cover is the dialog the target itself lives in, dismissing it
    // closes the target. Measured on a real antd modal, where the old advice
    // (press Escape) would have destroyed the form the caller was filling in.
    step: (r, a) => (r.targetInsideCoverDialog
      ? {
        kind: 'diagnose',
        tool: 'browser_read',
        arguments: { tabId: a.tabId, scope: 'overlay', mode: 'cheap' },
        why: 'The click point is owned by another element inside the SAME dialog as the target, so pressing Escape would close the dialog and the target with it. Read the dialog itself: scope "overlay" scans it first and returns refs for the elements that actually own the point.'
      }
      : {
        kind: 'diagnose',
        tool: 'browser_scan_overlays',
        arguments: { tabId: a.tabId },
        why: 'Something else owns the click point. Scanning overlays names the cover and its dismiss path; a click through an obstruction is never the fix, and every ref held from before a dismissal is stale.'
      })
  },
  // A coordinate token is single-use and short-lived, and the three ways it can
  // fail need three different moves. Reporting them as one reason made a caller
  // re-prepare when it had simply reused a token, or retry a dead one forever.
  {
    id: 'download_wait_timeout',
    match: r => r.reason === 'download_wait_timeout' && Number.isInteger(r.downloadId),
    step: (r, a) => ({
      kind: 'diagnose',
      tool: 'browser_downloads',
      arguments: { downloadId: r.downloadId, limit: 1, ...(a.agent ? { agent: a.agent } : {}) },
      why: 'The bounded wait ended while this exact download was still in progress. Read its current Chrome state first; if it remains active, you may intentionally wait again for the same ID. Do not start or replay another download to test it.'
    })
  },
  {
    id: 'download_not_found',
    match: r => r.reason === 'download_not_found',
    step: () => ({
      kind: 'stop', tool: null, arguments: {},
      why: 'Chrome has no item with that exact downloadId. Do not guess another ID or repeat the page action; inspect browser_downloads and identify the intended record first.'
    })
  },
  {
    id: 'download_interrupted',
    match: r => r.reason === 'download_interrupted',
    step: () => ({
      kind: 'stop', tool: null, arguments: {},
      why: 'Chrome reports this exact download interrupted. Do not automatically repeat it: inspect the reason, destination and user intent before deciding whether a new download is appropriate.'
    })
  },
  {
    id: 'coordinate_token',
    match: r => /^coordinate_token_/.test(reasonOf(r)) || (Array.isArray(r.validationFailures) && r.validationFailures.some(f => /^coordinate_token_/.test(f))),
    step: (r, a) => {
      const kind = reasonOf(r).replace('coordinate_token_', '')
        || (r.validationFailures ?? []).find(f => /^coordinate_token_/.test(f))?.replace('coordinate_token_', '') || '';
      if (kind === 'never_issued') {
        return { kind: 'stop', tool: null, arguments: {},
          why: 'No coordinate token with that value was ever issued in this document. A token cannot be invented or carried over from another tab: call browser_prepare_coordinate first and use the value it returns.' };
      }
      return {
        kind: 'retry_with_changes',
        tool: 'browser_prepare_coordinate',
        arguments: Number.isFinite(a.x) && Number.isFinite(a.y) ? { tabId: a.tabId, x: a.x, y: a.y, ttlMs: 300000 } : { tabId: a.tabId, x: 500, y: 500, ttlMs: 300000 },
        why: kind === 'consumed'
          ? 'That token was already used once; a coordinate token is single-use. Prepare the same coordinate again with a longer ttlMs and dispatch it in the very next call.'
          : 'The token expired before the dispatch reached the page. Prepare again with a longer ttlMs and dispatch immediately, with no other call in between.'
      };
    }
  },
  {
    id: 'eval_blocked',
    match: r => r.reason === 'eval_blocked_by_page_csp' || r.reason === 'debugger_channel_failed',
    step: () => ({
      kind: 'escalate',
      tool: null,
      arguments: {},
      why: 'Both evaluation channels failed: the page\'s Content Security Policy forbids eval in its own world, and the debugger fallback could not run either. Do not repeat the expression blindly. Use the page\'s own controls (browser_read, browser_find_element, browser_shadow_tree) or the desktop path for browser UI.'
    })
  },
  {
    id: 'expression_threw',
    match: r => r.reason === 'expression_threw' || r.reason === 'promise_rejected' || r.reason === 'empty_expression',
    step: () => ({
      kind: 'stop',
      tool: null,
      arguments: {},
      why: 'The expression itself threw, which is a fact about the expression rather than a bridge failure. Fix the expression from the exception in the reply; running the same text again produces the same throw.'
    })
  },
  {
    id: 'overlay_settling',
    match: r => !!r.overlaySettling,
    step: (r, a) => ({
      kind: 'wait',
      tool: 'browser_wait',
      arguments: { tabId: a.tabId, ms: 400 },
      why: 'A dialog is on screen but read as having no controls, which is what an entrance animation looks like from the DOM: everything inside is at opacity 0 for a few hundred milliseconds. Wait briefly and read again instead of concluding the dialog is empty.'
    })
  },
  {
    id: 'not_rendered',
    match: r => r.notRendered?.reason === 'not_rendered_possible' || r.reason === 'not_rendered_possible',
    step: (r, a) => ({
      kind: 'diagnose',
      tool: 'browser_scan_overlays',
      arguments: { tabId: a.tabId },
      why: 'The target may be unrendered rather than absent. Scanning overlays returns the scrollable containers with refs; scroll the container and search again before concluding the target does not exist.'
    })
  },
  {
    id: 'ambiguous_target',
    match: r => r.ambiguous === true,
    step: (r, a) => ({
      kind: 'diagnose',
      tool: 'browser_prepare_action',
      arguments: { tabId: a.tabId, query: a.query ?? a.text ?? '' },
      why: 'More than one element matches, and picking one of them is a guess about which row the task means. browser_prepare_action ranks the candidates with their row context so the choice can be made on evidence.'
    })
  },
  {
    id: 'stale_reference',
    match: r => /stale|reference|not_found|removed/i.test(reasonOf(r)),
    step: (r, a) => READ_STEP(a.tabId,
      'The element reference no longer resolves. Refs stay valid only while the element list is unchanged; something on the page changed it. Read the page again and use the refs from that reading.')
  },
  {
    id: 'verify_failed',
    match: r => reasonOf(r).startsWith('verify_'),
    step: (r, a) => ({
      kind: 'diagnose',
      tool: 'browser_fetch',
      arguments: { tabId: a.tabId, url: a.verify?.url ?? '' },
      why: 'The read-back did not report the expected value. Reading the verify endpoint directly shows what it actually returns, which is the difference between a write that did not take effect and a pointer that points at the wrong place. Do not resend the write.'
    })
  },
  {
    id: 'fetch_cross_origin',
    match: r => r.reason === 'fetch_cross_origin_denied',
    step: (r, a) => ({
      kind: 'retry_with_changes',
      tool: 'browser_replay_request',
      arguments: { tabId: a.tabId, method: 'GET', url: a.url, confirmation: 'replay_request_once' },
      why: 'browser_fetch is same-origin only. The same read is available through browser_replay_request, which reports the third-party exposure instead of refusing it.'
    })
  },
  {
    id: 'not_scriptable',
    match: r => r.reason === 'page_not_scriptable' || r.status === 'blocked',
    step: () => DESKTOP_STEP('This page cannot be scripted from the extension. Internal Chrome surfaces are reachable through the desktop adapter, so list the windows and bind a control there.')
  },
  {
    id: 'disconnected',
    match: r => /disconnect|not_connected|paused|service_busy|queue_full|lease|maintenance|bridge_command/i.test(reasonOf(r)),
    step: () => WAIT_STEP()
  },
  {
    id: 'desktop_target',
    match: r => /chrome_target|no_visible_chrome_window|desktop_adapter|desktop_window/i.test(reasonOf(r)),
    step: () => DESKTOP_STEP('The desktop path could not resolve exactly one Chrome window. Listing windows gives the process id and handle to name one precisely.')
  },
  {
    id: 'focus_required',
    match: r => r.focusRequired === true || r.reason === 'focus_required_for_ui_automation',
    step: (r, a) => ({
      kind: 'escalate',
      tool: null,
      arguments: {},
      why: 'This path needs the Chrome window in front, which takes the screen away from the user. That is their decision, not the caller\'s: ask before repeating with allowFocus:true.'
    })
  },
  {
    id: 'timeout',
    match: r => /timeout|timed_out|timed out/i.test(reasonOf(r)) || r.timedOut === true,
    step: () => WAIT_STEP()
  },
  {
    id: 'not_found',
    match: r => r.found === false,
    step: (r, a) => READ_STEP(a.tabId,
      'Nothing matched. Reading the page shows what is actually there; a second identical search on an unchanged page cannot produce a different answer.')
  }
];

function stripInternal(args) {
  const copy = { ...args };
  delete copy.__tool;
  return copy;
}

// A step is only worth emitting if the call it describes would be accepted.
// Advice that the very next call refuses is worse than no advice: the caller
// spends a round trip learning that the guide cannot be trusted, and then has to
// decide what to do anyway. So the target tool's own schema is the judge.
const SCHEMAS = new Map(TOOLS.map(entry => [entry.name, entry.inputSchema]));

function validStep(step) {
  // A tool-less step is only allowed for moves that are instructions rather than
  // calls: stop, escalate, and "same call plus one flag" (retry_with_changes).
  if (!step.tool) return ['stop', 'escalate', 'retry_with_changes'].includes(step.kind);
  const schema = SCHEMAS.get(step.tool);
  if (!schema) return false;
  const args = step.arguments ?? {};
  for (const value of Object.values(args)) if (value === undefined) return false;
  for (const key of schema.required) {
    if (!Object.hasOwn(args, key)) return false;
    const property = schema.properties[key];
    if (property?.type === 'string' && typeof args[key] === 'string' && args[key].length < (property.minLength ?? 0)) return false;
    if (property?.type === 'integer' && !Number.isInteger(args[key])) return false;
  }
  return true;
}

// The single entry point. Returns null when no rule can name its arguments -
// silence is a valid answer and a guessed step is not.
// When all deterministic rules are exhausted, returns a special escalation step
// with aiAssisted: true, signaling that AI-assisted discovery is needed.
export function nextStepFor(name, args = {}, result = null) {
  if (!isFailure(result)) return null;
  for (const rule of RULES) {
    let matched = false;
    try { matched = rule.match(result); } catch { matched = false; }
    if (!matched) continue;
    let step = null;
    try { step = rule.step(result, { ...args, __tool: name }); } catch { step = null; }
    if (!step || !validStep(step)) continue;
    return { rule: rule.id, ...step };
  }
  // All deterministic rules exhausted → mark for AI-assisted discovery
  return {
    rule: 'deterministic_rules_exhausted',
    kind: 'escalate_to_ai',
    tool: null,
    arguments: {},
    why: `Deterministic rules exhausted for "${name}". The page structure or tool routing is unclear. Call browser_local_judge({mode:"discovery", goal:"<your goal>", observation:"<latest page read>", attemptedTools:["${name}"], failureReasons:["${result.reason || result.status || 'unknown'}"]}) for AI-assisted page analysis and tool recommendation.`,
    aiAssisted: true,
    needsAiDiscovery: true,
    suggestedTool: 'browser_local_judge',
    suggestedMode: 'discovery',
    suggestedArgs: {
      mode: 'discovery',
      goal: args.goal || '<define your goal>',
      observation: args.observation || '<include latest page read>',
      attemptedTools: [name],
      failureReasons: [result.reason || result.status || 'unknown']
    }
  };
}

// Attach the step without ever replacing what the tool already said. Tools that
// carry their own recommendedNextAction keep it; this adds the executable form.
export function withNextStep(name, args, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.nextStep !== undefined) return result;
  const step = nextStepFor(name, args, result);
  if (!step) return result;
  return { ...result, nextStep: step };
}

// A thrown error is the other way a call fails, and it used to be the one path
// with no guidance at all: the extension throws "Stale element reference. Read
// page again." and the caller received a bare sentence with no reason code to
// branch on. Measured on the real browser - the stale_reference rule existed and
// could never fire, because a throw never reaches a result.
//
// Only the message is available here, so it is mapped onto the reason code the
// rules already speak. An unrecognised message stays silent on purpose: a rule
// matched by guessing is worse than no rule.
const ERROR_REASONS = [
  [/stale element|reference no longer|not_found|element.*removed/i, 'stale_reference'],
  [/password field/i, 'password_needs_secret_fill'],
  [/timed out|timeout|timed_out/i, 'timeout'],
  [/not connected|disconnected|extension paused|bridge is paused/i, 'extension_disconnected'],
  [/covered|intercepts pointer events/i, 'element_covered']
];

export function nextStepForError(name, args = {}, message = '') {
  const text = typeof message === 'string' ? message : '';
  const matched = ERROR_REASONS.find(([pattern]) => pattern.test(text));
  if (!matched) return null;
  return nextStepFor(name, args, { status: 'failed', reason: matched[1], message: text });
}
