# 开发规范与发布流程

> 记录踩过的坑和固定操作，避免重复犯错。

## 版本号同步规则（硬规则）

### 每次更新版本时，必须同时更新四处：

1. **`package.json`** → `"version"` 字段
2. **`extension/manifest.json`** → `"version"` 字段
3. **`package-lock.json` 顶层** → `"version"` 字段
4. **`package-lock.json` 的 `packages[""]`** → `"version"` 字段

**这四处必须保持一致，缺一不可。** `src/version.js` 只从 `package.json` 读，所以漏改 lock 不会立刻报错，但 `doctor` 与发布对账会留下版本漂移；0.35.1 就因为 lock 停在 0.32.0 被记进 CHANGELOG。

#### 踩过的坑
- **0.32.1 遗漏**：只更新了 `package.json`，遗漏 `extension/manifest.json`，导致扩展端仍然显示 0.32.0。
- 扩展端版本号来自 `manifest.json`，不是 `package.json`。
- 服务版本号来自 `package.json`。

#### 验证方法
```bash
# 检查 package.json 版本
node -e "const pkg=JSON.parse(require('fs').readFileSync('package.json','utf8'));console.log('Package:',pkg.version)"

# 检查 manifest.json 版本
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8'));console.log('Extension:',m.version)"
```

**两处输出必须一致。**

## 维护操作的目标绑定（0.35.1 血泪教训）

凡是「通过桌面 UI Automation 操作某个浏览器页面」的维护动作（典型：`clear-extension-errors.ps1`），必须遵守：

1. **先证明目标页面身份，再读内容。** 地址栏以 `chrome://extensions` 开头是硬前提，且验证必须**无条件**执行，不能放在「页面没有 Document 节点」的分支里。普通网页也有 Document，那里跳过验证就会在 CSDN 页面上找 `Clear all`，找不到就误报「列表为空」。
2. **不要按「唯一可见窗口」猜目标。** 系统里可能同时有系统 Chrome、Codex/ChatGPT 内置浏览器、Canary，各自独立的扩展与错误列表。`Get-Process chrome` 枚举到的窗口**可能属于另一个浏览器实例**。用扩展 WebSocket 的 (客户端端口, 服务端口) 对反查持有进程 PID，`/status` 的 `extensionOwner` 就是这么来的；再把这个 pid 作为 `processId` 传给清错脚本，脚本按 PID 枚举该进程的窗口。**不要因为宿主不是 chrome.exe 就一律拒绝**：那会让它的错误列表永远清不掉；也不要靠反复重启服务去赌系统 Chrome 抢到连接（实测两次重启占用者稳定是 ChatGPT）。宿主确实没有可见窗口时，返回 `hostBinding` 指明进程，别用「Bring a Chrome window up」把人引到另一个浏览器。
3. **「没找到按钮」不等于「列表为空」。** 结论必须携带原始证据：`addressVerified`、`documentVisible`、`address`、`targetResolution`、`observedButtonNames`。`nothing_to_clear` 只有在地址栏已验证 + 文档可读时才算 clean。
4. **新增证据字段要同时加进投影白名单**（`src/extension-errors.js` 的 `describeErrorList`）。读侧过滤 + 写侧白名单会同时挡掉同一条路径，字段丢了调用方就无法复核。
5. **UI 控件名要考虑本地化**：同一文件里 Reload 有 `重新加载` 别名而 `Clear all` 没有，是造成误判的直接原因之一。

### 本机环境事实

- `tasklist.exe` 单 PID 查询实测 **15 秒硬超时**不可用；查进程名用 `Get-Process -Id <pid>`（秒级）。
- PowerShell 参数/局部变量**永不叫 `$pid` / `$Pid`**（保留变量，赋值直接报 ParserError）。
- Windows 保留设备名文件（如 `nul`）删不掉：常规 `rm` / 回收站 API 报 `0x800704B0`。本轮实测 `[System.IO.File]::Delete('\\?\<绝对路径>')` → Access denied；`Remove-Item` 报成功但文件仍在（**假成功**）；Node `fs.unlinkSync('\\?\...')` 被 safe-delete shim 转成 trash 后同样失败，关掉 shim 则是 `EPERM`；`Add-Type` 编译 P/Invoke 被沙箱拦截。**本机唯一可行解是加进 `.gitignore`**，不要重复尝试删除，也不要把「报 ok」当删除成功。
- `chrome://` 页面的 Document 子树只对**同一进程内**的 UIA 客户端可见；跨进程 `browser_native_snapshot` 读不到是预期行为，不是「页面不存在」。所以 reload + read + click 必须在**一个 PowerShell 进程**里完成。

