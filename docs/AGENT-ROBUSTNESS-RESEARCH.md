# 让「很弱的 agent」也能把事做完：调研与取舍

> 调研时间 2026-10-27。目标不是「再支持几个 API」，而是回答一个问题：**一个看不懂页面的 agent，凭什么能完成任意目的？**
> 本文只写结论和证据，不写宣传。凡是没有实测过的，都标明「未验证」。

---

## 1. 先把目标拆成可测的东西

「弱 agent 也能顺畅完成」不是一句口号，它至少要能回答五个问题。下面每条都是可测的，也是本文评估任何方案的标准：

| # | 能力 | 弱 agent 的典型失败 | 可测的判据 |
|---|---|---|---|
| 1 | 看懂页面 | 把 3 万个 DOM 节点塞进上下文，或只看截图猜坐标 | 一次调用能拿到「能点的东西 + 稳定的引用」 |
| 2 | 选对目标 | 猜错按钮、把密码填进搜索框 | 歧义时**拒绝**而不是按位置挑 |
| 3 | 知道做成了没有 | 点完就说「已完成」 | 有独立的成功证据（URL / 文本 / 字段值 / 相位） |
| 4 | 出错能恢复 | 重试到死、重复提交、把登录锁掉 | 失败有分类，且**默认不重试写操作** |
| 5 | 不必每次都想一遍 | 每次都重新推理同一个流程 | 流程能被**存下来按数据重放** |

本项目在 0.1–0.11 里逐条补的是 1–5。本文的重点是：**业界已有做法里，哪些能直接借，哪些借不了，为什么。**

---

## 2. 四类做法与代表项目

### A. 页面表示：结构化快照 > 截图

- **Playwright MCP（微软，Apache-2.0）** 的做法是明确的：用 Playwright 的无障碍树而不是像素输入，理由是「deterministic tool application — avoids ambiguity common with screenshot-based approaches」，并且工具描述里直接写「`browser_snapshot` … this is better than screenshot」「you can't perform actions based on the screenshot」。它还提供 `browser_find` 在快照里按文本/正则搜索并返回**节点路径**，明确说这比抓整棵树更省 token。
- **Playwright 的 aria snapshot（v1.49+）** 把 a11y 树序列化成 YAML（role + accessible name + 层级 + 状态），并用 `toMatchAriaSnapshot` 做结构断言。
- **browser-use（MIT）** 走的是 DOM 抽取 + 元素编号标注（set-of-marks 那一系），把「可交互元素」编号后交给模型选编号。

**借到了什么**：本项目 0.1 起就用「结构化引用 + 只读快照」，0.10 又给 `browser_login_state` 加了 `phaseEvidence`/`phaseConfidence`。这次 0.11 进一步把「引用」升级成「**可重放的描述符**」（见 C）。

**没借什么**：不做 set-of-marks 截图标注。原因是我们的目标环境是**用户自己的真实 Chrome、已登录态**，截图里全是真实账号内容；把截图当动作依据，等于把像素里的隐私送进模型上下文，而结构化描述足够定位。

### B. 定位与自愈：选择器优先、失败再兜底

- **Healenium（Apache-2.0）** 是这条路线的经典实现：定位器失效时不直接判死，而是按多属性（text / class / data-*）算相似度选最可能的目标。
- **Skyvern（AGPL-3.0）** 的 `page.click("#submit-btn", prompt="Click the Submit button")` 是另一种兜底：**先试 CSS/XPath，失败再交给 AI**。它还提供 `page.validate(prompt)` 返回布尔，用于「检查是否已登录」这类自然语言断言。

**借到了什么**：分层的思路（强身份优先，弱身份兜底）+ 兜底必须显式标记。本项目 0.11 的 `browser_recipe_locate` 就是七级阶梯：`role+name → name → id → name-attribute → selector → text → fuzzy-name`，命中弱层时返回 `degraded: true`。

**明确不借的一条**：**AI 兜底**。Skyvern 的 prompt 兜底需要一个模型在场，而本项目的定位是「基座只供能力」——模型挂了、网断了、用户没配模型时，基座仍然要能跑。所以我们的兜底是**确定性相似度**（页面内 30 行 Levenshtein），不是模型判断。

**许可证纪律**：Skyvern 是 AGPL-3.0，**只看思路，不抄代码**。browser-use 与 Healenium 分别是 MIT / Apache-2.0，思路与代码都可借，本文仍只借思路，因为我们的安全性质不同（见下）。

