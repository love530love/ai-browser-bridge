# Playwright 旁路决策记录（授权范围 / 硬约束冲突 / PoC 门槛）

- 状态：**决策文档**。本轮**未执行 PoC、未启动 Playwright / Puppeteer / Selenium / CDP、未拉起第二个 Chrome、未克隆或解析任何 Chrome profile / `Cookies` / `Login Data` / `Local State`、未改 `src/` / `extension/`、未抢前台**。
- 日期：2026-11-14（GMT+8）。版本基线 0.40.0，HEAD `b4ad8d0`。
- 触发：Qoder 在「用项目能力发布一篇 CSDN 文章」时阻滞，其个人 skill 建议把 CSDN 编辑器从扩展桥改走 Playwright + 独立调试配置，并建议先跑「默认配置已登录浏览器 + Playwright 连接」的 PoC。

---

## 1. 「无 Python 的机器」到底指什么（先纠正范围）

不是 **AI-Browser-Bridge 项目运行时**缺 Python：`package.json` 的 `engines.node >=22`，运行时依赖只有 `@modelcontextprotocol/sdk` 与 `ws`，`python/bridge_worker.py` 与 `test/python/worker_test.py` 是**孤儿侧车**（源码、npm scripts、扩展里零引用）。基座对 Python 零依赖，因此**不引入嵌入式 Python**：为一个不存在于基座里的依赖增加发布体积与进程面，不解决任何真实问题。

真实阻滞在**外部发布链路**：Qoder 个人 skill 把发布流程绑死在 `D:/A/python.exe` + Python Playwright 脚本 + 独立调试配置 `CSDN_Debug_Profile` + `connect_over_cdp` 上，换机即失效；同时该 skill 里「`simulation-button` 是真发布按钮」的旧结论已被证伪却仍有残留，错误经验混在流程里比没有更危险。因此本轮的正确动作是**把业务契约从 Python/Playwright 驱动里剥离出来**（`skills/csdn-publish/snippets/publish-contract.md`），而不是给桥塞一个 Python 运行时。

## 2. 与项目硬约束的逐字冲突

按 **2026-11-14 当前工作树**逐字复核 `AGENTS.md`（该文件正处于他人并行改动中，行号仅对本次快照有效）：

| Qoder 侧做法 | 证据（本机输入文件行号） | 冲突条款 | 结论 |
|---|---|---|---|
| 把 Playwright + CDP 列为首选主路径 | `csdn-autopublish/SKILL.md:20`；`scripts/csdn_lib.py:110-112` 的 `connect_over_cdp` | `AGENTS.md:12`：「Do not start Playwright, Puppeteer, Selenium, CDP, or a second browser-control bridge unless the bridge is unavailable and the user explicitly authorizes a fallback.」 | **双前提不成立**：本轮四证全通（见 §4），桥可用；用户授权的是文档而非运行 |
| 起第二个 Chrome 实例 / 新 context | `SKILL.md:24,30,35,287-289`；`csdn_lib.py:8-9` | `AGENTS.md:10`：「never start a second browser or a fresh Playwright context」 | 冲突，不照抄 |
| 以独立调试配置携带登录态 | `SKILL.md:287-289`（自述为默认 profile 克隆、含登录 cookie）、`SKILL.md:35` 的 `--disable-extensions` | `AGENTS.md:16`：「Never copy, clone, archive, start with, parse, upload, or mine a Chrome profile or its `Login Data`, `Cookies`, or `Local State` … Do not use a second debug profile as an improvised login workaround.」 | **直接冲突，不照抄、不实现、不写进仓库 skill 的执行路径** |
| 把 CSDN 编辑器永久列为扩展桥禁区 | `SKILL.md:24`「⛔ 不可用于 CSDN 编辑器」 | 产品方向（「不设能力禁区」）+ `docs/KNOWN-LIMITATIONS.md` + `docs/TROUBLESHOOTING-MATRIX.md` §2 | **不照抄**。只记为「2026-11-14 单次现场观察，归因待 0.40.0 复现」 |
| 把凭据/登录 cookie 值写进文档 | `SKILL.md:319` 等 | `AGENTS.md:17`：不得把口令、token、cookie 写进脚本、日志、报告或任务记录 | 本轮所有文档**只写字段是否存在**，绝不写值 |

**行号纠偏**：上一轮口头记作 `AGENTS.md:10/14`。按当前工作树逐字复核，`:10` 是「不启第二浏览器」、`:12` 是 Playwright/CDP 双前提、`:16` 是 profile / Cookies 禁令，`:14` 只是「Failure containment and secrets」节标题。本文件与后续引用一律用 `:10 / :12 / :16`。

## 3. 用户授权的范围（不扩大解释）

用户 2026-11-14 在四档推进选项中选择「**以上都做**」，其中 D 档是「撰写 Playwright 旁路决策文档，并记录显式授权与 PoC 门槛」。

