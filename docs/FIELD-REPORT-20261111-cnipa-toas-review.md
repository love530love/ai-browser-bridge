# FIELD REPORT：CNIPA 商标网上服务系统驳回复审全流程（2026-11-11）

> 目标站点：`sso.cnipa.gov.cn` → `toas.sbj.cnipa.gov.cn`（React + antd 5）
> 场景：第 93829735 号「彝笙」第 35 类驳回复审，2026-11-11 16:05:49 提交成功（评审号 20260000250975）
> 结论：**全流程跑通**，但桥在「文件上传」和「后台 tab 动画」两处存在硬伤，需要改。

---

## 一、阻断级问题（必须绕过，不改就跑不通）

### P0-1 上传 MIME 只识别 zip/json/txt/csv，PDF 被标成 octet-stream

- 现象：`browser_upload` 传 PDF 成功返回，但 CNIPA 前端校验拒绝，提示「上传文件格式不正确,无法上传」。
- 根因：桥根据扩展名推导 MIME，未覆盖 `.pdf`。
- 影响：所有政务/表单站点的 PDF 上传全部不可用。
- **建议修复**：MIME 表补 pdf/png/jpg/docx/xlsx 等常见类型；或增加 `mimeType` 显式参数。
- 临时绕过：见 P0-3。

### P0-2 上传 16 MiB 上限 + uploadRoots 不热加载

- 现象：>16 MiB 文件直接被拒；把材料目录加进 `uploadRoots` 后仍不生效。
- 根因：上限硬编码；配置只在服务启动时读取。
- 影响：合并证据 PDF 普遍在 5–30 MB，直接不可用。
- **建议修复**：上限提到可配置；`uploadRoots` 支持热加载或提供 reload 接口。
- 临时绕过：本地 HTTP 中转。

### P0-3 隐藏 `input[type=file]` 被判定 "Element unavailable or protected"

- 现象：antd 的 Upload 组件把 input 设为 `display:none`，`browser_find_element` / `browser_upload` 无法定位。
- 影响：所有 antd Upload 场景（大量政企后台）。
- **建议修复**：`browser_upload` 支持按 selector 直接塞 `DataTransfer`，允许操作 `display:none` 的 file input。
- 临时绕过（本次采用，稳定）：

```js
// 页面内执行（mode: write）
const rel = encodeURIComponent('01_事实与理由.pdf');
const r = await fetch('http://127.0.0.1:8767/?rel=' + rel);
const blob = await r.blob();
const file = new File([blob], '01_事实与理由.pdf', { type: 'application/pdf' });
const input = document.querySelectorAll('input[type=file]')[i];
const dt = new DataTransfer();
dt.items.add(file);
input.files = dt.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
```

本地服务见 `docs/FIELD-REPORT` 同目录附录或项目侧 skill `cnipa-trademark-online` 附录 A。

---

## 二、可靠性问题（会静默失败，浪费大量时间）

### P1-1 后台 tab 的 antd 离场动画卡死，遮罩永久拦截点击

- 现象：点「确定」后 `.ant-modal` 停在 `ant-zoom-leave ant-zoom-leave-active`，`transform: matrix(0.2,…)`、`opacity: 0`；`.ant-modal-wrap` 仍 `pointer-events: auto`，之后所有 click 无效但**不报错**。
- 根因：后台 tab 被 Chrome 节流，CSS animation 的 `animationend` 不触发，antd 等不到卸载回调。
- 影响：任何 antd 弹窗站点；表现为「点击没反应」的假死。
- **建议**：`browser_eval` 增加可选 `activateTab: true`（点击前把 tab 切前台）；或在 click 失败时自动检测覆盖层并提示。
- 临时绕过：
```js
document.querySelectorAll('.ant-modal-wrap').forEach(w => w.style.pointerEvents = 'none');
```

### P1-2 服务重启后 primary host 漂移

- 现象：重启 Bridge 服务后，默认 host 变成另一个扩展实例（本次是 "ChatGPT"），所有调用打到错误浏览器，表现为「页面没变化」。
- 影响：跨会话极易误判为「页面没响应」。
- **建议**：`browser_open` 首次调用必须显式 hostId；或返回当前 host 名称供日志核对。
- 绕过：会话内固定 `hostId: "h-0b47a521c4384e90beb4"`（本次实例，跨会话会变，勿硬编码）。

