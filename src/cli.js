import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
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
  } else if (cmd === 'status') console.log(JSON.stringify(await request('/status'), null, 2));
  else if (cmd === 'diagnose-upgrade') console.log(JSON.stringify(upgradeDiagnosis(), null, 2));
  else if (cmd === 'upgrade-check') {
    const context = await collectUpgradeContext();
    const report = buildUpgradeCheck(context);
    console.log(JSON.stringify({ ...context, ...report }, null, 2));
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
  } else throw new Error('Usage: node src/cli.js setup | doctor | diagnose-upgrade | allow-upload-root ABSOLUTE_PATH | agent list | agent show NAME | agent set NAME [JSON|--stdin] | agent remove NAME | instance list | instance add [NAME] | instance remove NAME | instance start NAME | instance stop NAME | instance start-all | instance stop-all | status | tools | call TOOL [JSON|--stdin] | call-raw TOOL [JSON|--stdin] | heartbeat [--watch] [--interval-ms N] [--timeout-ms N] [--max-cycles N] [--remediate] [--no-remediate] [--dry-run] | upgrade-check | set-browser-target --from-running-chrome [--write]');
} catch (e) { console.error(e.message); process.exitCode = 1; }

