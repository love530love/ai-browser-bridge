// browser_agent_advice is only useful if every discovery surface actually
// points at it: the schema catalogue, the policy scope table, the priority
// lane, the compact index and the capability guide. A tool that exists but is
// invisible to a weak caller is indistinguishable from one that is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools.js';
import { TOOL_GROUPS, toolIndex } from '../src/tool-index.js';
import { TOOL_CATEGORIES } from '../src/priority-engine.js';
import { capabilityGuide } from '../src/capability-guide.js';
import { requiredScope } from '../src/policy.js';
import { LEASE_TOOLS, WRITE_TOOLS } from '../src/leases.js';

const byName = name => TOOLS.find(tool => tool.name === name);

test('the advisor is a local read-only tool with a bounded model switch', () => {
  const tool = byName('browser_agent_advice');
  assert.ok(tool, 'browser_agent_advice must exist in the catalogue');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required, []);
  assert.deepEqual(tool.inputSchema.properties.modelProvider.enum, ['off', 'auto', 'local', 'chrome']);
  assert.deepEqual(tool.inputSchema.properties.urgency.enum, ['interactive', 'normal', 'batch']);
  assert.ok(tool.inputSchema.properties.lastResult);
  assert.ok(tool.inputSchema.properties.allowSwitchHost);
  assert.equal(requiredScope('browser_agent_advice', tool), 'read');
  assert.ok(!WRITE_TOOLS.has('browser_agent_advice'));
  assert.ok(!LEASE_TOOLS.has('browser_agent_advice'));
});

test('the local judge advertises triage as a separate mode, not a risk verdict', () => {
  const judge = byName('browser_local_judge');
  assert.deepEqual(judge.inputSchema.properties.mode.enum, ['risk', 'discovery', 'triage']);
  assert.equal(judge.inputSchema.properties.allowedTools.maxItems, 24);
  assert.ok(judge.inputSchema.properties.tool);
  assert.ok(judge.inputSchema.properties.urgency);
  assert.ok(judge.inputSchema.properties.queue);
  assert.deepEqual(judge.inputSchema.required, ['goal', 'observation']);
  assert.match(judge.description, /never counts as a risk verdict/i);
});

test('the compact index lists the advisor and can be narrowed by a concurrency goal', () => {
  const all = toolIndex({});
  assert.equal(all.status, 'success');
  assert.ok(all.index.includes('browser_agent_advice'));
  assert.ok(Buffer.byteLength(all.index, 'utf8') < 4000);

  const debug = TOOL_GROUPS.find(group => group.id === 'debug');
  assert.ok(debug.tools.includes('browser_agent_advice'));
  for (const goal of ['排队', '并发', '建议', '下一步']) {
    const result = toolIndex({ goal });
    assert.ok(result.groups.includes('debug'), `${goal} must reach the debug group, got ${result.groups}`);
  }
  const group = toolIndex({ group: 'debug' });
  assert.ok(group.index.includes('browser_agent_advice'));
});

test('the priority engine classifies the advisor as a read, not as bulk work', () => {
  assert.ok(TOOL_CATEGORIES.read.tools.includes('browser_agent_advice'));
  for (const [id, category] of Object.entries(TOOL_CATEGORIES)) {
    if (id === 'read') continue;
    assert.ok(!category.tools.includes('browser_agent_advice'), `duplicate category ${id}`);
  }
});

test('the capability guide leads a concurrency task with the advisor', () => {
  const guide = capabilityGuide({ goal: '多个 agent 并发排队时我该先做什么' });
  assert.equal(guide.primary.intent, 'multi-agent');
  assert.equal(guide.chain[0], 'browser_agent_advice');
  assert.ok(guide.chain.includes('browser_claim_tab'));
  assert.equal(guide.focusRequired, false);
  assert.equal(guide.primary.backgroundSafe, true);
  assert.ok(guide.focusPolicy.backgroundSafeTools.includes('browser_agent_advice'));
  assert.match(guide.primary.prefer, /never queued|deterministic/i);
});
