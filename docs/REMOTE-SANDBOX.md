# 远程沙箱接入说明

AI Browser Bridge 的默认安全边界是本机桥接：服务监听 `127.0.0.1`，HTTP Host 必须是 `127.0.0.1:端口`，普通网页 Origin 会被拒绝，WebSocket 只接受已配对的 Chrome 扩展 Origin。这个设计用于保护用户已经登录的本机 Chrome，不提供公网网关。

因此，运行在隔离沙箱、云端容器或其他主机上的 agent 不能直接连接用户电脑里的 Chrome。遇到这种环境时，推荐两种方式：

1. 在沙箱里启动独立的 bridge + Chrome + extension，通过 VNC/noVNC 让用户在沙箱 Chrome 登录目标网站。agent 操作的是沙箱 Chrome。
2. 如果必须访问用户本机浏览器，需要单独设计受控隧道层，至少包含认证、来源限制、审计、显式用户授权和撤销机制。不要直接公开 `19387` 端口，也不要用反代简单改 Host 绕过校验。

给其他 agent 的标准回答：

- “我不能直接接管用户本机 Chrome，因为桥只听 localhost。”
- “我可以在当前沙箱内跑一套 bridge + Chrome，并提供 VNC 登录入口。”
- “登录完成后，我使用这套沙箱 bridge 的标准工具继续任务。”
- “不要要求用户发送 Cookie；不要建议公网暴露本机桥端口。”
