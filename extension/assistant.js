const $ = id => document.getElementById(id);
let taskState = null;
const statusNames = { running: '执行中', cancelling: '正在停止', cancelled: '已停止', failed: '执行失败', reported_complete: '模型报告完成，请核对结果', step_limit: '达到步数上限，任务可能未完成', needs_user: '需要你接手' };
async function api(name, args = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'agent', name, args });
  if (response?.error) throw new Error(response.error);
  return response;
}
function render(task) {
  taskState = task;
  $('events').replaceChildren();
  $('task-status').textContent = statusNames[task?.status] || '等待任务';
  $('run').disabled = ['running', 'cancelling'].includes(task?.status);
  for (const event of task?.events || []) {
    const row = document.createElement('div'); row.className = 'event';
    row.textContent = `${event.step ? `第 ${event.step} 步 · ` : ''}${event.tool || event.type}\n${event.message || ''}`;
    $('events').append(row);
  }
}
async function tabs() {
  const items = await chrome.tabs.query({ currentWindow: true });
  const previous = $('target').value;
  $('target').replaceChildren();
  for (const tab of items.filter(t => /^https?:\/\//.test(t.url || ''))) {
    const option = document.createElement('option'); option.value = tab.id; option.textContent = tab.title || new URL(tab.url).hostname;
    option.selected = previous ? previous === String(tab.id) : tab.active;
    $('target').append(option);
  }
}
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'task-state') render(message.task);
  if (message.type === 'connection-status') $('connection').textContent = message.connectionState;
});
$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  try { render(await api('agent_start', { tabId: Number($('target').value), task: $('task').value, maxSteps: Number($('max-steps').value) })); }
  catch (e) { $('task-status').textContent = e.message; $('run').disabled = false; }
});
$('cancel').addEventListener('click', async () => { try { render(await api('agent_cancel', { id: taskState?.id })); } catch (e) { $('task-status').textContent = e.message; } });
$('refresh-tabs').addEventListener('click', () => tabs());
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
await tabs();
const status = await chrome.runtime.sendMessage({ type: 'status' }); $('connection').textContent = status.connectionState;
try { render(await api('agent_status')); } catch (e) { $('task-status').textContent = e.message; }
