# 排障矩阵：服务级 OK、页面级超时 / 调试横幅 / 宿主误选

- 版本基线：**0.40.0**（`main`，HEAD `3f69ec1`），`src/tools.js` 注册 125 个工具。
- 触发来源：`docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md`（2026-11-14 CSDN 自动发布现场复盘，报告基线写的是 **0.39.0**）第 5.8 / 第 9 节。
- 本文性质：**只读排障指引 + 与当前源码的逐字对账**。不新增能力，不改 `src/` / `extension/`，不构成对任何修复动作的授权。

> **先划一条线**：本报告**不否认**现场观察到的现象（页面命令全超时、调试横幅、`devtools_already_attached`、宿主 flap、`browser_reload_extension` 超时但已执行）。本文否认的是把报告里对 **0.39.0 机制**的推断直接当成 **0.40.0 源码事实**来照抄。现象要保留，归因要重新取证——这正是本项目「单轮不是事实」的判定纪律。

---

## 0. 判定纪律（每次排障都适用）

1. **先分层，再猜根因**：服务级命令（`browser_health` / `browser_hosts` / `browser_tabs` / `browser_queue_status` / `browser_cookies`）能秒回，而页面级命令超时，说明断点在「宿主 / 标签 / 通道」，不在 HTTP 服务。这一步能砍掉一半错误方向。
2. **一次超时不是事实**：判服务存活要四证——LISTENING PID + TCP 探针 + 裸 `/status`（带端口应返回 401，属预期鉴权）+ 带 token 的 `/status` 或 `doctor`。`.local/server.pid` 不是存活证据（PID 可被复用为别的程序）。
3. **不确定结果的写操作绝不重放**：超时返回 `status:uncertain` / `dispatched:true` / `verified:false` 时，先重新观测，不要重试同一个写。
4. **能力存在 ≠ 走得通**：文档里写的工具名必须真在 `src/tools.js`、`src/tool-index.js` 与扩展侧分发表都能走到。扩展侧有**两类**分发：`extension/worker.js` 的 `if (name === 'browser_xxx')` 主链（如 `browser_close` / `browser_eval`），以及 `extension/browser-authority.js:888` 的 `HANDLERS` 表（如 `browser_windows_control`，经 `worker.js:829` 的 `runAuthorityTool` 委托）。漏接任一类就是真机 `Unknown command`，而单测全绿。
5. **不抢前台、不启 GUI、不改 `browserTarget`**：这些不是「更好的修复」，是项目硬边界，见 `docs/KNOWN-LIMITATIONS.md`。
6. **文档里的调用形态要能在真机走到**：`browser_debugger` 的 `list` 分支虽不消费 `tabId`（`extension/worker.js:1341`；`:1340` 是 `close`），但入口 schema 把 `['tabId','action']` 列为必填（`src/tools.js:386`），服务层还会先解析该标签。不带 `tabId` 真机返回 `Missing argument: tabId`，传不存在的 id 返回 `No tab with id: N.` ⇒ 查长活会话必须先 `browser_tabs` 取真实 `tabId`，写成 `browser_debugger {action:"list", tabId:<真实 tabId>}`。这是「能力存在但文档路径走不到」的一个变体；逐字证据见 `docs/LOCAL-EVIDENCE-20261114-runtime.md` §5。

---

## 1. 症状 → 判据 → 处置矩阵

