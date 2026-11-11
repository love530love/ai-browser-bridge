// 适用场景：CNIPA 评审模块（React + antd 5）与注册申请模块（Vue 3 + ant-design-vue）的受控表单。
//           整段粘贴到 browser_eval 执行一次，之后调用 window.__antd.*。
// 来源：外部能力包 J:\WorkAndData\双柏彝笙商城\80_工具与脚本\01_能力包_CNIPA\snippets\antd_forms.js
//       （2026-11-11 四案现场实测沉淀）；交互配方对照
//       docs/FIELD-REPORT-20261111-cnipa-toas-review.md §三。
// 已知限制：受控组件必须走原生 setter + input 事件，直接 el.value = v 无效；
//           Select 选项挂在 body 下的 .ant-select-dropdown，需等约 300ms 渲染后再点；
//           后台 tab 被节流时 antd 离场动画的 animationend 不触发，.ant-modal-wrap 会残留
//           pointer-events:auto 遮罩永久拦截点击（clearModalMask 是绕过，不是根因修复）；
//           选择器与组件类名随 antd / 站点版本变化，以实际 DOM 为准。

(() => {
  const nativeSet = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const mouse = (el) => {
    ['mousedown', 'mouseup', 'click'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  };

  const byText = (sel, text) =>
    [...document.querySelectorAll(sel)].find(e => (e.innerText || '').trim().replace(/\s+/g, '') === text.replace(/\s+/g, ''));

  const setInput = (selector, value) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('not found: ' + selector);
    el.scrollIntoView({ block: 'center' });
    nativeSet(el, value);
    return true;
  };

  // 打开下拉并点选；triggerSelector 通常是表单项内的 .ant-select-selector。
  // 注意选项在 body 下的 .ant-select-dropdown 内，不在表单项里。
  const pickSelect = (triggerSelector, optionText, wait = 300) =>
    new Promise((resolve, reject) => {
      const trigger = document.querySelector(triggerSelector);
      if (!trigger) return reject(new Error('trigger not found: ' + triggerSelector));
      trigger.scrollIntoView({ block: 'center' });
      mouse(trigger);
      setTimeout(() => {
        const opt = [...document.querySelectorAll('.ant-select-item-option')]
          .find(o => (o.innerText || '').trim() === optionText);
        if (!opt) return reject(new Error('option not found: ' + optionText));
        mouse(opt);
        resolve(true);
      }, wait);
    });

  const pickRadio = (text) => {
    const w = [...document.querySelectorAll('.ant-radio-wrapper')]
      .find(e => (e.innerText || '').includes(text));
    if (!w) throw new Error('radio not found: ' + text);
    w.click();
    return true;
  };

  const pickCheckbox = (text) => {
    const w = [...document.querySelectorAll('.ant-checkbox-wrapper')]
      .find(e => (e.innerText || '').includes(text));
    if (!w) throw new Error('checkbox not found: ' + text);
    w.click();
    return true;
  };

  // 清理 antd 弹窗离场动画残留遮罩（后台 tab 节流会导致永久拦截点击）。
  const clearModalMask = () => {
    document.querySelectorAll('.ant-modal-wrap').forEach(w => { w.style.pointerEvents = 'none'; });
    document.querySelectorAll('.ant-modal-mask').forEach(m => { m.style.pointerEvents = 'none'; });
  };

  // 按按钮文本点击；自动点内部 span，规避文本含空格/图标（如「提 交」「预 览」）。
  const clickButton = (text, root = document) => {
    const norm = s => (s || '').replace(/\s+/g, '');
    let btn = [...root.querySelectorAll('button')].find(b => norm(b.innerText) === norm(text));
    if (!btn) throw new Error('button not found: ' + text);
    btn.scrollIntoView({ block: 'center' });
    const span = btn.querySelector('span');
    (span || btn).click();
    return true;
  };

  window.__antd = { nativeSet, mouse, byText, setInput, pickSelect, pickRadio, pickCheckbox, clearModalMask, clickButton };
  return 'antd helpers ready';
})();
