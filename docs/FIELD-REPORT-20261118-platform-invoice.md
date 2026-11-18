# FIELD REPORT — AI-Browser-Bridge × 电商平台开票全链路（税局开票 → 平台回传）

- 日期：2026-11-18
- 场景：在与用户已登录的 Chrome 中，完成云南电子税务局数电票开具（含红冲重开）→ 拼多多 / 淘宝 / 抖音商家后台回传发票 → 提交记录核验与截图/PDF 归档
- 结果：**4 笔票据全部提交成功**（拼多多 24.00 审核通过、淘宝 4.54 已完成、抖音有竹居 125.18 / 字跳 1.03 审核中）；文件上传环节 100% 绕开 Bridge，改用系统级点击 + 原生"打开"对话框
- 环境：
  - OS：Windows 11（10.0.29708）
  - Chrome：156.0.8078.49（用户默认配置，全站已登录）
  - Bridge：service/extension **0.48.0**（仓库 HEAD `b9a30ae`）
  - Bridge 工具面：当前会话的 MCP 进程早于 0.47.0 提交（`8f37594`，09:13）启动；`mcp_get` 实测 `browser_click_verified` 的 expect 只有三选一，无 `anyOf/anyChange/stableForMs`；`ps` 同时存在 10 个 `src/mcp.js` 实例（最早 08:02）。插件安装清单仍为 `ai-browser-bridge@0.46.0`
  - 升级方案：`docs/UPGRADE-PLAN-20261118-platform-invoice-site-feedback.md`
  - 站点类型：拼多多 cashier（React）、淘宝千牛（React）、抖音抖店（React + aurora 组件）、云南电子税务局（TDesign）
  - 外部干扰：IDM 接管 Chrome 下载（`USER_CANCELED` + 原生"下载文件信息"对话框）
- 关联文档：`skills/platform-invoice-upload/SKILL.md`（本次新增的站点 skill）、`docs/FIELD-REPORT-20261118-competition-registration.md`、`docs/UPGRADE-PLAN-20261111-cnipa-site-feedback.md`

---

## 1. 结论（TL;DR）

0. **P0：MCP 工具面与仓库/扩展版本错配。** 磁盘代码已是 0.48.0，但由 schema 反推，本会话连接的 MCP 进程在 0.47.0 提交前启动（或客户端缓存了旧工具列表），`TOOLS` 常量固化在内存，导致 0.47 的多分支期望/稳定窗口能力对客户端不可见；本次所有调用实际跑在旧工具面上。`browser_health` 目前只报告 service/extension 版本，不报告 MCP 进程版本与工具指纹，无法自证错配。详见 §3 P0-0。
1. **P0：`browser_upload_verified` 在拼多多 / 淘宝两个后台现场 100% 返回 `Stale element reference [stale_ref generation=unknown]`，`ref`、`selector`、`inputIndex` 三种定位全部失败。** 同一页面的 `click_verified` 可用，说明连接与快照面正常；但 0.48 源码的 ref-less 分支本不经过 ref 校验，因此"与页面重渲染无关"尚不能断言，需先排除进程/内容脚本陈旧（§3 P0-1）。直接后果：所有财务票据上传只能走 OS 级"鼠标点击按钮 → 原生打开对话框 → AutoIt 填路径"，Bridge 的上传校验（含 `sha256` / `expect`）在这类站点等于不可用。
2. **P0：`browser_navigate_verified` 的 `expectUrlContains` 是子串比较，目标 URL 与当前 URL 同源同前缀时被误判"已加载"→ `not_dispatched`。** 实测 `tab=submit` 命中 `tab=submitRecord`、`invoice/applyList` 命中 `invoice/applyList/applyDetail`。三后台均为 SPA 子路由，本问题在电商后台是常态，不是边缘情况。
3. **P1：`browser_prepare_coordinate` 对拼多多 / 淘宝返回 `Coordinate target unavailable or protected`，且不提供可点击 ref 的替代。** 复选框、页签等 role-less 控件只能用 `browser_eval` 原生 `.click()`，脱离 verified 账本（与 2026-11-18 赛事报告的 P1-3 同源）。
4. **P1：`click_verified` 的成功证据可被瞬时 toast 满足（代码已在 0.47 修复，但未生效）。** 抖音"提交"返回 `condition_met`，唯一证据是 `div.aurora-message` 的 `提交成功`（`transient:true`、`stability.heldMs=0`）；真正落库要另读批次详情页。仓库 `src/tools.js:20-47` 已提供 `anyOf/anyChange/stableForMs`，但当前 MCP 进程暴露的仍是旧 schema，调用方看不到这些字段；即便更新，skill/文档也必须默认使用 `stableForMs`，否则同一问题会重演。
5. **P1：后台标签残留的 TDesign 对话框容器（`div.t-dialog__ctx`，`display:block`、铺满视口）会挡住点击命中测试，且无法关闭。** `click_verified` 返回 `element_covered`，`suggestedAction` 让按 Esc；Esc 派发成功但对话框不消失（后台标签 `rAF`/定时器被节流，离场动画不结束），"返回""关闭"按钮同步无响应。最终只能 `style.display='none'` 隐藏。`coveredBy.dismissPath` 的推断在此时是误导性的。
6. **P1：Bridge 没有"把指定标签页置前"的能力（设计如此），但本任务的原生文件对话框必须由可视标签触发。** 现行唯一可行路径是"把正在显示的标签导航到目标 URL"（标签复用）；`browser_windows_control {focused:true}` 只前置窗口，不切换标签。需要一条显式、需用户授权的"激活标签以配合 OS 对话框"的通道。
7. **P2：`browser_downloads` 把 IDM 接管的下载报告为 `USER_CANCELED`。** 这既不是用户取消也不是 Bridge 失败，调用方只能靠"文件没出现 + 外部窗口标题"推断。建议区分 `external_download_manager_suspected` 或在回执中提示检查 IDM 类进程。
8. **P2：抖音页面在后台标签长时间停留在"加载中…"，切到前台标签后正常。** 与既有文档"后台标签不绘制、定时器节流"一致，但对 SPA 首屏渲染的影响高于预期；建议在 `browser_wait`/读取回执中给出"文档处于 hidden 且 DOM 长时间无变化"的显式提示。

