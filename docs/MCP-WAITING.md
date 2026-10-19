# MCP 等待契约

MCP 接入收到服务的 `status: waiting` 时立即返回文字结果，不再在同一个工具调用中隐藏最长两分钟的自动轮询。CLI 原有等待恢复逻辑不变。

调用方应保留原任务，使用返回的 `nextPollTool` / `nextPollArgs` 等待，再重新观测并决定下一步。等待不是任务完成或失败；未知结果的写操作仍不能重放。显式 `browser_wait_until_ready` 的单次 MCP 等待最多 20 秒，可多次调用。

`browser_screenshot` 的等待或拒绝结果必须作为文字返回；只有实际图像数据才使用 MCP image 内容，避免缺少 data 的无效图片响应。

这次改动消除服务已经返回 waiting 后的额外轮询，不保证所有请求都在 20 秒内结束：已经进入服务队列、实际浏览器执行和只读导航恢复仍可能耗时，需要继续完善请求进度与取消协议。

验证：9 项针对性测试通过，包括真实 MCP stdio 客户端连接本地模拟服务，在 5 秒客户端期限内收到截图等待结果且只提交一次请求。当前 Chrome 回归在本地测试按钮遇到 Element is covered，未强点，测试标签已清理；不将本次页面回归报告为通过。

已运行的 agent 需要重新连接 MCP 进程才能加载这项修改，不需要重新加载 Chrome 扩展或配对。不要使用被安全软件删除的重启脚本。

## 断连后的指导（开发版）

`browser_failure_help` 现在在服务端权限校验后直接回答，不占浏览器队列，也不依赖扩展在线。遮挡错误优先于附带的“Read page again”提示分类。返回 `observationAllowed`、`outcomeVerificationRequired` 和 `automaticWriteReplayAllowed:false`，将重新观测与重放原操作区分开。

只有 attemptedAction 精确对应已知只读工具时，部分暂态故障才给出 retryAllowed。普通断连不再一律要求人工确认或打开设置页；高风险提示仍需核对用户授权，错误文本不是授权。服务自身不可达时，这个 HTTP 工具仍不可用，需先恢复服务。

6 项相关测试通过，包括无扩展连接时直接获取指导、遮挡分类优先级、写超时不允许重放。该批服务端改动尚未部署到常驻进程。
