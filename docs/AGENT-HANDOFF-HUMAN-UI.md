# 人类等价浏览器 UI 基座：Agent 交接

> 本文是后续 Agent 接手本项目的入口，不依赖某一段对话。每次交接前先核对实际 Git、部署和测试状态；不要把本文件中的计划当成已交付能力。

## 目标

## 2026-10-29 接手增量（0.25.1）：扩展 Errors 面板的噪音

- 用户贴出一屏红字（几十条 `ERR_CONNECTION_REFUSED` + `An unknown error occurred when fetching
  the script.`）。核查：审计日志里最新一条扩展错误是当天 10:29，之后没有任何新条目，服务
  `connected:true`。**红字是历史累积**，但面板本身被一件与缺陷无关的事填满了，这仍是缺陷。
- **硬事实：`new WebSocket()` 连接被拒时，Chrome 自己往 console 打一行错误，worker 无法捕获。**
  所以「重连时少打日志」做不到，只能**不构造注定失败的 socket**：连接前用 `fetch` 探端口，
  任何应答（含 401/403）都算在监听，探测失败则排下一次重连。
  - CSP `connect-src` 必须同时允许 `ws://127.0.0.1:*` 和 `http://127.0.0.1:*`。少了后者，
    探测被 CSP 拦、恒 false、扩展永远连不上，**失败现象会伪装成「配对密钥不对」**。
  - 探测带 1.5s `AbortController`：端口接受连接但永不应答时不能卡死重连循环。
  - 真机实测（函数体从源码读出直接跑）：`:19387` → true/27ms，关闭端口 → false/3ms，
    接受不应答 → false/1509ms。停服务窗口内审计新增 `WEBSOCKET_ERROR` **0 条**。
- `allFrames` 注入统一走 `injectAllFrames()`：不可脚本化页面返回
  `status:"blocked"` / `reason:"page_not_scriptable"` + 原始 message + nextAction，
  不再是 Chrome 那句 `An unknown error occurred when fetching the script.`。
  真机 `chrome://extensions/` 验证返回 `{"reason":"page_not_scriptable","message":"Cannot access a chrome:// URL","frames":[]}`。
- 538/538 测试（新增 `test/extension-connection.test.js` 6 条静态断言）、`doctor` 12/12。
- **排查顺序提醒（已写进 memory）**：扩展报 `ERR_CONNECTION_REFUSED` 先查端口监听，
  不要先怀疑配对密钥；`Errors` 面板里的历史条目需要手动 Clear all，连上后不会自动消失。
- **更新扩展后自动清错误**（用户明确要求）：`chrome.runtime.reload()` **不清**错误列表；
  `developerPrivate.deleteExtensionErrors` 只在 chrome://extensions 内可用；`chrome.debugger`
  对 chrome:// 直接拒绝（`Cannot access a chrome:// URL`）。因此新增
  `browser_extension_errors`（把 `?errors=<id>` 摆到前台并刷新）+ `scripts/clear-extension-errors.ps1`
  （同一进程内遍历 → 点 `Clear all` → 复查），由 reload 成功后自动调用，结果在 `extensionErrors`。
- **推翻旧结论：`chrome://` 页面内容对 UIA 是可见的。** 原结论错在两处自限——
  `native-ui-snapshot.ps1` 跳过 Document 子树、`validateNativeSnapshot` 拒绝 Document 节点。
  两者现在都有 opt-in 开关（`includeDocuments`）。
- **Chrome 无障碍引擎按文档启用，且只在 UIA 客户端在线时保持。** 已加载页面永远只给
  86 个控件、0 个 Document；刷新后 113～162 个。⇒ 刷新与读取必须**同一进程**，
  分两次调用时第二次连接引擎已关闭。这是 `clear-extension-errors.ps1` 把整套动作写在一个
  脚本里的唯一原因，不是偷懒。

## 2026-10-29 接手增量（0.25.0）：一闪而过和悬停才出现的 UI

- 用户问的是「tooltip / toast / alert / modal / popconfirm 的识别和操作兜底补齐了吗」。诚实答案
  是半个：`modal` 有 `browser_scan_overlays` + `browser_dismiss_overlay`，原生 `alert/confirm/
  prompt` 有 `browser_dialog`；**toast 读不到、tooltip 只有 hover 才存在、popconfirm 就是个普通
  按钮**。这三类各需要一种不同的工具，不是「再扫一次」能解决的。
- 2 个新工具（108 → 110），无新权限、无新确认串：`browser_transient`（只读时间线，
  `read`/`watch`/`clear`）、`browser_popup`（`probe`/`reveal`/`open`/`choose`）。`browser_popup`
  进了 `WRITE_TOOLS`，因为它的「确定」通常就是删除。
- **toast 的正解不是更快的扫描，是常驻记录**。扩展在 isolated world 装一个 `MutationObserver`
  （第一次触碰文档时启动，之后复用 `globalThis`），把提示**还在屏幕上时**记下来。真机：
  点按钮 → 等 2.6 秒（toast 1.5 秒已被移除）→ `read` 仍返回 `text:"保存成功：3 条记录已更新"`、
  `goneAt-firstSeenAt = 2451ms`、`preExisting:false`。
- **四个只有真机才暴露的坑**（每一个都改了代码）：
  1. `el.textContent = x` **是替换文本节点，不是 `characterData` 变更**。第一版只处理元素节点的
     `addedNodes`，于是所有 aria-live 区域一条都记不到。现在文本节点也沿 `parentElement` 找回
     被跟踪的 live region。
  2. **裸类名不是证据**：`[class*=message i]` 在聊天页命中每条消息气泡，必须同时满足
     `position: fixed|absolute` 才算瞬态。
  3. **`visible()` 的 per-call `WeakMap` 缓存跨了点击边界**：点击前问「这个 `display:none` 的
     popconfirm 可见吗」把 hidden 缓存下来，点击后再问还是 hidden ⇒ `open` 误报 `not_opened`，
     而 `browser_find_text` 明明看得到气泡里的字。修法是 `visible(el, fresh)` 加一条不走缓存的
     路径，`waitGone` 也用它（popconfirm 靠切 `display` 关闭，节点一直在，否则永远报
     `still-present`）。
  4. **「已打开的浮层」不能用节点集合判断**（popconfirm 从一开始就在 DOM 里，点击只加 class），
     也不能用**几何距离猜归属**（一个残留的 CSS tooltip 恰好挨着删除按钮，`open` 就返回了它）。
     现在只认 ARIA 的明确信号（`aria-expanded="true"` + `aria-controls` 指向可见元素），其余靠
     `opened` / `closed_by_click` / `unchanged` **如实报告点击改变了什么**。