---

## 2. 任务链路与结果

| 阶段 | 站点 | 结果 | 关键证据 |
|---|---|---|---|
| 电税红冲旧票 | dppt.yunnan.chinatax.gov.cn | 成功 | 红字票 26532000001905999406，-24.00，开票时间 2026-11-18 11:41:43 |
| 电税重开蓝票 | 同上 | 成功 | 26532000002013452941，24.00，备注 47 字商标模板 |
| 拼多多上传 | cashier.pinduoduo.com | 成功（OS 路径） | 提交 16:53；17:20 复查"审核通过" |
| 淘宝上传 | myseller.taobao.com | 成功（OS 路径） | 历史处理记录 16:55:56"已完成 4.54" |
| 抖音有竹居上传 | fxg.jinritemai.com | 成功（OS 路径） | 批次 2611186069975502461，17:05:25，审核中 |
| 抖音字跳上传 | 同上 | 成功（OS 路径） | 批次 2611186052753003910，17:08:25，审核中 |
| 红字票下载 | dppt（全量发票查询 → 交付） | 成功（IDM 确认） | PDF 184,357 B / OFD 97,846 B；下载 ID 2305 一开始为 `USER_CANCELED` |
| 证据归档 | 本地 | 成功 | 10 份票据 + 4 张截图 + 归档说明（含 sha256） |

> 本报告不含账号密码、短信码、cookie；商户号、税号均为发票法定公开要素。

---

## 3. 阻滞明细与证据

### P0-0 MCP 工具面版本错配（本次新增结论）

**现象**

- `~/.qoder/settings.json` 的 MCP 命令为 `D:\Scoop\apps\nodejs-lts\current\node.exe K:/PythonProjects5/AI-Browser-Bridge/src/mcp.js`，加载的是仓库磁盘代码；
- 仓库 HEAD `b9a30ae`（0.48.0）的 `src/tools.js:20-47` 已定义 `anyOf/anyChange/stableForMs`，`browser_upload_verified` 的描述也已包含这些修饰符；
- 但本会话 `mcp_get` 实测 `browser_click_verified` / `browser_upload_verified` 的 `expect` 仍是单条件三选一，无任何修饰符；
- `src/mcp.js:4` 在进程启动时 `import { TOOLS }`，`:14` 的 `ListTools` 直接返回这个内存常量；磁盘更新不会触发重载；
- `ps` 显示本机同时存在 10 个 `src/mcp.js` 进程（08:02、08:09、08:21、08:39、08:50、09:19、11:23、13:27、15:30、17:33），0.47.0 提交于 09:13。由 schema 反推，本会话命中的是 09:13 之前的进程（或客户端缓存了旧工具列表）；具体 PID 未逐一对号，故标为推断。
- `browser_health`（`src/server.js:540-558`）只报告 service/extension/browser 版本，不报告 MCP 进程版本或工具指纹，因此调用方无法从回执发现错配。

