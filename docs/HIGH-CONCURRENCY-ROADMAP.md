# 高并发 / 多兼容浏览器操纵基座 — 开发计划与极端场景库

> 立项 2026-11-06，基线 `0.35.1`，首个交付 `0.36.0`。
> 来源：五个并行审计视角（多宿主拓扑、故障与时滞、跨版本兼容、AI 时代前瞻、连接层代码勘察）。
> 本文是**需求池 + 排期**，不是已完成清单。刻意收录看似天马行空的条目并标注现实性等级：
> 收录 ≠ 承诺实现，但不允许因为"现在不切实际"而删掉——AI 时代的能力边界移动得比排期快。

## 0. 不可协商的产品不变量

用户定义的方向优先于任何工程便利性：

1. **不设能力禁区**。安全性由 agent 判断，项目只提升能力、强化兜底，最多给出高危风险提示，并让 agent 诚实地返回给用户。任何工具都不得返回 `denied_by_policy` 式的"我替你判断这不安全"。
2. **任何一方都不被阻止或抢占**。系统 Chrome、Canary/Dev/Beta、Codex/ChatGPT 等 Agent 内置浏览器、不同版本扩展，可以同时在线、各自完成任务。
3. **项目层仍必须提供兜底**（这不是禁区，是精确性）：精确目标绑定、未知结果不重放、恰好一次、结果归属、可审计、状态诚实。冲突只返回**证据**（双方 commandId、epoch、DOM 摘要），由 agent 裁决。
4. **宁可返回 `UNKNOWN`，不可猜测成功**；宁可 `waiting` 给可执行下一步，不可静默把任务改派到另一个浏览器。
5. **能力 hints 不是拒绝理由**。`features` / `hostKind` / `uiAutomationLikely` 只帮助 agent 选路，永不作为门控。

## 1. 根因（0.35.x 实测，非推测）

`src/server.js` 里 `if (extension) ws.close(4003, 'Another Chrome profile is already connected')` 把「先连上的浏览器赢」写成协议；`current` / `queue` / `extensionVersion` / `extensionId` / `extensionBrowser` 全是单值；`leases.js` 的键是裸 `tabId`，而 Chrome tab id 只在单个浏览器进程内唯一。0.35.0 的多实例架构只是把「一个独占」复制成「多个独占」，没有解决连接归属。

结果：谁先连上，谁决定哪些 agent 能工作；一个浏览器卡 20 秒，所有 agent 一起等；两个浏览器的 tab 7 共用一把锁；内置浏览器无可见窗口时 UIA 清错不可达却仍被当成"已清理"。

## 2. 分期排期

| 期 | 版本 | 目标 | 关键交付 | 出口条件 |
|---|---|---|---|---|
| **P0 已交付** | 0.36.0 | 多宿主并发基座 | `src/host-registry.js`（握手/能力 hints/作用域键/公平派发/幂等账本）；去掉 4003；每宿主独立 in-flight；按 `hostId` 路由与结果归属；租约按 `hostId:tabId` 隔离；`browser_hosts` 工具；扩展端持久 hostId | 3 宿主并发连接无拒绝；3 个命令同时派发；跨宿主伪造 result 不结算他人任务；单宿主 29/29 旧测试不变 |
| **P1** | 0.37 | 故障自愈与终态完备 | 持久化结果账本、epoch/fencing 栅栏、半开心跳探测、按宿主 watchdog、子进程超时兜底、孤儿租约回收、磁盘原子写 + 只读降级、backlog 背压 | S1 终态完备率 ≥99.99%，S2 写操作恰好一次 =100%，S4 自愈 p99 <30s |
| **P2** | 0.38 | 跨版本 / 跨宿主兼容 | 握手 v3（能力矩阵、toolSchemaHash、renegotiate 广播）、按 `chromeVersion` 区间的能力索引、声明与实测分离（verifiedBy + TTL）、Host Adapter SPI、doctor 多实例矩阵、WebMCP 命名空间仲裁 | 0.33/0.36/0.40 三扩展同连吞吐=三者之和；注入失败能力后自动降级且握手 P99 不随探测项数增长 |
| **P3** | 0.39 | 并发正确性与公平 | docEpoch 栅栏、读写 revision、按 agent 配额 + aging 阻尼、Jain 公平指数、跨实例 `T→H` 亲和路由、精确目标指纹（windowId + frameId + 元素）、语义级锁接口 | 1000 read + 1 navigate 时 navigate 有上界等待；30 分钟高压零饿死；切窗后坐标点击零副作用 |
| **P4** | 0.40+ | 统一能力面与意图账本 | 全量 `ActionLog` + 可哈希状态摘要（回放/时间旅行）、`IntentLedger` 交接、`Capability{inputSchema, outputSchema, source}` 统一注册、WebMCP `getTools()` 发现与输出软校验 | 任意 seq 回放 digest 一致；同意图 DOM/WebMCP 两路径副作用等价；模型输出不符 schema 时返回明确 validation error |
| **P5 前瞻** | 未排期 | 军团 / 联邦 / 自生成能力 | FleetRegistry、Arbiter 多模型仲裁、影子页预演、页面分叉合并、跨机联邦 + HLC、ToolForge、Meter 计量、Prompt API 本地裁决、异常 Agent 隔离 | 见 §5 L3 各条验收 |

