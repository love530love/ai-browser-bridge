# 采集型任务能力缺口分析（复杂后台页面会话）

日期：2026-10-25。对象：本机 ai-browser-bridge service/extension 0.5.18（`127.0.0.1:19387`，`POST /call`，body 用 `arguments`）。
场景：本地跨站点数据迁移工作流早期阶段——用 Bridge 采集两个站点的层级数据，作为映射基础。具体站点、项目路径和业务数据未公开。
证据均来自本会话真实调用返回与项目侧产物，非推测。分级：**实证**=本次调用直接观察到；**推断**=基于实证的根因分析。

---

## 0. 结论摘要

- **「读」链路顺畅，可用作回归基线**：`browser_health` → `browser_tabs` → `browser_claim_tab`/`browser_release_tab` 租约 → `browser_observe` → `browser_find_element`/`browser_fill`/`browser_click`/`browser_screenshot` 常规场景全部正常，租约防冲突有效（两个站点采集无抢注）。
- **三个能力缺口直接决定采集型任务成败**：
  1. **[P0] 无页面内 JS 执行**（无 evaluate 类工具）——SPA 深层数据、XHR hook、前端 state 读取全部不可达；
  2. **[P0] 网络层无响应体捕获，且经常整体为空**——`browser_network_summary` 两次调用均空，且设计上不返回 body；
  3. **[P1] 无原始 HTML 获取**（`view-source:` 导航被拦）——SSR 内嵌数据（`window._ROUTER_DATA` 类）拿不到。
- **后果分级（本次真实发生）**：站点 A的类目采集**靠公开页面旁路成功**；站点 B深层类目**无法自动采集**，最终只能提供手动执行脚本——自动化降级成人工，是本次主要效率损失。具体业务数据与平台信息已脱敏。
- **关键判断**：`browser_capabilities` 返回的 ordinaryPage 通道已含 `debugger`——上述缺口不是底层能力缺失，而是**没有把已有能力暴露成 MCP 工具**。补齐的边际成本低、收益大。

---

## 1. 能力缺口（按优先级）

### 1.1 [P0] 无页面内 JS 执行能力

- **现象（实证）**：需登录的站点 B发布页只内嵌部分类目，深层类目按需从 API 加载。要拿全量树只有两条路：hook XHR 捕获 API 响应，或读前端状态/程序化展开树——两者都需要在页面上下文执行 JS，Bridge 无此工具。具体平台、地址及数据规模已脱敏。
- **已尝试的替代路全部失败（实证）**：UI 逐点展开——`browser_find_element`/`browser_find_text` 找不到类目树行的可点元素；`browser_prepare_coordinate` 对事件委托列表只返回整个列表容器，点不到具体行。最终只能提供一段手动执行的采集脚本。
- **根因（推断）**：工具面只有 DOM/accessibility/screenshot/coordinate 四类通道的封装，没有 Runtime.evaluate 出口；而 capabilities 矩阵里 `debugger` 通道已存在（当前仅用于截图等内部用途）。
- **影响**：任何「SPA 深层数据 / 需要劫持网络 / 需要读 window 状态」的采集与自动化场景，Bridge 只能看不能动。这类场景在复杂业务后台中常见。
- **改进建议——新增 `browser_evaluate`**：
  1. 参数草案：`{ expression: string, awaitPromise?: bool, timeoutMs?: int(默认10000), maxResultBytes?: int(默认1MB), frameId?: int }`；走 debugger/Runtime.evaluate，支持 await Promise（SPA 异步 state 常见）。
  2. 安全模型与现有策略对齐：capabilities 已声明 `cookiesAndSecrets: blocked`——evaluate 的定位在文档中明确为「操纵 DOM/XHR/前端状态，不提供凭据读取出口」；默认关闭，agent 需显式 arm（一次性授权 token），全量审计日志，超时强杀。
  3. 与既有工具的组合价值：evaluate + observe 的 ref 体系互补——ref 管「稳定点击」，evaluate 管「批量/程序化操作」，两者都留审计。

### 1.2 [P0] 网络层：响应体不可达，且经常整体为空