- **tooltip 只能让真实指针去问**：合成 `mouseover` 不移动 CSS `:hover` 状态，所以 `reveal` 走
  CDP `Input.dispatchMouseEvent{mouseMoved}`，settle 后读新出现的浮层。真机：`.tip-trigger` 的
  `tooltipSources` 是**空数组**（CSS-only），reveal 后 `revealed[0].text` 拿到文案。另：tooltip
  常挂在 `<span>`/图标上，`browser_find_element` **不会给 ref**，所以 `browser_popup` 支持
  `selector`，`probe` 无参时列出全页 `tooltipCandidates`。
- **`extension/worker.js` 有一行显式的工具分发白名单**，新工具漏加就是真机 `Unknown command`，
  而 532 个单测全绿——单测看 `src/`，白名单在 `extension/`，没有测试同时看两边。所以加了
  `test/ui-surfaces.test.js`：直接读那行 `throw new Error('Unknown command')` 断言两个工具名都在；
  另有三条契约（schema `kind` 枚举 == `transientKind` 实际返回值、`action` 枚举 == page.js 分支、
  `browser_popup` ∈ `WRITE_TOOLS`）。
- **`watch` 会占用该 tab 的命令通道**（和 `browser_wait` 一样）。实测拿它当「点一下再等提示」会
  死锁式排队：watch 占队列 → click 排后面 → watch 超时后 click 才执行。工具描述里写死了顺序：
  **先派发动作，再读时间线**。
- 真机验收（Chrome 156，探针页 `test/fixtures/ui-surface-probe.html`，用任意静态服务器起在
  `127.0.0.1` 上再 `browser_open`）：toast 事后可查 ✓、aria-live 捕获 + supersede 链 ✓、`title`
  静态读取 ✓、CSS `:hover` tooltip reveal ✓、popconfirm `open`→`choose confirm`→
  `verification:{status:"gone"}` ✓、`watch` 捕获延迟 3 秒的提示 ✓。全量 **532/532**，`doctor` 12/12。

## 2026-10-29 接手增量（0.24.0）：撤掉「明确不加」清单

- 0.22.0 里那份「明确不加的权限及原因」被用户整条推翻：**能力没有边界、没有禁区，取舍交给接入
  的 agent**。判断标准随之改变——不再是「这个能力有没有坑」，而是「这个坑有没有写进返回值」。
- 权限 20 → 27：`offscreen` `clipboardRead` `clipboardWrite` `webNavigation` `nativeMessaging`
  `identity` `identity.email`。规矩不变：**每开一个权限，同版必须有一个真能用的工具**。
- 10 个新工具 + 4 个新确认串（`modify_clipboard_once` / `run_native_host_once` /
  `modify_native_host_once` / `modify_certificates_once`）。
- **剪贴板四条实测**（决定了最终设计）：offscreen 文档读不了（`Document is not focused`，
  offscreen 永远没焦点）；offscreen 写返回 `true` 而系统剪贴板是空的（用独立回读证伪，所以
  「copy 返回 true」不是证据）；**完全被覆盖的 Chrome 窗口，活动标签 `visibilityState` 是
  `hidden`**；`waiting` 导致服务自动重试 **119 次 / 120 秒**全被同一原因拒绝 ⇒ 改成
  `retryable:false` + `retryWith:{allowFocus:true}`。最终加第三条通道 `strategy:"native"`：
  走本项目自己的原生宿主碰操作系统剪贴板，不碰页面、不抬窗口、写入能读回。
- **`nativeMessaging` 没有已注册的 host 就是空权限**：先写 `native-host/host.js`（4 字节长度 +
  JSON 帧，支持 ping/system.info/clipboard/shell.run，写审计日志），再做工具。两个真机 bug：
  MV3 worker 没有 `Buffer`（`Buffer.byteLength` 抛错 → catch 把未知大小当无穷大 → 每条消息都被
  拒为 `message_too_large`）；`shell.run` 的 promise 在 stdout flush 前就 resolve。
- **证书没有扩展 API**（`chrome.certificateProvider` 只对厂商/企业组件扩展开放），而 Windows 上
  Chrome 用的就是操作系统存储 ⇒ 直接读那个存储，不绕 UI。三个真机才暴露的 PowerShell 坑：
  `[StoreName]::$name` 不是动态查表（传 null 枚举）、`New-Object X509Store(a,b)` 位置参数被当
  字符串、**`$store` 与 `[string]$Store` 大小写不敏感同名**导致每次赋值被转回字符串。
- **一条改变上版假设的实测**：把窗口切到 `chrome://extensions` 再抓原生树 → 88 个控件、
  `ControlType.Document` **0** 个、带 `TogglePattern` 的 **0** 个，全是浏览器外壳。即
  **chrome:// 页面的内容对 UIA 不可见**（Chrome 只在无障碍引擎启用时才暴露页面内容，且
  `native-ui-snapshot` 本来就跳过 Document 子树）。⇒ 「用人类工程师的 UIA 去操作 chrome://
  页面」对**页面内容**不成立，只对浏览器外壳成立；`browser_password_manager_reveal` 能读是因为
  它走地址栏输入 + 键盘，不是 UIA 元素绑定。证书走操作系统存储不是退路，是唯一可达路径。
