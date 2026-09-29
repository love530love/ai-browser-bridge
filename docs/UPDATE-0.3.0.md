# 0.3.0 原生受限文件上传

## 事故驱动

FlagOS Task 108 r2 自动化已经进入上传步骤，但使用旧截图坐标点击上传区时落空。
页面滚动位置、DPI、调试器附加和叠加文件对话框都会让桌面坐标链失效。根因不是
“需要更多坐标 fallback”，而是桥接缺少文件上传原语。

## 新能力

`browser_upload` 使用最新 `browser_read` 产生的 file-input ref，把文件直接选择到
网页 DOM，不打开 Windows 文件对话框。安全约束：

- 本机服务只读取 `uploadRoots` 明确许可目录下的真实文件；使用 `realpath` 阻止
  `..` 和符号链接越界；
- 调用者必须给出完整 SHA256，读取后的实际 SHA 不一致即拒绝；
- 大小限制为 1 byte 至 16 MiB；
- 本地绝对路径不会发送给扩展或网页，只发送文件名、类型、大小、SHA 和文件内容；
- 审计只记录工具、tabId、结果类别和工件 SHA，不记录路径或内容；
- 工具只触发 input/change 事件，不点击“提交”或其他网页按钮；
- ref 过期、结果未知或页面未显示文件名时禁止自动重放，必须重新读取和对账。

配置示例：

```powershell
.\agent.ps1 allow-upload-root 'K:\PythonProjects5\FlagGems-sglang\submissions'
```

## 验证

- 服务与安全测试：14/14；
- 隔离 Chromium 端到端：25/25；
- 覆盖隐藏 file input、目录限制、SHA 不匹配拒绝、路径不泄漏、旧 ref 拒绝；
- 日常 Chrome 仍必须在服务重启、扩展重新加载后单独验收，源码测试不等于已部署。

## 日常 Chrome 部署验收（2026-09-29）

- 服务版本 `0.3.0`、扩展版本 `0.3.0`、`connected=true`；
- Cursor 与 WorkBuddy 的 stdio 注册均发现 16 个工具；
- 日常 Chrome 在新建 localhost 测试页中，成功将白名单目录内的
  `topk_sigmoid_vendor_r2.zip` 按完整 SHA256 选择到隐藏 file input；
- 全程未打开系统文件对话框，未点击任何提交按钮，测试页关闭后无外部副作用；
- 同次实机测试通过读取、填写、点击、滚动、截图和跨 localhost origin 导航；
- 报告：`output/live-installed/report.json`，`completed=true`。

## 0.3.1：自定义下拉框精确选择

T108 r3 自动流程在文件上传之前失败：填充搜索后使用 ArrowDown/Enter，没有可靠
选中 Task 108。0.3.1 新增 `browser_choose`，以最新 combobox ref 和完整可见选项
文本为输入，通过 MutationObserver 等待 option，精确匹配后只点击一次，并返回输入
框观察值。找不到精确选项时安全失败，不回退到键盘序号或坐标。

隔离验证更新为：14/14 服务测试、26/26 Chromium 检查。

## 0.3.2：已展开下拉框修复

真实 FlagOS 验证发现：当搜索结果已经展开时，0.3.1 会再次点击 combobox，导致
Element Plus 弹层被反向关闭，随后报 `Exact visible option not found`。0.3.2 改为
先复用当前可见的精确选项；只有找不到时才点击打开下拉。自动化脚本必须从最新
`browser_read` 的 `role=option` 元素派生规范化文本，不得自行拼接页面展示标签。

隔离验证更新为：14/14 服务测试、27/27 Chromium 检查，其中新增“下拉已展开”
回归场景。

## 0.3.3：开发者诊断能力

新增只读 `browser_debug`。它不产生页面写操作，返回 readyState、焦点、滚动位置、
可见 option、combobox、file input、dialog、iframe 和 role 计数。Agent 在下拉框、
上传区、SPA 空读、遮挡或扩展状态不明时，应先用它定位现场，再决定是否读取、等待、
选择或要求人工确认；不得用轮询脚本长期空转，也不得把坐标和键盘 fallback 当作
确定性流程。

## 0.3.4：Chrome 内置 AI 本地裁判

新增只读 `browser_ai_status` 与 `browser_local_judge`。前者检查扩展上下文中是否
暴露 Chrome Built-in AI / Prompt API；后者在模型可用时将用户目标、页面观察和拟执行
动作交给本地模型，要求返回 `allow`、`warn`、`block` 或 `unsure` 的 JSON 建议。

该能力是 advisory guardrail，不是执行器、不是用户授权、也不是最终事实裁判。若 API
不可用、模型未下载、会话创建失败或返回非 JSON，工具会返回 `verdict: "unavailable"`，
调用方必须进入普通确认或保守路径。

## 0.3.5：本地裁判冷启动超时修复

真实日常 Chrome 验收显示 `LanguageModel.availability()` 可返回 `available`，但首次
`browser_local_judge` 会话/推理可能超过普通网页操作的 20 秒超时，导致连接被保护性
断开。0.3.5 为 `browser_local_judge` 设置 120 秒专用超时，并在超时报错中包含工具名。
普通网页读写仍沿用较短超时，避免未知写操作长时间悬挂。
