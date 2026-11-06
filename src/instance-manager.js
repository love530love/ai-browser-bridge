/**
 * Instance Manager - Manages multiple bridge server instances
 * Each instance runs on a separate port and connects to a different Chrome profile
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { listInstances } from './instance-config.js';

const STATE_DIR = process.env.AIB_STATE_DIR || '.local';
const PIDS_DIR = join(STATE_DIR, 'pids');

const pidFile = (instanceId) => join(PIDS_DIR, `${instanceId}.pid`);

function ensurePidsDir() {
  mkdirSync(PIDS_DIR, { recursive: true, mode: 0o700 });
}

function isInstanceRunning(instanceId) {
  const pf = pidFile(instanceId);
  if (!existsSync(pf)) return false;
  try {
    const pid = parseInt(readFileSync(pf, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      try { unlinkSync(pf); } catch {}
      return false;
    }
  } catch {
    return false;
  }
}

function startInstance(instanceId, options = {}) {
  const instance = listInstances().find(i => i.id === instanceId);
  if (!instance) {
    throw new Error(`Instance "${instanceId}" not found`);
  }
  if (!instance.enabled) {
    throw new Error(`Instance "${instanceId}" is disabled`);
  }
  if (isInstanceRunning(instanceId)) {
    throw new Error(`Instance "${instanceId}" is already running on port ${instance.port}`);
  }
  ensurePidsDir();
  const env = {
    ...process.env,
    AIB_PORT: String(instance.port),
    AIB_PROFILE: instance.profileDirectory || 'Default',
    AIB_USER_DATA_DIR: instance.userDataDir || '',
    AIB_CHROME_PATH: instance.chromePath || ''
  };
  const serverProcess = spawn('node', ['src/server.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  writeFileSync(pidFile(instanceId), String(serverProcess.pid));
  console.log(`Started instance "${instanceId}" on port ${instance.port} (PID: ${serverProcess.pid})`);
  return { instanceId, port: instance.port, pid: serverProcess.pid };
}

function stopInstance(instanceId) {
  const instance = listInstances().find(i => i.id === instanceId);
  if (!instance) {
    throw new Error(`Instance "${instanceId}" not found`);
  }
  const pf = pidFile(instanceId);
  if (!existsSync(pf)) {
    throw new Error(`Instance "${instanceId}" is not running`);
  }
  const pid = parseInt(readFileSync(pf, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }, 5000);
    try { unlinkSync(pf); } catch {}
    console.log(`Stopped instance "${instanceId}" (PID: ${pid})`);
    return { instanceId, pid, status: 'stopped' };
  } catch (error) {
    throw new Error(`Failed to stop instance "${instanceId}": ${error.message}`);
  }
}

function statusInstance(instanceId) {
  const instance = listInstances().find(i => i.id === instanceId);
  if (!instance) {
    throw new Error(`Instance "${instanceId}" not found`);
  }
  const running = isInstanceRunning(instanceId);
  return {
    ...instance,
    running,
    pidFile: pidFile(instanceId)
  };
}

function listAllInstances() {
  return listInstances().map(instance => ({
    ...instance,
    running: isInstanceRunning(instance.id)
  }));
}

function startAllInstances() {
  const instances = listInstances().filter(i => i.enabled);
  const results = [];
  for (const instance of instances) {
    try {
      const result = startInstance(instance.id);
      results.push({ ...result, status: 'started' });
    } catch (error) {
      results.push({ instanceId: instance.id, error: error.message, status: 'failed' });
    }
  }
  return results;
}

function stopAllInstances() {
  const instances = listInstances();
  const results = [];
  for (const instance of instances) {
    try {
      const result = stopInstance(instance.id);
      results.push(result);
    } catch (error) {
      results.push({ instanceId: instance.id, error: error.message, status: 'failed' });
    }
  }
  return results;
}

export {
  startInstance,
  stopInstance,
  statusInstance,
  listAllInstances,
  startAllInstances,
  stopAllInstances,
  isInstanceRunning,
  ensurePidsDir,
  pidFile
};
