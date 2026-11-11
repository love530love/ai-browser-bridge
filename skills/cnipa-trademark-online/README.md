# cnipa-trademark-online：CNIPA 商标网上服务系统站点配方（索引）

面向 AI Agent 的操作契约在 [`SKILL.md`](SKILL.md)。本文件是给人看的索引：说明能力包来源、文件结构、与 Bridge 核心的边界，以及哪些属于站点知识而非桥缺陷。中文写作；代码里的字符串/键名用 ASCII 直引号。

## 这是什么 / 不是什么

把 2026-11-11 用 AI-Browser-Bridge 完成 CNIPA 新系统 4 件业务（驳回复审 1 件、无效宣告 2 件、注册申请 1 件，申请号 94896138）时沉淀的**站点专用知识**，从会话里搬进项目内的 skill 能力包。结论是：站点知识不硬编码进 Bridge 核心，而放进 skill；通用能力缺口由 Bridge 自己修。对应升级方案里程碑 **M4（recipe 化）**。

**不是**：Bridge 的修复清单、部署脚本、账号凭据库、法律意见书，也不承诺审查结果。

## 来源

| 来源 | 路径 | 作用 |
|---|---|---|
| 外部能力包（实测沉淀源码，本次落地的内容来源） | `J:\WorkAndData\双柏彝笙商城\80_工具与脚本\01_能力包_CNIPA\` | README / CHANGELOG / `snippets/` 3 段 JS / `runbooks/` 4 份 / `checklists/` 2 份 / `scripts/` 3 个 Python / `templates/` 1 个 xlsx / `cases/94896138_彝笙缘三类/` |
| 现场报告 | [`docs/FIELD-REPORT-20261111-cnipa-toas-review.md`](../../docs/FIELD-REPORT-20261111-cnipa-toas-review.md) | §三 antd 交互配方、§四 站点侧坑、§五 可复现完整路径、§七 注册模块补充（P1-7~P2-5） |
| 升级方案 | [`docs/UPGRADE-PLAN-20261111-cnipa-site-feedback.md`](../../docs/UPGRADE-PLAN-20261111-cnipa-site-feedback.md) | §3 站点专用 recipe 清单、§5 M4 验收、§6 不建议在 Bridge 层解决的事项 |
| Bridge 操作契约（风格与上位约定） | [`skills/ai-browser-bridge/SKILL.md`](../ai-browser-bridge/SKILL.md) | 连接、verified 写、重新观察、hostId、PII/凭据纪律 |

外部能力包是**项目外的自办实操沉淀**；本目录只挑选其中**有复用价值的 JS 片段**落地并写清出处，不复制二进制 xlsx，不大段搬无注释代码，也不把含真实个人信息的内容原样带进来（见下方「PII 与纪律」）。

## 文件结构

```
skills/cnipa-trademark-online/
├─ SKILL.md          面向 AI Agent 的操作契约（两套系统、antd/Vue 配方、商品弹窗、
│                    上传路径、站点坑、30 分钟复现清单）
├─ README.md         本文件（来源 / 结构 / 边界 / 版本状态 / PII 纪律）
└─ snippets/         可复用的页面内 JS 助手（每段顶部注明适用场景、来源、已知限制）
   ├─ antd-input.js        antd 5 / ant-design-vue 受控表单填表 + 遮罩清理
   ├─ vue-form-model.js    Vue 3 表单模型探针（PII 安全：默认只回字段名/空字段）
   ├─ upload-workaround.js 隐藏 file input 的本地 HTTP 中转上传（替代路径）
   └─ goods-dialog.js      商品弹窗逐条检索勾选 + Jeecg 菜单（按文字配方固化，待验证）
