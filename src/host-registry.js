// Multi-host foundation (0.36.0).
//
// Before this module a bridge process had exactly one `extension` socket. A
// second Chrome - stable, Canary, or an agent-embedded browser - was closed with
// 4003 "Another Chrome profile is already connected", and a single `current`
// job serialised every caller behind whichever browser happened to connect
// first. That is not a capacity limit, it is an ownership bug: the browser that
// wins a race decides which agents get to work.
//
// The registry makes hosts peers. Every host keeps its own identity, its own
// in-flight slot and its own queue position. Nothing here refuses a tool: the
// capability flags are hints for the agent, not a policy gate. Safety decisions
// belong to the agent; the bridge only provides precise target binding, honest
// outcome reporting and an auditable record.

import { createHash, randomUUID } from 'node:crypto';

export const SERVICE_PROTOCOL_VERSION = 2;
export const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const HOST_KINDS = ['stable', 'canary', 'dev', 'beta', 'agent_embedded', 'generic'];

export function isValidHostId(value) {
  return typeof value === 'string' && HOST_ID_PATTERN.test(value);
}

// An older extension sends no hostId. Derive a stable-looking id from the
// connection's origin/port rather than treating every legacy socket as the
// same host. Reconnects of a legacy extension get a new id; upgrading the
// extension to 0.36.0 makes the identity persistent.
export function hostIdFromSeed(seed) {
  return `legacy-${createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)}`;
}

// Chrome tab ids are only unique inside one browser process. Two browsers both
// have a tab 7, so a lease keyed on the bare number locks the wrong tab.
export function scopeKey(hostId, tabId) {
  return `${hostId ?? 'unscoped'}:${tabId}`;
}

