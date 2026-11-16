import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import { configPath, loadConfig, ROOT, stateDir } from './config.js';
import { request } from './client.js';
import { callWithWaitingRecovery } from './auto-recovery.js';
import { createAgentPolicy } from './policy.js';
import { regressionSummary } from './regression-summary.js';
import { computeBuildIdentity } from './build-identity.js';
import { buildUpgradeCheck } from './upgrade-check.js';
import { inferBrowserTarget } from './browser-target.js';
import { runNativeHostTool, NATIVE_HOST_NAME } from './native-host.js';
import { findBridgeExtension, describeExtensionState, chromeUserDataDir, sameDirectory, developerModeInEffect } from './chrome-profile.js';
import { createDesktopAdapter } from './desktop-adapter.js';
import { usageSummary } from './usage-summary.js';
import { listInstances, createInstance, removeInstance, enableInstance, disableInstance } from './instance-config.js';
import { startInstance, stopInstance, statusInstance, listAllInstances, startAllInstances, stopAllInstances } from './instance-manager.js';
import { listAdapters, pruneStaleAdapters } from './adapter-registry.js';
import { isProcessAlive, probeParentName, SHELL_PARENT_NAMES } from './mcp-parent-guard.js';
import { readLifecycle } from './service-lifecycle.js';
import { restartServiceWhenIdle } from './service-restart.js';

async function rawToolCall(name, args) {
  return await request('/call', { name, arguments: args });
}

