#!/usr/bin/env node
// The MCP server lives in the AI Browser Bridge repository, not in this
// plugin, so the plugin never ships a second copy of service code.
// Resolution order: AIB_ROOT, a pointer file, then common checkout locations.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function isBridgeRoot(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg.name === 'ai-browser-bridge' && existsSync(join(root, 'src', 'mcp.js'));
  } catch {
    return false;
  }
}

const pointerFile = join(homedir(), '.ai-browser-bridge-root');
const candidates = [];
if (process.env.AIB_ROOT) candidates.push(process.env.AIB_ROOT);
try {
  const line = readFileSync(pointerFile, 'utf8').split(/\r?\n/).map(s => s.trim()).find(Boolean);
  if (line) candidates.push(line);
} catch {}
for (const relative of ['PythonProjects5/AI-Browser-Bridge', 'AI-Browser-Bridge', 'projects/AI-Browser-Bridge', 'source/AI-Browser-Bridge']) {
  candidates.push(join(homedir(), relative));
}

const root = [...new Set(candidates)].map(p => resolve(p)).find(isBridgeRoot);
if (!root) {
  console.error([
    'AI Browser Bridge checkout not found.',
    'Set AIB_ROOT to its directory, or write the absolute path into',
    `${pointerFile}`,
    'then restart Qoder. The repository must have npm dependencies installed.'
  ].join('\n'));
  process.exit(2);
}

const child = spawn(process.execPath, [join(root, 'src', 'mcp.js')], {
  stdio: 'inherit',
  windowsHide: true
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { child.kill(signal); } catch {} });
}
child.on('error', (error) => {
  console.error(`Failed to start the bridge MCP adapter: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 1)));
