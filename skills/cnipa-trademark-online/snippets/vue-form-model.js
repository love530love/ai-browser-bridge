// 适用场景：CNIPA 注册申请模块（Vue 3 + qiankun，入口 code=toas_00501）。预览/校验被打回时
//           只读定位空字段；预览页地址/商标说明用可编辑 textarea 渲染、innerText 读不到值时，
//           作为「读 input/textarea.value」之外的替代核验入口。
// 来源：外部能力包 J:\WorkAndData\双柏彝笙商城\80_工具与脚本\01_能力包_CNIPA\snippets\vue_form_probe.js
//       （2026-11-11 实测）；原理见 docs/FIELD-REPORT-20261111-cnipa-toas-review.md §七 P2-3/P2-4
//       与 docs/UPGRADE-PLAN-20261111-cnipa-site-feedback.md §3。
// 已知限制：生产包暴露内部状态属站点实现细节，组件名 / subTree 路径随改版失效；探针只读勿改，
//           读模型不等于页面已提交；页面未挂载完成（#app.__vue_app__ 不存在）会返回 ok:false。
// PII 警告：setupState.formNewState / isRules 可能含身份证号、营业执照 OCR 结果与详细地址门牌号。
//           本文件默认【不回显任何表单值】，只返回组件名与状态键名；需要的单个字段用
//           __cnipaFormField(path) 按需取，空字段用 __cnipaEmptyFields() 只取字段名。
//           绝不整包 console.log、写进日志/报告/页面。

(() => {
  const app = document.querySelector('#app')?.__vue_app__;
  if (!app) return { ok: false, error: 'no #app.__vue_app__ (not a Vue app or not mounted yet)' };

  const seen = new Set();
  const found = [];

  const walk = (vnode, depth = 0) => {
    if (!vnode || depth > 60 || seen.has(vnode)) return;
    seen.add(vnode);
    const comp = vnode.component;
    if (comp) {
      const name = comp.type?.name || comp.type?.__name || '';
      if (/action-form|register|apply/i.test(name)) {
        found.push({ name, comp });
      }
      walk(comp.subTree, depth + 1);
    }
    walk(vnode.subTree, depth + 1);
    if (Array.isArray(vnode.children)) vnode.children.forEach(c => walk(c, depth + 1));
  };

  walk(app._instance?.subTree);

  // 只挂组件引用，不展开任何表单值，避免把 PII 带进返回值 / 日志。
  window.__cnipaFormComp = found[0]?.comp || null;
  const state = () => window.__cnipaFormComp?.setupState || {};

  // 按需读取单个字段（调用方自己决定读哪个、是否记录），路径形如 'formNewState.applicantName'。
  window.__cnipaFormField = (path) => {
    const parts = String(path).split('.');
    let cur = state();
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  };

  // 只报「哪些 formNewState 顶层字段为空」的字段名，不回显值；用于校验被打回时定位空字段。
  window.__cnipaEmptyFields = () => {
    const form = state().formNewState;
    if (!form || typeof form !== 'object') return { ok: false, error: 'formNewState not found' };
    const isEmpty = v => v == null || v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
    return {
      ok: true,
      stateKeys: Object.keys(state()),
      emptyFields: Object.keys(form).filter(k => isEmpty(form[k])),
    };
  };

  return {
    ok: found.length > 0,
    count: found.length,
    components: found.map(f => ({ name: f.name, stateKeys: Object.keys(f.comp.setupState || {}) })),
    note: 'values are NOT returned; use __cnipaFormField(path) / __cnipaEmptyFields()',
  };
})();
