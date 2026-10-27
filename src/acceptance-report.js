// Execution evidence, not feature availability or authorization policy.
// Required scenarios cannot silently disappear when a live fixture skips them.
export function acceptanceReport(required, results) {
  if (!Array.isArray(required) || !required.length || new Set(required).size !== required.length ||
      required.some(id => typeof id !== 'string' || !id)) throw new Error('Unique required scenario IDs expected');
  if (!Array.isArray(results)) throw new Error('Scenario results expected');
  const seen = new Map();
  for (const row of results) {
    if (!required.includes(row.id) || seen.has(row.id) || !['passed', 'failed', 'skipped'].includes(row.status)) {
      throw new Error('Unknown, duplicate, or invalid scenario result');
    }
    seen.set(row.id, { id: row.id, status: row.status, ...(row.reason ? { reason: String(row.reason).slice(0, 300) } : {}) });
  }
  const scenarios = required.map(id => seen.get(id) ?? { id, status: 'skipped', reason: 'not_executed' });
  const passed = scenarios.filter(x => x.status === 'passed').length;
  const failed = scenarios.filter(x => x.status === 'failed').length;
  const skipped = scenarios.length - passed - failed;
  const status = failed ? 'failed' : skipped ? 'partial' : 'passed';
  return { status, passed, failed, skipped, total: scenarios.length, scenarios,
    exitCode: status === 'passed' ? 0 : status === 'partial' ? 2 : 1 };
}
