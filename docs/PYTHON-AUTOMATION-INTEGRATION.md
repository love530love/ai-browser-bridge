# Python 自动化能力接入方案

用户提供的 Python 库清单可以显著扩展 AI Browser Bridge，但这些库解决的是“数据和文件处理”，并不等于浏览器操控能力。项目采用按需侧车架构：Bridge 保持轻量、离线可用和权限可控；Python Worker 只在任务需要时启动，并通过受限目录和结构化 RPC 接入。

## 能力映射

| 能力域 | 推荐库 | 接入方式 | 默认状态 |
|---|---|---|---|
| PDF 提取/生成 | PyMuPDF、pdfminer.six、ReportLab | Worker 任务，输出到受限目录 | 按需 |
| Word 模板 | python-docx-template | Worker 任务，模板和输出目录白名单 | 按需 |
| Excel/表格 | openpyxl、pandas、xlrd/xlwt | Worker 任务，限制文件大小和公式外链 | 按需 |
| 文本分析 | Python 标准库、nltk | 本地离线任务 | 按需 |
| 数值/统计 | numpy、scipy、statsmodels | 本地任务，限制内存和运行时间 | 按需 |
| 可视化/报告 | matplotlib、seaborn、plotly、Jinja2、WeasyPrint | 生成 HTML/PNG/PDF 工件 | 按需 |
| 机器学习 | scikit-learn | 独立环境或任务容器 | 禁止默认自动安装 |
| 深度学习 | PyTorch、TensorFlow | 独立环境/GPU 任务 | 禁止默认自动安装 |
| 邮件 | smtplib、imaplib、aiosmtplib、imapclient | 明确授权的邮件任务 | 默认关闭 |
| 文件/目录 | pathlib、shutil、zipfile、tarfile、watchdog | 仅受限工作目录 | 默认开启基础能力 |
| HTTP/解析 | httpx、aiohttp、BeautifulSoup、lxml、html5lib | 仅用户指定 URL/域名 | 按需 |

## 不建议直接引入的做法

- 不把 TensorFlow、PyTorch、Dask、Modin 等重量依赖放进默认安装；它们会显著增加安装时间、磁盘占用和崩溃面。
- 不允许 Worker 任意读取用户目录、Cookie、密码库或浏览器配置目录。
- 不允许页面内容直接生成 Python 代码或 shell 命令。页面内容始终是不可信数据。
- 不把邮件发送、外部网络请求、删除文件、提交表单等动作当作普通读任务；这些动作必须有任务级授权和审计记录。
- 不用 requests/BeautifulSoup 绕过 Bridge 的页面授权；HTTP 抓取和已登录浏览器操作是两个不同的权限域。

## 统一任务接口

Python 侧车应实现以下抽象，而不是让 agent 直接执行任意 Python：

```json
{
  "task": "document.extract_pdf",
  "inputs": [{"path": "allowed/input/report.pdf", "sha256": "..."}],
  "outputs": [{"path": "allowed/output/report.json"}],
  "limits": {"timeoutMs": 120000, "maxBytes": 50000000},
  "agent": "agent-name",
  "authorization": "task-scoped-token"
}
```

任务运行器必须：

1. 校验路径、哈希、文件大小、超时和内存预算。
2. 使用独立 Python 环境，记录包版本和任务输入摘要。
3. 输出结构化结果和审计事件，不记录密码、Cookie、Authorization 或完整邮件正文。
4. 对超时、崩溃和未知副作用返回可恢复状态；禁止自动重放不确定的外部写操作。
5. 与浏览器队列共享 agent 身份、优先级和取消信号。

## 与浏览器任务的组合示例

```text
browser_observe
  → browser_upload_verified
  → Python Worker 解析返回的文件
  → browser_fill_verified
  → browser_click_verified
  → 读取页面结果
  → Python Worker 生成 PDF/Excel 报告
```

浏览器负责页面、授权和用户态；Python 负责确定性的数据变换。模型离线时，两侧仍可按已验证的工具链继续执行。

## 分阶段实现

### P0：基础侧车

- Python Worker 生命周期、版本探针、健康检查。
- 受限输入/输出目录和 SHA-256 校验。
- pathlib、zipfile、pandas、openpyxl、PyMuPDF 的小型适配器。

### P1：报告和文档

- Jinja2 + ReportLab/WeasyPrint 报告生成。
- Word 模板填充、Excel 导入导出、PDF 文本/图片提取。
- 产物清单、大小限制和失败恢复。

### P2：异步网络和邮件

- httpx/aiohttp 的域名白名单和速率限制。
- SMTP/IMAP 的显式授权、凭据不进入 agent 上下文。
- 所有外部发送操作使用一次性确认令牌。

### P3：可选计算环境

- scikit-learn 任务环境。
- PyTorch/TensorFlow/Dask/Modin 独立环境或容器。
- 资源配额、取消、日志轮转和结果缓存。

## 结论

功能上可以全部覆盖，但工程上不应“一次性把 40 个库全部安装并暴露给 agent”。应按需安装、按能力域隔离、按任务授权，并由 Bridge 统一审计和恢复。这样既能自动完成文档、数据、邮件和报告任务，又不会削弱浏览器操控的安全边界和无人值守稳定性。

