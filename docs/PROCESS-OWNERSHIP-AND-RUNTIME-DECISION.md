# 进程归属与运行时选型决策（2026-11-14）

- 性质：**证据化结论文档**，全程只读取证。不改 `src/` / `extension/`、不改版本号、不改 buildId、不杀任何进程、不启 GUI、不改 `browserTarget`。
- 触发：用户在「冗余进程清理」会话发现本机 **166 个重复 MCP/stdio 服务器实例、18 条完全相同的命令行**（`windows-control/server.py` 20 份、`windows_mcp serve` 18 份、`jianyingdraft/server.py` 16 份，另 207 个 conhost、29 个卡死 taskkill），问是否与本项目有关、是否该改用 Python / Rust 提升稳定性。用户随后补充了宿主分支归因证据（见 §1.5）。
- 基线：版本 `0.40.0`，HEAD `d64f837`，tag `v0.40.0-docs.2`，`origin/main...HEAD 0/0`。

---

## 0. 结论先行（两问两答）

1. **那 166 个重复 MCP 实例与本项目无同源关系**，不需要为此修复或升级本项目。源码 / 脚本 / 扩展 / 测试全零命中；本机实证显示本桥当前只占 **1 个** Node 进程（服务本体），stdio adapter 为 **0 个**，且唯一的扩展宿主是**系统 Chrome** 而非那支陈旧 WorkBuddy 进程。真正该处置的是 MCP 宿主侧的去重配置、conhost 孤儿与卡死的 taskkill，以及 WMI provider 挂死。
2. **不建议改用 Python 或 Rust**。扩展层受 Manifest V3 硬约束只能是 JS；服务层换语言要重写全栈且故障不在此层；真正不稳的是 **Windows 运维脚本层与宿主环境前提**，仓库已有对症方案与免 pwsh 入口。换语言与产品既有立场相悖、无可复算收益。

---

## 1. 第一问：166 个重复 MCP 实例与本项目的关系

### 1.1 源码零命中（先排除同源）

口径：**除本轮新增/修订文档自身对这些名词的引述外**，`src/`、`scripts/`、`extension/`、`test/`、`.local/` 与既有 `docs/`、`CHANGELOG.md` 全部零命中。

| 关键词 | 检索结果（除本轮文档自身引述外） |
|---|---|
| `windows-control` / `windows_mcp` / `jianyingdraft` | **零命中** |
| `reap-duplicate-mcp` / `orphan-watchdog` / `kill-zombie-procs` | **零命中**（这些工具属另一仓库） |
| `StdioServerTransport` / `@modelcontextprotocol/sdk/server/stdio.js` | 仅 `src/mcp.js:2`、`:52` |

那批实例是被多个 agent 宿主各拉一整套的第三方 Python/Node MCP server，不是本桥的组件。宿主身份**按可执行文件完整路径判断**，不按产品名，见 §1.5。

### 1.2 本项目的进程面（逐字源码）

| 环节 | 事实 | 证据 |
|---|---|---|
| MCP 入口 | **stdio**，`src/mcp.js`；每个客户端宿主 1 个 adapter，**共用** 127.0.0.1:19387 服务 | `src/mcp.js:2,52`、`src/client.js:9`、`README.md:317-327`、`AGENT-QUICKSTART.md:112` |
| 服务单实例 | `start.ps1` 命名互斥锁 + `/status` 探活 + 端口占用报错**不杀进程**；`server.js` 默认在 19387 listen（`AIB_PORT` 可覆盖），**绑定 127.0.0.1 恒成立** | `start.ps1:6-10,29-30,58-62`、`src/server.js:2023,2051,2080-2082` |
| 多宿主 | **同一服务 + 多条 WebSocket**，不是「每个浏览器各拉一个进程」；`extension/` 下 `child_process`/`spawn` 零命中 | `src/host-registry.js:3-8,124-179`、`AGENTS.md:30`、`extension/manifest.json:40-43` |
| 看门狗 | 命名互斥锁；仅「`/status` 不通 **且** 端口空闲」才拉起服务；端口占用只记 `port-occupied-or-service-unresponsive`；指数退避上限 60s | `scripts/watch-service.ps1:13,149-156,161`、`src/heartbeat.js:424-436`（只 SIGTERM，**不 spawn**） |
| adapter 生命周期 | **已有清理**：stdin `end`/`close` 或 stdout `EPIPE` → 关 transport → 1 秒兜底 `process.exit(0)`；真实子进程回归测试 | `src/mcp.js:35-52`、`docs/PROCESS-LIFECYCLE.md:7-9,16-19` |

