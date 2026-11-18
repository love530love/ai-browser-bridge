# UPGRADE PLAN — 平台开票现场反馈的修复方案（2026-11-18）

- 来源：`docs/FIELD-REPORT-20261118-platform-invoice.md`
- 源码基线：`b9a30ae`（0.48.0），工作区仅新增文档与 skill，无源码改动
- 适用环境：Windows 11 / Chrome 156 / service+extension 0.48.0 / 本机 MCP 进程工具面陈旧（见 P0-0）
- 原则：每一项都必须能在真实浏览器上验收；不得用"文档说明"替代代码修复，除非明确标注为文档项

## 0. 优先级总表

| 编号 | 问题 | 类型 | 代码面 | 里程碑 |
|---|---|---|---|---|
| P0-0 | MCP 进程工具面与仓库/扩展版本错配，0.47 的期望能力对客户端不可见 | 部署/协议 | `src/mcp.js`、`src/server.js`、`src/version.js` | M1 |
| P0-1 | `browser_upload_verified` 在电商后台报 `stale_ref generation=unknown`，三类定位均失败 | 功能缺陷/待复测 | `extension/page.js:2967-3058`、`src/tools.js:476` | M1 |
| P0-2 | `browser_navigate_verified` 子串期望误判，同源子路由无法导航 | 功能缺陷 | `src/tools.js:507` | M1 |
| P1-1 | `prepare_coordinate` 拒绝无原因、无 ref 替代 | 可用性 | `extension/page.js:1903` | M2 |
| P1-2 | `stableForMs`/`anyOf` 已实现但默认用法仍被瞬时 toast 满足 | 文档+验收 | `src/tools.js:20-47`、skill | M2 |
| P1-3 | 残留 TDesign 对话框容器遮挡点击，关闭启发式全部无效 | 功能缺陷 | `extension/page.js:451-484`、`3045-3053`、`2383` | M2 |
| P1-4 | 无"激活指定标签"原语，原生文件对话框无法由目标标签触发 | 能力缺口 | `src/tools.js:98-106`、`extension/worker.js` tabs 处理 | M2 |
| P2-1 | `USER_CANCELED` 未提示外部下载器接管 | 可用性 | `extension/browser-authority.js:86-103`、`305-318` | M3 |
| P2-2 | hidden 文档的读/观察回执没有"需前台可见"提示 | 可用性 | `extension/page.js:63-69`、读取路径 | M3 |
| P2-3 | 缺少受授权的原生文件对话框驱动 | 能力缺口 | 新工具 + `src/confirmations.js` | M3 |
| P2-4 | 本机安装的插件清单停留在 0.46.0，新 skill 未同步 | 打包 | `.qoder` 安装记录、`bin/launch-bridge.mjs` | M3 |

---

## P0-0 MCP 工具面版本错配

**源码坐标**

- `src/mcp.js:4` `import { TOOLS, validateCall } from './tools.js';`
- `src/mcp.js:13` `new Server({ name: 'ai-browser-bridge', version: VERSION }, …)`
- `src/mcp.js:14` `ListTools` 处理器直接返回进程启动时导入的 `TOOLS` 常量
- `src/version.js` 从 `package.json` 读取 `VERSION`
- `src/server.js:540-558` `browser_health` 已返回 `version/buildId/extensionVersion/browserVersion`

**当前行为（实测）**

- `~/.qoder/settings.json` 的 MCP 命令指向 `K:/PythonProjects5/AI-Browser-Bridge/src/mcp.js`，磁盘代码为 0.48.0；
- 但当前会话的 MCP 工具 schema **没有** `anyOf` / `anyChange` / `stableForMs`（`mcp_get` 实测，`browser_click_verified` 的 expect 仅三选一），由 schema 反推服务方的 MCP 进程在 0.47.0 提交（`8f37594`，09:13）之前启动（也可能是客户端缓存了旧工具列表），`TOOLS` 固化在内存；
- 本机同时存在 10 个 `src/mcp.js` 进程（08:02、08:09、08:21、08:39、08:50、09:19、11:23、13:27、15:30、17:33），旧进程不会因文件更新而重载；命中旧进程为 schema 反推，未逐一对号；
- 直接后果：扩展端 0.47/0.48 已实现的能力（多分支/稳定窗口/变更基线）**调用方看不到、用不了**；本次"toast 可满足成功"的现场行为因此发生。

