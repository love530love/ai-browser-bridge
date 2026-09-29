import { pageOperation } from './page.js';
import { withDebugger, pointer, key } from './cdp.js';
let socket = null;
let keepalive = null;
let connectDeadline = null;
let connectionState = '未连接';
let lastAction = '';
let connectionEpoch = 0;
const uiRequests = new Map();
const defaults = { port: 19387, token: '', allowedOrigins: [], allSites: true, enabled: false };
const settings = () => chrome.storage.local.get(defaults);
function notifyStatus() {
  chrome.runtime.sendMessage({ type: 'connection-status', connectionState, lastAction }).catch(() => {});
}
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
function disconnect(message = '已暂停') {
  connectionEpoch++;
  clearInterval(keepalive); keepalive = null;
  clearTimeout(connectDeadline); connectDeadline = null;
  const previous = socket; socket = null;
  if (previous) previous.close();
  for (const request of uiRequests.values()) { clearTimeout(request.timer); request.reject(new Error('连接已断开')); }
  uiRequests.clear();
  connectionState = message;
  notifyStatus();
  chrome.action.setBadgeText({ text: '' });
}
function checkedUrl(url, config) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (!config.allSites && !config.allowedOrigins.includes(u.origin))) throw new Error('Site not allowed. Enable all sites or add its origin in extension settings.');
  return u.href;
}
async function execute(name, args) {
  const config = await settings();
  if (!config.enabled) throw new Error('Extension paused');
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
  async function page(name, input = args) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageOperation, args: [name, input, config.allowedOrigins, config.allSites] });
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
  if (!['browser_read', 'browser_debug', 'browser_click', 'browser_fill', 'browser_upload', 'browser_scroll', 'browser_wait', 'browser_select', 'browser_choose'].includes(name)) throw new Error('Unknown command');
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageOperation, args: [name, args, config.allowedOrigins, config.allSites] });
  if (result?.error) throw new Error(result.error.message || 'Page operation failed');
  if (result?.result?.__aibError) throw new Error(result.result.__aibError);
  if (result?.result === undefined) throw new Error('No page result. Page may have navigated; inspect before retrying.');
  return result.result;
}
async function connect() {
  disconnect('连接中');
  const epoch = connectionEpoch;
  const config = await settings();
  if (epoch !== connectionEpoch) return;
  if (!config.enabled) { connectionState = '已暂停'; notifyStatus(); return; }
  if (!/^[a-f0-9]{64}$/.test(config.token) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) { connectionState = '请先配对'; notifyStatus(); return; }
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`);
  socket = ws;
  connectDeadline = setTimeout(() => { if (socket === ws) disconnect('连接超时，请检查本机服务后重新连接'); }, 10000);
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
    } catch { disconnect('协议错误，请重新连接'); }
  };
  ws.onerror = () => { if (socket === ws) { connectionState = '本机服务不可用'; notifyStatus(); } };
  ws.onclose = () => { if (socket === ws) disconnect('连接已断开，请重新连接'); };
}
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
// A restarted worker reconnects once. A failed connection requires a user click.
connect();
