import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Diagnostic evidence, not a task-success metric or a claim about exit causes.
export function usageSummary(directory, now = Date.now()) {
  const result = { windowHours: 48, commandRecords: 0, commandErrors: 0,
    extensionErrorRecords: 0, extensionErrorCategories: {}, duplicateExtensionRecords: 0, extensionDroppedRecords: 0, errorCategories: {}, serviceStarts: 0,
    recoveryConnections: 0, unreadableFiles: 0, malformedRows: 0,
    missingFiles: 0, frequentRestarts: false, exitCause: 'unknown' };
  const cutoff = now - 48 * 3600000;
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
  const seen = new Set();
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
    if (row.outcome === 'error') {
      result.commandErrors++;
      const category = typeof row.errorCategory === 'string' && /^[A-Z_]{1,64}$/.test(row.errorCategory) ? row.errorCategory : 'UNKNOWN';
      result.errorCategories[category] = (result.errorCategories[category] ?? 0) + 1;
    }
  }
  for (const row of rows('watchdog.jsonl')) {
    if (row.state === 'starting-service') result.serviceStarts++;
    if (row.state === 'connected') result.recoveryConnections++;
  }
  // Advisory threshold, not proof of a crash or a matched start/recovery pair.
  result.frequentRestarts = result.serviceStarts >= 3;
  return result;
}
