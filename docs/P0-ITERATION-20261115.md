# P0 三项实施记录（2026-11-15，qoder）

- 触发：用户 **「三项都由你开始修复并迭代试试」**。范围限定为 `docs/AGENT-HANDOFF-20261115.md` 的 P0-1 / P0-2 / P0-3。
- 后续授权：用户 **「升级本机浏览器扩展并推送和发布版本号」**，据此完成两个宿主的扩展重载、0.41.0 升版、提交、push 与发版。
- 协作声明：AEP 四个 claim 均 ALLOWED（`0401-P0-ADAPTER-QODER`、`0401-P0-CDP-PROBE-QODER`、`0401-P0-PLAYWRIGHT-QODER`、`0401-RELEASE-QODER`）。
- 版本：**0.41.0**（四处同步）；服务已重启，两个宿主扩展均已重载。Playwright 未启动。

## 0. 结论先行

| 项 | 代码 | 测试 | 真机状态 | 还差什么 |
|---|---|---|---|---|
| P0-1 adapter 注册与清单 | **已完成** | 5 新 + 1 扩展边界，全绿 | 新 adapter 自动登记；活服务上 `adapters` 可读，当前 0 条（现有 MCP adapter 仍是旧代码启动的） | 无（残余缺口变为可观测，仍未自动关闭） |
| P0-3 CDP 门槛 1–2 探针 | **已完成** | 5 项，全绿 | 0.41.0 真机已执行：`Target.getTargets` 被拒 `-32000`、`Schema.getDomains` 不支持 `-32601`、其余 4 条 accepted；`browserLevelEndpoint:false` | 无（门槛 1–2 已执行）；若要浏览器级 CDP，仍需独立网关 + 新端口 + 单独授权 |
| P0-2 Playwright 门禁 PoC | **已完成（门禁 + 本地 fixture）** | 6 项，全绿 | 门 0 **不成立**：0.41.0 复跑仍 `reachable:true`（HTTP 401），拒绝启动 | 需要「桥不可用 + 该具体通道」的新授权；本轮不跑 live PoC |

## 1. P0-1：stdio adapter 注册与只读清单

### 实现

- 新增 `src/adapter-registry.js`：`createAdapterRegistry()` 在 adapter 启动时原子写入 `stateDir/mcp-adapters/<pid>.json`，每 15 秒刷新 `heartbeatAt`（测试可用 `AIB_ADAPTER_HEARTBEAT_MS` 缩短），进程正常退出时删除；记录 `pid/ppid/execPath/argv/cwd/startedAt/heartbeatAt`。
- `src/mcp.js` 在 `server.connect()` 前启动注册，在既有 EOF/close/EPIPE 关闭路径和 `exit` 钩子里撤销。注册失败被吞掉，不影响 MCP 协议输出。
- `node src/cli.js adapters [--stale-ms N] [--prune [--older-than-hours N] [--dry-run]]`：
  - 默认只读；按心跳年龄给 `fresh/stale`，**明确输出 `liveness:"not_checked"`**；
  - `--prune` 只删注册文件，不碰进程；默认只删 24 小时以前的记录；
  - 不用 `process.ppid` 判活、不做空闲超时、不按名字杀 node。
- 旧 `docs/PROCESS-LIFECYCLE.md` 的残余缺口（宿主活着且不关管道）**未关闭**；现在只是从「不可见」变成「可清点」。

### 证据 / 回归

- `test/adapter-registry.test.js`（5 项）：记录字段、心跳刷新、fresh/stale 判定且不认领存活、缺失目录为空清单、按年龄 prune（含 dry-run）。
- `test/mcp-lifecycle.test.js`（扩展）：真实子进程在服务请求期间有记录、EOF 退出后记录消失；原有 2.5s 退出断言仍通过。
- 活服务 `node src/cli.js adapters` 返回 `count:0 / liveness:"not_checked"`。这不是失败：本会话的 MCP adapter 是在加注册表之前启动的，只有新 spawn 的 adapter 才会登记。

## 2. P0-3：CDP 门槛 1–2 的一次性只读探针

### 实现

- `browser_debugger` 新增 `action:"probe"`（`src/tools.js` 枚举与说明、`extension/worker.js` 分支、`extension/cdp-probe.js`）。
- 探针短暂 attach（或复用已有 debugger 会话），依次调用：
  - `chrome.debugger.getTargets()`（扩展 API，不 attach 也能调）
  - `Target.getTargets`、`Schema.getDomains`、`Page.getFrameTree`
  - `Runtime.evaluate("1+1", returnByValue:true, timeout:1000)`
  - `Input.setIgnoreInputEvents({ignore:false})`
  - `Network.getCookies({urls:["https://example.invalid/"]})`
- 返回只含：target 计数/类型、域存在性、frame 计数、脱敏后的 scheme+host、`-32601`/refused 分类。**不返回 target URL、title、cookie 名值或页面文本**。`Network.getCookies` 只查一个无效域名；`Runtime.evaluate` 只算 `1+1`。
- `node src/cli.js cdp-probe [--host-id ID] [--tab-id N] [--out FILE]` 自动选一个可读 http(s) 标签，调用探针并将脱敏结果写到 `.local/cdp-probe-<stamp>.json`。多宿主时必须带 `--host-id`（本次 Chrome host 为 `h-0b47a521c4384e90beb4`）。

### 真机证据与结论

重载前（06:52Z，旧扩展 0.40.0）：`not_dispatched / no_debugger_session`，未 attach、无页面副作用。

0.41.0 重载后（07:04Z，同一 host / tab `663195610`）探针成功执行：

