# 自主浏览器 · AI Browser Bridge

**默认用途：让已有 AI Agent 直接操作浏览器，无需配置模型。** 终端 Agent 可立即使用 [接入说明](AGENT-QUICKSTART.md) 和 agent.ps1；MCP 客户端使用本机生成的工具配置。插件内模型任务页只是可选功能。

**Agent 操作契约**：新 MCP 连接的初始化说明自动包含 [操作 Skill](skills/ai-browser-bridge/SKILL.md)，也可通过 MCP 资源 `bridge://skills/ai-browser-bridge` 读取同一份内容。已有客户端需要重新连接。初始化会传递说明，但客户端是否展示、模型是否遵守取决于客户端；这不代替服务端租约、权限和动作验证。无需重新加载 Chrome 扩展。

一个可自行修改、运行的 Chrome Manifest V3 扩展，将网页提供给支持 MCP、HTTP 或命令行的 AI。当前源码版本 **0.5.24**（部署状态以 doctor 为准），默认允许所有 HTTP / HTTPS 网站，也可切换为指定网站列表。

0.5.24 让所有页面动作默认不依赖窗口/标签焦点：标签置于后台、窗口不在最上层时，读写、CDP 指针派发与坐标动作仍照常完成（后台实测 25/25，`npm run test:focus`）。坐标工具新增可选 `requireForeground` 用于显式恢复严格模式；`browser_prepare_coordinate` 用 `evidenceQuality` 提示截图是否可能是旧帧。详见 [Chrome 能力矩阵](docs/CHROME-CAPABILITY-MATRIX.md) 的「焦点独立性契约」。

0.5.18 增加断线错误暂存、重连补传和落盘确认，以及鼠标移入后的再次校验、弹窗表单值变化检测。日志保留范围与错误清理流程见 [扩展错误维护](docs/EXTENSION-ERROR-MAINTENANCE.md)。

0.5.17 坐标指针动作新增必需步骤：`browser_prepare_coordinate` → 核对返回目标 → 使用一次性 `coordinateToken` 调用 `browser_action`。旧客户端需刷新工具列表；服务与扩展需配套升级。

浮层、坐标与交易结果的当前保障及待完成项见 [操作可靠性说明](docs/ACTION-RELIABILITY.md)。点击已派发不等于业务成功；故障诊断对租用等操作返回待核验凭据，不授权自动重放。

## 能做什么

AI Browser Bridge 是一个本机优先的浏览器操控编排层，服务与扩展配套运行。它不内置云模型；任意支持 MCP、HTTP 或 CLI 的 Agent 都可以接入。

- 读取网页正文、交互控件、页面状态和受限截图。
- 点击、填写、选择、滚动、上传、下载、导航和关闭标签页，并对关键写操作做结果验证。
- 处理 iframe、重型 SPA、虚拟滚动、下拉框、广告、引导层、客服浮窗和透明遮挡。
- 通过 DOM、Accessibility、Debugger、截图和坐标适配器进行分层兜底；没有 GPT 时仍可使用本地确定性工具链。
- Windows 0.5.24 候选支持停靠式 DevTools 观察，以及在用户已打开 DevTools 后选择 Elements/Console/Network 面板；由于 UIA 负证据与全局 F12 焦点竞态，当前候选不自动打开 DevTools。
- `browser_devtools_capture` 通过 CDP 在单次 attach 的有界窗口内只读捕获 Console 消息、异常、Network 请求行、Sources 脚本列表和 Performance 指标；空结果不证明没有发生，网络记录不含 header/cookie/body，缓冲溢出以 `dropped`/`truncated` 计数上报。
- 仍未实现：请求重放、脚本编辑、断点调试、Console 输入执行、Chrome 设置修改、分离 DevTools 绑定和下载落盘核验。
- 支持多 Agent 队列、优先级、等待状态、标签页写租约、租约续期和服务重启恢复。
- 支持上传目录白名单、SHA256 校验、Agent 作用域、origin 白名单、内容边界和审计脱敏。
- 提供 `doctor`、`browser_health`、`browser_execution_profile`、网络/性能诊断和本地滚动日志。
- 真实 Chrome 本地 fixture 验收可通过 `npm run test:devtools` 运行；该用例仅操作并关闭自身创建的测试标签。
- 默认本机监听 `127.0.0.1`，不直接暴露公网；高风险网页内容按不可信输入处理。

