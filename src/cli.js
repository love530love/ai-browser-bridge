import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configPath, loadConfig, ROOT, stateDir } from './config.js';
import { request } from './client.js';
import { callWithWaitingRecovery } from './auto-recovery.js';
import { createAgentPolicy } from './policy.js';
import { regressionSummary } from './regression-summary.js';
import { computeBuildIdentity } from './build-identity.js';

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
    if (status.buildId !== expectedBuildId) report.recommendations.push('Service source identity differs or is unavailable. Arrange an idle service restart and verify again; matching version numbers alone do not prove current code is loaded.');
    add('deployment-current', status.version === expectedVersion && status.extensionVersion === manifestVersion && expectedVersion === manifestVersion,
      { expectedVersion, manifestVersion, serviceVersion: status.version, extensionVersion: status.extensionVersion ?? null });
    if (status.version !== expectedVersion) report.recommendations.push(`Running service differs from disk version ${expectedVersion}; restart the service when idle.`);
    if (status.extensionVersion !== manifestVersion) report.recommendations.push(`Loaded extension differs from disk version ${manifestVersion}; reload and verify before claiming deployment complete.`);
    add('service-status', status.service === 'ai-browser-bridge', { version: status.version });
    add('extension-connected', status.connected === true, { extensionVersion: status.extensionVersion ?? null });
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
  } catch (error) {
    add('service-status', false, { error: error.message });
    report.recommendations.push('Bridge service is not reachable on 127.0.0.1. Run start.ps1 and wait for status.');
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
  if (report.regressions.unexpectedFailures) report.recommendations.push('Review preserved local regression runs before upgrading. Injected fault runs are counted separately; do not replay failed writes.');
  if (report.regressions.unreadable) report.recommendations.push('Some regression reports were missing, malformed or too large to summarize; inspect them locally.');
  report.status = errors.length || report.regressions.unexpectedFailures || report.regressions.unreadable ? 'attention' : 'ready';
  writeFileSync(join(stateDir, 'upgrade-analysis.json'), JSON.stringify(report, null, 2), { encoding: 'utf8' });
  return report;
}

try {
  const [cmd, name, args] = process.argv.slice(2);
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
  } else if (cmd === 'agent') {
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
  } else if (cmd === 'status') console.log(JSON.stringify(await request('/status'), null, 2));
  else if (cmd === 'diagnose-upgrade') console.log(JSON.stringify(upgradeDiagnosis(), null, 2));
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
  } else throw new Error('Usage: node src/cli.js setup | doctor | diagnose-upgrade | allow-upload-root ABSOLUTE_PATH | agent list | agent show NAME | agent set NAME [JSON|--stdin] | agent remove NAME | status | tools | call TOOL [JSON|--stdin] | call-raw TOOL [JSON|--stdin]');
} catch (e) { console.error(e.message); process.exitCode = 1; }

