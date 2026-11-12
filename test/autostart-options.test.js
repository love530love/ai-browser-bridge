// P0-2 assembly + P2-9 opt-in autostart options.
// Static contract assertions (the switches are OFF by default and must stay
// that way; the watchdog detects stale source READ ONLY and never restarts),
// plus real boundaries that run the scripts without ever registering or
// deleting any real autostart item / scheduled task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFileSync(join(ROOT, relative), 'utf8');
const installSrc = read('install-autostart.ps1');
const uninstallSrc = read('uninstall-autostart.ps1');
const watchSrc = read('scripts/watch-service.ps1');

// The exact stale branch, with comment lines removed so a comment can never
// satisfy / mask a "does not kill / pause / stop" assertion.
const staleStart = watchSrc.indexOf("if ($staleVerdict -eq 'stale') {");
const staleEnd = watchSrc.indexOf("} elseif ($staleVerdict -eq 'unknown')", staleStart);
const staleBranch = watchSrc.slice(staleStart, staleEnd)
  .split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n');

// ---------------------------------------------------------------- switches

test('两个可选开关存在，且默认不启用（新增注册逻辑都在开关守卫内）', () => {
  assert.match(installSrc, /\[switch\]\$Heartbeat/, '缺少 -Heartbeat 开关');
  assert.match(installSrc, /\[switch\]\$ScheduledTask/, '缺少 -ScheduledTask 开关');
  assert.doesNotMatch(installSrc, /\[switch\]\$Heartbeat\s*=\s*\$true/, '-Heartbeat 默认必须关闭');
  assert.doesNotMatch(installSrc, /\[switch\]\$ScheduledTask\s*=\s*\$true/, '-ScheduledTask 默认必须关闭');
  assert.match(installSrc, /if \(\$Heartbeat\) \{/, 'heartbeat 注册未包在 if ($Heartbeat) 内');
  assert.match(installSrc, /if \(\$ScheduledTask\) \{/, '计划任务注册未包在 if ($ScheduledTask) 内');

  // The classic Method block (the only path taken when neither switch is given)
  // must add NO new-kind entries, so the default install is byte-for-byte the
  // old behaviour: startup-shortcut / registry-run only.
  const optionalIdx = installSrc.indexOf('# ---- optional registrations');
  assert.ok(optionalIdx > 0, '找不到可选注册段落');
  // Start at the install-path list (not the $entries = @($reg.entries) local
  // inside Show-AutostartStatus), so this is exactly the default install block.
  const entriesStart = installSrc.indexOf('$entries = [System.Collections.Generic.List');
  assert.ok(entriesStart > 0 && entriesStart < optionalIdx, '找不到安装路径的 entries 列表');
  const classic = installSrc.slice(entriesStart, optionalIdx);
  assert.doesNotMatch(classic, /heartbeat-watch/, '默认安装不应写 heartbeat-watch 条目');
  assert.doesNotMatch(classic, /scheduled-task/, '默认安装不应写 scheduled-task 条目');
  assert.ok(installSrc.indexOf('if ($Heartbeat) {') < installSrc.indexOf("kind       = 'heartbeat-watch'"),
    'heartbeat-watch 条目必须在 -Heartbeat 守卫内');
  assert.ok(installSrc.indexOf('if ($ScheduledTask) {') < installSrc.indexOf("kind = 'scheduled-task'"),
    'scheduled-task 条目必须在 -ScheduledTask 守卫内');
});

test('清单含两类新 kind 及各自字段，卸载器按清单清理这两类', () => {
  // install writes them
  assert.match(installSrc, /kind\s*=\s*'heartbeat-watch'/);
  assert.match(installSrc, /command\s*=\s*\$heartbeatCommand/);
  assert.match(installSrc, /intervalMs\s*=\s*\$heartbeatIntervalMs/);
  assert.match(installSrc, /\$heartbeatIntervalMs\s*=\s*60000/);
  assert.match(installSrc, /heartbeat --watch --interval-ms/);
  assert.match(installSrc, /kind\s*=\s*'scheduled-task'/);
  assert.match(installSrc, /name\s*=\s*\$scheduledTaskName/);
  assert.match(installSrc, /AI Browser Bridge Watchdog/, '计划任务名');
  // heartbeat/automation 二选一警示写进清单条目
  assert.match(installSrc, /warning\s*=\s*\$heartbeatWarning/);
  // uninstall cleans both, from the manifest only
  assert.match(uninstallSrc, /\$kind -eq 'heartbeat-watch'/);
  assert.match(uninstallSrc, /\$kind -eq 'scheduled-task'/);
  assert.match(uninstallSrc, /schtasks\.exe \/delete \/tn/, '计划任务按清单删除');
  assert.match(uninstallSrc, /unknown/, '删除失败应报 unknown');
  assert.match(uninstallSrc, /entries\s*=\s*@\(\)/, '最后仍把 entries 清空');
});

test('-ScheduledTask 用 schtasks /create 注册登录触发任务（PT0S / 失败重启 3 次），失败报 unknown 给可复制命令', () => {
  assert.match(installSrc, /schtasks\.exe \/create \/xml/, '应通过 schtasks.exe /create 注册');
  assert.match(installSrc, /LogonTrigger/, '应为登录触发');
  assert.match(installSrc, /ExecutionTimeLimit>PT0S/, '应设置无限执行时限');
  assert.match(installSrc, /<Count>3<\/Count>/, '应设置失败重启 3 次');
  assert.match(installSrc, /registration result: unknown/, '权限/沙箱不足应报 unknown 而非抛异常');
  assert.match(installSrc, /copyable create command/, '应给出可复制创建命令');
});

test('-StatusOnly 能列出新 kind 并区分 managed / external', () => {
  assert.match(installSrc, /if \(\$StatusOnly\)/, '保留 -StatusOnly 只读分支');
  assert.match(installSrc, /Show-AutostartStatus/);
  assert.match(installSrc, /kind=heartbeat-watch/, '-StatusOnly 未列出 heartbeat-watch');
  assert.match(installSrc, /kind=scheduled-task/, '-StatusOnly 未列出 scheduled-task');
  assert.match(installSrc, /managed: true/, '新增项标注为项目管理的');
  assert.match(installSrc, /external: true managed: false/, '外部任务仍标注 external / managed: false');
  assert.match(installSrc, /\[managed manifest entry\]/, '清单项仍标注 managed');
});

test('输出与清单含 heartbeat 与 automation 二选一警示（含 clock_drift 依据）', () => {
  assert.match(installSrc, /heartbeat --watch/);
  assert.match(installSrc, /automation/, '警示要点名每小时单次巡检 automation');
  assert.match(installSrc, /二选一/, '警示要说明二选一');
  assert.match(installSrc, /不要同时启用/, '警示要明确禁止同时启用');
  assert.match(installSrc, /clock_drift/, '警示要给出实测依据');
  assert.match(installSrc, /WARNING:/, '安装输出应打印该警示');
});

// ---------------------------------------------------------------- watchdog

test('watchdog 源码含 build-stale-restart-needed，且 stale 分支绝不杀进程 / 写 paused / 调 stop.ps1', () => {
  assert.match(watchSrc, /build-stale-restart-needed/, '缺少新状态名');
  assert.ok(staleStart > 0 && staleEnd > staleStart, '找不到 stale 分支代码区');
  // positive: it DOES report the state and marks the action read-only
  assert.match(staleBranch, /Report-State 'build-stale-restart-needed'/, 'stale 分支应上报新状态');
  assert.match(staleBranch, /report-only/, 'stale 分支动作应为只读');
  // negative: no restart machinery in the stale branch
  assert.doesNotMatch(staleBranch, /Stop-Process/, 'stale 分支不得杀进程');
  assert.doesNotMatch(staleBranch, /\.Kill\(/, 'stale 分支不得 kill');
  assert.doesNotMatch(staleBranch, /Start-Process/, 'stale 分支不得拉起/重启服务');
  assert.doesNotMatch(staleBranch, /Set-Content/, 'stale 分支不得写任何标记文件');
  assert.doesNotMatch(staleBranch, /service-paused/, 'stale 分支不得写 service-paused');
  assert.doesNotMatch(staleBranch, /stop\.ps1/, 'stale 分支不得调用 stop.ps1');
  assert.doesNotMatch(staleBranch, /start\.ps1/, 'stale 分支不得调用 start.ps1');
  // the watchdog never invokes the stop script anywhere
  assert.doesNotMatch(watchSrc, /stop\.ps1/, 'watchdog 整体不应调用 stop.ps1');
});

test('watchdog 只读 stale 检测的技术契约：node -e + 工作目录 + 缓存 + 失败报 unknown', () => {
  assert.match(watchSrc, /Get-DiskBuildIdentity/, '缺少磁盘 buildId 计算函数');
  assert.match(watchSrc, /Resolve-BridgeBinary -Root \$root -Kind node/, 'node 路径应走共享固化解析');
  assert.match(watchSrc, /computeBuildIdentity\(process\.cwd\(\)\)/, '应复用 build-identity.js');
  assert.match(watchSrc, /\$psi\.WorkingDirectory = \$root/, 'node 子进程应设 -WorkingDirectory $root');
  assert.match(watchSrc, /WaitForExit\(8000\)/, 'node 调用应有超时');
  assert.match(watchSrc, /% 6 -eq 0/, '应有每若干轮一次的轻量缓存');
  assert.match(watchSrc, /diskBuildUnknown/, 'node 失败应进入 unknown');
  assert.match(watchSrc, /\$staleVerdict = 'unknown'/, '应能给出 unknown 判定');
  assert.match(watchSrc, /\$staleVerdict -eq 'unknown'/, 'unknown 时应保持既有存活状态');
  assert.match(watchSrc, /buildStaleCheck/, '证据里应带 buildStaleCheck');
  assert.match(watchSrc, /return \$null/, 'node 失败时返回 unknown 而非把服务判成故障');
  // 现有状态语义仍保留
  for (const state of ["'connected'", "'port-occupied-or-service-unresponsive'", "'startup-completed'", "'maintenance'"]) {
    assert.ok(watchSrc.includes(`Report-State ${state}`), `丢失既有状态 ${state}`);
  }
});

// ------------------------------------------------------------- real boundary

test('真实边界：写入含新 kind 的清单，pwsh -StatusOnly 读出并区分 managed / external（全程只读）', t => {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command pwsh.exe).Source'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { t.skip('pwsh.exe 不可用，跳过 -StatusOnly 实跑边界'); return; }
  const temp = mkdtempSync(join(tmpdir(), 'aib-autostart-options-'));
  try {
    copyFileSync(join(ROOT, 'install-autostart.ps1'), join(temp, 'install-autostart.ps1'));
    copyFileSync(join(ROOT, 'uninstall-autostart.ps1'), join(temp, 'uninstall-autostart.ps1'));
    mkdirSync(join(temp, '.local'), { recursive: true });
    const entries = [
      { kind: 'startup-shortcut', path: 'C:\\Temp\\AI Browser Bridge.lnk', target: 'pwsh.exe', arguments: '-NoProfile' },
      { kind: 'heartbeat-watch', command: '"node.exe" "src/cli.js" heartbeat --watch --interval-ms 60000', intervalMs: 60000, warning: 'heartbeat --watch 与每小时单次巡检 automation 二选一，不要同时启用' },
      { kind: 'scheduled-task', name: 'AI Browser Bridge Watchdog' }
    ];
    const manifestText = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries });
    const registryFile = join(temp, '.local', 'autostart-registry.json');
    // 真实写入：用 spawnSync(process.execPath, [...]) 子进程写清单（不碰真实 .local）
    const writeCode = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(registryFile)}, ${JSON.stringify(manifestText)});`;
    const wrote = spawnSync(process.execPath, ['-e', writeCode], { encoding: 'utf8' });
    assert.equal(wrote.status, 0, `写入清单失败: ${wrote.stderr}`);
    // 真实读出：pwsh -StatusOnly 是纯读，不注册/删除任何系统项
    const run = () => spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(temp, 'install-autostart.ps1'), '-StatusOnly'], { encoding: 'utf8', timeout: 30000 });
    const r = run();
    assert.equal(r.status, 0, `pwsh -StatusOnly 失败: ${r.stderr}\n${r.stdout}`);
    const out = r.stdout;
    assert.match(out, /kind=heartbeat-watch/, '输出未列出 heartbeat-watch');
    assert.match(out, /kind=scheduled-task/, '输出未列出 scheduled-task');
    assert.match(out, /kind=startup-shortcut/, '既有 kind 仍需列出');
    assert.match(out, /\[managed manifest entry\]/, '清单项应标注 managed');
    assert.match(out, /managed: true/, '新增项应标注 managed: true');
    assert.match(out, /external: true managed: false/, '外部任务应标注 external / managed: false');
    assert.match(out, /warning:/, '应输出 heartbeat / automation 二选一警示');
    // 纯读：清单逐字不变，且不产生安装副作用文件
    assert.equal(readFileSync(registryFile, 'utf8'), manifestText, '-StatusOnly 不应改写清单');
    assert.ok(!existsSync(join(temp, '.local', 'runtime.json')), '-StatusOnly 不应写 runtime.json');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('P0-2 真实边界：watch-service -Once 报 build-stale-restart-needed 而不重启，connected 语义不变', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command pwsh.exe).Source'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { t.skip('pwsh.exe 不可用，跳过 watchdog 实跑边界'); return; }
  const temp = mkdtempSync(join(tmpdir(), 'aib-watch-stale-'));
  const state = join(temp, '.local');
  const srcDir = join(temp, 'src');
  mkdirSync(state, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  // 最小可哈希工程根：computeBuildIdentity 需要 package.json / package-lock.json / src/；
  // import('./src/build-identity.js') 相对 cwd 解析，故拷一份到临时根。
  writeFileSync(join(temp, 'package.json'), '{"name":"aib-probe","version":"0.0.0"}');
  writeFileSync(join(temp, 'package-lock.json'), '{"lockfileVersion":3}');
  copyFileSync(join(ROOT, 'src', 'build-identity.js'), join(srcDir, 'build-identity.js'));
  // 固化运行时，让 Resolve-BridgeBinary 返回当前 node 的绝对路径（确定性）
  writeFileSync(join(state, 'runtime.json'), JSON.stringify({ pwsh: process.execPath, node: process.execPath, resolvedAt: new Date().toISOString() }));

  const statusFile = join(temp, 'fake-status.json');
  const portFile = join(temp, 'fake-port.txt');
  const serverCode = [
    "const http=require('node:http'),fs=require('node:fs');",
    "const sf=process.env.FAKE_STATUS,pf=process.env.FAKE_PORT;",
    "http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(fs.readFileSync(sf,'utf8'));}).listen(0,'127.0.0.1',function(){fs.writeFileSync(pf,String(this.address().port));});"
  ].join('\n');
  const server = spawn(process.execPath, ['-e', serverCode], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, FAKE_STATUS: statusFile, FAKE_PORT: portFile }
  });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += d; });
  const stopServer = () => { try { server.kill(); } catch { } };
  t.after(stopServer);
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) assert.fail(`fake server 未就绪: ${serverErr}`);
      await new Promise(r => setTimeout(r, 30));
    }
    const port = Number(readFileSync(portFile, 'utf8').trim());
    writeFileSync(join(state, 'config.json'), JSON.stringify({ port, agentToken: 'fixture' }));

    const WRONG = '0'.repeat(64);
    const run = () => spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'scripts', 'watch-service.ps1'), '-Once', '-ProjectRoot', temp], { encoding: 'utf8', timeout: 60000 });
    const readState = () => JSON.parse(readFileSync(join(state, 'watchdog-status.json'), 'utf8').replace(/^\uFEFF/, ''));

    // 1) 运行代码 ≠ 磁盘代码：应报只读新状态，绝不重启服务
    writeFileSync(statusFile, JSON.stringify({ service: 'ai-browser-bridge', buildId: WRONG, connected: true }));
    const r1 = run();
    assert.equal(r1.status, 0, `watch-service(stale) 失败: ${r1.stderr}\n${r1.stdout}`);
    const s1 = readState();
    assert.equal(s1.state, 'build-stale-restart-needed', '应上报新状态而非 connected / 重启');
    assert.equal(s1.buildStaleCheck, 'stale');
    assert.equal(s1.action, 'report-only');
    assert.equal(s1.runningBuildId, WRONG);
    assert.match(s1.diskBuildId, /^[a-f0-9]{64}$/, '应留下磁盘 buildId 证据');
    assert.ok(!existsSync(join(state, 'service-paused')), 'stale 分支不得写 service-paused');
    assert.ok(!existsSync(join(temp, 'started')), 'stale 分支不得拉起 / 重启服务');

    // 2) 开 / 关不同：把 running buildId 改成与磁盘一致，应回到既有 connected 语义
    writeFileSync(statusFile, JSON.stringify({ service: 'ai-browser-bridge', buildId: s1.diskBuildId, connected: true }));
    const r2 = run();
    assert.equal(r2.status, 0, `watch-service(match) 失败: ${r2.stderr}\n${r2.stdout}`);
    const s2 = readState();
    assert.equal(s2.state, 'connected', 'buildId 一致时应保持原有 connected 语义');
  } finally {
    stopServer();
    rmSync(temp, { recursive: true, force: true });
  }
});
