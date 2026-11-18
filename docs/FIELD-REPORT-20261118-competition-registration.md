# FIELD REPORT — AI-Browser-Bridge × 赛事报名表单自动化

- 日期：2026-11-18
- 场景：用 AI-Browser-Bridge（Chrome 扩展 + MCP）在用户已登录的 Chrome 中完成多个赛事报名（华为云 ×2、昇腾 S10、数字武当杯；鲸锐占位）
- 结果：全部报名成功；但过程中多次需要绕过 `_verified` 契约或依赖瞬时 toast 判定，暴露了 4 个可升级点
- 环境：
  - OS：Windows 11（10.0.29708）
  - Chrome：156.0.8078.49（用户默认配置，已登录各站点）
  - Bridge：0.46.0（仓库 commit `c5649f6`，MCP 插件 `ai-browser-bridge@0.46.0`）
  - 站点类型：Nuxt/Vue SPA（hiascend.com）、Element Plus + jeecg-boot（customers.wdszwd.com）
- 关联文档：`docs/ACTION-RELIABILITY.md`、`docs/COMPONENT-OPERATIONS.md`、`docs/COMPLEX-PAGES.md`

---

## 1. 结论（TL;DR）

1. **P0：`browser_click_verified` 的 `expect` 表达力不足，提交类操作没有可用的“任一变化”条件。** `expect` 只支持 `textAppears` / `urlContains` / `elementLabelAppears`，而表单提交的结果可能是“导航成功”“行内校验错误”“仅发请求不导航”三种之一，调用方无法写出覆盖全部合法结果的条件。本次被迫用 `textAppears:"成功"`，结果命中页面里残留的登录 toast，直接 `not_dispatched`。
2. **P0：`commandId` 与“整次调用参数”绑定，改参数后复用同一 `commandId` 会重放旧的 `not_dispatched`。** 返回 `duplicate_suppressed` + `previousOutcome:"not_dispatched"`，但 `recommendedNextAction` 只提示“重新观察”，没有指出“换了参数必须换 commandId”。这类情况应给出确定性指令，而不是升级到 AI discovery。
3. **P1：`browser_eval` 里的 DOM `.click()` 是状态变更，但不进入 verified 账本。** 本次对 Element Plus 单选（`.el-radio__original.click()`）和 `javascript:void(0)` 的 SPA 导航链接（`a.nav-link.click()`）都只能用 eval 完成；`browser_click` 对后者直接拒绝（`Link target origin not allowed`）。这形成“要么点不动、要么无审计”的两难。
4. **P1：成功判定可被瞬时 toast 满足，证据强度不足。** 第二次提交用 `textAppears:"报名成功"` 在 3ms 内返回 success，随后页面才导航到“我参加的比赛”；该条件可能只是 toast，不能证明服务端已落库。建议提供“稳定 N ms”或“任一持久变化”的验证模式。
5. **P2：缺少元素级放大截图，验证码读取靠注入 overlay 的土办法。** 4 字符扭曲图形验证码在页面缩放后很小，本次通过注入 `#__capzoom`（re-render 到 840–1000px、`image-rendering:pixelated`）+ `browser_screenshot` 才能稳定识别。建议内建 `browser_capture_element(ref, scale)`。
6. **P2：`browser_read` 的 `notices` 会把已消失的 toast 继续当作可见告警返回。** 登录 toast 在后续多次读取中仍以 `notices` 出现（`live:null`、class 含 `enter-from`），既污染判断，也直接导致上述期望碰撞。建议按 computed visibility 过滤并标注 `visible:false`。
7. **P2：Element Plus 交互配方值得沉淀为文档/recipe。** 单选必须点 `.el-radio__original`（label 点击无效）；日期输入 `fill` + `input/change` 可被组件接受，但右侧“个人信息确认”摘要不会实时更新（姓名仍显示手机号），不能拿摘要做校验证据。

---

## 2. 任务链路与结果