## 项目审计（0.37.1 血泪教训）

1. **凡「只在异常轮生成」的产物，必须有一条断言检查渲染后文本**，不能只检查内存对象。0.35.1 事故报告与 0.37.0 incident 报告两次栽在同一处：模板读 `result.verdict`、调用没传，报告恒 `**undefined**`，而 CLI / jsonl / evidence 全对、730 条全绿。
2. **凡新增模块，必须有一条测试走真实边界**（HTTP URL / header / body、CLI 参数、文件落盘），不能只测注入桩的纯函数。`test/scheduler-runtime.test.js` 是正面范例。
3. **去抖状态机要检查「失败轮会不会清空证据」**：采集超时什么都没观测到，不构成反证；否则一次 8 秒超时就能让临界告警永不升级。
4. **常驻 watch 的首轮不能与历史 cadence 比较**：state 可能来自数小时前的 hourly 单次巡检，按 10 秒间隔判定必报 `clock_drift` 并冻结全部自愈。单次巡检与常驻 watch 必须分别处理时序假设。
5. **修复动作绝不能回落到 primary 兼容镜像**：`hostId: null` 会把命令打到另一个浏览器。候选为空就**不动作**，从 finding 的 evidence 显式取目标。
6. **锁文件时间戳不可解析时必须可接管**，否则一次「openSync 之后、write 之前」的崩溃会让监控永久 `skipped`。
7. **文档里的「两处 / 不支持 / 正确答案是 X」要与代码逐字对账**：内部工具名写错不抛错、静默落到默认分；过时的 Canary/Default 与「可换 Playwright」会直接把 Agent 引到错路；版本同步漏改 lock 不会立刻报错。
8. **审计结论要区分现症与已闭环**：recheck 报 `uncertain` 不是修复，下一轮 `clean` 才是；心跳 jsonl 按 UTC 命名、工作日志按本地 GMT+8，相差 8 小时，只按「当天」找会漏掉凌晨故障。
9. **能力存在但没接进真实调用路径 = 能力不存在**：调度器 `routeTask` 至今只在模块级测试里被调用，文档必须写明「尚未接入 `/call`」，不能让读者以为跨实例自动路由已生效。

## 心跳巡检（0.37.0 硬规则）

1. **clean 必须有证据**：`status.buildId === computeBuildIdentity(ROOT)`、版本一致、`connected`、schema 完整、零 findings，缺一即 `uncertain`。「没发现问题」不是「健康」。
2. **单样本不是结论**：所有 finding 连续 3 轮才从 warn 升 critical；宿主增减按 `hostId` 做前后双快照对比，不能读 primary 兼容镜像。丢失的宿主必须记进 `missingHostIds`，否则第二轮的空快照会让去抖永远凑不满（本轮实测踩过）。
3. **时钟/采集间隔跳变的那一轮冻结所有 critical 升级**：去抖窗口本身失效时，任何升级都不可信。
4. **自动排障白名单只有两项**：`build_restart`（buildId 不一致 → 杀 `.local/server.pid` 交看门狗，**不用 `stop.ps1`**）与 `extension_reload`（buildId 一致但扩展落后 → 按 `hostId` 逐个）。服务不可达、宿主丢失、卡住的 in-flight、租约沉淀、错误率尖峰、无窗口清错一律只报告——因为重启会截断在途写、启动 GUI 越权、清错 unknown 不能当成功。
5. **动作前置缺一不可**：无 in-flight、无排队、无 taskLease / desktopOperation / maintenance、无 tabLeases、connected；外加冷却 3 周期、actionId 幂等、单实例锁、动作后 recheck。restart 是异步的，下一轮才确认，绝不在本轮写「已修复」。
6. **心跳自身 fail-closed**：采集超时、payload 非法（例如 auth 错误页被当成 status）、状态文件损坏、磁盘满、双实例、连续失败 ≥3 时冻结外部排障并输出 `uncertain`。watch 模式的 interval timer **不能 `unref()`**，否则事件循环排空、守护在第一轮后静默退出（本轮实测踩过）。
7. **只读元数据**：审计日志只取 `time / outcome / tool / errorCategory`，不读页面内容、不碰凭据；doctor 的 profile 扫描与 launch dry-run 不要重复实现。
8. **非零退出码是契约**：`critical / uncertain / skipped` 必须让调度器看见，不能因为「没崩」就返回 0。

