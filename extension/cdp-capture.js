// Read-only DevTools-equivalent capture over one CDP attachment.
//
// A debugger attachment only receives events emitted after a domain is
// enabled, so every result carries its observation window and never implies
// that earlier activity was seen. Buffers are bounded and overflow is counted,
// never silently discarded.

export const CAPTURE_DOMAINS = ['console', 'network', 'scripts', 'metrics'];
const MAX_STRING = 400;
const MAX_BYTES = 65536;
const MAX_EVENTS = 200;
const MAX_DURATION_MS = 5000;
const MAX_METRICS = 40;

// DevTools Console shows these as distinct levels; anything else is reported as
// "other" instead of being mapped onto a level the page never used.
const CONSOLE_LEVELS = {
  log: 'log', info: 'info', warning: 'warning', error: 'error', debug: 'debug',
  assert: 'error', trace: 'trace', dir: 'dir', dirxml: 'dir', table: 'table',
  count: 'count', timeEnd: 'log', group: 'group', groupCollapsed: 'group', groupEnd: 'group'
};

function bounded(value, max = MAX_STRING) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function countOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Credentials, query strings, fragments and non-http payloads are excluded so a
// capture cannot become a secret exfiltration channel.
export function safeResourceUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol === 'data:' || url.protocol === 'blob:') return '[inline resource]';
    if (!['http:', 'https:', 'ws:', 'wss:', 'chrome-extension:', 'file:'].includes(url.protocol)) return '[other scheme]';
    return bounded(`${url.protocol}//${url.host}${url.pathname}`, 300);
  } catch {
    return '[unparsed url]';
  }
}

// Console arguments are summarised by type on purpose: serialising object
// contents would turn a diagnostic read into a credential dump.
function consoleText(args) {
  if (!Array.isArray(args) || !args.length) return null;
  const parts = args.slice(0, 20).map(arg => {
    if (!arg || typeof arg !== 'object') return null;
    if (arg.type === 'string') return bounded(arg.value);
    if (arg.type === 'number' || arg.type === 'boolean') return String(arg.value);
    if (arg.subtype === 'null') return 'null';
    if (arg.subtype === 'undefined') return 'undefined';
    if (arg.type === 'function') return bounded(arg.description, 120) ?? '[function]';
    if (arg.type === 'symbol') return bounded(arg.description, 120) ?? '[symbol]';
    if (arg.subtype === 'error') return bounded(arg.description, 200) ?? '[error]';
    if (arg.type === 'object') {
      const label = arg.subtype && arg.subtype !== 'object' ? bounded(arg.subtype, 20) : 'object';
      return `[${label ?? 'object'}]`;
    }
    return `[${bounded(arg.type, 20) ?? 'value'}]`;
  }).filter(Boolean);
  return parts.length ? bounded(parts.join(' '), MAX_STRING) : null;
}

