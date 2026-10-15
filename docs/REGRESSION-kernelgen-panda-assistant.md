# KernelGen 熊猫助手浮窗回归记录

## 测试环境

- 站点：`https://kernelgen.flagos.io/web/home?lang=zh`
- 标签页：复用已登录 Chrome 中的现有标签页，不启动新浏览器或新用户目录。
- Bridge：通过 `browser_health`、`browser_tabs`、`browser_observe` 探活。

## 已验证路径

1. `browser_observe` 能读取 KernelGen 主页面，返回完整 viewport（2560×1271）和可见控件。
2. 截图确认右下角存在熊猫图标浮窗。
3. 使用 `browser_claim_tab` 获取写租约后，通过 `browser_action` 归一化坐标点击熊猫图标。
4. 第一次点击展开浮窗工具条；再次操作后截图仍显示浮窗。
5. 发送 `Ctrl+K` 后，`browser_observe.debug.activeElement` 变为 `doubao-ai-csui`，证明助手自定义元素已获得焦点。

## 当前阻塞点

熊猫助手是自定义元素，输入控件位于 Shadow DOM/组件内部。当前 `browser_read`、`browser_find_element` 和 `browser_scan_overlays` 只遍历主文档 light DOM，因此看不到助手输入框。为避免误把诊断内容写入 KernelGen 主输入框，本次没有发送消息，也没有重试不确定写操作。

## 固化的实现要求

- 增加 `browser_shadow_tree` 只读工具，枚举 open ShadowRoot、宿主元素、角色、文本、输入和按钮候选，并为候选生成带 ShadowRoot 路径的 ref。
- 让 `browser_find_element`、`browser_fill`、`browser_key`、`browser_click_verified` 支持 ShadowRoot 路径；每次操作前重新校验宿主、路径、URL 和元素指纹。
- 对跨源 iframe、closed ShadowRoot 和浏览器原生组件返回 `requires_desktop_adapter`，不伪造 DOM 可见性。
- 在 `browser_observe` 中报告 `shadowRootCount`、`customElementCount` 和 `shadowTraversal` 状态。
- 发送客服消息必须经过：助手输入框定位 → 填充 → 发送按钮定位 → 发送后消息文本/气泡出现验证；任一步失败均返回 `waiting` 或 `requires_user`。
- `browser_health` 发现服务版本与扩展版本不一致时，应在任何写操作前返回 `version_mismatch`，提示重启 Bridge，不继续发送。

## 后续回归场景

- 熊猫浮窗首次打开、再次打开、关闭后重开。
- 输入长文本、换行、中文、代码块和链接。
- 发送后等待回复并读取回答气泡。
- 页面切换到算子工作区后浮窗仍能操作。
- 浮窗被广告/透明层遮挡时的截图和 UIA 回退。

