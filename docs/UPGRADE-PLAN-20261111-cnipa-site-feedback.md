# 升级方案：CNIPA 商标网四案实测反馈（2026-11-11）

> 来源：2026-11-11 用本 Bridge 完成 CNIPA 新系统 4 件业务——驳回复审 1 件、无效宣告 2 件、注册申请 1 件（一标三类 30 项，申请号 94896138）。
> 现场报告：[FIELD-REPORT-20261111-cnipa-toas-review.md](FIELD-REPORT-20261111-cnipa-toas-review.md)
> 本文只写**可开发、可验收**的条目；每条给出源码坐标、当前行为、期望行为、验收用例。站点侧的坑写在现场报告，不在此重复。

## 0. 结论

- 4 件业务全部提交成功，说明「DOM 动作 + JS eval + 截图核验」的路线可用。
- 但 3 个 P0 阻断点、7 个 P1 静默失败点，全部靠页面内 workaround 绕过，Bridge 自身未修复。
- 这些问题不只影响 CNIPA：antd/Element/政企后台大量使用隐藏 file input、离场动画、动态表格，属于通用能力缺口。
- **开发位置结论：继续在现有仓库开发，不新建 Qoder 项目空间**。理由见 §4。

## 1. P0（不修则同类站点直接不可用）

### P0-1 上传 MIME 只覆盖 4 种扩展名

- 源码：`src/server.js:693`
  ```js
  const mime = { '.zip': 'application/zip', '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv' }[extname(filePath).toLowerCase()] || 'application/octet-stream';
  ```
- 现象：上传 `.pdf` 被标为 `application/octet-stream`，CNIPA 前端校验拒绝（「上传文件格式不正确,无法上传」）。
- 期望：
  1. 内置常见类型表：pdf/png/jpg/jpeg/webp/gif/doc/docx/xls/xlsx/ppt/pptx/ofd/rar/7z；
  2. `browser_upload` 增加显式 `mimeType` 参数，覆盖自动推导；
  3. 返回体中回显最终使用的 MIME 与来源（`src/server.js:694` **已回显** `mimeType`；本轮补 `mimeSource`，便于区分显式指定与按扩展名推导）。
- 验收：上传 `01_事实与理由.pdf`，服务端返回 `mimeType=application/pdf`，CNIPA 预览区出现文件名。
- 影响面：所有政务/表单站点 PDF 上传。

### P0-2 隐藏 file input 不可操作

- 源码：`extension/page.js:2659`、`extension/page.js:2663`
  ```js
  if (binary.length !== args.size || binary.length > 16 * 1024 * 1024) throw new Error('Upload payload size mismatch');
  transfer.items.add(new File([bytes], args.fileName, { type: args.mimeType || 'application/octet-stream', lastModified: Date.now() }));
  ```
- 现象：antd Upload 把 `input[type=file]` 设为 `display:none`，调用方拿不到可用的 file input ref，上传无法发起。
- **复核更正（2026-11-11，对照 0.37.4 源码）**：`browser_upload` **本身已允许不可见元素**——`extension/page.js:2636` 的可见性检查带 `&& name !== 'browser_upload'` 例外，`page.js:39` 的 `sensitive()` 只拦 `input[type=password]` / `input[type=hidden]` / `[data-ai-private]`，`input[type=file]` 不算敏感；`page.js:2655-2667` 已直接 `el.files = transfer.files` 并派发 `input` + `change`。真正的卡点是 **ref 获取路径**：`browser_find_element`（`page.js:2509` / `:185`）会过滤 `display:none` 等不可见元素，而 `src/tools.js:324-326` 的 `browser_upload` 只接受 `ref`，没有 `selector` / `inputIndex`。原报告里的 "Element unavailable or protected" 不是当前 upload 分支抛的。
- 期望：`browser_upload` / `browser_upload_verified` 支持 `selector`（CSS）或 `inputIndex`，直接解析到 `display:none` 的 file input，仍走既有 `DataTransfer` 赋值与 `change` 派发；不要求元素可见，但仍拒绝敏感/私有子树并绑定精确目标（多个候选时拒绝，不猜）。
- 验收：CNIPA「身份证明文件」附件位（`#form_item_idetCertCnAttJson`）直接上传成功，不依赖页面内 fetch。
- 备注：当前 workaround 是本地 HTTP 服务 + 页面内 `fetch → File → DataTransfer`，见 §3。

