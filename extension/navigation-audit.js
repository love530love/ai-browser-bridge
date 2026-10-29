// Navigation audit.
//
// chrome.webNavigation has no commands at all - only events. That reads like a
// permission with nothing behind it, and it would be one if the events were
// merely forwarded. They are not: they are the only source in the whole platform
// that answers "where did this tab actually go", as opposed to "what URL is in
// the address bar now". A caller that only sees the final URL cannot tell a
// single 200 from a five-hop redirect chain, cannot see a navigation that a
// beforeunload handler cancelled, and cannot see a single-page app rewriting its
// own history without loading anything.
//
// So the capability is the record, not the event. Every listener below appends
// to a bounded per-tab ring buffer, and browser_navigation reads it back three
// ways: a timeline, a redirect chain for one navigation, and a per-tab status.
//
// Bounds are not optional here. onHistoryStateUpdated fires on every pushState,
// which a scrolling feed can do hundreds of times a second, so an unbounded
// buffer would grow until the worker is killed - and a killed worker is a
// disconnected bridge that looks like a broken server.
const MAX_ENTRIES_PER_TAB = 300;
const MAX_TABS = 40;
const MAX_TIMELINE = 200;

const TRACKED_EVENTS = [
  'onBeforeNavigate',
  'onCommitted',
  'onCompleted',
  'onDOMContentLoaded',
  'onErrorOccurred',
  'onBeforeRedirect',
  'onHistoryStateUpdated',
  'onReferenceFragmentUpdated',
  'onCreatedNavigationTarget'
];

function pick(payload) {
  return {
    url: payload?.url ?? null,
    redirectUrl: payload?.redirectUrl ?? null,
    frameId: Number.isInteger(payload?.frameId) ? payload.frameId : null,
    parentFrameId: Number.isInteger(payload?.parentFrameId) ? payload.parentFrameId : null,
    transitionType: payload?.transitionType ?? null,
    transitionQualifiers: Array.isArray(payload?.transitionQualifiers) ? payload.transitionQualifiers.slice(0, 8) : null,
    error: payload?.error ?? null,
    sourceTabId: Number.isInteger(payload?.sourceTabId) ? payload.sourceTabId : null,
    sourceFrameId: Number.isInteger(payload?.sourceFrameId) ? payload.sourceFrameId : null,
    // The browser's own monotonic timestamp, kept alongside the wall clock
    // because a clock change during a run would reorder the timeline.
    timeStamp: typeof payload?.timeStamp === 'number' ? payload.timeStamp : null
  };
}

