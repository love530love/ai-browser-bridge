# 多浏览器目标认定与默认宿主纠偏

2026-11-15 起，服务在“只有一个 `hostId` 可选”之外，增加了**默认目标推荐**。目标是纠正一类真实故障：agent-embedded 浏览器（例如 ChatGPT/Codex 内置浏览器）先连上桥，`primaryHostId` 指向它，随后所有省略 `hostId` 的命令都落到这个没有用户登录态的浏览器里，最终需要人工重新登录。

## 行为

- `browser_hosts` 返回：
  - `primaryHostId`：兼容镜像，仍按连接顺序变化，**不是**默认路由目标。
  - `recommendedHostId` / `defaultHostId`：省略 `hostId` 时的实际目标。
  - `selectionRequired` / `selectionConfidence` / `selectionReason`：是否存在目标歧义。
  - `recommendation.candidates[]`：每个宿主的 `hostKindObserved`、排名、是否 primary、是否被推荐。
- 默认排序：系统 Chrome（`stable`/`canary`/`dev`/`beta`）优先；`generic` 次之；`agent_embedded` 最后。同分时 primary 优先，再按连接时间稳定排序。
- `hostKindObserved` 优先取**socket 对端进程**的观测结果（非 chrome.exe 判为 `agent_embedded`），并在握手时持久化到 registry；短暂的 owner 查询失败不会把默认目标翻回内置浏览器。
- 省略 `hostId` 的排队任务在宿主变化（新浏览器接入、推荐宿主断开）时会被重新指向当前推荐宿主；显式 `hostId` 的任务永不迁移，宿主不在线就 `waiting`（`host_not_connected`）。

## 边界

- 推荐是启发式，不是登录证据：桥不读取 Cookie、`Login Data`、`Local State` 或任何 profile 文件，因此不会声称“这个浏览器已登录”。
- `selectionRequired:true` 不阻断调用：只表示“存在两个系统浏览器”或“全是内置浏览器”，建议在依赖登录态的写操作前显式传 `hostId`。默认仍可执行，避免把弱 agent 卡死。
- 显式 `hostId` 始终有效；推荐只影响省略 `hostId` 的路径。
- 写操作契约不变：`_verified`、`uncertain` 不重放、动作后回验。

## 验收

- 单元：`recommendHost` 覆盖“内置先连、系统后连”“两个系统浏览器”“只有内置”“空集合”。
- 集成：内置宿主先连接成为 primary，随后系统 Chrome 连接；`browser_hosts.defaultHostId` 指向系统 Chrome；省略 `hostId` 的 `browser_read` 只派发给系统 Chrome；显式 `hostId` 仍可派发给内置宿主。
- 运行：

```bash
node --test test/multi-host.test.js
```

## 真实环境核对

```bash
node src/cli.js call browser_hosts '{}'
```

同时观察 `hosts[].hostKindObserved`、`owner.processName`、`defaultHostId` 与 `selectionReason`。若默认仍不符合预期，带上这些字段和 `hosts[].remotePort` 反馈，不要靠重启或重载扩展“碰运气”。
