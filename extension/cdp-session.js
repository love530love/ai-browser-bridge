// A long-lived CDP session, which is what breakpoints and stepping require.
//
// The rest of the bridge attaches the debugger, does one thing and detaches.
// That model cannot support debugging: a breakpoint registered in one call is
// gone by the next one, because detaching tears the whole protocol session down.
// So this module keeps one session per tab alive across calls.
//
// Keeping a session alive introduces exactly one new way to hurt the user: a
// paused page is a frozen page. If the session is dropped while the target is
// paused, the tab stops responding and the user has to reload it by hand. Every
// path out of this module therefore resumes before it detaches, and a paused
// session that nobody touches is resumed automatically after a bounded window.
// That window is the whole reason this file exists rather than a thin wrapper.
//
// Effects are injected so the safety properties can be asserted without Chrome.

const MAX_SCRIPTS = 400;
const MAX_SCRIPT_LIST = 60;
const MAX_HITS = 50;
const MAX_FRAMES = 40;
const MAX_RESULT_CHARS = 4000;
const MAX_EXPRESSION_CHARS = 4000;
// A replacement script is whole-file text, so it is bounded far higher than an
// expression. It is refused rather than truncated: a truncated script would be
// applied as a corrupt edit, which is worse than not editing at all.
const MAX_SCRIPT_SOURCE_CHARS = 2000000;

function clampText(value, limit = MAX_RESULT_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text;
}

function summarizeFrame(frame, index) {
  return {
    index,
    functionName: clampText(frame?.functionName || '(anonymous)', 120),
    url: clampText(frame?.url ?? '', 300),
    lineNumber: Number.isSafeInteger(frame?.location?.lineNumber) ? frame.location.lineNumber + 1 : null,
    columnNumber: Number.isSafeInteger(frame?.location?.columnNumber) ? frame.location.columnNumber + 1 : null,
    scopeTypes: Array.isArray(frame?.scopeChain) ? frame.scopeChain.map(scope => scope?.type).filter(Boolean) : [],
    // Scope values are deliberately not included: a scope can hold megabytes and
    // may contain tokens. Ask for a specific expression instead.
    callFrameId: typeof frame?.callFrameId === 'string' ? frame.callFrameId : null
  };
}

// Keeps primitives as themselves: turning 42 into "42" makes the caller parse
// again, and hides whether the expression produced a number or a string.
function clampValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'string') return clampText(value);
  if (value === undefined) return null;
  try { return clampText(JSON.stringify(value)); } catch { return clampText(String(value)); }
}

