# SaaS 控制台全流程会话：Bridge 能力缺口与改进提案（写侧 / Write Path）

- 日期：2026-11-01
- 对象：本机 ai-browser-bridge（MCP server `ai_browser_bridge`，111 个工具）
- 场景：一个真实 SaaS 控制台上跑完**写侧全流程** —— 注册/下单（含虚拟化下拉选择）→ 实例开通后**取运行时凭证**（无 JS 工具可用）→ 下发状态变更（POST）→ 回读验证 → 清理（再次 POST，且明确避开 DELETE）。
- 脱敏：站点是公开产品（Gitee AI / 模力方舟），下文一律用 `<tenant>` / `<instance_id>` / `<page>` 占位；**不含**任何账号、密码、Cookie、Token、主机地址、SSH 参数或业务数据。
- 证据分级：**实证** = 本次调用直接观察到的返回；**推断** = 基于实证的根因假设。
- 与既有文档的关系：见 §7。`CAPABILITY-GAP-ANALYSIS-2026-10-25.md` 已经立过「无页面内 JS 执行」「无网络捕获」两项，本文**不重复立项**，只补写侧的新受益面与 8 项新缺口。

> **历史时点说明（2026-11-03）**：本文描述的是 **2026-11-01** 的能力状态。本文中的「无页面内 JS 执行」以及 §2.1 的 `browser_devtools` 误导性文案，是当时的证据，不应作为当前能力结论。0.30.0 起页面表达式由 `browser_eval` 支持（主世界执行，CSP 拒绝时降级 CDP）；当前仍未实现的仅是「在 DevTools Console 面板输入行里键入」这个 UI 动作。保留本注以防将历史缺口重新当成现状。

---

## 0. 结论摘要

一句话：**读侧这条链路这一轮是能用甚至好用的；卡点全部集中在"写"和"省"上**——写操作没有执行前后的状态闭环，一次调用固定背 1.5 KB 与业务无关的文本，而工具发现本身要吃掉 68.6 KB。

| # | 级别 | 缺口 | 本次实证信号 | 10-25 是否已立项 |
|---|---|---|---|---|
| 1 | P0 | 写操作无「执行→回读→判定」闭环 | 关实例只能手写 POST，工具回 `dispatched:true` + 明确说"Whether the server changed anything cannot be known from here"，正确性全靠我自己再发一个 GET | 否（新） |
| 2 | P0 | 无页面内 JS 执行 → 同源 **POST** API 只能盲拼 | 取运行时凭证靠"把 tab 导航到 JSON 端点"绕过；POST 无同类旁路 | 是（10-25 §1.1），本文补写侧受害面 |
| 3 | P1 | `browser_replay_request` 的 confirmation **只按约定、不按风险**：GET 也要 | schema `required: ["tabId","method","url","confirmation"]`，与其自身算出的 `destructive:false / sideEffects:[]` 自相矛盾 | 否（新） |
| 4 | P1 | 单次响应固定开销 ≈1.5 KB（6 条 limitations + 12 个响应头） | 一次会话 20+ 次调用，累计约 30 KB 上下文 | 否（新） |
| 5 | P1 | 工具**发现**成本 > 使用成本 | `mcp_list(includeDescription:true)` 单服务 68.6 KB / 111 个工具 | 否（新） |
| 6 | P1 | 普通文本 fill **不做**持久化校验，secret fill 反而做 | 设置密码对话框需三读三填；普通文本框被 re-render 清空时无任何提示 | 部分（10-25 §1.4b 是"框架状态不同步"，本文是"校验缺位"） |
| 7 | P1 | 虚拟化列表：目标**根本没渲染**，click 静默失败 | 预装镜像级联第一列 `scrollHeight 576 / clientHeight 240`，PyTorch 等条目不在 DOM 里 | 否（新；10-25 §1.4a 是坐标命中容器，属不同成因） |
| 8 | P1 | click 被遮挡时不给**覆盖者可操作摘要** | `Element is covered`；须自己 `browser_scan_overlays` → 判 radix portal → Escape → **重读拿新 ref** | 部分（10-25 提到 overlay，本文给触发面） |
| 9 | P2 | schema 参数不一致，单会话 4 次拒收 | `browser_read` 无 `mode:"text"`；`browser_fill` 只收 `text`；`find_element` 必填 `tabId`；`browser_open` 拒收 `tabId` | 否（新） |
| 10 | P2 | `browser_tabs` 无 origin/标题过滤 | 20+ 个完整对象，每次肉眼找目标 tab | 否（新） |
| 11 | P2 | 空路由/404 无诊断 | `/<tenant>/dashboard/containers` 不存在，没有任何"这个路径没有路由"的信号 | 否（新） |