## 多宿主并发（0.36.0 血泪教训）

1. **「第二个连接被 4003 拒绝」不是限流，是所有权 bug**。多个装了扩展的浏览器（系统 Chrome / Canary / Agent 内置浏览器）应该是**对等宿主**，谁先连上都不该决定哪些 agent 能工作。多实例架构只是把「一个独占」复制成「多个独占」，不解决归属。
2. **单 `current` = 一个宿主卡住、全体 agent 陪等**。`inFlight: Map<hostId, job>` 才能保证每宿主一个 in-flight 槽位。保留 `current` 作兼容镜像时，必须在 `finish()` 里重算为「任一活跃 job」；只在 `current === job` 时清空会让多宿主下留下永久 busy 的悬空指针。
3. **tab id 只在单个浏览器进程内唯一**。两个浏览器的 tab 7 会共用裸 `tabId` 租约键 ⇒ 作用域键必须能带 `hostId`。但默认路径（未显式传 hostId）要保持裸键，否则单宿主旧契约和 29 条旧测试会全崩。
4. **close handler 不要传 `keepQueued`**。本轮第一版在连接关闭时误带 `keepQueued:true`，单宿主队列要等 30 秒宽限期才失败，测试直接挂死。`keepQueued` 只属于「写超时、宿主可能重连」；多宿主的排队任务保留由 `dropHostOnly` 自己的 hostGrace 负责。
5. **队列上限要按宿主数伸缩**。写死 64 会让「queue_full」旧断言挂住；写死 16 会让 3 个浏览器共享一个马桶。`max(16, 16 × 宿主数)` 同时满足两者。
6. **结果归属必须 `(hostId, command id)` 双匹配**。只按 `msg.id === current.id` 收包，跨宿主迟到/伪造的 result 会结算别人的任务。服务端按 `ws → hostId → inFlight.get(hostId)` 取任务，扩展端带不带 hostId 都能归属。
7. **新增全局参数要同时改三处**：`schema()` 注入、`validateCall` 做格式校验（hostId 含 `:` 会伪造作用域）、**所有精确参数列表断言**（本轮 `test/field-report-030.test.js` 因硬列 `browser_eval` 参数而挂）。参数由服务消费、绝不转发给页面。
8. **意图索引有 3500 字节硬上限**。新增 `fleet` 分组后变成 3512 字节，缩短 `purpose` 文案即可，不要去改断言阈值（那个阈值是给调用方省 token 用的）。
9. **连接上限 8 → 64**：`clients.size` 的旧上限是「一个服务一个浏览器」假设的残留，真正的访问控制是 pairing token + Origin 校验。
10. **不设能力禁区**：版本错配、宿主不是 chrome.exe、某能力探测为 false，都只能作为 hints / warnings 报告，不得据此拒绝连接或工具。显式指定宿主掉线时返回 `waiting` + `browser_hosts`，绝不静默改派。
11. **迁移连接层后必须逐个审全局单值镜像的读取点**（`extension` / `extensionVersion` / `extensionSessionId` / `current` / `extensionOwner`）。0.36.0 真机：`waitForReload` 用全局 `extensionSessionId` 判重载，目标宿主断开后 primary 被同伴顶替，同伴的**旧** session 被当成新 session，于是把一次实际成功的重载误报成 `extension_reload_not_observed`。「看起来像状态变化、其实是别人」是这类缺陷的固定形态。修法是快照全部 sessionId + 按新会话与新版本判定，而不是删掉镜像。
12. **`extensionOwner.pid` 不一定是拥有可见窗口的进程**。实测服务绑定 pid 15944 时 `no_chrome_window`，而不绑定 PID 枚举到 pid 14900 的 `chrome://extensions` 窗口（地址栏验证通过）。清错失败要区分「宿主无窗口」与「绑定进程不是窗口进程」，两者都返回证据，绝不写成已清空。

## 调度器运行时回归（0.35.1 血泪教训）

