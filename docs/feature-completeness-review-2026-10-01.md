# AI-Browser-Bridge v0.4.1 功能完善度审议报告

- **项目**：AI-Browser-Bridge（本机 AI 浏览器控制桥，MV3 扩展 + 本机服务，已激活可用）
- **审议日期**：2026-10-01
- **审议方式**：四视角并行只读审查（安全/权限、自动化可靠性、内容识别与资源嗅探、刁蛮用户），基于真实源码交叉核对；关键事实已由主代理复核澄清。
- **源码基准**：`src/tools.js`（31 工具）、`src/server.js`、`extension/worker.js`、`extension/page.js`、`extension/manifest.json`、`README.md`、`AGENT-QUICKSTART.md`、`docs/`，并对照实验版 `AI-Browser-Bridge-agent`（`content.js` / `protocol.ts` / `README.md`）。

---

## 0. 一句话总评

读 / 写 / 选 / 传 / 截 / 诊断这条**主框架控制链路完整且安全保守**，但「嗅探隐藏资源、获取完整源码、调动下载、图片识别、iframe/Shadow DOM 穿透」这五根顶梁柱缺三根、歪两根。当前版本更准确的定位是「**能点、能填、能截图的主框架半自动遥控器**」，距离用户期望的「任意 AI 操纵浏览器实现全部功能」仍有明显缺口。

四视角评分：**安全/权限 68 · 可靠性 80 · 内容识别与资源嗅探 42 · 刁蛮用户 52**（综合约 60/100）。

---

## 1. 需求 ↔ 能力对照矩阵（汇总四视角）

| # | 需求 | 覆盖 | 依据（文件:行） | 缺口 / 备注 |
|---|---|---|---|---|
| 1 | 获取数据（可见数据） | ✅ 覆盖 | `browser_read`/`browser_observe`（page.js:126,153） | 仅主框架渲染文本，拿不到 JSON/网络数据/iframe 内文 |
| 2 | 信息（URL/标题/属性/坐标） | ✅ 覆盖 | `browser_debug`/`browser_health`（page.js:167, worker.js:175） | 扎实 |
| 3 | 图片（截图） | 🟡 部分 | `browser_screenshot`（worker.js:345） | 仅 debugger 全页 PNG，无元素级截图；自身无分析/OCR |
| 4 | 鼠标指针（移动/悬停/坐标） | ✅ 覆盖 | `browser_hover`（worker.js:318）、`browser_action` 归一化坐标（worker.js:323） | 纯坐标缺命中校验、易 stale 错点（worker.js:335） |
| 5 | 下拉框（原生/ARIA/自定义） | 🟡 部分 | `browser_select`（page.js:240）、`browser_choose`（page.js:247）、`browser_pick`（page.js:215） | 自定义 Vue/React 无 `role=option` 时兜底靠裸 `li`（page.js:49），一碰就关；虚拟列表无解 |
| 6 | 嗅探隐藏资源（网络/懒加载/CSP/登录挡住） | ❌ 缺失 | 全文无 webRequest / CDP Network 监听 | **命门级缺失**；素材站直链、懒加载图全嗅不到 |
| 7 | 识别（OCR/分类/验证码） | ❌ 缺失 | `browser_local_judge` 仅动作风险建议（worker.js:95） | 验证码直接躺平；Chrome Built-in AI 无视觉能力 |
| 8 | 填写表单 | ✅ 覆盖 | `browser_fill`/`browser_fill_verified`（page.js:280） | 单字段稳；无批量；`valueMatches` 只验即时 DOM，SPA 易误判 |
| 9 | 上传资源 | ✅ 覆盖 | `browser_upload`/`browser_upload_verified`（worker.js:221, server.js:67） | 白名单根 + SHA256 校验稳；只选不提交、限 16MiB |
| 10 | 调动下载资源 | ❌ 缺失 | manifest 无 `downloads` 权限，无下载工具 | 单向残疾，素材站批量下载做不了 |
| 11 | 调试页面 | 🟡 部分 | `browser_debug`/`browser_health`/`browser_failure_help` | 诊断扎实；无 CDP 网络/性能深调试、无 JS eval |
| 12 | 获取源代码或网址 | 🟡 部分 | `browser_read` 返回 url + 渲染文本 | 网址有；**完整 outerHTML/JS 源码无**——实验版反而有 `getHtml`/`evaluate` |