**期望行为**

1. MCP 服务在 `browser_health` 中暴露：
   - `mcpProcessStartedAt`、`mcpVersion`（与 `Server` 握手一致）、`toolCount`、`toolSurfaceHash`（对 `TOOLS` 名称+schema 的稳定哈希）；
   - `repoVersionOnDisk` 与 `toolsFileMtime`；
   - `staleToolSurface:true` 当 `repoVersionOnDisk > mcpVersion` 或 `toolsFileMtime > mcpProcessStartedAt`，并给出 `nextStep: "restart the MCP client process"`。
2. `ListTools` 处理器在检测到磁盘 `src/tools.js` 的 mtime/hash 变化时，至少返回一条告警（MCP 协议允许 `notifications/tools/list_changed`；若不实现通知，应在每次 `ListTools` 结果中附加 `_meta.staleToolSurface`）。Chrome 端已有 `browser_health` 的版本镜像机制，可复用同一思路。
3. 文档（AGENTS.md / README）写明升级流程：改 `package.json` 或 `src/tools.js` 后必须重启 MCP 进程（而不是只重启 service/extension），并说明 `browser_health` 如何判定错配。

**验收**

- 修改 `src/tools.js` 后不重启：调用 `browser_health` 得到 `staleToolSurface:true` 与可执行 nextStep；
- 重启 MCP 进程：`toolSurfaceHash` 变化、`staleToolSurface:false`，`browser_click_verified` schema 出现 `anyOf/anyChange/stableForMs`；
- 连续启动两个不同版本的 MCP 进程时，`browser_health` 能区分主/次连接并分别报告，不把旧 schema 的健康结果当作全局健康。

---

## P0-1 `browser_upload_verified` 的 stale_ref

**源码坐标**

- `extension/page.js:41-62` `applyUpload`：ref/selector/inputIndex 共用同一 DataTransfer 实现
- `extension/page.js:2967-2989` ref-less 分支：`selector` 必须唯一匹配 `input[type=file]`；`inputIndex` 按 DOM 顺序取
- `extension/page.js:3000-3007` ref 分支：`stateForRef` → 校验 `state.url/element.isConnected/fingerprint`，失败抛 `stale_ref generation=${ref.split(':')[0]}`；非 ref 传入时 generation 为 `unknown`
- `extension/page.js:3055-3060` `browser_upload` 与 `browser_upload_verified` 的入口
- `src/tools.js:476-…` upload 工具定义；`src/tools.js:58-64` uploadExpectation

**当前行为（现场）**

- 拼多多"发票信息确认"对话框行内文件 input、淘宝 `applyDetail` 上传，`ref` 调用稳定失败：
  `Stale element reference. Read page again. [stale_ref generation=unknown]`
- 现场记录显示 `selector:"input[type=file]"` 与 `inputIndex:0` 也返回同一错误；但当前 HEAD 的 ref-less 分支（2967-2989）在源码上不经过 `stateForRef`，两者矛盾。
- 因此不能直接断言"缺陷在 ref 校验"；需要先排除**客户端工具面陈旧 + 标签内 content script 陈旧**两个变量（P0-0），再复测。

**首先做（诊断，不改功能）**

1. ref-less 分支的 `applyUpload` 失败时，回执携带 `targetSource`、`refSupplied:boolean`、`selectorMatches`、`inputCount`；
2. 错误文本保留 `stale_ref` 前缀的同时，附 `refWasSupplied` 与 `snapshotUrl`，避免把"未传 ref"误诊为"ref 失效"；
3. 在 `browser_upload_verified` 的回执中返回 `page.js` 构建 id（若已有版本注入则复用），用于核对扩展内容脚本版本。

**然后按复测结果修复**

- 若 ref 路径失败、selector/index 成功：问题在 ref 指纹/快照；需要把上传元素注册进快照，或在 upload 前强制一次 `stateForRef` 刷新并返回新 generation。
- 若三者都失败：问题在扩展/客户端协议（旧 MCP 进程构造的上传参数可能缺 `data/size/uploadMaxBytes`）；修复点在 `src/mcp.js` 的工具转发与 `extension/page.js` 的参数校验，应在错误中暴露缺失字段名，而不是抛 stale。

