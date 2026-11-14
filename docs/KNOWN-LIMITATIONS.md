# 已知限制与硬边界（0.40.0）

- 适用版本：**0.40.0**（`main`，HEAD `3f69ec1`）。本文只描述**当前源码能复核到的事实**，不描述路线图。
- 来源：汇总 `docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md` 第 5.8 节的诉求，与 `README.md` / `CHANGELOG.md` / `src/capability-guide.js` 中分散的边界说明。
- 用法：遇到异常先查 [排障矩阵](TROUBLESHOOTING-MATRIX.md)；本文回答「哪些事本来就不该指望桥去做、或者需要额外前提」。

> **一条总原则**：本项目的产品方向是「覆盖人类可通过 Chrome UI 操作的全部操作面，不因 URL 类型永久列为禁区，不设能力禁区，安全性由 agent 判断」。但**方向不等于现状**——能力若没有能走到的工具路径，就按「不存在」处理；本文列的就是当前确实存在的边界。

---

## 1. 窗口可见性与前台（最常被误解的一条）

| 事实 | 证据 |
|---|---|
| 绝大多数 DOM / CDP 原语在**后台标签**上照常工作 | `src/capability-guide.js` 多数条目 `backgroundSafe:true`；`extension/worker.js:1287` 明写主注入通道「No debugger attachment, no banner, no foreground, works on a background tab」；`README.md` 0.5.24「焦点独立性契约」后台实测 25/25 |
| `tab.active` / `window.focused` / `document.visibilityState` / `document.hasFocus` 是**四种不同状态，且都只是建议值** | `src/capability-guide.js:254` 的 `advisoryOnlyStates`；`src/tools.js:297` `browser_health` 的分层说明 |
| 只有显式 `requireForeground:true` 的动作才要求前台 | `extension/page.js:1629` / `:1670`；`src/capability-guide.js:18` |
| 隐藏文档里 `requestAnimationFrame` 永不触发，等待 settle 必须先判 `visibilityState` | `extension/page.js:2996` 的 `timer_hidden_document`；`test/visibility-runtime.test.js` |
| `browser_open active:true` 只把标签切为 active（**不聚焦 OS 窗口**） | `extension/worker.js:743` / `:750` 走 `chrome.tabs.update({active:true})`；`src/tools.js:130` |
| 聚焦窗口的能力**有**，但必须显式且带确认 | `browser_windows_control {focused:true}` 要求 `confirmation:"modify_window_once"`（`src/tools.js:693-704`）；`src/capability-guide.js:66` 明说「抢前台正是本桥要避免的打断」 |

**硬边界**：桥**不隐式抢前台、不启 GUI、不改 `browserTarget`**。`browser_reload_extension` 在扩展在线时走 `chrome.runtime.reload`（不开窗、不按键、不聚焦），只有扩展断连时才回退到需要前台的 Windows UI Automation，且要 `allowFocus:true` 才派发（`src/capability-guide.js:36`）。`browser_launch` 只在**没有任何 chrome 进程**时启动，且不带 profile / 隐身参数，沿用默认配置（`README.md` 0.5.25）。

因此「给 `browser_open` 加 `focusWindow:true` 且默认自动聚焦」**不是修复建议**：它会与上述约定冲突。若确实需要用户看到窗口，请显式调用 `browser_windows_control` 并自行承担确认。

**若现场观察到「前台正常、后台全超时」**：先按排障矩阵 §1 #1 查 `tab_paused_by_debugger`，再查宿主连通性，不要直接归因遮挡。当前代码里已有 `window_not_focused` / `document_hidden` / `document_unfocused` 三个 advisory（`extension/worker.js:922-924`）与 `evidenceQuality: 'stale-frame-possible'` 提示，但没有统一的 `TAB_OCCLUDED` 错误码。

---

## 2. CSP 站点与脚本注入

- `browser_eval` 的主路径是 `chrome.scripting.executeScript({world:'MAIN', func})`（`extension/worker.js:1290`）：不开面板、不弹横幅、不抬窗口。
- 只有页面 CSP 拒绝 `eval` 时才自动降级到 CDP `Runtime.evaluate`（`worker.js:1299-1315`），命中时返回明确 reason `eval_blocked_by_page_csp`（`extension/eval-main.js:171-180`），返回体 `channel` 标明实际走的那条。**不是静默回退**。
- `mode:"read"` 用 `const` 遮蔽 `fetch` / `XMLHttpRequest` / `window.open` 等，但这是**防误触护栏，不是安全沙箱**（`readOnlyIsGuardrail:true`）；表达式仍可经 iframe 绕开，结果是不可信页面数据（`src/tools.js` 与 `README.md` 0.30.0 段）。
- `chrome://` 页、Web Store、PDF viewer **既拒绝注入也不接受 debugger attach**；`worker.js:1307` 会直接给出「用桌面路径或页面自身控件」的指引，不做无谓重试。
- `chrome.debugger` 只在 `http(s)` 标签上 attach（`worker.js:1303` 的 `canAttach`）。

