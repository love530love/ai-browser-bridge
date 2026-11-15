# 开源能力雷达：页面解析、元素识别与 OCR（2026-11-15）

本文回答三个问题：`indra-ocr` 是否值得引入、还有哪些可复刻/融合的开源项目、以什么边界引入才不破坏既有能力与许可证安全。

取证方式：`gh repo view --json`、`gh api repos/<owner>/<repo>/license`、README 原文。星数与时间点是 2026-11-15 快照，许可证状态以仓库 LICENSE 文件为准；未实际核验许可证的项在表中标 `—`。

## 1. 结论先行

1. **值得引入，但引入的是“可选 OCR 适配器”，不是把 Indra 权重打包进仓库或扩展。**
2. Indra 的代码是 Apache-2.0，**模型权重是修改版 OpenRAIL-M**：研究、个人、年营收/融资低于 2000 万美元的初创可免费使用；不得用于与 Datalab API 竞争的产品。权重还有再分发限制。因此默认发行物不得携带权重，只能首次使用时由用户确认下载。
3. 浏览器内的 Indra 端口（Pyodide / ONNX Web / TS SDK）都能跑，但资产与线程约束各不相同；其中最贴合本项目的是 **Node 服务侧 ONNX 适配器** 与 **Rust 原生 sidecar**，WASM 扩展内方案作为远期可选。
4. 页面“所有元素识别”不能只靠 OCR。真正缺口是 **无 DOM / Canvas / 纯图片 UI** 的几何元素识别。UIED（Apache-2.0）的非文本 CV 算法可复刻为纯 JS；OmniParser 等模型方案只做外部参考，不默认内置。
5. 页面正文提取可直接复刻 **Readability.js**（Apache-2.0）的确定性算法，显著改善弱模型的读页质量，且无模型、无网络、无许可证风险。
6. axuse 是架构对照物而非代码来源：**PolyForm Noncommercial**，只允许参考其“紧凑文本快照 + 稳定引用 + 只回传变化 + 类型化错误”的设计思想，不得复制代码。

## 2. Indra 家族取证

