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

// Six limitation sentences and a dozen response headers are worth reading once
// per session, not once per call. A caller that polls a status endpoint twenty
// times paid for the same disclaimer twenty times, which is context spent on
// nothing. Terse keeps the parts a caller acts on and drops the rest; it never
// drops a field that carries a verdict.
function terseProjection(result) {
  const out = {
    status: result.status,
    retryable: false,
    dispatched: result.dispatched,
    note: 'Terse: limitations, headers and echo fields omitted. Re-run with verbosity:"full" for them.'
  };
  for (const key of ['reason', 'message', 'httpStatus', 'method', 'url', 'destructive', 'crossOrigin', 'timedOut', 'aborted']) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  // Only a redirect makes requestUrl differ from url, and when it does it is the
  // difference between "the response came from where I asked" and "it did not".
  if (result.redirected === true && result.requestUrl && result.requestUrl !== result.url) out.requestUrl = result.requestUrl;
  if (result.response) {
    out.bodyText = result.response.bodyText;
    out.bodyReadable = result.response.bodyReadable;
    out.bodyTruncated = result.response.bodyTruncated;
    out.ok = result.response.ok;
    // Only a real read error is worth a field: a null one is noise on every
    // successful call, which is the whole thing terse exists to remove.
    if (result.response.bodyReadError) out.bodyReadError = result.response.bodyReadError;
  }
  if (result.json !== undefined) out.json = result.json;
  if (result.verify !== undefined) out.verify = result.verify;
  return out;
}

