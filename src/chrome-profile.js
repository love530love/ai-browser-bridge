// Which Chrome profile has the bridge extension, and is it switched on?
//
// This matters because "the extension did not connect" has two completely
// different causes and they look identical from the service: the browser may not
// have the extension at all (wrong profile), or Chrome may have disabled it. The
// first needs a different profile on the command line, the second needs a human
// to switch it back on. Both answers are on disk, so neither has to be guessed.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const chromeUserDataDir = () => join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data');

const normalize = value => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();

const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

// Chrome keeps extension records in "Secure Preferences" (signed) and, for some
// builds, plain "Preferences". Both are read because which one holds the record
// has changed between versions.
function profilesWithSettings(userDataDir) {
  const found = [];
  let entries;
  try { entries = readdirSync(userDataDir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue;
    for (const file of ['Secure Preferences', 'Preferences']) {
      const path = join(userDataDir, entry.name, file);
      if (!existsSync(path)) continue;
      const settings = readJson(path)?.extensions?.settings;
      if (settings && typeof settings === 'object') found.push({ profileDirectory: entry.name, settings, source: file });
    }
  }
  return found;
}

/**
 * @returns {{found: boolean, reason?: string, profileDirectory?: string, extensionId?: string,
 *   path?: string, enabled?: boolean, disableReasons?: number[], candidates?: number}}
 */
export function findBridgeExtension({ userDataDir = chromeUserDataDir(), extensionDir = null } = {}) {
  if (!userDataDir || !existsSync(userDataDir)) return { found: false, reason: 'user_data_not_found' };
  const wanted = extensionDir ? normalize(extensionDir) : null;
  const matches = [];
  for (const profile of profilesWithSettings(userDataDir)) {
    for (const [extensionId, value] of Object.entries(profile.settings)) {
      const declared = typeof value?.path === 'string' ? value.path : '';
      if (!declared) continue;
      if (wanted && normalize(declared) !== wanted) continue;
      const disableReasons = Array.isArray(value.disable_reasons)
        ? value.disable_reasons.filter(reason => Number.isInteger(reason)) : [];
      matches.push({
        profileDirectory: profile.profileDirectory, extensionId, path: declared,
        enabled: disableReasons.length === 0, disableReasons
      });
    }
  }
  if (!matches.length) return { found: false, reason: 'not_installed', userDataDir };
  // An enabled copy wins: a disabled leftover in another profile must not hide
  // the profile that can actually serve the bridge.
  const chosen = matches.find(match => match.enabled) ?? matches[0];
  return { found: true, ...chosen, candidates: matches.length };
}

export function describeExtensionState(state) {
  if (!state?.found) {
    return state?.reason === 'not_installed'
      ? 'The bridge extension is not installed in any Chrome profile under this user data directory.'
      : `Chrome user data was not readable (${state?.reason ?? 'unknown'}).`;
  }
  if (state.enabled) return `Loaded in profile "${state.profileDirectory}" and enabled.`;
  return `Chrome has disabled this extension in profile "${state.profileDirectory}" (disable_reasons ${JSON.stringify(state.disableReasons)}). Open chrome://extensions, turn on Developer mode (开发者模式) and enable 自主浏览器: an unpacked extension is exactly what Chrome disables when that mode is off, and until it is enabled nothing can dial back in.`;
}
