# CSDN 文章发布：语言无关业务契约

> 本文件只描述**站点怎么运作**和**怎样才算成功**，不含任何 Python / Playwright / CDP API、本机路径、账号值或凭据。可复算的机器判据在 [`verify-success.mjs`](verify-success.mjs)。
>
> 证据记号：`S` = 用户本机 `C:\Users\love\.qoder\skills\csdn-autopublish\SKILL.md`；`L` = 同目录 `scripts/csdn_lib.py`；`P` = `scripts/csdn_publisher.py`；`SKILL` = 本仓库 [../SKILL.md](../SKILL.md)。带这些记号的路径都是**本机输入文件，未纳入版本库**，clone 后不存在，仅用于证据定位。

---

## 0. 已证伪结论（**勿回退**）

| 旧结论 | 现状 | 证据 |
|---|---|---|
| 点隐藏 `button.simulation-button` 就是真发布 | **已证伪**。它只触发自动保存，文章留在草稿箱，制造「草稿假成功」 | `S:104`（2026-11-14 修正声明）、`S:247-251`（实测相反） |
| `POST /blog-console-api/v3/mdeditor/saveArticle` 返回 `code=200` + `data.id` = 发布成功 | **已证伪**。那是自动保存/草稿接口 | `S:253-260`、`SKILL §1` |
| 打开 `/md/` 得到空白编辑器 | **已证伪**。会带出旧草稿（含欢迎模板） | `S:295-301` |
| `input.cfw-file-input` 是插图用的 file input | **已证伪**（红鲱鱼）。真 input 是 `div.uploadPicture input[type=file]` | `S:203-210` |
| 摘要留空也能提交 | **已证伪**。摘要 < 10 字被前端静默拦截，可能不报错 | `S:263-266`、`L:344` |
| CSDN 编辑器「永久不可用扩展桥」 | **既未证实也未证伪**。只是 2026-11-14 单次现场观察；按产品方向「不设能力禁区」，不写成永久禁区 | `S:24`、`docs/PLAYWRIGHT-FALLBACK-DECISION.md` §2 |

> 旧结论残留比没有更危险：若在任何 skill / 脚本里看到「必须 JS 点 `simulation-button`」这类表述，按 `S:131,135,106` 判断为未同步的历史残留，**不要照做**。

---

## 1. 阶段 A — 前置（只读）

| 动作 | 判据 | 失败时 |
|---|---|---|
| 确认登录态 | 只回读「字段是否存在」，不回读值 | 缺失就停，不要试图绕过登录或验证码 |
| 确认宿主 / 标签 | 显式绑定目标标签；读取页面 URL 与结构 | 服务级命令正常但页面级超时 → 转 `docs/TROUBLESHOOTING-MATRIX.md` §1 |
| 复核选择器 | 用当前页面观察结果逐一比对下表 | 不匹配就停；CSDN 前端可能改版 |

**不采信的弱信号**（任一出现都**不能**写成发布成功）：按钮被点过、`status:success`、请求 200、草稿 id 存在、编辑器提示「已保存」、调用方自述「已完成」。

## 2. 阶段 B — 草稿恢复与内容导入

1. 打开编辑器后若 URL 自带 `articleId`（旧草稿），正文可能是「欢迎使用Markdown编辑器」模板（`S:296`）。
2. 导入新内容前先清空正文：点到正文编辑区 → 全选 → 删除；回读 `pre.editor__inner` 的文本长度 < 200 且不含欢迎模板文字（`S:298`、`L:133-142`）。
3. 去掉导入内容自身的首个 H1（标题走标题栏，不重复出现在正文）（`S:299`、`L:157-159`）。
4. **不要删除用户的旧草稿**（`S:301`）。
5. 标题走 `.article-bar__title-display` → `.article-bar__title--input` 的可交互输入；直接改隐藏 input 不生效（`L:219-223`）。
6. 正文就绪判据：`pre.editor__inner` 存在且可观察（`L:119`）。

## 3. 阶段 C — 原生插图（保持 Markdown 图片链接语义）

1. 找到目标章节的 `.cledit-section` 块，把光标定位到块首（现场做法是点块左上偏移后按 `Home`）（`S:216`）。
2. 触发图片按钮，选中 `div.uploadPicture input[type=file]` 上传（`S:206`）；**不是** `input.cfw-file-input`。
3. 等待 `pre.editor__inner` 的 innerText 出现新增 `https://i-blog.csdnimg.cn/…` 形式图片链接（`S:209`、`L:239,260`）。
4. 位置校验：新图片所在 section 的索引应为「目标标题 section 索引 − 1」（`S:218`）。**注意：这是现场文字规则，脚本里未找到对应实现**，属待实现校验，不要写成已自动化。
5. 收起弹层（现场用 `Esc`）；**全程不重新导入正文**（`S:219`）。
6. 完整性检查：线上图片数量、空链接数量（`L:98-101`、`P:71-79`）。线上图片不足或存在空链接就跳过发布，不要带病提交。

## 4. 阶段 D — 发布弹窗必填项（发布前闸门）