---

## 1. [P0] 写操作缺「执行 → 回读 → 判定」闭环

### 1.1 现象（实证）

本轮要对一台已付费实例执行「停止计费」：`POST /api/base/market/<tenant>/instances/<instance_id>/shutdown`。

工具侧能做，但返回只有：

```json
{"status":"success","dispatched":true,"destructive":true,
 "sideEffects":["a_real_request_was_sent_and_the_server_may_have_acted_on_it"],
 "response":{"status":200,"bodyText":"true"},
 "note":"A response was received. Whether the server changed anything cannot be known from here."}
```

这段文案本身是**诚实且正确**的（不撒谎、不自动重试）。问题是：**验证被完全推给了调用方**。我为了确认"计费真的停了"，又发了一个 `GET /instances`，人工比对 `status` 字段从 `running` 变成 `stopped`、`stopped_at` 被写入、`runtime` 固定。这一步没有工具支持，也没有结构化结果，只能靠人读 1 KB JSON。

对**破坏性操作**（本轮还涉及一个"绝不能碰"的 `DELETE` = 实例销毁，不可逆），这个缺口是安全性的：`destructive:true` 是在**发出去之后**才在响应里告诉我的，事前没有一道闸。

### 1.2 根因（推断）

`browser_prepare_action` 已经在点击前给出"目标绑定 / 可点性 / 预计后果"的事前证据；但 HTTP 层没有对应的 `prepare`。风险判定其实是**纯静态**的——只看 method + URL 模式就能算出（DELETE=销毁、POST=可能有副作用、GET=安全），根本不需要发请求。

### 1.3 改进建议

**① 事前闸：`browser_prepare_request`（只读，不发请求）**

```jsonc
{
  "tabId": 1,
  "method": "POST",
  "url": "https://<host>/api/.../instances/<id>/shutdown",
  "body": "{}",
  "expectedOrigin": "https://<host>"        // 可选：跨源时必须显式声明
}
// 返回：
{
  "riskLevel": "destructive",               // safe | mutating | destructive
  "reason": "method DELETE",
  "reversible": false,
  "requiresConfirmation": "replay_request_once",
  "sameOrigin": true,
  "wouldSendCookies": true,
  "urlPatternMatch": ["delete-instance"]     // 命中内置危险模式表
}
```

内置一张**危险模式表**即可覆盖绝大多数事故：`method == DELETE`、URL 命中 `/(delete|destroy|remove|terminate|shutdown|stop|reset|purge|cancel)/`、body 里出现 `force=true` 之类。表可以配置，但默认开启。

**② 事后闭环：给 `browser_replay_request` 加 `verify`**

```jsonc
{
  "tabId": 1, "method": "POST", "url": ".../shutdown", "body": "{}",
  "confirmation": "replay_request_once",
  "verify": {
    "url": "https://<host>/api/.../instances",   // 只读端点
    "method": "GET",
    "jsonPointer": "/0/status",                  // 期望值比对的位置
    "expect": "stopped",
    "pollMs": 1000,
    "maxWaitMs": 30000
  }
}
// 返回追加：
{ "verify": { "before": "running", "after": "stopped", "matched": true,
              "attempts": 3, "elapsedMs": 4100 } }
```

**为什么值得做**：这不是"多一个便利函数"。写操作的**正确性判定**目前完全在 agent 的推理里，每一次都要多花一个来回 + 一段人工比对；而对 SaaS 控制台这类场景，"发出去了但没生效"和"生效了但没确认"长得很像，agent 很容易误报成功。把 `before/after/matched` 变成结构化返回，是把一类系统性误判消掉。

