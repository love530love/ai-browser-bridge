import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LEASE_TOOLS, WRITE_TOOLS } from './leases.js';

// Governance layer. Leases decide *who holds a tab*; policy decides *what a
// named agent may do at all*. Both are answered by the service so every
// transport (MCP, CLI, HTTP) shares one decision point.
//
// Identity is carried by the same `agent` name used for leases. That is honest
// about the threat model: an agent name is an assertion, not a cryptographic
// identity, because all clients share one bearer token. Operators who need real
// enforcement turn on `requireIdentity`, which refuses governed calls that do
// not name an agent, and cap each agent's scopes. Default stays open so a
// single-user installation is unchanged.

export const SCOPES = ['read', 'write', 'lease', 'upload'];
export const DEFAULT_AGENT_SCOPES = ['read', 'write', 'lease'];
const FILE_VERSION = 1;

// One source of truth for "what does this tool need". Derived from the same
// sets the lease guard uses, so a tool can never be lease-governed but policy
// free (or the reverse).
export function requiredScope(name, tool) {
  // browser_tab_lease only reports state; it never changes it. It must stay
  // callable by any reader: it is the nextPollTool returned by every lease
  // conflict, and denying the documented recovery path with the policy that
  // produced the conflict would deadlock the caller.
  if (name === 'browser_tab_lease') return 'read';
  if (LEASE_TOOLS.has(name)) return 'lease';
  if (name === 'browser_upload' || name === 'browser_upload_verified') return 'upload';
  if (WRITE_TOOLS.has(name) || name === 'browser_open') return 'write';
  if (tool?.annotations?.readOnlyHint) return 'read';
  return 'write';
}

const NAVIGATION_TOOLS = new Set(['browser_open', 'browser_navigate']);

function hostAllowed(hostname, allowed) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return allowed.some(entry => {
    const pattern = String(entry).toLowerCase();
    return pattern === '*' || host === pattern || host.endsWith(`.${pattern}`) || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)));
  });
}

function normalize(entry = {}) {
  const scopes = Array.isArray(entry.scopes) ? entry.scopes.filter(scope => SCOPES.includes(scope)) : DEFAULT_AGENT_SCOPES;
  return {
    scopes: [...new Set(scopes)],
    ...(Array.isArray(entry.origins) && entry.origins.length ? { origins: entry.origins.map(String) } : {}),
    ...(Number.isFinite(entry.maxLeaseMs) ? { maxLeaseMs: Math.trunc(entry.maxLeaseMs) } : {}),
    ...(typeof entry.note === 'string' ? { note: entry.note.slice(0, 200) } : {})
  };
}

export function createAgentPolicy({ file = null, requireIdentity = false } = {}) {
  let agents = new Map();
  let loadedMtimeMs = null;

  function persist() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, updatedAt: new Date().toISOString(), agents: Object.fromEntries(agents) }, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // Policy is operational state; a read-only disk must not break the bridge.
    }
  }

  function load() {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const next = new Map();
      for (const [name, entry] of Object.entries(raw?.agents ?? {})) {
        if (typeof name === 'string' && name && entry && typeof entry === 'object') next.set(name, normalize(entry));
      }
      agents = next;
      loadedMtimeMs = mtime();
    } catch {
      agents = new Map();
    }
  }

  function mtime() {
    try { return statSync(file).mtimeMs; } catch { return null; }
  }

  // `node src/cli.js agent set` writes the same file the running service reads.
  // Reload on change so operator edits take effect without a restart.
  function refresh() {
    if (!file) return;
    if (mtime() !== loadedMtimeMs) load();
  }

  function deny(reason, detail) {
    return {
      allowed: false,
      status: 'denied',
      retryable: false,
      reason,
      ...detail,
      recommendedNextAction: reason === 'agent_identity_required'
        ? 'Pass a stable agent name on governed tools, or register the agent with node src/cli.js agent set.'
        : 'Ask the operator to widen this agent scopes with node src/cli.js agent set; retrying will not help.'
    };
  }

  // Returns { allowed: true, ... } or a denial payload the caller returns
  // verbatim. `maxLeaseMs` caps a lease TTL for this agent when present.
  function evaluate({ name, tool, args = {}, agent = null }) {
    refresh();
    const scope = requiredScope(name, tool);
    const identity = typeof agent === 'string' && agent.trim() ? agent.trim() : null;
    if (!identity) {
      if (requireIdentity && scope !== 'read') return deny('agent_identity_required', { tool: name, requiredScope: scope });
      return { allowed: true, scope, agent: null, registered: false, open: true };
    }
    const entry = agents.get(identity);
    if (!entry) {
      // Unregistered but named: stays open so existing multi-agent setups keep
      // working, but the audit row records registered:false so an operator can
      // see which agents are running unpoliced.
      return { allowed: true, scope, agent: identity, registered: false, open: true };
    }
    if (!entry.scopes.includes(scope)) return deny('agent_scope_denied', { tool: name, agent: identity, requiredScope: scope, grantedScopes: entry.scopes });
    if (NAVIGATION_TOOLS.has(name) && entry.origins) {
      const target = args?.url ?? args?.targetUrl ?? null;
      let hostname = null;
      try { hostname = target ? new URL(target).hostname : null; } catch { hostname = null; }
      if (!hostname || !hostAllowed(hostname, entry.origins)) return deny('agent_origin_denied', { tool: name, agent: identity, host: hostname, allowedOrigins: entry.origins });
    }
    return { allowed: true, scope, agent: identity, registered: true, grantedScopes: entry.scopes, ...(entry.maxLeaseMs ? { maxLeaseMs: entry.maxLeaseMs } : {}) };
  }

  load();

  return {
    evaluate,
    requireIdentity: () => requireIdentity,
    get: name => { refresh(); return agents.has(name) ? normalize(agents.get(name)) : null; },
    list: () => { refresh(); return [...agents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => ({ agent: name, ...normalize(entry) })); },
    set: (name, entry) => { agents.set(String(name), normalize(entry)); persist(); loadedMtimeMs = mtime(); return { agent: String(name), ...normalize(agents.get(String(name))) }; },
    remove: name => { const removed = agents.delete(String(name)); if (removed) persist(); return { removed, agent: String(name) }; },
    size: () => { refresh(); return agents.size; }
  };
}
