# Chrome 版本漂移：这次从 154 到 156

> 本文记录一次真实升级（154.0.8037.93 → 156.0.8078.49）的判断依据、改了什么、以及升级后必须重新测量什么。
> 原则：**发行说明能告诉你「改了什么功能」，只有实测能告诉你「本项目还成不成立」**。

## 事实（2026-10-28 本机实测）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 运行中的浏览器 | `154.0.8037.93` | `browser_queue_status.browserVersion`（UA-CH，worker 内读取） |
| 已下载待应用 | `156.0.8078.49` | 扫描 `Application\<version>\chrome.dll`，与运行版本比较 |
| 安装根 | `C:\Program Files\Google\Chrome\Application` 与 `D:\Program Files\Google\Chrome\Application` **各有一份** | 同上 |
| 基座 / 扩展源码 | `0.15.0`（本轮）；抓基线时**运行中**的是 `0.14.0` | `/status` |

## 「重启了，但版本没变」——先分清三种状态

这台机器上真实发生过一次：用户以为重启了 Chrome，`browserVersion` 仍是 154。三条证据说明浏览器进程
根本没退出过（最早一个 chrome.exe 从 18:23 一直活到 20:52；磁盘 `chrome.exe` 仍是 154；而 Omaha 的
`ClientState.pv` 已经是 156）。**升级有三种完全不同的状态，混在一起就会一直「重启无效」**：

| 状态 | 怎么认 | 怎么办 |
| --- | --- | --- |
| 只下载了 | `Application\<newer>\` 存在，`chrome.exe` 是旧版，**没有** `new_chrome.exe` | 正常重启即可应用 |
| **已安装、只差换启动器** | `Application\` 下有 **`new_chrome.exe`**（新版启动器），`chrome.exe` 仍是旧版 | 重启**不会**生效。见下 |
| 已应用 | `chrome.exe` 的 FileVersion = 新版 | — |

`new_chrome.exe` 是 Chrome 暂存更新的标准形态：整份新构建写进自己的版本目录，然后在旧启动器旁边
放一个新版启动器，**最后一步是把它改名成 `chrome.exe`**。这一步由更新程序在「没有浏览器在跑」时做。
如果这台机器上的 Chrome 没有注册 Omaha（`HKLM/HKCU` 的 Uninstall 里查不到 Google Chrome），
就没人来做这一步，于是「已安装、已下载、重启无效」可以无限期持续。

查当前状态（不需要浏览器在跑，这正是要查的时刻）：

```powershell
node scripts/chrome-compat-baseline.js --disk
```

修复（等于替更新程序做那一次改名，可回滚）：

```powershell
# 1. 完全退出 Chrome，确认没有 chrome.exe 残留
# 2. 备份并换上暂存的启动器
Copy-Item "D:\Program Files\Google\Chrome\Application\chrome.exe" "D:\Program Files\Google\Chrome\Application\chrome.exe.154.bak"
Move-Item "D:\Program Files\Google\Chrome\Application\new_chrome.exe" "D:\Program Files\Google\Chrome\Application\chrome.exe" -Force
# 3. 启动后确认版本
node src/cli.js doctor
```

本机 2026-10-28 实测：C: 那份安装自己完成了换名（`chrome.exe` 已是 156），D: 那份一直卡在
`new_chrome.exe` 上，手工换名后两个根都是 `156.0.8078.49`，`chrome.exe.154.bak` 保留作回滚。

**另一个坑：基座不能替用户启动 Chrome。** 从工具里 `Start-Process chrome.exe` 能起来（32–40 个进程、
窗口正常），但**工具调用一结束，整棵进程树就被清理掉**——两次不同启动方式（PowerShell 的
`Start-Process`、bash 的后台执行）都是同一结果，`Crashpad` 里也没有当天的转储，说明不是崩溃而是被回收。
这与项目「基座从不启动浏览器」的设计一致，只是现在有了实测依据：**最后一下必须由人点**。
（0.19.0 起这件事改由**服务进程**做，从服务里启动的 Chrome 能活下来。）

## 156 上第一次真正重启后：扩展被停用

升级到 156 并真正重启浏览器之后，扩展**没有回连**。症状看起来和「扩展没装」完全一样，但磁盘上的答案很明确：

```
doctor -> bridge-extension-registered
  profileDirectory: Default
  extensionId: mmopbppoabmhliflinadkgnedjpmbgig
  enabled: false
  disableReasons: [16777216]
