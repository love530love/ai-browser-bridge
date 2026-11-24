# 现场报告：`browser_pdf_save` 打印后源标签变 about:blank，且不含打开中的弹窗（CNIPA，2026-11-24）

- 宿主：Windows，Chrome，AI-Browser-Bridge 扩展
- 站点：`toas.sbj.cnipa.gov.cn`（CNIPA 商标网上服务系统，Vue3 + ant-design-vue）
- 关联报告：`docs/FIELD-REPORT-20261124-cnipa-sso-slider.md`（同日 SSO 滑块问题）

## 现象 1：打印完成后，源标签变成 about://blank

### 经过

1. 桥接新建标签打开【我的账户 → 申请管理 → 已提交】列表页，正常可 eval。
2. 调用 `browser_pdf_save`（`printBackground:true`），返回 `status:"success"`、`downloadId`、`bytes`（482,622 / 469,011）。
3. 随后同一 tabId 调用 `browser_eval` 返回：`Site not allowed. Enable all sites or add its origin in extension settings.`
4. `browser_tabs` 复查：该 tab `url:"about://blank"`、`title:null`、`restricted:true`、`restrictedReason:"non_http"`。

### 复现

- 连续两次、两个不同 tab 均复现：
  - tab 663197149：12:10 打印列表页（482,622 B）→ 变 about:blank；
  - tab 663197167：12:15 打印详情（469,011 B）→ 变 about:blank。
- 站点会话未失效：新开 tab 同一 URL 仍能直接进入列表并取到数据（Cookie 在浏览器层保留），只是原标签页被清空。

### 影响

- “打印归档 + 继续读取页面”的流程被打断；打印后必须新开标签并重新导航。
- 若打印前页面处于弹窗/表单中间态，该状态直接丢失。

### 建议排查

- printToPDF 走 download manager 时是否触发了标签级导航/清理；
- 是否为站点自身在打印前卸载文档（Vue 路由）导致；
- 至少应在返回中提示 `tabBlanked:true`，或打印前保存 `location.href` 供恢复。

## 现象 2：打印结果不含打开中的 ant-design 弹窗

- 12:15 场景：列表行已点「查看」，`.ant-modal-wrap` 可见（eval 返回 `modal:true`），1.5 s 后打印。
- 产出 PDF（469,011 B，2 页）用 PyMuPDF 读取文本：**没有**「申请人类型」「95091473」「干食用菌」等弹窗字段，只有列表页表头/行与空白。
- 结论：该通道只打印页面主体，弹窗内容（或弹窗在打印时被隐藏）不在输出中。
- 规避：打印前用 eval 抓弹窗 `innerText` 存档（本次已按此归档文字记录）；需要视觉证据时另用截图通道。

## 现象 3（轻微）：打印下载未出现在 `browser_downloads`

- `browser_pdf_save` 返回的 `downloadId`（2327/2328）在随后 `browser_downloads`（limit 3/5）中查不到，列表最新仍是更早的 2324。
- 文件实际落在默认下载目录（`E:\Downloads`），名称为 `download (1).pdf`，需按 `bytes` 识别。
- 建议：`browser_pdf_save` 返回最终落盘路径，或让 `browser_downloads` 收录打印任务。

## 最小复现清单

1. `browser_open` 任意 http 页面 → `browser_pdf_save`；
2. 观察该 tab 是否 `about://blank`；
3. 打开一个 antd 弹窗后再打印，检查 PDF 文本是否含弹窗字段。