**期望行为**

- 三种定位在 PDD、淘宝、抖音上传页均能返回 `success`，回执包含 `selected.targetSource`、`selected.fileName`、`verification`；
- `sha256` 在扩展端能被核对（当前仅服务端读文件时算哈希，扩展端只回显），至少回执明确 `sha256VerifiedOn:server|extension`；
- 失败时给出可执行原因与下一次调用建议，不用一句 `stale_ref` 覆盖三种不同根因。

**验收用例**

1. PDD 对话框内 `input[type=file]`（ref）→ success，页面表格出现文件名；
2. 淘宝 `applyDetail` 的 `display:none` input（selector/index）→ success；
3. React 重渲染后立即上传（两次读取之间不刷新 ref）→ 明确 `stale_ref generation=<snap>`，而不是 `unknown`；
4. 未传 `ref` 且 selector 命中两个 input → `Upload selector matched 2 file inputs; expected exactly one`，且无派发。

---

## P0-2 `navigate_verified` 的子串误判

**源码坐标**

- `src/tools.js:507` `browser_navigate_verified`，参数为单个 `expectUrlContains`
- `src/tools.js:29-36` 已有 `anyChange`/`stableForMs` 修饰符，但仅用于 `expectationObject`
- `extension/page.js` 的导航校验逻辑（由 worker 调用；`page.js:1791` 之前的导航处理在同文件）

**当前行为**

- `expectUrlContains:"tab=submit"` 在 URL 已含 `tab=submitRecord` 时被判为"已满足"，返回 `not_dispatched`，导航未派发；
- `expectUrlContains:"invoice/applyList"` 命中 `.../applyList/applyDetail`，同样 `not_dispatched`；
- 三个电商后台都是子路由 SPA，这个行为等于导航能力不可用，调用方被迫用 `browser_eval` 改 `location.href`（脱离 verified 账本）。

**期望行为**

1. 期望判定按"规范化 URL"比较：`new URL(...)` 的 `origin + pathname` 精确匹配，query 按 key/value 集合比较；子串只作为显式的 `expectUrlIncludes` 保留；
2. 新增 `expectUrlChanged:true`（与 `anyChange` 同义）或允许 `expect:{anyChange:true}`；
3. 语义修正：如果目标 URL 与当前 URL 不同，即使某个子串已满足，也必须派发导航；`not_dispatched` 只用于"目标 URL 与当前 URL 规范化后完全相等"；
4. 文档明确 `expectUrlContains` 是子串比较、可能误判。

**验收**

- 当前 `/a/list/detail`，目标 `/a/list` + `expectUrlContains:"/a/list"` → 必须派发并成功；
- 当前 `/tab=submitRecord`，目标 `/tab=submit` → 必须派发；
- 目标等于当前 URL → `outcome:"already_there"`（成功语义，非失败）；
- 跨域重定向到登录页 → `success:false` 且回执含最终 URL 与 reason，不误报成功。

---

## P1-1 `prepare_coordinate` 拒绝不可解释

**源码坐标**

- `extension/page.js:1791` 坐标分支入口
- `extension/page.js:1903`：
  `if (!el || sensitive(el) || !visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Coordinate target unavailable or protected');`
- `src/next-step.js:217-221` 坐标 token 的 nextStep

**当前行为**

- PDD 账单复选框、淘宝复选框返回 `Coordinate target unavailable or protected`，没有任何原因码；
- 这些控件是 role-less `<label>` + 内部 input，`browser_locate` 能给出候选但 `click_verified` 对"已成立"的期望返回 `already_satisfied`，只能退回 eval。

**期望行为**

- 错误对象携带 `reason`（`not_found|sensitive|not_visible|disabled`）与 `nearestActionableRef`（若命中祖先/子控件）；
- `sensitive` 与 `disabled` 绝不能返回可点击替代，只返回原因；
- 当 `sensitive(el)` 为 false 但点内是 label 时，返回 label 关联的 input ref；
- `nextStep` 指明"用 ref 点击"或"该控件不可坐标操作，改用 browser_click_verified/browser_eval"，而不是让调用方猜。

