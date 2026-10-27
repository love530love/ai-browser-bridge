// Runs in Chrome's isolated extension world, never the page's JS world.
export async function pageOperation(name, args, allowedOrigins, allSites = false) {
  try {
  if (!['http:', 'https:'].includes(location.protocol) || (!allSites && !allowedOrigins.includes(location.origin))) throw new Error('Origin changed or not allowed.');
  const hiddenLayoutCache = new WeakMap();
  const hiddenByLayout = el => {
    const path = [];
    for (let current = el; current; current = current.parentElement) {
      if (hiddenLayoutCache.has(current)) {
        const hidden = hiddenLayoutCache.get(current);
        for (const item of path) hiddenLayoutCache.set(item, hidden);
        return hidden;
      }
      path.push(current);
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0 || !!current.hasAttribute?.('inert')) {
        for (const item of path) hiddenLayoutCache.set(item, true);
        return true;
      }
    }
    for (const item of path) hiddenLayoutCache.set(item, false);
    return false;
  };
  const visible = el => {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && !hiddenByLayout(el) && el.getClientRects().length > 0;
  };
  const sensitive = el => el.matches('input[type=password],input[type=hidden]') || el.closest('[data-ai-private]');
  const fileInput = el => el instanceof HTMLInputElement && el.type === 'file';
  const squash = value => (value || '').replace(/\s+/g, ' ').trim();
  // Accessible name in the order the ARIA accname spec defines it. The previous
  // version was a property-order guess: it never read aria-labelledby (the most
  // common labelling in modern component libraries), only the first native
  // <label>, and missed input[type=submit]'s value, so locators built on it
  // could match the wrong control or find nothing.
  //
  // dom-accessibility-api is the reference implementation and is deliberately
  // NOT used: pageOperation is serialised into the page by
  // chrome.scripting.executeScript, so it cannot reference a module. Vendoring
  // the library would mean injecting ~80KB on every executeScript call, which
  // would slow every read for the remaining edge cases. If a case is ever found
  // that this does not cover, that trade should be revisited with evidence.
  const label = el => {
    const labelledby = () => {
      const ids = squash(el.getAttribute('aria-labelledby'));
      if (!ids) return '';
      return squash(ids.split(/\s+/).map(id => {
        const target = el.ownerDocument?.getElementById?.(id);
        return target ? (target.getAttribute('aria-label') || target.textContent) : '';
      }).join(' '));
    };
    const nativeLabel = () => {
      if (el.labels?.length) return squash([...el.labels].map(node => node.textContent).join(' '));
      const wrapping = el.closest?.('label');
      return wrapping ? squash(wrapping.textContent) : '';
    };
    // Duck-typed on purpose: an instanceof check against a global constructor
    // breaks in any realm where that global is absent (a vm sandbox, a test
    // double), and the tag plus type attribute says the same thing.
    const submitValue = () => (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(String(el.getAttribute?.('type') || '').toLowerCase()))
      ? squash(el.value ?? '') : '';
    return (
      labelledby()
      || squash(el.getAttribute('aria-label'))
      || nativeLabel()
      || squash(el.getAttribute('alt'))
      || submitValue()
      || squash(el.getAttribute('placeholder'))
      || squash(el.innerText)
      || squash(el.getAttribute('title'))
    ).slice(0, 180);
  };
  const cheapLabel = el => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.getAttribute('id') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const fingerprint = el => JSON.stringify([el.tagName, el.getAttribute('type'), label(el), el.getAttribute('href'), el.getAttribute('formaction')]);
  const rememberState = state => {
    state.createdAt = Date.now();
    const snapshots = globalThis.__aiBrowserBridgeSnapshots instanceof Map ? globalThis.__aiBrowserBridgeSnapshots : new Map();
    snapshots.set(state.snapshot, state);
    const now = Date.now();
    for (const [key, value] of snapshots) {
      if (snapshots.size <= 12 && now - (value.createdAt || 0) <= 120000) break;
      if (now - (value.createdAt || 0) > 120000 || snapshots.size > 12) snapshots.delete(key);
    }
    globalThis.__aiBrowserBridgeSnapshots = snapshots;
    globalThis.__aiBrowserBridge = state;
    return state;
  };
  const stateForRef = ref => {
    const snapshot = typeof ref === 'string' ? ref.split(':', 1)[0] : '';
    return globalThis.__aiBrowserBridgeSnapshots?.get(snapshot) || (globalThis.__aiBrowserBridge?.snapshot === snapshot ? globalThis.__aiBrowserBridge : null);
  };
  const clean = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const rowContext = el => {
    const row = el.closest('tr,[role=row],.el-table__row,.ant-table-row');
    if (!row || sensitive(row)) return '';
    return clean(row.innerText || row.textContent);
  };
  const renderedTextNode = node => {
    const parent = node.parentElement;
    if (!parent || hiddenByLayout(parent)) return false;
    const ownStyle = getComputedStyle(parent);
    if (ownStyle.visibility === 'hidden' || ownStyle.visibility === 'collapse') return false;
    if (parent.getClientRects().length > 0) return true;
    if (ownStyle.display !== 'contents') return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getClientRects().length > 0;
  };
  const collectReadableText = ({ max = 16000, maxTextNodes = 4000, deadline = Infinity, requireVisible = true } = {}) => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const chunks = [];
    let length = 0;
    let node;
    let textNodesVisited = 0;
    let textBudgetHit = false;
    let textLengthBudgetHit = false;
    let previousBlock = null;
    let pendingWhitespace = false;
    const inlineDisplays = new Set(['inline', 'contents', 'inline-block', 'inline-flex', 'inline-grid', 'ruby', 'ruby-text']);
    while ((node = walker.nextNode())) {
      if (length >= max) { textLengthBudgetHit = true; break; }
      textNodesVisited++;
      if (textNodesVisited > maxTextNodes || performance.now() >= deadline) { textBudgetHit = true; break; }
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,select,[data-ai-private],[hidden],[aria-hidden=true],[inert],.hidden,#hidden,[style*=\"display:none\"],[style*=\"display: none\"]') || sensitive(parent) || (requireVisible && !renderedTextNode(node))) continue;
      const source = node.textContent;
      const remaining = Math.max(0, max - length);
      const boundedSource = source.length > remaining ? source.slice(0, remaining) : source;
      if (source.length > remaining) textLengthBudgetHit = true;
      const rawValue = boundedSource.replace(/\s+/g, ' ');
      const value = rawValue.trim();
      if (!value) {
        if (previousBlock && /\s/.test(rawValue)) pendingWhitespace = true;
        if (textLengthBudgetHit) break;
        continue;
      }
      let block = document.body;
      for (let current = parent; current && current !== document.body; current = current.parentElement) {
        if (!inlineDisplays.has(getComputedStyle(current).display)) { block = current; break; }
      }
      const separator = previousBlock ? previousBlock === block ? (pendingWhitespace || /^\s/.test(rawValue) ? ' ' : '') : '\n' : '';
      const available = Math.max(0, max - length - separator.length);
      const boundedValue = value.slice(0, available);
      chunks.push(`${separator}${boundedValue}`);
      length += separator.length + boundedValue.length;
      previousBlock = block;
      pendingWhitespace = /\s$/.test(rawValue);
      if (boundedValue.length < value.length) textLengthBudgetHit = true;
      if (textLengthBudgetHit) break;
    }
    return { text: chunks.join(''), length, textNodesVisited, textBudgetHit, textLengthBudgetHit };
  };
  const findReadableTextMatches = ({ query, maxMatches = 10, contextChars = 160, deadline = Infinity, maxTextNodes = 50000, requireVisible = true } = {}) => {
    const collected = collectReadableText({ max: 500000, maxTextNodes, deadline, requireVisible });
    const normalized = collected.text.replace(/\s+/g, ' ');
    const matches = [];
    let from = 0;
    while (matches.length < maxMatches) {
      const index = normalized.indexOf(query, from);
      if (index < 0) break;
      matches.push({
        index,
        before: normalized.slice(Math.max(0, index - contextChars), index).trim(),
        match: normalized.slice(index, index + query.length),
        after: normalized.slice(index + query.length, index + query.length + contextChars).trim()
      });
      from = index + Math.max(1, query.length);
    }
    return {
      matches,
      textNodesVisited: collected.textNodesVisited,
      textBudgetHit: collected.textBudgetHit,
      textLength: collected.length,
      textLengthBudgetHit: collected.textLengthBudgetHit
    };
  };
  const deepHit = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; hit?.shadowRoot && depth < 32; depth++) {
      const next = hit.shadowRoot.elementFromPoint(x, y);
      if (!next || next === hit) break;
      hit = next;
    }
    return hit;
  };
  const elementBox = el => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const hit = box.width > 0 && box.height > 0 ? deepHit(Math.min(Math.max(x, 0), innerWidth - 1), Math.min(Math.max(y, 0), innerHeight - 1)) : null;
    const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    return { x, y, left: box.left, top: box.top, width: box.width, height: box.height, covered: !inViewport || box.width <= 0 || box.height <= 0 || !hit || (hit !== el && !el.contains(hit)), hitTag: hit?.tagName?.toLowerCase() || null };
  };
  const shortSelector = el => clean([el.tagName?.toLowerCase(), el.id ? `#${el.id}` : '', el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''].join(''));
  const overlayHint = el => {
    const s = `${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    if (el.matches('dialog,[role=dialog],[aria-modal=true]')) return 'dialog';
    if (/cookie|consent|gdpr|privacy|ad-|advert|ads|popup|pop-up|modal|overlay|mask|drawer|tour|guide|onboard|intercom|chat|客服|广告|弹窗|浮层|遮罩|引导/.test(s)) return 'semantic-overlay';
    const style = getComputedStyle(el);
    if ((style.position === 'fixed' || style.position === 'sticky') && Number(style.zIndex) >= 10) return `${style.position}-high-z`;
    return '';
  };
  const closeHint = el => /^(×|x)$/i.test(clean(el.textContent)) || /(close|dismiss|skip|got it|later|no thanks|not now|accept|agree|关闭|取消|跳过|我知道|知道了|稍后|不再|同意|接受)/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`);
  const actionSelector = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=option],[role=menuitem],[role=radio],[role=checkbox],[role=combobox],[contenteditable=true]';
  if (name === 'browser_shadow_tree') {
    const maxRoots = Math.max(1, Math.min(100, args.maxRoots ?? 50));
    const maxControls = Math.max(1, Math.min(200, args.maxControls ?? 100));
    const roots = [], controls = [], seen = new Set();
    const deadline = performance.now() + 200;
    let visited = 0, partial = false, customElementCount = 0;
    const snapshot = crypto.randomUUID();
    const state = rememberState({ snapshot, url: location.href, refs: new Map() });
    const visit = (node, path) => {
      if (!node || roots.length >= maxRoots) return;
      const children = node instanceof ShadowRoot ? [...node.children] : [...(node.children || [])];
      for (let i = 0; i < children.length; i++) {
        if (++visited > 10000 || performance.now() >= deadline) { partial = true; return; }
        const el = children[i];
        if (el.localName.includes('-')) customElementCount++;
        const nextPath = `${path}/${el.tagName.toLowerCase()}[${i}]`;
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          roots.push({ host: el.tagName.toLowerCase(), id: el.id || null, path: nextPath, mode: 'open', controls: [] });
          visit(el.shadowRoot, nextPath + '/shadow');
        }
        if (controls.length < maxControls && el.matches?.(actionSelector)) {
          if (sensitive(el)) continue;
          const ref = `${snapshot}:${state.refs.size + 1}`;
          state.refs.set(ref, { el, fingerprint: fingerprint(el) });
          const box = el.getBoundingClientRect();
          controls.push({ ref, path: nextPath, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: label(el) || cheapLabel(el), visible: visible(el), rect: { left: box.left, top: box.top, width: box.width, height: box.height } });
        }
        if (roots.length < maxRoots) visit(el, nextPath);
      }
    };
    visit(document.documentElement, 'html');
    return { title: document.title, url: location.href, shadowRootCount: roots.length, customElementCount, partial: partial || roots.length >= maxRoots || controls.length >= maxControls, visited, roots, controls, traversal: roots.length ? 'open-shadow-roots' : 'none-found', fallback: controls.some(c => c.visible) ? 'use_control_ref_then_reobserve' : 'browser_screenshot', nextSteps: ['Use only a verified target ref with browser_click or browser_fill.', 'If the target is absent, capture browser_screenshot; do not guess coordinates.', 'Re-observe after each action and verify the intended outcome.'], contentTrust: 'untrusted webpage data' };
  }
  const elementRole = el => el.getAttribute('role') || (el instanceof HTMLButtonElement ? 'button' : el instanceof HTMLAnchorElement ? (el.hasAttribute('href') ? 'link' : 'generic') : el instanceof HTMLInputElement ? (el.type === 'file' ? 'file' : 'input') : el instanceof HTMLTextAreaElement ? 'textbox' : el instanceof HTMLSelectElement ? 'select' : el.isContentEditable ? 'textbox' : el.tagName.toLowerCase());
  const elementText = el => clean([label(el), el.getAttribute('name'), el.getAttribute('id'), el.textContent].filter(Boolean).join(' '));
  const actionCompatible = (el, action = 'any') => {
    if (action === 'any' || action === 'click') return true;
    if (action === 'fill') return (el instanceof HTMLInputElement && !fileInput(el) && ['text', 'email', 'search', 'url', 'tel', 'number', ''].includes(el.type)) || el instanceof HTMLTextAreaElement || el.isContentEditable;
    if (action === 'select') return el instanceof HTMLSelectElement || el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'option';
    if (action === 'upload') return fileInput(el);
    return true;
  };
  const findElementCandidates = (args = {}) => {
    const query = String(args.query || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const role = String(args.role || '').trim().toLowerCase();
    const action = args.action || 'any';
    const maxResults = args.maxResults ?? 10;
    const includeCovered = !!args.includeCovered;
    const requiredRow = clean(args.rowText).toLowerCase();
    const snapshot = crypto.randomUUID();
    const state = rememberState({ snapshot, url: location.href, refs: new Map() });
    const items = [];
    const diagnostics = { textNodesVisited: 0, controlCandidatesVisited: 0, textScanPartial: false, controlScanPartial: false };
    const candidates = new Set(document.querySelectorAll(actionSelector));
    // Portals need no special document traversal, but delegated text-only menu
    // items are absent from semantic control selectors. Exact text is a locator,
    // not proof that a click is meaningful; expose that distinction to callers.
    const textCandidates = new Set();
    if (query && !role && ['click', 'any'].includes(action)) {
      const deadline = performance.now() + 150;
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (diagnostics.textNodesVisited >= 5000 || performance.now() >= deadline) { diagnostics.textScanPartial = true; break; }
        diagnostics.textNodesVisited++;
        const unlinkedAnchor = node.matches('a:not([href])');
        const exactLeafText = node.matches('span,div,li') && node.children.length === 0;
        if ((!unlinkedAnchor && !exactLeafText) || sensitive(node)) continue;
        const ownerAnchor = !unlinkedAnchor ? node.closest('a:not([href])') : null;
        if (ownerAnchor && clean(ownerAnchor.textContent).toLowerCase() === query) continue;
        if (clean(node.textContent).toLowerCase() !== query) continue;
        candidates.add(node); textCandidates.add(node);
      }
    }
    const controlDeadline = performance.now() + 250;
    for (const el of candidates) {
      if (items.length >= Math.max(maxResults * 8, 80) || diagnostics.controlCandidatesVisited >= 5000 || performance.now() >= controlDeadline) { diagnostics.controlScanPartial = true; break; }
      diagnostics.controlCandidatesVisited++;
      if (sensitive(el) || !visible(el) || !actionCompatible(el, action)) continue;
      const rowText = rowContext(el);
      if (requiredRow && !rowText.toLowerCase().includes(requiredRow)) continue;
      const r = elementRole(el).toLowerCase();
      if (role && r !== role && !r.includes(role)) continue;
      const hay = elementText(el).toLowerCase();
      const exact = hay === query;
      const starts = hay.startsWith(query);
      const includes = query && hay.includes(query);
      if (query && !includes) continue;
      const ref = `${snapshot}:${state.refs.size + 1}`;
      state.refs.set(ref, { el, fingerprint: fingerprint(el), ...(requiredRow ? { rowText } : {}) });
      const box = elementBox(el);
      if (box.covered && !includeCovered) continue;
      const score = (exact ? 100 : starts ? 80 : includes ? 60 : 0) + (box.covered ? -40 : 10) + (actionCompatible(el, action) ? 10 : 0);
      items.push({ ref, score, rowText, locatorEvidence: textCandidates.has(el) ? 'exact-visible-text; clickability-unverified' : 'semantic-control', clickability: textCandidates.has(el) ? 'unverified' : 'semantic-control', covered: box.covered, role: r, text: elementText(el), tag: el.tagName.toLowerCase(), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', ...box });
    }
    return { candidates: items.sort((a, b) => b.score - a.score).slice(0, maxResults), partial: diagnostics.textScanPartial || diagnostics.controlScanPartial, diagnostics };
  };
  const elementSummary = (el, extra = {}) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), label: clean(label(el) || el.textContent), selector: shortSelector(el), ...elementBox(el), ...extra });
  const waitGone = async (ref, timeoutMs = 3000) => {
    if (!ref) return null;
    const targetState = stateForRef(ref);
    const target = targetState?.refs.get(ref)?.el;
    if (!target) return { status: 'gone' };
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!target.isConnected || !visible(target)) return { status: 'gone', elapsedMs: Date.now() - started };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { status: (!target.isConnected || !visible(target)) ? 'gone' : 'still-present', elapsedMs: Date.now() - started };
  };
  const pageText = () => document.body?.innerText || '';
  const expectationState = (expect = {}, context = {}) => {
    const checks = {};
    if (typeof expect.textAppears === 'string') checks.textAppears = pageText().includes(expect.textAppears);
    if (typeof expect.urlContains === 'string') checks.urlContains = location.href.includes(expect.urlContains);
    if (typeof expect.elementLabelAppears === 'string') {
      const needle = expect.elementLabelAppears.replace(/\s+/g, ' ').trim();
      checks.elementLabelAppears = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=option],[role=combobox],[contenteditable=true]')]
        .some(el => visible(el) && label(el).replace(/\s+/g, ' ').trim().includes(needle));
    }
    if (typeof expect.valueMatches === 'string') checks.valueMatches = (typeof context.getValue === 'function' ? context.getValue() : context.value) === expect.valueMatches;
    if (typeof expect.fileNameAppears === 'string') checks.fileNameAppears = pageText().includes(expect.fileNameAppears) || context.fileName === expect.fileNameAppears;
    return { checks, satisfied: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean) };
  };
  const verify = async (expect = {}, timeoutMs = 3000, context = {}) => {
    const started = Date.now();
    const run = () => expectationState(expect, context);
    let initial = run();
    // A controlled framework input can synchronously reflect the fill and roll
    // it back on its next scheduled render. Give that commit one short settle
    // window, then read the live element value rather than the fill-time snapshot.
    if (initial.satisfied && typeof context.getValue === 'function') {
      await new Promise(resolve => setTimeout(resolve, Math.min(50, timeoutMs)));
      initial = run();
    }
    if (initial.satisfied) return { status: 'success', checks: initial.checks, elapsedMs: Date.now() - started };
    return await new Promise(resolve => {
      const finish = () => {
        const result = run();
        observer.disconnect();
        clearTimeout(timer);
        resolve({ status: result.satisfied ? 'success' : 'failed', checks: result.checks, elapsedMs: Date.now() - started });
      };
      const observer = new MutationObserver(() => { if (run().satisfied) finish(); });
      const timer = setTimeout(finish, Math.max(0, timeoutMs - (Date.now() - started)));
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    });
  };
  const optionSelector = '[role=option],[role=menuitem],.el-select-dropdown__item,.ant-select-item-option,.ant-select-item,li';
  const findExactOption = exact => [...document.querySelectorAll(optionSelector)]
    .find(option => visible(option) && option.textContent.replace(/\s+/g, ' ').trim() === exact && option.getAttribute('aria-disabled') !== 'true' && !option.matches('[disabled],.is-disabled'));
  const chooseOption = async (control, exact, timeoutMs = 5000, query = '') => {
    let option = findExactOption(exact);
    if (!option) {
      control.scrollIntoView({ block: 'center', inline: 'nearest' });
      control.focus();
      control.click();
      if (query && ('value' in control)) {
        const proto = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(control, query);
          control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: query }));
        }
      }
      option = findExactOption(exact);
    }
    if (!option) option = await new Promise(resolve => {
      const finish = value => { observer.disconnect(); clearTimeout(timer); resolve(value); };
      const observer = new MutationObserver(() => { const found = findExactOption(exact); if (found) finish(found); });
      const timer = setTimeout(() => finish(null), timeoutMs);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const found = findExactOption(exact); if (found) finish(found);
    });
    if (!option) throw new Error('Exact visible option not found');
    option.scrollIntoView({ block: 'center', inline: 'nearest' });
    option.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    return { chosen: exact, value: typeof control.value === 'string' ? control.value : clean(control.textContent), ariaExpanded: control.getAttribute('aria-expanded') };
  };
  const pickControl = async () => {
    const exact = args.chooseText.replace(/\s+/g, ' ').trim();
    const wantedLabel = (args.label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const controls = [...document.querySelectorAll('select,[role=combobox],input,.el-select,.ant-select,[aria-haspopup=listbox]')]
      .filter(el => visible(el) && !sensitive(el));
    let control = null;
    if (wantedLabel) {
      control = controls.find(el => {
        const own = `${label(el)} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
        if (own.includes(wantedLabel)) return true;
        const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (id && id.textContent.toLowerCase().includes(wantedLabel)) return true;
        const parent = el.closest('label,.form-item,.el-form-item,.ant-form-item,div');
        return parent?.textContent?.replace(/\s+/g, ' ').trim().toLowerCase().includes(wantedLabel);
      });
    }
    control ||= controls.find(el => el instanceof HTMLSelectElement && [...el.options].some(o => o.label.replace(/\s+/g, ' ').trim() === exact || o.textContent.replace(/\s+/g, ' ').trim() === exact));
    control ||= controls[0];
    if (!control) throw new Error('No picker control found');
    if (control instanceof HTMLSelectElement) {
      const option = [...control.options].find(o => (o.label.replace(/\s+/g, ' ').trim() === exact || o.textContent.replace(/\s+/g, ' ').trim() === exact || o.value === exact) && !o.disabled);
      if (!option) throw new Error('Native select option not found');
      control.value = option.value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return { chosen: exact, value: control.value, control: { tag: control.tagName.toLowerCase(), label: label(control) } };
    }
    const input = control.matches('input,[role=combobox]') ? control : control.querySelector('input,[role=combobox]') || control;
    const result = await chooseOption(input, exact, args.timeoutMs ?? 5000, args.query || exact);
    return { ...result, control: { tag: control.tagName.toLowerCase(), label: label(control) } };
  };
  if (name === 'browser_prepare_coordinate' || name === 'browser_validate_coordinate') {
    const tokens = globalThis.__aiBridgeCoordinateTokens ||= new Map();
    const now = Date.now();
    for (const [id, record] of tokens) if (now - record.at > 15000) tokens.delete(id);
    const stamp = () => JSON.stringify([location.href, innerWidth, innerHeight, scrollX, scrollY,
      globalThis.visualViewport?.scale, globalThis.visualViewport?.offsetLeft, globalThis.visualViewport?.offsetTop]);
    const describeTarget = el => {
      const rect = el.getBoundingClientRect();
      const dialog = el.closest('dialog,[role=dialog],[aria-modal=true],.ant-modal,.el-dialog');
      const fields = [...(dialog?.querySelectorAll?.('input,select,textarea,[aria-checked],[aria-selected]') || [])];
      if (fields.length > 200) throw new Error('Dialog too complex for coordinate verification; use scoped element tools.');
      const values = fields.filter(field => !sensitive(field)).map(field => [field.tagName, field.getAttribute('name'),
        String(field.value ?? '').slice(0, 2000), field.checked, field.getAttribute('aria-checked'), field.getAttribute('aria-selected')]);
      return JSON.stringify([fingerprint(el), rowContext(el), rect.left, rect.top, rect.width, rect.height,
        dialog?.textContent?.slice(0, 8000) || '', values]);
    };
    const pageForeground = () => ({ visibilityState: document.visibilityState, focused: document.hasFocus() });
    const targetEvidence = el => !el ? null : ({ tag: el.tagName?.toLowerCase() || null, role: el.getAttribute?.('role') || null,
      label: clean(label(el) || el.textContent), rowText: rowContext(el) || null });
    if (name === 'browser_validate_coordinate') {
      // A backgrounded document is not a reason to refuse: the token is bound to
      // a DOM element and re-hit-tested here, so the press still lands on the
      // prepared target. Foreground is only enforced when the caller asks for it.
      const pageState = pageForeground();
      if (args.requireForeground === true && (pageState.visibilityState !== 'visible' || !pageState.focused)) {
        return { status: 'waiting', retryable: true, reason: 'page_not_foreground', dispatched: false, pageState,
          nextPollTool: 'browser_health', recommendedNextAction: 'This call asked for foreground evidence. Bring the window and tab to the front, or drop requireForeground to act on the page in the background. No pointer event dispatched.' };
      }
      const record = tokens.get(args.coordinateToken);
      if (args.consume !== false) tokens.delete(args.coordinateToken);
      const currentHit = record ? deepHit(record.x, record.y) : null;
      const connected = !!record?.el?.isConnected;
      const failures = [];
      if (!record) failures.push('coordinate_token_missing_or_expired');
      else {
        if (record.stamp !== stamp()) failures.push('page_or_viewport_changed');
        if (record.nx !== args.x || record.ny !== args.y) failures.push('coordinate_mismatch');
        if (!connected) failures.push('prepared_target_disconnected');
        if (connected && (sensitive(record.el) || !visible(record.el) || record.el.disabled || record.el.getAttribute('aria-disabled') === 'true')) failures.push('prepared_target_unavailable');
        if (currentHit !== record.el) failures.push('hit_target_changed');
        if (connected && describeTarget(record.el) !== record.signature) failures.push('prepared_target_changed');
      }
      if (failures.length) {
        tokens.delete(args.coordinateToken);
        return { status: 'waiting', retryable: true, reason: record ? 'coordinate_target_changed' : 'coordinate_token_missing_or_expired',
          dispatched: false, validationFailures: failures, pageState,
          targetChange: record ? { expected: record.expectedTarget, actual: targetEvidence(currentHit) } : undefined,
          nextPollTool: 'browser_prepare_coordinate', recommendedNextAction: 'Inspect a fresh screenshot and prepare the intended target again. Do not repeat the old coordinate. No pointer press dispatched.' };
      }
      return { status: 'ready', x: record.x, y: record.y, width: innerWidth, height: innerHeight, pageState };
    }
    const pageState = pageForeground();
    if (args.requireForeground === true && (pageState.visibilityState !== 'visible' || !pageState.focused)) {
      return { status: 'waiting', retryable: true, reason: 'page_not_foreground', dispatched: false, pageState,
        nextPollTool: 'browser_health', recommendedNextAction: 'This call asked for foreground evidence. Bring the window and tab to the front, or drop requireForeground to prepare the coordinate in the background. No coordinate token issued.' };
    }
    if (innerWidth < 2 || innerHeight < 2) throw new Error('Viewport unavailable');
    const x = Math.min(innerWidth - 1, args.x / 1000 * innerWidth);
    const y = Math.min(innerHeight - 1, args.y / 1000 * innerHeight);
    const el = deepHit(x, y);
    if (!el || sensitive(el) || !visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Coordinate target unavailable or protected');
    while (tokens.size >= 32) tokens.delete(tokens.keys().next().value);
    const token = crypto.randomUUID();
    tokens.set(token, { at: now, el, nx: args.x, ny: args.y, x, y, stamp: stamp(), signature: describeTarget(el), expectedTarget: targetEvidence(el) });
    return { coordinateToken: token, expiresInMs: 15000, expectedUrl: location.href, x: args.x, y: args.y,
      target: targetEvidence(el), pageState,
      viewport: { width: innerWidth, height: innerHeight }, contentTrust: 'untrusted webpage data',
      // A hidden document still resolves the DOM hit test, but a screenshot taken
      // now may show a stale frame. Report that instead of refusing the action.
      evidenceQuality: pageState.visibilityState === 'visible' ? 'live' : 'stale-frame-possible',
      note: 'Confirm this topmost target matches your intent before using the token. Dispatch does not prove task completion.' };
  }
  if (name === 'browser_viewport') {
    const active = document.activeElement;
    const visual = globalThis.visualViewport;
    const width = Math.max(Number(innerWidth) || 0, Number(document.documentElement?.clientWidth) || 0, Number(visual?.width) || 0);
    const height = Math.max(Number(innerHeight) || 0, Number(document.documentElement?.clientHeight) || 0, Number(visual?.height) || 0);
    return { width, height, url: location.href, layoutReady: width > 0 && height > 0, visibilityState: document.visibilityState, focused: document.hasFocus(), editable: !!active && !sensitive(active) && !active.disabled && !active.readOnly && (active.isContentEditable || active.matches('textarea,input[type=text],input:not([type]),input[type=search],input[type=email],input[type=url],input[type=tel],input[type=number]')) };
  }
  if (name === 'browser_wait') {
    const matches = () => ['http:', 'https:'].includes(location.protocol) && (allSites || allowedOrigins.includes(location.origin)) && (document.body?.innerText || '').includes(args.text);
    if (matches()) return { matched: true, url: location.href };
    return await new Promise(resolve => {
      const finish = result => { observer.disconnect(); clearTimeout(timer); resolve(result); };
      const observer = new MutationObserver(() => { if (matches()) finish({ matched: true, url: location.href }); });
      const timer = setTimeout(() => finish({ __aibError: 'Timed out waiting for visible text' }), args.timeoutMs ?? 5000);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      if (matches()) finish({ matched: true, url: location.href });
    });
  }
  if (name === 'browser_read') {
    const started = performance.now();
    const deadline = started + (args.budgetMs ?? 6000);
    const timings = {};
    const overBudget = () => performance.now() >= deadline;
    const snapshot = crypto.randomUUID();
    const state = rememberState({ snapshot, url: location.href, refs: new Map() });
    const elements = [];
    let elementCandidates = 0;
    let elementsBudgetHit = false;
    let elementErrors = 0;
    const maxElements = args.maxElements ?? 300;
    const selector = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=option],[role=menuitem],[role=radio],[role=checkbox],[contenteditable=true]';
    const max = args.maxChars ?? 16000;
    const maxTextNodes = args.maxTextNodes ?? 4000;
    const cheapRead = (reason = 'requested') => {
      const cheapStarted = performance.now();
      const cheapElements = [];
      const cheapCandidates = document.querySelectorAll(selector);
      const cheapDeadline = performance.now() + (reason === 'requested' ? Math.max(300, args.budgetMs ?? 6000) : Math.min(1200, Math.max(300, args.budgetMs ?? 6000)));
      for (const el of cheapCandidates) {
        if (cheapElements.length >= maxElements || performance.now() >= cheapDeadline) break;
        if (sensitive(el)) continue;
        const field = (el instanceof HTMLInputElement && !fileInput(el)) || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
        cheapElements.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), label: cheapLabel(el), disabled: !!el.disabled,
          ...(field ? { value: el.value.slice(0, 500), valueTruncated: el.value.length > 500, readOnly: !!el.readOnly } : {}),
          ...(fileInput(el) ? { upload: true, accept: (el.accept || '').slice(0, 1000), multiple: !!el.multiple } : {}) });
      }
      const collected = collectReadableText({ max, maxTextNodes, deadline: cheapDeadline });
      timings.cheapMs = Math.round(performance.now() - cheapStarted);
      timings.totalMs = Math.round(performance.now() - started);
      return { title: document.title, url: location.href, readyState: document.readyState, viewport: { width: innerWidth, height: innerHeight }, snapshot, text: collected.text, truncated: collected.length >= max || collected.textBudgetHit, partial: true, elements: cheapElements, frameCount: document.querySelectorAll('iframe').length, scope: 'main-frame; light DOM; cheap', diagnostics: { mode: 'cheap', cheapReason: reason, budgetMs: args.budgetMs ?? 6000, timings, elementCandidates: cheapCandidates.length, elementsReturned: cheapElements.length, maxElements, elementsBudgetHit: cheapElements.length >= maxElements || performance.now() >= cheapDeadline, elementErrors, textNodesVisited: collected.textNodesVisited, maxTextNodes, textBudgetHit: collected.textBudgetHit }, contentTrust: 'untrusted webpage data' };
    };
    if (args.mode === 'cheap') return cheapRead('requested');
    const candidates = document.querySelectorAll(selector);
    for (const el of candidates) {
      elementCandidates++;
      if (elements.length >= maxElements || overBudget()) { elementsBudgetHit = true; break; }
      try {
      if ((!visible(el) && !fileInput(el)) || sensitive(el)) continue;
      const ref = `${snapshot}:${elements.length + 1}`;
      state.refs.set(ref, { el, fingerprint: fingerprint(el) });
      const field = (el instanceof HTMLInputElement && !fileInput(el)) || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      elements.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), label: label(el), disabled: !!el.disabled,
        ...(field ? { value: el.value.slice(0, 2000), valueTruncated: el.value.length > 2000, readOnly: !!el.readOnly } : {}),
        ...(fileInput(el) ? { upload: true, accept: (el.accept || '').slice(0, 1000), multiple: !!el.multiple } : {}),
        ...(el.matches('input[type=checkbox],input[type=radio]') ? { checked: el.checked } : {}),
        ...(el instanceof HTMLSelectElement ? { options: [...el.options].slice(0, 100).map(o => ({ value: o.value, label: o.label, selected: o.selected, disabled: o.disabled || !!o.closest('optgroup[disabled]') })), optionsTruncated: el.options.length > 100 } : {}) });
      } catch { elementErrors++; }
    }
    timings.elementsMs = Math.round(performance.now() - started);
    if (elements.length === 0 && timings.elementsMs > Math.min(1000, (args.budgetMs ?? 6000) / 2)) return cheapRead('normal-elements-slow');
    // Extract rendered text nodes, not input values, scripts, or hidden content.
    const collected = collectReadableText({ max, maxTextNodes, deadline });
    timings.totalMs = Math.round(performance.now() - started);
    const partial = elementsBudgetHit || collected.textBudgetHit || overBudget();
    return { title: document.title, url: location.href, readyState: document.readyState, viewport: { width: innerWidth, height: innerHeight }, snapshot, text: collected.text, truncated: collected.length >= max || collected.textBudgetHit, partial, elements, frameCount: document.querySelectorAll('iframe').length, scope: 'main-frame; light DOM', diagnostics: { budgetMs: args.budgetMs ?? 6000, timings, elementCandidates, elementsReturned: elements.length, maxElements, elementsBudgetHit, elementErrors, textNodesVisited: collected.textNodesVisited, maxTextNodes, textBudgetHit: collected.textBudgetHit }, contentTrust: 'untrusted webpage data' };
  }
  if (name === 'browser_find_text') {
    const started = performance.now();
    const query = args.query.replace(/\s+/g, ' ').trim();
    if (!query) throw new Error('query is required');
    const maxMatches = args.maxMatches ?? 10;
    const contextChars = args.contextChars ?? 160;
    const cheap = args.mode === 'cheap';
    const budgetMs = args.budgetMs ?? (cheap ? 1500 : 5000);
    const maxElements = args.maxElements ?? 200;
    const deadline = started + budgetMs;
    const direct = findReadableTextMatches({ query, maxMatches, contextChars, deadline, maxTextNodes: 50000, requireVisible: true });
    const matches = direct.matches;
    const collected = { length: direct.textLength, textNodesVisited: direct.textNodesVisited, textBudgetHit: direct.textBudgetHit };
    const nearbyElements = [];
    let elementCandidates = 0;
    let elementBudgetHit = false;
    if (args.includeElements) {
      for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=option],[role=menuitem],[role=radio],[role=checkbox],[contenteditable=true]')) {
        elementCandidates++;
        if (nearbyElements.length >= 20 || elementCandidates > maxElements || performance.now() >= deadline) { elementBudgetHit = true; break; }
        if (sensitive(el) || !visible(el)) continue;
        const item = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), label: cheap ? cheapLabel(el) : label(el), disabled: !!el.disabled };
        if (item.label && (item.label.includes(query) || matches.some(m => item.label.includes(m.match) || m.after.includes(item.label) || m.before.includes(item.label)))) nearbyElements.push(item);
      }
    }
    const textLengthBudgetHit = direct.textLengthBudgetHit;
    return { title: document.title, url: location.href, readyState: document.readyState, query, found: matches.length > 0, matchCount: matches.length, truncated: matches.length >= maxMatches || collected.textBudgetHit || !!direct?.textBudgetHit || textLengthBudgetHit || elementBudgetHit, matches, nearbyElements, diagnostics: { mode: cheap ? 'cheap' : 'normal', elapsedMs: Math.round(performance.now() - started), textLength: collected.length, contextChars, maxMatches, textNodesVisited: collected.textNodesVisited, directTextNodesVisited: direct?.textNodesVisited ?? 0, maxTextNodes: 50000, textBudgetHit: collected.textBudgetHit || !!direct?.textBudgetHit, textLengthBudgetHit, budgetMs, maxElements, elementCandidates, elementBudgetHit }, contentTrust: 'untrusted webpage data' };
  }
  if (name === 'browser_observe') {
    const read = await pageOperation('browser_read', { ...args, maxChars: args.maxChars ?? 16000 }, allowedOrigins, allSites);
    const debug = await pageOperation('browser_debug', args, allowedOrigins, allSites);
    const geometry = [];
    const state = globalThis.__aiBrowserBridge;
    for (const item of read.elements.slice(0, 100)) {
      const entry = state?.refs.get(item.ref);
      if (!entry?.el?.isConnected) continue;
      geometry.push({ ref: item.ref, label: item.label, tag: item.tag, role: item.role, upload: !!item.upload, ...elementBox(entry.el) });
    }
    return { read, debug, geometry, observationTrust: 'untrusted webpage data plus extension geometry', scope: 'main-frame; light DOM' };
  }
  if (name === 'browser_scan_overlays') {
    const snapshot = crypto.randomUUID();
    const state = rememberState({ snapshot, url: location.href, refs: new Map() });
    const makeRef = el => {
      for (const [existingRef, entry] of state.refs) if (entry.el === el) return existingRef;
      const ref = `${snapshot}:${state.refs.size + 1}`;
      state.refs.set(ref, { el, fingerprint: fingerprint(el) });
      return ref;
    };
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    const overlays = [];
    const overlaySelector = 'dialog,[role=dialog],[aria-modal=true],[popover],[class*=modal i],[class*=popup i],[class*=overlay i],[class*=mask i],[class*=cookie i],[class*=consent i],[class*=ad i],[class*=chat i],[id*=modal i],[id*=popup i],[id*=overlay i],[id*=cookie i],[id*=consent i],[id*=ad i],[id*=chat i]';
    const candidates = new Set([...document.querySelectorAll(overlaySelector)]);
    for (const el of document.querySelectorAll('body *')) {
      if (candidates.size >= 250) break;
      if (!visible(el) || sensitive(el)) continue;
      const style = getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(style.position)) continue;
      const box = el.getBoundingClientRect();
      const area = Math.max(0, box.width * box.height);
      if (area > viewportArea * 0.015 || Number(style.zIndex) >= 10) candidates.add(el);
    }
    for (const el of candidates) {
      if (!visible(el) || sensitive(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) continue;
      const hint = overlayHint(el);
      const areaRatio = Math.round((box.width * box.height / viewportArea) * 1000) / 1000;
      const style = getComputedStyle(el);
      const closeCandidates = [];
      for (const close of [...el.querySelectorAll('button,a,[role=button],[aria-label],[title]')].filter(closeHint).slice(0, 12)) {
        if (!visible(close) || sensitive(close)) continue;
        // A malicious ad can label an external link "close". Only expose
        // non-navigating anchors as safe dismissal candidates.
        if (close.matches('a[href]') && !/^(#|javascript:)/i.test(close.getAttribute('href') || '')) continue;
        closeCandidates.push({ ref: makeRef(close), ...elementSummary(close) });
      }
      overlays.push({ ref: makeRef(el), hint, areaRatio, position: style.position, zIndex: style.zIndex || 'auto', pointerEvents: style.pointerEvents, opacity: style.opacity, ...elementSummary(el), closeCandidates });
    }
    overlays.sort((a, b) => (b.areaRatio - a.areaRatio) || ((Number(b.zIndex) || 0) - (Number(a.zIndex) || 0)));
    const scrollContainers = [];
    for (const el of document.querySelectorAll('body *')) {
      if (scrollContainers.length >= 40) break;
      if (!visible(el) || sensitive(el)) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) || el.scrollHeight <= el.clientHeight + 20) continue;
      scrollContainers.push({ ref: makeRef(el), scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, ...elementSummary(el) });
    }
    const samplePoints = [[0.5, 0.5], [0.5, 0.12], [0.5, 0.88], [0.12, 0.5], [0.88, 0.5]];
    const hitTest = samplePoints.map(([px, py]) => {
      const x = Math.max(0, Math.min(innerWidth - 1, Math.round(innerWidth * px)));
      const y = Math.max(0, Math.min(innerHeight - 1, Math.round(innerHeight * py)));
      const el = document.elementFromPoint(x, y);
      if (!el || sensitive(el)) return { x, y, element: null };
      return { x, y, ref: makeRef(el), element: elementSummary(el, { hint: overlayHint(el) || null }) };
    });
    return { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, overlays: overlays.slice(0, 50), scrollContainers, hitTest, guidance: 'Use closeCandidates refs with browser_dismiss_overlay only when label/hint clearly identifies a blocker. Use scrollContainers refs with browser_scroll_element for nested panes.', contentTrust: 'untrusted webpage data plus extension hit testing' };
  }
  if (name === 'browser_otp_fetch') {
    // Reads codes out of whatever is on screen in a mailbox or chat tab that is
    // already logged in. It deliberately returns several ranked candidates
    // rather than one answer: a wrong code costs a lockout, and a code from an
    // unverified sender is precisely what a phishing page is after, so the
    // sender line travels with the code and the caller has to check it.
    const maxCandidates = Math.min(20, Math.max(1, args.maxCandidates ?? 5));
    const requireKeyword = args.requireKeyword !== false;
    const KEYWORD = /(验证码|校验码|动态码|确认码|安全码|登录码|verification|verify|one[- ]?time|otp|passcode|security code|auth(?:entication)? code|login code|2fa|two[- ]?factor)/i;
    const PHONEISH = /(phone|mobile|tel|电话|手机|客服|热线|\+\d{1,3}[\s-])/i;
    const blocks = [];
    // Message rows first: in a list view the first row is the newest message, and
    // a row carries its own sender/subject text next to the code.
    for (const item of document.querySelectorAll('[role=listitem],li,tr,article,[class*=mail i],[class*=message i],[class*=thread i],[class*=conversation i]')) {
      if (blocks.length >= 60) break;
      if (!visible(item) || sensitive(item)) continue;
      const text = clean(item.innerText || '');
      if (text.length < 8 || text.length > 4000) continue;
      blocks.push({ text, scoped: true });
    }
    if (!blocks.length) blocks.push({ text: clean(document.body.innerText || ''), scoped: false });
    const candidates = [];
    let charactersScanned = 0;
    const seen = new Set();
    for (const [blockIndex, block] of blocks.entries()) {
      charactersScanned += block.text.length;
      const context = block.text;
      const patterns = [
        { re: /(?<!\d)(\d{6})(?!\d)/g, shape: 'six_digits' },
        { re: /(?<!\d)(\d{4,8})(?!\d)/g, shape: 'digits' },
        { re: /(?<![\w])([A-Z0-9]{6,8})(?![\w])/g, shape: 'alphanumeric' }
      ];
      for (const { re, shape } of patterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(context)) !== null) {
          const code = match[1];
          if (seen.has(`${blockIndex}:${match.index}:${code}`)) continue;
          if (shape === 'alphanumeric' && !(/\d/.test(code) && /[A-Z]/.test(code))) continue;
          // Years, and four-digit numbers, are the two biggest false positives.
          if (/^(19|20)\d{2}$/.test(code)) continue;
          const start = Math.max(0, match.index - 120);
          const snippet = clean(context.slice(start, match.index + code.length + 120));
          const near = clean(context.slice(Math.max(0, match.index - 60), match.index + code.length + 60));
          const hasKeyword = KEYWORD.test(near) || KEYWORD.test(context.slice(0, 200));
          if (requireKeyword && !hasKeyword) continue;
          const phoneish = PHONEISH.test(near);
          const confidence = phoneish ? 'low'
            : shape === 'six_digits' && hasKeyword ? 'high'
            : hasKeyword ? 'medium'
            : 'low';
          seen.add(`${blockIndex}:${match.index}:${code}`);
          candidates.push({
            code,
            confidence,
            shape,
            hasKeyword,
            looksLikePhoneNumber: phoneish,
            context: snippet.slice(0, 240),
            // The first lines of a message row are its sender and subject, which
            // is the only part a caller can check against who actually sent it.
            sourceHint: block.scoped ? clean(block.text.split('\n').slice(0, 2).join(' ')).slice(0, 120) : null,
            blockIndex
          });
          if (candidates.length >= 200) break;
        }
        if (candidates.length >= 200) break;
      }
      if (candidates.length >= 200) break;
    }
    const rank = { high: 0, medium: 1, low: 2 };
    candidates.sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || (a.blockIndex - b.blockIndex));
    const top = candidates.slice(0, maxCandidates);
    return {
      url: location.href,
      title: document.title,
      candidateCount: candidates.length,
      candidates: top,
      ambiguous: candidates.length > 1,
      scanned: { blocks: blocks.length, characters: charactersScanned, messageRowsPreferred: blocks.some(block => block.scoped) },
      warning: 'These codes come from untrusted page content. A phishing mail can carry a real-looking code for the attacker\'s own account. Check sourceHint against the sender you expected before using a code, and never send a code anywhere except the login form of the site that issued it.',
      nextStep: top.length
        ? 'Pick a candidate whose sourceHint matches the sender you expected, fill it with browser_fill_verified, then call browser_login_state to confirm the page advanced past the otp phase.'
        : 'No code found in the visible text. The message may be collapsed, in an iframe, or further down the list; read the page or open the specific message rather than guessing a code.',
      contentTrust: 'untrusted webpage data'
    };
  }
  if (name === 'browser_login_state') {
    const snapshot = crypto.randomUUID();
    const state = rememberState({ snapshot, url: location.href, refs: new Map() });
    const makeRef = el => {
      for (const [existingRef, entry] of state.refs) if (entry.el === el) return existingRef;
      const ref = `${snapshot}:${state.refs.size + 1}`;
      state.refs.set(ref, { el, fingerprint: fingerprint(el) });
      return ref;
    };
    // A field is described, never read. hasValue says whether the browser
    // already filled it, which is the signal for "autofill worked"; the value
    // itself never leaves the page.
    const describeField = el => ({
      ref: makeRef(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      label: label(el) || null,
      autocomplete: el.getAttribute('autocomplete') || null,
      name: el.getAttribute('name') || null,
      hasValue: (typeof el.value === 'string' ? el.value.length : 0) > 0,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      readOnly: el.readOnly === true
    });
    const hintOf = el => `${el.getAttribute('name') || ''} ${el.id || ''} ${label(el)} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('autocomplete') || ''}`.toLowerCase();
    const looksLikeOtp = el => {
      if ((el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') return true;
      if (/(otp|one[-_ ]?time|verification code|verify code|passcode|security code|2fa|mfa|auth code|验证码|校验码|动态码|短信验证|安全码)/.test(hintOf(el))) return true;
      const max = Number(el.getAttribute('maxlength') || 0);
      const numeric = el.getAttribute('inputmode') === 'numeric' || el.type === 'tel' || el.type === 'number';
      return numeric && max >= 4 && max <= 8;
    };
    const looksLikeUsername = el => {
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (['username', 'email', 'tel', 'tel-national'].includes(ac)) return true;
      if (['email', 'tel'].includes(el.type)) return true;
      return /(user|email|e-?mail|phone|mobile|account|login|member|账号|帐号|邮箱|手机|用户名|会员)/.test(hintOf(el));
    };
    const submitText = /(log ?in|sign ?in|sign ?on|continue|next|submit|确认|登录|登陆|提交|下一步|继续)/i;
    const controls = [...document.querySelectorAll('input,select,textarea,button,a[role=button],[role=button]')].filter(el => visible(el) && !fileInput(el));
    const passwordFields = controls.filter(el => el.matches('input[type=password]'));
    const otpFields = controls.filter(el => !el.matches('input[type=password]') && el.matches('input') && looksLikeOtp(el));
    // Split one-time-code widgets: six maxlength=1 boxes are one logical field.
    const digitBoxes = controls.filter(el => el.matches('input') && Number(el.getAttribute('maxlength') || 0) === 1);
    const usernameFields = controls.filter(el => el.matches('input') && !el.matches('input[type=password]') && !looksLikeOtp(el) && looksLikeUsername(el));
    const submitCandidates = controls.filter(el => {
      if (el.matches('input[type=submit],button[type=submit]')) return true;
      const text = `${el.innerText || el.value || ''} ${el.getAttribute('aria-label') || ''}`.trim();
      return submitText.test(text) && !el.matches('input[type=password]');
    }).slice(0, 6);
    const thirdParty = controls.filter(el => {
      const text = `${el.innerText || el.value || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('href') || ''}`.toLowerCase();
      return /(google|apple|microsoft|github|facebook|wechat|weixin|qq|weibo|dingtalk|sso|single sign|微信|企业微信|钉钉|微博|扫码)/.test(text);
    }).slice(0, 8);
    const logoutHints = controls.filter(el => {
      const text = `${el.innerText || el.value || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('href') || ''}`.toLowerCase();
      return /(log ?out|sign ?out|退出|登出|注销)/.test(text);
    }).slice(0, 4);
    const errorNodes = [...document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-live=polite],[class*=error i],[class*=invalid i],[class*=alert i]')]
      .filter(el => visible(el) && !sensitive(el))
      .map(el => clean(el.innerText || el.textContent || ''))
      .filter(text => text && /(error|incorrect|invalid|wrong|failed|denied|错误|失败|不正确|有误|无效|被拒绝|请重试)/i.test(text))
      .slice(0, 4);
    const phase = passwordFields.length ? 'credentials'
      : (otpFields.length || digitBoxes.length >= 4) ? 'otp'
      : logoutHints.length ? 'logged_in'
      : 'unknown';
    const autofill = {
      popupObservableFromExtension: false,
      why: 'Chrome draws the password autofill popup in the browser process, not in the page DOM, so an extension can neither see it open nor click an entry in it. CDP-synthesised key events are delivered to the renderer and never reach that popup either, so pressing Down/Enter cannot pick a suggestion.',
      paths: [
        'If the caller already holds the credential, fill it with browser_fill_verified: that is faster, works on a background tab and is verifiable. browser_credential_lookup can read the saved password for one exact origin when the caller has no other source.',
        'To let Chrome fill from its own saved password, a human has to accept the suggestion, or a foreground Windows UI-automation path has to drive the popup.',
        'A password field whose hasValue is already true means something filled it: read the field state again after the page reacts instead of typing over it.'
      ]
    };
    if (args.focusPassword === true && passwordFields.length) {
      const target = passwordFields[0];
      target.focus();
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      autofill.focusDispatched = true;
      autofill.focusedRef = makeRef(target);
      autofill.note = 'Focus and click were dispatched to the password field. Whether the browser raised its autofill popup is NOT observable from here, so it is reported as unknown rather than assumed.';
    } else {
      autofill.focusDispatched = false;
    }
    return {
      url: location.href,
      title: document.title,
      phase,
      passwordFields: passwordFields.map(describeField),
      usernameFields: usernameFields.map(describeField),
      otpFields: otpFields.map(describeField),
      otpDigitBoxCount: digitBoxes.length,
      submitCandidates: submitCandidates.map(el => ({ ref: makeRef(el), label: label(el) || clean(el.innerText || '').slice(0, 80), tag: el.tagName.toLowerCase() })),
      thirdPartyOptions: thirdParty.map(el => ({ ref: makeRef(el), label: (label(el) || clean(el.innerText || '')).slice(0, 80) })),
      logoutHints: logoutHints.map(el => ({ ref: makeRef(el), label: (label(el) || clean(el.innerText || '')).slice(0, 80) })),
      errorText: errorNodes,
      autofill,
      guidance: phase === 'credentials'
        ? 'A password field is present. Fill the username and password, submit, then call browser_login_state again: a move to phase "otp" means a code is now required.'
        : phase === 'otp'
          ? 'A one-time-code field is present. Read the code with browser_otp_fetch on the mailbox tab, fill it with browser_fill_verified, then call browser_login_state again to confirm the page advanced.'
          : phase === 'logged_in'
            ? 'No password or code field is visible and a sign-out control exists, which suggests the session is already authenticated. Verify with a read of the expected account state rather than assuming.'
            : 'No login form was recognised. This may be a custom widget in a shadow root, a cross-origin iframe, or a page that is neither a login nor a signed-in view. Inspect with browser_shadow_tree or browser_observe before acting.',
      contentTrust: 'untrusted webpage data plus extension geometry'
    };
  }
  if (name === 'browser_find_element') {
    const { candidates, partial, diagnostics } = findElementCandidates(args);
    return { title: document.title, url: location.href, query: args.query, action: args.action || 'any', partial, diagnostics, searchStatus: partial ? 'partial' : 'complete', candidates, found: candidates.length > 0, guidance: partial ? 'Search is incomplete. Do not infer that the target is absent or unique; inspect a screenshot and refine the scope.' : 'Verify the intended target and row before using an uncovered enabled candidate. If covered, inspect overlays before writing.', contentTrust: 'untrusted webpage data plus extension hit testing' };
  }
  if (name === 'browser_prepare_action') {
    const { candidates, partial, diagnostics } = findElementCandidates({ query: args.query, rowText: args.rowText, role: args.role, action: args.action || 'any', maxResults: 8, includeCovered: true });
    const scan = await pageOperation('browser_scan_overlays', args, allowedOrigins, allSites);
    const blocker = candidates.find(c => c.covered);
    const top = candidates.find(c => !c.covered && !c.disabled) || candidates[0] || null;
    const close = scan.overlays.flatMap(o => (o.closeCandidates || []).map(c => ({ overlayRef: o.ref, overlayLabel: o.label, overlayHint: o.hint, close: c }))).find(x => x.close?.ref);
    const steps = [];
    let recommended = 'read';
    if (close && (blocker || scan.overlays.some(o => o.areaRatio > 0.2 || o.hint))) { recommended = 'dismiss_overlay'; steps.push({ tool: 'browser_dismiss_overlay', args: { tabId: args.tabId, ref: close.close.ref, expectGoneRef: close.overlayRef }, reason: `Possible blocker ${close.overlayHint || close.overlayLabel || 'overlay'}` }); }
    if (top && !top.covered && !top.disabled) {
      if (top.locatorEvidence?.includes('clickability-unverified')) {
        recommended = 'verify_text_target';
        steps.push({ tool: 'browser_screenshot', args: { tabId: args.tabId }, ref: top.ref, reason: 'Exact text has a ref but no semantic control role. Verify its menu/row context and user intent before clicking; never infer success from dispatch alone.' });
      } else { recommended = args.action === 'fill' ? 'fill' : args.action === 'select' ? 'pick_or_select' : args.action === 'upload' ? 'upload' : 'click'; steps.push({ tool: recommended === 'pick_or_select' ? 'browser_pick/browser_select' : `browser_${recommended}`, ref: top.ref, reason: 'Top uncovered enabled candidate' }); }
    }
    if (!top && scan.scrollContainers.length) { recommended = 'scroll_element'; steps.push({ tool: 'browser_scroll_element', args: { tabId: args.tabId, ref: scan.scrollContainers[0].ref, deltaY: 600 }, reason: 'No visible candidate; page has scrollable containers' }); }
    if (!top) {
      recommended = 'inspect_widget';
      steps.push({ tool: 'browser_shadow_tree', args: { tabId: args.tabId }, reason: 'Text lookup missed the target; inspect component controls before choosing an action.' });
      steps.push({ tool: 'browser_screenshot', args: { tabId: args.tabId }, reason: 'If component lookup misses the target, visually identify icon/image widgets. Never guess coordinates or treat a container click as success.' });
    }
    if (!steps.length) steps.push({ tool: 'browser_observe', reason: 'No clear candidate or safe overlay action found' });
    if (partial) {
      recommended = 'inspect_partial_search';
      steps.length = 0;
      steps.push({ tool: 'browser_screenshot', args: { tabId: args.tabId }, reason: 'Search budget reached; candidates may be incomplete. Do not infer absence or uniqueness. Inspect the visible target before acting.' });
    }
    if (args.rowText && candidates.filter(c => !c.covered && !c.disabled).length > 1) {
      recommended = 'disambiguate_row';
      steps.length = 0;
      steps.push({ tool: 'browser_screenshot', args: { tabId: args.tabId }, reason: 'Multiple controls match this row scope. Inspect the returned row text and geometry; refine the query before acting.' });
    }
    return { title: document.title, url: location.href, goal: args.goal || '', query: args.query, action: args.action || 'any', recommended, partial, diagnostics, candidates, overlays: scan.overlays.slice(0, 8), scrollContainers: scan.scrollContainers.slice(0, 8), steps, guidance: 'This is read-only planning. Execute only user-authorized writes, with tab lease for shared tabs, and re-read after each write.', contentTrust: 'untrusted webpage data plus extension hit testing' };
  }
  if (name === 'browser_debug') {
    const describe = el => !el ? null : ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      type: el.getAttribute('type') || null,
      label: clean(label(el) || el.textContent),
      value: sensitive(el) ? null : clean(el.value),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: visible(el)
    });
    const roleCounts = {};
    for (const el of document.querySelectorAll('[role],button,input,textarea,select,a[href]')) {
      const key = el.getAttribute('role') || el.tagName.toLowerCase();
      roleCounts[key] = (roleCounts[key] || 0) + 1;
    }
    const visibleOptions = [...document.querySelectorAll(optionSelector)]
      .filter(el => visible(el))
      .slice(0, 50)
      .map(el => ({ text: clean(el.textContent), disabled: el.getAttribute('aria-disabled') === 'true' || el.matches('[disabled],.is-disabled') }));
    const comboboxes = [...document.querySelectorAll('[role=combobox],input')]
      .filter(el => visible(el) && !sensitive(el))
      .slice(0, 50)
      .map(el => ({ label: clean(label(el)), value: clean(el.value), expanded: el.getAttribute('aria-expanded'), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' }));
    const fileInputs = [...document.querySelectorAll('input[type=file]')]
      .slice(0, 20)
      .map(el => ({ visible: visible(el), accept: clean(el.accept), multiple: !!el.multiple, files: el.files?.length ?? 0 }));
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      focused: document.hasFocus(),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      activeElement: describe(document.activeElement),
      roleCounts,
      comboboxes,
      visibleOptions,
      fileInputs,
      dialogs: [...document.querySelectorAll('dialog,[role=dialog],[aria-modal=true]')].filter(el => visible(el)).slice(0, 20).map(describe),
      frameCount: document.querySelectorAll('iframe').length,
      contentTrust: 'untrusted webpage data'
    };
  }
  if (name === 'browser_scroll') {
    if (!Number.isInteger(args.deltaY) || Math.abs(args.deltaY) > 5000) throw new Error('Invalid scroll');
    window.scrollBy({ top: args.deltaY, behavior: 'instant' });
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }
  if (name === 'browser_pick') return await pickControl();
  const state = stateForRef(args.ref);
  const entry = state?.refs.get(args.ref);
  if (!entry || state.url !== location.href || !entry.el.isConnected || fingerprint(entry.el) !== entry.fingerprint) throw new Error('Stale element reference. Read page again.');
  if (entry.rowText !== undefined && rowContext(entry.el) !== entry.rowText) throw new Error('Stale row reference. Table row changed; find the target again.');
  const el = entry.el;
  if (sensitive(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || (!visible(el) && name !== 'browser_upload')) throw new Error('Element unavailable or protected');
  if (name === 'browser_scroll_element') {
    if (!Number.isInteger(args.deltaY) || Math.abs(args.deltaY) > 5000) throw new Error('Invalid scroll');
    if (typeof el.scrollTop !== 'number' || el.scrollHeight <= el.clientHeight) throw new Error('Element is not a scrollable container');
    const before = el.scrollTop;
    el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + args.deltaY));
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { scrollTop: el.scrollTop, before, changed: el.scrollTop !== before, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }
  if (name === 'browser_dismiss_overlay') {
    const box = el.getBoundingClientRect();
    const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
    const hit = deepHit(x, y);
    if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Dismiss target is covered or not topmost. Scan overlays again.');
    el.click();
    const gone = await waitGone(args.expectGoneRef || args.ref, args.timeoutMs ?? 3000);
    return { clicked: true, verification: gone, note: 'Dismiss clicked once; read or scan overlays again to verify page state.' };
  }
  if (name === 'browser_upload') {
    if (!fileInput(el)) throw new Error('Element is not a file input');
    if (typeof args.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data) || typeof args.fileName !== 'string' || !args.fileName || args.fileName.includes('/') || args.fileName.includes('\\')) throw new Error('Invalid upload payload');
    const binary = atob(args.data);
    if (binary.length !== args.size || binary.length > 16 * 1024 * 1024) throw new Error('Upload payload size mismatch');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], args.fileName, { type: args.mimeType || 'application/octet-stream', lastModified: Date.now() }));
    el.files = transfer.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: el.files?.length === 1, fileName: el.files?.[0]?.name || '', size: el.files?.[0]?.size ?? 0, sha256: args.sha256, note: 'File selected in DOM; page acceptance and submission require separate observation.' };
  }
  if (name === 'browser_upload_verified') {
    const selected = await pageOperation('browser_upload', args, allowedOrigins, allSites);
    const result = await verify(args.expect || {}, args.timeoutMs ?? 3000, { fileName: selected.fileName });
    return { selected, verification: result, status: result.status };
  }
  if (name === 'browser_select') {
    if (!(el instanceof HTMLSelectElement)) throw new Error('Element is not a native select');
    const option = [...el.options].find(o => o.value === args.value && !o.disabled && !o.closest('optgroup[disabled]'));
    if (!option) throw new Error('Available option not found');
    el.value = args.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: el.value };
  }
  if (name === 'browser_choose') {
    if (el.getAttribute('role') !== 'combobox' && !(el instanceof HTMLInputElement)) throw new Error('Element is not a combobox');
    const exact = args.text.replace(/\s+/g, ' ').trim();
    if (!exact) throw new Error('Exact option text is required');
    const result = await chooseOption(el, exact, args.timeoutMs ?? 2500);
    return { ...result, note: 'Option clicked once; application acceptance still requires a fresh read.' };
  }
  if (name === 'browser_resolve') {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (args.focus) el.focus();
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const hit = deepHit(x, y);
    if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Element is covered');
    return { x, y, url: location.href };
  }
  if (name === 'browser_click') {
    if (el instanceof HTMLAnchorElement) {
      const target = new URL(el.href, location.href);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || (!allSites && !allowedOrigins.includes(target.origin))) throw new Error('Link target origin not allowed');
    }
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = el.getBoundingClientRect();
    const hit = deepHit(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Element is covered. Read page again.');
    el.click();
    return { clicked: true, note: 'Click dispatched; read page to verify outcome.' };
  }
  if (name === 'browser_click_verified') {
    const baseline = expectationState(args.expect || {});
    if (baseline.satisfied) {
      return { status: 'not_dispatched', reason: 'expected_condition_already_satisfied', dispatched: false, retryable: false,
        verification: { status: 'already_satisfied_before_action', checks: baseline.checks, elapsedMs: 0 },
        recommendedNextAction: 'Re-observe the page and choose a condition that distinguishes this click from the existing state. No click was dispatched.' };
    }
    const clicked = await pageOperation('browser_click', args, allowedOrigins, allSites);
    if (clicked?.__aibError) throw new Error(clicked.__aibError);
    let result;
    try {
      result = await verify(args.expect || {}, args.timeoutMs ?? 3000);
    } catch {
      return { status: 'uncertain', reason: 'verification_interrupted_after_dispatch', dispatched: true, retryable: false,
        recommendedNextAction: 'The click was dispatched but page verification was interrupted. Re-observe and independently verify the outcome before any new action; do not click again automatically.' };
    }
    if (result.status !== 'success') {
      return { clicked, verification: { ...result, status: 'not_observed' }, status: 'uncertain',
        reason: 'expected_outcome_not_observed', dispatched: true, retryable: false,
        recommendedNextAction: 'The click was dispatched, but its expected outcome was not observed before the deadline. Re-observe and independently verify whether it completed; do not click again automatically.' };
    }
    return { clicked, verification: result, status: 'success', dispatched: true, retryable: false };
  }
  if (name === 'browser_fill') {
    if (typeof args.text !== 'string' || args.text.length > 20000 || el.readOnly) throw new Error('Invalid text or readonly field');
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && !['text', 'email', 'search', 'url', 'tel', 'number'].includes(el.type)) throw new Error('Unsupported input type');
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, args.text);
    } else if (el.isContentEditable) { el.textContent = args.text; }
    else throw new Error('Element is not a text field');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: args.text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const observed = el.isContentEditable ? el.textContent : el.value;
    return { filled: true, characters: args.text.length, valueMatches: observed === args.text, dispatchedEvents: ['input', 'change'], applicationStateVerified: false, note: 'DOM value checked immediately; application acceptance still requires observation. Clearing a search field does not necessarily exit search mode; inspect the clear control or use browser_key with Escape if supported by the site.' };
  }
  if (name === 'browser_fill_verified') {
    const filled = await pageOperation('browser_fill', args, allowedOrigins, allSites);
    const current = el.isContentEditable ? el.textContent : el.value;
    const result = await verify(args.expect || { valueMatches: args.text }, args.timeoutMs ?? 3000, { value: current, getValue: () => el.isConnected ? (el.isContentEditable ? el.textContent : el.value) : undefined });
    if (result.status !== 'success') return { filled, verification: { ...result, status: 'not_observed' }, status: 'uncertain',
      reason: 'filled_value_not_observed', dispatched: true, retryable: false,
      recommendedNextAction: 'The fill events were dispatched, but the expected value was not observed. Re-read the field and application state before any further write; do not refill automatically.' };
    return { filled, verification: result, status: 'success', dispatched: true, retryable: false };
  }
  throw new Error('Unsupported page operation');
  } catch (error) {
    // Chrome may return null instead of propagating a thrown injected-script error.
    return { __aibError: error.message };
  }
}




