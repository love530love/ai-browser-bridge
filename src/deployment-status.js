// Read-only deployment convergence facts.
//
// `git pull` updates disk source only. The running service keeps its startup
// BUILD_ID, Chrome keeps the extension it loaded, and the config file may lack
// a field the new source expects. Those are three independent states, and a
// panel that only says "connected" cannot tell them apart from "upgraded".
//
// This module never writes anything. Disk identity is cached briefly so a
// dashboard poll does not hash the source tree on every request while still
// noticing a pull within the 30-second visibility budget.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBuildIdentity } from './build-identity.js';

export const EXPECTED_CONFIG_FIELDS = Object.freeze(['browserTarget', 'uploadRoots', 'uploadMaxBytes']);

const BUILD_CACHE_MS = 10000;
const CONFIG_CACHE_MS = 5000;
const cache = new Map();

function cached(key, ttlMs, now, produce) {
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = produce();
  cache.set(key, { at: now, value });
  return value;
}

// Exported for tests and for a future explicit refresh; a normal process never
// needs to call it because the TTL is already below the panel poll interval.
export function resetDeploymentCache() {
  cache.clear();
}

export function diskBuildIdentity(root, { now = Date.now(), ttlMs = BUILD_CACHE_MS, compute = computeBuildIdentity } = {}) {
  return cached(`build:${root}`, ttlMs, now, () => {
    try {
      return { buildId: compute(root), error: null };
    } catch (error) {
      return { buildId: null, error: `build_identity_unavailable: ${String(error?.message ?? error).slice(0, 200)}` };
    }
  });
}

export function diskManifestVersion(root, { now = Date.now(), ttlMs = BUILD_CACHE_MS } = {}) {
  return cached(`manifest:${root}`, ttlMs, now, () => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
      return { version: typeof manifest.version === 'string' ? manifest.version : null, error: null };
    } catch (error) {
      return { version: null, error: `manifest_unreadable: ${String(error?.message ?? error).slice(0, 200)}` };
    }
  });
}

export function diskPackageVersion(root, { now = Date.now(), ttlMs = BUILD_CACHE_MS } = {}) {
  return cached(`package:${root}`, ttlMs, now, () => {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      return { version: typeof pkg.version === 'string' ? pkg.version : null, error: null };
    } catch (error) {
      return { version: null, error: `package_unreadable: ${String(error?.message ?? error).slice(0, 200)}` };
    }
  });
}

// Presence only. Values are never copied into a status reply: one of these
// fields can hold a user-data path, and a dashboard does not need it.
export function configFieldPresence(configPath, { now = Date.now(), ttlMs = CONFIG_CACHE_MS } = {}) {
  return cached(`config:${configPath}`, ttlMs, now, () => {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      const missingFields = EXPECTED_CONFIG_FIELDS.filter(field => !Object.prototype.hasOwnProperty.call(raw, field));
      return { readable: true, missingFields, error: null };
    } catch (error) {
      return {
        readable: false,
        missingFields: [],
        error: `config_unreadable: ${String(error?.message ?? error).slice(0, 200)}`
      };
    }
  });
}

export function buildDeploymentStatus({
  root,
  runningBuildId = null,
  runningVersion = null,
  extensionVersion = null,
  configPath = null,
  now = Date.now(),
  compute = computeBuildIdentity
} = {}) {
  const disk = diskBuildIdentity(root, { now, compute });
  const manifest = diskManifestVersion(root, { now });
  const pkg = diskPackageVersion(root, { now });
  const config = configPath
    ? configFieldPresence(configPath, { now })
    : { readable: null, missingFields: [], error: null };

  const buildIdCheck = disk.buildId && runningBuildId
    ? (disk.buildId === runningBuildId ? 'current' : 'stale')
    : 'unavailable';
  const deploymentStale = buildIdCheck === 'stale';
  const extensionVersionSkew = !!(manifest.version && extensionVersion && manifest.version !== extensionVersion);
  const missingFields = config.readable ? config.missingFields : [];

  const actionRequired = [];
  if (deploymentStale) actionRequired.push('restart-service');
  if (extensionVersionSkew) actionRequired.push('reload-extension');
  if (missingFields.length > 0) actionRequired.push('write-config');

  return {
    checkedAt: new Date(now).toISOString(),
    diskVersion: pkg.version,
    manifestVersion: manifest.version,
    runningVersion,
    runningBuildId,
    extensionVersion,
    diskBuildId: disk.buildId,
    buildIdCheck,
    deploymentStale,
    extensionVersionSkew,
    configReadable: config.readable,
    configMissingFields: missingFields,
    upgradeRequired: actionRequired.length > 0,
    actionRequired,
    errors: [
      ...(disk.error ? [disk.error] : []),
      ...(manifest.error ? [manifest.error] : []),
      ...(pkg.error ? [pkg.error] : []),
      ...(config.error ? [config.error] : [])
    ]
  };
}
