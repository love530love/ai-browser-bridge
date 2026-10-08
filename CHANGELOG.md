# 修改日志（CHANGELOG）

供其他 Agent 接手改进时快速了解：改了哪些文件、为什么改、怎么验证、还剩什么。
按时间倒序追加，最新在最前。

---

## 0.5.4 — 2026-10-08 · 租约所有权上移到服务端并持久化（并发层架构变更）

> 本次为**架构级**改动，不是补丁。租约从「扩展 Service Worker 的内存」搬到
> 「桥接服务进程 + 磁盘快照」，扩展退化为纯执行器。

### 为什么必须改

MV3 的 Service Worker 会被 Chrome 回收。租约原来存在 `extension/worker.js` 的
`tabLeases = new Map()` 里，于是出现两类事故：

1. **租约凭空消失**：持有者 A 正在多步写，SW 一回收租约就没了，B 随即拿到同一标签页；
2. **静默接管**：A 与 B 同时写同一页面，而双方都以为自己持有租约。

同时旧路径把租约判断放在扩展端，导致 0.5.2 修过的那个「等待 30s > 服务超时 20s → 断开扩展」
的整条链路。**这次把决策点上移后，那条链路从根上消失了。**

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/leases.js`（新增） | 租约子系统：`createLeaseStore`。权威状态在内存 Map，**原子落盘**到 `stateDir/tab-leases.json`（tmp + rename，0600）；TTL 钳制 1s–600s（默认 120s）；过期惰性清理 + `sweep()`；`claim/renew/release/releaseTab/get/list/guard`；`wait:true` 有界等待（`MAX_LEASE_WAIT_MS = 15000`）；心跳续租走 250ms 合并写，不每次写盘 |
| `src/server.js` | ① 租约工具（`claim/renew/release/tab_lease`）**本地应答，不再入队、不再下发扩展**，因此不存在超时/断连路径；② 受管写工具**入队前**调 `leases.guard()` 校验持有者，冲突直接返回 waiting，不占队列槽；③ `/status` 与 `browser_queue_status` 新增 `tabLeases` 真实视图（修掉此前 `active`/`leases` 与实际持有不一致的问题）；④ `browser_close` 完成后释放该标签租约；⑤ 收到扩展 `tab-removed` 立即释放租约；⑥ 关闭时 `flush()` 落盘 |
| `extension/worker.js` | **删除全部租约裁决逻辑**（-66 行）：`tabLeases`、`normalizeLease`、claim/renew/release/tab_lease 分支、写操作前的租约检查全部移除；新增 `chrome.tabs.onRemoved` 监听，向服务上报 `tab-removed`；诊断输出改为 `leaseOwner: 'bridge-service'` |
| `test/leases.test.js`、`test/lease-service.test.js`（新增） | 租约语义与服务集成测试 |
| `test/lease-governance.test.js`（新增） | **不变量回归测试**：受管写工具必须在工具表中存在、必须强制 `tabId`、不得是只读工具；租约工具不得被自身门禁；读操作永不被阻塞；持有者永不被阻塞；无租约标签保持可写（单 agent 用户无感）；持有者写操作续租 |
| 版本 | 0.5.3 → **0.5.4**（`server.js`×2、`mcp.js`、`manifest.json`、`package.json`） |

### 关键设计决策（写下来，避免后人改回去）

1. **租约工具绝不下发扩展**——它是协调状态，不是页面操作。本地应答 = 零超时风险，
   这也是 0.5.2 那个断连 bug 的根治方式。
2. **冲突的 `nextPollTool` 指向 `browser_tab_lease`（只读），绝不指回 `wait:true`**。
   指回阻塞式 claim 曾把 auto-recovery 自旋进 20s 超时并拖垮扩展；已加不变量测试锁定。
3. **读操作永不被租约阻塞**——其他 agent 仍可持续观察被租用的标签页，只有写被拦。
4. **未认领标签保持可写**——单 agent 用户不会因为这次改动被强制加一道门禁。
5. **持有者的每次写自动续租**——长任务不会被自己的心跳间隔踢掉。
6. **标签关闭即释放**（`browser_close` 与 Chrome 内直接关闭两条路径都覆盖），
   避免租约挂到 TTL 到期、白白堵住下一个 agent。
7. **落盘失败不致命**——租约是协调状态不是安全状态，磁盘只读/写满时静默降级为纯内存。

### 验证

- 单元测试 **52/52 通过**（原 21 → 44 → 52）。
- 语义实测（真实 Chrome + 已登录扩展）：
  - A 取租约 → B 争抢：返回 `status=waiting`、`reason=tab_write_lease_conflict`、
    `holder=agentA`、`nextPollTool=browser_tab_lease`，**无 20s 超时、无断连**；
  - B 的 `browser_scroll` 被拦截，A 的 `browser_scroll` 放行；
  - 第三方 C 读取另一标签页正常，不受争抢影响；
  - A 释放后 B 立即取得租约。
- **持久化实测（核心）**：`claim` 后执行 `stop.ps1` → `start.ps1`（期间服务停止约 4 分钟），
  重启后 `browser_tab_lease` 返回**同一个 `leaseId`、同一个持有者**。（若仍在 SW 内存中，
  此时必然已丢失。）
- `/status` 输出 `tabLeases` 真实数组；`cli.js doctor` 全绿。

### 生效条件与回滚

- **两端都要更新**：服务端重启即生效；扩展需重载（`chrome://extensions` → 重新加载）
  才能装上 `tabs.onRemoved` 监听与移除后的执行逻辑。实测扩展已自动上报 0.5.4。
- 持久化文件：`stateDir/tab-leases.json`（测试用 `AIB_STATE_DIR` 指向临时目录，不污染真实状态）。
  若状态损坏，删掉该文件即回到空租约，不影响桥接启动。
- 回滚：`git revert <本提交>`；旧扩展 + 新服务端组合下，租约工具由服务应答、扩展不再有
  租约逻辑，**不会重复裁决**，可安全混合运行。

### 并发提示（给接手 Agent）

本改动落地时，仓库中曾存在**另一位 Agent 未提交的在途改动**（`src/leases.js` 与其测试）。
已核验其内容与上述设计一致后合并提交，未覆盖其实现。**多人同时改 `src/server.js` 前请先确认
工作区状态（`git status`），避免互相覆盖。**

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

1. ~~**租约存在 Service Worker 内存中，SW 重启即丢失**~~ → **✅ 0.5.4 已解决**。
   租约所有权已上移到 `src/leases.js`（服务端进程 + 磁盘持久化），扩展只做执行。详见 0.5.4 章节。
   剩下的并发层隐患见下面第 2 条。

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
| 并发层 | ✅ | tab 租约**由服务端持有并持久化**（0.5.4）+ 队列优先级 + waiting 契约；扩展只做执行。剩余小项见待办第 2 条 |
| 治理层 | ❌ | agent 身份 / 权限域 / 审计 |
| 分发层 | ❌ | npm 可装 / 跨平台 / `setup --register` 自动注册 |

### 回滚

```bash
git log --oneline          # 找到本改动前的提交
git revert <commit>        # 或直接 git checkout <commit> -- src/server.js extension/worker.js
# 重启服务；扩展需在 chrome://extensions 重新加载
```
