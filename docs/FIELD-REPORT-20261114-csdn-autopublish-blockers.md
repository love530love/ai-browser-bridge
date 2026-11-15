# FIELD REPORT — AI-Browser-Bridge × CSDN 自动发布阻滞复盘

- 日期：2026-11-14
- 场景：用 AI-Browser-Bridge（Chrome 扩展 + MCP）完成「CSDN 文章撰写 → 自动发布」全链路
- 结果：桥链路未能完成发布；改用 Playwright + CDP（独立调试配置）发布成功（articleId=<redacted>）
- 环境：
  - OS：Windows 11（10.0.29704）
  - 用户 Chrome：156.0.8078.49（默认配置，已登录 CSDN：UserName=<redacted> / UserNick=<redacted> / 后台显示「<redacted>」）
  - Bridge 主宿主：Chrome 157（ChatGPT 桌面端内嵌 Chromium，无窗口）
  - Bridge 版本：0.39.0；MCP 本地端口 19387
  - 配置：`K:\PythonProjects5\AI-Browser-Bridge\.local\config.json`（uploadRoots 含 `C:\Users\<user>\Documents\CSDN`，uploadMaxBytes=16777216，browserTarget 指向默认 Chrome 配置）
- 关联目标文档：`docs/ACTION-RELIABILITY.md`、`docs/PROCESS-LIFECYCLE.md`、`docs/MCP-WAITING.md`、`docs/EXTENSION-ERROR-MAINTENANCE.md`

---

## 1. 结论（TL;DR）

1. **P0：CSDN 编辑器页面上的所有页面级命令会整体卡死**。`browser_eval` / `browser_read` / `browser_screenshot` / `browser_close` 全部超时；服务级命令（health/hosts/tabs/queue/cookies）正常。根因链：CSDN CSP 阻断 eval 注入 → 桥回退 `chrome.debugger` → attach 成功但未正确收尾 → 标签留下调试横幅且渲染器停摆 → 之后 `browser_debugger open` 返回 `devtools_already_attached`，无任何恢复手段。
2. **P0：真实 Chrome 宿主高频 flap**（约 1.5–2 分钟一轮），每次重连生成新 sessionId、`commandsDispatched` 归零，进行中的命令与状态全部丢失，且无「命令是否已执行」的查询接口。
3. **P0：非前台窗口的页面脚本被冻死**。同一站点，Chrome 在前台时 `browser_eval` 毫秒级成功（`elapsedMs: 0, channel: "main_world"`），被遮挡/后台时全部超时；`browser_open active:true` 只激活标签页，不会聚焦 OS 窗口，无法自救。
4. **P1：宿主列表把 ChatGPT 内嵌 Chromium 当成一等公民**（无窗口宿主）。用户明确质疑：「本机有默认浏览器，为什么去 ChatGPT 里找浏览器？」——宿主缺少 `kind` 分类与默认选择策略，扩展装进内嵌浏览器后就会自动注册并抢主宿主。
5. **P1：MCP 工具超时 ≠ 未执行**。`browser_reload_extension` 超时后实际已执行（hosts 与 desktopOperation 日志可证），但调用方无法确认，只能人工核对，违反「不确定结果必须可查询」的基本要求。
6. **P1：缺少调试会话与卡死标签的应急通道**：没有 `browser_debugger action:"detach"`，没有按 URL/tabId 强杀（`browser_close` 也超时），卡死标签只能靠人工 Ctrl+W，且在窗口失焦时连 Ctrl+W 都打不进去。
7. **P2：诊断粒度不足**。同一个「超时」背后混着四种完全不同的根因（宿主 flap / CSP 回退 / 渲染器冻结 / 调试会话粘滞），错误信息不携带通道、阶段、耗时、宿主与会话 ID，排查成本极高。

---

## 2. 任务链路与关键事实

目标：把本地 `article.md`（5305 字符、9 章节、代码块、活链引用框、3 张本地配图）导入 CSDN Markdown 编辑器并发布。

事实基线：

