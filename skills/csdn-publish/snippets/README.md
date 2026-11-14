# csdn-publish / snippets

把 CSDN 发布流程里的**业务契约**从「Python + Playwright 驱动」里剥离出来的产物。目标是：换一台机器、换一种浏览器驱动、甚至换一种语言，规则本身仍然可读、可复用。

| 文件 | 内容 | 依赖 |
|---|---|---|
| `publish-contract.md` | 语言无关的分阶段流程、页面判据、成功/失败判据、已证伪结论清单 | 无（纯文本） |
| `verify-success.mjs` | 把「唯一可采信的成功判据」写成零依赖纯函数；`node verify-success.mjs --self-test` 可自测 | 仅 Node 内置模块 |

## 边界（重要）

- **不进基座**：本目录不在 `src/` / `extension/` / `src/tools.js` / `src/tool-index.js` 里，不是 MCP 工具，不参与 `computeBuildIdentity()` 的哈希，不需要重启服务或重载扩展。
- **不碰 Playwright**：`verify-success.mjs` 不联网、不启动浏览器、不读写文件、不调 CDP，只判断「给定的观测值是否构成发布成功」。它连 `package.json` 的 `devDependencies.playwright` 都不引用。
- **不是已验收能力**：整套发布流程**未在 Bridge 工具链上重放验收**（见 [../SKILL.md](../SKILL.md) §0）。选择器来自 2026-11-14 现场 DOM，CSDN 前端可能改版，用前必须 `browser_observe` / `browser_find_element` 复核。
- **不含本机环境值**：`D:/A/python.exe`、独立调试配置路径、调试端口、账号与草稿 id 一律不写入本目录。若确需记录本机值，只放在使用者自己的环境准备文件里，换机只改那一处。
- **不含凭据**：按 `AGENTS.md:17`，文档只写「字段是否存在 / 长度 / 返回码」，不写 cookie、`UserToken`、`csrfToken` 的值。

## 证据来源

业务规则来自 2026-11-14 现场复盘与用户本机 Qoder 个人 skill（`C:\Users\love\.qoder\skills\csdn-autopublish\`）的**只读**提炼，行号在 `publish-contract.md` 里逐条标注。那个目录是**本机输入文件，未纳入版本库**，clone 后不存在；本目录不修改、不依赖、也不执行其中的任何脚本。

## 关联

- 站点配方：[../SKILL.md](../SKILL.md)
- 通道决策与 PoC 门槛：[../../../docs/PLAYWRIGHT-FALLBACK-DECISION.md](../../../docs/PLAYWRIGHT-FALLBACK-DECISION.md)
- 页面级命令超时的分诊：[../../../docs/TROUBLESHOOTING-MATRIX.md](../../../docs/TROUBLESHOOTING-MATRIX.md)
