# AI-Browser-Bridge 接手交接：当前进度 · 计划 · 审计入口

> **快照基准**：2026-11-15 14:02–14:06 GMT+8（UTC 2026-11-15T06:02Z 起）在本机取证。
> **本文是什么**：一份「其他 agent 从哪接手、怎么审计、哪些能改、哪些必须先问」的**状态快照与计划**。
> **本文不是什么**：不是能力清单、不是验收报告、不是最新版本说明。版本说明看 [CHANGELOG.md](../CHANGELOG.md)，产品硬契约看根 [AGENTS.md](../AGENTS.md)。
>
> ⚠️ **三条使用纪律**
> 1. **先复核再引用**：下面所有运行态数字都带时间戳，接手时请按 §6 重跑一遍；跨会话直接抄本文数字等于用旧状态判断现症。
> 2. **单轮不是事实**：`clean` / `provenClean:true` / `failures:0` / 状态端点全绿，都不等于「持久稳定」或「新模块能用」，也不等于「我修好了」。闭环判据见 §3.4。
> 3. **引用历史用章节名，不用行号**；引用源码可给 `文件:行号（0.40.0）`。本机路径与 `.local/` 证据是 **gitignored 的本机文件，clone 后不存在**。

---

## 0. 30 秒版

> **0.41.0 更新（2026-11-15）**：P0 三项已实施并发布，两个宿主扩展已重载到 0.41.0，真机 CDP 门槛 1–2 已执行。下文 §3 是 **14:02 的 0.40.0 快照**，仅作历史基线；当前证据与结论见 [P0-ITERATION-20261115.md](P0-ITERATION-20261115.md)。

| 项 | 2026-11-15 14:02 实测 |
|---|---|
| HEAD / 远端 | `7f343d4`，`origin/main...HEAD 0/0` |
| 版本 | 四处均 `0.40.0`；Latest = `v0.40.0`；Pre-release = `v0.40.0-docs.1/.2/.3` |
| buildId | `5b70528676c3403d92c234bb218d01f2c364d82fbe426b13917e3e00a977c77a`（磁盘与在线一致） |
| 服务 | 四证全通：LISTENING `142028` = `server.pid` = node，TCP OK，裸 `/status` 带端口 `401`，带 token `status` 返回 `0.40.0` |
| 宿主 | `hostCount:2` / `connected:true`；`heartbeat/state.json` 的 `lastSnapshot.hostIds` 两条、`counters:{}`、`missingHostIds:[]` |
| 工作区 | 他人并行改动 6 项（**不夹带提交**），见 §3.5 |
| 本轮结论 | 无现症代码缺陷；本轮只补交接文档，纯文档交付，buildId 不变、无需重启或重载扩展 |

**接手第一件事**：跑 §9 的 1–5 条，用自己的时间戳重建基线，再决定做哪条待办。

---

## 1. 事实源优先级与文档分工

当前仓库里有多份「看起来像交接」的文档，**不要读错入口**：

| 优先级 | 文件 | 角色 | 使用方式 |
|---|---|---|---|
| 1 | 根 `AGENTS.md`（含 §Incoming agent handoff、§Verified write contract 与结尾的 AEP JOIN 注释块 / §Agent Evolution Protocol） | **产品硬契约**，最高优先 | 任何动作前先读；与协作便利冲突时以它为准 |
| 2 | `src/**`、`extension/**` + 真机取证 | **事实源** | 文档与代码冲突时，以代码 + 真机为准 |
| 3 | 本文 `docs/AGENT-HANDOFF-20261115.md` | **当前状态快照 + 待办计划 + 审计入口** | 接手起点；数字需复核 |
| 4 | [docs/AGENT-HANDOFF-HUMAN-UI.md](AGENT-HANDOFF-HUMAN-UI.md) | **历史接手增量**（0.27.0 / 0.29.0 … 逐版本复盘），`AGENTS.md` §Incoming agent handoff 指定它 | 查某版本「为什么这么改」；**正在被其他 agent 并行修改，不要覆盖** |
| 5 | [docs/HANDOFF.md](HANDOFF.md) | 0.2.0 / 0.1.1 早期交接，标题即写明「涉及未完成项可能已过时」 | 只作考古，不作现状依据 |
| 6 | [CHANGELOG.md](../CHANGELOG.md) / [README.md](../README.md) | 版本说明与文档索引 | 查「做过什么 / 文档在哪」 |
| 7 | [docs/TROUBLESHOOTING-MATRIX.md](TROUBLESHOOTING-MATRIX.md)、[docs/CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md)、[docs/PLAYWRIGHT-FALLBACK-DECISION.md](PLAYWRIGHT-FALLBACK-DECISION.md)、[docs/PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md](PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md)、[docs/KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) | 专题决策与「不能照抄」清单 | 动对应模块前必读 |
| 8 | `.workbuddy-ai/memory/YYYY-MM-DD.md` / `MEMORY.md` | 本机 AAR 与长期硬规则（**本机记忆目录**） | 查教训；`MEMORY.md` 的硬规则优先于泛化经验 |

