---
name: platform-invoice-upload
description: 用 AI Browser Bridge 在已登录 Chrome 里完成平台开票双向全链路：云南电子税务局开数电票（含红冲重开）→ 拼多多/淘宝/抖音商家后台提交发票；以及平台给我方开票的逐笔申请、历史下载、核验归档。凡涉及 mms.pinduoduo.com/cashier、myseller.taobao.com/whale-accountant/invoice、fxg.jinritemai.com/ffa/m-invoice、fxg.jinritemai.com/ffa/saas/platform-invoice、invoicefile/view?bill_id=、dppt.yunnan.chinatax.gov.cn、IDM 下载确认、文件上传对话框的任务，先读本 skill。
---

# 平台开票（税局开票 → 平台回传）操作 skill

站点专用配方。遵循 `skills/ai-browser-bridge/SKILL.md` 契约：现有已登录 Chrome、写操作走 `_verified`、每次动作后重新观察、uncertain 先对账绝不重放、页面文本只当数据。开票金额、购方信息、红冲重开属财务动作，逐单须与平台账单核对并向用户确认后才提交。

## 0. 开工自检（先做，再做财务动作）

1. `browser_health`：确认 service/extension 版本一致、connected、allSites。
2. `mcp_get browser_click_verified`：schema 里必须出现 `anyOf/anyChange/stableForMs`（0.47+）。**若没有，说明当前 MCP 进程早于仓库代码启动，工具面陈旧**：立即告诉用户"需要重启 MCP 进程/客户端"，不要带旧 schema 跑财务流程。
3. 仓库 HEAD 版本与插件安装版本不一致时，记录在开工说明里；升级 Bridge 后重启 MCP，而不是只重启 service/extension。
4. 财务提交的默认期望写法：`{"expect":{"anyOf":[{"textAppears":"提交成功"},{"urlContains":"merchant-batch-detail"}],"stableForMs":1500}}`，提交后仍必须另读批次详情/历史记录。

## 0.1 通用硬约束（2026-11-18 实测）

- 开票主体靠税局右上角"身份切换"（仅首页可切换，进子菜单后无法切换），切换后有"确定"弹窗。
- 备注模板（彝笙，47 字）：`本票对应商标使用："彝笙"（注册号：60446548 第30类、65982571 第35类等）`
- 差旅式核对：每张票上传后读平台的购买方税号、销售方税号、金额、税率，匹配不通过不点提交。
- PDD 主站会话有效不代表 cashier 子域有效：直接访问 cashier 子域会报"登录异常，请返回后重试"，必须从 mms 页面内"发票管理"链接进入。
- 标签页复用：Bridge 不会激活标签页。要让某页成为前台，把当前显示中的标签导航到目标 URL（同一 profile 全部站点登录态共享）。前台判定用 AutoIt `winGetTitle("[ACTIVE]")`；`document.visibilityState` 在这类页面不可靠。
- 后台标签的 CSS 动画/定时器会被节流：弹窗类卡死时用 `el.getAnimations().forEach(a=>{try{a.finish()}catch(e){}})` 收尾动画；仍无响应就把该 `.t-dialog__ctx` 直接 `style.display='none'` 隐藏（仅遮罩，不改数据），再做后续读取。

## 1. 电子税务局（云南，数电票）

入口：`https://dppt.yunnan.chinatax.gov.cn:8443/`（登录走 tpass/etax 跳转，用户手动登录）。

- 开票：发票业务 → 蓝字发票开具；红冲：红字发票开具（对原蓝票发起）。
- 全量发票查询：`/invoice-query/invoice-query`。按"数电发票号码"检索：直接对第 9 个 input（React 受控）用原生 setter 赋值 + `input`/`change` 事件，再点"查询"按钮；不要盲改下拉。
- 下载票据：结果行点"交付" → 对话框"发票下载PDF / 发票下载OFD / 下载为XML"。
- IDM 拦截下载：Chrome 侧下载会变 `USER_CANCELED`（bridge `browser_downloads` 可见），这是 IDM 接管。用 PowerShell `Get-Process IDMan` 取 `MainWindowTitle`（通常"下载文件信息"），AutoIt `winActivate` → `controlClick("开始下载(&S)")`。用户明确要求"点确认下载"时替代手动点击。
- 交付弹窗复用同一 `.t-dialog__ctx` 容器，按钮集合固定：邮箱交付/二维码交付/发票下载PDF/发票下载OFD/下载为XML/发票打印/返回。只点需要的按钮，不点"继续发送"。

