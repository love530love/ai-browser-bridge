import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const stateDir = resolve(process.env.AIB_STATE_DIR || join(ROOT, '.local'));
export const configPath = join(stateDir, 'config.json');
export function loadConfig(create = false) {
  if (!existsSync(configPath)) {
    if (!create) throw new Error('Run npm run setup first.');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, JSON.stringify({
      port: 19387,
      agentToken: randomBytes(32).toString('hex'),
      extensionToken: randomBytes(32).toString('hex'),
      uploadRoots: []
    }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(config.agentToken) || !/^[a-f0-9]{64}$/.test(config.extensionToken) ||
      (config.uploadRoots !== undefined && (!Array.isArray(config.uploadRoots) || config.uploadRoots.some(root => typeof root !== 'string' || !root)))) {
    throw new Error('Invalid local configuration.');
  }
  return { ...config, uploadRoots: config.uploadRoots ?? [] };
}
