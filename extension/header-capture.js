// Bounded, explicitly-confirmed request-header export for one tab.
//
// This is deliberately not folded into browser_devtools_capture. That tool is a
// diagnostic read that promises no headers, cookies or bodies; turning it into a
// header archive would make every ordinary capture a secret store. This tool
// exists only for the caller that asked for live credentials in so many words,
// and it returns them to that caller without writing them to disk or to the
// service's audit ledger.
//
// The default scope is the tab's own origin. Cross-site request headers are how
// an unrelated analytics or ad call carries a session token, so seeing them
// requires scope:"all" rather than being the default of a header dump.

const MAX_REQUESTS = 50;
const MAX_HEADERS_PER_REQUEST = 80;
const MAX_HEADER_CHARS = 16000;
const MAX_TOTAL_CHARS = 256000;
const MAX_DURATION_MS = 5000;

function bounded(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function hostOf(raw) {
  try { return new URL(String(raw)).host; } catch { return null; }
}

function originOf(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

function displayUrl(raw, includeQuery) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[other scheme]';
    return includeQuery ? bounded(url.href, 4000) : bounded(`${url.origin}${url.pathname}`, 4000);
  } catch { return '[unparsed url]'; }
}

function mergeHeaders(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [name, value] of Object.entries(source)) {
    const key = String(name).toLowerCase();
    target.set(key, { name: String(name), value: bounded(value, MAX_HEADER_CHARS) });
  }
  return target;
}

function headerList(map) {
  return [...map.values()].slice(0, MAX_HEADERS_PER_REQUEST);
}