---

## 3. 调试横幅、DevTools 互斥与调试会话残留

- **横幅只在长活会话期间出现**：`browser_debugger`（`src/tools.js:371`）明写「session 开着时 Chrome 显示调试提示条，期间 DevTools 无法附加」。一次性 CDP 回退**不会**留下横幅——`extension/cdp.js:13-14` 是 `try/finally { chrome.debugger.detach }`。
- **关闭路径是安全的**：`extension/cdp-session.js:100-117` 每条退出路径先 `Debugger.resume` 再 detach；暂停且无人查看的会话按 `session.paused.autoResumeInMs` 自动恢复。暂停期间其它页面工具返回结构化 `waiting / tab_paused_by_debugger`，而不是静默超时（自 0.6.0 起）。
- **`devtools_already_attached` 是真实死胡同**：`cdp-session.js:143-149` 返回 `retryable:false`、`dispatched:false`、要求人去关该标签上的 DevTools 或换标签。**扩展无权 detach 别的调试器持有的会话**，当前也没有 `action:"recover"` 或 SW 启动时的残留 attach 自检。这是已知缺口，不是已修复项。
- **扩展重载不清横幅**：`browser_reload_extension` 不会替你关闭长活会话。要清，用 `browser_debugger {action:"list", tabId:<真实 tabId>}` → `status` → `close`（**`tabId` 必填**，见 `docs/LOCAL-EVIDENCE-20261114-runtime.md` §5）；若 attach 属于别人，只能人工在横幅上点「取消」或关 DevTools。
- **CDP override 可能比会话活得更久**：`README.md` 0.23.0 段实测视口 override 在 detach、扩展重载、服务重启后仍残留，只有**导航/刷新该标签**才还原。`clear` 命令被接受 ≠ override 消失；`browser_emulation` 因此用 set 前 baseline + 回读页面判定 `verified` / `stillInEffect`。

---

## 4. 宿主身份：扩展装在哪个 Chromium，就注册哪个宿主

这是用户质疑「本机有默认浏览器，为什么去 ChatGPT 里找浏览器」的直接答案。**桥的能力来自扩展的安装位置，不是从系统里挑浏览器。**

- 已有分类：`src/host-registry.js:66-120` 的 `hostKind`（`generic` / `stable` / `canary` / `agent_embedded`）与 `featureFlagsFor()` 的 `uiAutomationLikely`（`agent_embedded` → `false`，`generic` → `null`，其余 → `true`）；`src/server.js:1649` 的 `hostKindObserved` 对非 Chrome 宿主标 `agent_embedded`。
- **身份是 `hostId`，不是 `extensionOwner`**：owner 会摆动，hostId 稳定；owner 变了但 hostCount / connected / missingHostIds 不变，就不是宿主丢失。
- **精确绑定**：所有工具支持可选 `hostId`（`README.md` 0.36.0 段），显式指定的宿主掉线返回 `waiting`，**绝不静默改派到另一个浏览器**。tab id 只在单个浏览器内唯一。
- **尚未提供**：`interactive` / `hasVisibleWindow` / `isDefaultProfile` 元数据、`browser_use_host` 工具、以及「默认只选交互式可见宿主」的选择策略。因此**内嵌无窗口宿主仍会并列出现在 hosts 里**，需要调用方自己按 `hostKind` / `features` 判断并显式传 `hostId`。
- **禁用内嵌宿主**：在对应 Chromium 的扩展管理页禁用/卸载本扩展即可；桥不会替用户删除别的浏览器里的宿主，也不提供「从 hosts 列表里隐藏」这类会掩盖事实的选项。
- **不按注册表顺序取 `chrome.exe`**：本机 `browserTarget = stable / Default`，指向 `D:\Program Files\Google\Chrome\Application\chrome.exe`；HKCU Canary(SxS) 与 HKLM 稳定版 user-data 独立，取错会打到另一个浏览器。

---

## 5. 会话轮换、累计计数与「超时 ≠ 未执行」