**影响**

- 0.47/0.48 的写可靠性改进（多分支期望、稳定窗口、变更基线）对客户端不可见；
- 现场问题被误判为"代码没修"，实际是"代码修了但进程没换"；
- 同机多会话可能各自连接不同版本的 MCP 进程，行为不一致。

**期望**：`browser_health` 返回 `mcpVersion`、`mcpProcessStartedAt`、`toolSurfaceHash`、`staleToolSurface`；`ListTools` 在磁盘文件更新时给出告警；文档写明升级后必须重启 MCP 进程。

**复现**：`node src/cli.js` 启动一个 MCP 进程 → 修改 `src/tools.js` 增加字段 → 用旧进程 `mcp_get` 拉 schema，仍是旧字段 → 重启后新字段出现。

**后续处置（2026-11-18 17:5x）**

- 本机插件已从 0.46.0 升级为 0.48.0（App 安装器返回 `version:"0.48.0"`、`enabled:true`），连接器 revision 已更新，`manage_app_mcp retry` 返回 `accepted:true`。
- 独立 stdio 探针直连新 `src/mcp.js`：**140 个工具**，`browser_click_verified` / `browser_upload_verified` 的 expect 均含 `anyOf/anyChange/stableForMs`。当前会话仍显示 **133** 个工具，证明是客户端工具面缓存，而不是磁盘/服务端缺能力。
- 剩余动作：重启 Qoder 或新开会话后，再按本报告与升级方案复测 upload / navigate；完成该复测前，不把 P0-1/P0-2 的根因固定为单一缺陷。

---

### P0-1 `browser_upload_verified` 三类定位全部 `stale_ref`

**现象**

```text
browser_upload_verified({tabId, ref:"…:1", filePath:"…pdf", sha256:"…", expect:{fileNameAppears:"…"}})
→ error: Stale element reference. Read page again. [stale_ref generation=unknown]

browser_upload_verified({tabId, selector:"input[type=file]", …})      → 同一错误
browser_upload_verified({tabId, inputIndex:0, …})                     → 同一错误
```

- 拼多多（cashier 提交发票对话框，行内单文件 input）与淘宝（applyDetail"上传发票"）两站复现，跨两套前端框架。
- 同一时刻，同一页面的 `browser_click_verified`、`browser_eval` 读取均正常；重新 `browser_locate` 取新 ref 后上传仍报同一错误。
- `generation=unknown` 说明上传通道没有拿到有效快照代数，而不是"页面变了"。

**源码对照（HEAD `b9a30ae`）**

- `extension/page.js:2967-2988`：ref-less 分支（`selector` 或 `inputIndex`）直接 `applyUpload`，**不经过** `stateForRef`；
- `extension/page.js:3000-3007`：只有 ref 分支才会校验快照并抛 `[stale_ref generation=...]`；
- 也就是说，按 HEAD 源码，`selector`/`inputIndex` 不应产生 `generation=unknown` 的 stale。现场三种调用都报同一错误，与源码矛盾，最可能的解释是：当前会话的 MCP 进程/标签内 content script 版本陈旧（P0-0），把 ref-less 调用转换成了 ref 调用，或旧扩展代码没有 ref-less 分支。
- 因此先做 P0-0 的进程/标签刷新，再复测；在复测结果出来前，不把根因钉在"上传快照注册表"。

**无论根因如何都应补的可观测性**：ref-less 分支失败时回执带 `targetSource/refSupplied/selectorMatches/inputCount`；`stale_ref` 消息带 `refWasSupplied`，避免 `unknown` 掩盖"根本没传 ref"。

**影响**：财务、政务、ERP 类站点的文件上传全部降级为 OS 自动化；`sha256` 完整性校验与上传后的 `fileNameAppears` 校验都失去意义。

**期望与验收**

1. `ref`/`selector`/`inputIndex` 三条路径在 PDD、淘宝、抖音上传页均返回 `success`，回执含 `fileNameAppears` 命中值；
2. 若确实 stale，回执给出 `generation` 数值与快照年龄，而不是 `unknown`；
3. 上传成功前后各一次读取，页面文件名出现在表格（本任务三站均为"文件名进入表格 = 解析完成"）；
4. 增加回归用例：React 受控上传 + 行内多文件 input + `display:none` input 各一。

---

### P0-2 `navigate_verified` 的子串误判

**现象**

- `expectUrlContains:"tab=submit"`，当前 URL 已含 `tab=submitRecord` → 返回 `not_dispatched`（reason 为"已满足/已加载"类），导航未派发；
- `expectUrlContains:"invoice/applyList"`，当前 URL 已含 `.../invoice/applyList/applyDetail` → 同上。

