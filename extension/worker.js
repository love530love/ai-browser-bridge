import { pageOperation } from './page.js';
import { withDebugger, pointer, key } from './cdp.js';
import { createErrorJournal } from './error-journal.js';
import { evaluatedValue, resourceSummary } from './cdp-results.js';
import { captureDevtools, createTabSubscription } from './cdp-capture.js';
import { readStorage, writeStorage } from './cdp-storage.js';
import { replayRequest } from './cdp-replay.js';
import { createSessionManager } from './cdp-session.js';
import { createCdpAdvanced } from './cdp-advanced.js';
import { createClipboard } from './clipboard.js';
import { createNavigationAudit } from './navigation-audit.js';
import { createNativeMessaging } from './native-messaging.js';
import { createIdentity } from './identity.js';
import { runAuthorityTool } from './browser-authority.js';
import { reuseKey, samePage, visibleTab, isInternalPage, describeTab, createTabOwnership } from './tab-identity.js';
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
// The bridge used to drive a browser whose version it could not name, which is
// how an update becomes a mystery instead of a diff. No chrome.* API reports the
// browser version, and the reduced user agent reports 154.0.0.0 for every patch
// of that major, so the only source is the user-agent client hints, read here in
// the worker where the promise can actually be awaited. Cached for the worker
// lifetime on purpose: the value cannot change without the browser restarting,
// and that restart recreates this worker.
let browserIdentityCache = null;
async function browserIdentity() {
  if (browserIdentityCache) return browserIdentityCache;
  const data = typeof navigator !== 'undefined' ? navigator.userAgentData : null;
  if (!data) return (browserIdentityCache = { version: null, major: null, brands: null, source: 'unavailable' });
  let full = null;
  try { full = await data.getHighEntropyValues(['uaFullVersion', 'fullVersionList']); } catch { /* reduced hints only */ }
  const brands = full?.fullVersionList ?? data.brands ?? null;
  const product = (brands ?? []).find(item => /Google Chrome/i.test(item.brand)) ?? (brands ?? []).find(item => /Chromium/i.test(item.brand));
  const version = full?.uaFullVersion ?? product?.version ?? null;
  browserIdentityCache = {
    version: version && /^\d+(\.\d+){1,3}$/.test(version) ? version : null,
    major: version ? Number.parseInt(version, 10) : null,
    brands: Array.isArray(brands) ? brands.slice(0, 8).map(item => ({ brand: String(item.brand).slice(0, 40), version: String(item.version).slice(0, 20) })) : null,
    source: full ? 'user_agent_client_hints' : 'reduced_user_agent'
  };
  return browserIdentityCache;
}
// One long-lived debugger session per tab, which is what breakpoints need. Every
// path out of the manager resumes a paused target before detaching: a paused tab
// nobody owns is a frozen tab the user has to reload by hand.
const debuggerSessions = createSessionManager({
  attach: async tabId => { await chrome.debugger.attach({ tabId }, '1.3'); },
  detach: async tabId => { await chrome.debugger.detach({ tabId }); },
  send: async (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params)
});
const cdpAdvanced = createCdpAdvanced({ sessions: debuggerSessions });
// These four are not page tools, so they answer before the tab gate and are not
// blocked by a paused renderer. The navigation audit installs its listeners here,
// at worker top level, because chrome.webNavigation only delivers events to
// listeners that were registered while the worker was being evaluated: a
// listener added later misses every navigation that happened in between.
const clipboardTools = createClipboard({
  sessions: debuggerSessions,
  // The clipboard's native route reuses the native messaging transport for one
  // fixed PowerShell command. It goes through invoke() rather than the generic
  // send tool because the clipboard tools carry their own confirmation strings,
  // and a generic gate cannot classify a message it does not understand.
  native: (message, timeoutMs) => nativeMessagingTools.invoke('com.aibridge.host', message, timeoutMs)
});
const navigationAudit = createNavigationAudit();
const navigationAuditInstall = navigationAudit.install();
const nativeMessagingTools = createNativeMessaging();
const identityTools = createIdentity({ manifest: chrome.runtime.getManifest() });
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (Number.isInteger(source?.tabId)) debuggerSessions.handleEvent(source.tabId, method, params);
});
chrome.debugger.onDetach.addListener(source => {
  if (Number.isInteger(source?.tabId)) debuggerSessions.handleDetach(source.tabId, source.reason);
});
// Screenshot, capture and metrics used to attach their own debugger and fail if
// one was already attached. Reusing the open session keeps both paths working.
async function withTabDebugger(tab, fn) {
  const reuse = debuggerSessions.activeSend(tab.id);
  if (reuse) return await fn(reuse);
  return await withDebugger(tab.id, fn);
}
// A hidden tab produces no animation frames, and a persistent debugger
// attachment does not change that. Page.captureScreenshot then waits for a frame
// that never arrives: measured 20.0s - Chrome's own limit - on the first capture
// after opening a session on an otherwise idle hidden tab, and a
// requestAnimationFrame-based wait never resolves at all. Marking the page active
// does not help, and Page.bringToFront does help but steals the tab, which this
// bridge refuses to do by default.
//
// Page.startScreencast makes Chrome produce frames for a hidden target, so a
// bounded wait for the first screencast frame warms the surface; capture is then
// a steady 143-181ms. Callers stop the screencast immediately afterwards.
async function warmFrames(tab, send, budgetMs = 1500) {
  const started = Date.now();
  let frames = 0;
  const listener = source => { if (source?.tabId === tab.id) frames++; };
  chrome.debugger.onEvent.addListener(listener);
  try {
    await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    while (!frames && Date.now() - started < budgetMs) await sleep(25);
  } catch {
    // Capture below reports its own failure; a failed warm-up is not fatal.
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }
  return { frames, warmed: frames > 0, warmupMs: Date.now() - started, budgetMs };
}
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
// Injecting into every frame fails as a whole when the tab cannot be scripted at
// all: chrome://, the Web Store, an extensions page, a PDF viewer. Chrome answers
// with the opaque "An unknown error occurred when fetching the script.", which
// surfaced in the Errors panel as an unhandled API failure and told the caller
// nothing at all. Naming the reason is the difference between "this page has no
// script access" and "the bridge is broken".
async function injectAllFrames(tabId, func, args) {
  try {
    return { frames: await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args }), blocked: null };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    const noScript = /cannot be scripted|chrome:\/\/|web ?store|extensions gallery|chrome-extension:\/\/|viewer|about:blank/i.test(message);
    return { frames: null, blocked: {
      status: 'blocked', retryable: false, dispatched: false,
      reason: noScript ? 'page_not_scriptable' : 'frames_not_injectable',
      message,
      recommendedNextAction: noScript
        ? 'This tab has no scriptable document, so no frame can be read by injection. Use browser_screenshot or the desktop tools for this surface, or navigate to a normal http(s) page.'
        : 'Chrome refused injection into at least one frame. Read the main frame only (browser_read without frame:"all") and call browser_frames to see which frames are reachable.'
    } };
  }
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
        { name: 'cdp-debug-session', tools: ['browser_debugger'], useFor: 'long-lived debugger session for breakpoints, stepping, call-frame inspection and evaluation; leaves a debugging banner on the tab until closed', retrySafe: false },
        { name: 'coordinate-adapter', tools: ['browser_action'], useFor: 'Open-AutoGLM style normalized coordinates as last resort with stale-URL guard', retrySafe: false }
      ],
      fallbackOrder: ['health', 'observe', 'cdp-capture', 'cdp-debug-session', 'dom-transaction', 'picker-upload-bridge', 'cdp-input', 'coordinate-adapter', 'human-confirmation'],
      concurrency: { writeLeaseTools: ['browser_claim_tab', 'browser_release_tab', 'browser_tab_lease'], rule: 'one write owner per tab; read-only tools may still observe; conflicting writes return status=waiting instead of throwing' },
      retryPolicy: 'Never replay uncertain writes automatically. Use browser_failure_help, then re-observe and choose the next safer mode.'
    };
  }
  if (name === 'browser_frames') {
    const tab = await chrome.tabs.get(args.tabId);
    const config = await settings();
    const paused = pausedGuard(tab.id);
    if (paused) return paused;
    const { frames, blocked } = await injectAllFrames(tab.id, () => ({ url: location.href, origin: location.origin, name: name || '', readyState: document.readyState }));
    if (blocked) return { tabId: tab.id, ...blocked, frames: [], contentTrust: 'untrusted webpage metadata' };
    return { tabId: tab.id, frames: frames.map(item => ({ frameId: item.frameId, ...(item.result || {}), accessible: !item.error })), contentTrust: 'untrusted webpage metadata' };
  }
  const frameRef = typeof args?.ref === 'string' ? args.ref.match(/^(.*)@frame(\d+)$/) : null;
  const routedArgs = frameRef ? { ...args, ref: frameRef[1], frame: Number(frameRef[2]) } : args;
  if (name === 'browser_performance') {
    const tab = await chrome.tabs.get(args.tabId);
    checkedUrl(tab.url, config);
    // Runtime.evaluate on a paused renderer never answers: the execution context
    // is frozen by definition. Refuse instead of waiting for the read timeout.
    const paused = pausedGuard(tab.id);
    if (paused) return paused;
    return withTabDebugger(tab, async send => {
      // Performance.getMetrics returns an empty array unless the domain was
      // enabled first, which reads as "no metrics" rather than "not enabled".
      const enabled = await send('Performance.enable').then(() => true).catch(() => false);
      const [metrics, layout, timing] = await Promise.all([
        send('Performance.getMetrics').catch(error => ({ error: error.message })),
        send('Page.getLayoutMetrics').catch(error => ({ error: error.message })),
        send('Runtime.evaluate', { expression: `(() => { const n = performance.getEntriesByType('navigation')[0]; const resources = performance.getEntriesByType('resource'); const longTasks = performance.getEntriesByType('longtask'); return { readyState: document.readyState, visibilityState: document.visibilityState, url: location.href, navigation: n ? { type: n.type, startTime: n.startTime, domInteractive: n.domInteractive, domContentLoaded: n.domContentLoadedEventEnd, loadEventEnd: n.loadEventEnd, responseEnd: n.responseEnd } : null, resources: resources.length, resourceTransferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0), longTasks: longTasks.length, longestTaskMs: longTasks.reduce((max, item) => Math.max(max, item.duration || 0), 0) }; })()`, returnByValue: true }).catch(error => ({ error: error.message }))
      ]);
      return { tabId: tab.id, metrics: metrics.metrics || metrics, metricsDomainEnabled: enabled,
        layout, timing: timing.error ? timing : evaluatedValue(timing), contentTrust: 'untrusted webpage diagnostics' };
    });
  }
  if (name === 'browser_network_summary') {
    const tab = await chrome.tabs.get(args.tabId);
    checkedUrl(tab.url, config);
    const paused = pausedGuard(tab.id);
    if (paused) return paused;
    return withTabDebugger(tab, async send => {
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
    // The capture window itself is bounded, but enabling and draining a domain
    // against a frozen renderer is not: the useful paused-state reading is
    // browser_debugger action:"evaluate" on the paused frame, which is exact.
    const paused = pausedGuard(tab.id);
    if (paused) return paused;
    return await withTabDebugger(tab, async send => captureDevtools({
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
  // Storage is read and written against the origin the tab is actually on, never
  // an origin the caller names: the extension permission covers the tab, and
  // letting a caller pick an origin would turn a page diagnostic into a
  // cross-site read of a site the user never granted. The tab's own origin is
  // the whole authorisation.
  if (name === 'browser_storage_read' || name === 'browser_storage_write') {
    const tab = await chrome.tabs.get(args.tabId);
    checkedUrl(tab.url, config);
    const paused = pausedGuard(tab.id);
    if (paused) return paused;
    const securityOrigin = new URL(tab.url).origin;
    const result = await withTabDebugger(tab, async send => name === 'browser_storage_read'
      ? readStorage({ send, area: args.area, securityOrigin, key: args.key, limit: args.limit })
      : writeStorage({ send, area: args.area, action: args.action, securityOrigin, key: args.key, value: args.value, cookie: args.cookie }));
    // A write can itself cause a navigation (a storage change that a page reacts
    // to). Comparing the URL is the cheapest way to say whether the answer still
    // describes the document the caller was looking at.
    const after = await chrome.tabs.get(tab.id);
    const moved = after.url !== tab.url || Boolean(after.pendingUrl);
    if (moved && result?.status === 'success') {
      return { tabId: tab.id, ...result, status: 'uncertain', reason: 'page_changed_during_storage_call',
        verified: false,
        message: 'The tab navigated during this call, so the reply may describe the previous document. Re-read before trusting it.' };
    }
    return { tabId: tab.id, ...result, ...(moved ? { pageChangedDuringCall: true } : {}) };
  }
  // Replay runs in the page, so it inherits the page's cookies and CORS position
  // instead of being a separate request the bridge invents. pageUrl is passed so
  // the module can state whether the body went to a third-party origin.
  if (name === 'browser_replay_request') {
    const tab = await chrome.tabs.get(args.tabId);
    checkedUrl(tab.url, config);
    const paused = pausedGuard(tab.id);
    if (paused) return paused;
    return { tabId: tab.id, ...await withTabDebugger(tab, async send => replayRequest({
      send, method: args.method, url: args.url, headers: args.headers, body: args.body,
      timeoutMs: args.timeoutMs, maxResponseChars: args.maxResponseChars, pageUrl: tab.url
    })) };
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
      // Which browser this worker is running in. Reported on every health call
      // rather than only at connect time, because "the version changed under me"
      // is exactly the question health is called to answer after an update.
      browser: await browserIdentity(),
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
      // browser_health is the tool an agent calls precisely when something looks
      // stuck, so it must answer on a paused tab. The probe would block forever
      // there; report the pause instead of hiding it behind a timeout.
      const paused = pauseSnapshot(tab.id);
      // Spread the pause detail first: session.paused.reason is the CDP pause
      // reason ("other", "breakpoint", ...) and must not overwrite the field the
      // caller branches on.
      if (paused) pageProbe = { ...paused, ok: false, skipped: true, reason: 'tab_paused_by_debugger', pauseReason: paused.reason };
      else if (allowed && !tab.pendingUrl) {
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
    const rows = [];
    for (const tab of await chrome.tabs.query({})) {
      if (!visibleTab(tab, { includeIncognito: args.includeIncognito === true })) continue;
      const mine = owned.has(tab.id);
      try {
        checkedUrl(tab.url, config);
        rows.push(describeTab(tab, { owned: mine }));
      } catch {
        // Listed, not hidden. An internal page or a tab on an origin this agent
        // may not read still exists, and choosing a native menu item such as New
        // tab creates exactly one of these - so hiding it left the caller unable
        // to answer "what did I just open" or to clean it up.
        rows.push(describeTab(tab, { owned: mine, allowed: false,
          restrictedReason: isInternalPage(tab.url) ? 'non_http' : 'origin_not_allowed' }));
      }
    }
    return rows;
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
  if (name === 'browser_reload_extension') {
    // chrome.runtime.reload() restarts this extension in place. No window is
    // brought forward, no tab is opened, no keystroke is synthesised, so the
    // reload has no focus dependency at all - unlike the Windows UI Automation
    // path, which has to type into a real chrome://extensions tab.
    //
    // The reply must leave before the worker is torn down, hence the delay.
    setTimeout(() => { try { chrome.runtime.reload(); } catch { /* the service reports an unverified reload */ } }, 80);
    return { status: 'success', retryable: false, reason: 'extension_reload_dispatched', dispatched: true,
      verified: false, method: 'chrome.runtime.reload',
      nextStep: 'This worker unloads and reloads, then reconnects with a new session id. The service confirms it by observing that new session and version.' };
  }
  // Browser-wide tools (sessions, bookmarks, history, downloads, extension
  // manager, cookies, site settings, windows, tab groups, page capture) are not
  // about one document, so they are answered before the tab gate below. Their
  // authority comes from the extension being connected, and every write among
  // them was already refused by the service unless the caller echoed the
  // confirmation string for that specific tool.
  // Clipboard, navigation audit, native messaging and identity are not about one
  // document either. They answer here, before the tab gate, so a tab that is
  // mid-navigation or paused cannot make them unavailable. The write paths among
  // them were already refused by the service unless the caller echoed the
  // confirmation string for that specific tool.
  for (const tools of [clipboardTools, navigationAudit, nativeMessagingTools, identityTools]) {
    const result = await tools.run(name, args);
    if (result !== null) return result;
  }
  const authorityResult = await runAuthorityTool(name, args);
  if (authorityResult !== null) return authorityResult;
  if (!Number.isInteger(args.tabId) || args.tabId < 1) throw new Error('Invalid tabId');
  const tab = await chrome.tabs.get(args.tabId);
  // Closing is about a tab's lifecycle, not its content. Requiring the origin
  // check here made every tab the bridge cannot read permanently unclosable -
  // including the ones a native menu invocation creates - and it answered with
  // a URL-policy error instead of the ownership decision that actually applies.
  // browser_close still refuses tabs the bridge did not open unless force:true.
  if (name !== 'browser_close') checkedUrl(tab.url, config);
  // A phase wait is the one command that is supposed to run while the tab is
  // between documents: it is called right after a submit, which is exactly when
  // pendingUrl is set. Refusing it here made untilPhase unreachable for every
  // full-page login - the case it exists for. Every other command still refuses,
  // because acting on a document that is about to be replaced is how a click
  // lands on the wrong element.
  const waitingForLoginPhase = name === 'browser_login_state' && typeof args.untilPhase === 'string';
  if (tab.pendingUrl && tab.pendingUrl !== tab.url && !waitingForLoginPhase) throw new Error('Navigation in progress. Wait and read again.');
  // Lease tools never reach the extension: the service owns and answers them.
  // Page operations below therefore execute unconditionally; conflicting writes
  // were already rejected by the service before this job was dispatched.
  // A paused page cannot run its own script. Without this guard every DOM call
  // would sit there until the service read timeout and come back as a vague
  // "read_timeout", which looks like a broken bridge rather than a paused tab.
  function pauseSnapshot(tabId) {
    const session = debuggerSessions.get(tabId);
    return session?.paused ? {
      reason: session.paused.reason,
      hitBreakpoints: session.paused.hitBreakpoints,
      pausedAt: session.paused.at,
      frameCount: session.paused.callFrames.length,
      autoResumeInMs: Math.max(0, debuggerSessions.describe(session).paused?.autoResumeInMs ?? 0)
    } : null;
  }
  function pausedGuard(tabId = tab.id) {
    const snapshot = pauseSnapshot(tabId);
    if (!snapshot) return null;
    return {
      status: 'waiting', retryable: true, reason: 'tab_paused_by_debugger', dispatched: false,
      pausedAt: snapshot.pausedAt, pauseReason: snapshot.reason,
      hitBreakpoints: snapshot.hitBreakpoints,
      autoResumeInMs: snapshot.autoResumeInMs,
      nextPollTool: 'browser_debugger', nextPollArgs: { tabId, action: 'status' },
      recommendedNextAction: 'This tab is paused by an open debugger session, so page script and input cannot run. Inspect it with browser_debugger action:"frames", then resume or close the session and repeat this call.'
    };
  }
  // Tools that never touch page script or renderer input, so a paused tab cannot
  // stall them. Everything else is refused up front instead of hanging until the
  // service read timeout and coming back as a vague "read_timeout".
  const pauseImmune = new Set([
    'browser_debugger', 'browser_health', 'browser_tabs', 'browser_open', 'browser_close',
    'browser_failure_help', 'browser_reload_extension'
  ]);
  // One gate for the whole page domain, instead of a check inside each tool.
  // A paused renderer accepts a CDP call and then simply never answers, so the
  // failure mode is a silent stall, not an error. Refusing up front with a
  // structured waiting result is the only shape the caller can act on.
  if (!pauseImmune.has(name)) {
    const paused = pausedGuard();
    if (paused) return paused;
  }
  async function page(name, input = routedArgs) {
    const paused = pausedGuard();
    if (paused) return paused;
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
    const injection = await injectAllFrames(tab.id, pageOperation, [name, args, config.allowedOrigins, config.allSites]);
    if (injection.blocked) return { status: 'blocked', ...injection.blocked, frameResults: [], frameCount: 0, scope: 'all accessible frames', contentTrust: 'untrusted webpage data' };
    const results = injection.frames;
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
    const injection = allFrames
      ? await injectAllFrames(tab.id, pageOperation, [name, args, config.allowedOrigins, config.allSites])
      : { frames: await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageOperation, args: [name, args, config.allowedOrigins, config.allSites] }), blocked: null };
    if (injection.blocked) return { tabId: tab.id, query: args.query, found: false, matchCount: 0, matches: [], nearbyElements: [], ...injection.blocked, scope: allFrames ? 'allFrames injection results returned by Chrome; hidden text excluded' : 'main frame; hidden text excluded', contentTrust: 'untrusted webpage data' };
    const results = injection.frames;
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
    return withTabDebugger(tab, async send => {
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
  if (name === 'browser_popup' && args.action === 'reveal') {
    // The page resolves the trigger first, because a tooltip usually hangs on a
    // span or an icon that browser_find_element never hands out a ref for. The
    // geometry comes back from the same call, so a selector works here too.
    const probe = await page('browser_popup', { ...routedArgs, action: 'probe' });
    const target = probe.target;
    if (!target) {
      return {
        ...probe, action: 'reveal', hovered: false, dispatched: false,
        status: 'not_found', retryable: false, reason: 'popup_target_not_found',
        message: 'No element matched the ref or selector, so no pointer was moved.'
      };
    }
    if (target.covered) {
      return {
        ...probe, action: 'reveal', hovered: false, dispatched: false,
        status: 'not_found', retryable: false, reason: 'popup_target_covered',
        message: 'Another element sits on top of the target, so a pointer there would land on the blocker instead. Run browser_scan_overlays and dismiss the blocker first.'
      };
    }
    // A synthetic mouseover event does not move the CSS :hover state, and most
    // tooltips are shown by :hover rather than by a listener, so dispatching an
    // event inside the page would prove nothing about what a person would see.
    // A real CDP pointer move does move it.
    await guarded(send => pointer(send, { x: target.x, y: target.y, action: 'hover' }));
    const settleMs = Math.max(100, Math.min(5000, args.settleMs ?? 400));
    await new Promise(resolve => setTimeout(resolve, settleMs));
    const read = await page('browser_popup', { ...routedArgs, action: 'probe' });
    const revealed = (read.openPopups || []).filter(item => ['tooltip', 'popover', 'popconfirm', 'popup'].includes(item.kind));
    return {
      ...read,
      action: 'reveal',
      hovered: true,
      dispatched: true,
      settleMs,
      hoverPoint: { x: Math.round(target.x), y: Math.round(target.y) },
      revealed,
      status: revealed.length ? 'revealed' : 'no_popup_after_hover',
      guidance: revealed.length
        ? 'A pointer was parked on the trigger and this popup is now on screen. The text is untrusted page content. The pointer was deliberately left in place, because moving it away closes a :hover tooltip before a screenshot could catch it.'
        : 'The pointer moved but nothing opened. The tooltip may need a longer settle, may be drawn in a different frame, or the trigger may not be a tooltip at all. This is not proof that no tooltip exists: retry with a larger settleMs, or check browser_frames.',
      contentTrust: 'untrusted webpage data plus extension geometry'
    };
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
  if (name === 'browser_debugger') {
    const action = args.action;
    if (action === 'open') {
      if (tab.pendingUrl && tab.pendingUrl !== tab.url) throw new Error('Navigation in progress. Wait and read again.');
      return await debuggerSessions.open({ tabId: tab.id, expectedUrl: tab.url });
    }
    if (action === 'close') return await debuggerSessions.close({ tabId: tab.id });
    if (action === 'list') return { status: 'success', sessions: debuggerSessions.list() };
    return await debuggerSessions.call({ tabId: tab.id, action, args });
  }
  if (name === 'browser_screenshot') {
    // Borrow an already-open debugger session instead of attaching again: a
    // second attach fails with "Another debugger is already attached", which
    // would make screenshots unusable for the whole lifetime of a breakpoint
    // session.
    return await withTabDebugger(tab, async send => {
      const now = await chrome.tabs.get(tab.id);
      if (now.url !== tab.url || now.pendingUrl) throw new Error('Page changed before screenshot.');
      const warmup = now.active ? null : await warmFrames(tab, send);
      try {
        const result = await send('Page.captureScreenshot', { format: 'png' });
        const after = await chrome.tabs.get(tab.id);
        if (after.url !== tab.url || after.pendingUrl) throw new Error('Page changed during screenshot. Discarded.');
        return { data: result.data, mimeType: 'image/png',
          // Stated, not hidden: frames were forced for this capture.
          sideEffects: warmup ? ['hidden_tab_frames_forced_for_capture'] : [],
          warmup: warmup ?? undefined };
      } finally {
        if (warmup) await send('Page.stopScreencast').catch(() => {});
      }
    });
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
    // A verified write whose expectation lives in the document that the write
    // itself replaces cannot report success: the code that would evaluate the
    // expectation died with the old document. Only a click can do this (fill and
    // upload never navigate), so only a click pays for the extra read.
    //
    // The url survives the document, so it is read from chrome.tabs rather than
    // from the page. Without this, a submit that navigates comes back as
    // "uncertain" — and "uncertain" is the word that teaches a caller to click
    // the submit button a second time. A changed url is the evidence that the
    // click was dispatched; whether it reached the right page is a separate
    // question, so the result still says the expectation was never evaluated.
    const urlBefore = name === 'browser_click_verified'
      ? (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? null
      : null;
    const asNavigated = async outcome => {
      if (urlBefore === null || outcome?.status === 'success') return outcome;
      const urlAfter = (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? null;
      if (!urlAfter || urlAfter === urlBefore) return outcome;
      return { ...(outcome ?? {}), status: 'navigated', dispatched: outcome?.dispatched ?? true, retryable: false,
        navigation: { from: urlBefore, to: urlAfter },
        reason: outcome?.reason ?? 'document_replaced_by_navigation',
        recommendedNextAction: 'The click navigated, which is the evidence that it was dispatched, but the document that held the expectation is gone, so the expectation was never evaluated. Confirm the outcome on the new page with browser_read or browser_login_state before doing anything else. Do not click again.' };
    };
    let outcome;
    try {
      outcome = await page(name, { ...prepared, ...routedArgs, ref: routedArgs.ref });
    } catch (error) {
      // The throw is usually the injected world disappearing under the click.
      // If the url moved, that is a dispatch, not a failure, and reporting it as
      // a failure is what causes the duplicate submit.
      const settled = await asNavigated({ status: 'uncertain', reason: 'verification_interrupted_after_dispatch', dispatched: true, retryable: false });
      if (settled?.status === 'navigated') return settled;
      throw error;
    }
    return await asNavigated(outcome);
  }
  // Ref-to-descriptor conversion for recipe saving. It answers here rather than
  // in the service because only the page knows an element's accessible name and
  // selector; the service never sees the DOM.
  if (name === 'browser_recipe_describe') return await page('browser_recipe_describe', routedArgs);
  // Deterministic replay of a recorded flow. Every step is re-resolved by
  // identity before it runs, so a weak caller never has to look at the page: it
  // supplies variables and reads the per-step report.
  if (name === 'browser_recipe_run') {
    const recipe = args.recipe && typeof args.recipe === 'object' ? args.recipe : null;
    if (!recipe || !Array.isArray(recipe.steps) || recipe.steps.length === 0) throw new Error('browser_recipe_run needs a stored recipe');
    const variables = args.variables && typeof args.variables === 'object' ? args.variables : {};
    const settleMs = Math.min(5000, Math.max(0, Number(args.settleMs) || 350));
    const stepTimeoutMs = Math.min(30000, Math.max(1000, Number(args.stepTimeoutMs) || 8000));
    const substitute = value => {
      if (typeof value === 'string') return value.replace(/\{\{\s*([A-Za-z0-9_.-]{1,40})\s*\}\}/g, (whole, key) => (Object.hasOwn(variables, key) ? String(variables[key]) : whole));
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
      return value;
    };
    // Waits on the tab's own load state, not on a page promise: after a click
    // that navigates, the injected world is gone, but chrome.tabs still knows
    // whether the new document finished loading.
    const documentReady = async () => {
      const deadline = Date.now() + stepTimeoutMs;
      for (;;) {
        const now = await chrome.tabs.get(tab.id).catch(() => null);
        if (!now) return false;
        if (now.status === 'complete' && !now.pendingUrl) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    };
    const done = [];
    for (const [index, step] of recipe.steps.entries()) {
      const at = index + 1;
      if (!(await documentReady())) {
        return { status: 'waiting', retryable: true, reason: 'recipe_step_document_not_ready', dispatched: done.some(item => item.dispatched),
          recipe: recipe.name, failedAtStep: at, stepsCompleted: done.length, steps: done,
          recommendedNextAction: 'The document did not finish loading before this step. Re-observe the tab, then run the recipe again only if the remaining steps have not already run: steps already completed are not rolled back.' };
      }
      const located = await page('browser_recipe_locate', { target: step.target, frame: routedArgs.frame });
      if (!located?.found) {
        return { status: 'failed', retryable: false, dispatched: done.some(item => item.dispatched),
          reason: located?.ambiguous ? 'recipe_step_target_ambiguous' : 'recipe_step_target_not_found',
          recipe: recipe.name, failedAtStep: at, stepsCompleted: done.length, detail: located, steps: done,
          recommendedNextAction: done.length
            ? `Steps 1..${done.length} already ran and were NOT rolled back. Re-observe the page, finish the remaining steps by hand, then record a new recipe from the current page. Do not re-run from step 1 without checking what already happened.`
            : 'Nothing ran: the first step could not be resolved. Re-observe the page and record a new recipe.' };
      }
      const stepArgs = { ...step, ref: located.target.ref };
      delete stepArgs.target;
      delete stepArgs.tool;
      const callArgs = substitute(stepArgs);
      const urlBefore = (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? null;
      let outcome = null;
      try {
        outcome = await page(step.tool, callArgs);
      } catch (error) {
        const urlAfter = (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? null;
        // A submit that navigates destroys the document the step was verifying
        // in, so the tool throws even though the click landed. A changed url is
        // the evidence that it landed: record the step as navigated and carry on
        // into the new document. Without a url change there is no evidence at
        // all, and that stays uncertain.
        if (urlAfter && urlAfter !== urlBefore) {
          done.push({ step: at, tool: step.tool, matchedBy: located.tier, degradedMatch: located.degraded === true,
            status: 'navigated', verified: null, url: urlAfter,
            note: 'The document was replaced during this step, so the step\'s own expectation could not be evaluated. The url change is the evidence it dispatched.' });
          if (at < recipe.steps.length) await new Promise(resolve => setTimeout(resolve, settleMs));
          continue;
        }
        // The step may or may not have dispatched. Report it as uncertain and
        // stop: continuing would build the next step on an unknown state.
        return { status: 'uncertain', retryable: false, reason: 'recipe_step_failed_midway', dispatched: true,
          recipe: recipe.name, failedAtStep: at, stepsCompleted: done.length, steps: done,
          message: String(error?.message ?? error).slice(0, 300),
          recommendedNextAction: 'The failing step may or may not have been dispatched, so its outcome is unknown. Re-observe the page before doing anything else, and do not re-run the recipe from the start.' };
      }
      // The url comes from the tab, not from the page: after a step that
      // navigates, the injected world is gone and `location` here is the
      // extension's own url, not the page's.
      const afterStep = await chrome.tabs.get(tab.id).catch(() => null);
      done.push({ step: at, tool: step.tool, matchedBy: located.tier, degradedMatch: located.degraded === true,
        status: outcome?.status ?? null, verified: outcome?.verified ?? null, url: afterStep?.url ?? null });
      if (outcome?.status === 'failed' || outcome?.status === 'denied') {
        return { status: 'failed', retryable: false, dispatched: true, reason: 'recipe_step_reported_failure',
          recipe: recipe.name, failedAtStep: at, stepsCompleted: done.length - 1, steps: done, stepResult: outcome,
          recommendedNextAction: 'The step ran and reported a failure, so the page state is known to be short of the expectation. Read the step result, fix the page by hand, and record a new recipe if the flow changed.' };
      }
      // An uncertain step is not a step that succeeded. Carrying on would build
      // the next step on an unknown state and still report the run as a success.
      if (outcome?.status === 'uncertain' || outcome?.status === 'waiting') {
        return { status: 'uncertain', retryable: false, reason: 'recipe_step_outcome_unknown',
          recipe: recipe.name, failedAtStep: at, stepsCompleted: done.length - 1, steps: done, stepResult: outcome,
          dispatched: true,
          recommendedNextAction: 'This step reported that its own outcome is unknown, so the run stopped rather than building on it. Re-observe the page before doing anything else; do not re-run from step 1.' };
      }
      if (at < recipe.steps.length) await new Promise(resolve => setTimeout(resolve, settleMs));
    }
    return { status: 'success', retryable: false, dispatched: true, recipe: recipe.name,
      stepsCompleted: done.length, steps: done,
      degradedMatches: done.filter(item => item.degradedMatch).map(item => item.step),
      finalUrl: (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? null,
      note: 'Every step was re-resolved by identity, not replayed by position. A step whose match was fuzzy is listed in degradedMatches; check those against the page if the flow mattered.' };
  }
  // Device emulation, native dialogs, accessibility snapshots, drag and drop,
  // print-to-PDF, init scripts and request mocking. These are dispatched here
  // rather than inside page() because several of them have to keep a long-lived
  // debugger session open - a CDP override ends when the attachment does - and
  // page() is built on the attach-per-call path.
  if (cdpAdvanced.names.has(name)) {
    if (!(await commandStillActive())) {
      return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
    }
    return await cdpAdvanced.run(name, args, { tab, page, guarded });
  }
  if (!['browser_read', 'browser_shadow_tree', 'browser_find_text', 'browser_find_element', 'browser_prepare_action', 'browser_debug', 'browser_scan_overlays', 'browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_scroll_element', 'browser_dismiss_overlay', 'browser_wait', 'browser_select', 'browser_choose', 'browser_pick', 'browser_login_state', 'browser_otp_fetch', 'browser_transient', 'browser_popup'].includes(name) && !cdpAdvanced.names.has(name)) throw new Error('Unknown command');
  const pageWriteTools = new Set(['browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_scroll_element', 'browser_dismiss_overlay', 'browser_select', 'browser_choose', 'browser_pick', 'browser_popup']);
  if (pageWriteTools.has(name) && !(await commandStillActive())) return { status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false, nextPollTool: 'browser_health' };
  // A login submit is the one moment where a single frame is not enough: the
  // server navigates or the SPA swaps views, so a read taken right after the
  // click lands in the gap and reports "unknown". The wait therefore polls from
  // here, in the service worker, and not inside the page. An in-page promise is
  // destroyed by the very navigation the caller is waiting for, so it could only
  // ever observe transitions that happen without a document change - which is
  // the case untilPhase exists to cover.
  if (name === 'browser_login_state' && typeof args.untilPhase === 'string') {
    const phases = ['credentials', 'identifier', 'otp', 'logged_in', 'unknown'];
    if (!phases.includes(args.untilPhase)) throw new Error(`untilPhase must be one of ${phases.join(', ')}`);
    const timeoutMs = Math.min(60000, Math.max(200, Number(args.timeoutMs) || 15000));
    const pollMs = Math.min(2000, Math.max(100, Number(args.pollMs) || 250));
    const startedAt = Date.now();
    const startUrl = tab.url;
    // The wait is a property of this call, not of the page read: the page op
    // must stay a single-frame description or every read would carry its own
    // nested wait.
    const readArgs = { ...routedArgs };
    delete readArgs.untilPhase; delete readArgs.timeoutMs; delete readArgs.pollMs;
    const phasesSeen = [];
    const readFailures = [];
    const deadline = startedAt + timeoutMs;
    let polls = 0;
    let originBlocked = false;
    let latest = null;
    let matched = false;
    for (;;) {
      const atMs = Date.now() - startedAt;
      polls += 1;
      let state = null;
      try {
        state = await page('browser_login_state', readArgs);
      } catch (error) {
        // A navigation tears down the isolated world mid-call. That is the
        // transition being waited for, not a failure of the wait, so it is
        // recorded and the next poll reads the new document.
        const message = String(error?.message || error);
        if (/Origin changed or not allowed/i.test(message)) { originBlocked = true; break; }
        readFailures.push({ atMs, error: message.slice(0, 200) });
      }
      if (state && typeof state.phase === 'string') {
        latest = state;
        const last = phasesSeen[phasesSeen.length - 1];
        if (!last || last.phase !== state.phase) phasesSeen.push({ phase: state.phase, atMs, url: state.url });
        if (state.phase === args.untilPhase) { matched = true; break; }
      } else if (state && state.status === 'waiting') {
        readFailures.push({ atMs, error: `page returned waiting: ${state.reason || 'no reason given'}` });
      }
      if (Date.now() >= deadline) break;
      if (!(await commandStillActive())) {
        return { ...(latest ?? {}), status: 'waiting', retryable: true, reason: 'bridge_command_cancelled_or_disconnected', dispatched: false,
          wait: { untilPhase: args.untilPhase, matched: false, timedOut: false, waitedMs: Date.now() - startedAt, phasesSeen, readFailures },
          nextPollTool: 'browser_health',
          recommendedNextAction: 'The command was cancelled or the bridge disconnected during the wait, so the final phase is unknown. Re-read with browser_login_state before acting; do not re-submit blindly.' };
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    const waitedMs = Date.now() - startedAt;
    const afterTab = await chrome.tabs.get(tab.id).catch(() => null);
    const toUrl = afterTab?.url ?? latest?.url ?? startUrl;
    if (originBlocked) {
      return { ...(latest ?? {}), status: 'blocked', reason: 'phase_wait_left_allowed_origins', dispatched: false,
        untilPhase: args.untilPhase, waitedMs, phasesSeen, readFailures,
        fromUrl: startUrl, toUrl,
        recommendedNextAction: 'The page navigated to an origin this bridge is not allowed to read, so the phase after the submit cannot be observed. Add that origin to the allowlist, or read the tab with browser_health to see where it landed. Do not treat the missing phase as a failed login.' };
    }
    if (!latest) {
      return { status: 'waiting', retryable: true, reason: 'login_phase_unreadable', dispatched: false,
        untilPhase: args.untilPhase, waitedMs, readFailures: readFailures.slice(0, 6),
        nextPollTool: 'browser_login_state',
        recommendedNextAction: 'No frame of this tab could be read during the wait, which usually means a navigation is still in flight or the document was replaced repeatedly. Read browser_health, then call browser_login_state again without untilPhase to see the current state.' };
    }
    return { ...latest,
      wait: {
        untilPhase: args.untilPhase, matched, timedOut: !matched, waitedMs, pollMs, timeoutMs,
        polls, phasesSeen, readFailures: readFailures.slice(0, 6),
        urlChanged: toUrl !== startUrl, fromUrl: startUrl, toUrl,
        note: matched
          ? 'The page reached the requested phase while this call was open. A phase is a DOM reading, not proof of authentication: read the account name or a signed-in-only view before calling the login complete.'
          : `The page did not reach phase "${args.untilPhase}" within ${waitedMs}ms. That is not proof the submit failed - a slow server, a captcha, an unmodelled second step or an error banner all look the same from here. phasesSeen is what was actually observed. Read errorText and the fields above before retrying, and never re-submit blindly: a second submit can trip a lockout or send a second code.`
      }
    };
  }
  const target = Number.isInteger(routedArgs.frame) ? { tabId: tab.id, frameIds: [routedArgs.frame] } : { tabId: tab.id };
  const [result] = await chrome.scripting.executeScript({ target, func: pageOperation, args: [name, routedArgs, config.allowedOrigins, config.allSites] });
  if (result?.error) throw new Error(result.error.message || 'Page operation failed');
  if (result?.result?.__aibError) throw new Error(result.result.__aibError);
  if (result?.result === undefined) throw new Error('No page result. Page may have navigated; inspect before retrying.');
  return result.result;
}
// A WebSocket constructor that fails writes a console error the worker cannot
// catch: every reconnect attempt against a stopped service left one more
// "ERR_CONNECTION_REFUSED" in the extension's Errors panel. Restarting the
// service a few times therefore painted a wall of red that reads as "the
// extension is broken", when the only fact was that a process was not running.
// The same question can be asked with fetch, whose failure IS catchable.
//
// Any HTTP answer counts as "listening". /status needs a bearer token and the
// server rejects a request carrying a browser Origin outright, so the expected
// reply here is 401 or 403 - a rejection still proves a socket accepted the
// connection, which is the only thing this probe claims to know.
async function serviceListening(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  // Deliberately no WebSocket is constructed when nothing is listening. The
  // state says what is actually true - the service is not up yet, and it is
  // usually up again by itself because start.ps1 is on login autostart.
  if (!(await serviceListening(config.port))) {
    if (epoch !== connectionEpoch) { connectInFlight = false; return; }
    connectionState = '本机服务未运行，等待启动';
    notifyStatus();
    connectInFlight = false;
    await scheduleReconnect();
    return;
  }
  if (epoch !== connectionEpoch) { connectInFlight = false; return; }
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`);
  socket = ws;
  connectInFlight = false;
  connectDeadline = setTimeout(() => { if (socket === ws) disconnect('连接超时，后台自动重连中', { automaticReconnect: true }); }, 10000);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', token: config.token, version: chrome.runtime.getManifest().version }));
    // Sent after hello so authentication is never delayed by a hint lookup: a
    // slow client-hints promise must not look like a wrong pairing key.
    browserIdentity()
      .then(browser => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        // The extension id travels with the hint because nothing else can supply
        // it: a native messaging host manifest has to list the exact
        // chrome-extension://<id>/ origin that is allowed to launch it, and the
        // service is the only side that can write that file. Without this the
        // installer would have to guess the id from the profile on disk.
        ws.send(JSON.stringify({ type: 'browser', browser, extensionId: chrome.runtime.id }));
      })
      .catch(() => {});
  };
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
          // A policy refusal is not a defect. The caller asked to read a tab this
          // bridge was never allowed to read - an origin the user did not
          // authorise, or an internal page that has no origin at all - and got a
          // clear, correct answer. Recording it as an extension error is how the
          // Errors panel fills with things that are working exactly as designed,
          // which is the same problem as the reconnect noise above. The service
          // still audits the call; only the extension-side error journal skips it.
          const policyRefusal = /^Site not allowed\./.test(String(e?.message ?? ''));
          if (!policyRefusal) reportExtensionError(`command:${message.name}`, e, 'COMMAND_ERROR');
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