> 协作区 `coordination/PROJECT-POLICY.md`（行内路径，未跟踪文件）定义 claim / lease / 单写者文件组，改共享文件前读它；其基线仍写 `0.37.2` / `58d4539`，**已过时**。根 `AGENTS.md` 优先于协作区配置。

---

## 2. 架构分层：能改什么、改了会怎样

| 层 | 关键文件 | 语言 / 形态 | 改动影响 | buildId |
|---|---|---|---|---|
| Chrome 扩展层 | `extension/manifest.json`（MV3，`background.service_worker: "worker.js"`，`type: "module"`）、`extension/worker.js`（主分发）、`extension/browser-authority.js`（`HANDLERS` 表，经 `worker.js` 的 `runAuthorityTool` 委托）、`extension/page.js`、`extension/cdp.js`、`extension/cdp-session.js` | **必须 JS**，CSP `script-src 'self'`，页面代码须可序列化 | 改后**必须按 `hostId` 重载扩展**；新增工具有**两类**分发 | 否（不在哈希范围），但需重载 |
| Node 服务层 | `src/server.js`（HTTP `127.0.0.1:19387` + WS）、`src/host-registry.js`、`src/tools.js`（`TOOLS` = **125** 个）、`src/tool-index.js`、`src/heartbeat.js`、`src/policy.js`、`src/instance-manager.js` | Node ≥ 22，运行时依赖仅 `@modelcontextprotocol/sdk` + `ws` | 改后 **buildId 变** ⇒ 重启服务 + 四处升版 | **是** |
| MCP / CLI 适配层 | `src/mcp.js`（**stdio**，唯一 MCP 入口）、`src/cli.js`、`src/client.js`（指向 19387） | Node | 每个 agent 宿主 +1 个 adapter 进程，但**共用** 19387 服务；多宿主是「同一服务 + 多条 WS」 | 是 |
| Windows 运维脚本层 | `start.ps1` / `stop.ps1` / `scripts/watch-service.ps1`（看门狗）/ `scripts/probe-service-process.ps1`（原生 API 读命令行）/ `install-autostart.ps1` / `doctor-lite.bat` → `scripts/doctor-host-env.mjs` / `scripts/resolve-runtime.ps1` | PowerShell / bat / Node | 故障多来自**环境前提**（PATH 抢占、MSYS2 改写、敏感字样拦截、pwsh 子进程异常），不是语言缺陷 | 否 |
| 站点配方层 | `skills/ai-browser-bridge/SKILL.md`（**契约文件，在 buildId 哈希内**）、`skills/csdn-publish/`（含 `snippets/`） | Markdown / 零依赖 `.mjs` | 前者改动会变 buildId；后者不会 | 见左 |
| 文档与证据层 | `docs/**` | Markdown | **纯文档不改 buildId**；本机证据放 `docs/LOCAL-*` 前缀 | 否 |
| 孤儿侧车 | `python/bridge_worker.py`、`test/python/worker_test.py` | Python | 源码 / npm scripts / 扩展 / JS 调用链**零引用**；按「走不到 = 不存在」处理，不是运行时依赖 | 否 |

**已定决策（勿重复讨论）**：不引入嵌入式 Python 到基座、不改用 Rust 重写。三层语言约束、迁移代价与「脚本层最小稳定化路线」见 [docs/PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md](PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md) §2–§3。扩展层受 MV3 与 CSP 约束，文档逐字写明「Python 库不能直接进基座」。

---

## 3. 当前状态快照（2026-11-15 14:02–14:06 GMT+8）

### 3.1 发布面