### 依赖顺序（先有什么才能有什么）

`ActionLog + 状态摘要` → `IntentLedger / 语义锁` → `仲裁 / 本地裁决` → `统一 Capability schema` → `自生成工具 / 计量` → `单实例语义锁与分叉` → `联邦 / 军团` → `模型驱动调度 / 预测预取 / 隔离与公平收敛`。

## 3. 极端场景库

现实性等级：**L1** 现在就该做 / **L2** 一年内 / **L3** 前瞻构想。
`H`=hostId，`T`=tabId。

### 3.1 多宿主拓扑与并发正确性（S）

| 编号 | 触发 | 当前会怎么失败 | 能力需求 | 可验证验收 | 级 |
|---|---|---|---|---|---|
| S01 | N 宿主同连 19387 | 单 `extension` 变量，第二个被 4003 关闭；`clients>=8` 再挡一层 | 对等 `Map<H,ws>` + 每宿主 sessionId | 3 宿主并发 hello → `hosts.length===3` 且 0 次 4003 | L2 → **P0 已做** |
| S02 | 两 Agent 同 tab 同元素都未 claim | 无租约即放行，两次 click 都派发 → 双提交 | 写前隐式租约 + 冲突证据 | 2 click 同 ref → `dispatch===1` | L1 |
| S03 | A 导航、B 点击同页 | 优先级 nav=80 排在 write=60 后，B 打旧 DOM | docEpoch 校验 + 命令 barrier | 携旧 epoch 的 click 被拒且零副作用 | L2 |
| S04 | 两个浏览器的 `T7` 撞号 | 租约键 `String(T)` 无宿主维 | `H:T` 作用域键 + 目标指纹 | A claim 后 B 写 `B:7` 不冲突 | L2 → **P0 已做** |
| S05 | 租约跨实例失效 | 各实例独立 `tab-leases.json` 互不可见 | 租约服务化 + 原子 claim | 实例1持 `A:7` 时实例2 claim → `waiting` | L2 |
| S06 | 宿主断线，在途任务归属不清 | `drop()` 一刀切清全局 `current`/`queue` | job 带 H + 按宿主回收 + uncertain 挂起 | A 断线 → B 的 3 个 queued 全 `ok`，A 的全 `uncertain` 且带 `hostId` | L2 → **P0 部分** |
| S07 | 写后读返回写前 DOM | 读快照无版本号 | 读附 revision、写递增 epoch | `fill` 后 `read.revision > 写前` | L2 |
| S08 | 两 Agent 改同一账号同一字段 | 服务端状态共享、跨宿主写无会话锁 | sessionKey 级冲突证据（只告知不拒绝） | 双方 commandId 都返回且 `committed===2` | L2 |
| S09 | 低优任务被廉价读淹没 | read=10 恒插队且无 aging | aging + 按 agent 配额轮转 | 1000 read + 1 navigate → navigate 在 `maxWaitMs` 内执行 | L1 |
| S10 | 队列混着不同宿主命令 | 单 `queue`+单 `current`，慢宿主阻塞全体 | 每宿主独立 `currentMap[H]` | A 卡 20s 时 B 的读 <1s 返回 | L2 → **P0 已做** |
| S11 | 一个 Agent 灌 500 任务 | `queue>=16` 挡的是全体且插队 | 按 agent 分账配额 + 公平入队 | A 发 500、B 发 1 → B 先完成 | L1 |
| S12 | 切前台窗口致坐标错命中 | 坐标按当前前台窗口命中 | 坐标绑 `windowId+H`、派发前复核 | 切窗后 `dispatched=false` 且零副作用 | L2 |
| S13 | Agent 崩溃但租约不释放 | 只靠 TTL sweep，holder 每次写自动续租 | 心跳 idle 回收 + 审计化 forceRelease | 停心跳 >idleTtl → `lease===null` | L1 |
| S14 | LB 路由到无目标 tab 的实例 | 只按 `queued` 打分，不校验 T 归属 | `T→H` 亲和表 + 路由前查 `/tabs` | 目标仅在实例2 → `targetInstance=2` | L1 |
| S15 | 宿主半开假死 | 20s 后 `drop` 断开整个服务 | 每宿主独立 watchdog，只隔离该宿主 | A 半开 20s → B 仍 connected 且持续完成 | L2 → **P0 部分** |
| S16 | 意图级并发共写 | 排队退化为串行，语义冲突无法合并 | OT/CRDT 操作日志 + epoch 向量，由 agent 裁决 | 两 Agent 填不同字段 → 无 lostUpdate；2 机同 commandId 去重 | L3 |

