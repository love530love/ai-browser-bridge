// Tool-surface discovery.
//
// The bridge has more tools than a weak caller can hold at once. Pull-only
// discovery failed in the field: an agent saw the first batch of tools/list,
// never called the index, and concluded that a capability did not exist. This
// module makes the first batch useful and the rest reachable:
//
//   - a core profile of everyday tools is returned first by tools/list;
//   - every tool remains listed, in its original order after the core;
//   - browser_tool_search searches the complete catalogue by plain language;
//   - browser_tool_schema returns one exact schema;
//   - an unknown tool fails with ranked names and a search nextStep.
//
// Discovery is a map, not a permission gate. Search can return every tool, and
// nothing here denies a capability because of its group or a guessed name.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TOOLS, suggestToolNames } from './tools.js';
import { TOOL_GROUPS, groupsForGoal, TOOL_ALIASES } from './tool-index.js';
import { capabilityGuide } from './capability-guide.js';
import { VERSION } from './version.js';

// Ordered by the shape of a real task, not by implementation history. The two
// discovery tools sit at the top because a caller that sees only these twenty
// names must still be able to reach the other hundred. The same list is the
// first page of tools/list, the core section of browser_agent_guide and the
// default allowedTools for a weak-agent benchmark.
export const CORE_TOOL_PROFILE = [
  'browser_agent_guide',
  'browser_tool_index',
  'browser_tool_search',
  'browser_tool_schema',
  'browser_capability_guide',
  'browser_health',
  'browser_tabs',
  'browser_open',
  'browser_at',
  'browser_read',
  'browser_observe',
  'browser_locate',
  'browser_find_element',
  'browser_find_text',
  'browser_prepare_action',
  'browser_click_verified',
  'browser_fill_verified',
  'browser_navigate_verified',
  'browser_screenshot',
  'browser_failure_help',
  'browser_wait_until_ready',
  'browser_queue_status',
  'browser_agent_advice',
  'browser_claim_tab'
];

const CORE_TOOL_SET = new Set(CORE_TOOL_PROFILE);
const TOOLS_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
const GROUP_BY_TOOL = new Map();
const GROUP_INDEX = new Map();
for (const group of TOOL_GROUPS) for (const [index, name] of group.tools.entries()) {
  GROUP_BY_TOOL.set(name, group.id);
  GROUP_INDEX.set(name, index);
}

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
const TOOLS_PATH = new URL('./tools.js', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

function readDiskVersion() {
  try { return JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version ?? null; } catch { return null; }
}

function toolsMtime() {
  try { return statSync(TOOLS_PATH).mtime.toISOString(); } catch { return null; }
}

const TOOL_SURFACE_HASH = createHash('sha256')
  .update(JSON.stringify(TOOLS.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema }))))
  .digest('hex')
  .slice(0, 16);

// tools/list order: discovery and daily work first, then the rest exactly as
// declared. Every tool is still present, so a client that asks for all of them
// loses nothing; a client that truncates gets the usable page.
export function listToolsOrdered() {
  const core = CORE_TOOL_PROFILE.flatMap(name => {
    const tool = TOOLS_BY_NAME.get(name);
    return tool ? [tool] : [];
  });
  return [...core, ...TOOLS.filter(tool => !CORE_TOOL_SET.has(tool.name))];
}

