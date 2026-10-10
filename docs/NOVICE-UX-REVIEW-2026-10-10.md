# 小白用户找茬评审（2026-10-10）

目的：在改动启动机制 / 升级桥接系统之前，先让不同画像的新手把现有流程踩一遍，把「不方便」摊开。

## 评审方法

5 位用户代表各自独立走完「安装 → 配对 → 日常 → 排障 → 迁移」全流程，只报告不改动：

| 画像 | 关注点 |
|---|---|
| 纯小白（不懂命令行） | 安装第一步能不能走通 |
| 半懂技术（运营/设计） | 报错能不能自救 |
| 公司受限账户（无管理员 + EDR） | 企业环境能不能装、会不会被拦 |
| 多设备 / 重装系统用户 | 换机器成本 |
| 用了三个月的重度用户 | 长期稳定性、状态可见性 |

关键代码指控已逐条核对源码确认，不是评审员的猜测。

---

## P0 · 阻断级（照现在的样子，这类用户会直接放弃）

| # | 问题 | 证据 |
|---|---|---|
| 1 | **README 第一步就要求「PowerShell 7」**，却不解释它是什么、怎么打开 | `README.md:52,56` |
| 2 | **双击 `.ps1` 只会用记事本打开**，全仓库没有一个 `.bat` | `start.ps1` 等 |
| 3 | **`stop.ps1` 停不掉自启起来的服务**：vbs 从不写 PID 文件，脚本直接 `exit` | `stop.ps1:3-4`；`install-autostart.ps1:21` |
| 4 | **换机流程漏了 `start.ps1`**，照 README 做 `pair.ps1` 必崩（`.local/config.json` 尚不存在） | `README.md:113`；`pair.ps1:3` |
| 5 | **误点「暂停」后所有报错都不提暂停**，一律 `extension_disconnected` | `src/server.js:292`；`worker.js:222` |
| 6 | **一个写操作超时，清空全体队列**：`drop()` 让其他 AI 的 job 全部失败 | `src/server.js:222-227,239-240` |
| 7 | **自启失败完全静默**：vbs 隐藏窗口、无日志、无通知，服务死了用户不知道 | `bridge-autostart.vbs`；`install-autostart.ps1:19-23` |

---

## 分主题问题清单

### A. 安装与启动（最致命）

- 「加载已解压的扩展程序」对小白是天书，且企业策略一旦禁用开发者模式就**没有退路**（`extension/manifest.json` 无 `key`/`update_url`）→ `README.md:65`
- 「打开扩展的**选项**」实际入口是工具栏图标，`manifest.json` 同时有 `default_popup` 和 `options_page`，README 没说清点哪个 → `README.md:66`
- `#Requires -Version 7.0` 只从 `start.ps1` 去掉了，`pair.ps1:1` / `stop.ps1:1` / `upgrade.ps1:1` 还在，与 `README.md:115`「5.1 也能跑」**自相矛盾**
- `upgrade.ps1` 名不副实：只是 stop+start，不拉代码；结尾提示还是英文
- 示例路径硬编码 `K:\PythonProjects5\...`，用户照抄必错 → `README.md:59,81`

### B. 状态不可见（重度用户最不满）

- 角标只有「ON」，暂停 / 断线 / 未配对 / 连接中**一律空白**，用户分不清状态 → `worker.js:505,212`
- 没有托盘、没有通知、断线不提醒，确认状态只能去跑 `npm run status`
- 休眠唤醒后恢复时间不明（20s 心跳冻结，重连靠 worker 重启兜底），AI 拿到失败但不知道该等还是该重发 → `worker.js:507,553`
- 端口 19387 被占用**零提示**，只让用户去看从没打开过的日志 → `start.ps1:16,27`

### C. 报错文案

- `fetch failed` / `ERR_CONNECTION_REFUSED` / `status:"waiting"` 全是英文黑话，且没有下一步动作 → `src/client.js:20`
- **token 不匹配**和**「已有另一个 Chrome 配置连接」共用同一个 close code 4001**，扩展无法区分 → `src/server.js:365`
- 第二个 Chrome 配置永远显示「连接中」，5 秒一次无限重连，从不说明原因 → `worker.js:521`
- 公司代理可能吞掉 `127.0.0.1` 探活（`Invoke-RestMethod` 走系统代理）→ `start.ps1:8`

### D. 迁移与备份

