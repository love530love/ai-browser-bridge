import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync,
  existsSync, rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = [
  'start.bat', 'status.bat', 'doctor.bat', 'pair.bat', 'stop.bat',
  'install-autostart.bat', 'uninstall-autostart.bat',
];
const checkRuntime = join(root, 'scripts', 'check-runtime.bat');

function assertUtf8NoBom(buf, label) {
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${label}: 不应带 UTF-8 BOM`);
  assert.ok(Buffer.from(buf.toString('utf8'), 'utf8').equals(buf), `${label}: 必须是合法 UTF-8`);
}

test('每个根目录入口都满足启动器契约（静态）', () => {
  for (const name of entries) {
    const buf = readFileSync(join(root, name));
    const src = buf.toString('utf8');
    assertUtf8NoBom(buf, name);
    assert.doesNotMatch(src, /[\u201c\u201d\u2018\u2019]/, `${name}: 只允许 ASCII 直引号`);
    assert.match(src, /@echo off/i, `${name}: 保留 @echo off`);
    assert.match(src, /setlocal/i, `${name}: 保留 setlocal`);
    assert.match(src, /chcp 65001/i, `${name}: 含 chcp 65001`);
    assert.match(src, /call "%~dp0scripts\\check-runtime\.bat" \S+\.bat/i, `${name}: 必须 call 公共检查并传入脚本名`);
    assert.match(src, /pwsh\.exe\s+-NoProfile\s+-File\s+"%~dp0[^"\r\n]+\.ps1"/i, `${name}: 保留原始 pwsh -File 命令`);
    assert.match(src, /set "BRIDGE_EXIT=%ERRORLEVEL%"/i, `${name}: 捕获真实退出码`);
    assert.match(src, />>"%~dp0\.local\\launcher-error\.log" echo/i, `${name}: 失败时写 launcher-error.log`);
    assert.match(src, /exit \/b %BRIDGE_EXIT%/i, `${name}: 传播真实退出码`);
    assert.match(src, /exit \/b 1/i, `${name}: 公共检查失败时有非零退出`);
    assert.match(src, /pause/i, `${name}: 失败路径需要 pause`);
    // 成功路径必须在 pause 之前提前返回，避免 CI/Agent 调用被卡住；且 pause 只能出现一次
    const successEarly = src.search(/if "%BRIDGE_EXIT%"=="0" exit \/b 0/i);
    const pauseAt = src.search(/^\s*pause\s*$/im);
    assert.ok(successEarly !== -1, `${name}: 缺成功提前返回`);
    assert.ok(successEarly < pauseAt, `${name}: 成功路径不得经过 pause`);
    assert.equal((src.match(/^\s*pause\s*$/gim) || []).length, 1, `${name}: 只允许一处 pause`);
  }
});

test('scripts/check-runtime.bat 满足公共前置检查契约（静态）', () => {
  const buf = readFileSync(checkRuntime);
  const src = buf.toString('utf8');
  assertUtf8NoBom(buf, 'check-runtime.bat');
  assert.match(src, /chcp 65001/i);
  assert.match(src, /setlocal/i);
  assert.match(src, /where\.exe pwsh\.exe/i);
  assert.match(src, /where\.exe node\.exe/i);
  assert.match(src, /node\.exe -e "process\.exit/i);
  assert.match(src, /launcher-error\.log/);
  assert.match(src, /pause/i);
  assert.match(src, /exit \/b 1/i);
  assert.match(src, /endlocal & exit \/b 0/i);
});

// 真实边界测试：在临时副本项目里，用受控 env 实际执行 check-runtime.bat。
// 不改动用户真实 PATH / 系统状态，全部落在 os.tmpdir() 下，测试结束清理。
function runCheck({ includeFakePwsh = false, includeNode = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'aibb-launcher-'));
  const scriptsDir = join(tmp, 'scripts');
  mkdirSync(scriptsDir);
  copyFileSync(checkRuntime, join(scriptsDir, 'check-runtime.bat'));
  const bat = join(scriptsDir, 'check-runtime.bat');

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const system32 = join(systemRoot, 'System32');
  const cmdExe = join(system32, 'cmd.exe');
  const pathDirs = [system32];
  if (includeNode) pathDirs.push(dirname(process.execPath));
  if (includeFakePwsh) {
    const fakeBin = join(tmp, 'fakebin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'pwsh.exe'), ''); // where.exe 只需找到同名文件即可
    pathDirs.push(fakeBin);
  }
  const env = {
    ComSpec: process.env.ComSpec || cmdExe,
    SystemRoot: systemRoot,
    PATH: pathDirs.join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.WSH',
    TEMP: tmp,
    TMP: tmp,
  };
  const inner = `"${bat}" start.bat`;
  const result = spawnSync(cmdExe, ['/d', '/s', '/c', `"${inner}"`], {
    env, cwd: tmp, encoding: 'utf8', windowsVerbatimArguments: true,
    windowsHide: true, input: '\r\n', timeout: 20000,
  });
  return { tmp, result, env, cmdExe, logPath: join(tmp, '.local', 'launcher-error.log') };
}

function assertFailure({ result, logPath }, expectReason) {
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  assert.notEqual(result.error && result.error.code, 'ENOENT', 'cmd.exe 应可启动');
  assert.ok(
    Number.isInteger(result.status) && result.status !== 0,
    `失败时退出码应为非零整数，实际 status=${result.status}, error=${result.error && result.error.code}`,
  );
  assert.ok(existsSync(logPath), '日志应落盘到 .local/launcher-error.log');
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /start\.bat/, '日志应含脚本名');
  assert.match(log, expectReason, '日志应含失败原因');
  assert.match(out, /winget|nodejs\.org|learn\.microsoft\.com|PowerShell 7|Node\.js/, '输出应含可操作指引');
  assert.match(out, /[\u4e00-\u9fff]/, '输出应含中文指引关键词');
}

test('边界：PATH 不含 pwsh 时，check-runtime.bat 非零退出、落盘日志、给出中文指引', () => {
  const ctx = runCheck({ includeFakePwsh: false, includeNode: true });
  try {
    // 先确认这个受控环境里 pwsh 确实解析不到
    const probe = spawnSync(ctx.cmdExe, ['/c', 'where.exe pwsh.exe'], {
      env: ctx.env, cwd: ctx.tmp, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    assert.notEqual(probe.status, 0, '受控环境里 pwsh.exe 应确实缺失');
    assertFailure(ctx, /pwsh\.exe not found/);
    assert.match(`${ctx.result.stdout || ''}`, /winget|安装方式一/);
  } finally {
    rmSync(ctx.tmp, { recursive: true, force: true });
  }
});

test('边界：缺 node.exe 时，check-runtime.bat 非零退出、落盘日志、给出中文指引', () => {
  const ctx = runCheck({ includeFakePwsh: true, includeNode: false });
  try {
    assertFailure(ctx, /node\.exe not found/);
    assert.match(`${ctx.result.stdout || ''}`, /nodejs\.org|Node\.js/);
  } finally {
    rmSync(ctx.tmp, { recursive: true, force: true });
  }
});