| 项 | 结果 | 证据 |
|---|---|---|
| CSDN 登录态（默认 Chrome） | 有效 | cookies 36 条；`UserName=<redacted>`；`UserToken` / `UserInfo`(httpOnly) / `csrfToken` 存在 |
| 服务级命令 | 正常 | health / hosts / tabs / queue / cookies 均秒回 |
| CSDN 编辑器页面命令 | 全部超时 | eval / read / screenshot / close 无一返回 |
| Bridge 导入/发布 | 未完成 | 全程未产生任何 `saveArticle` 请求 |
| 替代路径 | 成功 | Playwright 1.58 + `chrome.exe --remote-debugging-port=9222 --disable-extensions --user-data-dir=<redacted-debug-profile>`，发布成功 |
| 成稿 | 已上线 | https://blog.csdn.net/<redacted>/article/details/<redacted> |

---

## 3. 阻滞明细（按严重度）

### P0-1 页面通道在 CSDN 编辑器整体卡死，调试会话残留不可恢复

**现象**

- 对 `https://editor.csdn.net/md/` 标签执行 `browser_eval` / `browser_read` / `browser_screenshot` → 全部超时。
- 同标签的 `browser_close` 同样超时；标签处于「已 attach 调试器」状态。
- Chrome 窗口出现横幅：`"自主浏览器 · AI Browser Bridge" 开始调试此浏览器 [取消]`。
- 此后 `browser_debugger action:"open"` 返回 `devtools_already_attached`。
- `browser_reload_extension`（重载扩展）执行后，**横幅与卡死状态依旧**，错误页清理没有触及调试会话。

**复现路径**

1. 默认 Chrome 打开 CSDN Markdown 编辑器（已登录）。
2. 桥服务器 + 扩展正常，hosts 可见真实 Chrome 宿主。
3. 任意页面级命令 → 超时。
4. 观察 Chrome 顶部调试横幅；再发任何页面命令 → 继续超时。

**根因分析**

- CSDN 编辑器响应头带严格 CSP（禁止 `unsafe-eval` 一类注入），桥的**脚本注入通道（eval/MAIN world）被拦截**。
- 桥的兜底路径是 `chrome.debugger` attach 后走 CDP `Runtime.evaluate`。attach 成功，但：
  - 会话生命周期没有「命令结束即 detach」或「超时即 detach」的约束；
  - 异常路径没有 `Debugger.resume` / `Page.setWebLifecycleState` 之类的恢复动作；
  - 重载扩展不会强制清理已存在的 attach（Chrome 侧会话仍粘滞该标签）。
- 结果：标签被留在「调试器挂着 + 渲染器停摆」状态，页面命令全挂；`browser_close` 也因为要跟页面通信而卡死。

**严重度理由**：这是「一次失败即永久损坏会话」的毒化型故障；对强 CSP 站点（CSDN、多数 SaaS 编辑器、银行后台）等于整站不可用，且会让同宿主的后续任务一起不可用。

**修复建议**

- 调试会话改为**短租约**：`attach → 执行 → finally: detach`；超时也必须 detach，并在 detach 前 `Debugger.resume`（如处于 paused）。
- 增加 `browser_debugger action:"detach"` / `status`，能识别「自己残留的 attach」并清理；`already attached` 不应是死胡同，而应自动尝试 detach 后重连。
- 增加**按标签强杀**：`browser_close {tabId|url, force:true}`，实现上走 `Target.closeTarget`（browser 级 WS）或 `/json/close/<targetId>`，不依赖页面响应。
- 扩展 SW 启动时做一次自检清理：遍历残留 debuggee，若属于本扩展则 detach。
- 注入层不要只依赖 eval：优先 `chrome.scripting.executeScript({world:"MAIN"|"ISOLATED"})` + postMessage RPC，并对 CSP 检测给出明确错误码（如 `CSP_BLOCKED`），而不是静默回退到高风险路径。

### P0-2 真实 Chrome 宿主高频 flap，命令与会话状态不可续

**现象**

- 宿主 `h-0b47a521c4384e90beb4`（Chrome 156）持续断连/重连，节奏约 1.5–2 分钟。
- 每次重连：`sessionId` 变化、`commandsDispatched` 归零；此前派发的命令无结果。
- 工具调用表现为「超时」，无任何 flap 提示。

