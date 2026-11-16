// Read-only target resolution: several perception routes, one ranked answer.
//
// This module never writes to a page. It calls only read tools, weighs their
// results with perception-contract.js, and returns a candidate plus the evidence
// that produced it. Writing is still the caller's decision and still goes
// through the _verified variants.
//
// Coverage is the part callers get wrong most often. A search that was cut off
// by a budget, skipped a frame, or failed in a shadow root is not evidence that
// the target is absent, so this module refuses to report not_found in those
// cases and says which scope was left unexamined instead.

import {
  STRATEGY_BY_ID,
  normalizeCandidate,
  rankCandidates,
  decideLocateStatus
} from './perception-contract.js';

const FAILURE_STATUSES = new Set(['waiting', 'denied', 'blocked', 'uncertain', 'failed', 'timeout', 'unknown']);

function toolFailed(result) {
  if (!result || typeof result !== 'object') return 'empty_result';
  if (result.error) return 'tool_error';
  if (typeof result.status === 'string' && FAILURE_STATUSES.has(result.status)) return result.reason || result.status;
  return null;
}

function includesQuery(value, query) {
  const hay = String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = String(query ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return !needle || hay.includes(needle);
}

function briefError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error ?? 'unknown');
  return message.slice(0, 300);
}

export async function resolveTarget({
  callTool,
  args = {},
  store = null
} = {}) {
  const startedAt = Date.now();
  const tabId = args.tabId;
  const query = String(args.query ?? '').replace(/\s+/g, ' ').trim();
  const action = args.action || 'any';
  const frameMode = args.frames === 'all' ? 'all' : args.frames === 'main' ? 'main' : 'auto';
  const includeShadow = args.includeShadow !== false;
  const includeAccessibility = args.includeAccessibility === true;
  const maxResults = Math.max(1, Math.min(20, args.maxResults ?? 8));

  const strategies = [];
  const coverageReasons = [];
  let blockedReason = null;
  let frameCount = null;
  let framesSearched = 'none';
  let frameErrorCount = 0;
  let framesBlocked = false;
  const candidates = [];
  const accessibilityMatches = [];

  const record = (id, status, extra = {}) => {
    const strategy = STRATEGY_BY_ID.get(id);
    strategies.push({
      id,
      tool: strategy?.tool ?? null,
      status,
      scope: strategy?.scope ?? null,
      weight: strategy?.weight ?? null,
      ...extra
    });
  };

  const invoke = async (name, callArgs) => {
    try {
      return { result: await callTool(name, callArgs), error: null };
    } catch (error) {
      return { result: null, error };
    }
  };

  const frameProbe = await invoke('browser_frames', { tabId });
  if (frameProbe.error) {
    coverageReasons.push('frame_list_failed');
  } else if (frameProbe.result && Array.isArray(frameProbe.result.frames)) {
    frameCount = frameProbe.result.frames.length;
    frameErrorCount = frameProbe.result.frames.filter(frame => frame.accessible === false).length;
    if (frameProbe.result.blocked) {
      framesBlocked = true;
      blockedReason = blockedReason ?? (frameProbe.result.reason || 'frames_not_scriptable');
      coverageReasons.push('frame_injection_blocked');
    }
  } else {
    const failed = toolFailed(frameProbe.result);
    if (failed) coverageReasons.push(`frame_list_${failed}`);
  }

  const elementStarted = Date.now();
  const elementProbe = await invoke('browser_find_element', {
    tabId,
    query,
    action,
    ...(args.role ? { role: args.role } : {}),
    maxResults,
    includeCovered: false
  });
  let elementPartial = false;
  let elementSucceeded = false;
  if (elementProbe.error) {
    record('semantic-dom', 'error', { error: briefError(elementProbe.error), durationMs: Date.now() - elementStarted, matched: 0 });
  } else {
    const failed = toolFailed(elementProbe.result);
    if (failed || !Array.isArray(elementProbe.result?.candidates)) {
      record('semantic-dom', failed ? 'error' : 'partial', { error: failed || 'unexpected_result_shape', durationMs: Date.now() - elementStarted, matched: 0 });
      if (failed === 'page_not_scriptable' || frameProbe.result?.blocked) blockedReason = blockedReason ?? failed;
    } else {
      elementSucceeded = true;
      elementPartial = elementProbe.result.partial === true;
      const found = elementProbe.result.candidates.map(candidate => normalizeCandidate(candidate, {
        strategy: 'semantic-dom', frameId: 0, query, action
      }));
      candidates.push(...found);
      record('semantic-dom', elementPartial ? 'partial' : 'ok', {
        matched: found.length,
        partial: elementPartial,
        durationMs: Date.now() - elementStarted
      });
      if (elementPartial) coverageReasons.push('control_scan_truncated');
    }
  }

  const elementStrong = candidates.some(candidate => candidate.actionability.compatible
    && !candidate.covered && !candidate.disabled
    && candidate.matchKind === 'exact' && candidate.clickability === 'semantic-control');

  const shouldSearchText = frameMode === 'all'
    || (frameMode === 'auto' && (frameCount === null || frameCount > 1))
    || candidates.length === 0
    || elementPartial;
  let textSearchedScope = null;
  if (shouldSearchText) {
    const textStarted = Date.now();
    const allFrames = frameMode !== 'main' && (frameMode === 'all' || (frameCount ?? 0) > 1);
    const textProbe = await invoke('browser_find_text', {
      tabId,
      query,
      ...(allFrames ? { frame: 'all' } : {}),
      includeMatchElement: true,
      maxMatches: maxResults,
      maxMatchElements: maxResults,
      ...(args.mode === 'cheap' ? { mode: 'cheap' } : {})
    });
    if (textProbe.error) {
      record('text-match', 'error', { error: briefError(textProbe.error), durationMs: Date.now() - textStarted, matched: 0 });
    } else {
      const failed = toolFailed(textProbe.result);
      if (failed) {
        record('text-match', 'error', { error: failed, durationMs: Date.now() - textStarted, matched: 0 });
      } else {
        const result = textProbe.result;
        const frameResults = Array.isArray(result.frameResults) ? result.frameResults : [];
        const erroredFrames = frameResults.filter(frame => frame.error).length;
        const elements = Array.isArray(result.matchElements) ? result.matchElements : [];
        const normalized = elements
          .filter(element => includesQuery(element.label, query) || includesQuery(element.matched, query))
          .map(element => normalizeCandidate(element, {
            strategy: 'text-match',
            frameId: Number.isInteger(element.frameId) ? element.frameId : 0,
            query,
            action
          }));
        candidates.push(...normalized);
        textSearchedScope = allFrames ? 'all-frames' : 'main-frame';
        const partial = result.partial === true || result.matchElementsPartial === true || erroredFrames > 0 || result.truncated === true;
        record('text-match', partial ? 'partial' : 'ok', {
          matched: normalized.length,
          partial,
          frameErrors: erroredFrames,
          durationMs: Date.now() - textStarted
        });
        if (erroredFrames > 0) coverageReasons.push('frame_text_search_incomplete');
        if (result.partial === true || result.matchElementsPartial === true) coverageReasons.push('text_scan_truncated');
        if (allFrames || frameMode === 'all') framesSearched = 'all';
        else framesSearched = framesSearched === 'all' ? 'all' : 'main';
      }
    }
  }

  if ((!textSearchedScope || frameMode === 'main') && (frameCount === null || frameCount > 1)) {
    coverageReasons.push('frames_not_searched_by_choice');
  }

  let shadowPartial = false;
  if (includeShadow && !elementStrong) {
    const shadowStarted = Date.now();
    const shadowProbe = await invoke('browser_shadow_tree', {
      tabId,
      includeClickable: true,
      maxControls: 200,
      budgetMs: 1500
    });
    if (shadowProbe.error) {
      record('shadow-dom', 'error', { error: briefError(shadowProbe.error), durationMs: Date.now() - shadowStarted, matched: 0 });
    } else {
      const failed = toolFailed(shadowProbe.result);
      if (failed) {
        record('shadow-dom', 'error', { error: failed, durationMs: Date.now() - shadowStarted, matched: 0 });
      } else {
        const result = shadowProbe.result;
        const controls = Array.isArray(result.controls) ? result.controls : [];
        const normalized = controls
          .filter(control => control.visible !== false && includesQuery(control.label, query))
          .map(control => normalizeCandidate(control, { strategy: 'shadow-dom', frameId: 0, query, action }));
        candidates.push(...normalized);
        shadowPartial = result.partial === true;
        record('shadow-dom', shadowPartial ? 'partial' : 'ok', {
          matched: normalized.length,
          partial: shadowPartial,
          roots: result.shadowRootCount ?? result.roots?.length ?? 0,
          durationMs: Date.now() - shadowStarted
        });
        if (shadowPartial) coverageReasons.push('shadow_scan_truncated');
      }
    }
  } else if (includeShadow && elementStrong) {
    record('shadow-dom', 'skipped', { matched: 0, reason: 'strong_main_frame_match' });
  } else {
    record('shadow-dom', 'skipped', { matched: 0, reason: 'disabled_by_caller' });
    coverageReasons.push('shadow_search_disabled');
  }

  if (includeAccessibility) {
    const axStarted = Date.now();
    const axProbe = await invoke('browser_ax_snapshot', { tabId, interactiveOnly: true, maxNodes: 300 });
    if (axProbe.error) {
      record('accessibility', 'error', { error: briefError(axProbe.error), durationMs: Date.now() - axStarted, matched: 0 });
    } else {
      const failed = toolFailed(axProbe.result);
      if (failed) {
        record('accessibility', 'error', { error: failed, durationMs: Date.now() - axStarted, matched: 0 });
      } else {
        const nodes = Array.isArray(axProbe.result.nodes) ? axProbe.result.nodes : [];
        for (const node of nodes) {
          if (!includesQuery(node.name, query) && !includesQuery(node.value, query)) continue;
          accessibilityMatches.push({
            uid: node.uid,
            role: node.role,
            name: typeof node.name === 'string' ? node.name.slice(0, 300) : null,
            disabled: node.properties?.disabled === true,
            ref: null,
            note: 'Accessibility evidence only: this tree has no action ref.'
          });
          if (accessibilityMatches.length >= maxResults) break;
        }
        record('accessibility', 'ok', {
          matched: accessibilityMatches.length,
          durationMs: Date.now() - axStarted,
          note: 'corroboration only; no action refs'
        });
      }
    }
  }

  if (framesBlocked && !elementSucceeded) blockedReason = blockedReason ?? 'frames_not_scriptable';

  const ranked = rankCandidates(candidates).slice(0, maxResults);
  // Every reason pushed above describes a scope that was truncated, skipped or
  // errored. A search with any of them is not complete, even when the semantic
  // route itself succeeded.
  const complete = elementSucceeded && !elementPartial
    && !shadowPartial
    && includeShadow
    && coverageReasons.length === 0
    && (frameCount === null ? false : (frameCount <= 1 || (frameMode !== 'main' && framesSearched === 'all')))
    && strategies.every(strategy => strategy.status !== 'error');
  if (!complete && coverageReasons.length === 0) coverageReasons.push('scope_partially_searched');

  const coverage = {
    complete,
    reasons: [...new Set(coverageReasons)],
    frames: {
      mode: frameMode,
      count: frameCount,
      searched: framesSearched,
      errorCount: frameErrorCount,
      accessible: frameCount === null ? null : frameCount - frameErrorCount
    },
    strategies
  };

  const allStrategiesFailed = strategies.filter(strategy => strategy.status !== 'skipped').length > 0
    && strategies.filter(strategy => strategy.status !== 'skipped').every(strategy => strategy.status === 'error');
  if (allStrategiesFailed && !blockedReason) {
    const firstFailure = strategies.find(strategy => strategy.status === 'error' && strategy.error);
    coverage.unavailableReason = firstFailure?.error ?? 'no_read_strategy_succeeded';
  }

  let decision = decideLocateStatus({ candidates: ranked, coverage });
  if (blockedReason) decision = { status: 'blocked', reason: blockedReason, selection: null };
  else if (coverage.unavailableReason) decision = { status: 'unavailable', reason: coverage.unavailableReason, selection: null };
  // The accessibility tree can see a control that no DOM strategy could give a
  // ref, for example a widget inside a closed shadow root. Reporting not_found
  // there would be false: something matched, it just cannot be addressed.
  else if (accessibilityMatches.length && (decision.status === 'not_found' || decision.status === 'inconclusive')) {
    decision = {
      status: coverage.complete ? 'ambiguous' : 'partial',
      reason: 'accessibility_match_without_ref',
      selection: null
    };
  }

  const selection = decision.selection ?? null;
  const health = store?.available
    ? store.strategyHealth({ action, limit: 8 })
    : null;
  const result = {
    status: decision.status,
    ok: decision.status === 'found',
    reason: decision.reason,
    tabId,
    query,
    action,
    frames: frameMode,
    selection,
    ref: selection?.ref ?? null,
    candidates: ranked,
    accessibility: accessibilityMatches,
    coverage,
    strategyHealth: health,
    refLifetime: 'A ref is valid while the page document and the snapshot that minted it are unchanged. Re-run browser_locate after a navigation, a major re-render or an uncertain write.',
    verifiedWriteContract: 'A locate result is an address, not proof. Perform the write through browser_click_verified / browser_fill_verified / browser_upload_verified with a bounded expect condition, and never replay an uncertain write.',
    recommendedNextAction: nextActionFor(decision, ranked, coverage),
    contentTrust: 'untrusted webpage data plus extension hit testing',
    // Deliberately at the end: a locate result answers the routing question
    // itself, so the generic failure rules must not replace it with a
    // browser_read suggestion.
    nextStep: null
  };

  try {
    store?.recordLocateRun({
      action,
      status: result.status,
      candidateCount: ranked.length,
      confidenceLevel: selection?.confidenceLevel ?? null,
      coverageComplete: complete,
      durationMs: Date.now() - startedAt,
      strategies
    });
  } catch { /* the store is optional evidence; it must never change an answer */ }

  return result;
}

