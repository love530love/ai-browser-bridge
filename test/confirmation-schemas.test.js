// The tool schema advertises the one confirmation string a caller must echo, and
// the service refuses the call when it does not match. Those two are the only
// coupling that decides whether the tool is callable at all, and nothing else
// exercises it: every unit test of the module underneath passes with the wrong
// string, because the module never sees the confirmation. A drift here would
// make the tool permanently uncallable while the whole suite stayed green, so it
// is pinned directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools.js';
import { STORAGE_WRITE_CONFIRMATION, REPLAY_REQUEST_CONFIRMATION } from '../src/confirmations.js';

const EXPECTED = {
  browser_storage_write: STORAGE_WRITE_CONFIRMATION,
  browser_replay_request: REPLAY_REQUEST_CONFIRMATION
};

test('each confirmation-gated tool advertises exactly the value the service checks', () => {
  for (const [name, value] of Object.entries(EXPECTED)) {
    const tool = TOOLS.find(item => item.name === name);
    assert.ok(tool, `${name} must exist`);
    const confirmation = tool.inputSchema.properties.confirmation;
    assert.ok(confirmation, `${name} must declare a confirmation property`);
    assert.deepEqual(confirmation.enum, [value],
      `${name} must accept exactly "${value}"; any other enum makes the tool uncallable`);
    assert.ok(tool.inputSchema.required.includes('confirmation'),
      `${name} must require confirmation, otherwise omitting it is the same as a wrong value`);
  }
});

test('every tool that declares a confirmation requires one and offers a single value', () => {
  // A tool with an optional confirmation, or with several accepted values, is a
  // tool whose gate can be satisfied by accident. This walks the whole list so a
  // future tool cannot join without meeting the same rule.
  const gated = TOOLS.filter(item => item.inputSchema.properties.confirmation);
  assert.ok(gated.length >= 5, `expected several confirmation-gated tools, found ${gated.length}`);
  for (const tool of gated) {
    const confirmation = tool.inputSchema.properties.confirmation;
    assert.ok(tool.inputSchema.required.includes('confirmation'),
      `${tool.name}: confirmation must be in required`);
    assert.equal(confirmation.type, 'string', `${tool.name}: confirmation must be a string`);
    assert.ok(Array.isArray(confirmation.enum) && confirmation.enum.length === 1,
      `${tool.name}: confirmation must accept exactly one documented value, found ${JSON.stringify(confirmation.enum)}`);
    assert.ok(confirmation.enum[0].length >= 8,
      `${tool.name}: the confirmation value must be a phrase a caller cannot type by accident`);
  }
});

test('every confirmation gate is distinct and named after what it authorises', () => {
  const values = TOOLS
    .filter(item => item.inputSchema.properties.confirmation)
    .map(item => item.inputSchema.properties.confirmation.enum[0]);
  assert.equal(new Set(values).size, values.length,
    `confirmation values must not be shared between tools, found ${JSON.stringify(values)}`);
  // A single shared word would let one confirmation authorise an unrelated tool.
  // The verb has to say what kind of thing is being authorised: `run_` covers a
  // stored recipe, which is many writes from one approval.
  for (const value of values) assert.match(value, /^(modify|replay|reveal|read|reload|run)_/);
});
