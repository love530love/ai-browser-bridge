# FlagOS 赛况页卡点复盘：role-less 可点元素（React onClick）的发现与点击盲区

- 日期：2026-11-04
- 对象：本机 ai-browser-bridge（MCP server `ai_browser_bridge`，版本 **0.32.0**，111 个工具）
- 场景：在 FlagOS 赛季2 赛况页 `https://flagos.io/race-detail-season2?id=782kzq4m&lang=cn&task=105` 上，试图点开「我的参赛」子标签与单题「查看单题榜」按钮，以读取 AICity 战队在 Task 179/181/182/183 昆仑芯的有效提交状态。
- 证据分级：**实证** = 本次调用直接观察到的返回 / 源码 `src/tools.js`、`src/agent.js` 中的定义与注释；**推断** = 基于实证的根因假设。
- 与既有文档的关系：见 §7。本文**不重复** 11-01 文的写路径/虚拟化列表/overlay 议题，只补「role-less 可点元素的发现死路」。同时**纠正**一篇内部对话中对本项目的两处误判（见 §2 末尾更正说明）。

> **历史时点说明（2026-11-04）**：本文描述的`browser_eval`/`browser_prepare_coordinate`/`browser_find_text({includeMatchElement})`/`browser_shadow_tree({includeClickable})` 均为 0.32.0 当前已实现能力。诊断结论以本次核对的源码为准，不沿用任何早期记忆中的旧状态。

---

## 0. 结论摘要

一句话：**这次卡住不是因为"能力缺失"，而是因为"引导缺失"——能力都在，但自然循环 `observe → click` 在 role-less 可点元素上静默断链，且没有指向下方兜底工具的下一步提示。**

| # | 级别 | 类别 | 缺口（或更正） | 实证信号 |
|---|---|---|---|---|
| 1 | P1 | 引导缺失 | `browser_observe`/`browser_read` 对「有交互文本但无 ref」的元素**不给出 nextStep 提示**，自然循环在此死路 | observe 返回页面其余 ref，`我的参赛`/`查看单题榜` 无 ref、无建议 |
| 2 | P1 | 工具过度承诺 | `browser_find_element` 对纯 onClick 文字只返回「unverified text target」，**无 clickable ref**；未交叉引用 `browser_find_text({includeMatchElement:true})` | `src/tools.js:156` 注释明写"Exact-text anchors without href may be surfaced as unverified text targets" |
| 3 | P2 | 兜底可见性 | 真正的破局工具 `browser_eval` 未在 AGENTS.md 点击指引、observe 失败路径中显式点名；111 工具下发现成本高 | `src/tools.js:133` 注释已声明其为通用 escape hatch；但 AGENTS.md:30 仅提 `find_element` |
| 4 | P2 | 真实增强 | role-less 可点元素**未折进默认 observe 输出**，必须改用专门工具/eval 才能点到 | `browser_shadow_tree` 注释（`src/tools.js:140`）承认其"invisible to browser_read, browser_find_element and browser_pick"，需 `includeClickable:true` 才可见 |
| — | — | 更正 | 「坐标点击被锁死」是**误判**：`browser_prepare_coordinate` 提供受控坐标路径（preflight 产 token，dispatch 时重命中），是正确安全设计，非死路 | `src/tools.js:426`、`src/agent.js:54` |
| — | — | 更正 | 「三个发现工具全盲」是**误判**：`browser_shadow_tree({includeClickable:true})` 与 `browser_find_text({includeMatchElement:true})` 均能命中 role-less 元素 | `src/tools.js:140`、`:142` |

---

## 1. [P1/P2] 复现序列（实证）

目标页是重 SPA（FlagOS 赛况页）。已登录、标签已激活（tabId 663192416）。

1. `browser_observe`（maxChars 12000）→ 返回完整榜单与若干 ref，但「我的参赛」子标签、「查看单题榜」按钮**均无 ref**。多次 observe 出现 `sameAsPrevious:true`（重 SPA hydrate 抖动，11-01 文 §1.2 同款表现）。
2. 尝试 `browser_action({action:"Tap", x, y})`（估算坐标）→ 返回要求 `coordinateToken`，而该 token 只能来自 observe/find_element 返回的几何信息 → 自然坐标路径被门挡（这是**正确**的安全设计，见 §2 更正）。
3. 退而试 `browser_find_element({query:"我的参赛"})` → 返回的是**未验证文本目标（unverified text target）**，不是可点 ref；拿不到 `browser_click` 需要的 ref。
4. 试 URL 参数 `&tab=my` → SPA 忽略，页面未切换（说明「我的参赛」不是路由参数，而是 React 状态切换的 onClick span）。
5. 至此自然循环 `observe → find_element → click` 全部断链；未意识到应使用 `browser_eval` / `browser_find_text({includeMatchElement:true})` / `browser_shadow_tree({includeClickable:true})`，遂中止并上报缺口。