export function toolSurfaceMeta() {
  const mcpVersion = VERSION;
  const repoVersionOnDisk = readDiskVersion();
  const toolsFileMtime = toolsMtime();
  const startedMs = Date.parse(PROCESS_STARTED_AT);
  const mtimeMs = toolsFileMtime ? Date.parse(toolsFileMtime) : null;
  const staleToolSurface = Boolean(
    (repoVersionOnDisk && repoVersionOnDisk !== mcpVersion) ||
    (mtimeMs !== null && Number.isFinite(startedMs) && mtimeMs > startedMs)
  );
  const meta = {
    status: staleToolSurface ? 'stale' : 'current',
    mcpVersion,
    repoVersionOnDisk,
    mcpProcessStartedAt: PROCESS_STARTED_AT,
    toolsFileMtime,
    toolCount: TOOLS.length,
    toolSurfaceHash: TOOL_SURFACE_HASH,
    coreToolCount: CORE_TOOL_PROFILE.length,
    coreProfile: [...CORE_TOOL_PROFILE],
    listOrder: 'core_profile_then_catalogue',
    discovery: {
      index: 'browser_tool_index',
      search: 'browser_tool_search',
      schema: 'browser_tool_schema',
      capabilityGuide: 'browser_capability_guide',
      searchIsLocal: true,
      allToolsSearchable: true
    },
    staleToolSurface
  };
  if (staleToolSurface) {
    meta.nextStep = {
      kind: 'restart_client',
      action: 'restart_mcp_client',
      why: 'The running MCP process imported an older tool surface than the repository on disk. Restart the client (or its MCP server process) so tools/list and schemas match the code.'
    };
  }
  return meta;
}

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function summary(text, max = 220) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function scoreTool(tool, query, intentTools) {
  const q = normalized(query);
  const name = tool.name.toLowerCase();
  const description = normalized(tool.description);
  const group = GROUP_BY_TOOL.get(tool.name) ?? null;
  const groupEntry = TOOL_GROUPS.find(item => item.id === group);
  // Underscore is a word separator here, not a word character: a caller
  // guessing "browser_make_pdf" must match the "pdf" token, and keeping "_"
  // inside the class turned the whole guess into one unmatched token.
  const tokens = q.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(token => token.length >= 2);
  let score = 0;
  const basis = [];

  if (name === q) { score += 1000; basis.push('exact_name'); }
  else if (name.includes(q)) { score += 600; basis.push('name_contains_query'); }
  else if (q.length >= 8 && q.includes(name)) { score += 500; basis.push('query_contains_name'); }

  if (group && (group === q || group.includes(q))) { score += 320; basis.push('group_match'); }
  if (group && groupEntry && q.includes(group)) { score += 180; basis.push('group_named_in_query'); }
  if (groupEntry && q && normalized(groupEntry.purpose).includes(q)) { score += 240; basis.push('group_purpose'); }

  const aliasHit = (TOOL_ALIASES[group] ?? []).some(raw => {
    const alias = normalized(raw);
    return alias && (q.includes(alias) || (tokens.length && tokens.includes(alias)));
  });
  if (aliasHit) { score += 200; basis.push('goal_alias'); }

  const matchedTokens = tokens.filter(token => name.includes(token) || description.includes(token));
  if (tokens.length && matchedTokens.length === tokens.length) { score += 260; basis.push('all_query_tokens'); }
  else if (matchedTokens.length) { score += matchedTokens.length * 45; basis.push('some_query_tokens'); }
  // A token that appears in the tool's own name is stronger evidence than one
  // that only appears in its description: it decides ties inside a group.
  const nameTokens = tokens.filter(token => name.includes(token));
  if (nameTokens.length) { score += nameTokens.length * 30; basis.push('name_token'); }

  if (tokens.length && tokens.every(token => description.includes(token))) { score += 80; basis.push('description_match'); }
  if (intentTools.has(tool.name)) { score += 350; basis.push('capability_guide_primary'); }
  if (CORE_TOOL_SET.has(tool.name)) { score += 12; basis.push('core_profile'); }

  return { score, basis };
}

function publicTool(tool, score = null, basis = []) {
  // A non-verified twin is a diagnostic: it dispatches but never proves the
  // outcome. Surfacing the twin here means a caller that found the right family
  // does not have to know the naming convention before it reads a schema.
  const verifiedVariant = !tool.name.endsWith('_verified') && TOOLS_BY_NAME.has(`${tool.name}_verified`)
    ? `${tool.name}_verified`
    : undefined;
  return {
    name: tool.name,
    group: GROUP_BY_TOOL.get(tool.name) ?? null,
    summary: summary(tool.description),
    readOnly: tool.annotations?.readOnlyHint === true,
    ...(verifiedVariant ? { verifiedVariant } : {}),
    ...(score === null ? {} : { score, basis })
  };
}