- `git log -1` → `7f343d4`（2026-11-14 22:36 +08:00，docs.3）；`git rev-list --left-right --count origin/main...HEAD` → `0 0`。
- 四处版本：`package.json` / `package-lock.json` 顶层 / `package-lock.json` 的 `packages[""]` / `extension/manifest.json` 全为 `0.40.0`。
- 远端 tag 精确对账（`git ls-remote --tags origin 'refs/tags/v0.40.0*'`）：`v0.40.0→3f69ec1`、`docs.1→b4ad8d0`、`docs.2→d64f837`、`docs.3→7f343d4`；`gh release list -L 6` 显示 Latest 为 `v0.40.0`，其余三个为 Pre-release。
- 磁盘与在线 `buildId` 均为 `5b705286…77a`；`computeBuildIdentity()` 只 hash `package.json` / `package-lock.json` / `skills/ai-browser-bridge/SKILL.md` / `src/**`，**`docs/` 与 `skills/csdn-publish/` 不在内**。

### 3.2 服务四证（现取，非引用历史）

| 证据 | 实测 | 取法 |
|---|---|---|
| LISTENING PID | `142028` = `.local/server.pid`，`Get-Process -Id` 得 `node`，`Path = D:\Scoop\apps\nodejs-lts\current\node.exe`，启动 `2026-11-15T13:44:35+08:00` | 独立 PowerShell 通道 `netstat -ano -p TCP` + 单 PID `Get-Process` |
| TCP 探针 | `TCP_OK` | `node` net.connect 19387 |
| 裸鉴权 | 带端口 Host → `401`（预期拒绝） | `curl --noproxy '*' -H 'Host: 127.0.0.1:19387'`；**验拒绝码用原始 socket，别用 fetch/undici** |
| 带 token 状态 | `version 0.40.0` / `buildId 5b705286…77a` / `extensionVersion 0.40.0` / `hostCount 2` / `connected true` | `node src/cli.js status` |

> `.local/server.pid` **不是存活证据**（可指向死进程、监听者是另一个 node、PID 被复用）。判存活必须四证齐；**绝不 kill 未验证 PID**。

### 3.3 宿主与巡检

- `status`：`hostCount:2`、`connected:true`、`browserVersion 157.0.8103.78`。`extensionOwner` 报 `pid 198816 / ChatGPT / nonChromeHost:true` —— **这是易变字段，`hostId` 才是宿主身份**；owner 摆动而 `hostCount` / `connected` / `missingHostIds` 不变 ⇒ 不是宿主丢失。14:02 的宿主画像与 11-14 22:00 的「1 个 generic / Chrome 156」不同，属跨会话状态变化，不猜原因。
- `.local/heartbeat/state.json`：`lastSuccessAt 2026-11-15T05:25:16.120Z`（本地 13:25）、`counters:{}`、`consecutiveFailures:0`、`missingHostIds:[]`、`frozen:false`、`observedIntervalMs 4303455`、`cooldowns` 两条未变；`lastSnapshot.hostIds` 两条、`hostMeta` 两 host 均 0.40.0 / connected / `inFlight:false`。**该文件的宿主信息在 `lastSnapshot` 下，没有顶层 `hosts`**，逐字复读原文。
- 看门狗：`.local/watchdog-status.json` → `pid 31176 / connected / failures 0 / 14:03:36+08:00`。`.local/watchdog.jsonl` 逐行 `JSON.parse` 共 2619 行 `BAD=0`，本地 11-15 共 280 行；末段可见 **13:43:21 与 13:44:32 两轮** `starting-service → startup-completed → connected`，`failures` 恒 0，与 14:02 实测 PID 启动时间 13:44:35 吻合。
  - ⚠️ 同日 13:25–13:31 的 AAR 日志基线是 `server.pid 35384`（11:40:15 启动），**与 14:02 的 142028 不同**。按「看门狗启动序列」解释，不称漂移、不称故障、不称「已修复」。
  - `watchdog.jsonl` 的 `failures` **不是单调累计值**（`connected` 会归零）；`failures:0` 或 `flagged` 分日累积都不是「我修好了」。分日按时间字段自带的 `+08:00` 本地自然日 `slice(0,10)` 直取，**绝不再 `Date.UTC +8h` 二次换算**。

### 3.4 诚实边界（照抄进下一轮报告）

- 11-14 的 critical / uncertain / attention 与 11-15 更早的 non-clean 已有连续 clean 闭环 ⇒ **历史 finding 非现症**；单轮 clean 不作持久事实（`nextStep` 要求下轮再观察）。
- 闭环只认：连续两轮单次 `clean + provenClean:true` + 四证全通 + `doctor ok:true` + `counters` 清空 + 两 `hostId` 版本实证 + `missingHostIds:[]`。
- 状态端点全绿 ≠ 新模块能用；`doctor ok:true` 只按 `checks[].ok` 对账；`clean` ≠ 宿主都回来。
- 两条历史 `extension_reload` 的 `errorListCleared:false` ⇒ 扩展报错列表仍「**未清除、状态未知**」；不写成已清空、不重复 reload、不启 GUI 抢前台。
- 8 条 `pwsh` 子进程边界测试失败属**环境前提不成立**，不是代码回归；本轮未据此改代码。

