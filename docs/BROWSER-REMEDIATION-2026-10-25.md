# 业务后台采集问题处置

2026-10-25，根据 CAPABILITY-GAP-ANALYSIS-2026-10-25.md 核对源码。原报告保留，以下区分观察与代码证据。

## 0.5.19 已实现，需部署后现场验收

- P0 网络摘要伪空：Chrome debugger 的 Runtime.evaluate 返回 `{result:{value}}`，原 worker 错读为 `result.result.value`（在已命名 result 的对象上又读两层），导致已有资源也返回空列表。改用统一 CDP 结果解码，缺值/异常不再伪装成空数组。性能诊断同修。
- 网络摘要返回 readyState、timeOrigin、来源和限制；URL 去除用户信息、query 与 fragment。只涵盖当前主 frame 的 Resource Timing 缓冲，可能含扩展接入前仍保留的记录；不是“只在扩展跟踪期间捕获”。导航前后 URL 变化时拒绝旧结果，同 URL 文档更换仍存在竞态。
- fill 回执增加实际派发事件和 applicationStateVerified:false，避免把输入值清空当作退出搜索模式。
- capabilities 明列 evaluate、网络响应体、page source 尚未实现，解释 readiness 只代表服务/队列准备好。

## 报告中的归因修正

- fill 原先就使用 native setter，并对填写和清空都派发 input/change；不能仅凭搜索视图未关闭认定 React 状态事件缺失。需要现场比对清空按钮、Escape 和组件行为。
- 已有 browser_key，支持 Escape、Enter、Tab，无需再创建同义工具。
- ref 保存最多 12 份、约 120 秒快照，并校验连接状态、元素指纹及行上下文；不是每次 read 或任何 DOM 变动后统一失效，也不是一次性。一次性限制属于 coordinateToken。
- 坐标预检已经调用 elementFromPoint 并下探开放 Shadow DOM。返回容器可能确为该点最深命中项，也可能坐标映射不正确；不能在没有新截图与点位证据时承诺“自动下钻到行”。
- outerHTML 是实时 DOM，不是原始网络 HTML；不能把两者混称为同一来源证据。

## 仍需开发与验收

1. 网络响应体布防：按 tab/agent 租约持有调试器、限定请求范围、TTL、总容量与响应体上限，支持 drain/stop。需要处理导航重定向、调试器冲突、worker 回收、未完请求和敏感字段；不能让诊断锁阻塞截图或其他 agent。
2. 页面源码/结构化数据提取：区分 live DOM、SSR JSON 和 HTTP response body，提供有界快照与分块，标记截断和一致性，不能以重新 fetch 冒充原响应。
3. 页面执行：任意 JS 可读取凭据或写页面，不能靠表达式黑名单或“只读”描述实现隔离。需独立能力授权、写租约、结果上限和真实超时语义；超时不代表脚本副作用被撤销。
4. 页面等待：单独实现文档/元素条件与有界等待，networkidle 对长轮询页面不保证完成，不重放导航。
5. 复杂业务后台 现场验证：恢复目标登录标签后，采集一次主 frame 网络摘要；后续验证完整类目响应、搜索清空与委托列表。当前未重新操作目标业务页面，未证明目标站点深层采集已打通。

验收基线继续保留租约、observe、fill/click、截图和 Shadow DOM。单元测试覆盖真实 CDP 返回形状、正常有资源、合法空缓冲、执行异常和 URL 脱敏；不等同目标页面实测。

## 0.5.20 修复回溯（2026-10-25）

### 现场问题与可复核证据
- 用户在目标站点导出记录页读取到“下载报表”文字，但 `browser_find_element` 没有候选；用户现场描述目标为无 `href` 的 `<A onClick>`，且键盘导航未聚焦它。现有 `actionSelector` 只含 `a[href]`，精确文字兜底只扫 `span/div/li` 叶节点，因此确实存在可定位性缺口。
- 此前两次坐标动作返回 `coordinate_target_changed`、`dispatched:false`。实现会 mouseMoved 后在 mousePressed 前复验目标，故不能声称下载已经触发；但拒绝结果没有说明命中变化前后的元素信息。
- 健康检查虽返回 tab 标记 active，但没有同屏窗口焦点、文档可见性和页面焦点，坐标写操作也没有在发指针事件前强制要求这些条件。`tab.active`、`window.focused`、`document.visibilityState`、`document.hasFocus()` 必须分别解释。
- SSR/hydration 双渲染可能解释用户观察到的 A/TD 命中切换，但本项目没有 page source 或任意 evaluate 能力；这仍是用户现场观察支持的假设，不能写成 Bridge 已独立验证的根因。