export function searchTools({ query = '', group = '', limit = 8 } = {}) {
  const q = normalized(query);
  if (!q) {
    return {
      status: 'denied', retryable: false, reason: 'query_required',
      message: 'Pass a plain-language query such as "download a file", "上传附件", "network request" or "chrome settings".',
      knownGroups: TOOL_GROUPS.map(item => item.id)
    };
  }
  const wantedGroup = normalized(group);
  if (wantedGroup && !TOOL_GROUPS.some(item => item.id === wantedGroup)) {
    return {
      status: 'denied', retryable: false, reason: 'unknown_group', group: wantedGroup,
      known: TOOL_GROUPS.map(item => item.id),
      nextStep: { kind: 'plan', tool: 'browser_tool_index', arguments: { goal: q } }
    };
  }

  const intent = capabilityGuide({ goal: q });
  const intentTools = new Set(intent.primary?.tools ?? []);
  const matchedGroups = groupsForGoal(q).map(item => item.id);
  const scored = TOOLS
    .filter(tool => !wantedGroup || GROUP_BY_TOOL.get(tool.name) === wantedGroup)
    .map(tool => ({ tool, ...scoreTool(tool, q, intentTools) }))
    .filter(entry => entry.score > 0)
    // Equal scores inside one group fall back to the group's curated order,
    // which is written by first use. Cross-group ties stay alphabetical.
    .sort((a, b) => b.score - a.score ||
      (GROUP_BY_TOOL.get(a.tool.name) === GROUP_BY_TOOL.get(b.tool.name)
        ? GROUP_INDEX.get(a.tool.name) - GROUP_INDEX.get(b.tool.name)
        : a.tool.name.localeCompare(b.tool.name)) ||
      a.tool.name.localeCompare(b.tool.name));

  const max = Math.min(Math.max(Number.isInteger(limit) ? limit : 8, 1), 20);
  const results = scored.slice(0, max).map(entry => publicTool(entry.tool, entry.score, entry.basis));
  if (!results.length) {
    const suggestions = suggestToolNames(q, 5);
    return {
      status: 'not_found', retryable: false, reason: 'no_matching_tool',
      query: q, matchedGroups,
      suggestedTools: suggestions,
      coverage: { complete: true, searchedTools: TOOLS.length, groups: TOOL_GROUPS.length },
      nextStep: suggestions.length
        ? { kind: 'plan', tool: 'browser_tool_schema', arguments: { name: suggestions[0] }, why: 'The query matched no tool directly; inspect the closest name before trying another spelling.' }
        : { kind: 'plan', tool: 'browser_tool_index', arguments: { goal: q }, why: 'Search found no match. The compact intent index may name the group in different words.' }
    };
  }
  const top = results[0];
  return {
    status: 'success', retryable: false,
    query: q,
    matchedGroups,
    results,
    totalMatches: scored.length,
    truncated: scored.length > results.length,
    coverage: { complete: true, searchedTools: TOOLS.length, groups: TOOL_GROUPS.length },
    nextStep: {
      kind: 'plan',
      tool: 'browser_tool_schema',
      arguments: { name: top.name },
      why: top.verifiedVariant
        ? `Read the exact arguments for ${top.name}; if this call changes state, read ${top.verifiedVariant} instead, because the non-verified variant is diagnostic only.`
        : `Read the exact arguments for ${top.name} before calling it.`
    }
  };
}

export function getToolSchema(name) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    const suggestions = suggestToolNames(name, 5);
    return {
      status: 'not_found', retryable: false, reason: 'unknown_tool', name,
      suggestedTools: suggestions,
      coverage: { complete: true, searchedTools: TOOLS.length },
      nextStep: {
        kind: 'plan', tool: 'browser_tool_search',
        arguments: { query: String(name ?? '').trim() || 'browser task' },
        why: 'The exact name is not registered. Search the complete catalogue, then read the returned name.'
      }
    };
  }
  const required = [...(tool.inputSchema.required ?? [])];
  const optional = Object.keys(tool.inputSchema.properties ?? {}).filter(key => !required.includes(key));
  const verifiedVariant = !tool.name.endsWith('_verified') && TOOLS_BY_NAME.has(`${tool.name}_verified`)
    ? `${tool.name}_verified`
    : undefined;
  return {
    status: 'success', retryable: false,
    tool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    },
    group: GROUP_BY_TOOL.get(tool.name) ?? null,
    required,
    optional,
    ...(verifiedVariant ? { verifiedVariant } : {}),
    note: verifiedVariant
      ? `required lists the arguments that must be present. ROUTING arguments hostId and commandId are optional on every tool. This tool is diagnostic for writes; ${verifiedVariant} dispatches with an expectation and proves the outcome.`
      : 'required lists the arguments that must be present. ROUTING arguments hostId and commandId are optional on every tool.'
  };
}