export function parseScopeKey(key) {
  const text = String(key);
  const at = text.lastIndexOf(':');
  if (at < 1) return null;
  const tabId = Number(text.slice(at + 1));
  return Number.isInteger(tabId) ? { hostId: text.slice(0, at), tabId } : null;
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    const left = Number.isFinite(pa[i]) ? pa[i] : 0;
    const right = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

const majorOf = version => {
  const value = Number.parseInt(String(version ?? '').split('.')[0], 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

// Advisory only. A `false` here never denies a tool; it tells the agent which
// observation path is likely to work so it can choose a fallback itself.
export function featureFlagsFor({ chromeVersion = null, hostKind = 'generic' } = {}) {
  const major = majorOf(chromeVersion);
  return {
    chromeMajor: major,
    // Origin Trial from Chrome 149, local flag #enable-webmcp-testing.
    webmcpOriginTrial: major === null ? null : major >= 149,
    // outputSchema on registerTool() from 159.0.8140.0 (spec PR #254).
    webmcpOutputSchema: chromeVersion ? compareVersions(chromeVersion, '159.0.8140.0') >= 0 : null,
    // An agent-embedded browser is not chrome.exe and often has no visible
    // window, so a UI Automation walk cannot reach it. This is an observation,
    // not a prohibition: the agent may still use extension-side paths.
    uiAutomationLikely: hostKind === 'agent_embedded' ? false : (hostKind === 'generic' ? null : true),
    declaredBy: chromeVersion ? 'handshake' : 'unknown'
  };
}

// Handshake is deliberately additive. Missing fields never close a socket: an
// older extension falls back to protocol 1 and the baseline tool set. That is
// what lets a 0.33 extension, a 0.36 extension and an embedded browser share
// one service while the operator upgrades them at their own pace.
export function negotiateHandshake(hello = {}, {
  serviceVersion = null,
  fallbackSeed = 'primary',
  serviceProtocolVersion = SERVICE_PROTOCOL_VERSION
} = {}) {
  const requestedProtocol = Number.isSafeInteger(hello?.protocolVersion) && hello.protocolVersion > 0
    ? Math.min(hello.protocolVersion, 1000) : 1;
  const protocolVersion = Math.min(requestedProtocol, serviceProtocolVersion);
  const warnings = [];
  const suppliedHostId = isValidHostId(hello?.hostId) ? hello.hostId : null;
  const hostId = suppliedHostId ?? hostIdFromSeed(fallbackSeed);
  if (!suppliedHostId) warnings.push('host_id_missing_baseline');
  if (requestedProtocol > serviceProtocolVersion) warnings.push('protocol_downgraded');
  const extensionVersion = typeof hello?.version === 'string' ? hello.version.slice(0, 30) : null;
  if (!extensionVersion) warnings.push('extension_version_missing');
  // Version skew is reported, never enforced. Blocking a host for being older
  // would reintroduce the exclusivity this release removes.
  if (extensionVersion && serviceVersion && extensionVersion !== serviceVersion) warnings.push('version_mismatch_advisory');
  const hostKind = HOST_KINDS.includes(hello?.hostKind) ? hello.hostKind : 'generic';
  const chromeVersion = typeof hello?.chromeVersion === 'string' && /^\d+(\.\d+){1,3}$/.test(hello.chromeVersion)
    ? hello.chromeVersion : null;
  const extensionId = typeof hello?.extensionId === 'string' && /^[a-p]{32}$/.test(hello.extensionId)
    ? hello.extensionId : null;
  return {
    accepted: true,
    hostId,
    protocolVersion,
    baseline: requestedProtocol < 2,
    extensionVersion,
    extensionId,
    hostKind,
    chromeVersion,
    warnings,
    serviceVersion,
    features: featureFlagsFor({ chromeVersion, hostKind })
  };
}

export class HostRegistry {
  constructor({ serviceVersion = null } = {}) {
    this.serviceVersion = serviceVersion;
    this.byHostId = new Map();
    this.bySocket = new Map();
    this.primaryHostId = null;
  }

  register(ws, handshake, meta = {}) {
    const previous = this.byHostId.get(handshake.hostId);
    if (previous && previous.ws !== ws) {
      // Same host reconnecting, not a competing browser taking the slot.
      this.bySocket.delete(previous.ws);
      try { previous.ws.close(4004, 'Superseded by the same host reconnecting'); } catch { /* already closing */ }
    }
    const record = {
      hostId: handshake.hostId,
      ws,
      sessionId: randomUUID(),
      protocolVersion: handshake.protocolVersion,
      baseline: handshake.baseline,
      extensionVersion: handshake.extensionVersion,
      extensionId: handshake.extensionId ?? meta.extensionId ?? null,
      hostKind: handshake.hostKind,
      chromeVersion: handshake.chromeVersion,
      features: handshake.features ?? featureFlagsFor(handshake),
      warnings: [...(handshake.warnings ?? [])],
      browser: null,
      origin: meta.origin ?? null,
      remotePort: meta.remotePort ?? null,
      connectedAt: Date.now(),
      commandsDispatched: 0,
      commandsCompleted: 0,
      replacedPreviousSocket: !!previous
    };
    this.byHostId.set(record.hostId, record);
    this.bySocket.set(ws, record);
    if (!this.primaryHostId || !this.byHostId.has(this.primaryHostId)) this.primaryHostId = record.hostId;
    return record;
  }

  remove(ws) {
    const record = this.bySocket.get(ws);
    if (!record) return null;
    this.bySocket.delete(ws);
    this.byHostId.delete(record.hostId);
    if (this.primaryHostId === record.hostId) this.primaryHostId = this.byHostId.keys().next().value ?? null;
    return record;
  }

  byWs(ws) { return this.bySocket.get(ws) ?? null; }
  byId(hostId) { return this.byHostId.get(hostId) ?? null; }
  hostIdFor(ws) { return this.bySocket.get(ws)?.hostId ?? null; }
  primary() { return this.primaryHostId ? this.byHostId.get(this.primaryHostId) ?? null : null; }
  list() { return [...this.byHostId.values()]; }
  size() { return this.byHostId.size; }

  noteBrowser(ws, { extensionId = null, browser = null } = {}) {
    const record = this.bySocket.get(ws);
    if (!record) return null;
    if (typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId)) record.extensionId = extensionId;
    if (browser && typeof browser === 'object') {
      record.browser = browser;
      if (!record.chromeVersion && typeof browser.version === 'string') {
        record.chromeVersion = browser.version;
        record.features = featureFlagsFor({ chromeVersion: browser.version, hostKind: record.hostKind });
      }
    }
    return record;
  }

  // Public projection: never expose the socket or the pairing token.
  snapshot({ ownerFor = () => null } = {}) {
    return this.list().map(record => ({
      hostId: record.hostId,
      primary: record.hostId === this.primaryHostId,
      sessionId: record.sessionId,
      protocolVersion: record.protocolVersion,
      baseline: record.baseline,
      extensionVersion: record.extensionVersion,
      extensionId: record.extensionId,
      hostKind: record.hostKind,
      chromeVersion: record.chromeVersion,
      browserVersion: record.browser?.version ?? null,
      features: record.features,
      warnings: record.warnings,
      origin: record.origin,
      remotePort: record.remotePort,
      owner: ownerFor(record),
      connectedAt: record.connectedAt,
      connectedMs: Date.now() - record.connectedAt,
      commandsDispatched: record.commandsDispatched,
      commandsCompleted: record.commandsCompleted,
      connected: record.ws.readyState === 1,
      inFlight: false
    }));
  }
}

// Choose the next job that can actually be dispatched. A host with an in-flight
// command is skipped, not waited on, so one stalled browser cannot hold every
// other browser's work hostage. Aging prevents a low-priority task from being
// starved by a stream of cheap reads; the fairness bonus rotates agents.
export function pickDispatchable(queue, inFlight, { now = Date.now(), lastAgent = null, availableHostIds = null } = {}) {
  let best = null;
  for (let index = 0; index < queue.length; index += 1) {
    const job = queue[index];
    if (inFlight.has(job.hostId)) continue;
    if (availableHostIds && !availableHostIds.has(job.hostId)) continue;
    const waitedMs = Math.max(0, now - job.created);
    const aging = Math.min(100, Math.floor(waitedMs / 1000));
    const agent = job.args?.agent ?? null;
    const fairness = lastAgent && agent && agent !== lastAgent ? 15 : 0;
    const score = job.priority - aging - fairness;
    if (!best || score < best.score || (score === best.score && job.created < best.job.created)) {
      best = { index, job, score };
    }
  }
  return best;
}

// Idempotency ledger. An agent that loses a response may legitimately resend
// the same commandId; the bridge replays the recorded outcome instead of
// dispatching a second write whose result nobody can prove.
export class CommandLedger {
  constructor({ maxEntries = 4096 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  check(commandId) {
    return typeof commandId === 'string' && commandId ? this.entries.get(commandId) ?? null : null;
  }

  record(commandId, value) {
    if (typeof commandId !== 'string' || !commandId) return null;
    this.entries.set(commandId, { ...value, recordedAt: Date.now() });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return this.entries.get(commandId);
  }

  size() { return this.entries.size; }
}