| # | 症状 | 先查（工具 / 字段） | 在 0.40.0 里的可验证解释 | 处置 | 禁止动作 |
|---|---|---|---|---|---|
| 1 | 服务级全正常，页面级 eval/read/screenshot/close 全超时 | `browser_health`（`tab.active` / `windowFocused` / `pageProbe.visibilityState` / `hasFocus`）；`browser_debugger {action:"list", tabId:<真实 tabId>}` | 标签被**长期调试会话暂停**：`extension/worker.js:854-872` 的 `tab_paused_by_debugger` 守卫会让所有页面命令返回 `waiting` + `nextPollTool:"browser_debugger"` + `nextPollArgs:{action:"status"}`，而不是裸超时 | 按指引 `browser_debugger action:"status"` → `frames` → `resume` / `close` | 不要先归因 CSP；不要据一次超时重启服务 |
| 2 | Chrome 顶部有「…开始调试此浏览器」横幅 | `browser_debugger {action:"list", tabId:<真实 tabId>}` / `status` | 横幅来自**长活会话**（`browser_debugger`，`src/tools.js:371` 明写「banner 会一直显示到 close」）。`browser_eval` 的一次性 CDP 回退**不会**留下横幅：`extension/cdp.js:13-14` 是 `try/finally { chrome.debugger.detach }` | 找到自己的会话就 `action:"close"`；关闭路径会先 `Debugger.resume` 再 detach（`extension/cdp-session.js:100-117`），暂停页还有 `autoResumeInMs` 兜底 | 不要靠 `browser_reload_extension` 清横幅——重载扩展不会替你关闭长活会话 |
| 3 | `browser_debugger action:"open"` 返回 `devtools_already_attached` | 同一返回体的 `retryable` / `message` | `extension/cdp-session.js:143-149`：attach 抛「another debugger is already attached」时返回 `status:denied`、`retryable:false`、`dispatched:false`、明确「Nothing was attached」。**这是 Chrome 事实**：扩展无权 detach 别的 DevTools / 别的扩展持有的会话 | 如实报「不可由桥恢复」；由人关掉该标签上的 DevTools，或换一个标签 | 不要假装能 `recover`；不要无限重试 `open` |
| 4 | 强 CSP 站点（编辑器 / SaaS 后台）`browser_eval` 返回 `channel:"cdp"` | 返回体的 `channel` / `reason` / `mainWorldFailure` | 主路径是 `chrome.scripting.executeScript({world:'MAIN', func})`（`extension/worker.js:1290`）；只有 `first.reason === 'eval_blocked_by_page_csp'` 才进 CDP（`worker.js:1302`），命中时 `extension/eval-main.js:171-180` 会**明确**返回 `eval_blocked_by_page_csp` + "Retry once through the debugger channel" | 读 `channel` 判断实际走哪条；两通道都失败时返回 `debugger_channel_failed` 并明说「Nothing is known about whether the expression ran; do not repeat it blindly」（`worker.js:1327-1331`） | 不要说「桥静默回退」；不要重放表达式 |
| 5 | `browser_close` 超时 | `browser_health` 的宿主连通性 | 当前实现只查 ownership + `chrome.tabs.remove`（`extension/worker.js:1241-1254`），**完全不跟页面通信**；`force:true` 已存在（`src/tools.js:370`） | 先查宿主 / 会话是否还活着，再定位超时发生在哪一层 | 不要因为「close 也超时」就新增 `Target.closeTarget` 强杀——见 `docs/CDP-GATEWAY-PLAN.md` 的架构障碍 |
| 6 | 命令时好时坏、`sessionId` 轮换、`commandsDispatched` 归零 | `browser_hosts` 的 `hostId` / `sessionId` / `connected` | `sessionId` 每次重连 `randomUUID()`（`src/host-registry.js:142`），`hostId` 稳定；`commandsDispatched` 归零是**设计**，0.40.0 已修「累计派发差冒充瞬时 in-flight 泄漏」（`src/heartbeat.js:266`） | 按 `hostId` 显式绑定；用 `commandId` 幂等键（`README` 0.36.0 段） | **不要**用 `Σ(dispatched − completed)` 比瞬时 `inFlightHosts`——超时 drop 与 `ws.close(4000)` 不补 completed，会误报 |
| 7 | `browser_reload_extension` 「超时但看起来执行了」 | 返回体 `verified` / `dispatched` / `hosts[]` / `previousSessionId` | `src/server.js:1330-1366` 用「观察到新 `sessionId` + 期望版本」验证；超时返回 `status:uncertain` / `reason:extension_reload_not_observed` / `verified:false` / `dispatched:true` 并附 `hosts` 快照 | 按 `hosts[]` 复核，再决定是否重来；多宿主时看 `staleHosts` / `partialHosts` | 不要写成「已修复」；不要重放不确定的写 |
| 8 | hosts 列表里出现 ChatGPT 内嵌 Chromium，怀疑选错浏览器 | `browser_hosts` 的 `hostKind` / `hostKindObserved` / `features.uiAutomationLikely` | 已有分类：`src/host-registry.js:66-120` 的 `hostKind`（`generic` / `stable` / `canary` / `agent_embedded`）与 `featureFlagsFor()`；`src/server.js:1649` 的 `hostKindObserved` 对非 Chrome 宿主标 `agent_embedded`，`uiAutomationLikely:false` | 页面级操作显式传 `hostId`；**当前没有** `interactive` / `hasVisibleWindow` / `isDefaultProfile` 字段，也没有 `browser_use_host` 工具 | 不要凭 `extensionOwner` 判断宿主身份（`hostId` 才是身份）；不要静默改派到另一个浏览器 |