**验收**

- PDD `label.CBX_outerWrapper_5-191-0` 的坐标点 → 回执含 `reason`，且不派发；
- 同一控件的 ref 点击 → success，随后读取 `checked` 变化；
- 密码框坐标点 → `reason:"sensitive"`，无替代 ref。

---

## P1-2 `stableForMs`/`anyOf` 的生产用法

**源码坐标**

- `src/tools.js:20-47` `expectationBranch` / `expectationModifiers`（0.47.0，`8f37594`）
- `src/tools.js:48-64` click/fill/upload 使用 `expectationObject`
- `extension/page.js:2993-2999` `browser_expect` / `browser_expect_verify` 与 `verify(...changeBaseline)`

**当前行为**

- 代码层已具备：`anyOf`、`anyChange`、`stableForMs`（单分支与 anyOf 分支均可带）；
- 当前会话（旧 MCP 进程）schema 未暴露这些字段，现场"提交成功"toast 仍被当作唯一证据；
- 即使 schema 更新，若调用方不写 `stableForMs`，问题会重演。

**期望行为**

1. 所有 `_verified` 工具的文档字符串都给出"财务/提交类操作必须使用 `stableForMs` 或 `anyChange`"的硬规则；
2. skill 模板默认写入：
   ```json
   { "expect": { "anyOf": [{ "textAppears": "提交成功" }, { "urlContains": "merchant-batch-detail" }], "stableForMs": 1500 } }
   ```
3. `outcome:"navigated"` 时，若期望未被评估，回执明确 `expectationEvaluated:false` 并要求另读新页；
4. `stability.heldMs` 是"最后一次观察到条件成立"的窗口，`stableForMs` 应拒绝"出现后立即消失"的 toast。

**验收**

- 抖音"提交"toast：`stableForMs:1500` 时，toast 只显示 <1500ms → `failed`/`uncertain`，不得 `condition_met`；
- 提交后跳转 `merchant-batch-detail`：`anyOf` 第二分支成功，`outcome:"navigated"` 且回执标明未评估；
- 点击一个不会消失的提示 → `condition_met` 且 `heldMs>=stableForMs`。

---

## P1-3 残留 TDesign 对话框容器

**源码坐标**

- `extension/page.js:450-484` `describeCover`：
  - `dismissible: true` 写死（477 行）
  - `dismissPath` 依据 `portalLike` → `'escape'`（464-466 行）
  - `heuristic` 明确"不能证明是 overlay"（482 行）
- `extension/page.js:3045-3053` `browser_dismiss_overlay`：只点击覆盖元素中心，并等待 `expectGoneRef` 消失
- `extension/page.js:2383` `browser_scan_overlays`

**当前行为**

- 后台标签残留 `div.t-dialog__ctx`（`display:block`，2388×1174）覆盖全屏；
- `click_verified` 返回 `element_covered`，`suggestedAction` 让 Esc；Esc、返回、关闭、`getAnimations().finish()` 全部无效；
- 只能 eval 改 `style.display='none'` 才能继续；
- `coveredBy.dismissible:true` 与实际不可关闭矛盾。

**期望行为**

1. `describeCover` 不再写死 `dismissible:true`；判定条件：
   - 可见的 close 控件（`button, [role=button], a[href]` 且可见、未被遮挡）→ `dismissible:true, dismissPath:"click_close"`；
   - 无 close 控件且 `portalLike` → `dismissible:false, dismissPath:"none"`，并说明"可能是后台标签冻结的离场动画"；
2. `scan_overlays` 增加：
   - `visibleCloseControls`（refs）；
   - `animationFrozen:true`（`getAnimations()` 连续两次采样 `playState/currentTime` 不变）；
   - `inertMountedContainer:true`（全屏、无可见关闭控件、覆盖目标）；
3. 提供受控的隐藏动作（仅当 `inertMountedContainer` 为 true）：
   - 新工具或 `browser_dismiss_overlay {strategy:"hide_container"}`，要求 `confirmation:"hide_overlay_once"`；
   - 回执说明"仅改 display，不删除 DOM，可刷新恢复"；
