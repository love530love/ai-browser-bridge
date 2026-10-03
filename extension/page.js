// Runs in Chrome's isolated extension world, never the page's JS world.
export async function pageOperation(name, args, allowedOrigins, allSites = false) {
  try {
  if (!['http:', 'https:'].includes(location.protocol) || (!allSites && !allowedOrigins.includes(location.origin))) throw new Error('Origin changed or not allowed.');
  const visible = el => {
    const style = getComputedStyle(el);
    return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[inert]');
  };
  const sensitive = el => el.matches('input[type=password],input[type=hidden]') || el.closest('[data-ai-private]');
  const fileInput = el => el instanceof HTMLInputElement && el.type === 'file';
  const label = el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || '').trim().slice(0, 180);
  const cheapLabel = el => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.getAttribute('id') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const fingerprint = el => JSON.stringify([el.tagName, el.getAttribute('type'), label(el), el.getAttribute('href'), el.getAttribute('formaction')]);
  const clean = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const collectReadableText = ({ max = 16000, maxTextNodes = 4000, deadline = Infinity, requireVisible = true } = {}) => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const chunks = [];
    let length = 0;
    let node;
    let textNodesVisited = 0;
    let textBudgetHit = false;
    while ((node = walker.nextNode()) && length < max) {
      textNodesVisited++;
      if (textNodesVisited > maxTextNodes || performance.now() >= deadline) { textBudgetHit = true; break; }
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,select,[data-ai-private],[hidden],[aria-hidden=true],.hidden,#hidden,[style*=\"display:none\"],[style*=\"display: none\"]') || sensitive(parent) || (requireVisible && !visible(parent))) continue;
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      if (value) { chunks.push(value); length += value.length + 1; }
    }
    return { text: chunks.join('\n').slice(0, max), length, textNodesVisited, textBudgetHit };
  };
  const elementBox = el => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const hit = box.width > 0 && box.height > 0 ? document.elementFromPoint(Math.min(Math.max(x, 0), innerWidth - 1), Math.min(Math.max(y, 0), innerHeight - 1)) : null;
    return { x, y, left: box.left, top: box.top, width: box.width, height: box.height, covered: !!hit && hit !== el && !el.contains(hit), hitTag: hit?.tagName?.toLowerCase() || null };
  };
  const pageText = () => document.body?.innerText || '';
  const verify = async (expect = {}, timeoutMs = 3000, context = {}) => {
    const started = Date.now();
    const checks = {};
    const run = () => {
      if (typeof expect.textAppears === 'string') checks.textAppears = pageText().includes(expect.textAppears);
      if (typeof expect.urlContains === 'string') checks.urlContains = location.href.includes(expect.urlContains);
      if (typeof expect.elementLabelAppears === 'string') {
        const needle = expect.elementLabelAppears.replace(/\s+/g, ' ').trim();
        checks.elementLabelAppears = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=option],[role=combobox],[contenteditable=true]')]
          .some(el => visible(el) && label(el).replace(/\s+/g, ' ').trim().includes(needle));
      }
      if (typeof expect.valueMatches === 'string') checks.valueMatches = context.value === expect.valueMatches;
      if (typeof expect.fileNameAppears === 'string') checks.fileNameAppears = pageText().includes(expect.fileNameAppears) || context.fileName === expect.fileNameAppears;
      return Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
    };
    if (run()) return { status: 'success', checks, elapsedMs: Date.now() - started };
    return await new Promise(resolve => {
      const finish = () => {
        const ok = run();
        observer.disconnect();
        clearTimeout(timer);
        resolve({ status: ok ? 'success' : 'failed', checks: { ...checks }, elapsedMs: Date.now() - started });
      };
      const observer = new MutationObserver(() => { if (run()) finish(); });
      const timer = setTimeout(finish, timeoutMs);
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
  if (name === 'browser_viewport') {
    const active = document.activeElement;
    return { width: innerWidth, height: innerHeight, url: location.href, editable: !!active && !sensitive(active) && !active.disabled && !active.readOnly && (active.isContentEditable || active.matches('textarea,input[type=text],input:not([type]),input[type=search],input[type=email],input[type=url],input[type=tel],input[type=number]')) };
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
    const state = { snapshot, url: location.href, refs: new Map() };
    globalThis.__aiBrowserBridge = state;
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
    const collected = cheap
      ? collectReadableText({ max: 500000, maxTextNodes: 50000, deadline, requireVisible: false })
      : collectReadableText({ max: 500000, maxTextNodes: 50000, deadline });
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
    const nearbyElements = [];
    let elementCandidates = 0;
    let elementBudgetHit = false;
    if (args.includeElements) {
      for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=option],[role=menuitem],[role=radio],[role=checkbox],[contenteditable=true]')) {
        elementCandidates++;
        if (nearbyElements.length >= 20 || elementCandidates > maxElements || performance.now() >= deadline) { elementBudgetHit = true; break; }
        if (sensitive(el)) continue;
        const item = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), label: cheap ? cheapLabel(el) : label(el), disabled: !!el.disabled };
        if (item.label && (item.label.includes(query) || matches.some(m => item.label.includes(m.match) || m.after.includes(item.label) || m.before.includes(item.label)))) nearbyElements.push(item);
      }
    }
    return { title: document.title, url: location.href, readyState: document.readyState, query, found: matches.length > 0, matchCount: matches.length, truncated: matches.length >= maxMatches || collected.textBudgetHit || elementBudgetHit, matches, nearbyElements, diagnostics: { mode: cheap ? 'cheap' : 'normal', elapsedMs: Math.round(performance.now() - started), textLength: normalized.length, contextChars, maxMatches, textNodesVisited: collected.textNodesVisited, maxTextNodes: cheap ? 8000 : 50000, textBudgetHit: collected.textBudgetHit, budgetMs, maxElements, elementCandidates, elementBudgetHit }, contentTrust: 'untrusted webpage data' };
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
  const state = globalThis.__aiBrowserBridge;
  const entry = state?.refs.get(args.ref);
  if (!entry || state.url !== location.href || !entry.el.isConnected || fingerprint(entry.el) !== entry.fingerprint) throw new Error('Stale element reference. Read page again.');
  const el = entry.el;
  if (sensitive(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || (!visible(el) && name !== 'browser_upload')) throw new Error('Element unavailable or protected');
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
    const hit = document.elementFromPoint(x, y);
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
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Element is covered. Read page again.');
    el.click();
    return { clicked: true, note: 'Click dispatched; read page to verify outcome.' };
  }
  if (name === 'browser_click_verified') {
    const clicked = await pageOperation('browser_click', args, allowedOrigins, allSites);
    const result = await verify(args.expect || {}, args.timeoutMs ?? 3000);
    return { clicked, verification: result, status: result.status };
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
    return { filled: true, characters: args.text.length, valueMatches: observed === args.text, note: 'DOM value checked immediately; application acceptance still requires observation.' };
  }
  if (name === 'browser_fill_verified') {
    const filled = await pageOperation('browser_fill', args, allowedOrigins, allSites);
    const current = el.isContentEditable ? el.textContent : el.value;
    const result = await verify(args.expect || { valueMatches: args.text }, args.timeoutMs ?? 3000, { value: current });
    return { filled, verification: result, status: result.status };
  }
  throw new Error('Unsupported page operation');
  } catch (error) {
    // Chrome may return null instead of propagating a thrown injected-script error.
    return { __aibError: error.message };
  }
}
