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

**未实现**：Select、Toggle、Value、Scroll（Invoke 已在 0.16.0 补上，见下）。

验证：`npm run test:native`（`test/live-native-action.js`）真机 **13/13**；
`test/native-ui-action.test.js` 单测 **10/10**。真机记录：`All Bookmarks`（view_1026）
Collapsed→Expanded（settleMs 161）→ 独立快照确认为 Expanded → 45 个 MenuItem 可见 →
Collapsed → 独立快照确认 Collapsed → 没有留下打开的菜单。同时证明：不存在的 ref 与
名字不符的 ref 都 `not_dispatched`，只给 role 的 ref 在校验层就被拒。

## 2026-10-28：跨版本的身份问题（0.15.0）

上面所有原语都建立在「`automationId` 在下次启动时还是同一个」这个假设上，而浏览器升级正是
打破它的那件事。所以 0.15.0 不加原语，先把这个假设变成可检验的：

- **基座现在知道自己驱动的是哪个 Chrome**。`/status` 的 `browserVersion` / `browserMajor` /
  `browserIdentitySource` 来自 service worker 的 UA-CH（`getHighEntropyValues(['uaFullVersion'])`）。
  页面侧拿不到：`navigator.userAgent` 被减缩成 `154.0.0.0`，而 `browser_debugger action:"evaluate"`
  走 `Runtime.evaluate` + `awaitPromise:false`，Promise 不会被等。
- **`scripts/chrome-compat-baseline.js`** 抓基线（只读 `/status` 与本机安装目录，不开标签），
  `--diff` 输出 GONE / NEW / CHANGED。**GONE 即「有代码按那个 id 绑定了控件，必须改成可发现的绑定」。**
  基线只保留有 `automationId` 的控件，名称存 sha256 前 12 位 + 48 字符前缀，不把书签栏抄进文件。
- **`scripts/password-manager-ui.ps1` 改成 `Find-Control`：id 优先 → 角色+可访问名称兜底 → 歧义即拒绝。**
  理由不是「更稳」，而是 `Find-ById` 失败与「控件不存在」不可区分，而这条流程会把密码显示出来。
  命中多个候选时返回 `denied`（`search_input_ambiguous` / `reveal_control_ambiguous`）而不是挑一个——
  按位置挑候选在一条会显示密码的路径上是不可接受的。匹配路径写进 `evidence.lookup`，
  事后能区分「靠 id 成功」和「靠兜底成功」。**这条兜底只解决改名，不解决语义变化**：
  如果 156 把「显示密码」按钮改成菜单项，角色兜底也找不到，那必须重新观察。

156 的公开变更里与本项目相关的只有 IndexedDB 后端迁移（LevelDB+扁平文件 → SQLite，API 不变），
判断与理由见 [CHROME-VERSION-ADAPTATION.md](CHROME-VERSION-ADAPTATION.md)。
**升级未实际应用前不宣称已适配**；基线为 154.0.8037.93，156.0.8078.49 已下载待应用。

## 2026-10-28：invoke（选中一个菜单项，0.16.0）

`browser_native_action` 的 `action` 增加 `invoke`，**必须**同时给 `expect.afterInvoke: "control_gone"`。

**为什么必须带后置条件**：expand/collapse 是幂等的，所以「不确定就重试一次」是安全指令；
invoke 不是——同一个菜单项选两次，命令就跑两次。而 UIA 能观测到的只有「这个控件还在不在树里」，
命令本身执行了什么在这一层完全看不见。所以 invoke 只在调用方声明了它可被判定的效果时才提供，
且 `success` 只表示「声明的后置条件被观测到了」，**永远不表示命令执行成功**。

**证据怎么来**：`controlGone` 由派发后的重新遍历得出，遍历与产生 ref 的那次完全一致
（同一个 walker、同样排除 Document 与 offscreen、同样 400 行 / 3000ms / 深度 32、同一个 `Scan-Tree`）。
菜单关闭时树会重建、runtime id 会变，所以「ref 不见了」不等于「项被选中了」——必须**连续两次**
遍历都找不到同名 + 同角色 + 同 automationId 的控件才算 gone。实测 settleMs 461–625。

