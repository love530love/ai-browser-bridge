// The optional local endpoint is useful only if it is boring: loopback by
// default, no secrets in a URL, bounded output and time, and every failure
// downgraded to "unavailable" so the deterministic advice still stands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localModelConfig, normalizeModelAdvice, adviseWithLocalModel } from '../src/local-model.js';

const baseEnv = {
  AIB_LOCAL_MODEL_URL: 'http://127.0.0.1:11434',
  AIB_LOCAL_MODEL_NAME: 'qwen-local'
};

test('a missing URL or model name is not configured, not a crash', () => {
  assert.equal(localModelConfig({}).configured, false);
  assert.equal(localModelConfig({}).reason, 'url_missing');
  assert.equal(localModelConfig({ AIB_LOCAL_MODEL_URL: 'http://127.0.0.1:11434' }).reason, 'model_name_missing');
});

test('loopback is the default and a remote host needs an explicit opt-in', () => {
  const local = localModelConfig(baseEnv);
  assert.equal(local.configured, true);
  assert.equal(local.loopback, true);
  assert.equal(local.endpoint, 'http://127.0.0.1:11434/chat/completions');

  const remote = localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_URL: 'http://10.0.0.5:11434' });
  assert.equal(remote.configured, false);
  assert.equal(remote.reason, 'non_loopback_requires_opt_in');

  const optedIn = localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_URL: 'http://10.0.0.5:11434', AIB_LOCAL_MODEL_ALLOW_REMOTE: '1' });
  assert.equal(optedIn.configured, true);
  assert.equal(optedIn.loopback, false);
});

test('credentials, query strings and fragments in the URL are refused', () => {
  const cases = [
    ['http://user:pass@127.0.0.1:11434', 'url_credentials_not_allowed'],
    ['http://127.0.0.1:11434/?key=secret', 'url_query_not_allowed'],
    ['http://127.0.0.1:11434/#frag', 'url_fragment_not_allowed'],
    ['ftp://127.0.0.1:11434', 'unsupported_protocol'],
    ['not a url', 'invalid_url']
  ];
  for (const [url, reason] of cases) {
    const config = localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_URL: url });
    assert.equal(config.configured, false, url);
    assert.equal(config.reason, reason, url);
  }
});

test('the endpoint is normalized exactly once', () => {
  const cases = [
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/chat/completions'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434/chat/completions'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/chat/completions'],
    ['http://127.0.0.1:11434/v1/chat/completions/', 'http://127.0.0.1:11434/v1/chat/completions']
  ];
  for (const [url, endpoint] of cases) {
    assert.equal(localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_URL: url }).endpoint, endpoint, url);
  }
});

test('the timeout is clamped and an absent one uses the default', () => {
  assert.equal(localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_TIMEOUT_MS: '10' }).timeoutMs, 500);
  assert.equal(localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_TIMEOUT_MS: '999999' }).timeoutMs, 60000);
  assert.equal(localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_TIMEOUT_MS: 'abc' }).timeoutMs, 8000);
  assert.equal(localModelConfig(baseEnv).timeoutMs, 8000);
});

test('an API key is reported as configured but never leaves the config', async () => {
  const config = localModelConfig({ ...baseEnv, AIB_LOCAL_MODEL_API_KEY: 'sk-test-secret' });
  assert.equal(config.authConfigured, true);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"decision":"wait","waitMs":250}' } }] }) };
  };
  const result = await adviseWithLocalModel({ config, context: { candidateTools: [] }, fetchImpl });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test-secret');
  assert.ok(!JSON.stringify(result).includes('sk-test-secret'));
});