### P1-3 元素在视口外时 find_element 找不到

- 现象：「预览」按钮在折叠区域下方，`find_element` 返回空。
- 绕过：`el.scrollIntoView({block:'center'})` 后再点，或直接 `[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '预 览')`。
- **建议**：find_element 内部先 scrollIntoView 再匹配。

### P1-4 ref 在重渲染后失效

- 现象：`browser_at` 拿到的 ref 在弹窗关闭、步骤切换后失效，点击落到旧节点或报错。
- 绕过：每次交互前重新取 ref；或改用文本/选择器定位。
- **建议**：文档中明确 ref 生命周期。

### P1-5 三个下拉共用一个 id

- 现象：省/市/区选择器 `id` 相同，`querySelector` 永远只拿到第一个。
- 绕过：`querySelectorAll('#id')[n]` 或按 label 就近定位。
- 备注：这是站点问题，但桥的 find_element 同样会命中错误元素，建议文档提示。

### P1-6 JS eval 超时与页面加载竞态

- 现象：点击「下一步」后立即 eval，DOM 还没渲染完，返回空。
- 绕过：轮询等待目标元素出现（`waitFor` 式），不要固定 sleep。
- **建议**：内置 `browser_wait_for_selector`。

---

## 三、交互配方（antd 5 实测有效）

| 组件 | 错误做法 | 正确做法 |
|---|---|---|
| Input/TextArea | `el.value = v` | 原生 setter + `dispatchEvent(new Event('input',{bubbles:true}))` |
| Select | 点 selector 后立刻找选项 | `mousedown/mouseup/click` 三步打开，选项在 body 下 `.ant-select-dropdown`，延时 300ms 再点 |
| Radio/Checkbox | 点 `input` | 点 `.ant-radio-wrapper` / `.ant-checkbox-wrapper` |
| Button | 点 `button` 有时无效 | 点内部 `span` 或对 button 派发完整鼠标事件序列 |
| Modal 确定 | 直接 click | 先确认无 `ant-modal-wrap` 残留遮罩 |

---

## 四、站点侧问题（非桥缺陷，但会误导自动化）

1. **「阐述事实与理由」200 字硬上限**，无 `maxlength` 属性，超限静默截断或报错。长文必须走 PDF。
2. **联系地址只自动填充到县/区级**，门牌号需手工补全；预览页会显示截断，需回步骤1 改。
3. **下拉里出现 "+ 0 ..." 的透明项**，是 antd 溢出占位（`opacity:0;height:0`），不是错误。
4. **提交后需微信小程序扫码**，二维码 2 分钟过期，无法自动化，必须人工介入。
5. **缴费递延**：提交当天【我的收文】【待支付业务管理】【支付状态查询】全空，属正常；缴费通知书几天后才到。
6. 类别行、附件位在步骤切换后会重新挂载，之前填的值可能被重置，**每次回退都要复核**。

---

## 五、本次成功的完整路径（可复现）

1. `browser_open` + 固定 hostId → 打开 sso 登录页。
2. 填三要素（信用代码/密码/验证码）→ 登录 → 自动跳 toas。
3. 直接访问复审入口 `.../review/reject?code=toas_0050401`。
4. 步骤1：填商标号、发文编号、补充证据=是；地址补全到门牌号。
5. 附件：本地 8767 服务 + 页面内 fetch → File → DataTransfer → change，逐个上传 5 个 PDF（事实理由、证据目录、证据内容、驳回通知书、主体资格）。
6. `scrollIntoView` 后点「预览」，逐项核对；发现地址截断 → 点「修改」→ 步骤1 改 → 再「下一步」→「预览」。
7. 点「提交」→ 二维码导出 PNG → 用户微信扫码 → 成功页（评审号 20260000250975）。
8. 截图存档；建缴费待办。

---

## 六、给 Bridge 的优先级建议

| 优先级 | 事项 |
|---|---|
| P0 | PDF/常见文档 MIME 识别 |
| P0 | `browser_upload` 支持隐藏 file input（selector + DataTransfer） |
| P0 | 上传上限可配置 + uploadRoots 热加载 |
| P1 | 点击前自动激活 tab / 检测遮罩覆盖层 |
| P1 | `browser_wait_for_selector` |
| P1 | find_element 自动 scrollIntoView |
| P2 | host 漂移告警；ref 生命周期文档化 |

