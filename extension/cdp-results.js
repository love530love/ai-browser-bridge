// chrome.debugger.sendCommand returns the CDP payload directly, not an RPC envelope.
export function evaluatedValue(payload) {
  if (payload?.exceptionDetails) throw new Error('Page diagnostic evaluation failed; no valid data returned.');
  if (!payload?.result || !Object.hasOwn(payload.result, 'value')) throw new Error('Page diagnostic result missing; absence is not an empty dataset.');
  return payload.result.value;
}

export function resourceSummary(payload) {
  const value = evaluatedValue(payload);
  if (!value || !Array.isArray(value.entries)) throw new Error('Invalid resource diagnostic result.');
  const entries = value.entries.map(entry => {
    let name = '[non-http resource]';
    try {
      const url = new URL(entry.name);
      if (['http:', 'https:'].includes(url.protocol)) name = `${url.origin}${url.pathname}`.slice(0, 500);
    } catch { /* Do not return unparsed data URLs or possible credentials. */ }
    return { name, initiatorType: String(entry.initiatorType || '').slice(0, 60),
      duration: Number(entry.duration) || 0, transferSize: Number(entry.transferSize) || 0,
      decodedBodySize: Number(entry.decodedBodySize) || 0, startTime: Number(entry.startTime) || 0 };
  });
  return { entries, count: entries.length, readyState: value.readyState, timeOrigin: value.timeOrigin,
    source: 'current-main-frame-resource-timing-buffer', captureBody: false,
    emptyMeaning: entries.length ? null : 'No entries currently observable in this frame buffer; not proof that no requests occurred.',
    limitations: ['Not a response-body capture.', 'Entries may predate extension attachment; cleared or evicted entries cannot be recovered.', 'Other frames and workers are not enumerated.'],
    redaction: 'URL credentials, query, fragment, headers, cookies, request bodies and response bodies excluded',
    contentTrust: 'untrusted webpage diagnostics' };
}