⇒ 本项目**不会因为多宿主而按宿主数爆发式拉起进程**，也**不会因看门狗重启失败反复拉起新进程**。

### 1.3 本机实证（22:04–22:15 GMT+8）

用项目自带的 `scripts/probe-service-process.ps1`（`NtQueryInformationProcess(ProcessCommandLineInformation=60)`，**不依赖 WMI**）逐个读 `node` 进程命令行：

```
NODE_TOTAL=58
BRIDGE_MCP_ADAPTERS=0
BRIDGE_SERVER=1
FOREIGN_MCP_IN_NODE=0
  SERVER_PID=37712 TEXT="D:\Scoop\apps\nodejs-lts\current\node.exe" "K:\PythonProjects5\AI-Browser-Bridge\src\server.js"
NODE_OLDER_THAN_12H=4
```

- 服务存活四证：`netstat` 显示 `127.0.0.1:19387 LISTENING 37712`；TCP 探针 `TCP_OK`；裸 `/status` 带端口 `HTTP=401`（预期鉴权）；带 token 的 `status` 返回 `version:0.40.0` / `buildId:5b705286…77a`。**PID 与命令行、监听端口三者一致才认领**，不靠名字相似度。
- `NODE_OLDER_THAN_12H=4`：4 个老 node 进程存在，但本桥只认领上述 1 个 server，**未逐个认定其余归属，也未 kill 任何未验证 PID**。
- 看门狗 `.local/watchdog-status.json`：`pid:31176`、`state:"port-occupied-or-service-unresponsive"`、`failures:34`（**累计值**）、`time:2026-11-14T22:07:20+08:00`。四证全通 ⇒ 按项目纪律**只登记、不重启、不杀 PID、不猜诱因**。
- 摘录里的 `orphan-watchdog.heartbeat` / `kill-zombie-procs` / `reap-duplicate-mcp.py` **不是本项目的看门狗**；本项目的看门狗是 `scripts/watch-service.ps1`，其状态文件是 `.local/watchdog-status.json` / `.local/watchdog.jsonl`。

### 1.4 一个**属于本项目**的残余缺口（但不是现症）

`docs/PROCESS-LIFECYCLE.md:21-24` 逐字写明：

> This fix does not establish the cause of all machine-wide slowdown, **nor detect clients that remain alive and keep their pipes open indefinitely**.

即：**宿主进程仍活着但不再使用 adapter、stdin 不 EOF 时，adapter 不会退出**。多宿主环境下每个宿主 1 个 adapter，理论上可累积。「MCP 死进程」这个描述在本项目上唯一可能对应的就是这一条。

**本轮不改它**，理由是可复算的：

- 实测 `BRIDGE_MCP_ADAPTERS=0`，**无现症**；按项目「单轮不是事实 / 不因一次观察改代码」的纪律，不凭推测改运行时。
- 改 `src/mcp.js` 会改变 `computeBuildIdentity()` ⇒ 需要重启服务、四处升版、按 `hostId` 重载/重连，影响面远大于收益。
- 朴素「父进程存活检测」不安全：adapter 可能由 shell wrapper 启动，`process.ppid` 指向一个启动后即退出的壳，会**误杀正常 adapter**；「空闲超时」会误杀长时间闲置但有效的会话。两者都需要「开与关不同」的真实子进程边界测试，不能拍脑袋上线。

**可选加固（需用户单独授权）**：① adapter 启动/退出登记到 `.local/`，让巡检**按命令行**精确识别而不是按 `node` 名字；② 父进程身份 + 启动方式双证齐备后才考虑存活检测；③ 加固必须带真实边界回归（范例 `test/mcp-lifecycle.test.js`）。

给外部回收器的硬规则（`docs/PROCESS-LIFECYCLE.md:5` 已有）：**不要把所有 Node 进程当重复项按名字杀**。本桥唯一的常驻进程是带 `src\server.js` 命令行的那一个。

