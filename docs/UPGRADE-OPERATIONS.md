# 升级运行与验收

`scripts/upgrade.ps1` 在修改依赖前读取 doctor。存在执行中任务、排队任务、任务租约或标签租约时，报告 `status: waiting`、`actionRequired: wait-for-idle`，不继续 Git 更新、依赖安装或扩展重载。

调用方应保留原任务，等任务完成且释放租约后再安排升级。不要把 waiting 当成任务失败，也不要为升级强制删除租约。此检查是时点快照，不是原子维护锁；管理员仍须在升级窗口暂停提交新任务。

启动脚本失败时不尝试扩展重载；旧服务仍运行时返回 `restart-service-when-idle`，不会把 start.ps1 的“已经运行”误判为服务更新成功。`-BestEffort` 只使错误以 JSON 输出，不代表成功：失败退出码仍为 1。

每次结果写入 `.local/upgrade/last-result.json`。部署成功需 doctor 比较磁盘、服务和扩展的版本一致；不以“已点击 Reload”作为成功依据。

## 2026-10-17 验证

- 服务和 Chrome 扩展均为 0.5.15，doctor 全部通过。
- `node --test test/upgrade-preflight.test.js`：四种忙碌状态均在任何安装或重载前返回等待，记录退出码和日志。
- `node test/live-installed-smoke.js`：在现有 Chrome 新建本地测试标签，验证输入/点击回读、滚动、截图、跨源导航、Shadow DOM 操作、透明遮罩拦截；最终只关闭测试标签。
- 真实熊猫客服问答、自动 Reload、封闭 Shadow DOM 和原子升级维护锁仍需后续实现或验收，不属于本次通过范围。