- `browser_native_action` 补 `toggle`（**必须带 `desiredState`**，只接受「请求一个状态」；三态
  `Indeterminate` 直接拒绝）、`select`（按可见名字，控件是条目或容器都支持，用回读选择集判定）、
  `value`（设值回读，`valueMatches` 用完整字符串算，回显截断 200 字符）。五种状态动作都是幂等
  请求，`invoke` 仍必须带 `expect.afterInvoke:"control_gone"` 且不确定绝不重发。
- **真机暴露、单测结构上抓不到的 bug**：`toggle` 的拒绝分支没回显 `desiredState`，校验器判成
  `native_action_invalid_result`。单测自己构造结果对象，所以永远不缺字段——只有真跑一次才会。
  修法是每个结果都回显请求，并加静态测试：三个动作块里**每一个** `Emit @{` 都必须带自己的请求
  字段。同时删掉两条「适配器在 spawn 前就会拒绝」的死分支（不能回显请求的拒绝无法被校验）。
- 真机验证：`value` 打在地址栏（`valueBefore`=当前 URL → `valueAfter`=探针 → `valueMatches:true`，
  第二次同请求 `alreadyInState:true`/`dispatched:false`，随后恢复原 URL）；`select` 打在标签项
  （`selectionBefore:[]` → `["Example Domain"]`，并用 `browser_tabs` 独立确认该窗口活动标签真的
  变成 `https://example.com/`，随后切回）；`toggle` 打在地址栏 → `native_pattern_not_supported`。
- 全量 **518/518**（上一版 513）。新增 6 个测试文件，`native-ui-action` 10 → 17 条。

## 2026-10-29 接手增量（0.23.0）：对照开源实现补齐七块 DevTools 能力

- 尺子是 `chrome-devtools-mcp` 与 `playwright-mcp`。逐条比对后只缺七块，而且都属「以前做不到」
  而不是「没做」：CDP override 的生命周期绑在 debugger 附件上，attach-per-call 会在调用返回时
  撤销模拟。所以这三类必须跑在 `cdp-session.js` 的长连接上，代价是**标签页挂调试横幅**。
- 七个工具：`browser_dialog`（alert/confirm/prompt，`verified:false`）、`browser_emulation`
  （地理/时区/UA/视口/色彩/CPU/网络，**每字段在开会话前校验**）、`browser_ax_snapshot`
  （`ignored` 包装 splice 掉、子节点上提；`backendNodeId` 只用于诊断）、`browser_drag`
  （HTML5 需 `setInterceptDrags`+`dispatchDragEvent`，canvas 才用 press-move-release，
  回复说明跑了哪条路，`verified:false`）、`browser_pdf_save`（`printToPDF` 走下载管理器落盘）、
  `browser_init_script`（**从下次导航生效**，Chrome 无法枚举，只能记自己发过的 id）、
  `browser_network_rules`（glob 匹配；mock 存在时该标签页每个请求都被暂停）。
- **推送式事件必须逐个答复**：`Fetch.requestPaused` 每一条都要 continue/fulfill/fail，否则请求
  永久挂起。监听器是全局单例，没有规则的标签页也立刻 continue。
- 能力指引新增 7 个意图，关键词刻意收窄（`网络`/`请求` 属 network、`脚本` 属 debug，松一个词就
  会静默改道），`test/capability-guide.test.js` 用三条反例钉住。
- 测试：`test/cdp-advanced.test.js` 15 条、`capability-guide` 9 条。

## 2026-10-29 接手增量（0.22.0）：范围从「页面」扩到「浏览器本身」

- **13 个权限 / 21 个工具**，规则是「每开一个权限，同一版必须有一个工具」。
  权限：`sessions` `bookmarks` `history` `downloads` `management` `cookies` `browsingData`
  `contentSettings` `privacy` `topSites` `pageCapture` `tabGroups` `proxy`。
  **明确不加**：`webNavigation`（只有事件）、`nativeMessaging` / `identity`（本机无基础设施）、
  `clipboardRead/Write`（粘贴已可用 CDP Ctrl+V；读剪贴板需 `offscreen` 且会读到用户刚复制的任意内容）。
- **读写必须分家**。`test/confirmation-schemas.test.js` 要求「声明 confirmation 即 required 且单值」，
  所以读写混用的工具只有两种坏结局：让只读也闭眼填确认（闸门失效），或让写没有闸门。
  每个域都是 `browser_x`（只读）+ `browser_x_write`（带确认串）。
- **10 个确认串在服务端入队前就拒**（`AUTHORITY_CONFIRMATIONS`），不是往返一轮之后才说不。
- 硬边界写在代码里：桥扩展**不能停用/卸载自己**（`bridge_extension_protected`）；
  `browser_cookies` **没有「读全部」模式**（必须给 url 或 domain，返回 `secrets:true`）；
  `browser_clear_browsing_data` **必须显式列 dataTypes**；建窗口**默认 `focused:false`**；
  代理 rules 的 scheme 不一致时**拒绝**；所有读工具返回的文本标 `untrusted browser metadata`。
- **本机实测注意**：书签根 id 是 **5/6/7**，不是标准 1/2/3（写死会 `Can't find parent bookmark for id`）；
  Chrome 156 的 `contentSettings.get` **不再回 `source`**，所以「未报告」不等于「没有例外」。
- **旧债已可回收**：`browser_session_restore action:"list"` 列出 25 条最近关闭记录，
  其中 6 条是 20 标签窗口（`veryai.cn` / `kernelgen.flagos.io`）。恢复会**消费**该条目，
  所以结果不确定时先重新 list 再决定，绝不自动重放。
- 部署方式：`stop.ps1` → `start.ps1` → `browser_reload_extension`（`chrome.runtime.reload`，
  零焦点零新标签）→ 逐项真机验证。

## 2026-10-28 接手增量（0.21.0）：浏览器目标由用户指定