// A JSON body is the common case for the endpoints this is used against, and
// making the caller parse a string the page already had parsed is a pointless
// round of quoting. Only a complete, non-truncated body is parsed: half a
// document is not JSON, and reporting a parse error for a body that was
// deliberately shortened would be a false alarm.
function parseJsonBody(text, truncated) {
  if (truncated || typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
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
async function performRequest({ send, method, url, headers, body, timeoutMs, pageUrl, maxResponseChars } = {}) {
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
  const json = parseJsonBody(bodyText, bodyTruncated);

  return {
    ...base,
    status: 'success',
    dispatched: true,
    // url is what was asked for; requestUrl is what the browser reports as the
    // effective URL after redirect:"follow".
    requestUrl: typeof reported.url === 'string' && reported.url ? reported.url : validated.url,
    redirected: reported.redirected === true,
    crossOrigin,
    ...(json === undefined ? {} : { json }),
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

// ---------------------------------------------------------------------------
// Verification: turn "the request was sent" into "the server reports the state
// that was asked for".
//
// The gap this closes is not convenience. A write's correctness used to live
// entirely in the caller's reasoning: send, then read something else, then
// compare by eye. "It went out but did not take effect" and "it took effect but
// I never checked" look identical from the outside, so the natural failure mode
// is reporting success for a change that never happened.
//
// Three decisions:
//
// 1. The pointer is resolved inside the page, not here. A status document is
//    often longer than the preview cap, and walking a truncated body would
//    report a JSON error for a response that was perfectly fine.
// 2. The read before the write is what makes before/after meaningful. It is a
//    read-only request against an endpoint the caller already named, so it
//    cannot change anything.
// 3. matched:false is a verdict, not a timeout. It means the write was sent and
//    the server does not report the expected state. It is returned with the last
//    observed value and is never a reason to send again.
// ---------------------------------------------------------------------------

// The parameter is named jsonPointer, not pointer, because that is the name the
// spec actually carries. Spelling it "pointer" here while the caller sends
// jsonPointer produced req.pointer === undefined and a TypeError on the first
// real run - the shape looked right and the key did not exist.
function buildVerifyExpression({ url, method, headers, timeoutMs, jsonPointer }) {
  return `(async () => {
  const req = ${literal({ url, method, headers, timeoutMs, pointer: jsonPointer })};
  // Resolved before the request so a malformed pointer is reported as a pointer
  // problem instead of being caught as if the network had failed.
  let parts;
  try {
    parts = req.pointer === '' ? [] : String(req.pointer).split('/').slice(1).map(function (part) {
      return part.replace(/~1/g, '/').replace(/~0/g, '~');
    });
  } catch (error) {
    return { ok: false, httpStatus: 0, found: false, value: null, failedAt: null, parseError: null,
      pointerError: String((error && error.message) || error) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await response.text();
    let parsed = null;
    let parseError = null;
    try { parsed = JSON.parse(text); } catch (error) { parseError = String((error && error.message) || error); }
    let found = false;
    let value = null;
    let failedAt = null;
    if (parseError === null) {
      let current = parsed;
      found = true;
      for (const part of parts) {
        if (current === null || current === undefined) { found = false; failedAt = part; break; }
        if (Array.isArray(current)) {
          const index = Number(part);
          if (!Number.isInteger(index) || index < 0 || index >= current.length) { found = false; failedAt = part; break; }
          current = current[index];
          continue;
        }
        if (typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) { found = false; failedAt = part; break; }
        current = current[part];
      }
      if (found) value = current;
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      httpStatus: response.status,
      found: found,
      value: found && value !== null && value !== undefined ? String(value).slice(0, 300) : null,
      valueType: found ? (value === null ? 'null' : typeof value) : null,
      failedAt: failedAt,
      parseError: parseError,
      bodyLength: text.length,
      bodyHead: text.slice(0, 200)
    };
  } catch (error) {
    return { ok: false, httpStatus: 0, found: false, value: null, failedAt: null, parseError: null,
      transportError: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
})()`;
}

// One read of the verify endpoint. Exported so the worker can take the "before"
// snapshot before the write, in the same debugger session.
//
// errorKind separates two failures that used to look identical. 'expression'
// means the code we injected is wrong (a bad pointer, a typo in the generated
// source) and will be just as wrong on the next attempt, so polling it 30 times
// only spends the caller's deadline. 'network' means the read itself did not
// complete and may succeed on retry.
export async function readVerifyValue(send, spec) {
  let payload;
  try {
    payload = await send('Runtime.evaluate', {
      expression: buildVerifyExpression({ ...spec, timeoutMs: 15000 }),
      awaitPromise: true, returnByValue: true
    });
  } catch (error) {
    return { ok: false, httpStatus: 0, found: false, value: null, errorKind: 'network',
      transportError: bounded(error?.message ?? error, MAX_EXCEPTION_CHARS) };
  }
  if (payload?.exceptionDetails) {
    const details = payload.exceptionDetails;
    return { ok: false, httpStatus: 0, found: false, value: null, errorKind: 'expression',
      transportError: bounded(details.exception?.description ?? details.text ?? 'evaluate threw', MAX_EXCEPTION_CHARS) };
  }
  const value = payload?.result?.value;
  if (!value || typeof value !== 'object') {
    return { ok: false, httpStatus: 0, found: false, value: null, errorKind: 'expression',
      transportError: 'evaluate returned no value object' };
  }
  return value;
}

// Comparison is textual on purpose: the pointer's value is stringified in the
// page, and the service already normalises expect to a string, so a counter
// expecting 1 and a flag expecting true both compare without a type dance.
function observationText(observation) {
  if (!observation || observation.found !== true) return null;
  if (observation.valueType === 'null') return 'null';
  return observation.value;
}

export async function verifyRequest({ send, spec, before = null }) {
  const started = Date.now();
  const deadline = started + spec.maxWaitMs;
  let attempts = 0;
  let last = null;
  let matched = false;
  // At least one read always happens, so a caller that asks for verification
  // gets an observation even when maxWaitMs is shorter than pollMs.
  while (true) {
    attempts += 1;
    last = await readVerifyValue(send, spec);
    matched = observationText(last) === spec.expect;
    if (matched) break;
    // A broken expression or a malformed pointer cannot be fixed by waiting.
    if (last?.errorKind === 'expression' || last?.pointerError) break;
    if (Date.now() + spec.pollMs > deadline) break;
    await new Promise(resolve => setTimeout(resolve, spec.pollMs));
  }
  const elapsedMs = Date.now() - started;
  const beforeValue = before && before.found === true ? before.value : null;
  const beforeReadOk = Boolean(before && before.found === true);
  if (matched) {
    return {
      status: 'verified', matched: true, before: beforeValue, beforeReadOk, after: observationText(last),
      attempts, elapsedMs, jsonPointer: spec.jsonPointer, expect: spec.expect,
      httpStatus: last.httpStatus,
      note: 'The read-back reports the expected value. This is evidence about the endpoint that was read, not proof that every side effect of the write completed.'
    };
  }
  const reason = last?.pointerError ? 'verify_pointer_invalid'
    : last?.transportError ? 'verify_read_failed'
      : last?.parseError ? 'verify_body_not_json'
        : last?.found === false ? 'verify_pointer_not_found'
          : 'verify_expect_not_observed';
  const message = last?.pointerError || last?.errorKind === 'expression'
    ? 'The read-back could not be performed at all: the verify expression itself failed, so this says nothing about whether the write took effect. Fix the pointer or the endpoint and read it again by hand; do not resend the write.'
    : 'The request was sent and the read-back does not report the expected value. Do not send it again on the strength of this result: either the write did not take effect, or the endpoint or pointer is wrong. Read the endpoint or the page again and decide.';
  return {
    status: 'not_matched', matched: false, reason,
    before: beforeValue, beforeReadOk,
    after: observationText(last),
    observed: {
      httpStatus: last?.httpStatus ?? null,
      found: last?.found === true,
      value: observationText(last),
      failedAt: last?.failedAt ?? null,
      parseError: last?.parseError ? bounded(last.parseError, 300) : null,
      transportError: last?.transportError ? bounded(last.transportError, 300) : null,
      pointerError: last?.pointerError ? bounded(last.pointerError, 300) : null,
      bodyHead: last?.bodyHead ?? null
    },
    attempts, elapsedMs, jsonPointer: spec.jsonPointer, expect: spec.expect,
    retryable: false,
    message
  };
}

// The read-only entry point. Same transport as a replay, narrower authority: it
// refuses any method that can change state and any URL outside the tab's own
// origin, which is why it needs no confirmation string. Widening it would turn
// the one ungated network tool into the dangerous one.
//
// verbosity is applied by the wrapper rather than inside, so every return path -
// including the refusals, which carry the longest limitations block - is shaped
// the same way. A terse option that only shortened the happy path would leave the
// caller paying the full overhead exactly when it is being told no.
async function fetchRequestFull({ send, method, url, headers, timeoutMs, maxResponseChars, pageUrl } = {}) {
  const normalized = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
  if (!SAFE_METHODS.includes(normalized)) {
    return { status: 'denied', retryable: false, reason: 'fetch_method_not_read_only', dispatched: false,
      method: normalized, url: typeof url === 'string' ? url : null,
      message: `browser_fetch only reads: ${SAFE_METHODS.join(', ')}. A method that can change server state belongs in browser_replay_request, which requires an explicit confirmation string, so that reading and writing do not sit on the same tier.` };
  }
  const validated = validateReplayRequest({ method: normalized, url, headers });
  if (!validated.ok) {
    return { status: 'denied', retryable: false, reason: validated.reason, message: validated.message, dispatched: false, limitations: LIMITATIONS };
  }
  let pageOrigin = null;
  try { pageOrigin = pageUrl ? new URL(pageUrl).origin : null; } catch { pageOrigin = null; }
  if (!pageOrigin) {
    return { status: 'denied', retryable: false, reason: 'fetch_page_origin_unknown', dispatched: false,
      url: validated.url,
      message: 'The tab does not report an http(s) URL, so same-origin cannot be established. Nothing was sent.' };
  }
  const targetOrigin = new URL(validated.url).origin;
  if (targetOrigin !== pageOrigin) {
    return { status: 'denied', retryable: false, reason: 'fetch_cross_origin_denied', dispatched: false,
      url: validated.url, pageOrigin, targetOrigin,
      message: `browser_fetch is same-origin only: ${targetOrigin} is not ${pageOrigin}. Nothing was sent. A cross-origin read is browser_replay_request, which reports the third-party exposure in its result.` };
  }
  const result = await performRequest({ send, method: normalized, url: validated.url, headers, timeoutMs, maxResponseChars, pageUrl });
  return { ...result, tool: 'browser_fetch', readOnly: true };
}

export async function fetchRequest(options = {}) {
  const result = await fetchRequestFull(options);
  return options.verbosity === 'terse' ? terseProjection(result) : result;
}

export async function replayRequest({ verbosity, ...options } = {}) {
  const result = await performRequest(options);
  return verbosity === 'terse' ? terseProjection(result) : result;
}