export async function captureRequestHeaders({
  tabId,
  pageUrl,
  durationMs = 1200,
  maxRequests = 30,
  urlPattern = '',
  scope = 'tab_origin',
  includeQuery = false,
  includeResponseHeaders = false,
  send,
  subscribe,
  readUrl,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (typeof send !== 'function' || typeof subscribe !== 'function') {
    throw new Error('captureRequestHeaders requires send and subscribe');
  }
  const windowMs = Math.min(MAX_DURATION_MS, Math.max(0, Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : 1200));
  const cap = Math.min(MAX_REQUESTS, Math.max(1, Number.isFinite(Number(maxRequests)) ? Math.round(Number(maxRequests)) : 30));
  const allowedOrigin = scope === 'all' ? null : originOf(pageUrl);
  if (scope !== 'all' && !allowedOrigin) {
    return {
      status: 'denied', retryable: false, reason: 'tab_origin_unavailable', dispatched: false,
      message: 'The tab URL has no http(s) origin, so the default same-origin scope cannot be applied. Use an http(s) tab, or pass scope:"all" deliberately.'
    };
  }
  const allowedPath = scope === 'current_page' ? displayUrl(pageUrl, false) : null;
  const pattern = typeof urlPattern === 'string' ? urlPattern.trim().toLowerCase() : '';
  const requests = new Map();
  const startedAt = Date.now();
  let totalChars = 0;
  let dropped = 0;
  let partial = false;

  const keep = rawUrl => {
    const origin = originOf(rawUrl);
    if (!origin) return false;
    if (allowedOrigin && origin !== allowedOrigin) return false;
    if (allowedPath && displayUrl(rawUrl, false) !== allowedPath) return false;
    if (pattern && !String(rawUrl).toLowerCase().includes(pattern)) return false;
    return true;
  };

  const recordFor = (requestId, rawUrl, extra = {}) => {
    const existing = requests.get(requestId);
    if (existing) return existing;
    if (requests.size >= cap) { dropped += 1; partial = true; return null; }
    const record = {
      requestId: bounded(requestId, 80),
      url: displayUrl(rawUrl, includeQuery),
      host: hostOf(rawUrl),
      method: null,
      resourceType: null,
      headers: new Map(),
      response: null,
      truncatedHeaders: false,
      ...extra
    };
    requests.set(requestId, record);
    return record;
  };

  const unsubscribe = subscribe((method, params = {}) => {
    if (method === 'Network.requestWillBeSent') {
      const requestId = bounded(params.requestId, 80);
      const rawUrl = params.request?.url;
      if (!requestId || !rawUrl || !keep(rawUrl)) return;
      const record = recordFor(requestId, rawUrl);
      if (!record) return;
      // A redirect reuses requestId; the newest request is the one whose headers
      // are current, so replace rather than merge stale credentials.
      record.method = bounded(params.request?.method, 20);
      record.resourceType = bounded(params.type, 30);
      record.headers = new Map();
      mergeHeaders(record.headers, params.request?.headers);
      return;
    }
    if (method === 'Network.requestWillBeSentExtraInfo') {
      const requestId = bounded(params.requestId, 80);
      const record = requests.get(requestId);
      if (!record) return;
      mergeHeaders(record.headers, params.headers);
      if (record.headers.size > MAX_HEADERS_PER_REQUEST) {
        record.truncatedHeaders = true;
        record.headers = new Map([...record.headers].slice(0, MAX_HEADERS_PER_REQUEST));
      }
      return;
    }
    if (method === 'Network.responseReceived' && includeResponseHeaders) {
      const requestId = bounded(params.requestId, 80);
      const record = requests.get(requestId);
      if (!record) return;
      const headers = new Map();
      mergeHeaders(headers, params.response?.headers);
      record.response = {
        status: Number.isFinite(params.response?.status) ? params.response.status : null,
        mimeType: params.response?.mimeType ?? null,
        headers: headerList(headers),
        headersTruncated: headers.size > MAX_HEADERS_PER_REQUEST
      };
    }
  });

  try {
    await send('Network.enable');
    if (windowMs > 0) await sleep(windowMs);
    const afterUrl = typeof readUrl === 'function' ? await readUrl().catch(() => null) : null;
    const targetChanged = typeof afterUrl === 'string' && typeof pageUrl === 'string' && afterUrl !== pageUrl;

    const output = [];
    for (const record of requests.values()) {
      const headers = headerList(record.headers);
      const payload = {
        requestId: record.requestId,
        url: record.url,
        host: record.host,
        method: record.method,
        resourceType: record.resourceType,
        headers,
        headersTruncated: record.truncatedHeaders || record.headers.size > headers.length,
        ...(record.response ? { response: record.response } : {})
      };
      const chars = JSON.stringify(payload).length;
      if (totalChars + chars > MAX_TOTAL_CHARS) { dropped += 1; partial = true; break; }
      totalChars += chars;
      output.push(payload);
    }

    return {
      status: 'success', retryable: false, dispatched: false,
      tabId,
      secrets: true,
      scope,
      origin: allowedOrigin,
      urlPattern: pattern || null,
      includeQuery,
      includeResponseHeaders,
      window: { requestedMs: windowMs, elapsedMs: Date.now() - startedAt },
      requestCount: output.length,
      requests: output,
      dropped,
      partial: partial || targetChanged,
      partialReasons: [
        ...(dropped ? ['request_or_byte_limit_reached'] : []),
        ...(targetChanged ? ['target_url_changed_during_window'] : [])
      ],
      limits: { maxRequests: cap, maxHeadersPerRequest: MAX_HEADERS_PER_REQUEST, maxTotalChars: MAX_TOTAL_CHARS, maxDurationMs: MAX_DURATION_MS },
      noPersistence: true,
      contentTrust: 'untrusted http request metadata; header values are live credentials',
      negativeEvidence: [
        'Only requests emitted after Network.enable are visible; an empty list is not proof that no request happened.',
        'Only this tab target is observed; other tabs, workers and service workers are separate targets.',
        'The default scope is the tab origin. Cross-site requests are absent unless scope:"all" was requested.',
        'Request bodies are never captured. Response headers are absent unless includeResponseHeaders:true.',
        'Credentials in these values are returned to the caller only: this tool does not write them to disk or to the service audit ledger.'
      ],
      recommendedNextAction: 'Treat every header value as a live secret: do not copy it into a report, a page, a log or another service. Close the debugging session with browser_debugger action:"close" when finished if this call opened one.'
    };
  } catch (error) {
    return {
      status: 'failed', retryable: true, reason: 'header_capture_failed', dispatched: false,
      tabId, message: String(error?.message ?? error), secrets: true, noPersistence: true
    };
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
  }
}

export const HEADER_CAPTURE_LIMITS = { MAX_REQUESTS, MAX_HEADERS_PER_REQUEST, MAX_HEADER_CHARS, MAX_TOTAL_CHARS, MAX_DURATION_MS };