### P0-3 上传上限 16 MiB 硬编码 + uploadRoots 不热加载

- 源码：`src/server.js:689` 与 `extension/page.js:2659`（**两处** 16 MiB 硬编码）、`src/config.js:17`（默认空数组）、`src/server.js:120`（启动时一次性缓存 config）、`src/cli.js:194-195`（写回 config.json）
- 现象：合并证据 PDF 普遍 5–30 MB；把材料目录加进 `uploadRoots` 后，运行中的服务不生效。
- **复核更正（2026-11-11）**：原稿写「`cli.js:194` 仅追加到内存 config」是错的——`cli.js:194-195` 明确 `writeFileSync(configPath, ...)` **已持久化**。真因是 `server.js:120` 启动时把 config 读进内存后不再重读文件，运行中的服务持有旧 allowlist。修法仍是「热加载 / reload 接口」，但不要按「改成写文件」去修。
- 期望：
  1. 上限改为配置项 `uploadMaxBytes`，默认仍 16 MiB，可调；
  2. `uploadRoots` 支持热加载（文件监听或 `browser_reload_config`），已在运行的服务无需重启；
  3. 拒绝时返回当前上限与配置来源。
- 验收：不重启服务，`browser_upload` 能读取新增 allowlist 目录中的 25 MB PDF。

## 2. P1（会静默失败/误判，浪费调用方大量时间）

### P1-1 点击成功但零副作用，没有诊断

- 现象：CNIPA【已提交】列表的「下载」按钮，`browser_click` 返回 `clicked:true`，但无弹窗、无 toast、无新下载、无 JS 错误。
- 期望：写动作返回体增加 `effect` 判定：`dom | network | download | dialog | none | unknown`；`none` 时给出 `diagnoseFlow`（最近 5 个 XHR、DOM 变更计数、file input 调用、控制台错误）。
- 验收：点「下载」返回 `effect:"none"` 与诊断摘要，而不是只给 `changed:false`。

### P1-2 `document.hidden` 与窗口焦点脱钩

- 现象：`browser_windows_control` 返回 `focused:true, state:maximized`，页面内 `document.hidden` 仍为 `true`；定时器被节流（10ms→165ms，300ms→1008ms），antd 离场动画卡死。
- 期望：
  1. **复核更正（2026-11-11）**：`extension/worker.js:700-701` 已在 health 结果里暴露 `documentFocused` / `visibilityState`，`:922-924` 已产出 `window_not_focused` / `document_hidden` / `document_unfocused` advisories，`src/tools.js:289` 的 `browser_health` 描述也已涵盖。基础读数**不缺**，只补可选的 `timersThrottled` 估计；
  2. 写动作前若 `visibilityState=hidden`，返回警告字段 `throttled:true`，并在 `nextStep` 建议 `browser_windows_control` 激活（**本轮真正要做的部分**）；
  3. 文档明确：`focused:true` 不等于页面可见。
- 验收：在最小化窗口调用 `browser_at`，返回 `throttled:true`。

### P1-3 缺少 wait_for_selector

- 现象：点击「下一步」后立即 eval，DOM 未渲染完返回空；只能固定 sleep 或页面内轮询。
- 期望：新增 `browser_wait_for_selector`（CSS/文本/role，`timeoutMs`，`state: visible|attached|detached`），返回命中的 ref 与耗时。
- 验收：CNIPA 复审「预览」页等待 `.form-detail-spc` 出现，返回 ref。

### P1-4 find_element 不自动滚动

- 现象：折叠区域下方的「预 览」按钮 `find_element` 返回空。
- 期望：匹配阶段先 `scrollIntoView({block:'center'})` 再判定可见性；或在空结果时自动滚动一屏重试一次。
- 复核补充（2026-11-11）：`browser_prepare_action`（`extension/page.js:2538`）在找不到候选时**已经**给出 `browser_scroll_element` 的 nextStep，`browser_find_element`（`:2515`）也有 `notRendered` 提示；缺的是工具内部自动重试，不是完全没有指引。
- 验收：CNIPA 注册向导最后一步「预 览」可直接找到。

### P1-5 预览/详情页表单值不在可读文本里