- `Target.getTargets` → **refused**，`-32000 Not allowed`（页级 debugger 会话不暴露浏览器级 `Target` 域）
- `Schema.getDomains` → **unsupported**，`-32601 "'Schema.getDomains' wasn't found"`
- `Page.getFrameTree`、`Runtime.evaluate("1+1")`、`Input.setIgnoreInputEvents(false)`、`Network.getCookies("https://example.invalid/")` → **accepted**
- 因 `Target.getTargets` 无结果：`gate1:"inconclusive"`、`targetDomain:"unknown"`、`browserLevelEndpoint:false`
- `chrome.debugger.getTargets()` 扩展 API 可用：32 targets（5 page / 17 worker / 10 other），attached 1

证据：`.local/cdp-probe-2026-11-15T07-04-13-603Z.json`（只含 scheme+host，无 title、cookie 名值或页面文本）。

⇒ **门槛 1–2 已执行，结论是「当前可用的页级 debugger 会话拿不到浏览器级 Target」**。这不证明 Chrome 不存在浏览器级 CDP，只证明路径 A 不能靠现状会话成立；继续推进需要独立网关 + 新端口 + 单独授权。

## 3. P0-2：Playwright 旁路门禁与本地 fixture

### 实现

- 新增 `poc/playwright-fallback/gate-check.mjs`。默认只做门禁判定，**不导入 Playwright**。
- 门 0 必须同时满足：
  1. 现场 `GET /status` 失败（任何 HTTP 应答都算桥可达，401 也算）；
  2. 证据文件符合 `ai-browser-bridge-unavailable-evidence-v1`，`service.reachable:false` 且至少一条失败尝试；
  3. 非空 `--authorization-scope`，且不得涉及 default profile / Chrome profile / cookies / login data / local state；
  4. 精确确认串 `playwright-temporary-profile-local-fixture`（文档明确标注为**调用方自证，不是独立人工认证**）。
- 全部门禁通过后，`--launch` 也只允许：`mkdtemp` 临时 profile + `127.0.0.1` 本地 fixture + 一个按钮点击；没有 URL / profile / 调试端口参数。证据写入 `.local/playwright-poc-*.json`，并声明 `defaultProfileTouched:false`、`doesNotProve:["默认登录态","CDP endpoint","桥能力"]`。

### 实测

0.41.0 复跑：

```json
{"allowed":false,"gate0":"not_met","reason":"bridge_reachable",
 "defaultProfileTouched":false,"playwrightStarted":false,
 "live":{"reachable":true,"httpStatus":401}}
```

桥可用 ⇒ **门 0 不成立**，没有启动 Playwright、没有创建 profile、没有连接任何浏览器。`test/playwright-gate.test.js` 6 项覆盖健康桥拒绝、状态未知、证据缺失/错误 schema/未显示不可用/无失败尝试、scope 与确认串、实时复探优先于证据文件。

## 4. 验证与运行时状态

- **全量回归 `npm test` 882/882 通过**（`node --test --test-concurrency=1 test/*.test.js`，exit 0，0 fail，约 131s）；`skills/csdn-publish/snippets/verify-success.mjs --self-test` **7/7**。
- 四处版本 0.40.0 → **0.41.0**；buildId `f0bf52f9…b94c` → **`6b29c09228f456a46924eef660ad69e18ab26ce18387aff3c54913c14b2a4e44`**。
- 服务经 allow-listed `build_restart` 重启；两个宿主分别用 `browser_reload_extension` + `confirmation:"reload_extension_once"` 重载，结果均 `verified:true`、`method:"chrome.runtime.reload"`、`expectedVersion:"0.41.0"`、`focusRequired:false`。
- 重载后 `status`：`version 0.41.0` / buildId 一致 / `extensionVersion 0.41.0`；两次 heartbeat `4cdd5cde-0153-42f0-aa98-1d066970f502` 与 `8655d4e9-aefc-4c23-bd51-effcb146680a` 均 `clean` + `provenClean:true`、`hostCount:2`、running/disk buildId 一致。
- `node src/cli.js doctor`：`ok:true`、`service-build-current:true`、`queued:0`。
- 两次重载均 `partial:true`：错误列表因 `no_chrome_window` 未清除（Chrome 与 ChatGPT 宿主都没有可见窗口）。**状态是「未知」，不写成「已清空」**，不重复 reload。

## 5. 边界（本轮明确未做）

- 未改 `browserTarget`、未启 GUI / 抢前台、未杀任何未验证进程。
- 未启动 Playwright / Puppeteer / Selenium / CDP 网关，未开调试端口，未创建或克隆浏览器 profile，未读取 `Cookies` / `Login Data` / `Local State` / `.tmp-cred.txt`。
- 未把扩展错误列表标记为已清理；`errorListCleared:false` 原样保留。
- P0-1 的父进程判活 / 空闲超时仍未做；需要单独决策与真实边界测试。

## 6. 交付与发布

- 版本：**0.41.0**（`package.json`、`extension/manifest.json`、`package-lock.json` 顶层与 `packages[""].version`）。
- 提交、push、tag `v0.41.0` 与 GitHub Release 见仓库发布页；本报告随该版本入库。
- 关联：`docs/AGENT-HANDOFF-20261115.md`（P0 原始计划，快照仍为 0.40.0，接手时按文内命令复核）。

## 7. 关联

- [AGENT-HANDOFF-20261115.md](AGENT-HANDOFF-20261115.md)（P0 原始计划）
- [PROCESS-LIFECYCLE.md](PROCESS-LIFECYCLE.md)（Adapter registry 节）
- [PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md](PROCESS-OWNERSHIP-AND-RUNTIME-DECISION.md) §1.4
- [CDP-GATEWAY-PLAN.md](CDP-GATEWAY-PLAN.md) §4.1
- [PLAYWRIGHT-FALLBACK-DECISION.md](PLAYWRIGHT-FALLBACK-DECISION.md) §4.1
- [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)
