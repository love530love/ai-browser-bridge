// A fixed, small answer to "where am I and what can I touch".
//
// browser_read returns everything, which is right for a caller that knows what
// it is looking for and wrong for a weak one: a page dump of several thousand
// characters with twenty element objects is more than a small model can hold,
// so it keeps only the first few lines and acts on those. That is how a correct
// tool produces an incorrect click.
//
// This projection has the same information in a shape that does not grow: a
// short text head, at most a handful of actionable elements, and counts that say
// how much was left out. It never invents a capability - the element list is
// what the page actually exposes, and the closing line only says how to use the
// refs that are there.
const clip = (value, max) => {
  const text = typeof value === 'string' ? value : '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
};

const ACTIONABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);

export function digestState(read, { tabId, maxActions = 8, maxTextChars = 420 } = {}) {
  if (!read || typeof read !== 'object') {
    return { status: 'failed', retryable: true, reason: 'state_unavailable',
      message: 'The page returned nothing to summarise. It may still be loading, or the frame may have been replaced. Read it again before acting.',
      nextStep: { kind: 'diagnose', tool: 'browser_read', arguments: { tabId, mode: 'cheap' }, why: 'A digest needs a reading to summarise.' } };
  }
  const elements = Array.isArray(read.elements) ? read.elements : [];
  const actionable = elements.filter(el => el && !el.disabled && (ACTIONABLE_TAGS.has(el.tag) || el.role));
  const actions = actionable.slice(0, maxActions).map(el => ({
    ref: el.ref,
    tag: el.tag,
    role: el.role ?? null,
    label: clip(el.label, 80) || null,
    ...(el.type ? { type: el.type } : {}),
    // Whether the field holds anything, never what it holds: a digest must not
    // become the one path that echoes what the user typed.
    ...(el.value ? { hasValue: true } : {}),
    ...(el.readOnly ? { readOnly: true } : {})
  }));
  const counts = { elements: elements.length, actionable: actionable.length, shown: actions.length };
  const text = clip(read.text, maxTextChars);
  const truncated = Boolean(read.truncated) || actions.length < actionable.length || (read.text ?? '').length > maxTextChars;
  return {
    status: 'success',
    tabId,
    url: read.url ?? null,
    title: read.title ?? null,
    readyState: read.readyState ?? null,
    viewport: read.viewport ?? null,
    text,
    actions,
    counts,
    ...(read.partial ? { partial: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    howToAct: 'Act on these refs with browser_click, browser_fill, browser_select or browser_key. Refs are one-shot: any change to the page invalidates every ref you are holding, so read again after acting instead of reusing one.',
    contentTrust: 'untrusted webpage data'
  };
}
