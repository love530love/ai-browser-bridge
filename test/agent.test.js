import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseAction, toBrowserAction } from '../src/autoglm-actions.js';
import { runAgent } from '../src/agent.js';
import { validateCall } from '../src/tools.js';

test('Open-AutoGLM literal actions adapt without code execution', () => {
  const parsed = parseAction('do(action="Tap", element=[250, 700])');
  const result = toBrowserAction(parsed, { tabId: 5, expectedUrl: 'https://example.com/' });
  assert.deepEqual(result.arguments, { tabId: 5, action: 'Tap', expectedUrl: 'https://example.com/', x: 250, y: 700 });
  validateCall(result.name, result.arguments);
  assert.equal(parseAction("do(action='Type', text='hello\\nworld')").text, 'hello\nworld');
  assert.equal(toBrowserAction('finish(message="done")', {}).terminal, 'reported_complete');
  assert.equal(toBrowserAction('do(action="Take_over", message="login")', {}).terminal, 'needs_user');
  for (const malicious of ['do(action=__import__("os").system("bad"))', 'do(action="Tap", element=[1,2]); process.exit()', 'do(action="Tap", element=[f(),2])', 'do(__proto__="bad")']) assert.throws(() => parseAction(malicious));
  assert.throws(() => toBrowserAction('do(action="Launch", app="Settings")', {}), /Unsupported/);
  assert.throws(() => toBrowserAction('do(action="Tap", element=[1001,0])', {}), /Coordinates/);
  assert.throws(() => toBrowserAction('do(action="Wait", duration="100 seconds")', {}), /0..5/);
});
async function provider(t, reply) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: reply(JSON.parse(raw)) }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'simulated-test-model', mode: 'tools' };
}
const observation = { url: 'https://example.com/', text: 'test fixture', elements: [] };
test('model tool loop executes a validated command then reports completion', async t => {
  let count = 0; const events = []; const executed = [];
  const model = await provider(t, () => ++count === 1 ? { role: 'assistant', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'browser_key', arguments: '{"tabId":1,"key":"Enter"}' } }] } : { role: 'assistant', content: 'Done based on observation' });
  const result = await runAgent({ task: 'Test', tabId: 1, model, emit: e => events.push(e), callTool: async (name, args) => { executed.push({ name, args }); return name === 'browser_read' ? observation : { dispatched: true }; } });
  assert.equal(result.status, 'reported_complete'); assert.equal(result.actions, 1);
  assert.equal(executed.filter(e => e.name === 'browser_key').length, 1);
  assert.ok(events.some(e => e.type === 'action'));
});
test('model cannot operate another tab and failed writes are not retried', async t => {
  let calls = 0;
  const model = await provider(t, () => ({ role: 'assistant', tool_calls: [{ id: 'bad', type: 'function', function: { name: 'browser_key', arguments: '{"tabId":2,"key":"Enter"}' } }] }));
  await assert.rejects(runAgent({ task: 'Test', tabId: 1, model, callTool: async () => { calls++; return observation; } }), /another tab/);
  assert.equal(calls, 1);
  const model2 = await provider(t, () => ({ role: 'assistant', tool_calls: [{ id: 'one', type: 'function', function: { name: 'browser_key', arguments: '{"tabId":1,"key":"Enter"}' } }] }));
  let writes = 0;
  await assert.rejects(runAgent({ task: 'Test', tabId: 1, model: model2, callTool: async name => { if (name === 'browser_read') return observation; writes++; throw new Error('unknown outcome'); } }), /unknown outcome/);
  assert.equal(writes, 1);
});
test('native AutoGLM mode supports handoff and never executes a handoff action', async t => {
  const model = { ...await provider(t, () => ({ role: 'assistant', content: 'do(action="Take_over", message="Please log in")' })), mode: 'autoglm' };
  const calls = [];
  const result = await runAgent({ task: 'Test', tabId: 1, model, callTool: async name => { calls.push(name); return name === 'browser_read' ? observation : { data: 'test-image' }; } });
  assert.equal(result.status, 'needs_user'); assert.deepEqual(calls, ['browser_read', 'browser_screenshot']);
});
test('step budget stops a loop and cancellation stops before any browser access', async t => {
  const model = await provider(t, () => ({ role: 'assistant', tool_calls: [{ id: 'one', type: 'function', function: { name: 'browser_scroll', arguments: '{"tabId":1,"deltaY":1}' } }] }));
  const result = await runAgent({ task: 'Test', tabId: 1, maxSteps: 1, model, callTool: async () => observation });
  assert.equal(result.status, 'step_limit');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runAgent({ task: 'Test', tabId: 1, model, signal: controller.signal, callTool: async () => { throw new Error('Should not run'); } }), /abort/i);
});