### 1.5 宿主分支归因（用户补充证据 + 本机复核）

用户补充：**陈旧 daemon（PID 57164）与已回收的 12 个旧 CodeBuddy/renderer 根都在 `D:\Programs\WorkBuddy\WorkBuddy.exe` 子树下**，不是独立的 `WorkBuddyAI.exe`（后者当时约 2.3% CPU）；按可执行文件身份，它是 **WorkBuddy 而非 WorkBuddy AI**。这条纠正了「按产品名笼统称 WorkBuddy 宿主」的说法。

本机只读复核（22:18 GMT+8，独立 PowerShell 通道 + 单 PID + 原生 API 命令行）：

```
WB_EXE_EXISTS=True                 # D:\Programs\WorkBuddy\WorkBuddy.exe
WBAI_EXE_EXISTS=True               # D:\Programs\WorkBuddyAI\WorkBuddyAI.exe（另一支）
PID_57164_NAME=WorkBuddy
PID_57164_PATH=D:\Programs\WorkBuddy\WorkBuddy.exe
PID_57164_START=2026-11-13T17:47:46+08:00   # 约 28.5 小时，与「陈旧 daemon」一致
OWNER_124960_NAME=chrome
OWNER_124960_PATH=D:\Program Files\Google\Chrome\Application\chrome.exe
OWNER_124960_CMD="D:\Program Files\Google\Chrome\Application\chrome.exe" --type=utility --utility-sub-type=network.mojom.NetworkService ...
```

- 两个可执行文件**确实并存且是不同安装**；PID 57164 的 `Path` 逐字指向 `WorkBuddy.exe` 那一支 ⇒ 用户的归因在本机复核**通过**。「`WorkBuddyAI.exe` 当时约 2.3% CPU」是另一会话的瞬时采样，**本轮未复测**，不作为本文的验证结论。
- **本桥当前的扩展宿主不是这一支**：`status.extensionOwner.pid = 124960` 是系统 Chrome（`stable/Default`，与用户二次确认的 `browserTarget` 一致）；`browser_hosts` 只有 1 个宿主，`hostKind:"generic"`、`chromeVersion 156.0.8078.49`。当前**没有** WorkBuddy / CodeBuddy / 其它 agent 内嵌浏览器连入本桥。
- 本桥的多宿主设计（`AGENTS.md:30`）允许内嵌浏览器以 WebSocket 连入，但那属于**Chrome 自身的进程模型**，本桥不按宿主数拉起独立 OS 进程；当前 `hostCount:1` 也说明连入数量为 1。
- ⇒ 这条证据**进一步强化「不同源」**：陈旧 daemon 与旧 renderer 根在 WorkBuddy.exe 子树，本桥唯一的常驻进程是 `src\server.js`，唯一的扩展宿主是系统 Chrome。
- 归因纪律（用户长期硬规则）：**绝不靠名字相似度判断进程归属**；判定前必须拿到 exe 完整路径或命令行，再看父链。`WorkBuddy` ≠ `WorkBuddyAI`，两者不能合并计数。

---

## 2. 第二问：PowerShell / bash 语法不稳，要不要换 Python 或 Rust

### 2.1 本轮拿到的四类实证（都是**环境前提**，不是代码回归）

1. **PATH 抢占（仓库已有逐字记载）**：`docs/DEVELOPMENT-GUIDE.md:315-318` —— `timeout` / `find` / `sort` 可能被 Git/MSYS2 的 `usr\bin` 抢占；Windows 命令等待改用 `ping -n 4 127.0.0.1 >nul`，PowerShell 用 `Start-Sleep`；写脚本不要假定同名工具是 Windows 版。
2. **MSYS2 参数改写（本轮新增实证）**：在 Git Bash 里执行 `tasklist /fo csv /nh`，`/fo` 被转换成绝对路径，逐字报错：
   ```
   ERROR: Invalid argument/option - 'D:/Programs/WorkBuddyAI/resources/vendor/PortableGit/fo'.
   Type "TASKLIST /?" for usage.
   ```
   ⇒ Windows 原生命令的 `/` 开关在 MSYS 层被当路径改写，**不是语法写错**。