`browser_queue_status` 全绿**不等于调度器能用**：服务实际只调用 `assessAndSchedule` 与 `cleanupTimeouts`，
`enqueue` / `detectConflicts` / `routeTask` 从来没被走到过。新增模块必须打到真实调用路径：

1. **类方法与模块级函数别混用**：`AIScheduler` 没有 `detectConflicts` 方法，实例调用必抛 `TypeError`。
2. **不要在 `find()` 的结果上继续调数组方法**：`queue.reverse().find(...).reverse()` 对对象取 `.reverse()` 必抛，
   且 `reverse()` 原地反转会打乱优先级顺序。
3. **早退路径要检查副作用是否完成**：抢占成功后直接 return，把「触发抢占的高优先级任务」静默丢了。
4. **建议 ≠ 可调度命令**：任务分解产物绝不能进可执行队列，否则凭空多出浏览器写操作、同一命令被排两次。
5. **HTTP 契约逐字对齐**：`/status` 与 `/call` 都强制 `Bearer <agentToken>`；`browser_queue_status` 是**工具名不是路由**；
   端口从实例注册表取，不要 `instanceId.port`；401 是「服务在监听」，不是「实例死了」。
6. **存活判据别只信记账文件**：默认实例由看门狗用 `.local/server.pid` 启动，没有 `.local/pids/default.pid`。以端口探测为准。
7. **测试要打到边界**：用临时 `AIB_STATE_DIR` + stub `globalThis.fetch` 断言真实 URL / header / body，
   而不是自己构造一个「看起来对」的结果对象。范例：`test/scheduler-runtime.test.js`。

## 发布流程（固定动作）

### 1. 代码提交

```bash
# 暂存所有修改
git add .

# 提交（包含详细的修改说明）
git commit -m "type: description

- 具体修改 1
- 具体修改 2
- 验证方法/结果"

# 推送远程
git push sshpush main
```

### 2. 版本号更新

根据修改类型选择版本号：

| 修改类型 | 版本递增 | 示例 |
|---|---|---|
| **Bug fix** | patch (0.x.y → 0.x.y+1) | 0.32.0 → 0.32.1 |
| **新功能** | minor (0.x.y → 0.x+1.0) | 0.32.0 → 0.33.0 |
| **重大重构** | major (0.x.y → x+1.0.0) | 0.32.0 → 1.0.0 |

#### 更新步骤

```bash
# 1. 更新 package.json
# 编辑 package.json 中的 "version" 字段

# 2. 更新 extension/manifest.json
# 编辑 extension/manifest.json 中的 "version" 字段

# 3. 提交版本更新
git add package.json extension/manifest.json
git commit -m "bump: version X.Y.Z → X.Y+1 for <description>"

# 4. 推送远程
git push sshpush main
```

### 3. 创建 GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z: <short description>" \
  --notes "## Changes

- **Fix**: <bug fix 描述>
- **Feat**: <新功能描述>
- **Doc**: <文档更新描述>

## Verification

<验证方法/结果>"
```

#### Release 内容要求

- **必须包含**：修改文件列表、修改内容摘要、验证结果
- **Bug fix**：必须说明修复前/后的对比数据（如测试页面元素数量对比）
- **新功能**：必须说明新增工具/能力列表

### 4. 扩展重新加载

```bash
# 重新加载扩展以应用新版本
node src/cli.js call browser_reload_extension '{"confirmation":"reload_extension_once"}'

# 验证扩展状态
node src/cli.js status
```

**必须确认 `extensionVersion` 已更新到新版本。**

## 版本一致性检查清单

每次发布前，逐项检查：

- [ ] `package.json` 版本号已更新
- [ ] `extension/manifest.json` 版本号已更新
- [ ] 两处版本号完全一致
- [ ] 所有修改已提交（`git status` 无 uncommitted 文件）
- [ ] 版本更新已提交并推送远程
- [ ] GitHub Release 已创建
- [ ] 扩展已重新加载
- [ ] 扩展版本号已验证为最新版本
- [ ] 扩展错误列表已清除（无报错）

## Git 操作规范

### 提交规范

采用 **Conventional Commits** 格式：

```
type: description