### 实施改动
- `extension/page.js`：仅在精确文本匹配时补充无 href anchor 候选；无 href anchor 的隐式角色报告为 `generic`，候选显式带 `clickability: unverified` 与 `exact-visible-text; clickability-unverified`，不把找到目标等同于有语义按钮/链接保证。
- `extension/page.js`：坐标准备要求页面 `visibilityState === visible` 且 `document.hasFocus() === true`。失焦/隐藏时不签发 token；验证时失焦会销毁 token，恢复前台后必须重新截图/准备。
- `extension/page.js`：目标校验失败增加 `validationFailures` 与 `targetChange.expected/actual`（标签、ARIA 角色、文案、行文案）；`expected` 来自签发 token 时保存的摘要快照，即使同一 DOM 节点原地换文案也能看出前后差异；保留拒绝派发的 fail-closed 行为。
- `extension/cdp.js`、`extension/worker.js`：Double Tap 的每一次 mousePressed 前都重新校验前台状态和目标。第一次按下后若页面切换目标，第二次按下取消；一次工具调用结束或失败时销毁 coordinate token。
- `extension/worker.js`：`browser_health` 同时返回 Chrome `tab.active`、`window.focused`、document `visibilityState` / `focused` 和 viewport；坐标预检及动作开始前复核当前 tab/window/document 状态，拒绝时不自动抢焦点，并销毁本次坐标 token，避免失焦后复用旧点位。
- `extension/worker.js`、`extension/cdp.js`：指针移动前增加状态复核；Tap/Double Tap/Long Press/Swipe 在 mouseMoved 后、每次 mousePressed 前再次核对前台与目标，避免 hover 引起的目标切换导致按下。扩展暂停/断连时通过命令 epoch 与 socket 身份取消后续 CDP 输入，并在页面写操作/导航起点再次门控；必要的 mouseReleased/keyUp 仍允许清理已按下状态。Double Tap 首次 release 后若暂停或断连，第二次按下会取消，并返回 `status: uncertain`、已派发次数，要求先核验，不可盲重放。拒绝结果指出前后目标或具体状态阻断原因。
- `src/tools.js`：更新 MCP 工具描述，提示前台状态区别、无 href 文本候选的不确定性和坐标动作安全门。
- `test/coordinate-guard.test.js`、`test/error-journal.test.js`：增加隐藏/失焦 token、同节点文案变更诊断、无 href 锚点发现、鼠标移动前拦截及双击中途暂停/断连取消第二次按下回归。
- 版本从 0.5.19 升至 0.5.20；`package.json`、`package-lock.json`、`extension/manifest.json` 一致。完整变更记录在 `CHANGELOG.md`。

### 验证与部署边界
- 定向 Node 测试：coordinate guard、error journal / CDP pointer、version 共 13/13 通过。最后的 worker 命令生命周期门控（含 Back 动作入口检查）合入后，重新运行完整 Node 测试套件，120/120 通过（0 failed）；`git diff --check` 和扩展脚本语法检查通过。
- 这些是本地模拟 DOM 与 Node 回归，不等于已在 Chrome / 目标站点真实登录页验收。部署后先重启本地 Bridge 服务、在 `chrome://extensions` 重新加载 0.5.20 扩展，并刷新 MCP 客户端工具列表；随后 `browser_health` 核对 tab active、window focused、document visible/focused，再对下载按钮执行截图和精确行上下文确认。
- 找到候选不证明 `onclick` 有效，也不证明下载完成；不做鼠标中键/坐标盲重试。下载完成需要独立的受限等待/下载观测，本轮未实现。网络响应体、原始 HTTP page source、任意页面 JS 执行也仍未实现。

