import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFileSync(join(ROOT, relative), 'utf8');
const installSrc = read('install-autostart.ps1');
const uninstallSrc = read('uninstall-autostart.ps1');

// Static contract: install writes both shared files, uninstall consumes the
// manifest and empties it, and both sides reference the SAME format.
test('install 固化 runtime.json 并按 Method 写 autostart-registry.json 清单', () => {
  assert.match(installSrc, /\.local\/runtime\.json|runtime\.json/, 'install 未写 runtime.json');
  assert.match(installSrc, /pwsh\s*=\s*\$pwsh/, 'runtime.json 缺少 pwsh 绝对路径');
  assert.match(installSrc, /node\s*=\s*\$node/, 'runtime.json 缺少 node 绝对路径');
  assert.match(installSrc, /resolvedAt\s*=\s*\[DateTimeOffset\]::Now\.ToString\('o'\)/, 'runtime.json 缺少 resolvedAt');
  assert.match(installSrc, /autostart-registry\.json/, 'install 未写注册清单');
  assert.match(installSrc, /version\s*=\s*1/, '清单缺少 version=1');
  assert.match(installSrc, /updatedAt/, '清单缺少 updatedAt');
  assert.match(installSrc, /startup-shortcut/, '清单缺少 StartupFolder 条目');
  assert.match(installSrc, /registry-run/, '清单缺少 Registry 条目');
  assert.match(installSrc, /ConvertTo-Json -Depth 6/, '未用 ConvertTo-Json -Depth 6');
  assert.match(installSrc, /Set-Content[^\n]*-Encoding utf8/, '写文件未用 utf8');
  assert.match(installSrc, /\[System\.IO\.File\]::Delete/, '安装器丢失 [System.IO.File]::Delete 消标记约定');
  assert.match(installSrc, /\[switch\]\$StatusOnly/, '缺少 -StatusOnly 开关');
  // Manifest is overwritten (not appended) so switching Method leaves no ghost.
  assert.match(installSrc, /entries\s*=\s*\$entries\.ToArray\(\)/, '清单 entries 未整体覆盖写入');
});

test('uninstall 按 entries 逐项清理、清空 entries 并保留清单文件', () => {
  assert.match(uninstallSrc, /Read-AutostartRegistry/, 'uninstall 未读取清单');
  assert.match(uninstallSrc, /\$reg\.entries/, 'uninstall 未按 entries 迭代');
  assert.match(uninstallSrc, /Remove-AutostartEntry/, 'uninstall 未逐项清理');
  assert.match(uninstallSrc, /已移除/, '缺少「已移除」输出');
  assert.match(uninstallSrc, /未找到/, '缺少「未找到」输出');
  assert.match(uninstallSrc, /entries\s*=\s*@\(\)/, '清理后未把 entries 写成空数组');
  assert.match(uninstallSrc, /updatedAt/, '清空清单未更新 updatedAt');
  assert.match(uninstallSrc, /watchdog-disabled/, '丢失 watchdog-disabled 标记写入');
  assert.match(uninstallSrc, /\[System\.IO\.File\]::Delete/, '.local 文件未沿用 .NET 删除约定');
});

test('两边引用同一份清单格式，且外部计划任务只报告不删除', () => {
  for (const [name, source] of [['install', installSrc], ['uninstall', uninstallSrc]]) {
    assert.match(source, /autostart-registry\.json/, `${name} 未引用清单文件`);
    assert.match(source, /version\s*=\s*1/, `${name} 清单缺少 version`);
    assert.match(source, /updatedAt/, `${name} 清单缺少 updatedAt`);
    assert.match(source, /entries/, `${name} 清单缺少 entries`);
    assert.match(source, /startup-shortcut/, `${name} 未识别 startup-shortcut 格式`);
    assert.match(source, /registry-run/, `${name} 未识别 registry-run 格式`);
    assert.match(source, /不会自动删除外部计划任务/, `${name} 缺少「不删除外部计划任务」守卫`);
    assert.match(source, /AI Browser Bridge Watchdog/, `${name} 缺少外部计划任务名称`);
  }
  assert.match(uninstallSrc, /unknown|未能确认/, 'uninstall 未报告 unknown');
  assert.match(uninstallSrc, /不宣称「自启已全部清除」/, 'uninstall 不应声称全部清除');
  assert.match(installSrc, /external: true managed: false/, '-StatusOnly 未标注外部项 external/managed');
});

// Real boundary: -StatusOnly is a pure read. Never runs the install/uninstall
// write paths, so it cannot register or delete the user's real autostart items.
test('真实边界：-StatusOnly 列出每个 entry 的 kind/path，空清单明确说明，且全程只读', t => {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command pwsh.exe).Source'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('pwsh.exe 不可用，跳过 -StatusOnly 实跑边界测试');
    return;
  }
  const temp = mkdtempSync(join(tmpdir(), 'bridge-autostart-status-'));
  try {
    mkdirSync(join(temp, '.local'), { recursive: true });
    const script = join(temp, 'install-autostart.ps1');
    // Copy both scripts into the sandbox project; only -StatusOnly (read-only)
    // is ever executed, so no real autostart item or scheduled task is touched.
    copyFileSync(join(ROOT, 'install-autostart.ps1'), script);
    copyFileSync(join(ROOT, 'uninstall-autostart.ps1'), join(temp, 'uninstall-autostart.ps1'));
    const registryFile = join(temp, '.local', 'autostart-registry.json');

    const entries = [
      { kind: 'startup-shortcut', path: 'C:\\Temp\\AI Browser Bridge.lnk', target: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', arguments: '-NoProfile -WindowStyle Hidden -File watcher.ps1' },
      { kind: 'registry-run', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'AIBrowserBridge', value: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile' },
    ];
    const manifestText = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries });
    writeFileSync(registryFile, manifestText);

    const run = () => spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-StatusOnly'], { encoding: 'utf8', timeout: 30000 });

    const withEntries = run();
    assert.equal(withEntries.status, 0, `pwsh -StatusOnly 失败: ${withEntries.stderr}\n${withEntries.stdout}`);
    const out1 = withEntries.stdout;
    assert.match(out1, /kind=startup-shortcut/, '输出缺少 startup-shortcut 的 kind');
    assert.match(out1, /kind=registry-run/, '输出缺少 registry-run 的 kind');
    assert.ok(out1.includes(entries[0].path), `输出缺少 startup-shortcut 的 path: ${entries[0].path}`);
    assert.ok(out1.includes(entries[1].key), '输出缺少 registry-run 的 key');
    assert.ok(out1.includes(entries[1].name), '输出缺少 registry-run 的 name');
    assert.match(out1, /\[managed manifest entry\]/, '输出未标注「项目管理的」清单项');
    assert.match(out1, /external: true managed: false/, '输出未把外部计划任务标为 external/managed: false');
    // Pure read: the manifest must be byte-for-byte unchanged, and no install
    // side-effect files may have been created.
    assert.equal(readFileSync(registryFile, 'utf8'), manifestText, '-StatusOnly 不应改写清单');
    assert.ok(!existsSync(join(temp, '.local', 'runtime.json')), '-StatusOnly 不应写 runtime.json');

    writeFileSync(registryFile, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: [] }));
    const empty = run();
    assert.equal(empty.status, 0, `pwsh -StatusOnly(empty) 失败: ${empty.stderr}\n${empty.stdout}`);
    assert.match(empty.stdout, /managed entries: none/i, '空清单时输出缺少明确说明');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