| 项 | 页面判据 / 选择器 | 合格条件 | 证据 |
|---|---|---|---|
| AI 摘要闸门 | `button.el-button.btn-getdistill` / `button.btn-getdistill` | 生成后摘要长度显著增加；若侧栏出现「抱歉 / 无法回答 / 不符合规范 / 违规」等，判为**内容不合规，停止发布** | `S:82`、`L:449-489`、`L:168-170` |
| 摘要 | `div.desc-box textarea` | 长度 ≥ 10 字 | `S:265`、`L:344` |
| 标签 | `input.tag__option-chk` | ≥ 1（现场上限 3） | `S:88`、`L:270-276` |
| 创作声明 | `.creation-statement-select` → 可见 `.el-select-dropdown__item` | 已选定（现场选项「个人观点，仅供参考」） | `S:90`、`L:291-301` |
| 封面 | `.cover-upload-box input[type=file]` → `.vicp-operate-btn` | `.container-coverimage-box img` 的 src 指向 `i-blog.csdnimg.cn` | `S:89`、`L:245-260` |
| 文章类型 / 可见范围 | `label.lab-switch`、`label[for=multiPlatformPublishYes/No]` | 与预期一致 | `L:416-437,498-500` |
| 分类专栏（可选） | `.form-entry` 内 `input.tag__option-chk[value=…]` | — | `L:388-389` |

**关键**：这些项不合格时的表现常常是「点了发布但没反应」，而不是红色报错。必须先做「字段齐全 → 才允许点发布」的显式检查，不要点完靠超时猜原因（`SKILL §3`）。

## 5. 阶段 E — 发布动作

1. 定位**可见**按钮：文本精确为「发布文章」且 class 含 `btn-b-red`；多个候选时取纵向位置最靠下的那个（弹窗底部主按钮），并在点击前用「文本 + 类名 + 可见」三重确认（`S:248-249`、`L:516-536`）。
2. 候选不唯一、文本相似、共享父容器时**拒绝点击**，不按几何顺序猜。
3. 点击后立刻回读 URL 与提示，不要采信「已派发」。
4. 发布是**对外可见的写操作**：结果不确定时绝不重放，先重新观测；用幂等键记录已派发的动作（`SKILL §5`、`AGENTS.md:24-26`）。
5. 限流：现场观察到 `code!=200` 且 message 命中「频繁 / 限制 / 过快 / 稍后」时需退避（现场参数 ~120s、最多 5 次、轮询 90s），这是**站点行为观察**，不是通用常量（`L:547,585,591`）。

> `S:250` 保留了一条「12s 内既无响应也无跳转才 JS 点隐藏 `simulation-button`，仅作 legacy fallback」的历史兜底。**本契约不采用**：它属于 §0 已证伪结论，且违反「不确定结果不重放」。

## 6. 阶段 F — 唯一可采信的成功判据

**满足其一且要有回读证据**：

1. URL 跳转到 `/mp_blog/creation/success/<id>`（正则 `/\/mp_blog\/creation\/success\/(\d+)/`，`L:587,602,618,621`）；或
2. 页面出现明确「发布成功 / 发布完成」提示，且提示中不含「继续发布 / 确认发布 / 仍要发布」等否定语境（`L:594-599`）。

**更强的外部回读**（现场补充，`S:257-259`）：创作中心列表显示「已发布」**且**文章公开页返回 HTTP 200。

**一律不算**：`saveArticle` 200、`data.id`、按钮已点击、`status:success`、草稿箱里有文章、调用方自述。机器可执行版本见 [`verify-success.mjs`](verify-success.mjs)。

## 7. 决策树（简版）

```
前置只读通过?
  ├─ 否 → 停止，按排障矩阵分诊；不归因、不重放
  └─ 是 → 草稿已清空且内容导入正确?
           ├─ 否 → 修正后重读
           └─ 是 → 插图位置与链接完整性通过?
                    ├─ 否 → 跳过发布
                    └─ 是 → 摘要/标签/声明/封面齐全?
                             ├─ 否 → 补齐后重读
                             └─ 是 → 唯一候选 btn-b-red 可见?
                                      ├─ 否 → 拒绝点击
                                      └─ 是 → 派发一次 → 立刻回读
                                               ├─ 命中成功判据 → published，记录 id
                                               ├─ 明确失败 → 报告原因
                                               └─ 结果未知 → unknown，重新观测，绝不重放
```

## 8. 刻意不包含的内容

- 解释器路径、调试 profile 路径、`--disable-extensions`、`--remote-debugging-port`、`connect_over_cdp`、profile 克隆与 cookie 处理、进程强杀命令：全部是**绑死本机与驱动**的实现细节（`S:35,39,287-293,311`、`L:8-11,110-112`），且与 `AGENTS.md:10/12/16` 冲突，见 [../../../docs/PLAYWRIGHT-FALLBACK-DECISION.md](../../../docs/PLAYWRIGHT-FALLBACK-DECISION.md)。
- 任何凭据值、账号 id、草稿 id：按 `AGENTS.md:17` 不写。
- 「CSDN 编辑器必须走哪条浏览器通道」的结论：只有单次现场观察，归因待 0.40.0 真实环境复现，见 [../../../docs/LOCAL-EVIDENCE-20261114-runtime.md](../../../docs/LOCAL-EVIDENCE-20261114-runtime.md) §4（本轮标签清单为空，前提不成立，未复现）。