export function createNavigationAudit({ now = () => Date.now() } = {}) {
  const tabs = new Map();
  const trackedSince = new Date(now()).toISOString();
  let sequence = 0;
  let total = 0;

  function bucket(tabId) {
    let entry = tabs.get(tabId);
    if (!entry) {
      entry = { tabId, entries: [], firstAt: now(), lastAt: null };
      tabs.set(tabId, entry);
      // Oldest tab first. A Map preserves insertion order, and a tab that keeps
      // navigating should not be evicted by a tab that was opened once.
      while (tabs.size > MAX_TABS) {
        const oldest = tabs.keys().next().value;
        if (oldest === tabId) break;
        total -= tabs.get(oldest)?.entries?.length ?? 0;
        tabs.delete(oldest);
      }
    }
    return entry;
  }

  function record(type, payload) {
    if (!Number.isInteger(payload?.tabId) || payload.tabId < 0) return;
    const entry = bucket(payload.tabId);
    const row = { seq: ++sequence, at: now(), type, ...pick(payload) };
    entry.entries.push(row);
    entry.lastAt = row.at;
    total += 1;
    while (entry.entries.length > MAX_ENTRIES_PER_TAB) {
      entry.entries.shift();
      total -= 1;
    }
  }

  let installed = false;
  function install() {
    if (installed) return { installed: false, reason: 'already_installed' };
    const api = globalThis.chrome?.webNavigation;
    if (!api) return { installed: false, reason: 'web_navigation_unavailable' };
    for (const eventName of TRACKED_EVENTS) {
      const event = api[eventName];
      if (typeof event?.addListener !== 'function') continue;
      // A listener that throws would be removed by Chrome, silently ending the
      // audit for the rest of the worker's life. Nothing here is allowed to
      // throw out of the callback.
      event.addListener(payload => {
        try { record(eventName, payload); } catch { /* recording must never break the browser */ }
      });
    }
    installed = true;
    return { installed: true, events: TRACKED_EVENTS.length };
  }

  function rowsFor(tabId) {
    if (Number.isInteger(tabId)) return tabs.get(tabId)?.entries ?? [];
    // No tabId: merge every tab, ordered by the browser's own sequence counter,
    // which is the only ordering that survives a clock change.
    const merged = [];
    for (const entry of tabs.values()) merged.push(...entry.entries);
    merged.sort((a, b) => a.seq - b.seq);
    return merged;
  }

  function filterSince(rows, since) {
    if (since === undefined || since === null) return rows;
    const threshold = typeof since === 'number' ? since : Date.parse(String(since));
    if (!Number.isFinite(threshold)) return rows;
    return rows.filter(row => row.at >= threshold);
  }

  function project(row) {
    const out = { seq: row.seq, at: new Date(row.at).toISOString(), event: row.type, url: row.url };
    if (row.redirectUrl) out.redirectUrl = row.redirectUrl;
    if (row.frameId !== null && row.frameId !== 0) out.frameId = row.frameId;
    if (row.transitionType) out.transitionType = row.transitionType;
    if (row.transitionQualifiers?.length) out.transitionQualifiers = row.transitionQualifiers;
    if (row.error) out.error = row.error;
    if (row.sourceTabId !== null) out.openedByTabId = row.sourceTabId;
    return out;
  }

  // One navigation = the span between a main-frame onBeforeNavigate and the next
  // one. Every redirect hop, every commit and any error inside that span belongs
  // to it, which is why the grouping is by position in the record and not by URL
  // - a site that redirects back to where it started would otherwise merge two
  // navigations into one.
  function navigationsFor(tabId) {
    const rows = rowsFor(tabId);
    const groups = [];
    let current = null;
    for (const row of rows) {
      if (row.type === 'onBeforeNavigate' && (row.frameId === 0 || row.frameId === null)) {
        current = { startedAt: row.at, startUrl: row.url, hops: [], committedUrl: null, completedAt: null, error: null, historyUpdates: 0, transitionType: row.transitionType, seq: row.seq };
        groups.push(current);
        continue;
      }
      if (!current) continue;
      if (row.type === 'onBeforeRedirect') {
        current.hops.push({ from: row.url, to: row.redirectUrl, statusCode: null });
      } else if (row.type === 'onCommitted') {
        current.committedUrl = row.url;
        current.transitionType = row.transitionType ?? current.transitionType;
        // Measured on Chrome 156: an http-to-https upgrade produced no
        // onBeforeRedirect at all - the only evidence of it was
        // transitionQualifiers ["server_redirect"] on the commit. Counting only
        // onBeforeRedirect hops therefore reported "redirects: 0" for a
        // navigation that was demonstrably redirected, which is exactly the kind
        // of confident wrong answer this tool exists to avoid.
        current.commitQualifiers = row.transitionQualifiers ?? null;
      } else if (row.type === 'onCompleted') {
        current.completedAt = row.at;
      } else if (row.type === 'onErrorOccurred') {
        current.error = row.error;
      } else if (row.type === 'onHistoryStateUpdated') {
        current.historyUpdates += 1;
      }
    }
    return groups;
  }

  async function timeline(args) {
    const rows = filterSince(rowsFor(Number.isInteger(args.tabId) ? args.tabId : undefined), args.since);
    const want = Math.min(MAX_TIMELINE, Math.max(1, Number.isFinite(Number(args.limit)) ? Math.trunc(Number(args.limit)) : 50));
    const tail = rows.slice(-want);
    return {
      status: 'success', retryable: false, action: 'timeline',
      trackedSince, recordedEvents: total, trackedTabs: tabs.size,
      tabId: Number.isInteger(args.tabId) ? args.tabId : null,
      returned: tail.length, available: rows.length, truncated: rows.length > tail.length,
      entries: tail.map(project),
      contentTrust: 'untrusted navigation metadata',
      note: 'Events are recorded from the moment this worker started and are bounded per tab; a worker restart starts a new record. A missing entry is an absence of observation, not proof that nothing happened.'
    };
  }

  async function chain(args) {
    if (!Number.isInteger(args.tabId)) {
      return { status: 'denied', retryable: false, action: 'chain', reason: 'tab_id_required', message: 'A redirect chain belongs to one tab. Pass tabId.' };
    }
    const groups = navigationsFor(args.tabId);
    if (!groups.length) {
      return { status: 'success', retryable: false, action: 'chain', tabId: args.tabId, trackedSince, navigations: 0, chain: [], note: 'No main-frame navigation has been observed on this tab since the worker started.' };
    }
    const index = Number.isInteger(args.index) ? Math.max(0, Math.min(groups.length - 1, args.index)) : groups.length - 1;
    const group = groups[index];
    const chain = [{ url: group.startUrl, via: 'navigation_start' }];
    for (const hop of group.hops) {
      // A hop whose "from" does not match the last hop is still kept: a redirect
      // can be triggered by a service worker or a meta refresh, where the
      // recorded from-URL is the request URL rather than the document URL.
      chain.push({ url: hop.to, via: 'redirect', from: hop.from });
    }
    if (group.committedUrl && group.committedUrl !== chain[chain.length - 1].url) chain.push({ url: group.committedUrl, via: 'commit' });
    const qualifiers = group.commitQualifiers ?? null;
    const redirectQualifier = Array.isArray(qualifiers)
      ? qualifiers.filter(item => /redirect/i.test(String(item)))
      : [];
    return {
      status: 'success', retryable: false, action: 'chain', tabId: args.tabId,
      trackedSince, navigations: groups.length, index,
      startUrl: group.startUrl, finalUrl: group.committedUrl ?? group.startUrl,
      // Two independent pieces of evidence, kept apart on purpose: the hops are
      // what onBeforeRedirect recorded, the qualifier is what the commit itself
      // declared. A redirect that Chrome only reports as a qualifier is real and
      // must not read as "no redirects".
      redirects: group.hops.length,
      redirectQualifiers: redirectQualifier.length ? redirectQualifier : null,
      redirected: group.hops.length > 0 || redirectQualifier.length > 0,
      historyUpdates: group.historyUpdates,
      completed: group.completedAt !== null, error: group.error,
      durationMs: group.completedAt !== null ? group.completedAt - group.startedAt : null,
      chain,
      contentTrust: 'untrusted navigation metadata',
      note: 'finalUrl is the last document that committed, which is not necessarily where the browser settled: a single-page app can rewrite it afterwards, and historyUpdates counts those rewrites. redirects counts hops observed through onBeforeRedirect; redirectQualifiers is the commit\'s own claim (for example server_redirect), so redirected:true with redirects:0 means the browser redirected without emitting a per-hop event.'
    };
  }

  async function status(args) {
    const tabId = Number.isInteger(args.tabId) ? args.tabId : null;
    const rows = rowsFor(tabId ?? undefined);
    const lastCommitted = [...rows].reverse().find(row => row.type === 'onCommitted' && (row.frameId === 0 || row.frameId === null)) ?? null;
    const lastError = [...rows].reverse().find(row => row.type === 'onErrorOccurred') ?? null;
    const groups = tabId === null ? [] : navigationsFor(tabId);
    let liveTab = null;
    if (tabId !== null) {
      try { liveTab = await chrome.tabs.get(tabId); } catch { liveTab = null; }
    }
    return {
      status: 'success', retryable: false, action: 'status',
      trackedSince, trackedTabs: tabs.size, recordedEvents: total,
      tabId,
      // null, not false: with no recorded event there is nothing to report, and
      // "no navigation happened" is a claim this module cannot make.
      lastCommittedUrl: lastCommitted?.url ?? null,
      lastCommittedAt: lastCommitted ? new Date(lastCommitted.at).toISOString() : null,
      lastError: lastError ? { error: lastError.error, url: lastError.url, at: new Date(lastError.at).toISOString() } : null,
      navigations: tabId === null ? null : groups.length,
      inFlight: tabId === null ? null : (groups.length ? groups[groups.length - 1].completedAt === null && groups[groups.length - 1].error === null : null),
      browserUrl: liveTab?.url ?? null,
      browserStatus: liveTab?.status ?? null,
      browserPendingUrl: liveTab?.pendingUrl ?? null,
      divergence: liveTab && lastCommitted && liveTab.url && liveTab.url !== lastCommitted.url ? { committed: lastCommitted.url, browser: liveTab.url } : null,
      note: 'divergence means the document that committed is not the URL the tab holds now, which is what a single-page app rewrite looks like. inFlight true means a navigation started and never completed or errored, which is what a cancelled beforeunload looks like.'
    };
  }

  async function clear(args) {
    const tabId = Number.isInteger(args.tabId) ? args.tabId : null;
    let removed = 0;
    if (tabId === null) {
      for (const entry of tabs.values()) removed += entry.entries.length;
      tabs.clear();
    } else {
      removed = tabs.get(tabId)?.entries?.length ?? 0;
      tabs.delete(tabId);
    }
    total = Math.max(0, total - removed);
    return { status: 'success', retryable: false, action: 'clear', tabId, removed, trackedTabs: tabs.size, note: 'Clearing the audit record does not affect the tab. The listeners keep running, so later navigations are still recorded.' };
  }

  const HANDLERS = { timeline, chain, status, clear };

  return {
    install,
    names: new Set(['browser_navigation']),
    trackedSince,
    async run(name, args = {}) {
      if (name !== 'browser_navigation') return null;
      const handler = HANDLERS[args.action ?? 'timeline'];
      if (!handler) {
        return { status: 'denied', retryable: false, reason: 'unknown_action', tool: name, message: `Unknown action "${String(args.action)}"; use timeline, chain, status or clear.` };
      }
      try {
        return await handler(args);
      } catch (error) {
        return { status: 'failed', retryable: false, reason: 'navigation_audit_failed', tool: name, message: String(error?.message ?? error) };
      }
    }
  };
}

export const NAVIGATION_AUDIT_LIMITS = { MAX_ENTRIES_PER_TAB, MAX_TABS, MAX_TIMELINE };
