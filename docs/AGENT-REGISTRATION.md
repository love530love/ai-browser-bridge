# 五个 Agent 的浏览器工具注册

日期：2026-09-28。服务名统一为 ai-browser-bridge。所有客户端使用本机 Node 启动本项目 src/mcp.js，无模型配置、无新增 API key；认证由桥接客户端自动读取本机私有文件。原配置已在原路径旁保存 .aib-backup-时间戳 备份。

| 客户端 | 注册位置 | 当前证据 |
|---|---|---|
| Codex | C:/Users/love/.codex/config.toml | 官方 CLI add 成功；get 显示 enabled=true、stdio |
| Claude Code | C:/Users/love/.claude.json，user scope | 官方 CLI get 显示 Connected |
| Cursor | C:/Users/love/.cursor/mcp.json | 写入并解析成功；0.3.5 使用该条目应发现 20 个工具 |
| WorkBuddy | C:/Users/love/.workbuddy/mcp.json | 保留原有条目；0.3.5 使用该条目应发现 20 个工具 |
| Hermes | F:/PythonProjects1/Hermes/config.yaml | 按实际 HERMES_HOME 注册；0.3.5 应发现 20 个工具 |

浏览器连接状态：桥接和扩展均已升级为 0.3.0，connected=true。上述证明配置与协议连接；不代表所有升级前已打开的客户端会话已经热加载新增工具，Cursor/WorkBuddy 的既有桌面会话仍可能需要刷新 MCP 或重开会话。

使用：在客户端刷新 MCP 工具或重启客户端并新开会话；若客户端提示启用该服务器，正常启用即可。向 Agent 说：“使用 ai-browser-bridge 查看浏览器标签页，然后按我的任务操作。”无需再运行 agent.ps1，无需配置插件内模型。各客户端原有工具权限规则保持原样；避免多个 Agent 同时修改同一页面。

复核脚本：scripts/verify-agent-registration.mjs；结果：output/agent-registration/config-probe.json。
Codex 官方 MCP 文档：https://developers.openai.com/codex/mcp
