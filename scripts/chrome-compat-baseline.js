// Capture the Chrome facts this project's non-DOM paths depend on, so a browser
// update can be diffed instead of guessed at.
//
// A version bump cannot break the DOM tools in an interesting way: the page API
// is the page API. What it does break is everything this project drives by
// identity - Windows UI Automation automation ids (view_1012, showPasswordButton,
// view_1026), the shape of the native control tree, and the CDP domains behind
// the debugger and capture tools. Those were measured once on one version and
// are re-measured here, because "it worked on 154" is not a fact about 156.
//
//   node scripts/chrome-compat-baseline.js                 capture a baseline
//   node scripts/chrome-compat-baseline.js --diff A B      compare two captures
//
// Captures land in .local/chrome-compat-<version>.json and are never committed:
// they contain the names of the user's toolbar buttons, which is machine state,
// not product state.
//
// It opens no tabs and touches no page. Everything here comes from the bridge's
// own status, the extension's user-agent client hints and one native snapshot.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../src/client.js';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT_DIR = join(ROOT, '.local');
const agent = 'compat-baseline';
const call = async (name, args = {}) => (await request('/call', { name, arguments: { ...args, agent } })).result;

const INSTALL_ROOTS = [
  'C:\\Program Files\\Google\\Chrome\\Application',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application',
  'D:\\Program Files\\Google\\Chrome\\Application',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application')
];

// A version directory holds chrome.dll and a <version>.manifest; chrome.exe sits
// one level up at Application\chrome.exe, so testing for the exe finds nothing.
function installedVersions() {
  const found = [];
  for (const root of INSTALL_ROOTS) {
    if (!root || !existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(entry)) continue;
      const dir = join(root, entry);
      if (existsSync(join(dir, 'chrome.dll')) || existsSync(join(dir, `${entry}.manifest`))) {
        // The same build can be installed under more than one root; the diff
        // cares about versions, not about how many copies exist on disk.
        if (!found.some(item => item.version === entry)) found.push({ root, version: entry });
      }
    }
  }
  return found;
}

const compareVersions = (a, b) => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
};

// The version the browser reports about itself, not the one on disk: an update
// downloads next to the running build, so the two disagree until the restart.
// That disagreement is the useful signal, so both are kept.
async function runningBrowserVersion(status) {
  const health = await call('browser_health', {}).catch(() => null);
  return {
    version: status?.browserVersion ?? health?.browser?.version ?? null,
    major: status?.browserMajor ?? health?.browser?.major ?? null,
    source: status?.browserIdentitySource ?? health?.browser?.source ?? null,
    brands: health?.browser?.brands ?? null
  };
}

// Only the toolbar matters for identity: the app menu, the bookmarks button, the
// profile button and the extension buttons are what any menu-driving flow binds
// to. Names are kept as a hash plus a bounded prefix so the file is useful in a
// diff without becoming a copy of the user's bookmarks bar.
const inventory = controls => {
  const rows = [];
  for (const control of controls) {
    if (!control.automationId) continue;
    rows.push({
      automationId: control.automationId,
      role: control.role,
      state: control.state && Object.keys(control.state).length ? control.state : null,
      patterns: control.patterns,
      nameHash: createHash('sha256').update(control.name ?? '').digest('hex').slice(0, 12),
      namePrefix: String(control.name ?? '').slice(0, 48)
    });
  }
  return rows.sort((a, b) => a.automationId.localeCompare(b.automationId));
};

async function capture() {
  const status = await call('browser_queue_status', {});
  const listed = await call('browser_desktop_windows', {});
  if (listed?.status !== 'success' || (listed.windows ?? []).length !== 1) {
    throw new Error(`expected exactly one visible Chrome window, got ${JSON.stringify(listed?.windows ?? listed)}`);
  }
  const target = { processId: listed.windows[0].processId, windowHandle: listed.windows[0].windowHandle };
  const snapshot = await call('browser_native_snapshot', target);
  if (snapshot?.status !== 'success') throw new Error(`native snapshot unavailable: ${JSON.stringify(snapshot).slice(0, 200)}`);
  const running = await runningBrowserVersion(status);
  const installed = installedVersions();
  const pending = running.version
    ? installed.map(item => item.version).filter(version => compareVersions(version, running.version) > 0).sort(compareVersions).pop() ?? null
    : null;
  return {
    capturedAt: new Date().toISOString(),
    bridgeVersion: status?.version ?? null,
    extensionVersion: status?.extensionVersion ?? null,
    running,
    pendingUpdate: pending,
    installed,
    target,
    snapshot: { controls: snapshot.controls.length, partial: snapshot.partial, omittedDocuments: snapshot.omittedDocuments },
    inventory: inventory(snapshot.controls),
    label: running.version ?? (running.major ? `major-${running.major}` : 'unknown')
  };
}

