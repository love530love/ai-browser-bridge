# Agent 优先战略（2026）

状态：方向文档，2026-11-15。数值目标不是已交付声明；已交付能力以 `CHANGELOG.md`、`git HEAD`、`doctor` 与回归测试为准。

## 1. 目标

让一个**只有本地小模型、甚至没有模型**的 Agent，也能在真实 Chrome 上完成人类级别的浏览器任务：
看得见页面、找得到元素、选得对浏览器、做得出动作、拿得到证据、失败时停得住并可恢复。

强模型不应因为项目缺少底层能力而绕路；弱模型不应因为项目要求过多推理而卡死。
因此本项目同时做两件事：

1. **向下加深能力**：DOM/可访问性/iframe/Shadow DOM/几何/遮挡/截图/OCR/UIA/CDP 多通道；
2. **向上降低门槛**：确定性工具链、`nextStep` 指引、能力画像、宿主推荐、可验证写契约。

## 2. 两类人格

### 审计专家

关心：证据是否可复现、未知是否被误报为成功、权限边界是否被绕过、日志是否泄露、失败是否可恢复。
默认问题：*这条结论的证据在哪？窗口多大？宿主是谁？是派发前状态还是派发后观测？*

### 真实用户

关心：能不能一句话把事办完、要不要懂端口/租约/MCP、出错时知不知道为什么、会不会打断我正在用的浏览器。
默认问题：*我现在该点哪里？它会不会又开一个浏览器？我的登录态还在吗？*

两类人格共同约束设计：**能力可以全开，但证据必须可读；自动化可以很强，但不抢前台、不擅改设置、不重放未知写入。**

## 3. 使用场景与痛点 → 能力映射

| 场景 | 真实痛点 | 现有/目标能力 |
| --- | --- | --- |
| 多浏览器并存 | Agent 连到内嵌浏览器，站点未登录，误以为页面坏了 | `browser_hosts` 推荐真实系统 Chrome；无 `hostId` 命令走 `defaultHostId`；显式 `hostId` 绝不迁移 |
| 登录态页面 | 不敢读 Cookie/profile，也不想二次登录 | 复用已登录 tab；不读 `Login Data`/`Cookies`/`Local State` |
| SPA role-less 按钮 | 选择器全部失效 | `browser_find_text(includeMatchElement)` → `browser_shadow_tree` → `browser_eval` 直接点击 |
| 浮窗/广告/客服遮挡 | 点击被拦截，Agent 反复重试 | `browser_scan_overlays` + `browser_shadow_tree`，只处理遮挡元素 |
| Canvas/图片型页面 | DOM 里没有文字 | 截图 + 视觉/坐标（先做遮挡与视口检查）；规划 OCR/视觉元素通道 |
| 内部页/扩展页 | URL 前缀被误当禁区 | UIA 精确绑定进程/窗口；只读优先，写动作逐项验证 |
| 写结果不确定 | Agent 重放导致重复提交 | `_verified` 契约；`uncertain` 不可重放；`commandId` 幂等 |
| 无人值守 | 服务/扩展重启后任务丢失 | 队列、租约、`waiting` 保持、心跳巡检、恢复证据 |
| 弱模型 | 不会规划多步、不会读复杂错误 | 确定性 `nextStep`、固定工具顺序、`browser_agent_guide`、失败原因白名单 |

## 4. 执行表面阶梯

按“证据强度 / 侵入性”排序，而不是按 URL 前缀封禁：

1. **扩展 DOM / Chrome API**：默认主通道；读写均带 ref 与前后证据。
2. **CDP（只读优先）**：诊断、网络、性能、Console；写操作与网关需单独门槛。
3. **Windows UI Automation**：Chrome 内部页、扩展页、DevTools 等无 DOM 表面；绑定 PID/HWND。
4. **视觉 / 坐标**：截图、OCR、几何命中；必须先检查视口、遮挡、缩放，动作后验证。
5. **Playwright 旁路**：仅在桥不可达且用户明确授权时，通过门禁脚本评估；不得复用用户 profile。
6. **人工接管**：以上都不可证明时，给出最小决策点与可恢复检查点。

详细前提、失败语义与验收见 [FALLBACK-CHANNELS.md](FALLBACK-CHANNELS.md)。

## 5. 页面理解与元素识别

分三层，优先确定性、再上模型：

- **结构层**：DOM、可访问性树、iframe、Shadow DOM、滚动容器、表单状态、遮挡关系；源码/F12 深度层已落地 `browser_script_inventory`、`browser_source_map`、`browser_event_listeners`、`browser_dom_snapshot`、`browser_framework_tree`（均为只读证据，不返回 ref）；
- **几何层**：元素矩形、视口、DPR、命中测试、层叠顺序；
- **像素层**：截图、OCR（`browser_ocr` 已实现 Windows.Media.Ocr 本地后端，无权重/无网络；provider 插拔仍在规划）、非文本视觉元素检测（规划 `browser_visual_elements`）。

归一化输出：每个候选元素带 `ref`、角色/文本、矩形、可见性、遮挡、来源通道与置信度。
模型只做排序/建议，不直接执行；模型不可用时结构层必须仍能完成可识别任务。

