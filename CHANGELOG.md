# 修改日志（CHANGELOG）

供其他 Agent 接手改进时快速了解：改了哪些文件、为什么改、怎么验证、还剩什么。
按时间倒序追加，最新在最前。

---

## 0.5.2 — 2026-10-08 · 修复多 Agent 租约冲突拖垮整条桥（并发层）

### 症状（修复前，实测）

两个 Agent 争抢同一标签页的写租约时：

1. 第二个 `browser_claim_tab` 调用 **20s 后超时**，返回
   `browser_claim_tab timed out after 20000ms; outcome may be unknown.`；
2. 随即 **扩展被断开**（`connected: false`）；
3. 期间**所有其他 Agent 的调用全部变成 `fetch failed`** —— 即「两个 Agent 打架，拖垮第三个」。

### 根因（完整调用链）

- `extension/worker.js:385` 冲突时返回 `status:"waiting"`，且
  `nextPollArgs` 里带 **`wait: true`**；
- `src/auto-recovery.js` 的 `callWithWaitingRecovery` 会照 `nextPollTool/nextPollArgs`
  自动重试，于是**带着 `wait:true` 再次调用** `browser_claim_tab`；
- 扩展端 `waitBudgetMs = min(ttlMs ?? 30000, 60000)` → **最多等 30s**；
- 但 `src/server.js` 的通用 job 超时是 **20s**，超时走 `drop()` → **断开扩展**。

即：**扩展等待上限（30s）> 服务超时（20s）**，只要走 `wait:true`（文档推荐的用法）就必然断连。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/server.js` | 新增 `LEASE_TOOLS` 集合与 `jobTimeoutMs` 分支；租约类工具超时改 **15s** 且**超时不 `drop()`**，只返回 `status:"waiting"`（`reason:"lease_bookkeeping_timeout"`）；队列优先级新增 `lease`（20），排在 `read` 之后；文档化 `priorityOrder` 加入 `lease` |
| `extension/worker.js` | `waitBudgetMs` 增加 **12s 上限**（原 30s/60s），确保永远小于服务超时 |
| `src/server.js` / `src/mcp.js` / `extension/manifest.json` / `package.json` | 版本 0.5.1 → **0.5.2**（共 5 处） |

三层留白：扩展正常返回 ≤12s → 服务兜底 15s → 通用超时 20s。健康扩展永远先返回；只有真卡死才走兜底，且兜底**不断连**。

### 为什么「超时不 drop」

租约记账（`claim/renew/release/tab_lease`）**不修改页面状态、不存在"结果未知"**，
与写操作（`click/fill/...`）性质不同。写超时必须断连是因为结果未知；租约超时没有这个风险，
所以只回报 `waiting`，让调用方重试即可。

### 验证

- 单元测试：`node --test --test-concurrency=1 test/*.test.js` → **21/21 通过**（修复前后均通过，无回归）。
- 场景测试（真实 Chrome + 已登录扩展）：
  - A 持有 T1 租约，B 争抢同一 T1；
  - 同时第三方 C 持续读取另一个标签页 T2；
  - 结果：**C 读取 12/12 全部成功，全程无 `fetch failed`**，扩展保持连接；
  - 修复前同一场景：B 超时 20s → 扩展断开 → C 全部 `fetch failed`。
- 复现脚本：`K:\PythonProjects5\FlagGems-sglang\competition\coordination\probes\probe_browser_bridge.py`（跨项目，路径按实际调整）。

### 生效条件

- **服务端改动**：重启桥接服务即生效（`stop.ps1` → `start.ps1`，需 PowerShell 7）。
- **扩展端 12s 上限**：需在 `chrome://extensions` 点「重新加载」扩展才生效。
  实测扩展已自动上报 `extensionVersion: 0.5.2`，即已加载新代码。

---

## 已知限制与待办（给接手 Agent）

按优先级排列。**这些本次未改**，避免一次改动面过大。

1. **租约存在 Service Worker 内存中，SW 重启即丢失**
   `extension/worker.js` 的 `tabLeases = new Map()` 是 SW 作用域内存。MV3 的 SW 会被 Chrome
   回收，实测出现过「A 的租约莫名消失、B 直接拿到租约」以及 `Tab is leased by agentB` 的情况。
   → 建议：把租约状态搬到服务端（`src/server.js`）持久化，扩展只做执行。
   **这是并发层剩下的最大隐患。**

2. **`callWithWaitingRecovery` 默认 `maxWaitMs = 120000`**
   永久冲突会自旋到 120s。符合「waiting 不是失败」契约，但调用方可能感知为卡住。
   → 建议：给 `browser_claim_tab` 的冲突返回降低 `maxWaitMs`，或让调用方可配置。

3. **治理层缺失（架构第 4 层）**
   `agent` 是自由字符串，任何 Agent 可冒名；无 per-agent 权限域（只读 / 禁上传 / 域名白名单）；
   无审计日志（现有 `audit.jsonl` 只记工具名/tabId/成败，不记 agent）。
   `browser_queue_status` 的 `active`/`leases` 显示曾与实际持有不一致。

4. **分发层缺失（架构第 5 层）**
   `package.json` 仍 `private: true`；`.local/mcp-config.json` 硬编码本机绝对路径；
   生命周期脚本仅 Windows PowerShell 7（`start.ps1` 有 `#Requires -Version 7.0`）；
   `src/*.js` 无任何平台判断。→ 别人要用需手动 5 步。

5. **扩展偶发被 Chrome 回收**
   高频调用下观察到 SW 重启导致瞬时断连（autoRecovery 可自愈，约 4s）。
   建议评估 keepalive 策略。

### 五层架构现状速查

| 层 | 状态 | 内容 |
|---|---|---|
| 契约层 | ✅ | `browser_agent_guide` / `browser_bridge_modes` / 实时 schema / `browser_failure_help` |
| 传输层 | ✅ | MCP stdio / CLI / HTTP + Bearer |
| 并发层 | ⚠️ 部分 | tab 租约 / 队列优先级 / waiting 契约 —— **本次修了断连 bug，仍有第 1、2 条待办** |
| 治理层 | ❌ | agent 身份 / 权限域 / 审计 |
| 分发层 | ❌ | npm 可装 / 跨平台 / `setup --register` 自动注册 |

### 回滚

```bash
git log --oneline          # 找到本改动前的提交
git revert <commit>        # 或直接 git checkout <commit> -- src/server.js extension/worker.js
# 重启服务；扩展需在 chrome://extensions 重新加载
```
