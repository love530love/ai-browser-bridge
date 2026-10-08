import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configPath, loadConfig, ROOT, stateDir } from './config.js';
import { request } from './client.js';
import { callWithWaitingRecovery } from './auto-recovery.js';
import { createAgentPolicy } from './policy.js';

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
  else if (cmd === 'doctor') console.log(JSON.stringify(await doctor(), null, 2));
  else if (cmd === 'tools') console.log(JSON.stringify(await request('/tools'), null, 2));
  else if (cmd === 'call' || cmd === 'call-raw') {
    const input = args === '--stdin' ? readFileSync(0, 'utf8') : args || '{}';
    const parsed = JSON.parse(input);
    const raw = () => rawToolCall(name, parsed);
    const result = cmd === 'call-raw' || process.env.AIB_AUTO_WAIT === '0'
      ? await raw()
      : await callWithWaitingRecovery({ name, args: parsed, rawCall: rawToolCall, maxWaitMs: Number(process.env.AIB_AUTO_WAIT_MS || 120000) });
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error('Usage: node src/cli.js setup | doctor | allow-upload-root ABSOLUTE_PATH | agent list | agent show NAME | agent set NAME [JSON|--stdin] | agent remove NAME | status | tools | call TOOL [JSON|--stdin] | call-raw TOOL [JSON|--stdin]');
} catch (e) { console.error(e.message); process.exitCode = 1; }

