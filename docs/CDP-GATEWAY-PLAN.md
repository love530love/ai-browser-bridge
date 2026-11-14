# CDP Gateway 可行性评估（**未实现、未 PoC、未授权**）

- 状态：**设计评估文档**。当前仓库没有任何 CDP 网关实现，`src/` / `extension/` 未改动。
- 版本基线：0.40.0（`main`，HEAD `3f69ec1`）。
- 来源：`docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md` 第 5.1 节与第 9 节建议 2。
- 决策：2026-11-14 用户确认推进范围为「**只落文档**」，本文件因此**只记录可行性判断与验收门槛，不构成开发授权**，也不承诺交付时间。

---

## 1. 想解决的问题（报告的诉求）

报告希望让 Playwright / Puppeteer 通过 `connect_over_cdp` 直接驱动**用户日常已登录的默认 Chrome 配置**，从而不必为自动化另开一个需要重新登录的独立调试配置。报告给出的路径是：由扩展用 `chrome.debugger` attach 目标标签，桥在 `127.0.0.1`（带 token 鉴权）暴露一个 WebSocket，把 `Target` / `Runtime` / `Page` / `Input` / `Network` 子集翻译到扩展会话。

诉求本身成立：本次现场用独立调试配置 + `--disable-extensions` 发布成功，代价确实是重新登录/重配。但**「诉求成立」不等于「这条实现路径可行」**。

---

## 2. 架构障碍（逐字源码证据，这是本文最重要的部分）

### 2.1 `chrome.debugger` 是 **page 级**会话，不是 **browser 级** endpoint

当前扩展实际使用的 `chrome.debugger` API 面（全仓 `extension/` 统计）：

| API | 使用次数 |
|---|---|
| `attach` | 2 |
| `detach` | 2 |
| `onDetach` | 1 |
| `onEvent` | 11 |
| `sendCommand` | 9 |

`attach` 的 target 一律是 `{ tabId }`（`extension/cdp.js:4`、`extension/worker.js:110`）。**全仓没有任何 `chrome.debugger.getTargets()` 调用，也没有任何 `Target.*` CDP 命令**。这不代表 Chrome 没有这些 API，只代表**本桥当前没有走这条路，因此不存在可复用的实现或验证证据**。

而 Playwright `connect_over_cdp` 需要的是 browser 级 WebSocket + 一整套 target 生命周期协议：`Target.getTargets` / `Target.setDiscoverTargets` / `Target.attachToTarget(flatten)` / `Target.receivedMessageFromTarget` / `Target.createTarget` / `Target.closeTarget`，以及 `/json/version` 之类的发现端点。这是**两层不同的协议面**，不是「在 `Target.getTargets` 返回里过滤一下扩展 target」就能补上的。

### 2.2 `chrome.debugger.sendCommand` 只转发 CDP **域的子集**

这不是推测，是本机实测并写进代码的否定事实：

> `extension/cdp-storage.js:128-131`：Chrome 154 上 `DOMStorage.enable` 与 `IndexedDB.enable` 都回 `{"code":-32601,"message":"…wasn't found"}`；而 `Network.getCookies` 一直成功。因此 cookie 走 `Network`，web storage 与 IndexedDB 改走 `Runtime.evaluate` 在页面上下文读写。

`README.md` 的 0.9.0 段同样记录了这条实测结论。也就是说，即便做一个翻译网关，能转发的域也是**已经被 `chrome.debugger` 允许的那一小部分**，不是报告里列的完整 `Target/Runtime/Page/Input/Network` 任意子集。尤其 `Target` 域在扩展通道里没有已验证的可用性证据。

### 2.3 一个容易误引的「✅」

`docs/LIGHTPANDA-EVALUATION-2026-11-02.md:36` 确实写着 `Target.createTarget / getTargets / attachToTarget(flatten)` ✅，但那份文档测的是 **Lightpanda 通过 `http://127.0.0.1:9222/json/version` 暴露的原生 CDP WebSocket**（`Chrome/124.0.6367.29` 自报、`UA=Lightpanda/1.0`），不是本桥扩展的 `chrome.debugger` 通道。**不能把那一栏 ✅ 外推成本桥已具备 browser 级 target 能力。**

### 2.4 因此报告里三条「顺手写下的实现建议」都不能照抄

| 报告建议 | 障碍 |
|---|---|
| 「在 `Target.getTargets` 层只返回页面 target，或提供 `--target-filter=page`」（5.1 已知坑） | 扩展通道本就没有 browser 级 `Target.getTargets`；过滤发生在不存在的层 |
| 「`browser_close` 兜底走 `Target.closeTarget`（browser 级 WS）」（P0-1 / P1-6 / 5.7） | 扩展通道无 browser 级 WS；且当前 `browser_close` 走 `chrome.tabs.remove`（`extension/worker.js:1241-1254`），**本来就不需要页面响应**，这条兜底没有必要 |
| 「用 CDP `Page.bringToFront` + `Emulation.setFocusEmulationEnabled` 降低对前台依赖」（5.6） | 后者在 Lightpanda 上 ✅ 不等于在本桥扩展通道上可用；且自动抢前台违反项目硬边界，见 `docs/KNOWN-LIMITATIONS.md` |

报告关于「Chrome 136+/148+ 禁止在默认配置上开 `--remote-debugging-port`」的说法，本次**未在本机复核**，属于报告主张；若要做 PoC，第一步就要把它变成可复算的本机证据，而不是引用报告。

---

## 3. 三条候选路径与各自的门槛

都**未实施**。列出是为了让下一次决策有可证伪的判据，不是路线承诺。

