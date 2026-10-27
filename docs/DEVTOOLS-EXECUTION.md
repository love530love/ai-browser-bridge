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

优先开发缺口仍是窗口内精确绑定的 DevTools 打开动作，随后才能自动覆盖面板选择验收。旧快捷键候选的历史成功不替代当前版本验收。验收模块与 live fixture 变更已在提交 `a9fc930` 中推送。

# 只读捕获增量：`browser_devtools_capture`（0.5.24，2026-10-27）

这是与 `browser_devtools` 完全不同的通路：`browser_devtools` 走 Windows UIA 操作**界面**，`browser_devtools_capture` 走 CDP（`chrome.debugger`）读**数据**。两者不共享状态，也不互相替代。

## 语义

- 一次调用 = 一次 attach → enable 选定 domain → 有界观察窗口 → 读取结果 → detach。`domains` 可选 `console` / `network` / `scripts` / `metrics`，默认 `['console','network']`。
- `durationMs` 上限 5000、`maxEvents` 上限 200，服务端 schema 与扩展内双重收敛。
- 结果结构：`messages`（console/exception/log，按到达顺序）、`network`（每个 requestId 合并成一行，`state` 为 `completed`/`failed`/`pending`）、`scripts`（按 scriptId 去重）、`metrics`、`counts`、`dropped`、`truncated`、`pendingAtWindowEnd`、`partial`、`partialReasons`、`negativeEvidence`。

## 必须如实转述的负证据

- domain enable **之前**的事件不可见；空列表不是「没有发生」。
- 只观察该 tab target；其它 tab、dedicated worker、Service Worker、OOPIF 是独立 target。
- 缓冲有界，`dropped`/`truncated` 是真实计数，不是装饰。
- 网络记录只有方法、去 query/fragment/凭据的 URL、状态、类型、耗时、编码长度；**没有** header、cookie、请求体、响应体。
- console 对象参数按类型摘要（`[object]`、`[array]`、`[node]`），不序列化内容；但 console 文本本身是页面写的，可能包含页面自己的秘密。
- `targetChanged: true` 表示窗口内 URL 变化或出现 pending 导航，此时结果可能是两个页面的混合观察。

## 明确不做

请求重放（`Network.replay`）、脚本编辑、断点/单步调试、Console 输入执行、分离 DevTools 窗口与被检查标签绑定。这些仍是缺口，不要用本工具冒充。

## 验证状态

- 单元契约 15/15（`test/cdp-capture.test.js`）：console 字段边界与对象不序列化、网络敏感字段拒绝、失败请求保留、pending 不冒充完成、溢出计数、脚本去重与 inline 标记、单 domain enable 失败报 failed、全部失败不编造数据、导航漂移、跨 tab 事件不归属、非法 domain 不订阅不调用、预算收敛、URL 脱敏、数组 schema 校验。
- **尚未做真实 Chrome 现场验收**。CDP 事件行为在不同 Chrome 版本可能不同，验收必须用本地 fixture 页面而不是用户业务页面。
- 现场验收入口已就绪：`npm run test:capture`（`test/live-capture.js`）。它启动本地 fixture（每 400ms 重复一次探针突发，保证有界窗口必然重叠）、用 `browser_open` 开自己的标签、跑一次捕获、断言 console 文本与级别、未捕获异常、`/api/ok` 的 200 完成行、被拒绝请求保留为 failed、脚本含 inline 标记、结果不含 header/cookie/凭据、负证据存在、缓冲计数存在，最后只关闭自己创建的标签。
- **当前该入口会 BLOCKED 而不是 PASS**：已加载扩展是 0.5.22，不含 `browser_devtools_capture` 命令；必须先获授权 Reload 0.5.24 扩展。脚本在版本不匹配时**不打开任何标签**，直接以退出码 **2** 结束（0=全通过，1=有断言失败，2=被环境阻断），所以 BLOCKED 不可能被 CI 当成成功。
