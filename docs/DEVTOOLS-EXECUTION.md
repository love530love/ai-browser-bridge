# DevTools 执行增量（0.5.23，2026-10-26）

新增 `browser_devtools`，通过现有本机服务统一调用 Windows UIA 适配器，用于观察当前窗口及在已打开的停靠 DevTools 中选择面板。
Agent 判断任务意图与授权，工具不增加新的人工确认口令。工具仍核对窗口身份、当前页面及执行结果，并与其他桌面/网页写操作互斥。当前版本暂不提供 F12/open toggle：UIA 缺少可证明完整的负证据，且 `SendKeys` 有全局前台焦点竞态；在找到目标窗口内精确绑定且可回读的原生 UIA 菜单操作前，open 返回 `not_dispatched`。

## 调用流程

1. `browser_desktop_windows` 取得当前 PID/HWND。
2. `browser_devtools` 使用 `action: "observe"`、`processId`、`windowHandle` 读取界面证据。
3. 当前不请求 `action: "open"`：UIA 树没有可依赖的“DevTools 确认关闭”负证据，且全局快捷键存在焦点切换竞态。该操作在服务端返回 `not_dispatched`，不会发送 F12。
4. 若 DevTools 已由用户打开，使用刚观察到的 `evidence.url` 作为 `expectedUrl` 请求选择面板；UIA 只操作可见、启用且唯一匹配的 DevTools TabItem，并回读选中状态。
5. `uncertain` 必须先重新观察，不自动重复面板选择。`not_dispatched` 表示没有派发该面板动作；等待状态仍按服务给出的等待工具处理。

## 当前验证范围和缺口

- 当前确定性测试覆盖参数校验、拒绝不支持的 F12/open、超时不重放面板选择、服务端并发互斥、仅当目标 DevTools document 下存在唯一可见面板且回读为选中时才报成功。
- 历史真实 Chrome 验收（在禁用 open 前的候选中）：本机现有 Chrome 的测试标签曾验证 F12 首次打开、重复 open 不再派发，以及 Console/Network/Elements 选择回读。这不是当前代码对 F12 安全性的验收；因独立审查发现焦点竞态及 closed 负证据不足，当前候选已撤下 open/F12 通路。
- 当前 DevTools 能力：只观察用户已经打开的停靠 DevTools 并选择可见面板。面板操作真实 Chrome 测试证据适用于曾测试的本机 UIA 树，不证明各 Chrome 版本一致。分离窗口不能精确绑定被检查标签。
- Console 命令输入/执行、断点、源码编辑、Chrome 内部设置写入、下载事件/落盘验证仍未实现。
- UIA 单次平台调用仍可能阻塞；外层进程超时将结果标为失败或未知，不重放。

**源码候选版本为 0.5.23，发布/部署验收未完成。** 运行服务曾报告 0.5.23，但 Chrome 当前仍加载 0.5.22；本轮策略热加载源码修改后服务 buildId 还需重新部署核验。当前 F12/open toggle 已撤下，扩展 manifest 版本号变化也不等于已 Reload 或版本匹配。

## 2026-10-27 验收报告修正

现场复测仅完成 observe：1 项通过、6 项面板选择/重复选择跳过，整体为 partial，不再报告整套通过。新增 acceptance-report 模块要求必测场景逐项记账；缺失/跳过不会转为成功，重复/无关场景不能充数。定向 Node 测试 9/9 通过。

优先开发缺口仍是窗口内精确绑定的 DevTools 打开动作，随后才能自动覆盖面板选择验收。旧快捷键候选的历史成功不替代当前版本验收。新的验收模块与 live fixture 变更尚未提交或推送。