**项目层兜底（不属禁区）**：未知结果不重放（`dispatch===1`）；精确目标绑定（H+T+frameId+元素指纹，不符 `dispatched=false` 不猜）；客户端 commandId 恰好一次；只收 id+H 双匹配 result；append-only 全量审计可重建每个副作用；身份解析失败返回 null 不默认；永不 `denied_by_policy`。

### 3.2 故障、时滞与恶劣环境（F）

兜底代号：R1 幂等键+持久化结果账本 / R2 不确定返 UNKNOWN 且写不重放 / R3 epoch/fencing 栅栏（服务端单调钟）/ R4 心跳半开+重连对账 / R5 有界队列·超时抢占·配额 / R6 能力探测+降级替代 / R7 原子写+文件锁+校验和+只读降级 / R8 重启重建登记+孤儿回收 / R9 背压+环形错误缓冲+指标。

| 编号 | 触发 → 失败 | 兜底 | 验收 | 级 |
|---|---|---|---|---|
| F01 | MV3 worker 执行中被回收 → 命令无终态、队列悬挂 | R1R2R5 | kill SW 后恰一次或 UNKNOWN、零悬挂 | L1 |
| F02 | 热升级撞在途命令 → 旧上下文蒸发、新 SW 重复执行 | R1R3 | 会话对账后恰一次 | L1 |
| F03 | Chrome 崩溃 / 用户手动关 tab → 租约悬空、结果丢失 | R4R8 | 租约回收并报 TAB_GONE | L1 |
| F04–F06 | 休眠半开、网络栈重置、断线重连 → 假连接吞命令、旧 epoch 覆盖新状态 | R3R4 | 心跳判死、fencing 拒旧 epoch、未确认转 UNKNOWN | L1 |
| F07 | 结果不确定 → 重试把提交命令重放两次 | R1R2 | 丢响应后不自动重放、返 UNKNOWN | L1 → **P0 幂等部分** |
| F08 | 扩展报错列表堆积 | R9 | 环形上限、可检索、不 OOM | L1 |
| F09–F10 | UIA 仅同进程可见、内置浏览器无窗口、`chrome://` Document 不可读 | R6 | 启动期探测、报 UNSUPPORTED 并给替代路径 | L1 |
| F11–F12 | SPA 在读与点之间重渲染、ref 失效 | R1R9 | ref 版本校验+二次确认，失败回 UNKNOWN | L1 |
| F13 | 时钟漂移 → 租约提前被抢 / 延后不过期 | R3 | NTP 大步长跳变下服务端单调钟裁决，零双重租约 | L1 |
| F14 | 看门狗重启 → 内存「本桥创建」登记丢失、孤儿 tab 撞车 | R8 | 从磁盘重建登记、不误杀用户 tab | L1 |
| F15 | 磁盘写满 → 状态/epoch 落不了盘 | R7 | 原子写失败即降级只读、无半文件 | L1 |
| F16–F17 | Agent 无限刷任务 / 单任务占队列 10min → 饿死他人 | R5 | 配额+超时抢占、p99 排队有上界 | L1 |
| F18 | PowerShell/UIA 超时或 stdout 不回传 → 串行队列永久阻塞 | R5R9 | 子进程超时杀、返 TIMEOUT 并释放队列 | L1 |
| F19 | 多进程抢写同一 `.local` → 状态撕裂、双主 | R7R3 | flock + 端口互斥、败者拒启、校验和拦损坏 | L1 |
| F20 | 扩展 WS 缓冲积压 → 静默超时乱序 | R5R9 | 发送窗限流、超阈值拒新命令而非丢弃 | L2 |
| F21 | 进程被 sandbox 杀 → 端口残留、半开连接 | R4R8 | PID 存活探针、端口自解绑、重启对账 | L2 |
| F22/F24 | 切前台、远程桌面/多显示器 DPI 变化 → 缓存坐标全偏 | R6R9 | 每操作重取窗口/DPI、失效即 UNSUPPORTED | L2 |
| F23 | 隐身窗口 cookie jar 不同 → 登录态假设失效 | R6R8 | tab 标注 jar、跨 jar 重新校验登录态 | L2 |
| F25 | 多版本扩展混连 → 字段语义错解 | R3R8 | 握手协商版本、不兼容隔离到独立端口 | L2 → **P0 部分** |
| F27 | 19387 遭 DNS-rebinding / 恶意页劫持 | R3R7 | Origin+token 鉴权、非法来源零执行 | L3 |
| F28 | Chrome 被 OOM 回收后从账本快照续跑 | R1R8 | 跨进程续播且无重放 | L3 |