- **现象（实证）**：两个站点的采集会话都调用了 `browser_network_summary`，两次都返回空。站点 A页面的解释是「页面加载早于扩展跟踪」；站点 B页面在自己发起的导航之后调用仍为空。
- **设计限制（实证）**：`browser_network_summary` 即使非空也不返回响应 body——只能看到「发过请求」，看不到「返回了什么」。
- **根因（推断）**：网络记录依赖扩展跟踪开始后的性能缓冲，对早于注入/绕过跟踪的请求无记录；且工具设计上主动剥离 body（安全考虑）。
- **影响**：违反「API 原始返回才是一手资料」的数据纪律（本地迁移项目的硬约束）。本次站点 A树是靠公开页旁路拿到的 SSR+API 数据；换成需要登录的页面即无路可走。
- **改进建议**：
  1. 新增布防式捕获：`browser_network_arm { urlPattern, captureBody?: bool, maxBodyKB?: int(默认512) }` → 后续正常导航/交互 → `browser_network_drain` 取走匹配请求的 `{url, method, status, requestHeaders?, body}`。debugger 通道的 Network 域不受页面 CORS 限制，XHR/fetch 的 body 拿得到（与页面内 fetch 的成功率差异正是关键收益）。
  2. 兜底清单：至少用 `performance.getEntriesByType('resource')` 补全「本次导航后页面发过的所有请求 URL」（无 body），让调用方回答「这个页面到底调了什么 API」——本次两个页面都是空白告终，连 URL 线索都没有。
  3. 兼容现有语义：`browser_network_summary` 保持不变（轻量巡检用），新工具走显式布防（重操作、有审计），两者文档写明分工。

### 1.3 [P1] 原始 HTML 不可达

- **现象（实证）**：`browser_navigate` 导航到 `view-source:` 协议被 Bridge 拦截拒绝。
- **连带后果（实证）**：站点 A页面含 SSR 数据，可由项目侧从公开页面获取；站点 B发布页需登录，直接请求无法复现相同会话——部分类目只能从 DOM 转录再人工清洗，易丢字段且不可复现校验。具体字段、平台与数据规模已脱敏。
- **根因（推断）**：view-source 协议被安全策略拦掉，但没有提供等价的「取当前文档原始 HTML」出口。
- **影响**：复杂业务后台中的 SSR 内嵌数据较常见（`_ROUTER_DATA`/`_SSR_DATA`/`__NEXT_DATA__`），这是采集型任务最高频的数据入口之一。
- **改进建议——新增 `browser_page_source`**：`{ maxBytes?, chunked? }`，优先 `document.documentElement.outerHTML`（含内联 script 文本，SSR JSON 就在里面）；备选对当前 URL 做 same-origin fetch（带 cookie，利用浏览器已登录态）。分块返回 + 大小上限，审计同 evaluate。

### 1.4 [P1] 交互层三个卡点（有工具，但关键场景断）

**（a）坐标点击命中容器，点不到具体行**
- **实证**：站点 B类目树是事件委托列表，`browser_prepare_coordinate` 对行坐标只返回整个列表容器信息，无法下钻到行元素。
- **建议**：prepare_coordinate 增加 `elementFromPoint` 最深元素返回（标签/文本/可点性判定），并允许「直接点这个最深元素」；或提供 `browser_click_at(x,y)` 用 elementFromPoint 派发。这与 0.5.17「single-use coordinate target preflight」的方向一致，补上「容器委托」这一分支即可。

**（b）fill 与前端框架状态不同步**
- **实证**：搜索框 `browser_fill` 填入「男装」文本显示成功；再用 `browser_fill("")` 清空，文本清掉但页面视图不退出（仍停留在搜索结果态），最终只能整页 `browser_navigate` 重载恢复。
- **根因（推断）**：受控组件（React/Vue）需要 native setter + `input`/`change` 事件序列才同步 state；清空路径的事件序列与填入路径不对称。
- **建议**：fill 统一走 native setter + `input/change`（必要时 `compositionend`）并返回「已派发事件清单」；新增 `browser_press_key { key }`（Enter/Escape/Tab 优先）——Escape 很可能直接退出搜索视图，省掉整页重载。