**根因分析（待仓库侧验证）**

- 高概率与 MV3 Service Worker 生命周期、WS 心跳/超时策略、或扩展重注册逻辑有关；也可能是桥服务器把「心跳超时」当作会话结束，而扩展侧只重建会话不恢复队列。
- 无论具体诱因，**协议层缺少「稳定宿主身份」与「会话语义分离」**：hostId 虽然稳定，但命令队列、幂等键、结果缓存都绑在易碎的 session 上。

**修复建议**

- 明确三层模型：`hostId`（稳定） / `sessionId`（可轮换） / `tabKey`（稳定引用）。
- 队列与结果按 `(hostId, tabKey, operationId)` 持久化；重连后自动续投未决命令，已执行命令可查结果。
- hosts 输出附带：`disconnectReason`、`lastSeen`、`reconnectCount`、`flapRate(1m)`；超过阈值进入退避并显式告警。
- 心跳参数可配置，并支持「命令执行期间不因空闲判定掉线」。

### P0-3 非前台窗口页面脚本冻结；browser_open 不聚焦系统窗口

**现象**

- 同一 `example.com` 标签：
  - Chrome 在前台：`browser_eval` 立即成功（`elapsedMs: 0`，`channel: "main_world"`）。
  - Chrome 被遮挡或最小化：全部超时。
- `browser_open active:true` 能把标签切为 active，但**不会把 OS 窗口拉到前台**；本机 WorkBuddy 全屏应用持续抢占焦点，导致自动化全部假死。
- 此时 `browser_screenshot` 亦不可用（渲染被节流）。

**根因分析**

- Chrome 对不可见/被遮挡窗口执行渲染与定时器节流（occlusion throttling），页面主线程调度被冻结；扩展与页面通信依赖页面执行环境，于是命令超时。
- 桥没有区分「页面不存在/崩了」与「窗口被遮挡」；也没有提供聚焦能力，只能人工前置窗口。

**修复建议**

- `browser_open` 增加 `focusWindow:true`：`chrome.windows.update(windowId, {focused:true})`（必要时 `state:"normal"`）。
- 页面命令前自动检测 `document.visibilityState === "hidden"` 与窗口遮挡；无法聚焦时返回明确错误码 `TAB_OCCLUDED`，并提示调用方先聚焦。
- 走 CDP 时可用 `Page.bringToFront` + `Emulation.setFocusEmulationEnabled(true)` + `Page.setWebLifecycleState("active")` 降低对前台窗口的依赖；截图用 `Page.captureScreenshot` 而非页面内脚本。
- 文档明确写出「页面脚本通道要求窗口可见」这一硬约束（当前 README/quickstart 未显著提示）。

### P1-4 ChatGPT 内嵌 Chromium 被当成主宿主

**现象**

- hosts 首位宿主为 `h-b76b872f85d347a49e00`：Chrome 157，ChatGPT 桌面端内嵌浏览器，**无窗口**。
- 用户视角：本机明明有默认浏览器（已登录、正开着目标页面），桥却暴露/优先了 ChatGPT 里的浏览器，语义上不可接受。

**根因分析**

- 扩展被安装进 ChatGPT 内嵌 Chromium（Electron/CEF）后正常注册为宿主；桥未对宿主做 `kind` 分类（user-browser / embedded / headless / windowless），也没有「默认仅交互式宿主」的选择策略。
- 无窗口宿主天然不能做 UI 自动化，却与真实浏览器并列展示，造成误选与无效排查。

**修复建议**

- 宿主元数据增加：`kind: "user-browser" | "embedded" | "headless"`、`interactive: bool`、`hasVisibleWindow: bool`、`isDefaultProfile: bool`。
- 默认宿主策略：页面级操作只允许 `interactive && hasVisibleWindow`；同分时优先「用户最近活跃」或「系统默认浏览器」。
- 提供显式 `browser_use_host {hostId}`；hosts 列表排序与标签明确区分，避免用户误以为桥在「操作 ChatGPT 的浏览器」。
- 文档说明：桥的能力来自扩展安装位置，装进哪个 Chromium 就会注册哪个宿主；给出卸载/禁用内嵌宿主扩展的操作指引。