**「稳定发挥」的度量（SLO）**

| 指标 | 目标 | 故障注入 |
|---|---|---|
| 终态完备率 | ≥99.99%，每条命令必落 SUCCESS/FAIL/UNKNOWN/TIMEOUT，零悬挂 | kill SW、断网、脚本超时，查账本无 open 态 |
| 写操作恰好一次 | 100%，副作用计数 = 已确认命令数 | 丢响应 + 客户端重试 |
| 诚实率 | 100%，不可用/不可见/不确定一律显式报码，零静默成功 | `chrome://`、无窗口、DPI 变化 |
| 自愈时长 | p99 <30s（断连/重启/休眠后首个成功命令） | kill -9、休眠唤醒计时 |
| 公平性 | 饿死数 0、低优 p99 排队有上界 | 无限刷任务 + 10min 长任务 |

### 3.3 跨版本 / 跨渠道 / 跨宿主兼容（C）

| 编号 | 触发 → 失败 | 能力需求 | 验收 | 级 |
|---|---|---|---|---|
| C1 | stable156 / Canary159 并存，WebMCP OT(149起)、outputSchema(159.0.8140.0起) | 能力矩阵按 `hostKind+chromeVersion` 区间索引 + 握手 `apiAvailability` | 桩注入 149/156/159 三档，路由与字段投影零越界 | L1 → **P0 hints 部分** |
| C2 | 0.33/0.35/0.40 三扩展同连 | 连接态按 connectionId 分表、按能力分流 | 吞吐 = 三者之和且无 `waiting` 误报 | L1 → **P0 部分** |
| C3 | 扩展新于/旧于服务、服务热升级后旧扩展长连 | semver 区间协商 + `toolSchemaHash` + renegotiate 广播 + 未知消息忽略 | 0.40 扩展连 0.35 服务基线可用、新工具回 `unsupported`；热升级 5s 内零丢单 | L1 |
| C4 | 各版本 SW 休眠/回收策略不同 | 握手带 `swKeepaliveStrategy`，按宿主设心跳 | 模拟 SW 终止，命令 N 秒内重投成功且不重复 | L2 |
| C5 | manifest 权限在某版本被移除 | 权限运行时惰性探测，标 `unavailable(reason)` | 注入缺失 API 桩，服务不抛错且 doctor 列出该项 | L1 |
| C6 | 渠道缺 `developerPrivate` / `chrome://extensions` 不可达 | 按 hostKind 分流：UIA 仅 Windows+可见窗口启用，否则 `runtime.reload` | 无 UI 宿主返回 `degraded` 而非超时 | L1 |
| C7 | 内置浏览器非 chrome.exe、无窗口、无常规 user-data | Host Adapter SPI（进程/注入/窗口/provider 四接口）+ `agent_embedded` | 模拟宿主跑通 read→click 闭环，零文件系统假设 | L2/L3 |
| C8 | 各渠道 profile 独立 | mtime 比较限定 `instanceKey` 内，跨渠道只比心跳 | 构造 mtime 倒挂两 profile，选主不依赖 mtime | L1 |
| C9 | 不同渠道扩展 ID 不同 | token 绑 `instanceKey+hostKind+pairScope`，ID 仅诊断提示 | 同 token 在 stable/Canary 各配对成功、互不顶号 | L1 |
| C10 | 某宿主只支持部分工具 | 能力矩阵按连接过滤，派发前给 `fallbackTo` | 禁用 3 工具后随机 100 次派发，0 次落到不支持连接 | L1 |
| C11 | 探测报"支持"但实调失败；探测本身弹权限框 | 声明与实测分离（`verifiedBy`+TTL）、失败回写熔断、静态先行 + 异步重探测带预算 | 注入一次失败后降级并改走备选；握手 P99 不随探测项数增长 | L2 |
| C12 | doctor 只检查单一目标版本 | doctor 遍历所有 `instanceKey` 出矩阵报告 | 故意断一实例，报告逐实例标红且退出码非 0 | L1 |
| C13 | WebMCP 原生工具与 Bridge 工具同名；Canary 回退旧版 | 命名空间前缀 + 调度器单一仲裁；每次握手重测 `chromeVersion` 并使区间缓存失效 | 同名并发仅执行一次且可溯源；热切版本 1 次握手内矩阵刷新 | L2 |
| C14 | 多实例同 chromePath 不同 profile | `instanceKey` 全链路透传（日志/租约/审计） | 两实例并发，审计条目无交叉 | L1 |