完整能力基线、限制、验收指标和升级目标见 [产品路线图](docs/PRODUCT-ROADMAP.md)；新 Agent 接入规则见 [AGENTS.md](AGENTS.md)。

### 发布与版本管理

- 发布历史：[GitHub Releases](https://github.com/love530love/ai-browser-bridge/releases)。源码与本机部署版本以 package.json 和 doctor 为准；推送提交不等于创建 Release。
- 所有版本：[GitHub Releases](https://github.com/love530love/ai-browser-bridge/releases)
- 版本号必须同时更新 `package.json`、`package-lock.json`、`extension/manifest.json` 和 `CHANGELOG.md`，再创建同名 Git tag 与 GitHub Release。
- Release 必须包含变更、验证结果、升级步骤和已知限制；只有“已实现并有测试或实测证据”的能力才可列入已完成清单。

### 当前版本升级指南

0.5.10：在 0.5.9 基础上增加 SPA 零尺寸布局诊断、视口回退和坐标动作安全等待，避免客服浮窗等图标控件被盲点。完整历史见 [CHANGELOG.md](CHANGELOG.md)。

下一阶段的一次性重构与 Python 数据自动化接入方案见 [一次性升级与验收方案](docs/ONE-SHOT-UPGRADE-PLAN.md)。该文件区分已实现能力、实施批次和验收证据；计划内容不会自动视为当前版本功能。


### 远程沙箱与 VNC 登录边界

AI Browser Bridge 默认是本机桥接，不是公网浏览器网关：HTTP 服务只监听 `127.0.0.1`，Host 必须匹配 `127.0.0.1:端口`，普通网站 Origin 会被拒绝。隔离沙箱里的 agent 不能直接接管你电脑上已经登录的 Chrome。

如果 agent 在云端/沙箱里工作，推荐让它在沙箱内运行自己的一套 bridge + Chrome + extension，并通过 VNC/noVNC 让用户在那台沙箱 Chrome 登录目标网站。登录态只留在沙箱 Chrome 中。不要建议用户把本机 `19387` 端口直接暴露到公网；如确需远程访问，应另行设计带认证、审计、来源限制和明确用户授权的隧道层。
### 历史：从 0.1.0 更新到 0.1.1

如果加载的是本项目的 `extension` 文件夹，在 `chrome://extensions` 找到“自主浏览器”，点击重新加载，然后重新打开扩展面板。配对密钥和已保存的网站列表保留；未设置过 `allSites` 的旧配置默认启用所有网站。确认“允许所有网站（默认）”已勾选，点击“保存并连接”。如 Chrome 显示新增网站权限提示，按提示确认。若从其他目录解压安装，请用新扩展包更新那个目录后重新加载。

0.1.1 的连接状态和最近操作通过事件自动更新，无需持续点击刷新。原 0.1.0 桥接服务与新版扩展兼容，不必为了升级扩展断开正在使用的服务。

没有内置模型、开发者云端、遥测或 AutoGLM 依赖。浏览器控制在本机完成；接入的 AI 若运行在云端，返回给它的网页内容仍会进入该 AI 的服务。普通封闭聊天窗口不会因为安装扩展就自动获得工具能力。

## 默认无人值守策略

默认目标是让 WorkBuddy、Copilot、Codex、Qoder 等任意 MCP/HTTP Agent 接上就能稳定使用，不要求用户反复值守：

- 首次只需要加载扩展、运行 `pair.ps1` 并保存连接；之后保存配对密钥，扩展和服务会后台重连。
- 默认允许所有 HTTP / HTTPS 网站，减少小白用户逐站配置成本；需要收紧时再切到 origin 白名单。
- 多 Agent 冲突、队列满和扩展临时断线默认返回 `status:"waiting"`、`retryable:true`、`suggestedDelayMs`、`nextPollTool` 和 `recommendedNextAction`，调用方应等待/轮询，不应把它当成任务失败。
- 读类工具有 DOM/时间预算并返回 `diagnostics`；重页面可先用 `browser_find_text` 定位关键词，也可用 `browser_read mode:"cheap"` 获取轻量摘要。外层读超时只失败当前读请求，桥保持在线；写类工具超时仍按未知结果处理，避免自动重放误操作。
- 任意 agent 首次接入先读 `browser_agent_guide`；使用 `browser_queue_status` 查看 active/queued/connected 状态；等待恢复时调用 `browser_wait_until_ready`；共享 tab 的多步写任务用 `browser_claim_tab`，无人值守场景建议带 `wait:true`，长任务可用 `browser_renew_tab` 心跳，写工具带同一个 `agent` 会自动续租，结束后 `browser_release_tab`。
- 上传仍要求本机 allowlisted upload root 和 SHA256，这是少数必须显式配置的安全边界。

## 已实现

- 网页可见正文提取、交互元素编号、点击、文本输入、主页面滚动。
- 在显式许可的本机目录内，按完整 SHA256 将文件绑定到最新 file-input ref；只选择文件，不自动点击提交。
- 标签页列举、新建、导航、关闭；通过临时 debugger 连接截图，完成后释放。
- Chrome 中文控制面板：配对、网站授权、连接状态、最近操作、暂停与重新连接。
- MCP stdio、带认证的本机 HTTP API、CLI 三种入口；不绑定模型厂商。
- 默认允许所有 HTTP / HTTPS 网站；关闭“允许所有网站”后按完整 origin 列表检查。拒绝 `file:`、`javascript:`、Chrome 内部页和带账户信息的 URL；浏览器保护的页面仍受 Chrome 限制。
- 命令全局顺序执行；失效元素引用与改变了标签/链接的元素会拒绝操作。多客户端共享同一标签页时，可用 `browser_claim_tab` 获取强制写租约；租约有效期间，写操作必须传入匹配的 `agent`，读操作仍可观察。
- 可选的 Chrome 内置模型协助：`browser_ai_status` 检测本机 Chrome 内置 AI，`browser_local_judge` 用它在本地把一个拟执行动作判为 allow/warn/block/unsure，**模型不出本机、也不执行动作**。治理可配置 `judge:"require"`，让某个 agent 的写操作必须先拿到 `allow` 裁决；模型不可用则拒绝写入（fail-closed）。
- 可选的多 agent 治理：用 `node src/cli.js agent set <name> '{"scopes":["read"],"origins":["example.com"],"maxLeaseMs":60000}'` 注册具名 agent 后，超出作用域的写入/上传/认领租约、白名单外的导航都会被服务直接拒绝并返回 `status:"denied"`、`reason`、`retryable:false`，租约时长会被钳制到上限；未注册或未具名的调用保持默认开放，不会削弱单机使用。所有工具都接受可选 `agent`，建议读操作也带上以便审计归属。同一份策略还可配 `tools.allow/tools.deny`（工具级白/黑名单）、`judge:"require"`（写前过本机模型，默认 `judgeTtlMs` 120s）、`contentBoundaries:true`（读输出加不可信内容边界）。策略存放于 `.local/agents.json`，运维改动无需重启。
- 断线和超时不自动重放写入；断线后的新请求返回 waiting 恢复指引，已派发或排队的未知结果命令仍失败返回。暂停不撤销已经执行的操作。扩展保存配对密钥后会在后台自动重连，不需要 AI 自动打开扩展设置页。
- 日志仅记录操作名称、标签页编号、调用方 agent 名、时间和成功/失败，不记录输入内容、正文、截图或密钥。

## 本机启动与安装

要求：Node.js 22+、Chrome 120+。**不需要会命令行**：每个 `.ps1` 都配了同名 `.bat`，双击即可运行。

本机已安装依赖；迁移到另一台电脑时先在项目目录运行 `npm ci`。

1. **双击 `start.bat`**。服务只监听 `127.0.0.1:19387`，后台运行。再次启动会先检查已有服务，不会重复启动。
2. 在你希望使用的 Chrome 用户配置中打开 `chrome://extensions`，打开右上角的**开发者模式**开关，点左上角“加载已解压的扩展程序”，选择本项目的 **extension 文件夹**。
3. **双击 `pair.bat`**，密钥会复制到剪贴板（不会打印）。点击浏览器工具栏右上角的**拼图图标 → 自主浏览器**（若被折叠，先点拼图图标把它固定出来），粘贴配对密钥。
4. 默认勾选“允许所有网站”，无需填写网站列表，点击“保存并连接”，状态会自动更新为“已连接”。若只想操作部分网站，取消勾选并逐行填写源地址，例如 `https://example.com`，再保存。路径不能填写；不同端口属于不同 origin。
5. **双击 `status.bat`**。只有 `connected: true` 才表明当前 Chrome 扩展实际连接成功。

### 瞄一眼就知道通不通：工具栏角标

| 角标 | 含义 | 该做什么 |
|---|---|---|
| `ON`（绿） | 已连接 | 直接用 |
| `...`（黄） | 正在连接 | 稍等几秒 |
| `OFF`（灰） | 已被暂停 | 点图标 → “重新连接” |
| `?`（红） | 配对密钥不匹配 | 重跑 `pair.bat` 再粘贴 |
| `2`（橙） | 服务已被**另一个 Chrome 配置**占用 | 先在那边断开 |
| `!`（红） | 服务没起来或连接断开 | 双击 `start.bat`；扩展会后台自动重连 |

出问题时还会弹一次系统通知（同一类问题 10 分钟内至多一次），不用盯着角标等。

现有 AutoGLM 无需卸载。建议不要让两个自动化工具同时操作同一个标签页。每个服务只连接一个 Chrome 用户配置；第二个配置会被拒绝，并在角标上显示 `2`，不再只是无意义地转圈。

扩展更新后，在 Chrome 扩展页点“重新加载”。已保存配对密钥且未暂停时，扩展会在后台自动重连；连接成功时每 20 秒发送一个纯本机保活消息，**不会调用模型或消耗模型 token**。AI 客户端诊断断线时只应读取 `npm run status` 或 `GET /status`，不要自动打开 `chrome-extension://.../panel.html`。

## 开机 / 关机后的必要操作

服务注册为登录自启后，日常使用**不需要任何手动操作**。下面分「一次性设置」和「日常」两部分。

### 一次性设置（每台机器只做一次）

**双击 `install-autostart.bat`**。

启动入口使用 PowerShell 7 并遵守机器原有的脚本执行策略。若被策略或安全软件拦截，应保留报错并排查，不自动添加排除项、降低策略或恢复隔离文件。参见 [2026-10-19 告警记录](docs/SECURITY-INCIDENT-20261019.md)。

默认在用户「启动」文件夹放一个快捷方式，运行隐藏的 PowerShell 7 健康守护程序。可以在「任务管理器 → 启动应用」里禁用；组织安全软件仍可能限制启动。

两种方式均隐藏运行。如需注册表方式：

```powershell
.\install-autostart.ps1 -Method Registry
```

安装会立即启动守护程序，并注册以后登录时启动。它约每 10 秒检查认证状态，服务未监听时尝试启动，失败退避至最多 60 秒；命名互斥锁避免重复守护。当前状态写入 `.local/watchdog-status.json`，状态变化写入可轮转的 `.local/watchdog.jsonl`。安装命令完成不等于连接验收通过，使用 `npm run doctor` 确认。

运行期调用、连接恢复、队列等待、权限拒绝和错误分类会自动追加到 `.local\logs\audit.jsonl`；单文件超过 10 MB 时滚动为 `audit.1.jsonl`。这些日志用于下一次版本升级的回归分析，不包含页面正文、输入值、Cookie 或 Authorization。

撤销：双击 `uninstall-autostart.bat`。它会清掉快捷方式、注册表项和生成的启动器，但**保留配对密钥和你的配置**。

此外，扩展只需要加载 `extension/` 并用 `pair.bat` 配对**一次**；密钥保存在扩展里，之后自动重连。

### 每次开机 / 重新登录后

什么都不用做。登录 Windows 时服务自动起来，打开 Chrome 后扩展自动连上，不需要再跑 `start.bat` 或 `pair.bat`。

想确认就双击 `status.bat`，看到 `"connected": true` 即可。

### 关机 / 重启 / 合盖

守护程序运行且依赖正常时，休眠唤醒后继续检查与恢复；恢复期间 AI 报 `waiting` 属正常，不要重复提交不确定的写操作。端口被占用、配置损坏或扩展被禁用不能承诺自动恢复，日志会区分这些情况；守护不会杀死未知进程或修改配对信息。

主动停止：双击 `stop.bat`，同时设置持久暂停标记，避免被守护立即重启。运行 `start.bat` 或重新安装自启动可解除暂停。卸载自启动会使守护在下次检查时退出。

### 状态不对时的排查顺序

先双击 `doctor.bat`，它会直接告诉你卡在哪一层。

| 现象 | 处理 |
|---|---|
| 服务未监听、`fetch failed` | 查看 `.local/watchdog-status.json`；可双击 `start.bat`，反复失败检查 `.local/server-error.log` |
| 服务在跑但 `connected: false` | 扩展被暂停（角标 `OFF`）：点图标 → “重新连接” |
| 角标 `?` | 配对密钥不匹配，重跑 `pair.bat` 再粘贴 |
| 角标 `2` | 另一个 Chrome 配置已占用，先在那边断开 |
| 扩展卡着红色 `Errors` | 只是历史错误残留，不影响使用。等几分钟或在 `chrome://extensions` 点 Reload |
| 换电脑 / 重装系统 | `npm ci` → `start.bat` → `install-autostart.bat` → `pair.bat` |

> 所有 `.ps1` 都不再要求 PowerShell 7，Windows PowerShell 5.1 也能直接运行。

## 让其他 AI 接入

### MCP 客户端

`npm run setup` 会生成 `.local/mcp-config.json`，包含当前机器的 Node 可执行文件路径与 MCP 入口，不含密钥。将其中的服务器条目加入支持 stdio MCP 的客户端配置并重载连接。不同客户端的外围配置格式可能不同。

```json
{
  "mcpServers": {
    "ai-browser-bridge": {
      "command": "node",
      "args": ["K:/PythonProjects5/AI-Browser-Bridge/src/mcp.js"]
    }
  }
}
```

MCP 入口不会启动云模型。客户端自己决定下一步调用哪个工具。`tools/list` 暴露 45 个工具，`browser_screenshot` 返回 MCP 图片内容。

### CLI 客户端

```powershell
node src/cli.js tools
node src/cli.js call browser_tabs
'{"url":"https://example.com"}' | node src/cli.js call browser_open --stdin
'{"tabId":123}' | node src/cli.js call browser_read --stdin
```

必须使用实际返回的 tabId 和 ref，不能照抄示例中的 123。元素 ref 与最近一次快照绑定；导航或页面变化后重新读取。

### HTTP / 自己的 AI 程序

端点：`GET /status`、`GET /tools`、`POST /call`。请求头使用 `Authorization: Bearer <agentToken>`，令牌从本机 `.local/config.json` 读取。不要把配对密钥当成 agentToken，也不要把令牌贴到对话中。

```json
{"name":"browser_read","arguments":{"tabId":123,"maxChars":12000}}
```

服务拒绝网页 Origin 请求、错误 Host 和未认证请求，不提供浏览器可用的跨域开放接口。远程 AI 客户端需要本机适配器；本版本不提供公网网关。

## 验证与边界

```powershell
npm test
npm run test:e2e
```

自动测试使用独立临时 Chromium 配置和本地测试网页，不读取个人 Chrome 数据。端到端测试通过 MCP 完成打开、读取、填写、点击、截图、导航、暂停、恢复及关闭，并由独立 HTTP 客户端验证第二条接入路径。截图与报告在 `output/playwright/`。

本机测试脚本会优先使用已存在的 Playwright Chromium；其他机器可运行 `npx playwright install chromium`，或用 `AIB_TEST_CHROMIUM` 指向测试专用 Chromium。不要指向你的日常 Chrome 用户数据目录。

明确边界：

- 测试通过不等于已经装入你的日常 Chrome。实际连接以 `npm run status` 为准。
- 当前 DOM 操作限主框架和普通 DOM；尚未覆盖 iframe、Shadow DOM 的结构化定位、验证码和复杂富文本编辑器。文件上传支持主框架普通 DOM 的 file input；坐标操作可触达可见区域，但不提供 Canvas 结构化解析。
- 原有输入/点击使用 DOM 事件；新增键盘和坐标路径使用 CDP 可信事件。截图使用 debugger 权限，Chrome 可能显示调试提示；与其他调试器冲突时返回错误。
- 内置任务期间持有全局操作租约；外部客户端编排同一标签页的多步工作流时，应先 `browser_claim_tab`，后续写工具传入同一个 `agent`，完成验证后 `browser_release_tab`。
- 指定网站模式约束工具的直接目标，**不是网络防火墙**。网页自身的脚本仍可能提交表单、发网络请求或跳转到其他网站；指定模式下未授权页不能继续读写，所有网站模式可继续操作其他 HTTP / HTTPS 页。截图包含页面中可见的嵌入内容。
- 文本提取不读取密码输入值，忽略隐藏文本与 `data-ai-private` 标记区域；截图没有自动脱敏。不能将其理解为完整敏感信息检测。
- 页面内容属于不可信数据，AI 客户端不得将网页中的指令当作用户授权。点击可能导致提交、发消息或购买，客户端必须遵守用户授权范围。
- `browser_local_judge` 只是可选的本地 Chrome 内置 AI 建议源。它不执行动作，也不替代用户授权；如果 Chrome 没有暴露 Built-in AI API、模型未下载或会话创建失败，会返回 `verdict: "unavailable"`，调用方必须按无裁判可用处理。首次本地模型会话可能较慢，服务端对该工具使用 120 秒专用超时。调用方必须检查 `schemaValid`、`parseWarning` 和 `needsHumanConfirm`，不得把非标准模型输出当作批准。
- 已有插件任务助手，模型在本机配置文件设置；尚无完整多轮聊天和模型管理界面。外部 AI 仍可独立调用工具。没有声称已全面超过 AutoGLM。

## 文件与运行状态

| 位置 | 用途 |
|---|---|
| `extension/` | 可直接加载的 Chrome 插件源码 |
| `src/server.js` | 本机 HTTP / WebSocket 桥接、排队、鉴权 |
| `src/mcp.js` | MCP stdio 适配 |
| `src/cli.js` | 命令行入口 |
| `.local/` | 本机密钥、日志、PID、接入配置，不进入分发包 |
| 各 `.bat` | 双击入口：`start` / `stop` / `pair` / `status` / `doctor` / `install-autostart` / `uninstall-autostart` |
| `install-autostart.ps1` | 注册登录自启，默认启动文件夹，`-Method Registry` 用注册表 |
| `uninstall-autostart.ps1` | 撤销登录自启，清掉所有方式与生成的启动器 |
| `test/` | 服务测试和真实扩展端到端测试 |
| `docs/HANDOFF.md` | 后续开发交接与已知限制 |

停止后台服务：`.\stop.ps1`。不设置开机自启、不修改现有 AI 客户端配置。若要完全停用，也可在 Chrome 中禁用扩展。

## 技术依据

- [Chrome WebSocket 与 service worker 生命周期](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [MCP stdio 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Playwright 扩展测试](https://playwright.dev/docs/chrome-extensions)
\n+0.4.20 增加 `browser_frames` 与 `browser_read frame:"all"`，用于发现和读取 iframe 页面；失败恢复会给出等待与 `browser_prepare_action` 规划建议。跨源 frame 的可访问性由 Chrome 权限决定，结果会明确标注。
# 给新 Agent 的浏览器接入提示词

将下面的提示词放在新 Agent 的任务前置说明中。它让 AI Browser Bridge 成为默认入口，同时保留在桥接不可用或能力不足时安全降级的空间：

```text
浏览器任务默认优先使用 AI Browser Bridge。

先执行 browser_health、browser_tabs、browser_observe。
如果桥接可用，继续使用 Bridge 完成任务，并遵守其队列、租约和验证规则。

如果 Bridge 暂时不可用：
1. 不要反复打开扩展设置或无限重连；
2. 判断任务是否可以安全等待；
3. 如果任务需要底层调试、网络拦截、性能分析或 Bridge 不支持的能力，可以选择 CDP、Playwright 或其他工具；
4. 切换工具前记录原因，并避免同时对同一标签页执行写操作；
5. 对点击、填写、上传、提交等不确定写操作，先重新读取并验证，禁止盲目重放。

根据任务目标和页面状态选择最合适的工具，不要为了遵守工具偏好而牺牲任务完成度。
```

完整的工具顺序、iframe 和遮挡处理、多 Agent 排队规则见本项目的 `AGENTS.md`。
产品能力基线与长期升级目标见 [`docs/PRODUCT-ROADMAP.md`](docs/PRODUCT-ROADMAP.md)。

