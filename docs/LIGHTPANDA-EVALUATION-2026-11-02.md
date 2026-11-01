# Lightpanda 评估（2026-11-02）：能接什么、不能接什么

> 结论先说：**它不是这个项目的替代品，但它的「干净只读旁路」和「cookie 交接」两个能力，正好补上当前架构里最贵的一块。**
> 本文所有能力判断都来自本机实跑，不是读 README。跑不起来的项单独标注。

## 一、它是什么（事实）

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | `lightpanda-io/browser` | GitHub API |
| 规模 | 39,852 star / 1,947 fork / 101 open issues，当天仍在推送 | GitHub API 2026-11-01 |
| 语言 | Zig（V8 做 JS，html5ever 解析 HTML，libcurl 加载） | README |
| 许可证 | **AGPL-3.0** | GitHub API |
| 本机版本 | `1.1.0-nightly.11471+cebb8d51e` | WSL2 实跑 |
| 平台 | Linux x86_64/aarch64、macOS；**无 Windows 原生二进制** | README + 实测 |
| 渲染 | **无图形渲染引擎**（这是它省内存的根本原因） | README |

关键设计取舍：**砍掉布局/绘制**。所以它快、它小，也所以它拿不到「人看到的画面」。

## 二、本机实测（WSL2 + glibc 2.39，全部通过）

### 2.1 资源

| 指标 | 实测 |
|---|---|
| `serve` 常驻内存 | **39.4 MB RSS** |
| 冷启动 + 抓一页 | **1.78 s** |
| 连接方式 | WSL2 的 localhost 转发正常，Windows 侧 `http://127.0.0.1:9222/json/version` 直接可用 |

### 2.2 CDP 逐项（原生 WebSocket，不用 Puppeteer）

`Browser.getVersion` 自报 **`Chrome/124.0.6367.29`** —— 协议层冒充 Chrome，但 UA 是 `Lightpanda/1.0`。这两件事不一致，是有意的（见 4.4）。

| 命令 | 结果 |
|---|---|
| `Target.createTarget` / `getTargets` / `attachToTarget(flatten)` | ✅ |
| `Page.enable` / `Page.navigate` / `Page.loadEventFired` | ✅ |
| `Runtime.enable` / `evaluate(returnByValue)` / `evaluate(awaitPromise)` | ✅（`await fetch()` 返回 `{"status":200}`） |
| `Network.enable` + 事件 | ✅ |
| `Fetch.enable` + `Fetch.continueRequest` | ✅ 2/2 全部续行 |
| `DOM.enable` / `DOM.getDocument` | ✅ |
| `DOM.querySelector` | ❌ `NodeNotFoundForGivenId`（`getDocument` 返回的 nodeId 不被接受） |
| `Emulation.setFocusEmulationEnabled` / `setDeviceMetricsOverride` | ✅ |
| `Page.addScriptToEvaluateOnNewDocument` | ✅ |
| `Page.getLayoutMetrics` | ✅（返回 1280×800） |
| `Page.captureScreenshot` | ⚠️ 返回**真 PNG**，但内容是**纯文本排版**（见 4.3） |
| `Input.dispatchMouseEvent` 三连 | ✅ 且 `event.isTrusted === true` |
| `Input.insertText` / `dispatchKeyEvent` | ✅ 输入框值从 `""` → `"hello"` → `"helloa"` |
| 隐藏页面里的 `requestAnimationFrame` | ✅ 会触发（`raf-fired`） |

> 踩过的坑：**`Fetch.enable` 会暂停所有匹配请求**。第一次探测时开了 `Fetch.enable` 却不续行，`Page.navigate` 15 秒超时、`Page.loadEventFired` 永不出现——看起来完全像「不支持导航」。续行后一切正常。**这是探测脚本的错，不是 Lightpanda 的缺陷**，写在这里防止下次重复误判。

### 2.3 Playwright 兼容性（`connectOverCDP`）

| 步骤 | 结果 |
|---|---|
| `connectOverCDP` / `newPage` | ✅ |
| `goto`（JS 渲染页） | ✅ 1821 ms，`document.querySelectorAll('.quote').length === 10` |
| `screenshot` | ✅ 85,824 bytes PNG |
| `context.cookies()` | ✅ |
| `setContent` 后 `fill('#x')` | ❌ 定位器 30 s 超时 |

