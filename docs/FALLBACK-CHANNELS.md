# 执行通道与旁路门禁（2026-11-15）

本文回答一个问题：**当主通道做不了时，按什么顺序换通道，换之前要满足什么。**
原则：能力不设 URL 前缀禁区，但换通道必须有证据、有边界、有验证；不因一次失败就换浏览器或起第二条控制链。

## 1. 通道阶梯

| 阶梯 | 通道 | 入口 | 适用 | 写操作 |
| --- | --- | --- | --- | --- |
| 0 | 扩展 DOM / Chrome API | 默认 MCP 工具 | 普通网页、表单、SPA、iframe、Shadow DOM | `_verified` 变体 |
| 1 | CDP 只读探针 | `browser_debugger action:"probe"`、`browser_devtools_capture` | 诊断、Console/Network/Performance、target 判断 | 不提供写入 |
| 2 | Windows UI Automation | `browser_extension_errors`、`browser_desktop_windows`、桌面适配器 | Chrome 内部页、扩展页、无 DOM 表面 | 精确目标 + 回读 |
| 3 | 视觉 / 坐标 | `browser_screenshot`、`browser_prepare_coordinate`、`browser_visual_elements`（规划） | Canvas、图片页、DOM 缺失 | 先检查遮挡/视口/缩放，动作后验证 |
| 4 | Playwright 门禁 PoC | `poc/playwright-fallback/gate-check.mjs` | 仅桥不可达且用户明确授权 | 默认不启动；独立临时 profile；不复用用户登录 |
| 5 | 人工接管 | `nextStep` / `requires_user` | 以上均无法证明 | 用户决定 |

阶梯不是“越往下越强”，而是“越往下证据越弱、侵入性越高”。能在阶梯 0 验证完成的任务，不得为了省事下探。

## 2. 主通道前置检查

```text
browser_health → browser_hosts → browser_tabs → browser_observe/browser_read
```

- 多宿主时必须看 `recommendedHostId`、`defaultHostId`、`selectionRequired`、`selectionReason`；
- 未显式传 `hostId` 的命令走推荐宿主，不再默认旧 primary；
- 显式 `hostId` 的命令绑定该浏览器；掉线返回 `waiting/host_not_connected`，不得静默改派；
- tab id 只在单个宿主内唯一，跨宿主必须同时给 `hostId`。

## 3. CDP 只读通道

已实现：

- `browser_debugger action:"probe"`：`Target.getTargets`、`Schema.getDomains`、`Page.getFrameTree`、`Runtime.evaluate("1+1")`、`Input.setIgnoreInputEvents`、无效域探测；
- `browser_devtools_capture`：一次 attach 内有界采集 Console / Network / Sources / Performance；URL 去 query/fragment/凭据，不采集 header/cookie/body。
- **深度只读感知（0.44.0 工作树）**：`browser_script_inventory`、`browser_source_map`、`browser_event_listeners`、`browser_dom_snapshot`、`browser_framework_tree`。Debugger 只做临时 attachment 并在返回前 detach；已有 `browser_debugger` 会话时复用，不产生第二个调试横幅。source map 以页面源优先、扩展源兜底，只做 GET；DOM/组件树只走主 frame 注入，不修改页面。五者都只返回证据、不返回 ref，动作仍须回到 `browser_locate`/`browser_find_element` + `_verified`。

边界：

- 不读 `Cookies`、`Login Data`、`Local State`；不做 profile 解析；
- 只观察被检查 tab；窗口内导航漂移返回 `targetChanged`；
- 空列表不证明没有发生；domain enable 前的事件不可见；
- CDP **写入网关未实现、未授权**；探针结果中 `Target` 被拒（`-32000`）是宿主能力事实，不是重试理由。

验收：`node src/cli.js cdp-probe --host-id <id> --tab-id <id> --out .local/...json`，检查 `gate1`、`targetDomain`、`browserLevelEndpoint`。

## 4. UI Automation 通道

适用：`chrome://extensions`、扩展错误列表、DevTools 外壳、无 DOM 的浏览器 UI。

规则：

- 必须绑定到持有扩展连接的进程 PID 与具体窗口 HWND；不可达时返回 `hostBinding`，不换窗口猜；
- 只读动作优先：`browser_extension_errors action:"read"` 只观察，不点 `Clear all`；
- 写动作必须回读验证；地址栏未验证为 `chrome://extensions` 时不得 reload 用户页面；
- 最小化窗口用 `SW_SHOWNOACTIVATE` 恢复，不抢前台；恢复结果要回读确认；
- 页面未就绪是 `page_not_ready`，不是“列表为空”；`empty` 必须有已读页面证据。

## 5. 视觉 / 坐标通道

- 先 `browser_screenshot` 取当前视口与 DPR；坐标动作记录视口、缩放、截图哈希；
- 先 `browser_scan_overlays` / `browser_prepare_coordinate` 检查遮挡与命中；
- 动作后必须重新截图/观察验证，不能以“点了”作为成功；
- 视觉通道不用于绕过验证码、登录或安全提示。