```

`User Data\Default\Secure Preferences` 里这条扩展记录带 `disable_reasons: [16777216]`，同时
`extensions.ui.developer_mode` 未设置（开发者模式关闭）。**154 上它一直可用，156 上第一次真正重启后被停用**
——这是目前最强的解释，但没有 154 的对照实验，所以只记为「强怀疑」。

处理方式（一步，需要人）：`chrome://extensions` → 打开「开发者模式」→ 启用「自主浏览器」。
之所以要打开开发者模式，是因为**这正是 Chrome 用来管「从目录加载的扩展」的开关**，关着的时候
Chrome 有权在启动时把它们停用。

顺带得到的两个结论：

1. **「没连上」是三种状态，修法各不相同**：没安装（去加载）、装了但被停用（去启用）、装了也启用但没起来
   （去重载）。服务此前只能报第一种，现在 `doctor` 的 `bridge-extension-registered` 直接把磁盘上的答案说出来。
2. **启动成功不等于能干活**。0.19.0 的自动启动确实把 Chrome 拉起来了，但扩展是停用的，于是原始调用仍然
   完不成——所以那一轮的结果必须是 `chrome_launched_extension_not_connected`（带 `extensionState`），
   **不能降级成 `extension_disconnected`**，否则「浏览器已经起来了」这个事实就被藏掉了。

Chrome 156 于 **2026-10-20** 进入稳定通道（`156.0.8078.47/.48`，本机是 `.49`），含 **353 项安全修复、其中 6 个严重漏洞**，覆盖图形、无障碍、渲染、通信等模块。稳定通道公告的措辞是「修复与改进」，**没有逐项功能清单**。

## 公开变更里唯一影响本项目判断的一条

**IndexedDB 的实现从 LevelDB + 扁平文件迁移到 SQLite 后端**（官方说明：网页开发者使用的 API 不变）。

对本项目逐项判断：

- `browser_storage_read` 走页面内的 `indexedDB.databases()` → **不受影响**（API 未变）。
- `browser_credential_lookup` 读的是 profile 里的 `Cookies` 与 `Login Data`，本来都是 SQLite → **不受影响**。
- 任何「离线遍历 profile 的 IndexedDB 目录」的做法会失效 → **本项目没有这种实现**，所以这是一条「无需改动」的结论，记下来是为了下次不要再查一遍。

其余公开条目（CSS `random()`、失败的 `import()` 可重试）与浏览器操控无关。

## 真正会受影响的是「按身份驱动」的路径

以下都不是读发行说明能确认的，必须实测：

1. **Windows UI Automation automation id**。本项目依赖：地址栏 `view_1012`、密码管理器 `searchInput` / `passwords` / `seePasswordDetails` / `showPasswordButton`、工具栏 `view_1007`（应用菜单）/ `view_1026`（书签）/ `view_1018`（资料）。这些 id 是 Chrome 自己的实现细节。
2. **原生控件树的形状**。`browser_native_snapshot` 的遍历预算（400 行 / 3000ms / 深度 32）是按 154 的树标定的；树变深或变宽会让 `partial` 变真。
3. **CDP 域可达性**。0.9 的 `DOMStorage` 教训：先探测域是否可达，再写代码。`Debugger.setScriptSource` 被 V8 无条件 stub、`chrome://` 页面禁止 attach 这两条结论都来自具体版本。

## 本轮为此做了三件事