test('model advice is normalized: enums, clamps, allowed tools and text', () => {
  const unknown = normalizeModelAdvice({ decision: 'restart_everything', waitMs: null, nextTool: 'browser_rm_rf', why: 'do it' }, ['browser_read']);
  assert.equal(unknown.decision, 'escalate');
  assert.equal(unknown.waitMs, null, 'null means no opinion, not zero');
  assert.equal(unknown.nextTool, null);
  assert.ok(unknown.warnings.includes('unknown_decision_mapped_to_escalate'));
  assert.ok(unknown.warnings.includes('next_tool_not_in_candidate_list'));
  assert.equal(unknown.authority, 'advisory_only');

  const numeric = normalizeModelAdvice({ decision: 'Wait', waitMs: '750', nextTool: 'browser_read', why: 'line\nbreak', confidence: 'high' }, ['browser_read']);
  assert.equal(numeric.decision, 'wait');
  assert.equal(numeric.waitMs, 750);
  assert.equal(numeric.nextTool, 'browser_read');
  assert.equal(numeric.why, 'line break');
  assert.equal(numeric.confidence, 'high');
  assert.deepEqual(numeric.warnings, []);

  assert.equal(normalizeModelAdvice({ waitMs: -5 }, []).waitMs, 0);
  assert.equal(normalizeModelAdvice({ waitMs: 999999 }, []).waitMs, 120000);
  assert.equal(normalizeModelAdvice({ waitMs: '' }, []).waitMs, null);
  assert.equal(normalizeModelAdvice({ confidence: 'certain' }, []).confidence, 'low');
  assert.equal(normalizeModelAdvice(null, []).status, 'unavailable');
});

test('a successful endpoint call sends the fixed JSON request and returns advice', async () => {
  const config = localModelConfig(baseEnv);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '```json\n{"decision":"wait","waitMs":"250","nextTool":"browser_read","why":"busy","confidence":"medium"}\n```' } }] })
    };
  };
  const result = await adviseWithLocalModel({ config, context: { candidateTools: ['browser_read'], queue: { queued: 1 } }, fetchImpl });
  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'local_endpoint');
  assert.equal(result.decision, 'wait');
  assert.equal(result.waitMs, 250);
  assert.equal(result.nextTool, 'browser_read');
  assert.equal(result.authConfigured, false);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'qwen-local');
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 300);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /advisory queue/);
});

test('every endpoint failure degrades to unavailable and never throws', async () => {
  const config = localModelConfig(baseEnv);
  const context = { candidateTools: [] };

  const http = await adviseWithLocalModel({ config, context, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(http.status, 'unavailable');
  assert.equal(http.reason, 'local_model_http_error');
  assert.equal(http.httpStatus, 503);

  const errorObject = await adviseWithLocalModel({
    config, context,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: { type: 'rate_limit' } }) })
  });
  assert.equal(errorObject.reason, 'local_model_error_object');

  const invalid = await adviseWithLocalModel({
    config, context,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'no json here' } }] }) })
  });
  assert.equal(invalid.reason, 'invalid_model_reply');

  const unreachable = await adviseWithLocalModel({ config, context, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(unreachable.reason, 'local_model_unreachable');
  assert.equal(unreachable.errorName, 'TypeError');

  const notConfigured = await adviseWithLocalModel({ config: { configured: false, reason: 'url_missing' }, context });
  assert.equal(notConfigured.status, 'not_configured');

  const noFetch = await adviseWithLocalModel({ config, context, fetchImpl: null });
  assert.equal(noFetch.reason, 'fetch_unavailable');
});

test('a slow endpoint is aborted at the budget', async () => {
  const config = localModelConfig(baseEnv);
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const started = Date.now();
  const result = await adviseWithLocalModel({ config, context: {}, fetchImpl, timeoutMs: 500 });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'local_model_timeout');
  assert.equal(result.timeoutMs, 500);
  assert.ok(Date.now() - started >= 450);
});

test('at most two advisory calls run at once, so the advisor cannot become a second queue', async () => {
  const config = localModelConfig(baseEnv);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"decision":"proceed"}' } }] }) };
  };
  const first = adviseWithLocalModel({ config, context: {}, fetchImpl });
  const second = adviseWithLocalModel({ config, context: {}, fetchImpl });
  const third = await adviseWithLocalModel({ config, context: {}, fetchImpl });
  assert.equal(third.status, 'busy');
  assert.equal(third.reason, 'local_model_concurrency_limit');
  release();
  const settled = await Promise.all([first, second]);
  assert.deepEqual(settled.map(item => item.status), ['success', 'success']);
});

test('a later call works again after the concurrency slots are released', async () => {
  const config = localModelConfig(baseEnv);
  const result = await adviseWithLocalModel({
    config, context: {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"decision":"proceed"}' } }] }) })
  });
  assert.equal(result.status, 'success');
  assert.equal(result.decision, 'proceed');
});