**验收标准**：
- 对一个已知安全端点调 `browser_prepare_request` → `riskLevel:"safe"`、`wouldSendCookies:true`、**不产生任何网络请求**（Network 面板可证）。
- 对 `DELETE` 调 → `riskLevel:"destructive"`、`reversible:false`。
- `verify.matched:false` 时必须明确返回 `attempts` 与最后一次观测值，而不是超时静默。

---

## 2. [P0] 无页面内 JS 执行 —— 写侧受害面

10-25 那份已经把「无 JS 执行」立为 P0（采集侧：读后端 state、hook XHR 拿不到）。本次补充**写侧**的同一条根因，因为旁路完全不对称：

| 需求 | 有 JS 时的做法 | 没有 JS 时的旁路 | 本次是否可行 |
|---|---|---|---|
| 读一个同源 JSON API | `fetch(url).then(r=>r.json())` | **把 tab 导航到该 API URL，直接读文档** | ✅ 可行（本轮取凭证就走这条） |
| 写一个同源 API（POST） | 同上，带 body | 无 | ❌ 只能靠 `browser_replay_request` 手拼，且必须**事先已知**端点与 body 形状 |

也就是说：**读有旁路、写没有**。而写偏偏是风险更高、更需要精确的那一侧。

### 2.1 实证细节

取实例运行时凭证时，会话里没有任何 JS 能力（`browser_devtools` 的描述明确写着 "Console/script execution are not implemented"，"Detached DevTools and Console/script execution are not implemented"），最终靠：

1. `browser_open` 一个 tab，URL 直接指到 `https://<host>/api/base/market/<tenant>/instances`
2. `browser_read` 读回 JSON 文本
3. 正则取出 `ssh_props`

这条旁路**只在 GET 且同源时成立**，而且副作用是把浏览器的一个 tab 变成"一个 API 文档页"——每换一个端点就重导航一次。

### 2.2 建议

优先做 10-25 §1.1 提的 `browser_evaluate`；如果短期不做，至少给一个**有名字、有文档的 `browser_fetch`**：

```jsonc
{
  "tabId": 1,
  "method": "GET",              // GET | POST
  "url": "https://<same-origin>/api/...",
  "headers": { "Content-Type": "application/json" },
  "body": "{}",                 // 仅 POST
  "maxBytes": 262144,
  "confirmation": "replay_request_once"   // 仅 mutating 时要求
}
```

它与现有 `browser_replay_request` 的差别只有两点：**（a）名字与文档承认它是"发一个同源请求"，而不是"重放 Network 面板里的一条"；（b）安全方法免确认**。功能上零新增实现，属纯"把已有能力正名 + 收敛确认门"。

**验收标准**：文档里能搜到"如何在不执行 JS 的前提下与该页面的同源 API 对话"，且 GET 不需要 `confirmation`。

---

## 3. [P1] `browser_replay_request` 的确认门只按约定、不按风险

### 3.1 现象（实证）

schema：`required: ["tabId","method","url","confirmation"]`，`confirmation` 恒为 `"replay_request_once"`。

而同一个工具的**响应**里已经给出了风险判定：

```json
{"method":"GET","destructive":false,"sideEffects":[],"retryable":false}
```

即：工具**已经知道这次是只读的**，但事前仍然要求一次性确认字符串。本轮为了轮询实例状态、读额度、读流水，重复了 6~8 次 GET，每次都要带同一个 constant。

### 3.2 影响

- 摩擦是**真实的**但不是"多打几个字"级别的：它把"只读探查"和"破坏性写入"放在同一个心智档位上，久而久之 agent 会对 `confirmation` 脱敏，**真正的危险操作也就不再有警戒感**。这是安全设计上的反向激励。
- 与 AGENTS.md 的 `Never automatically replay an uncertain write` 精神不一致：该规则约束的是 **write**，工具却把 read 也一并约束了。

### 3.3 建议