export function capabilityManifest() {
  return {
    service: 'ai-browser-bridge',
    version: VERSION,
    toolCount: TOOLS.length,
    coreProfile: [...CORE_TOOL_PROFILE],
    groups: TOOL_GROUPS.map(group => ({ id: group.id, purpose: group.purpose, count: group.tools.length })),
    discovery: {
      order: ['browser_agent_guide', 'browser_tool_index', 'browser_tool_search', 'browser_tool_schema', 'browser_capability_guide'],
      firstToolsBatch: 'A core profile, not the whole catalogue.',
      conclusionRule: 'Never conclude a capability is missing from the first tools/list batch; search the complete catalogue first.',
      allToolsReachable: true
    },
    integrityStops: [
      'An uncertain write is re-observed, never replayed.',
      'duplicate_suppressed is a refusal, not a failure; only allowRepeat:true overrides it.',
      'The bridge never mines Chrome profile stores or bypasses an OS/Chrome permission prompt.',
      'Secrets stay in the approved input channel and out of commands, logs, reports and chat summaries.'
    ],
    warningPolicy: 'Warnings and handoff fields are advisory. The bridge reports risk and missing prerequisites; the connected agent decides what to attempt and talks to its user.',
    localOnly: 'Search and schema are answered by the service and never touch the browser.'
  };
}

// Add advisory fields without turning a result into a refusal. A caller that
// ignores them is no worse off; a caller that reads them knows when to
// re-observe, when the visible scope was partial, and when a human must answer
// an operating-system prompt.
export function applySurfaceFields(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const add = warning => {
    const list = Array.isArray(result.warnings) ? result.warnings : [];
    if (!list.some(item => item.code === warning.code)) list.push(warning);
    result.warnings = list;
  };
  if (result.status === 'uncertain') {
    add({
      code: 'uncertain_outcome', severity: 'warning',
      message: 'The outcome is unknown. Re-observe the page before any further write; never replay the uncertain action.'
    });
  }
  if (result.status === 'partial') {
    add({
      code: 'partial_result', severity: 'info',
      message: 'The visible scope was incomplete. Treat absent data as unmeasured, not as proof of absence.'
    });
  }
  if (result.status === 'unsupported') {
    add({
      code: 'capability_unsupported', severity: 'warning',
      message: 'This route is not available in the current browser or build. Report it as a route limitation, not as a missing bridge capability.'
    });
  }
  const needsHuman = result.status === 'waiting_for_user_auth' ||
    result.reason === 'waiting_for_user_auth' ||
    result.userActionRequired === true;
  if (needsHuman && !result.handoff) {
    result.handoff = {
      needed: true,
      reason: 'user_action_required',
      userMessage: result.message || 'The browser is waiting for a human to complete its own prompt. Relay this to the user; the bridge did not bypass it.',
      resume: result.nextStep ?? null
    };
  }
  return result;
}

export function errorSurfaceFields(error) {
  const fields = {};
  if (error?.code) fields.code = error.code;
  if (error?.reason) fields.reason = error.reason;
  if (Array.isArray(error?.suggestedTools) && error.suggestedTools.length) fields.suggestedTools = error.suggestedTools;
  if (error?.toolSurface) fields.toolSurface = error.toolSurface;
  if (error?.nextStep) fields.nextStep = error.nextStep;
  if (error?.code === 'UNKNOWN_TOOL') {
    fields.warnings = [{
      code: 'unknown_tool', severity: 'info',
      message: 'The name is not registered. The tool may still exist under a different name; search the complete catalogue instead of concluding the capability is missing.'
    }];
  }
  return fields;
}

export const TOOL_SURFACE_INTERNALS = {
  groupOf: name => GROUP_BY_TOOL.get(name) ?? null,
  isCore: name => CORE_TOOL_SET.has(name)
};
