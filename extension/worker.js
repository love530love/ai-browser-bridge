import { pageOperation } from './page.js';
import { withDebugger, pointer, key } from './cdp.js';
import { createErrorJournal } from './error-journal.js';
import { evaluatedValue, resourceSummary } from './cdp-results.js';
import { captureDevtools, createTabSubscription } from './cdp-capture.js';
import { reuseKey, samePage, visibleTab, createTabOwnership } from './tab-identity.js';
let socket = null;
let keepalive = null;
let connectDeadline = null;
let reconnectTimer = null;
// The service worker can be suspended between retries. Keep the retry state in
// memory for the current worker lifetime and mirror every retry through an
// alarm, so a refused localhost connection does not turn into a permanent
// disconnect or a storm of simultaneous sockets.
let reconnectAttempt = 0;
let connectInFlight = false;
let connectionState = '未连接';
const errorJournal = createErrorJournal(chrome.storage.local, message => {
  if (socket?.readyState !== WebSocket.OPEN || connectionState !== '已连接') return false;
  socket.send(JSON.stringify(message)); return true;
});
// Which tabs this bridge opened. Closing anything else would destroy work the
// user did not hand over, so browser_close checks this before removing a tab.
const tabOwnership = createTabOwnership(chrome.storage.session);
function reportExtensionError(source, error, category = 'EXTENSION_ERROR') {
  void errorJournal.record(source, category).then(() => errorJournal.flush()).catch(() => {});
}
let lastAction = '';
let connectionEpoch = 0;
const uiRequests = new Map();
// Tab write leases are owned by the bridge service (src/leases.js), not by this
// service worker. Chrome recycles MV3 workers, which used to make leases vanish
// mid-task. Lease tools are answered by the service and never reach the
// extension; this worker only executes page operations.
const defaults = { port: 19387, token: '', allowedOrigins: [], allSites: true, enabled: false };
const reconnectAlarm = 'ai-browser-bridge-reconnect';
const settings = () => chrome.storage.local.get(defaults);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    // Small on-device models frequently emit prose or a localized word instead
    // of the exact enum. Recovering the verdict from the raw answer keeps the
    // judge useful instead of degrading every call to `unsure`, which would
    // make a judge:"require" policy block all writes.
    const recovered = String(raw || '').toLowerCase().match(/\b(allow|warn|block|unsure)\b/);
    if (recovered) {
      warnings.push(`Non-standard verdict ${JSON.stringify(parsed?.verdict ?? null)} recovered from model text as "${recovered[1]}".`);
      verdict = recovered[1];
    } else {
      warnings.push(`Non-standard verdict ${JSON.stringify(parsed?.verdict ?? null)} mapped to unsure.`);
      verdict = 'unsure';
    }
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
// The badge used to be blank for everything except "connected", so a paused
// extension, a dead service and an unpaired install all looked identical in the
// toolbar. One glance at the badge has to tell them apart.
const BADGE_STATES = [
  { match: s => s === '已连接', text: 'ON', color: '#22b895' },
  { match: s => s === '已暂停', text: 'OFF', color: '#888780' },
  { match: s => s === '请先配对', text: '?', color: '#888780' },
  { match: s => s.startsWith('配对密钥'), text: '?', color: '#E24B4A' },
  { match: s => s.startsWith('另一个 Chrome'), text: '2', color: '#BA7517' },
  { match: s => s.startsWith('连接中'), text: '...', color: '#BA7517' }
];
function applyBadge() {
  const state = BADGE_STATES.find(item => item.match(connectionState)) || { text: '!', color: '#E24B4A' };
  chrome.action.setBadgeBackgroundColor({ color: state.color }).catch(error => reportExtensionError('badge-color', error, 'UI_API_ERROR'));
  chrome.action.setBadgeText({ text: state.text }).catch(error => reportExtensionError('badge-text', error, 'UI_API_ERROR'));
}
// After we've been connected once, a small system notification when something
// goes wrong replaces the user's "I just stare at a blank badge" feeling. Throttled
// so we don't pester anyone — at most one per problem state per 10 minutes.
let wasConnected = false;
let lastNotifyAt = 0;
const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const NOTIFY_PROBLEMS = {
  '配对密钥': ['配对密钥不匹配', '请重新运行 pair.ps1，把新的密钥粘贴到扩展面板。'],
  '另一个 Chrome': ['本机服务已被另一个 Chrome 配置占用', '在那一配置的扩展面板里断开连接，然后再试。'],
  '本机服务不可用': ['本机桥接服务未运行', '请在项目目录里运行 start.ps1（已配置登录自启后通常不需要手动启动）。']
};
function maybeNotify(state) {
  if (!chrome.notifications?.create) return;
  if (state === '已连接') { wasConnected = true; return; }
  if (!wasConnected) return;
  const match = Object.entries(NOTIFY_PROBLEMS).find(([prefix]) => state.startsWith(prefix));
  if (!match) return;
  if (Date.now() - lastNotifyAt < NOTIFY_COOLDOWN_MS) return;
  lastNotifyAt = Date.now();
  chrome.notifications.create(`aib-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-48.png'),
    title: '自主浏览器 · AI Browser Bridge',
    message: match[1][0],
    contextMessage: match[1][1],
    silent: true
  }).catch(error => reportExtensionError('notification', error, 'UI_API_ERROR'));
}
function notifyStatus() {
  applyBadge();
  maybeNotify(connectionState);
  chrome.runtime.sendMessage({ type: 'connection-status', connectionState, lastAction }).catch(() => {});
}
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(error => reportExtensionError('storage-access', error, 'STORAGE_ERROR'));
function validConnectionConfig(config) {
  return config.enabled && /^[a-f0-9]{64}$/.test(config.token) && Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535;
}
function clearReconnect() {
  clearTimeout(reconnectTimer); reconnectTimer = null;
  chrome.alarms.clear(reconnectAlarm).catch(() => {});
}
async function scheduleReconnect(delayMs = null) {
  const config = await settings();
  if (!validConnectionConfig(config)) return;
  clearReconnect();
  if (delayMs == null) {
    const base = Math.min(30000, 1000 * (2 ** Math.min(reconnectAttempt, 5)));
    // Small jitter prevents several profiles/workers from reconnecting in the
    // same millisecond after the bridge service is restarted.
    delayMs = Math.round(base * (0.9 + Math.random() * 0.2));
    reconnectAttempt++;
  }
  reconnectTimer = setTimeout(() => connect({ automatic: true }), delayMs);
  chrome.alarms.create(reconnectAlarm, { delayInMinutes: Math.max(0.1, delayMs / 60000) });
}
function disconnect(message = '已暂停', { automaticReconnect = false, reconnectDelayMs = 5000 } = {}) {
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
  if (automaticReconnect) scheduleReconnect(reconnectDelayMs);
}
function checkedUrl(url, config) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (!config.allSites && !config.allowedOrigins.includes(u.origin))) throw new Error('Site not allowed. Enable all sites or add its origin in extension settings.');
  return u.href;
}
async function execute(name, args, commandContext = { socket, epoch: connectionEpoch }) {
  const commandSocket = commandContext.socket;
  const commandEpoch = commandContext.epoch;
  let pointerPressesAttempted = 0;
  const config = await settings();
  if (!config.enabled) throw new Error('Extension paused');
  const commandStillActive = async () => {
    const latest = await settings();
    return latest.enabled && connectionEpoch === commandEpoch && socket === commandSocket && commandSocket?.readyState === WebSocket.OPEN;
  };
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
        { name: 'cdp-capture', tools: ['browser_devtools_capture'], useFor: 'read-only console/network/script/metrics capture inside one bounded window; not a DevTools write path', retrySafe: true },
        { name: 'coordinate-adapter', tools: ['browser_action'], useFor: 'Open-AutoGLM style normalized coordinates as last resort with stale-URL guard', retrySafe: false }
      ],
      fallbackOrder: ['health', 'observe', 'cdp-capture', 'dom-transaction', 'picker-upload-bridge', 'cdp-input', 'coordinate-adapter', 'human-confirmation'],
      concurrency: { writeLeaseTools: ['browser_claim_tab', 'browser_release_tab', 'browser_tab_lease'], rule: 'one write owner per tab; read-only tools may still observe; conflicting writes return status=waiting instead of throwing' },
      retryPolicy: 'Never replay uncertain writes automatically. Use browser_failure_help, then re-observe and choose the next safer mode.'
    };
  }
  if (name === 'browser_frames') {
    const tab = await chrome.tabs.get(args.tabId);
    const config = await settings();
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({ url: location.href, origin: location.origin, name: name || '', readyState: document.readyState })
    });
    return { tabId: tab.id, frames: frames.map(item => ({ frameId: item.frameId, ...(item.result || {}), accessible: !item.error })), contentTrust: 'untrusted webpage metadata' };
  }
  const frameRef = typeof args?.ref === 'string' ? args.ref.match(/^(.*)@frame(\d+)$/) : null;
  const routedArgs = frameRef ? { ...args, ref: frameRef[1], frame: Number(frameRef[2]) } : args;
  if (name === 'browser_performance') {
    const tab = await chrome.tabs.get(args.tabId);
    checkedUrl(tab.url, config);
    return withDebugger(tab.id, async send => {
      const [metrics, layout, timing] = await Promise.all([
        send('Performance.getMetrics').catch(error => ({ error: error.message })),
        send('Page.getLayoutMetrics').catch(error => ({ error: error.message })),
        send('Runtime.evaluate', { expression: `(() => { const n = performance.getEntriesByType('navigation')[0]; const resources = performance.getEntriesByType('resource'); const longTasks = performance.getEntriesByType('longtask'); return { readyState: document.readyState, visibilityState: document.visibilityState, url: location.href, navigation: n ? { type: n.type, startTime: n.startTime, domInteractive: n.domInteractive, domContentLoaded: n.domContentLoadedEventEnd, loadEventEnd: n.loadEventEnd, responseEnd: n.responseEnd } : null, resources: resources.length, resourceTransferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0), longTasks: longTasks.length, longestTaskMs: longTasks.reduce((max, item) => Math.max(max, item.duration || 0), 0) }; })()`, returnByValue: true }).catch(error => ({ error: error.message }))
      ]);
      return { tabId: tab.id, metrics: metrics.metrics || metrics, layout, timing: timing.error ? timing : evaluatedValue(timing), contentTrust: 'untrusted webpage diagnostics' };
    });
  }
  if (name === 'browser_network_summary') {
    const tab = await chrome.tabs.get(args.tabId);
    checkedUrl(tab.url, config);
    return withDebugger(tab.id, async send => {
      const limit = Math.min(200, Math.max(1, args.maxEntries ?? 100));
      const result = await send('Runtime.evaluate', { expression: `(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin, entries: performance.getEntriesByType('resource').slice(-${limit}).map(r => ({ name: String(r.name), initiatorType: r.initiatorType, duration: Math.round(r.duration), transferSize: r.transferSize || 0, decodedBodySize: r.decodedBodySize || 0, startTime: Math.round(r.startTime) })) }))()`, returnByValue: true });
      const after = await chrome.tabs.get(tab.id);
      if (after.url !== tab.url || after.pendingUrl) throw new Error('Page changed during network diagnostic. Observe again.');
      return { tabId: tab.id, ...resourceSummary(result) };
    });
  }
  if (name === 'browser_devtools_capture') {
    const tab = await chrome.tabs.get(args.tabId);
    checkedUrl(tab.url, config);
    return await withDebugger(tab.id, async send => captureDevtools({
      tabId: tab.id,
      expectedUrl: tab.url,
      requested: args.domains,
      durationMs: args.durationMs,
      maxEvents: args.maxEvents,
      send,
      subscribe: createTabSubscription(chrome.debugger, tab.id),
      // A pending navigation must not be reported as a stable same-page window.
      readUrl: async () => {
        const now = await chrome.tabs.get(tab.id);
        return now.pendingUrl ? `pending:${now.pendingUrl}` : now.url;
      }
    }));
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
    } else if (/covered|unavailable|protected|disabled|obscured|intercept/.test(lower)) {
      category = 'element-unavailable';
      retryAllowed = !highRisk;
      nextMode = 'planner';
      steps.push('Call browser_prepare_action with the original goal, then inspect overlay and element candidates before choosing a fresh ref.');
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
    } else if (/timed out|timeout|busy|main thread|execution context/.test(lower)) {
      category = 'timeout-uncertain';
      retryAllowed = false;
      nextMode = 'wait-and-plan';
      steps.push('Call browser_wait_until_ready, then browser_prepare_action or browser_read mode:"cheap". Inspect writes before deciding whether the outcome is unknown.');
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
      nextPollTool: category === 'timeout-uncertain' ? 'browser_wait_until_ready' : undefined,
      nextPollArgs: category === 'timeout-uncertain' ? { timeoutMs: 5000, idle: true } : undefined,
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
      leaseOwner: 'bridge-service'
    };
    if (!Number.isInteger(args?.tabId)) return base;
    try {
      const tab = await chrome.tabs.get(args.tabId);
      let allowed = false, allowedError = null, windowFocused = null, windowFocusError = null;
      try { checkedUrl(tab.url, config); allowed = true; } catch (error) { allowedError = error.message; }
      try { windowFocused = !!(await chrome.windows.get(tab.windowId)).focused; } catch (error) { windowFocusError = error.message; }
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
            visibilityState: document.visibilityState,
            viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
            frameCount: document.querySelectorAll('iframe').length
          }) });
          pageProbe = result?.result ?? null;
        } catch (error) { pageProbe = { ok: false, error: error.message }; }
      }
      return { ...base, tab: { id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl || null, title: tab.title, status: tab.status, active: !!tab.active, windowId: tab.windowId, windowFocused, windowFocusError, allowed, allowedError, pageProbe } };
    } catch (error) {
      return { ...base, tab: { id: args.tabId, error: error.message } };
    }
  }
  if (name === 'browser_tabs') {
    const owned = await tabOwnership.ids();
    return (await chrome.tabs.query({})).filter(tab => {
      if (!visibleTab(tab, { includeIncognito: args.includeIncognito === true })) return false;
      try { checkedUrl(tab.url, config); return true; } catch { return false; }
    }).map(({ id, title, url, active, windowId, incognito }) => ({
      id, title, url, active, windowId, incognito: incognito === true, bridgeCreated: owned.has(id)
    }));
  }
  if (name === 'browser_open') {
    const targetUrl = checkedUrl(args.url, config);
    // Stealing focus buys nothing: every primitive works on a background tab,
    // so a caller that wants the window in front has to say so.
    const wantActive = args.active === true;
    if (args.reuseExisting !== false) {
      const wanted = reuseKey(targetUrl);
      const existing = wanted === null ? null
        : (await chrome.tabs.query({})).find(candidate => visibleTab(candidate) && samePage(candidate.url, targetUrl));
      if (existing) {
        if (wantActive) await chrome.tabs.update(existing.id, { active: true });
        return { tabId: existing.id, url: existing.url, reused: true, activated: wantActive,
          loading: existing.status !== 'complete', note: 'Reused an existing tab. Nothing was created and the window was not moved to the front.' };
      }
    }
    // The extension cannot create incognito tabs: a split incognito profile has
    // a separate cookie jar, and silently opening one would look logged out.
    const tab = await chrome.tabs.create({ url: targetUrl, active: wantActive });
    await tabOwnership.mark(tab.id);
    return { tabId: tab.id, url: targetUrl, reused: false, activated: wantActive, incognito: false, loading: true };
  }
  if (!Number.isInteger(args.tabId) || args.tabId < 1) throw new Error('Invalid tabId');
  const tab = await chrome.tabs.get(args.tabId);
  checkedUrl(tab.url, config);
  if (tab.pendingUrl && tab.pendingUrl !== tab.url) throw new Error('Navigation in progress. Wait and read again.');
  // Lease tools never reach the extension: the service owns and answers them.
  // Page operations below therefore execute unconditionally; conflicting writes
  // were already rejected by the service before this job was dispatched.
  async function page(name, input = routedArgs) {
    const target = Number.isInteger(input.frame) ? { tabId: tab.id, frameIds: [input.frame] } : { tabId: tab.id };
    const results = await chrome.scripting.executeScript({ target, func: pageOperation, args: [name, input, config.allowedOrigins, config.allSites] });
    const result = results[0];
    if (result?.result?.__aibError) throw new Error(result.result.__aibError);
    if (result?.result == null) throw new Error('No page result. Inspect page before retrying.');
    return result.result;
  }
  async function pointerForeground({ afterMove = false, invalidateCoordinate = false, requireForeground = false } = {}) {
    const commandActive = await commandStillActive();
    const currentTab = await chrome.tabs.get(tab.id);
    let windowFocused = false, windowFocusError = null;
    try { windowFocused = !!(await chrome.windows.get(currentTab.windowId)).focused; }
    catch (error) { windowFocusError = error.message; }
    const pageState = await page('browser_viewport');
    const foreground = { tabActive: !!currentTab.active, windowFocused, windowFocusError,
      visibilityState: pageState.visibilityState, documentFocused: pageState.focused,
      viewport: { width: pageState.width, height: pageState.height } };
    // Hard blockers are about target correctness: the command is gone, or the
    // document is no longer the one the coordinate was prepared against.
    const blockers = [];
    if (!commandActive) blockers.push('bridge_command_cancelled_or_disconnected');
    if (currentTab.url !== tab.url || currentTab.pendingUrl) blockers.push('navigation_in_progress_or_url_changed');
    if (pageState.url !== tab.url) blockers.push('document_url_changed');
    // Foreground state does not change which DOM element sits at these
    // coordinates: CDP dispatches into the target, so a backgrounded tab still
    // resolves the same hit test. Report it, do not gate on it, unless the caller
    // explicitly asked for foreground evidence.
    const advisories = [];
    if (!currentTab.active) advisories.push('tab_inactive');
    if (!windowFocused) advisories.push('window_not_focused');
    if (pageState.visibilityState !== 'visible') advisories.push('document_hidden');
    if (!pageState.focused) advisories.push('document_unfocused');
    if (requireForeground) blockers.push(...advisories);
    if (blockers.length) {
      if (invalidateCoordinate) await page('browser_validate_coordinate', { ...routedArgs, consume: true }).catch(() => {});
      return { ready: false, result: { status: 'waiting', retryable: true,
      reason: blockers.includes('bridge_command_cancelled_or_disconnected') ? 'bridge_command_cancelled_or_disconnected' : blockers.some(item => item.includes('changed') || item.includes('navigation')) ? 'page_state_changed' : 'page_not_foreground',
      dispatched: false, foreground, blockers, advisories, nextPollTool: 'browser_health',
      recommendedNextAction: afterMove ? 'The pointer moved to the preflight location, but no mouse press was dispatched. Recheck browser_health and prepare a fresh coordinate; a backgrounded tab alone is not a blocker unless requireForeground was set.' : 'Recheck browser_health and prepare a fresh coordinate. A backgrounded tab alone is not a blocker unless requireForeground was set. No pointer event dispatched.' } };
    }
    if (!commandActive) return { ready: false, result: { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, foreground, blockers, advisories, nextPollTool: 'browser_health', recommendedNextAction: 'The Bridge command is no longer active. Reconnect, re-observe, and prepare a new coordinate; no pointer event was dispatched.' } };
    return { ready: true, foreground: { ...foreground, advisories } };
  }
  if (name === 'browser_read' && args.frame === 'all') {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: pageOperation, args: [name, args, config.allowedOrigins, config.allSites] });
    const decorate = (value, frameId) => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(item => decorate(item, frameId));
      const copy = {};
      for (const [key, item] of Object.entries(value)) copy[key] = key === 'ref' && typeof item === 'string' ? `${item}@frame${frameId}` : decorate(item, frameId);
      return copy;
    };
    return { status: 'ok', frameResults: results.map(item => ({ frameId: item.frameId, result: decorate(item.result || { error: item.error || 'frame unavailable' }, item.frameId) })), frameCount: results.length, scope: 'all accessible frames', contentTrust: 'untrusted webpage data' };
  }
  if (name === 'browser_find_text') {
    const allFrames = args.frame === 'all';
    const results = await chrome.scripting.executeScript({ target: allFrames ? { tabId: tab.id, allFrames: true } : { tabId: tab.id }, func: pageOperation, args: [name, args, config.allowedOrigins, config.allSites] });
    const frameResults = results.map(item => {
      const result = item.result || { __aibError: item.error?.message || 'frame unavailable' };
      if (result.__aibError) return { frameId: item.frameId, error: result.__aibError };
      return { frameId: item.frameId, title: result.title, url: result.url, found: result.found, matchCount: result.matchCount, truncated: result.truncated, diagnostics: result.diagnostics };
    });
    const available = results.filter(item => item.result && !item.result.__aibError);
    const maxMatches = args.maxMatches ?? 10;
    const allMatches = available.flatMap(item => (item.result.matches || []).map(match => ({ ...match, frameId: item.frameId })));
    const allNearbyElements = available.flatMap(item => (item.result.nearbyElements || []).map(element => ({ ...element, frameId: item.frameId })));
    const matches = allMatches.slice(0, maxMatches);
    const nearbyElements = allNearbyElements.slice(0, 20);
    const frameErrorCount = frameResults.length - available.length;
    const partial = frameErrorCount > 0 || available.length === 0;
    const maxReached = allMatches.length > matches.length || available.some(item => item.result.truncated) || partial;
    const main = available.find(item => item.frameId === 0)?.result;
    const diagnostics = {
      mode: args.mode === 'cheap' ? 'cheap' : 'normal',
      frameResultCount: results.length,
      successfulFrameCount: available.length,
      frameErrorCount,
      omittedFrameCoverageKnown: false,
      textNodesVisited: available.reduce((sum, item) => sum + (item.result.diagnostics?.textNodesVisited || 0), 0),
      textBudgetHit: available.some(item => item.result.diagnostics?.textBudgetHit),
      textLengthBudgetHit: available.some(item => item.result.diagnostics?.textLengthBudgetHit),
      maxMatches,
      aggregateMatchLimitHit: allMatches.length > matches.length
    };
    return {
      title: main?.title || available[0]?.result?.title || '',
      url: main?.url || available[0]?.result?.url || tab.url,
      query: args.query,
      found: matches.length > 0,
      matchCount: matches.length,
      partial,
      truncated: maxReached,
      matches,
      nearbyElements,
      diagnostics,
      frameResults,
      scope: allFrames ? 'allFrames injection results returned by Chrome; hidden text excluded' : 'main frame; hidden text excluded',
      contentTrust: 'untrusted webpage data'
    };
  }
  async function guarded(sendOperation) {
    return withDebugger(tab.id, async send => {
      const current = await chrome.tabs.get(tab.id);
      if (current.url !== tab.url || current.pendingUrl) throw new Error('Page changed before input. Read again.');
      if (!(await commandStillActive())) throw new Error('Bridge command cancelled or disconnected before input.');
      const guardedSend = async (method, params = {}) => {
        const cleanupEvent = (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') ||
          (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp');
        if (!cleanupEvent && !(await commandStillActive())) throw new Error('Bridge command cancelled or disconnected before input.');
        const result = await send(method, params);
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pointerPressesAttempted++;
        return result;
      };
      return sendOperation(guardedSend);
    });
  }
  if (name === 'browser_history') {
    if (!(await commandStillActive())) return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
    if (args.action === 'back') await chrome.tabs.goBack(tab.id);
    if (args.action === 'forward') await chrome.tabs.goForward(tab.id);
    if (args.action === 'reload') await chrome.tabs.reload(tab.id);
    if (args.action === 'activate') await chrome.tabs.update(tab.id, { active: true });
    return { dispatched: args.action };
  }
  if (name === 'browser_key' || name === 'browser_hover') {
    const point = routedArgs.ref ? await page('browser_resolve', { ...routedArgs, focus: name === 'browser_key' }) : null;
    await guarded(send => name === 'browser_key' ? key(send, args.key) : pointer(send, { ...point, action: 'hover' }));
    return { dispatched: true, inspectOutcome: true };
  }
  if (name === 'browser_prepare_coordinate') {
    const state = await pointerForeground({ requireForeground: args.requireForeground === true });
    if (!state.ready) return state.result;
    const prepared = await page(name);
    return prepared.coordinateToken ? { ...prepared, foreground: state.foreground } : prepared;
  }
  if (name === 'browser_action') {
    if (args.expectedUrl !== tab.url) throw new Error('Observation URL is stale. Read page again.');
    const viewport = await page('browser_viewport');
    if (viewport.url !== args.expectedUrl) throw new Error('Observation URL changed');
    if (!viewport.layoutReady || viewport.width < 2 || viewport.height < 2) {
      return { status: 'waiting', retryable: true, reason: 'viewport_unavailable', nextPollTool: 'browser_wait_until_ready', recommendedNextAction: 'Wait for SPA layout, then observe again. No coordinate action was dispatched.' };
    }
    if (args.action === 'Wait') { await new Promise(resolve => setTimeout(resolve, args.durationMs)); return { waited: args.durationMs }; }
    if (args.action === 'Back') {
      if (!(await commandStillActive())) return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
      await chrome.tabs.goBack(tab.id); return { dispatched: 'back' };
    }
    const pointerActions = new Set(['Tap', 'Double Tap', 'Long Press', 'Hover', 'Swipe']);
    if (pointerActions.has(args.action)) {
      const state = await pointerForeground({ invalidateCoordinate: true, requireForeground: args.requireForeground === true });
      if (!state.ready) return state.result;
    }
    let coordinateResult;
    await guarded(async send => {
      if (args.action === 'Type') {
        if (!viewport.editable) throw new Error('Focus an editable non-password field before Type');
        await key(send, 'Ctrl+A'); await send('Input.insertText', { text: args.text }); return;
      }
      if (args.action === 'Key') { await key(send, args.key); return; }
      coordinateResult = await page('browser_validate_coordinate', { ...args, consume: false });
      if (coordinateResult.status !== 'ready') return;
      const point = { x: coordinateResult.x, y: coordinateResult.y, endX: Math.min(coordinateResult.width - 1, args.endX / 1000 * coordinateResult.width), endY: Math.min(coordinateResult.height - 1, args.endY / 1000 * coordinateResult.height) };
      try {
        const pointerCompleted = await pointer(send, { ...point, action: { Tap: 'click', 'Double Tap': 'double', 'Long Press': 'long', Hover: 'hover', Swipe: 'drag' }[args.action],
          beforeMove: async () => {
            const state = await pointerForeground({ invalidateCoordinate: true, requireForeground: args.requireForeground === true });
            if (!state.ready) { coordinateResult = state.result; return false; }
            coordinateResult = await page('browser_validate_coordinate', { ...args, consume: false });
            return coordinateResult.status === 'ready';
          },
          beforePress: async () => {
            const state = await pointerForeground({ afterMove: true, invalidateCoordinate: true, requireForeground: args.requireForeground === true });
            if (!state.ready) { coordinateResult = state.result; return false; }
            coordinateResult = await page('browser_validate_coordinate', { ...args, consume: false });
            if (coordinateResult.status !== 'ready') return false;
            if (!(await commandStillActive())) {
              coordinateResult = { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health', recommendedNextAction: 'The Bridge command was paused or disconnected; this press was cancelled. Reconnect, re-observe, and prepare a new coordinate.' };
              return false;
            }
            return true;
          } });
        if (!pointerCompleted && pointerPressesAttempted > 0) {
          coordinateResult = { status: 'uncertain', retryable: false, reason: 'pointer_action_partially_dispatched',
            dispatched: true, pointerPressesDispatched: pointerPressesAttempted,
            recommendedNextAction: 'The pointer action was only partially dispatched. Inspect the page and verify the outcome before any new action; do not replay automatically.' };
        }
      } finally {
        await page('browser_validate_coordinate', { ...args, consume: true }).catch(() => {});
      }
    });
    if (coordinateResult && coordinateResult.status !== 'ready') return coordinateResult;
    return { dispatched: args.action, inspectOutcome: true };
  }
  if (name === 'browser_navigate') {
    if (!(await commandStillActive())) return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
    await chrome.tabs.update(tab.id, { url: checkedUrl(args.url, config) });
    return { navigating: true };
  }
  if (name === 'browser_close') {
    if (!(await commandStillActive())) return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
    // A tab the bridge did not open belongs to the user's session. Closing it
    // can destroy unsaved work or a logged-in flow, so it needs an explicit
    // override rather than being a side effect of a generic "close" call.
    if (args.force !== true && !(await tabOwnership.owns(tab.id))) {
      return { status: 'denied', closed: false, dispatched: false, retryable: false,
        reason: 'tab_not_created_by_bridge', tabId: tab.id, url: tab.url,
        nextPollTool: 'browser_tabs',
        recommendedNextAction: 'This tab existed before the bridge opened it. Closing it would remove something the user was using. Close it yourself, or pass force:true after explicit approval for this exact tab. Nothing was closed.' };
    }
    await chrome.tabs.remove(tab.id);
    await tabOwnership.forget(tab.id);
    return { closed: true };
  }
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
    if (!(await commandStillActive())) return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
    const prepared = name === 'browser_upload_verified' ? { ...args, verifyKind: 'upload' } : args;
    return await page(name, { ...prepared, ...routedArgs, ref: routedArgs.ref });
  }
  if (!['browser_read', 'browser_shadow_tree', 'browser_find_text', 'browser_find_element', 'browser_prepare_action', 'browser_debug', 'browser_scan_overlays', 'browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_scroll_element', 'browser_dismiss_overlay', 'browser_wait', 'browser_select', 'browser_choose', 'browser_pick'].includes(name)) throw new Error('Unknown command');
  const pageWriteTools = new Set(['browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_scroll_element', 'browser_dismiss_overlay', 'browser_select', 'browser_choose', 'browser_pick']);
  if (pageWriteTools.has(name) && !(await commandStillActive())) return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
  const target = Number.isInteger(routedArgs.frame) ? { tabId: tab.id, frameIds: [routedArgs.frame] } : { tabId: tab.id };
  const [result] = await chrome.scripting.executeScript({ target, func: pageOperation, args: [name, routedArgs, config.allowedOrigins, config.allSites] });
  if (result?.error) throw new Error(result.error.message || 'Page operation failed');
  if (result?.result?.__aibError) throw new Error(result.result.__aibError);
  if (result?.result === undefined) throw new Error('No page result. Page may have navigated; inspect before retrying.');
  return result.result;
}
async function connect({ automatic = false } = {}) {
  if (connectInFlight) return;
  if (automatic && socket?.readyState === WebSocket.OPEN) return;
  connectInFlight = true;
  clearReconnect();
  disconnect('连接中');
  const epoch = connectionEpoch;
  const config = await settings();
  if (epoch !== connectionEpoch) { connectInFlight = false; return; }
  if (!config.enabled) { connectionState = '已暂停'; notifyStatus(); connectInFlight = false; return; }
  if (!/^[a-f0-9]{64}$/.test(config.token) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) { connectionState = '请先配对'; notifyStatus(); connectInFlight = false; return; }
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`);
  socket = ws;
  connectInFlight = false;
  connectDeadline = setTimeout(() => { if (socket === ws) disconnect('连接超时，后台自动重连中', { automaticReconnect: true }); }, 10000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: config.token, version: chrome.runtime.getManifest().version }));
  ws.onmessage = async event => {
    if (ws !== socket) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'extension-error-ack') { await errorJournal.acknowledge(message.eventId); return; }
      if (message.type === 'ui-result') {
        const pending = uiRequests.get(message.id);
        if (pending) { clearTimeout(pending.timer); uiRequests.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
        return;
      }
      if (message.type === 'task-state') { chrome.runtime.sendMessage(message).catch(() => {}); return; }
      if (message.type === 'ready') {
        clearTimeout(connectDeadline); connectDeadline = null;
        reconnectAttempt = 0;
        connectionState = '已连接';
        void errorJournal.flush().catch(() => {});
        notifyStatus();
        // Transport keepalive only: no model, no task polling, no cloud requests.
        keepalive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'keepalive' })); void errorJournal.flush().catch(() => {}); } }, 20000);
      } else if (message.type === 'command') {
        lastAction = `${new Date().toLocaleTimeString()} · ${message.name}`;
        notifyStatus();
        try {
          const result = await execute(message.name, message.args, { socket: ws, epoch: connectionEpoch });
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
        } catch (e) {
          if (e.code === 'DEBUGGER_BUSY_BEFORE_DISPATCH') {
            const result = {
              status: 'waiting', reason: 'debugger_busy', dispatched: false,
              retryable: message.name === 'browser_screenshot', suggestedDelayMs: 1000,
              requiresObservation: message.name !== 'browser_screenshot',
              recommendedNextAction: 'Keep the task pending. Do not detach another debugger. Retry screenshots after a delay; for input, re-observe the target before issuing a fresh action.'
            };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
            return;
          }
          reportExtensionError(`command:${message.name}`, e, 'COMMAND_ERROR');
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, error: e.message }));
        }
      }
  } catch (error) { reportExtensionError('websocket-message', error, 'PROTOCOL_ERROR'); disconnect('协议错误，后台自动重连中', { automaticReconnect: true }); }
  };
  ws.onerror = error => { reportExtensionError('websocket', error, 'WEBSOCKET_ERROR'); if (socket === ws) { connectionState = '本机服务不可用'; notifyStatus(); } };
  ws.onclose = event => {
    if (socket !== ws) return;
    // The service used to close every rejection with the same 4001, so a stale
    // pairing key and a second Chrome profile both looked like "reconnecting".
    if (event.code === 4002) { disconnect('配对密钥不匹配，请重新运行 pair.ps1'); return; }
    if (event.code === 4003) { disconnect('另一个 Chrome 配置已占用此服务，请先断开它', { automaticReconnect: true, reconnectDelayMs: 30000 }); return; }
    disconnect('连接已断开，后台自动重连中', { automaticReconnect: true });
  };
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === reconnectAlarm) connect({ automatic: true });
});
// A tab closed by the user (not through the bridge) can never be written again.
// Tell the service so it drops the lease immediately instead of holding it until
// the TTL expires and blocking the next agent.
chrome.tabs.onRemoved.addListener(tabId => {
  // The tab is gone, so its ownership record is dead weight that would otherwise
  // accumulate for the whole browser session.
  tabOwnership.forget(tabId).catch(() => {});
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tab-removed', tabId }));
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own extension UI may configure or reconnect. No content-script API.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  (async () => {
    if (message.type === 'status') return { connectionState, lastAction, ...(await settings()), token: undefined };
    if (message.type === 'connect') { await chrome.storage.local.set({ enabled: true }); await connect(); return { ok: true }; }
    if (message.type === 'pause') {
      // Tell the service it is a deliberate pause. Without this every later call
      // reports extension_disconnected and the user restarts everything instead
      // of just clicking Reconnect.
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pause' }));
      await chrome.storage.local.set({ enabled: false }); disconnect(); return { ok: true };
    }
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
globalThis.addEventListener?.('error', event => reportExtensionError('worker', event.error || event.message, 'UNCAUGHT_ERROR'));
globalThis.addEventListener?.('unhandledrejection', event => reportExtensionError('worker', event.reason, 'UNHANDLED_REJECTION'));
// With a saved pairing key, the extension reconnects in the background.
connect();