```
confirmation 规则改为：
  GET / HEAD / OPTIONS            → 不需要
  POST / PUT / PATCH / DELETE     → 需要 "replay_request_once"
  覆盖：method 安全但 url 命中危险模式表 → 仍需要
  覆盖：调用方显式传 requireConfirmation:true → 仍需要
```

**验收标准**：一次会话内连续 10 次 GET 不需要任何 confirmation；一次 POST 仍需要。

---

## 4. [P1] 单次响应固定开销 ≈1.5 KB

### 4.1 现象（实证 / 估算）

每次 `browser_replay_request` 返回的 JSON 里，**与业务无关**的固定部分包括：

- `limitations`：6 条长句（"This is not a copy of a Network-panel entry…"、"Requests signed with a one-time CSRF token…" 等），约 0.9 KB
- `headers`：12 个响应头键值对（`bdwaf-request-id` / `x-trace-id` / `server: ADAS/1.0.214` …），约 0.6 KB
- `contentTrust`、`note`、`requestUrl` 之类的回显

单次约 1.5 KB。本轮同类调用 20+ 次 ⇒ 约 30 KB 的上下文预算花在**重复读同一段免责声明**上。对长会话来说这是实打实的成本：它挤掉的不是"好看"，是能用来干活的窗口。

### 4.2 建议

```jsonc
{ "verbosity": "terse" }   // 新增可选参数
// terse 模式只回：
{ "status": "success", "httpStatus": 200, "bodyText": "...", "bodyTruncated": false }
// 首次调用（或带 verbose:true 时）仍回全量
```

或者按 agent 维度做"**该会话已确认过免责声明**"的一次性开关：第一次给全量，之后只给差异。

**验收标准**：`terse` 模式下响应 < 400 字节（不含 body），且关键字段（status / httpStatus / bodyText）一个不少。

---

## 5. [P1] 工具发现成本 > 使用成本

### 5.1 现象（实证）

- `mcp_list({keyword:"ai_browser_bridge"})`（**不带**描述）→ 只有工具名，无法据此选工具
- `mcp_list({..., includeDescription:true})` → **68.6 KB / 111 个工具**

两个档位都不好用：不带描述选不了，带描述吃 68.6 KB。而本轮实际用到的工具只有 **11 个**。

### 5.2 建议

**① 一个 `browser_capabilities` 之外的"意图索引"**：按任务分组，每组一句话 + 组内工具名。

```markdown
读页面     : browser_read, browser_observe, browser_ax_snapshot, browser_find_text
点/填/选   : browser_click, browser_fill, browser_select, browser_find_element, browser_prepare_action
网络       : browser_replay_request, browser_network_summary
标签管理   : browser_tabs, browser_open, browser_claim_tab, browser_release_tab
诊断       : browser_health, browser_scan_overlays, browser_debug
```

约 30 行覆盖 90% 场景，成本 < 2 KB。

**② `browser_find_tool` / `mcp_list` 支持 `fields:"name,summary"`**：一句话摘要（≤80 字符）而不是整段。

**③ 可选：把低频维护类工具（bookmarks / history / privacy_settings / certificates / extensions …）默认折叠**，只在显式 `include:"all"` 时列出。111 个工具里真正影响自动化的不到 30 个。

**验收标准**：一个新 agent 从零到选对第一个工具，读取量 < 5 KB。

---

## 6. [P1] fill 的持久化校验：优先级反了

### 6.1 现象（实证）

`browser_fill` 的描述明确写了 secret 路径的校验：

> "A secret fill still refuses hidden inputs and anything inside `[data-ai-private]`, and its reply **reports the length and a boolean match** but never echoes the value"

也就是说：**密码框填完会校验有没有真的进去**。但**普通文本框没有这一层**。

本轮在两个普通输入框（设置密码对话框的两个字段）上，填完后的 re-render 把两个框**清空**并把"确认"按钮置灰。工具没有报任何异常——从返回看是"填成功了"。我是**肉眼读页面**才发现的。修复方式：重新 `browser_read` 拿新 refs → 再填一次 → 再找"确认" → 才点得上。同样的事在 `browser_fill("")` 清空搜索框时也发生过（10-25 §1.4b 记录的是"页面视图不退出"，同一个根因的另一种表现）。