- 具体修改 1
- 具体修改 2
- 验证方法/结果
```

#### Type 说明

| Type | 说明 | 示例 |
|---|---|---|
| **fix** | Bug 修复 | `fix: enhance role-less clickable element detection` |
| **feat** | 新功能 | `feat: add verified write contract` |
| **bump** | 版本号更新 | `bump: version 0.32.0 → 0.32.1` |
| **docs** | 文档更新 | `docs: update AGENTS.md with role-less guidance` |
| **refactor** | 代码重构 | `refactor: restructure browser_read paths` |
| **test** | 测试相关 | `test: add role-less element detection test` |

#### 推送规范

- **一律使用 `git push sshpush main`**（已配置的 SSH push 别名）
- **不要使用 https 推送**（会卡凭据弹窗）
- 推送前确认 `git status` 无未暂存的重要文件

## 扩展开发规范

### 新工具添加（必须修改三处）

新增工具时，必须同时修改以下三处：

1. **`src/tools.js`** — 工具定义和实现
2. **`extension/worker.js`** — 工具分发白名单
3. **`src/tool-index.js`** — 工具索引

**遗漏任何一处都会导致工具不可用。**

### 新工具验证

```bash
# 1. 语法检查
node --check src/tools.js
node --check extension/worker.js
node --check src/tool-index.js

# 2. 重新加载扩展
node src/cli.js call browser_reload_extension '{"confirmation":"reload_extension_once"}'

# 3. 验证工具可用
node src/cli.js call <tool_name> '{"param": "value"}'
```

### 扩展重载验证

重载后必须验证：

```bash
# 检查扩展版本号
node src/cli.js status | grep extensionVersion

# 检查扩展错误列表
node src/cli.js call browser_extension_errors '{"action":"open"}'
```

## 测试验证规范

### 功能验证

- **必须使用真实页面测试**，不能仅依赖单元测试
- **测试页面应覆盖边界情况**（如 role-less 元素、SPA 页面、Shadow DOM）
- **验证前后对比数据**（如元素数量、返回字段）

### 回归测试

```bash
# 全量测试
npm test

# 扩展相关测试
npm run test:e2e

