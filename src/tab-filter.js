// Narrowing a tab list on the service side.
//
// Twenty tabs is an ordinary desktop, and reading twenty full objects before
// every task is a cost paid on every call - not to mention the caller scanning
// them by eye for the one tab on the origin it cares about. Filtering here keeps
// the narrowing in one place, and reporting total alongside browserTotal means a
// short list can never be mistaken for the whole browser.
//
// No filter means the reply keeps its original array shape: this is an addition,
// not a new contract, so an existing caller sees exactly what it saw before.

export const TAB_FILTER_FIELDS = ['origin', 'urlContains', 'titleContains', 'fields', 'limit'];

function originOf(url) {
  try { return url ? new URL(url).origin : null; } catch { return null; }
}

export function filterTabs(rows, args = {}) {
  if (!Array.isArray(rows)) return rows;
  if (!TAB_FILTER_FIELDS.some(key => args[key] !== undefined)) return rows;
  const origin = typeof args.origin === 'string' && args.origin.trim()
    ? args.origin.trim().replace(/\/+$/, '')
    : null;
  const urlContains = typeof args.urlContains === 'string' && args.urlContains.trim()
    ? args.urlContains.trim().toLowerCase()
    : null;
  const titleContains = typeof args.titleContains === 'string' && args.titleContains.trim()
    ? args.titleContains.trim().toLowerCase()
    : null;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : null;
  const fields = typeof args.fields === 'string' && args.fields.trim()
    ? args.fields.split(',').map(item => item.trim()).filter(Boolean)
    : null;

  let matched = rows.filter(row => {
    if (!row || typeof row !== 'object') return false;
    // A restricted tab has no URL, so an origin filter excludes it. That is the
    // honest outcome: the origin of a tab this agent may not read is not known
    // here, and guessing it from a title would be worse than dropping it.
    if (origin && originOf(row.url) !== origin) return false;
    if (urlContains && !String(row.url ?? '').toLowerCase().includes(urlContains)) return false;
    if (titleContains && !String(row.title ?? '').toLowerCase().includes(titleContains)) return false;
    return true;
  });
  const total = matched.length;
  if (limit) matched = matched.slice(0, limit);
  const tabs = fields
    ? matched.map(row => {
      const projected = {};
      for (const field of fields) if (Object.hasOwn(row, field)) projected[field] = row[field];
      return projected;
    })
    : matched;

  return {
    status: 'success', retryable: false, tabs,
    total, returned: tabs.length, browserTotal: rows.length,
    filtered: { origin, urlContains, titleContains, fields, limit },
    note: 'Narrowed by this call. total counts the tabs that matched the filter, browserTotal counts every tab the browser listed, so a short list is never the whole browser.'
  };
}