**（c）导航无等待 + 截图时机**
- **实证**：`browser_navigate` 后立即 `browser_observe`/`browser_network_summary` 拿到旧状态或空，需人工重试；站点 A弹窗点击后 `browser_screenshot` 未见弹窗（`browser_observe` 显示弹窗在），需重读确认。
- **建议**：navigate 增加 `waitUntil`（`domready`/`networkidle`/`timeoutMs`）选项；`browser_screenshot`/`take_snapshot` 支持 `selector` 或显式等待条件（弹窗/portal 层常渲染在 fixed overlay，时序敏感）。可复用既有 `browser_wait_until_ready` 的重试语义。

### 1.5 [P2] ref 一次性语义的摩擦

- **实证**：页面任何变动（fill、点击、导航）都使此前 observe 得到的 ref 全部失效，必须反复 observe；失效时的报错未明确提示「来自哪次 read、当前已第几次 read」。项目侧靠经验在 playbook 里记下「ref 只用一次」。
- **建议**：ref 带 read epoch，失效报错格式化为 `ref#12 来自 read#3，当前 read#7，请重新 observe`；或提供「同一次 observe 结果内 N 秒短时效」的批量点击窗口（tab 级租约已有时效，ref 级可同理），减少多步操作的 observe 往返。

### 1.6 [P2] 元数据与失败引导

- **实证**：`browser_capabilities` 只描述通道矩阵，不描述每个工具的前提条件——本次两次踩 `network_summary` 为空的坑，事前无从得知它「仅覆盖扩展跟踪期内的请求且不含 body」。失败返回（如 view-source 被拦）也没有结构化替代建议。
- **建议**：capabilities/工具描述中补充每工具的前提与边界（跟踪期、body 有无、登录态要求）；失败返回统一带 `next_actions`（如 view-source 被拦时提示改用 `browser_page_source`）。

---

## 2. 顺畅项（回归基线，别改坏）

| 能力 | 本次表现 |
|---|---|
| `browser_health` / `browser_tabs` | 连接状态、标签页枚举准确，目标页定位一次命中 |
| `browser_claim_tab` / `browser_release_tab` | 租约体系有效，两个站点长时间采集无冲突、无残留 |
| `browser_observe` | 结构化读取稳定，弹窗/面板内容完整可见（含 shadow 外常规 DOM） |
| `browser_find_element` / `browser_fill` / `browser_click` | 常规控件场景可靠（按钮、输入框均一次成功） |
| `browser_screenshot` | 兜底留证有效（时序问题见 1.4c，但能力本身可用） |
| `browser_shadow_tree` | 正常返回（目标页无有效 shadow 内容，但通道工作） |

---

## 3. 验收用例（修复后用本地迁移场景验证）

1. **[1.1 evaluate]**：在站点 B发布页 evaluate `location.href + '|' + document.title`，再 evaluate 一段读 `window` 状态键列表的表达式——验证基本执行与 await 支持。
2. **[1.2 网络布防]**：arm `*category*` 后导航发布页并展开一个类目，drain 应拿到类目 API 的完整 JSON body——这正是本次卡死的全量树采集。
3. **[1.3 page_source]**：对发布页取 source，grep 到内嵌类目数据——替代当前的人工 DOM 转录（项目侧清洗脚本可作对照基准）。
4. **[1.4a 坐标下钻]**：prepare_coordinate 类目树行坐标，返回最深行元素而非列表容器。
5. **[1.4b fill/key]**：fill 清空搜索框后视图退出，或 Escape 达成同样效果。
6. **[1.4c 导航等待]**：navigate 带 `waitUntil:networkidle`，返回后首次 observe 即为稳定态。
7. **[1.5 ref epoch]**：导航后复用旧 ref 点击，报错含 read epoch 提示。

---

## 4. 与既有文档的关系

- `docs/ai-browser-bridge-阻塞与不便清单.md`（竞赛与批处理场景）侧重：跨 iframe、重 SPA read_timeout、upload allowlist、服务单点。
- 本文（复杂业务后台采集场景）侧重：页面内执行、网络 body、原始 HTML、事件委托列表交互。
- 两者互补，建议合并跟踪时保留「场景标签」，避免回归时只覆盖一类。

---

## 5. 续：导出报表下载会话的新证据（2026-10-25 晚，同一数据迁移工作流）