### P1-5 工具超时 ≠ 未执行；无操作状态查询

**现象**

- `browser_reload_extension` MCP 调用超时（"did not complete"），但实际已执行：hosts 显示扩展已重载，desktopOperation 记录 `browser_reload_extension:clear-errors`。
- 依据「不确定结果禁止重放」的原则，只能人工核查后放弃重试，效率极低。

**根因分析**

- 工具协议只有同步返回；长操作没有 `operationId`、没有异步状态查询，超时即语义丢失。

**修复建议**

- 所有写操作返回 `operationId` + 初始状态；新增 `browser_operation_status {operationId}`（queued/running/succeeded/failed/unknown）。
- 超时错误里携带 `operationId`、`hostId`、`sessionId`、`likelyExecuted`（可推断时）。
- 幂等声明：`reload_extension`、`close_tab`、`open_tab` 标注幂等，重复调用安全。

### P1-6 标签与调试生命周期缺应急通道

**现象**

- 卡死标签：`browser_close` 超时；`browser_debugger open` → `devtools_already_attached`；扩展重载无效；只能手动 Ctrl+W，且窗口失焦时快捷键进不去。
- 标签 ID 是**宿主作用域**的；宿主 flap 后旧 tabId 失效，但错误信息不说明，容易被误判为「页面问题」。

**修复建议**

- 统一稳定引用：`hostId:tabKey`（tabKey 可用 chrome tabId + URL 哈希），跨宿主可查找。
- 新增：`browser_tabs_find {urlPattern}`、`browser_close {url|tabKey, force}`、`browser_tabs_hung`（依据心跳/命令超时标记）。
- 关闭实现不依赖页面执行：优先 `chrome.tabs.remove`，失败则 `Target.closeTarget`。

### P2-7 诊断粒度不足（同一「超时」掩盖四种根因）

**现象**：调用方无法区分：

1. 宿主 flap（会话重建）；
2. CSP 拦截 + debugger 回退；
3. 窗口遮挡导致渲染冻结；
4. 调试会话粘滞（`already_attached` 后的死循环）。

**修复建议**

- 每次调用记录：`channel`（service / page / debugger / cdp）、阶段耗时（dispatch/attach/eval/return）、宿主/会话/标签、最后一次心跳。
- 错误码体系：`HOST_FLAPPED` / `TAB_OCCLUDED` / `CSP_BLOCKED` / `DEBUGGER_STUCK` / `TARGET_GONE` / `TIMEOUT_UNKNOWN`。
- `doctor` 增加一项「CSDN/强 CSP 编辑器探针」，输出一次全链路自检结果。

---

## 4. 已验证可用能力（应保留）

- 服务级命令稳定：health / hosts / tabs / queue / cookies，可在页面通道全挂时用于诊断。
- 登录态检查：读取 `UserName` / `UserNick` / `UserToken`(httpOnly) / `csrfToken`，可判定 CSDN 登录有效性（本次据此确认默认 Chrome 可发布）。
- `browser_open active:true` 能正确激活标签（只差 OS 窗口聚焦）。
- `browser_reload_extension` 功能本身有效（清理 errors 成功），问题只在结果回传。
- 配置面合理：uploadRoots / uploadMaxBytes / browserTarget 默认配置路径，便于做文件类自动化（本次未用到上传通道）。

---

## 5. 升级方向（Roadmap 建议）

### 5.1 主线：CDP Gateway 模式（推荐优先级 P0）

背景：Chrome 136+/148+ 禁止在**默认配置**上开 `--remote-debugging-port`，而 Playwright 直连默认配置会丢失登录态；本次只能开独立调试配置（名称已脱敏）绕开，代价是重新登录/重配。

建议：由扩展用 `chrome.debugger` attach 目标标签，桥在本地（127.0.0.1，带 token 鉴权）暴露一个**CDP 复用网关**（WebSocket），把 `Target/Runtime/Page/Input/Network` 子集翻译到扩展会话。这样：