| 路径 | 做法 | 必须先证伪/证实的门槛 | 现状 |
|---|---|---|---|
| **A. 扩展侧 CDP 子集翻译网关** | 桥暴露 WS，把收到的 CDP 命令映射到 `chrome.debugger.sendCommand` 或 `chrome.*` API | ① `Target` 域在扩展通道是否可用；② Playwright 能否在不改源码的情况下接受「只有 page target、无 browser 级 flatten 会话」；③ 事件（如 `Page.loadEventFired`）能否通过 `chrome.debugger.onEvent` 反向翻译 | 三条都无证据。最可能的结果是**只能做「够用的 RPC 代理」，不能冒充完整 CDP browser endpoint** |
| **B. 原生消息宿主 + 独立调试配置** | 由本机进程拉起带 `--remote-debugging-port` 的 Chrome 供 Playwright 直连 | ① 默认配置能否开调试端口（报告主张不能，待本机复核）；② 独立配置必然丢登录态，是否接受；③ 与项目「绝不按注册表顺序取 chrome.exe」「`browserTarget` = stable/Default」的硬约定是否冲突 | 现场已用 `CSDN_Debug_Profile` + `--disable-extensions` 走通发布，但那是**绕过桥**，不是桥能力 |
| **C. 继续走桥自身的工具层** | 不引入 Playwright 兼容层，缺什么能力就补一个 `browser_*` 工具（当前已有 125 个） | 是否需要「让第三方 CDP 客户端连进来」这个目标本身；若目标只是「把页面自动化做完」，这条路径成本最低且有回归保障 | 现行路线；新增工具须同步 `src/tools.js` / `src/tool-index.js` 与扩展侧分发表（`extension/worker.js` 主链，或 `extension/browser-authority.js:888` 的 `HANDLERS` 表经 `worker.js:829` 委托） |

---

## 4. PoC 验收门槛（**在动手写网关代码之前**先跑）

报告的验收用例 6 是「Playwright `connect_over_cdp` 直连网关，在默认配置（已登录）上完成导航 + evaluate + 截图；扩展 target 被过滤，无 180s 握手卡死」。这条**不能**作为已实现功能写进任何文档，只能作为 PoC 目标。把它拆成可证伪的前置门槛：

1. **协议面举证**：在本机 Chrome 上，用 `chrome.debugger` 实际发起一次 `Target.getTargets`（或等价 API），把原始返回写进 `.local/` 证据；若不可用，路径 A 到此终止，不要靠「理论上应该有」继续。
2. **域清单举证**：列出 `chrome.debugger.sendCommand` 在目标 Chrome 版本上实际接受的命令清单，至少覆盖 `Target` / `Page` / `Runtime` / `Input` / `Network`，把 `-32601` 的项明确记下来。
3. **握手举证**：Playwright `connect_over_cdp` 连到 PoC 端点，记录是否卡在 `<ws connected>` 后 180s；报告说扩展 target 会导致该现象，此结论需在**有网关**的条件下复现才能归因。
4. **登录态举证**：在默认配置上读回一个已登录站点的用户态字段，证明没有退化成独立配置。
5. **安全举证**：网关只在 `127.0.0.1`、带 token 鉴权、不暴露扩展自身 target、不暴露 `chrome://`；这些是前置条件，不是事后补的加固。

任一门槛不过，结论就写「此路径在现有架构下不成立」，而不是「调一调参数就能通」。

---

## 5. 与项目硬边界的交叉检查

- **不设能力禁区**（产品方向）：这条约束的是「不因 URL 类型或『宿主不是 chrome.exe』永久拒绝能力」，**不等于**要兼容任意第三方 CDP 客户端的协议。网关是否属于基座职责，需要用户明确决定。
- **只提升能力、强化兜底、给出诚实证据**：在门槛 1–5 有实证之前，任何「网关可用」的表述都是不诚实证据。
- **精确目标绑定、未知结果不重放、可审计状态**：网关若引入，`operationId` / 幂等键 / `hostId` 绑定必须同步设计；当前仓库**没有** `operationId`（见 `docs/TROUBLESHOOTING-MATRIX.md` §4）。
- **不抢前台**：PoC 不得以「为了截图」为由隐式 `SetForegroundWindow` 或 `chrome.windows.update({focused:true})`。

---

## 6. 决策记录

| 日期 | 决定 | 依据 |
|---|---|---|
| 2026-11-14 | 用户确认「只落文档」；本文件作为**评估**归档，**不**启动网关开发、**不**改 `src/` / `extension/` | 报告基于 0.39.0 现场，多条建议与 0.40.0 源码不符；架构障碍 §2 未做 PoC |

后续若要推进，先按 §4 的 1–2 两条做**只读举证**，把结果回写本文件，再重新向用户确认范围。

## 7. 关联

- 症状分诊：[docs/TROUBLESHOOTING-MATRIX.md](TROUBLESHOOTING-MATRIX.md)
- 硬边界与已知限制：[docs/KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)
- CDP 域子集的原始实测记录：[docs/LIGHTPANDA-EVALUATION-2026-11-02.md](LIGHTPANDA-EVALUATION-2026-11-02.md)（注意是 Lightpanda 原生 WS，非本桥扩展通道）
- 现场报告：`docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md`（**本机输入文件，未纳入版本库**，clone 后该路径不存在；按 `README.md` 的约定应放 `docs/local/` 或加 `LOCAL-` 前缀归档）
- 多宿主与 `hostId` 身份：[docs/HIGH-CONCURRENCY-ROADMAP.md](HIGH-CONCURRENCY-ROADMAP.md)