### 3.5 工作区（他人并行改动，**一律不夹带提交**）

`M .gitignore`、`M AGENTS.md`、`M docs/AGENT-HANDOFF-HUMAN-UI.md`、`?? .aep/`、`?? coordination/`、`?? docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md`。精确 `git add`，绝不 `git add .`。AEP JOIN 下只读巡检属 `status-report`：不认领 / claim / lease / 写协作区，「分类不是授权」。

---

## 4. 工作进度：最近交付链

| Commit | Tag / Release | 类型 | 内容 |
|---|---|---|---|
| `3f69ec1` | `v0.40.0`（Latest） | **代码 + 升版** | 心跳误报修复：累计 `dispatchGap` 降级为观察字段，`inflight_leak` 改同快照瞬时账目比较；`test/heartbeat.test.js` 补 3 条含真实 HTTP 边界的回归；四处版本同步 |
| `b4ad8d0` | `v0.40.0-docs.1`（Pre-release） | 纯文档 | 第三份 CSDN 现场报告逐条对账，新建排障矩阵 / CDP 网关评估 / 已知限制 / `skills/csdn-publish/`，登记 8 条「不能照抄」 |
| `d64f837` | `v0.40.0-docs.2`（Pre-release） | 纯文档 | Qoder 链路纠偏、0.40.0 真机只读取证、Playwright 旁路决策、语言无关契约与 `snippets/`；**真机发现并修正 `browser_debugger` 全 action 必填 `tabId` 的文档缺陷** |
| `7f343d4` | `v0.40.0-docs.3`（Pre-release） | 纯文档 | 166 个第三方 MCP 实例与本桥**不同源**的进程归属取证；不改用 Python / Rust 的运行时选型决策；脚本层三类环境坑归档 |
| 本轮 | `v0.40.0-docs.4`（规划中，Pre-release） | 纯文档 | 本文 + 索引 / CHANGELOG 交叉链接 |

更早：`3a68937`（0.39.0 第二份现场反馈）、`3802e3e`（0.38.0 CNIPA 四案）、`85e6119`（0.37.4）。**历史内部任务编号与 AAR 结论以带时间戳的日志为准，不要把旧待办、旧版本号当现状**。

---

## 5. 计划 / 待办（按优先级，逐条带证据与门槛）

### P0 — 需用户单独授权才能动

| # | 事项 | 现状与证据 | 下一步 | 风险 |
|---|---|---|---|---|
| P0-1 | **stdio adapter 残余缺口** | [docs/PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md](PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md) §1.4 引有 `docs/PROCESS-LIFECYCLE.md` 的英文原文（`nor detect clients that remain alive and keep their pipes open indefinitely`）；中文转述为「宿主活着且 stdin 不 EOF 时 adapter 不退出」。11-14 实测 `BRIDGE_MCP_ADAPTERS=0`，**无现症** | 若要加固：① adapter 启停登记到 `.local/`，按命令行识别；② 父进程身份 + 启动方式双证后才考虑存活检测；③ 必带真实子进程边界回归（范例 `test/mcp-lifecycle.test.js`） | 改 `src/mcp.js` ⇒ buildId 变、需重启 + 四处升版；朴素 `process.ppid` 检测会因 shell wrapper **误杀正常 adapter**，空闲超时会误杀长会话 |
| P0-2 | **Playwright 旁路 PoC** | [docs/PLAYWRIGHT-FALLBACK-DECISION.md](PLAYWRIGHT-FALLBACK-DECISION.md) §4：门槛 0–5 **均未完成**，PoC 未执行、未通过、未获运行授权。门槛 0 要求「桥不可用 + 用户对具体通道明确授权」双前提，而 `docs/LOCAL-EVIDENCE-20261114-runtime.md` §1 记的是四证全通 | 用户先指定具体通道与范围；补齐门槛 0 证据；按门槛 1–2 做只读举证并回写 `CDP-GATEWAY-PLAN.md`，再确认范围 | 与 `AGENTS.md` §Required startup handshake / §Failure containment and secrets 冲突；**禁止**克隆 / 解析 / 上传 Chrome profile、`Cookies`、`Login Data`、`Local State`；不得把第二调试 profile 当登录 workaround；桥可用时不要人为制造故障 |
| P0-3 | **CDP Gateway** | [docs/CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md) 标题即「未实现、未 PoC、未授权」；§4 五条门槛（协议面 / 域清单 / 握手 / 登录态 / 安全）全无实证 | 先做门槛 1–2 的只读举证；任一不过就写「此路径在现有架构下不成立」 | `chrome.debugger` 是 **page 级**且只转发 CDP 域子集，与 `connect_over_cdp` 需要的 **browser 级** WS + target 发现不是同一层；网关若引入须同步设计 `operationId` / 幂等键 / `hostId` 绑定 |