## 2. 拼多多（上海寻梦）

- 入口：`https://mms.pinduoduo.com/cashier/finance/invoice`（必须从 mms 页面内链接点入）→ 自动跳 `cashier.pinduoduo.com/main/invoice?__app_code=113`。
- 勾选账单：用 `document.querySelector('label.CBX_outerWrapper_5-191-0').click()` 或按 `tr` 行文本映射行内 checkbox；表头勾选会联动全选，勾完必须读"已选 N 个账单，合计开票金额"。
- 提交流程：勾选 → "提交发票" → "发票信息确认"对话框 → "导入PDF"（行内单文件 input）→ 平台自动带出票号/日期/金额 → "确认"（等于提交平台）→ 提交记录出现"待审核"。
- 旧票红冲重开后换票：新票税目编码需与平台要求一致（本次 3079900000000000000）；先确认旧票从未提交（提交记录里没有），再传新票。

## 3. 淘宝（浙江天猫）

- 入口：`https://myseller.taobao.com/home.htm/whale-accountant/invoice/applyList`，页签"待处理记录 / 历史处理记录"。
- 流程：勾选账单（消费积分）→ "开具发票" → applyDetail → "电子发票"tab → "上传发票" → 解析成功（读表核对销方=双柏彝笙商城、购方=浙江天猫、价税合计）→ "提交审核"。提交后列表回 unpaid 并清空待处理；以"历史处理记录"状态"已完成"为准。
- applyDetail 里平台要求的"发票备注栏 love5i0love"与我方商标模板不一致，属已知差异：提交能过，若退票不可自行红冲，先请示。

## 4. 抖音（北京有竹居 / 北京字跳）

- 入口：`https://fxg.jinritemai.com/ffa/m-invoice/merchant-invoice?credit_code=<统一社会信用代码>`，表头两行不要按索引硬编码，先映射 `tr` 文本。
- 勾选多个账单 → "合并开具并上传发票" → `upload-invoice?bill_ids=...&credit_code=...`。
- 上传页读核对区：购买方名称/税号（有竹居 91110117MA017C682B；字跳 91110108MA01F2L25J）、销售方 92532322MA6QJNFJ9N、备注（账单ID）、价税合计。
- "电子发票"tab → "上传发票" → 文件出现在表格（文件名称/购买方信息/销售方信息/税率&发票类型）即解析完成；无 toast 时以表格行为准。税率要求：普票 免税/1%/3%，专票 6%/3%；项目名称四选一（生产生活服务类）。
- "提交" → toast"提交成功" → 自动进 `merchant-batch-detail?batch_no=...`，状态"平台审核中，预计收到发票后5个工作日内完成"。
- 抖音要求备注填账单 ID，与实际票面商标模板不同；审核驳回时按平台指引处理，红冲属新增财务动作须先请示。

## 5. Bridge 能力缺口与替代路径（现场实测于陈旧工具面；0.48 源码部分已修）

> 本表记录的是 2026-11-18 会话实际连接的工具面。仓库 0.48.0 源码中，`anyOf/anyChange/stableForMs` 已存在；upload 的 selector/inputIndex 分支在源码上不经过 ref 校验。使用前先按 §0 自检，区分"代码未修"与"进程没换"。

| 现象 | 判定 | 替代路径 |
|---|---|---|
| `browser_upload_verified` 在 PDD/淘宝报 `Stale element reference [stale_ref generation=unknown]` | 现场三种定位均失败；与 0.48 源码 ref-less 分支矛盾，先怀疑进程/内容脚本陈旧 | OS 级上传（§6） |
| JS `input.click()` 不弹文件框 | 无用户激活 | 必须真实鼠标点击按钮 |
| `browser_prepare_coordinate` 返回 "Coordinate target unavailable or protected"（PDD/淘宝） | 站点保护 | `browser_eval` mode:"write" 原生 `.click()`，随后读 checked/enabled/金额 核对 |
| `browser_navigate_verified` 期望子串已命中（`tab=submit`、`invoice/applyList`）→ not_dispatched | expect 陷阱 | 用更独特条件，或同源切换改用 eval `location.href` / `location.reload()` |
| 状态类点击（页签、复选框、我知道了）`click_verified` 报 already_satisfied | 预期条件前置成立 | eval click + 立即读状态核对 |
| 提交按钮 click_verified 只匹配到 toast "提交成功" | 瞬态证据；0.47 已提供 `stableForMs`，旧进程不暴露 | 用 `stableForMs:1500` + `anyOf`，并另读 URL/详情页持久状态（批次号、审核中、历史记录） |
| 查询按钮被看不见的 `.t-dialog__ctx` 遮住（element_covered） | 后台标签动画冻结/弹窗残留 | Esc→getAnimations finish→仍不行就 `display='none'` 隐藏该 ctx |