export function createSessionManager({
  attach,
  detach,
  send,
  now = Date.now,
  pausedTtlMs = 30000,
  idleTtlMs = 300000,
  schedule = setTimeout,
  cancelSchedule = clearTimeout
} = {}) {
  const sessions = new Map();

  const blank = tabId => ({
    tabId, openedAt: now(), lastUsedAt: now(), url: null,
    scripts: new Map(), breakpoints: new Map(),
    paused: null, pausedTimer: null, hits: [],
    autoResumedCount: 0, closed: false, closeReason: null
  });

  function describe(session) {
    return {
      tabId: session.tabId,
      openedAt: session.openedAt,
      idleMs: now() - session.lastUsedAt,
      url: session.url,
      paused: session.paused ? {
        reason: session.paused.reason,
        hitBreakpoints: session.paused.hitBreakpoints,
        frameCount: session.paused.callFrames.length,
        pausedAt: session.paused.at,
        // Measured from the last interaction while paused, not from the pause
        // itself: an agent inspecting frames must not be cut off mid-inspection,
        // while an abandoned paused tab must still recover on its own.
        autoResumeInMs: Math.max(0, pausedTtlMs - (now() - session.paused.lastTouchedAt))
      } : null,
      breakpoints: [...session.breakpoints.values()],
      scriptCount: session.scripts.size,
      recentHits: session.hits.slice(-5),
      autoResumedCount: session.autoResumedCount,
      // The user-visible cost of this capability, stated where the caller reads it.
      debuggerBannerVisible: true
    };
  }

  // The single place a session dies. Resume first, always: detaching a paused
  // target can leave the tab frozen, and that is not something the caller can
  // detect afterwards.
  async function shutdown(session, reason) {
    session.closed = true;
    session.closeReason = reason;
    cancelSchedule?.(session.pausedTimer);
    session.pausedTimer = null;
    const wasPaused = Boolean(session.paused);
    session.paused = null;
    if (wasPaused) await send(session.tabId, 'Debugger.resume', {}).catch(() => {});
    await send(session.tabId, 'Debugger.disable', {}).catch(() => {});
    await detach(session.tabId).catch(() => {});
    sessions.delete(session.tabId);
    return {
      status: 'success', closed: true, reason: 'debugger_session_closed',
      closeReason: reason, resumedBeforeClose: wasPaused,
      note: wasPaused ? 'The target was paused, so it was resumed before detaching. The page is not frozen.' : undefined
    };
  }

  async function autoResume(session) {
    if (!session.paused) return false;
    session.pausedTimer = null;
    session.autoResumedCount += 1;
    session.paused = null;
    await send(session.tabId, 'Debugger.resume', {}).catch(() => {});
    return true;
  }

  async function open({ tabId, expectedUrl } = {}) {
    if (!Number.isSafeInteger(tabId) || tabId < 1) {
      return { status: 'denied', retryable: false, reason: 'invalid_tab', dispatched: false };
    }
    const existing = sessions.get(tabId);
    if (existing && !existing.closed) {
      existing.lastUsedAt = now();
      return { status: 'success', reused: true, session: describe(existing),
        note: 'A debugger session was already open on this tab. Reusing it instead of attaching twice.' };
    }
    try {
      await attach(tabId);
    } catch (error) {
      const busy = /another debugger is already attached|already attached to the tab/i.test(error?.message ?? '');
      return {
        status: 'denied', retryable: busy ? false : true, dispatched: false,
        reason: busy ? 'devtools_already_attached' : 'debugger_attach_failed',
        message: busy
          ? 'Another debugger is already attached to this tab, which in practice means DevTools is open on it. Close DevTools, or debug a different tab. Nothing was attached.'
          : `Could not attach the debugger: ${error?.message ?? 'unknown error'}. Nothing was attached.`
      };
    }
    const session = blank(tabId);
    session.url = expectedUrl ?? null;
    sessions.set(tabId, session);
    try {
      await send(tabId, 'Runtime.enable', {});
      await send(tabId, 'Debugger.enable', {});
    } catch (error) {
      sessions.delete(tabId);
      await detach(tabId).catch(() => {});
      return { status: 'failed', retryable: true, reason: 'debugger_domain_enable_failed', dispatched: false,
        message: `The debugger attached but enabling its domains failed: ${error?.message ?? 'unknown error'}. It was detached again.` };
    }
    return { status: 'success', reused: false, session: describe(session),
      note: 'Chrome now shows a debugging banner on this tab and DevTools cannot attach to it until this session is closed.' };
  }

  async function close({ tabId, reason = 'requested' } = {}) {
    const session = sessions.get(tabId);
    if (!session) return { status: 'not_dispatched', retryable: false, closed: false, reason: 'no_debugger_session', dispatched: false };
    return await shutdown(session, reason);
  }

  function get(tabId) {
    const session = sessions.get(tabId);
    return session && !session.closed ? session : null;
  }

  // Lets screenshot, capture and metrics reuse an open session instead of
  // failing with "another debugger is already attached".
  function activeSend(tabId) {
    const session = get(tabId);
    return session ? (method, params = {}) => send(tabId, method, params) : null;
  }

  function handleEvent(tabId, method, params = {}) {
    const session = get(tabId);
    if (!session) return;
    session.lastUsedAt = now();
    if (method === 'Debugger.scriptParsed') {
      const scriptId = params.scriptId;
      if (typeof scriptId !== 'string') return;
      session.scripts.set(scriptId, {
        scriptId,
        url: clampText(params.url ?? '', 300),
        startLine: Number.isSafeInteger(params.startLine) ? params.startLine + 1 : null,
        endLine: Number.isSafeInteger(params.endLine) ? params.endLine + 1 : null
      });
      while (session.scripts.size > MAX_SCRIPTS) session.scripts.delete(session.scripts.keys().next().value);
      return;
    }
    if (method === 'Debugger.breakpointResolved') {
      const record = [...session.breakpoints.values()].find(entry => entry.breakpointId === params.breakpointId);
      if (record) {
        record.resolved = true;
        record.locations = [{ lineNumber: (params.location?.lineNumber ?? 0) + 1, columnNumber: (params.location?.columnNumber ?? 0) + 1 }];
      }
      return;
    }
    if (method === 'Debugger.paused') {
      const callFrames = Array.isArray(params.callFrames) ? params.callFrames.slice(0, MAX_FRAMES) : [];
      session.paused = {
        reason: clampText(params.reason ?? 'other', 60),
        hitBreakpoints: Array.isArray(params.hitBreakpoints) ? params.hitBreakpoints.slice(0, 8) : [],
        callFrames,
        at: now(),
        lastTouchedAt: now()
      };
      session.hits.push({
        at: now(), reason: session.paused.reason,
        hitBreakpoints: session.paused.hitBreakpoints,
        topFrame: callFrames[0] ? summarizeFrame(callFrames[0], 0) : null
      });
      while (session.hits.length > MAX_HITS) session.hits.shift();
      cancelSchedule?.(session.pausedTimer);
      // Backstop only. sweep() is the deterministic path; this timer exists so a
      // paused tab recovers even if nothing calls into the bridge again.
      session.pausedTimer = schedule(() => { autoResume(session); }, pausedTtlMs);
      session.pausedTimer?.unref?.();
      return;
    }
    if (method === 'Debugger.resumed') {
      cancelSchedule?.(session.pausedTimer);
      session.pausedTimer = null;
      session.paused = null;
    }
  }

  function handleDetach(tabId, reason) {
    const session = sessions.get(tabId);
    if (!session) return null;
    cancelSchedule?.(session.pausedTimer);
    session.pausedTimer = null;
    session.closed = true;
    session.closeReason = `detached:${reason ?? 'unknown'}`;
    sessions.delete(tabId);
    return { tabId, reason: session.closeReason };
  }

  async function sweep() {
    const changes = [];
    for (const session of [...sessions.values()]) {
      if (session.paused && now() - session.paused.lastTouchedAt >= pausedTtlMs) {
        await autoResume(session);
        changes.push({ tabId: session.tabId, autoResumed: true });
        continue;
      }
      if (!session.paused && now() - session.lastUsedAt >= idleTtlMs) {
        await shutdown(session, 'idle_timeout');
        changes.push({ tabId: session.tabId, closed: true, reason: 'idle_timeout' });
      }
    }
    return changes;
  }

  async function call({ tabId, action, args = {} } = {}) {
    await sweep();
    const session = get(tabId);
    if (!session) {
      return { status: 'not_dispatched', retryable: true, reason: 'no_debugger_session', dispatched: false,
        nextPollTool: 'browser_debugger', nextPollArgs: { tabId, action: 'open' },
        recommendedNextAction: 'Open a debugger session on this tab first. Breakpoints do not survive a closed session.' };
    }
    session.lastUsedAt = now();
    const paused = session.paused;
    if (paused) {
      // Any inspection while paused keeps the target paused. The TTL only
      // reclaims a tab nobody is looking at.
      paused.lastTouchedAt = now();
      cancelSchedule?.(session.pausedTimer);
      session.pausedTimer = schedule(() => { autoResume(session); }, pausedTtlMs);
      session.pausedTimer?.unref?.();
    }
    const requirePaused = () => paused ? null : {
      status: 'waiting', retryable: true, reason: 'target_not_paused', dispatched: false,
      nextPollTool: 'browser_debugger', nextPollArgs: { tabId, action: 'status' },
      recommendedNextAction: 'The page is running. Set a breakpoint and trigger it, or call pause, then inspect frames.'
    };

    if (action === 'status') return { status: 'success', session: describe(session) };

    if (action === 'scripts') {
      // A page with 87 scripts pushes its own document script out of a plain
      // "last 60" window, which is exactly the script a caller wants to break
      // on. Filtering is part of the answer, not a convenience: without it the
      // caller cannot discover the URL that set_breakpoint requires.
      const filter = typeof args.urlFilter === 'string' && args.urlFilter.trim()
        ? args.urlFilter.trim().toLowerCase() : null;
      const all = [...session.scripts.values()];
      const matched = filter ? all.filter(item => typeof item.url === 'string' && item.url.toLowerCase().includes(filter)) : all;
      const scripts = matched.slice(-MAX_SCRIPT_LIST);
      return {
        status: 'success',
        count: matched.length,
        totalScripts: all.length,
        urlFilter: filter,
        scripts,
        truncated: matched.length > scripts.length,
        nextStep: filter
          ? 'Pass scripts[].url as scriptUrl to action:"set_breakpoint".'
          : 'No urlFilter was given, so this is the tail of every loaded script. Add urlFilter to find a specific script.'
      };
    }

    if (action === 'set_breakpoint') {
      const url = typeof args.scriptUrl === 'string' ? args.scriptUrl : '';
      const lineNumber = args.lineNumber;
      if (!url || !Number.isSafeInteger(lineNumber) || lineNumber < 1) {
        return { status: 'denied', retryable: false, reason: 'invalid_breakpoint_target', dispatched: false,
          message: 'A breakpoint needs scriptUrl (an exact script URL from action:"scripts") and a 1-based lineNumber.' };
      }
      const result = await send(tabId, 'Debugger.setBreakpointByUrl', {
        url, lineNumber: lineNumber - 1, columnNumber: Number.isSafeInteger(args.columnNumber) ? args.columnNumber - 1 : 0,
        ...(typeof args.condition === 'string' && args.condition ? { condition: args.condition } : {})
      });
      const record = {
        breakpointId: result?.breakpointId ?? null,
        url,
        lineNumber,
        columnNumber: Number.isSafeInteger(args.columnNumber) ? args.columnNumber : null,
        condition: typeof args.condition === 'string' && args.condition ? args.condition : null,
        resolved: Array.isArray(result?.locations) && result.locations.length > 0,
        locations: Array.isArray(result.locations) ? result.locations.map(location => ({ lineNumber: location.lineNumber + 1, columnNumber: location.columnNumber + 1 })) : []
      };
      if (record.breakpointId) session.breakpoints.set(record.breakpointId, record);
      return { status: 'success', breakpoint: record,
        note: record.resolved ? undefined : 'The breakpoint is registered but no loaded script matched yet. It will bind when that script loads.' };
    }

    if (action === 'remove_breakpoint') {
      const breakpointId = typeof args.breakpointId === 'string' ? args.breakpointId : '';
      if (!breakpointId || !session.breakpoints.has(breakpointId)) {
        return { status: 'denied', retryable: false, reason: 'unknown_breakpoint', dispatched: false };
      }
      await send(tabId, 'Debugger.removeBreakpoint', { breakpointId });
      session.breakpoints.delete(breakpointId);
      return { status: 'success', removed: breakpointId, remaining: session.breakpoints.size };
    }

    if (action === 'pause') {
      if (paused) return { status: 'success', alreadyPaused: true, paused: describe(session).paused };
      await send(tabId, 'Debugger.pause', {});
      return { status: 'success', dispatched: true,
        note: 'Pause is asynchronous: poll browser_debugger with action:"status" until paused is not null. A tab with no running script may never pause.' };
    }

    if (action === 'resume') {
      if (!paused) return { status: 'not_dispatched', retryable: false, reason: 'target_not_paused', dispatched: false };
      cancelSchedule?.(session.pausedTimer);
      session.pausedTimer = null;
      session.paused = null;
      await send(tabId, 'Debugger.resume', {});
      return { status: 'success', resumed: true };
    }

    if (['step_over', 'step_into', 'step_out'].includes(action)) {
      const blocked = requirePaused();
      if (blocked) return blocked;
      const method = { step_over: 'Debugger.stepOver', step_into: 'Debugger.stepInto', step_out: 'Debugger.stepOut' }[action];
      cancelSchedule?.(session.pausedTimer);
      session.pausedTimer = null;
      session.paused = null;
      await send(tabId, method, {});
      return { status: 'success', stepped: action,
        note: 'Stepping resumes the target until the next pause. Poll status for the new frames.' };
    }

    if (action === 'frames') {
      const blocked = requirePaused();
      if (blocked) return blocked;
      return { status: 'success',
        pauseReason: paused.reason,
        hitBreakpoints: paused.hitBreakpoints,
        frames: paused.callFrames.map(summarizeFrame),
        truncated: paused.callFrames.length >= MAX_FRAMES,
        contentTrust: 'untrusted webpage data' };
    }

    if (action === 'evaluate') {
      const expression = typeof args.expression === 'string' ? args.expression.slice(0, MAX_EXPRESSION_CHARS) : '';
      if (!expression.trim()) return { status: 'denied', retryable: false, reason: 'empty_expression', dispatched: false };
      if (paused) {
        const index = Number.isSafeInteger(args.frameIndex) ? args.frameIndex : 0;
        const frame = paused.callFrames[index];
        if (!frame) return { status: 'denied', retryable: false, reason: 'frame_index_out_of_range', dispatched: false, frameCount: paused.callFrames.length };
        const result = await send(tabId, 'Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId, expression,
          returnByValue: true, awaitPromise: false, silent: true
        });
        return {
          status: 'success', evaluatedOn: 'call_frame', frameIndex: index,
          value: clampValue(result?.result?.value ?? result?.result?.description ?? ''),
          type: result?.result?.type ?? null,
          exception: result?.exceptionDetails ? clampText(result.exceptionDetails.text ?? '', 400) : null,
          // A debugger evaluation runs with page privileges: it is exactly what a
          // human types in the DevTools Console, and it is not sandboxed.
          pagePrivileged: true,
          contentTrust: 'untrusted webpage data'
        };
      }
      const result = await send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, silent: true });
      return {
        status: 'success', evaluatedOn: 'global',
        value: clampValue(result?.result?.value ?? result?.result?.description ?? ''),
        type: result?.result?.type ?? null,
        exception: result?.exceptionDetails ? clampText(result.exceptionDetails.text ?? '', 400) : null,
        pagePrivileged: true,
        contentTrust: 'untrusted webpage data'
      };
    }

    if (action === 'set_script_source') {
      const scriptId = typeof args.scriptId === 'string' ? args.scriptId.trim() : '';
      if (!scriptId) {
        return { status: 'denied', retryable: false, reason: 'invalid_script_id', dispatched: false,
          message: 'set_script_source needs scriptId: the scriptId that action:"scripts" reports for the script to edit.' };
      }
      if (typeof args.source !== 'string' || !args.source.trim()) {
        return { status: 'denied', retryable: false, reason: 'empty_source', dispatched: false,
          message: 'set_script_source needs source: the complete replacement text for that script. Blank or non-string source is refused rather than sent, because it would blank the script.' };
      }
      if (args.source.length > MAX_SCRIPT_SOURCE_CHARS) {
        return { status: 'denied', retryable: false, reason: 'source_too_large', dispatched: false,
          sourceChars: args.source.length, limit: MAX_SCRIPT_SOURCE_CHARS,
          message: `The replacement source is ${args.source.length} characters, over the ${MAX_SCRIPT_SOURCE_CHARS} limit. It was not truncated: a truncated script would be applied as a corrupt edit.` };
      }
      // Applying is the default; dryRun is only ever what the caller asked for,
      // so the payload can state which of the two happened without guessing.
      const dryRun = args.dryRun === true;
      let result;
      try {
        result = await send(tabId, 'Debugger.setScriptSource', { scriptId, scriptSource: args.source, dryRun });
      } catch (error) {
        // Deliberately not retried. A second attempt cannot distinguish a failed
        // edit from one that already landed, and re-applying a half-applied
        // source edit is not a harmless retry.
        const detail = String(error?.message ?? 'unknown error');
        // Measured, not inferred. Current Chrome answers this command with the
        // ServerError "setScriptSource functionality no longer available", and
        // V8's own inspector returns it from an unconditional stub:
        // src/inspector/v8-debugger-agent-impl.cc,
        // V8DebuggerAgentImpl::setScriptSource -> `return Response::ServerError(
        // "setScriptSource functionality no longer available")` before any
        // parameter is looked at. So no argument combination can make it work,
        // and the reason is reported separately from a generic failure: a caller
        // that sees "set_script_source_failed" would keep trying.
        const removedByV8 = /setScriptSource functionality no longer available/i.test(detail);
        return { status: 'failed', retryable: false,
          reason: removedByV8 ? 'script_edit_removed_by_v8' : 'set_script_source_failed',
          dispatched: true,
          scriptId, dryRun, applied: false, cdpStatus: null, exceptionDetails: null, callFrames: [], frameCount: 0,
          targetPaused: Boolean(paused),
          ...(removedByV8 ? {
            blockedBy: 'v8_inspector',
            blockedCommand: 'Debugger.setScriptSource',
            measuredEvidence: 'V8DebuggerAgentImpl::setScriptSource in src/inspector/v8-debugger-agent-impl.cc returns ServerError("setScriptSource functionality no longer available") unconditionally, and this browser returned exactly that text. Changing scriptId, source or dryRun cannot change the outcome.',
            alternatives: [
              'Runtime.evaluate can redefine a function or a global right now (for example `window.tick = function (n) { return n * 300; }`). That changes what the page runs immediately, but it is a value assignment, not a source edit: the script text, its line numbers and its source map stay as they were.',
              'Page.addScriptToEvaluateOnNewDocument runs a script before the page\'s own scripts on the next navigation, which is a reload, not a live edit.',
              'Fetch.requestPaused + Fetch.fulfillRequest can serve a modified response body for a network resource, which is how DevTools overrides work. It is not implemented here, and it also only takes effect on a new request.'
            ]
          } : {}),
          message: removedByV8
            ? 'Chrome refused Debugger.setScriptSource: V8 has replaced the command with a stub, so live source editing is not reachable over CDP on this browser. Nothing was changed. It was sent once and not retried.'
            : `CDP rejected Debugger.setScriptSource: ${detail}. It was sent once and not retried.`,
          recommendedNextAction: removedByV8
            ? 'Do not send the edit again with different arguments: the command is a stub, so the result cannot change. Use action:"evaluate" to redefine the function for immediate effect, or accept that the source text itself cannot be rewritten.'
            : 'Check that the script still exists with action:"scripts" and whether the page still runs before sending another edit.' };
      }
      const cdpStatus = typeof result?.status === 'string' ? result.status : null;
      // "Ok" is the only status that means CDP accepted the edit. An unknown or
      // missing status is reported as not applied, because a response that did
      // not throw is not proof that anything changed.
      const accepted = cdpStatus === 'Ok';
      const applied = accepted && !dryRun;
      const details = result?.exceptionDetails;
      const exceptionDetails = details ? {
        text: clampText(details.text ?? '', 800),
        lineNumber: Number.isSafeInteger(details.lineNumber) ? details.lineNumber + 1 : null,
        columnNumber: Number.isSafeInteger(details.columnNumber) ? details.columnNumber + 1 : null,
        url: clampText(details.url ?? '', 300)
      } : null;
      const callFrames = Array.isArray(result?.callFrames)
        ? result.callFrames.slice(0, MAX_FRAMES).map(summarizeFrame) : [];
      const payload = {
        status: accepted ? 'success' : 'failed',
        retryable: false,
        dispatched: true,
        scriptId,
        // The envelope "status" above says whether the bridge call succeeded;
        // this is CDP's own status, verbatim, because only it distinguishes a
        // compile error from a blocked edit from an applied one.
        cdpStatus,
        dryRun,
        applied,
        exceptionDetails,
        callFrames,
        frameCount: callFrames.length,
        framesTruncated: Array.isArray(result?.callFrames) && result.callFrames.length > callFrames.length,
        // A source edit against a frozen page is a different situation from one
        // against a running page, and the caller has to know which it got.
        targetPaused: Boolean(paused),
        contentTrust: 'untrusted webpage data'
      };
      if (!accepted) {
        return { ...payload, reason: 'script_edit_not_applied',
          message: exceptionDetails
            ? `CDP did not accept the edit (status "${cdpStatus ?? 'missing'}"): ${exceptionDetails.text} The page still runs its original script.`
            : `CDP did not accept the edit (status "${cdpStatus ?? 'missing'}"). The page still runs its original script.`,
          recommendedNextAction: 'Fix the reported problem and send the edit again, or pass dryRun:true to validate the source before applying it.' };
      }
      return { ...payload,
        note: dryRun
          ? 'dryRun was set, so CDP compiled the source but the page keeps its original script. Repeat the call without dryRun to apply it.'
          : (paused
            ? 'The page is paused at a breakpoint, so the edit landed while execution is frozen. The new source runs after resume.'
            : undefined) };
    }

    return { status: 'denied', retryable: false, reason: 'unsupported_debugger_action', dispatched: false,
      supported: ['status', 'scripts', 'set_breakpoint', 'remove_breakpoint', 'pause', 'resume', 'step_over', 'step_into', 'step_out', 'frames', 'evaluate', 'set_script_source'] };
  }

  async function closeAll(reason = 'shutdown') {
    const results = [];
    for (const session of [...sessions.values()]) results.push(await shutdown(session, reason));
    return results;
  }

  return { open, close, closeAll, get, activeSend, handleEvent, handleDetach, sweep, call, describe,
    list: () => [...sessions.values()].map(describe), size: () => sessions.size };
}

export const DEBUGGER_SESSION_LIMITS = { MAX_SCRIPTS, MAX_SCRIPT_LIST, MAX_HITS, MAX_FRAMES, MAX_RESULT_CHARS, MAX_EXPRESSION_CHARS, MAX_SCRIPT_SOURCE_CHARS };
