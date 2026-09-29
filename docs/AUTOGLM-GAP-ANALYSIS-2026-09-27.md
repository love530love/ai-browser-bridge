# AutoGLM 与自主浏览器功能差距审查

日期：2026-09-27。对象：本机 AutoGLM 0.1.6 与自主浏览器扩展 0.1.1。

**结论：我们的浏览器工具连接与基础操作已跑通，但完整聊天产品、复杂页面操作和多步骤任务管理仍有明显缺口。默认全网站权限只扩大可访问范围，不会自动补齐这些能力。**

## 找到的文件与证据范围

AutoGLM 安装目录：

`C:\Users\love\AppData\Local\Google\Chrome\User Data\Default\Extensions\jelniggicmclhfgnlapbkgfibmgelfnp\0.1.6_1`

共 241 个文件，未发现 `.map`、`.ts` 或 `.tsx` 文件。主要代码是 webpack 压缩后的发布 JavaScript，不是完整原始开发仓库。

| 文件 | 字节数 | 本次用途 |
|---|---:|---|
| `manifest.json` | 见 inventory.json | 权限、快捷键、入口声明 |
| `static/js/background.js` | 1,083,305 | 动作分发、CDP 输入、文件与任务处理 |
| `static/js/main.js` | 4,418,951 | 侧边栏、流式聊天、远端服务调用 |
| `static/js/content.js` | 465,648 | 页面注入及共享模块 |
| `static/js/workflow.js` | 724,831 | 工作流 UI 构建包；不能仅凭文件名推断全部工作流能力 |
| `static/js/options.js` | 990,598 | 配置界面构建包 |
| `prompts.json` | 见 inventory.json | 翻译、解释、段落/全文总结等模板名称 |

只读检查安装资源；未修改 AutoGLM，未读取其 cookies、用户存储、账号或对话。保留了文件 SHA256、关键片段、UTF-16 字符偏移及原文件行号：

- `docs/research/autoglm-0.1.6/inventory.json`
- `docs/research/autoglm-0.1.6/evidence.json`，证据编号 A01–A24。
- 可复查脚本：`node scripts/audit-autoglm.mjs [安装目录]`。

证据分级：**实现证据**表示存在具体本地执行分支；**入口证据**表示有 UI/接口/模板；**待实测**表示未验证实际效果。静态代码存在不等于该功能在当前账户、所有站点均可用。

## 功能对照

| 能力 | AutoGLM 本地证据 | 我们当前状态 | 应补内容 / 优先级 |
|---|---|---|---|
| 持续侧边栏对话 | A01：sidePanel 设置和打开；A15–16：会话/请求 ID、流式结果与取消读取 | 只有连接设置弹窗，无聊天 UI；外部 AI 经 MCP 控制 | 页面问答侧边栏、消息流、选定页面上下文、引用来源。P1，若用户优先需要插件内聊天可提前 |
| 浏览器级鼠标与键盘输入 | A02–06：Input.dispatchMouseEvent、dispatchKeyEvent、insertText、组合键、拖拽、悬停、滚轮 | 点击用 `el.click()`，输入用 value setter + DOM input/change；debugger 只用于截图 | DOM 与 CDP 双通道；Enter/Tab/快捷键、双击、右键、拖拽、悬停、坐标滚动。P0 |
| 下拉框与复杂表单 | A09：点击下拉项后输入选项并 Enter 的执行分支 | 读取可枚举 select，但没有 select 工具；checkbox/radio 可尝试点击，无明确设值和结果验证 | select、check/uncheck、按键、焦点与输入结果验证。P0 |
| iframe / Shadow DOM | A07：shadowRoot 遍历；A08：getAllFrames + frameIds，有特定域名分支 | 仅主框架普通 DOM；只返回 iframe 数量 | 带 frame/document 的元素引用、开放 shadow root 遍历、跨 frame 定位与权限检查。P0；AutoGLM 的通用覆盖仍待实测 |
| 富文本与站点适配 | A24：飞书等特定站点的粘贴/键盘事件分支 | contenteditable 直接替换 textContent，复杂编辑器未验证 | ProseMirror/Quill/Slate 等按实际需求建立夹具；保留格式、分段输入及兼容策略。P0/P1 |
| 等待页面和结果 | A22：readyState 等待；动作分发存在 bounded wait | open/navigate 立即返回；没有 wait-for-element/text/navigation 工具，测试脚本自行重试读取 | 事件驱动等待、SPA 更新/元素可操作判定、动作后置条件。P0 |
| 文件上传下载 | A10–11：upload_file 路由、File/DataTransfer/输入赋值；A12：downloads API 与状态事件 | 明确拒绝 file input，无上传/下载工具 | 本机文件句柄/允许目录、上传完成校验、下载 ID/状态/结果；不必照搬远端上传。P1 |
| 标签/窗口管理 | A13–14：后退/前进、分组；manifest 和代码含窗口 API | 只有列表、新建、导航、关闭；无切换、后退、前进、刷新、分组 | 先补激活/后退/前进/刷新；任务关联标签与窗口，避免操作错误页面。P0/P1 |
| 多步骤任务状态 | A23：sessionId/taskId/round/任务标签集合；A18：需要登录；A17：敏感操作状态返回 | 单命令队列，20 秒执行超时，断线丢弃待执行队列；暂停不撤销在途动作 | task/session ID、任务详情、进度、取消待执行项、人工接管、明确可恢复点。P0/P1；不能据字段证明 AutoGLM 可跨崩溃恢复 |
| 多 AI 协作 | AutoGLM 有任务会话字段，未证明跨客户端工作流互斥 | 多 MCP/HTTP 客户端可调用，但多步工作流会交错；一个浏览器连接；共享 agentToken | 按客户端标识、标签页租约、工作流隔离、连接选择。P0；这是我们自身目标的缺口，不是已证明 AutoGLM 已解决的优势 |
| 结果与诊断 | AutoGLM 有动作结果/页面信息与敏感状态字段；完整可视审计覆盖未验证 | 错误主要为字符串；日志只保留动作名和成败；版本协商未实现 | 错误码、执行阶段、unknown outcome、能力/版本握手、可选脱敏前后截图。P1 |
| 网页总结/翻译/多链接处理 | manifest 四个快捷键；prompts 七类模板；A15 可附 URLs、HTML、文件上下文 | 外部 AI 可组合 read 实现，但无一键产品功能 | 选中文本问答、页面总结、双语翻译、多标签摘要、快捷键。P1/P2 |
| OCR / PDF / 文档理解 | A20 有 OCR 服务路由，构建包有 PDF 提取相关代码 | 截图可交给外部多模态 AI，但无内置 OCR/PDF 提取 | 先区分截图理解、PDF文本层、扫描件 OCR；服务算法和效果需另建或调用。P2 |
| 朗读 | A19：chrome.tts.speak/stop 实现 | 无 | 按需增加语音朗读；不是核心操作可靠性的前置。P2 |

