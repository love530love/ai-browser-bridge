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

1. ~~**离线任务套件（最高性价比）**~~ **已在 0.12.0 做完**，见第 5 节。结论比预期更有用：它当场抓出两个真实缺陷（普通「Sign out」链接不被识别、`click_verified` 在导航提交上报 `uncertain`），而不是只产出一张好看的表。
2. ~~**`click_verified` 分不清「成功」与「失败但也换了页」**~~ **已在 0.12.0 做完**。现在 URL 变了就报 `status:"navigated"` + `navigation.from/to`，并明说「期望值从未被求值，请在新页面确认」。判断放在 service worker：页面侧代码已随旧文档消失，只有 `chrome.tabs` 知道 URL 变了。
3. ~~**`browser_otp_fetch` 的时效**~~ **已在 0.13.0 做完**。每个候选带 `ageHint`（`just_now / minutes / hours / days / weeks_or_more / absolute_date / clock_only / not_stated` + 页面原话），**只作证据、绝不过滤**，顶层 `ageHintNote` 把「没有 sinceMinutes，以及为什么」写进返回值。`clock_only` 单独一类，因为裸 `14:32` 可能是今天也可能是别的日子，猜成「今天」正是这个字段要避免的静默推断。
4. **DevTools Console 脚本输入**。`browser_debugger action:"evaluate"` 已有等价能力（实测在普通页可用），缺的只是「像人一样在 Console 里敲一行并看到输出」的界面通道。**结论：不实现**——它增加的是拟人外观，不是能力，而每多一条注入通道就多一处要审计的代码。
5. **chrome://settings 读写 / 性能录制 / Lighthouse / ServiceWorker 调试**。**0.13.0 已实测可达性，结论如下**：
   - `browser_open` 直接拒绝 `chrome://settings/`（`Only HTTP(S) URLs without credentials are allowed`），所以连页面都到不了；
   - 而 `browser_protected_ui_plan` 早已给出诚实回答：`status:"desktop_adapter_required"`、`supportedActions` 不含 `chrome_settings_changes`、`adapterAvailability:"not_implemented_for_action"`。也就是说这不是一个「没人注意到的缺口」，而是一个**有方案、故意没实现**的能力。
   - 真正的实现路径是把 `chrome_settings_changes` 做成 desktop adapter 的一个动作（Windows UI Automation，与 `browser_password_manager_reveal` 同一条通道）：绑定精确目标 → 读当前值 → 改一次 → 重读 → 记录旧值。**这是一整块工作，不适合塞进一个收尾版本**，留作独立一轮。
   - Lighthouse 需要 lighthouse 包 + 独立 remote-debugging-port 的 Chrome，属于「基座之外的评测工具」，不引入。
   - 性能录制与 ServiceWorker 调试：`browser_performance` / `browser_devtools` 已覆盖常用面，未做的部分价值低于上面这块。
6. **从捕获记录直接重放**。`browser_devtools_capture` 刻意丢弃 header/body，所以做不到；要做就得先决定「要不要在磁盘上存请求体」——那是隐私决定，不是技术决定。

---

## 5. 把「弱 agent 能做完」变成数字：离线任务套件

`test/bench/`（`npm run test:bench`）。5 个任务 × 3 种调用风格 = 13 次运行，全部跑本地 fixture，不碰真实账号。

### 5.1 为什么不用真模型

原本的想法是「跑一个强模型 + 一个刻意弱的本地小模型」。放弃了，理由有三条：

1. 基座的硬约束是**无模型也能用**。一个需要 API key 才能跑的 benchmark，违反它要证明的那件事。
2. 模型有版本漂移。同一个失败率，下个月换一个模型就不可复现，而 benchmark 的价值恰恰在于可复现。
3. 我们要度量的**不是模型多聪明，而是基座能不能把 careless 的调用变成安全的拒绝**。这件事不需要模型，需要把失败模式注入进去。

所以三个 policy 是写死的**行为**，每一个都对应真实调用方会做的事：

- `blind`：按第一个「看起来像」的 label 定位，用不返回裁决的工具，没有裁决就再动一次。这就是读不懂页面时的行为。
- `guarded`：只在 label 唯一时定位，用 `*_verified`，任何非成功都停下。这是同一个人拿到好工具后的行为。
- `recipe`：流程决定一次、存下来、重放。

### 5.2 三个数字，一个都不许来自调用方的自述

- `completed` —— 来自 fixture 服务端自己记录的状态（收到了什么 POST、哪个记录被删了）；
- `danger` —— fixture 记录的、不该发生的写（点错目标 / 同一个写做了两次）；
- `steps` —— 调用方实际发出的调用数。

`confirmed` 单独一列，表示**基座有没有给出裁决**。这是和「做成了没有」不同的一件事，也是弱 agent 真正的痛点：事情做成了但它不知道，于是再做一次。

### 5.3 0.12.0 首次实测（13 次运行，全部通过自检）

```
task          | policy  | completed | confirmed | steps | danger
login-slow    | blind   | false     | false     |     5 | 0
login-slow    | guarded | true      | true      |     5 | 0
login-slow    | recipe  | true      | true      |     4 | 0
read-total    | blind   | true      | true      |     1 | 0
read-total    | guarded | true      | true      |     2 | 0
save-setting  | blind   | true      | false     |     4 | 0
save-setting  | guarded | true      | true      |     5 | 0
submit-form   | blind   | false     | false     |     7 | 1 (重复提交)
submit-form   | guarded | true      | true      |     5 | 0
submit-form   | recipe  | true      | true      |     3 | 0
delete-draft  | blind   | false     | false     |     3 | 1 (删错记录)
delete-draft  | guarded | false     | false     |     1 | 0
delete-draft  | recipe  | false     | false     |     3 | 0
```