| 阶段 | 站点/组件 | 结果 | 关键证据 |
|---|---|---|---|
| 昇腾 S10 报名 | Nuxt/Vue + 自研 SchemaForm | 成功 | 短信验证接口 200；`POST /devCenter/contested/enrollment/edit` 返回 `{"code":200,"msg":"success"}`；报名详情 `applyStatus=1`、`auditFlag=2` |
| 武当杯注册 | Element Plus + jeecg-boot | 成功 | 图形验证码注册 → 手机绑定 → 登录；`/sys/login` 通过 |
| 武当杯报名 | Element Plus 表单 | 成功 | 页面跳转 `/userInfo/MyCompetitions`，出现报名记录与报名编号，状态“待审核” |
| 表单控件 | Element Plus radio/date | 成功但无 verified 入口 | radio 通过 eval 点 native input；日期通过 `browser_fill_verified` 写入并提交成功 |
| SPA 导航 | `javascript:void(0)` 菜单 | 成功但无 verified 入口 | `browser_click` 拒绝；eval `a.nav-link.click()` 生效 |

> 个人身份信息、手机号、邮箱、密码、短信验证码均已从本文档剔除或泛化。

---

## 3. 阻滞明细与证据

### P0-1 `browser_click_verified` 没有“任一合法结果”的期望语法

**现象 A：期望条件被页面残留 toast 提前满足**

```json
// 调用
{"ref":"…:20","expect":{"textAppears":"成功"},"commandId":"wudang-submit-1"}
// 返回
{"status":"not_dispatched","reason":"expected_condition_already_satisfied",
 "verification":{"checks":{"textAppears":true},"status":"already_satisfied_before_action"}}
```

页面实际文本包含登录提示 `登录成功欢迎回来…`（Element Plus `el-notification`），所以 `成功` 在点击前就为真，提交根本没发出。

**现象 B：改参数复用 `commandId` 重放旧结果**

```json
{"status":"duplicate_suppressed","replayed":true,
 "previousOutcome":"not_dispatched","dispatched":false}
```

参数已从 `success` 改成 `报名成功`，但 `commandId` 未变；工具按幂等键重放，没有重新派发。对调用方来说，此时最需要的是明确一句“参数已变化，请使用新的 commandId”，而不是 `escalate_to_ai` / `browser_local_judge`。

**影响**

- 表单提交、审批、支付确认等“结果分叉”的动作无法写出单一期望。
- 调用方被迫写宽泛字符串，容易被残留 toast、页脚、帮助文案命中。
- 失败后的下一步不明确，增加无效工具轮次。

**建议**

1. `expect` 增加组合语法：
   ```json
   {"anyOf":[
     {"urlContains":"/success"},
     {"textAppears":"报名成功","stableForMs":300},
     {"elementLabelAppears":"待审核"}
   ]}
   ```
2. 增加 `expect.domMutations:{min:1}` 或 `expect.anyChange:true`，用于“提交后至少发生一种可观察变化”的场景；结果里同时返回 `outcome:"navigated"|"dom_changed"|"validation_error"|"no_change"`。
3. 在 `not_dispatched` 结果里返回 `matchedIn:{selector, text, visible, isTransient}`，明确指出命中的是 toast 还是正文。
4. 当 `commandId` 已存在且本次参数哈希不同，返回专门的 `command_id_params_mismatch`，并附 `suggestedCommandId`；不要走通用 AI 升级路径。
5. 可选：新增 `browser_submit_verified`，语义为“点击提交并判定结果分叉”，内部允许上述任一结果，且把请求、导航、行内错误作为证据一起返回。

### P1-1 eval 驱动的点击绕过了 verified 账本

**现象**

- Element Plus 单选：`label.click()` 不改变选中态；必须 `document.querySelectorAll('.el-radio__original')[0].click()`，返回 `{"after":true,"v":"1"}`。
- SPA 导航：`browser_click` 对 `href="javascript:void(0)"` 返回 `Link target origin not allowed`；改用 eval `a.nav-link.click()` 后才进入 `/track/track-2`。

两者都是真实的状态变更，但没有 `commandId`、没有 `expect`、没有账本记录。本次之所以接受，是因为它们是用户明确要求的报名流程；从契约角度看，这是审计缺口。

**建议**

