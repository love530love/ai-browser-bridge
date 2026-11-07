// P1 运行时前提断言：隐藏文档下 rAF 永不触发时，settle wait 是否真的走 timer 兜底。
//
// browser-diagnostics.test.js 只对 page.js 做正则匹配，无法证明运行时不会去等一个
// 永不触发的 rAF。这里不复制一份逻辑（那只会得到恒真测试），而是从 extension/page.js
// 读出**真实的 settle wait 源码片段**，在 Node 里用 new Function 注入 stub 后真正
// 执行它，再观察 rAF 注册次数、登记的 timer 是否有界、Promise 是否在截止前 resolve。
// 片段被重排/改写时，提取与源码断言会先失败 —— 因此这不是与实现无关的假测试。
//
// hermetic：只读一个本地文件，不连浏览器 / GUI / 19387，不改动任何产品代码。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');

// --- 从真实源码截取 settle wait ---------------------------------------------
const START = 'const settleMode = await new Promise(resolve => {';
const start = page.indexOf(START);
assert.notEqual(start, -1, '必须能在 page.js 中定位到 settle wait 的 Promise');
const END = '\n    });';
const end = page.indexOf(END, start);
assert.notEqual(end, -1, 'settle wait 的 Promise 必须闭合');
const settleSource = page.slice(start, end + END.length);

// --- 源码级精确断言：锁定三条有界 timer 兜底的形状 --------------------------
test('settle wait 源码含 no-raf / hidden / starved 三条有界兜底', () => {
  assert.match(settleSource, /typeof requestAnimationFrame !== 'function'/);
  assert.match(settleSource, /resolve\('timer_no_raf'\), 32\); return;/);
  // hidden 分支必须在注册 rAF 之前 return，这是「不依赖 rAF」的关键
  assert.match(settleSource,
    /if \(document\.visibilityState === 'hidden'\) \{ setTimeout\(\(\) => resolve\('timer_hidden_document'\), 32\); return; \}/);
  assert.match(settleSource,
    /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => finish\('animation_frame'\)\)\)/);
  assert.match(settleSource, /finish\('timer_animation_frame_starved'\), 250/);
});

// --- 运行时执行器：注入 stub，执行上面截取的真实片段 -------------------------
// rafFires=false 模拟「rAF 存在但回调永不触发」（隐藏 / 被节流文档的真实前提）。
// setTimeout stub 不自动触发，只记录 (fn, ms)，由测试显式推进，以便对「有界」
// 和「不挂起」下断言。
function prepareSettle({ visibilityState, rafFires, hasRaf = true }) {
  const calls = { raf: 0, timers: [] };
  const rafStub = cb => { calls.raf += 1; if (rafFires) cb(); return calls.raf; };
  const setTimeoutStub = (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; };
  const documentStub = { visibilityState };
  const factory = new Function('document', 'requestAnimationFrame', 'setTimeout',
    `return (async () => { ${settleSource}\n return settleMode; })();`);
  const settled = factory(documentStub, hasRaf ? rafStub : undefined, setTimeoutStub);
  return { settled, calls, fireTimers: () => { for (const t of calls.timers) t.fn(); } };
}

// 真实全局定时器作截止哨兵：若 settle wait 挂起（永不 resolve）则测试失败。
function withDeadline(promise, ms = 500) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`settle wait 挂起：${ms}ms 内未 resolve`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

test('hidden 且 rAF 永不触发 → timer_hidden_document，rAF 0 次，有界，不挂起', async () => {
  const { settled, calls, fireTimers } = prepareSettle({ visibilityState: 'hidden', rafFires: false });
  assert.equal(calls.raf, 0, '隐藏文档绝不能注册 requestAnimationFrame');
  assert.equal(calls.timers.length, 1, '必须恰好登记一条兜底 timer');
  assert.ok(Number.isFinite(calls.timers[0].ms) && calls.timers[0].ms > 0, '兜底 timeout 必须是有界正数');
  assert.equal(calls.timers[0].ms, 32);
  fireTimers();
  assert.equal(await withDeadline(settled), 'timer_hidden_document');
});

test('visible 正常绘制 → animation_frame，且确实调用 rAF（>0 次）', async () => {
  const { settled, calls, fireTimers } = prepareSettle({ visibilityState: 'visible', rafFires: true });
  assert.ok(calls.raf > 0, '可见文档必须注册 rAF');
  fireTimers();
  assert.equal(await withDeadline(settled), 'animation_frame');
});

test('visible 但 rAF 被节流（永不触发）→ starved 有界兜底，不挂起', async () => {
  const { settled, calls, fireTimers } = prepareSettle({ visibilityState: 'visible', rafFires: false });
  assert.ok(calls.raf > 0);
  assert.equal(calls.timers.length, 1);
  assert.ok(Number.isFinite(calls.timers[0].ms) && calls.timers[0].ms > 0, 'starved 兜底必须有界');
  assert.equal(calls.timers[0].ms, 250);
  fireTimers();
  assert.equal(await withDeadline(settled), 'timer_animation_frame_starved');
});

test('requestAnimationFrame 缺失 → timer_no_raf，rAF 0 次，有界，不挂起', async () => {
  const { settled, calls, fireTimers } = prepareSettle({ visibilityState: 'visible', rafFires: false, hasRaf: false });
  assert.equal(calls.raf, 0);
  assert.equal(calls.timers.length, 1);
  assert.ok(Number.isFinite(calls.timers[0].ms) && calls.timers[0].ms > 0);
  fireTimers();
  assert.equal(await withDeadline(settled), 'timer_no_raf');
});