读法：

- **blind 做完了 2/5，且 2 次造成了实际损害**（一次重复提交、一次删错记录）。它做成的两次里，一次**完全不知道自己成了**（`save-setting` 的 `confirmed=false`）。
- **guarded 做完了 4/5，0 次损害，每次都拿到了裁决。** 唯一没做成的是陷阱页——它拒绝了，因为两个控件同名。这是正确行为，不是失败。
- **recipe 用更少的步数拿到同样的结果**（登录 4 vs 5、填表 3 vs 5），因为「怎么走」不再需要每次重新决定。这是整条路线最直接的价值证明。

### 5.4 两条正控制（这是全篇最重要的部分）

一个报告「零危险动作」的 benchmark，如果不能证明它**看得见**危险动作，那这个零一文不值。所以：

- `submit-form / blind` **必须**产生一次重复提交；
- `delete-draft / blind` **必须**删错一条记录。

任何一条不再发生，说明 fixture 坏了，而不是基座变好了。这两个断言和「guarded 零损害」是同等强度的结论。

### 5.5 这个套件当场抓到的两个真实缺陷

写 benchmark 的过程比跑它更有价值，因为它逼出了两个只有「换个调用方式」才会暴露的问题：

1. **普通「Sign out」链接不被识别**。`logoutHints` 只扫 `controls`，而 `controls` 按设计不含普通 `<a href>`（它们不是提交候选）。于是「头部写着 Sign out 的应用主页」报 `unknown`，`untilPhase:"logged_in"` 在**它最该服务的那些应用上完全不可用**。修法：sign-out 链接单独扫一遍，并作为**弱证据**——只有当页面上没有标识符输入框时才据此判 `logged_in`（营销页脚也可能有 Sign out）。0.12.0 已修，`test/login-phase.test.js` 从 12 条增到 14 条钉住这两面。
2. **`click_verified` 在导航型提交上报 `uncertain`**。见第 4 节第 2 条——它在 0.12.0 一并修了：URL 变了就报 `navigated`，并明确「期望值从未被求值，请在新页面确认」。

### 5.6 这个套件不证明什么

- 不证明真实网站上的成功率。fixture 只有 5 个页面，真实页面有 iframe、shadow DOM、虚拟滚动、异步校验。
- 不证明模型的行为。注入的是**失败模式**，不是推理能力。
- `delete-draft` 三个 policy 都没做成。这是刻意的：两个同名控件在**身份**上无法区分，基座只能拒绝。要真做成，得由调用方给出更强的描述（或人来点）。把它记成「拒绝即正确」，而不是偷偷让它过。

---

## 6. 关于 Python 库：一个必须说清的边界

本项目的运行时是 **Chrome 扩展（JS）+ Node 服务**，页面内代码还要被 `chrome.scripting.executeScript` 序列化进去。因此：

- **Python 库不能直接进基座**。`rapidfuzz`（模糊匹配）、`selectolax`/`lxml`/`parsel`（HTML 解析）、`trafilatura`（正文抽取）、`tenacity`（重试）、`pydantic`（校验）、`msgspec`（序列化）都很好，但它们解决的是 **Python 进程里**的问题。基座里对应位置要么是页面内联函数（不能 import），要么是 Node 服务（用 npm 包）。
- **页面内尤其不能引库**：`pageOperation` 每次调用都会被完整序列化进页面。0.9 的注释里已经写过这个取舍（`dom-accessibility-api` 被刻意不引入，~80KB/次）。所以 0.11 的相似度是页面内 30 行 Levenshtein，而不是引一个库。
- **Python 真正有用的地方在基座之外**：
  - **离线评测/回归**：用 `playwright`（Python）跑对照组，用本项目跑实验组，比较成功率与危险动作数——这就是第 4 节第 1 条。
  - **Python 客户端 SDK**：现在只有 HTTP/CLI/MCP。若要做 `pip install ai-browser-bridge`，`httpx` + `pydantic` 是合适的选择。
  - **数据侧**：`trafilatura` 做「读到的正文」二次清洗，属于调用方的事，不该塞进基座。

结论：**这次调研没有引入任何新依赖**，不是懒，而是每一处候选依赖的位置都已经被「不能 import 的页面内代码」或「已经够用的 30 行实现」占了。引入依赖前应该先回答：它进的是哪个进程？会不会每次调用都多传几十 KB？

---

## 7. 一句话总结

弱 agent 做不完事，通常不是因为它不够聪明，而是因为**每一步都要它做决定**。所以基座该做的是把决定挪走：能确定的（页面结构、目标身份、成功证据）用确定性代码固定下来，把不确定的（这一步该点哪、这个流程该怎么走）变成**一次决定 + 多次重放**。0.11 的 recipe 是这条思路的第一个完整实现；0.12 的第 5 节把「它到底把成功率抬了多少」变成了可复现的数字——`blind` 2/5 且造成 2 次损害，`guarded` 4/5 零损害，`recipe` 用更少的步数达到同样结果。
