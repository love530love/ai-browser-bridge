// Static risk analysis for an HTTP request the bridge is about to send.
//
// The whole point is that this is decidable before anything leaves the process.
// Method and URL are enough to separate "this reads something" from "this
// destroys something", so asking the question costs nothing and answers
// instantly - no request, no CDP, no extension round trip. browser_prepare_request
// exposes the verdict as a planner, and the replay path uses the same function to
// label the result it returns, so the label a caller sees before a send and the
// label it sees after cannot disagree.
//
// Two deliberate limits:
//
// 1. This is a heuristic over method and URL shape, not a model of the server.
//    A GET that deletes and a POST that is pure idempotent bookkeeping both
//    exist. The verdict is therefore a warning level, never a proof, and the
//    result says so instead of implying authority it does not have.
// 2. A pattern hit escalates the level; it never blocks. Blocking on a URL
//    substring would break ordinary work (a page whose path contains "stop"
//    is not necessarily a shutdown endpoint) and the escalation already forces
//    the caller to pass an explicit confirmation string.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DESTRUCTIVE_METHODS = new Set(['DELETE']);

// Matched against path segments rather than the raw URL, so a query parameter
// named "reset" does not make every request look destructive.
const PATH_SIGNALS = [
  { id: 'delete', level: 'destructive',
    pattern: /(^|\/)(delete|destroy|destroyed|terminate|purge|erase|wipe|drop|truncate|destroy-all)(\/|$)/i },
  { id: 'shutdown-or-reset', level: 'destructive',
    pattern: /(^|\/)(shutdown|shut-down|poweroff|power-off|halt|kill|reboot|restart|reset|factory-reset|reinstall)(\/|$)/i },
  { id: 'revoke-or-detach', level: 'destructive',
    pattern: /(^|\/)(revoke|unbind|detach|unlink|deauthorize|deactivate|uninstall|deregister)(\/|$)/i },
  { id: 'stop-or-suspend', level: 'mutating',
    pattern: /(^|\/)(stop|suspend|pause|freeze|archive)(\/|$)/i },
  { id: 'cancel-or-refund', level: 'mutating',
    pattern: /(^|\/)(cancel|refund|chargeback|void|rollback|revert)(\/|$)/i },
  { id: 'publish-or-transfer', level: 'mutating',
    pattern: /(^|\/)(publish|deploy|release|transfer|withdraw|approve|reject|commit|submit|pay|purchase|checkout)(\/|$)/i }
];

// Query parameters that turn an ordinary call into an irreversible one.
const DESTRUCTIVE_QUERY = [
  { id: 'force', pattern: /(^|&)force=(true|1|yes)(&|$)/i },
  { id: 'hard', pattern: /(^|&)(hard|permanent|cascade|purge)=(true|1|yes)(&|$)/i },
  { id: 'skip-confirm', pattern: /(^|&)(skipConfirm|skip_confirm|noConfirm|confirm)=(true|1|yes)(&|$)/i }
];