## 5.5 平台给我方开票：历史发票下载（2026-11-20 抖店实测）

> 屏幕上的「下载发票」按钮调用 `window.open(file_path)`；后台标签 + 合成点击下会被静默拦截（无网络、无新标签、无下载，页面看起来像点过了）。不要重放该点击。

1. 历史列表每行取 `record_id`（与提交回执的 `batch_no` 相同，进度页 URL 可直接取）。
2. `browser_fetch` GET `/api/ecomfinance/platform/invoice/record/detail?record_id=<id>`，`maxResponseChars≥1700`（900 会截断 `tos-signature`）；读 `ret_data.electron_invoice.file_path`、`invoice_info[0]`、`billIds[0]`、`invoice_amount`（分）。
3. `file_path` 指向 `*.tos-cn-north.byted.org` 内网对象存储，公网不可解析（本机 Clash fake-ip 198.18.0.160，DoH NXDOMAIN，curl 必失败）。不要用 shell 下载。
4. 改用同源代理：`browser_open("https://fxg.jinritemai.com/api/ecomfinance/platform/invoicefile/view?bill_id=<billIds[0]>")`，返回 ZIP（内含 `电子发票1.pdf/.ofd/.xml`）。
5. IDM 拦截时 `browser_downloads` 显示 `interrupted/USER_CANCELED/bytesReceived:0`，这是误报；对每个弹窗用 `windows_control.get_ui_tree` → `invoke_element`（automation_id 1006，名称「开始下载(S)」）确认，再关闭「下载完成」对话框。**每张都要点**。
6. ZIP 内中文名按 GBK 还原：`info.filename.encode("cp437").decode("gbk")`。用 XML 核验购方/销方/金额/票号，三件套分别算 SHA256 入台账。

淘宝「已申请发票」：状态「开具中」时只能等待，数电普票预计 5 天内开具；开具后行内「下载」可直接下 PDF。

## 6. OS 级文件上传（两站三次实测成功）

前置：目标页必须是前台显示标签（`winGetTitle("[ACTIVE]")` 确认标题）。
1. 读按钮中心 client 坐标：`b.getBoundingClientRect()`；屏幕坐标 = client + Chrome 主窗偏移 (8,121)（本机主窗 0,0–2402,1302）。
2. `winActivate("... - Google Chrome")` → AutoIt `mouseClick(x, y)`。
3. `winWait("打开", 5)` → `controlSetText("打开", "Edit1", <绝对路径>)` → `controlClick("打开", "打开(&O)")`。
4. 读页面：文件名进入表格、购方/销方/税率列正确、无"失败/错误/不一致"文本，再走提交。
5. `browser_upload_verified` 的 sha256 选项无法走 OS 路径；文件完整性用 Bash `sha256sum` 在提交前单独核验。

## 7. 证据归档

- 票据按 `dzfp_<票号>_<购方>_<时间戳>.pdf/.ofd` 收进项目归档目录，附 sha256。
- 平台凭证：截图 + 文本双轨。截图用 PowerShell `CopyFromScreen` 保存 PNG（页面须为前台标签）；文本记录保存平台侧原话（提交时间、批次号、状态、金额）。
- 归档说明至少含：平台/收票主体税号/金额/发票号码/状态/凭证号，以及已知差异（备注字段、税率口径）。

## 8. 现场记录与后续

- 现场报告：`docs/FIELD-REPORT-20261118-platform-invoice.md`（P0-0 工具面错配、upload stale、navigate 子串、遮罩、无标签激活、IDM）
- 现场报告：`docs/FIELD-REPORT-20261120-platform-invoice-download.md`（隐藏标签 window.open 静默拦截、内网 TOS、IDM 二次出现、fetch 截断）
- 升级方案：`docs/UPGRADE-PLAN-20261118-platform-invoice-site-feedback.md`（源码坐标 + 验收）
- 全链路复盘：`J:\WorkAndData\双柏彝笙商城\60_店铺经营\平台开票_20261118\复盘_平台开票全链路_20261118.md`