4. `element_covered` 的 `suggestedAction` 不再无条件建议 Esc；按上述判定给出 `scan_overlays` / `hide_container` / "切前台标签重试"三条分支。

**验收**

- 后台标签打开 TDesign 交付弹窗 → `scan_overlays` 返回 `inertMountedContainer:true, dismissible:false, animationFrozen:true`；
- `hide_container` 后底层"查询"按钮可点击，且刷新页面恢复原状；
- 一个真正可关闭的 antd modal → `dismissible:true`，点击 close 生效；
- 前台标签的同一弹窗 → Esc 正常关闭，`dismissPath:"escape"` 成立。

---

## P1-4 标签激活原语

**源码坐标**

- `src/tools.js:98-106` `browser_tabs`：只有列/筛选（origin/urlContains/titleContains/fields/limit），无 action
- `src/tools.js` 中 `browser_windows_control`：窗口级 `focused:true`，不切换标签
- `extension/worker.js` 的 tabs 处理（`chrome.tabs.update/activate` 未暴露）

**当前行为**

- OS 原生文件对话框只能由前台标签的用户激活触发；本任务只能把"当前显示的标签"导航到目标 URL（标签复用），并用 `winGetTitle("[ACTIVE]")` 判定前台；
- 无法在不移动用户当前标签的情况下，让指定后台标签弹出文件对话框；
- 这直接导致 P0-1 的 OS 兜底路径依赖"标签复用"这一非正式技巧。

**期望行为**

- 新增 `browser_tabs {action:"activate", tabId}`：
  - 必须带 `confirmation:"activate_tab_once"`；
  - 回执说明"将把该标签置前，可能打断用户当前操作"；
  - 激活后以 `chrome.tabs.update(tabId,{active:true})` + `chrome.windows.update(windowId,{focused:true})` 双确认；
- 或者提供 `browser_file_dialog`（见 P2-3），避免调用方需要前台标签；
- 文档明确：后台标签的 DOM/CDP 写入仍可用，但原生对话框、离场动画、部分 SPA 首屏渲染需要前台。

**验收**

- 在用户当前标签为 A、目标标签为 B 时，`activate B` 后 `winGetTitle("[ACTIVE]") == B.title`，A 的 URL 不变；
- 未带确认串 → `denied`，无窗口变化；
- 恢复用户标签（activate A）在一次调用内完成，回执记录两个 tabId。

---

## P2-1 下载 `USER_CANCELED` 与外部下载器

**源码坐标**

- `extension/browser-authority.js:86-103` `downloadRow`：原样透传 `error`
- `extension/browser-authority.js:305-318` `downloadsRead`
- `extension/browser-authority.js:320-345` `downloadsWait`

**当前行为**

- IDM 接管后，Chrome 下载项为 `state:"interrupted", error:"USER_CANCELED", bytesReceived:0, canResume:false`；
- 回执没有任何"可能是外部下载管理器"的提示，调用方只能靠"文件没出现 + 外部窗口标题"推断。

**期望行为**

- 当 `error==="USER_CANCELED"` 且 `bytesReceived===0` 且 `canResume===false` 时，`downloadsRead/downloadsWait` 回执增加：
  `hint:"Chrome reported USER_CANCELED with no bytes received. An external download manager (IDM/Thunder) may have taken over; check for its window before retrying."`
- 不自动重试、不修改下载项；
- 可选：服务端在 Windows 上检测已知下载器进程（`IDMan.exe`），仅在回执中提示，不据此做任何动作。

**验收**

- IDM 拦截 PDF 下载 → 回执含 hint；
- 用户手动在 Chrome 下载页取消 → 同一 hint（语义不误导：说明两种可能）；
- 正常完整下载 → 无 hint。

---

## P2-2 hidden 文档的读/观察提示

**源码坐标**

- `extension/page.js:63-69` `throttledInfo`：写操作（click/upload）已返回 `throttled` 与 `visibilityState`
- 读取路径（`browser_read`/`browser_observe`/`browser_debug`）目前只在 `browser_debug` 中返回 `document.visibilityState`，普通读回执不带"该页可能未完成渲染"的提示

**当前行为**

