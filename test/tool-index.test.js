// Tool discovery used to have two settings: names only, which is not enough to
// choose, and full descriptions, which cost 68.6 KB for 111 tools. The index is
// the middle setting, and its only failure mode is drifting away from the real
// tool list - so that is what is pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools.js';
import { TOOL_GROUPS, toolIndex } from '../src/tool-index.js';

test('every tool is in the index exactly once, and nothing else is', () => {
  const names = new Set(TOOLS.map(item => item.name));
  const grouped = new Map();
  for (const group of TOOL_GROUPS) {
    for (const name of group.tools) {
      assert.ok(names.has(name), `${group.id} lists ${name}, which is not a tool`);
      assert.ok(!grouped.has(name), `${name} appears in both ${grouped.get(name)} and ${group.id}`);
      grouped.set(name, group.id);
    }
  }
  const missing = [...names].filter(name => !grouped.has(name));
  assert.deepEqual(missing, [], 'an ungrouped tool is a tool nobody can find from the index');
});

test('the whole index stays small enough to read before a task', () => {
  const result = toolIndex({});
  assert.equal(result.status, 'success');
  assert.equal(result.groups.length, TOOL_GROUPS.length);
  const bytes = Buffer.byteLength(result.index, 'utf8');
  assert.ok(bytes < 3500, `the index must stay a fraction of the 68.6 KB catalogue, got ${bytes} bytes`);
  for (const group of TOOL_GROUPS) assert.ok(result.index.includes(group.id), `${group.id} must be in the text index`);
});

test('one group can be requested on its own', () => {
  const result = toolIndex({ group: 'network' });
  assert.deepEqual(result.groups, ['network']);
  for (const name of ['browser_prepare_request', 'browser_fetch', 'browser_replay_request']) {
    assert.ok(result.index.includes(name), `${name} must be listed under network`);
  }
  assert.ok(!result.index.includes('browser_bookmarks'), 'a single group must not leak the maintenance list');
});

test('an unknown group is refused with the list of real ones', () => {
  const result = toolIndex({ group: 'netwrok' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'unknown_group');
  assert.deepEqual(result.known, TOOL_GROUPS.map(group => group.id));
});

test('a goal narrows the index, in either language', () => {
  const api = toolIndex({ goal: 'POST 一个同源接口然后回读' });
  assert.ok(api.groups.includes('network'), `expected network for an API goal, got ${api.groups}`);
  assert.ok(api.index.includes('browser_replay_request'));

  const click = toolIndex({ goal: '点击' });
  assert.ok(click.groups.includes('act'));

  const login = toolIndex({ goal: '登录' });
  assert.ok(login.groups.includes('auth'));

  // A goal that matches nothing must not silently return everything: the caller
  // would then read the whole index and be no better off than before.
  const nothing = toolIndex({ goal: 'zzzz-no-such-goal' });
  assert.deepEqual(nothing.groups, TOOL_GROUPS.map(group => group.id));
});

test('the json form carries the same data as the text form', () => {
  const json = toolIndex({ format: 'json' });
  assert.equal(json.status, 'success');
  assert.equal(json.groups.length, TOOL_GROUPS.length);
  assert.deepEqual(json.groups[0].tools, TOOL_GROUPS[0].tools);
  assert.equal(json.index, undefined);
});
