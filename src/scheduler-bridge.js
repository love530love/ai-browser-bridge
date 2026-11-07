/**
 * Scheduler Bridge - P1 capability wiring.
 *
 * 把 createScheduler() 里从未在真实请求路径被调用的能力（detectConflicts /
 * routeTask）以"证据 + 显式派发"的方式接到 server。硬规则：
 *   - 冲突只给证据，由 agent 裁决；绝不拒绝任务、绝不改队列。
 *   - 只有 routeExplicitly 会真正转发；/call 里绝不隐式自动转发。
 *   - 超时/异常 => 结果未知 => uncertain，绝不自动重放写操作。
 *   - 同一 (name, arguments) 2 秒内幂等抑制，防止二次派发。
 *
 * 注意：ESM 是严格模式，形参/绑定名不能叫 `arguments`（SyntaxError）。
 * 这里用 `arguments: args` 解构重命名，调用方传入的对象形状仍是
 * { name, arguments, agent }，与约定接口逐字一致。
 */

const DEDUP_WINDOW_MS = 2000;
const ROUTE_TOOL = 'browser_route_task';
const UNCERTAIN_MESSAGE = '对方实例可能已执行，绝不自动重放；重新观察后再决定';

function createSchedulerBridge({
  scheduler,
  instanceMode = false,
  currentInstanceId = null,
  now = () => Date.now(),
  fetchFn = null
} = {}) {
  // describe()/setInstanceMode() 反映的可变内部状态
  let mode = instanceMode === true;
  let instanceId = currentInstanceId;
  const recentDispatches = new Map();

  function syncScheduler(config) {
    if (scheduler && typeof scheduler.updateInstanceConfig === 'function') {
      scheduler.updateInstanceConfig(config);
    }
  }

  // server.js 用 instanceMode:false 创建 scheduler。若桥处于多实例模式却不同步，
  // scheduler.routeTask 会因自身 instanceMode=false 直接返回 single_instance_mode，
  // 导致"正常转发"永远发不出去。构造时对齐一次。
  syncScheduler({
    instanceMode: mode,
    ...(instanceId !== null && instanceId !== undefined ? { currentInstanceId: instanceId } : {})
  });

  function describe() {
    return {
      wired: true,
      instanceMode: mode,
      currentInstanceId: instanceId,
      routeTool: ROUTE_TOOL,
      capabilities: ['conflict_evidence', 'explicit_instance_routing']
    };
  }

  function conflictEvidenceFor(job, queue) {
    // 只读、永不抛、永不拒绝任务、永不改队列。try/catch 包住整体与每次 detector 调用。
    try {
      if (!job || !Array.isArray(queue)) return null;
      const evidence = [];
      for (const other of queue) {
        if (!other || other === job) continue;
        if (job.id != null && other.id === job.id) continue;
        let verdict;
        try {
          verdict = scheduler.detectConflicts(job, other);
        } catch {
          continue; // 单次比较失败不影响其余比较
        }
        const conflicts = Array.isArray(verdict?.conflicts) ? verdict.conflicts : [];
        const warnings = Array.isArray(verdict?.warnings) ? verdict.warnings : [];
        if (conflicts.length === 0 && warnings.length === 0) continue;
        evidence.push({
          otherId: other.id ?? null,
          tool: other.name ?? null,
          verdict: {
            hasConflict: conflicts.length > 0,
            conflicts,
            warnings
          }
        });
      }
      if (evidence.length === 0) return null;
      return {
        code: 'scheduler_conflict_evidence',
        jobId: job.id ?? null,
        conflicts: evidence,
        advisory: true,
        dispatched: false
      };
    } catch {
      return null;
    }
  }

  async function dispatchThroughScheduler(task) {
    if (!fetchFn) {
      // 不注入 fetchFn：沿用 load-balancer 自带的（全局）fetch
      return scheduler.routeTask(task);
    }
    // fetchFn 仅为测试注入：临时接管全局 fetch，调用结束后还原。
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      return await scheduler.routeTask(task);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function uncertain(targetInstance) {
    return {
      status: 'uncertain',
      retryable: false,
      dispatched: null,
      reason: 'routing_outcome_unknown',
      targetInstance: targetInstance ?? null,
      message: UNCERTAIN_MESSAGE
    };
  }

  async function routeExplicitly({ name, arguments: args = {}, agent = null } = {}) {
    // 递归防护：无条件、最先执行
    if (typeof name !== 'string' || name.length === 0 || name === ROUTE_TOOL) {
      return { status: 'denied', retryable: false, reason: 'routing_recursion_blocked', dispatched: false };
    }

    const key = JSON.stringify([name, args]);
    const t = now();
    for (const [k, ts] of recentDispatches) {
      if (t - ts >= DEDUP_WINDOW_MS) recentDispatches.delete(k);
    }
    if (recentDispatches.has(key)) {
      return { status: 'duplicate_suppressed', dispatched: false, replayed: true };
    }

    // 单实例：绝不发起任何 fetch；不登记幂等键，保留 retryable 的可重试语义
    if (!mode) {
      return {
        status: 'waiting',
        retryable: true,
        reason: 'single_instance_mode',
        dispatched: false,
        recommendedNextAction: '启用多实例模式(setInstanceMode(true, instanceId))后再显式派发'
      };
    }

    // 即将真正派发：登记幂等键，防止 2 秒内二次派发 / 超时后重放
    recentDispatches.set(key, t);

    let result;
    try {
      result = await dispatchThroughScheduler({ name, args, agent });
    } catch {
      return uncertain(null);
    }

    if (!result || typeof result !== 'object') {
      return uncertain(null);
    }
    if (result.routed === true) {
      return {
        status: 'success',
        routed: true,
        targetInstance: result.targetInstance ?? null,
        dispatched: true,
        result: result.result,
        advisory: false
      };
    }
    // load-balancer 把网络超时吞成 routed:false + routing_timeout。
    // 该 POST /call 可能已被对方执行，结果未知，必须判 uncertain 绝不重放。
    if (result.reason === 'routing_timeout') {
      return uncertain(result.targetInstance ?? null);
    }
    return {
      status: 'waiting',
      reason: result.reason,
      dispatched: false,
      targetInstance: result.targetInstance ?? null
    };
  }

  function setInstanceMode(enabled, newInstanceId) {
    mode = enabled === true;
    const config = { instanceMode: mode };
    if (newInstanceId !== undefined) {
      instanceId = newInstanceId;
      config.currentInstanceId = newInstanceId;
    }
    syncScheduler(config);
  }

  return { describe, conflictEvidenceFor, routeExplicitly, setInstanceMode };
}

export { createSchedulerBridge };
