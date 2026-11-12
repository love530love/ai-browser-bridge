import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inferBrowserTarget } from '../src/browser-target.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

// A real on-disk fixture: a fake chrome.exe file and a real user-data directory
// (deliberately with a space in the name, to exercise quoted --user-data-dir).
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-bt-'));
  const exePath = join(root, 'chrome.exe');
  const userDataDir = join(root, 'User Data');
  writeFileSync(exePath, 'MZ fake chrome executable');
  mkdirSync(userDataDir);
  return { root, exePath, userDataDir };
}

function withFixture(fn) {
  const fx = makeFixture();
  try { return fn(fx); } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

function visibleRecord(exePath, commandLine, pid = 4242) {
  return { ProcessId: pid, ExecutablePath: exePath, CommandLine: commandLine, MainWindowHandle: 987654, MainWindowTitle: 'Chrome' };
}

function runCli(args, extraEnv) {
  return spawnSync(process.execPath, [join(PROJECT_ROOT, 'src', 'cli.js'), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...extraEnv }
  });
}

test('non-Windows returns an explicit reason and never runs the process query', () => {
  const result = inferBrowserTarget({ platform: 'linux', run: () => { throw new Error('must not run'); } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_platform');
  assert.ok(result.detail);
});

test('injected run: a visible window yields a parsed target and never uses the registry', () => {
  withFixture(fx => {
    const commandLine = `--user-data-dir="${fx.userDataDir}" --profile-directory="Profile 2" --no-first-run`;
    const result = inferBrowserTarget({ platform: 'win32', run: () => [visibleRecord(fx.exePath, commandLine)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.target.exePath, fx.exePath);
    assert.equal(result.target.userDataDir, fx.userDataDir);
    assert.equal(result.target.profileDirectory, 'Profile 2');
    assert.equal(result.target.channel, 'stable');
    assert.equal(result.evidence.registryUsed, false);
    assert.equal(result.evidence.visibleWindowCount, 1);
    assert.equal(result.evidence.userDataDirFrom, 'command-line --user-data-dir');
  });
});

test('injected run: 有/无可见窗口 produce different outcomes', () => {
  withFixture(fx => {
    const withWindow = inferBrowserTarget({
      platform: 'win32',
      run: () => [visibleRecord(fx.exePath, `--user-data-dir="${fx.userDataDir}" --profile-directory=Default`)]
    });
    const withoutWindow = inferBrowserTarget({
      platform: 'win32',
      run: () => [
        { ProcessId: 1, ExecutablePath: fx.exePath, CommandLine: '--type=renderer', MainWindowHandle: 0, MainWindowTitle: '' },
        { ProcessId: 2, ExecutablePath: fx.exePath, CommandLine: '--type=gpu-process', MainWindowHandle: 0, MainWindowTitle: '' }
      ]
    });
    assert.equal(withWindow.ok, true);
    assert.equal(withoutWindow.ok, false);
    assert.equal(withoutWindow.reason, 'no_visible_window');
  });
});

test('missing flags fall back to Chrome default user-data dir and Default profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-bt-'));
  try {
    const exePath = join(root, 'chrome.exe');
    writeFileSync(exePath, 'MZ');
    const localAppData = join(root, 'LOCALAPPDATA');
    const defaultUserDataDir = join(localAppData, 'Google', 'Chrome', 'User Data');
    mkdirSync(defaultUserDataDir, { recursive: true });
    const result = inferBrowserTarget({
      platform: 'win32',
      run: () => [visibleRecord(exePath, '--no-first-run')],
      env: { LOCALAPPDATA: localAppData }
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.target.userDataDir, defaultUserDataDir);
    assert.equal(result.target.profileDirectory, 'Default');
    assert.equal(result.evidence.userDataDirFrom, 'chrome-default-for-channel');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a non-existent ExecutablePath -> ok:false with a path reason', () => {
  const result = inferBrowserTarget({
    platform: 'win32',
    run: () => [visibleRecord(join(tmpdir(), 'bridge-bt-missing-never-created', 'chrome.exe'), '--profile-directory=Default')]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exe_path_not_found');
});

test('two different visible windows -> ambiguous, never guesses', () => {
  withFixture(fx => {
    const result = inferBrowserTarget({
      platform: 'win32',
      run: () => [
        visibleRecord(fx.exePath, `--user-data-dir="${fx.userDataDir}" --profile-directory=Default`, 1),
        visibleRecord(fx.exePath, `--user-data-dir="${join(fx.root, 'Other Data')}" --profile-directory=Default`, 2)
      ]
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ambiguous_visible_window');
  });
});

test('a throwing process query is reported as query_failed, not a crash', () => {
  const result = inferBrowserTarget({ platform: 'win32', run: () => { throw new Error('cim boom'); } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'query_failed');
  assert.match(result.detail, /cim boom/);
});

// dry-run semantics at the module level: inferBrowserTarget only suggests, it
// never writes config.json. A real sentinel config file must survive untouched.
test('dry-run: inference never writes a temp config.json (mkdtemp boundary)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-bt-'));
  try {
    const configFile = join(root, 'config.json');
    const sentinel = JSON.stringify({ port: 19387, marker: 'unchanged-by-inference' });
    writeFileSync(configFile, sentinel);
    const exePath = join(root, 'chrome.exe');
    writeFileSync(exePath, 'MZ');
    const userDataDir = join(root, 'User Data');
    mkdirSync(userDataDir);
    const result = inferBrowserTarget({
      platform: 'win32',
      run: () => [visibleRecord(exePath, `--user-data-dir="${userDataDir}" --profile-directory=Default`)]
    });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(configFile, 'utf8'), sentinel);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Command-level dry-run / --write gating. AIB_CHROME_PROCESSES_JSON injects the
// process data so no PowerShell is spawned; AIB_STATE_DIR points config.json at
// a mkdtemp dir. No secrets are ever present in config or in assertions.
function cliFixture() {
  const fx = makeFixture();
  const processes = [visibleRecord(fx.exePath, `--user-data-dir="${fx.userDataDir}" --profile-directory=Default`)];
  const configFile = join(fx.root, 'config.json');
  const original = JSON.stringify({ port: 19387, marker: 'sentinel' });
  writeFileSync(configFile, original);
  const env = {
    AIB_STATE_DIR: fx.root,
    AIB_CHROME_PROCESSES_JSON: JSON.stringify(processes)
  };
  return { fx, env, configFile, original };
}

test('set-browser-target default is dry-run: written:false and config.json untouched', () => {
  const { fx, env, configFile, original } = cliFixture();
  try {
    const run = runCli(['set-browser-target', '--from-running-chrome'], env);
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const out = JSON.parse(run.stdout);
    assert.equal(out.written, false);
    assert.equal(out.dryRun, true);
    assert.equal(out.target.exePath, fx.exePath);
    assert.equal(readFileSync(configFile, 'utf8'), original);
    assert.equal('browserTarget' in JSON.parse(readFileSync(configFile, 'utf8')), false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('set-browser-target --write persists only browserTarget and preserves other fields', () => {
  const { fx, env, configFile } = cliFixture();
  try {
    const run = runCli(['set-browser-target', '--from-running-chrome', '--write'], env);
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const out = JSON.parse(run.stdout);
    assert.equal(out.written, true);
    const written = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(written.marker, 'sentinel');
    assert.equal(written.port, 19387);
    assert.ok(written.browserTarget);
    assert.equal(written.browserTarget.exePath, fx.exePath);
    assert.equal(written.browserTarget.userDataDir, fx.userDataDir);
    assert.equal(written.browserTarget.profileDirectory, 'Default');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