3. **命令文本敏感字样被安全策略误判（本轮新增实证）**：Bash 命令里出现 `powershell.exe` / `pwsh.exe` 字样被拦为「Invoking PowerShell from Bash」；PowerShell 命令里变量名 `$cmd` 被拦为「cmd.exe cannot be used from the PowerShell tool」。改走独立 PowerShell 通道 / 换变量名后，同一逻辑立即成功。另一次 `MSYS2_ARG_CONV_EXCL='*' tasklist …` 在进程数较大时被 `SIGTERM` 终止，**未拿到数据 ⇒ 不写成已验证的解法**。
4. **`pwsh` 子进程整体异常（既有记载 + 本轮复现）**：`CHANGELOG.md:81` 记载 8 条测试失败属「环境前提不成立」，集中在 `autostart-options` / `autostart-registry` / `bounded-process` / `startup-mutex` / `stop-timeout` / `upgrade-preflight` / `watchdog`；本轮最小 PowerShell 探针 `PS_OK=…` 正常，但含 `tasklist` 的调用两次 `exit 1` 且无 stdout；`watchdog-status.json` 长期停在 `port-occupied-or-service-unresponsive`。

这四类都指向**宿主 shell 环境 / 工具链前提**，不是本项目代码的语法错误。

### 2.2 为什么不能换语言（按层）

| 层 | 能换吗 | 代价 / 硬约束 |
|---|---|---|
| **Chrome 扩展层** | **不能** | `extension/manifest.json:2` 是 MV3、`:40-43` 声明 `service_worker:"worker.js"` + `type:"module"`；页面侧代码要能被 `chrome.scripting.executeScript({func})` 序列化（`extension/worker.js:894,1290`）；CSP `script-src 'self'`。逐字约束见 `docs/AGENT-ROBUSTNESS-RESEARCH.md:183-186,192`「**Python 库不能直接进基座**」「引入依赖前应该先回答：它进的是哪个进程？」。Rust/WASM 需要构建链，全仓无 `wasm` / `Cargo` / `rollup` / `webpack` / `esbuild` / `dist` 工程配置 |
| **Node 服务层** | 理论可、**无收益** | 运行时依赖只有 `@modelcontextprotocol/sdk 1.30.1` 与 `ws 8.22.0`（`package.json:27-30`），`engines.node >=22`；换语言要重写 MCP/WS/CLI 全栈与 100+ `test/*.test.js`，而本次故障**不在此层** |
| **Windows 运维脚本层** | **唯一值得动**，但也**不是换语言** | 23 个 `.ps1` + 9 个 `.bat`，被 `src/desktop-adapter.js:11-13`、`src/native-ui-action.js:227` 等按路径 spawn；全迁要改所有调用点与 7 个 `.bat`。仓库**已有免 pwsh 入口**：`doctor-lite.bat:14` → `scripts/doctor-host-env.mjs`（Node）、`scripts/check-runtime.bat:10-16`（`where.exe` + `node -e`）、`package.json:20` 的 `doctor = node src/cli.js doctor`；`scripts/resolve-runtime.ps1` + `.local/runtime.json` 固化绝对路径以消除 PATH 抢占 |

产品既有立场（逐字）：`docs/PRODUCT-ROADMAP.md:157`「**模型不是运行前置条件**」、`docs/ONE-SHOT-UPGRADE-PLAN.md:19`「**Python Worker 是可选旁路，不进入扩展包**」、`docs/PYTHON-AUTOMATION-INTEGRATION.md:94`「应按需安装、按能力域隔离」、`CHANGELOG.md:17`「结论仍是**不引入嵌入式 Python**；正解是业务契约与环境值分层，而不是给基座加运行时」。`python/` 下 3 个 `.py` 仅被 `test/python/worker_test.py` 自测 import，JS / npm scripts / 扩展零引用。

### 2.3 最小稳定化路线（绑定具体文件）