1. **版本可见性**。扩展在 worker 内用 user-agent client hints 读出完整版本（`navigator.userAgent` 只报 `154.0.0.0`，补丁号被隐藏），随 hello 之后的 `browser` 消息上报；`/status` 暴露 `browserVersion` / `browserMajor` / `browserIdentitySource`，`browser_health` 每次调用都带 `browser` 字段。此前基座**根本不知道自己驱动的是哪个 Chrome**。
2. **基线 + 差异工具**。`scripts/chrome-compat-baseline.js` 把「运行版本 / 已安装版本 / 待应用更新 / 原生控件身份表（automationId → role / state / patterns / 名称哈希）」写进 `.local/chrome-compat-<version>.json`；`--diff` 输出 GONE / NEW / CHANGED 三类，**GONE 就是必须重新发现的绑定**。它不开标签、不读页面。
3. **UIA 定位从「只认 id」改成「id 优先 + 角色/名称兜底 + 歧义拒绝」**（`scripts/password-manager-ui.ps1` 的 `Find-Control`）。每个关键控件先按 id 找，找不到再按角色 + 可访问名称找，命中多个**直接拒绝**而不是按位置挑；成功结果里带 `lookup: { search, entries, reveal }` 说明这次是靠 id 还是靠语义匹配到的。理由很直接：id 被改名后的失败和「控件不存在」长得一模一样，而这个流程会把密码显示出来。

## 升级后必须按顺序执行

```powershell
node scripts/chrome-compat-baseline.js
node scripts/chrome-compat-baseline.js --diff .local/chrome-compat-154.0.8037.93.json .local/chrome-compat-156.0.8078.49.json
npm test
node src/cli.js doctor
npm run test:native
npm run test:devtools
npm run test:capture
npm run test:debugger
npm run test:bench
```

- `--diff` 里出现 **GONE** 的 id，意味着有代码按那个 id 绑定了控件，必须改成可发现的绑定，或确认它已不在任何路径上。
- `npm test` 是契约层，版本升级**不该**让它变红；它红了说明我们自己的代码有问题。
- `test:native` / `test:devtools` / `test:capture` / `test:debugger` 是**唯一**能证明 UIA 与 CDP 在 156 上仍成立的东西。
- `test:devtools` 尤其相关：它整条链都压在 `view_1007`（应用菜单）与两个本地化的菜单项名称上，
  而且要求 `devtools://` 文档与面板 TabItem 都还能从原生树里读出来。**156 若改了菜单结构，这里会先红。**
- `test:bench` 是不变量层，它红了说明「弱调用方也不会弄坏东西」这条不成立了，比单个能力坏掉更严重。

### 不需要真实密码也能验证的一条

密码管理器那条流程没有 live 测试（它会显示真密码），但升级后仍然可以低成本地证明
`Find-Control` 的兜底没有坏：用一个**确定不存在**的站点名跑 `reveal`，期望得到
`status: not_found` / `reason: no_exact_entry`。这一步会真的打开 `chrome://password-manager/passwords`
并把名字填进搜索框，但**不会按下显示密码**，所以不暴露任何密码；返回里的
`visibleEntries` 是用户自己的站点名，读的时候只看 `status` / `reason` / `evidence.lookup` 就够。

```powershell
# 只取判决字段，不把 visibleEntries 抄进记录
.\scripts\password-manager-ui.ps1 -Action reveal -Site '__compat_probe_does_not_exist__' |
  ConvertFrom-Json | Select-Object status, reason
```

得到 `not_found` 就说明：搜索框被找到了（不管是靠 `searchInput` 还是靠角色+名称兜底）、
条目行被找到了、过滤逻辑正常工作。**这不能证明「显示密码」按钮的 id 没变**——
那条只能靠真实账号，或者在 156 上重新观察一次详情面板。

## 不承诺的部分

- 本机 156 的实测结果不证明其他机器、其他渠道（Beta / Dev / Canary）、其他操作系统。
- 单窗口、单 profile 的结果不证明多 profile 或多显示器下的窗口解析。
- 发行说明没有逐项清单，所以「我们漏掉了某个变更」这件事无法被排除；只能靠上面的清单把可观测面测一遍。