### C. 录制-重放：把「想过一次」存成数据

这是本次调研里**最直接可用**的一条。

- **browser-use（MIT）**：`agent.save_history('run.json')` + `detect_variables()` 自动识别表单字段名（`name`/`email`…）+ `load_and_rerun(..., variables={...})` 用新变量重放点击和输入，**不需要每一步调用模型**。它的失败语义也写得很清楚：页面结构变了就在**第一个匹配不上的步骤**抛 `RuntimeError`，**之前的步骤已经执行**，需要先核实表单是否已提交。
- **LangGraph 的 durable execution / idempotency key 模式**：工具调用带 `idempotency_key = agent.tool.input_hash`，网关缓存一段时间并拒绝重复请求；长任务用 checkpoint 重放执行路径，保证副作用不重复。

**借到了什么**：本项目 0.11 的 `browser_recipe_save` / `browser_recipe_run`。差别（也是必须自己写的原因）：

| | browser-use history replay | 本项目 recipe |
|---|---|---|
| 存什么 | 历史动作序列 | 每步一个**耐久描述符**（tag/role/accessible name/text/id/name 属性/selector） |
| 定位 | 重放原动作 | **七级身份阶梯重新解析**，弱层显式标记 `degraded` |
| 歧义 | — | **命中多个可见元素就拒绝**，绝不按位置挑 |
| 秘密 | 存 `<secret>` 占位，但快照仍按原样保存（其 README 自己指出可能残留） | **拒绝** secret 步骤存字面量，只接受 `{{变量}}` |
| 变量 | 运行前不校验 | **step 1 之前全量校验**，缺变量直接拒绝（避免半执行） |
| 失败 | 抛错 | 返回 `failedAtStep` / `stepsCompleted`，并明说**已完成步骤不回滚** |

「歧义就拒绝」这条是刻意与测试工具反着来的：Healenium 这类工具的 KPI 是「测试别红」，猜对了就算过；本项目的 KPI 是「**别点错**」——猜错一次可能是把钱付了、把密码填进搜索框。所以宁可停下。

### D. 长任务韧性：失败分类 + 不重放未知结果

本项目已有（0.1–0.9 逐轮加固）：`status: uncertain` 与 `failed` 分开、写操作超时**不重试**、`browser_failure_help` 给分类后的下一步、租约防止两个 agent 抢同一个标签、`browser_wait_until_ready` 做连接级就绪。

**这次补的一条**：`jobTimeoutMs` 开始看 `args`。一个「刻意的长等待」（等登录相位、跑多步 recipe）如果被默认 20s 的任务计时器打断，会被误报成 `read_timeout`——**把「按计划慢」和「卡死」混成同一个结果**，正是弱 agent 最容易被误导的地方。

---

## 3. 采纳 / 不采纳清单

| 方案 | 结论 | 理由 |
|---|---|---|
| 结构化快照 + 稳定引用（Playwright MCP） | **早已采纳**，0.11 加强为可重放描述符 | 确定性，且不需要视觉模型 |
| 分层定位 + 弱层显式标记（Healenium / Skyvern） | **采纳**，但兜底换成确定性相似度 | 不引入模型依赖 |
| 录制-重放 + 变量（browser-use） | **采纳并加严** | 见上表；加严点是歧义拒绝与秘密不入盘 |
| AI 兜底定位（Skyvern prompt fallback） | **不采纳** | 基座必须在无模型时可用；模型判断不可复现、不可审计 |
| set-of-marks 截图标注（browser-use 一系） | **不采纳** | 真实账号的像素进上下文，隐私成本高于收益 |
| 视觉 grounding（OmniParser 一类） | **暂不采纳**，保留为「截图-only 页面」的最后手段 | 需要额外模型与权重；当前 DOM/`chrome.debugger` 覆盖更好 |
| 云端反爬 / 代理 / CAPTCHA 破解（Skyvern Cloud） | **永不采纳** | 本项目明确不承载风控对抗，见 `docs/PRODUCT-ROADMAP.md` |
| idempotency key 网关 | **暂缓** | 需要服务端去重存储与 TTL；当前用「写操作不自动重试 + `uncertain` 语义」覆盖主要风险。若引入，必须同时定义「同 key 但页面已变」的语义，否则是假安全 |

---

