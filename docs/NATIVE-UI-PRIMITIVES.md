# 原生 Chrome UI 原语（开发增量，2026-10-27）

## 已实现：browser_native_snapshot

先使用 `browser_desktop_windows` 取得当前 PID/HWND，再调用
`browser_native_snapshot({processId, windowHandle, agent})`。

返回最多 400 个可见原生控件，包含 runtime ref、父节点、名称、角色、
AutomationId、enabled 和实际支持的 UIA patterns。遍历有节点和时间预算，
未完成返回 partial；外层 PowerShell 7 子进程另有超时及输出大小限制。
服务入口复用近期窗口验证、窗口重新校验、桌面互斥与精简审计。

该快照不读取 document 子树、表单值、密码或 DevTools 输出。不包含**独立顶层**的
popup 窗口（detached 窗口）；runtime refs 是本次观察身份，不是持久定位符或写操作许可。
UIA 支持某个 pattern 不代表 Bridge 已实现对应动作。

⚠ **已实测修正**：Chrome 自己画的菜单（书签菜单、应用菜单）是浏览器窗口的**子 HWND**，
在 UIA control view 里是窗口的后代，因此菜单展开时 `browser_native_snapshot` **能看到**
它的 `MenuBar / Menu / MenuItem` 树（实测展开书签菜单后控件数 111 → 166，其中 45 个
`MenuItem`，均带 ref）。所以「不含 popup」只对独立顶层窗口成立，对浏览器自带菜单不成立。
这条修正决定了「选菜单项」这一步比原先设想的近得多。

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

## 2026-10-28：browser_native_action（单个原生控件的展开/折叠）

`browser_native_action({processId, windowHandle, ref, action, expect})`，`action` 只有
`expand` / `collapse`。

**为什么没有 Toggle**：F12 那条教训的直接应用——toggle 派发两次就回到原点，所以
「结果不确定」时无法重试。expand/collapse 是**构造上幂等**的：目标状态已经成立时
不派发任何东西并返回 `alreadyInState:true`。这是让「不确定之后重试」变成安全指令
的唯一方式，因此 toggle 不是「还没做」，是「不能做」。

**身份绑定**：`ref` 只是本次观察的 runtime id，树重建后可能被别的控件复用。所以
`expect` 必须重复至少一个从快照读到的属性（`name` 或 `automationId`，可选 `role`），
三个都比对，任一不符即 `native_control_identity_mismatch` 且**不派发**。校验发生在
参数校验层，坏调用连桌面互斥都不会占用。

**证据链**：`stateBefore` 由控件自己读出；派发后 1.5s 内轮询回读（菜单有动画），
`stateAfter` 也是控件自己读出的。`success` 只表示「读回了请求的状态」，pattern 调用
不抛异常**不算**成功。`PartiallyExpanded` 计为 expand 成功（真的展开了，只是子项没全显）。
`LeafNode` 在派发**之前**就拒绝（它根本没有可展开内容）。派发后读不回来 → `uncertain`；
派发后状态没变 → `failed/native_state_not_reached`，两者都不许重按。

**没有焦点竞态**：这里走的是绑定到元素的 `ExpandCollapsePattern`，不是
`SendKeys('{F12}')`，所以不存在「检查焦点」与「按键」之间的 TOCTOU。代价是它打开的
菜单**可能**夺取焦点，但派发本身不依赖前台。脚本里没有任何 `SendKeys` /
`SetForegroundWindow` / `WScript.Shell`，这一点由单测按源码断言钉住。

**未实现**：Invoke、Select、Toggle、Value、Scroll。选菜单项需要 Invoke + 同一套前后
证据，属于下一轮。

验证：`npm run test:native`（`test/live-native-action.js`）真机 **13/13**；
`test/native-ui-action.test.js` 单测 **10/10**。真机记录：`All Bookmarks`（view_1026）
Collapsed→Expanded（settleMs 161）→ 独立快照确认为 Expanded → 45 个 MenuItem 可见 →
Collapsed → 独立快照确认 Collapsed → 没有留下打开的菜单。同时证明：不存在的 ref 与
名字不符的 ref 都 `not_dispatched`，只给 role 的 ref 在校验层就被拒。

## 下一条执行链

1. ~~对近期快照 ref 绑定的原生控件执行 Expand/Collapse，回读展开状态。~~ 已完成（0.14.0）。
2. **Invoke**：展开后菜单项已在快照里，下一步是绑定 `MenuItem` 的 ref 做单次 Invoke
   并回读菜单是否关闭；这是打开 DevTools 面板的真正入口，也是「设置项」的第一块。
3. 从实际菜单树选择开发者工具入口，验证目标页面与 DevTools 文档。
4. 对 Select、Toggle、Value、Scroll 原语分别补前后证据与异常结果。Toggle 若要实现，
   必须先解决「重试会反转」——例如只暴露 SetState 式的语义，不暴露裸 toggle。

未恢复有焦点竞态的全局 F12 路径。未声称已完成 Console 执行、设置修改或完整人类等价能力。