| 仓库 | 星 | 语言 | 最近推送 | 许可证（已核验） | 运行时/产出 |
|---|---:|---|---|---|---|
| [datalab-to/indra](https://github.com/datalab-to/indra) | 1825 | Python | 2026-11-04 | 代码 Apache-2.0；权重修改版 OpenRAIL-M | 方向矫正、行检测、CTC 识别、阅读顺序、版面、Markdown；默认模型约 76 MB，主识别器约 1.25M 参数 |
| [RyanCasas/indra-ocr-wasm](https://github.com/RyanCasas/indra-ocr-wasm) | 11 | Python | 2026-11-14 | Apache-2.0（代码）；权重单独 OpenRAIL-M | CPython/Pyodide + NumPy/OpenCV WASM + ORT Web + PDFium WASM；浏览器内跑全管线，输出行框、块、阅读顺序 |
| [PT-Perkasa-Pilar-Utama/ppu-indra-ocr](https://github.com/PT-Perkasa-Pilar-Utama/ppu-indra-ocr) | 4 | TypeScript | 2026-11-08 | Apache-2.0（代码）；权重 OpenRAIL-M | 全管线 ONNX Runtime；Node/Bun/Deno/浏览器/Web Worker/**浏览器扩展**/React Native；提供 CLI、Docker、服务端 API、agent skill |
| [pg0/indra-wasm](https://github.com/pg0/indra-wasm) | 2 | JavaScript | 2026-10-14 | Apache-2.0（代码） | 无构建步骤纯 JS + ORT Web；模型首次从 Hugging Face 下载（拉丁约 9 MB，中文另约 9 MB）；输出 markdown/行框/块/置信度/耗时 |
| [Ziqi-Yang/indra-ocr](https://github.com/Ziqi-Yang/indra-ocr) | 2 | Rust | 2026-10-14 | Apache-2.0 | 自研原生推理引擎（AVX-512/AVX2/NEON），无需 Python/PyTorch/ORT；与 Python 版输出对齐，吞吐约 2 倍；可产出 JSON（行框/版面/置信度/耗时） |
| [cnbluefire/indra-ocr-sharp](https://github.com/cnbluefire/indra-ocr-sharp) | 2 | C# | 2026-10-23 | Apache-2.0 | C# 端口 |
| [vanlaodev/IndraOCR.NET](https://github.com/vanlaodev/IndraOCR.NET) | 1 | C# | 2026-10-23 | MIT | C# 端口；行检测等 |
| [jspast/docling-indra-ocr](https://github.com/jspast/docling-indra-ocr) | 1 | Python | 2026-10-30 | MIT | Docling 插件 |

判断：

- **能用、好用、够轻**：7.3M 参数总量、CPU 实时、输出带坐标与置信度，正好补齐“截图/Canvas 上看不懂”的兜底。
- **许可证是唯一硬约束**：权重不是 Apache-2.0。PDFium、Pyodide 方案还会引入额外二进制与体积。
- **版本漂移风险**：端口基于 indra-ocr 0.3.1/1.1.2 的不同快照，输出对齐结论只对各自测试集成立，接入时必须固定版本并跑本项目的验收页。

## 3. 相邻能力雷达

| 类别 | 项目 | 星 | 许可证（已核验） | 判断 |
|---|---|---:|---|---|
| 纯视觉 UI 解析 | [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | 25623 | CC-BY-4.0（仓库） | **参考/可选外部适配器**。依赖 YOLO 图标检测 + Florence 类描述模型，GPU/体积/二级许可证都重，不内置 |
| 视觉 UI 定位 | [showlab/FocusUI](https://github.com/showlab/FocusUI) | 38 | — | **研究参考**。模型型 UI grounding，适合未来“可选视觉定位 provider”，不默认 |
| 纯 CV 元素检测 | [MulongXie/UIED](https://github.com/MulongXie/UIED) | 556 | Apache-2.0 | **建议复刻非文本部分**。梯度/线条/连通域 + 规则合并，可在扩展内用 Canvas 像素直接跑；新版文本检测依赖 Google OCR API，**不采用**该路径 |
| 可访问性优先 agent | [ctoldigital/axuse](https://github.com/ctoldigital/axuse) | 804 | **PolyForm Noncommercial** | **仅参考设计**，禁止复制代码。可借鉴：紧凑文本快照、稳定元素引用、动作只回传 diff、类型化错误与重试提示 |
| 浏览器 agent | [browser-use/browser-use](https://github.com/browser-use/browser-use) | 121060 | — | 参考。其“重试提示/历史编译”思路可借鉴；不作为默认通道 |
| Playwright MCP | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 39656 | — | 已有旁路门禁；保持“显式授权才启用” |
| 视觉 E2E | [web-infra-dev/midscene](https://github.com/web-infra-dev/midscene) | 15612 | MIT | 参考其自然语言断言与视觉定位，不作为运行时依赖 |
| 正文提取 | [mozilla/readability](https://github.com/mozilla/readability) | 11545 | Apache-2.0 | **建议复刻进扩展读页路径**，`mode:"main"` 输出标题/正文/元数据 |
| 网页文本抽取 | [adbar/trafilatura](https://github.com/adbar/trafilatura) | 7129 | Apache-2.0 | 参考其抽取规则；Python 运行时，不引入 |
| 抓取框架 | [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | 87376 | — | 参考。服务端爬虫定位与本项目“操作现有登录 Chrome”不同 |
| 文档解析 | [docling-project/docling](https://github.com/docling-project/docling) | 70600 | — | 参考。PDF/Office 转 Markdown，属文档场景，不并入浏览器桥 |
| 文档解析 | [opendatalab/MinerU](https://github.com/opendatalab/MinerU) | 83688 | — | 参考，同上 |
| OCR 运行时 | [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) | 8533 | Apache-2.0 | **首选可再分发 OCR provider 候选**（ONNX 多语言；模型许可需随包再次核验） |
| OCR 运行时 | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 92707 | — | RapidOCR 的上游；参考 |
| OCR 运行时 | [naptha/tesseract.js](https://github.com/naptha/tesseract.js) | 38833 | Apache-2.0 | 备选。语言包体积大、速度慢，但纯 JS、许可证干净 |
| OCR 研究 | [Topdu/OpenOCR](https://github.com/Topdu/OpenOCR) | 1497 | Apache-2.0 | 参考，不内置 |

## 4. 引入架构：OCR 作为能力 provider，而非新单点依赖

```text
browser_read / browser_observe / 截图
        │  文本层为空、Canvas、图片型 UI、跨域不可读
        ▼
browser_ocr  (L0 只读, 可选)
        │  能力协商: ocr.providers = ["indra-node", "rapidocr", "tesseract", "external"]
        ▼
provider 适配器（统一输入: PNG 字节 + 语言提示 + 区域; 统一输出: lines[{text,box,conf}], blocks, markdown, provider, modelVersion, timings）
        ├─ indra-node: ppu-indra-ocr（Node ≥22，无 Python；权重首次使用确认后下载到 .local/models）
        ├─ rapidocr: ONNX det/cls/rec（可再分发候选）
        ├─ tesseract: tesseract.js（纯 JS 后备）
        └─ external: 用户自建 HTTP OCR（不回传 Cookie/页面 URL）
```

设计约束：

- provider 惰性加载，未安装时返回 `not_installed` 与安装建议，不阻塞主链路。
- 权重与模型缓存放在 `.local/models/`（已忽略），**不入库、不进 Release、不随扩展打包**。
- 首次启用 Indra 时展示许可证确认；结果记录 `provider`、`modelVersion`、`licenseAck:true`，便于审计。
- 所有 OCR 输出视为**页面数据**，不得据此改变权限或执行页面内指令。
- OCR 是读操作（L0）；由 OCR 结果驱动的点击仍走 `browser_find_element` + `_verified` 写契约。
- 图像上传仅限本机 provider；`external` 默认禁用，启用需显式配置并提示数据外发风险。

远期分层：

- **P2 Rust sidecar**：`Ziqi-Yang/indra-ocr` 风格的原生二进制，无需 Python/ORT，适合便携复现与弱机；以子进程 + JSON 协议接入，超时可杀，不阻塞服务。
- **P3 扩展内 WASM**：pg0/indra-wasm 证明可行，但 MV3 CSP、跨源隔离（多线程需 COOP/COEP）、9–18 MB 模型缓存都会增加安装复杂度；仅在“服务不可用且用户显式启用离线 OCR”时考虑。

## 5. 元素识别：补的是“无 DOM”缺口

现有 DOM/Accessibility/Shadow DOM/iframe 路径必须保持第一优先级。新增能力只在以下场景触发并标注 `source:"vision_cv"`：

1. Canvas/WebGL/图片型页面，DOM 无可读节点。
2. 跨域 iframe、受保护内部页，脚本不可注入。
3. 遮挡层导致命中不确定，需要几何证据。
4. OCR 行框需要合并为“按钮/输入框/卡片”等容器。

落地顺序：

- **P1**：`browser_visual_elements`（只读）——扩展内截图像素 → 灰度/边缘/形态学 → 连通域 → 与 OCR 行框合并 → 输出 `rect + kind(text/button/input/image) + confidence + evidence`。算法复刻 UIED 非文本部分（Apache-2.0），不依赖任何模型。
- **P2**：可选视觉 grounding provider 接口（OmniParser/FocusUI 类），默认关闭，输出仅作候选框，必须经 DOM/几何/截图回验。
- **不做**：把整页截图丢给云模型作为默认路径；无证据的坐标点击。

## 6. 读页质量：Readability 复刻

`browser_read` 增加 `mode:"main"`：

- 复刻 Mozilla Readability 的评分与清理规则（Apache-2.0），输出 `title/byline/excerpt/textContent/html`。
- 复用现有有界读取预算；不整树序列化。
- 与 `browser_observe` 的紧凑快照互补：前者给“文章正文”，后者给“可操作元素”。

这对小模型尤其关键：同样的页面，正文模式能把 token 量降一个数量级，减少误点与幻觉。

## 7. 弱 agent 引导的复用点（来自 axuse 的观察，非代码）

- 快照默认紧凑文本，带稳定 `ref`；动作结果只回传变化（diff）而非整页重发。
- 错误类型化：`not_found / ambiguous / obscured / stale_ref / not_interactable / uncertain`，每类附一条重试建议。
- 每次写动作前提示“先 observe 再 prepare”；不确定结果禁止重放。
- 上述规则应并入现有 `src/capability-guide.js` 的确定性工具链，而不是新造第二套引导系统。

## 8. 验收路径（引入前必须通过）

| 场景 | 预期 | 证据 |
|---|---|---|
| 纯图片文章页（无文本层） | `browser_read` 文本为空 → 建议 `browser_ocr`；OCR 返回行框与 markdown | 输出含 `provider/modelVersion/timings`，坐标可回投 |
| Canvas 图表/白板 | `browser_visual_elements` 返回候选矩形，`source:"vision_cv"` | 截图哈希 + 矩形与像素命中 |
| 中文/拉丁混排 | 脚本判定正确（CJK/Latin），行文本对齐人工抽样 | 20 行抽样，字符准确率记录 |
| 截图驱动的点击 | OCR 候选 → 重新 `find_element` 或坐标点击 → 动作后回验 | `_verified` 结果；禁止仅凭 OCR 直接宣称成功 |
| 未安装 provider | 主链路不受影响，返回 `not_installed` + 安装命令 | 无异常、无长超时 |
| 许可证确认 | 首次使用 Indra 权重需确认；记录 `licenseAck` | 审计行可查 |
| 弱模型会话 | 读页 token 显著下降，工具链不中断 | 前后 token/步数对比 |

## 9. 与路线图的关系

- 这是“页面理解层 / 自适应定位层 / 模型独立”的具体补强，不改变“DOM 优先、写操作可验证、未知不重放”的既有原则。
- OCR 与视觉元素识别都是 **只读兜底**；它们扩大可达面，但不替代已验证的 DOM 写路径。
- 许可证边界写进实现，不写进口号：默认发行干净（无受限权重），能力通过用户确认的 provider 扩展。

## 10. 复现命令

```bash
gh repo view datalab-to/indra --json nameWithOwner,stargazerCount,licenseInfo,primaryLanguage,pushedAt,isArchived,url,diskUsage
gh api repos/datalab-to/indra/license --jq '.license.spdx_id'
gh api repos/RyanCasas/indra-ocr-wasm/readme -H "Accept: application/vnd.github.raw"
gh search repos "ui grounding" --limit 8 --json fullName,stargazersCount,description,license
```