**握手字段演进基线**（P2 v3 目标，单向加字段、未知忽略、取 min 协商、缺字段永不断连、旧版本落 baseline 白名单）：
`protocolVersion` / `serviceVersion`+`extensionVersion` / `instanceKey` / `hostKind` / `chromeVersion` / `extensionId`（不参与配对）/ `pairToken`+`pairScope` / `capabilities{level,since,until,verifiedBy,evidenceAt}` / `apiAvailability` / `toolSchemaHash` / `swKeepaliveStrategy`+`fallbackPolicy`+`nonce`。

### 3.4 AI 时代前瞻（D）

| 编号 | 场景 | 具体能力需求（接口/数据结构层） | 前置 | 验收 | 级 |
|---|---|---|---|---|---|
| D1 | 48 Agent 抢 8 profile | `FleetRegistry{agentId,quota,trustTier}`、租约键 `(instanceId,tabId)`、`enqueueFleet(task,deadline,cost)` | D9,D13 | 30min 零双写/零租约丢失、P99 可预测 | L3 |
| D2 | 三模型对「已提交？」判断互斥 | `Verdict{claim,digestHash,conf,modelId}` + `Arbiter.arbitrate()→{canonical,dissent}` | D3,D13 | 注入矛盾后落库动作唯一且=canonical | L3 |
| D3 | A 把「填报销单」交 B | append-only `IntentLedger{seq,from,to,snapshotDigest,openWrites}`、写带 `ledgerSeq`、`handoff()` 原子移租约 | receipt,state-digest | B 首动作复现 A 未完成字段、账本可重放 | L2 |
| D4 | 页面 `registerTool()` 与 `click` 同台 | 统一 `Capability{uri,inputSchema,outputSchema,source,risk,leaseScope}`，tool-index 合并注册 | D10 | 同意图两路径副作用等价 | L3 |
| D5 | 锁「这段文本」而非整 tab | `SemanticKey{contentHash,selectorPath}`、`keyOf/overlap()`、`semantic_overlap` | 可插拔租约键 | 异段并行成功、同段被阻断 | L2 |
| D6 | 填完表必截图 → 预取 | `BehaviorModel(Markov)` + `Prefetcher` 空窗缓存 `PageState` | D13 | 命中率 >60%、observe 延迟量化下降 | L3 |
| D7 | 孪生页预演再落真实页 | `forkShadow()→shadowId`、`replay(plan)→Diff{networkDelta,sideEffects}`、显式 `commit()` | D8 | 含外部 POST 的影子序列被拦、真实页零副作用 | L3 |
| D8 | 同页分叉 3 路再合并 | `Session{baseDigest,branchOf}`、`merge()→{merged,conflicts}`、DOM 用 OT、字段级 LWW | D5,D7 | 无重叠字段无损、重叠进 conflicts 不静默覆盖 | L3 |
| D9 | 本机+云机+同事机器联邦 | `FederatedNode{pubkey,caps,trust}`、gossip 成员表、HLC `CommitOrder`、跨节点两阶段 `grant()` | 全局时钟 | 断一节点 TTL 内接管、零双写 | L3 |
| D10 | Agent 自造「批量导出」工具 | `GapSignal→ToolForge.synthesize()→{spec,code,testVector}`、沙箱试跑、热注册带 `provenance/TTL` | D4,D11 | 越 scope 调用被拒、可一键吊销 | L3 |
| D11 | 按调用计费 | `Meter{callId,capability,costUnits,outcome}`、`Quota.enforce()` | D1,D3,D11 | Meter 与副作用一一对应、无漏计 | L3 |
| D12 | 规则被群体行为打穿 | `Scheduler.rank(tasks,ctx)` 由本地模型出序，规则退为 guardrail 硬上限 | browser_local_judge,D13 | 模型越硬约束无效、吞吐 ≥ 规则基线 | L2 |
| D13 | 复现三天前误点 | `ActionLog{seq,ts,tool,args,digestBefore/After,receipt}` 全量落盘、`seek(seq)`、`diff()` | receipt,state-digest | 任意 seq 回放 digest 一致、定位唯一致变动作 | L2 |
| D14 | 劫持 Agent 狂写不误伤 | `TrustTier+AnomalyScore→quarantine()`（冻结租约/降权/只读，**不停服**）、`SandboxPolicy` | D1,D3,D11 | 正常 Agent P99 劣化 <10%、恶意副作用 0 | L2 |
| D15 | Prompt API 页内判按钮语义 | `browser_local_judge(mode:'verify',{outputSchema})→{decision,conf,schemaValid}`，模型不出机 | D2 | 结果符合 schema、零网络外发 | L3 |
| D16 | 抢占互踩致饥饿 | `aging(priority,wait)`、`perAgentBudget`、抢占频率阻尼、`fairnessIndex(Jain)` | D1,D12 | 高压 30min 最低优 Agent 仍获份额 | L2 |

