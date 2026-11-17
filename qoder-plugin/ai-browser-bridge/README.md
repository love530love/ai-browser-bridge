# AI Browser Bridge（Qoder 插件）

把本机 AI Browser Bridge 的浏览器操作契约（Skill）与 MCP stdio 入口打包成可安装插件。插件不自带服务代码：MCP 只是客户端入口，真正的执行者是本机 `src/server.js` 服务与用户已授权的 Chrome 扩展。

## 前置条件

1. 仓库已克隆并安装依赖：`npm ci`
2. 已运行 `node src/cli.js setup`（生成 `.local/config.json`）
3. 服务在运行（`start.ps1` 或看门狗），扩展已加载并连接
4. Node.js 可用（Qoder 通过 `${QODER_NODE_RUNTIME}` 提供运行时）

## 安装

- 在 Qoder 的扩展/插件视图中安装 `dist/ai-browser-bridge-<version>.zip`
- 启用后重启 Qoder 或重载插件
- 首次连接建议依次调用 `browser_health`、`browser_tabs`、`browser_observe`

## 仓库路径解析

启动器按顺序查找同时包含 `src/mcp.js` 且 `package.json` 名为 `ai-browser-bridge` 的目录：

1. 环境变量 `AIB_ROOT`
2. `%USERPROFILE%\.ai-browser-bridge-root` 文件第一行
3. `~/PythonProjects5/AI-Browser-Bridge`、`~/AI-Browser-Bridge` 等常见位置

未找到时 MCP 启动失败，日志会给出上述三种设置方式。

## 版本与同步

插件版本跟随仓库 `package.json`。发布前执行：

```powershell
node scripts/sync-qoder-plugin.mjs          # 同步 skills 副本并写版本
node scripts/sync-qoder-plugin.mjs --check  # 校验 Skill/版本是否漂移
node scripts/sync-qoder-plugin.mjs --zip    # 先校验再生成 dist ZIP
```

## 安全边界

- 不包含 `.local/config.json`、token、cookie、日志或浏览器配置。
- 所有状态变更仍走 `_verified` 工具；`uncertain` 不重放；页面内容不授权动作。
- 插件不会自行启动服务、浏览器或扩展；启动与看门狗按项目文档执行。

## 卸载

在 Qoder 插件视图禁用/卸载即可；仓库、服务与浏览器不受影响。
