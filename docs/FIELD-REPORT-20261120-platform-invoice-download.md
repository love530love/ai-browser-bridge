# 现场报告 2026-11-20：平台给我方开票 —— 抖店历史发票下载、隐藏标签 window.open、外部下载管理器

- 环境：Extension 0.48.0（`browser_health` connected）、Chrome 156.0.8078.49、Windows 11、IDM 常驻
- 场景：抖店「平台给我开票」历史列表 9 张发票，逐张下载 ZIP（PDF/OFD/XML 三件套）并归档
- 结论：9 张全部获取成功；但自动化路径必须绕开页面自带的「下载发票」按钮，且下载完成不能以 `browser_downloads` 为证据

## 1. 发现

### P1-1 隐藏标签下「下载发票」点击静默无效（window.open 被拦截且无回执）

页面 chunk 里的下载逻辑：

```js
handleDownloadInvoice: e => {
  (0,T.Jm)(e.record_id).then(t => {
    let i = t?.ret_data?.electron_invoice?.file_path || "";
    (0,lt.Z)("/api/ecomfinance/platform/invoicefile/view?bill_id=" + n, {blank:!0})
      : (0,I.k_)(i, {blank:!0})
  })
}
```

`blank:!0` 即 `window.open(url, "_blank")`。在后台标签 + CDP 合成点击（无用户激活）下：

- `browser_click_verified` 回执为点击已派发，但 `browser_network_summary` 请求数 0、`domDelta` 0、无新标签、无下载条目
- 页面文本仍正常，读起来像"点过了"，实际什么都没发生
- 同一 URL 用 `browser_open` 打开（前台/后台均可）能触发 ZIP 下载

**建议**：下载类点击在回执中区分"页面无反应"与"被弹窗拦截"。可在点击后短窗口内检查 `popup_blocked` 事件（CDP `Page.javascriptDialogOpening` 不覆盖，需监听 `window.open` 返回值/扩展层），或直接提供 `browser_download` 类能力：给定 URL 在目标标签内以 `download` 语义导航，并返回 downloadId。至少应在 `click_verified` 的 `nextStep` 中提示"该控件疑似 window.open 下载，后台标签可能被拦截，改用 browser_open URL"。

**现场绕行**（已验证）：不点按钮，直接 `browser_open("https://fxg.jinritemai.com/api/ecomfinance/platform/invoicefile/view?bill_id=<bill_id>")`，由浏览器触发 ZIP 下载。

### P1-2 detail API 的 `file_path` 指向内网 TOS 域名，公网不可解析

- `record/detail` 返回 `ret_data.electron_invoice.file_path = http://ecom-finance-app-core.tos-cn-north.byted.org/...ofd`
- 本机 Clash fake-ip 将该域名解析到 198.18.0.160；公网 DoH（223.5.5.5、1.12.12.12）均 NXDOMAIN
- `curl` HTTP 空响应、HTTPS schannel 握手失败、7897 代理连接被中止

**结论**：`file_path` 只能在字节侧可路由的环境使用；本机自动化必须改走平台同源代理接口 `invoicefile/view?bill_id=<billIds[0]>`（返回 ZIP，内含 `电子发票1.pdf/.ofd/.xml`）。这不是 Bridge 缺陷，但建议在文档中以"平台 detail API 的文件地址可能是内网对象存储"作为通用警示案例。

### P1-3 IDM 接管下载时 `browser_downloads` 无法作为完成证据（11-18 报告 P2-1 的二次出现）

- Chrome 下载条目：`state:"interrupted", error:"USER_CANCELED", bytesReceived:0, canResume:false`
- 实际是 IDM 弹出「下载文件信息」#32770 对话框，点「开始下载(S)」后落盘 `E:\Downloads\Compressed\<record_id>.zip`
- 下载完成后另弹「下载完成」#32770，需要关闭

**建议**：沿用 11-18 的 `external_download_manager_suspected` 字段，并把它升级为 P1：在 IDM 常驻环境下，`browser_downloads` 的 `interrupted/USER_CANCELED/bytesReceived:0` 是**误报失败**，会诱导 agent 重放下载。回执应附带检测到的外部管理器窗口标题与可执行的 `nextStep`（Windows UI Automation 点「开始下载」）。

