# 0.5.22 部署验收（2026-10-26）

本批整合协作中的桌面扩展重载、文本查找和升级可靠性改动。Node 全量测试 140/140 通过；桌面适配、Reload 定位约束与内部 URL 校验定向测试 7/7 通过；扩展脚本语法检查及 git diff --check 通过。

后续针对实际 Chrome UIA 结构补充固定扩展定位：直接使用 `chrome://extensions/?id=<固定ID>` 打开详情页；当 UIA 未将 ID 放在 Reload 按钮祖先时，必须同时核对该详情页精确 URL、唯一可见扩展 ID，以及唯一启用的开发者 Reload 控件。按指定 PID 操作前还校验进程名及映像文件名确为 Chrome。移除地址栏控件 `AutomationId` 前缀假设，并在快捷键序列间加入短暂等待。

部署验收结果：提交 `f4bd3c9`（Reload 脚本进程/目标约束）和 `7d68bb4`（UIA 地址控件定位与输入时序修复）均已推送到 `sshpush/main`、`origin/main`。本机 Bridge 服务已运行 0.5.22 且 buildId 与工作树一致；Reload 前扩展为 0.5.21。首个本轮 UIA 调用明确返回 `not_dispatched`，未调用 Invoke；修正地址栏匹配后，固定扩展 Reload 只执行一次，返回 `success / dispatched:true / verified:true`。扩展 session 从 `4d3d158c-5c23-446c-9876-8880775d5bfb` 变为 `c13b3add-0cba-4680-b63f-2cfd06e4d3b5`，版本变为 0.5.22；doctor 全部检查通过、队列空闲。测试和真实 Reload 均不代表业务站点下载或任意 Chrome 设置已验收。

Reload 后首轮全量测试为 138/140；两项失败来自 `test/stop-timeout.test.js` 的 `spawnSync` 外层等待到期（status=null）。将此类 Windows 子进程 fixture 的外层上限调至 60 秒，并补充失败诊断信息；保留 stop 脚本自身 1/8 秒探测预算作为被测对象。随后停止探测测试 3/3、升级前置测试 2/2、browser-stress 10/10，最终 Node 全量 140/140 通过。stress harness 还增加等待扩展 panel 的异步存储初始化完成，并在连接前核对隔离端口、随机配对密钥和 all-sites 状态，避免与常驻 19387 服务串线。Bridge doctor 与扩展健康/version-match 检查仍通过。
