# csdn-publish

CSDN Markdown 编辑器自动发布的**站点专用配方** skill。与 `skills/cnipa-trademark-online/` 同一定位：只放站点知识，不修改 Bridge 核心（`src/` / `extension/` / `src/tools.js` / `extension/worker.js` / `src/tool-index.js`）。

| 文件 | 内容 |
|---|---|
| `SKILL.md` | `saveArticle` 只存草稿、真发布按钮 `button.btn-b-red`、`simulation-button` **已证伪勿回退**、草稿恢复、原生插图流程、摘要合规闸门与必填项、唯一可采信的成功判据、登录态前置检查、通道选择为何不写成永久禁区、环境准备规则 |
| `snippets/README.md` | 语言无关契约与机器判据的定位、边界、证据来源 |
| `snippets/publish-contract.md` | 6 阶段流程、页面选择器、成功/失败判据、已证伪结论清单（逐条带证据行号） |
| `snippets/verify-success.mjs` | 零依赖纯函数判据；`node verify-success.mjs --self-test` 自测 |

## 适用

涉及 `editor.csdn.net/md/`、`mp.csdn.net`、`/blog-console-api/v3/mdeditor/saveArticle`、`btn-b-red`、`btn-getdistill`、`simulation-button`、`uploadPicture`、`creation/success/<id>` 的 CSDN 发文任务。

## 验证状态（重要）

配方来自 2026-11-14 一次真实发布（外部 Playwright 链路，上线 `articleId=170777271`）。**同一次现场里 Bridge 链路未完成发布**（CSDN 编辑器页面上页面级命令整体超时），因此：

- 这里是「CSDN 怎么判断发布成功」的知识，**不是**「桥已能自动发 CSDN」的能力声明；
- 选择器来自当次 DOM，用前必须 `browser_observe` / `browser_find_element` 复核；
- 在 Bridge 工具上重放整套流程**尚未验收**；
- 2026-11-14 21:07 GMT+8 的 0.40.0 只读取证里，服务四证全通但 `browser_tabs` 返回空列表、**没有 CSDN 编辑器标签** ⇒ 现场现象未复现、未排除，见 [docs/LOCAL-EVIDENCE-20261114-runtime.md](../../docs/LOCAL-EVIDENCE-20261114-runtime.md)。

页面命令超时时转 [docs/TROUBLESHOOTING-MATRIX.md](../../docs/TROUBLESHOOTING-MATRIX.md)，不要靠反复点按钮硬闯；硬边界见 [docs/KNOWN-LIMITATIONS.md](../../docs/KNOWN-LIMITATIONS.md)。

## 「无 Python 的机器」怎么处理

不是项目运行时缺 Python（基座对 Python 零依赖，本轮**不引入嵌入式 Python**），而是外部发布链路把业务规则绑死在 `D:/A/python.exe` + Python Playwright + 独立调试配置上，换机即失效。解法是把**业务契约**与**驱动/环境值**分层：契约放 `snippets/`，本机值只由使用者在自己的环境准备文件里维护、换机只改一处。详见 [docs/PLAYWRIGHT-FALLBACK-DECISION.md](../../docs/PLAYWRIGHT-FALLBACK-DECISION.md) §1–§3。

## 先读

通用契约在 [skills/ai-browser-bridge/SKILL.md](../ai-browser-bridge/SKILL.md)。现场报告原文（`docs/FIELD-REPORT-20261114-csdn-autopublish-blockers.md`）与用户本机 Qoder 个人 skill 均为**本机输入文件，未纳入版本库**，clone 后不存在；本 skill 只读引用其证据行号，不修改、不依赖、不执行其中的脚本。