> 事实复核：0.4.1 真实 `manifest.json` 权限为 `["storage","scripting","tabs","debugger","sidePanel","alarms"]`，**不含** `downloads`/`cookies`/`webNavigation`。故「下载/Cookie 嗅探」需补权限；「网络嗅探」可走**已声明**的 `debugger`（CDP `Network.enable`）；「获取源码/evaluate」可走**已声明**的 `scripting`，均无需新权限。

---

## 2. 四视角关键发现

### 2.1 安全与权限边界（评分 68）
- **默认 `allSites:true`**（worker.js:12）：任意已连 AI 可操纵全部 HTTP(S) 页（网银/邮箱/后台），边界仅靠文档声明。
- **多 Agent 租约仅 advisory**（worker.js:296, server.js:86 全局单 lease）：并行 Agent 可串改/错页，无强制互斥。
- **截图无脱敏**（README:113）：含密码框可见值、登录态、嵌入跨站帧，像素外泄给云端 AI。
- **`local_judge` 注入检测正则过弱**（worker.js:51）：仅少量关键词，复杂/编码注入漏判；且只建议不执行，调用方可无视。
- **`extensionToken` 本机 64hex**：同机恶意进程可复用 WS 通道；`host_permissions` 全开放大面。

### 2.2 自动化可靠性与容错（评分 80）
- **ref 无版本号/失效事件**：SPA 同 url 重绘仍可失效（page.js:218）。
- **点击无可见性/动画等待**：`scrollIntoView` 后未 await 即 `elementFromPoint`，动画元素易误点（page.js:268）。
- **坐标路径无命中校验且无法回退 ref**：`browser_action` 静默错点（worker.js:335）。
- **下拉虚拟列表超时无解**：仅精确文本匹配（page.js:50）。
- **「禁止自动重放」仅为策略文案**：server.js 超时 drop 了任务，但未在协议层强制约束 Agent 侧重放。

### 2.3 内容识别、无障碍与资源嗅探（评分 42）
- **隐藏资源嗅探全缺**：无请求监听，XHR/fetch 响应体、懒加载图、被挡媒体均拿不到。
- **完整源码获取缺失**：仅可见 `innerText`，无法读 hidden DOM / JS 渲染源。
- **识别/OCR 缺失**：截图无分析；验证码/图片分类无能力。
- **iframe / Shadow DOM 未穿透**：`page.js` `scope:'main-frame; light DOM'`（page.js:153），`frameCount` 只报数不遍历。
- **权限前提修正**：下载/Cookie 需补 manifest 权限；网络嗅探、源码/evaluate 用已声明权限即可。

### 2.4 刁蛮用户（产品完善度，评分 52）
- 最坑 Top5（按杀伤力）：① 源码/隐藏资源抓不到（#6/#12）；② iframe/Shadow 全盲区（#1/#6）；③ 下拉框真实场景翻车（#5）；④ 下载缺失（#10）；⑤ OCR/验证码缺失（#7）。
- 最该先补 3 项：**getHtml + 网络嗅探** > **iframe/Shadow 作用域** > **批量事务 + 下拉稳健化**（电商上架循环：勾选→加价→下一页，是高频刚需，现靠 AI 脆弱手串）。
- 吐槽点：README 自陈「tools/list 暴露 20 个工具」，实际 31 个，文档与代码对不上，削弱信任。

---

## 3. 优先级改进 Backlog（给 Codex 的协作清单）