**根因定位**：第 1 步 observe 已断链，但**返回里没有任何"该交互文本无 ref，请改用 X"的提示**；后续步骤在错误路径上反复尝试，而非切换到正确工具。

---

## 2. [更正] 已存在、但本次未用对的能力（实证，src/tools.js）

### 2.1 `browser_eval` —— 通用 escape hatch（**真正的破局手段**）
`src/tools.js:133` 注释原文：
> "when a card, tile, canvas, shadow root or modal control cannot be scanned, ref-ed or hit by coordinate, one expression reaches it - `[...document.querySelectorAll(".card")][1].click()`."

对 role-less onClick span，直接：
```js
[...document.querySelectorAll('span,div')].find(e=>e.textContent.trim().includes('我的参赛')).click()
```
即可绕过 ref 体系完成点击。`mode:"read"` 默认遮蔽 fetch/XHR 等副作用（护栏非沙箱），`mode:"write"` 用于主动操作。CSP 禁止 eval 时自动降级 CDP 通道。

### 2.2 `browser_find_text({includeMatchElement:true})` —— 按文本取最深可见元素的 ref
`src/tools.js:142`：
> "pass includeMatchElement:true to also get `matchElements`, the deepest visible element that contains each matched text, with a usable ref, rect and covered flag."

对「我的参赛」这类纯文字标签，这是**比 find_element 更对的工具**——find_element 只给 unverified text target，find_text+includeMatchElement 给**带 ref 的最深元素**。

### 2.3 `browser_shadow_tree({includeClickable:true})` —— 显式枚举 cursor:pointer 容器
`src/tools.js:140`：
> "elements that are clickable without being controls: a div whose computed cursor is pointer and that has no href, role or tabindex. That second kind is what a React onClick on a card or tile leaves behind ... invisible to browser_read, browser_find_element and browser_pick ... Use for ... modal card groups."

设 `includeClickable:true` 后会返回 `kind:"clickable"` 条目（带 ref），可经 `browser_click` 命中。

### 2.4 `browser_prepare_coordinate` —— 受控坐标路径（**非死路，更正旧误判**）
`src/tools.js:426`：只读 preflight，基于新鲜截图把坐标绑定到下方 DOM 元素，dispatch 时重命中测试，返回 `coordinateToken`。`src/agent.js:54` 的 `coordinateToken` 闸门正是对接它——**先 prepare 再 Tap 是设计内的受控坐标点击**，并非"坐标被锁死"。旧对话中"坐标点击锁死"的判读应作废。

> **结论**：本次卡点 90% 是「没走对工具 + 没收到指路提示」，10% 是「默认 observe 不把 role-less 可点元素折进输出」这一真实增强项。能力侧并非缺失。

---

## 3. [P1] 真实缺口 A：observe 断链无 nextStep（引导缺失）

`browser_observe`（`src/tools.js:281`）在「页面有交互文本、但目标元素无语义 role/无 ref」时，只返回其它元素的 ref，**不产出任何"该文本无法 ref，请改用 find_text/includeMatchElement 或 shadow_tree/includeClickable 或 browser_eval"的提示**。agent 沿 `observe→click` 直觉进入死循环，不会自然跳到 §2 的兜底工具。

**影响面**：所有用 React/Vue 的 SPA 标签、文字按钮、可点卡片（占现代 Web 极大比例）都会触发。

---

## 4. [P1] 真实缺口 B：`browser_find_element` 过度承诺（实证）

`src/tools.js:156`：
> "Exact-text anchors without href may be surfaced as unverified text targets, not guaranteed links or buttons."

对纯 onClick span，`browser_find_element({query:"我的参赛"})` 返回的正是「unverified text target」——**没有 clickable ref，不能传给 browser_click**。agent 可能误把它当可操作目标而失败，或误以为"工具彻底盲了"而放弃。且 `browser_find_element` 文档**未交叉引用** `browser_find_text({includeMatchElement:true})` 这个更对的同族工具。

---

## 5. [P2] 真实缺口 C：`browser_eval` 兜底可见性不足（发现成本）

`browser_eval`（`src/tools.js:133`）在文档里已被声明为通用 escape hatch，且在 `capability-guide.js:183` 作为 `browser_pick` 失败时的 fallback 列出。**但**：
- AGENTS.md:30 的点击规则只写 "Use `browser_prepare_action` and `browser_find_element` before clicks"，**未把 `browser_eval` 列为 role-less 兜底**；
- observe 失败路径不提示 eval；
- 111 工具下，关键兜底工具未被 ToolSearch 主动带出（11-01 文 Gap 5「工具发现成本 > 使用成本」同款）。

