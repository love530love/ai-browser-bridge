# 0.2.0 升级与使用

本版是可运行的自主浏览器原型。默认所有 HTTP/HTTPS 网站可用，不设商业域名白名单；Chrome 内部页、扩展商店等受浏览器保护的页面仍受 Chrome 限制。网站兼容性取决于页面实现，不能承诺每个网页都能成功操作。

## 更新已有安装

1. PowerShell 7 执行 `& "K:\PythonProjects5\AI-Browser-Bridge\upgrade.ps1"`，重启本机服务，保留配对密钥。
2. 在 `chrome://extensions` 找到“自主浏览器”，点击重新加载。若安装目录是旧 ZIP 的解压目录，先用新包替换该目录；不要替换 AutoGLM 的安装目录。
3. 打开扩展设置，确认“允许所有网站”勾选，点击“保存并连接”。Chrome 如提示新增 sidePanel 权限，按提示处理。
4. 在项目目录运行 `npm run status`：应为 version=0.2.0、extensionVersion=0.2.0、connected=true。只有服务版本正确不等于扩展已升级。

## 两种 AI 接入方式

**外部 AI：**支持 MCP 的客户端加载 `.local/mcp-config.json`，即可发现 15 个工具；其他程序使用本机认证 HTTP API 或 CLI。不需要配置内置模型，也不会产生后台模型调用。普通无工具能力的聊天窗口不能自动接入。

**插件内任务：**将 `model.example.json` 复制为 `.local/model.json`，在本机编辑 baseUrl、model、apiKey。支持 OpenAI-compatible `/chat/completions` 接口，不是所有供应商的原生 API 都通用。`mode: "tools"` 要求模型支持函数工具调用；`vision: true` 还要求模型支持图片。`mode: "autoglm"` 接收 AutoGLM 风格 do/finish 字面量或 JSON 动作，并发送截图，要求相应视觉模型。它只是浏览器动作子集兼容，并非手机代理完整替代。

配置示例使用 localhost 占位地址，需要替换为实际运行的模型服务。不要将 API key 发到聊天中；`.local` 不进入分发包。请求从本机直接发往你配置的模型端点，页面文字和启用的截图会交给该端点。

点击扩展面板的任务助手按钮，选择目标页、输入任务并开始。任务仅操作选定标签页，默认 12 步，最多 30 步、5 分钟；状态由事件推送，空闲不调用模型。任务期间桥接操作由该任务独占，外部客户端会收到忙碌错误。停止会取消模型请求、阻止后续动作；已经执行或正在执行的动作无法撤销。外部客户端自行编排的多步任务仍需自行协调。

API 新增 `GET /agent/status`、`POST /agent/start`、`POST /agent/cancel`，使用现有 agentToken。start 请求体示例：`{"tabId":123,"task":"读取页面标题","maxSteps":12}`，tabId 必须是实际标签 ID。cancel 可传 `{"id":"实际任务ID"}`。任务状态仅在内存保存，不是持久历史系统。

## 新功能与剩余差距

新增可信键盘事件、悬停、原生下拉框、前进/后退/刷新/激活、事件驱动等待、归一化坐标点击/双击/长按/鼠标拖动及输入；工具总数 15。原有 browser_click/browser_fill 仍主要使用 DOM 事件；需要可信事件时使用新键盘或坐标路径。

相对完整 AutoGLM 产品，仍未完成：跨 iframe/Shadow DOM 的结构化定位、上传下载管理、完整多轮聊天和模型管理 UI、多标签自主任务、持久历史与断点恢复。坐标操作不能替代这些结构化能力；验证码、登录和密码仍需人工。

## 验证证据

11 项单元/服务测试和 24 项独立 Chromium 扩展检查通过，涵盖 MCP/HTTP、可信 Enter、选择和悬停、等待、坐标输入、跨源访问、任务独占和取消。侧边栏页面通过真实扩展消息 API → 本地模拟模型 → 真实浏览器动作完成任务。测试将 assistant.html 打开为扩展页面，Chrome 原生侧栏容器的日常使用尚待人工重载后验收。未用真实付费/云模型验收；不得把模拟模型结果当成供应商兼容证明。

报告：output/playwright/e2e-report.json；截图：output/playwright/assistant-task.png。旧版日常 Chrome 实测记录保存在 output/live-installed/report.json，不能当成本版安装验收。
