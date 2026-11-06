import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const STATE_DIR = resolve(process.env.AIB_STATE_DIR || join(ROOT, '.local'));
export const INSTANCES_PATH = join(STATE_DIR, 'instances.json');

const DEFAULT_PORT = 19387;

function loadInstances() {
  if (!existsSync(INSTANCES_PATH)) {
    const defaultInstance = {
      id: 'default',
      name: 'default',
      port: DEFAULT_PORT,
      profileDirectory: 'Default',
      userDataDir: null,
      chromePath: null,
      enabled: true,
      created: new Date().toISOString()
    };
    return { version: 1, instances: [defaultInstance] };
  }
  const data = readFileSync(INSTANCES_PATH, 'utf8');
  const parsed = JSON.parse(data);
  if (!parsed.version) {
    // Upgrade old format
    if (Array.isArray(parsed)) {
      return { version: 1, instances: parsed.map((i, idx) => ({
        ...i,
        id: i.id || `instance_${idx}`,
        version: 1
      })) };
    } else {
      return { version: 1, instances: [{ ...parsed, id: 'default', version: 1 }] };
    }
  }
  return parsed;
}

function saveInstances(instances) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(INSTANCES_PATH, JSON.stringify(instances, null, 2), { mode: 0o600 });
}

function findNextAvailablePort(instances) {
  const usedPorts = new Set(instances.map(i => i.port));
  let port = DEFAULT_PORT;
  let attempts = 0;
  while (attempts < 100) {
    if (!usedPorts.has(port)) {
      return port;
    }
    port++;
    attempts++;
  }
  throw new Error(`No available port found near ${DEFAULT_PORT}`);
}

function getInstanceConfig(instanceId) {
  const instances = loadInstances();
  const instance = instances.instances.find(i => i.id === instanceId);
  if (!instance) {
    throw new Error(`Instance "${instanceId}" not found`);
  }
  return instance;
}

function listInstances() {
  return loadInstances().instances;
}

function enableInstance(instanceId) {
  const instances = loadInstances();
  const instance = instances.instances.find(i => i.id === instanceId);
  if (!instance) {
    throw new Error(`Instance "${instanceId}" not found`);
  }
  instance.enabled = true;
  saveInstances(instances);
  return instance;
}

function disableInstance(instanceId) {
  const instances = loadInstances();
  const instance = instances.instances.find(i => i.id === instanceId);
  if (!instance) {
    throw new Error(`Instance "${instanceId}" not found`);
  }
  instance.enabled = false;
  saveInstances(instances);
  return instance;
}

function removeInstance(instanceId) {
  const instances = loadInstances();
  const idx = instances.instances.findIndex(i => i.id === instanceId);
  if (idx === -1) {
    throw new Error(`Instance "${instanceId}" not found`);
  }
  const removed = instances.instances.splice(idx, 1)[0];
  saveInstances(instances);
  return removed;
}

function createInstance(config) {
  const instances = loadInstances();
  const instanceId = config.id || `instance_${Date.now()}`;
  if (instances.instances.find(i => i.id === instanceId)) {
    throw new Error(`Instance "${instanceId}" already exists`);
  }
  const instance = {
    id: instanceId,
    name: config.name || instanceId,
    port: config.port || findNextAvailablePort(instances.instances),
    profileDirectory: config.profileDirectory || 'Default',
    userDataDir: config.userDataDir || null,
    chromePath: config.chromePath || null,
    enabled: true,
    created: new Date().toISOString()
  };
  instances.instances.push(instance);
  saveInstances(instances);
  return instance;
}

export {
  loadInstances,
  saveInstances,
  getInstanceConfig,
  listInstances,
  enableInstance,
  disableInstance,
  removeInstance,
  createInstance
};