---

## 6. [P2] 真实增强 D：role-less 可点元素折进默认 observe（能力增强）

`browser_shadow_tree` 注释（`src/tools.js:140`）承认这类元素对 `browser_read`/`browser_find_element`/`browser_pick` **不可见**，需 `includeClickable:true` 才可见。当前默认 `browser_observe`/`browser_read` 不启用该逻辑，故 agent 必须**先知道**要切专门工具。最省心的修复是把 "cursor:pointer 且无 href/role/tabindex 的容器" 直接作为 clickable ref 折进默认 observe 输出（即把 shadow_tree 的 includeClickable 逻辑默认化）。这是唯一需要改代码的真实能力项。

---

## 7. 根因（推断）

`browser_observe`/`browser_read` 的元素抽取以**语义控件**（a/button/input/role/tabindex）为主键；role-less 的 React onClick 容器被归入 `browser_shadow_tree` 的**独立 pass**（`includeClickable:true`），不在默认读取循环内。结果是：默认路径对这类元素"看不见"，而跳转专门工具的**信号链缺失**（observe 不提示、find_element 过度承诺、AGENTS.md 未点名 eval），agent 即陷入死路。

---

## 8. 改进建议（按性价比排序）

1. **[P2, 最小改动] 折进默认 observe**：`browser_observe`/`browser_read` 默认把 "computed cursor:pointer 且无 href/role/tabindex 的容器" 作为 `kind:"clickable"` ref 输出（复用 shadow_tree 既有逻辑）。覆盖极广，改动小。
2. **[P1, 零代码·指南] observe 失败提示**：当目标文本/区域无语义 ref 时，observe 返回 `nextStep` 字段，指向 `browser_find_text({includeMatchElement:true})` → `browser_shadow_tree({includeClickable:true})` → `browser_eval`。
3. **[P1, 零代码·指南] 修正 `browser_find_element` 文档**：明确"纯文本 onClick 元素请用 `browser_find_text({includeMatchElement:true})` 取 ref"，消除过度承诺。
4. **[P2, 零代码·指南] 更新 AGENTS.md:30 点击规则**：增加 "role-less 可点元素（React onClick span/div）：优先 `browser_find_text({includeMatchElement:true})`，仍无则用 `browser_shadow_tree({includeClickable:true})` 或 `browser_eval`"。
5. **[P2] capability-guide 扩展**：将 `browser_eval` 显式列为 `observe→click` 死路的 fallback（目前仅 pick 失败列了它，见 `capability-guide.js:183`）。

---

## 9. 证据附录（精确引用）

| 主张 | 位置 | 原文/信号 |
|---|---|---|
| role-less 可点元素对 read/find_element/pick 不可见 | `src/tools.js:140` | "a div whose computed cursor is pointer and that has no href, role or tabindex ... invisible to browser_read, browser_find_element and browser_pick" |
| browser_eval 是通用 escape hatch | `src/tools.js:133` | "when a card, tile, canvas, shadow root or modal control cannot be scanned, ref-ed or hit by coordinate, one expression reaches it" |
| find_text 可带 includeMatchElement 取 ref | `src/tools.js:142` | "pass includeMatchElement:true to also get `matchElements`, the deepest visible element that contains each matched text, with a usable ref" |
| find_element 对纯文本只给 unverified text target | `src/tools.js:156` | "Exact-text anchors without href may be surfaced as unverified text targets, not guaranteed links or buttons" |
| 坐标点击需 coordinateToken（受控路径，非锁死） | `src/agent.js:54` / `src/tools.js:426` | `if (... 'x' in args && !coordinateToken) → No action dispatched`; `browser_prepare_coordinate` 提供 token |
| AGENTS.md 点击规则只提 find_element | `AGENTS.md:30` | "Use `browser_prepare_action` and `browser_find_element` before clicks" |
| pick 失败已列 browser_eval 为 fallback | `capability-guide.js:183` | fallback: [...PICK, 'browser_shadow_tree', 'browser_eval'] |

---

## 10. 与既有文档关系

- **`CAPABILITY-GAP-ANALYSIS-2026-11-01.md`**：覆盖写路径、虚拟化列表（§7）、overlay 遮挡（§8）——成因与本文明示不同（本文明示是"语义抽取盲区 + 引导缺失"），**不重复立项**。
- **`ai-browser-bridge-阻塞与不便清单.md` §2.4**：曾建议"给受控 `clickAt(x,y)` 兜底"——**现已由 `browser_prepare_coordinate` 实现**，本条标记已解决，本文明示更正旧误判。
- 本文新增：**role-less 可点元素的"发现死路 + 指南未指路"**，以及"默认 observe 折入 clickable ref"这一真实增强项。