### P1 — 需排期的实现缺口（`TROUBLESHOOTING-MATRIX.md` §4「仍未落地的诊断缺口」）

~~统一错误码表~~：**0.46.0 已实现**（`src/error-codes.js`，六个族 + `ERROR_CODE_GUIDE`；服务 `finish()` 统一附加且不覆盖生产方 code；扩展看门狗超预算时先用 tab/窗口证据自报；`browser_dialog wait` 在隐藏标签直接返回 `TAB_OCCLUDED`）。仍未实现：`operationId` + `browser_operation_status` 只读状态查询；hosts 的 `reconnectCount` / `disconnectReason` / `lastSeen` / `flapRate`；`browser_debugger action:"recover"` 与 SW 启动残留 attach 自检；`hostId:tabKey` 稳定跨宿主引用与 `browser_tabs_hung`；`doctor` 的强 CSP 编辑器探针。
> 当前已有**零散但真实**的 reason（`eval_blocked_by_page_csp`、`devtools_already_attached`、`tab_paused_by_debugger` 等），错误码只是在其上附加稳定族、不改写原文。除统一错误码外，其余五项**均未实现**，别写成已有能力。

### P2 — 需人决定的处置项（均非现症）

1. `README.md` / `CHANGELOG.md` 历史段落 **2 处既有断链**：都写成 `docs/field-reports/LOVE-PC-WIN11-2026-11-11-deploy-upgrade.md`，而真实文件是 `docs/FIELD-REPORT-LOVE-PC-WIN11-2026-11-11-deploy-upgrade.md`（`docs/` 根目录、无 `field-reports/` 子目录、前缀大小写不同）。非本轮引入，是否统一归档路径由人决定；本轮只登记不改。
2. 本机输入文件 `docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md` 未跟踪，是否归档；链接到它必须标「clone 后不存在」。`docs/local/` 自身 `.gitignore` 的 `*` 会排除全部内容 ⇒ 需留痕的本机证据改放 `docs/LOCAL-*` 前缀。
3. 本机个人目录 `C:\Users\love\.qoder\skills\csdn-autopublish\SKILL.md` 与仓库 `skills/csdn-publish/` 是否同步；旧结论 `simulation-button 是真发布按钮` **已证伪**（真按钮 `button.btn-b-red`，成功判据 `/mp_blog/creation/success/<id>`），个人目录里是否仍有旧结论残留未清理，本桥**不主动改或删**。
4. 历史掉线宿主 `h-b76b872f85d347a49e00` 与 `errorListCleared:false` 的处置；当前 `missingHostIds:[]`、两 host 均 connected，不据此宣称「都回来了」。
5. 看门狗 `pwsh` 启动链路偶发失败根因；`watchdog.jsonl` 的 `failures` 会归零、分日 `flagged` 是当日历史累积，别当新增失败。
6. UIA / DPAPI 单点 `.ps1` 是否排期收敛为 Node（`doctor-lite.bat` → `scripts/doctor-host-env.mjs` 已是「不依赖 pwsh」的可用范例，**不要给它加回 pwsh 依赖**）。
7. `python/bridge_worker.py` 孤儿侧车：删除 / 归档 / 明确声明，需人决定；项目运行时零 Python 依赖。
8. 「Chrome 136+ 禁止默认配置开 `--remote-debugging-port`」这一说法**仓库未在本机复核**，引用前先举证。
9. 模型链路现状：`src/agent.js` 会 POST OpenAI 兼容 `/chat/completions`，但入口只在 `assistant.html` + `POST /agent/start`，**未进 MCP 工具表**；Chrome 内置 AI 的 `browser_ai_status` / `browser_local_judge` 已在工具表但只做 advisory（默认 `off`）。产品硬约束见 `docs/PRODUCT-ROADMAP.md`：「模型不是运行前置条件」。

### P3 — 已知环境性失败，不是代码回归

