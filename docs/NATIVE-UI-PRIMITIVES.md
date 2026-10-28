# 原生 Chrome UI 原语（开发增量，2026-10-27）

## 已实现：browser_native_snapshot

先使用 `browser_desktop_windows` 取得当前 PID/HWND，再调用
`browser_native_snapshot({processId, windowHandle, agent})`。

返回最多 400 个可见原生控件，包含 runtime ref、父节点、名称、角色、
AutomationId、enabled 和实际支持的 UIA patterns。遍历有节点和时间预算，
未完成返回 partial；外层 PowerShell 7 子进程另有超时及输出大小限制。
服务入口复用近期窗口验证、窗口重新校验、桌面互斥与精简审计。

该快照不读取 document 子树、表单值、密码或 DevTools 输出。不包含分离的
popup 窗口；runtime refs 是本次观察身份，不是持久定位符或写操作许可。
UIA 支持某个 pattern 不代表 Bridge 已实现对应动作。

### 2026-10-28：控件状态证据

快照新增 `state`：支持 ExpandCollapse 的控件返回 `expandCollapse`
（Collapsed/Expanded/PartiallyExpanded/LeafNode），Toggle 返回 `toggle`
（Off/On/Indeterminate），SelectionItem 返回布尔值 `selected`。
某个 provider 在读取中失效时，该字段为 `unknown`；不支持的 pattern 不返回对应字段。
不读取 Value/Text，因此不会为收集状态额外提取输入框内容。
Node 验证层拒绝状态值非法、状态与 pattern 不匹配以及非约定字段。

验证：原生快照、DevTools adapter、desktop adapter 定向测试 **17/17**；
PowerShell 脚本解析及 UIA pattern 类型解析通过。尚未做本增量的真实 Chrome 验收，
也未部署或新增 Expand/Collapse 写动作。

本机只读实测：121 个控件、1 个 document 子树被排除、partial=false。
找到名称为 Chrome、AutomationId 为 view_1007、支持 ExpandCollapse 的原生按钮；
它是后续菜单展开路径的候选，不能仅凭名称断言已完成菜单或 DevTools 打开。
Chrome 版本变化可能改变这些标识，必须每次观察，不硬编码为跨版本事实。

## 下一条执行链

1. 对近期快照 ref 绑定的原生控件执行 Expand/Collapse，回读展开状态。
2. 将 popup 与所属窗口通过操作系统 owner 链关联，再定位可见菜单项。
3. 从实际菜单树选择开发者工具入口，验证目标页面与 DevTools 文档。
4. 对 Invoke、Select、Toggle、Value、Scroll 原语分别补前后证据与异常结果。

当前新增快照模块尚未部署；未恢复有焦点竞态的全局 F12 路径。
未声称已完成上述写原语、Console 执行、设置修改或完整人类等价能力。
