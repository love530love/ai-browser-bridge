# ai-browser-bridge 阻塞与不便清单（实测记录 + 改进建议）

> 用途：供改进 `ai-browser-bridge`（本地 Chrome MV3 扩展 + 127.0.0.1:19387 HTTP 服务）。
> 记录人场景：2026「移动云杯」AI Coding 作品提交（ecloud.10086.cn 开发者社区竞赛专区）。
> 版本：service/extension 0.4.19；OS Windows Dev；shell pwsh7。
> 证据均来自本会话真实调用返回，非推测。

---

## 0. 结论摘要
- **链路本身通**：`/status`、鉴权、`browser_tabs`、主框架 `browser_read`/`browser_debug` 均正常。
- **致命阻塞**：目标表单在**跨文档 iframe** 内，而 read/click/upload **仅作用主框架**，无跨 frame 能力 → 无法自动化提交表单。
- **高频不便**：重 SPA 页 `read_timeout`、`browser_screenshot` 因 debugger 占用/页面 busy 失败、`browser_upload` 受 allowlist 根目录 + SHA256 约束、服务单点（掉线即 fetch failed）。

---

## 1. 阻塞项（Blocker）

### 1.1 跨 iframe 无法读取/操作（本次核心）
- **现象**：竞赛提交页 `home.html#match@ecloudcup` 主框架只读到站点导航/页脚；`browser_debug` 返回 `frameCount:1`、主框架 `fileInputs:[]`、`roleCounts` 全是 chrome（a:1/button:8）。真正的"上传作品"表单在 iframe 内。
- **复现**：`browser_observe`/`browser_read` 的 `scope` 恒为 `"main-frame; light DOM"`；`browser_click`/`browser_fill`/`browser_upload` 的 ref 只能来自主框架 `browser_read`，故 iframe 内元素永远拿不到 ref。
- **根因**：read 系工具硬编码只遍历主框架，未提供 frame 定位参数或跨 frame 遍历。
- **影响**：任何把业务表单嵌进 iframe 的站点（大量国内控制台/门户/活动页）都无法自动化，实用性大打折扣。
- **改进建议（按性价比）**：
  1. `browser_read`/`browser_debug` 增加 `frame` 选择参数（按 `frameId`/`url` 匹配/`all`），并把每个 ref 标注所属 `frameId`+`frameUrl`；`browser_click`/`fill`/`upload` 依据 ref 的 frameId 用 `chrome.scripting.executeScript({target:{tabId,frameIds}})` 精确注入。
  2. 提供 `browser_frames`（列出所有 frame 的 url/name/origin/是否同源），便于上层决定"直开 iframe 顶层 URL"这一绕过手段。
  3. 文档明确标注同源/跨源 iframe 的能力边界与安全策略（跨源本就受扩展权限限制，需说明）。

### 1.2 重 SPA 页 `read_timeout` / 截图失败
- **现象**：活动标签 `visibilityState:"hidden"`、`readyState:"complete"` 但 `browser_screenshot` 返回 `{"status":"waiting","retryable":true,"reason":"read_timeout","suggestedDelayMs":1000,"nextPollTool":"browser_wait_until_ready"}`；多次读取超时。
- **根因**：SPA 持续有网络/定时器/RFC 活动 → 稳定判定永不满足；隐藏标签渲染节流；临时 debugger 附着与页面自身 devtools 冲突（历史报 `Another debugger is already attached to the tab`）。
- **改进建议**：
  1. `read_timeout` 时提供"降级快照"（即便页面 busy 也返回已抓到的 DOM 文本，`partial:true`），而非整体 waiting。
  2. 截图走 CDP `Page.captureScreenshot` 而非依赖"页面 idle"；对 hidden 标签先 `chrome.windows.update`/`tabs.update({active})` 或用 `captureVisibleTab` 兜底。
  3. 暴露 `waitFor` 策略参数（`idle`/`timeout-then-partial`/`force`），让调用方选择"等稳定"还是"抓当前"。

---

## 2. 不便项（Friction）

### 2.1 `browser_upload` 受 allowlist 根 + SHA256 约束
- **现象**：工具描述要求"文件必须在本地 allowlisted upload root 下且匹配 SHA256"。本会话 `config.uploadRoots=["K:\\...\\FlagGems-sglang\\submissions"]`，而待传作品包在 `F:\\PythonProjects1\\ecloudcup\\提交包\\...zip`，不在根内 → 即便拿到 ref 也会拒。
- **不便**：跨盘符/临时目录的文件要上传前必须先拷进 allowlist 根并算 sha256，多两步。
- **改进建议**：`uploadRoots` 支持多根与运行时临时授权（一次性 token 授权某绝对路径）；或提供 `browser_upload` 直接接收绝对路径 + 交互确认，而非仅 allowlist 根。