**不提供 failed**：`failed` 在 expand/collapse 里表示「派发成功但状态没变」。对 invoke 这个判断
不成立——项还在，只说明没观测到效果，不说明命令没跑。所以 invoke 只有
`not_dispatched` / `success` / `uncertain`，而 `uncertain` 的含义是「命令可能已经在跑，不许重按」。

**禁用控件在派发前拒绝**（`native_control_disabled`）。否则「什么都没发生」会被报成不确定，
诱导调用方做一次毫无意义的重复。

**真机验收**（`npm run test:native`，**17/17**）：展开应用菜单 → 快照拿到 26 个 MenuItem →
invoke `New tab Ctrl+T` → `success / verified / controlGone`（settleMs 461）→ 独立快照确认
应用菜单已折叠、该项不在树里 → **窗口标题从空变成 `New Tab - Google Chrome`**。最后一条是关键：
菜单关闭只能证明「项被选中了」，标题是另一个 API 读到的，才证明命令真的跑了。
验收脚本还会先把窗口切到一个已存在的 http 标签再 invoke——第一版没这么做，而窗口本来就是
New Tab，「标题变了」这条断言恒真，等于没测。

**已知缺口 → 已在 0.17.0 解决**：invoke 可以打开 `chrome://` 面（New tab / Downloads / Settings…），
而 `browser_tabs` 会把非 http(s) 标签过滤掉，于是基座既看不见、也关不掉自己造成的那一个标签。
现在这类标签会被**列出**并标 `restricted:true`（`title` 为 `null`，内部页只给 `scheme://host/path`，
无权站点连 URL 都不给），`browser_close` 在 `force:true` 时能关掉它。**可见不等于可读**：
`browser_read` / `browser_screenshot` 对受限标签仍然报 `Site not allowed`。
真机验收因此从 17 条涨到 21 条，并且**验收脚本会自己清掉它打开的标签**。

**部署后复验抓到两件事**：

1. **应用菜单打开时，它会作为一个标题为空的顶层窗口出现在 `browser_desktop_windows` 里**
   （实测返回真窗口 + 一个空标题句柄）。枚举把它当成可选目标是危险的：绑到它上面的 ref
   会在菜单关闭的瞬间失效。现在窗口枚举要求**标题非空**——浏览器窗口永远有标题，菜单 popup 没有。
   实测修好后菜单打开期间枚举只返回真窗口。这条用源码断言钉在 `test/reload-native.test.js`。
2. **Zoom 的两个菜单项不关闭菜单**（Chrome 故意如此，方便连点），所以 `control_gone`
   对它们永远不成立，结果稳定是 `uncertain / native_invoke_effect_unobserved`。
   这是设计在正确工作：宁可报不确定，也不把「菜单还开着」说成成功。代价是当前的 invoke
   只覆盖「选中后会离开树」的菜单项；缩放这类项要另找可观测效果（如 zoom 值）才能验证。

## 下一条执行链

1. ~~对近期快照 ref 绑定的原生控件执行 Expand/Collapse，回读展开状态。~~ 已完成（0.14.0）。
2. ~~**Invoke**：绑定 `MenuItem` 的 ref 做单次 Invoke，并回读菜单是否关闭。~~ 已完成（0.16.0）。
3. ~~**让 invoke 造成的 `chrome://` 标签可见可关**。~~ 已完成（0.17.0）：`browser_tabs` 列出
   `restricted:true` 的条目（只给身份不给内容），`browser_close` 在 `force:true` 时能关。
4. 从实际菜单树选择开发者工具入口（`More tools → Developer tools`），验证目标页面与 DevTools 文档。
5. 对 Select、Toggle、Value、Scroll 原语分别补前后证据与异常结果。Toggle 若要实现，
   必须先解决「重试会反转」——例如只暴露 SetState 式的语义，不暴露裸 toggle。

未恢复有焦点竞态的全局 F12 路径。未声称已完成 Console 执行、设置修改或完整人类等价能力。
