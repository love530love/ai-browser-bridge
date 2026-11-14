# csdn-publish

CSDN Markdown 编辑器自动发布的**站点专用配方** skill。与 `skills/cnipa-trademark-online/` 同一定位：只放站点知识，不修改 Bridge 核心（`src/` / `extension/` / `src/tools.js` / `extension/worker.js` / `src/tool-index.js`）。

| 文件 | 内容 |
|---|---|
| `SKILL.md` | `saveArticle` 只存草稿、真实发布按钮 `button.btn-b-red`、隐藏 `simulation-button` 的假成功陷阱、摘要合规闸门与必填项、唯一可采信的成功判据、登录态前置检查与处置边界 |

## 适用

涉及 `editor.csdn.net/md/`、`mp.csdn.net`、`/blog-console-api/v3/mdeditor/saveArticle`、`btn-b-red`、`btn-getdistill`、`creation/success/<id>` 的 CSDN 发文任务。

## 验证状态（重要）

配方来自 2026-11-14 一次真实发布：Playwright 1.58 + `connect_over_cdp` + 独立调试配置，上线 `articleId=170777271`。**同一次现场里 Bridge 链路未完成发布**（CSDN 编辑器页面上页面级命令整体超时），因此：

- 这里是「CSDN 怎么判断发布成功」的知识，**不是**「桥已能自动发 CSDN」的能力声明；
- 选择器来自当次 DOM，用前必须 `browser_observe` / `browser_find_element` 复核；
- 在 Bridge 工具上重放整套流程**尚未验收**。

页面命令超时时转 [docs/TROUBLESHOOTING-MATRIX.md](../../docs/TROUBLESHOOTING-MATRIX.md)，不要靠反复点按钮硬闯；硬边界见 [docs/KNOWN-LIMITATIONS.md](../../docs/KNOWN-LIMITATIONS.md)。

## 先读

通用契约在 [skills/ai-browser-bridge/SKILL.md](../ai-browser-bridge/SKILL.md)。现场报告原文（第三方归档路径，可能未纳入版本库）：`docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md`。