- 重装系统后旧密钥**必然作废**（每次 setup 重新 `randomBytes(32)`）→ `src/config.js:16`
- 没有「重新生成密钥」命令；`pair.ps1` 缺配置时直接崩溃
- 剪贴板单槽、静默覆盖、无回执（`pair.ps1:4-5`）
- 配置散在三处且无导出：白名单在 `chrome.storage.local`、上传根在 `.local/config.json`、策略在 `.local/agents.json`
- 卸载不干净：只删注册表项和 vbs，`.local/`（含两个 token）、扩展、MCP 客户端配置全留下

### E. 多客户端与稳定性

- **MCP 通道没有 waiting 自动恢复**：`mcp.js:13` 只用 `recoverRead`，CLI 才有 `callWithWaitingRecovery` → 最常用的那条路反而最脆
- 多 AI 抢队列时 `waiting` 不带 `position / behind / etaMs / whoHolds`，AI 常把 `waiting` 当失败
- 与 AutoGLM 共存只有一句「建议不要」，无检测、无互斥

---

## 启动机制：现状的 4 个硬伤

`install-autostart.ps1` 的方案是 `HKCU Run` + 生成的 `bridge-autostart.vbs`。它解决了「要手动启动」，但引入 4 个新问题：

1. **node 路径烤死在 vbs 里**（当前指向 `.workbuddy-ai\binaries\node\versions\22.22.2-6`）。Node 升级 / 换版本 / 卸载后，开机即静默失效。
2. **无看门狗**。登录时启动一次，之后服务崩溃不会自愈。
3. **失败完全静默**。隐藏窗口 + 无日志重定向 + 无通知。
4. **在企业环境是高危特征**：写 Run 键 + 落地 `.vbs` + `wscript //B` 隐藏执行，三重触发 EDR/杀软。公司代表明确说「会被拦，还得跟安全部门解释」。

另外 `stop.ps1` 依赖 PID 文件，而自启路径不写 PID —— 两者互相看不见。

---

## 三个改造方案

### 方案 A · 修补现状（止血）

- vbs 改成**动态探测 node**（先试 PATH，再试已知托管路径，最后报错可见）
- 启动器 stdout/stderr **重定向到 `.local/server-start.log`**
- 安装时**先跑一次 setup + 试启动**，失败立刻中文提示
- `stop.ps1` 改为**按端口查进程**，不再依赖 PID 文件
- 所有 `.ps1` 去掉 `#Requires`，并各配一个 `.bat` 供双击

成本：低（数小时）。解决硬伤 1/3/4 的一半，不解决崩溃自愈与 EDR。

### 方案 B · 启动文件夹为默认，计划任务可选（推荐）

- **默认**用 `%APPDATA%\...\Startup` 放快捷方式：不碰注册表、不落地 vbs、用户能在「任务管理器 → 启动」里自己禁用，EDR 友好度最高
- **可选** `-Method Task` 用计划任务：支持崩溃自动重启、可配登录延迟、能做看门狗
- 两者共用同一套「探测 node + 写日志 + 自检」启动器

成本：中。解决硬伤 1/2/3/4。

### 方案 C · Chrome Native Messaging 守护（中期方向）

用户真正的诉求是「**打开浏览器那一刻起就要可用**」，而不是「登录 Windows 时启动」。Native Messaging 能精确命中：扩展一连接，Chrome 自动拉起本机进程，不需要任何自启注册表。

- 优点：时机精确、官方机制、无 Run 键无 vbs
- 代价：需要安装 native host manifest（仍是注册表/JSON）、连接层要改造、MCP 客户端在服务未起时仍会失败

建议单独立项评估，不混进这次改动。

---

## 建议落地顺序

1. **先做状态可见性**（角标区分暂停/断线/未配对 + 断线通知）—— 重度用户说「我每天靠它干活，却没有一个能瞄一眼的灯」，这条性价比最高
2. **方案 A 全量**（止血，含 `.bat` 伴侣与去 `#Requires`）
3. **拆掉 4001 的语义歧义**（token 不匹配 vs 已有其他 Chrome 配置）
4. **MCP 补上 `callWithWaitingRecovery`**
5. **修 `drop()` 连坐**：写超时只隔离该 job
6. 方案 B（启动文件夹默认 + 计划任务看门狗）
7. 文档重写：README 第一步改成图形化入口，路径用占位符
