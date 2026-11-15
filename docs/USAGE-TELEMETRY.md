# 使用遥测与心跳验收（2026-11-15）

本文件说明本项目自带的本地遥测：采集什么、不采集什么、怎么读、如何用于实战验收。
它是一层**诊断证据**，不是任务成功率指标，也不是崩溃原因的证明。

## 1. 数据来源

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `.local/logs/audit.jsonl` | 服务端每条命令结束时 | `time`、`tool`、`hostId`、`outcome`、`errorCategory`、`durationMs`、`traceId` 等 |
| `.local/logs/audit.jsonl`（`tool:"extension-error"`） | 扩展 | `eventId`、`errorCategory`、`droppedBeforeSend`，**不含页面内容** |
| `.local/watchdog.jsonl` | 看门狗 | `starting-service`、`connected` 等状态迁移 |
| `.local/heartbeat/<UTC-date>.jsonl` | `cli heartbeat` / watch | 每周期快照：版本、buildId、宿主数、队列、findings、**1 小时 usage 摘要** |
| `.local/heartbeat/incidents/*.md` | `cli heartbeat` | 非 clean 周期的证据与建议 |

`.local/` 已在 `.gitignore` 中，不进入版本库。

## 2. 采集边界

会记录：

- 工具名（`browser_read`、`browser_click` …）与 `hostId`；
- 结果状态（`ok` / `error` / `uncertain`）、错误分类（`ELEMENT_COVERED` …）、耗时；
- 宿主连接/恢复次数、看门狗启动次数；
- 扩展侧错误分类与发送前丢弃计数。

不记录：

- 页面文本、DOM、截图、URL、请求头、Cookie、token、密码或任何凭据；
- Chrome 配置文件内容（`Login Data`、`Cookies`、`Local State` 一律不读）；
- 调用参数原文（审计行只保留白名单字段）。

早期没有 `hostId` 的行不会被猜测归属，而是归入 `unrecorded` 并在 `hostTelemetryNote` 中说明：
“未记录宿主，不等于主宿主”。

## 3. 读取方式

```bash
# 最近 2 小时的聚合（默认 48 小时）
node src/cli.js usage --hours 2

# 单次心跳（含 1 小时 usage 摘要）
node src/cli.js heartbeat

# 持续观察，每 60 秒一次
node src/cli.js heartbeat --watch --interval-ms 60000
```

`usage` 输出字段：

| 字段 | 含义 |
| --- | --- |
| `commandRecords` / `commandErrors` / `uncertainCommands` | 命令总数、错误数、不确定数 |
| `byTool[tool]` | 每工具 `records/errors/uncertain/p50Ms/p95Ms/maxMs` |
| `byHost[hostId]` | 每宿主同上；无 `hostId` 的行为 `unrecorded` |
| `slowestTools` | 按 p95 排序的前 N 个工具 |
| `extensionErrorRecords` / `extensionErrorCategories` | 扩展侧错误与分类 |
| `serviceStarts` / `recoveryConnections` | 看门狗启动与恢复连接次数 |
| `frequentRestarts` | `serviceStarts >= 3` 的**提示性**标记，不等于崩溃 |
| `exitCause` | 固定 `unknown`：本层不推断退出原因 |
| `missingFiles` / `unreadableFiles` / `malformedRows` | 证据缺失时显式暴露，不静默吞掉 |

## 4. 实战验收用法

1. **找退化**：对比两个窗口的 `byTool.*.p95Ms`；p95 上升而记录数不变，优先怀疑目标宿主或页面类型变化。
2. **找错宿主**：`byHost` 中出现 `agent_embedded` 宿主承接了本应走系统 Chrome 的命令时，结合 `browser_hosts` 的 `recommendedHostId` / `selectionRequired` 复核路由。
3. **找不确定性**：`uncertainCommands > 0` 表示有写入结果未被观察到；按约定不得重放，应先重新观察再行动。
4. **验收修复**：修复前后各取一个窗口，记录 `commandErrors`、`errorCategories` 与相关工具的 p95，作为“是否真的变好”的对照证据。
5. **心跳留痕**：`.local/heartbeat/<UTC-date>.jsonl` 每行的 `usage` 是逐周期时间序列（命令/错误/不确定计数、每宿主记录数与 p95、最慢 3 个工具），可直接用于复盘“哪一小时开始变慢/报错”。

所有结论必须带窗口与文件坐标；单点快照不能证明趋势。

## 5. 与心跳的关系

- 心跳负责“当前是否健康”：buildId、版本、宿主在线、队列、in-flight、错误尖峰；
- `usage` 负责“最近用得好不好”：每工具/宿主时延与错误分布；
- 两者都只做观测。自动化修复仍只限两件事：源码 buildId 落后时的服务重启、扩展落后时的扩展重载；
- `uncertain` 永远不等于 clean，也不会被 usage 汇总“洗白”。

## 6. 复现与测试

```bash
node --test test/usage-summary.test.js
node --test test/heartbeat.test.js
node src/cli.js usage --hours 2
```

`test/usage-summary.test.js` 覆盖：镜像错误与扩展错误分离、恢复抖动、p50/p95、按工具/宿主归属、无 `hostId` 的 `unrecorded`、窗口参数、缺失与损坏文件可见性。