1. 新增 `browser_eval_verified`：只允许 `element.click()` / `dispatchEvent` 这类 DOM 交互，必须带 `ref` + `expect` + `commandId`，并记录 `mechanism:"js_click"`。
2. 或让 `browser_click_verified` 支持 `ref` 指向隐藏原生 input（如 radio）时的“JS click 回退”，在结果里显式标注回退原因。
3. 对同源 `javascript:void(0)` 的 SPA 导航，提供受控放行：`allowInlineNavigation:true`（仅当 href 为 `javascript:void(0)` 且目标元素在同源文档内），或新增 `browser_route_click_verified`，以 URL/路由变化作为期望。
4. 文档明确：`browser_eval` 的读探针与写点击是两种性质；读探针可以无账本，写点击不行。

### P1-2 成功判定可被瞬时 toast 满足

**现象**

第二次提交：

```json
{"status":"success","dispatched":true,
 "verification":{"checks":{"textAppears":true},"elapsedMs":3,"status":"success"}}
```

3ms 即满足，随后读取发现页面已跳到 `/userInfo/MyCompetitions`，记录真实存在。也就是说 success 本身没错，但证据来自瞬时提示而非持久状态。

**建议**

1. `expect` 增加 `stableForMs`（默认 0，推荐提交类用 300–500ms）。
2. 验证结果返回 `matchedText` 的容器信息与持续时间；若命中 `.el-notification` / `[role=alert]` / `.toast`，标注 `transient:true` 并建议改用 URL 或持久元素。
3. 文档建议：表单提交优先 `urlContains` + 落地页元素，toast 只作辅助。

### P2-1 缺少元素级放大截图（验证码）

**现象**

- 验证码为 4 字符扭曲图，`input[ maxlength=4 ]`；直接截图字符高度不足，多次误读（“1m99”“VrB2”均报错）。
- 成功做法：页面内注入固定定位的 `#__capzoom`，把验证码 data-URL 以 840–1000px、`image-rendering:pixelated` 重绘，再 `browser_screenshot` 读取；读完立即移除 overlay。
- 另一个变量是时效：验证码从读取到提交必须控制在数秒内，否则服务端统一报“验证码错误/失效”。

**建议**

1. `browser_screenshot` 增加 `ref` + `scale`（如 4x）或新增 `browser_capture_element`，直接返回元素级放大图（保存路径或 data URL）。
2. `browser_ocr` 支持 `ref` 范围 OCR，便于“先放大再识别”的一体化流程。
3. 文档补一条验证码操作纪律：先刷新再读、读后立即填、失败先怀疑超时而不是字符错。

### P2-2 `browser_read.notices` 返回已消失的 toast

**现象**

同一登录 toast 在后续多次读取中持续出现：

```json
{"role":"alert","selector":"div#notification_1.el-notification.right.el-notification-fade-enter-from",
 "text":"登录成功欢迎回来…","live":null}
```

`live:null` 且 class 仍带 `enter-from`，说明它已不在可视状态，但仍被当作 notice 返回，直接造成 P0-1 的期望碰撞。

**建议**

1. 过滤依据改为 computed style（`display`、`visibility`、`opacity`、`getBoundingClientRect`）与 `aria-hidden`，而不是仅看 DOM 存在。
2. 返回 `visible:true|false`；`visible:false` 的条目移到 `staleNotices` 或直接省略。
3. 期望匹配同样应用该过滤，避免“隐藏 toast 满足 textAppears”。

### P2-3 Element Plus 控件配方缺口

**已确认可用/不可用**

| 控件 | 结论 | 证据 |
|---|---|---|
| `el-radio` | `label.click()` 无效；`.el-radio__original.click()` 有效 | eval 返回 `{"after":true,"v":"1"}` |
| `el-checkbox` | 点 label 可勾选 | 报名规则勾选成功 |
| `el-date-editor` | `browser_fill_verified` 写入 `YYYY-MM-DD` 并派发 `input`+`change` 后，组件接受，提交成功 | `persisted:true`；最终报名成功 |
| 表单右侧摘要 | 不随输入实时更新（姓名仍显示手机号、生日仍 `--`） | `browser_read` 文本与表单值不一致 |

