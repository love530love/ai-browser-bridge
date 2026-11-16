// A weak caller under concurrency has three questions and no way to answer
// them: may I call this now, if not how long should I wait, and which tool
// should I try instead. The queue snapshot holds the facts, but reading a
// snapshot and inferring a safe move is exactly the work a weak model does
// badly. This module turns those facts into one decision and, when the
// arguments are fully known, one executable call.
//
// Boundaries that keep it from becoming another source of bad advice:
//
// 1. It is advisory. It cannot grant authority, approve a write, or claim that
//    an unobserved write succeeded. The verified-write contract still applies.
// 2. A failed result goes through nextStep first. An uncertain write becomes a
//    read, never a retry, even when the queue is idle.
// 3. It never fabricates arguments. A proceed step is emitted only when the
//    target tool's required arguments are already present.
// 4. It never moves work to another browser silently. A host suggestion is
//    opt-in and is a suggestion, not a dispatch.
// 5. It accepts only queue metadata. No page text, OCR text, cookies, profile
//    paths or credentials enter the model context or the reply.
import { TOOLS } from './tools.js';
import { isFailure, nextStepFor } from './next-step.js';
import { capabilityGuide } from './capability-guide.js';
import { WRITE_TOOLS } from './leases.js';

const TOOLS_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
const MAX_WAIT_MS = 120000;
const MIN_WAIT_MS = 250;
const MAX_READS_PER_HOST = 2;
const DEFAULT_READ_MS = 1200;
const DEFAULT_WRITE_MS = 2500;
const DEFAULT_NAV_MS = 4000;

// Local tools are answered without the queue, so queue depth and lanes are not
// reasons to wait for them. This list mirrors where src/server.js answers before
// enqueueJob; a name that is wrong here only makes the advice more conservative.
const QUEUE_EXEMPT = new Set([
  'browser_agent_guide', 'browser_capabilities', 'browser_tool_index',
  'browser_prepare_request', 'browser_protected_ui_plan', 'browser_execution_profile',
  'browser_capability_guide', 'browser_queue_status', 'browser_scheduler_status',
  'browser_hosts', 'browser_wait_until_ready', 'browser_failure_help',
  'browser_agent_advice', 'browser_health', 'browser_launch',
  'browser_route_task', 'browser_claim_tab', 'browser_renew_tab',
  'browser_release_tab', 'browser_tab_lease', 'browser_reload_extension',
  'browser_credential_lookup', 'browser_password_manager_reveal',
  'browser_certificates', 'browser_certificates_write',
  'browser_native_host', 'browser_native_host_install',
  'browser_recipe_list', 'browser_recipe_save', 'browser_recipe_delete',
  'browser_desktop_windows', 'browser_devtools', 'browser_native_snapshot',
  'browser_native_action'
]);

// These are answered before the maintenance gate, so maintenance does not
// block them. Everything else waits.
const PRE_MAINTENANCE = new Set([
  'browser_agent_guide', 'browser_capabilities', 'browser_tool_index',
  'browser_prepare_request', 'browser_protected_ui_plan', 'browser_execution_profile',
  'browser_capability_guide', 'browser_queue_status', 'browser_scheduler_status',
  'browser_hosts', 'browser_wait_until_ready', 'browser_route_task',
  'browser_failure_help', 'browser_locate', 'browser_ocr',
  'browser_extension_errors', 'browser_agent_advice'
]);