场景：某复杂业务后台「导出记录」页，点击表格行内下载入口。本机使用系统级鼠标通道与 Bridge 并行测试；具体平台地址、工具品牌和设备尺寸已脱敏。

### 5.1 [P0] 窗口遮挡 → `visibilityState:hidden` 的静默失败模式（归因修正）

- **实证**：Chrome 窗口被其他窗口压住后（`get_active_window` 报 `isForeground:false`），`browser_observe` 的 `debug.visibilityState` 为 `hidden`；此时 OS 级鼠标悬停任何元素**无任何视觉效果**（截图 diff 只有页面自身动画），`browser_action` 坐标 Tap 持续 `coordinate_target_changed`。此前会话把该错误单方面归因为「SSR/hydrated 双渲染」，**归因不完整**——窗口遮挡是首要根因。
- **实证（恢复）**：系统级窗口控制将 Chrome 提回前台后，`visibilityState` 恢复 visible，OS 悬停立即生效，且 `browser_prepare_coordinate` 能稳定返回目标元素。具体工具名已脱敏。
- **建议**：① `browser_prepare_coordinate`/`browser_action` 的失败返回中带 `document.visibilityState` 与窗口前台状态，把「页面不可见」从「目标变化」里分流出来；② 文档写明坐标类工具的前提是「标签页可见」，否则命中测试与事件派发都不可靠。

### 5.2 [P1] 视口高度抖动会打破 prepare→tap 的坐标一致性

- **实证**：同一标签页短时间内视口高度反复变化，归一化坐标映射因此跨过链接边界；prepare 记录的 target 与 tap 时重新命中的 target 不一致 ⇒ 即使没有双渲染，也会 `coordinate_target_changed`。具体尺寸、坐标和页面结构已脱敏。
- **建议**：tap 派发时沿用 prepare 时刻记录的视口尺寸做坐标映射（或 prepare/tap 原子化），避免 UI 抖动造成的映射漂移。

### 5.3 [P1] SSR/hydrated 双渲染下「无 href 动作链接」结构性不可达

- **实证**：站点 A后台（微前端容器）表格行内的「下载报表」是**无 href 的 `<A onClick>`**：`browser_find_element`（含 `includeCovered:true`）与 `browser_find_text` 均只能拿到文本节点、拿不到可点击元素（无 accessible name）；而 `browser_prepare_coordinate` 的命中测试却能返回 `{tag:"A", label:"下载报表"}`——说明元素在 DOM 里、可命中，只是**元素扫描通道的候选规则把它过滤了**。同一坐标连续两次 prepare 返回的 topmost 在 `A` 与 `TD` 间翻转（双副本堆叠），tap 守卫永久拒绝派发。
- **实证（绕行成功）**：系统级点击在该链接上**成功触发下载**——前提是页面可见且坐标精确。坐标校准通过可见控件几何与截图像素分析交叉验证，求出屏幕与视口偏移；具体控件、位置和窗口尺寸已脱敏。
- **建议**：① `find_element` 的候选规则补充「hit-test 可见但无 accessible name 的 A/span+onClick」分支（prepare 已能命中，说明信息可得）；② prepare 命中的元素可颁发**一次性 click token**（绑定 elementFromPoint 结果直接派发，不重新命中），从机制上绕过双副本翻转。

### 5.4 [P2] 截图捕获语义未文档化

- **实证**：`browser_screenshot` 返回整页捕获且带缩放；文档未说明 captureBeyondViewport 与缩放比例，调用方容易把截图像素直接当视口坐标用。具体设备尺寸已脱敏。
- **建议**：screenshot 工具描述/返回中标注 `captureBeyondViewport`、缩放比例与视口尺寸。

### 5.5 环境事实（非 Bridge 缺陷，记录备查）

- 本机 Chrome 下载目录与常见默认目录不同；本次曾因检查错误目录而把已成功的下载误判为失败。具体路径已脱敏。下载类任务应先确认实际落盘目录。
- 结论：「读」与「OS 级点击」通道在页面可见时可靠；Bridge 坐标通道在双渲染页面仍有结构性限制（5.3），两类通道互补使用。

---

*附：项目侧存在类目基准数据与人工采集脚本；本地路径、文件名、数据规模和项目测试结果未公开。*
