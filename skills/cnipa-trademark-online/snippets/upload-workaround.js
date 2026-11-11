// 适用场景：对 CNIPA antd Upload 里 display:none 的 input[type=file] 塞入文件。
//           【优先用 browser_upload / browser_upload_verified 的 selector 或 inputIndex】——
//           那是本轮 M1 正在实现的能力；本片段只在「旧版本」或「该能力不可用」时作为替代路径使用。
// 来源：外部能力包 J:\WorkAndData\双柏彝笙商城\80_工具与脚本\01_能力包_CNIPA\snippets\local_upload.js
//       与 scripts\local_upload_server.py（只读 CORS 文件服务）；
//       docs/FIELD-REPORT-20261111-cnipa-toas-review.md §一 P0-3 临时绕过片段、§五 第 5 步；
//       docs/UPGRADE-PLAN-20261111-cnipa-site-feedback.md §3 / §1 P0-1~P0-3。
// 前置：本地起服务 python scripts/local_upload_server.py --root <材料目录> --port 8767
//       http://127.0.0.1 属 potentially trustworthy origin，HTTPS 页面可 fetch；
//       服务默认只绑 127.0.0.1、只读、按 realpath 校验防目录穿越，仅限本次要传的材料目录。
// 已知限制：依赖本地服务与页面 CORS；文件名、字节数必须与材料目录一致；
//           附件位多时用 querySelectorAll('input[type=file]')[index] 定位，index 随附件位顺序变化；
//           PDF 必须显式 type='application/pdf'（旧版 Bridge 把 .pdf 推成 application/octet-stream
//           会被站点拒收）；旧版还有 16 MiB 上传上限；站点改版会使选择器失效。
// 版本说明：这是 2026-11-11 四案实测采用的稳定绕过，不代表它已在当前 Bridge 版本上重新验证，
//           也不能据此宣称「桥已修复」。用前先用 browser_capabilities 确认 selector/inputIndex 是否可用。

(async () => {
  const BASE = 'http://127.0.0.1:8767';

  // 材料目录内相对路径 -> 目标 file input。附件位多时用 index 区分；mime 可显式覆盖。
  const files = [
    // { rel: '01_事实与理由.pdf', selector: 'input[type=file]', index: 0, mime: 'application/pdf' },
    // { rel: '02_证据目录.pdf',   selector: 'input[type=file]', index: 1, mime: 'application/pdf' },
  ];

  const setFile = async ({ rel, selector = 'input[type=file]', index = 0, mime }) => {
    const url = BASE + '/?rel=' + encodeURIComponent(rel);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('fetch failed: ' + rel + ' ' + resp.status);
    const blob = await resp.blob();
    const name = rel.split('/').pop();
    const type = mime || blob.type ||
      (name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    const file = new File([blob], name, { type });
    const inputs = [...document.querySelectorAll(selector)];
    const input = inputs[index];
    if (!input) throw new Error('file input not found: ' + selector + '[' + index + ']');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { name, bytes: file.size, type };
  };

  const out = [];
  for (const f of files) out.push(await setFile(f));
  return out;
})();
