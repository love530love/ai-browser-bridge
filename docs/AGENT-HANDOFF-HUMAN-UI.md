# 人类等价浏览器 UI 基座：Agent 交接

> 本文是后续 Agent 接手本项目的入口，不依赖某一段对话。每次交接前先核对实际 Git、部署和测试状态；不要把本文件中的计划当成已交付能力。

## 目标

让 Agent 能通过当前用户已授权的 Chrome 界面完成工程师可人工执行的浏览器工作。页面 URL 前缀（包括 `chrome://`、`devtools://`、`chrome-extension://`）本身不是永久拒绝理由；应按真实执行表面选用扩展 DOM/Chrome API、CDP、Windows UI Automation、视觉/坐标或人工接管通路。用户/接入 Agent 负责任务意图与业务授权，基座负责可用能力、精确目标绑定、真实执行状态/证据、日志、技术异常处理与不确定结果不重放。

“人类等价”不是绕过 Chrome/操作系统原生权限、认证、策略或安全提示；网页内容不是授权。不得把主机任意命令伪装成浏览器工具，不得把“快捷键/点击已派发”冒充最终任务完成。

## 加入协作与接手步骤

1. 阅读根目录 `AGENTS.md` 和本文件。
2. 检查 `git status --short --branch`、`git log --oneline --decorate -8`、所有远端跟踪分支及本任务板；不得丢弃、覆盖其他 Agent 的未提交文件。
3. 在共享任务板认领一个未阻塞事项。当前活跃协作区：`ai-browser-bridge-human-ui`；共享 task list 为本轮人类等价 UI 基座任务板。新会话若无法进入同一个协作区，仍可按仓库此交接文档和任务编号继续，并先向负责人说明。
4. 实施前先加可复现测试/独立 oracle，改动保持单一能力边界；不得同时操作真实用户浏览器和隔离 fixture。真实 Chrome 操作必须经过 Bridge、限制在本次创建的测试标签/窗口，任何扩展 Reload、用户设置变更、安装/删除扩展都需要本次具体动作的明确授权。
5. 交付时记录变更文件、确切命令/结果、真实 Chrome 覆盖范围、未覆盖边界、工作树和提交/部署状态；更新本文件与任务板。未明确要求时不要擅自推送、部署或重载扩展。

## 当前交接快照（2026-10-27 收口后，接手前必须复核）

