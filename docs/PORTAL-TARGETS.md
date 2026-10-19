# Portal 文本与固定列选择

0.5.16 开发版支持 `browser_find_element` / `browser_prepare_action` 按精确文本寻找 light DOM 中的叶子 `span`、`div`、`li`。仅用于 click/any 且没有 role 限制的查询，最多检查 5000 节点或 150ms。Portal 被挂到 body 下无需特殊路由；iframe 和 Shadow DOM 仍需各自的检查工具。

返回 `locatorEvidence: exact-leaf-text; clickability-unverified` 表示可定位，不表示已经证明它是按钮。prepare_action 会要求截图核对菜单上下文；只有用户授权的操作才执行，点击后必须验证页面变化。文字“关机”不构成用户关机授权。

固定列重复控件按真实命中分别筛选，覆盖副本、零尺寸或屏外控件不能伪装成可点击控件。不会跨行转移引用，不会强制点穿遮罩。若多行复选框没有可区分名称，仍需核对目标行和截图；当前没有通用的固定列语义映射算法。

`browser_find_element` 和 `browser_prepare_action` 支持 `rowText`，按最近的 tr、ARIA row 或常见表格行文本过滤。例如 `{query:"选择", rowText:"实例名称", action:"click"}`。返回候选附带行文本；多候选时 planner 要求消歧。通过 rowText 生成的 ref 在使用时重新验证行文本，虚拟表格复用节点或行变化会使引用失效。行文本最多取 240 字符，不映射缺乏行信息的独立固定列副本。

安装新版后，可设置 `$env:AIB_TEST_PORTAL_TARGETS='1'` 再执行 `node test/live-installed-smoke.js`，在本地测试标签验证委托事件的 portal 文本点击和第二行复选框回读。该用例不会访问真实实例或执行关机；本次只新增场景，尚未执行新版 Chrome 验收。

重网页查找返回 `partial` 和 `diagnostics`，区分文本扫描与控件筛选是否触及预算。`found:false, partial:true` 不代表目标不存在；找到一个候选但扫描不完整也不代表唯一。规划工具此时返回 `inspect_partial_search`，建议截图核对，避免直接建议点击。文本扫描限制为 5000 节点/150ms，控件筛选限制为 5000 候选/250ms；单次 DOM API 调用本身不能被这些预算抢占。

2026-10-19 全量 `npm test` 为 86/86 通过。后续已部署服务与扩展 0.5.16，开启 `AIB_TEST_PORTAL_TARGETS=1` 的实际 Chrome 回归完整通过：portal 委托点击、第二行复选框回读、Shadow DOM 操作与透明遮罩保护。报告在 `output/live-installed/report.json`。首次测试因维护锁等待超过 MCP 请求时限而失败，释放本次锁后重新执行通过。HiDevLab 实际页面尚未验收，未执行关机。

后续一次回归在本地回显按钮处遇到遮挡，再次执行同一测试完整通过，尚未确认偶发遮挡的根因。现加入失败后的 observe、overlay scan 和截图采集，只针对测试标签，不自动重放失败点击。每次结果保存到 `output/live-installed/runs/<runId>/`，包含运行版本和独立截图；根目录 report.json 仅作为最新结果索引，不再覆盖各次运行的证据。

故障采集验证：设置 `AIB_TEST_FORCE_OVERLAY=1` 会仅在本地测试页添加透明遮罩，预期测试以非零退出并保存诊断，不能当作普通通过。已验证它产生 covered 错误、observe/overlay 记录和 failure.png；取消该变量后正常回归再次通过。

`node src/cli.js diagnose-upgrade` 会汇总最近 20 个独立运行目录，加入 regressions 字段，分别统计通过、非预期失败、故障注入、不可读记录。只输出类别统计，不复制页面内容、截图或原始错误；原始报告留在本机。汇总不是自动修复，也不能证明安全软件告警为误报。

测试：`node --test test/portal-targets.test.js test/version.test.js` 通过，覆盖纯文本引用、前景/覆盖副本、零尺寸、屏外和缺失目标。此为模拟 DOM 回归，不等于 HiDevLab 实际页面验收。扩展需要加载 0.5.16 后才使用新代码；没有执行实际关机。