### 6.2 根因（推断）

受控组件（React/Vue）在 `input`/`change` 之后异步 setState，组件重渲染可能用**旧值**覆盖 DOM 值，或直接重建节点让 ref 失效。secret 路径因为"不能回显"而必须做一次内部比对，恰好覆盖了这种情况；普通路径默认"写进 DOM 就是成功"，没有复核。

### 6.3 建议

把 secret 路径已有的校验**提升为默认行为**：

```jsonc
browser_fill {
  "tabId": 1, "ref": "e123", "text": "Hello",
  "verify": true            // 默认 true（普通文本）
}
// 返回追加：
{ "persisted": true, "observedLength": 5, "refStillValid": true }
// 若 persisted:false，附带诊断：
{ "persisted": false,
  "reason": "value reverted after render",
  "suggestedRef": "e127",        // 重读后的新 ref（若已能定位同一个字段）
  "suggestedAction": "retry_fill" }
```

更进一步，`persisted:false` 时可以自动**重取 ref 再填一次**（一次性、幂等、文本内容确定，重试没有副作用风险），把三读三填压成一次调用。注意：这条自动重试仅限 **fill 文本**，不适用于点击/提交。

**验收标准**：在一个 React 受控组件上 fill 后立刻 re-render，返回 `persisted:false` 而不是"成功"。

---

## 7. [P1] 虚拟化列表：目标根本没渲染，click 静默失败

### 7.1 现象（实证）

下单页的"预装镜像"级联选择器，第一列是一个固定高度滚动容器：

```
<div class="max-h-60 overflow-y-auto">   scrollHeight=576  clientHeight=240
```

**后面的条目（如 PyTorch）此刻根本不在 DOM 里**。`browser_find_element` / 按文本查找都找不到，`browser_click` 拿不到可点目标。我最终是手动把该容器滚到底，等新条目渲染出来，才点中的。

这与 10-25 §1.4a 记录的"坐标点击命中容器"**不是一个成因**：
- 10-25：元素**在** DOM 里，只是坐标命中被判给父容器（事件委托）
- 本次：元素**不在** DOM 里，虚拟化按需渲染

### 7.2 建议

**① click 失败时给准确病因**，不要笼统说找不到：

```jsonc
{ "found": false,
  "reason": "not_rendered",                       // vs "not_found" / "covered" / "disabled"
  "scrollContainer": { "selector": "div.max-h-60.overflow-y-auto",
                       "scrollTop": 0, "scrollHeight": 576, "clientHeight": 240,
                       "totalNeeded": 3 },         // 还需要滚几屏
  "suggestedAction": "browser_scroll_element" }
```

**② `browser_find_text` 支持"容器内逐屏查找"**：

```jsonc
{ "query": "PyTorch", "scrollContainer": "auto", "maxScreens": 10 }
```

命中后直接返回 ref（或返回"已滚到该屏，ref 为 eNNN"）。

**③ 更通用的 `browser_virtual_list`**：给定容器与索引，滚到该索引并等渲染稳定。级联/树/表格在 SaaS 后台里极常见，这一类问题的复发率很高。

**验收标准**：在上述 cascader 上按文本找"PyTorch"，一次调用成功（不许要求调用方先手工滚）。

---

## 8. [P1] click 被遮挡：不给覆盖者可操作摘要

### 8.1 现象（实证）

点"下一步"时返回 `Element is covered`。真实原因是**上一级 radix 的 popover 还挂载着**（`[data-radix-popper-content-wrapper]`），视觉上已经关了但 DOM 还在。解决路径是：`browser_scan_overlays` → 看到该 wrapper → 判断是 portal → 发 `Escape` → **重新 `browser_read` 拿新 refs** → 再点。

四步里，工具只在第一步帮了忙；后面三步全靠经验。

### 8.2 建议

click 失败时直接回**覆盖者的可操作摘要**，而不是让 agent 从零诊断：