```

片段与外部能力包的对应关系：

| 本目录文件 | 外部来源 | 处理 |
|---|---|---|
| `snippets/antd-input.js` | `snippets/antd_forms.js` | 保留核心助手，补出处与限制注释 |
| `snippets/vue-form-model.js` | `snippets/vue_form_probe.js` | 改为**默认不回显任何表单值**，按需单字段读取，落实 PII 警告 |
| `snippets/upload-workaround.js` | `snippets/local_upload.js` + `scripts/local_upload_server.py` + 现场报告 §一 P0-3 | 保留 fetch→File→DataTransfer→change，补版本说明 |
| `snippets/goods-dialog.js` | 升级方案 §3、现场报告 §七 P1-9、外部 `runbooks/01_注册申请.md` §5、`cases/.../README.md` | 外部无同名 JS；按文字配方固化，明确标注「未逐选择器实测」 |

## 与 Bridge 核心的边界

- **本目录只新增 skill 文件**。绝不改 `src/*`、`extension/*`、`tools.js`、`worker.js`、`tool-index.js`、根 `README.md` / `CHANGELOG.md` / `AGENTS.md` / `package.json`、任何 `.bat` / `.ps1`（由主 agent 负责）；不碰 `coordination/`、`.aep/`、`docs/AGENT-HANDOFF-HUMAN-UI.md`（别的会话的并行改动）；不做 `git add` / `commit` / `push`。
- **站点知识 → skill**：Vue3/qiankun 表单模型、商品弹窗、Jeecg 菜单、antd 交互配方、业务校验规则、二维码/缴费/送达流程，都放这里，不进 Bridge 源码。
- **通用能力缺口 → Bridge 核心**：升级方案 §1/§2 的 P0/P1 由 M1/M2/M3 修，skill 只调用、不补洞。包括：上传 MIME 表与显式 `mimeType`（P0-1）、`browser_upload` 的 `selector` / `inputIndex`（P0-2）、上传上限可配置与 `uploadRoots` 热加载（P0-3）、`effect` 诊断 / `visibilityState` / `flow` 证据链 / `stale_ref`（P1-1/2/6/7）、`browser_wait_for_selector` / `find_element` 自动滚动 / `includeFormValues`（P1-3/4/5）。

### 哪些是站点知识而非桥缺陷

以下都写进 skill / 检查清单，**不是 Bridge 的 bug，不要在 Bridge 层「修」**（现场报告 §四、§六、§七，升级方案 §6）：

- 「阐述事实与理由」200 字硬上限且无 `maxlength`；地址必须以「省+市+县/区」开头、默认只填到县区级；下拉 `+ 0` 透明占位。
- 提交需微信小程序扫码，二维码 108 秒 / 2 分钟过期，无刷新入口；扫码必须本人，无法自动化。
- 缴费递延（当天账单为空属正常）、电子送达路径、未缴费视为未提出申请。
- 子步骤切换重挂载导致表单值/附件/图样被重置；预览页用 `textarea` 渲染值。
- Vue 生产包暴露 `formNewState` / `isRules`（站点实现细节，可诊断但会随改版失效）。
- 商品「按名称关键词搜、C 开头中国特有编码不能按编码搜」；官方「商品导入」Excel 为死按钮；Jeecg 菜单 DOM 结构。
- 【已提交】列表「下载」按钮无响应（站点自身缺陷），归档用 `browser_pdf_save` 替代。
- 三个下拉共用同一 `id`、`document.hidden` 与窗口焦点脱钩等站点/浏览器表现。

## 版本状态：区分「已有 / 本轮新增 / 替代路径 / 待验证」

- **已有**：`browser_upload` 对不可见元素本身不设限（0.37.4 源码复核），卡点只在 ref 获取；`browser_pdf_save` 归档可用。
- **本轮 M1 新增（正在实现，未在本 skill 全部验证）**：`browser_upload` / `browser_upload_verified` 的 `selector` / `inputIndex`、显式 `mimeType`、常见文档 MIME 表。SKILL.md §5 要求**优先**用它，但用前先用 `browser_capabilities` 确认。
- **替代路径**：旧版本或该能力不可用时，才用本地 HTTP 服务 + 页面内 `fetch → File → DataTransfer → change`（`snippets/upload-workaround.js`）。2026-11-11 四案实测走的是这条，不能因为写了它就宣称「桥已修复」。
- **待验证**：`snippets/goods-dialog.js` 的选择器来自文字配方，未按实际 DOM 逐项实测；站点改版会使所有选择器、字段 id、`code` 参数失效，以 `browser_observe` 为准。

不要声称这些配方已在当前 Bridge 版本全部验证通过。

## PII 与纪律

- **有意省略**（因 PII 或版权/版本差异）：外部案例里的申请人详细地址门牌号、扫码人姓名、流水号、营业执照号 / 身份证号及 OCR 正文、案件台账绝对路径；含真实个人信息的 `cases/.../README.md` 正文、`templates/` 二进制 xlsx、3 个 Python 工具脚本、`runbooks/` / `checklists/` 全文均未原样搬入。申请号 `94896138` 仅作为**示例编号**出现；评审号、注册号、流水号等案卷标识一律不写入。
- Vue 表单模型含身份证 / 营业执照 OCR 结果：`snippets/vue-form-model.js` 默认只返回组件名与状态键名，`SKILL.md` §3 明确「日志里不要整包打印」。
- 账号密码只在会话内使用，绝不写入任何文件、日志、脚本；扫码只能申请人本人完成，agent 不代扫、不代持密码。
- 本包不代替审查、不承诺结果；商品名称、类似群、编码、官费以提交日官方数据为准，逐案确认后再缴。