export function createRecorder({ maxEvents = 100, maxBytes = MAX_BYTES } = {}) {
  const startedAt = Date.now();
  const network = new Map();
  const scriptIds = new Set();
  const counts = { console: 0, exception: 0, log: 0, script: 0, network: 0 };
  let metrics = null;
  let bytes = 0;
  let dropped = 0;
  let truncated = false;

  function sink(cap = maxEvents) {
    const items = [];
    let overflow = 0;
    return {
      add(record) {
        const size = JSON.stringify(record).length;
        if (items.length >= cap || bytes + size > maxBytes) { overflow++; dropped++; truncated = true; return false; }
        items.push(record); bytes += size; return true;
      },
      get items() { return items; },
      get overflow() { return overflow; }
    };
  }

  const messages = sink();
  const requests = sink();
  const scripts = sink();

  return {
    handle(method, params = {}) {
      switch (method) {
        case 'Runtime.consoleAPICalled': {
          counts.console++;
          const frame = params.stackTrace?.callFrames?.[0];
          messages.add({ kind: 'console', level: CONSOLE_LEVELS[params.type] ?? 'other',
            rawType: bounded(params.type, 40), text: consoleText(params.args),
            url: frame?.url ? safeResourceUrl(frame.url) : null, line: countOrNull(frame?.lineNumber),
            atMs: Date.now() - startedAt });
          return;
        }
        case 'Runtime.exceptionThrown': {
          counts.exception++;
          const details = params.exceptionDetails ?? {};
          const frame = details.stackTrace?.callFrames?.[0];
          messages.add({ kind: 'exception', level: 'error',
            text: bounded(details.exception?.description, 600) ?? bounded(details.text),
            url: details.url ? safeResourceUrl(details.url) : (frame?.url ? safeResourceUrl(frame.url) : null),
            line: countOrNull(details.lineNumber ?? frame?.lineNumber), atMs: Date.now() - startedAt });
          return;
        }
        case 'Log.entryAdded': {
          counts.log++;
          const entry = params.entry ?? {};
          messages.add({ kind: 'log', level: bounded(entry.level, 20) ?? 'info',
            source: bounded(entry.source, 20), text: bounded(entry.text, 600),
            url: entry.url ? safeResourceUrl(entry.url) : null, line: countOrNull(entry.lineNumber),
            atMs: Date.now() - startedAt });
          return;
        }
        case 'Network.requestWillBeSent': {
          counts.network++;
          const id = bounded(params.requestId, 60);
          if (!id) return;
          const prior = network.get(id);
          network.set(id, {
            requestId: id, method: bounded(params.request?.method, 12), resourceType: bounded(params.type, 30),
            url: safeResourceUrl(params.request?.url),
            startedAtMs: countOrNull(params.timestamp) === null ? null : Math.round(Number(params.timestamp) * 1000),
            redirectHops: (prior?.redirectHops ?? 0) + (params.redirectResponse ? 1 : 0),
            status: params.redirectResponse ? countOrNull(params.redirectResponse.status) : null,
            mimeType: params.redirectResponse ? bounded(params.redirectResponse.mimeType, 80) : null,
            fromCache: false, failed: false, canceled: false, blockedReason: null, failureText: null,
            finishedAtMs: null, encodedDataLength: null
          });
          return;
        }
        case 'Network.responseReceived': {
          const record = network.get(bounded(params.requestId, 60));
          if (!record) return;
          record.status = countOrNull(params.response?.status);
          record.mimeType = bounded(params.response?.mimeType, 80);
          record.fromCache = params.response?.fromDiskCache === true || params.response?.fromServiceWorker === true || params.response?.fromPrefetchCache === true;
          return;
        }
        case 'Network.loadingFinished': {
          const record = network.get(bounded(params.requestId, 60));
          if (!record) return;
          const at = countOrNull(params.timestamp);
          record.finishedAtMs = at === null ? null : Math.round(at * 1000);
          record.encodedDataLength = countOrNull(params.encodedDataLength);
          return;
        }
        case 'Network.loadingFailed': {
          const record = network.get(bounded(params.requestId, 60));
          if (!record) return;
          const at = countOrNull(params.timestamp);
          record.failed = true;
          record.canceled = params.canceled === true;
          record.blockedReason = bounded(params.blockedReason, 60);
          record.failureText = bounded(params.errorText, 120);
          record.finishedAtMs = at === null ? null : Math.round(at * 1000);
          return;
        }
        case 'Debugger.scriptParsed': {
          counts.script++;
          const id = bounded(params.scriptId, 60);
          if (!id || scriptIds.has(id)) return;
          scriptIds.add(id);
          scripts.add({ scriptId: id, url: params.url ? safeResourceUrl(params.url) : '[inline script]',
            length: countOrNull(params.length), hasSourceMap: Boolean(params.sourceMapURL),
            isModule: params.isModule === true, language: bounded(params.scriptLanguage, 20) });
          return;
        }
        default:
      }
    },
    setMetrics(list) {
      if (!Array.isArray(list)) return;
      metrics = list.slice(0, MAX_METRICS).map(item => ({ name: bounded(item?.name, 60), value: countOrNull(item?.value) }));
    },
    flush() {
      for (const record of network.values()) {
        const state = record.failed ? 'failed' : record.finishedAtMs === null ? 'pending' : 'completed';
        requests.add({ kind: 'network', ...record, state,
          durationMs: record.startedAtMs === null || record.finishedAtMs === null
            ? null : Math.max(0, record.finishedAtMs - record.startedAtMs) });
      }
      const pending = [...network.values()].filter(record => !record.failed && record.finishedAtMs === null).length;
      return {
        messages: messages.items, network: requests.items, scripts: scripts.items, metrics,
        counts, dropped, truncated, bytes, pendingAtWindowEnd: pending,
        overflow: { messages: messages.overflow, network: requests.overflow, scripts: scripts.overflow }
      };
    }
  };
}

const NEGATIVE_EVIDENCE = [
  'Events emitted before the domain was enabled are invisible; an empty list is not proof that nothing happened.',
  'Only the selected tab target is observed. Other tabs, dedicated workers, service workers and out-of-process iframes are separate targets.',
  'Buffers are bounded; dropped and truncated counters report overflow instead of hiding it.',
  'Network records carry method, URL without query, status, type and timing only: no headers, cookies or bodies.',
  'Console object arguments are summarised by type, not serialised.'
];