## 4. 0.36.0 的实际边界（诚实说明）

**已做到**：多宿主对等登记、握手向后兼容到 protocol 1、每宿主独立 in-flight、按 `hostId` 路由与结果归属、`hostId:tabId` 租约隔离、`commandId` 幂等、aging + agent 轮转派发、队列上限按宿主数伸缩、队列按宿主隔离保留等待重连、`browser_hosts` 状态可见、能力 hints（Chrome 149/159 边界）、扩展端持久 hostId。

**尚未做到**（落在 P1 及以后）：跨实例共享租约、持久化结果账本、epoch/fencing、docEpoch 栅栏、半开连接主动探测、坐标按 windowId 绑定、模型驱动调度、WebMCP 原生工具统一能力面、影子页与联邦。

**已知取舍**：
- 不带 `hostId` 的默认调用仍落到 primary，且租约使用裸 tabId 键。多 Agent 场景必须显式传 `hostId` 才能完全隔离——这是为保持单宿主 29/29 旧行为不变而做的兼容选择。
- 旧扩展（无 hostId）重连会换一个 `legacy-*` id，因此其排队任务不会自动续上；升级扩展后身份稳定。
- `features` 是声明/UA 推导的 hints，不是运行时实测；C11 的 `verifiedBy` 闭环留到 P2。
- 同 hostId 重连会用 4004 关闭旧 socket；这不是抢占，是同一浏览器自己的新连接接管。

## 5. 明确不做的事

- 不因为「宿主不是 chrome.exe」而拒绝扩展连接或 UIA 之外的全部能力（0.35.1 的教训）。
- 不把 `unsupported` / `degraded` 当作拒绝；agent 决定要不要尝试，项目只提供诚实证据。
- 不静默把显式指定 `hostId` 的任务改派给别的浏览器；宿主掉线时返回 `waiting` + `browser_hosts`。
- 不自动重放结果不确定的写操作。
- 不替用户启动 GUI、不复制 Chrome profile、不把密码库当可解数据源（既有硬规则继续有效）。
