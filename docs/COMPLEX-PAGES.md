# 复杂网页可操作性用例矩阵

目标：面对重广告、强引导、透明遮罩、客服浮窗、嵌套滚动、虚拟列表、portal 下拉框、sticky 顶栏等复杂页面时，先用只读诊断定位页面结构，再用明确 ref 执行最小写操作，避免坐标猜测和误点。

## 覆盖用例

| 类别 | 典型页面结构 | 风险 | 首选工具 | 兜底策略 |
|---|---|---|---|---|
| Cookie/GDPR 横幅 | fixed bottom/top banner，按钮为“接受/同意/关闭” | 遮挡底部按钮、滚动条 | `browser_scan_overlays` 找 banner 和 closeCandidates | 用 `browser_dismiss_overlay` 点击明确同意/关闭 ref；不明确则只报告候选 |
| 广告弹窗 | centered modal、半透明 backdrop、高 z-index | 点击被 backdrop 截获 | `browser_scan_overlays` + hitTest | 关闭 ref 明确才 dismiss；否则 screenshot/observe 人审 |
| 新手引导/蒙层 | spotlight overlay、Skip/Next/Got it | 目标按钮可见但被透明层挡住 | `browser_scan_overlays` | 优先 Skip/关闭；必要时按步骤点 Next，但每步 verify |
| 客服助手/聊天球 | fixed 右下角 iframe/div | 遮挡提交/上传按钮 | `browser_scan_overlays` | 关闭/最小化 ref 明确才点；否则滚动或避开坐标 |
| 透明点击层 | opacity 0/0.01 overlay，pointer-events auto | DOM 目标存在但点击命中遮罩 | `browser_observe.geometry.covered` + `browser_scan_overlays.hitTest` | 不用坐标强点；先 dismiss blocker 或报告被覆盖 |
| Sticky header/footer | position sticky/fixed | scrollIntoView 后目标在顶栏下面 | `browser_scan_overlays` + `browser_observe` | 使用 ref 点击前 hit-test；必要时滚动微调 |
| 内部滚动容器 | modal body、侧栏、虚拟列表、表格 body | 主窗口滚动无效 | `browser_scan_overlays.scrollContainers` | `browser_scroll_element` 滚动容器 ref，再 read/scan |
| 自定义下拉框 | portal 到 body 的 option 列表 | ArrowDown 猜错，option 不在控件附近 | `browser_pick`/`browser_choose`，`browser_debug.visibleOptions` | exact text；不使用历史坐标 |
| iframe 广告/跨域嵌入 | iframe 覆盖或内嵌表单 | 主 frame 无法读内部 DOM | `browser_scan_overlays.hitTest` / screenshot | 标记 iframe blocker；不尝试越权读跨域 DOM |
| Shadow DOM/Web Component | closed/open shadow controls | 普通 selector 不完整 | `browser_debug` + screenshot | 先用可见文本和 CDP 键鼠；失败报告结构限制 |
| 虚拟列表/无限滚动 | 只渲染可视行 | full read 找不到未渲染项 | `browser_find_text` + `browser_scroll_element` | 分段滚动容器并查找，限制步数 |
| 动画/延迟加载 | skeleton、loading mask | ref 过早、点击未生效 | `browser_wait` / `browser_wait_until_ready` | 等目标文本/状态；不重放写动作 |
| 被 disabled/aria-disabled 控件 | 按钮可见但未启用 | 误判可点 | `browser_read`/`browser_debug` disabled | 等待条件或报告，不强点 |
| 文件上传伪按钮 | 隐藏 input + UI button | 坐标打开系统对话框不可控 | `browser_upload(_verified)` | 只用 DOM file input ref + SHA256 |
| 反爬/验证码 | captcha/cf challenge | 自动操作可能违规/失败 | `browser_observe`/screenshot | 只报告需要用户处理 |
| 多 agent 同页 | 其他 agent 同时读写 | ref 被覆盖、写冲突 | `browser_claim_tab` + 多快照 ref | 写入带 agent；waiting 不结束任务 |

## 默认流程

1. `browser_health` 确认连接、授权、readyState。
2. `browser_scan_overlays` 判断是否有遮挡层、透明 blocker、可关闭候选和内部滚动容器。
3. 若 closeCandidates 明确属于广告/引导/cookie/客服浮层，先 `browser_claim_tab`，再 `browser_dismiss_overlay`，然后重新 scan/read。
4. 若目标在内部滚动容器，使用 `browser_scroll_element` 滚动容器 ref，不盲目滚主窗口。
5. 下拉框使用 `browser_pick`/`browser_choose` exact text；失败时看 `browser_debug.visibleOptions`。
6. 最后才使用 `browser_action` 坐标适配器；坐标前后必须 observe/verify，不自动重放未知写结果。
