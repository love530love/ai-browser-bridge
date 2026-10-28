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
      uploadRoots: [],
      // Off means every call that needs the extension while no browser is
      // running comes back as extension_disconnected. On means the bridge starts
      // the user's own Chrome and then runs that call. It is opt-in in the file
      // rather than implied, so an operator can see and change the behaviour
      // without reading the source.
      autoLaunchBrowser: true
    }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // A machine can carry several Chrome installs side by side (stable, Beta, Dev,
  // Canary/SxS) and each one keeps its own user-data directory. Picking between
  // them by heuristic opens the wrong browser eventually, and to the person whose
  // logins are in the other one that looks like a wiped session. So the target is
  // recorded once, by whoever knows, and then always used verbatim.
  const target = config.browserTarget;
  const validTarget = target === undefined || (target && typeof target === 'object' &&
    typeof target.exePath === 'string' && target.exePath.length > 0 &&
    (target.userDataDir === undefined || typeof target.userDataDir === 'string') &&
    (target.profileDirectory === undefined || (typeof target.profileDirectory === 'string' && /^(Default|Profile \d+)$/.test(target.profileDirectory))) &&
    (target.channel === undefined || typeof target.channel === 'string'));
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(config.agentToken) || !/^[a-f0-9]{64}$/.test(config.extensionToken) ||
      (config.uploadRoots !== undefined && (!Array.isArray(config.uploadRoots) || config.uploadRoots.some(root => typeof root !== 'string' || !root))) ||
      (config.contentBoundaries !== undefined && typeof config.contentBoundaries !== 'boolean') ||
      (config.autoLaunchBrowser !== undefined && typeof config.autoLaunchBrowser !== 'boolean') ||
      !validTarget ||
      (config.requireAgentIdentity !== undefined && typeof config.requireAgentIdentity !== 'boolean')) {
    throw new Error('Invalid local configuration.');
  }
  return { ...config, uploadRoots: config.uploadRoots ?? [], contentBoundaries: config.contentBoundaries === true,
    browserTarget: validTarget && target ? target : null };
}
