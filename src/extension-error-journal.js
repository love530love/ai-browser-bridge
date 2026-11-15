import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The bridge already receives extension diagnostics over its own socket:
// extension/error-journal.js stores them, the service writes them to
// logs/audit.jsonl, and they survive a worker teardown. Reading that journal is
// the one error-list verdict that needs no window, no chrome://extensions tab
// and no accessibility engine, so it is the default answer instead of "unknown
// because no Chrome window is reachable".
//
// It is evidence with a scope, not proof of a clean panel: it covers events the
// extension managed to enqueue and send. A crash before the handshake, or an
// error from before the journal existed, is not in it. Callers that need the
// on-screen list itself must ask for includePanel:true.
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 50;

function readRows(file, { sinceCutoff, now }) {
  let size;
  try { size = statSync(file).size; } catch { return { rows: [], malformed: 0, missing: true, oversized: false }; }
  if (size > MAX_BYTES) return { rows: [], malformed: 0, missing: false, oversized: true };
  let text;
  try { text = readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch { return { rows: [], malformed: 0, missing: false, oversized: false, unreadable: true }; }
  let malformed = 0;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const time = Date.parse(row?.time);
      if (!Number.isFinite(time)) throw new Error('invalid timestamp');
      if (time >= sinceCutoff && time <= now) rows.push({ ...row, _time: time });
    } catch { malformed++; }
  }
  return { rows, malformed, missing: false, oversized: false };
}

export function readExtensionErrorJournal(directory, {
  hostId = null, windowHours = 24, since = null, limit = 20, now = Date.now()
} = {}) {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(windowHours, 24 * 365) : 24;
  const sinceMs = Number.isFinite(Date.parse(since)) ? Date.parse(since) : now - hours * 3600000;
  const cutoff = Math.min(sinceMs, now);
  const files = [join(directory, 'audit.1.jsonl'), join(directory, 'audit.jsonl')];
  let malformed = 0;
  let scanned = 0;
  const byEvent = new Map();
  for (const file of files) {
    const result = readRows(file, { sinceCutoff: cutoff, now });
    malformed += result.malformed;
    if (result.oversized) continue;
    for (const row of result.rows) {
      if (row.tool !== 'extension-error') continue;
      scanned++;
      const key = typeof row.eventId === 'string' && row.eventId
        ? `event:${row.eventId}`
        : `row:${row.id ?? `${row._time}:${scanned}`}`;
      // A resent event keeps its eventId; the newest row wins so the record is
      // counted once, not once per delivery attempt.
      const previous = byEvent.get(key);
      if (!previous || previous._time <= row._time) byEvent.set(key, row);
    }
  }
  const all = [...byEvent.values()].sort((a, b) => b._time - a._time);
  const hostRows = hostId ? all.filter(row => row.hostId === hostId) : all;
  const unrecordedHostRows = hostId ? all.filter(row => !row.hostId).length : 0;
  const entries = hostRows.slice(0, Math.max(1, Math.min(limit, MAX_ENTRIES))).map(row => ({
    at: new Date(row._time).toISOString(),
    category: typeof row.errorCategory === 'string' ? row.errorCategory.slice(0, 80) : 'EXTENSION_ERROR',
    source: typeof row.source === 'string' ? row.source.slice(0, 80) : 'extension',
    ...(row.hostId ? { hostId: row.hostId } : {}),
    ...(row.tabId !== null && row.tabId !== undefined ? { tabId: row.tabId } : {})
  }));
  const categories = {};
  for (const row of hostRows) {
    const category = typeof row.errorCategory === 'string' ? row.errorCategory.slice(0, 80) : 'EXTENSION_ERROR';
    categories[category] = (categories[category] ?? 0) + 1;
  }
  const droppedBeforeSend = hostRows.reduce((max, row) => (
    Number.isSafeInteger(row.droppedBeforeSend) ? Math.max(max, row.droppedBeforeSend) : max), 0);
  const state = entries.length > 0 ? 'errors_present' : 'none_recorded';
  return {
    basis: 'bridge-journal',
    panelInspected: false,
    state,
    hasErrors: entries.length > 0,
    count: hostRows.length,
    entries,
    errorEntryNames: Object.keys(categories),
    categories,
    droppedBeforeSend,
    latestAt: entries[0]?.at ?? null,
    windowHours: hours,
    since: new Date(cutoff).toISOString(),
    hostId,
    ...(unrecordedHostRows > 0 ? { unrecordedHostRows } : {}),
    malformedRows: malformed,
    scopeNote: state === 'errors_present'
      ? 'These extension diagnostics were recorded by the bridge itself and need no Chrome window to read. They prove errors occurred; the on-screen panel was not inspected.'
      : 'No extension diagnostic was recorded in this window. This is absence of evidence, not proof that the chrome://extensions panel is empty; ask for includePanel:true when the on-screen list itself must be read.'
  };
}
