import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFileSync(join(ROOT, relative), 'utf8');
const startPs1 = read('start.ps1');
const agentPs1 = read('agent.ps1');
const watchPs1 = read('scripts/watch-service.ps1');
const helper = read('scripts/resolve-runtime.ps1');

const entryPoints = {
  'start.ps1': startPs1,
  'agent.ps1': agentPs1,
  'scripts/watch-service.ps1': watchPs1
};

test('三个入口都从 runtime.json 解析二进制，不再直接 Get-Command', () => {
  for (const [name, source] of Object.entries(entryPoints)) {
    assert.match(source, /Resolve-BridgeBinary/, `${name} 未调用共享解析函数`);
    assert.match(source, /resolve-runtime\.ps1/, `${name} 未加载共享模块`);
    assert.doesNotMatch(source, /= \(Get-Command (node|pwsh)\.exe/, `${name} 仍硬编码 PATH 解析`);
  }
  assert.match(helper, /runtime\.json/, '共享模块未读取固化配置');
  assert.match(helper, /ValidateSet\('node', 'pwsh'\)/, '共享模块缺少 Kind 白名单');
  assert.match(helper, /ConvertFrom-Json/, '共享模块未解析 JSON');
  assert.match(helper, /Write-Warning/, '固化路径失效时必须如实告警而不是静默换二进制');
});

test('所有本机 /status 请求都显式绕过代理', () => {
  for (const [name, source] of Object.entries({ 'start.ps1': startPs1, 'scripts/watch-service.ps1': watchPs1 })) {
    const lines = source.split(/\r?\n/).filter(line => line.includes('Invoke-RestMethod'));
    assert.ok(lines.length > 0, `${name} 没有本机 HTTP 探活`);
    for (const line of lines) {
      assert.match(line, /-NoProxy/, `${name} 的探活未绕代理: ${line.trim()}`);
      assert.match(line, /127\.0\.0\.1/, `${name} 的探活不是本机地址`);
    }
  }
});

test('启动失败区分「端口有监听但 HTTP 不通」与「端口无监听」', () => {
  assert.match(startPs1, /TcpClient/, '缺少端口监听探测');
  assert.match(startPs1, /端口已有监听/, '缺少「端口被占用或响应异常」分支');
  assert.match(startPs1, /端口始终无监听/, '缺少「服务进程已退出」分支');
  assert.match(startPs1, /Get-NetTCPConnection -LocalPort/, '端口占用分支未给可复制命令');
  assert.match(startPs1, /doctor-lite\.bat/, '端口占用分支未指向宿主诊断入口');
});

test('真实 PowerShell 边界：命中固化路径，文件消失后回退 PATH（开与关不同）', t => {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command pwsh.exe).Source'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('pwsh.exe 不可用，跳过 PowerShell 运行时边界测试');
    return;
  }
  const pwshPath = probe.stdout.trim().split(/\r?\n/).pop();
  const temp = mkdtempSync(join(tmpdir(), 'bridge-runtime-'));
  const helperPath = join(ROOT, 'scripts', 'resolve-runtime.ps1');
  try {
    mkdirSync(join(temp, '.local'), { recursive: true });
    const fakeNode = join(temp, 'pinned-node.exe');
    writeFileSync(fakeNode, '');
    const runtimeFile = join(temp, '.local', 'runtime.json');
    writeFileSync(runtimeFile, JSON.stringify({ pwsh: pwshPath, node: fakeNode, resolvedAt: new Date().toISOString() }));

    const resolveNode = () => {
      const ps = `. '${helperPath.replace(/'/g, "''")}'; $p = Resolve-BridgeBinary -Root '${temp.replace(/'/g, "''")}' -Kind node; Write-Output ("RESOLVED=" + $p)`;
      const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
      assert.equal(result.status, 0, `pwsh 执行失败: ${result.stderr}`);
      const matched = result.stdout.match(/RESOLVED=(.+)/);
      assert.ok(matched, `未拿到解析结果: ${result.stdout} / ${result.stderr}`);
      return matched[1].trim();
    };

    const pinned = resolveNode();
    assert.equal(resolve(pinned).toLowerCase(), resolve(fakeNode).toLowerCase(), '应优先使用 runtime.json 固化的绝对路径');

    rmSync(fakeNode);
    const fallback = resolveNode();
    assert.notEqual(resolve(fallback).toLowerCase(), resolve(fakeNode).toLowerCase(), '固化路径消失后必须回退，不能继续用失效路径');
    assert.match(fallback.toLowerCase(), /node\.exe$/, `回退结果不是 node 可执行文件: ${fallback}`);
    assert.ok(readFileSync(fallback) !== undefined, '回退结果应指向真实存在的文件');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
