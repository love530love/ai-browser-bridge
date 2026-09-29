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
  const fingerprint = el => JSON.stringify([el.tagName, el.getAttribute('type'), label(el), el.getAttribute('href'), el.getAttribute('formaction')]);
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
    const snapshot = crypto.randomUUID();
    const state = { snapshot, url: location.href, refs: new Map() };
    globalThis.__aiBrowserBridge = state;
    const elements = [];
    const candidates = document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=option],[role=menuitem],[role=radio],[role=checkbox],[contenteditable=true]');
    for (const el of candidates) {
      if ((!visible(el) && !fileInput(el)) || sensitive(el) || elements.length >= 300) continue;
      const ref = `${snapshot}:${elements.length + 1}`;
      state.refs.set(ref, { el, fingerprint: fingerprint(el) });
      const field = (el instanceof HTMLInputElement && !fileInput(el)) || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      elements.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), label: label(el), disabled: !!el.disabled,
        ...(field ? { value: el.value.slice(0, 2000), valueTruncated: el.value.length > 2000, readOnly: !!el.readOnly } : {}),
        ...(fileInput(el) ? { upload: true, accept: (el.accept || '').slice(0, 1000), multiple: !!el.multiple } : {}),
        ...(el.matches('input[type=checkbox],input[type=radio]') ? { checked: el.checked } : {}),
        ...(el instanceof HTMLSelectElement ? { options: [...el.options].slice(0, 100).map(o => ({ value: o.value, label: o.label, selected: o.selected, disabled: o.disabled || !!o.closest('optgroup[disabled]') })), optionsTruncated: el.options.length > 100 } : {}) });
    }
    // Extract rendered text nodes, not input values, scripts, or hidden content.
    const max = args.maxChars ?? 16000;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const chunks = []; let length = 0; let node;
    while ((node = walker.nextNode()) && length < max) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,[data-ai-private]') || !visible(parent)) continue;
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      if (value) { chunks.push(value); length += value.length + 1; }
    }
    return { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight }, snapshot, text: chunks.join('\n').slice(0, max), truncated: length >= max, elements, frameCount: document.querySelectorAll('iframe').length, scope: 'main-frame; light DOM', contentTrust: 'untrusted webpage data' };
  }
  if (name === 'browser_debug') {
    const clean = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
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
    const visibleOptions = [...document.querySelectorAll('[role=option],[role=menuitem],.el-select-dropdown__item,.ant-select-item-option,li')]
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
    const findOption = () => [...document.querySelectorAll('[role=option],[role=menuitem],.el-select-dropdown__item,.ant-select-item-option,li')]
      .find(option => visible(option) && option.textContent.replace(/\s+/g, ' ').trim() === exact && option.getAttribute('aria-disabled') !== 'true' && !option.matches('[disabled],.is-disabled'));
    let option = findOption();
    // Clicking an already-open combobox commonly toggles its popup closed
    // (Element Plus and similar controls). Reuse a visible exact option first;
    // only open the combobox when no matching option is currently visible.
    if (!option) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.focus(); el.click();
      option = findOption();
    }
    if (!option) option = await new Promise(resolve => {
      const finish = value => { observer.disconnect(); clearTimeout(timer); resolve(value); };
      const observer = new MutationObserver(() => { const found = findOption(); if (found) finish(found); });
      const timer = setTimeout(() => finish(null), args.timeoutMs ?? 2500);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const found = findOption(); if (found) finish(found);
    });
    if (!option) throw new Error('Exact visible option not found');
    option.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    return { chosen: exact, value: typeof el.value === 'string' ? el.value : '', ariaExpanded: el.getAttribute('aria-expanded'), note: 'Option clicked once; application acceptance still requires a fresh read.' };
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
  throw new Error('Unsupported page operation');
  } catch (error) {
    // Chrome may return null instead of propagating a thrown injected-script error.
    return { __aibError: error.message };
  }
}