## 4. 还没做、但值得做的（按性价比排序）

1. **离线任务套件（最高性价比）**。目前所有验收都是「这个能力对不对」，没有「一个弱模型能不能把任务做完」。建议做一个本地 benchmark：20–30 个真实小任务（登录、改设置、填表、导出、跨页取数），跑两个模型（一个强、一个刻意弱的本地小模型），记录**成功率 / 平均步数 / 危险动作次数（点错、重复提交）**。没有这个数字，「让弱 agent 也能做」就无法证伪。→ 新增 `test/bench/`，复用现有 fixture 服务器。
2. **`click_verified` 分不清「成功」与「失败但也换了页」**。0.10 解决了「等相位」，但一次点击之后如果页面跳转到了错误页，`expect.textAppears` 在新文档里根本没被求值。建议：点击后若发生导航，返回 `status: navigated` + `finalUrl`，并要求调用方用 `browser_login_state` / `browser_read` 确认，而不是让 `verified:true` 混过去。**0.11 已在 recipe 里这么做（`status: 'navigated'`），单次点击还没跟上。**
3. **`browser_otp_fetch` 的时效**。刻意不做 `sinceMinutes`（错误的时区/相对时间猜测会静默藏掉正确的码）。可行的替代：把「这条消息看起来是新的/旧的」作为**证据**返回（`ageHint` + `parsed: false`），而不是用来过滤。
4. **DevTools Console 脚本输入**。`browser_debugger action:"evaluate"` 已有等价能力，缺的是「像人一样在 Console 里敲一行并看到输出」的通道；优先级低于 1–3。
5. **chrome://settings 读写 / 性能录制 / Lighthouse / ServiceWorker 调试**。都属于「人类能点，但扩展与 CDP 各有硬墙」的区域，必须逐项实测可达性再写实现（0.9 的 `DOMStorage` 教训：**先探测域是否可达，再写代码**）。
6. **从捕获记录直接重放**。`browser_devtools_capture` 刻意丢弃 header/body，所以做不到；要做就得先决定「要不要在磁盘上存请求体」——那是隐私决定，不是技术决定。

---

## 5. 关于 Python 库：一个必须说清的边界

本项目的运行时是 **Chrome 扩展（JS）+ Node 服务**，页面内代码还要被 `chrome.scripting.executeScript` 序列化进去。因此：

- **Python 库不能直接进基座**。`rapidfuzz`（模糊匹配）、`selectolax`/`lxml`/`parsel`（HTML 解析）、`trafilatura`（正文抽取）、`tenacity`（重试）、`pydantic`（校验）、`msgspec`（序列化）都很好，但它们解决的是 **Python 进程里**的问题。基座里对应位置要么是页面内联函数（不能 import），要么是 Node 服务（用 npm 包）。
- **页面内尤其不能引库**：`pageOperation` 每次调用都会被完整序列化进页面。0.9 的注释里已经写过这个取舍（`dom-accessibility-api` 被刻意不引入，~80KB/次）。所以 0.11 的相似度是页面内 30 行 Levenshtein，而不是引一个库。
- **Python 真正有用的地方在基座之外**：
  - **离线评测/回归**：用 `playwright`（Python）跑对照组，用本项目跑实验组，比较成功率与危险动作数——这就是第 4 节第 1 条。
  - **Python 客户端 SDK**：现在只有 HTTP/CLI/MCP。若要做 `pip install ai-browser-bridge`，`httpx` + `pydantic` 是合适的选择。
  - **数据侧**：`trafilatura` 做「读到的正文」二次清洗，属于调用方的事，不该塞进基座。

结论：**这次调研没有引入任何新依赖**，不是懒，而是每一处候选依赖的位置都已经被「不能 import 的页面内代码」或「已经够用的 30 行实现」占了。引入依赖前应该先回答：它进的是哪个进程？会不会每次调用都多传几十 KB？

---

## 6. 一句话总结

弱 agent 做不完事，通常不是因为它不够聪明，而是因为**每一步都要它做决定**。所以基座该做的是把决定挪走：能确定的（页面结构、目标身份、成功证据）用确定性代码固定下来，把不确定的（这一步该点哪、这个流程该怎么走）变成**一次决定 + 多次重放**。0.11 的 recipe 就是这条思路的第一个完整实现；下一步该做的是**度量它到底把成功率抬了多少**，而不是继续加工具。