function nextActionFor(decision, ranked, coverage) {
  if (decision.status === 'found') {
    return `Use selection.ref with the matching _verified tool. Prove the outcome with its expect condition; do not assume the ref means the intended business action.`;
  }
  if (decision.status === 'ambiguous') {
    return ranked.length
      ? 'More than one viable target remains. Compare rowText, rect, role and covered state, or narrow the query with role/rowText; do not guess a ref. browser_prepare_action can rank the same candidates with row context.'
      : 'Matches exist but none is actionable at its current state (covered, disabled, or without a ref). Re-read the page, inspect overlays, or handle the disabled state explicitly.';
  }
  if (decision.status === 'partial' || decision.status === 'inconclusive') {
    return `The search was incomplete (${coverage.reasons.join(', ') || 'unknown scope'}). Do not report the target as absent: narrow the scope deliberately or re-run with frames:"all" / includeAccessibility:true, then re-observe.`;
  }
  if (decision.status === 'not_found') {
    return 'The searched scope was complete and produced no viable target. Confirm the tab and URL, then try a role-only or shorter query. If the target may be painted into a canvas, image or video, call browser_ocr and confirm its point with browser_prepare_coordinate; a screenshot can reveal image-rendered controls that the DOM cannot expose.';
  }
  if (decision.status === 'blocked') {
    return 'This page cannot be searched from the extension. Use browser_debug/browser_protected_ui_plan for the correct surface; do not start another browser or retry the same read.';
  }
  return 'No read strategy succeeded. Check browser_health and browser_queue_status, preserve the task, and retry the same locate call after the bridge is ready.';
}