## 对我们当前代码的具体检查

1. `src/tools.js` 仅 9 个工具，没有按键、等待、下拉选择、文件、任务或租约接口。对会话网页而言，缺少 Enter/组合键和回复完成事件尤其明显。
2. `extension/page.js` 的候选元素限 a/button/input/textarea/select/部分 role/contenteditable，最多 300 个；没有子树范围查询和分页。不宜把一次正文读取当成完整页面状态。
3. DOM 读取不返回 input 当前值；这是减少泄露的设计，但需要有目的的表单校验接口来确认输入结果，不能让 AI 盲目重复填写。
4. `extension/page.js` 的指纹检查可拦截引用失效和部分标签变化，但无法证明同一节点绑定的业务逻辑没有改变；没有动作级结果断言。
5. `src/server.js` 只串行单条请求。AI A 的读取和点击之间，AI B 可以读同一页并刷新引用，造成 A 的 ref 失效；也可能改变页面语义。需要租约，而不应简单自动重试。
6. `src/server.js` 超时后断开并失败返回是当前可取的保守处理；后续须区分“未开始”“已派发但结果未知”“已完成”。不能把超时简单归为未执行。
7. `src/mcp.js` 没有向 HTTP/队列传播调用取消与 client identity；取消 MCP 请求不等于撤销已排队浏览器操作。应在明确取消语义后接线。
8. `extension/worker.js` 连接失败需手动重连、只在启动/点击时尝试；可增加有界退避与网络/服务事件恢复，保持无后台模型轮询。不要重放未知结果的写入。
9. 扩展版本已为 0.1.1，服务和 MCP 自报 0.1.0；目前协议兼容，但没有扩展版本/功能清单握手，诊断时容易误判。应区分各组件版本并报告实际连接者版本。
10. 当前 agentToken 是服务级单一凭据，缺少每客户端撤销/只读权限和客户端审计。支持“多个 AI 能调用”不等于已实现多 AI 权限管理。

## 已完成与本次未做的事

已重新读取 `output/live-installed/report.json`：2026-09-27T10:27:41.431Z 的实际 Chrome 测试 completed=true，含 MCP 接入、读取/输入/点击/滚动/截图、跨源导航及公网 HTTPS 读取。此前 HANDOFF/VERIFICATION 文档关于日常 Chrome 尚未连接的描述已过时，应以该记录为准。

本次审查没有重新操控浏览器、调用 AutoGLM 云端服务或改动任何运行逻辑。AutoGLM 功能结论以静态实现为限；我们已有运行证据也只覆盖测试中列出的场景。

## 开发顺序与验收标准

### 第一批：把网页操作做可靠

CDP 输入后备、按键/悬停/拖拽/下拉选择、事件驱动等待、iframe/开放 Shadow DOM、标签租约、组件版本握手。

验收：在普通表单、SPA、iframe、Shadow DOM、嵌套滚动和富文本夹具上验证；双客户端竞争同一页时不会交错写入；不确定结果不会自动重复提交。选择实际需要的网站追加人工授权的兼容验收。

### 第二批：把它做成直接可用的 AI 助手

侧边栏流式聊天、当前页上下文、选中文本问答、任务进度、任务取消/人工接管、文件上传下载、多客户端凭据。

模型 API 和操作第三方网页聊天应作为两种适配路线：前者有结构化接口，后者依赖页面布局与登录状态，不能只换一个模型名称就通用支持。

验收：一个多轮页面问答任务和一个包含上传/下载的任务可看到步骤、结果及失败点；模型调用仅在明确触发时发生；验证真实第二种 AI 客户端接入。

### 第三批：增强效率和内容能力

多链接总结、页面翻译、文档/PDF/OCR、工作流模板、语音朗读及更多站点适配。

验收：用固定任务集比较成功率、耗时、人工介入次数和重复操作次数。未完成同条件基准前，不声称全面超过 AutoGLM。

## 自主可控的边界

AutoGLM 发布包中能看到远端 chat/controller/planner/ocr/translate/upload 路由与请求。扩展资产不包含那些服务的完整实现或模型权重。复用其安装文件无法自动得到离线可用的完整 AutoGLM。

适合我们的路径是依据可观察的功能需求独立实现，继续保留本机执行和多模型接口。是否本地推理取决于以后接入的模型；“本机插件”本身不保证所有推理都在本机。