- 仓库：`K:\PythonProjects5\AI-Browser-Bridge`，分支 `main`，**工作树干净**（唯一未跟踪项是本地 `graphify-out/` 缓存，不属产品）。
- 已提交并推送：`a9fc930`（0.5.23 收口）、`8a259ef`（0.5.24 只读捕获）、`91c3068`（现场验收入口）。接手后仍要复核 `git log` 与远端指针。
- **0.5.24 已真实部署并验证**（2026-10-27）：服务重启到 0.5.24，扩展经 `browser_reload_extension` 重载并核验新会话与版本，`doctor` **10/10 通过**（service 0.5.24 = extension 0.5.24，buildId 与磁盘一致，队列空闲）。
- 接手后仍必须先跑 `node src/cli.js doctor` 与 `browser_queue_status` 复核，不得沿用本文数字；任何源码改动都会让 `service-build-current` 变红，需要重新重启服务才算部署。
- **Reload 已是能力，不是人工步骤**：`browser_reload_extension` 只传 `confirmation: "reload_extension_once"` 就会在现场枚举可见 Chrome 窗口——恰好一个则使用（回传 `targetResolution: "single-visible-chrome-window"`），零个 `not_dispatched`/`no_visible_chrome_window`，多个 `denied`/`chrome_target_ambiguous` 并列出候选而不猜。显式传 `processId`/`windowHandle` 的路径仍要求近期枚举过。固定 confirmation 是**调用方声明**（Agent 自己给出），不是人工点击墙；但每次重载仍需这一次调用的明确授权，且 `uncertain` 之后不得再调。
- 已有停靠式 DevTools `browser_devtools` UIA 候选：**只有 `observe` 与 `select_panel`，不含 `open`/F12 toggle**（原因见下节未决审查点）。代码和文档位于 `src/desktop-adapter.js`、`scripts/devtools-ui.ps1`、`src/server.js`、`src/tools.js`、`docs/DEVTOOLS-EXECUTION.md`；对应测试 `test/devtools-adapter.test.js`、可选真实 Chrome 本地 fixture `test/live-devtools.js`。`devtoolsState` 只会返回 `open` 或 `unknown`，**永不推断 `closed`**。本机 Chrome 历史上曾验证过停靠 DevTools 的 F12 打开/幂等与 Elements/Console/Network 面板选择回读，但 open 通路已在当前候选撤下；select_panel 只适用于用户已自行打开 DevTools 的场景。这不覆盖 detached DevTools、Console 脚本执行、Sources 调试或其他 Chrome/UIA 版本。
- **本轮已完成的验证（可引用）**：0.5.23 阶段 —— `node --check` 通过；`scripts/devtools-ui.ps1` 与 `scripts/native-ui-snapshot.ps1` 用 `System.Management.Automation.Language.Parser::ParseFile` 解析 0 错误；`test/devtools-adapter.test.js` 6/6。0.5.24 阶段 —— `test/cdp-capture.test.js` 15/15、`test/reload-target.test.js` 6/6、`test/capability-guide.test.js` 6/6、`test/coordinate-guard.test.js` 7/7。**全量 `node --test --test-concurrency=1 test/*.test.js` = 181/181 通过（41 个测试文件全部有贡献，无静默跳过）**。
- **后台焦点独立性现场实测**：`node test/focus-matrix.js` = **25/25**（两个 fixture 标签，激活第二个使第一个真后台）。`browser_action` `Tap` 在后台真实落到预备的 DOM 目标（计数器 1→2），`Hover` 正常派发；`requireForeground:true` 仍按请求拒绝且不签发 token。日志里会打印 `active` / `windowId` / `visibility` / `windowFocused` / `viewport`，便于复核环境。
- **真实 Chrome 验收（已通过）**：`npm run test:capture` **9/9**，退出码 0；本地 fixture 页（每 400ms 重复探针）在 1500ms 窗口内捕获到 console 文本与级别、未捕获异常、`/api/ok` 的 200 完成行、被拒请求的 failed 行、inline 脚本标记，且结果不含 header/cookie/凭据；只操作并关闭自身创建的标签。
- `browser_reload_extension` 自动目标解析路径已在真实 Chrome 实测：只传 `confirmation` 即成功，回传 `targetResolution: "single-visible-chrome-window"` 与 `expectedVersion: "0.5.24"`。
- 工作树还有 Graphify 临时目录 `graphify-out/` 未跟踪。不得把其中缓存/临时文件加进产品提交；不要在没有审阅前删除。
- **两个测试基础设施缺陷，本轮已定性，接手者不要再踩**：
  1. `test/watchdog.test.js` 的外层超时（原 60000ms）小于 4 次串行 `pwsh.exe` 的内层超时之和（4×30000ms），预算内部不自洽；机器有负载时单次 pwsh 超过 30s 就会假红（实测一次 148/149 失败，该文件本轮未修改，单独跑通过）。已把外层提到 180000ms，断言未动。
  2. 一次全量运行里 `test/native-ui-snapshot.test.js` 的 4 个用例**没有出现在结果中也没有报错**（该轮计 149，正确应为 153），即 runner 可能静默少跑一个文件——这是"看起来全绿其实漏跑"的假绿风险。复核全量结果时必须同时核对用例数与文件数，不能只看 fail=0。
- 新查明并在当前工作树修复策略注册表的可靠性缺口：热加载原先只比较 `mtimeMs`，Windows 粗粒度/同时间戳原子替换会漏掉外部 CLI 更新；现改为比较文件内容字节并解析同一快照。`test/policy.test.js` 增加同时间戳复现，定向 16/16 通过。

## 本阶段任务板与优先顺序

1. **稳定并收尾 0.5.23 DevTools 阶段**：已完成（撤下 open/F12、全量回归、文档校准、提交 `a9fc930` 并推送）。
2. **建立跨 Agent 交接**：已完成；由本文件、根 `AGENTS.md`、共享协作区 task list 承载，接手者应先验证以上快照。
3. **扩充 DevTools 面板原语**：**进行中**。已完成只读捕获切片 `browser_devtools_capture`（Console/Network/Sources 元数据/Performance，单元契约见 `test/cdp-capture.test.js`），真实 Chrome 验收待扩展 Reload 授权。**未做**：Console 输入执行、Sources 断点/单步/编辑、请求重放、Application 存储、Lighthouse、ServiceWorker 调试。按小步落地，逐动作提供目标、派发状态和结果证据；“打开面板”不等于完成面板任务。
4. **Chrome 原生 UI**：逐项实现设置读写与回读、证书/代理、扩展管理、下载完成和落盘证据、上传、剪贴板、权限对话框、多窗口/标签。精确目标（尤其扩展 ID、窗口 PID/HWND、下载 ID/文件路径）；不确定的副作用不重放。
5. **统一执行上下文**：DOM/视觉/网络/页面快照、trace/audit、可扩展 before/after hooks、可分类异常与恢复建议、可暂停/续接的检查点；与现有队列/lease/写超时语义兼容。

## 当前代码入口