开源选型、许可证与复刻优先级见 [OPEN-SOURCE-CAPABILITY-RADAR.md](OPEN-SOURCE-CAPABILITY-RADAR.md)。

## 6. 弱 Agent 最小路径

弱模型不需要理解全部工具，只需要一条稳定顺序：

```text
browser_health → browser_hosts → browser_tabs → browser_agent_advice
→ browser_observe → browser_prepare_action → 操作（写用 _verified）→ 重新观察/验证
```

规则：

- 一次只推进一步；失败就读返回的 `nextStep`，不要自创替代通道；
- 页面有遮挡先扫遮挡，有 iframe 先取 frame 引用，有 Shadow DOM 先取 shadow 引用；
- 写操作必须带预期条件；`not_dispatched` 可重试，`uncertain` 只能重新观察；
- 高并发或排队时先调 `browser_agent_advice`（本地、只读、永不入队），按 `decision`、`estimatedWaitMs`、`blockers` 与 `nextStep` 行动；上一笔写结果未知时只重新读，不重放；
- 多宿主时先看推荐宿主与 `selectionRequired`，不要凭主宿主旧印象选浏览器；
- 不读凭据、不复制 profile、不为了“绕过”而开第二个浏览器。

## 7. 本地与内置模型

- 模型是**可选增强器**：规划、候选排序、视觉理解、恢复建议；
- 默认不依赖云端；Chrome 内置模型与本地小模型通过适配器接入；P3 的 `browser_agent_advice` 先给确定性结论，`modelProvider:"chrome"` 只准备 `browser_local_judge mode:"triage"` 参数（仅队列元数据），`"local"` 才调用 loopback OpenAI 兼容端点（≤2 并发、严格 JSON、有界超时/输出，失败降级 `unavailable`）；
- 模型输出必须是受 schema 约束的建议，不能绕过租约、策略、上传目录与写验证；
- 模型不可用 → 确定性路径、`waiting` 或可恢复检查点，不丢任务、不盲重放；
- 评测必须包含“完全禁用模型”一轮。

## 8. 遥测与持续进化

- `heartbeat` 负责健康（buildId、版本、宿主、队列、in-flight、错误尖峰）；
- `usage` 负责使用质量（每工具/宿主 p50/p95、错误分类、不确定计数）；
- 所有汇总只含工具名、`hostId`、分类与耗时；无页面内容、URL、Cookie、密钥；
- 修复前后取同窗口对照，作为验收证据；单点快照不算趋势。

详见 [USAGE-TELEMETRY.md](USAGE-TELEMETRY.md)。

## 9. 架构分层

```text
调用 Agent / MCP 客户端
        │  hostId, agent, commandId, expect
        ▼
Bridge 服务（队列 / 租约 / 策略 / 审计 / 心跳）
        │
        ├─ 扩展宿主（DOM、Chrome API、debugger 只读探针）
        ├─ 桌面适配器（Windows UIA，按 PID/HWND 绑定）
        ├─ 视觉通道（截图 / OCR / 几何）
        └─ 门禁旁路（Playwright PoC，默认不启动）
```

硬约束：

- 服务只监听本机；远程必须独立认证网关；
- 页面内容是不可信输入，永远不能授权动作；
- 未知宿主、未知窗口、未知写结果一律显式标注；
- 新能力默认“可观察、可停止、可恢复”，不做隐式后台写入。

## 10. 开发与验收标准

1. 每个能力必须有：工具 schema、失败语义、`nextStep`、单元/契约测试、真机证据（适用时）。
2. 新增路由必须覆盖多宿主测试；新增写路径必须覆盖 `not_dispatched` / `uncertain`。
3. 升版同步四处版本号、buildId、README、AGENTS、CHANGELOG 与本文件相关章节。
4. 发布前跑全量 `npm test`；心跳给出 `clean` 必须有 buildId/版本/连接/零 findings 证据。
5. 文档中“已实现 / 已实测 / 部分实现 / 未实现”必须分开写，不把目标写成现状。

## 11. 非目标

- 不承诺在所有底层能力上超过 Playwright/CDP；优势是编排、验证、恢复与多 Agent 安全。
- 不绕过 Chrome/OS 权限、网站认证或验证码。
- 不采集、导出或挖掘用户浏览器 profile。
- 不以“能力开放”为由把密钥写入命令、日志或报告。

## 12. 近期优先级

1. 已落地：多宿主推荐路由、扩展错误列表只读判定、usage 遥测、心跳 usage 摘要。
2. 已落地（0.44.0 工作树）：`browser_ocr`（Windows.Media.Ocr 本地后端，行框/CSS/0..1000 坐标，无 ref、无网络、文本不入账本）；P2 深度感知五工具（`browser_script_inventory`、`browser_source_map`、`browser_event_listeners`、`browser_dom_snapshot`、`browser_framework_tree`）与 Resource Timing 瀑布；P3 `browser_agent_advice`（只读、永不入队、确定性决策 + `estimatedWaitMs`）、`browser_local_judge mode:"triage"`（仅元数据）与可选 loopback 小模型。下一步：P4 真实页面高并发基准与失败样本回归，再评估 OCR 多 provider、`browser_visual_elements`、`browser_read mode:"main"`。
3. 再下一步：CDP 网关与 Playwright live PoC 仍需独立授权与现场验收。