### P0（先补，决定"全功能"是否成立）
- **P0-1 `browser_get_html` + `browser_evaluate`**：复用已声明 `scripting` 注入，取完整 `outerHTML` / 执行受限表达式。补需求 #12，并为 #6 网络嗅探打底。**无需新权限**。
- **P0-2 `browser_network_sniff`**：复用已声明 `debugger` 发 `Network.enable`，监听 `responseReceived`/`loadingFinished`，返回请求 URL / 类型 / 大小 / 响应头 / 是否来自懒加载。限定主框架与授权 origin；HTTPS 响应体受 Chrome 限制，仅元数据级。**无需新权限**。补需求 #6。

### P1（高频真实场景）
- **P1-1 iframe / Shadow DOM 穿透**：`page.js` 递归 `iframe.contentDocument` 与 `el.shadowRoot`，ref 带 `frame/shadow` 路径。补 #1/#6 大半盲区。
- **P1-2 下拉框稳健化**：自定义 Vue/React 选择器改「按可见文本定位」而非裸 `li` 兜底；虚拟列表滚动展开再匹配。救 #5 电商后台。
- **P1-3 识别/OCR**：`browser_screenshot` 已返回 base64 PNG，在 server 端接外部视觉模型做 OCR/分类（项目本允许多模型）；Chrome Built-in AI 无视觉，外部模型更现实。补 #3/#7。
- **P1-4 批量事务与重放约束**：`browser_fill` 支持字段组；协议层对写动作加 `neverAutoRetry` 强制标记，落实"写不自动重放"。

### P2（加固与长尾）
- **P2-1 下载 / Cookie**：补 manifest `downloads`、`cookies` 权限 + 新增 `browser_download` / `browser_cookies`（后者支撑登录态资源嗅探）。补 #10。
- **P2-2 ref 版本号 + 失效回调**；点击前 `await` 可见性/无遮挡；坐标动作 `elementFromPoint` 校验失败回退 ref。补可靠性。
- **P2-3 安全加固**：默认关闭 `allSites` 或加敏感站保护名单；写操作强制 lease 互斥；含登录态/密码页截图需用户确认或打码；强化 `local_judge` 注入检测并强制 `verdict!=allow` 即阻断。

---

## 4. 完善度评分汇总

| 视角 | 评分 | 一句话 |
|---|---|---|
| 安全/权限边界 | 68 | 默认全开 + 弱租约 + 无脱敏，距「任意 AI 可安全同控」有差距 |
| 自动化可靠性 | 80 | 主链路完整保守，ref 失效/坐标可靠性待补 |
| 内容识别与资源嗅探 | 42 | 隐藏资源/源码/识别三块近空白，关键短板 |
| 刁蛮用户（产品） | 52 | 五根顶梁柱缺三歪二，半自动主框架遥控器 |
| **综合** | **≈60** | 主框架控制可用，全功能需补 P0 三项 |

---

## 5. 给 Codex 的协作任务书

请基于本报告的 Backlog 在本项目工作区协作修改完善，建议执行顺序与边界：

1. **先落地 P0-1 / P0-2**（网络嗅探 + 源码获取）——用已声明权限，风险最低、价值最高，直接补全"全功能"的两条命门。
2. **P1-1 / P1-2**（iframe 穿透 + 下拉稳健化）——打通电商上架等高频真实场景。
3. **P1-3 / P1-4**（OCR 识别 + 批量事务）——接外部视觉模型，落实写不重放。
4. **P2 加固**（下载/Cookie 权限 + 安全边界）——长尾但关乎"任意 AI 同控"的安全承诺。
5. 每完成一项，更新 `src/tools.js` 工具定义与 `extension/page.js`/`worker.js` 实现，并同步 `README.md` 的「已实现 / 明确边界」与工具计数（修正 20→实际值）。
6. **安全红线**：不得为"全功能"引入静默绕过（如自动读取密码、无确认下载、跨站数据外泄）；新增能力必须保持「先读后动、写不自动重放、用户授权范围」的既有设计哲学。

— 主代理（WorkBuddy）整理，2026-10-01
