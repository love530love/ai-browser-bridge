import { pageOperation } from './page.js';
import { withDebugger, pointer, key } from './cdp.js';
let socket = null;
let keepalive = null;
let connectDeadline = null;
let reconnectTimer = null;
let connectionState = '未连接';
let lastAction = '';
let connectionEpoch = 0;
const uiRequests = new Map();
const tabLeases = new Map();
const defaults = { port: 19387, token: '', allowedOrigins: [], allSites: true, enabled: false };
const reconnectAlarm = 'ai-browser-bridge-reconnect';
const settings = () => chrome.storage.local.get(defaults);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function normalizeLease(tabId, lease) {
  if (!lease || lease.expiresAt <= Date.now()) return null;
  return {
    tabId,
    ...lease,
    remainingMs: Math.max(0, lease.expiresAt - Date.now()),
    idleMs: Math.max(0, Date.now() - (lease.lastActiveAt ?? lease.acquiredAt)),
    autoRenewOnOwnerWrite: true
  };
}
function findTextOperation(args, allowedOrigins, allSites) {
  if (!['http:', 'https:'].includes(location.protocol) || (!allSites && !allowedOrigins.includes(location.origin))) throw new Error('Origin changed or not allowed.');
  const started = performance.now();
  const query = String(args.query || '').replace(/\s+/g, ' ').trim();
  if (!query) throw new Error('query is required');
  const maxMatches = args.maxMatches ?? 10;
  const contextChars = args.contextChars ?? 160;
  const budgetMs = args.budgetMs ?? (args.mode === 'cheap' ? 1500 : 5000);
  const deadline = started + budgetMs;
  const matches = [];
  let visited = 0;
  let textLength = 0;
  let textBudgetHit = false;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && visited < 50000) {
    visited++;
    if (performance.now() >= deadline) { textBudgetHit = true; break; }
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,noscript,input,textarea,select,[data-ai-private],[hidden],[aria-hidden=true],.hidden,#hidden,[style*="display:none"],[style*="display: none"]')) continue;
    const value = node.textContent.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    let from = 0;
    while (matches.length < maxMatches) {
      const index = value.indexOf(query, from);
      if (index < 0) break;
      matches.push({
        index: textLength + index,
        before: value.slice(Math.max(0, index - contextChars), index).trim(),
        match: value.slice(index, index + query.length),
        after: value.slice(index + query.length, index + query.length + contextChars).trim()
      });
      from = index + Math.max(1, query.length);
    }
    textLength += value.length + 1;
    if (matches.length >= maxMatches) break;
  }
  const nearbyElements = [];
  let elementCandidates = 0, elementBudgetHit = false;
  if (args.includeElements) {
    const maxElements = args.maxElements ?? 200;
    for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=link],[role=option],[role=menuitem],[role=radio],[role=checkbox],[contenteditable=true]')) {
      elementCandidates++;
      if (nearbyElements.length >= 20 || elementCandidates > maxElements || performance.now() >= deadline) { elementBudgetHit = true; break; }
      if (el.matches('input[type=password],input[type=hidden]') || el.closest('[data-ai-private]')) continue;
      const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.getAttribute('id') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      const item = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), label, disabled: !!el.disabled };
      if (label && (label.includes(query) || matches.some(m => label.includes(m.match) || m.after.includes(label) || m.before.includes(label)))) nearbyElements.push(item);
    }
  }
  return { title: document.title, url: location.href, readyState: document.readyState, query, found: matches.length > 0, matchCount: matches.length, truncated: matches.length >= maxMatches || elementBudgetHit || textBudgetHit || visited >= 50000, matches, nearbyElements, diagnostics: { mode: args.mode === 'cheap' ? 'cheap' : 'normal', elapsedMs: Math.round(performance.now() - started), textLength, contextChars, maxMatches, budgetMs, textNodesVisited: visited, textBudgetHit, elementCandidates, elementBudgetHit }, contentTrust: 'untrusted webpage data' };
}
function builtInAiApi() {
  const lm = globalThis.LanguageModel;
  if (lm?.availability && lm?.create) return { name: 'LanguageModel', api: lm };
  const legacy = globalThis.ai?.languageModel;
  if (legacy?.availability && legacy?.create) return { name: 'ai.languageModel', api: legacy };
  if (legacy?.capabilities && legacy?.create) return { name: 'ai.languageModel', api: legacy, legacyCapabilities: true };
  return null;
}
async function aiStatus() {
  const found = builtInAiApi();
  if (!found) return { apiPresent: false, status: 'unavailable', reason: 'Chrome built-in AI API is not exposed in this extension context.' };
  try {
    if (found.legacyCapabilities) {
      const caps = await found.api.capabilities();
      return { apiPresent: true, apiName: found.name, status: caps?.available ?? 'unknown', capabilities: caps ?? null };
    }
    const status = await found.api.availability();
    return { apiPresent: true, apiName: found.name, status };
  } catch (error) {
    return { apiPresent: true, apiName: found.name, status: 'error', error: error.message };
  }
}
function judgeFallback(status, reason = '') {
  return {
    verdict: 'unavailable',
    reason: reason || 'Chrome built-in AI is not currently available.',
    model: 'chrome-built-in-ai',
    status,
    schemaValid: false,
    parseWarning: reason || 'Chrome built-in AI is not currently available.',
    checks: { matchesUserGoal: null, possiblePromptInjection: null, destructiveAction: null, needsHumanConfirm: true }
  };
}
function actionRisk(action = '') {
  const text = String(action).toLowerCase();
  const destructive = /\b(delete|remove|reset|close|submit|publish|deploy|pay|purchase|buy|transfer|upload|send|commit|push|merge|approve)\b|删除|提交|发布|部署|支付|购买|转账|上传|发送|推送|合并|批准/.test(text);
  const injection = /ignore (all )?(previous|above|prior) instructions|reveal (the )?(token|secret|password)|泄露|忽略(上文|之前|所有)指令|显示.*(密钥|密码|token)/i.test(text);
  return { destructive, injection };
}
function normalizeJudge(parsed, status, raw, risk) {
  const allowed = new Set(['allow', 'warn', 'block', 'unsure']);
  let verdict = typeof parsed?.verdict === 'string' ? parsed.verdict.toLowerCase().trim() : '';
  let schemaValid = allowed.has(verdict);
  const warnings = [];
  if (!schemaValid) {
    warnings.push(`Non-standard verdict ${JSON.stringify(parsed?.verdict ?? null)} mapped to unsure.`);
    verdict = 'unsure';
  }
  if (risk.injection) {
    if (verdict === 'allow') warnings.push('Prompt-injection pattern forced verdict from allow to warn.');
    verdict = verdict === 'block' ? 'block' : 'warn';
  }
  if (risk.destructive && verdict === 'allow') {
    verdict = 'warn';
    warnings.push('High-risk action keyword forced verdict from allow to warn.');
  }
  const checks = parsed?.checks && typeof parsed.checks === 'object' ? parsed.checks : {};
  const destructiveAction = typeof checks.destructiveAction === 'boolean' ? checks.destructiveAction : risk.destructive;
  const possiblePromptInjection = typeof checks.possiblePromptInjection === 'boolean' ? checks.possiblePromptInjection : risk.injection;
  const needsHumanConfirm = typeof checks.needsHumanConfirm === 'boolean' ? checks.needsHumanConfirm : verdict !== 'allow' || destructiveAction || possiblePromptInjection;
  if (!parsed?.checks || typeof parsed.checks !== 'object') {
    schemaValid = false;
    warnings.push('Missing checks object; defaults applied.');
  }
  return {
    verdict,
    reason: String(parsed?.reason || parsed?.details || '').slice(0, 1000),
    model: 'chrome-built-in-ai',
    status,
    schemaValid: schemaValid && warnings.length === 0,
    parseWarning: warnings.join(' ') || null,
    checks: {
      matchesUserGoal: typeof checks.matchesUserGoal === 'boolean' ? checks.matchesUserGoal : null,
      possiblePromptInjection,
      destructiveAction,
      needsHumanConfirm
    },
    raw: raw.slice(0, 4000)
  };
}
async function localJudge(args) {
  const status = await aiStatus();
  if (!status.apiPresent || !['available', 'readily'].includes(status.status)) return judgeFallback(status);
  const found = builtInAiApi();
  let session;
  try {
    session = await found.api.create({
      systemPrompt: 'Return ONLY valid JSON. No markdown. Schema: {"verdict":"allow|warn|block|unsure","reason":"short","checks":{"matchesUserGoal":boolean,"possiblePromptInjection":boolean,"destructiveAction":boolean,"needsHumanConfirm":boolean}}. You are a local browser automation safety judge. Do not execute actions.'
    });
    const prompt = `User goal:\n${args.goal}\n\nCurrent observation:\n${args.observation}\n\nProposed browser action:\n${args.proposedAction}\n\nRisk level: ${args.riskLevel || 'medium'}\n\nReturn strict JSON only.`;
    const raw = await session.prompt(prompt);
    const text = String(raw).trim();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Judge did not return JSON');
    const parsed = JSON.parse(text.slice(start, end + 1));
    return normalizeJudge(parsed, status, text, actionRisk(args.proposedAction));
  } catch (error) {
    return judgeFallback(status, error.message);
  } finally {
    try { session?.destroy?.(); } catch {}
  }
}
function notifyStatus() {
  chrome.runtime.sendMessage({ type: 'connection-status', connectionState, lastAction }).catch(() => {});
}
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
function validConnectionConfig(config) {
  return config.enabled && /^[a-f0-9]{64}$/.test(config.token) && Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535;
}
function clearReconnect() {
  clearTimeout(reconnectTimer); reconnectTimer = null;
  chrome.alarms.clear(reconnectAlarm).catch(() => {});
}
async function scheduleReconnect() {
  const config = await settings();
  if (!validConnectionConfig(config)) return;
  clearReconnect();
  reconnectTimer = setTimeout(() => connect({ automatic: true }), 5000);
  chrome.alarms.create(reconnectAlarm, { delayInMinutes: 0.1 });
}
function disconnect(message = '已暂停', { automaticReconnect = false } = {}) {
  connectionEpoch++;
  clearInterval(keepalive); keepalive = null;
  clearTimeout(connectDeadline); connectDeadline = null;
  clearReconnect();
  const previous = socket; socket = null;
  if (previous) previous.close();
  for (const request of uiRequests.values()) { clearTimeout(request.timer); request.reject(new Error('连接已断开')); }
  uiRequests.clear();
  connectionState = message;
  notifyStatus();
  chrome.action.setBadgeText({ text: '' });
  if (automaticReconnect) scheduleReconnect();
}
function checkedUrl(url, config) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (!config.allSites && !config.allowedOrigins.includes(u.origin))) throw new Error('Site not allowed. Enable all sites or add its origin in extension settings.');
  return u.href;
}
async function execute(name, args) {
  const config = await settings();
  if (!config.enabled) throw new Error('Extension paused');
  if (name === 'browser_ai_status') return await aiStatus();
  if (name === 'browser_local_judge') return await localJudge(args);
  if (name === 'browser_bridge_modes') {
    return {
      extensionVersion: chrome.runtime.getManifest().version,
      modes: [
        { name: 'health', tools: ['browser_health'], useFor: 'connection, permission, content-script and page-state diagnosis', retrySafe: true },
        { name: 'observe', tools: ['browser_observe', 'browser_read', 'browser_find_text', 'browser_debug'], useFor: 'state acquisition, geometry, visible text search, controls, occlusion hints', retrySafe: true },
        { name: 'dom-transaction', tools: ['browser_click_verified', 'browser_fill_verified', 'browser_upload_verified'], useFor: 'preferred writes with explicit expected outcome', retrySafe: false },
        { name: 'picker-upload-bridge', tools: ['browser_pick', 'browser_choose', 'browser_upload'], useFor: 'custom selects, portal options, hidden file inputs without OS dialog', retrySafe: false },
        { name: 'cdp-input', tools: ['browser_key', 'browser_hover', 'browser_screenshot'], useFor: 'trusted browser keyboard/pointer/screenshot when DOM events are insufficient', retrySafe: false },
        { name: 'coordinate-adapter', tools: ['browser_action'], useFor: 'Open-AutoGLM style normalized coordinates as last resort with stale-URL guard', retrySafe: false }
      ],
      fallbackOrder: ['health', 'observe', 'dom-transaction', 'picker-upload-bridge', 'cdp-input', 'coordinate-adapter', 'human-confirmation'],
      concurrency: { writeLeaseTools: ['browser_claim_tab', 'browser_release_tab', 'browser_tab_lease'], rule: 'one write owner per tab; read-only tools may still observe; conflicting writes return status=waiting instead of throwing' },
      retryPolicy: 'Never replay uncertain writes automatically. Use browser_failure_help, then re-observe and choose the next safer mode.'
    };
  }
  if (name === 'browser_failure_help') {
    const err = String(args.error || '');
    const attempted = String(args.attemptedAction || '');
    const highRisk = actionRisk(attempted).destructive;
    const lower = err.toLowerCase();
    let category = 'unknown';
    let retryAllowed = false;
    let nextMode = 'observe';
    const steps = ['Call browser_health for the tab.', 'Call browser_observe and compare URL, visible text, active element, geometry, and dialogs before any further write.'];
    if (/extension not connected|connection|disconnected/.test(lower)) {
      category = 'connection';
      steps.push('Reconnect extension from the panel; do not retry the write until status reports connected.');
    } else if (/site not allowed|origin/.test(lower)) {
      category = 'permission';
      steps.push('Ask user to allow the origin or enable all HTTP/HTTPS sites, then re-open/re-read the tab.');
    } else if (/stale|read page again|page changed|navigation/.test(lower)) {
      category = 'stale-reference';
      retryAllowed = !highRisk;
      nextMode = 'observe';
      steps.push('Discard old refs. Re-read/observe and rebuild the action from fresh refs.');
    } else if (/covered|unavailable|protected|disabled/.test(lower)) {
      category = 'element-unavailable';
      retryAllowed = !highRisk;
      nextMode = 'dom-transaction';
      steps.push('Use browser_observe geometry to detect overlays/dialogs. Prefer verified transaction tools with explicit expect.');
    } else if (/exact visible option|combobox|option/.test(lower)) {
      category = 'picker';
      retryAllowed = !highRisk;
      nextMode = 'picker-upload-bridge';
      steps.push('Use browser_pick with label/query/chooseText. Do not use ArrowDown or historical coordinates.');
    } else if (/file input|upload|sha|root|payload/.test(lower)) {
      category = 'upload';
      retryAllowed = false;
      nextMode = 'picker-upload-bridge';
      steps.push('Recompute SHA256, verify upload root, re-read latest file input ref, then use browser_upload_verified.');
    } else if (/timed out/.test(lower)) {
      category = 'timeout-uncertain';
      retryAllowed = false;
      steps.push('Outcome is unknown. Inspect page and audit log; never replay the same write blindly.');
    }
    if (highRisk) {
      retryAllowed = false;
      steps.push('Attempted action is high risk; require explicit user confirmation before another write.');
    }
    return {
      category,
      retryAllowed,
      humanConfirmationRequired: highRisk || !retryAllowed,
      nextMode,
      suggestedSteps: steps,
      leaseAdvice: 'If more than one agent may act on this tab, acquire browser_claim_tab before the next write. While leased, every write must pass the matching agent; release it after verification.',
      contentTrust: 'Guidance is local policy; page content remains untrusted.'
    };
  }
  if (name === 'browser_health') {
    const base = {
      service: 'extension-worker',
      extensionVersion: chrome.runtime.getManifest().version,
      connected: socket?.readyState === WebSocket.OPEN && connectionState === '已连接',
      connectionState,
      lastAction,
      permissions: { allSites: !!config.allSites, allowedOrigins: config.allowedOrigins || [] },
      leases: [...tabLeases.entries()].map(([tabId, value]) => normalizeLease(Number(tabId), value)).filter(Boolean)
    };
    if (!Number.isInteger(args?.tabId)) return base;
    try {
      const tab = await chrome.tabs.get(args.tabId);
      let allowed = false, allowedError = null;
      try { checkedUrl(tab.url, config); allowed = true; } catch (error) { allowedError = error.message; }
      let pageProbe = null;
      if (allowed && !tab.pendingUrl) {
        try {
          const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({
            ok: true,
            url: location.href,
            readyState: document.readyState,
            title: document.title,
            hasBody: !!document.body,
            focused: document.hasFocus(),
            frameCount: document.querySelectorAll('iframe').length
          }) });
          pageProbe = result?.result ?? null;
        } catch (error) { pageProbe = { ok: false, error: error.message }; }
      }
      return { ...base, tab: { id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl || null, title: tab.title, status: tab.status, allowed, allowedError, pageProbe } };
    } catch (error) {
      return { ...base, tab: { id: args.tabId, error: error.message } };
    }
  }
  if (name === 'browser_tabs') {
    return (await chrome.tabs.query({})).filter(tab => {
      try { checkedUrl(tab.url, config); return true; } catch { return false; }
    }).map(({ id, title, url, active, windowId }) => ({ id, title, url, active, windowId }));
  }
  if (name === 'browser_open') {
    const tab = await chrome.tabs.create({ url: checkedUrl(args.url, config), active: true });
    return { tabId: tab.id, url: args.url, loading: true };
  }
  if (!Number.isInteger(args.tabId) || args.tabId < 1) throw new Error('Invalid tabId');
  const tab = await chrome.tabs.get(args.tabId);
  checkedUrl(tab.url, config);
  if (tab.pendingUrl && tab.pendingUrl !== tab.url) throw new Error('Navigation in progress. Wait and read again.');
  const leaseKey = String(tab.id);
  const lease = tabLeases.get(leaseKey);
  if (lease && lease.expiresAt <= Date.now()) tabLeases.delete(leaseKey);
  const writeTools = new Set(['browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_navigate', 'browser_close', 'browser_key', 'browser_hover', 'browser_select', 'browser_choose', 'browser_action', 'browser_scroll_element', 'browser_dismiss_overlay', 'browser_click_verified', 'browser_fill_verified', 'browser_upload_verified', 'browser_pick', 'browser_history']);
  if (name === 'browser_claim_tab') {
    const started = Date.now();
    const waitBudgetMs = args.wait ? Math.min(args.ttlMs ?? 30000, 60000) : 0;
    let existing = tabLeases.get(leaseKey);
    while (existing && existing.expiresAt > Date.now() && existing.agent !== args.agent && Date.now() - started < waitBudgetMs) {
      await sleep(Math.min(500, Math.max(50, existing.expiresAt - Date.now())));
      existing = tabLeases.get(leaseKey);
    }
    if (existing && existing.expiresAt > Date.now() && existing.agent !== args.agent) return { status: 'waiting', retryable: true, reason: 'tab_write_lease_conflict', tabId: tab.id, requestedAgent: args.agent, holder: existing.agent, holderLeaseId: existing.leaseId, expiresAt: existing.expiresAt, suggestedDelayMs: Math.min(10000, Math.max(1000, existing.expiresAt - Date.now())), nextPollTool: 'browser_claim_tab', nextPollArgs: { tabId: tab.id, agent: args.agent, ttlMs: args.ttlMs, wait: true }, recommendedNextAction: 'Keep the task alive; retry browser_claim_tab with wait:true, then write with the same agent after acquisition.' };
    const now = Date.now();
    const current = tabLeases.get(leaseKey);
    if (current?.agent === args.agent) {
      const renewed = { ...current, ttlMs: args.ttlMs ?? current.ttlMs ?? 120000, lastActiveAt: now, lastTool: 'browser_claim_tab', renewCount: (current.renewCount ?? 0) + 1 };
      renewed.expiresAt = now + renewed.ttlMs;
      tabLeases.set(leaseKey, renewed);
      return normalizeLease(tab.id, renewed);
    }
    const record = { agent: args.agent, leaseId: crypto.randomUUID(), acquiredAt: now, lastActiveAt: now, lastTool: 'browser_claim_tab', renewCount: 0, ttlMs: args.ttlMs ?? 120000, expiresAt: now + (args.ttlMs ?? 120000) };
    tabLeases.set(leaseKey, record);
    return normalizeLease(tab.id, record);
  }
  if (name === 'browser_renew_tab') {
    const existing = tabLeases.get(leaseKey);
    if (!existing || existing.expiresAt <= Date.now()) return { status: 'waiting', retryable: true, reason: 'tab_write_lease_missing', tabId: tab.id, requestedAgent: args.agent, suggestedDelayMs: 1000, nextPollTool: 'browser_claim_tab', nextPollArgs: { tabId: tab.id, agent: args.agent, ttlMs: args.ttlMs, wait: true }, recommendedNextAction: 'Re-acquire the tab lease with browser_claim_tab before continuing writes.' };
    if (existing.agent !== args.agent) return { status: 'waiting', retryable: true, reason: 'tab_write_lease_conflict', tabId: tab.id, requestedAgent: args.agent, holder: existing.agent, holderLeaseId: existing.leaseId, expiresAt: existing.expiresAt, suggestedDelayMs: Math.min(10000, Math.max(1000, existing.expiresAt - Date.now())), nextPollTool: 'browser_claim_tab', nextPollArgs: { tabId: tab.id, agent: args.agent, ttlMs: args.ttlMs, wait: true }, recommendedNextAction: 'Keep the task alive; wait for the current lease to clear, then claim the tab before continuing writes.' };
    const now = Date.now();
    const renewed = { ...existing, ttlMs: args.ttlMs ?? existing.ttlMs ?? 120000, lastActiveAt: now, lastTool: 'browser_renew_tab', renewCount: (existing.renewCount ?? 0) + 1 };
    renewed.expiresAt = now + renewed.ttlMs;
    tabLeases.set(leaseKey, renewed);
    return normalizeLease(tab.id, renewed);
  }
  if (name === 'browser_release_tab') {
    const existing = tabLeases.get(leaseKey);
    if (existing && existing.agent !== args.agent) throw new Error(`Tab is leased by ${existing.agent}`);
    tabLeases.delete(leaseKey);
    return { released: true, tabId: tab.id };
  }
  if (name === 'browser_tab_lease') return { tabId: tab.id, lease: normalizeLease(tab.id, tabLeases.get(leaseKey)) };
  const activeLease = tabLeases.get(leaseKey);
  if (activeLease && activeLease.expiresAt > Date.now() && writeTools.has(name) && args.agent !== activeLease.agent) return { status: 'waiting', retryable: true, reason: 'tab_write_lease_conflict', tool: name, tabId: tab.id, requestedAgent: args.agent ?? null, holder: activeLease.agent, holderLeaseId: activeLease.leaseId, expiresAt: activeLease.expiresAt, suggestedDelayMs: Math.min(10000, Math.max(1000, activeLease.expiresAt - Date.now())), nextPollTool: 'browser_tab_lease', nextPollArgs: { tabId: tab.id }, recommendedNextAction: 'Keep the task alive, wait suggestedDelayMs, poll browser_tab_lease, then retry the write with the same agent after release.' };
  if (activeLease && activeLease.expiresAt > Date.now() && writeTools.has(name) && args.agent === activeLease.agent) {
    activeLease.lastActiveAt = Date.now();
    activeLease.lastTool = name;
    activeLease.renewCount = (activeLease.renewCount ?? 0) + 1;
    activeLease.expiresAt = Date.now() + (activeLease.ttlMs ?? 120000);
    tabLeases.set(leaseKey, activeLease);
  }
  async function page(name, input = args) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageOperation, args: [name, input, config.allowedOrigins, config.allSites] });
    if (result?.result?.__aibError) throw new Error(result.result.__aibError);
    if (result?.result == null) throw new Error('No page result. Inspect page before retrying.');
    return result.result;
  }
  if (name === 'browser_find_text') {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findTextOperation, args: [args, config.allowedOrigins, config.allSites] });
    if (result?.result?.__aibError) throw new Error(result.result.__aibError);
    if (result?.result == null) throw new Error('No page result. Inspect page before retrying.');
    return result.result;
  }
  async function guarded(sendOperation) {
    return withDebugger(tab.id, async send => {
      const current = await chrome.tabs.get(tab.id);
      if (current.url !== tab.url || current.pendingUrl) throw new Error('Page changed before input. Read again.');
      if (!(await settings()).enabled) throw new Error('Extension paused');
      return sendOperation(send);
    });
  }
  if (name === 'browser_history') {
    if (args.action === 'back') await chrome.tabs.goBack(tab.id);
    if (args.action === 'forward') await chrome.tabs.goForward(tab.id);
    if (args.action === 'reload') await chrome.tabs.reload(tab.id);
    if (args.action === 'activate') await chrome.tabs.update(tab.id, { active: true });
    return { dispatched: args.action };
  }
  if (name === 'browser_key' || name === 'browser_hover') {
    const point = args.ref ? await page('browser_resolve', { ...args, focus: name === 'browser_key' }) : null;
    await guarded(send => name === 'browser_key' ? key(send, args.key) : pointer(send, { ...point, action: 'hover' }));
    return { dispatched: true, inspectOutcome: true };
  }
  if (name === 'browser_action') {
    if (args.expectedUrl !== tab.url) throw new Error('Observation URL is stale. Read page again.');
    const viewport = await page('browser_viewport');
    if (viewport.url !== args.expectedUrl) throw new Error('Observation URL changed');
    if (args.action === 'Wait') { await new Promise(resolve => setTimeout(resolve, args.durationMs)); return { waited: args.durationMs }; }
    if (args.action === 'Back') { await chrome.tabs.goBack(tab.id); return { dispatched: 'back' }; }
    await guarded(async send => {
      if (args.action === 'Type') {
        if (!viewport.editable) throw new Error('Focus an editable non-password field before Type');
        await key(send, 'Ctrl+A'); await send('Input.insertText', { text: args.text }); return;
      }
      if (args.action === 'Key') { await key(send, args.key); return; }
      const point = { x: Math.min(viewport.width - 1, args.x / 1000 * viewport.width), y: Math.min(viewport.height - 1, args.y / 1000 * viewport.height), endX: Math.min(viewport.width - 1, args.endX / 1000 * viewport.width), endY: Math.min(viewport.height - 1, args.endY / 1000 * viewport.height) };
      await pointer(send, { ...point, action: { Tap: 'click', 'Double Tap': 'double', 'Long Press': 'long', Hover: 'hover', Swipe: 'drag' }[args.action] });
    });
    return { dispatched: args.action, inspectOutcome: true };
  }
  if (name === 'browser_navigate') {
    await chrome.tabs.update(tab.id, { url: checkedUrl(args.url, config) });
    return { navigating: true };
  }
  if (name === 'browser_close') { await chrome.tabs.remove(tab.id); return { closed: true }; }
  if (name === 'browser_screenshot') {
    const target = { tabId: tab.id };
    await chrome.debugger.attach(target, '1.3');
    try {
      const now = await chrome.tabs.get(tab.id);
      if (now.url !== tab.url || now.pendingUrl) throw new Error('Page changed before screenshot.');
      const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png' });
      const after = await chrome.tabs.get(tab.id);
      if (after.url !== tab.url || after.pendingUrl) throw new Error('Page changed during screenshot. Discarded.');
      return { data: result.data, mimeType: 'image/png' };
    } finally { await chrome.debugger.detach(target).catch(() => {}); }
  }
  if (name === 'browser_observe') {
    const observation = await page('browser_observe');
    if (args.maxChars && observation.read?.text?.length > args.maxChars) {
      observation.read.text = observation.read.text.slice(0, args.maxChars);
      observation.read.truncated = true;
    }
    return observation;
  }
  if (['browser_click_verified', 'browser_fill_verified', 'browser_upload_verified'].includes(name)) {
    const prepared = name === 'browser_upload_verified' ? { ...args, verifyKind: 'upload' } : args;
    return await page(name, prepared);
  }
  if (!['browser_read', 'browser_find_text', 'browser_find_element', 'browser_prepare_action', 'browser_debug', 'browser_scan_overlays', 'browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_scroll_element', 'browser_dismiss_overlay', 'browser_wait', 'browser_select', 'browser_choose', 'browser_pick'].includes(name)) throw new Error('Unknown command');
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageOperation, args: [name, args, config.allowedOrigins, config.allSites] });
  if (result?.error) throw new Error(result.error.message || 'Page operation failed');
  if (result?.result?.__aibError) throw new Error(result.result.__aibError);
  if (result?.result === undefined) throw new Error('No page result. Page may have navigated; inspect before retrying.');
  return result.result;
}
async function connect() {
  clearReconnect();
  disconnect('连接中');
  const epoch = connectionEpoch;
  const config = await settings();
  if (epoch !== connectionEpoch) return;
  if (!config.enabled) { connectionState = '已暂停'; notifyStatus(); return; }
  if (!/^[a-f0-9]{64}$/.test(config.token) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) { connectionState = '请先配对'; notifyStatus(); return; }
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`);
  socket = ws;
  connectDeadline = setTimeout(() => { if (socket === ws) disconnect('连接超时，后台自动重连中', { automaticReconnect: true }); }, 10000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: config.token, version: chrome.runtime.getManifest().version }));
  ws.onmessage = async event => {
    if (ws !== socket) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'ui-result') {
        const pending = uiRequests.get(message.id);
        if (pending) { clearTimeout(pending.timer); uiRequests.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
        return;
      }
      if (message.type === 'task-state') { chrome.runtime.sendMessage(message).catch(() => {}); return; }
      if (message.type === 'ready') {
        clearTimeout(connectDeadline); connectDeadline = null;
        connectionState = '已连接';
        notifyStatus();
        chrome.action.setBadgeBackgroundColor({ color: '#22b895' });
        chrome.action.setBadgeText({ text: 'ON' });
        // Transport keepalive only: no model, no task polling, no cloud requests.
        keepalive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'keepalive' })); }, 20000);
      } else if (message.type === 'command') {
        lastAction = `${new Date().toLocaleTimeString()} · ${message.name}`;
        notifyStatus();
        try {
          const result = await execute(message.name, message.args);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
        } catch (e) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, error: e.message }));
        }
      }
    } catch { disconnect('协议错误，后台自动重连中', { automaticReconnect: true }); }
  };
  ws.onerror = () => { if (socket === ws) { connectionState = '本机服务不可用'; notifyStatus(); } };
  ws.onclose = () => { if (socket === ws) disconnect('连接已断开，后台自动重连中', { automaticReconnect: true }); };
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === reconnectAlarm) connect({ automatic: true });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own extension UI may configure or reconnect. No content-script API.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  (async () => {
    if (message.type === 'status') return { connectionState, lastAction, ...(await settings()), token: undefined };
    if (message.type === 'connect') { await chrome.storage.local.set({ enabled: true }); await connect(); return { ok: true }; }
    if (message.type === 'pause') { await chrome.storage.local.set({ enabled: false }); disconnect(); return { ok: true }; }
    if (message.type === 'open-assistant') { await chrome.sidePanel.open({ windowId: message.windowId }); return { ok: true }; }
    if (message.type === 'agent') {
      if (socket?.readyState !== WebSocket.OPEN || connectionState !== '已连接') throw new Error('请先连接本机服务');
      return await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { uiRequests.delete(id); reject(new Error('服务响应超时')); }, 10000);
        uiRequests.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: 'ui', id, name: message.name, args: message.args }));
      });
    }
    throw new Error('Unknown UI message');
  })().then(respond, error => respond({ error: error.message }));
  return true;
});
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
// With a saved pairing key, the extension reconnects in the background.
connect();