// Debugger events are broadcast for every attached target. Without this filter a
// capture could attribute another tab's console output to the tab under test.
export function createTabSubscription(api, tabId) {
  return handler => {
    const listener = (source, method, params) => {
      if (source && source.tabId === tabId) handler(method, params);
    };
    api.onEvent.addListener(listener);
    return () => api.onEvent.removeListener(listener);
  };
}

export async function captureDevtools({ tabId, expectedUrl, requested = ['console', 'network'], durationMs = 800, maxEvents = 100, send, subscribe, readUrl, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const domains = [...new Set(Array.isArray(requested) && requested.length ? requested : ['console', 'network'])];
  const invalid = domains.filter(domain => !CAPTURE_DOMAINS.includes(domain));
  if (invalid.length) throw new Error(`Unsupported capture domain: ${invalid.join(', ')}`);
  if (typeof send !== 'function' || typeof subscribe !== 'function' || typeof readUrl !== 'function') throw new Error('Capture requires send, subscribe and readUrl');

  const windowMs = Math.min(MAX_DURATION_MS, Math.max(0, Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : 800));
  const cap = Math.min(MAX_EVENTS, Math.max(1, Number.isFinite(Number(maxEvents)) ? Math.round(Number(maxEvents)) : 100));
  const recorder = createRecorder({ maxEvents: cap });
  const enable = {
    console: async () => { await send('Runtime.enable'); await send('Log.enable'); },
    network: async () => { await send('Network.enable'); },
    scripts: async () => { await send('Debugger.enable'); },
    metrics: async () => { await send('Performance.enable'); }
  };
  const domainStatus = {};
  const startedAt = Date.now();
  // Subscribing before enabling closes the gap between "attached" and "listening".
  const unsubscribe = subscribe((method, params) => recorder.handle(method, params));
  try {
    for (const domain of domains) {
      try { await enable[domain](); domainStatus[domain] = 'enabled'; }
      catch (error) { domainStatus[domain] = `failed: ${bounded(error?.message ?? error, 120) ?? 'unknown error'}`; }
    }
    const enabled = domains.filter(domain => domainStatus[domain] === 'enabled');
    if (!enabled.length) {
      return { status: 'failed', retryable: true, reason: 'no_capture_domain_enabled', dispatched: false,
        tabId, domains: domainStatus, window: { requestedMs: windowMs, elapsedMs: Date.now() - startedAt },
        messages: [], network: [], scripts: [], metrics: null, counts: {}, dropped: 0, truncated: false, bytes: 0,
        pendingAtWindowEnd: 0, overflow: {}, targetChanged: false, partial: true,
        partialReasons: ['no_capture_domain_enabled'], negativeEvidence: NEGATIVE_EVIDENCE,
        recommendedNextAction: 'The tab may already be owned by another debugger. Observe again with browser_health instead of retrying the capture blindly.' };
    }
    if (windowMs > 0) await sleep(windowMs);
    if (enabled.includes('metrics')) {
      try {
        const payload = await send('Performance.getMetrics');
        if (!Array.isArray(payload?.metrics)) domainStatus.metrics = 'failed: metric payload missing';
        else recorder.setMetrics(payload.metrics);
      } catch (error) { domainStatus.metrics = `failed: ${bounded(error?.message ?? error, 120) ?? 'unknown error'}`; }
    }
    let afterUrl = null;
    try { afterUrl = await readUrl(); } catch { afterUrl = null; }
    const targetChanged = typeof afterUrl === 'string' && typeof expectedUrl === 'string' && afterUrl !== expectedUrl;
    const snapshot = recorder.flush();
    const notEnabled = domains.filter(domain => domainStatus[domain] !== 'enabled');
    const partialReasons = [
      ...(notEnabled.length ? [`domains_not_enabled: ${notEnabled.join(', ')}`] : []),
      ...(targetChanged ? ['target_url_changed_during_window'] : []),
      ...(snapshot.truncated ? ['buffer_limit_reached'] : []),
      ...(afterUrl === null ? ['target_url_unreadable'] : [])
    ];
    return {
      status: 'success', tabId, domains: domainStatus,
      window: { requestedMs: windowMs, elapsedMs: Date.now() - startedAt },
      ...snapshot, targetChanged, partial: partialReasons.length > 0, partialReasons,
      limits: { maxEvents: cap, maxBytes: MAX_BYTES, maxDurationMs: MAX_DURATION_MS },
      negativeEvidence: NEGATIVE_EVIDENCE,
      replayPolicy: 'Read-only capture; re-running is safe, but events from the earlier window cannot be recovered.',
      contentTrust: 'untrusted webpage diagnostics'
    };
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
  }
}