- `sessionId` 每次重连重新生成（`src/host-registry.js:142`），`hostId` 保持稳定。重连时 `commandsDispatched` 归零是**设计**，不是故障。
- **累计计数器不是瞬时状态**：`Σ(dispatched − completed)` 会因读/写超时 drop、`ws.close(4000)` 不补 completed 而留下历史差值，与瞬时 `inFlightHosts` 不可比。0.40.0 已把它降级为观察字段 `cumulativeDispatchGap`（`src/heartbeat.js:266`），判定泄漏只比同一快照内由同一个 `inFlight` Map 构造的 `activeCount` / `activeByHost` / `hosts[].inFlight`。
- **没有 `operationId`**：全仓除现场报告外零命中，也没有 `browser_operation_status`。长操作超时后没有统一的状态查询工具。
- 但**不是黑盒**：`browser_reload_extension` 超时返回 `status:uncertain` / `verified:false` / `dispatched:true` / `hosts[]` 快照（`src/server.js:1361-1366`）；`browser_eval` 双通道失败会明说「Nothing is known about whether the expression ran; do not repeat it blindly」（`worker.js:1331`）。
- **写操作不确定结果绝不重放**：用 `commandId` 幂等键（`README.md` 0.36.0），`status:waiting` 按 `nextPollTool` / `nextPollArgs` 重新观测后再决定（[MCP 等待契约](MCP-WAITING.md)）。已派发的 write 不会因为客户端断开而被撤销。

---

## 6. 服务与进程判定的边界

- `.local/server.pid` **不是进程存活证据**：可指向死进程、真实监听者可能是另一个 node、PID 也可能被复用为完全无关的程序。**绝不 kill 未验证的 PID**；判存活用 LISTENING PID + TCP 探针 + 裸 `/status`（带端口应返回 401，属预期鉴权）+ 带 token 的 `/status` 或 `doctor`（见 [进程生命周期](PROCESS-LIFECYCLE.md)）。
- 裸 `GET /status` 被拒是**预期鉴权**，不是服务坏了。token 不写命令行、脚本或日志。
- `doctor ok:true` 只按 `checks[].ok` 对账；`heartbeat` 的 `clean` 必须有证据链（`provenClean`），`critical` 也不等于要动手——动作只看 `finding.action.kind` 与 `remediation[]`。

---

## 7. 其它已实测但无法绕过的事实

| 事实 | 出处 |
|---|---|
| `chrome.debugger.sendCommand` 只转发 CDP 域的一个子集（`DOMStorage.enable` / `IndexedDB.enable` 实测 `-32601`，`Network.getCookies` 可用） | `extension/cdp-storage.js:128-131`、`README.md` 0.9.0 |
| V8 已移除 `Debugger.setScriptSource`，任何参数都返回同一个 ServerError；桥如实返回 `script_edit_removed_by_v8` | `cdp-session.js:422-466`、`src/tools.js:371` |
| `chrome://` 内容对 UI Automation 不可见，`native_action` 只能驱动外壳 | `README.md` 0.8.0 / `docs/NATIVE-UI-PRIMITIVES.md` |
| 本机密码库能解同 profile 的 cookies，但读不到已保存密码；失败拆成三种处置相反的原因 | `README.md` 0.7.0 |
| 剪贴板 offscreen 文档 `navigator.clipboard.readText()` 抛 "Document is not focused"，后台可用的是原生宿主那条路 | `extension/clipboard.js:9-23`、`:431` |
| Chrome 136+ 起默认配置开 `--remote-debugging-port` 的限制 | **报告主张，本仓库未在本机复核**；见 [CDP 网关评估](CDP-GATEWAY-PLAN.md) §2.4 |

---

## 8. 本次文档交付的边界

本页与 `TROUBLESHOOTING-MATRIX.md`、`CDP-GATEWAY-PLAN.md`、`skills/csdn-publish/` 同属 **2026-11-14 纯文档交付**：**不改 `src/` / `extension/` 代码，不改版本号，不改 buildId**。

依据是 `src/build-identity.js`：`computeBuildIdentity()` 只 hash `package.json`、`package-lock.json`、`skills/ai-browser-bridge/SKILL.md` 与 `src/**/*.{js,mjs,cjs,json}`。`docs/` 不在哈希范围内，因此这次交付**不会**触发 `build_stale` / `version_skew`，**不需要**重启服务或重载扩展。若后续改动涉及 `src/` 或 `extension/manifest.json`，则必须按 `CHANGELOG.md` 0.40.0 的升级步骤重启 + 按 `hostId` 重载。

## 9. 关联

- [排障矩阵](TROUBLESHOOTING-MATRIX.md) · [CDP 网关评估（未实现）](CDP-GATEWAY-PLAN.md)
- [操作可靠性](ACTION-RELIABILITY.md) · [MCP 等待契约](MCP-WAITING.md) · [扩展错误维护](EXTENSION-ERROR-MAINTENANCE.md)
- [Chrome 能力矩阵](CHROME-CAPABILITY-MATRIX.md) · [产品路线图](PRODUCT-ROADMAP.md) · [CHANGELOG](../CHANGELOG.md)
