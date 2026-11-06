# 开发规范与发布流程

> 记录踩过的坑和固定操作，避免重复犯错。

## 版本号同步规则（硬规则）

### 每次更新版本时，必须同时更新两处：

1. **`package.json`** → `"version"` 字段
2. **`extension/manifest.json`** → `"version"` 字段

**这两处必须保持一致，缺一不可。**

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