// The same intent expressed in a body. JSON, form-encoded and query-string
// bodies all land on the same key/value shape, so one pattern covers them.
const DESTRUCTIVE_BODY = [
  { id: 'force-true', pattern: /["']?(force|hard|permanent|cascade|purge|forceDelete|force_delete)["']?\s*[:=]\s*(true|1|["']true["'])/i },
  { id: 'delete-all', pattern: /["']?(deleteAll|delete_all|removeAll|remove_all|purgeAll|purge_all)["']?\s*[:=]\s*(true|1|["']true["'])/i }
];

const LEVEL_ORDER = { safe: 0, mutating: 1, destructive: 2 };

function worse(a, b) {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

function parseUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch { return null; }
}

function pathSegments(parsed) {
  return parsed.pathname.replace(/\/+$/, '');
}

function matchPath(parsed) {
  const path = pathSegments(parsed);
  return PATH_SIGNALS.filter(signal => signal.pattern.test(path));
}

function matchQuery(parsed) {
  const query = parsed.search.replace(/^\?/, '');
  if (!query) return [];
  return DESTRUCTIVE_QUERY.filter(signal => signal.pattern.test(query));
}

function matchBody(body) {
  if (typeof body !== 'string' || !body.trim()) return [];
  return DESTRUCTIVE_BODY.filter(signal => signal.pattern.test(body));
}

function sameOriginOf(url, pageUrl) {
  const page = parseUrl(pageUrl);
  if (!page) return null;
  const target = parseUrl(url);
  if (!target) return null;
  return target.origin === page.origin;
}

// The single entry point. Pure: same inputs, same verdict, no I/O.
export function analyzeRequest({ method, url, headers, body, pageUrl } = {}) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return {
      riskLevel: 'unknown', method: null, methodClass: null, reversible: null,
      requiresConfirmation: true, reasons: ['url_not_http'],
      destructivePatterns: [], bodySignals: [], sameOrigin: null,
      wouldSendCookies: true, dispatched: false, sent: false,
      message: 'Only an absolute http: or https: URL can be analysed. Nothing was sent.',
      contentTrust: 'caller-supplied request description, not server state'
    };
  }

  const normalizedMethod = typeof method === 'string' && method.trim()
    ? method.trim().toUpperCase()
    : 'GET';

  const reasons = [];
  let level = 'safe';

  if (DESTRUCTIVE_METHODS.has(normalizedMethod)) {
    level = 'destructive';
    reasons.push(`method ${normalizedMethod}`);
  } else if (!SAFE_METHODS.has(normalizedMethod)) {
    level = 'mutating';
    reasons.push(`method ${normalizedMethod}`);
  } else {
    reasons.push(`method ${normalizedMethod} is expected to be read-only`);
  }

  const pathHits = matchPath(parsed);
  for (const hit of pathHits) {
    level = worse(level, hit.level);
    reasons.push(`path segment matches "${hit.id}"`);
  }

  const queryHits = matchQuery(parsed);
  for (const hit of queryHits) {
    level = 'destructive';
    reasons.push(`query parameter matches "${hit.id}"`);
  }

  const bodyHits = matchBody(body);
  for (const hit of bodyHits) {
    level = 'destructive';
    reasons.push(`body matches "${hit.id}"`);
  }

  const methodClass = DESTRUCTIVE_METHODS.has(normalizedMethod)
    ? 'destructive'
    : SAFE_METHODS.has(normalizedMethod) ? 'safe' : 'mutating';

  // "Reversible" is a claim about the server, which this function cannot see. It
  // is therefore only ever false - never true - so that the honest answer
  // "probably reversible" is not dressed up as a fact.
  const reversible = level === 'destructive' ? false : null;

  return {
    riskLevel: level,
    method: normalizedMethod,
    methodClass,
    reversible,
    reversibleNote: reversible === false
      ? 'A destructive request is reported as not reversible. Whether this particular server can undo it is unknown here.'
      : 'Reversibility is a property of the server, not of the request shape, so it is reported as null rather than guessed.',
    requiresConfirmation: level !== 'safe',
    reasons,
    destructivePatterns: [...pathHits.map(hit => hit.id), ...queryHits.map(hit => hit.id)],
    bodySignals: bodyHits.map(hit => hit.id),
    sameOrigin: sameOriginOf(parsed.href, pageUrl),
    wouldSendCookies: true,
    url: parsed.href,
    origin: parsed.origin,
    dispatched: false,
    sent: false,
    analysed: 'static analysis of method, path, query and body; no request was sent',
    contentTrust: 'caller-supplied request description, not server state',
    ...(level === 'safe' ? {} : {
      recommendedNextAction: level === 'destructive'
        ? 'Treat this as irreversible. Confirm the exact target and the exact resource id with the user before sending, and pass a verify block so the outcome is read back instead of assumed.'
        : 'A non-safe method can change server state. Send it once, then read the result back with verify rather than assuming it took effect.'
    })
  };
}

// A verify block is the difference between "the request was sent" and "the
// server now reports the state I asked for". It is validated before the write is
// dispatched, because discovering a malformed verify afterwards leaves the
// caller with a completed write and no way to check it.
export function validateVerifySpec(spec) {
  if (spec === undefined || spec === null) return { ok: true, spec: null };
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, reason: 'invalid_verify', message: 'verify must be an object with url, jsonPointer and expect.' };
  }
  const parsed = parseUrl(spec.url);
  if (!parsed) {
    return { ok: false, reason: 'verify_url_invalid', message: 'verify.url must be an absolute http(s) URL that can be read back.' };
  }
  const method = spec.method === undefined ? 'GET' : String(spec.method).toUpperCase();
  // A verification that can change state is a second write wearing the word
  // "verify", and it would run on every poll. Only reads are accepted.
  if (!SAFE_METHODS.has(method)) {
    return { ok: false, reason: 'verify_method_not_read_only',
      message: `verify.method "${method}" is not read-only. Verification polls, so a mutating method here would send the change again on every attempt. Allowed: ${[...SAFE_METHODS].join(', ')}.` };
  }
  const pointer = spec.jsonPointer;
  if (typeof pointer !== 'string' || !pointer.trim()) {
    return { ok: false, reason: 'verify_pointer_missing', message: 'verify.jsonPointer is required: without a location there is nothing to compare. Use "" for the whole document, or "/0/status" for a field.' };
  }
  if (pointer !== '' && !pointer.startsWith('/')) {
    return { ok: false, reason: 'verify_pointer_invalid', message: 'verify.jsonPointer must be an RFC 6901 pointer starting with "/", or "" for the whole document.' };
  }
  if (spec.expect === undefined || spec.expect === null || spec.expect === '') {
    return { ok: false, reason: 'verify_expect_missing', message: 'verify.expect is required: the value the pointer is expected to hold after the write.' };
  }
  if (typeof spec.expect === 'object') {
    return { ok: false, reason: 'verify_expect_not_scalar', message: 'verify.expect must be a scalar (string, number or boolean), compared as text against the value at the pointer.' };
  }
  const pollMs = spec.pollMs === undefined ? 1000 : Number(spec.pollMs);
  if (!Number.isFinite(pollMs) || pollMs < 200 || pollMs > 10000) {
    return { ok: false, reason: 'verify_poll_invalid', message: 'verify.pollMs must be between 200 and 10000.' };
  }
  const maxWaitMs = spec.maxWaitMs === undefined ? 30000 : Number(spec.maxWaitMs);
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < pollMs || maxWaitMs > 120000) {
    return { ok: false, reason: 'verify_wait_invalid', message: 'verify.maxWaitMs must be at least pollMs and at most 120000.' };
  }
  return { ok: true, spec: { url: parsed.href, method, jsonPointer: pointer.trim(), expect: String(spec.expect), pollMs: Math.round(pollMs), maxWaitMs: Math.round(maxWaitMs), headers: spec.headers } };
}

// RFC 6901. Kept here rather than in the extension so the same walk is used by
// the static tests and by the page-side evaluation.
export function readPointer(document, pointer) {
  if (pointer === '' || pointer === undefined || pointer === null) return { found: true, value: document };
  const parts = String(pointer).split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = document;
  for (const part of parts) {
    if (current === null || current === undefined) return { found: false, value: undefined, failedAt: part };
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false, value: undefined, failedAt: part };
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return { found: false, value: undefined, failedAt: part };
    if (!Object.hasOwn(current, part)) return { found: false, value: undefined, failedAt: part };
    current = current[part];
  }
  return { found: true, value: current };
}
