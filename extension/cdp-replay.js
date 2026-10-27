// Replay one HTTP request from the page's own context, like DevTools' "Replay XHR".
//
// DevTools can replay because it still holds the recorded request: method, URL,
// headers and body. The bridge does not keep that record (see cdp-capture.js,
// which deliberately drops headers and bodies), so the caller supplies the
// request explicitly. That difference is stated in every result's limitations
// instead of being papered over: this is "send this request again", not "replay
// the request the Network panel showed".
//
// Three decisions are load-bearing:
//
// 1. The request runs through fetch() in the page, not through CDP's network
//    stack. The page's origin, its cookies and its CORS rules are therefore the
//    ones applied, which is what makes a replay representative. The cost is
//    that CORS applies to the replay exactly as it does to the page.
// 2. The fetch is bounded by AbortController. An unbounded fetch that hangs
//    would hold the debugger attachment until the bridge's own job timeout, and
//    the caller would get nothing useful back.
// 3. A timeout is reported as 'uncertain', never as 'failed'. The request may
//    well have reached the server; only the response is missing. Calling that a
//    failure would invite a retry, and a retry of a request that already took
//    effect is a second effect.
//
// For the same reason every result carries retryable:false. Nothing here
// retries, and nothing here can tell "the first one never left" from "the first
// one landed".
//
// The module has no chrome API dependency: CDP arrives through the injected
// send(method, params), which returns the CDP payload and throws on failure.

export const REPLAY_LIMITS = {
  MAX_BODY_CHARS: 100000,
  MAX_HEADER_COUNT: 50,
  MAX_HEADER_VALUE_CHARS: 8192,
  MAX_RESPONSE_PREVIEW_CHARS: 4000,
  MIN_TIMEOUT_MS: 1000,
  MAX_TIMEOUT_MS: 60000
};

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_EXCEPTION_CHARS = 800;

// Only these methods are replayed. Anything else (CONNECT, TRACE, a custom
// verb) has semantics a page fetch cannot express, and fetch would throw.
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// Methods a server is expected to treat as read-only. Used only to label the
// result, never to decide whether to send.
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
// HEAD/GET bodies are dropped or rejected by fetch, so they are refused here
// rather than sent and silently discarded.
const BODYLESS_METHODS = ['GET', 'HEAD'];

// Browsers either ignore these (and the request then differs from what the
// caller asked for) or reject the request outright with an unhelpful TypeError.
// Silent divergence is worse than a refusal, so these are hard errors.
const FORBIDDEN_HEADERS = ['cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'referer'];
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const LIMITATIONS = [
  'This is not a copy of a Network-panel entry: method, URL, headers and body are whatever the caller passed, so they can differ from the request that was originally observed.',
  'The Cookie header is attached by the browser from the current profile and page context. The original request may have carried different cookies, and httpOnly cookies are included here but were never visible to any capture.',
  'Requests signed with a one-time CSRF token, a nonce or a timestamped signature usually fail (typically 4xx) when replayed, because the token was already consumed or has expired.',
  "When response.type is 'opaque' the response is cross-origin without CORS, so status, headers and body are all unreadable; that is a browser rule, not a bridge failure.",
  'A cross-origin replay is subject to the same CORS policy as the page: the browser may send the request and then refuse to expose the response.',
  'redirect:"follow" means the reported response can be the final hop, not the URL that was requested.'
];

// Truncation is always visible in the text itself, so a shortened value can
// never be mistaken for the whole value.
function bounded(value, max = 400) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
}

// Every caller-supplied value is embedded as a JS literal, never concatenated
// into code. Quotes, backslashes and newlines are therefore data. '<' is also
// escaped: it is inert in a JS string, but this keeps the expression safe even
// if it is ever pasted into an HTML context.
function literal(value) {
  return JSON.stringify(value ?? null)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c');
}

