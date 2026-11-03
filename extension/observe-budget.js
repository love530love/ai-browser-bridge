// browser_observe answered with three sections and a budget that measured one of
// them. Measured on a real page: maxChars:150 returned roughly ten thousand
// characters, because `geometry` repeats `read.elements` and `debug` repeats the
// active element, and neither was ever compared against the budget. A budget that
// covers only the field with the most text is not a budget - it is a promise the
// caller reads and the tool does not keep.
//
// The ladder is ordered by what a caller can least afford to lose, not by what is
// biggest. Refs are what makes the next action possible, so elements go late; a
// form error is the sentence that decides the task, so notices go last; geometry
// and debug are both derivable from read, so they go first.
//
// This is a pure function so it can be tested without a browser. The page side
// builds the sections; the worker applies the limit, because that is the layer
// that can also be unit tested.
const BULKY_DEBUG_KEYS = ['roleCounts', 'visibleOptions', 'comboboxes', 'fileInputs', 'dialogs'];
const ELEMENT_STEPS = [40, 15, 5, 0];
// Constant strings the caller already knows from the tool description. They are
// the last thing to go, and only when the budget cannot be met otherwise.
const CONSTANT_KEYS = ['scope', 'observationTrust', 'sections'];
// Guidance for a caller who has room to read it. Dropping it is what lets a small
// request answer small instead of hitting a fixed floor of prose.
const PROSE_KEYS = ['refLifetime', 'diagnostics'];

// The receipt is not content: counting `trimmed` and `maxChars` against the budget
// would make the budget report itself as an overrun, and the amount trimmed would
// depend on how much had already been trimmed.
const ACCOUNTING = new Set(['payloadChars', 'maxChars', 'trimmed', 'truncated', 'budgetExceeded', 'budgetNote']);
const measure = payload => {
  const content = {};
  for (const [key, value] of Object.entries(payload)) if (!ACCOUNTING.has(key)) content[key] = value;
  return JSON.stringify(content).length;
};

function finish(payload, size, limit, trimmed) {
  return {
    ...payload,
    payloadChars: size,
    maxChars: limit,
    // Nothing disappears silently: the caller is told which sections went, so a
    // missing `geometry` cannot be mistaken for a page with no elements.
    ...(trimmed.length ? { trimmed, truncated: true } : {})
  };
}

export function applyObserveBudget(observation, budget = 16000) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return observation;
  const limit = Number.isFinite(budget) && budget > 0 ? budget : 16000;
  // Shallow copies: trimming must not mutate the object the page returned, because
  // the same observation is also used to build the refs the caller will act on.
  const payload = { ...observation };
  if (payload.read && typeof payload.read === 'object') payload.read = { ...payload.read };
  if (payload.debug && typeof payload.debug === 'object') payload.debug = { ...payload.debug };
  const trimmed = [];
  let size = measure(payload);
  if (size <= limit) return finish(payload, size, limit, trimmed);

  // 1. Geometry: read.elements plus boxes, the most redundant section there is.
  if (payload.geometry) {
    delete payload.geometry;
    trimmed.push('geometry');
    size = measure(payload);
  }
  // 2. The bulky debug lists, biggest first.
  if (size > limit && payload.debug) {
    for (const key of BULKY_DEBUG_KEYS) {
      if (size <= limit) break;
      if (payload.debug[key] === undefined) continue;
      delete payload.debug[key];
      trimmed.push(`debug.${key}`);
      size = measure(payload);
    }
  }
  // 3. Prose and diagnostics, which a caller with a small budget is not reading.
  for (const key of PROSE_KEYS) {
    if (size <= limit) break;
    if (payload.read?.[key] === undefined) continue;
    delete payload.read[key];
    trimmed.push(`read.${key}`);
    size = measure(payload);
  }
  // 4. The rest of debug: it is a second view of the same page.
  if (size > limit && payload.debug) {
    delete payload.debug;
    trimmed.push('debug');
    size = measure(payload);
  }
  // 5. Elements in steps, so the caller keeps as many usable refs as fit.
  if (size > limit && Array.isArray(payload.read?.elements) && payload.read.elements.length) {
    for (const keep of ELEMENT_STEPS) {
      if (size <= limit) break;
      if (payload.read.elements.length <= keep) continue;
      payload.read.elements = payload.read.elements.slice(0, keep);
      trimmed.push(`read.elements:${keep}`);
      size = measure(payload);
    }
  }
  // 6. Text, which a caller can re-read with browser_find_text when it needs it.
  if (size > limit && typeof payload.read?.text === 'string' && payload.read.text.length) {
    for (let i = 0; i < 4 && size > limit; i += 1) {
      const next = Math.max(0, payload.read.text.length - (size - limit) - 40);
      if (next === payload.read.text.length) break;
      payload.read.text = payload.read.text.slice(0, next);
      payload.read.textTrimmed = true;
      size = measure(payload);
    }
    trimmed.push('read.text');
  }
  // 7. Notices are small and decide the task, so they go after everything above.
  if (size > limit && payload.read?.notices?.length) {
    delete payload.read.notices;
    trimmed.push('read.notices');
    size = measure(payload);
  }
  for (const key of CONSTANT_KEYS) {
    if (size <= limit) break;
    if (payload[key] === undefined) continue;
    delete payload[key];
    trimmed.push(key);
    size = measure(payload);
  }
  // A budget below the fixed floor cannot be met by removing data. Say so instead
  // of pretending: a caller that asked for 150 and got 380 needs to know the floor
  // is page identity, not content it can trim further.
  return size <= limit
    ? finish(payload, size, limit, trimmed)
    : { ...finish(payload, size, limit, trimmed), budgetExceeded: true, budgetNote: 'Every removable section was removed and the fixed metadata (url, title, readyState, viewport, counts) still exceeds maxChars. The floor is metadata, not content.' };
}
