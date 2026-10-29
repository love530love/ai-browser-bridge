import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

export function validateNativeSnapshot(value, target, { allowDocuments = false } = {}) {
  if (value?.status !== 'success' || value.dispatched !== false || value.processId !== target.processId ||
      value.windowHandle !== target.windowHandle || !Array.isArray(value.controls) || value.controls.length > 400 ||
      typeof value.partial !== 'boolean') throw new Error('Invalid native snapshot evidence');
  const ids = new Set();
  for (const node of value.controls) {
    if (typeof node.ref !== 'string' || ids.has(node.ref) || typeof node.name !== 'string' || node.name.length > 300 ||
        !Array.isArray(node.patterns) || (node.role === 'ControlType.Document' && !allowDocuments) ||
        (node.parent !== null && !ids.has(node.parent))) throw new Error('Invalid native control tree');
    ids.add(node.ref);
    if (node.state !== undefined) {
      if (!node.state || typeof node.state !== 'object' || Array.isArray(node.state)) throw new Error('Invalid native state');
      const states = {
        expandCollapse: ['ExpandCollapse', ['Collapsed', 'Expanded', 'PartiallyExpanded', 'LeafNode', 'unknown']],
        toggle: ['Toggle', ['Off', 'On', 'Indeterminate', 'unknown']],
        selected: ['SelectionItem', [true, false, 'unknown']]
      };
      for (const [key, value] of Object.entries(node.state)) {
        const spec = states[key];
        if (!Object.hasOwn(states, key) || !spec[1].includes(value) ||
            !node.patterns.includes(`${spec[0]}PatternIdentifiers.Pattern`)) throw new Error('Invalid native state evidence');
      }
    }
  }
  return value;
}

export async function nativeUiSnapshot(target, { platform = process.platform, timeoutMs = 10000, includeDocuments = false } = {}) {
  if (platform !== 'win32') return { status: 'unavailable', dispatched: false, reason: 'platform_unsupported' };
  if (![target.processId, target.windowHandle].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Exact process and window required');
  const executable = (process.env.PATH ?? '').split(delimiter).map(p => join(p.replace(/^"|"$/g, ''), 'pwsh.exe')).find(existsSync);
  if (!executable) return { status: 'unavailable', dispatched: false, reason: 'powershell7_unavailable' };
  const script = fileURLToPath(new URL('../scripts/native-ui-snapshot.ps1', import.meta.url));
  return new Promise(resolve => {
    let output = ''; let settled = false; let timer;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const failed = reason => ({ status: 'failed', reason, dispatched: false, retryable: true });
    // includeDocuments is opt-in and only ever set by maintenance callers: by
    // default a native snapshot of browser chrome must not quietly become a read
    // of whatever page is in front. It exists because chrome:// pages are real
    // UI - chrome://extensions exposes its own controls once the document
    // subtree is walked, which is how the extension list became inspectable.
    const extra = includeDocuments ? ['-IncludeDocuments'] : [];
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', script, '-ChromeProcessId', String(target.processId), '-ChromeWindowHandle', String(target.windowHandle), ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    timer = setTimeout(() => { child.kill(); done(failed('native_snapshot_timeout')); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 512000) { child.kill(); done(failed('native_snapshot_output_limit')); }
    });
    child.on('error', () => done(failed('native_snapshot_spawn_failed')));
    child.on('close', code => {
      if (settled) return;
      try { if (code !== 0) throw Error(); done(validateNativeSnapshot(JSON.parse(output), target, { allowDocuments: includeDocuments })); }
      catch { done(failed('native_snapshot_invalid_result')); }
    });
  });
}