### 0.5.20 隔离对抗回归续测（2026-10-25）
- 修正 E2E 中 `pointerPressesAttempted` 作用域错误；用户主动暂停的预期状态明确为 `extension_paused`。隔离真实扩展 E2E 共 35 项通过，覆盖坐标 adapter、模拟 Agent 任务、租约恢复、暂停和断连等流程。
- 新增本地 adversarial fixture：400 层嵌套文本、1000 行精确行目标、虚拟列表、同源 iframe、Open Shadow DOM、透明遮挡层和独立 HTTP 写入审计。测试实际确认目标行 `record-0719` 只产生一条服务端导出记录；遮挡状态下点击拒绝；把另一行从 `Order 0720` 改名后，旧行 ref 被拒绝且审计记录未增加；虚拟行 `940` 需滚动后才能找到。
- 滚动 API 单次 delta 上限为 5000，且滚动会令前次扫描 ref 变 stale；测试据此分段滚动、每次刷新容器 ref，并验证旧 ref 拒绝，未提高工具上限或放宽校验。Shadow DOM 控件移至遍历早期以免测试 fixture 的大 DOM 抢占其 200ms 扫描预算。
- 最终 `browser-stress.js` 10 项通过。并发过载记录 24 个调用中的 8 个 `queue_full`、16 个完成；16 个完成请求均找到目标（报告分列 `completedOverloadReads` 与 `overloadReadsFindingTarget`）。`multi-agent-stress.js` 6 项通过，36 个并发读/查任务约 1.1 秒完成；测试输出版本标签改为动态读取 package 版本，确认实际为 0.5.20。完整 Node 测试 120/120 通过，`git diff --check` 无空白错误（仅 Git 的 LF→CRLF 提示）。
- 边界：全部为临时 Playwright Chromium profile 与本机 localhost fixture；本地 fixture 审计可独立核对 Bridge 之外的业务副作用，但不是第三方站点验收。尚未真实 Chrome/目标站点登录页验证，不能据此声称线上导出问题解决或下载成功。

## 0.5.21 verified click 结果语义（2026-10-25）

- 风险：`browser_click_verified` 原先先点击、后检查条件。期待条件如果点击前已满足，会被误报为本次动作成功；条件等到期仍不满足则返回 `failed`，但 click 已派发，调用方可能把它误当成“肯定没发生”并重复触发。
- 修复：点击前同步检查有限的 text/url/element-label 条件。若已经满足则返回 `not_dispatched`、`dispatched:false`、`retryable:false`。点击一次后观察成功返回 `success`；等待截止或验证被中断则返回 `uncertain`、`dispatched:true`、`retryable:false`，要求重新观察与独立核验，不自动重试。`elementLabelAppears` 也扫描无 `href` 的 anchor，覆盖先前发现/后置条件选择器不一致的问题。
- Fill 观察：`browser_fill_verified` 在条件初始满足时用短 settle window（最多 50ms）再读取实时控件值；等待期间持续读取当前值，不再依赖填充后的静态快照。若前端回滚导致预期值未观察到，返回 `uncertain`、`dispatched:true`、`retryable:false`，提示先重读而非自动重填。
- 参数契约：click/fill/upload verified 的条件对象现要求非空，只允许各自工具支持的字符串字段；值有长度限制。这样可避免空/无效 expectation 在副作用派发后才变成无意义的验证失败。
- 审计：受限记录结果状态（白名单）及布尔 `dispatched`，明确 `uncertain`；不记录 expectation 文本或页面正文。扩展断连/写操作超时会保留 `outcome:error` 与错误分类，同时记录 `resultStatus:uncertain`、`dispatched:null`，表示调用结果丢失且页面事件派发无法确认。
- 验证：本机 Chromium fixture 的 HTTP `/audit` 独立记录表明，点击前条件已满足时没有请求；“请求已成功但预期 UI 文案不出现”时 Bridge 返回 `uncertain` 且服务端副作用正好一次。成功分支仍由精确行文本期待值与服务端记录交叉验证。
- 边界：这改善的是操作结果分类与不重放契约，不证明真实业务成功，也不证明文件已下载/落盘。Chrome/第三方页面验收和真实下载事件观察仍待单独实现与授权评估。
