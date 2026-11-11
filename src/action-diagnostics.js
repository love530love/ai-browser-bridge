// Pure, dependency-free helpers for deciding whether an action actually had an
// effect. They never read page content, URLs or input values, and they never
// emit secrets into logs. The wiring into extension/page.js, src/tools.js and
// extension/worker.js is done by the caller, not here.

export const EFFECTS = Object.freeze([
  'dom', 'network', 'download', 'dialog', 'none', 'unknown'
]);

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const measured = (value) => (isNumber(value) ? value : undefined);

// Decides what kind of side effect the evidence points at. Missing/undefined
// fields stay unknown: they are never fabricated into zeros. Only a complete,
// all-zero observation is honest enough to be called 'none'.
export function classifyEffect(evidence) {
  const e = (evidence && typeof evidence === 'object') ? evidence : {};
  if (e.observed === false) return 'unknown';

  const domDelta = measured(e.domDelta);
  const requests = measured(e.requests);
  const fileInputs = measured(e.fileInputs);
  const downloads = measured(e.downloads);
  const dialogs = measured(e.dialogs);
  const values = [domDelta, requests, fileInputs, downloads, dialogs];

  if (downloads !== undefined && downloads > 0) return 'download';
  if (dialogs !== undefined && dialogs > 0) return 'dialog';
  if (requests !== undefined && requests > 0) return 'network';
  if ((domDelta !== undefined && domDelta > 0) || (fileInputs !== undefined && fileInputs > 0)) return 'dom';

  if (values.every((value) => value !== undefined)) return 'none';
  return 'unknown';
}

const WHITELIST = new Set([
  'xhr', 'fetch', 'dom', 'file-input', 'console', 'download', 'dialog'
]);

// A run of hex characters that looks like a token, or a Bearer credential, is
// replaced before it can reach a log. The whole detail is then clamped to 200
// characters. Both replacements run unconditionally; replace() is idempotent.
const HEX_TOKEN = /[0-9a-fA-F]{16,}/g;
const BEARER = /Bearer\s*\S*/gi;

function sanitizeDetail(detail) {
  let text = typeof detail === 'string'
    ? detail
    : (detail === undefined || detail === null ? '' : String(detail));
  text = text.replace(BEARER, '[redacted]').replace(HEX_TOKEN, '[redacted]');
  return text.slice(0, 200);
}

const zeroCounts = () => ({
  xhr: 0, fetch: 0, dom: 0, fileInputs: 0,
  consoleErrors: 0, downloads: 0, dialogs: 0
});

export function summarizeDiagnoseFlow(events, limit = 5) {
  if (!Array.isArray(events)) {
    return { recent: [], counts: zeroCounts(), effect: 'unknown' };
  }

  const counts = zeroCounts();
  const recentSource = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    switch (event.type) {
      case 'xhr': counts.xhr++; break;
      case 'fetch': counts.fetch++; break;
      case 'dom': counts.dom++; break;
      case 'file-input': counts.fileInputs++; break;
      case 'console': counts.consoleErrors++; break;
      case 'download': counts.downloads++; break;
      case 'dialog': counts.dialogs++; break;
      default: break;
    }
    if (WHITELIST.has(event.type)) {
      recentSource.push({
        type: event.type,
        detail: sanitizeDetail(event.detail),
        at: event.at
      });
    }
  }

  const parsedLimit = limit == null ? 5 : Number(limit);
  const max = Number.isFinite(parsedLimit) && parsedLimit >= 0
    ? Math.trunc(parsedLimit)
    : 5;
  const recent = recentSource
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, max);

  const effect = classifyEffect({
    domDelta: counts.dom + counts.fileInputs,
    requests: counts.xhr + counts.fetch,
    fileInputs: counts.fileInputs,
    downloads: counts.downloads,
    dialogs: counts.dialogs,
    observed: true
  });

  return { recent, counts, effect };
}

export function summarizeDialogFlow(before, after) {
  const b = (before && typeof before === 'object') ? before : {};
  const a = (after && typeof after === 'object') ? after : {};
  const number = (value) => (isNumber(value) ? value : 0);
  const delta = (key) => Math.max(0, number(a[key]) - number(b[key]));

  return {
    fileInputs: delta('fileInputs'),
    requests: delta('requests'),
    domDelta: delta('domNodes'),
    downloads: delta('downloads'),
    consoleErrors: delta('consoleErrors')
  };
}

export function makeRefGeneration(ref, generation) {
  const validRef = typeof ref === 'string' && ref.length > 0;
  const validGeneration = isNumber(generation) && Number.isInteger(generation) && generation >= 0;
  if (!validRef || !validGeneration) throw new Error('Invalid ref generation');
  return ref + '#g' + generation;
}

// A tagged ref is only live when its generation exactly matches the current
// one. Anything malformed, or an unusable current generation, is treated as
// stale: clicking a possibly-old node silently is worse than refusing it.
export function isStaleRef(tagged, currentGeneration) {
  if (typeof tagged !== 'string') return true;
  const match = /^(.+)#g(\d+)$/.exec(tagged);
  if (!match) return true;
  const generation = Number(match[2]);
  if (String(generation) !== match[2]) return true;
  if (!isNumber(currentGeneration) || !Number.isInteger(currentGeneration) || currentGeneration < 0) return true;
  return generation !== currentGeneration;
}