- **本机的正确答案（用户当场确认）**：日常浏览器 = **Chrome SxS（Canary）/ profile `Default`**，
  已登录 `love530love@gmail.com`。稳定版的 `Default` 虽然历史更大、cookies 更多，但**没有登录 Google 账号**，
  所以启发式选出来的是「看起来最干净」的那个。已写入 `.local/config.json` 的
  `browserTarget: { channel: "canary", exePath, userDataDir, profileDirectory: "Default" }`。
  ⚠ **但这个记录本身可能是错的，先看下一条再动手。**
- **登录账号不能区分「我在用」和「我用过一次」（本轮实测）**：Canary/Default（`Zack`）与稳定版/Default
  （`您的 Chrome 数据`）**是同一个账号、`Login Data` 都是 192KB**，是同一份数据的克隆；Canary 那份的
  `Preferences`/`History`/`Cookies` 全部停在 2026-08-11，稳定版那份几分钟前还在写。**唯一能回答
  「人在用哪个」的信号是 profile 目录里这几个文件的最大 mtime**，不是历史大小、书签数、`last_used`、登录账号。
  `-DryRun` 现在给 `wouldLaunch.ageMinutes` / `profileName` / `accounts` + 顶层 `liveCandidate` /
  `targetIsLive` / `warnings:["recorded_target_looks_stale"]`，`doctor` 在目标陈旧时直接判红。
  **换记录前先问用户，不要自己翻。**
- **不要再写「按证据打分选浏览器」的兜底逻辑**。打分只在**没有 `browserTarget`** 时使用，并且 `doctor`
  会明确提示正在用启发式。渠道内部也**不要**再按 `last_used` 猜 profile——本机 `last_used` 是 `Profile 1`，
  而两份数据都在 `Default`。
- **本机有多个安装根**：`C://Program Files`、`D://Program Files`（本机 `Program Files` 实际指向 D:）、
  `%LOCALAPPDATA%\Google\Chrome SxS`（Canary，159.0.8128.2）。三者共用各自渠道的 user-data 目录，
  所以**换安装根不改 profile，换渠道才改**。
- **两条实测负面结论，别再试**：① `--load-extension` 在 Chrome 156/159 上被忽略（`Secure Preferences`
  里不会出现 `location:4`，扩展不回连）；② `SW_SHOWNOACTIVATE` 挡不住 Chrome 抢前台（第一个窗口会显式
  `ShowWindow`）。焦点必须**事后归还**：`AttachThreadInput` + `SetForegroundWindow`，然后重新测量。
- **开发者模式在本机不可持久化**：Chrome 退出时把 `extensions.ui.developer_mode` 的值丢掉、MAC 留下
  （`developerModeInEffect()` 就是读这个指纹）。所以「重启后扩展被停用」是稳定复现，不是偶发。
  当前扩展**在任何渠道里都没有注册记录**（被 Chrome prune），需要在用户选定的 Canary/Default 里
  `chrome://extensions` → 开发者模式 → Load unpacked 一次。
- 诊断修正：扩展记录被压缩成 `{"disable_reasons":[...]}` 时 `path` 会消失，只按路径匹配会误报
  「未安装」；现在 id 也参与匹配（`matchedBy: "id"`）。

## 2026-10-28 接手增量（0.20.0）：不再开错浏览器，也不再抢前台

- **本机有一条必须先知道的事实**：`HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`
  指向 `C:\Users\love\AppData\Local\Google\Chrome SxS\Application\chrome.exe`（**Canary/SxS 渠道**），
  而 `HKLM` 那一项指向稳定版 `C:\Program Files\Google\Chrome\Application\chrome.exe`。
  Windows 解析 `chrome` 时 **HKCU 优先**，而每个渠道有**自己的 user-data 目录**
  （`Chrome SxS\User Data` vs `Chrome\User Data`）⇒ 选错渠道 = 一个没登录、没书签、没历史的浏览器。
  **这就是「又开了一个没有历史信息的浏览器」的根因**，不是随机故障。
- `scripts/launch-chrome.ps1` 现在**按 profile 证据选二进制**：对每个已安装渠道的 user-data 目录打分
  （`last_used` profile 存在 +1、有书签 +2、`Login Data` 非空壳 +1），最高分胜、平手稳定版优先；
  全 0 分时返回 `no_used_profile_available` **拒绝启动**（空壳比不开更糟，它看起来像会话被清空）。
- **不抢前台**：改用 `CreateProcess` + `STARTF_USESHOWWINDOW` + `SW_SHOWNOACTIVATE`（不再用 `Start-Process`）。
  并且**只测量不承诺**：启动前后各取 `GetForegroundWindow`，前台若变成新窗口就报 `activated: true`。
- **服务侧两道闸**：① 启动前探测可见窗口，有窗口就 `chrome_window_present`（映射成
  `chrome_running_extension_not_connected`），绝不启动；② 启动后比对 `userDataDir` 与本机实际使用的目录，
  不一致 → `launched_wrong_profile`（`status: failed`，`retryable: false`）**且不继续原调用**。
- **`browser_reload_extension` 的 UIA 回退不再自动抢前台**（那是 `SetForegroundWindow` + 往真实窗口打字）。
  没有 `allowFocus: true` 时返回 `waiting / focus_required_for_ui_automation / foregroundTaken: false`，
  什么都不派发、也不抬窗口，并给 `retryWith`；允许后才执行并如实报 `foregroundTaken: true`。
- **`doctor` 新增 `auto-start-target`**：用 `-DryRun` 在不启动任何东西的前提下回答
  「会起哪个浏览器、用哪份 profile」，输出 `wouldLaunch` / `rejectedCandidates` / `runningSession` /
  `sameProfileAsThisMachine`。本机实测 `true`，SxS 落在 `rejectedCandidates`。
- **上一轮结论已过期，按过期处理**：0.19.1 说扩展被 Chrome 停用；本轮实测
  `Secure Preferences` 的 `extensions.ui.developer_mode` **已是 `true`**，`doctor` 报
  `enabled: true / disableReasons: []`，扩展当前已连接（0.19.0 / Chrome 156.0.8078.49）。
  所以**不再需要用户去开开发者模式**——那一步已经完成，别再让用户重做。