function normalizeHeaders(headers) {
  if (headers === undefined || headers === null) return { ok: true, headers: [] };
  let pairs;
  if (Array.isArray(headers)) {
    pairs = headers;
  } else if (typeof headers === 'object') {
    pairs = Object.entries(headers);
  } else {
    return { ok: false, reason: 'invalid_headers', message: 'headers must be an object of name/value pairs or an array of [name, value] pairs.' };
  }
  if (pairs.length > REPLAY_LIMITS.MAX_HEADER_COUNT) {
    return { ok: false, reason: 'too_many_headers',
      message: `${pairs.length} headers were given, over the ${REPLAY_LIMITS.MAX_HEADER_COUNT} limit. Extra headers were not dropped: a request sent with some of its headers removed is not the request that was asked for.` };
  }
  const normalized = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return { ok: false, reason: 'invalid_headers', message: 'Each header must be a [name, value] pair.' };
    }
    const name = String(pair[0] ?? '').trim();
    if (!HEADER_NAME.test(name)) {
      return { ok: false, reason: 'invalid_header_name', message: `"${bounded(name, 80)}" is not a valid header name; fetch would reject the whole request.` };
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.includes(lower)) {
      return { ok: false, reason: 'forbidden_header',
        message: `The "${name}" header cannot be set here: the browser either ignores it or rejects the request with an opaque TypeError. Cookie is attached automatically by credentials:"include", so do not set it by hand. Also rejected: ${FORBIDDEN_HEADERS.join(', ')}.` };
    }
    const value = pair[1] === undefined || pair[1] === null ? '' : String(pair[1]);
    if (value.length > REPLAY_LIMITS.MAX_HEADER_VALUE_CHARS) {
      return { ok: false, reason: 'header_value_too_long',
        message: `Header "${name}" is ${value.length} characters, over the ${REPLAY_LIMITS.MAX_HEADER_VALUE_CHARS} limit. It was not truncated: a shortened header value is a different request.` };
    }
    normalized.push([name, value]);
  }
  return { ok: true, headers: normalized };
}

// Pure: no CDP, no fetch, no I/O. Callers can validate before deciding whether
// to ask the user to confirm a destructive replay.
export function validateReplayRequest({ method, url, headers, body } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'invalid_url', message: 'url is required and must be an absolute http(s) URL.' };
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'invalid_url', message: `"${bounded(url, 200)}" is not an absolute URL. Replay needs the full URL including the scheme, because there is no page-relative base to resolve against.` };
  }
  // Hard red line: a page-context fetch of javascript:/data:/file: would either
  // do nothing useful or reach something the bridge should never reach on the
  // caller's behalf.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme',
      message: `Only http: and https: can be replayed; "${parsed.protocol}" was refused before anything was sent.` };
  }

  let normalizedMethod = 'GET';
  if (method !== undefined && method !== null) {
    if (typeof method !== 'string') {
      return { ok: false, reason: 'unsupported_method', message: 'method must be a string.' };
    }
    normalizedMethod = method.trim().toUpperCase();
    if (!ALLOWED_METHODS.includes(normalizedMethod)) {
      return { ok: false, reason: 'unsupported_method',
        message: `"${bounded(method, 40)}" cannot be replayed. Allowed: ${ALLOWED_METHODS.join(', ')}.` };
    }
  }

  const normalizedHeaders = normalizeHeaders(headers);
  if (!normalizedHeaders.ok) return normalizedHeaders;

  if (body !== undefined && body !== null && typeof body !== 'string') {
    return { ok: false, reason: 'body_must_be_string',
      message: 'body must be a string. Pass the exact request text (JSON, form-encoded or plain) so it is sent byte for byte; an object would be re-serialised by the caller and may not match the original.' };
  }
  const normalizedBody = typeof body === 'string' ? body : null;

  if (normalizedBody && BODYLESS_METHODS.includes(normalizedMethod)) {
    return { ok: false, reason: 'body_not_allowed',
      message: `A ${normalizedMethod} request cannot carry a body: fetch rejects it. Drop the body or use POST/PUT/PATCH.` };
  }
  if (normalizedBody && normalizedBody.length > REPLAY_LIMITS.MAX_BODY_CHARS) {
    return { ok: false, reason: 'body_too_large',
      message: `The body is ${normalizedBody.length} characters, over the ${REPLAY_LIMITS.MAX_BODY_CHARS} limit. It was refused rather than truncated: a shortened body would be a different request.` };
  }

  return { ok: true, method: normalizedMethod, url: parsed.href, headers: normalizedHeaders.headers, body: normalizedBody };
}

function clampTimeout(timeoutMs) {
  const raw = Number(timeoutMs);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(REPLAY_LIMITS.MAX_TIMEOUT_MS, Math.max(REPLAY_LIMITS.MIN_TIMEOUT_MS, Math.round(raw)));
}

function clampPreview(maxResponseChars) {
  const raw = Number(maxResponseChars);
  if (!Number.isFinite(raw)) return REPLAY_LIMITS.MAX_RESPONSE_PREVIEW_CHARS;
  return Math.min(REPLAY_LIMITS.MAX_RESPONSE_PREVIEW_CHARS, Math.max(0, Math.round(raw)));
}

