import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Diagnostic evidence, not a task-success metric or a claim about exit causes.
export function usageSummary(directory, now = Date.now(), { windowHours = 48, topTools = 10 } = {}) {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(windowHours, 24 * 365) : 48;
  const result = { windowHours: hours, commandRecords: 0, commandErrors: 0, uncertainCommands: 0,
    extensionErrorRecords: 0, extensionErrorCategories: {}, duplicateExtensionRecords: 0, extensionDroppedRecords: 0, errorCategories: {}, serviceStarts: 0,
    recoveryConnections: 0, unreadableFiles: 0, malformedRows: 0,
    missingFiles: 0, frequentRestarts: false, exitCause: 'unknown',
    byTool: {}, byHost: {}, slowestTools: [], hostTelemetryNote: null };
  const cutoff = now - hours * 3600000;
  function rows(name) {
    try {
      const file = join(directory, name);
      if (statSync(file).size > 16 * 1024 * 1024) { result.unreadableFiles++; return []; }
      return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).flatMap(line => {
        try {
          const row = JSON.parse(line), time = Date.parse(row?.time);
          if (!Number.isFinite(time)) throw new Error('invalid timestamp');
          return time >= cutoff && time <= now ? [row] : [];
        } catch { result.malformedRows++; return []; }
      });
    } catch (error) {
      if (error.code === 'ENOENT') result.missingFiles++; else result.unreadableFiles++;
      return [];
    }
  }
  const bucket = (map, key) => {
    if (!map[key]) map[key] = { records: 0, errors: 0, uncertain: 0, durations: [] };
    return map[key];
  };
  const note = (map, key, row) => {
    const item = bucket(map, key);
    item.records++;
    if (row.outcome === 'uncertain' || row.resultStatus === 'uncertain') item.uncertain++;
    if (row.outcome === 'error') item.errors++;
    if (Number.isFinite(row.durationMs) && row.durationMs >= 0) item.durations.push(row.durationMs);
  };
  const seen = new Set();
  let rowsWithoutHost = 0;
  for (const row of rows('logs/audit.jsonl')) {
    if (row.tool === 'extension-error') {
      if (row.eventId && seen.has(row.eventId)) { result.duplicateExtensionRecords++; continue; }
      if (row.eventId) seen.add(row.eventId);
      result.extensionErrorRecords++;
      const category = typeof row.errorCategory === 'string' && /^[A-Z_]{1,80}$/.test(row.errorCategory) ? row.errorCategory : 'UNKNOWN';
      result.extensionErrorCategories[category] = (result.extensionErrorCategories[category] ?? 0) + 1;
      result.extensionDroppedRecords = Math.max(result.extensionDroppedRecords, Number.isSafeInteger(row.droppedBeforeSend) ? row.droppedBeforeSend : 0);
      continue;
    }
    result.commandRecords++;
    if (row.outcome === 'uncertain' || row.resultStatus === 'uncertain') result.uncertainCommands++;
    if (row.outcome === 'error') {
      result.commandErrors++;
      const category = typeof row.errorCategory === 'string' && /^[A-Z_]{1,64}$/.test(row.errorCategory) ? row.errorCategory : 'UNKNOWN';
      result.errorCategories[category] = (result.errorCategories[category] ?? 0) + 1;
    }
    const tool = typeof row.tool === 'string' && row.tool ? row.tool.slice(0, 120) : 'unknown';
    const hostId = typeof row.hostId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.hostId) ? row.hostId : null;
    if (!hostId) rowsWithoutHost++;
    note(result.byTool, tool, row);
    note(result.byHost, hostId ?? 'unrecorded', row);
  }
  for (const row of rows('watchdog.jsonl')) {
    if (row.state === 'starting-service') result.serviceStarts++;
    if (row.state === 'connected') result.recoveryConnections++;
  }
  const finish = item => {
    const durations = item.durations.sort((a, b) => a - b);
    const at = fraction => durations.length === 0 ? null
      : Math.round(durations[Math.min(durations.length - 1, Math.max(0, Math.ceil(fraction * durations.length) - 1))]);
    return { records: item.records, errors: item.errors, uncertain: item.uncertain,
      p50Ms: at(0.5), p95Ms: at(0.95), maxMs: durations.length ? Math.round(durations[durations.length - 1]) : null };
  };
  const toolStats = Object.entries(result.byTool).map(([tool, item]) => ({ tool, ...finish(item) }));
  const hostStats = Object.entries(result.byHost).map(([hostId, item]) => ({ hostId, ...finish(item) }));
  result.byTool = Object.fromEntries(toolStats.map(item => [item.tool, item]));
  result.byHost = Object.fromEntries(hostStats.map(item => [item.hostId, item]));
  result.slowestTools = toolStats
    .filter(item => item.p95Ms !== null)
    .sort((a, b) => b.p95Ms - a.p95Ms || b.records - a.records)
    .slice(0, Math.max(1, topTools));
  if (rowsWithoutHost > 0) {
    result.hostTelemetryNote = `${rowsWithoutHost} audit row(s) predate hostId logging and are grouped as "unrecorded"; their host attribution is unknown, not the primary host.`;
  }
  // Advisory threshold, not proof of a crash or a matched start/recovery pair.
  result.frequentRestarts = result.serviceStarts >= 3;
  return result;
}
