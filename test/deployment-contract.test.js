import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFileSync(join(ROOT, relative), 'utf8');
const exists = relative => existsSync(join(ROOT, relative));

// A documented path that no tool can reach is worse than no documentation at
// all: the reader follows it, gets nothing, and concludes the whole feature is
// missing. This file is the executable form of that contract.
test('README / HANDOFF 承诺的每个部署入口文件都真实存在', () => {
  for (const relative of [
    'start.bat', 'status.bat', 'doctor.bat', 'pair.bat', 'stop.bat',
    'install-autostart.bat', 'uninstall-autostart.bat', 'doctor-lite.bat',
    'scripts/check-runtime.bat', 'scripts/doctor-host-env.mjs', 'scripts/resolve-runtime.ps1',
    'start.ps1', 'agent.ps1', 'scripts/watch-service.ps1',
    'install-autostart.ps1', 'uninstall-autostart.ps1',
    'docs/DEPLOYMENT-FEEDBACK-2026-11-09.md'
  ]) {
    assert.ok(exists(relative), `文档承诺的文件不存在：${relative}`);
  }
});

test('七个双击入口都接公共前置检查；doctor-lite 是唯一零 pwsh 例外', () => {
  for (const name of ['start.bat', 'status.bat', 'doctor.bat', 'pair.bat', 'stop.bat', 'install-autostart.bat', 'uninstall-autostart.bat']) {
    const source = read(name);
    assert.match(source, /check-runtime\.bat/, `${name} 未接公共前置检查`);
    assert.match(source, /exit \/b/, `${name} 未传播退出码`);
    assert.match(source, /chcp 65001/, `${name} 未切 UTF-8 代码页，中文指引会乱码`);
  }
  const lite = read('doctor-lite.bat');
  assert.doesNotMatch(lite, /pwsh\.exe/i, 'doctor-lite 绝不能依赖 pwsh.exe');
  assert.match(lite, /doctor-host-env\.mjs/, 'doctor-lite 未调用宿主诊断实现');
  assert.match(read('scripts/check-runtime.bat'), /launcher-error\.log/, '公共检查未落错误日志');
});

test('自启清单的写入格式与宿主诊断的读取格式逐字一致', () => {
  const install = read('install-autostart.ps1');
  const uninstall = read('uninstall-autostart.ps1');
  const hostEnv = read('scripts/doctor-host-env.mjs');
  for (const [name, source] of Object.entries({ 'install-autostart.ps1': install, 'uninstall-autostart.ps1': uninstall })) {
    assert.match(source, /autostart-registry\.json/, `${name} 未使用清单文件`);
  }
  assert.match(install, /runtime\.json/, '安装器未固化二进制路径');
  assert.match(install, /entries/, '安装器未写 entries');
  assert.match(uninstall, /entries/, '卸载器未按 entries 清理');
  assert.match(hostEnv, /autostart-registry\.json/, '宿主诊断未读清单');
  assert.match(hostEnv, /entries/, '宿主诊断未读 entries 字段');
  assert.match(hostEnv, /runtime\.json/, '宿主诊断未读固化路径');
  // 文档里承诺的只读开关必须真的存在，否则验收清单是一句空话。
  assert.match(install, /StatusOnly/, '安装器缺少 -StatusOnly');
  assert.ok(read('README.md').includes('-StatusOnly'), 'README 承诺了不存在的开关');
});

test('README 显式声明 PS7 硬依赖，且不再把 5.1 当作可用引擎', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('PowerShell 7（`pwsh.exe`）'), '前置要求未显式列出 PowerShell 7');
  assert.doesNotMatch(readme, /^> 所有 `\.ps1` 都不再要求 PowerShell 7/m, '旧的错误注脚仍在');
  assert.ok(readme.includes('doctor-lite.bat'), 'README 未指向不依赖 pwsh 的诊断入口');
  assert.ok(read('CHANGELOG.md').includes('## 0.37.3'), 'CHANGELOG 缺少本版条目');
  const handoff = read('docs/HANDOFF.md');
  assert.ok(handoff.includes('doctor-lite.bat'), '交接文档未记录零 pwsh 例外');
});