// The page-side half. Written as one expression because Runtime.evaluate takes
// a single string; every input arrives through the embedded literal, and the
// whole thing resolves to a plain object so returnByValue can carry it back.
function buildExpression(request) {
  return `(async () => {
  const req = ${literal(request)};
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, req.timeoutMs);
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === null ? {} : { body: req.body }),
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal
    });
    const allHeaders = [...response.headers];
    const headers = allHeaders.slice(0, req.maxHeaders).map(pair => [
      pair[0],
      pair[1].length > req.maxHeaderChars ? pair[1].slice(0, req.maxHeaderChars) : pair[1]
    ]);
    let bodyText = '';
    // An opaque response has status 0 and no readable headers or body. Reading
    // it throws, so it is skipped and reported as unreadable rather than empty.
    const readable = response.type !== 'opaque' && response.type !== 'opaqueredirect';
    // null, not 0: an unreadable body has an unknown length, not an empty one.
    let bodyLength = null;
    let bodyReadError = null;
    if (readable) {
      try {
        const text = await response.text();
        bodyLength = text.length;
        bodyText = text.length > req.maxResponseChars ? text.slice(0, req.maxResponseChars) : text;
      } catch (error) {
        bodyReadError = String((error && error.message) || error);
      }
    }
    return { aborted: false, timedOut: false, error: null, response: {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      redirected: response.redirected,
      url: response.url,
      type: response.type,
      headers,
      headerCount: allHeaders.length,
      headersTruncated: allHeaders.length > headers.length,
      bodyReadable: readable,
      bodyText,
      bodyLength,
      bodyTruncated: bodyLength !== null && bodyLength > req.maxResponseChars,
      bodyReadError
    } };
  } catch (error) {
    // AbortError is produced by our own timer; anything else is the browser
    // refusing the request (CORS, DNS, offline, mixed content).
    const name = (error && error.name) || '';
    return {
      aborted: timedOut || name === 'AbortError',
      timedOut,
      error: String((error && error.message) || error),
      response: null
    };
  } finally {
    clearTimeout(timer);
  }
})()`;
}

// Number(null) is 0 and Number('') is 0, so a missing number has to be excluded
// explicitly: reporting a missing length as zero would turn "unknown" into
// "empty".
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sideEffectsFor(method) {
  return SAFE_METHODS.includes(method) ? [] : ['a_real_request_was_sent_and_the_server_may_have_acted_on_it'];
}

function crossOriginFor(url, pageUrl) {
  try {
    if (typeof pageUrl !== 'string' || !pageUrl.trim()) return null;
    return new URL(url).origin !== new URL(pageUrl.trim()).origin;
  } catch {
    return null;
  }
}

