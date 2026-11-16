# 升级运行与验收

> **DEPRECATED（2026-11-16）**：`scripts/upgrade.ps1` 已不是官方升级入口。它默认只运行只读 `node src/cli.js upgrade-check`，不拉取、不安装、不重启；旧流程（`npm ci` → `start.ps1` → UIA 重载扩展）必须显式加 `-Legacy` 才会执行，且 `-Legacy` 与官方五步流程互斥。不要再把旧脚本描述成“一键升级”。

## 唯一官方升级流程

磁盘源码、运行中的服务、Chrome 扩展和 `.local/config.json` 是四个独立层；`git pull` 只更新第一层。

1. **拉取源码**：`git pull --ff-only origin main`。不要手改版本号，也不要覆盖工作区未提交改动。
2. **只读预检**：`node src/cli.js upgrade-check`。它按顺序输出每一层的问题、可复制命令和证据；`ok:true` 表示四层已收敛。不重启、不重载、不写配置。
3. **空闲重启服务**：`node src/cli.js restart-service-when-idle --apply`。命令先做完整预检（`/status` 的 pid 对 LISTENING pid、进程命令行、看门狗身份、队列/租约/维护锁空闲、running 与 disk buildId 不一致），任一不符即拒绝且不发送任何信号；预检通过后写 `restart_intent`，请服务自查空闲并自行退出，由看门狗拉起新源码，CLI 轮询到 `buildId === 磁盘 buildId`（`status:verified`）才算完成。只看预检时去掉 `--apply`。
4. **重载扩展**：`node src/cli.js call browser_reload_extension '{"confirmation":"reload_extension_once","allowFocus":true}'`，多宿主按各 `hostId` 分别执行一次。扩展已连接时会走 `chrome.runtime.reload()` 自我重载；不再使用 UIA 点击作为官方路径。
5. **复验**：`doctor-lite.bat && doctor.bat`，并用 `node src/cli.js upgrade-check` 确认 `running.buildId === disk.buildId`、扩展版本一致。面板也会显示 `deploymentStale` / 版本偏差 / 配置缺字段提示。

### 首次迁移（运行中的服务早于本协议）

旧服务没有 `POST /restart-when-idle`。第 3 步会返回 `status: refused`、`reason: restart_endpoint_unavailable`，并且**不发送任何信号**。此时在确认空闲窗口后按“历史流程”手工重启一次；之后该命令即可使用。

### 边界

- 不按 `.local/server.pid` 杀进程；该文件不是存活证明，实际 LISTENING PID 可能属于另一个 node 进程。
- 除 `restart-service-when-idle` 外，只有心跳白名单 `-Heartbeat` 会在空闲/冷却/单实例锁/复检门控下执行 `build_restart`；看门狗默认只报告 `build-stale-restart-needed`，绝不自动重启。
- 绝不要用 `stop.ps1` 执行升级重启：它会写 `service-paused` 让守护自我暂停。
- `uncertain` 结果不可重放；先观察 `/status`、`.local/service-lifecycle.jsonl` 与看门狗日志。

## 历史：旧升级脚本流程（已弃用）

以下内容仅用于理解 `scripts/upgrade.ps1 -Legacy` 的行为，不是推荐路径。

旧脚本在修改依赖前读取 doctor。存在执行中任务、排队任务、任务租约或标签租约时，报告 `status: waiting`、`actionRequired: wait-for-idle`，不继续 Git 更新、依赖安装或扩展重载。

开发版增加经过本机认证的 `POST /maintenance`：`action: acquire` 在同一个服务事件循环中检查队列和租约并关闭新任务入口，成功返回独立持有令牌；`action: release` 必须携带该令牌。状态接口不公开令牌。新浏览器调用返回 `waiting / maintenance / dispatched:false`，读取就绪状态不会错误地返回 ready。CLI 支持 `node src/cli.js maintenance --stdin` 接收 JSON。

旧脚本取得最长 10 分钟的维护窗口，退出时释放，崩溃后自动到期恢复。正式服务把锁同步写入 `.local/maintenance.json` 后才确认取得，服务重启后继续等待至释放或到期；持有令牌不出现在 status 中。损坏的状态文件会使服务启动失败，必须先排查，不会静默解除维护。

安装依赖前至少需要剩余 5 分钟维护时间；`npm ci` 最长运行 4 分钟。旧流程的 `start.ps1` 不会替换已在运行的服务实例，因此“已经运行”不等于“已升级”——这正是官方流程改用自退出重启的原因。

旧路径的扩展 Reload 是一次性 UIA 操作，只调用一次，不因非零退出码自动重放；`-ChromeWindowHandle` / `-ChromeProcessId` 用于消歧。`reload-extension.ps1` 退出码 `0` 表示目标版本已观察到，`2` 表示确认未调用 Reload，`3` 表示调用可能已派发但未能验证。遇到 `uncertain` 必须先独立观察扩展连接与版本，不得直接重试。

`service-build-current`：服务启动时固定计算 src 中 JS/JSON 源码及 package/lock 声明的 SHA-256 摘要。旧服务不提供 buildId 也视为未验证，避免同一版本号下运行旧代码被误报为部署完成。

这不是签名、安全扫描或实际依赖文件完整性证明；不覆盖 node_modules、Chrome 扩展实际加载源码，也不读取本机配置、密钥或日志。

## 2026-10-17 验证

- 服务和 Chrome 扩展均为 0.5.15，doctor 全部通过。
- `node --test test/upgrade-preflight.test.js`：四种忙碌状态均在任何安装或重载前返回等待，记录退出码和日志。
- `node test/live-installed-smoke.js`：在现有 Chrome 新建本地测试标签，验证输入/点击回读、滚动、截图、跨源导航、Shadow DOM 操作、透明遮罩拦截；最终只关闭测试标签。
- 真实熊猫客服问答、自动 Reload、封闭 Shadow DOM 和跨服务重启的升级事务仍需后续实现或验收，不属于本次通过范围。
- 开发版维护锁：并发抢锁、鉴权、令牌所有权、阻止新请求和新租约、就绪等待、租约占用、到期恢复测试通过；服务/租约相关回归共 22 项通过。尚未部署到常驻服务。

## 2026-10-18 开发验证

- 新增锁持久化测试：重建实例后持有令牌仍有效、无法重复取得、释放/到期落盘、损坏文件与写入失败均不假报成功。
- Windows 安装进程测试：正常退出、非零退出、挂起后的超时终止。
- 全量 `npm test`：84/84 通过（Windows PowerShell 7 环境）。
- 本批仅修改服务和升级脚本，不涉及扩展前端；尚未重启常驻服务部署这些改动。

## 2026-10-18 服务恢复与守护部署

后续排查确认本机服务未监听。已安装新版用户登录自启动守护，自动拉起当前服务，扩展自动重连；doctor 全部通过，服务和扩展均报告 0.5.15。当前服务已加载上述维护锁实现。

守护每约 10 秒检查认证健康状态，服务不监听时启动，失败退避；服务在运行而扩展断连时不会反复重启服务。占用端口不会被强杀。暂停标记、卸载标记和单实例互斥均生效；日志位于 `.local/watchdog-status.json` 和 `.local/watchdog.jsonl`。

验证：3 项 Windows 脚本测试通过，覆盖缺失服务恢复、暂停、禁用、占用端口保护、升级前置检查及安装超时；真实 Chrome smoke 完整通过。没有实际重启 Windows 验证登录流程。守护自身被终止后仍需重新启动或下次登录，不承诺任意故障下无条件可用。
