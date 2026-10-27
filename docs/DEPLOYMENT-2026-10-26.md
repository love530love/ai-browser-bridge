# 0.5.22 部署验收（2026-10-26）

本批整合协作中的桌面扩展重载、文本查找和升级可靠性改动。Node 全量测试 140/140 通过；桌面适配、Reload 定位约束与内部 URL 校验定向测试 7/7 通过；扩展脚本语法检查及 git diff --check 通过。

后续针对实际 Chrome UIA 结构补充固定扩展定位：直接使用 `chrome://extensions/?id=<固定ID>` 打开详情页；当 UIA 未将 ID 放在 Reload 按钮祖先时，必须同时核对该详情页精确 URL、唯一可见扩展 ID，以及唯一启用的开发者 Reload 控件。按指定 PID 操作前还校验进程名及映像文件名确为 Chrome。移除地址栏控件 `AutomationId` 前缀假设，并在快捷键序列间加入短暂等待。

部署验收结果：提交 `f4bd3c9`（Reload 脚本进程/目标约束）和 `7d68bb4`（UIA 地址控件定位与输入时序修复）均已推送到 `sshpush/main`、`origin/main`。本机 Bridge 服务已运行 0.5.22 且 buildId 与工作树一致；Reload 前扩展为 0.5.21。首个本轮 UIA 调用明确返回 `not_dispatched`，未调用 Invoke；修正地址栏匹配后，固定扩展 Reload 只执行一次，返回 `success / dispatched:true / verified:true`。扩展 session 从 `4d3d158c-5c23-446c-9876-8880775d5bfb` 变为 `c13b3add-0cba-4680-b63f-2cfd06e4d3b5`，版本变为 0.5.22；doctor 全部检查通过、队列空闲。测试和真实 Reload 均不代表业务站点下载或任意 Chrome 设置已验收。

Reload 后首轮全量测试为 138/140；两项失败来自 `test/stop-timeout.test.js` 的 `spawnSync` 外层等待到期（status=null）。将此类 Windows 子进程 fixture 的外层上限调至 60 秒，并补充失败诊断信息；保留 stop 脚本自身 1/8 秒探测预算作为被测对象。随后停止探测测试 3/3、升级前置测试 2/2、browser-stress 10/10，最终 Node 全量 140/140 通过。stress harness 还增加等待扩展 panel 的异步存储初始化完成，并在连接前核对隔离端口、随机配对密钥和 all-sites 状态，避免与常驻 19387 服务串线。Bridge doctor 与扩展健康/version-match 检查仍通过。

## 0.5.23 DevTools 阶段状态（2026-10-27）

- 增加 `browser_devtools` Windows UIA 通路：observe、open、select_panel；只处理停靠式 DevTools。open 使用真实 F12 toggle，仅在 UIA 将状态判为 closed、当前地址与 `expectedUrl` 一致、窗口为前台时派发一次；已开返回 no-op，UIA partial/unknown 或同进程 detached DevTools 歧义时不派发。打开和面板选择都会重新读取 UIA 状态验证。
- 面板切换限于 `devtools://` document 下可见/启用的 TabItem，只有回读 `SelectionItemPattern.IsSelected` 后报告成功。DevTools Console/脚本执行、断点、Chrome 设置写入、detached 窗口目标绑定、下载落盘验证仍未实现。
- 本轮策略热加载改为基于内容指纹后，完整串行 Node 回归 `node --test --test-concurrency=1 test/*.test.js`：146/146 通过；策略热加载定向测试 16/16，DevTools/Bridge/Protected-UI/version 定向组 33/33 通过。该验证针对源码候选；不代表服务重新加载了本轮策略热加载修复。
- 真实 Chrome 本地 fixture 曾验证停靠 DevTools 打开/幂等和 Console/Network/Elements 选择回读，仅限该机器当前 Chrome/UIA 结构；由于独立审查发现 UIA “closed”负证据和 F12 全局焦点竞态尚未解决，本轮不将它升级为跨场景安全验收。
- **部署现状：**本轮策略热加载代码改动后，运行服务所报告的 0.5.23 buildId 已不再代表最新工作树，需再运行 `status/doctor` 确认 stale 状态并在维护窗口重启部署；加载中的扩展仍报告 0.5.22，因此 deployment-current/version-match 检查失败。扩展内容代码没有 DevTools UIA 改动，但 manifest 版本改为 0.5.23；是否 Reload 扩展须单独确认当次授权。当前工作树尚未完成本轮提交/推送验收。不得称整个部署或版本匹配已完成。