function diff(a, b) {
  const lines = [];
  lines.push(`browser   ${a.running?.version ?? a.label}  ->  ${b.running?.version ?? b.label}`);
  lines.push(`extension ${a.extensionVersion}  ->  ${b.extensionVersion}`);
  lines.push(`bridge    ${a.bridgeVersion}  ->  ${b.bridgeVersion}`);
  lines.push(`controls  ${a.snapshot.controls}  ->  ${b.snapshot.controls}   (partial ${a.snapshot.partial} -> ${b.snapshot.partial}, omittedDocuments ${a.snapshot.omittedDocuments} -> ${b.snapshot.omittedDocuments})`);
  const byId = list => new Map(list.map(row => [row.automationId, row]));
  const before = byId(a.inventory);
  const after = byId(b.inventory);
  const gone = [...before.keys()].filter(id => !after.has(id));
  const added = [...after.keys()].filter(id => !before.has(id));
  const changed = [...before.keys()].filter(id => after.has(id) && (
    after.get(id).nameHash !== before.get(id).nameHash ||
    after.get(id).role !== before.get(id).role ||
    JSON.stringify(after.get(id).state) !== JSON.stringify(before.get(id).state) ||
    JSON.stringify(after.get(id).patterns) !== JSON.stringify(before.get(id).patterns)));
  if (gone.length) lines.push(`\nGONE (bound by id in this project, must be re-discovered):\n${gone.map(id => `  ${id}  ${before.get(id).role}  "${before.get(id).namePrefix}"`).join('\n')}`);
  if (added.length) lines.push(`\nNEW:\n${added.map(id => `  ${id}  ${after.get(id).role}  "${after.get(id).namePrefix}"`).join('\n')}`);
  if (changed.length) lines.push(`\nCHANGED:\n${changed.map(id => `  ${id}  ${before.get(id).role} -> ${after.get(id).role}  state ${JSON.stringify(before.get(id).state)} -> ${JSON.stringify(after.get(id).state)}  name ${before.get(id).nameHash === after.get(id).nameHash ? 'same' : 'DIFFERENT'}`).join('\n')}`);
  if (!gone.length && !added.length && !changed.length) lines.push('\nno automation id, role, state or pattern changed');
  return lines.join('\n');
}

const args = process.argv.slice(2);
if (args[0] === '--diff') {
  if (!args[1] || !args[2]) {
    console.error('usage: node scripts/chrome-compat-baseline.js --diff <before.json> <after.json>');
    process.exit(2);
  }
  console.log(diff(JSON.parse(readFileSync(args[1], 'utf8')), JSON.parse(readFileSync(args[2], 'utf8'))));
} else {
  const result = await capture();
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `chrome-compat-${String(result.label).replace(/[^\d.a-z-]/gi, '')}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`captured ${result.label}  (identity source: ${result.running?.source ?? 'unknown'})`);
  console.log(`  bridge ${result.bridgeVersion} / extension ${result.extensionVersion}`);
  console.log(`  installed on disk: ${result.installed.map(item => item.version).join(', ') || 'none found'}`);
  if (result.pendingUpdate) console.log(`  PENDING UPDATE: ${result.pendingUpdate} is downloaded and applies on the next browser restart`);
  console.log(`  controls: ${result.snapshot.controls}  partial=${result.snapshot.partial}  omittedDocuments=${result.snapshot.omittedDocuments}`);
  console.log(`  identity rows: ${result.inventory.length}`);
  console.log(`  written: ${file}`);
}