**影响**：三个后台全部是子路由 SPA，几乎每次"切页签/切列表"都会撞上；调用方被迫改用 `browser_eval` 的 `location.href=…`，写操作脱离 verified 账本（本任务 20+ 次页面切换均为 eval）。

**期望与验收**

1. 子串判等改为"规范化后的路径+查询键值比较"，或新增 `expectUrlNotEqual` / `expectUrlChanged`；
2. 同文档同 URL 的重复导航返回 `outcome:"already_there"`（成功、非失败），而不是 `not_dispatched` 的失败语义；
3. 验收：`/a/list` → `/a/list/detail` 的导航在两个方向上都不误判。

---

### P1-1 `prepare_coordinate` 拒绝与 role-less 控件

**现象**

```text
browser_prepare_coordinate({tabId, x, y}) → "Coordinate target unavailable or protected"
```

拼多多账单复选框（`label.CBX_outerWrapper_5-191-0`）、淘宝复选框均如此。`browser_locate` 能找到按钮候选但 `browser_click_verified` 对"点击前已成立"的期望返回 `already_satisfied`，复选框状态只能靠 `browser_eval` 原生 `.click()` 改变并立即读 `checked` 核对。

**期望**：`prepare_coordinate` 的拒绝要带可执行原因（跨域 iframe / pointer-events / 元素不可见），并给出"改用 ref / eval"的确定性 nextStep；或允许 click_verified 对未派发但状态已变的控件返回 `already_satisfied`（状态等价成功）。

---

### P1-2 瞬时 toast 作为唯一成功证据

**现象**

```json
{"outcome":"condition_met","verification":{"checks":{"textAppears":true},
 "matchedIn":{"textAppears":{"selector":"div.aurora-message.aurora-message-top.css-1oikbv6",
 "text":"提交成功","transient":true,"visible":true}},"stability":{"heldMs":1,"stableForMs":0}}}
```

抖音"提交"按钮的成功回执全部依赖该 toast；随后页面才跳转 `merchant-batch-detail?batch_no=…`。另一处提交（淘宝）返回 `outcome:"navigated"`，期望在新文档上无法评估——两种都是"已派发、需另读状态"的形态。

**更正**：仓库在 0.47.0（`8f37594`，09:13）已在 `src/tools.js:20-47` 实现 `anyOf/anyChange/stableForMs`，`extension/page.js:2993-2999` 也支持 `changeBaseline`；问题在于本会话的 MCP 进程（P0-0）没有加载这段代码，schema 里不存在这些字段。因此本条不是"功能缺失"，而是"部署未生效 + 用法未固化"。

**仍需要的改动**

1. 进程刷新（P0-0）；
2. skill/文档把财务提交的默认写法固定为 `stableForMs` + `anyOf`（见升级方案 P1-2）；
3. `outcome:"navigated"` 时回执明确 `expectationEvaluated:false`，强制另读新页。

---

### P1-3 后台标签的 TDesign 对话框容器挡点击且关不掉

**现象**

```json
{"status":"not_dispatched","reason":"element_covered",
 "coveredBy":{"selector":"div.t-dialog__position.t-dialog--center","coversWholeViewport":true,
 "dismissPath":"escape","portalLike":true}}
```

- Esc 派发（`focusedElement` 为 body）、对话框"返回""关闭"的 eval 点击均无效果；
- 枚举 `.t-dialog__ctx` 只有一个 `display:block`、2388×1174 的容器，内容为上一笔发票的"交付"弹窗；
- `getAnimations().finish()` 收尾动画后仍无效，最终 `style.display='none'` 才恢复可点击。

**推测根因**：后台标签 `rAF` 冻结导致 TDesign 离场动画不结束、组件状态未卸载；`dismissPath:"escape"` 是基于覆盖元素的启发式推断，未验证可关闭性。

**期望**：`browser_scan_overlays` 能标注"已隐藏/无绘制/pointer-events:none"的容器并给出可执行的隐藏路径；文档补充"隐藏标签下残留 modal 容器"的标准处置（与 CNIPA 报告里 `.ant-modal-wrap {pointer-events:none}` 同一类问题）。

---

### P1-4 无"激活指定标签"能力，原生对话框无法触发

文件选择对话框只能由**可见标签**中的真实点击触发（JS `input.click()` 无用户激活不弹框）。本次通过"把正在显示的标签导航到目标 URL"实现（标签复用），过程中用 AutoIt `winGetTitle("[ACTIVE]")` 判断当前显示标签。Bridge 目前没有对应工具，`browser_windows_control` 只能前置窗口。

