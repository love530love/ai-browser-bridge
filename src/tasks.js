import { randomUUID } from 'node:crypto';
import { loadModel, runAgent } from './agent.js';

export function createTasks({ acquire, release, callTool, notify, modelLoader = loadModel }) {
  let current = null;
  let controller = null;
  let running = false;
  const snapshot = () => current ? structuredClone(current) : null;
  function update(event) {
    current.events.push({ ...event, time: new Date().toISOString() });
    if (current.events.length > 100) current.events.shift();
    notify(snapshot());
  }
  return {
    status: snapshot,
    start(input) {
      if (running) throw new Error('A task is already running');
      if (!input || typeof input.task !== 'string' || !input.task.trim() || input.task.length > 12000 || !Number.isInteger(input.tabId) || input.tabId < 1 || !Number.isInteger(input.maxSteps ?? 12) || (input.maxSteps ?? 12) < 1 || (input.maxSteps ?? 12) > 30) throw new Error('Invalid task input');
      const model = modelLoader();
      const id = randomUUID(); acquire(id);
      controller = new AbortController(); running = true;
      current = { id, tabId: input.tabId, status: 'running', events: [], startedAt: new Date().toISOString() };
      update({ type: 'started', message: '任务开始，本机浏览器操作已由本任务独占' });
      const signal = controller.signal;
      Promise.resolve().then(() => runAgent({ ...input, model, signal, callTool: (name, args) => callTool(name, args, id), emit: update }))
        .then(result => {
          current.status = signal.aborted ? 'cancelled' : result.status;
          update({ type: 'done', message: signal.aborted ? '已停止后续动作；已执行动作不会撤销。' : result.message, steps: result.steps, actions: result.actions });
        }, error => {
          current.status = signal.aborted ? 'cancelled' : 'failed';
          update({ type: 'error', message: signal.aborted ? '已停止后续动作；请检查在途操作的结果。' : error.message });
        }).finally(() => { running = false; release(id); notify(snapshot()); });
      return snapshot();
    },
    cancel(id) {
      if (!current || (id && id !== current.id)) throw new Error('Task not found');
      if (running) { current.status = 'cancelling'; controller.abort(); update({ type: 'cancelling', message: '停止模型请求与后续动作；等待已派发动作返回。' }); }
      return snapshot();
    }
  };
}