```jsonc
{ "error": "covered",
  "coveredBy": {
    "tag": "div",
    "selector": "[data-radix-popper-content-wrapper]",
    "role": "portal-overlay",
    "zIndex": 50,
    "dismissible": true,
    "dismissPath": "escape",          // escape | click_outside | dismiss_button
    "rect": { "x": 0, "y": 0, "w": 1280, "h": 800 }
  },
  "suggestedAction": "browser_key(keys:\"Escape\") 然后 browser_read 重取 refs" }
```

配套：`browser_dismiss_overlay` 里可以加一条 `selector` 精确关闭（现在只有"关掉挡路的那个"的泛化语义）。

**为什么值得**：`ref 一次性`（10-25 §1.5）意味着 Esc 之后必须重读——这条**链式知识**现在只存在于 agent 的经验里。工具完全有条件把它变成结构化指引，一次省掉两个来回。

**验收标准**：在 radix/antd/mui 的 portal 遮挡上 click，返回的 `dismissPath` 能直接执行成功。

---

## 9. [P2] schema 参数不一致：单会话 4 次拒收

### 9.1 实证清单（都是本次真实撞到的）

| 调用 | 我传的 | 实际要求 | 结果 |
|---|---|---|---|
| `browser_read` | `mode:"text"` | `enum:["normal","cheap"]` | 拒收 |
| `browser_fill` | `value:"..."` | 只收 `text` | 拒收 |
| `browser_find_element` | 省了 `tabId` | `required:["tabId","query"]` | 拒收 |
| `browser_open` | 带 `tabId` | 无此字段 | 拒收 |

同类里 `browser_click`/`browser_select`/`browser_hover` 又要 `tabId`。**同一个参数在 111 个工具里有"必填 / 可选 / 不存在"三种待遇。**

### 9.2 建议

1. **`tabId` 全 family 可选**，缺省 = 当前活动 tab（或该 agent 持有的 lease 上的 tab）。只有需要**跨 tab** 时才必须显式给。
2. **`text` / `value` 互为 alias**（`fill` / `select` / `type` 统一）：校验层接受两者，内部归一。
3. **`mode` 之类的枚举改名或放宽**：`browser_read` 的 `normal|cheap` 与直觉的"text/html/markdown"无关，建议改成语义化名字或接受别名。
4. **校验失败给"你是不是想要 X"**：现在返回的是裸 `additionalProperties` 错误。改成：

```jsonc
{ "error": "unknown_parameter",
  "received": "value",
  "didYouMean": "text",
  "hint": "browser_fill 用 text 承载要填入的内容" }
```

**验收标准**：一条"从浏览器任务直觉出发"的调用序列（读→找→填→点）零 schema 拒收。

---

## 10. [P2] `browser_tabs` 无过滤

### 10.1 现象（实证）

本轮 `browser_tabs` 返回 **20+ 个完整对象**（title / url / windowId / restricted / bridgeCreated …）。我要找的是"那个在 `ai.gitee.com` 上的 tab"，每次都要肉眼扫一遍；而且返回体本身就不小。

### 10.2 建议

```jsonc
browser_tabs { "origin": "https://ai.gitee.com" }   // 按 origin
browser_tabs { "titleContains": "实例管理" }         // 按标题
browser_tabs { "urlContains": "/dashboard/compute" }
browser_tabs { "fields": "id,title,url" }           // 精简字段
```

**验收标准**：20+ tab 环境下定位目标 tab 只需一次调用且返回 < 300 字节。

---

## 11. [P2] 空路由 / 404 无诊断

### 11.1 现象（实证）

按直觉导航到 `/<tenant>/dashboard/containers` —— 这个路径**不存在**（真实路径是 `/<tenant>/dashboard/compute/instances`）。页面既没报错也没重定向，读回来是个空壳。我花了两次调用才确认"不是我找错元素，是这条路根本没有页面"。

### 11.2 建议

`browser_read` / `browser_observe` 在检测到 SPA 空挂载时补一条诊断字段：