- 现象：CNIPA 预览页用可编辑 textarea 渲染地址与商标说明，`innerText` 只有 label；`browser_read` 误判为空。
- 期望：`browser_read` 增加 `includeFormValues`（默认 false），把 `input/textarea/select` 的当前值以 `field: value` 并入结果；`mode:"cheap"` 不启用。
- 验收：读取预览页，返回 `申请人详细地址: 云南省…42号`。

### P1-6 确认类弹窗「点了确定但流程没动」缺少证据链

- 现象：CNIPA「商品导入」→ 确定，无 file input、无 XHR、无错误、无 DOM 变化。
- 期望：`browser_click` 对 `role=dialog` 内的确认按钮增加 `flow` 诊断：是否创建 file input、是否发起请求、是否新增 DOM、是否触发下载；任一为真即记录。
- 验收：复现「商品导入」，返回 `flow:{fileInputs:0,requests:0,domDelta:0}`。

### P1-7 ref 生命周期与重渲染

- 现象：弹窗关闭/步骤切换后旧 ref 失效，点击落到旧节点。
- 期望：ref 携带 `elementVersion`/`generation`，失效时返回 `stale_ref` 而不是静默点击；文档给出「每次交互重新取 ref」的硬规则。
- 验收：关闭弹窗后点旧 ref，返回 `stale_ref`。

## 3. 站点专用 recipe（不进 Bridge 核心）

CNIPA 的 Vue3/qiankun 表单模型、商品弹窗、Jeecg 菜单属于站点知识，建议放 `skills/cnipa-trademark-online` 与项目能力包，不硬编码进 Bridge：

- Vue 表单模型探针：`#app.__vue_app__` → 遍历 `subTree` → 组件名 `action-form` → `setupState.formNewState`。
- 商品弹窗自动化：类别 Select 搜索 → 关键词检索 → 按编码匹配行 → 勾选 → 一次「添加」。
- Jeecg 菜单：`.jeecg-menu-submenu-title` 展开，`li.jeecg-menu-item` 文本点击走路由。
- 上传：本地 HTTP 服务 + 页面内 `fetch → File → DataTransfer → change`（当前 P0-2 的替代路径）。

