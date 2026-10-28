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

// Comparing two user-data directories is how "the launcher opened the right
// browser" is decided, so the comparison itself is shared rather than rewritten
// at each call site with slightly different rules.
export const sameDirectory = (left, right) => Boolean(left) && Boolean(right) && normalize(left) === normalize(right);

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

// The id of an unpacked extension is derived from its absolute path, so it is
// stable for this project and is the fallback key when Chrome has stripped the
// path out of the record.
export const BRIDGE_EXTENSION_ID = 'mmopbppoabmhliflinadkgnedjpmbgig';

// Chrome compacts extension records on exit. A record that was
// {"path":"...","disable_reasons":[]} can come back as just
// {"disable_reasons":[16777216]} - the path is gone. Matching only on path then
// reports "not installed" for an extension that is installed and disabled, and
// the recommended fix ("Load unpacked") is the wrong one. So the id is checked
// as well, and a record that carries neither is not evidence of anything.
/**
 * @returns {{found: boolean, reason?: string, profileDirectory?: string, extensionId?: string,
 *   path?: string|null, enabled?: boolean, disableReasons?: number[], matchedBy?: string,
 *   candidates?: number}}
 */
export function findBridgeExtension({ userDataDir = chromeUserDataDir(), extensionDir = null,
  extensionId = BRIDGE_EXTENSION_ID } = {}) {
  if (!userDataDir || !existsSync(userDataDir)) return { found: false, reason: 'user_data_not_found' };
  const wanted = extensionDir ? normalize(extensionDir) : null;
  const matches = [];
  for (const profile of profilesWithSettings(userDataDir)) {
    for (const [id, value] of Object.entries(profile.settings)) {
      const declared = typeof value?.path === 'string' ? value.path : '';
      const byPath = Boolean(wanted) && Boolean(declared) && normalize(declared) === wanted;
      const byId = Boolean(extensionId) && id === extensionId;
      if (!byPath && !byId) continue;
      const disableReasons = Array.isArray(value.disable_reasons)
        ? value.disable_reasons.filter(reason => Number.isInteger(reason)) : [];
      matches.push({
        profileDirectory: profile.profileDirectory, extensionId: id, path: declared || null,
        enabled: disableReasons.length === 0, disableReasons,
        matchedBy: byPath ? 'path' : 'id'
      });
    }
  }
  if (!matches.length) return { found: false, reason: 'not_installed', userDataDir };
  // An enabled copy wins: a disabled leftover in another profile must not hide
  // the profile that can actually serve the bridge.
  const chosen = matches.find(match => match.enabled) ?? matches[0];
  return { found: true, ...chosen, candidates: matches.length };
}

// Chrome tracks extensions.ui.developer_mode behind a signed MAC. On a machine
// whose MAC seed no longer matches, the value is silently dropped on exit while
// the MAC is left behind, so developer mode never survives a restart. Reading
// the value (not the MAC) is what matters here: absent means off.
export function developerModeInEffect({ userDataDir = chromeUserDataDir(), profileDirectory = 'Default' } = {}) {
  if (!userDataDir) return null;
  const secure = readJson(join(userDataDir, profileDirectory, 'Secure Preferences'));
  if (!secure) return null;
  const value = secure?.extensions?.ui?.developer_mode;
  if (typeof value === 'boolean') return value;
  // A MAC without a value is the fingerprint of "this pref was dropped", which
  // is worth reporting differently from "never set".
  const mac = secure?.protection?.macs?.extensions?.ui?.developer_mode;
  if (typeof mac === 'string') return false;
  return null;
}

export const DISABLE_DEVELOPER_MODE = 16777216;

export function describeExtensionState(state, { developerMode = null } = {}) {
  if (!state?.found) {
    return state?.reason === 'not_installed'
      ? 'The bridge extension is not registered in any Chrome profile under this user data directory.'
      : `Chrome user data was not readable (${state?.reason ?? 'unknown'}).`;
  }
  if (state.enabled) return `Registered in profile "${state.profileDirectory}" and enabled.`;
  const reasons = Array.isArray(state.disableReasons) ? state.disableReasons : [];
  const developerModeOff = reasons.includes(DISABLE_DEVELOPER_MODE);
  if (!developerModeOff) {
    return `Chrome has disabled this extension in profile "${state.profileDirectory}" (disable_reasons ${JSON.stringify(reasons)}). Open chrome://extensions and enable 自主浏览器; until it is enabled nothing can dial back in.`;
  }
  // The interesting case: the reason is "developer mode is off", and on this
  // machine that is not something a human can fix once and forget.
  const persistence = developerMode === false
    ? ' Note that developer mode does not survive a restart here: Chrome dropped extensions.ui.developer_mode from Secure Preferences while leaving its MAC behind, which is what happens when the pref signature no longer validates.'
    : '';
  return `Chrome disabled this unpacked extension in profile "${state.profileDirectory}" because developer mode is off (disable_reasons ${JSON.stringify(reasons)}). It stays registered, so the fix is to switch developer mode back on in chrome://extensions rather than loading it again.${persistence}`;
}
