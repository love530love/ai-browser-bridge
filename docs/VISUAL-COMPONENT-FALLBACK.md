# 浮窗、客服组件和异常网页兜底

弱 Agent 常见失败不是连接断开，而是页面里有大量没有文字标签的固定组件：客服熊猫、背景音乐、广告、引导层、透明遮罩、Shadow DOM、Canvas 和自定义元素。统一处理顺序如下：

```text
browser_health
→ browser_observe
→ browser_scan_overlays
→ browser_shadow_tree
→ browser_find_element / browser_prepare_action
→ 截图和命中测试
→ Windows UIA / Computer Use
→ 用户确认
```

## 工具契约

- `browser_shadow_tree` 只读枚举 open ShadowRoot、宿主路径和交互控件候选，不执行点击或输入。
- `shadowRootCount > 0` 时，Agent 不得把主页面 textarea 当作浮窗输入框。
- `shadowRootCount = 0` 不能证明组件不存在；可能是 closed ShadowRoot、跨源 iframe 或浏览器原生控件，应转截图/桌面回退。
- 每次视觉点击后必须重新截图或读取状态，确认面板出现、输入框获得焦点或回复气泡出现。
- 坐标点击只允许使用最近截图的视口尺寸和页面 URL；不确定结果不得自动重放。

## 典型组件

覆盖客服聊天、熊猫助手、音乐播放器、翻译工具条、广告弹窗、Cookie 横幅、浮动分享按钮、返回顶部、悬浮购物车、引导遮罩、虚拟列表和 Canvas 控件。

## 为什么要分层

DOM 工具对普通页面最稳定，Shadow DOM 需要路径化遍历，视觉/桌面适配器才能处理 closed ShadowRoot 和 Chrome 原生界面。模型不可用时，健康检查、DOM、ShadowRoot 枚举、截图和等待仍可继续；模型只作为可选规划增强。