- **授权的是**：写决策文档、逐条登记冲突、把 PoC 变成可证伪的门槛、修订站点配方、提炼语言无关契约、做只读取证。
- **不是授权**：运行 PoC、启用第二套浏览器通道、克隆/解析 profile、改 `src/` / `extension/`、把本机绝对路径写成仓库配置。
- 依据：`AGENTS.md:12` 明写「An authorized alternative is limited to the user's stated scope」；`:19` 要求桥不可用时如实报告观测状态并给出最小决策，不得自造 workaround；`:20` 要求换外部账号/服务须针对该具体路由单独授权。

## 4. PoC 前置门槛（**均未完成，不得写成「已通过」**）

门槛 0 来自 `AGENTS.md:12/:19`，门槛 1–5 逐字取自 [docs/CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md) §4：

0. **双前提举证**：① 桥确实不可用（health/status、尝试过的工具与 reason 的逐字证据）；② 用户对**该具体通道**的明确授权。两者缺一不进 PoC。
   - 本轮实测（`docs/LOCAL-EVIDENCE-20261114-runtime.md` §1）：LISTENING PID `37712` 为 `node`、TCP 探针 OK、裸 `/status` 带端口返回预期 `401`、带 token 的 `status` 返回 `0.40.0` + `hostCount:1` + `connected:true` ⇒ **四证全通，「桥不可用」前提不成立**。这是本轮不进 PoC 的**实证**，不是托辞。
1. **协议面举证**：用 `chrome.debugger` 实际发起一次 `Target.getTargets`（或等价 API），把原始返回写入 `.local/` 证据；不可用则路径 A 终止。
2. **域清单举证**：列出 `chrome.debugger.sendCommand` 在目标 Chrome 版本上实际接受的命令清单（至少 `Target` / `Page` / `Runtime` / `Input` / `Network`），明确记下 `-32601` 的项。
3. **握手举证**：`connect_over_cdp` 连到 PoC 端点，记录是否卡在 `<ws connected>` 后 180s；该现象需在**有网关**条件下复现才能归因。
4. **登录态举证**：在默认配置上读回一个已登录站点的用户态字段，证明没有退化成独立配置。
5. **安全举证**：网关只绑 `127.0.0.1`、带 token 鉴权、不暴露扩展自身 target、不暴露 `chrome://`——这些是**前置条件**，不是事后加固。

任一门槛不过，结论写「此路径在现有架构下不成立」，不写「调调参数就能通」。另见 `CDP-GATEWAY-PLAN.md` §2 的架构障碍：`chrome.debugger` 是 **page 级**会话且只转发 CDP 域子集，与 `connect_over_cdp` 需要的 **browser 级** WS + target 发现不是同一层协议。

本轮附加的、尚未取证的前提：`docs/LOCAL-EVIDENCE-20261114-runtime.md` §4 显示当前桥返回的标签清单为空，**不存在 CSDN 编辑器标签**，因此连「在真实编辑器上复现现场现象」这一前提也不成立。

## 5. 决策记录

| 日期 | 决定 | 依据 |
|---|---|---|
| 2026-11-14 | 用户「以上都做」→ 交付本决策文档、PoC 门槛、语言无关契约与站点配方修订；**PoC 未执行、未通过、未获运行授权** | `AGENTS.md:10/12/16/17/19/20`；四证全通；`CDP-GATEWAY-PLAN.md` §2/§4 |
| 2026-11-14 | **不引入嵌入式 Python 到基座** | 项目运行时零 Python 依赖；真实阻滞在外部发布链路，属契约剥离问题 |
| 2026-11-14 | **不照抄** Qoder 的第 5 条通道建议进仓库 skill | 与 `AGENTS.md:10/12/16` 冲突；产品方向「不设能力禁区」不允许把单次观察写成永久禁区 |

## 6. 若下一轮要真正推进 PoC，最小步骤

1. 由用户明确指定**具体通道**（例如「允许在本机临时起一个带调试端口的独立浏览器实例，仅用于 CSDN 编辑器」），并确认该授权范围。
2. 先补齐门槛 0 的桥不可用证据；桥可用时不要为了跑 PoC 而人为制造故障。
3. 按门槛 1–2 做**只读举证**并回写 `CDP-GATEWAY-PLAN.md`，再重新向用户确认范围。
4. 全程遵守 `AGENTS.md:17`：token / cookie / profile 内容不进脚本、日志、报告或聊天摘要；证据只保留「字段存在 / 长度 / 返回码」。

## 7. 关联

- 运行态四证与文档路径缺陷取证：[docs/LOCAL-EVIDENCE-20261114-runtime.md](LOCAL-EVIDENCE-20261114-runtime.md)
- CDP 网关可行性评估（未实现、未 PoC）：[docs/CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md)
- 症状分诊：[docs/TROUBLESHOOTING-MATRIX.md](TROUBLESHOOTING-MATRIX.md)
- 硬边界：[docs/KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)
- 语言无关发布契约：[skills/csdn-publish/snippets/publish-contract.md](../skills/csdn-publish/snippets/publish-contract.md)
- 现场报告 `docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md` 与 Qoder 个人 skill 均为**本机输入文件**，未纳入版本库，clone 后不存在；本文件只引用其行号作证据定位，不构成可执行配置。