这些 recipe 的代码已固化到 `J:\WorkAndData\双柏彝笙商城\80_工具与脚本\01_能力包_CNIPA\`（见该目录 README）。

## 4. 为什么留在现有仓库开发，不新建 Qoder 项目空间

| 维度 | 现有仓库（推荐） | 新建 Qoder 项目空间 |
|---|---|---|
| 源码与版本 | 直接改 `src/`、`extension/`，git 分支可回溯 | 需要复制/镜像，易产生双源 |
| 文档体系 | 已有 51 篇 docs、CHANGELOG、AGENTS.md、PRODUCT-ROADMAP | 需重建索引与规范 |
| 验收 | `npm run doctor`、现有 test/ 与部署脚本直接可用 | 需重新接 CI/部署 |
| 协作 | 现有 `coordination/` 与 git 分支即可并行 | 多一个入口，跨库同步成本高 |
| 风险 | 低（只新增 docs 与分支） | 中（代码分叉） |

**执行建议**：在现有仓库开分支 `feature/cnipa-feedback-20261111`，按 P0→P1 顺序提交；每个 P0 附一个可复现测试用例。若需要并行开发，用 `git worktree` 在同一仓库开第二个工作目录，而不是新建项目空间。Qoder 侧只需把 `K:\PythonProjects5\AI-Browser-Bridge` 作为工作区打开即可。

> **执行备注（2026-11-11 19:30，主 agent 复核后）**：本轮**不实际创建该分支**。主工作区存在其它会话未提交的并行改动（`.aep/`、`coordination/`、`AGENTS.md`、`docs/AGENT-HANDOFF-HUMAN-UI.md`、`.gitignore`），在同一工作树 `git checkout -b` 会切换整个工作树并可能干扰它们；而新 `git worktree` 里没有 `node_modules/` 与 `.local/config.json`，测试链路要先重建。因此本轮在 `main` 上按 M1→M4 **分批提交**，每批精确 `git add`（只列本轮文件，绝不 `git add .`），保持与并行会话共存。分支建议留待无并行会话时采用；「不新建 Qoder 项目空间」这条结论不变。

## 5. 里程碑与验收

| 里程碑 | 内容 | 完成标准 |
|---|---|---|
| M1（P0） | MIME 表 + 显式 mimeType + 隐藏 input + 上传上限/热加载 | CNIPA 营业执照 PDF 与图样 JPG 直接用 `browser_upload` 成功，无需本地 HTTP 服务 |
| M2（P1 可观测） | effect 诊断、visibilityState、flow 证据链、stale_ref | 四个静默失败场景均返回可解释结果 |
| M3（P1 易用） | wait_for_selector、find_element 自动滚动、includeFormValues | CNIPA 注册全流程不写自定义轮询即可跑通 |
| M4（recipe 化） | 把 CNIPA 页面 JS 从会话搬进 skill/能力包 | 新会话按 README 可在 30 分钟内复现 94896138 同类申请 |

## 6. 本次未解决、但不建议在 Bridge 层解决的

- 微信/支付宝小程序扫码确认：必须人工，Bridge 只负责导出二维码与等待。
- 官网表单的业务校验（地址必须省市区开头、200 字上限）：属于站点规则，写入 recipe 与检查清单。
- 「下载」按钮无反应：站点自身缺陷；Bridge 提供 `browser_pdf_save` 作为归档替代（已实测 493KB 成功）。

---

## 7. 实施结果（2026-11-11，v0.38.0）

本方案 10 项已全部落地，逐项对照：

| 条目 | 落地位置 | 验收 |
|---|---|---|
| P0-1 MIME + 显式 mimeType + 回显 | `src/upload-mime.js`、`src/server.js`、`src/tools.js` | `test/upload-cnipa.test.js` 真实起服务断言 PDF → `application/pdf`、显式覆盖 `mimeSource=explicit` |
| P0-2 隐藏 file input | `extension/page.js` 的 `applyUpload` + `selector` / `inputIndex` | 断言参数透传、零目标 / 多目标拒绝 |
| P0-3 上限 + 热加载 | `src/config.js`、`src/server.js` 的 `liveUploadPolicy()` | 断言**不重启服务**改 config 后新 root 与 4096 上限生效，拒绝消息含上限与来源 |
| P1-1 effect / diagnoseFlow | `extension/page.js` 的 click 分支 | `test/cnipa-capabilities.test.js` 断言字段与脱敏 |
| P1-2 throttled | `extension/page.js` 的 `throttledInfo()`、`browser_at` | 契约断言 |
| P1-3 wait_for_selector | `tools.js` / `worker.js` 白名单 / `tool-index.js` / `page.js` | 三处接线断言 + 超时不伪造命中 |
| P1-4 自动滚动 | `page.js` 的 find_element | `autoScrolled` 留痕 |
| P1-5 includeFormValues | `page.js` 的 browser_read + `tools.js` | 默认关 / cheap 不启用 / 敏感字段排除 |
| P1-6 dialog flow | `page.js` 的 click 分支 | 契约断言 |
| P1-7 stale_ref | `page.js` + `src/diagnostics.js` | 从源码提取文案喂给 `errorCategory` 断言 `STALE_REF` |
| M4 recipe | `skills/cnipa-trademark-online/` | 独立目录，站点知识未进核心 |

**实施中的新发现（已修，均未放宽断言）**：

1. 新增工具让 `tool-index` 超 3500 字节（3517），按既有做法压缩 `maintenance` 组 purpose 恢复。
2. 页面侧 effect 观测与自动滚动在**最小 DOM 夹具**里会因缺少 `getElementsByTagName` / `performance.getEntriesByType` / `setTimeout` / `getComputedStyle` 抛错，导致 4 条既有测试红。改为「观测不到即 `unknown`、不支持滚动即保留原零结果」。
3. 热加载第一版从磁盘无条件读 config，测试夹具注入的 allowlist 被真实 `.local/config.json` 覆盖（还撞上一个已不存在的 J: 目录而 ENOENT）。加 agentToken 同源校验 + 失效 root 跳过解决。

**诚实边界**：

- `effect` 只能观测 DOM / 资源请求 / 对话框 / file input；**下载与 console 错误在页面世界不可观测**，返回 `unknown` 而非编造零效应证据。
- `timersThrottled` 是估计值，不是 Chrome 内部节流状态的直接读数。
- P1-7 的「generation」就是 ref 里已有的 `snapshot` 前缀；本轮补的是结构化回显与分类，不是新的失效检测。
- M4 的上传替代路径仅适用于旧版本或 `selector` 能力不可用时，能力包已注明。