8 条 `pwsh` 子进程边界测试（`autostart-options` / `autostart-registry` / `bounded-process` / `startup-mutex` / `stop-timeout` / `upgrade-preflight` ×2 / `watchdog`）；`npm test` 经管道或重定向会因缓冲伪装「卡住」；`Get-CimInstance` 全表 / WMI 全量枚举在本机可能挂起。

---

## 6. 审计工具箱（可直接复制；命令均为只读）

```bash
# 1) 发布面
git log -1 --format='%h %ad %s' --date=iso
git rev-list --left-right --count origin/main...HEAD
timeout 30 git ls-remote --tags origin 'refs/tags/v0.40.0*'   # 别用字典序 | tail 判最新
gh release list -L 6
node -e "const p=require('./package.json'),l=require('./package-lock.json'),m=require('./extension/manifest.json');console.log(p.version,l.version,l.packages[''].version,m.version)"

# 2) buildId（磁盘 vs 在线）
node -e "import('./src/build-identity.js').then(m=>console.log(m.BUILD_ID))"
node src/cli.js status          # token 由 CLI 内部读取，绝不写进命令行/脚本/日志

# 3) 服务四证
node -e "const n=require('net');const s=n.connect(19387,'127.0.0.1');s.setTimeout(3000);s.on('connect',()=>{console.log('TCP_OK');s.end()});s.on('timeout',()=>{console.log('TCP_TIMEOUT');s.destroy()});s.on('error',e=>console.log('TCP_ERR',e.code))"
curl -s -o /dev/null -w 'NAKED_HTTP=%{http_code}\n' --noproxy '*' --max-time 6 -H 'Host: 127.0.0.1:19387' http://127.0.0.1:19387/status
node src/cli.js doctor          # 只按 checks[].ok 对账；ok:true 的判定别用「全树扫 false」

# 4) 巡检（单次；并行会话有未提交源码时必须 --no-remediate）
node src/cli.js heartbeat --no-remediate
# EXIT=1 是调度信号；attention + provenClean:false 时 EXIT=0 ⇒ 调度器必须读 JSON 的 verdict + provenClean
# 复核只跑一次单次，不用 --watch --max-cycles、不跑第三次

# 5) 测试（无管道后台输出，避免缓冲伪装卡住）
node --test --test-concurrency=1 test/*.test.js
node skills/csdn-publish/snippets/verify-success.mjs --self-test   # 零依赖纯内存自测
```

**进程 / 端口取证走独立 PowerShell 通道**，别用 Git Bash `ps -p`、别从 Bash 调 PowerShell；`Get-Process` 全表 / WMI 全量枚举会挂起，一律单 PID + `netstat -ano -p TCP`。按 **exe 完整路径 + 命令行 + 父链** 认领，绝不按产品名相似度（例如 `WorkBuddy.exe` 与 `WorkBuddyAI.exe` 是两支）。命令行读取用项目自带 `scripts/probe-service-process.ps1`（`NtQueryInformationProcess`），不依赖 WMI。

**脚本层三类坑**（已实证，见 `docs/DEVELOPMENT-GUIDE.md` §4–§6）：
- PATH 里 Git/MSYS2 `usr\bin` 排在 System32 前 ⇒ `.cmd` 的 `timeout /t 3` 被 Unix `timeout.exe` 抢占；等待改用 `ping -n 4 127.0.0.1 >nul` 或 `Start-Sleep`。
- Git Bash 会把 Windows `/xxx` 开关改写成路径（实测 `tasklist /fo` → `PortableGit/fo`，报 `Invalid argument/option`）⇒ 必要时 `MSYS2_ARG_CONV_EXCL='*'`。
- 命令文本含 `powershell` / `pwsh` / `cmd` 字样会被安全策略误判为跨 shell 调用或危险命令（连变量名 `$cmd` 都会误伤）⇒ 走独立 PowerShell 通道、改变量名、结果写文件再读。
- 沙箱拦 `schtasks` / `reg` / `wscript`；PS stdout 常不回传，验证结果写文件再 `Read`。**工具调用结束会回收进程树 ⇒ 服务不能依附于即将结束的调用。**

---

## 7. 升级 SOP：改动 → 影响 → 发版