**现场确认方式**（可靠）：`windows_control.get_ui_tree` 找到 `ButtonControl` 且 `automation_id=1006`，用 `invoke_element`（Invoke pattern）点击；`click_element` 的屏幕坐标点击受 DPI 缩放影响会报成功但无效。

### P2-1 `browser_fetch` 截断响应体且无续读机制

- `maxResponseChars: 900` 时 `record/detail` 的 `file_path` 查询串签名被截断（`tos-signature=` 后为空），无法排查
- 提到 1700 才完整（签名实际 30 字符，但前后字段很长）
- 回执没有 `originalLength`/`truncatedAt`，只有被截断的 `bodyText`

**建议**：回执增加 `originalLength`、`truncated:true` 与建议值；或支持 `maxResponseChars` 之外的 `offset` 续读。对 JSON 端点，默认上限可提高到 8–16KB。

### P2-2 正向验证：`browser_capture_element` 在隐藏标签可用

对淘宝发票页（tab 663196931，非 active）抓取「查看详情」按钮：

- 返回 `56×15` CSS px，`scale:2`、`padding:8`，`warmup.frames:1`、`sideEffects:["hidden_tab_frames_forced_for_capture"]`
- 不激活标签、不写页面，适合核对小控件/验证码
- 几何以 CSS px 计，需自行乘以 scale 换算像素

这是本轮唯一无需绕行的新工具，行为符合说明。

### P2-3 OS 级坐标点击受 DPI 缩放影响（复核 11-18 结论）

- 同一对话框，`screen rect` 在 2560×1440 与 3840×2160 两种读数间变化
- `click_element` 报 `clicked:true` 但对话框未关闭；改用 `get_ui_tree` + `invoke_element` 成功
- 建议 Bridge 的坐标工具明确回报 `devicePixelRatio`/缩放比例，或在文档中要求优先使用 UI Automation pattern 而非屏幕坐标

## 2. 可复用配方：抖店历史发票批量下载

1. 在「平台给我开票 → 历史」读取每行 `record_id`（与提交回执里的 `batch_no` 相同，进度页 URL 可直接取）。
2. `browser_fetch` GET `/api/ecomfinance/platform/invoice/record/detail?record_id=<id>`，`maxResponseChars≥1700`，取：
   - `ret_data.electron_invoice.file_path`（内网 TOS，勿直接访问）
   - `ret_data.invoice_info[0].invoiceNo / invoiceDate`
   - `ret_data.billIds[0]`、`invoice_amount`（分）、`company_name`、`invoice_title`、`credit_code`
3. `browser_open("https://fxg.jinritemai.com/api/ecomfinance/platform/invoicefile/view?bill_id=<billIds[0]>")` 触发 ZIP 下载。
4. IDM 弹窗逐张确认：`get_ui_tree` → `invoke_element("开始下载(S)", automation_id=1006)`；完成后关闭「下载完成」对话框。**每张都要点，不能只点一次**。
5. ZIP 内文件名是 GBK：`info.filename.encode("cp437").decode("gbk")` 还原中文名，按扩展名落盘。
6. 用 XML 核验购方/销方/金额/票号，计算 PDF/OFD/XML 三件套 SHA256，写入台账。

## 3. 验收清单（建议加入回归）

| 优先级 | 用例 | 通过标准 |
|---|---|---|
| P1 | 后台标签点击 `window.open` 下载按钮 | 回执明确 `popup_blocked`/`no_effect`，或 `browser_download` 可直达 |
| P1 | IDM 接管下载 | `browser_downloads` 标记 `external_download_manager_suspected:true` 并给 nextStep |
| P2 | `browser_fetch` 大响应 | 回执含 `originalLength/truncated`，或支持续读 |
| P2 | `browser_capture_element` 隐藏标签 | 已通过（本轮实测） |
| P2 | OS 坐标点击 DPI | 回执含缩放信息，或文档禁用坐标优先 |

## 4. 资产

- 归档：`J:\WorkAndData\双柏彝笙商城\60_店铺经营\进项发票\2026\平台给我方开票_20261119\抖店\`（9 张 × PDF/OFD/XML = 27 个文件，SHA256 已登记）
- 台账：`进项发票登记表_2026.md` §5.2–5.4
- 相关：`docs/FIELD-REPORT-20261118-platform-invoice.md`（P2-1 首次记录 IDM）、`skills/platform-invoice-upload/SKILL.md` §5.5