### 2.2 服务单点，掉线即 `fetch failed`
- **现象**：19387 未在监听时所有调用 `fetch failed`；需手动跑 `start.ps1` 拉起 `node src/server.js`，扩展再自动重连。
- **不便**：机器重启/进程被杀后静默不可用，错误信息（fetch failed）不区分"服务没起"与"扩展没连"。
- **改进建议**：`/status` 与客户端错误区分三态（service down / extension disconnected / version mismatch）；提供开机自启（计划任务/托盘）与更清晰的 `doctor` 指引。

### 2.3 service/extension 版本必须匹配
- **现象**：`doctor` 逻辑里 `version !== extensionVersion` 会给"重载扩展/重启服务"提示；历史上出现过 0.4.17↔0.4.19 需对齐。
- **改进建议**：握手时协商最低兼容版本，向后兼容优先，而非强依赖同版本。

### 2.4 坐标点击被禁/不可靠
- **现象**：工具集倾向"必须用 ref 点击"，`browser_debug` 提示"guessing coordinates 前先诊断"；SPA 上坐标点击常落空。
- **改进建议**：当无 ref（如 iframe/虚拟列表）时，提供受控的 `clickAt(x,y)` 作为**显式兜底**并标注风险，而不是完全不给。

### 2.5 编码/输出呈现
- **现象**：经 pwsh→node→控制台链路，中文在部分环节显示为 cp437 mojibake（如 `µÄ¿τÉå`），但工具**内部数据其实正确**（`"李富强" in name` 校验通过）。属呈现层噪声，易误导排查。
- **改进建议**：`/call` 返回统一 UTF-8；文档说明"控制台乱码≠数据乱码"，或提供 `--json-out file` 避免终端渲染干扰。

### 2.6 `browser_read` 参数不直观
- **现象**：传 `{tabId, query}` 报 `Unknown argument: query`（read 不接受 query）；而 `browser_scan_overlays`/`browser_find` 类工具需要关键词。命名/签名不一致，靠试错。
- **改进建议**：统一检索型工具参数；返回 400 时附带"该工具接受的参数列表"，减少试错。

---

## 3. 本会话可用工具清单（实测确认）
`browser_tabs`（列标签，✅可用）、`browser_open`（开 URL）、`browser_read`（主框架文本+ref）、`browser_debug`（诊断：focus/scroll/combobox/fileInputs/dialogs/iframe count/roleCounts）、`browser_observe`（read+debug+几何）、`browser_scan_overlays`（弹窗/遮挡/滚动容器）、`browser_health`（分层健康）、`browser_bridge_modes`（可用模式与回退顺序）、`browser_click`/`browser_fill`（需主框架 ref）、`browser_upload`（allowlist 根+sha256，选文件不提交）、`*_verified` 变体（点击/填充后校验、失败不重试）、`browser_scroll(_element)`、`browser_screenshot`（临时 debugger 附着，占用则失败）、`browser_wait`。
> 均经 `request('/call',{name,arguments})`，返回体 `r.result ?? r`；写操作类带 `agent` 租约参数。

---

## 4. 改进优先级建议（给维护者）
| 优先级 | 项 | 理由 |
|---|---|---|
| P0 | 跨 iframe 读取+操作（1.1） | 决定"能不能用"，门户/控制台类站点占比极高 |
| P0 | busy SPA 降级快照 + 截图不依赖 idle（1.2） | 现状频繁 read_timeout，体验断崖 |
| P1 | 三态健康错误 + 开机自启（2.2） | 掉线静默、排障成本高 |
| P1 | upload 路径授权灵活化（2.1） | 跨目录上传是常见刚需 |
| P2 | 受控坐标兜底、参数一致性、UTF-8 输出（2.4/2.6/2.5） | 降低试错与误判 |

---

## 5. 本次绕开 iframe 的可行手段（记录）
在浏览器内**右键 iframe → 在新标签打开框架**，或复制该 frame 的直链交给 bridge `browser_open` 作为**顶层标签**打开；此时主框架可读，`browser_fill`/`browser_upload` 方能作用。根因还是 1.1——若工具原生支持 frame 选择，就不需要这一步人工绕道。