const NO_HOST_LOCAL = new Set([
  ...PRE_MAINTENANCE,
  'browser_recipe_list', 'browser_recipe_save', 'browser_recipe_delete'
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

function toolAverageMs(durations, name) {
  const entry = durations?.[name];
  if (Number.isFinite(entry)) return entry;
  if (Number.isFinite(entry?.avgMs)) return entry.avgMs;
  return null;
}

function defaultMsFor(name) {
  if (name === 'browser_navigate' || name === 'browser_navigate_verified' || name === 'browser_open') return DEFAULT_NAV_MS;
  if (TOOLS_BY_NAME.get(name)?.annotations?.readOnlyHint === true) return DEFAULT_READ_MS;
  return DEFAULT_WRITE_MS;
}

function remainingMs(job, durations) {
  if (!job) return 0;
  const measured = toolAverageMs(durations, job.tool) ?? defaultMsFor(job.tool);
  return Math.max(MIN_WAIT_MS, measured - (Number.isFinite(job.ageMs) ? job.ageMs : 0));
}

function estimateWait({ mode, activeWrite, activeReads, queuedForHost, queueLength, durations, sameTabJob = null }) {
  const measured = [...(activeWrite ? [activeWrite] : []), ...activeReads, ...queuedForHost]
    .some(job => toolAverageMs(durations, job.tool) !== null);
  let estimateMs = 1500;
  if (mode === 'write_lane_busy') {
    estimateMs = remainingMs(activeWrite, durations) +
      queuedForHost.filter(job => job.readOnly !== true).reduce((sum, job) => sum + remainingMs(job, durations), 0);
  } else if (mode === 'read_lane_draining_for_write') {
    // A write is skipped while ANY read is in flight on that host. New reads can
    // extend this, so the estimate is deliberately a lower bound.
    estimateMs = Math.max(...activeReads.map(job => remainingMs(job, durations)), MIN_WAIT_MS) +
      queuedForHost.filter(job => job.readOnly === true).reduce((sum, job) => sum + remainingMs(job, durations) * 0.5, 0);
  } else if (mode === 'read_lane_full') {
    estimateMs = Math.min(...activeReads.map(job => remainingMs(job, durations))) +
      queuedForHost.filter(job => job.readOnly === true).reduce((sum, job) => sum + remainingMs(job, durations) * 0.5, 0);
  } else if (mode === 'same_tab_busy') {
    estimateMs = Math.max(remainingMs(sameTabJob, durations), MIN_WAIT_MS) +
      queuedForHost.filter(job => sameTabJob && job.tabId === sameTabJob.tabId).reduce((sum, job) => sum + remainingMs(job, durations), 0);
  } else if (mode === 'queue_full') {
    estimateMs = Math.max(3000, Math.round(queueLength * (defaultMsFor('browser_read') + defaultMsFor('browser_click')) / 4));
  } else if (mode === 'lease') {
    estimateMs = 3000;
  }
  estimateMs = clamp(Math.round(estimateMs), MIN_WAIT_MS, MAX_WAIT_MS);
  return {
    estimateMs,
    basis: measured ? 'recent measured durations plus current queue age' : 'default tool latency; no measured samples yet',
    confidence: measured ? 'medium' : 'low'
  };
}

function waitStep(estimateMs, why, agent) {
  return {
    kind: 'wait',
    tool: 'browser_wait_until_ready',
    arguments: {
      timeoutMs: clamp(estimateMs + 2000, 5000, 60000),
      idle: true,
      ...(agent ? { agent } : {})
    },
    why
  };
}

function presentArguments(tool, { tabId, hostId, agent }) {
  if (!tool) return null;
  const args = {};
  if (Number.isInteger(tabId) && Object.hasOwn(tool.inputSchema.properties, 'tabId')) args.tabId = tabId;
  if (typeof hostId === 'string' && hostId && Object.hasOwn(tool.inputSchema.properties, 'hostId')) args.hostId = hostId;
  if (typeof agent === 'string' && agent && Object.hasOwn(tool.inputSchema.properties, 'agent')) args.agent = agent;
  for (const key of tool.inputSchema.required ?? []) {
    if (!Object.hasOwn(args, key)) return null;
  }
  return args;
}

function toolTrailFor({ goal, tabId, toolName }) {
  const guide = goal ? capabilityGuide({ goal, tabId: Number.isInteger(tabId) ? tabId : null }) : null;
  const tools = [...new Set([toolName, ...(guide?.chain ?? [])].filter(value => typeof value === 'string' && value))].slice(0, 12);
  return {
    tools,
    intents: guide?.matchedIntents ?? [],
    primary: guide?.primary ? {
      intent: guide.primary.intent,
      backgroundSafe: guide.primary.backgroundSafe,
      focusRequired: guide.primary.focusRequired
    } : null,
    focusRequired: guide?.focusRequired ?? false
  };
}

function sanitizeFailure(lastResult, toolName) {
  if (!isFailure(lastResult)) return null;
  return {
    tool: typeof toolName === 'string' ? toolName : null,
    status: typeof lastResult?.status === 'string' ? lastResult.status : null,
    reason: typeof lastResult?.reason === 'string' ? lastResult.reason.slice(0, 120) : null,
    dispatched: typeof lastResult?.dispatched === 'boolean' ? lastResult.dispatched : null,
    retryable: typeof lastResult?.retryable === 'boolean' ? lastResult.retryable : null,
    found: typeof lastResult?.found === 'boolean' ? lastResult.found : null,
    ambiguous: typeof lastResult?.ambiguous === 'boolean' ? lastResult.ambiguous : null
  };
}

function buildChromeTriage({ goal, toolName, urgency, queueDigest, blockers, waitEstimateMs, lastFailure, trail }) {
  const queue = {
    connected: queueDigest.connected,
    hostsConnected: queueDigest.hostsConnected,
    hostCount: queueDigest.hostCount,
    activeCount: queueDigest.activeCount,
    queued: queueDigest.queued,
    queueLimit: queueDigest.queueLimit,
    activeLane: queueDigest.activeLane,
    readInFlight: queueDigest.readInFlight,
    waitEstimateMs: Number.isFinite(waitEstimateMs) ? waitEstimateMs : null,
    blockerCodes: blockers.map(item => item.code).slice(0, 12)
  };
  const allowedTools = [...new Set([toolName, ...trail.tools].filter(Boolean))].slice(0, 24);
  return {
    provider: 'chrome-built-in-ai',
    status: 'delegated_to_extension',
    tool: 'browser_local_judge',
    mode: 'triage',
    arguments: {
      mode: 'triage',
      goal: text(goal, 1000) || `Choose the next safe step for ${toolName || 'this browser task'}.`,
      // browser_local_judge requires a non-empty observation; triage ignores its
      // content and deliberately receives no page text.
      observation: 'queue-only triage; no page text supplied',
      tool: typeof toolName === 'string' ? toolName : null,
      urgency: ['interactive', 'normal', 'batch'].includes(urgency) ? urgency : 'normal',
      queue,
      allowedTools,
      attemptedTools: typeof toolName === 'string' ? [toolName] : [],
      failureReasons: lastFailure?.reason ? [lastFailure.reason] : []
    },
    note: 'browser_agent_advice does not call the extension model synchronously: that call would queue behind the jobs being diagnosed. Send these arguments to browser_local_judge mode:"triage"; the reply is advisory only and never executes an action.'
  };
}

function decorate(result, context) {
  const {
    queueDigest, goal, toolName, agent, tabId, hostId, urgency,
    lastFailure, trail
  } = context;
  const blockers = Array.isArray(result.blockers) ? result.blockers : context.blockers;
  const nextStep = result.nextStep ?? null;
  const decision = result.decision ?? 'diagnose';
  const waitEstimateMs = Number.isFinite(result.waitEstimateMs) ? result.waitEstimateMs : null;
  const pollAfterMs = waitEstimateMs === null ? null : clamp(Math.round(waitEstimateMs / 2), 500, 10000);
  const full = {
    status: 'success',
    advisory: true,
    authority: 'advisory_only',
    agent: agent ?? null,
    goal: text(goal, 500),
    hostId: typeof hostId === 'string' ? hostId : null,
    tabId: Number.isInteger(tabId) ? tabId : null,
    decision,
    confidence: result.confidence ?? 'medium',
    why: result.why ?? nextStep?.why ?? '',
    nextStep,
    waitEstimateMs,
    pollAfterMs,
    blockers,
    toolTrail: trail.tools,
    capability: {
      matchedIntents: trail.intents,
      primary: trail.primary,
      focusRequired: trail.focusRequired
    },
    lastFailure,
    queue: queueDigest,
    ...(result.neverRetry ? { neverRetry: true } : {}),
    ...(result.requiredHumanAction ? { requiredHumanAction: result.requiredHumanAction } : {}),
    ...(result.suggestedHostId ? { suggestedHostId: result.suggestedHostId } : {}),
    authorityNote: 'Advice is derived from local queue metadata. It never approves a write, grants policy authority, or proves an outcome; use _verified writes and re-observe before the next action.',
    contentTrust: 'local queue metadata and the caller-supplied goal; no page text, OCR text, cookies, profile paths or secrets'
  };
  full.chromeTriage = buildChromeTriage({
    goal, toolName, urgency, queueDigest, blockers, waitEstimateMs, lastFailure, trail
  });
  full.modelContext = {
    task: text(goal, 500) || null,
    requestedTool: typeof toolName === 'string' ? toolName : null,
    urgency: ['interactive', 'normal', 'batch'].includes(urgency) ? urgency : 'normal',
    queue: {
      connected: queueDigest.connected,
      hostsConnected: queueDigest.hostsConnected,
      hostCount: queueDigest.hostCount,
      activeCount: queueDigest.activeCount,
      queued: queueDigest.queued,
      queueLimit: queueDigest.queueLimit,
      activeLane: queueDigest.activeLane,
      readInFlight: queueDigest.readInFlight,
      queuedAheadForHost: queueDigest.queuedAheadForHost,
      waitEstimateMs,
      blockerCodes: blockers.map(item => item.code).slice(0, 12)
    },
    lastFailure,
    candidateTools: trail.tools.slice(0, 10)
  };
  full.recommendedNextAction = (() => {
    if (nextStep?.tool) return `Call ${nextStep.tool}${nextStep.arguments && Object.keys(nextStep.arguments).length ? ' with the returned arguments' : ''}, then re-observe before the next action. ${full.authorityNote}`;
    if (decision === 'wait') return `Wait about ${waitEstimateMs ?? 3000} ms, then re-check with browser_queue_status or browser_agent_advice. Do not replay a write.`;
    if (decision === 'proceed') return `Proceed with ${toolName} using your own arguments. Re-observe after any write; ${full.authorityNote}`;
    if (decision === 'stop') return full.why;
    if (decision === 'escalate') return full.why;
    if (decision === 'plan') return 'Use toolTrail in order, starting with browser_capability_guide. Read the page before the first write.';
    return full.why || 'Re-observe the page and call browser_agent_advice again with the latest result.';
  })();
  return full;
}

export function buildAgentAdvice({
  queue = {},
  agent = null,
  goal = '',
  toolName = null,
  tabId = null,
  hostId = null,
  urgency = 'normal',
  lastResult = null,
  allowSwitchHost = false,
  durations = {},
  now = Date.now()
} = {}) {
  const normalizedTab = Number.isInteger(tabId) && tabId > 0 ? tabId : null;
  const requestedHost = typeof hostId === 'string' && hostId ? hostId : null;
  const tool = typeof toolName === 'string' && toolName ? TOOLS_BY_NAME.get(toolName) ?? null : null;
  const readOnly = tool?.annotations?.readOnlyHint === true;
  const hosts = Array.isArray(queue.hosts) ? queue.hosts : [];
  const activeByHost = Array.isArray(queue.activeByHost) ? queue.activeByHost : [];
  const queuedJobs = Array.isArray(queue.queuedJobs) ? queue.queuedJobs : [];
  const leases = Array.isArray(queue.tabLeases) ? queue.tabLeases : [];
  const connected = queue.connected === true || Number(queue.hostsConnected) > 0 || hosts.some(host => host.connected === true);
  const hostsConnected = Number.isFinite(queue.hostsConnected)
    ? queue.hostsConnected
    : hosts.filter(host => host.connected === true).length;
  const hostCount = Number.isFinite(queue.hostCount) ? queue.hostCount : hosts.length;
  const queueLimit = Number.isFinite(queue.queueLimit)
    ? queue.queueLimit
    : Math.max(16, 16 * Math.max(1, hostCount));
  const recommendedHostId = typeof queue.recommendedHostId === 'string' ? queue.recommendedHostId : null;
  const targetHostId = requestedHost ?? recommendedHostId ?? hosts.find(host => host.connected === true)?.hostId ?? hosts[0]?.hostId ?? null;
  const targetHost = targetHostId ? hosts.find(host => host.hostId === targetHostId) ?? null : null;
  const hostTagged = queuedJobs.some(job => typeof job.hostId === 'string');
  const queuedForHost = targetHostId
    ? queuedJobs.filter(job => hostTagged ? (job.hostId ?? targetHostId) === targetHostId : true)
    : queuedJobs;
  const activeForHost = targetHostId ? activeByHost.filter(job => job.hostId === targetHostId) : [];
  const activeWrite = activeForHost.find(job => job.lane === 'write') ?? null;
  const activeReads = activeForHost.filter(job => job.lane === 'read');
  const activeLane = activeWrite && activeReads.length ? 'write+read' : activeWrite ? 'write' : activeReads.length ? 'read' : null;
  const queueManaged = !!tool && !QUEUE_EXEMPT.has(tool.name);
  const trail = toolTrailFor({ goal: text(goal, 1000), tabId: normalizedTab, toolName: tool?.name ?? null });
  const lastFailure = sanitizeFailure(lastResult, tool?.name ?? toolName);
  const blockers = [];
  const lastStep = tool && lastResult
    ? nextStepFor(tool.name, { tabId: normalizedTab, agent, ...(requestedHost ? { hostId: requestedHost } : {}) }, lastResult)
    : null;
  const deferredStep = lastStep && (lastStep.rule === 'deterministic_rules_exhausted' || lastStep.rule === 'disconnected' || lastStep.rule === 'timeout')
    ? lastStep
    : null;
  const specificStep = lastStep && !deferredStep ? lastStep : null;
  const queueDigest = {
    connected,
    hostsConnected,
    hostCount,
    activeCount: Number.isFinite(queue.activeCount) ? queue.activeCount : activeByHost.length,
    queued: Number.isFinite(queue.queued) ? queue.queued : queuedJobs.length,
    queueLimit,
    activeLane,
    readInFlight: activeReads.length,
    targetHostId,
    queuedAheadForHost: queuedForHost.length,
    recommendedHostId
  };
  const make = result => decorate(result, {
    queueDigest, goal, toolName: tool?.name ?? toolName, agent, tabId: normalizedTab,
    hostId: requestedHost, urgency, lastFailure, trail, blockers
  });

  // A failed call is answered before any scheduling question. The one rule that
  // must never be softened by an idle queue is "an unobserved write is not a
  // retry"; nextStep already encodes it.
  if (specificStep) {
    if (specificStep.rule === 'uncertain_write') blockers.push({ code: 'uncertain_write', detail: 'The previous write was dispatched and its outcome was not observed.' });
    if (specificStep.rule === 'duplicate_suppressed') blockers.push({ code: 'duplicate_suppressed', detail: 'An identical action already ran against an unchanged page.' });
    return make({
      decision: specificStep.kind === 'escalate_to_ai' ? 'escalate' : specificStep.kind,
      confidence: 'high',
      why: specificStep.why,
      nextStep: specificStep,
      waitEstimateMs: Number.isFinite(specificStep.arguments?.ms) ? specificStep.arguments.ms : null,
      ...(specificStep.rule === 'uncertain_write' || specificStep.rule === 'duplicate_suppressed' ? { neverRetry: true } : {})
    });
  }

  // nextStepFor needs a tabId to build its read step. With no tab it would
  // return silence, and silence here would let an idle queue turn an
  // unobserved write into a retry. Keep the safety rule independent of that.
  if (lastResult?.reason === 'duplicate_suppressed') {
    blockers.push({ code: 'duplicate_suppressed', detail: 'An identical action already ran against an unchanged page.' });
    return make({
      decision: 'stop',
      confidence: 'high',
      why: 'An identical action already ran against an unchanged page moments ago. The first one counted; do not repeat it.',
      nextStep: null,
      neverRetry: true
    });
  }
  if (lastResult?.dispatched === true && ['uncertain', 'timeout', 'unknown'].includes(lastResult?.status)) {
    blockers.push({ code: 'uncertain_write', detail: 'The previous write was dispatched and its outcome was not observed.' });
    return make({
      decision: 'diagnose',
      confidence: 'high',
      why: 'The previous write was dispatched and its outcome was not observed. Reading is the only safe next move; repeating it could create a second order, message or deletion.',
      nextStep: normalizedTab ? {
        kind: 'diagnose',
        tool: 'browser_read',
        arguments: { tabId: normalizedTab, mode: 'cheap', ...(agent ? { agent } : {}) },
        why: 'Read the page to find out whether the first dispatch landed. Do not resend the write.'
      } : null,
      neverRetry: true
    });
  }

  if (typeof toolName === 'string' && toolName && !tool) {
    return make({
      decision: 'diagnose',
      confidence: 'high',
      why: `No registered tool is called "${text(toolName, 120)}". Guessing a similar call is how a mistyped tool name becomes a wrong action.`,
      nextStep: {
        kind: 'plan',
        tool: 'browser_tool_index',
        arguments: { goal: text(goal, 200) || text(toolName, 200) },
        why: 'Read the compact index, pick the exact tool name, then call browser_capability_guide for the path.'
      }
    });
  }

  const noHostLocal = !tool || NO_HOST_LOCAL.has(tool.name);
  if (!connected) {
    if (queue.extensionPaused === true) {
      return make({
        decision: 'escalate',
        confidence: 'high',
        why: 'The extension is paused by the user. Nothing will run until they resume it; waiting or retrying cannot reconnect it.',
        nextStep: null,
        requiredHumanAction: 'Click the 自主浏览器 extension icon and press 重新连接 (Reconnect).',
        blockers: [...blockers, { code: 'extension_paused', detail: 'User-initiated pause.' }]
      });
    }
    if (lastResult?.reason === 'chrome_already_running') {
      return make({
        decision: 'diagnose',
        confidence: 'high',
        why: 'Chrome is running but no extension host is connected. Starting another Chrome would open a second profile and lose the logged-in session.',
        nextStep: { kind: 'diagnose', tool: 'browser_health', arguments: {}, why: 'Read the layered health state to distinguish a paused extension, an unpaired install and a dead service.' },
        blockers: [...blockers, { code: 'chrome_running_extension_not_connected', detail: 'browser_launch refused to start a second instance.' }]
      });
    }
    if (lastResult?.reason === 'no_used_profile_available') {
      return make({
        decision: 'escalate',
        confidence: 'high',
        why: 'No installed Chrome channel has a profile with history, so there is no session this bridge may open. Starting an empty profile would look like a wiped login.',
        nextStep: null,
        blockers: [...blockers, { code: 'no_used_profile_available', detail: 'No usable Chrome profile was found.' }]
      });
    }
    if (!tool || tool.name === 'browser_launch' || queueManaged) {
      return make({
        decision: 'start_browser',
        confidence: 'high',
        why: 'No browser host is connected. The bridge starts the user\'s own Chrome with no profile flags and waits for the extension to dial back in.',
        nextStep: { kind: 'start_browser', tool: 'browser_launch', arguments: {}, why: 'Start the existing Chrome profile; never a second browser or an incognito profile.' },
        blockers: [...blockers, { code: 'no_host_connected', detail: 'No extension host is connected to the service.' }]
      });
    }
    if (!noHostLocal) {
      return make({
        decision: 'start_browser',
        confidence: 'medium',
        why: 'This tool needs a connected browser, and none is connected.',
        nextStep: { kind: 'start_browser', tool: 'browser_launch', arguments: {}, why: 'Start the user\'s own Chrome, then poll browser_wait_until_ready.' },
        blockers: [...blockers, { code: 'no_host_connected', detail: 'No extension host is connected to the service.' }]
      });
    }
    // A purely local tool can still answer with no browser. Fall through.
  }

  if (requestedHost && !targetHost) {
    const alternative = hosts.find(host => host.connected === true)?.hostId ?? null;
    return make({
      decision: allowSwitchHost && alternative && !normalizedTab ? 'switch_host' : 'wait',
      confidence: 'high',
      why: `The requested hostId "${requestedHost}" is not connected. Work is never silently moved to a different browser.`,
      nextStep: { kind: 'diagnose', tool: 'browser_hosts', arguments: {}, why: 'List the connected hosts and choose one explicitly before dispatching.' },
      ...(allowSwitchHost && alternative ? { suggestedHostId: alternative } : {}),
      blockers: [...blockers, { code: 'host_not_connected', detail: `Requested host ${requestedHost} is absent.` }]
    });
  }

  if (targetHost && targetHost.connected === false) {
    const alternative = hosts.find(host => host.connected === true && host.hostId !== targetHost.hostId)?.hostId ?? null;
    const canSuggestSwitch = allowSwitchHost && alternative && normalizedTab === null;
    return make({
      decision: canSuggestSwitch ? 'switch_host' : 'wait',
      confidence: 'high',
      why: `Host ${targetHost.hostId} is connected in the registry but its socket is not open. A tab id is only unique inside one browser, so work is not moved silently.`,
      nextStep: { kind: 'diagnose', tool: 'browser_hosts', arguments: {}, why: 'Confirm which host is actually connected before dispatching.' },
      ...(canSuggestSwitch ? { suggestedHostId: alternative } : {}),
      blockers: [...blockers, { code: 'host_not_connected', detail: `Host ${targetHost.hostId} has no open socket.` }]
    });
  }

  if (queue.maintenance && !PRE_MAINTENANCE.has(tool?.name ?? '')) {
    const estimate = estimateWait({ mode: 'queue_full', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
    blockers.push({ code: 'maintenance', detail: 'The service is in a maintenance window.' });
    return make({
      decision: 'wait',
      confidence: estimate.confidence,
      why: 'The bridge is in a maintenance window. A browser call would be answered with waiting without dispatching.',
      waitEstimateMs: estimate.estimateMs,
      nextStep: waitStep(estimate.estimateMs, 'Wait for maintenance to finish; no browser action was dispatched.', agent)
    });
  }

  if (queue.desktopOperation && tool?.name !== 'browser_queue_status' && tool?.name !== 'browser_agent_advice') {
    const estimate = estimateWait({ mode: 'queue_full', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
    blockers.push({ code: 'desktop_operation', detail: 'A one-shot desktop action is in progress.' });
    return make({
      decision: 'wait',
      confidence: estimate.confidence,
      why: 'A one-shot desktop action is in progress. It owns the real screen and must finish before another browser write is dispatched.',
      waitEstimateMs: estimate.estimateMs,
      nextStep: waitStep(estimate.estimateMs, 'Wait for the desktop action to finish.', agent)
    });
  }

  if (queue.taskLease && queueManaged && queue.taskLease !== agent) {
    const estimate = estimateWait({ mode: 'queue_full', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
    blockers.push({ code: 'global_task_lease', detail: `Global task lease is held by ${queue.taskLease}.` });
    return make({
      decision: 'wait',
      confidence: estimate.confidence,
      why: `Another agent holds the global task lease (${queue.taskLease}). Submitting now would be answered with waiting.`,
      waitEstimateMs: estimate.estimateMs,
      nextStep: waitStep(estimate.estimateMs, 'Wait until the global task lease clears; do not replay a write.', agent)
    });
  }

  if (!tool) {
    if (text(goal, 1000)) {
      return make({
        decision: 'plan',
        confidence: 'high',
        why: 'No target tool was supplied, so the safe next move is to choose a path before calling anything.',
        nextStep: {
          kind: 'plan',
          tool: 'browser_capability_guide',
          arguments: { goal: text(goal, 1000), ...(normalizedTab ? { tabId: normalizedTab } : {}) },
          why: 'Get the primary path, foreground requirement and fallbacks for this goal, then call the first tool in toolTrail.'
        }
      });
    }
    return make({
      decision: 'diagnose',
      confidence: 'high',
      why: 'No tool and no goal were supplied. Read the tab list first so the next call can name a real target.',
      nextStep: { kind: 'diagnose', tool: 'browser_tabs', arguments: {}, why: 'List the authorized tabs, then pass a real tabId and a goal.' }
    });
  }

  if (tool.name === 'browser_launch' && connected) {
    return make({
      decision: 'diagnose',
      confidence: 'high',
      why: 'A browser host is already connected. browser_launch refuses to start a second instance because that would open a second profile and lose the logged-in session.',
      nextStep: { kind: 'diagnose', tool: 'browser_hosts', arguments: {}, why: 'Inspect the connected hosts instead of starting another browser.' },
      blockers: [...blockers, { code: 'browser_already_connected', detail: 'browser_launch is only for the no-browser case.' }]
    });
  }

  if (!queueManaged) {
    return make({
      decision: 'proceed',
      confidence: 'high',
      why: 'This tool is answered locally by the service, so queue lanes and browser contention do not block it.',
      nextStep: (() => {
        const args = presentArguments(tool, { tabId: normalizedTab, hostId: requestedHost, agent });
        return args ? { kind: 'proceed', tool: tool.name, arguments: args, why: 'Issue the call with these routing arguments.' } : null;
      })()
    });
  }

  if (normalizedTab && WRITE_TOOLS.has(tool.name)) {
    const lease = leases.find(item => item.tabId === normalizedTab && (!item.hostId || !targetHostId || item.hostId === targetHostId));
    if (lease && lease.agent !== agent) {
      const estimate = estimateWait({ mode: 'lease', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
      blockers.push({ code: 'tab_lease', detail: `Tab ${normalizedTab} is leased by ${lease.agent}.` });
      return make({
        decision: 'wait',
        confidence: 'high',
        why: `Agent "${lease.agent}" holds the write lease on tab ${normalizedTab}. Reads remain allowed, but this write cannot be dispatched.`,
        waitEstimateMs: estimate.estimateMs,
        nextStep: {
          kind: 'wait',
          tool: 'browser_tab_lease',
          arguments: { tabId: normalizedTab, ...(requestedHost ? { hostId: requestedHost } : {}), ...(agent ? { agent } : {}) },
          why: 'Read the lease again after the suggested delay; do not dispatch the write until it clears or the holder releases it.'
        }
      });
    }
  }

  if (normalizedTab) {
    const activeSameTab = [...(activeWrite ? [activeWrite] : []), ...activeReads].find(job => job.tabId === normalizedTab);
    if (activeSameTab) {
      const estimate = estimateWait({ mode: 'same_tab_busy', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations, sameTabJob: activeSameTab });
      blockers.push({ code: 'same_tab_busy', detail: `Tab ${normalizedTab} already has ${activeSameTab.lane} job ${activeSameTab.tool}.` });
      return make({
        decision: 'wait',
        confidence: estimate.confidence,
        why: `Tab ${normalizedTab} is already busy with ${activeSameTab.tool}. A tab is exclusive even for reads, so this call would queue behind it.`,
        waitEstimateMs: estimate.estimateMs,
        nextStep: waitStep(estimate.estimateMs, `Wait for tab ${normalizedTab} to become free, then re-observe before the next action.`, agent)
      });
    }
  }

  if (!readOnly) {
    if (activeWrite) {
      const estimate = estimateWait({ mode: 'write_lane_busy', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
      blockers.push({ code: 'write_lane_busy', detail: `Host ${targetHostId} is running ${activeWrite.tool}.` });
      return make({
        decision: 'wait',
        confidence: estimate.confidence,
        why: `Host ${targetHostId} is already running a write (${activeWrite.tool}). One write lane per host prevents two unprovable side effects from racing.`,
        waitEstimateMs: estimate.estimateMs,
        nextStep: waitStep(estimate.estimateMs, 'Wait for the active write to finish; never replay an uncertain write.', agent)
      });
    }
    if (activeReads.length) {
      const estimate = estimateWait({ mode: 'read_lane_draining_for_write', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
      blockers.push({ code: 'read_lane_draining_for_write', detail: `${activeReads.length} read(s) are in flight on host ${targetHostId}.` });
      return make({
        decision: 'wait',
        confidence: estimate.confidence,
        why: `Host ${targetHostId} is still serving ${activeReads.length} read(s). A write is deliberately skipped until that host's read lane drains, so the shortest wait is for those reads to finish.`,
        waitEstimateMs: estimate.estimateMs,
        nextStep: waitStep(estimate.estimateMs, 'Let the read lane drain, then submit the write once.', agent)
      });
    }
  } else if (activeReads.length >= MAX_READS_PER_HOST) {
    const estimate = estimateWait({ mode: 'read_lane_full', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
    blockers.push({ code: 'read_lane_full', detail: `Host ${targetHostId} already has ${activeReads.length} reads in flight.` });
    return make({
      decision: 'wait',
      confidence: estimate.confidence,
      why: `The read fast lane on host ${targetHostId} is full (${activeReads.length}/${MAX_READS_PER_HOST}). This read would queue rather than start.`,
      waitEstimateMs: estimate.estimateMs,
      nextStep: waitStep(estimate.estimateMs, 'Wait for one read slot to open; reads on a different tab may then run in parallel with a write.', agent)
    });
  }

  if (queuedJobs.length >= queueLimit) {
    const estimate = estimateWait({ mode: 'queue_full', activeWrite, activeReads, queuedForHost, queueLength: queuedJobs.length, durations });
    blockers.push({ code: 'queue_full', detail: `The service queue is at ${queuedJobs.length}/${queueLimit}.` });
    return make({
      decision: 'wait',
      confidence: estimate.confidence,
      why: `The service queue is full (${queuedJobs.length}/${queueLimit}). Submitting now would be refused before reaching the browser.`,
      waitEstimateMs: estimate.estimateMs,
      nextStep: waitStep(estimate.estimateMs, 'Wait for queued browser jobs to drain, then resubmit once.', agent)
    });
  }

  if (deferredStep?.aiAssisted === true && lastResult) {
    // The queue is clear, but the previous failure had no deterministic next
    // step. Ask the local judge as an advisory planner rather than inventing a
    // tool call; the judge still cannot execute anything.
    return make({
      decision: 'escalate',
      confidence: 'medium',
      why: 'The queue is clear, but the previous failure exhausted deterministic recovery rules. The page/tool routing is the remaining uncertainty.',
      nextStep: {
        kind: 'escalate',
        tool: 'browser_local_judge',
        arguments: {
          mode: 'discovery',
          goal: text(goal, 1000) || `Recover from ${tool.name} failure`,
          observation: 'The previous call failed; read the page again before supplying an observation.',
          attemptedTools: [tool.name],
          failureReasons: [lastFailure?.reason ?? lastFailure?.status ?? 'unknown']
        },
        why: 'Ask Chrome\'s built-in model for a page-analysis and tool recommendation, then re-read before acting. The judge is advisory only.'
      }
    });
  }

  const proceedArgs = presentArguments(tool, { tabId: normalizedTab, hostId: requestedHost, agent });
  return make({
    decision: 'proceed',
    confidence: 'high',
    why: `No conflicting lease, tab job, lane or queue limit blocks ${tool.name} on host ${targetHostId ?? 'the default host'}.`,
    nextStep: proceedArgs ? {
      kind: 'proceed',
      tool: tool.name,
      arguments: proceedArgs,
      why: 'Call it once with these routing arguments. After a write, re-observe before the next action.'
    } : null
  });
}

// Merge a local-model opinion into deterministic advice. The model can add a
// caution or suggest a tool name, but it cannot turn a wait into a proceed, a
// stop into a retry, or an unobserved write into a safe repeat.
export function mergeModelAdvice(advice, model) {
  if (!advice || typeof advice !== 'object') return advice;
  if (!model || typeof model !== 'object') return { ...advice, model: null };
  const merged = { ...advice, model };
  if (model.status !== 'success' || !model.advice) return merged;
  const opinion = model.advice;
  const allowed = new Set(advice.modelContext?.candidateTools ?? []);
  const suggestedTool = typeof opinion.nextTool === 'string' && allowed.has(opinion.nextTool) ? opinion.nextTool : null;
  if (suggestedTool) merged.modelSuggestedTool = suggestedTool;
  const deterministic = advice.decision;
  if ((opinion.decision === 'wait' || opinion.decision === 'stop' || opinion.decision === 'escalate') && deterministic === 'proceed') {
    merged.modelCaution = `Local model suggests ${opinion.decision}${Number.isFinite(opinion.waitMs) ? ` (~${opinion.waitMs} ms)` : ''}: ${opinion.why || 'no reason supplied'}. The deterministic queue state says this call is safe now; the model cannot grant or deny authority. Re-check the queue before writing.`;
  }
  if (suggestedTool && advice.decision !== 'stop' && suggestedTool !== advice.nextStep?.tool) {
    merged.modelSuggestedStep = {
      tool: suggestedTool,
      why: opinion.why || 'The local model recommended this tool from the supplied candidate list.'
    };
  }
  return merged;
}