---

## 2. 报告里**不能照抄**的 0.39.0 断言

逐条给出 0.40.0 源码反证。这些不是「报告写错了」，而是报告描述的是当时的运行态/推断，当前代码已不同。

| 报告原文（章节） | 0.40.0 反证 |
|---|---|
| 「桥的脚本注入通道（eval/MAIN world）被拦截」「静默回退」（P0-1 / 5.2） | 主路径是 `executeScript({world:'MAIN', func})` 注入函数，不是字符串 eval；CSP 命中返回明确 `eval_blocked_by_page_csp` 并提示重试通道，回复带 `channel`。`extension/worker.js:1286-1315`、`extension/eval-main.js:171-180` |
| 「会话生命周期没有『命令结束即 detach』」（P0-1 / 5.3） | `extension/cdp.js:3-15` 的 `withDebugger` 在 `finally` 里 `detach`；长活会话的每个退出路径先 `Debugger.resume`（`extension/cdp-session.js:100-117`）。报告建议的「短租约」在一次性回退路径上已实现 |
| 「没有 `browser_debugger action:"detach"` / `status`」（P1-6 / 5.3） | 等价动作是 `action:"close"`（`extension/worker.js:1340`）+ `action:"status"`（`cdp-session.js:290`）+ `action:"list"`（`worker.js:1341`）。**名字不同不是能力缺失**；按项目规则新增工具要同步 `src/tools.js` / `src/tool-index.js` 与扩展侧分发表（`worker.js` 主链或 `browser-authority.js:888` 的 `HANDLERS`），重复造轮子反而会打破「最小夹具」类测试 |
| 「`browser_close` 也超时，缺按标签强杀」（P1-6 / 5.7） | `browser_close {tabId, force:true}` 已存在且走 `chrome.tabs.remove`，不依赖页面响应（`worker.js:1241-1254`）；按 URL 查找已由 `browser_tabs` 的 `origin` / `urlContains` / `titleContains` / `fields` / `limit` 覆盖（`src/tools.js:59`） |
| 「非前台窗口页面脚本被冻死」「`browser_open` 应加 `focusWindow:true`」（P0-3 / 5.6） | `worker.js:1287` 明写主通道「works on a background tab」；`src/capability-guide.js` 多数能力标 `backgroundSafe:true`，并把 `tab.active` / `window.focused` / `document.visibilityState` 列为 `advisoryOnlyStates`（`:254`）。已有 `browser_windows_control {focused:true}`，但要求 `confirmation:"modify_window_once"`（`src/tools.js:693-704`）——**不隐式抢前台是刻意设计**，不是缺陷 |
| 「宿主缺少 `kind` 分类」（P1-4） | `hostKind` / `hostKindObserved` / `features.uiAutomationLikely` 已存在（见矩阵 #8）。缺的是更细的可见性元数据与默认选择策略 |
| 「工具超时 ≠ 未执行…只能人工核对」（P1-5） | 现象成立，但「无任何信息」过重：`server.js:1361-1366` 已返回 `verified:false` / `dispatched:true` / `hosts[]` 快照。**真缺口是统一 `operationId` 与只读状态查询**，不是从零建可观测性 |
| 「CDP Gateway 只需在 `Target.getTargets` 层过滤页面 target」（5.1） | `chrome.debugger` 是 **page 级** attach 且只转发 CDP 域子集（`extension/cdp-storage.js:128-131` 实测 `DOMStorage.enable` / `IndexedDB.enable` 返回 `-32601`）；Playwright `connect_over_cdp` 需要 **browser 级** WS + target 发现。详见 `docs/CDP-GATEWAY-PLAN.md` |