// Never throws. Every exit is a result object the caller can act on.
export async function replayRequest({ send, method, url, headers, body, timeoutMs, pageUrl, maxResponseChars } = {}) {
  const validated = validateReplayRequest({ method, url, headers, body });
  if (!validated.ok) {
    // Not dispatched: validation runs before the first CDP command.
    return { status: 'denied', retryable: false, reason: validated.reason, message: validated.message,
      dispatched: false, limitations: LIMITATIONS };
  }

  const timeout = clampTimeout(timeoutMs);
  const preview = clampPreview(maxResponseChars);
  const safe = SAFE_METHODS.includes(validated.method);
  const destructive = !safe;
  const sideEffects = sideEffectsFor(validated.method);
  const crossOrigin = crossOriginFor(validated.url, pageUrl);
  const base = {
    method: validated.method, url: validated.url, timeoutMs: timeout,
    destructive, sideEffects, retryable: false, limitations: LIMITATIONS,
    contentTrust: 'untrusted remote response data'
  };

  if (typeof send !== 'function') {
    return { ...base, status: 'failed', reason: 'replay_send_unavailable', dispatched: false,
      message: 'No CDP sender was provided, so nothing was sent.' };
  }

  const expression = buildExpression({
    url: validated.url, method: validated.method, headers: validated.headers,
    body: validated.body, timeoutMs: timeout, maxResponseChars: preview,
    maxHeaders: REPLAY_LIMITS.MAX_HEADER_COUNT, maxHeaderChars: REPLAY_LIMITS.MAX_HEADER_VALUE_CHARS
  });

  let payload;
  try {
    payload = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  } catch (error) {
    // The command was handed to CDP, so the fetch may already have started. The
    // transport failed, not the request: that is 'uncertain', not 'failed'.
    return { ...base, status: 'uncertain', reason: 'replay_cdp_failed', dispatched: true,
      exceptionText: bounded(error?.message ?? error, MAX_EXCEPTION_CHARS),
      message: `The evaluate command failed after it was dispatched: ${bounded(error?.message ?? error, 200) ?? 'unknown error'}. The request may or may not have been sent, so it was not retried.` };
  }

  if (payload?.exceptionDetails) {
    const details = payload.exceptionDetails;
    const text = details.exception?.description ?? details.text ?? '';
    return { ...base, status: 'failed', reason: 'replay_evaluate_failed', dispatched: true,
      exceptionText: bounded(text, MAX_EXCEPTION_CHARS),
      message: 'The page threw before the fetch result could be returned. The request may already have been sent; it was not retried.' };
  }

  const value = payload?.result?.value;
  if (!value || typeof value !== 'object') {
    return { ...base, status: 'failed', reason: 'replay_result_missing', dispatched: true,
      message: 'Runtime.evaluate returned no value object. Absence is not an empty response: the request may still have been sent.' };
  }

  if (value.aborted) {
    return { ...base, status: 'uncertain', reason: 'replay_timeout', dispatched: true,
      timedOut: value.timedOut === true, aborted: true,
      exceptionText: bounded(value.error ?? '', MAX_EXCEPTION_CHARS),
      crossOrigin,
      message: `The fetch was aborted after ${timeout}ms without a response. The request may have reached the server and taken effect, so this is reported as uncertain, not failed, and it was not retried.` };
  }

  if (value.error || !value.response) {
    // A CORS rejection arrives here after the request was already on the wire,
    // which is exactly why it is not reported as "not sent".
    return { ...base, status: 'failed', reason: 'replay_fetch_error', dispatched: true,
      exceptionText: bounded(value.error ?? '', MAX_EXCEPTION_CHARS), crossOrigin,
      message: `fetch rejected the request: ${bounded(value.error ?? 'unknown error', 200) ?? 'unknown error'}. A CORS or mixed-content rejection happens after the request is sent, so a non-safe request may still have reached the server.` };
  }

  const reported = value.response;
  const rawText = typeof reported.bodyText === 'string' ? reported.bodyText : '';
  const bodyText = rawText.length > preview ? rawText.slice(0, preview) : rawText;
  const bodyReadable = reported.bodyReadable !== false;
  const declaredLength = finiteOrNull(reported.bodyLength);
  // An unreadable body keeps a null length. A readable body without a declared
  // length falls back to what was actually received, which is then exact.
  const bodyLength = declaredLength ?? (bodyReadable ? rawText.length : null);
  const bodyTruncated = reported.bodyTruncated === true || (declaredLength !== null && declaredLength > preview);

  return {
    ...base,
    status: 'success',
    dispatched: true,
    // url is what was asked for; requestUrl is what the browser reports as the
    // effective URL after redirect:"follow".
    requestUrl: typeof reported.url === 'string' && reported.url ? reported.url : validated.url,
    redirected: reported.redirected === true,
    crossOrigin,
    crossOriginNote: crossOrigin === true
      ? 'The request body was sent to a third-party origin, and the response is readable only if that origin allows this page to read it.'
      : undefined,
    response: {
      status: finiteOrNull(reported.status),
      statusText: bounded(reported.statusText ?? '', 120) ?? '',
      ok: reported.ok === true,
      redirected: reported.redirected === true,
      url: bounded(reported.url ?? '', 2000),
      type: bounded(reported.type ?? '', 40),
      headers: Array.isArray(reported.headers)
        ? reported.headers.filter(pair => Array.isArray(pair) && pair.length === 2)
          .map(pair => [bounded(pair[0], 120) ?? '', bounded(pair[1], REPLAY_LIMITS.MAX_HEADER_VALUE_CHARS) ?? ''])
        : [],
      headerCount: finiteOrNull(reported.headerCount),
      headersTruncated: reported.headersTruncated === true,
      bodyReadable,
      bodyText,
      bodyLength,
      bodyTruncated,
      bodyReadError: reported.bodyReadError ? bounded(reported.bodyReadError, 300) : null
    },
    httpStatus: finiteOrNull(reported.status),
    note: reported.ok === true
      ? 'A response was received. Whether the server changed anything cannot be known from here.'
      : 'A response was received with a non-2xx status. Replays of signed or tokenised requests commonly land here; the server still received the request.'
  };
}