最后一条说明：**不能假设 Playwright 的便利 API 一定可用**。同样的输入动作直接用 `Runtime.evaluate` 造元素 + `Input.*` 派发是成功的，所以问题在 `Page.setDocumentContent` 或可操作性判定，不在输入通道。

### 2.4 cookie 交接（本轮最有价值的一条）

| 场景 | 服务端看到的 `Cookie` 头 |
|---|---|
| 不给 `--cookie` | `cookie=`（空） |
| `--cookie` Netscape `cookies.txt` | `cookie=sid=from-the-bridge` ✅ |
| `--cookie` Puppeteer/CDP JSON | `cookie=sid=from-json` ✅ |
| `--cookie-jar out.json` | 文件被写出（JSON 数组） |

**两种格式都认**，包括 curl/wget 的 `cookies.txt`。这是唯一一条能让「干净浏览器」带上用户真实会话的通道。

### 2.5 `fetch` 子命令

`--dump markdown` 对 JS 渲染页可用，但质量粗糙：`deep\-thoughts` 这种转义残留、`"…"by Albert Einstein` 引号与人名之间缺空格。可用，不能当成品排版。
另支持 `--dump html` / `pdf` / `structured_data`（JSON-LD / OpenGraph / Twitter card）/ `wpt`、`--dump-selector`、`--dump-max-bytes`、`--inject-script`、`--obey-robots`。

## 三、能融进来的（按性价比排序）

### 3.1 值得直接接：**只读旁路 lane**

现在的架构里，「读 30 个页面做个对比」是一件很贵的事：要走用户唯一那个前台 Chrome、一次一个标签、还要担心动到用户的会话。而这类任务**根本不需要用户的会话**。

- 39 MB / 1.78 s 冷启动，意味着可以并行跑几个而不心疼。
- 桥已经有的能力可以原样复用：`Page.navigate` + `Runtime.evaluate` + `Input.*` + `Fetch` 拦截全部实测可用，`cdp-replay.js` 那套「页面内 fetch + 回读」也能跑（`awaitPromise` 已验证）。
- **硬约束**：lane 只开只读工具（`browser_read` / `browser_find_*` / `browser_fetch` / `browser_network_summary`），写工具一律拒绝。
- **硬约束**：结果里必须带 `lane` 字段。`lane:"clean"` 与 `lane:"user-chrome"` 是**两个不同的事实**——「用你的会话读的」和「用干净浏览器读的」如果在结果里分不开，就是本项目一直在消灭的那种假成功。
- **硬约束**：lane 不可用时 `reason:"lane_unavailable"` 失败，**绝不回退到真 Chrome**。静默回退等于把「我动了你的浏览器」伪装成「我没动」。

### 3.2 值得接但要用户点头：**cookie 交接**

技术上完全成立（2.4 已证）。但要注意：桥现在**故意不导出 cookie 值**——`src/credential-store.js` 里那句注释是明确的：「Only counts are reported: no cookie value ever leaves this function」。cookie 解密只用来**反证密钥对不对**，不是导出通道。

所以这不是「接一下就有」的功能，而是一个信任决策：**把用户解密后的 cookie 写成磁盘上的临时文件，交给另一个进程。** 如果要做得先定死四条：

1. 单次调用、按 origin 白名单、只导出该 origin 的 cookie；
2. 写到临时文件后，`finally` 里删除，失败也删；
3. 审计只记 origin 哈希与 cookie 条数，不记值；
4. 结果里明说「传了 cookie，没传 localStorage / IndexedDB / Service Worker」——现代 SPA 的登录态大多在 localStorage，**只给 cookie 会失败**，这个失败必须写在结果里，而不是让调用方以为「登录态已经带过去了」。

### 3.3 值得抄思路（不需要引入它）