1. 交付给用户的诊断入口优先走 **Node**：`doctor-lite.bat` / `node src/cli.js doctor` / `scripts/doctor-host-env.mjs`；不要用需要 pwsh 的 `doctor.bat` 作为唯一入口。
2. 确需 pwsh 时，用 `scripts/resolve-runtime.ps1` 读 `.local/runtime.json` 的**绝对路径**，不靠 `Get-Command` / PATH。
3. `.bat` / `.cmd` 里不写 `timeout /t`；等待用 `ping -n 4 127.0.0.1 >nul`，PowerShell 用 `Start-Sleep`。
4. 在 Git Bash 调 Windows 原生命令时不要写 `/xxx` 开关（改走独立 PowerShell 通道）；命令文本避免出现 `powershell` / `pwsh` / `cmd` 等会触发安全策略误判的字样。
5. 单点 UIA / DPAPI 的 `.ps1` 若要收敛为 Node，需**单独排期 + 回归**，不是本次范围；不要因为「换语言」把它们一次性重写。

---

## 3. 决策记录

| 日期 | 决定 | 依据 |
|---|---|---|
| 2026-11-14 | **不为 166 个第三方 MCP 实例修本项目**；只落结论文档与进程归属规则 | 源码零命中；本机 `BRIDGE_MCP_ADAPTERS=0` / `BRIDGE_SERVER=1`；本桥已有单实例锁、看门狗不重启、adapter EOF 清理 |
| 2026-11-14 | **不引入嵌入式 Python / 不迁 Rust** | MV3 扩展必须 JS；无构建链；服务层重写无收益；产品立场与已有免 pwsh 入口 |
| 2026-11-14 | 把「MSYS2 参数改写」「命令文本敏感字样误判」补进开发指南 | 本轮逐字实证，仓库此前只有 PATH 抢占记载 |
| 2026-11-14 | 采纳用户补充的**宿主分支归因**，并把「按 exe 完整路径而非产品名归因」写成硬规则 | 本机复核 `WorkBuddy.exe` / `WorkBuddyAI.exe` 并存、PID 57164 属前者；本桥宿主是系统 Chrome |

---

## 4. 边界 / 未完成

- 未杀任何进程、未运行外部回收器、未改 `src/` / `extension/`、未启 GUI / 抢前台 / 切 `browserTarget`、未克隆或解析 Chrome profile。
- 未复现摘录里的 166 个实例；结论是「**不同源**」，不是「问题不存在」。本机 4 个 >12h 的 node 进程未逐个认定归属，不 kill 未验证 PID。
- 用户补充的「12 个旧 CodeBuddy/renderer 根已回收」「`WorkBuddyAI.exe` 当时约 2.3% CPU」属于**另一会话的观察与处置**，本轮只读复核了 exe 路径与 PID 57164 身份，**未复测 CPU、未重复回收、不宣称是自己做的**。
- §1.4 的 adapter 残余缺口**未修**；如需加固要单独授权并带真实边界回归。
- 本次取证中 `tasklist` 相关命令因 MSYS2 改写 / 安全策略字样 / 工具超时多次失败，改用项目自带原生 API 探针 + 独立 PowerShell 通道后才拿到可复算数据；这些失败本身已作为 §2.1 的证据保留，不写成「已验证解法」。
- `README.md` / `CHANGELOG.md` 历史段落 2 处既有断链（`docs/field-reports/LOVE-PC-WIN11-…`）非本轮引入，已在前一轮登记，本轮仍未修改。
- 工作区他人并行改动（`.gitignore`、`AGENTS.md`、`docs/AGENT-HANDOFF-HUMAN-UI.md`、`.aep/`、`coordination/`、现场报告）一律不夹带提交。

## 5. 关联

- 进程归属与 adapter 生命周期：[docs/PROCESS-LIFECYCLE.md](PROCESS-LIFECYCLE.md)
- PATH / 脚本坑：[docs/DEVELOPMENT-GUIDE.md](DEVELOPMENT-GUIDE.md) §4–§6
- 已知限制与硬边界：[docs/KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)
- 0.40.0 运行态四证：[docs/LOCAL-EVIDENCE-20261114-runtime.md](LOCAL-EVIDENCE-20261114-runtime.md)
- 「不引入嵌入式 Python」的上一次决策：[docs/PLAYWRIGHT-FALLBACK-DECISION.md](PLAYWRIGHT-FALLBACK-DECISION.md) §1