async function doctor() {
  const report = { service: 'ai-browser-bridge', ok: false, checks: [], recommendations: [] };
  const add = (name, ok, details = {}) => report.checks.push({ name, ok, ...details });
  let config;
  try {
    config = loadConfig();
    add('config', true, { port: config.port, uploadRoots: config.uploadRoots?.length ?? 0 });
  } catch (error) {
    add('config', false, { error: error.message });
    report.recommendations.push('Run start.ps1 or node src/cli.js setup to create local configuration.');
    return report;
  }
  try {
    const status = await request('/status');
    report.status = status;
    const expectedVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    const manifestVersion = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
    const expectedBuildId = computeBuildIdentity(ROOT);
    add('service-build-current', status.buildId === expectedBuildId, { expectedBuildId, runningBuildId: status.buildId ?? null });
    if (status.buildId !== expectedBuildId) report.recommendations.push('Service source identity differs or is unavailable. Arrange an idle service restart and verify again; matching version numbers alone do not prove current code is loaded. Copyable: node src/cli.js upgrade-check (ordered, read-only plan). Verify the 19387 LISTENING PID, the process command line and an idle queue before any restart; .local/server.pid is NOT proof of process identity, so never kill by it blindly. Let the watchdog (or the heartbeat allow-list) restart, then run node src/cli.js status; never stop.ps1.');
    add('deployment-current', status.version === expectedVersion && status.extensionVersion === manifestVersion && expectedVersion === manifestVersion,
      { expectedVersion, manifestVersion, serviceVersion: status.version, extensionVersion: status.extensionVersion ?? null });
    if (status.version !== expectedVersion) report.recommendations.push(`Running service differs from disk version ${expectedVersion}; restart the service when idle. Copyable: node src/cli.js upgrade-check (read-only plan with the LISTENING-PID identity check), let the watchdog restart only after that check, then verify with node src/cli.js status. Never kill by .local/server.pid alone; never stop.ps1.`);
    if (status.extensionVersion !== manifestVersion) report.recommendations.push(`Loaded extension differs from disk version ${manifestVersion}; reload and verify before claiming deployment complete. Copyable: node src/cli.js upgrade-check, then node src/cli.js call browser_reload_extension '{"confirmation":"reload_extension_once","allowFocus":true}' (repeat per hostId when multi-host).`);
    add('service-status', status.service === 'ai-browser-bridge', { version: status.version });
    add('extension-connected', status.connected === true, { extensionVersion: status.extensionVersion ?? null, browserVersion: status.browserVersion ?? null });
    // "Not connected" and "not installed" and "Chrome disabled it" are the same
    // symptom and three different fixes, so the profile on disk is read here.
    const extensionState = findBridgeExtension({ extensionDir: join(ROOT, 'extension') });
    const developerMode = developerModeInEffect({ profileDirectory: extensionState.profileDirectory ?? 'Default' });
    add('bridge-extension-registered', extensionState.found === true && extensionState.enabled === true, {
      profileDirectory: extensionState.profileDirectory ?? null,
      extensionId: extensionState.extensionId ?? null,
      matchedBy: extensionState.matchedBy ?? null,
      enabled: extensionState.enabled ?? null,
      disableReasons: extensionState.disableReasons ?? null,
      developerMode,
      explanation: describeExtensionState(extensionState, { developerMode })
    });
    if (extensionState.found && extensionState.enabled === false) {
      report.recommendations.push(`Chrome has disabled the bridge extension in profile "${extensionState.profileDirectory}" (disable_reasons ${JSON.stringify(extensionState.disableReasons)}). It is still registered, so switch Developer mode back on in chrome://extensions and enable 自主浏览器; auto start also passes --load-extension in this state so a restart does not need that step repeated.`);
    }
    if (!extensionState.found) {
      report.recommendations.push('The bridge extension is not registered in any Chrome profile. Load it with "Load unpacked" from chrome://extensions with Developer mode on.');
    }
    // Which browser auto start would pick, and on which profile. This is the one
    // decision that can silently lose every cookie, so it is answerable without
    // launching anything: the launcher runs in dry-run mode and reports the
    // binary, the channel and the user-data directory it would use.
    try {
      const adapter = createDesktopAdapter();
      const target = config.browserTarget ?? null;
      const decision = adapter.available
        ? await adapter.launchChrome({ dryRun: true, exePath: target?.exePath ?? null,
          userDataDir: target?.userDataDir ?? null, profileDirectory: target?.profileDirectory ?? null })
        : null;
      if (decision) {
        const would = decision.wouldLaunch ?? null;
        // With a recorded target the question is "does the launch match what was
        // recorded", not "does it match the stable channel".
        const expected = target?.userDataDir ?? chromeUserDataDir();
        const sameProfile = would?.userDataDir ? sameDirectory(would.userDataDir, expected) : null;
        // A stale target is not "correct just because it is explicit": the whole
        // point of recording a target is to open the browser its owner uses, and
        // recency is the only evidence that answers that. So it fails the check
        // instead of leaving doctor all-green while auto start would be wrong.
        const staleTarget = (decision.warnings ?? []).includes('recorded_target_looks_stale');
        add('auto-start-target', decision.reason === 'dry_run' && sameProfile !== false && !staleTarget, {
          configuredTarget: target,
          wouldLaunch: would,
          expectedUserDataDir: expected,
          sameProfileAsThisMachine: sameProfile,
          // Recency, not just identity: a recorded target can be a real profile
          // with a real login that nobody has touched for weeks, while another
          // channel was written to seconds ago. Identity alone would call that
          // "correct" and quietly open the wrong browser.
          liveCandidate: decision.liveCandidate ?? null,
          targetIsLive: decision.targetIsLive ?? null,
          warnings: decision.warnings ?? [],
          runningSession: decision.runningSession ?? null,
          rejectedCandidates: decision.rejectedCandidates ?? [],
          note: 'Dry run only: nothing was launched. This is the browser and profile a real auto start would use.'
        });
        if (!target) {
          report.recommendations.push('No browserTarget is recorded, so auto start picks a channel by heuristic. That is how the wrong browser gets opened: set browserTarget in config.json to the browser you actually use. Copyable: node src/cli.js set-browser-target --from-running-chrome (dry-run prints the suggestion + evidence); add --write to persist it, then node src/cli.js doctor.');
        }
        if ((decision.warnings ?? []).includes('recorded_target_looks_stale')) {
          const live = decision.liveCandidate ?? {};
          const recorded = would ?? {};
          report.recommendations.push(
            `browserTarget looks stale: ${recorded.channel}/${recorded.profileDirectory} was last written ${Math.round(recorded.ageMinutes ?? -1)} minutes ago, while ${live.channel}/${live.profileDirectory} was written ${Math.round(live.ageMinutes ?? -1)} minutes ago. Same machine, different browser - confirm which one you actually use before relying on auto start.`);
        }
        if (decision.reason === 'no_used_profile_available') {
          report.recommendations.push('Auto start is refusing to launch: no installed Chrome channel has a profile with history in it. Open your own browser once; launching a blank profile would look like a wiped session.');
        }
        if (sameProfile === false) {
          report.recommendations.push(`Auto start would launch ${would.chromePath} (${would.channel} channel), which uses ${would.userDataDir} instead of ${expected}. That browser has different cookies and logins.`);
        }
      }
    } catch (error) {
      add('auto-start-target', false, { error: error.message });
    }
    add('version-match', !!status.version && !!status.extensionVersion && status.version === status.extensionVersion, { serviceVersion: status.version, extensionVersion: status.extensionVersion ?? null });
    add('queue-idle', !status.active && status.queued === 0, { active: status.active, queued: status.queued });
    add('upload-roots', (status.uploadRoots ?? 0) === (config.uploadRoots?.length ?? 0), { count: status.uploadRoots ?? 0 });
    const agentPolicy = createAgentPolicy({ file: join(stateDir, 'agents.json') });
    add('agent-policy', true, { registeredAgents: agentPolicy.size(), note: agentPolicy.size() ? 'scopes enforced per registered agent' : 'no registered agents; named agents run unpoliced' });
    if (!status.connected) report.recommendations.push('Extension is not connected. Do not open many panel tabs automatically; reload the unpacked extension once or open its panel manually if needed.');
    if (status.version && status.extensionVersion && status.version !== status.extensionVersion) {
      if (status.extensionVersion > status.version) report.recommendations.push('Extension is newer than the running service. Restart the bridge service with start.ps1 or stop.ps1 then start.ps1.');
      else report.recommendations.push('Service is newer than the loaded extension. Reload the unpacked extension from chrome://extensions.');
    }
    report.checks.push(await nativeHostCheck());
  } catch (error) {
    add('service-status', false, { error: error.message });
    report.recommendations.push('Bridge service is not reachable on 127.0.0.1. Run start.ps1 and wait for status. If the launcher itself may have failed (missing PowerShell 7, wrong Node, port occupied, proxy swallowing loopback), run doctor-lite.bat first: it uses only node.exe, needs no pwsh.exe, and reports the host environment with copyable fixes.');
    report.localOnly = 'The bridge intentionally binds to 127.0.0.1 and rejects browser Origins; do not expose it directly to the public internet.';
    return report;
  }
  try {
    const tools = await request('/tools');
    const names = new Set(tools.map(tool => tool.name));
    const required = ['browser_agent_guide', 'browser_wait_until_ready', 'browser_find_text', 'browser_health', 'browser_observe', 'browser_claim_tab'];
    add('tools-schema', required.every(name => names.has(name)), { count: tools.length, missing: required.filter(name => !names.has(name)) });
  } catch (error) {
    add('tools-schema', false, { error: error.message });
  }
  report.localOnly = 'Default architecture is local-only: HTTP listens on 127.0.0.1, Host is pinned to 127.0.0.1:port, and website Origins are rejected. Remote sandboxes should run their own bridge+Chrome or use a separately designed authenticated tunnel, not direct public exposure.';
  report.ok = report.checks.every(check => check.ok);
  return report;
}
function upgradeDiagnosis() {
  const log = join(stateDir, 'logs', 'audit.jsonl');
  const rows = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const errors = rows.filter(row => row.outcome === 'error' || row.tool === 'extension-error');
  const counts = {};
  for (const row of errors) counts[row.errorCategory || 'UNKNOWN'] = (counts[row.errorCategory || 'UNKNOWN'] || 0) + 1;
  const report = { generatedAt: new Date().toISOString(), log, sampled: rows.length, errors: errors.length, errorCategories: counts, recentErrors: errors.slice(-20), recommendations: [] };
  if (counts.WEBSOCKET_ERROR || counts.CONNECTION_ERROR) report.recommendations.push('Restart the bridge once, then reload the extension and run doctor. Do not open multiple extension settings tabs.');
  if (counts.COMMAND_ERROR || counts.EXTENSION_ERROR) report.recommendations.push('Inspect the latest command error and re-observe the tab before retrying; uncertain writes must not be replayed.');
  if (counts.PROTOCOL_ERROR) report.recommendations.push('Check service/extension version match and reload the unpacked extension once.');
  if (counts.EXECUTION_ERROR) report.recommendations.push('Run browser_health then browser_wait_until_ready and browser_observe. Treat SPA/loading errors as retryable reads; never replay an uncertain write automatically.');
  if (counts.ELEMENT_COVERED) report.recommendations.push('Run browser_scan_overlays and browser_shadow_tree, then re-observe. Prefer semantic refs; use a screenshot/desktop fallback only after the target is verified.');
  if (counts.UNCAUGHT_ERROR || counts.UNHANDLED_REJECTION) report.recommendations.push('Reload the unpacked extension once, run doctor, and inspect the extension service-worker errors before resuming queued work.');
  if (errors.length && report.recommendations.length === 0) report.recommendations.push('Review recentErrors, run doctor, and retry only idempotent reads after readiness is confirmed.');
  report.regressions = regressionSummary(join(ROOT, 'output', 'live-installed', 'runs'));
  report.usage = usageSummary(stateDir);
  if (report.usage.frequentRestarts) report.recommendations.push('Frequent service starts in the last 48 hours: investigate process termination and cleanup schedules. Recovery does not establish the exit cause; do not kill processes by name.');
  if (report.usage.uncertainCommands) report.recommendations.push(`${report.usage.uncertainCommands} write(s) have uncertain outcomes. Re-observe and independently verify each before any new write; do not replay automatically.`);
  if (report.usage.unreadableFiles || report.usage.malformedRows || report.usage.missingFiles) report.recommendations.push('Usage evidence is incomplete. Missing or malformed logs must not be interpreted as zero failures.');
  if (report.regressions.unexpectedFailures) report.recommendations.push('Review preserved local regression runs before upgrading. Injected fault runs are counted separately; do not replay failed writes.');
  if (report.regressions.unreadable) report.recommendations.push('Some regression reports were missing, malformed or too large to summarize; inspect them locally.');
  report.status = errors.length || report.regressions.unexpectedFailures || report.regressions.unreadable || report.usage.frequentRestarts || report.usage.uncertainCommands || report.usage.unreadableFiles || report.usage.malformedRows || report.usage.missingFiles ? 'attention' : 'ready';
  writeFileSync(join(stateDir, 'upgrade-analysis.json'), JSON.stringify(report, null, 2), { encoding: 'utf8' });
  return report;
}