---

## 3. 现场必须区分的一条替代解释

报告把「页面命令全超时 + 横幅 + `already_attached`」归因为 *CSP → debugger 回退 → attach 残留*。当前一次性回退路径有 `finally detach`，因此这条链在 0.40.0 上不是唯一解：

**如果某次开了 `browser_debugger` 长活会话并把页面暂停**，则 `worker.js:854-872` 会让后续所有页面命令返回 `waiting/tab_paused_by_debugger`，长活会话本身又显示横幅、又让 DevTools 无法 attach——三种现象与报告完全一致，但根因和处置完全不同。

这是**可验证的假设，不是结论**。要在真实 CSDN 编辑器上按以下顺序取证，不能跳过：

1. `browser_debugger {action:"list", tabId:<真实 tabId>}` —— 有没有本扩展持有的长活会话、是否 `paused`；
2. `browser_health` —— `pageProbe` 的 `visibilityState` / `hasFocus` 与 `windowFocused` 分别是什么（三者是**不同状态**，见 `src/tools.js:297`）；
3. `browser_eval` 的返回体 —— 是 `channel:"main_world"` / `channel:"cdp"`，还是 `waiting/tab_paused_by_debugger`；
4. 只在证据齐备后，才谈 CSP、遮挡、宿主 flap 或会话粘滞。

---

## 4. 仍未落地的诊断缺口（本次范围之外，只登记）

用户 2026-11-14 确认的推进范围是「只落文档」，以下**未实现**，不要写成已有能力：

- 统一错误码表 `HOST_FLAPPED` / `TAB_OCCLUDED` / `CSP_BLOCKED` / `DEBUGGER_STUCK` / `TARGET_GONE` / `TIMEOUT_UNKNOWN`。当前是零散但真实存在的 `eval_blocked_by_page_csp`、`devtools_already_attached`、`tab_paused_by_debugger`、`injection_failed`、`debugger_channel_failed` 等 reason。
- `operationId` + `browser_operation_status` 只读状态查询（全仓除现场报告外零命中）。
- hosts 的 `reconnectCount` / `disconnectReason` / `lastSeen` / `flapRate`。
- `browser_debugger action:"recover"` 与 SW 启动时的残留 attach 自检。
- `hostId:tabKey` 稳定跨宿主引用、`browser_tabs_hung`。
- `doctor` 的「强 CSP 编辑器探针」。

## 5. 关联

- 已知限制与硬边界：[docs/KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)
- CDP 网关可行性评估（未实现）：[docs/CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md)
- 动作可靠性 / 不确定结果：[docs/ACTION-RELIABILITY.md](ACTION-RELIABILITY.md)、[docs/MCP-WAITING.md](MCP-WAITING.md)
- 扩展错误维护：[docs/EXTENSION-ERROR-MAINTENANCE.md](EXTENSION-ERROR-MAINTENANCE.md)
- 进程与 PID 归属：[docs/PROCESS-LIFECYCLE.md](PROCESS-LIFECYCLE.md)
- 0.40.0 心跳误报修复：[CHANGELOG.md](../CHANGELOG.md)