# 性能测试
npm run test:bench
```

**所有测试必须通过才能提交。**

## 常见陷阱

### 1. cheap 模式绕过逻辑

- **问题**：`browser_read` 的 `mode: 'cheap'` 模式可能绕过某些扫描逻辑
- **原因**：`cheapRead()` 函数直接 return，没有执行完整的二次扫描
- **修复**：在 `cheapRead()` 中也添加缺失的扫描逻辑
- **预防**：修改读取逻辑时，必须同时检查 `cheap` 和完整路径

### 2. 扩展缓存

- **问题**：修改扩展代码后，浏览器仍然运行旧代码
- **原因**：Chrome 缓存了扩展的旧版本
- **修复**：必须调用 `browser_reload_extension` 重新加载
- **预防**：每次修改 `extension/*` 文件后，立即重新加载扩展并验证

### 3. 服务缓存

- **问题**：修改 `src/*` 文件后，服务仍然运行旧代码
- **原因**：Node.js 缓存了模块
- **修复**：必须重启服务（`stop.ps1` → 启动服务）
- **预防**：修改 `src/*` 文件后，重启服务并验证

### 4. PATH 抢占

- **问题**：`timeout`、`find`、`sort` 等命令可能被 Git/MSYS2 抢占
- **原因**：Git 的 `usr\bin` 在 PATH 中排在 Windows System32 之前
- **修复**：Windows 命令用 `ping -n 4 127.0.0.1 >nul` 等待，PowerShell 用 `Start-Sleep`
- **预防**：写脚本时不要假定同名工具是 Windows 版

## AI 辅助发现能力（方案 A：扩展 browser_local_judge）

### 核心架构

```
┌─────────────────────────────────────────────────────────────┐
│                    发现阶段增强架构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Layer 1: 确定性规则引擎 (nextStep)                         │
│  └─ 命中 → 直接返回可执行下一步 (0ms AI 开销)               │
│                                                             │
│  Layer 2: AI 辅助发现 (browser_local_judge mode="discovery")│
│  └─ 确定性规则未命中 → Agent 自动降级到本地模型              │
│     ├─ 输入：DOM 快照 + Agent 意图 + 失败上下文             │
│     ├─ 输出：①页面语义解析 ②推荐工具链 ③操作教学            │
│     └─ 模型不可用 → 回退到 Layer 1 的通用建议                │
│                                                             │
│  Layer 3: 写操作风险裁决 (browser_local_judge mode="risk")  │
│  └─ 写操作前 → AI 风险评估 (allow/warn/block)              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 改动清单

1. **`src/tools.js`** — 扩展 `browser_local_judge` schema：
   - 新增 `mode` 参数：`['risk', 'discovery']`
   - 新增 `attemptedTools`, `failureReasons`, `context` 参数
   - `risk` 模式（默认）：保持向后兼容，评估写操作风险
   - `discovery` 模式：分析页面结构，推荐工具链

2. **`extension/worker.js`** — 扩展 `localJudge` 函数：
   - 支持 `mode: 'discovery'` 分支
   - systemPrompt 改为"发现引导器"，输出结构化 JSON
   - 返回字段：`pageType`, `structureAnalysis`, `recommendedTools`, `nextStep`, `confidence`

3. **`src/next-step.js`** — 扩展规则引擎：
   - 当所有确定性规则未命中时，返回 `aiAssisted: true` 的 nextStep
   - 包含 `suggestedArgs` 引导 Agent 调用 `browser_local_judge({mode:"discovery", ...})`

### 使用流程

Agent 收到 `nextStep.aiAssisted === true` 时，应自动执行：

```javascript
// Agent 收到 nextStep 标记
const step = result.nextStep;
if (step?.aiAssisted) {
  // 调用 AI 辅助发现
  const guide = await browser_local_judge({
    mode: 'discovery',
    goal: '<用户目标>',
    observation: '<最新页面读取结果>',
    attemptedTools: ['browser_find_element', 'browser_find_text'],
    failureReasons: ['found: false', 'ambiguous: true'],
    context: 'React SPA 页面，大量 cursor:pointer 容器'
  });
  // 根据 guide 推荐的工具链重试
}
```

### AI 辅助发现输出示例

```json
{
  "mode": "discovery",
  "verdict": "guide",
  "pageType": "React SPA",
  "structureAnalysis": "页面包含 13 个元素，其中 6 个为 role-less cursor:pointer 容器（React onClick），常规 find_element 无法识别。目标按钮为文本'提交订单'，位于外层 div.container 内。",
  "recommendedTools": [
    "browser_find_text({includeMatchElement:true})",
    "browser_read({mode:'cheap'})",
    "browser_observe({sections:['read']})"
  ],
  "nextStep": "使用 browser_find_text({query:'提交订单', includeMatchElement:true}) 搜索纯文本 onClick 元素。如果仍然找不到，调用 browser_read({mode:'cheap'}) 获取完整元素列表，然后从 textContent 中定位目标。",
  "confidence": "high",
  "status": "success"
}
```

### 安全性边界

- AI 模型仅作为**可选增强器**，绝不影响离线可用性
- 模型不可用时，系统仍然完全可用（现有 `optionalEnhancers` 机制）
- AI 输出是**指导性建议**，不是执行指令——Agent 仍需要判断是否执行
- AI 辅助发现**不替代**确定性规则引擎，仅在规则引擎无法提供明确下一步时介入

## 版本历史

| 版本 | 日期 | 说明 | 提交 |
|---|---|---|---|
| 0.32.1 | 2026-11-04 | role-less 可点元素检测修复 | a59271d, 9fbd8ae |
| 0.32.0 | 2026-11-04 | 下载工具路由修复 | 3db6868 |
| 0.33.0 | 2026-11-04 | Agent 失败 containment | 1fefe5c |
| 0.34.0 | 2026-11-04 | Verified Write Contract | f8323e1 |
| 0.35.0 | 2026-11-04 | AI 辅助发现能力（方案 A）+ bugfix | 4965813 |

## 与既有文档的关系

- **`UPGRADE-OPERATIONS.md`**：升级运行与验收流程，覆盖升级脚本、维护锁、扩展重载
- **`CAPABILITY-GAP-ANALYSIS-*.md`**：能力差距分析报告，记录具体场景中的问题
- **`AGENT-QUICKSTART.md`**：Agent 快速入门，包含操作指引和契约
- **`AGENTS.md`**：Agent 操作规范，包含工具使用指南和兜底策略

本文件补充上述文档的**开发侧规范**，特别是版本号同步、发布流程、Git 操作等运维固定动作。