- 工具定义/schema：`src/tools.js`
- 服务端 dispatch、policy、queue、audit、desktop mutex：`src/server.js`、`src/policy.js`、`src/leases.js`
- 扩展 DOM/Chrome API/CDP：`extension/worker.js`、`extension/page.js`、`extension/cdp.js`
- CDP 只读捕获（`browser_devtools_capture`）：`extension/cdp-capture.js`（`createRecorder` / `createTabSubscription` / `captureDevtools`，纯函数、无 chrome 依赖，可直接单测）、`test/cdp-capture.test.js`
- Windows UI 自动化：`src/desktop-adapter.js`、`scripts/devtools-ui.ps1`、`scripts/reload-extension.ps1`
- 现有能力/路线图：`docs/CHROME-CAPABILITY-MATRIX.md`、`docs/PRODUCT-ROADMAP.md`、`docs/DEVTOOLS-EXECUTION.md`
- 回归入口：`npm test`（串行全量）、`npm run test:stress`（隔离 Chromium）、`npm run test:devtools`（现有 Chrome 的 opt-in、本地 fixture，操作后仅关闭自身测试标签）、`npm run test:capture`（同上，针对 `browser_devtools_capture`；扩展未 Reload 时会报 BLOCKED，那不是通过）。

## 部署循环（全部由能力驱动，不存在“必须人工点一下”的步骤）

代码改动后按这三步走，每一步都是可调用、可回读、有状态证据的能力，而不是人工操作：

1. `node src/cli.js doctor` —— 看 `service-build-current`。红就说明运行的服务还是旧源码：停掉 `.local/server.pid` 里的进程再跑 `start.ps1`。**不要只看版本号**，版本相同但 buildId 不同也意味着没部署。
2. `browser_reload_extension` 带 `confirmation: "reload_extension_once"` —— 一条调用完成「解析目标窗口 → 打开固定 ID 详情页并保留当前页 → 点 Reload → 观察新扩展会话与版本」，成功回 `verified: true` 与 `targetResolution`。不需要先手工跑 `browser_desktop_windows`。
3. `node src/cli.js doctor` 应回到 10/10；需要真实浏览器行为证据时再跑 `npm run test:capture` / `npm run test:devtools`。

`confirmation` 是**调用方声明**（Agent 自己给出），不是人工点击墙；真正的约束是「每一次重载都需要这一次调用的明确授权」以及「`uncertain` 之后不得再调」。多窗口时能力不会替你猜，会返回候选让你选定。

## DevTools UIA 的未决审查点

独立审查指出两项发布阻断问题，**当前候选的处置是收缩能力面，不是修复后保留 open**：

1. **负证据不足**：Document 的 `ValuePattern` 读取失败会被静默吞掉；若 Chrome 只暴露 Accessible Name 或省略部分 DevTools 控件，“UIA 遍历完整但没找到 DevTools”并不能证明 DevTools 已关闭。据此推断 `closed` 会把 `unknown` 误判成确定状态。
2. **全局焦点 TOCTOU**：`SetForegroundWindow` / `GetForegroundWindow` 检查与 `WScript.Shell.SendKeys('{F12}')` 之间存在跨窗口竞态，F12 可能落到之后获得焦点的窗口。

**处置**：`open`/`toggle` 已从工具 schema、server capabilities、protected-ui planner、PowerShell 脚本、集成测试与文档六处同时撤下；脚本对 `open` 返回 `not_dispatched` / `action_not_implemented`，不派发任何按键。`devtoolsState` 收敛为只允许 `open` / `unknown`。要恢复 open，必须先做到：在目标窗口内用可精确绑定且可回读的原生 UIA action（或 CDP `Target.attachToTarget`）替代全局 SendKeys，并能证明负证据充分。**静态正则测试和单机成功都不是并发焦点安全的证明。** detached DevTools 尚未精确关联目标标签。

## 验证与发布纪律

- 单元/假 runner 测试证明代码契约，不证明真实 UIA；隔离 Chromium fixture 不证明日常 Chrome；实机单窗口结果不证明所有 Chrome 版本。
- 每项操作区分 `not_dispatched`、`success+verified`、`uncertain`、`unsupported/unavailable`。未知 UI/网络/下载/写结果绝不自动重放。
- 用托管 Node 运行：`C:\Users\love\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe`。
- 部署先确认队列 idle、maintenance lock、build ID 和 target；不因为 manifest version 字段变化就自动 Reload。
- 提交时只 stage 本次审查过的产品文件，排除 `graphify-out/`、本机日志、凭据与会话数据；推送之前核对 `origin/main` 与 `sshpush/main` 的提交图及项目长期约定。

## Codex 原生 UI 快照增量（2026-10-27）

本轮领取原生菜单发现/快照子任务。新增 scripts/native-ui-snapshot.ps1、src/native-ui-snapshot.js、test/native-ui-snapshot.test.js、docs/NATIVE-UI-PRIMITIVES.md；在 desktop-adapter/server/tools 仅追加 browser_native_snapshot 分发，保留撤下 open 的协作修复。定向测试 16/16 通过；PowerShell AST 解析及 git diff --check 通过。本机只读适配器实测取得 121 个原生控件，排除 1 个 document，partial=false；识别 Chrome/view_1007/ExpandCollapse 候选。未执行菜单展开、未完成 DevTools 打开；下一步是绑定 ref 的 Expand/Collapse 与 popup owner 关联。新增服务源码尚未部署，未提交或推送；现有 0.5.23 候选其他改动未重置或清理。