| 它的做法 | 桥的现状 | 建议 |
|---|---|---|
| `--obey-robots` + `RobotStore`（1000 条缓存上限） | **完全没有 robots 概念**，而桥有批量读和 `browser_replay_request` | 自己实现：拉 `/robots.txt`、按 UA+path 匹配、带 TTL 缓存。**不管接不接 Lightpanda 都该做** |
| `--watchdog-ms`：连续 N 秒不回到网络轮询就终止 JS | 只有超时，没有「页面卡在死循环」的判定 | 抄语义：页面停滞与「慢」是两回事，前者不该等满超时 |
| `--dump markdown` 先向服务器要 `Accept: text/markdown`（日志里叫 `markdown served`），没有再自己转 | `browser_read` 只出纯文本 | 在 `browser_read` 加 `format:"markdown"`，先协商再本地转 |
| `--dump structured_data`（JSON-LD / OG / Twitter card） | 没有 | 便宜的加法：读一次页面就能出结构化元数据 |
| `/save` → PandaScript → `run`（确定性重放、零 token） | 已有 `browser_recipe_*` | **不是缺口，是印证**。他们把它当卖点，说明这条路是对的 |
| `--web-bot-auth-*`（HTTP Message Signatures + Ed25519 密钥目录） | 没有 | 长期值得盯：这是「让站点知道调用方是谁」的标准做法，和本项目「诚实身份」的取向一致 |

### 3.4 只做记录

- `Mcp-Session-Id` 的会话隔离语义（同 id 共享上下文，不同 id 各自独立 cookie/页面）——桥用的是 agent 身份 + 标签租约，模型不同，暂不需要。
- `--render-font`（CJK 字体，给 png/pdf/screenshot 用）——提醒：任何本地出图的路径都要单独解决中文字体，否则是豆腐块。
- `/metrics`（Prometheus 文本格式，默认开）——桥有 `usage-summary.js`，不需要。

## 四、明确不能用的五条

### 4.1 AGPL-3.0：**只能当独立进程，绝不 vendor**

桥是 MIT。把它的 Zig 源码或二进制打进分发物会触发 AGPL 的传染条款。**唯一安全形态是「用户自己装、我们通过 CDP/HTTP 调它」**，进程边界就是许可证边界。

### 4.2 不能当「真 Chrome」的替代

用户的登录态、扩展、`chrome://` 页面、真实渲染、Windows 原生——五条全不满足。这个项目的前提是「和人类工程师用同一个浏览器」，Lightpanda 结构上就不是那个东西。

### 4.3 截图是陷阱（本机实拍）

它返回的是**合法 PNG**（`89 50 4e 47` 头、85 KB、能打开），但画面是**纯文本排版**：没有 CSS、没有盒子、没有图片，默认衬线字体一路往下排。

所以任何「截图成功」的判定在这个 lane 上都会**技术性为真、实际为假**——正是本项目反复在消灭的那类假成功。如果接了 lane，`browser_screenshot` 必须**拒绝**，或至少带 `rendering:"text-only"`。

### 4.4 UA 不能装 Chrome

`--user-agent` 只要含 `Mozilla` 就 **fatal**：`invalid user-agent ... can't contain Mozilla`。这是它的立场，也意味着**风控会把这条 lane 当机器人**，而真 Chrome 那条不会。哪些站点能读、哪些读不了，是 lane 的固有属性，要在结果里说清楚。

### 4.5 `DOM.querySelector` 这类局部缺口

`DOM.getDocument` 给的 nodeId 在 `DOM.querySelector` 里报 `NodeNotFoundForGivenId`。桥的页面侧代码基本走 `Runtime.evaluate`，所以能活；但任何假定「Chrome 的 DOM 域一定在」的代码路径，换 lane 前都要审一遍。

## 五、如果只做一件事

**做 3.1 的只读旁路 lane，并且第一版就带 `lane` 字段与「绝不回退」。**

理由不是性能数字，是**风险结构**：现在每一次「读 30 个页面」都在动用户唯一那个浏览器。把只读任务挪到一条 39 MB、随时可弃的进程上，是把「可能打扰用户」从默认路径上摘掉。而 `lane` 字段保证这件事**可被审计**——谁读的、用哪个浏览器读的，写在结果里。

## 六、没验证的部分（别当结论用）

- 复杂 SPA（React 18 / Vue 3 水合）能不能跑通：只测了 quotes.toscrape 的 JS 渲染、GitHub 未测。
- 长会话稳定性、`--cdp-max-connections 16` 下的并发表现。
- `--obey-robots` 的具体匹配语义（是否读 crawl-delay）。
- WSL2 这一层对延迟的额外开销（本次没做对照测量）。