| 改动范围 | buildId | 重启服务 | 重载扩展 | 版本 / tag |
|---|---|---|---|---|
| 仅 `docs/**`、`skills/csdn-publish/**`、其它 `skills/<非 ai-browser-bridge>/**` | **不变** | 否 | 否 | **不升版本**，发 `v<版本>-docs.N` Pre-release |
| `src/**/*.js`、`skills/ai-browser-bridge/SKILL.md` | 变 | **是** | 视改动 | 四处同步升版 + 正式 tag |
| `extension/**` | 不变 | 视联动 | **是，按 `hostId`** | 四处同步升版 + 正式 tag |
| 新增工具 | 变 | 是 | 是 | 同上 |

**新增工具的机械同步点**（漏一处就是「单测全绿但真机 Unknown command」）：`src/tools.js` → `src/tool-index.js` 分组（有体积预算）→ **扩展侧两类分发**：`extension/worker.js` 主链 `if (name === 'browser_xxx')` 与 `extension/browser-authority.js` 的 `HANDLERS` 表（经 `worker.js` 的 `runAuthorityTool` 委托）。新增读字段还要查 `sensitive()` 过滤器。新增/改动模块**必须有一条走真实边界的测试**（HTTP / CLI / 文件落盘），范例 `test/scheduler-runtime.test.js`；单测自己构造结果对象是最常见的假绿来源。

**升版四处**：`package.json` / `extension/manifest.json` / `package-lock.json` 顶层 / `package-lock.json` 的 `packages[""].version`，重启后跑 `doctor` 的 `service-build-current`。

**发版序列**（用户长期约定：每次更新务必 push 及发版）：

```bash
git add <精确文件列表>                    # 绝不 git add .
git commit -F .local/commit-msg-<tag>.txt
git push sshpush main                     # https 卡凭据弹窗一律 sshpush
git fetch origin
gh release create <tag> --target main --prerelease --title "..." --notes-file .local/release-notes-<tag>.md
git fetch origin tag <tag>                # 精确同步本地 tag，别用 --tags（历史 tag 会冲突）
git rev-list --left-right --count origin/main...HEAD   # 必须 0/0
timeout 30 git ls-remote --tags origin 'refs/tags/v0.40.0*'
```

纯文档 tag **创建时直接带 `--prerelease`**，否则会顶掉 Latest 冒充新版本。协作区 `coordination/PROJECT-POLICY.md` §2–§3 对「版本四处 / 新工具三处 / 发版文档批」定义了单写者文件组与 claim / lease，改共享文件前按它执行；根 `AGENTS.md` 优先。

---

## 8. 硬边界与陷阱清单（接手必读）

1. **判定**：跨会话先查 `git log` / 远端 tag / Release / 四处版本；单轮不是事实；能力存在但找不到 = 不存在；「哪个 X 在用」只有 mtime + 真实调用路径能回答。
2. **文档里的工具调用形态也要真机走到**：`browser_debugger` 全 action 必填 `tabId`（`src/tools.js` 的 `tool('browser_debugger')` schema，0.40.0），`list` 分支虽不消费它但服务层先解析标签 ⇒ 写完示例必须 CLI 实跑一次。
3. **写契约**：所有状态变更用 `_verified` 变体；`uncertain` 结果不重放、先重新观察；`waiting` 是任务存活不是失败；`commandId` 幂等。见 `AGENTS.md` §Verified write contract。
4. **通道**：桥是权威浏览器通道；`AGENTS.md` §Required startup handshake 要求 health → tabs → observe；未经「桥不可用 + 用户对该具体通道明确授权」双前提，不启 Playwright / Puppeteer / Selenium / CDP / 第二套浏览器桥。
5. **秘密**：token / 密码 / cookie / 私钥 / 带会话 URL 绝不进命令行、脚本、日志、报告或聊天摘要；裸 `GET /status` 是预期鉴权，Host 头决定拒绝码（带端口 401 / 不带端口 403 / 无 Host 400）。
6. **宿主**：`hostId` 是身份，`extensionOwner` 易变；多宿主显式传 `hostId`，不隐式跨实例路由；`chrome://` 对 UIA 不可见；`browser_close` 的「本桥创建」登记在 worker 内存，reload 即丢。
7. **心跳动作白名单**只有 `build_restart` 与 `extension_reload`，且要求完全空闲 + 冷却 + 单实例锁 + 动作后 recheck；`host_lost` 升 critical 仍 `report_only`；`verdict=critical` ≠ 授权动手；动作前后复核 `server.pid` / LISTENING / `cooldowns` 未变。
8. **进程**：按命令行认领（本桥唯一常驻是带 `src\server.js` 的那个），绝不按 `node` 名字杀；`CODEBUDDY_SAFE_DELETE_ENABLED=1` 会让 shim 劫持 `unlinkSync` ⇒ 陈旧锁用一次性 `=0 node src/cli.js heartbeat --no-remediate` 让内置接管自己删，复核 `LOCK_GONE`。
9. **时间**：心跳 jsonl 按 UTC（本地 00:00–08:00 落 UTC 前一天，UTC 双日都读），工作日志按本地；`evidence.jsonl` 按 `step` 分层（`observe.output` 对象、`classify.output` 数组）；一致性只认 heartbeat 顶层 `runningBuildId` / `diskBuildId` + doctor `service-build-current`。引用历史用 `cycleId + 机器 ts`。
10. **交付**：纯文档不改 buildId；本机证据用 `docs/LOCAL-*` 前缀；文档链接到未入库的本机报告要标「clone 后不存在」；他人并行改动精确排除；AAR 追加到 `.workbuddy-ai/memory/YYYY-MM-DD.md`（append-only），长期硬规则进 `MEMORY.md`。

