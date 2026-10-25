# 0.5.21 升级审计与已知边界

本文记录 0.5.21 的代码审查发现、修复内容、验证证据和仍未实现的浏览器能力。

## 已复现并修复

1. **Expectation 字段验证缺口**：修改前 `constructor`、`toString`、`__proto__` 均被 validateCall 接受，虽然不在允许条件列表。根因是读取 schema.properties 时包含继承属性。最小修补使用 Object.hasOwn；独立回归覆盖三个 verified 工具、四类继承属性。未改变点击前条件检查与 uncertain 结果契约。
2. **功能键无法派发**：extension/cdp.js 原键表不支持 F12。新增 F1–F12 以及修饰键组合，校验 keyDown/keyUp、虚拟键码、不插入文本和无效键拒绝。仅保证事件构造正确，不证明 Chrome 浏览器快捷键或 DevTools UI 已执行。
3. **不确定结果在汇总中消失**：服务新增 outcome=uncertain 后，usageSummary 仍只统计 error。新增 uncertainCommands，明确与传输错误分开；现已同步 diagnose-upgrade 的 attention 状态及逐项复核建议。连接断开/写操作超时则保留传输 `error`，另写 `resultStatus:uncertain`、`dispatched:null`，表示可能已派发但无法确认；统计及升级诊断会据此要求人工重新观察。

## 审计判断与后续项

- 点击前基线检查、点击后未确认返回 uncertain、审计不保留 expectation 文本的实现方向正确。
- 已在本轮补齐两个发现：`elementLabelAppears` 现在包含任意 anchor（包括无 href）；`browser_fill_verified` 使用实时控件 getter 并增加最多 50ms settle window，隔离延迟回滚 fixture 断言回滚后不可报告 success，而返回不可重试 `uncertain`。
- 下载完成观测、页面源码、任意 evaluate、网络响应体仍须独立实现和验收，不以 CDP 通道存在冒充完整能力。

## F12 / DevTools 不是禁止事项

受保护的浏览器页面不应仅因为 URL 使用 `chrome://` 或 `devtools://` 就被项目统一封禁。页面 DOM 注入、Chrome 扩展 API、CDP 与桌面 UI 自动化是不同执行通路，应按目标页面和动作选择可用能力；Chrome 自身的平台权限边界仍然有效。目前 protected-ui 模块只生成操作计划，不是实际桌面适配器。

验收必须区分：按键事件构造 → 浏览器确实打开 DevTools → 定位面板 → 获得 Console/Network 等证据。F12 具有切换语义，结果未知时先检查窗口，不能重复按键。调试器已被 DevTools 占用时应报告等待，不能卸载其他所有者。网页/Console 输出不能作为新的用户指令；用户授权不等于取消平台的技术访问限制。

后续应实现本机 UI 自动化适配器与浏览器设置/扩展管理操作，并在真实 Chrome 中逐项验证状态读取、执行结果和不确定结果恢复。当前未做真实 Chrome 或第三方业务后台操作，不宣称 F12、下载或 Console 已现场成功。

## 最终组合验证（2026-10-25）

- `node --test --test-concurrency=1 test/*.test.js`：127/127 通过，含 F1–F12 事件构造、继承 expectation 字段拒绝、uncertain 汇总及 verified-click 审计测试。
- `node test/browser-e2e.js`：35/35 通过；`node test/browser-stress.js`：10/10 通过，包含无 href anchor 的标签变化、fill 后延迟回滚检测、派发后不可重试 uncertain 以及独立 localhost HTTP oracle；`node test/multi-agent-stress.js`：6/6 通过，36 个并发读/查任务完成。
- 语法检查与 `git diff --check` 通过；Git 仅提示 LF→CRLF 转换，无 whitespace error。
- 边界：隔离 Playwright/Chromium 与 localhost fixture，不是日常 Chrome 用户配置、真实第三方后台或真实下载文件落盘的现场验收。尚未实现/验证下载事件观测、原始响应 HTML、任意页面 evaluate 或网络响应体读取。