- Playwright / Puppeteer 可 `connect_over_cdp` 到网关，直接驱动**用户日常已登录的默认浏览器**；
- 不受默认配置禁调试限制（attach 由扩展完成）；
- 天然复用现有 MCP 能力，且可只暴露页面 target、过滤扩展自身 target（见 5.6）。

已知坑（本次实测）：Playwright 1.58 `connect_over_cdp` 在存在扩展 target（如 Quark AI 插件、offscreen 扩展）时会卡在 `<ws connected>` 后 180s 超时；`--disable-extensions` 后恢复正常。若做网关，必须在 `Target.getTargets` 层只返回页面 target，或提供 `--target-filter=page`。

### 5.2 CSP 安全注入层（P0）

- 弃用 eval 主路径：`chrome.scripting.executeScript({world:"MAIN", func, args})` + `window.postMessage` RPC。
- CSDN 编辑器 CSP 命中时，直接走 debugger/CDP 通道，并明确返回 `CSP_BLOCKED → falling back to debugger`，不要静默。
- 注入世界区分 `MAIN` / `ISOLATED`，文档标注哪些站点需要 MAIN。

### 5.3 调试器生命周期治理（P0）

- 会话租约 + finally detach；异常时 `Debugger.resume`。
- `browser_debugger` 增加 `detach` / `status` / `recover`。
- 扩展启动自检清理残留 attach。
- 横幅只应在真实执行期间出现；命令结束应自动消失（与 5.3 验收绑定）。

### 5.4 会话与宿主治理（P0）

- 稳定 `hostId` + 轮换 `sessionId` + 稳定 `tabKey`；命令队列跨重连续投。
- flap 指标与退避；hosts 输出版本化能力（chromeVersion、kind、interactive、hasVisibleWindow、isDefaultProfile）。
- 默认宿主策略：交互式用户浏览器优先，内嵌/无窗口宿主不参与页面操作默认选择。

### 5.5 操作可观测性与幂等（P1）

- 每个命令 `operationId`；异步状态查询；结构化 outcome（not_started / succeeded / partial / unknown）。
- 超时错误必须可自证：包含 `operationId` 与 `likelyExecuted`。
- 幂等表：reload / close / open / detach。

### 5.6 聚焦与可见性（P1）

- `browser_open {active, focusWindow}`；`chrome.windows.update({focused:true})`。
- CDP 侧 `Page.bringToFront`、`Emulation.setFocusEmulationEnabled`、`Page.setWebLifecycleState("active")`。
- 检测 `visibilityState` 与窗口遮挡，返回 `TAB_OCCLUDED` 而不是裸超时。
- 截图优先 CDP `Page.captureScreenshot`（不依赖页面执行）。

### 5.7 标签生命周期（P1）

- `hostId:tabKey` 稳定引用；按 URL 查找/关闭；hung 标记；批量清理。
- 关闭优先 `chrome.tabs.remove`，兜底 `Target.closeTarget`，不依赖页面响应。

### 5.8 文档与默认宿主说明（P2，但直接决定用户信任）

- 新增「已知限制」页：窗口可见性硬约束、CSP 站点行为、调试横幅含义与手动取消方式、宿主 flap 的含义。
- 解释「扩展装在哪个 Chromium，就会注册哪个宿主」；如何禁用 ChatGPT 内嵌宿主；如何指定默认宿主。
- 提供「CSDN/富文本编辑器」案例页（本次复盘即可直接改写为文档）。
- 排障矩阵：
  - service 级 OK + page 级全超时 → 先看 visibility/window、再看 CSP/debugger；
  - 横幅存在 + `already_attached` → 走 detach/recover；
  - 标签命令时好时坏 → 查 host flap 与 sessionId 轮换。

---

## 6. 验收用例（建议纳入 regression）

