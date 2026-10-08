# 修改日志（CHANGELOG）

供其他 Agent 接手改进时快速了解：改了哪些文件、为什么改、怎么验证、还剩什么。
按时间倒序追加，最新在最前。

---

## 0.5.3 — 2026-10-08 · 参数错误回传可用列表 + 服务不可达可操作诊断（可用性层）

### 触发来源

另一位 Agent 留下 `docs/ai-browser-bridge-阻塞与不便清单.md`（实测于 **0.4.19**，本次一并提交入库，
此前未跟踪）。它列了 P0/P1/P2 共 8 项。**先审计再动手**——其中多项在 0.5.x 已解决：

| 清单项 | 现状（0.5.3 实测） |
|---|---|
| 1.1 跨 iframe 读取/操作（P0） | ✅ **已解决**：`browser_read` 支持 `frame:'all'`（多帧返回 `frameResults`），ref 自动加 `@frameN` 后缀；`worker.js:247` 解析该后缀后按 `frameIds` 精确注入；另有 `browser_frames` 工具列帧 |
| 1.2 重 SPA `read_timeout` | 🟡 部分：`browser_read` 已支持 `waitFor` 与 `partial:true` 降级快照 |
| 2.1 upload 受 allowlist 根约束（P1） | 🟡 部分：已有 `node src/cli.js allow-upload-root <绝对路径>` 可加根；SHA256 校验仍在（安全设计，不移除） |
| 2.2 服务单点（P1） | 🟡 **本次改进**：错误区分 service-down / extension-disconnected |
| 2.3 版本必须匹配 | ✅ `doctor` 已给出分级建议；本项目仍保持同版本发布 |
| 2.4 坐标点击（P2） | 🟡 已有 `browser_action`（0–1000 归一化坐标 + `expectedUrl` 守卫）作为显式兜底 |
| 2.5 控制台编码 mojibake | ⬜ 未改：属终端呈现层，工具内部数据正确 |
| 2.6 参数错误不回传可用列表（P2） | ✅ **本次解决** |

本次只动**性价比最高、且不影响运行时行为**的两处（均为错误提示层，不改正常路径）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/tools.js` | `validateCall` 全面增强：新增 `editDistance` / `closest` / `argSummary` / `constraints` 四个纯函数。① `Unknown argument: X` → 追加「Did you mean "Y"?」与完整参数清单（区分 required / optional）；② `Missing argument` 同样附清单；③ `Invalid <key>` → 回传实际值 + 约束（enum 取值 / 数值区间 / 长度 / pattern / 描述）；④ `Unknown tool` → 给出最近工具名与工具总数；⑤ `browser_action` 缺参提示带上 action 名 |
| `src/client.js` | `request()` 增加两段兜底：① `fetch` 失败 → 区分 timeout 与 refused，报 `State: service-down` 并给出 `start.ps1` / `doctor` 指引；② 响应非 JSON → 报 HTTP 状态与响应片段（原先 `res.json()` 直接抛难读错误）；③ `loadConfig` 失败单独提示 |
| `src/server.js` / `src/mcp.js` / `extension/manifest.json` / `package.json` | 版本 0.5.2 → **0.5.3** |
| `docs/ai-browser-bridge-阻塞与不便清单.md` | 另一位 Agent 的实测清单，原为未跟踪文件，本次提交入库（内容未改动） |

### 实测输出（修复前 → 修复后）

```
Unknown argument: query
  → Unknown argument: query. browser_read accepts 8 argument(s) — required: tabId;
    optional: maxChars, maxElements, maxTextNodes, budgetMs, mode, frame, waitFor

Unknown argument: txt
  → Unknown argument: txt. Did you mean "text"? browser_fill accepts 4 argument(s) — ...

Missing argument: tabId
  → Missing argument: tabId. browser_read accepts 8 argument(s) — ...

Invalid action          → Invalid action: "Click". allowed: Tap | Double Tap | Long Press |
                          Hover | Swipe | Type | Key | Back | Wait; expected string
Invalid x               → Invalid x: 9999. expected number in [0, 1000]
Unknown tool: browser_red → Unknown tool: browser_red. Did you mean "browser_read"? Run
                          browser_agent_guide or node src/cli.js tools to list the 44 available tools.
fetch failed            → Bridge service is not listening or refused the connection on
                          http://127.0.0.1:19387 (fetch failed). State: service-down. Start it
                          with start.ps1 (or 'node src/server.js'), then re-check with
                          'node src/cli.js doctor'. ...
```

### 验证

- 单元测试 **21/21 通过**（无回归）。
- 上述 7 类错误文案逐一实机调用确认（`call-raw` 走真实服务端校验）。
- 正常路径回归：T110 竞赛标签 `browser_read` 正常返回（含 `diagnostics`），`browser_frames` 正常。
- `node src/cli.js doctor` → `ok: true`，7 项检查全绿（含 version-match 0.5.3 / 0.5.3）。
- 服务不可达路径实测：执行 `stop.ps1` 后调用 → 输出新的可操作文案；随后 `start.ps1` 恢复。

### 生效条件

- 服务端改动：重启服务即生效（已重启至 0.5.3）。
- 扩展版本随 manifest 一并升到 0.5.3，**扩展端逻辑本次未改**；为避免 `doctor` 报版本不匹配，
  需重载一次扩展（实测已自动上报 0.5.3）。

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
另见 `docs/ai-browser-bridge-阻塞与不便清单.md`（另一位 Agent 在 0.4.19 上的实测，8 项处置状态见
0.5.3 章节的对照表）。该清单里**尚未解决**的两项并入下列待办：重 SPA 降级快照策略（1.2）、
控制台编码呈现（2.5，属终端层，数据本身正确）。

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
| 契约层 | ✅ | `browser_agent_guide` / `browser_bridge_modes` / 实时 schema / `browser_failure_help` / **参数错误回传可用列表与纠错建议（0.5.3）** |
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