已实现：`browser_ocr`（Windows.Media.Ocr 本地后端，无权重/网络；临时截图删除、识别文本不入账本；返回行框与 0..1000 坐标但不返回 ref）。规划中：`browser_visual_elements`（非文本元素检测）、OCR 多 provider 插拔。权重默认不随包分发，许可证与选型见 [OPEN-SOURCE-CAPABILITY-RADAR.md](OPEN-SOURCE-CAPABILITY-RADAR.md)。

## 6. Playwright 旁路门禁

只有同时满足才允许进入：

1. Bridge 不可达或目标能力在 Bridge 上不存在（有健康/能力证据）；
2. 用户**明确授权**使用 Playwright，且范围限定本次任务；
3. 门禁脚本通过：不导入 Playwright 的预检、临时 profile、`127.0.0.1` fixture、精确确认串。

禁止：

- 复用、复制或解析用户 Chrome profile；
- 以第二个 debug profile 充当登录态恢复手段；
- 在 Bridge 可用时并行启动 Playwright 抢同一浏览器；
- 未授权时用 Playwright“先试试”。

当前状态：门禁脚本与契约测试已实现；live PoC **未运行、未通过、未获运行授权**。详见 [PLAYWRIGHT-FALLBACK-DECISION.md](PLAYWRIGHT-FALLBACK-DECISION.md)。

## 7. 后台优先与前台预算（0.42.1）

默认契约：**自动化在后台完成，不抢屏幕、不夺焦点、不打断宿主机上的人。**
Chrome 可以最小化、可以被其他窗口完全遮挡，DOM 注入（`chrome.scripting.executeScript`）与 CDP 通道照常工作。

| 操作 | 前台行为 |
| --- | --- |
| `browser_open` | 默认 `active:false`；只有显式 `active:true` 才激活 tab |
| `browser_navigate` / 回读 / 查找 / 截图 | 不激活窗口 |
| `browser_history action:"activate"` | 显式前台动作，调用方声明后才切 tab |
| `browser_extension_errors action:"open"` | 显式前台动作 |
| `browser_windows_control focused:true` | 显式前台动作 |
| 剪贴板 / UIA 重载 | 仅在 `allowFocus:true` 时请求前台 |

隐藏文档的已知物理限制与正确应对：

- `requestAnimationFrame` 不触发，CSS 离场动画可能永不结束 → 使用有界超时 + 重新观察，不要为了等动画去激活窗口；
- 定时器被节流 → 按 `throttled` / `visibilityState` 诊断处理，不盲目重试；
- `Page.captureScreenshot` 在纯隐藏 tab 上可能长时间等待 → 走封装好的 screencast 预热路径；
- `Page.bringToFront` 会抢 tab 前台，默认路径不使用。

前台预算：一次常规任务的前台变更次数应为 **0**。只有两类例外——用户明确要求观看过程，或目标是无 DOM 表面的内部页且调用方已获得 `allowFocus` 授权。`_verified` 写操作在后台 tab 上同样有效，不需要先激活窗口；重新观察即可确认结果。

同页重复写保护：相同写在页面状态未变时 8 秒内返回 `status:"duplicate_suppressed"`（`dispatched:false`），是安全拒绝而非失败；确需重复时显式传 `allowRepeat:true`。指纹只取页面状态与目标元素，不读取输入值。

实测证据（`npm run test:focus` / `npm run test:background`）：最小化且未聚焦的 Chrome 上 25 项原语全部通过；3 个后台 tab、30 路混合并发、同 tab 突发写共 51 项断言通过，OS 前台窗口 identity（handle/pid/process）与 Chrome 窗口 `focused/state` 前后不变。

## 8. 失败语义

| 结果 | 含义 | 允许动作 |
| --- | --- | --- |
| `waiting` | 任务存活，队列/宿主暂不可用 | 保留任务，等待或查询队列；不新建浏览器 |
| `not_dispatched` | 预期条件已满足或前置失败，未派发 | 可重新观察后决定是否派发 |
| `uncertain` | 已派发但结果未观测 | **禁止重放**；重新观察/验证 |
| `denied` | 策略/权限拒绝 | 不绕过；按 `reason` 调整或交给用户 |
| `unsupported` / `not_implemented` | 能力缺口 | 换阶梯或报告，不假装完成 |
| `failed` | 有证据的失败 | 按 `retryable` 与 `nextStep` 处理 |

## 9. 多宿主与旁路

- 旁路通道也必须绑定同一个目标浏览器/窗口；不能因为主通道失败就换到另一个浏览器；
- UIA 以 PID/HWND 绑定；CDP 以 tab target 绑定；Playwright 只允许临时 profile + fixture；
- 任何通道的结果都要回写 `hostId`（适用时）与证据字段，便于 `usage`/`heartbeat` 归因。

## 10. 验收清单

1. 主通道可用时，旁路不得启动（门禁脚本 `playwrightStarted:false`）。
2. 多宿主场景：无 `hostId` 命令落到推荐宿主；显式宿主掉线返回 `waiting`。
3. 内部页只读：`browser_extension_errors action:"read"` 返回 `dispatched:false` 且状态有页面证据。
4. CDP 探针输出不含 cookie/header/body/凭据；被拒域如实记录。
5. 视觉动作前后均有截图/几何证据。
6. 任何 `uncertain` 写操作在审计中可见且未被自动重放。