```jsonc
{ "diagnostics": {
    "emptyMount": true,
    "reason": "no_route_matched",
    "httpStatus": 200,
    "hint": "SPA 渲染容器为空，可能是客户端路由不存在" } }
```

或在 `browser_navigate` 后主动判一次 `#root`/`#app` 的 `childElementCount == 0` 并给出提示。

---

## 12. 运行良好、建议作为回归基线的部分

这些在本轮**真实救过场**，改动时不要退化：

1. **`browser_replay_request` 的同源 fetch + `credentials:"include"`**：在完全无 JS 的前提下，这是唯一能拿到结构化数据的通道。本轮取凭证、读状态、读额度、执行关停全靠它。**这是 111 个工具里价值最高的一件。**
2. **不确定性语义**：超时报 `status:"uncertain"` + `reason:"replay_timeout"` 而不是 failure；**从不自动重试**；响应里主动计算 `destructive` / `sideEffects` / `retryable`。这套语义是对的，建议其他工具照抄。
3. **`restricted:true` + `restrictedReason`**：不可读的 tab 明确标注原因（`origin_not_allowed` / `non_http`），而不是让 agent 猜"为什么读不到"。
4. **"列出但不能读"的设计**：不可读的 tab 仍然列出。这让"我是不是开错了 tab"这类判断变得可证伪。
5. **`browser_scan_overlays`**：一次调用就把覆盖层点到名（radix popover），是本轮诊断效率最高的一次调用。
6. **`browser_open` 的 reuse 语义**：忽略 `#fragment` 与尾斜杠、但**保留 query**（`?id=1` 与 `?id=2` 绝不混淆）。下单页带 `?id=40`，正是靠这条规则没有和别的订单页串味。这个细节做得很对。
7. **敏感字段的双向保护**：`browser_read` 明确 "No password values"，`browser_fill` 需要 `secret:true` 且拒绝 `[data-ai-private]` 与隐藏输入，返回"长度 + 是否匹配"而不回显。
8. **`browser_health` / `browser_capabilities` / `browser_agent_guide` 三个自描述入口**：开工前的握手有明确落点。

---

## 13. 建议的实施顺序

按「改动面 / 收益」排，不是按级别排：

| 顺序 | 项 | 改动面 | 收益 | 备注 |
|---|---|---|---|---|
| 1 | ③ GET 免确认（§3） | 极小（一个 if） | 每次只读调用都受益 | 一行逻辑，风险为零 |
| 2 | ④ `verbosity:"terse"`（§4） | 小（响应序列化） | 每次调用都受益 | 长会话尤其 |
| 3 | ⑨ 参数一致性（§9） | 小（schema 归一 + 别名） | 消除系统性拒收 | 纯 ergonomics |
| 4 | ⑥ fill 持久化校验（§6） | 小（复用已有 secret 校验） | 消掉一类"假成功" | 已有实现可直接搬 |
| 5 | ⑦ 未渲染诊断（§7） | 中（滚动容器探测） | 消掉一类静默失败 | |
| 6 | ⑧ 遮挡者摘要（§8） | 中（click 失败分支） | 省两个来回/次 | |
| 7 | ⑤ 工具索引（§5） | 中（文档 + 一个工具） | 每个新 agent 都受益 | 可以先只写文档 |
| 8 | ① 写操作闭环（§1） | 大（prepare + verify） | 消掉写侧系统性误判 | 优先级最高、成本也最高 |
| 9 | ② JS / fetch 正名（§2） | 大（见 10-25 §1.1） | 打开整个写侧上限 | 与 10-25 合并立项 |

如果只做一件：**做 ①**。它消掉的是"写操作是否正确"这个 agent 现在只能靠推理回答的问题。
如果只做三件且要低成本：**③ + ④ + ⑨**，一天之内可完成，且每一次调用都受益。

---

## 14. 复现序列（脱敏）

一次完整的写侧会话，按实际发生顺序，标出每一步的摩擦点：

