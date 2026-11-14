# LOCAL-EVIDENCE-20261114-runtime — 0.40.0 真实环境只读取证

- 归档性质：**本机运行态快照**（按 `README.md` 约定用 `LOCAL-` 前缀归档，纳入版本库仅作证据留痕）。已脱敏：不含 `agentToken`、cookie 值、`UserToken`、页面正文或任何凭据。
- 取证时间：**2026-11-14 21:07 GMT+8**（UTC `2026-11-14T13:07Z`）。
- 版本基线：`package.json` / `package-lock.json`（顶层与 `packages[""]`）/ `extension/manifest.json` 四处均 **0.40.0**；HEAD `b4ad8d0`；`origin/main...HEAD 0/0`；本地 tag `v0.40.0`、`v0.40.0-docs.1`。
- 取证范围：**只读**。不改 `src/` / `extension/`、不改版本号、不重启服务、不重载扩展、不启 GUI、不抢前台、不启动 Playwright 或第二套浏览器通道、不克隆或解析 Chrome profile / `Cookies` / `Login Data`。

> 结论摘要：①服务存活四证全通；②**CSDN 编辑器取证前提不成立**（桥返回的标签清单为空），排障矩阵 §3 的四步现场归因本轮**未执行**、不伪造；③真机发现一条**文档承诺但走不通的调用路径**，已在本轮文档修订中纠偏；④看门狗异常状态只登记、不处置、不猜诱因。

---

## 1. 服务存活四证

| # | 证据 | 命令 / 来源 | 逐字输出（要点） | 判定 |
|---|---|---|---|---|
| 1 | LISTENING PID + 进程身份未漂移 | 独立 PowerShell：`netstat -ano -p TCP \| Select-String ':19387'`、`Get-Process -Id <pid>`；`.local/server.pid` | `TCP 127.0.0.1:19387 0.0.0.0:0 LISTENING 37712`；`TCP 127.0.0.1:19387 127.0.0.1:4893 ESTABLISHED 37712`；`NAME=node ID=37712 START=11/14/2026 20:43:37`；`PIDFILE=37712` | **通过**。pid 文件与真实监听者一致且均为 `node`，不是 PID 复用 |
| 2 | TCP 探针 | Node `net.connect(19387,'127.0.0.1')` | `TCP_CONNECT_OK` | **通过** |
| 3 | 裸 `/status`（带端口 Host） | `curl --noproxy '*' -H 'Host: 127.0.0.1:19387' http://127.0.0.1:19387/status` | `HTTP=401` | **通过**。401 是**鉴权前预期拒绝码**；Host 带端口决定该码（不带端口 403、无 Host 400） |
| 4 | 带 token 的状态读取 | `node src/cli.js status`（token 由 CLI 从 `.local/config.json` 内部读取，**不进命令行/脚本/日志**） | `version:"0.40.0"`、`extensionVersion:"0.40.0"`、`buildId:"5b70528676c3403d92c234bb218d01f2c364d82fbe426b13917e3e00a977c77a"`、`hostCount:1` | **通过** |

补充：`netstat` 同时显示 `127.0.0.1:4893 → 19387 ESTABLISHED 124960`，与 `status` 的 `extensionOwner.pid:124960` / `browser_hosts` 的 `owner.pid:124960` 一致，即扩展宿主的连接真实存在。

## 2. buildId 与纯文档交付前提

`src/build-identity.js` 的 `computeBuildIdentity(root)` 只 hash `package.json`、`package-lock.json`、`skills/ai-browser-bridge/SKILL.md` 与 `src/**/*.{js,mjs,cjs,json}`。本次新增/修订的文件全在 `docs/` 与 `skills/csdn-publish/` 下，**不在哈希范围内**。

在线 `status.buildId = 5b705286…77a` 与 `CHANGELOG.md` 0.40.0 部署记录里的 `5b70528…` 一致 ⇒ 本轮不会触发 `build_stale` / `version_skew`，**无需重启服务、无需按 `hostId` 重载扩展**。收尾时会再取一次 `status` 复核未变。

## 3. 看门狗观察项（只登记，不处置）

`.local/watchdog-status.json` 逐字内容：

```json
{
  "pid": 31176,
  "state": "port-occupied-or-service-unresponsive",
  "time": "2026-11-14T21:03:51.4557756+08:00",
  "failures": 34
}
```

按项目判定纪律：四证全通时这属于**看门狗/探测侧观察**，不是服务退化证据。`failures` 是**累计值**不是新增失败数；`watchdog-status.json` 的时间会推进而 `watchdog.jsonl` 末条可能滞后。本轮**不重启、不杀任何 PID、不改看门狗代码、不猜诱因**；原因无证据不写入结论。

## 4. CSDN 编辑器取证：**前提不成立**