- 抖音"我给平台开票"在后台标签保持"加载中…"数分钟；同一 URL 在前台标签 3 秒内渲染完成；
- 调用方读到"加载中"时无法区分"服务端慢"与"标签不可见导致渲染被节流"。

**期望行为**

- `browser_read`/`browser_observe` 在 `visibilityState:"hidden"` 且连续两次读取的可见文本/DOM 节点数无变化时，回执增加：
  - `visibilityState:"hidden"`；
  - `renderStalledSuspected:true`；
  - `nextStep:"activate the tab (P1-4) or ask the user to bring it to the foreground; DOM/CDP writes still work in the background."`
- 不自动切前台、不自动刷新。

**验收**

- 抖音后台标签 → 读回执含 `renderStalledSuspected:true`；
- 前台标签 → 无该提示；
- 明确处于 `loading` 但文本持续变化的页面 → 不误报（以两次快照无变化为条件）。

---

## P2-3 原生文件对话框驱动（可选替代 P1-4）

**源码坐标**

- 现有原生能力：`src/native-ui-action.js`、`src/protected-ui.js`、`browser_password_manager_reveal` 的 UIA 路线
- 新工具建议：`browser_file_dialog`（或 `browser_upload_native`）

**场景**：`browser_upload_verified` 不可用、或站点要求真实文件选择（JS `input.click()` 无用户激活不弹框）。

**期望行为**

- 输入：`tabId`、`filePath`（必须位于 `uploadRoots` 允许目录）、`expect`（文件名出现）；
- 动作：仅对已确认在前的标签，用 UIA 找到原生"打开"对话框（`#32770`），向 `Edit` 填入路径，点击"打开(&O)"；
- 安全：`confirmation:"native_file_dialog_once"`；拒绝非 allowlist 路径；拒绝与当前前台窗口不匹配的对话框；绝不自动点击"保存"以外的系统级按钮；
- 回执：`{status, dispatched, dialogTitle, fileName, foregroundVerified}`，并注明"文件是否被页面接受仍需读取页面"。

**验收**

- PDD/淘宝上传按钮触发原生对话框 → 填路径 → 页面出现文件名；
- 路径越界 → `denied`，无对话框操作；
- 对话框被其他程序抢焦点 → `uncertain` + 要求用户确认，不盲点。

---

## P2-4 插件清单与 skill 同步

**证据**

- `~/.qoder/plugins/installed_plugins_v2.json`：`ai-browser-bridge@local` 安装路径 `.../0.46.0`，版本 0.46.0；
- 仓库 HEAD 0.48.0，新增 `skills/platform-invoice-upload/`；
- MCP 命令却指向仓库源码（`src/mcp.js`），导致"插件技能 0.46 + 代码 0.48 + 进程 0.46"三层版本不一致。

**期望行为**

- 发布脚本（`bin/launch-bridge.mjs` 或 npm script）在版本 bump 后：
  1. 同步 `skills/` 到安装目录；
  2. 更新 `installed_plugins_v2.json` 的 version/installPath；
  3. 提示重启 MCP 进程；
- README 明确"本地源码接入"与"插件安装"两条路径的版本一致性检查方法（`browser_health` 的 `mcpVersion`/`extensionVersion`/`serviceVersion` 三者对齐）。

**验收**

- `package.json` bump 后运行发布脚本 → 插件清单版本一致、skill 可见；
- 未重启 MCP → `browser_health.staleToolSurface:true`。

---

## 建议落地顺序

1. **M1（当天）**：P0-0 版本握手 + P0-2 导航期望；重启 MCP 后复测 P0-1，按复测结果决定是否改扩展。
2. **M2（本周）**：P1-1/P1-3/P1-4；同步更新 `skills/platform-invoice-upload/SKILL.md` 的"已知限制"与默认 `stableForMs` 用法。
3. **M3（下周）**：P2-1 下载提示、P2-2 读回执提示、P2-3 原生对话框（若 P0-1 仍未解）、P2-4 打包脚本。
4. **回归**：把本报告 §3 的现场 JSON 片段转成 `test/` 夹具（尤其是 `element_covered`、`USER_CANCELED`、`stale_ref generation=unknown`），确保错误分类与 nextStep 不退化。