---

## 9. 接手第一小时检查单

- [ ] 1. 跑 §6 第 1–3 组命令，用**自己的时间戳**重建 HEAD / 版本 / buildId / 四证基线。
- [ ] 2. `git status --short`，列出他人并行改动并确认不会夹带；读根 `AGENTS.md` 当前工作树版本。
- [ ] 3. 读 §1 表格确定本次要查的专题文档；读 `.workbuddy-ai/memory/` 最近一日 AAR 与 `MEMORY.md` 硬规则。
- [ ] 4. `node src/cli.js doctor` + 单次 `heartbeat --no-remediate`（有并行未提交源码时），读 JSON 的 `verdict` + `provenClean`，不只看 EXIT。
- [ ] 5. 按 §3.4 判定「历史 finding 是否现症」，不把单轮 clean / `failures:0` 写成修复完成。
- [ ] 6. 从 §5 选**一条**待办，先确认它属于 P0（需授权）/ P1（需排期）/ P2（需人决定）；P0 未获授权只做只读取证。
- [ ] 7. 若动手改代码：按 §7 判断 buildId / 重启 / 重载 / 升版影响，并按机械同步点逐处核对。
- [ ] 8. 改完跑针对性回归 + 一条真实边界测试；文档改动跑一遍本地相对链接校验。
- [ ] 9. 独立交叉复核源码坐标与「未实现 / 未通过 / 未授权」措辞，避免把计划写成既成事实。
- [ ] 10. 精确提交 → push → Pre-release → 对账 `origin/main...HEAD 0/0` → 追加 AAR。

---

## 10. 本文维护约定

- 下一位 agent 更新状态时，**替换 §0 / §3 的带时间戳快照**并注明新的取证窗口；§4 追加新交付行，**不要回改历史结论**。
- 新决策写进对应专题文档，本文只加一行指针；不要在本文堆砌版本级复盘（那是 `docs/AGENT-HANDOFF-HUMAN-UI.md` 与 `CHANGELOG.md` 的职责）。
- 引用本文时带 `cycleId + 机器 ts`；引用历史位置用章节名而非行号。

## 11. 关联

- 产品硬契约：[../AGENTS.md](../AGENTS.md) · 版本说明：[../CHANGELOG.md](../CHANGELOG.md) · 文档索引：[../README.md](../README.md)
- 历史接手增量：[docs/AGENT-HANDOFF-HUMAN-UI.md](AGENT-HANDOFF-HUMAN-UI.md) · 早期交接（已过时）：[docs/HANDOFF.md](HANDOFF.md)
- 症状分诊：[docs/TROUBLESHOOTING-MATRIX.md](TROUBLESHOOTING-MATRIX.md) · 已知限制：[docs/KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)
- 网关评估（未实现）：[docs/CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md) · 旁路决策（PoC 未执行）：[docs/PLAYWRIGHT-FALLBACK-DECISION.md](PLAYWRIGHT-FALLBACK-DECISION.md)
- 本机只读取证：[docs/LOCAL-EVIDENCE-20261114-runtime.md](LOCAL-EVIDENCE-20261114-runtime.md) · 进程与运行时：[docs/PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md](PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md) · adapter 生命周期：[docs/PROCESS-LIFECYCLE.md](PROCESS-LIFECYCLE.md)
- 脚本坑与开发约定：[docs/DEVELOPMENT-GUIDE.md](DEVELOPMENT-GUIDE.md) · 产品方向：[docs/PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md) · 站点配方：[../skills/csdn-publish/SKILL.md](../skills/csdn-publish/SKILL.md)