- 顺手修掉 `visibleWindowCount` 长期虚高：原来用 `IsWindowVisible` 把 Chrome 一堆不可见消息窗口也算进去，
  现在只算「可见 + 无 owner + 有标题」的顶层窗口，本机从虚高变成正确的 **1**。
- 测试：受影响的 6 个文件 **56/56**，全量 **397/397**。`reload-native.test.js` 两条按新契约重写
  （先拒绝、`allowFocus: true` 才执行）。

## 2026-10-28 接手增量（0.19.1）：扩展被 Chrome 停用这件事，现在看得见了

- 0.19.0 真机验证暴露：浏览器被拉起来了，但扩展没回连。磁盘上的答案是**扩展被停用**
  （`disable_reasons: [16777216]`，开发者模式关闭）。服务此前只能看到「没连上」。
- 新增 `src/chrome-profile.js`：读 `User Data\<profile>\Secure Preferences` 的 `extensions.settings`，
  按**扩展目录路径**匹配（忽略斜杠方向/大小写/尾分隔符），返回 profile 名、id、`enabled`、`disableReasons`；
  **启用副本优先**（另一个 profile 的停用残留不该掩盖能服务基座的那个）。
- `doctor` 新增 `bridge-extension-registered`，三种状态三句不同的话（未安装 / 已启用 / 被停用 + 具体动作）。
- 修 0.19.0 的分支错误：`launchBrowserOnce` 把「起来了但没连」改成 `uncertain`，而 `reviveBrowser` 用
  `status === 'success'` 判断 ⇒ 被降级成 `extension_disconnected`，把「浏览器已经起来了」藏掉了。
  现在按 `reason` 判断，返回 `chrome_launched_extension_not_connected` + `extensionState`。
- **待用户做的一步**：`chrome://extensions` → 开发者模式 → 启用「自主浏览器」。做完之后自动启动链路才算
  真正闭环（目前只验证到「Chrome 被拉起」这一段）。

## 2026-10-28 接手增量（0.19.0）：浏览器没开时基座自己启动，并把原调用重跑一次

- **「浏览器没开」不再是回答，而是动作**。需要扩展的调用在浏览器关着时不再直接返回 `extension_disconnected`：
  **没有 chrome 进程时先启动浏览器，再重跑原调用**，结果带 `autoLaunched`。
- **规则窄得刻意**：只在**一个 chrome 进程都不存在**时启动。浏览器在跑却没回连（扩展暂停 / worker 被回收）
  再起一个就是**第二个 profile**，那是丢 cookie 而不是修好它 ⇒ 返回 `chrome_running_extension_not_connected`
  并说明该重载扩展。
- **旧 tabId 的死角一起拆掉**：重启后旧 `tabId` 必然失效，「tab not found」和「浏览器没开」是同一种阻滞。
  现在返回 `tab_gone_after_browser_launch` + 当前标签列表 + 下一步（`browser_open` 会复用同 url 标签）。
- **并发去重**：同时多个调用只启动一次，否则第二个会得到「已经在跑」——而那正是它自己刚启动的那个。
- 配置 `autoLaunchBrowser`（setup 写 `true`，本机已补），`AIB_AUTO_LAUNCH=0` 关闭；**测试默认关闭**，
  所以 385 条既有用例行为不变、跑测试不会真的弹浏览器。
- **两条真机事实**：① 从**服务进程**启动的 Chrome 能活（工具调用里启动的会被沙箱连树回收）⇒ 这件事必须做在
  服务里；② Chrome 的「Restore pages?」是**独立顶层窗口**，`browser_native_action invoke` 点它的 `Restore`
  返回 `success / controlGone / settleMs 384`，标签 1 → 20 —— 原生通道点浏览器自己的对话框也是可行的。

## 2026-10-28 接手增量（0.18.1）：「重启了但版本没变」的三种状态

- 用户重启 Chrome 后 `browserVersion` 仍是 154。证据链：最早一个 chrome.exe 从 18:23 活到 20:52、
  磁盘 `chrome.exe` FileVersion 仍是 154、Omaha `ClientState.pv` 已是 156 ⇒ **浏览器进程根本没退出过**。
- **升级有三种状态**：① 只下载（有 `<newer>` 目录、无 `new_chrome.exe`）→ 正常重启生效；
  ② **已安装、只差换启动器**（`Application\` 下有 `new_chrome.exe`）→ **重启不会生效**；
  ③ 已应用（`chrome.exe` FileVersion 是新版）。这台机器卡在 ②，因为没有 Omaha 注册，没人做最后那次改名。
- `node scripts/chrome-compat-baseline.js --disk` 就是查这个的（**不需要浏览器在跑**，而那正是唯一值得查的时刻）。
  capture 输出也新增 `STAGED LAUNCHER` 告警。
- **基座不能替用户启动 Chrome**：从工具里 `Start-Process chrome.exe` 能起来，但工具调用一结束整棵进程树
  就被回收（PowerShell 与 bash 两种方式一致，Crashpad 无当天转储）。**最后一下必须由人点。**
- 退出浏览器改用 `browser_native_action invoke` 点「Exit」菜单项，`success / controlGone / settleMs 684`，
  比 `Stop-Process` 干净且保留会话。
- 补掉上一轮漏改的 `package-lock.json` 版本号（先跑测试再改版本，正好绕过一致性断言——顺序错了）。

## 2026-10-28 接手增量（0.18.0）：expand + invoke 组合成「打开/关闭 DevTools」

- **`browser_devtools` 支持 `open` / `close`**，走浏览器自己的菜单
  （`expand 应用菜单 view_1007 → expand More tools → invoke Developer tools → 再 observe`），
  **不合成 F12，因此没有焦点竞态**。0.9 撤下它时写明的两个前提（绑定目标窗口的可回读原生动作、
  充分的负证据）在 0.14.0 / 0.16.0 已补齐，这一轮把它们接成一条完整能力。
- **对外是「请求一个状态」，不是切换**。菜单项本身是 toggle，所以永不以 toggle 暴露：
  已在目标状态就 `dispatched:false / alreadyInState:true`。**幂等性由此而来**，也是「`uncertain`
  之后允许重试」在这里成立、在裸 invoke 上不成立的唯一原因。
- **打开只认正证据，关闭必须同时有负证据**：`open` 要 `devtools://` 文档 + ≥2 个面板 TabItem；
  `close` 要 `!devtoolsOpen && partial === false`——「没看到打开」本身也描述了「遍历提前放弃」，
  走查不完整时报 `devtools_close_unverified_partial_walk`。