1. **遮挡场景**：Chrome 被其他全屏窗口覆盖时，`browser_eval` 5s 内返回 `TAB_OCCLUDED`（或自动聚焦成功），不得 180s 裸超时。
2. **CSP 场景**：在 CSDN 编辑器执行 eval + read + screenshot，全程无残留调试横幅；命令结束后 `browser_debugger status` 为 detached；`browser_close` < 2s。
3. **Flap 场景**：30 分钟长跑期间强制重连宿主，未决命令在重连后自动续投，且可通过 `operationId` 查到唯一结果（无重复执行）。
4. **超时语义**：`browser_reload_extension` 立即返回 `operationId`；查询状态为 succeeded；重复调用幂等。
5. **强杀场景**：人为制造卡死标签，`browser_close {url, force:true}` 5s 内生效并释放 target。
6. **CDP 网关**：Playwright `connect_over_cdp` 直连网关，在**默认配置（已登录）**上完成一次导航 + evaluate + 截图；扩展 target 被过滤，无 180s 握手卡死。
7. **宿主策略**：hosts 明确标注 ChatGPT 内嵌宿主 `interactive:false`；若本机存在可见的用户 Chrome，页面级操作默认选择它。

---

## 7. 附录 A：原始证据（脱敏）

```
# 宿主 flap（摘要）
host h-0b47a521c4384e90beb4: sessionId 周期性变化（约 1.5–2 min），
commandsDispatched 每次重连归零；期间 page 命令超时。

# 遮挡 vs 前台（同一标签 example.com）
Chrome 前台: browser_eval -> {ok:true, elapsedMs:0, channel:"main_world"}
Chrome 被遮挡: browser_eval -> timeout

# CSDN 编辑器
browser_eval     -> timeout
browser_read     -> timeout
browser_screenshot -> timeout
browser_close    -> timeout
Chrome 横幅: "自主浏览器 · AI Browser Bridge" 开始调试此浏览器 [取消]
browser_debugger action:"open" -> devtools_already_attached
browser_reload_extension -> MCP timeout（实测已执行；desktopOperation=browser_reload_extension:clear-errors）

# 替代路径（成功）
Chrome 156 + --remote-debugging-port=9222 --remote-allow-origins=* --disable-extensions \
  --user-data-dir=<redacted-debug-profile>
Playwright 1.58 connect_over_cdp -> 正常
发布结果: articleId=<redacted>, /mp_blog/creation/success/<redacted>

# 扩展 target 阻塞 Playwright 握手的证据
connect_over_cdp: "<ws connected> ws://127.0.0.1:9222/devtools/browser/..." 后 Timeout 180000ms
加 --disable-extensions 后立即成功
```

## 8. 附录 B：CSDN 发布链路修正（非桥缺陷，建议同步到技能库）

本次借 Playwright 直连补齐了 CSDN 新编辑器的发布语义，供桥的示例/技能文档参考：

- `POST /blog-console-api/v3/mdeditor/saveArticle` 是**自动保存/草稿保存**接口；返回 `code=200 + data.id` **不等于发布**（本次首次尝试即落入草稿箱）。
- 发布弹窗（`.cfw-modal`/全屏发布页）底部真正的发布按钮是橙色 **「发布文章」`button.btn-b-red`**；隐藏的 `simulation-button` 点击无效，容易造成「假成功」。
- 成功判据：跳转 `https://mp.csdn.net/mp_blog/creation/success/<id>` 或出现「发布成功」提示。
- 必填/易坑项：AI 提取摘要合规闸门（`button.btn-getdistill`）、摘要 ≥10 字否则静默阻塞、文章标签至少 1 个、创作声明、封面（`og:image` 即封面）。

## 9. 遗留事项

- 桥在用户默认 Chrome 中创建过多个测试标签（含一个卡死标签 663195172，带调试横幅）；建议新增批量清理 API 后再统一回收。
- 建议把本报告拆成两个可执行任务：
  1. `docs/TROUBLESHOOTING-MATRIX.md`（5.8 排障矩阵落文档）；
  2. `docs/CDP-GATEWAY-PLAN.md`（5.1 设计与 PoC 验收用例）。

---

*报告生成于 2026-11-14；所有命令与输出均来自本机真实会话，没有推测性数据（推测处已标注）。*