| 调用（只读） | 逐字返回（要点） |
|---|---|
| `browser_tabs {"agent":"docs-evidence"}` | `{"result": []}` |
| `browser_tabs {"hostId":"h-0b47a521c4384e90beb4","agent":"docs-evidence"}` | `{"result": []}` |
| `browser_hosts {"agent":"docs-evidence"}` | `hostCount:1`，`primaryHostId:"h-0b47a521c4384e90beb4"`，`hostKind:"generic"`，`extensionVersion:"0.40.0"`，`connected:true`，`inFlight:false`，`commandsDispatched:2` / `commandsCompleted:2` |

**判定**：宿主在线、有 ESTABLISHED 连接，但桥返回的标签清单为空 ⇒ **不存在可供取证的 CSDN 编辑器标签**。`docs/TROUBLESHOOTING-MATRIX.md` §3 要求的四步现场归因（`browser_debugger` → `browser_health` → `browser_eval` → 才谈 CSP/遮挡/宿主 flap）本轮**一步都未执行**，不写成「已复现」或「已排除」。这不等于「浏览器没有窗口/没有标签」，只表示**本次桥返回的清单为空**，是能力面可观察的边界。

本轮明确**未做**：没有用 `browser_open` 打开用户真实登录态页面（未经授权）、没有启动 Playwright / 第二套浏览器、没有克隆或解析 Chrome profile、`Cookies`、`Login Data`、没有写入任何页面、没有抢前台。

### 前提成立时的可复现步骤（留给下一次）

1. `browser_tabs` 取**真实 `tabId`**（并用 `hostId` 显式绑定，服务重启后 primary 会漂移）。
2. `browser_debugger {"action":"list","tabId":<真实 tabId>}` —— 查本扩展持有的长活会话与 `paused` 状态。
3. `browser_health {"tabId":<真实 tabId>}` —— 分开读 `windowFocused` / `pageProbe.visibilityState` / `hasFocus`，三者是不同状态且均属 advisory。
4. `browser_eval` 读返回体的 `channel`（`main_world` / `cdp`）或 `waiting/tab_paused_by_debugger`；**只在证据齐备后**才谈归因，且绝不重放不确定的写。

## 5. 真机发现：文档承诺的调用路径走不通

**现象**（逐字）：

```
$ node src/cli.js call browser_debugger '{"action":"list"}'
Missing argument: tabId. browser_debugger accepts 16 argument(s) — required: tabId, action; optional: scriptUrl, urlFilter, ...

$ node src/cli.js call browser_debugger '{"action":"list","tabId":1}'
No tab with id: 1.
```

**源码反证**：

- `src/tools.js:371-386`：`browser_debugger` 的必填数组是 `['tabId','action']`，**所有 15 个 action 一律要求 `tabId`**，没有为 `list` 开例外。
- `extension/worker.js:1334-1342`：`list` 分支本身确实不使用 `tabId`（`return { status:'success', sessions: debuggerSessions.list() }`），但服务层/标签解析发生在它之前（对照组 `tabId:1` 返回 `No tab with id: 1.` 即证据）。
- 因此上一轮交付的 `docs/TROUBLESHOOTING-MATRIX.md`（§1 #1/#2/#3 与 §3 第 1 步）、`docs/KNOWN-LIMITATIONS.md`（§3「扩展重载不清横幅」条目）、`skills/csdn-publish/SKILL.md`（§4 超时处置）里写的 `browser_debugger action:"list"`（不带 `tabId`）在真机上**必然报 `Missing argument: tabId`**。此处用的是**修订前**的章节定位，不用行号，避免文档改动后行号漂移造成误读；本轮已全部改为带 `tabId` 的形态。

**修法（本轮已落）**：文档统一改写为 `browser_debugger {action:"list", tabId:<真实 tabId>}` 并补一条说明——`list` 内部不消费 `tabId`，但入口 schema 与标签解析强制要求，必须先 `browser_tabs` 取真实 id。**不改 `src/` / `extension/`**：为 `list` 放宽 schema 会改变工具契约、触发版本与 buildId 变更，且当前按标签归属解析是既有设计；按「能力存在但找不到 = 不存在」的纪律，修文档里的调用形态才是最小正确解。

`CHANGELOG.md:17` 是上一轮的历史段落，按「旧标题错不回改」的约定**不回改**，纠偏记录写在本轮新增段落。

## 6. 证据边界

- 本文只陈述 2026-11-14 21:07 GMT+8 这一次观测；单轮不是事实，跨会话须重新取证。
- 所有 PID、`hostId`、`sessionId`、时间戳均为本机瞬时运行态，换机/重启后必然不同，不可当作稳定配置。
- 现场报告 `docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md` 仍是**用户提供的本机输入文件**，未纳入版本库；本文不改动它。
- 相关：[docs/TROUBLESHOOTING-MATRIX.md](TROUBLESHOOTING-MATRIX.md)、[docs/CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md)、[docs/KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)、[docs/PLAYWRIGHT-FALLBACK-DECISION.md](PLAYWRIGHT-FALLBACK-DECISION.md)。
