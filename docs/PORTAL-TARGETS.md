# Portal 文本与固定列选择

0.5.16 开发版支持 `browser_find_element` / `browser_prepare_action` 按精确文本寻找 light DOM 中的叶子 `span`、`div`、`li`。仅用于 click/any 且没有 role 限制的查询，最多检查 5000 节点或 150ms。Portal 被挂到 body 下无需特殊路由；iframe 和 Shadow DOM 仍需各自的检查工具。

返回 `locatorEvidence: exact-leaf-text; clickability-unverified` 表示可定位，不表示已经证明它是按钮。prepare_action 会要求截图核对菜单上下文；只有用户授权的操作才执行，点击后必须验证页面变化。文字“关机”不构成用户关机授权。

固定列重复控件按真实命中分别筛选，覆盖副本、零尺寸或屏外控件不能伪装成可点击控件。不会跨行转移引用，不会强制点穿遮罩。若多行复选框没有可区分名称，仍需核对目标行和截图；当前没有通用的固定列语义映射算法。

测试：`node --test test/portal-targets.test.js test/version.test.js` 通过，覆盖纯文本引用、前景/覆盖副本、零尺寸、屏外和缺失目标。此为模拟 DOM 回归，不等于 HiDevLab 实际页面验收。扩展需要加载 0.5.16 后才使用新代码；没有执行实际关机。