function gitFact(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return 'unknown'; }
}

function collectGit() {
  const head = gitFact(['rev-parse', 'HEAD']);
  const porcelain = gitFact(['status', '--porcelain']);
  const dirty = porcelain === 'unknown' ? 'unknown' : porcelain.length > 0;
  let behind = 'unknown';
  let ahead = 'unknown';
  const counts = gitFact(['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
  if (counts !== 'unknown') {
    const m = /^(\d+)\s+(\d+)$/.exec(counts);
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
  }
  return { head, behind, ahead, dirty };
}

// Read-only fact collection for upgrade-check. It never writes a file, never
// restarts the service and never reloads the extension. /status is copied
// field-by-field (never echoed whole) and config is reduced to field names +
// loadConfig() defaults, so no pairing token can ever reach the report.
async function collectUpgradeContext() {
  const disk = {
    version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    manifestVersion: JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version,
    buildId: computeBuildIdentity(ROOT)
  };
  let running = null;
  try {
    const s = await request('/status');
    running = {
      version: s.version ?? null,
      buildId: s.buildId ?? null,
      extensionVersion: s.extensionVersion ?? null,
      connected: s.connected ?? null,
      extensionId: s.extensionId ?? null
    };
  } catch { running = null; }
  const expected = ['browserTarget', 'uploadRoots', 'uploadMaxBytes'];
  let config;
  try {
    const merged = loadConfig();
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const missingFields = expected.filter(k => !Object.prototype.hasOwnProperty.call(raw, k));
    // Only report defaults for fields that are actually missing; a missing
    // field's loadConfig() value is already the safe default. Present fields
    // (which may hold real paths) are never echoed into the report.
    const defaults = {};
    if (missingFields.includes('browserTarget')) defaults.browserTarget = null;
    if (missingFields.includes('uploadRoots')) defaults.uploadRoots = merged.uploadRoots;
    if (missingFields.includes('uploadMaxBytes')) defaults.uploadMaxBytes = merged.uploadMaxBytes;
    config = { missingFields, defaults };
  } catch (error) {
    config = {
      missingFields: [...expected],
      defaults: { browserTarget: null, uploadRoots: [], uploadMaxBytes: 16 * 1024 * 1024 },
      error: error.message
    };
  }
  return { disk, running, config, git: collectGit(), extensionId: running?.extensionId ?? null };
}

// set-browser-target is dry-run by default: it only prints the suggestion and
// evidence. config.json is mutated only when --write is passed explicitly, and
// even then only after the target passes the same validation the inference did.
function setBrowserTarget(flags) {
  const wantsWrite = flags.includes('--write');
  const base = {
    command: 'node src/cli.js set-browser-target --from-running-chrome',
    written: false,
    dryRun: !wantsWrite,
    doctor: 'node src/cli.js doctor'
  };
  const result = inferBrowserTarget();
  if (!result.ok) {
    return { ...base, reason: result.reason, detail: result.detail ?? null, target: result.target ?? null };
  }
  const target = result.target;
  let validExe = false;
  let validUserDataDir = false;
  try { validExe = existsSync(target.exePath) && statSync(target.exePath).isFile(); } catch { /* boundary */ }
  try { validUserDataDir = existsSync(target.userDataDir) && statSync(target.userDataDir).isDirectory(); } catch { /* boundary */ }
  const validProfile = /^(Default|Profile \d+)$/.test(target.profileDirectory);
  const validation = { exePath: validExe, userDataDir: validUserDataDir, profileDirectory: validProfile };
  if (!wantsWrite) {
    return { ...base, target, evidence: result.evidence, validation };
  }
  if (!validExe || !validUserDataDir || !validProfile) {
    return { ...base, target, evidence: result.evidence, reason: 'validation_failed', validation };
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.browserTarget = target;
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { ...base, written: true, target, evidence: result.evidence };
}

// Information-level doctor check. Optional native capabilities must never make
// doctor.ok false, and a registry we cannot read is reported as unknown rather
// than as a failure. Reuses native-host.js's read-only status action.
async function nativeHostCheck() {
  const check = {
    name: 'native-host',
    ok: true,
    optional: true,
    registered: 'unknown',
    usable: 'unknown',
    installCommand: "node src/cli.js call browser_native_host_install '{\"action\":\"install\",\"confirmation\":\"modify_native_host_once\"}'",
    note: `Native messaging host "${NATIVE_HOST_NAME}" is optional: only clipboard / native-capability tools need it, so an unregistered host never affects doctor.ok. Registration lives at HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}.`
  };
  try {
    const status = await runNativeHostTool({ action: 'status' });
    if (status && status.status === 'success') {
      check.registered = status.registered ?? false;
      check.usable = status.usable ?? false;
      check.detail = {
        manifestExists: status.manifestExists ?? null,
        launcherExists: status.launcherExists ?? null,
        extensionIdMatches: status.extensionIdMatches ?? null
      };
    } else {
      check.readError = status?.reason ?? status?.status ?? 'unreadable';
    }
  } catch (error) {
    check.readError = String(error?.message ?? error).slice(0, 200);
  }
  return check;
}

try {
  const rest = process.argv.slice(2);
  const cmd = rest[0];
  const name = rest[1];
  const args = rest[2];
  
  // Handle compound commands like 'instance start-all', 'agent list', etc.
  const isInstanceCommand = cmd === 'instance';
  const isAgentCommand = cmd === 'agent';
  const isMaintenanceCommand = cmd === 'maintenance';
  
  if (cmd === 'setup') {
    loadConfig(true);
    writeFileSync(join(stateDir, 'mcp-config.json'), JSON.stringify({ mcpServers: { 'ai-browser-bridge': { command: process.execPath, args: [join(ROOT, 'src', 'mcp.js')] } } }, null, 2));
    console.log('Configuration ready. Run start.ps1, load extension/, then run pair.ps1.');
  } else if (cmd === 'allow-upload-root') {
    if (!name || !isAbsolute(name)) throw new Error('An absolute upload root is required');
    const root = realpathSync(resolve(name));
    const config = loadConfig();
    config.uploadRoots = [...new Set([...(config.uploadRoots ?? []), root])];
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ allowedUploadRoot: root, count: config.uploadRoots.length }));
  } else if (isAgentCommand) {
    // Operator surface for the governance layer. Writes land in
    // stateDir/agents.json and take effect on the next call; no restart needed
    // because the service re-reads decisions through the same file on boot and
    // the CLI writes are picked up by the running service's next evaluate().
    const policy = createAgentPolicy({ file: join(stateDir, 'agents.json') });
    if (name === 'list') console.log(JSON.stringify(policy.list(), null, 2));
    else if (name === 'show' && args) console.log(JSON.stringify(policy.get(args) ?? { agent: args, registered: false }, null, 2));
    else if (name === 'set' && args) {
      const payload = process.argv[5];
      const entry = payload === '--stdin' ? JSON.parse(readFileSync(0, 'utf8')) : JSON.parse(payload || '{}');
      console.log(JSON.stringify(policy.set(args, entry), null, 2));
    }
    else if (name === 'remove' && args) console.log(JSON.stringify(policy.remove(args), null, 2));
    else throw new Error('Usage: node src/cli.js agent list | show NAME | set NAME [JSON|--stdin] | remove NAME');
  } else if (isInstanceCommand) {
    // Instance management commands
    const instanceCmd = name;
    if (instanceCmd === 'list') {
      console.log(JSON.stringify(listAllInstances(), null, 2));
    } else if (instanceCmd === 'add') {
      const instanceName = args || `instance_${Date.now()}`;
      const instance = createInstance({ id: instanceName, name: instanceName });
      console.log(JSON.stringify(instance, null, 2));
    } else if (instanceCmd === 'remove' && args) {
      const removed = removeInstance(args);
      console.log(JSON.stringify(removed, null, 2));
    } else if (instanceCmd === 'start' && args) {
      const result = startInstance(args);
      console.log(JSON.stringify(result, null, 2));
    } else if (instanceCmd === 'stop' && args) {
      const result = stopInstance(args);
      console.log(JSON.stringify(result, null, 2));
    } else if (instanceCmd === 'start-all') {
      const results = startAllInstances();
      console.log(JSON.stringify(results, null, 2));
    } else if (instanceCmd === 'stop-all') {
      const results = stopAllInstances();
      console.log(JSON.stringify(results, null, 2));
    } else if (instanceCmd === 'status' && args) {
      const result = statusInstance(args);
      console.log(JSON.stringify(result, null, 2));
    } else {
      throw new Error('Usage: node src/cli.js instance list | add [NAME] | remove NAME | start NAME | stop NAME | start-all | stop-all | status NAME');
    }
  } else if (cmd === 'cdp-probe') {
    // Gate 1-2 evidence only. This never opens a CDP port, never starts a
    // browser and never connects Playwright; it asks the existing extension
    // channel what it answers and saves the sanitized reply under .local/.
    const flags = rest.slice(1);
    const flagValue = flag => { const index = flags.indexOf(flag); return index >= 0 ? flags[index + 1] : null; };
    const tabRaw = flagValue('--tab-id');
    const tabId = tabRaw === null ? null : Number(tabRaw);
    if (tabId !== null && (!Number.isSafeInteger(tabId) || tabId < 1)) throw new Error('--tab-id must be a positive integer');
    const hostId = flagValue('--host-id');
    const outFlag = flagValue('--out');
    const tabs = await rawToolCall('browser_tabs', hostId ? { hostId } : {});
    const tabsPayload = tabs?.result ?? tabs;
    const rows = Array.isArray(tabsPayload) ? tabsPayload : Array.isArray(tabsPayload?.tabs) ? tabsPayload.tabs : Array.isArray(tabsPayload?.result) ? tabsPayload.result : [];
    const eligible = rows.filter(row => row && row.restricted !== true && /^https?:\/\//i.test(row.url ?? ''));
    const target = tabId === null ? eligible[0] : rows.find(row => row.id === tabId);
    if (!target) throw new Error(tabId === null ? `No http(s) tab is available${hostId ? ` on host ${hostId}` : ''}. Open one, pass --tab-id, or route with --host-id.` : `Tab ${tabId} is not in the visible tab list${hostId ? ` on host ${hostId}` : ''}.`);
    if (target.restricted === true || !/^https?:\/\//i.test(target.url ?? '')) throw new Error(`Tab ${target.id} is not a readable http(s) tab; the probe needs one.`);
    const response = await rawToolCall('browser_debugger', { tabId: target.id, action: 'probe', ...(hostId ? { hostId } : {}) });
    const result = response?.result ?? response;
    const evidence = {
      schema: 'ai-browser-bridge-cdp-probe-v1',
      createdAt: new Date().toISOString(),
      requestedTabId: tabId,
      hostId: hostId ?? null,
      // The probe result already carries a redacted origin; the raw tab url and
      // title are deliberately not copied into evidence.
      selectedTabId: target.id,
      result
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const evidenceFile = outFlag ?? join(stateDir, `cdp-probe-${stamp}.json`);
    mkdirSync(dirname(evidenceFile), { recursive: true });
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({
      evidenceFile,
      tabId: target.id,
      status: result?.status ?? null,
      verdict: result?.verdict ?? null,
      sideEffects: result?.sideEffects ?? []
    }, null, 2));
    if (result?.status !== 'success') process.exitCode = 1;
  } else if (cmd === 'adapters') {
    // Read-only by default. --prune only deletes this registry's own record
    // files, never a process, and never a record younger than the given age.
    const flags = rest.slice(1);
    const flagValue = flag => { const index = flags.indexOf(flag); return index >= 0 ? flags[index + 1] : null; };
    const staleRaw = flagValue('--stale-ms');
    const staleMs = staleRaw === null ? undefined : Number(staleRaw);
    if (staleMs !== undefined && (!Number.isFinite(staleMs) || staleMs < 0)) throw new Error('--stale-ms must be a non-negative number');
    if (flags.includes('--prune')) {
      const hoursRaw = flagValue('--older-than-hours');
      const hours = hoursRaw === null ? 24 : Number(hoursRaw);
      if (!Number.isFinite(hours) || hours < 0) throw new Error('--older-than-hours must be a non-negative number');
      console.log(JSON.stringify(pruneStaleAdapters({ stateDir, olderThanMs: hours * 3600000, dryRun: flags.includes('--dry-run') }), null, 2));
    } else {
      const inventory = listAdapters({ stateDir, ...(staleMs === undefined ? {} : { staleMs }) });
      if (flags.includes('--liveness')) {
        for (const record of inventory.records) {
          record.alive = isProcessAlive(record.pid);
          record.parentAlive = isProcessAlive(record.ppid);
          record.orphanedCandidate = record.alive && !record.parentAlive;
        }
        inventory.liveness = 'checked';
        inventory.live = inventory.records.filter(record => record.alive).length;
        inventory.orphanedCandidates = inventory.records.filter(record => record.orphanedCandidate).length;
        inventory.livenessNote = 'Liveness is a probe of the recorded pid/parent, not proof of identity. Nothing was signalled or killed.';
      }
      console.log(JSON.stringify(inventory, null, 2));
    }
  } else if (cmd === 'processes') {
    // One bounded inventory of what this project actually started. It never
    // enumerates the machine by process name (that is how unrelated Node apps
    // get blamed or killed) and it never signals anything. Pid files are treated
    // as claims to verify, not identity: a stale pid may already belong to an
    // unrelated process.
    const readPid = name => {
      try {
        const pid = Number(readFileSync(join(stateDir, name), 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch { return null; }
    };
    const servicePid = readPid('server.pid');
    const watchdogPid = readPid('watchdog.pid');
    const inventory = listAdapters({ stateDir });
    // One PowerShell probe per adapter, in parallel: a serial probe made this
    // report take seconds on a fleet with several registered adapters.
    const records = await Promise.all(inventory.records.map(async record => {
      const parentName = await probeParentName(record.ppid);
      const alive = isProcessAlive(record.pid);
      const parentAlive = isProcessAlive(record.ppid);
      return {
        ...record,
        alive,
        parentAlive,
        parentName,
        parentIsShell: parentName ? SHELL_PARENT_NAMES.has(parentName) : null,
        guardMode: record.guard?.mode ?? null,
        guardAnchor: record.guard?.anchor ?? null,
        orphanedCandidate: alive && !parentAlive && (!parentName || !SHELL_PARENT_NAMES.has(parentName)) &&
          record.guard?.mode !== 'active'
      };
    }));
    const output = {
      schema: 'ai-browser-bridge-processes-v1',
      checkedAt: new Date().toISOString(),
      lifecycle: (() => {
        const ledger = readLifecycle(stateDir, { limit: 20 });
        return {
          file: ledger.file,
          lastExit: ledger.lastExit,
          lastEventAt: ledger.events.at(-1)?.time ?? null,
          totalRecorded: ledger.totalRecorded
        };
      })(),
      service: {
        pid: servicePid,
        alive: isProcessAlive(servicePid),
        pidSource: join(stateDir, 'server.pid'),
        identityNote: 'The pid file is a claim, not proof of identity. Verify the LISTENING pid and command line before any restart; never kill by pid file alone.'
      },
      watchdog: {
        pid: watchdogPid,
        alive: isProcessAlive(watchdogPid),
        pidSource: join(stateDir, 'watchdog.pid')
      },
      adapters: {
        count: records.length,
        live: records.filter(record => record.alive).length,
        orphanedCandidates: records.filter(record => record.orphanedCandidate).length,
        records
      },
      processCount: [servicePid, watchdogPid].filter(pid => isProcessAlive(pid)).length + records.filter(record => record.alive).length,
      action: 'report-only',
      notes: [
        'Only processes this project registered are listed. No machine-wide name scan was performed.',
        'orphanedCandidate means the adapter is alive while its recorded parent is gone and the parent was not a shell/launcher. It is evidence for an operator decision, not an instruction to kill.',
        'guard.mode is active when a stable ancestor (pid + creation time) is watched, and passive when no stable ancestor could be verified. passive is not protection; it is recorded so it is never mistaken for one.',
        'Registry files can be pruned with node src/cli.js adapters --prune --dry-run; no process is ever killed by this command.'
      ]
    };
    console.log(JSON.stringify(output, null, 2));
  } else if (cmd === 'service-history') {
    // Read-only lifecycle evidence. `planned_restart` is written by the
    // heartbeat BEFORE it signals the pid; a missing intent is what makes an
    // exit unattributed, so this command never guesses a cause.
    const limitAt = rest.indexOf('--limit');
    const limit = limitAt >= 0 ? Number(rest[limitAt + 1]) : 100;
    if (!Number.isFinite(limit) || limit <= 0 || limit > 2000) throw new Error('--limit must be between 1 and 2000');
    const ledger = readLifecycle(stateDir, { limit });
    console.log(JSON.stringify({
      schema: 'ai-browser-bridge-service-history-v1',
      file: ledger.file,
      count: ledger.count,
      totalRecorded: ledger.totalRecorded,
      lastExit: ledger.lastExit,
      events: ledger.events,
      unreadable: ledger.unreadable,
      notes: [
        'planned_restart means a heartbeat restart_intent covered that exit; it is not a crash.',
        'unrecorded_exit means the run left no exit record: absence of evidence, not proof of a crash.',
        'History begins when this ledger was introduced; earlier exits have no record here.'
      ]
    }, null, 2));
  } else if (cmd === 'runtime') {
    // Cross-device preflight. The bridge itself needs Node only; everything
    // else is an optional capability. Reporting them one by one stops a new
    // machine from being declared "not supported" because a Python or Rust
    // toolchain happens to be absent - and stops a missing optional runtime
    // from being mistaken for the cause of a browser failure.
    const findOnPath = names => {
      for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        const base = dir.replace(/^"|"$/g, '');
        if (!base) continue;
        for (const name of names) {
          const candidate = join(base, name);
          if (existsSync(candidate)) return candidate;
        }
      }
      return null;
    };
    const probe = (names, args = ['--version']) => {
      const path = findOnPath(names);
      if (!path) return { found: false, path: null, version: null };
      // Node cannot execFile a .cmd/.bat shim without a shell; the binary being
      // present is the fact that matters here, so do not invent a failure.
      if (/\.(cmd|bat)$/i.test(path)) return { found: true, path, version: null, probed: false };
      try {
        const output = execFileSync(path, args, {
          encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        return { found: true, path, version: output.trim().split(/\r?\n/)[0]?.slice(0, 120) ?? null };
      } catch (error) {
        const text = String(error?.stdout ?? error?.stderr ?? '').trim().split(/\r?\n/)[0];
        return { found: true, path, version: text ? text.slice(0, 120) : null, probed: false };
      }
    };
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
    const optional = {
      npm: probe(['npm.cmd', 'npm']),
      pwsh: probe(['pwsh.exe', 'pwsh']),
      powershell: probe(['powershell.exe', 'powershell']),
      python: probe(['python.exe', 'python3.exe', 'python', 'python3']),
      go: probe(['go.exe', 'go'], ['version']),
      rustc: probe(['rustc.exe', 'rustc']),
      rea: probe(['rea.cmd', 'rea.exe', 'rea.bat', 'rea'])
    };
    const report = {
      schema: 'ai-browser-bridge-runtime-v1',
      checkedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      core: {
        node: { version: process.versions.node, ok: nodeMajor >= 22, requirement: '>=22' },
        note: 'The browser bridge is a Node.js service plus a Manifest V3 extension. Nothing else is required to control Chrome.'
      },
      optional,
      policy: {
        requiredRuntimes: ['node>=22'],
        embeddedRuntimes: false,
        optionalNote: 'Python, Go, Rust and REA are optional operator tools. A missing optional runtime is reported here, never treated as a browser or bridge failure.',
        pwshNote: 'pwsh is used only for chrome://extensions error-list maintenance; page control does not need it.'
      },
      recommendations: []
    };
    if (nodeMajor < 22) report.recommendations.push('Upgrade Node to 22 or newer; the service will refuse to run correctly on older runtimes.');
    if (!optional.pwsh.found && !optional.powershell.found) report.recommendations.push('No PowerShell found. Page control still works; clearing the chrome://extensions error list needs pwsh (PowerShell 7).');
    if (!optional.python.found) report.recommendations.push('Python is absent. This does not block the bridge; optional Python workers and REA-style offline analysis stay unavailable until it is installed.');
    if (!optional.rea.found) report.recommendations.push('REA is not on PATH. It is an optional reverse-engineering MCP peer, not a runtime requirement; install it only when offline page/bundle analysis is needed.');
    console.log(JSON.stringify(report, null, 2));
  } else if (cmd === 'heartbeat') {
    // Continuous inspection is a separate command so an operator or a scheduler
    // can run one cycle without starting a daemon. --watch is opt-in and is
    // meant to be started by the user, never launched implicitly by an agent.
    const { parseHeartbeatArgs, runHeartbeat, createHeartbeatRunner } = await import('./heartbeat.js');
    const opts = parseHeartbeatArgs(rest.slice(1));
    if (!opts.watch) {
      const result = await runHeartbeat(opts);
      console.log(JSON.stringify(result, null, 2));
      // An uncertain verdict is not a pass. Schedulers need a non-zero exit to
      // know that a cycle did not produce evidence of health.
      if (result.status === 'skipped' || result.verdict === 'critical' || result.verdict === 'uncertain') process.exitCode = 1;
    } else {
      const runner = await createHeartbeatRunner({ ...opts, onCycle: (result, cycle) => console.log(JSON.stringify({ cycle, ...result }, null, 2)) });
      const finish = () => runner.stop();
      process.on('SIGINT', finish);
      process.on('SIGTERM', finish);
      await runner.loop;
    }
  } else if (cmd === 'usage') {
    // Local operation evidence for heartbeat/review loops: per-tool and
    // per-host volume, errors, uncertain outcomes and latency percentiles.
    // Read-only; never starts the service and never calls the browser.
    const hoursAt = rest.indexOf('--hours');
    const hours = hoursAt >= 0 ? Number(rest[hoursAt + 1]) : 48;
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be a positive number');
    console.log(JSON.stringify(usageSummary(stateDir, Date.now(), { windowHours: hours }), null, 2));
  } else if (cmd === 'status') console.log(JSON.stringify(await request('/status'), null, 2));
  else if (cmd === 'diagnose-upgrade') console.log(JSON.stringify(upgradeDiagnosis(), null, 2));
  else if (cmd === 'upgrade-check') {
    const context = await collectUpgradeContext();
    const report = buildUpgradeCheck(context);
    console.log(JSON.stringify({ ...context, ...report }, null, 2));
  } else if (cmd === 'restart-service-when-idle') {
    // Dry run unless --apply. The same idle/listener/watchdog/build gates are
    // re-evaluated inside the service before anything exits; a signal is never
    // sent to an unverified pid.
    const timeoutAt = rest.indexOf('--timeout-ms');
    const pollAt = rest.indexOf('--poll-ms');
    const timeoutMs = timeoutAt >= 0 ? Number(rest[timeoutAt + 1]) : undefined;
    const pollMs = pollAt >= 0 ? Number(rest[pollAt + 1]) : undefined;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 5000)) throw new Error('--timeout-ms must be at least 5000');
    if (pollMs !== undefined && (!Number.isFinite(pollMs) || pollMs < 250)) throw new Error('--poll-ms must be at least 250');
    const config = loadConfig();
    const result = await restartServiceWhenIdle({
      request, root: ROOT, stateDir, port: config.port,
      apply: rest.includes('--apply'), timeoutMs, pollMs
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = result.status === 'waiting' ? 2 : 1;
  } else if (cmd === 'set-browser-target') {
    const flags = rest.slice(1);
    if (!flags.includes('--from-running-chrome')) throw new Error('Usage: node src/cli.js set-browser-target --from-running-chrome [--write]');
    console.log(JSON.stringify(setBrowserTarget(flags), null, 2));
  }
  else if (cmd === 'doctor') console.log(JSON.stringify(await doctor(), null, 2));
  else if (cmd === 'maintenance') {
    const input = name === '--stdin' ? readFileSync(0, 'utf8') : name || '{}';
    console.log(JSON.stringify(await request('/maintenance', JSON.parse(input)), null, 2));
  }
  else if (cmd === 'tools') console.log(JSON.stringify(await request('/tools'), null, 2));
  else if (cmd === 'call' || cmd === 'call-raw') {
    const input = args === '--stdin' ? readFileSync(0, 'utf8') : args || '{}';
    const parsed = JSON.parse(input);
    const raw = () => rawToolCall(name, parsed);
    const result = cmd === 'call-raw' || process.env.AIB_AUTO_WAIT === '0'
      ? await raw()
      : await callWithWaitingRecovery({ name, args: parsed, rawCall: rawToolCall, maxWaitMs: Number(process.env.AIB_AUTO_WAIT_MS || 120000) });
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error('Usage: node src/cli.js setup | doctor | diagnose-upgrade | allow-upload-root ABSOLUTE_PATH | agent list | agent show NAME | agent set NAME [JSON|--stdin] | agent remove NAME | instance list | instance add [NAME] | instance remove NAME | instance start NAME | instance stop NAME | instance start-all | instance stop-all | status | adapters [--stale-ms N] [--prune [--older-than-hours N] [--dry-run]] | processes | service-history [--limit N] | runtime | cdp-probe [--tab-id N] [--host-id ID] [--out FILE] | tools | call TOOL [JSON|--stdin] | call-raw TOOL [JSON|--stdin] | heartbeat [--watch] [--interval-ms N] [--timeout-ms N] [--max-cycles N] [--remediate] [--no-remediate] [--dry-run] | usage [--hours N] | upgrade-check | restart-service-when-idle [--apply] [--timeout-ms N] [--poll-ms N] | set-browser-target --from-running-chrome [--write]');
} catch (e) { console.error(e.message); process.exitCode = 1; }

