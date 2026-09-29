const $ = id => document.getElementById(id);
const say = text => { $('message').textContent = text; };
function showStatus(state) {
  $('status').textContent = state.connectionState;
  $('activity').textContent = state.lastAction || '尚无操作';
}
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message.type === 'connection-status') showStatus(message);
});
function siteMode() { $('site-list').hidden = $('all-sites').checked; }
$('all-sites').addEventListener('change', siteMode);
async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'status' });
  showStatus(state);
}
async function init() {
  const state = await chrome.storage.local.get({ port: 19387, allowedOrigins: [], allSites: true, token: '' });
  $('port').value = state.port;
  $('origins').value = state.allowedOrigins.join('\n');
  $('all-sites').checked = state.allSites; siteMode();
  if (state.token) { $('token').placeholder = '已配对；留空保留现有密钥'; $('paired').textContent = '已有配对密钥。更换服务时可重新粘贴。'; }
  await refresh();
}
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const allSites = $('all-sites').checked;
    const previous = await chrome.storage.local.get({ token: '', allowedOrigins: [] });
    const origins = allSites ? previous.allowedOrigins : [...new Set($('origins').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => {
      const u = new URL(s);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('请填写源地址，例如 https://example.com，不带路径。');
      return u.origin;
    }))];
    const token = $('token').value.trim() || previous.token;
    const port = Number($('port').value);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('请粘贴 pair.ps1 复制的完整密钥。');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效');
    await chrome.storage.local.set({ token, port, allowedOrigins: origins, allSites });
    $('token').value = '';
    $('token').placeholder = '已配对；留空保留现有密钥';
    $('paired').textContent = '已有配对密钥。更换服务时可重新粘贴。';
    await chrome.runtime.sendMessage({ type: 'connect' });
    say(allSites ? '设置已保存：允许所有 HTTP / HTTPS 网站。连接状态会自动更新。' : '设置已保存：仅允许指定网站。连接状态会自动更新。'); await refresh();
  } catch (e) { say(e.message); }
});
for (const [id, type] of [['reconnect', 'connect'], ['pause', 'pause']]) $(id).addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type });
  say(type === 'pause' ? '已暂停；后续命令不会执行。' : '已发起连接。'); await refresh();
});
$('refresh').addEventListener('click', refresh);
$('assistant').addEventListener('click', () => {
  chrome.windows.getCurrent().then(window => chrome.sidePanel.open({ windowId: window.id })).catch(e => say(e.message));
});
init().catch(e => say(e.message));