**期望**：提供显式前景动作 `browser_tabs {action:"activate", tabId}`（或在 `browser_windows_control` 中加 `tabId+activate`），要求确认串（如 `"activate_tab_once"`）与用户授权；文档写明"仅当需要 OS 级对话框/人工观看时使用"。

---

### P2-1 下载被外部管理器接管时语义不清

`browser_downloads` 中该条目：

```json
{"id":2305,"state":"interrupted","error":"USER_CANCELED","canResume":false,"bytesReceived":0,
 "mime":"application/pdf","startTime":"…09:11:48Z"}
```

实际是 IDM 拦截并弹出"下载文件信息"对话框，确认后文件才落盘。建议在回执中加 `external_download_manager_suspected:true`（检测 IDM 进程/窗口）或把 `USER_CANCELED` 与"无数据即 canceled"区分开。

### P2-2 后台标签 SPA 首屏长时间不加载

抖音"我给平台开票"在后台标签保持"加载中…"数分钟，同一 URL 在前台标签 3 秒内渲染完成。属已知的 hidden 文档限制，但对需要即时读表的任务影响很大。建议 `browser_observe`/`browser_read` 对 `visibilityState:hidden` 且 DOM 长时间无变化给出显式提示与建议（"该页需要前台可见才能完成渲染"）。

---

## 4. 修复优先级与验收清单

| 优先级 | 条目 | 代码面（建议） | 验收用例 |
|---|---|---|---|
| P0 | MCP 工具面版本错配 | `src/mcp.js:4,13,14`、`src/server.js:540-558`、`src/version.js` | 旧进程 `browser_health` 报 `staleToolSurface:true`；重启后 schema 出现 `stableForMs/anyOf` |
| P0 | upload 三分支 stale | `extension/page.js:2967-3058`、`src/tools.js:476` | PDD 对话框内 PDF、淘宝 applyDetail PDF、`display:none` input 三用例全 success |
| P0 | navigate 子串误判 | `src/tools.js` navigate 期望比较 | `/a/list`→`/a/list/detail` 双向不误判；`already_there` 语义 |
| P1 | prepare_coordinate 拒绝说明与 ref 替代 | `extension/page.js` hit-test、`src/next-step.js` | PDD `label` 复选框给出可用 ref 或明确 nextStep |
| P1 | 期望修饰符部署与默认用法 | 已实现于 `src/tools.js:20-47`；补 `navigated` 回执标记与文档 | 抖音"提交成功"toast 用例：`stableForMs:1500` 不得提前成功；旧进程必须报错配 |
| P1 | 残留 modal 容器处置 | `extension/page.js:451-484`、`3045-3053` | 后台标签 TDesign 交付弹窗：一键隐藏并可点击底层按钮 |
| P1 | 标签激活（需确认串） | `src/tools.js` + extension `tabs` API | 显式激活后 `winGetTitle` 命中目标页；默认仍后台 |
| P2 | `USER_CANCELED` 与外部下载器 | `src/tools.js` downloads | IDM 拦截时回执含 `external_download_manager_suspected` |
| P2 | hidden 文档加载提示 | observe/read 回执 | 抖音后台标签给出"需前台可见"提示 |

---

## 5. 已固化资产

- 站点 skill：`skills/platform-invoice-upload/SKILL.md`（三平台 + 电税 + OS 上传 + IDM + 证据归档）
- 修复方案：`docs/UPGRADE-PLAN-20261118-platform-invoice-site-feedback.md`（P0-0…P2-3 的源码坐标与验收）
- 归档：`J:\WorkAndData\双柏彝笙商城\60_店铺经营\平台开票_20261118\`（票据 10 份、截图 4 张、`归档说明_20261118.md` 含 sha256 清单）
- 记忆：用户级 `ai-browser-bridge-usage-laws`（新增第 16–20 条）、项目级 `platform-invoice-20261118`

## 6. 最小复现（upload stale）

1. 打开拼多多商家后台 → 资金/发票管理 → 提交发票 → 勾选任一月度账单 → "提交发票"打开"发票信息确认"对话框；
2. `browser_locate` 取"导入PDF"按钮或对话框内 `input[type=file]` 的 ref；
3. `browser_upload_verified({tabId, ref, filePath:"任意 PDF", sha256, expect:{fileNameAppears:"<文件名>"}})`；
4. 观察返回 `stale_ref`；改用 `selector:"input[type=file]"`、`inputIndex:0` 复测，结果相同；
5. 对照：同一页面 `browser_click_verified` 点击"取消"可正常工作（证明快照与连接均正常）。
