# FIELD REPORT：CNIPA SSO 人工申诉滑块验证（2026-11-24）

> 现场：`https://sso.cnipa.gov.cn/am/#/manual-complaint`（Vue2 + Element UI，滑块组件为 vue-monoplasty-slide-verify 分支）
> 场景：账户法人类型更正申诉，最后一步「安全验证」滑块，2026-11-24 提交成功。
> 结论：**业务跑通**，但桥在「滑动类验证」上有一条会把页面留在半按状态的高危路径，以及一个会让 `anyChange` 误报 `no_change` 的观测盲区。

---

## 一、P1：`browser_action Swipe` 在隐藏标签上超时，并把页面留在未释放的按压态

- **时间线（同一 tab，隐藏状态）**
  1. `browser_prepare_coordinate` 成功，返回 `coordinateToken`（120s）与 `clickRef`（40×40 的滑块块）。
  2. `browser_action {type:"Swipe", ...}` 在扩展内跑了约 **18.5s** 后超时；回读 `.verify-move-block` 的 `left` 停在 **128px**（目标约 334px），组件 `isEnd=false`、`status` 仍为 `true`。
  3. 未重放（符合写操作不确定契约），改用页面内同步合成鼠标事件完成。
- **影响**：站点处于「鼠标按住、滑块半途」状态；后续任何点击/拖拽都可能被当成同一次拖动的一部分。这类残留状态不会自行恢复，只能靠页面自身的 refresh 或刷新页面清掉。
- **根因假设**：Swipe 的分步移动带等待，在隐藏文档里被定时器节流，耗尽了扩展侧预算；超时路径没有补发 `mouseup` 释放按压。
- **建议**：
  1. 超时/失败路径**必须**补发一次 `mouseup`（或 `pointercancel`），保证页面不留按压态；
  2. Swipe 增加 `steps` / `durationMs` 上限，或实现为**单次 tick 内的同步移动序列**（本次证明这条最稳：14 个 `mousemove` 在一个调用里派发完成）；
  3. 文档/capability guide 补一条「滑块验证优先用 `browser_drag mode:"mouse"` 或页面内同步派发，不要用长事务 Swipe」。

---

## 二、P1：`browser_eval_verified` 的 `anyChange` 对纯样式位移不可见

- **现象**：拖动成功后，`.verify-move-block` 的内联 `style.left` 从 `0px` 变为 `198px`，组件状态 `passFlag` 也已变化，但 `expect:{anyChange:true}` 判定**没有变化**。
- **原因**：工具描述里 `anyChange` 的基线只覆盖 **URL、可见文本、DOM 节点数、同源资源数**。滑块拖动只改内联样式与 data 状态，四者都不动，于是 `no_change` 是**定义内**的结果，不是 bug——但对「写操作是否生效」的判断会误导使用者。
- **影响**：所有 canvas/拖动/内联样式类控件（滑块、拖拽排序、绘图、富文本光标）都会踩到；agent 容易误以为写操作没派发而重试，违反不确定不重放原则。
- **建议**（二选一或都做）：
  1. 增加 `anyAttributeChange` / `elementGeometryChange`（带 selector）两个 matcher，或允许 `anyChange` 把 `style` 属性与元素 rect 变化计入；
  2. 至少在 `browser_eval_verified` 描述与排障矩阵里写明「样式/几何变化不算 anyChange，请用回读表达式自行校验」。

---

## 三、P2：后台 tab 的异步 eval 超时无中间态；同步派发是唯一可靠路径

- **现象**：同一次滑块，用 `async` 函数 + `await sleep(30)` 分步移动，`browser_eval` 在约 **18.5s** 超时，页面停在 `left=80px`，没有任何 partial 观测返回。改为完全同步的 14 步派发，一次调用内完成并成功。
- **说明**：隐藏文档节流是 Chrome 事实（KNOWN-LIMITATIONS §1 已写 rAF 不触发、CSS 离场动画会挂）。本次是 `setTimeout` 链被节流，和 rAF 不是同一条路径。
- **建议**：
  1. eval 超时回执附带 `visibilityState` 与「hidden 文档定时器被节流，建议同步派发」的提示（若已有 `timer_hidden_document` 错误码，请核对异步 sleep 路径为何没有命中）；
  2. 文档加一条硬规则：**隐藏 tab 内不要用 sleep 链做多步动作，能同步就同步**。

---

## 四、已实测成功的滑块配方（可直接做回归用例）

1. **找缺口**：皮尔逊相关，按横向偏移比较滑块图 alpha>10 像素亮度与背景图亮度，取 r 最高的偏移 `ox`（本次 `ox=259, r=0.96`）。
2. **坐标换算**：组件判定用 `o = parseInt(moveBlockLeft.replace("px","")) * 310 / parseInt(setSize.imgWidth)`（`imgWidth='400px'`），所以派发终点 `x = ox * 400 / 310`。
3. **先刷新再拖**：`vs.refresh()` 后**立即**拖；服务端 token 约 2 分钟过期，本次多次失败都是「拖的时候 token 已过期」，与拖动本身无关。过期表现是：判定失败后自动换一张新图和新 `secretKey`。
4. **同步派发**（`isTrusted=false` 被站点接受，无需 CDP）：
   ```js
   const barL = document.querySelector('.verify-bar-area').getBoundingClientRect().left;
   const startX = Math.round(barL + 20);
   const endX = startX + Math.round(ox * 400 / 310);
   blk.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:startX,clientY:y,buttons:1,button:0}));
   for (let i=1;i<=14;i++) blk.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:Math.round(startX+(endX-startX)*i/14),clientY:y,buttons:1}));
   blk.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:endX,clientY:y,buttons:0}));
   ```
5. **成功信号**：组件弹层出现「验证通过」/对勾并 1s 后自动关闭；服务端 `POST /validate/behavior/judge` 后不再发新图。失败则 1s 后刷新新图，可据此区分「拖错」与「token 过期」。

---

## 五、非桥问题（记录以免误归因）

- 滑块服务端 token 约 2 分钟过期，与桥无关。
- `browser_click_verified` 的 `timeoutMs` 上限 10000，超过会被拒（本次先传 15000）。提示清楚，仅记录。
- Windows 侧 `TaskStop` 杀后台 python 文件服务时进程快照超时；用 `netstat -ano` + `Stop-Process -Id` 可正常清理，与桥无关。

---

## 六、现场证据

- 浏览器宿主：primary host，tab `663197146`（SSO 用户中心），页面可见 `document.visibilityState="hidden"`。
- 申诉提交：`POST /sso-web/current/manual/appeal/submit` 200（194ms），页面提示「申诉提交成功」。
- 滑块成功：`moveBlockLeft="198px"`、`passFlag=true`；对应 `ox=259`、显示宽度 400、图宽 310。
- 页面文字与截图均为不可信页面数据；本报告不含账号、密码、验证码或令牌。
