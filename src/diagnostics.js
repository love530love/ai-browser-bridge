// Categorize without persisting page text, URLs, input values or raw errors.
export function errorCategory(message) {
  if (!message) return null;
  const value = String(message);
  // The injected page script appends this marker (with the ref generation) to
  // its long-standing "Stale element reference" message. Keep the marker as a
  // distinct, structured category so callers can tell a stale ref from a
  // generic stale-sounding error, without changing the older text match.
  if (/\[stale_ref\b/i.test(value)) return 'STALE_REF';
  if (/stale|reference/i.test(value)) return 'STALE_REFERENCE';
  if (/navigation|page changed|loading/i.test(value)) return 'PAGE_TRANSITION';
  if (/covered/i.test(value)) return 'ELEMENT_COVERED';
  if (/allowed|protected|paused/i.test(value)) return 'ACCESS_OR_STATE';
  if (/disconnect|not connected/i.test(value)) return 'DISCONNECTED';
  if (/timed out|timeout/i.test(value)) return 'TIMEOUT';
  if (/debugger/i.test(value)) return 'DEBUGGER_CONFLICT';
  return 'EXECUTION_ERROR';
}