---

## 七、注册申请模块实测补充（Vue 3 + qiankun，2026-11-11 18:37）

> 与评审模块（React + antd5）**不是同一套**。入口 `.../onlineApplication/applyRegister/registerApply?code=toas_00501`；申请号 94896138。

### P1-7 「下载」按钮点击无效（无任何可观测副作用）

- 场景：【我的账户】→【申请管理】→【已提交】列表行内「下载」。
- 现象：`browser_click` 返回 `clicked:true`，页面指纹无变化；随后查无弹窗、无 toast、无新下载记录、`window.__errs` 为空。
- 排除：`document.hidden` 为 true（见 P1-8），但已 `browser_windows_control` 把窗口 `state:maximized, focused:true`（返回 `focusRequested:true`）后重试，仍无下载；也排除了遮罩（`overlayControls:0`）。
- 结论：**不要依赖该按钮**。归档改用 `browser_pdf_save`（实测成功，493KB，`E:\Downloads\download (1).pdf`）。
- 建议：对「点击成功但零副作用」的按钮增加 `effect:"none"` 提示，避免调用方反复重试。

### P1-8 `document.hidden` 与窗口焦点脱钩

- 现象：`browser_windows_control` 报告窗口 `focused:true, state:maximized`，但页面内 `document.hidden === true` 持续存在；`browser_screenshot` 仍能出图（会临时开 screencast 强制一帧）。
- 影响：定时器被节流，antd 离场动画依旧可能卡死；`document.hidden` 不能作为「tab 是否可见」的唯一判断。
- 建议：`browser_health` 同时暴露每个 tab 的 `visibilityState`，并在写操作前提示「timers throttled」。
- **复核更正（2026-11-11，对照 0.37.4 源码）**：前半句**已实现**——`extension/worker.js:700-701` 已返回 `documentFocused` / `visibilityState`，`:922-924` 已给 `document_hidden` / `window_not_focused` / `document_unfocused` advisories，`src/tools.js:289` 的 `browser_health` 描述也已涵盖。本轮只需补写操作前的 `throttled:true` 警告与 nextStep，不要重复造基础读数。

### P1-9 商品导入（Excel）路线是死按钮

- 现象：「商品导入」→ 确认「确定」后：无 `input[type=file]` 创建、无 XHR/fetch、无 `window.onerror`/`unhandledrejection`；给 `HTMLInputElement.prototype.click` 打补丁也未捕获调用。
- 唯一可用的替代：弹窗「添加所选商品」逐条检索勾选（30 项约 30 轮，可用页面内队列跑）。
- 建议：对「点了确定但无网络/无 DOM/无文件框」的确认类弹窗，提供 `diagnoseFlow` 输出（类似本报告的证据链）。

### P2-3 Vue 3 生产包仍暴露表单模型（可用于诊断，注意 PII）

- `#app.__vue_app__` 存在，向下遍历 `subTree` 可按组件名找到 `action-form`；`setupState.formNewState` 即完整表单模型（地址、附件数组、商品列表），`setupState.isRules` 是校验规则。
- 用途：表单校验失败被打回时，直接读模型定位空字段，比在 DOM 里猜快一个数量级。
- 注意：模型含身份证/营业执照 OCR 结果，日志里不要整包打印。

### P2-4 预览页 textarea 值不在 innerText

- 现象：预览页用**可编辑 textarea** 渲染详细地址与商标说明，`innerText` 里只有 label，没有值；`addrNodes: []` 会误判「地址为空」。
- 正确核验：读 `input/textarea.value`，或读 `formNewState`。
- 建议：`browser_read` 增加 `includeFormValues:true` 选项，把 input/textarea/select 的当前值并入文本。

### P2-5 提交二维码 108 秒、无刷新入口

- 弹窗：`请使用商标局网上服务小程序扫码确认 | 二维码将在 108 秒后过期`；二维码是 200×200 `<img>`，只有关闭按钮。
- 过期/错过只能关闭后重新点「提交」（未扫码不会产生申请号，重提未见重复申请）。
- 与评审模块的 2 分钟二维码一致，但文案更精确（108 秒），可据此做倒计时提醒。