- 唯一一次派发是 invoke（带 `afterInvoke:"control_gone"`）；失败结果里带「不要重复调用」，
  `dispatched` 照抄原语，避免把「什么都没发生」报成不确定的点击。
- 真机 `npm run test:devtools` 从「只能 PARTIAL」变成 **11/11**：
  `ensure-closed → open → open again（dispatched=false）→ select/reselect Console·Network·Elements → close`。
- 验收脚本自身修了三处假测：面板列表读到半渲染状态（改成等数量稳定）、窗口按标题绑但标签未激活
  （先 activate 再轮询）、预热 observe 撞上受限标签被 `Site not allowed` 打断（按 `restricted !== true` 挑）。
- `panels` 列的是 DevTools 文档里所有 TabItem（顶层面板 + 当前面板的子标签页），所以 `select_panel`
  也能选 `Computed` / `Layout` / `Event Listeners`；超出停靠宽度的顶层面板被 Chrome 收进溢出菜单，
  **不在列表里**——这是 UI 事实，要选它们需先展开 chevron，尚未实现。
- 全量单测 **385/385**（+8，`test/devtools-menu.test.js` 用真实 toggle 语义模拟）；`doctor` 10/10；工具数仍 69。
- **下一步**：Select / Toggle / Value / Scroll 原语；DevTools 面板溢出菜单与 detached DevTools 的显式绑定；
  `chrome://settings` 修改类能力（回读必须来自设置页自己的控件值）。**Chrome 156 适配仍未闭环**（运行版本 154）。

## 2026-10-28 接手增量（0.17.0）：看不见的标签变成看得见、关得掉

- **`browser_tabs` 不再静默隐藏标签**。上一轮的缺口是：invoke 能打开 `chrome://` 面，
  而列表会过滤非 http(s) 标签，于是「我打开了什么」在基座里不可见。现在列出并标
  `restricted:true`，`restrictedReason` 为 `non_http` 或 `origin_not_allowed`。
- **只给身份不给内容**：`title` 恒 `null`；内部页只给 `scheme://host/path`（去掉 query/fragment）；
  `origin_not_allowed` 连 URL 都不给（URL 就是内容）。**可见不等于可读**——`browser_read` 仍报
  `Site not allowed`。
- **`browser_close` 在 `force:true` 时能关受限标签**。实现上把「关标签」从 URL 授权检查里摘出来：
  关闭是生命周期操作不是读取；不摘则这类标签永远关不掉，而且会用 URL 策略错误掩盖所有权判断。
  实测：无 force → `denied / tab_not_created_by_bridge`；有 force → `{closed:true}`。
- 真机 `npm run test:native` **21/21**（+4：可见 / 无 force 仍被拒 / 带 force 能关 / 跑完不留残留）。
  **验收脚本现在会自己收尾**，上一轮每跑一次留一个隐形标签的问题不再存在。
- 纯函数 `describeTab` / `internalUrlLabel` / `isInternalPage` 在 `extension/tab-identity.js`，
  单测 `test/tab-identity.test.js` 9 → 11 条。全量单测 **377/377**；工具数仍 69。
- **下一步（已在 0.18.0 完成）**：`More tools → Developer tools`（用 invoke 打开 DevTools 面板）。
  再往后是 Select / Toggle / Value / Scroll 原语。

## 2026-10-28 接手增量（0.16.0）：invoke，选中一个菜单项

- `browser_native_action` 的 `action` 增加 `invoke`，**必须**带 `expect.afterInvoke:"control_gone"`。
  expand/collapse 幂等所以「不确定就重试」安全；invoke 不幂等（选两次命令跑两次），
  而 UIA 只看得见「控件还在不在树里」，命令执行了什么看不见。所以 `success` 只表示
  **声明的后置条件被观测到了**，永远不表示命令成功。
- 派发后必须**连续两次**遍历都找不到「同名+同角色+同 automationId」的控件才算 gone——
  菜单关闭时树会重建、runtime id 会换，「ref 不见了」不等于「项被选中了」。
  两次遍历用同一个 `Scan-Tree`、同一套预算，否则不是同一次观测的证据。
- invoke **不提供 `failed`**（项还在只说明没观测到效果，不说明命令没跑），只剩
  `not_dispatched` / `success` / `uncertain`；`uncertain` = 命令可能已经在跑，**不许重按**。
  禁用控件在派发前拒绝。
- 真机 `npm run test:native` **17/17**：invoke `New tab Ctrl+T` → `controlGone`（settleMs 461）
  → 独立快照确认菜单折叠且该项消失 → **窗口标题变成 `New Tab`**（另一个 API 读到的，
  才证明命令真的跑了）。验收脚本第一版断言恒真（窗口本来就是 New Tab），已改成先切到
  一个已存在的 http 标签再比 before/after。
- **下一步**：invoke 能打开 `chrome://` 面，但 `browser_tabs` 过滤非 http(s) 标签，
  所以基座看不见也关不掉自己造成的那个标签（实测已留下一个）。正解：`browser_tabs`
  报告被过滤标签的数量与 id（不含标题/内容），`browser_close` 能关这些 id。