```
1  browser_health                                   OK
2  browser_tabs                                     ← 20+ 对象，无过滤（§10）
3  browser_open  <page>                             ← 若带 tabId 会被拒（§9）
4  browser_read  tabId                              OK
5  browser_find_element  {tabId, query:"立即购买"}   ← 必须有 tabId（§9）
6  browser_click  ref                               OK
7  browser_find_element  省了 tabId                  ← 拒收（§9）
8  browser_read  {mode:"text"}                      ← 拒收，enum 只有 normal|cheap（§9）
9  browser_read  {mode:"normal"}                     OK
10 browser_click  下一步                             ← "Element is covered"
11 browser_scan_overlays                            ← 定位到 [data-radix-popper-content-wrapper]
12 browser_key  Escape                              ← 需要 agent 自己想到这一步（§8）
13 browser_read  （必须重读，旧 ref 已失效）          ← ref 一次性（10-25 §1.5）
14 browser_click  下一步                             OK
15 browser_find_element  "预装镜像"                  ← 目标未渲染，静默失败（§7）
16 browser_scroll_element  容器                      ← 手工滚才拿到条目（§7）
17 browser_click  镜像条目                           OK
18 browser_fill   {value:"..."}                      ← 拒收，只收 text（§9）
19 browser_fill   {text:"...", ref}                  ← 返回成功，但 re-render 后为空（§6）
20 browser_read   （发现两框为空、"确认"置灰）
21 browser_fill   ×2                                 ← 三读三填（§6）
22 browser_click  确认                               OK
23 browser_navigate /<tenant>/dashboard/containers   ← 路由不存在，空壳，无诊断（§11）
24 browser_navigate /<tenant>/dashboard/compute/instances   OK
25 browser_replay_request GET  .../instances         ← 每次都要 confirmation（§3）+ 1.5 KB 固定开销（§4）
26 browser_replay_request GET  .../instances/<id>    ← 取 ssh_props（无 JS 时的唯一通道，§2）
27 browser_replay_request POST .../<id>/shutdown     ← dispatched:true，但无 verify（§1）
28 browser_replay_request GET  .../instances         ← 人工比对 status=running→stopped（§1）
```

摩擦点统计：**schema 拒收 4 次、静默失败 1 次、假成功 1 次、需要 agent 经验补位的诊断 3 次（遮挡诊断、ref 失效重读、未渲染滚动）**。

---

## 15. 与既有文档的关系

| 议题 | `CAPABILITY-GAP-ANALYSIS-2026-10-25.md` | 本文 |
|---|---|---|
| 无页面内 JS 执行 | §1.1 立项（P0，采集侧） | §2 **不重复立项**，补写侧受害面与"读有旁路、写没有"的不对称 |
| 无网络体捕获 | §1.2 立项（P0） | 未新增证据，维持原立项 |
| 原始 HTML 不可达 | §1.3（P1） | 未涉及 |
| fill 与框架状态不同步 | §1.4b（清空后视图不退出） | §6 同一根因的**另一表现**（re-render 覆盖 + 无持久化校验），建议按本条实现 |
| 坐标点不到行 | §1.4a（事件委托） | §7 **不同成因**（虚拟化未渲染），建议分开修 |
| ref 一次性语义 | §1.5（P2） | 未改判，但在 §8 里提出"用结构化指引替代经验"的做法 |
| 写操作闭环 | 未涉及 | §1 新增（P0） |
| 确认门 / 响应体积 / 工具发现 / 参数一致性 | 未涉及 | §3 §4 §5 §9 新增 |

---

## 16. 事实边界

- 本文所有"实证"条目均可由 §14 的序列复现；站点为公开产品，**所有账号、密码、Cookie、Token、实例标识、主机地址均已脱敏为占位符**。
- §4 的 1.5 KB 为**估算**（按本次两次同类响应的固定字段长度累加），不是逐字节测量。
- §5 的 68.6 KB 是 `mcp_list({keyword:"ai_browser_bridge", includeDescription:true})` 的**实际返回体积**。
- §1.2 / §6.2 / §7 的根因段落为**推断**，标注方式沿用 10-25 文档的规范。
- 本文只覆盖 MCP 工具面（`ai_browser_bridge` server）的可用性与人体工学，**不涉及**扩展实现、CDP 通道、native host 的内部质量。