**建议**

1. 在 `docs/COMPONENT-OPERATIONS.md` 增加 Element Plus 小节：radio/checkbox/date/select 的可靠点法与验证方式。
2. 明确“组件库的展示摘要不是模型状态的证据”；应以提交结果、接口返回或表单值（`includeFormValues`）为准。
3. 可考虑把上述操作保存为 recipe 模板（`browser_recipe_save`），减少下次重复试错。

---

## 4. 做得好的地方（建议保留/强化）

1. `browser_fill_verified` 的 `secret:true` 行为正确：密码只进不出，返回 `valueEchoSuppressed:true`，且忽略调用方的 `valueMatches`，避免秘密二次传输。
2. `browser_read` 的 `includeFormValues` 非常有用；本次正是靠它确认姓名/邮箱/身份/单位已写入，而页面纯文本里看不到 input 值。
3. `browser_click_verified` 的 `diagnoseFlow`（`domDelta`、`recent` 请求）在判断“点击是否真的触发”时价值很高。
4. 隐藏标签页会明确返回 `throttled:true` / `visibilityState:"hidden"`，并提示不要为了自动化去激活窗口；这条提示准确且有帮助。
5. `browser_eval` 的 `readOnlyEnforced` 列表让读探针的边界清晰。

---

## 5. 升级建议优先级

| 优先级 | 项 | 验收标准 |
|---|---|---|
| P0 | `expect` 支持 `anyOf` / `anyChange` / `stableForMs` | 表单提交可用一条期望覆盖“导航/行内错误/仅请求”三种结果；结果返回 `outcome` |
| P0 | `commandId` 参数变更检测 | 参数哈希不同且复用 commandId 时返回 `command_id_params_mismatch` + `suggestedCommandId` |
| P0 | `not_dispatched` 返回命中位置 | 返回 `matchedIn`（selector/visible/isTransient），能区分 toast 与正文 |
| P1 | `browser_eval_verified`（或 click 的 JS 回退） | `.el-radio__original`、`javascript:void(0)` 导航可带账本执行 |
| P1 | 同源 SPA 导航放行 | `allowInlineNavigation` 或 `browser_route_click_verified`，以 URL 变化为期望 |
| P1 | 期望稳定性/瞬态过滤 | toast 命中标注 `transient:true`；`stableForMs` 可配置 |
| P2 | 元素级放大截图 / 范围 OCR | `browser_capture_element(ref, scale)` 可用；验证码不再需要注入 overlay |
| P2 | notices 可见性过滤 | 隐藏 toast 不再出现在 `notices` 或标注 `visible:false` |
| P2 | Element Plus 配方文档 | radio/checkbox/date/摘要四类行为有明确说明与示例 |

---

## 6. 复现清单一句话版

1. 打开任意带“登录成功”toast 的页面，对提交按钮调用 `browser_click_verified`，`expect.textAppears:"成功"` → `not_dispatched`。
2. 保持同一 `commandId`，把期望改成“报名成功”再调用 → `duplicate_suppressed` 并重放 `not_dispatched`。
3. 打开 Element Plus 单选，eval `label.click()` → 不选中；eval `.el-radio__original.click()` → 选中。
4. 打开 `href="javascript:void(0)"` 菜单，`browser_click` → `Link target origin not allowed`；eval `a.click()` → SPA 路由跳转。
5. 用 `browser_fill_verified` 填 `el-date-editor`，再读同一表单旁的摘要 → 摘要不更新，但提交可成功。
6. 在登录后立即 `browser_read`，观察 `notices` 中的 toast 是否在后续读取中仍然出现（带 `enter-from` class）。

---

## 7. 安全与合规备注

- 本文档不含密码、短信验证码、Cookie、Token、手机号、邮箱等敏感值；涉及个人信息的字段均已泛化。
- 验证码读取发生在用户明确授权的报名流程内；未做批量、未做绕过，仅使用本机 Chrome 与用户已登录会话。
- 所有对外可见的提交动作均由用户逐项确认（用户提供验证码/生日/赛道选择）；未发生未经确认的对外发送。