- **部署后复验抓到两件事**：① 应用菜单打开时会作为一个**标题为空的顶层窗口**出现在
  `browser_desktop_windows` 里，绑上去的 ref 会在菜单关闭瞬间失效——枚举现在要求标题非空
  （实测修好后菜单打开期间只返回真窗口）。② Zoom 的两个菜单项**不关闭菜单**，
  所以 `control_gone` 对它们永远不成立，稳定返回 `uncertain`（设计正确，但划出了能力边界）。
- 全量单测 **375/375**；工具数仍 69；`scripts/native-ui-action.ps1` AST `parse-ok`。

## 2026-10-28 接手增量（0.15.0）：Chrome 156 适配轮

用户要重启 Chrome 应用更新到 156。这一轮**不加原语**，先把「升级会坏什么」变成可测量的事，
因为上面所有原语都建立在「`automationId` 下次启动还是同一个」这个假设上。

- **基座原本不知道自己驱动的是哪个 Chrome**。没有 `chrome.*` API 报版本；
  `navigator.userAgent` 被 UA 减缩成 `154.0.0.0`（补丁号被抹掉，正好抹掉升级最想确认的那几位）；
  `browser_debugger action:"evaluate"` 走 `Runtime.evaluate` + `awaitPromise:false`，页面侧
  拿到的是未决 Promise。答案是 service worker 里的 UA-CH：`/status` 现在有 `browserVersion` /
  `browserMajor` / `browserIdentitySource` / `browserBrands`，实测 `154.0.8037.93`
  （`user_agent_client_hints`）。`browser_health` 与 `doctor` 的 `extension-connected` 也带上。
- **版本消息与结果走同一条 socket，所以服务端校验而不信任**：只接受
  `/^\d+(\.\d+){1,3}$/`；**只给大版本号的一律拒绝**——把「补丁未知」当成「补丁 0」正好会藏掉升级。
  worker 在 `hello` **之后单独**发 `browser` 消息（并进 hello 会让 UA-CH 的慢把握手拖成配对失败）。
