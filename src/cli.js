import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configPath, loadConfig, ROOT, stateDir } from './config.js';
import { request } from './client.js';
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
  } else if (cmd === 'status') console.log(JSON.stringify(await request('/status'), null, 2));
  else if (cmd === 'tools') console.log(JSON.stringify(await request('/tools'), null, 2));
  else if (cmd === 'call') {
    const input = args === '--stdin' ? readFileSync(0, 'utf8') : args || '{}';
    console.log(JSON.stringify(await request('/call', { name, arguments: JSON.parse(input) }), null, 2));
  } else throw new Error('Usage: node src/cli.js setup | allow-upload-root ABSOLUTE_PATH | status | tools | call TOOL [JSON|--stdin]');
} catch (e) { console.error(e.message); process.exitCode = 1; }
