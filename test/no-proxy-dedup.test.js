// P2-10 (already implemented in scripts/doctor-host-env.mjs) gets a real
// boundary here: spawn the doctor as a subprocess with a case-duplicated,
// value-duplicated NO_PROXY / no_proxy, and assert the de-duplication is real.
// The env override lives ONLY in the child process; the real user environment
// is never modified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'doctor-host-env.mjs');
const STACKED = '127.0.0.1,localhost,::1,127.0.0.1,localhost,::1';
const CLEAN = '127.0.0.1,localhost,::1';

function runChild(env) {
  const result = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    env
  });
  assert.equal(result.error, undefined, `子进程启动失败: ${result.error && result.error.message}`);
  let report;
  try { report = JSON.parse(result.stdout ?? ''); }
  catch (error) { assert.fail(`--json 输出不是合法 JSON: ${error.message}\n${(result.stdout ?? '').slice(0, 500)}`); }
  const check = report.checks.find(c => c.name === 'no-proxy-loopback');
  assert.ok(check, '缺少 no-proxy-loopback 检查项');
  return { check, report, result };
}

test('P2-10 真实边界：大小写重复 + 同值重复时 ok:true，归并去重并说明「同值重复」', () => {
  // Only the child env is overridden. Snapshot the parent so we can prove the
  // real user environment was not touched by spawnSync's env option.
  const parentNoProxyBefore = process.env.NO_PROXY;
  const env = { ...process.env, NO_PROXY: STACKED, no_proxy: CLEAN };
  const { check } = runChild(env);
  assert.equal(process.env.NO_PROXY, parentNoProxyBefore, 'env 覆盖不得改动真实用户环境变量');

  assert.equal(check.ok, true, 'NO_PROXY 覆盖三个回环地址应通过');
  assert.equal(check.deduplicated, true, '检测到重复条目应标记 deduplicated=true');
  assert.ok(check.noProxyUniqueCount < check.noProxyEntryCount,
    `去重后条目应少于原始条目: unique=${check.noProxyUniqueCount} entry=${check.noProxyEntryCount}`);
  assert.match(check.detail, /同值重复/, 'detail 应说明「同值重复」来自会话注入');
  // detail / 展示值里不得再出现重复堆叠，读起来不能像配置错了。
  assert.doesNotMatch(check.detail, /127\.0\.0\.1,localhost,::1,127\.0\.0\.1/, 'detail 仍堆叠了重复条目');
  assert.equal(check.noProxy, CLEAN, '去重后展示值应为唯一的三条回环地址');
});

test('P2-10 对照边界：干净 NO_PROXY 不触发去重（开 / 关给出不同结论）', () => {
  // Windows env dict is case-insensitive: strip every case proxy variant first,
  // then set a single clean value. Still child-process-only, nothing real changes.
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (/^(no_proxy|http_proxy|https_proxy|all_proxy)$/i.test(k)) delete cleanEnv[k];
  }
  cleanEnv.NO_PROXY = CLEAN;
  const { check } = runChild(cleanEnv);
  assert.equal(check.ok, true);
  assert.equal(check.deduplicated, false, '无重复时不应标记去重');
  assert.equal(check.noProxyUniqueCount, check.noProxyEntryCount, '无重复时两个计数应相等');
  assert.doesNotMatch(check.detail, /同值重复/, '无重复时不应出现「同值重复」说明');
});

test('P2-10 源码契约：大小写归并 + Set 去重 + 计数字段 + 同值重复说明', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(src.includes('/^no_proxy$/i.test(k)'), '应按大小写不敏感收集所有 no_proxy 键');
  assert.ok(src.includes('new Set()'), '应使用 Set 去重');
  assert.ok(src.includes('deduplicated'), '应输出 deduplicated 字段');
  assert.ok(src.includes('noProxyEntryCount'), '应输出原始条目数');
  assert.ok(src.includes('noProxyUniqueCount'), '应输出去重后条目数');
  assert.ok(src.includes('同值重复'), '应给出「同值重复」说明');
});