- **`scripts/chrome-compat-baseline.js`**：只读 `/status` 与本机安装目录，不开标签、不读页面。
  两个实测修正：版本目录里**没有** `chrome.exe`（在 `Application\` 一层，子目录里是 `chrome.dll`
  与 `<version>.manifest`），以及本机 Chrome 装在**两个根**（C:\ 与 D:\）。
  基线 `154.0.8037.93`：`controls 109 partial=false omittedDocuments=0`、`identity rows 60`、
  `PENDING UPDATE: 156.0.8078.49`。
- **`scripts/password-manager-ui.ps1` 改为 `Find-Control`：id 优先 → 角色+可访问名称兜底 →
  歧义即拒绝**。`Find-ById` 的失败与「控件不存在」不可区分，而这条流程会把密码显示出来；
  命中多个候选直接 `denied`（`search_input_ambiguous` / `reveal_control_ambiguous`），
  匹配路径写进 `evidence.lookup`。
- 补齐 0.14.0 遗留：`browser_capabilities.protectedUi.implementedActions` 加
  `read_native_controls` / `expand_native_control` / `collapse_native_control`。
- 全量单测 **372/372**；工具数仍 69；`scripts/password-manager-ui.ps1` AST `parse-ok`。

**升级后必须按序执行**（详见 [CHROME-VERSION-ADAPTATION.md](CHROME-VERSION-ADAPTATION.md)）：

```powershell
node scripts/chrome-compat-baseline.js
node scripts/chrome-compat-baseline.js --diff .local/chrome-compat-154.0.8037.93.json .local/chrome-compat-156.0.8078.49.json
npm test
node src/cli.js doctor
npm run test:native
npm run test:capture
npm run test:debugger
npm run test:bench
```

`--diff` 里出现 **GONE** 的 `automationId` = 有代码按那个 id 绑定了控件，必须改成可发现的绑定
或确认它不在任何路径上。**当前运行版本仍是 154.0.8037.93，156.0.8078.49 已下载待应用，
所以本轮不宣称「已适配 156」。**

## 2026-10-28 接手增量（0.14.0）

磁盘基线 `85f2435` → 本轮新增 `browser_native_action`。
原生 UI 从「状态可读」推进到「单个控件可写且可证」，工具数 68 → 69。

- `browser_native_action({processId, windowHandle, ref, action, expect})`，`action` 只有
  `expand` / `collapse`。**没有 Toggle**：toggle 派发两次回到原点，结果不确定时无法重试；
  expand/collapse 构造上幂等（已在该状态则不派发，返回 `alreadyInState:true`）。
- `expect` 必须重复至少一个从快照读到的属性（`name` 或 `automationId`），否则在校验层
  就被拒——runtime ref 会被树重建复用，只有可重复的属性才是身份。
- 证据：`stateBefore`/`stateAfter` 都由控件自己读出，派发后 1.5s 内轮询回读；pattern
  不抛异常不算成功；`LeafNode` 在派发前拒绝；派发后读不回 → `uncertain`；状态没变 →
  `failed/native_state_not_reached`，两者都不许重按。
- 真机 `npm run test:native` **13/13**；单测 `test/native-ui-action.test.js` **10/10**。
  实测：`All Bookmarks` Collapsed→Expanded（settleMs 161）→ 独立快照确认 → 45 个
  MenuItem 可见 → Collapsed → 独立快照确认 → 未留下打开的菜单。
- **实测修正一条旧结论**：Chrome 自绘菜单是浏览器窗口的**子 HWND**，展开时快照能看到
  完整 `MenuBar/Menu/ControlType.MenuItem` 树（111 → 166 控件）。所以「不含 popup」
  只对独立顶层窗口成立。这让「选菜单项」比原先设想的近得多。
- 顺手修掉一个真机才暴露的缺陷：桌面目标「近期观察」TTL 30s 是**按墙钟**算的，而单次
  UIA 遍历实测约 10s，连续三次调用就会在目标已被两次重新校验通过的情况下被拒。现在
  重新校验成功即续期——校验本身就列了一次窗口并匹配了这对精确句柄，比调用方手里的
  那次列新。

下一步：**Invoke**。菜单项已在快照里，缺的是「绑定 MenuItem 的 ref 做单次 Invoke 并
回读菜单是否关闭」。这是打开 DevTools 面板的真正入口，也是「改设置项」的第一块。
Toggle 若要实现，必须先解决「重试会反转」——只暴露 SetState 式语义，不暴露裸 toggle。

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
- **本轮已完成的验证（可引用）**：0.5.23 阶段 —— `node --check` 通过；`scripts/devtools-ui.ps1` 与 `scripts/native-ui-snapshot.ps1` 用 `System.Management.Automation.Language.Parser::ParseFile` 解析 0 错误；`test/devtools-adapter.test.js` 6/6。0.5.24 阶段 —— `test/cdp-capture.test.js` 15/15、`test/reload-target.test.js` 6/6、`test/capability-guide.test.js` 7/7、`test/coordinate-guard.test.js` 7/7、`test/tab-identity.test.js` 9/9。**全量 `node --test --test-concurrency=1 test/*.test.js` = 191/191 通过（43 个测试文件全部有贡献，无静默跳过）**。
- **后台焦点独立性现场实测**：`npm run test:focus` = **25/25**（两个 fixture 标签，激活第二个使第一个真后台）。`browser_action` `Tap` 在后台真实落到预备的 DOM 目标（计数器 1→2），`Hover` 正常派发；`requireForeground:true` 仍按请求拒绝且不签发 token。日志里会打印 `active` / `windowId` / `visibility` / `windowFocused` / `viewport`，便于复核环境。
- **会话复用现场实测**：`npm run test:session` = **17/17**。同 URL 复用同一 tabId、`#fragment` 复用、不同查询串不误复用、开标签后不抢焦点、窗口数不变、本桥标签 `bridgeCreated:true` 而用户既有标签全为 `false`。该脚本**刻意不验证「拒绝关闭非本桥标签」**——守卫失效会关掉用户真实标签，风险不可接受；该分支由单元测试与一次性浏览器 e2e 覆盖。
- **0.6.0 断点调试已落地，且是现场实测而非单元自证**：`browser_debugger` 提供每标签一条长活 CDP 调试会话，断点跨调用存活。`test/live-debugger.js` **38/38，连续跑三次全绿**（`npm run test:debugger`）在真实 Chrome 上证明：断点真命中（`hitBreakpoints` 含我们设的 id）、页面真冻结、暂停期间 `browser_read`/`browser_screenshot`/`browser_key` 全部回 `waiting/tab_paused_by_debugger` 且不挂起、`browser_health` 仍能答并回 `pageProbe.skipped`、`step_over` 真换行（6→7）、`frames` 首帧 `functionName: "tick"` 且 `lineNumber` 为 1-based 的 6、帧上 `evaluate` 读到局部变量 `n = 0`、移除断点后 `resume` 使 `window.calls` 真的跑到 4、关会话后页面照常作答、隐藏标签截图的产帧预热真的执行了。单元侧 `test/cdp-session.test.js` **20/20**。
- **接手时必须知道的四个反直觉点**（都是实测踩出来的，不是理论）：① **触发断点要异步**——用 `evaluate` 跑 `setTimeout(fn, N)`；同步调用会在发起它的那次注入里就暂停，那个 promise 永不返回。② **`scripts` 必须带 `urlFilter`**——实测一个普通页面加载 87 个脚本，页面自身内联脚本被「取最后 60 个」的窗口挤掉，而它正是唯一想下断点的脚本。③ **会话开着时不能再次 `chrome.debugger.attach`**——`browser_screenshot`/`browser_performance`/`browser_network_summary`/`browser_devtools_capture` 已改为借用 `activeSend`，否则断点一开这些原语全部报 `Another debugger is already attached`。④ **隐藏标签不产帧**——持久会话下 `Page.captureScreenshot` 会等一个永不来的帧，实测首次固定 20016ms 撞穿 20s 读超时；`requestAnimationFrame` 等待在隐藏标签上永不 resolve。修法是截图前短暂 `startScreencast` 强制产帧、等首帧后再截、随即 `stopScreencast`，实测稳定 143–181ms。已证伪 `setWebLifecycleState('active')` 与 `setFocusEmulationEnabled`；`Page.bringToFront` 有效但抢前台，默认不用。
- **0.5.25 增量验证**：`test/reload-native.test.js` 5/5、`test/launch-chrome.test.js` 8/8。现场实测两条 reload 路径各跑通一次：旧 worker → `method: "windows_ui_automation"` + `fallbackReason: extension_cannot_self_reload`；新 worker → `method: "chrome.runtime.reload"` + `focusRequired: false` + 会话 id 已变。`browser_launch` 在 Chrome 已运行时正确返回 `not_dispatched/chrome_already_running`。`doctor` 全项通过，service 与 extension 均为 0.5.25。
- **已知遗留（别当成功）**：`browser_launch` 无法探测用户平时是否用 `--profile-directory` 启动 Chrome；裸 `chrome.exe` 会落到 Chrome 记住的上次使用 profile。这一点在返回里没有假装能识别。
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

0. **推送用 `git push sshpush main`，不要用 `origin`**。两个远程指向同一仓库，但 https 的
   `origin` 在非交互环境下会卡在凭据弹窗直到超时被 SIGTERM（推不上去，也不给错误内容）。
   推完 sshpush 再 `git fetch origin` 同步 tracking ref，否则 `git status -sb` 会一直显示
   `ahead 1`。`GIT_TERMINAL_PROMPT=0` 可以避免卡住。
1. `node src/cli.js doctor` —— 看 `service-build-current`。红就说明运行的服务还是旧源码：停掉 `.local/server.pid` 里的进程再跑 `start.ps1`。**不要只看版本号**，版本相同但 buildId 不同也意味着没部署。
   `stop.ps1` 偶发 `Service identity query timed out`（本机 WMI 不可用），可靠绕法是
   `netstat -ano | grep 19387` 取 PID → `Stop-Process -Id <pid> -Force`；watchdog 会自动
   拉起并加载新代码。
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
