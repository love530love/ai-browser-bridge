import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { errorCategory } from './diagnostics.js';

// Only return aggregate metadata. Never copy captured DOM, screenshots or raw errors.
export function regressionSummary(directory) {
  const summary = { sampled: 0, passed: 0, unexpectedFailures: 0, injectedRuns: 0, unreadable: 0, errorCategories: {} };
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().slice(-20); }
  catch (error) { if (error.code !== 'ENOENT') summary.unreadable++; return summary; }
  for (const entry of entries) {
    try {
      const file = join(directory, entry, 'report.json');
      if (statSync(file).size > 1024 * 1024) { summary.unreadable++; continue; }
      const report = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof report.completed !== 'boolean') { summary.unreadable++; continue; }
      summary.sampled++;
      if (report.faultInjection === 'transparent-overlay-on-local-fixture') { summary.injectedRuns++; continue; }
      if (report.completed) summary.passed++;
      else {
        summary.unexpectedFailures++;
        const category = errorCategory(report.error || report.cleanupError || 'unknown');
        summary.errorCategories[category] = (summary.errorCategories[category] || 0) + 1;
      }
    } catch { summary.unreadable++; }
  }
  return summary;
}
