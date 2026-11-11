// 适用场景：CNIPA 注册申请模块「选择商品」弹窗逐条检索勾选（官方「商品导入」Excel 实测为死按钮，
//           见现场报告 §七 P1-9），以及 Jeecg 左侧菜单展开 / 文本点击走路由。
// 来源：文字配方见 docs/UPGRADE-PLAN-20261111-cnipa-site-feedback.md §3、
//       docs/FIELD-REPORT-20261111-cnipa-toas-review.md §七 P1-9、
//       外部能力包 J:\WorkAndData\双柏彝笙商城\80_工具与脚本\01_能力包_CNIPA\runbooks\01_注册申请.md §5
//       与 cases\94896138_彝笙缘三类\README.md 复现要点。
//       【外部能力包无同名 JS 片段】——本文件是把上述文字配方固化成的可复用助手。
// 已知限制（重要）：选择器与按钮文本均为站点实现细节，**未逐项按实际 DOM 实测**，改版即失效；
//           用前先 browser_observe 核对并按实际 DOM 覆盖 CFG；
//           C 开头的中国特有编码不能按编码搜，须按名称关键词；
//           勾选跨搜索累积，每次「添加」前核对已选数量；
//           弹窗会重渲染，每轮都要重取节点；30 项约 30 轮，建议页面内队列跑；
//           「添加」前务必确认当前弹窗与类别正确，错误商品不要重复添加。

(() => {
  // 选择器表：按实际 DOM 覆盖，不要当成稳定 API。
  const CFG = {
    submenuTitle: '.jeecg-menu-submenu-title',
    menuItem: 'li.jeecg-menu-item',
    selectSelector: '.ant-select-selector',
    selectSearch: '.ant-select-dropdown input',
    selectOption: '.ant-select-dropdown .ant-select-item-option',
    keywordInput: 'input[placeholder*="关键词"], input[placeholder*="商品名称"]',
    searchButton: 'button',
    goodsRow: '.ant-table-tbody tr, .jeecg-table tbody tr',
    rowCheckbox: '.ant-checkbox-wrapper',
    addButton: 'button',
  };

  const norm = s => (s || '').replace(/\s+/g, '');
  const byText = (sel, text, root = document) =>
    [...root.querySelectorAll(sel)].find(e => norm(e.innerText) === norm(text));
  const hasText = (sel, text, root = document) =>
    [...root.querySelectorAll(sel)].find(e => norm(e.innerText).includes(norm(text)));
  const mouse = el => ['mousedown', 'mouseup', 'click'].forEach(t =>
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  const nativeSet = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // Jeecg 菜单：展开子菜单标题，再按文本点击菜单项走路由。
  // 注意先观察是否已展开；对已展开的标题重复点击可能把它收起。
  const openMenu = (titleText, itemText) => {
    const title = hasText(CFG.submenuTitle, titleText);
    if (title) mouse(title);
    const item = byText(CFG.menuItem, itemText) || hasText(CFG.menuItem, itemText);
    if (!item) throw new Error('menu item not found: ' + itemText);
    mouse(item);
    return true;
  };

  // 类别 Select：三步打开下拉 -> 输入搜索词 -> 点选项（选项挂在 body 下 .ant-select-dropdown）。
  const pickCategory = async (classNo, waitMs = 300) => {
    const trigger = document.querySelector(CFG.selectSelector);
    if (!trigger) throw new Error('select trigger not found');
    trigger.scrollIntoView({ block: 'center' });
    mouse(trigger);
    await wait(waitMs);
    const search = document.querySelector(CFG.selectSearch);
    if (search) nativeSet(search, String(classNo));
    await wait(waitMs);
    const opt = [...document.querySelectorAll(CFG.selectOption)]
      .find(o => norm(o.innerText).includes(String(classNo)));
    if (!opt) throw new Error('category option not found: ' + classNo);
    mouse(opt);
    return true;
  };

  // 关键词检索：C 开头中国特有编码不能按编码搜，按名称关键词。
  const searchGoods = async (keyword) => {
    const input = document.querySelector(CFG.keywordInput);
    if (!input) throw new Error('keyword input not found');
    nativeSet(input, keyword);
    const btn = byText(CFG.searchButton, '检索') || byText(CFG.searchButton, '搜索');
    if (btn) mouse(btn);
    await wait(300);
    return true;
  };

  // 按编码（或名称）匹配结果表格行，勾选该行 checkbox；返回是否命中。
  const checkRowByCode = (code) => {
    const rows = [...document.querySelectorAll(CFG.goodsRow)];
    const row = rows.find(r => norm(r.innerText).includes(String(code)));
    if (!row) return false;
    const box = row.querySelector(CFG.rowCheckbox) || row.querySelector('input[type=checkbox]');
    if (!box) return false;
    mouse(box);
    return true;
  };

  // 一次「添加」：调用方先核对已选数量（勾选跨搜索累积），不要重复点。
  const addOnce = () => {
    const btn = byText(CFG.addButton, '添加') || byText(CFG.addButton, '添加所选商品');
    if (!btn) throw new Error('add button not found');
    btn.scrollIntoView({ block: 'center' });
    const span = btn.querySelector('span');
    (span || btn).click();
    return true;
  };

  // 队列：逐条 搜索 -> 按编码匹配 -> 勾选 -> 一次添加；每轮重取节点。
  const run = async (items) => {
    const out = [];
    for (const it of items) {
      await searchGoods(it.name);
      const matched = checkRowByCode(it.code || it.name);
      const added = matched ? addOnce() : false;
      out.push({ name: it.name, code: it.code || null, matched, added });
      await wait(150);
    }
    return out;
  };

  window.__cnipaGoods = { CFG, openMenu, pickCategory, searchGoods, checkRowByCode, addOnce, run };
  return 'cnipa goods/menu helpers ready (selectors unverified - confirm against live DOM)';
})();
